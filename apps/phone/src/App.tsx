import { useCallback, useEffect, useRef, useState } from "react";
import { normalizeCode } from "@kiosk-access/shared";
import type { Cart, CartLine, KioskState, SessionEndReason } from "@kiosk-access/shared";
import { attachProfile, connectSocket, createSession, deleteProfile, fetchProfile, parseParams, updateProfile, type PhoneProfile } from "./connection.ts";
import type { PhoneSocket } from "./connection.ts";
import type { ChatMessage } from "./store.ts";
import { usePhone } from "./store.ts";
import { createAgentVoice } from "./agentSpeech.ts";
import { bindVoiceSocket } from "./voiceSocket.ts";
import { greeting, placeName, placeNameForKind, wantsToStart } from "./greeting.ts";
import { speechSupport } from "./speech.ts";
import { enableVoiceFallback, prepareMic, releaseMic, unlockAudio } from "./voiceFallback.ts";
import { navigate } from "./nav.ts";
import { iosNonSafari, permissionSteps, queryPermission, type Device } from "./permissions.ts";
import { CAMERA_PROBLEM_TEXT, CameraError, startQrScanner, type CameraProblem } from "./qrScanner.ts";
import { MENU_ITEMS } from "./menuData.ts";

let _id = 0;
const uid = () => String(++_id);

/** Keeps this phone's saved profile, and uses its speaking speed for spoken replies. */
function applyProfile(p: PhoneProfile) {
  const store = usePhone.getState();
  store.setProfile(p);
  const rate = p.preferences?.speechRate;
  if (rate && rate !== store.speechRate) store.setSpeechRate(rate);
}

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
  code_not_found: { heading: "Code not found",         body: "We couldn't find a kiosk with that code.",           recovery: "Check the code on the kiosk and try again. Codes look like FD12345.", canRetry: false },
  too_many_attempts: { heading: "Too many tries",      body: "Too many wrong codes were entered.",                  recovery: "Wait a few minutes, then try again or ask staff for help.", canRetry: false },
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
  // Welcome screen: the assistant asks "Do you want to start ordering?" before the chat opens.
  const [welcome, setWelcome] = useState<WelcomeStatus>("idle");
  const [settingsOpen,  setSettingsOpen]  = useState(false);
  const [cartReviewOpen, setCartReviewOpen] = useState(false);
  const [permissionHelp, setPermissionHelp] = useState<Device | null>(null);
  // Mic not allowed yet: wait for the Start tap so the browser's prompt comes with a reason.
  const [micNeedsTap, setMicNeedsTap] = useState(false);
  const askToStartRef = useRef<(auto?: boolean) => void>(() => {});

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
    let disableVoiceFallback: (() => void) | null = null;

    (async () => {
      try {
        const sess = await createSession(params);
        if (cancelled) return;
        socket = connectSocket(sess.sessionId, sess.sessionSecret);
        socketRef.current = socket;
        // If the browser can't do speech-to-text (Chrome on iPhone), record and let the server transcribe.
        disableVoiceFallback = enableVoiceFallback(sess.sessionId, sess.sessionSecret);
        // Recognise a returning customer (no login screen). Ordering doesn't wait for it.
        void attachProfile(sess.sessionId, sess.sessionSecret).then(p => { if (p && !cancelled) applyProfile(p); });

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
          // Voice problems ("Tap the microphone to answer") appear in the chat, so they're seen and announced.
          showStatus: (msg) => {
            // Don't repeat the same notice over and over.
            const last = usePhone.getState().messages.at(-1);
            if (last?.role === "agent" && last.text === msg) return;
            usePhone.getState().pushMessage({ id: uid(), role: "agent", text: msg, awaitingConfirmation: false });
          },
          permissionDenied: () => setPermissionHelp("microphone"),
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
          // Voice ordering turns itself on (greet, then listen) when the mic is already allowed.
          // Otherwise wait for a tap: a surprise mic prompt on page load looks broken, and iPhones
          // keep the greeting silent until a tap anyway. Chrome on iPhone asks again on every visit.
          if (!usePhone.getState().orderingStarted && speechSupport().recognition) {
            void queryPermission("microphone").then((mic) => {
              if (cancelled || usePhone.getState().orderingStarted) return;
              if (mic === "prompt" || (mic !== "granted" && iosNonSafari())) { setMicNeedsTap(true); return; }
              askToStartRef.current(true);
            });
          }
        });
        socket.on("connect_error", e => {
          if (!cancelled) store.setError("connect_failed", e.message);
        });
        socket.on("kiosk:state", state => store.setKioskState(state));
        // The customer may have just asked to be remembered ("speak slower"): pick up the change.
        socket.on("agent:message", () => { void fetchProfile().then(p => { if (p && !cancelled) applyProfile(p); }); });
        socket.on("agent:message", msg => {
          setAgentThinking(false);
          store.setAwaitingConfirmation(msg.awaitingConfirmation);
          store.pushMessage({ id: uid(), role: "agent", text: msg.text, awaitingConfirmation: msg.awaitingConfirmation });
          // If agent responds before user tapped Start, jump straight to conversation
          if (!usePhone.getState().orderingStarted) store.setOrderingStarted(true);
        });
        socket.on("session:ended", info => {
          releaseMic();
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
      disableVoiceFallback?.();
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

  // Opens the chat. With voice, the greeting is spoken and the mic then reopens by itself after every reply.
  // auto: started without a tap (iPhones may keep the greeting silent until the first touch).
  const enterChat = useCallback((withVoice: boolean, auto = false) => {
    const store = usePhone.getState();
    store.setOrderingStarted(true);
    const hello = greeting(store.kioskState, store.profile);
    store.pushMessage({ id: uid(), role: "agent", text: hello, awaitingConfirmation: false });
    if (withVoice) {
      unlockAudio(); // iPhones only allow recording audio after a tap
      voiceRef.current?.setEnabled(true, { handsFree: true });
      void voiceRef.current?.greet(hello, { auto });
    }
  }, []);

  // The first touch anywhere lets iPhones play speech and record (they block both until a tap).
  useEffect(() => {
    // ...and plays anything the phone couldn't say before that touch.
    const unlock = () => { unlockAudio(); voiceRef.current?.replaySilent(); };
    document.addEventListener("pointerdown", unlock, { once: true });
    return () => document.removeEventListener("pointerdown", unlock);
  }, []);

  // The customer's first tap on the welcome screen (browsers only allow speech after a tap):
  // the assistant asks whether to start, and a yes opens the chat.
  // auto: runs by itself right after connecting, so the mic turns on without a tap.
  const askToStart = useCallback(async (auto = false) => {
    const voice = voiceRef.current;
    if (!voice) { enterChat(false); return; }
    setMicNeedsTap(false);
    unlockAudio();
    // Ask for the mic now. Already blocked: show how to turn it on instead of listening.
    const mic = await queryPermission("microphone");
    if (mic === "denied" || (iosNonSafari() && (await prepareMic()) === "denied")) {
      setPermissionHelp("microphone");
      return;
    }
    voice.setEnabled(true);
    setWelcome("asking");
    const answer = await voice.ask(`Welcome to ${placeName(usePhone.getState().kioskState)}. Do you want to start ordering?`, { auto });
    if (answer && wantsToStart(answer)) { setWelcome("idle"); enterChat(true, auto); return; }
    setWelcome(answer ? "declined" : "unheard");
    if (answer) void voice.speakFeedback("Okay. Tap Start ordering whenever you're ready.");
  }, [enterChat]);
  askToStartRef.current = (auto) => { void askToStart(auto); };

  // Stop the conversation loop on screens where voice ordering doesn't apply (Nidhi).
  useEffect(() => {
    const ks = kioskState?.screen;
    if (ks === "paying" || ks === "complete") {
      voiceRef.current?.setEnabled(false);
    }
  }, [kioskState?.screen]);

  const micHelp = permissionHelp && (
    <PermissionHelpSheet
      device={permissionHelp}
      onClose={() => setPermissionHelp(null)}
      onRetry={() => {
        setPermissionHelp(null);
        unlockAudio();
        if (!usePhone.getState().orderingStarted) { void askToStart(); return; }
        voiceRef.current?.setEnabled(true, { handsFree: true });
        void voiceRef.current?.listenAndSend();
      }}
    />
  );

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
    <>
      <StartScreen
        place={placeName(kioskState)}
        status={voiceListening ? "listening" : agentSpeaking ? "asking" : welcome}
        micNeedsTap={micNeedsTap}
        onStartVoice={() => { void askToStart(); }}
        onStartText={() => enterChat(false)}
        onProfile={() => setSettingsOpen(true)}
      />
      {settingsOpen && <SettingsSheet onClose={() => setSettingsOpen(false)} />}
      {micHelp}
    </>
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
        onMicPress={() => { unlockAudio(); void voiceRef.current?.listenAndSend(); }}
        onEnd={endSession}
        onSettings={() => setSettingsOpen(true)}
        onRepeat={repeatLastMessage}
        onCartReview={() => setCartReviewOpen(true)}
      />
      {settingsOpen && <SettingsSheet onClose={() => setSettingsOpen(false)} />}
      {micHelp}
      {cartReviewOpen && kioskState?.cart && (
        <CartReviewSheet cart={kioskState.cart} onClose={() => setCartReviewOpen(false)} />
      )}
    </>
  );
}

// ============================================================
// QrScannerScreen
// ============================================================

/** Parse a full QR URL and extract the relative path + params we need. */
function parseQrUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (/^\/c\/[A-Za-z0-9]+$/.test(url.pathname)) return url.pathname; // kiosk code link
    const match = url.pathname.match(/^\/k\/([^/?#]+)/);
    const token = url.searchParams.get("t");
    if (!match?.[1] || !token) return null;
    return url.pathname + url.search; // relative path to navigate to
  } catch {
    return null;
  }
}

export function QrScannerScreen() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const [camera, setCamera] = useState<"starting" | "on" | CameraProblem>("starting");
  const [helpOpen, setHelpOpen] = useState(false);
  const [found, setFound] = useState(false);
  const [codeInput, setCodeInput] = useState("");
  const [codeError, setCodeError] = useState("");

  const startCamera = useCallback(async () => {
    if (!videoRef.current) return;
    stopRef.current?.();
    setCamera("starting");
    try {
      stopRef.current = await startQrScanner(videoRef.current, (text) => {
        const path = parseQrUrl(text);
        if (!path) return false; // some other QR code, keep scanning
        setFound(true);
        navigator.vibrate?.(60);
        navigate(path); // no reload, so the mic isn't asked for again
        return true;
      });
      setCamera("on");
    } catch (err) {
      const problem = err instanceof CameraError ? err.problem : "failed";
      setCamera(problem);
      if (problem === "denied") setHelpOpen(true);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    // Open the camera automatically. Already allowed: it just shows. Not asked yet: the browser asks.
    // Blocked: don't bother the browser, show how to turn it on.
    void queryPermission("camera").then((status) => {
      if (!alive) return;
      if (status === "denied") { setCamera("denied"); setHelpOpen(true); }
      else void startCamera();
    });
    return () => { alive = false; stopRef.current?.(); stopRef.current = null; };
  }, [startCamera]);

  const cameraProblem = camera !== "starting" && camera !== "on" ? camera : null;
  const canRetry = cameraProblem && cameraProblem !== "insecure" && cameraProblem !== "unsupported" && cameraProblem !== "not_found";

  // Kiosk codes: FD (food), CN (cinema), TR (transit), HP (hospital) + 5 digits, e.g. FD48213.
  const submitCode = () => {
    const code = normalizeCode(codeInput);
    if (!code) {
      setCodeError("Codes are two letters and five numbers, like FD12345.");
      return;
    }
    setCodeError("");
    navigate(`/c/${code}`);
  };

  return (
    <div className="page" role="main" aria-label="Scan the kiosk QR code">
      <header className="welcome-top"><AppLogo /></header>
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
        ) : (
          <div className="scanner-viewfinder" aria-label="Camera viewfinder">
            <video ref={videoRef} className="scanner-video" muted playsInline autoPlay aria-hidden="true" />
            {camera === "on" && (
              <div className="scanner-frame" aria-hidden="true">
                <div className="scanner-corner scanner-corner-tl" />
                <div className="scanner-corner scanner-corner-tr" />
                <div className="scanner-corner scanner-corner-bl" />
                <div className="scanner-corner scanner-corner-br" />
                <div className="scanner-line" />
              </div>
            )}
            {camera === "starting" && (
              <div className="scanner-placeholder" role="status">
                <span>Opening camera…</span>
              </div>
            )}
            {cameraProblem && (
              <div className="scanner-placeholder" role="alert">
                <CameraOffIcon />
                <span>{CAMERA_PROBLEM_TEXT[cameraProblem]}</span>
                {canRetry && (
                  <button type="button" className="btn btn-primary scanner-retry" onClick={startCamera}>
                    Turn on camera
                  </button>
                )}
                {cameraProblem === "denied" && (
                  <button type="button" className="scanner-help-link" onClick={() => setHelpOpen(true)}>
                    How do I allow the camera?
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        <form
          className="code-entry"
          onSubmit={e => { e.preventDefault(); submitCode(); }}
          aria-labelledby="code-entry-heading"
        >
          <h2 id="code-entry-heading" className="code-entry-heading">Or enter the kiosk code</h2>
          <p id="code-entry-hint" className="code-entry-hint">
            It&apos;s shown under the QR code on the kiosk, for example FD12345.
          </p>
          <div className="code-entry-row">
            <input
              className="code-field"
              type="text"
              inputMode="text"
              autoCapitalize="characters"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              maxLength={9}
              placeholder="FD12345"
              value={codeInput}
              onChange={e => { setCodeInput(e.target.value.toUpperCase()); setCodeError(""); }}
              aria-label="Kiosk code"
              aria-describedby="code-entry-hint"
              aria-invalid={Boolean(codeError)}
            />
            <button className="btn btn-primary code-connect" type="submit">Connect</button>
          </div>
          {codeError && <p className="code-entry-error" role="alert">{codeError}</p>}
        </form>

        <a className="profile-link" href="/profile">My profile &amp; order history</a>


        <div className="scanner-menu-preview">
          <p className="scanner-menu-heading">Today&apos;s Menu</p>
          <MenuCarousel compact />
        </div>
      </div>
      {helpOpen && (
        <PermissionHelpSheet device="camera" onClose={() => setHelpOpen(false)} onRetry={() => { setHelpOpen(false); void startCamera(); }} />
      )}
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

type WelcomeStatus = "idle" | "asking" | "listening" | "declined" | "unheard";

const WELCOME_STATUS: Record<WelcomeStatus, string> = {
  idle: "Tap anywhere to start talking.",
  asking: "Speaking…",
  listening: "Listening… say yes to start.",
  declined: "No problem. Tap Start ordering whenever you're ready.",
  unheard: "I didn't catch that. Tap Start ordering to try again.",
};

const MIC_NOTE = "Tap Start ordering. Your phone will ask to use the microphone: tap Allow.";

function StartScreen({ place, status, micNeedsTap, onStartVoice, onStartText, onProfile }: {
  place: string;
  status: WelcomeStatus;
  micNeedsTap: boolean;
  onStartVoice(): void;
  onStartText(): void;
  onProfile(): void;
}) {
  const hasSpeech = speechSupport().recognition;
  const busy = status === "asking" || status === "listening";
  // A tap anywhere starts voice ordering (the button keeps focus, so a VoiceOver double-tap anywhere works too).
  const tapAnywhere = (e: React.MouseEvent) => {
    if (hasSpeech && !busy && !(e.target as HTMLElement).closest("button, a")) onStartVoice();
  };
  return (
    <div className="page welcome-page" role="main" onClick={tapAnywhere}>
      <header className="welcome-top">
        <AppLogo />
        <span className="place-chip" role="status"><span className="place-dot" aria-hidden="true" />{place}</span>
      </header>

      <div className="welcome-hero">
        <div className={`voice-orb${busy ? ` voice-orb-${status}` : ""}`} aria-hidden="true">
          <span /><span /><span />
          <MicIcon active={status === "listening"} size={40} />
        </div>
        <h1 className="welcome-heading">Hi! Ready to order?</h1>
        <p className="welcome-sub">Just talk. I&apos;ll tap through the kiosk for you and read everything back before you pay.</p>
        <p className="welcome-status" aria-live="polite">{!hasSpeech ? "Type your order below." : micNeedsTap && status === "idle" ? MIC_NOTE : WELCOME_STATUS[status]}</p>
      </div>

      <ProfileCard />

      <div className="welcome-actions">
        {hasSpeech && (
          <button className="btn btn-primary btn-xl" type="button" onClick={onStartVoice} disabled={busy} autoFocus>
            <MicIcon active={false} size={26} />
            Start ordering
          </button>
        )}
        <button className="btn btn-outline" type="button" onClick={onStartText}>
          <KeyboardIcon />
          Type instead
        </button>
        <button className="btn-ghost welcome-profile" type="button" onClick={onProfile}>
          My profile &amp; order history
        </button>
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
  /** Tap to talk: a fallback when a browser won't reopen the mic by itself. */
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

  const voiceStatusLabel: Record<VoiceState, string> = {
    idle:      "Type your message below",
    listening: "Listening…",
    thinking:  "Thinking…",
    speaking:  "Speaking…",
  };

  const brandName = kioskState?.kioskId
    ? kioskState.kioskId.replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase())
    : "AllScreen";

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
        {/* Ambient voice status — replaces the mic button */}
        <div className="voice-status-bar" role="status" aria-live="polite">
          {effectiveVoiceState === "listening" && (
            <span className="voice-ring-inline" aria-hidden="true" />
          )}
          {effectiveVoiceState === "speaking" && (
            <span className="voice-wave-inline" aria-hidden="true">
              <span /><span /><span />
            </span>
          )}
          {effectiveVoiceState === "thinking" && (
            <span className="thinking-dots" aria-hidden="true">
              <span /><span /><span />
            </span>
          )}
          {effectiveVoiceState === "idle" && hasSpeech ? (
            // The conversation reopens the mic by itself; this is the fallback when a browser won't.
            <button className="tap-to-talk" type="button" onClick={onMicPress} aria-label="Tap to talk">
              <MicIcon active={false} size={18} />
              <span>Tap to talk</span>
            </button>
          ) : (
            <span className="voice-status-text">{voiceStatusLabel[effectiveVoiceState]}</span>
          )}
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
      <header className="welcome-top"><AppLogo /></header>
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
      <header className="welcome-top"><AppLogo /></header>
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
      <header className="welcome-top"><AppLogo /></header>
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
      <header className="welcome-top"><AppLogo /></header>
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
      <header className="welcome-top"><AppLogo /></header>
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

/** What this phone's profile remembers, shown on the start screen. */
function ProfileCard() {
  const profile = usePhone(s => s.profile);
  if (!profile) return null;
  const p = profile.preferences ?? {};
  const facts = [
    p.diet?.length ? p.diet.join(" and ") : "",
    p.allergies?.length ? `allergic to ${p.allergies.join(", ")}` : "",
  ].filter(Boolean);
  if (!profile.returning && !p.name && !facts.length) return null;
  return (
    <section className="panel panel-lavender profile-card" aria-label="Your profile">
      <p className="profile-card-title">{p.name ? `Welcome back, ${p.name}` : "Welcome back"}</p>
      {profile.lastOrder?.spoken && <p>Last time here: {profile.lastOrder.spoken}</p>}
      {facts.length > 0 && <p>Remembered: {facts.join(" · ")}</p>}
      <p className="profile-card-hint">Change these in Settings, or just tell the assistant.</p>
    </section>
  );
}

/** Edit what's remembered: name, diet, allergies and speaking speed. Saved on the server. */
function ProfileEditor() {
  const profile = usePhone(s => s.profile);
  const setProfile = usePhone(s => s.setProfile);
  const speechRate = usePhone(s => s.speechRate);
  const p = profile?.preferences ?? {};
  const [name, setName] = useState(p.name ?? "");
  const [diet, setDiet] = useState<string[]>(p.diet ?? []);
  const [allergies, setAllergies] = useState((p.allergies ?? []).join(", "));
  const [status, setStatus] = useState("");

  if (!profile) return <p className="settings-label">Your profile appears after you start an order.</p>;

  const toggleDiet = (d: string) => setDiet(cur => cur.includes(d) ? cur.filter(x => x !== d) : [...cur, d]);
  const save = async () => {
    setStatus("Saving…");
    const result = await updateProfile({
      ...(name.trim() ? { name: name.trim() } : {}),
      diet,
      allergies: allergies.split(",").map(a => a.trim()).filter(Boolean),
      speechRate,
    });
    if ("error" in result) { setStatus(result.error); return; }
    setProfile(result);
    setStatus("Saved.");
  };

  return (
    <div className="profile-editor" role="group" aria-labelledby="profile-heading">
      <p className="settings-label" id="profile-heading">Your profile</p>
      <label className="profile-field">
        <span>Name</span>
        <input className="text-field" value={name} onChange={e => setName(e.target.value)} maxLength={40} autoComplete="given-name" />
      </label>
      <div className="segmented" role="group" aria-label="Diet">
        {["vegetarian", "vegan"].map(d => (
          <button key={d} className="segmented-btn" type="button" aria-pressed={diet.includes(d)} onClick={() => toggleDiet(d)}>
            {d[0].toUpperCase() + d.slice(1)}
          </button>
        ))}
      </div>
      <label className="profile-field">
        <span>Allergies (separate with commas)</span>
        <input className="text-field" value={allergies} onChange={e => setAllergies(e.target.value)} placeholder="e.g. peanuts, shellfish" />
      </label>
      <p className="profile-card-hint">The menu has no allergen details, so the assistant will flag these but can&apos;t promise an item is safe.</p>
      <button className="btn btn-primary" type="button" onClick={save}>Save profile</button>
      <p className="profile-status" role="status" aria-live="polite">{status}</p>
    </div>
  );
}

/** Past orders on this phone, newest first. */
function OrderHistory() {
  const history = usePhone(s => s.profile?.history) ?? [];
  return (
    <section className="history" aria-labelledby="history-heading">
      <p className="settings-label" id="history-heading">Order history</p>
      {history.length === 0 ? (
        <p className="profile-card-hint">Nothing yet. Orders you finish at a kiosk will show up here.</p>
      ) : (
        <ul className="history-list">
          {history.map((o, i) => (
            <li key={`${o.at}-${i}`} className="history-item">
              <div className="history-head">
                <span className="history-place">{placeNameForKind(o.kind)}</span>
                <span className="history-total">${o.total.toFixed(2)}</span>
              </div>
              <p className="history-items">{o.lines.map(l => `${l.qty}× ${l.name}`).join(" · ")}</p>
              <p className="history-date">
                {new Date(o.at).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
                {" · "}
                {new Date(o.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** "Forget me": the first tap asks, the second deletes everything saved on this phone. */
function ForgetButton({ onDone }: { onDone?(): void }) {
  const [forget, setForget] = useState<"idle" | "confirm" | "deleting" | "done" | "failed">("idle");
  const onForget = async () => {
    if (forget === "idle" || forget === "failed") { setForget("confirm"); return; }
    if (forget !== "confirm") return;
    setForget("deleting");
    const ok = await deleteProfile();
    setForget(ok ? "done" : "failed");
    if (ok) onDone?.();
  };
  const label = {
    idle: "Delete my saved data",
    confirm: "Tap again to delete your name, preferences and past orders",
    deleting: "Deleting…",
    done: "Deleted. This phone will start fresh next time.",
    failed: "Couldn't delete right now. Tap to try again.",
  }[forget];
  return (
    <div className="settings-row">
      <p className="settings-label" id="forget-label">Saved data</p>
      <button
        className={forget === "confirm" ? "btn btn-danger" : "btn btn-outline"}
        type="button"
        aria-describedby="forget-label"
        aria-live="polite"
        disabled={forget === "deleting" || forget === "done"}
        onClick={onForget}
      >
        {label}
      </button>
    </div>
  );
}

/** allscreen.work/profile: saved preferences and order history, without a kiosk. */
export function ProfilePage() {
  const profile = usePhone(s => s.profile);
  const [status, setStatus] = useState<"loading" | "none" | "ready">("loading");
  useEffect(() => {
    void fetchProfile().then(p => {
      if (p) { applyProfile(p); setStatus("ready"); } else setStatus("none");
    });
  }, []);
  return (
    <div className="page profile-page" role="main" aria-labelledby="profile-page-title">
      <header className="welcome-top">
        <AppLogo />
        <a className="place-chip" href="/">Scan a kiosk</a>
      </header>
      <h1 className="page-title" id="profile-page-title">Your profile</h1>
      <p className="welcome-sub">Saved on this phone only. No account, no password: AllScreen remembers your orders, not who you are.</p>
      {status === "loading" && <p className="welcome-status" role="status">Loading…</p>}
      {status === "none" && (
        <div className="panel panel-lavender">
          <p>No profile on this phone yet. It&apos;s created automatically the first time you order at a kiosk.</p>
        </div>
      )}
      {status === "ready" && profile && (
        <>
          <section className="profile-section"><ProfileEditor /></section>
          <section className="profile-section"><OrderHistory /></section>
          <section className="profile-section"><ForgetButton onDone={() => setStatus("none")} /></section>
        </>
      )}
    </div>
  );
}

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
          <ProfileEditor />
          <OrderHistory />
          <ForgetButton />
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

function PermissionHelpSheet({ device, onClose, onRetry }: { device: Device; onClose(): void; onRetry(): void }) {
  const retryRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { retryRef.current?.focus(); }, []);
  const name = device === "camera" ? "camera" : "microphone";
  const steps = permissionSteps(device);
  return (
    <div
      className="sheet-backdrop"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="perm-title"
      aria-describedby="perm-body"
      onKeyDown={e => { if (e.key === "Escape") onClose(); }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="sheet">
        <div className="sheet-handle" aria-hidden="true" />
        <div className="sheet-header">
          <h2 className="sheet-title" id="perm-title">Turn on the {name}</h2>
          <button className="btn-icon" type="button" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>
        <div className="sheet-body">
          <p id="perm-body" className="perm-body">
            Your browser blocked the {name}. A website can't change this setting, but it only takes a moment:
          </p>
          <ol className="perm-steps">
            {steps.map((step, i) => <li key={i}>{step}</li>)}
          </ol>
          <button ref={retryRef} className="btn btn-primary perm-retry" type="button" onClick={onRetry}>
            Try again
          </button>
          <button className="btn btn-outline perm-later" type="button" onClick={onClose}>
            {device === "camera" ? "Enter the code instead" : "Type instead"}
          </button>
        </div>
      </div>
    </div>
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

function MenuCarousel({ compact = false }: { compact?: boolean }) {
  return (
    <div className="menu-carousel-wrap">
      {!compact && <p className="menu-carousel-label">Menu</p>}
      <div className="menu-carousel" role="list" aria-label="Menu items">
        {MENU_ITEMS.map(item => (
          <div key={item.id} className="menu-card" role="listitem">
            <img src={item.image} alt={item.name} className="menu-card-img" loading="lazy" />
            <div className="menu-card-body">
              <p className="menu-card-name">{item.name}</p>
              <p className="menu-card-price">${item.price.toFixed(2)}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Food illustration used on the Start screen — swap for real photography later. */

// ============================================================
// AppLogo — used on splash-style screens (login, connecting,
// start) to give the app a consistent identity anchor.
// ============================================================

function AppLogo() {
  return (
    <div className="app-logo-wrap" aria-label="AllScreen">
      <svg width="34" height="34" viewBox="0 0 34 34" fill="none" aria-hidden="true">
        <defs>
          <linearGradient id="allscreen-mark" x1="0" y1="0" x2="34" y2="34" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#485696" />
            <stop offset="1" stopColor="#7C6FD6" />
          </linearGradient>
        </defs>
        <rect width="34" height="34" rx="10" fill="url(#allscreen-mark)" />
        {/* A voice wave: talking to any screen */}
        <rect x="8" y="14" width="3" height="6" rx="1.5" fill="white" />
        <rect x="13" y="10" width="3" height="14" rx="1.5" fill="white" />
        <rect x="18" y="7" width="3" height="20" rx="1.5" fill="#F9C784" />
        <rect x="23" y="12" width="3" height="10" rx="1.5" fill="white" />
      </svg>
      <span className="app-logo-name">All<span>Screen</span></span>
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
  { id: "scanner",  label: "Scan QR" },
  { id: "settings", label: "Settings" },
];

const MOCK_MSGS: ChatMessage[] = [
  { id: "1", role: "agent",  text: "Hey! Welcome to Raising Cane's. What can I get you today?",                             awaitingConfirmation: false },
  { id: "2", role: "user",   text: "I'll have The Box Combo",                                                                awaitingConfirmation: false },
  { id: "3", role: "agent",  text: "Love it! The Box Combo comes with 4 chicken fingers, crinkle-cut fries, coleslaw, Cane's sauce, and Texas toast. Want to add an extra Cane's sauce for $0.50?", awaitingConfirmation: false },
  { id: "4", role: "user",   text: "Yes please",                                                                             awaitingConfirmation: false },
  { id: "5", role: "agent",  text: "Perfect. I've added The Box Combo with an extra Cane's Sauce. Anything else?",          awaitingConfirmation: false },
];

const MOCK_CART: Cart = {
  lines: [
    { lineId: "L1", itemId: "box", name: "The Box Combo",      qty: 1, options: { includes: ["4 Chicken Fingers", "Crinkle-Cut Fries", "Coleslaw", "Texas Toast"] }, lineTotal: 13.49 },
    { lineId: "L2", itemId: "cs",  name: "Extra Cane's Sauce", qty: 1, options: {},                                                                                   lineTotal: 0.50  },
  ],
  subtotal: 13.99,
  tax: 1.40,
  total: 15.39,
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
  const initialScreen = new URLSearchParams(window.location.search).get("demo") || "scanner";
  const [screen, setScreen] = useState(initialScreen);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Add/remove demo-mode class so CSS can offset scrollable content above the picker
  useEffect(() => {
    document.documentElement.classList.add("demo-mode");
    return () => document.documentElement.classList.remove("demo-mode");
  }, []);

  const noop = () => {};

  const renderScreen = () => {
    switch (screen) {
      case "settings":
        return (
          <div className="page" style={{ position: "relative" }}>
            <div style={{ flex: 1, background: "var(--lavender)" }} />
            <SettingsSheet onClose={noop} />
          </div>
        );
      case "scanner":
      default:
        // QrScannerScreen navigates via window.location.href when it reads a real code,
        // which reloads the page at /k/:kioskId?t=... and kicks off the real App flow.
        return <QrScannerScreen />;
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
          AllScreen
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
