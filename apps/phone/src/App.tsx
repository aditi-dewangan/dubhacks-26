import { useCallback, useEffect, useRef, useState } from "react";
import type { Cart, CartLine, KioskState, SessionEndReason } from "@kiosk-access/shared";
import { attachProfile, connectSocket, createSession, parseParams } from "./connection.ts";
import type { PhoneSocket } from "./connection.ts";
import type { ChatMessage } from "./store.ts";
import { usePhone } from "./store.ts";
import { createAgentVoice } from "./agentSpeech.ts";
import { bindVoiceSocket } from "./voiceSocket.ts";
import { speechSupport } from "./speech.ts";

let _id = 0;
const uid = () => String(++_id);

// ---- End / error display data ----

type EndInfo = { heading: string; body: string; recovery?: string };
const SESSION_END: Record<SessionEndReason, EndInfo> = {
  order_complete:     { heading: "Order placed",       body: "Your order is confirmed." },
  idle_timeout:       { heading: "Session timed out",  body: "Your session ended due to inactivity.",    recovery: "Tap the kiosk tag to start a new session." },
  staff_ended:        { heading: "Session ended",      body: "A staff member ended the session.",         recovery: "Please ask staff if you need help." },
  phone_disconnected: { heading: "Disconnected",       body: "Your phone lost its connection.",           recovery: "Tap the kiosk tag to reconnect." },
  user_ended:         { heading: "Session ended",      body: "You ended this session.",                   recovery: "Tap the kiosk tag to start a new session." },
  kiosk_disconnected: { heading: "Kiosk disconnected", body: "The kiosk lost its connection.",            recovery: "Please ask a staff member for help." },
};

type ErrorInfo = { heading: string; body: string; recovery: string; canRetry: boolean };
const ERROR_INFO: Record<string, ErrorInfo> = {
  kiosk_busy:     { heading: "Kiosk is busy",          body: "This kiosk already has an active session.",           recovery: "Wait a moment, then tap the tag again.",             canRetry: false },
  code_expired:   { heading: "Code has expired",       body: "This connection code has expired.",                   recovery: "Tap the kiosk tag again for a fresh code.",          canRetry: false },
  kiosk_offline:  { heading: "Kiosk is offline",       body: "This kiosk is currently offline.",                    recovery: "Ask a staff member for help.",                       canRetry: false },
  connect_failed: { heading: "Connection failed",      body: "Could not reach the server.",                         recovery: "Check your internet connection and try again.",      canRetry: true  },
  bad_url:        { heading: "Link not recognised",    body: "This link does not contain a valid connection code.", recovery: "Tap the kiosk tag again for a fresh link.",          canRetry: false },
  unknown:        { heading: "Something went wrong",   body: "An unexpected error occurred.",                       recovery: "Try tapping the kiosk tag again, or ask for help.", canRetry: false },
};

// ============================================================
// App — connection logic + screen routing
// ============================================================

export function App() {
  const phase              = usePhone(s => s.phase);
  const errorCode          = usePhone(s => s.errorCode);
  const errorMessage       = usePhone(s => s.errorMessage);
  const messages           = usePhone(s => s.messages);
  const endReason          = usePhone(s => s.endReason);
  const awaitingConfirmation = usePhone(s => s.awaitingConfirmation);
  const kioskState         = usePhone(s => s.kioskState);
  const orderingStarted    = usePhone(s => s.orderingStarted);
  const speechRate         = usePhone(s => s.speechRate);

  const socketRef          = useRef<PhoneSocket | null>(null);
  const voiceRef           = useRef<ReturnType<typeof createAgentVoice> | null>(null);
  const [agentThinking, setAgentThinking] = useState(false);
  const [agentSpeaking, setAgentSpeaking] = useState(false);
  const [voiceListening, setVoiceListening] = useState(false);
  const [settingsOpen,  setSettingsOpen]  = useState(false);
  const [cartReviewOpen, setCartReviewOpen] = useState(false);

  // Keep speech rate accessible to agentVoice without re-creating it on every render
  const speechRateRef = useRef(speechRate);
  speechRateRef.current = speechRate;

  // Connection — runs once; no StrictMode (single-use token)
  useEffect(() => {
    const store = usePhone.getState();
    const params = parseParams();
    if (!params) { store.setPhase("bad_url"); return; }
    store.setPhase("connecting");

    let cancelled = false;
    let socket: PhoneSocket | null = null;
    let unbindVoice: (() => void) | null = null;

    (async () => {
      try {
        const sess = await createSession(params.kioskId, params.token);
        if (cancelled) return;
        socket = connectSocket(sess.sessionId, sess.sessionSecret);
        socketRef.current = socket;
        // Recognise a returning customer (no login screen). Ordering doesn't wait for it.
        void attachProfile(sess.sessionId, sess.sessionSecret).then(p => { if (p && !cancelled) store.setProfile(p); });

        // Voice controller: sendText callback emits to server and updates store.
        // showTranscript is a no-op — sendText adds the bubble; we avoid duplicates.
        const voice = createAgentVoice({
          sendText: (text) => {
            if (!socketRef.current) return;
            socketRef.current.emit("user:message", { text });
            usePhone.getState().pushMessage({ id: uid(), role: "user", text, awaitingConfirmation: false });
            usePhone.getState().setAwaitingConfirmation(false);
            setAgentThinking(true);
          },
          showTranscript: (_text) => { /* sendText adds the bubble */ },
          showStatus: (_msg) => { /* showStatus errors surfaced via voiceState label */ },
          setSpeaking: (v) => setAgentSpeaking(v),
          setListening: (v) => setVoiceListening(v),
        }, () => speechRateRef.current);
        voiceRef.current = voice;

        // bindVoiceSocket wires agent:message → TTS, kiosk:state → order-complete TTS,
        // session:ended → stop speech. These run in addition to the store-update handlers below.
        unbindVoice = bindVoiceSocket(socket as unknown as Parameters<typeof bindVoiceSocket>[0], voice);

        socket.on("connect", () => {
          if (cancelled) return;
          store.setPhase("active");
          voice.speakFeedback("Connected to kiosk. Tap Start voice ordering to begin.");
        });
        socket.on("connect_error", e => {
          if (!cancelled) store.setError("connect_failed", e.message);
        });
        socket.on("kiosk:state", state => store.setKioskState(state));
        socket.on("agent:message", msg => {
          setAgentThinking(false);
          store.setAwaitingConfirmation(msg.awaitingConfirmation);
          store.pushMessage({ id: uid(), role: "agent", text: msg.text, awaitingConfirmation: msg.awaitingConfirmation });
          // If agent responds before user tapped Start, jump straight to conversation
          if (!usePhone.getState().orderingStarted) store.setOrderingStarted(true);
        });
        socket.on("session:ended", info => {
          store.setEnded(info.reason ?? null);
          socket!.disconnect();
        });
      } catch (err: unknown) {
        if (!cancelled) {
          const e = err as Error & { code?: string };
          store.setError(e.code ?? "unknown", e.message ?? "");
        }
      }
    })();

    return () => {
      cancelled = true;
      unbindVoice?.();
      voiceRef.current?.dispose();
      voiceRef.current = null;
      socket?.disconnect();
      socketRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Actions
  const sendText = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    voiceRef.current?.sendTyped(trimmed);
  }, []);

  const sendConfirm = useCallback((confirmed: boolean) => {
    socketRef.current?.emit("user:confirm", { confirmed });
    usePhone.getState().setAwaitingConfirmation(false);
    if (confirmed) setAgentThinking(true);
  }, []);

  const endSession = useCallback(() => {
    socketRef.current?.emit("user:end-session");
  }, []);

  const repeatLastMessage = useCallback(() => {
    const msgs = usePhone.getState().messages;
    const last = [...msgs].reverse().find(m => m.role === "agent");
    if (last) voiceRef.current?.speakFeedback(last.text);
  }, []);

  const startOrdering = useCallback((withVoice: boolean) => {
    usePhone.getState().setOrderingStarted(true);
    if (withVoice) {
      voiceRef.current?.setEnabled(true);
      voiceRef.current?.speakFeedback("Ready. Tap the microphone button and tell me what you'd like.");
    }
  }, []);

  // ---- Screen routing ----
  if (phase === "init") return null;
  if (phase === "connecting") return <ConnectingScreen />;
  if (phase === "bad_url")    return <QrScannerScreen />;
  if (phase === "error")      return <CantConnectScreen code={errorCode ?? "unknown"} detail={errorMessage ?? undefined} />;

  if (phase === "ended") {
    if (endReason === "order_complete") return <OrderCompleteScreen kioskState={kioskState} />;
    const info = SESSION_END[endReason as SessionEndReason] ?? { heading: "Session ended", body: "Your session has ended.", recovery: "Tap the kiosk tag to start again." };
    return <SessionEndedScreen heading={info.heading} body={info.body} recovery={info.recovery} />;
  }

  // phase === "active" — sub-screens by priority
  const ks = kioskState?.screen;
  if (ks === "paying")   return <PayAtReaderScreen kioskState={kioskState!} onEnd={endSession} onRepeat={() => {
    const total = kioskState!.cart?.total;
    const text = `Please pay at the kiosk reader${total != null ? `, total $${total.toFixed(2)}` : ""}.`;
    voiceRef.current?.speakFeedback(text);
  }} />;
  if (ks === "complete") return <OrderCompleteScreen kioskState={kioskState} />;
  if (awaitingConfirmation) return <ConfirmOrderScreen cart={kioskState?.cart ?? null} onConfirm={sendConfirm} />;
  if (!orderingStarted) return (
    <StartScreen
      kioskId={kioskState?.kioskId ?? ""}
      onStartVoice={() => startOrdering(true)}
      onStartText={() => startOrdering(false)}
    />
  );

  return (
    <>
      <ConversationScreen
        messages={messages}
        kioskState={kioskState}
        agentThinking={agentThinking}
        agentSpeaking={agentSpeaking}
        voiceListening={voiceListening}
        onSend={sendText}
        onMicPress={() => voiceRef.current?.listenAndSend()}
        onEnd={endSession}
        onSettings={() => setSettingsOpen(true)}
        onRepeat={repeatLastMessage}
        onCartReview={() => setCartReviewOpen(true)}
      />
      {settingsOpen && <SettingsSheet onClose={() => setSettingsOpen(false)} />}
      {cartReviewOpen && kioskState?.cart && (
        <CartReviewSheet cart={kioskState.cart} onClose={() => setCartReviewOpen(false)} />
      )}
    </>
  );
}

// ============================================================
// QrScannerScreen
// ============================================================

// BarcodeDetector is not in TypeScript's lib.dom yet — minimal inline type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const BarcodeDetectorAPI: (new (opts: { formats: string[] }) => { detect(src: HTMLVideoElement): Promise<{ rawValue: string }[]> }) | undefined
  = typeof window !== "undefined" ? (window as unknown as Record<string, unknown>).BarcodeDetector as never : undefined;

/** Parse a full QR URL and extract the relative path + params we need. */
function parseQrUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    const match = url.pathname.match(/^\/k\/([^/?#]+)/);
    const token = url.searchParams.get("t");
    if (!match?.[1] || !token) return null;
    return url.pathname + url.search; // relative path to navigate to
  } catch {
    return null;
  }
}

function QrScannerScreen() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [cameraError, setCameraError] = useState("");
  const [found, setFound] = useState(false);
  const [manualUrl, setManualUrl] = useState("");
  const supported = Boolean(BarcodeDetectorAPI);

  useEffect(() => {
    if (!supported || !videoRef.current) return;
    let stopped = false;
    let stream: MediaStream | null = null;
    let rafId = 0;
    const detector = new BarcodeDetectorAPI!({ formats: ["qr_code"] });

    const scan = async () => {
      if (stopped || !videoRef.current) return;
      try {
        const results = await detector.detect(videoRef.current);
        for (const r of results) {
          const path = parseQrUrl(r.rawValue);
          if (path) {
            stopped = true;
            setFound(true);
            stream?.getTracks().forEach(t => t.stop());
            window.location.href = path;
            return;
          }
        }
      } catch { /* frame not ready yet */ }
      rafId = requestAnimationFrame(scan);
    };

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } } });
        if (stopped) { stream.getTracks().forEach(t => t.stop()); return; }
        videoRef.current!.srcObject = stream;
        await videoRef.current!.play();
        scan();
      } catch {
        setCameraError("Could not access the camera. Allow camera access in your browser settings and try again.");
      }
    })();

    return () => {
      stopped = true;
      cancelAnimationFrame(rafId);
      stream?.getTracks().forEach(t => t.stop());
    };
  }, [supported]);

  const submitManual = () => {
    const path = parseQrUrl(manualUrl.trim());
    if (path) { window.location.href = path; }
    else setCameraError("That URL doesn't look like a valid kiosk link. Try scanning again.");
  };

  return (
    <div className="page" role="main" aria-label="Scan the kiosk QR code">
      <p className="page-brand" aria-hidden="true">Kiosk Access</p>
      <div className="scanner-inner">
        <h1 style={{ fontSize: "1.625rem", fontWeight: 800, color: "var(--text)", alignSelf: "flex-start", letterSpacing: "-0.02em" }}>
          Scan the kiosk
        </h1>
        <p style={{ color: "var(--text-2)", fontSize: "1rem", alignSelf: "flex-start" }}>
          Point your camera at the QR code on the kiosk screen.
        </p>

        {found ? (
          <div className="panel panel-sage" role="status" style={{ width: "100%", textAlign: "center", padding: "1.5rem" }}>
            <CheckmarkIcon size={24} color="var(--sage-text)" /> QR code found — connecting…
          </div>
        ) : supported ? (
          <div className="scanner-viewfinder" aria-label="Camera viewfinder">
            <video ref={videoRef} className="scanner-video" muted playsInline aria-hidden="true" />
            {!cameraError && (
              <div className="scanner-frame" aria-hidden="true">
                <div className="scanner-corner scanner-corner-tl" />
                <div className="scanner-corner scanner-corner-tr" />
                <div className="scanner-corner scanner-corner-bl" />
                <div className="scanner-corner scanner-corner-br" />
                <div className="scanner-line" />
              </div>
            )}
            {cameraError && (
              <div className="scanner-placeholder">
                <CameraOffIcon />
                <span>{cameraError}</span>
              </div>
            )}
          </div>
        ) : (
          <div className="panel panel-peach" style={{ width: "100%" }}>
            In-app QR scanning isn&apos;t supported by this browser. Use your phone&apos;s camera app to scan the kiosk&apos;s QR code directly.
          </div>
        )}

        {(cameraError || !supported) && (
          <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            <p style={{ fontSize: "0.9rem", color: "var(--text-3)" }}>Or paste the link shown on the kiosk:</p>
            <div className="text-row">
              <input
                className="text-field"
                type="url"
                inputMode="url"
                placeholder="https://…"
                value={manualUrl}
                onChange={e => setManualUrl(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") submitManual(); }}
                aria-label="Kiosk link"
                style={{ flex: 1 }}
              />
              <button className="send-btn" type="button" onClick={submitManual} aria-label="Connect">
                <SendIcon />
              </button>
            </div>
          </div>
        )}

        {cameraError && <p className="voice-error-msg" role="alert">{cameraError}</p>}
      </div>
    </div>
  );
}

// ============================================================
// ConnectingScreen
// ============================================================

function ConnectingScreen() {
  return (
    <div className="page" role="main" aria-label="Connecting to kiosk">
      <div className="connecting-page">
        <AppLogo />
        <div className="spinner" role="status" aria-label="Connecting" />
        <h1 className="connecting-heading">Connecting to<br />your kiosk</h1>
        <p className="connecting-sub" aria-live="polite">
          Please wait while we connect your phone.
        </p>
      </div>
    </div>
  );
}

// ============================================================
// StartScreen
// ============================================================

function StartScreen({ kioskId, onStartVoice, onStartText }: {
  kioskId: string;
  onStartVoice(): void;
  onStartText(): void;
}) {
  const hasSpeech = speechSupport().recognition;
  return (
    <div className="page" role="main">
      <p className="sr-only" aria-live="polite">
        Connected to kiosk{kioskId ? ` ${kioskId}` : ""}. Ready to take your order.
      </p>
      <div className="start-inner">
        <AppLogo />

        <div className="panel panel-sage" role="status" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <CheckmarkIcon size={15} color="var(--sage-text)" />
          Connected{kioskId ? ` · ${kioskId}` : ""}
        </div>

        {/* Food media — replace src with real photography when available */}
        <div className="start-media" aria-hidden="true">
          <FoodIllustration />
        </div>

        <div className="start-text">
          <h1 className="start-heading">Your order,<br />your way.</h1>
          <p className="start-sub">Tell us what you&apos;re craving. We&apos;ll handle the rest.</p>
        </div>

        <div className="start-actions">
          {hasSpeech && (
            <button className="btn btn-primary" type="button" onClick={onStartVoice}>
              <MicIcon active={false} size={20} />
              Start voice ordering
            </button>
          )}
          <button className="btn btn-outline" type="button" onClick={onStartText}>
            <KeyboardIcon />
            Type instead
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// ConversationScreen
// ============================================================

interface ConvProps {
  messages: ChatMessage[];
  kioskState: KioskState | null;
  agentThinking: boolean;
  agentSpeaking: boolean;
  voiceListening: boolean;
  onSend(text: string): void;
  onMicPress(): void;
  onEnd(): void;
  onSettings(): void;
  onRepeat(): void;
  onCartReview(): void;
}

function ConversationScreen({
  messages, kioskState, agentThinking, agentSpeaking, voiceListening,
  onSend, onMicPress, onEnd, onSettings, onRepeat, onCartReview,
}: ConvProps) {
  const listRef = useRef<HTMLUListElement>(null);
  const cart = kioskState?.cart;
  const cartCount = cart?.lines.reduce((s, l) => s + l.qty, 0) ?? 0;
  const hasAgentMsg = messages.some(m => m.role === "agent");
  const hasSpeech = speechSupport().recognition;

  type VoiceState = "idle" | "listening" | "thinking" | "speaking";
  const effectiveVoiceState: VoiceState =
    agentThinking ? "thinking" : agentSpeaking ? "speaking" : voiceListening ? "listening" : "idle";

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, agentThinking]);

  const voiceBtnLabel: Record<VoiceState, string> = {
    idle:      "Microphone off",
    listening: "Listening — tap to stop",
    thinking:  "Processing",
    speaking:  "Assistant speaking",
  };

  const brandName = kioskState?.kioskId
    ? kioskState.kioskId.replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase())
    : "Kiosk Access";

  return (
    <div className="conv-page" role="main" aria-label="Ordering conversation">
      <header className="conv-header">
        <span className="conv-brand">{brandName}</span>
        <div className="conv-header-actions">
          <button className="btn-icon" type="button" onClick={onSettings} aria-label="Settings">
            <SettingsIcon /><span aria-hidden="true">Settings</span>
          </button>
          <button className="btn-danger-ghost" type="button" onClick={onEnd} aria-label="End ordering session">
            End
          </button>
        </div>
      </header>

      {cartCount > 0 && cart && (
        <div
          className="cart-bar"
          role="status"
          aria-label={`Cart: ${cartCount} item${cartCount !== 1 ? "s" : ""}, total $${cart.total.toFixed(2)}`}
        >
          <CartIcon />
          <span>
            {cartCount} item{cartCount !== 1 ? "s" : ""} · <strong>${cart.total.toFixed(2)}</strong>
          </span>
        </div>
      )}

      <ul
        className="message-list"
        ref={listRef}
        role="log"
        aria-live="off"
        aria-label="Conversation"
      >
        {messages.length === 0 && !agentThinking && (
          <li className="empty-hint" aria-hidden="true">
            Ask about the menu, or tell me your order.
          </li>
        )}
        {messages.map(m => (
          <li key={m.id} className={`bubble bubble-${m.role}`}>
            <span className="sr-only">{m.role === "user" ? "You: " : "Assistant: "}</span>
            {m.text}
          </li>
        ))}
        {agentThinking && (
          <li className="bubble bubble-agent bubble-thinking" aria-label="Assistant is thinking">
            <span className="thinking-dots" aria-hidden="true">
              <span /><span /><span />
            </span>
          </li>
        )}
      </ul>

      <div className="bottom-panel">
        <div className="voice-section">
          {effectiveVoiceState === "listening" && (
            <div className="voice-ring" aria-hidden="true" />
          )}
          <button
            className={`voice-circle voice-${effectiveVoiceState}`}
            type="button"
            onClick={onMicPress}
            disabled={!hasSpeech || effectiveVoiceState === "thinking" || effectiveVoiceState === "speaking"}
            aria-label={voiceListening ? "Stop recording" : "Start voice input"}
            aria-pressed={voiceListening}
          >
            <MicIcon active={voiceListening} size={28} />
          </button>
          <p className="voice-status-label" role="status" aria-live="polite">
            {voiceBtnLabel[effectiveVoiceState]}
          </p>
        </div>

        <div className="secondary-actions">
          {hasAgentMsg && (
            <button className="btn-ghost" type="button" onClick={onRepeat}>
              <RepeatIcon /> Repeat last message
            </button>
          )}
          {cartCount > 0 && (
            <button className="btn-ghost" type="button" onClick={onCartReview}>
              <CartIcon /> Review order
            </button>
          )}
        </div>

        <div className="text-row-divider" aria-hidden="true" />
        <div className="text-row">
          <TextInput onSend={onSend} disabled={agentThinking || agentSpeaking} />
        </div>
      </div>
    </div>
  );
}

// ============================================================
// ConfirmOrderScreen
// ============================================================

function ConfirmOrderScreen({ cart, onConfirm }: { cart: Cart | null; onConfirm(confirmed: boolean): void }) {
  const [confirming, setConfirming] = useState(false);

  const handleConfirm = () => {
    if (confirming) return;
    setConfirming(true);
    onConfirm(true);
  };

  const handleChange = () => {
    if (confirming) return;
    onConfirm(false);
  };

  return (
    <div className="confirm-page" role="main" aria-label="Review your order">
      <p className="page-brand" aria-hidden="true">Kiosk Access</p>
      <div className="confirm-inner">
        <h1 className="confirm-heading">Review your order</h1>

        {cart && cart.lines.length > 0 ? (
          <>
            <ul aria-label="Order items" style={{ listStyle: "none", display: "flex", flexDirection: "column", gap: "0.625rem" }}>
              {cart.lines.map(line => <CartLineCard key={line.lineId} line={line} />)}
            </ul>
            <PriceTable cart={cart} />
            <div className="panel panel-peach" style={{ fontSize: "0.9375rem" }}>
              Your order will be read aloud before you confirm.
            </div>
          </>
        ) : (
          <div className="panel panel-lavender">Your cart is empty.</div>
        )}
      </div>

      <div className="confirm-footer">
        <button
          className="btn btn-primary"
          type="button"
          onClick={handleConfirm}
          disabled={confirming || !cart?.lines.length}
          aria-disabled={confirming}
        >
          {confirming ? "Confirming…" : "Confirm order"}
        </button>
        <button className="btn btn-outline" type="button" onClick={handleChange} disabled={confirming}>
          Change order
        </button>
      </div>
    </div>
  );
}

function CartLineCard({ line }: { line: CartLine }) {
  const optionParts: string[] = [];
  for (const [, values] of Object.entries(line.options)) {
    if (values.length) optionParts.push(values.join(", "));
  }
  return (
    <li className="cart-item-card">
      <div className="cart-item-info">
        <div className="cart-item-name">
          <span className="cart-item-qty" aria-label={`Quantity ${line.qty}`}>{line.qty}×</span>
          {line.name}
        </div>
        {optionParts.length > 0 && (
          <div className="cart-item-options">{optionParts.join(" · ")}</div>
        )}
      </div>
      <div className="cart-item-price" aria-label={`$${line.lineTotal.toFixed(2)}`}>
        ${line.lineTotal.toFixed(2)}
      </div>
    </li>
  );
}

function PriceTable({ cart }: { cart: Cart }) {
  return (
    <div className="price-table" role="table" aria-label="Price breakdown">
      <div className="price-row" role="row">
        <span role="rowheader">Subtotal</span>
        <span role="cell">${cart.subtotal.toFixed(2)}</span>
      </div>
      <div className="price-row" role="row">
        <span role="rowheader">Tax</span>
        <span role="cell">${cart.tax.toFixed(2)}</span>
      </div>
      <div className="price-row" role="row">
        <span role="rowheader" className="price-total">Total</span>
        <span role="cell" className="price-total">${cart.total.toFixed(2)}</span>
      </div>
    </div>
  );
}

// ============================================================
// PayAtReaderScreen
// ============================================================

function PayAtReaderScreen({ kioskState, onEnd, onRepeat }: { kioskState: KioskState; onEnd(): void; onRepeat(): void }) {
  const total = kioskState.cart?.total;
  return (
    <div className="page" role="main" aria-label="Pay at the reader">
      <p className="sr-only" aria-live="assertive">
        Please pay at the kiosk reader{total != null ? `, total $${total.toFixed(2)}` : ""}.
      </p>
      <p className="page-brand" aria-hidden="true">Kiosk Access</p>
      <div className="centred-page">
        <div className="pay-icon-wrap" aria-hidden="true"><ReaderIcon /></div>
        <h1>Pay at the reader</h1>
        {total != null && (
          <p style={{ fontWeight: 700, fontSize: "1.375rem", color: "var(--text)" }}>
            Total: ${total.toFixed(2)}
          </p>
        )}
        <p>Follow the prompts on the kiosk&apos;s payment reader to complete your payment.</p>
        <div className="centred-actions">
          <button className="btn btn-outline" type="button" onClick={onRepeat}>
            <RepeatIcon /> Repeat payment instructions
          </button>
          <button className="btn-ghost" type="button" onClick={onEnd} style={{ textAlign: "center" }}>
            End session
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// OrderCompleteScreen
// ============================================================

function OrderCompleteScreen({ kioskState }: { kioskState: KioskState | null }) {
  const orderNumber = kioskState?.orderNumber;
  return (
    <div className="page" role="main" aria-label="Order complete">
      <p className="sr-only" aria-live="polite">
        Order complete{orderNumber ? `, order number ${orderNumber}` : ""}.
      </p>
      <p className="page-brand" aria-hidden="true">Kiosk Access</p>
      <div className="centred-page">
        <div className="complete-check" aria-hidden="true">
          <CheckmarkIcon size={36} color="var(--sage-text)" />
        </div>
        <div className="panel panel-sage" role="status">Order placed successfully</div>
        <h1>Order complete</h1>
        <p>Thank you! Your order is confirmed and being prepared.</p>
        {orderNumber && (
          <p>
            <strong>Order number: {orderNumber}</strong>
          </p>
        )}
      </div>
    </div>
  );
}

// ============================================================
// SessionEndedScreen
// ============================================================

function SessionEndedScreen({ heading, body, recovery }: EndInfo) {
  return (
    <div className="page" role="main">
      <p className="sr-only" aria-live="polite">{heading}. {body}</p>
      <p className="page-brand" aria-hidden="true">Kiosk Access</p>
      <div className="centred-page">
        <h1 tabIndex={-1}>{heading}</h1>
        <p>{body}</p>
        {recovery && <div className="panel panel-lavender">{recovery}</div>}
      </div>
    </div>
  );
}

// ============================================================
// CantConnectScreen
// ============================================================

function CantConnectScreen({ code, detail }: { code: string; detail?: string }) {
  const info: ErrorInfo = ERROR_INFO[code] ?? ERROR_INFO.unknown;
  // detail is the raw server message — never shown to user, only logged
  void detail;

  return (
    <div className="page" role="main">
      <p className="sr-only" aria-live="assertive">{info.heading}. {info.body}</p>
      <p className="page-brand" aria-hidden="true">Kiosk Access</p>
      <div className="centred-page">
        <h1 tabIndex={-1}>{info.heading}</h1>
        <div className="panel panel-peach">{info.body}</div>
        <p>{info.recovery}</p>
        <div className="centred-actions">
          {info.canRetry && (
            <button className="btn btn-primary" type="button" onClick={() => window.location.reload()}>
              Try again
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// SettingsSheet
// ============================================================

const SPEECH_RATES = [
  { label: "Slow",   value: 0.75 },
  { label: "Normal", value: 1.0  },
  { label: "Fast",   value: 1.5  },
];

function SettingsSheet({ onClose }: { onClose(): void }) {
  const speechRate    = usePhone(s => s.speechRate);
  const setSpeechRate = usePhone(s => s.setSpeechRate);
  const firstFocusRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { firstFocusRef.current?.focus(); }, []);

  return (
    <div
      className="sheet-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      onKeyDown={e => { if (e.key === "Escape") onClose(); }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="sheet">
        <div className="sheet-handle" aria-hidden="true" />
        <div className="sheet-header">
          <h2 className="sheet-title">Settings</h2>
          <button className="btn-icon" type="button" ref={firstFocusRef} onClick={onClose} aria-label="Close settings">
            <CloseIcon />
          </button>
        </div>
        <div className="sheet-body">
          <div className="settings-row">
            <p className="settings-label" id="speech-rate-label">Assistant speaking speed</p>
            <div className="segmented" role="group" aria-labelledby="speech-rate-label">
              {SPEECH_RATES.map(r => (
                <button
                  key={r.value}
                  className="segmented-btn"
                  type="button"
                  aria-pressed={speechRate === r.value}
                  onClick={() => setSpeechRate(r.value)}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// CartReviewSheet
// ============================================================

function CartReviewSheet({ cart, onClose }: { cart: Cart; onClose(): void }) {
  const firstFocusRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { firstFocusRef.current?.focus(); }, []);

  return (
    <div
      className="sheet-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Current order"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={e => { if (e.key === "Escape") onClose(); }}
    >
      <div className="sheet">
        <div className="sheet-handle" aria-hidden="true" />
        <div className="sheet-header">
          <h2 className="sheet-title">Current order</h2>
          <button className="btn-icon" type="button" ref={firstFocusRef} onClick={onClose} aria-label="Close order review">
            <CloseIcon />
          </button>
        </div>
        <div className="cart-sheet-body">
          <ul aria-label="Order items" style={{ listStyle: "none", display: "flex", flexDirection: "column", gap: "0.625rem" }}>
            {cart.lines.map(line => <CartLineCard key={line.lineId} line={line} />)}
          </ul>
          {cart.lines.length > 0 && <PriceTable cart={cart} />}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// TextInput (fallback)
// ============================================================

function TextInput({ onSend, disabled }: { onSend(text: string): void; disabled?: boolean }) {
  const [value, setValue] = useState("");
  const submit = () => {
    const t = value.trim();
    if (!t) return;
    onSend(t);
    setValue("");
  };
  return (
    <div className="text-row" style={{ width: "100%" }}>
      <input
        className="text-field"
        type="text"
        placeholder="Or type here…"
        value={value}
        disabled={disabled}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter") submit(); }}
        aria-label="Type a message"
        autoComplete="off"
        style={{ flex: 1 }}
      />
      <button className="send-btn" type="button" onClick={submit} disabled={disabled || !value.trim()} aria-label="Send message">
        <SendIcon />
      </button>
    </div>
  );
}

// ============================================================
// LoginPage — visual only; not wired to auth backend.
// Ask before integrating: (1) does an auth backend exist?
// (2) is sign-in required or optional? (3) where in the NFC
// pairing + session flow should it appear?
// ============================================================

export function LoginPage({ onSubmit }: { onSubmit?(username: string): void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPwd,  setShowPwd]  = useState(false);
  const [error,    setError]    = useState("");
  const usernameId = "login-username";
  const passwordId = "login-password";
  const errorId    = "login-error";

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim()) { setError("Please enter your username."); return; }
    if (!password)        { setError("Please enter your password."); return; }
    setError("");
    onSubmit?.(username.trim());
  };

  return (
    <div className="page" role="main">
      <div className="login-inner">
        <AppLogo />
        <h1 className="login-heading">Sign in</h1>
        <p className="login-intro">Sign in to personalise your order and access saved preferences.</p>
        <form className="login-form-card" onSubmit={handleSubmit} aria-label="Sign in form" noValidate>
          {error && (
            <div id={errorId} className="panel panel-error" role="alert" aria-live="assertive">
              {error}
            </div>
          )}
          <div className="field">
            <label className="field-label" htmlFor={usernameId}>Username</label>
            <input
              id={usernameId}
              className="field-input"
              type="text"
              autoComplete="username"
              spellCheck={false}
              aria-required="true"
              aria-describedby={error ? errorId : undefined}
              value={username}
              onChange={e => setUsername(e.target.value)}
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor={passwordId}>Password</label>
            <div className="field-input-row">
              <input
                id={passwordId}
                className="field-input"
                type={showPwd ? "text" : "password"}
                autoComplete="current-password"
                aria-required="true"
                aria-describedby={error ? errorId : undefined}
                value={password}
                onChange={e => setPassword(e.target.value)}
              />
              <button
                type="button"
                className="field-show-pwd"
                onClick={() => setShowPwd(v => !v)}
                aria-label={showPwd ? "Hide password" : "Show password"}
                aria-pressed={showPwd}
              >
                {showPwd ? <EyeOffIcon /> : <EyeIcon />}
              </button>
            </div>
          </div>
          <button className="btn btn-primary" type="submit">Sign in</button>
        </form>
      </div>
    </div>
  );
}

// ============================================================
// SVG Icons
// ============================================================

function MicIcon({ active, size = 24 }: { active: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <rect x="8.5" y="2" width="7" height="12" rx="3.5" fill="currentColor" />
      <path d="M4 10c0 4.418 3.582 8 8 8s8-3.582 8-8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity={active ? 0.5 : 1} />
      <line x1="12" y1="18" x2="12" y2="22" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <line x1="8.5" y1="22" x2="15.5" y2="22" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path d="M22 2L11 13" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M22 2L15 22 11 13 2 9l20-7z" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CartIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="3" y1="6" x2="21" y2="6" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
      <path d="M16 10a4 4 0 01-8 0" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckmarkIcon({ size = 20, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path d="M20 6L9 17l-5-5" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2" />
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

function RepeatIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <polyline points="17 1 21 5 17 9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 11V9a4 4 0 014-4h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <polyline points="7 23 3 19 7 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M21 13v2a4 4 0 01-4 4H3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function ReaderIcon() {
  return (
    <svg width="40" height="40" viewBox="0 0 48 48" fill="none" aria-hidden="true" focusable="false">
      <rect x="10" y="8" width="28" height="32" rx="4" stroke="currentColor" strokeWidth="2.5" />
      <rect x="16" y="14" width="16" height="10" rx="2" fill="currentColor" opacity="0.2" />
      <rect x="16" y="14" width="16" height="10" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <line x1="16" y1="30" x2="22" y2="30" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <line x1="16" y1="34" x2="32" y2="34" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function KeyboardIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <rect x="2" y="6" width="20" height="12" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** Food illustration used on the Start screen — swap for real photography later. */
function FoodIllustration() {
  return (
    <svg width="140" height="140" viewBox="0 0 140 140" fill="none" aria-hidden="true" focusable="false">
      {/* Plate shadow */}
      <ellipse cx="70" cy="118" rx="42" ry="6" fill="rgba(72,86,150,0.07)" />
      {/* Plate */}
      <ellipse cx="70" cy="110" rx="40" ry="8" fill="#FEF3E2" stroke="#F5C370" strokeWidth="1.5" />
      {/* Bottom bun */}
      <path d="M34 92c0 10 16.268 18 36 18s36-8 36-18H34z" fill="#F9C784" stroke="#F5C370" strokeWidth="1.5" />
      {/* Lettuce frills */}
      <path d="M32 86c5-5 8-2 12 1 4-5 8-5 12 0 4-5 8-4 12 0 4-5 8-4 12 0 4-5 8-3 12 2H32z" fill="#A8D8A8" />
      {/* Cheese slice */}
      <path d="M30 82h80l-4 8H34l-4-8z" fill="#F9C784" stroke="#F5C370" strokeWidth="1" />
      {/* Patty */}
      <rect x="32" y="72" width="76" height="12" rx="4" fill="#C48A5A" />
      {/* Patty shading */}
      <rect x="32" y="72" width="76" height="5" rx="4" fill="rgba(255,255,255,0.08)" />
      {/* Top bun */}
      <path d="M36 70C36 52 52.536 38 70 38c17.464 0 34 14 34 32H36z" fill="#F9C784" stroke="#F5C370" strokeWidth="1.5" />
      {/* Sesame seeds */}
      <ellipse cx="58" cy="50" rx="3.5" ry="2" fill="#F5C370" transform="rotate(-15 58 50)" />
      <ellipse cx="70" cy="44" rx="3.5" ry="2" fill="#F5C370" transform="rotate(5 70 44)" />
      <ellipse cx="83" cy="49" rx="3.5" ry="2" fill="#F5C370" transform="rotate(-8 83 49)" />
      <ellipse cx="64" cy="57" rx="3" ry="1.8" fill="#F5C370" transform="rotate(10 64 57)" />
      <ellipse cx="76" cy="54" rx="3" ry="1.8" fill="#F5C370" transform="rotate(-5 76 54)" />
    </svg>
  );
}

// ============================================================
// AppLogo — used on splash-style screens (login, connecting,
// start) to give the app a consistent identity anchor.
// ============================================================

function AppLogo() {
  return (
    <div className="app-logo-wrap" aria-hidden="true">
      <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
        <rect width="32" height="32" rx="8" fill="var(--indigo)" />
        {/* Mic body */}
        <rect x="12" y="6" width="8" height="12" rx="4" fill="white" />
        {/* Mic arc */}
        <path d="M8 17c0 4.418 3.582 8 8 8s8-3.582 8-8" stroke="white" strokeWidth="2" strokeLinecap="round" />
        {/* Stand */}
        <line x1="16" y1="25" x2="16" y2="28" stroke="white" strokeWidth="2" strokeLinecap="round" />
        <line x1="12" y1="28" x2="20" y2="28" stroke="white" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <span className="app-logo-name">Kiosk Access</span>
    </div>
  );
}

function EyeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

function CameraOffIcon() {
  return (
    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path d="M1 1l22 22" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M21 21H3a2 2 0 01-2-2V8a2 2 0 012-2h3m3-3h6l2 3h4a2 2 0 012 2v9.34" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="13" r="3" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="1" y1="1" x2="23" y2="23" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

// ============================================================
// DemoApp — dev-only screen preview (mounted from main.tsx
// when URL contains ?demo).  Shows every screen with mock data
// so you can review designs without a live server.
// ============================================================

const DEMO_SCREENS: { id: string; label: string }[] = [
  { id: "login",       label: "Login" },
  { id: "scanner",     label: "QR Scanner" },
  { id: "connecting",  label: "Connecting" },
  { id: "start",       label: "Start" },
  { id: "conversation",label: "Conversation" },
  { id: "confirm",     label: "Confirm Order" },
  { id: "paying",      label: "Pay at Reader" },
  { id: "complete",    label: "Order Complete" },
  { id: "ended",       label: "Session Ended" },
  { id: "error-busy",  label: "Error: Busy" },
  { id: "error-expired", label: "Error: Expired" },
  { id: "error-offline", label: "Error: Offline" },
  { id: "settings",    label: "Settings" },
];

const MOCK_MSGS: ChatMessage[] = [
  { id: "1", role: "agent",  text: "Hi! What can I get you today?",                                awaitingConfirmation: false },
  { id: "2", role: "user",   text: "I'd like a cheeseburger",                                      awaitingConfirmation: false },
  { id: "3", role: "agent",  text: "Great! Would you like to add fries and a drink as a combo for $2 more?", awaitingConfirmation: false },
  { id: "4", role: "user",   text: "Yes please, medium size",                                      awaitingConfirmation: false },
  { id: "5", role: "agent",  text: "Perfect. I've added a Cheeseburger Combo (medium) to your order. Anything else?", awaitingConfirmation: false },
];

const MOCK_CART: Cart = {
  lines: [
    { lineId: "L1", itemId: "cb",  name: "Cheeseburger",   qty: 1, options: { size: ["Large"], extras: ["Extra cheese"] }, lineTotal: 7.99 },
    { lineId: "L2", itemId: "fr",  name: "Medium Fries",   qty: 1, options: {},                               lineTotal: 2.99 },
    { lineId: "L3", itemId: "dr",  name: "Fountain Drink", qty: 1, options: { size: ["Medium"] },             lineTotal: 1.49 },
  ],
  subtotal: 12.47,
  tax: 1.25,
  total: 13.72,
};

const MOCK_KIOSK_PAYING: KioskState = {
  kioskId: "store42-kiosk1",
  screen: "paying",
  title: "Payment",
  buttons: [],
  cart: MOCK_CART,
  sessionActive: true,
};

const MOCK_KIOSK_COMPLETE: KioskState = {
  kioskId: "store42-kiosk1",
  screen: "complete",
  title: "Thank you",
  buttons: [],
  cart: MOCK_CART,
  orderNumber: "142",
  sessionActive: true,
};

export function DemoApp() {
  const initialScreen = new URLSearchParams(window.location.search).get("demo") || "login";
  const [screen, setScreen] = useState(initialScreen);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Add/remove demo-mode class so CSS can offset scrollable content above the picker
  useEffect(() => {
    document.documentElement.classList.add("demo-mode");
    return () => document.documentElement.classList.remove("demo-mode");
  }, []);

  const noop = () => {};
  const noopStr = (_: string) => {};

  const renderScreen = () => {
    switch (screen) {
      case "login":
        return <LoginPage />;
      case "scanner":
        return <QrScannerScreen />;
      case "connecting":
        return <ConnectingScreen />;
      case "start":
        return <StartScreen kioskId="store42-kiosk1" onStartVoice={noop} onStartText={noop} />;
      case "conversation":
        return (
          <>
            <ConversationScreen
              messages={MOCK_MSGS}
              kioskState={{ kioskId: "store42-kiosk1", screen: "menu", title: "Menu", buttons: [], cart: MOCK_CART, sessionActive: true }}
              agentThinking={false}
              agentSpeaking={false}
              voiceListening={false}
              onSend={noopStr}
              onMicPress={noop}
              onEnd={noop}
              onSettings={() => setSettingsOpen(true)}
              onRepeat={noop}
              onCartReview={noop}
            />
            {settingsOpen && <SettingsSheet onClose={() => setSettingsOpen(false)} />}
          </>
        );
      case "confirm":
        return <ConfirmOrderScreen cart={MOCK_CART} onConfirm={noop as never} />;
      case "paying":
        return <PayAtReaderScreen kioskState={MOCK_KIOSK_PAYING} onEnd={noop} onRepeat={noop} />;
      case "complete":
        return <OrderCompleteScreen kioskState={MOCK_KIOSK_COMPLETE} />;
      case "ended":
        return (
          <SessionEndedScreen
            heading="Session timed out"
            body="Your session ended due to inactivity."
            recovery="Tap the kiosk tag to start a new session."
          />
        );
      case "error-busy":
        return <CantConnectScreen code="kiosk_busy" />;
      case "error-expired":
        return <CantConnectScreen code="code_expired" />;
      case "error-offline":
        return <CantConnectScreen code="kiosk_offline" />;
      case "settings":
        return (
          <div className="page" style={{ position: "relative" }}>
            <div style={{ flex: 1, background: "var(--lavender)" }} />
            <SettingsSheet onClose={noop} />
          </div>
        );
      default:
        return <ConnectingScreen />;
    }
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", position: "relative" }}>
      <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
        {renderScreen()}
      </div>

      {/* Floating screen picker */}
      <div style={{
        position: "fixed",
        bottom: 0, left: 0, right: 0,
        background: "rgba(30,25,53,0.92)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        padding: "0.625rem 1rem",
        paddingBottom: "max(0.625rem, env(safe-area-inset-bottom))",
        zIndex: 9999,
        display: "flex",
        flexDirection: "column",
        gap: "0.375rem",
      }}>
        <p style={{ color: "rgba(255,255,255,0.45)", fontSize: "0.7rem", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}>
          Preview — tap a screen
        </p>
        <div style={{ display: "flex", gap: "0.5rem", overflowX: "auto", paddingBottom: "0.25rem" }}>
          {DEMO_SCREENS.map(s => (
            <button
              key={s.id}
              type="button"
              onClick={() => { setSettingsOpen(false); setScreen(s.id); }}
              style={{
                flexShrink: 0,
                padding: "0.4rem 0.875rem",
                borderRadius: "999px",
                border: screen === s.id ? "2px solid var(--peach)" : "2px solid rgba(255,255,255,0.15)",
                background: screen === s.id ? "var(--peach)" : "transparent",
                color: screen === s.id ? "var(--text)" : "rgba(255,255,255,0.75)",
                fontSize: "0.8125rem",
                fontWeight: screen === s.id ? 700 : 500,
                cursor: "pointer",
                fontFamily: "inherit",
                whiteSpace: "nowrap",
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
