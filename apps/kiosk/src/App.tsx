import { useEffect, useMemo, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import type { ConnectionStatus } from "@kiosk-access/sdk";
import type { KioskState, SessionEndReason, SessionInfo } from "@kiosk-access/shared";
import { access, kioskId } from "./connection.ts";

const END_REASONS: Record<SessionEndReason, string> = {
  idle_timeout: "Accessible session ended after inactivity",
  order_complete: "Accessible order complete",
  staff_ended: "Accessible session ended by staff",
  phone_disconnected: "Phone disconnected",
  user_ended: "Customer ended the session",
  kiosk_disconnected: "Kiosk lost connection",
};

// Shell only: the ordering screens and the tap executor come next.
export function App() {
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

  // What the phone and the agent see.
  const state: KioskState = useMemo(
    () => ({
      kioskId,
      screen: "welcome",
      title: "Welcome to Harbor Burger",
      buttons: [{ id: "btn-start", label: "Start order", enabled: true }],
      cart: { lines: [], subtotal: 0, tax: 0, total: 0 },
      sessionActive,
    }),
    [sessionActive],
  );

  useEffect(() => access.publishState(state), [state]);

  useEffect(() => {
    access.onCommand(async () => ({
      ok: false,
      error: "The kiosk's ordering screens aren't built yet.",
      state,
    }));
  }, [state]);

  return (
    <div className="stage">
      <main className="kiosk" aria-label="Self-order kiosk">
        <header className="kiosk-header">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">HB</span>
            <span className="brand-name">Harbor Burger</span>
          </div>
        </header>

        <section className="welcome" aria-hidden={sessionActive || undefined}>
          <h1>Order here</h1>
          <p className="welcome-sub">Burgers, fries and shakes, made to order.</p>
          <button className="start-btn" data-kiosk-id="btn-start" type="button">
            Touch to start
          </button>
        </section>

        {!sessionActive && (
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
        )}

        {sessionActive && (
          <div className="session-overlay" role="status">
            <div className="session-banner">
              <span className="pulse" aria-hidden="true" />
              <div>
                <p className="session-title">Accessible ordering in progress</p>
                <p className="session-sub">A customer is ordering from their phone. Touch is paused.</p>
              </div>
            </div>
            <button className="end-btn" type="button" onClick={() => access.endSession()}>
              End accessible session
            </button>
          </div>
        )}

        {toast && <div className="toast" role="status">{toast}</div>}

        <footer className={`status status-${status}`}>
          <span className="status-dot" aria-hidden="true" />
          {kioskId} · {status}
        </footer>
      </main>
    </div>
  );
}
