import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import type { ConnectionStatus } from "@kiosk-access/sdk";
import type { SessionEndReason, SessionInfo } from "@kiosk-access/shared";
import { access, kioskId } from "./connection.ts";
import { currentState, runCommand } from "./executor.ts";
import { Finger } from "./finger.tsx";
import { ids } from "./model.ts";
import {
  CartScreen,
  CheckoutScreen,
  CompleteScreen,
  ItemScreen,
  MenuScreen,
  PayingScreen,
  Popup,
} from "./Screens.tsx";
import { useKiosk } from "./store.ts";

const END_REASONS: Record<SessionEndReason, string> = {
  idle_timeout: "Accessible session ended after inactivity",
  order_complete: "Accessible order complete",
  staff_ended: "Accessible session ended by staff",
  phone_disconnected: "Phone disconnected",
  user_ended: "Customer ended the session",
  kiosk_disconnected: "Kiosk lost connection",
};

const IDLE_MS = 90_000;
const STILL_THERE_MS = 20_000;

access.onCommand(runCommand);

export function App() {
  const screen = useKiosk((s) => s.screen);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [toast, setToast] = useState<string | null>(null);
  const sessionActive = Boolean(session?.active);

  useEffect(() => {
    const offs = [
      access.onPairingCode(setQrUrl),
      access.onStatus(setStatus),
      access.onSession((info) => {
        setSession(info);
        if (!info.active && info.reason) setToast(END_REASONS[info.reason]);
        // A finished or abandoned accessible order shouldn't linger for the next customer.
        if (!info.active && info.reason !== "order_complete") useKiosk.getState().cancelOrder();
      }),
      access.onPing((p) => setToast(`Ping from ${p.from}: ${p.text || "(empty)"}`)),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  // Publish state whenever the store or session changes (debounced ~100 ms).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const publish = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => access.publishState(currentState()), 100);
    };
    publish();
    const unsub = useKiosk.subscribe(publish);
    return () => { unsub(); if (timer) clearTimeout(timer); };
  }, [sessionActive]);

  useInactivityReset(sessionActive);

  return (
    <div className="stage">
      <main className={`kiosk ${sessionActive ? "in-session" : ""}`} aria-label="Self-order kiosk">
        <header className="kiosk-header">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">HB</span>
            <span className="brand-name">Harbor Burger</span>
          </div>
        </header>

        {screen === "welcome" && <WelcomeScreen qrUrl={sessionActive ? null : qrUrl} status={status} />}
        {screen === "menu" && <MenuScreen />}
        {screen === "item" && <ItemScreen />}
        {screen === "cart" && <CartScreen />}
        {screen === "checkout" && <CheckoutScreen />}
        {screen === "paying" && <PayingScreen />}
        {screen === "complete" && <CompleteScreen />}
        <Popup />

        {sessionActive && (
          <>
            {/* Blocks touch on everything except the card reader; the assistant's taps are programmatic. */}
            <div className="touch-blocker" aria-hidden="true" />
            <div className="session-banner" role="status">
              <span className="pulse" aria-hidden="true" />
              <div className="session-copy">
                <p className="session-title">Accessible ordering in progress</p>
                <p className="session-sub">A customer is ordering from their phone</p>
              </div>
              <button className="end-btn" type="button" onClick={() => access.endSession()}>
                End session
              </button>
            </div>
          </>
        )}

        <Finger />
        {toast && <div className="toast" role="status">{toast}</div>}

        <footer className={`status status-${status}`}>
          <span className="status-dot" aria-hidden="true" />
          {kioskId} · {status}
        </footer>
      </main>
    </div>
  );
}

function WelcomeScreen({ qrUrl, status }: { qrUrl: string | null; status: ConnectionStatus }) {
  const start = useKiosk((s) => s.start);
  return (
    <>
      <section className="welcome">
        <h1>Order here</h1>
        <p className="welcome-sub">Burgers, fries and shakes, made to order.</p>
        <button className="start-btn" data-kiosk-id={ids.start} type="button" onClick={start}>
          Touch to start
        </button>
      </section>
      {qrUrl !== null || status !== "online" ? (
        <aside className="access-card" aria-label="Accessible ordering">
          <div className="qr-frame">
            {qrUrl ? (
              <QRCodeSVG value={qrUrl} size={208} marginSize={0} level="M" />
            ) : (
              <div className="qr-placeholder">{status === "online" ? "Loading code" : "Connecting"}</div>
            )}
          </div>
          <div className="access-text">
            <p className="access-title">Blind or low vision?</p>
            <p className="access-body">Scan with your phone camera to order by voice from your own phone.</p>
          </div>
        </aside>
      ) : null}
    </>
  );
}

/** Without an accessible session: ask "Still there?" after 90 s idle, then reset. */
function useInactivityReset(sessionActive: boolean) {
  const lastTouch = useRef(Date.now());
  useEffect(() => {
    const touch = () => { lastTouch.current = Date.now(); };
    window.addEventListener("pointerdown", touch);
    const unsub = useKiosk.subscribe(touch);
    const timer = setInterval(() => {
      const s = useKiosk.getState();
      if (sessionActive || s.screen === "welcome" || s.screen === "paying" || s.screen === "complete") return;
      const idle = Date.now() - lastTouch.current;
      if (s.popup?.kind === "still-there") {
        if (idle > STILL_THERE_MS) s.cancelOrder();
      } else if (!s.popup && idle > IDLE_MS) {
        s.showStillThere();
      }
    }, 2000);
    return () => { window.removeEventListener("pointerdown", touch); unsub(); clearInterval(timer); };
  }, [sessionActive]);
}
