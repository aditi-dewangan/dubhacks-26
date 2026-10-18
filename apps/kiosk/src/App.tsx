import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { ConnectionStatus } from "@kiosk-access/sdk";
import type { SessionEndReason, SessionInfo } from "@kiosk-access/shared";
import imgRaisingCanes from "./assets/logos/raising-canes.png";
import imgAmcLogo       from "./assets/logos/amc.png";
import imgChildrensLogo from "./assets/logos/seattle-childrens.png";
import imgLightRailLogo from "./assets/logos/lightrail.png";
import { access } from "./connection.ts";
import { currentState, runCommand } from "./executor.ts";
import { Finger } from "./finger.tsx";
import { readScreen, runGenericCommand, type GenericKiosk } from "./generic.ts";
import { brand, kind, kioskId } from "./kinds.ts";
import { KioskNavigation } from "./KioskNavigation.tsx";
import { cinemaKiosk } from "./kiosks/cinema.tsx";
import { clinicKiosk } from "./kiosks/clinic.tsx";
import { transitKiosk } from "./kiosks/transit.tsx";
import { ids } from "./model.ts";
import {
  CartScreen,
  CheckoutScreen,
  CompleteScreen,
  ItemModal,
  MenuScreen,
  PayingScreen,
  Popup,
} from "./Screens.tsx";
import { useKiosk } from "./store.ts";
import { AccessCard } from "./ui.tsx";
import { afterPaint } from "./taps.ts";

const END_REASONS: Record<SessionEndReason, string> = {
  idle_timeout: "Accessible session ended after inactivity",
  order_complete: "Accessible session complete",
  staff_ended: "Accessible session ended by staff",
  phone_disconnected: "Phone disconnected",
  user_ended: "Customer ended the session",
  kiosk_disconnected: "Kiosk lost connection",
};

// Inactivity timeout (food kiosk, no accessible session). Override for testing with VITE_IDLE_MS / VITE_STILL_THERE_MS.
const IDLE_MS = Number(import.meta.env.VITE_IDLE_MS ?? 90_000);
const STILL_THERE_MS = Number(import.meta.env.VITE_STILL_THERE_MS ?? 20_000);

const GENERIC: Record<string, GenericKiosk> = { clinic: clinicKiosk, cinema: cinemaKiosk, transit: transitKiosk };
const generic: GenericKiosk | null = GENERIC[kind] ?? null;

let sessionActiveNow = false;
access.onSession((s) => { sessionActiveNow = s.active; });
access.onCommand(generic ? (cmd) => runGenericCommand(generic, cmd, () => sessionActiveNow) : runCommand);
document.title = brand.pageTitle;

const brandStyle = { "--red": brand.color, "--red-dark": brand.dark } as CSSProperties;

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
        // An abandoned accessible session shouldn't leave its order behind for the next customer.
        if (!info.active && info.reason !== "order_complete") {
          if (generic) generic.reset();
          else useKiosk.getState().cancelOrder();
        }
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

  // Publish state whenever the screen or session changes (debounced ~100 ms, after the DOM updates).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const publish = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        afterPaint(() => access.publishState(generic ? readScreen(generic, sessionActive) : currentState()));
      }, 100);
    };
    publish();
    const unsub = generic ? generic.subscribe(publish) : useKiosk.subscribe(publish);
    return () => { unsub(); if (timer) clearTimeout(timer); };
  }, [sessionActive]);

  const visibleQr = sessionActive ? null : qrUrl;

  return (
    <main className={`kiosk kind-${kind} ${sessionActive ? "in-session" : ""}`} style={brandStyle} aria-label={`${brand.name} kiosk`}>
      {sessionActive && (
        <div className="access-banner" role="status">
          <span className="pulse" aria-hidden="true" />
          <strong>Accessibility mode</strong>
          <span className="access-banner-sub">A customer is {brand.task} from their phone. Touch is paused.</span>
          <button className="end-btn" type="button" onClick={() => access.endSession()}>
            End session
          </button>
        </div>
      )}
      <header className="topbar" style={{ "--brand-color": brand.color, "--brand-dark": brand.dark } as React.CSSProperties}>
        <div className="topbar-leading">
          <KioskNavigation sessionActive={sessionActive} />
          <div className="brand">
            <img
              src={{ food: imgRaisingCanes, cinema: imgAmcLogo, clinic: imgChildrensLogo, transit: imgLightRailLogo }[kind]}
              alt={brand.name}
              className="brand-logo"
            />
            <span>
              <span className="brand-name">{brand.name}</span>
              <span className="brand-meta">{brand.meta}</span>
            </span>
          </div>
        </div>
        <div className={`status status-${status}`}>
          <span className="status-dot" aria-hidden="true" />
          {kioskId} · {status}
        </div>
      </header>

      <div className="content">
        {generic ? <generic.Body qrUrl={visibleQr} status={status} /> : <FoodBody qrUrl={visibleQr} status={status} sessionActive={sessionActive} />}
      </div>

      {/* Blocks touch on everything except the card reader; the assistant's taps are programmatic. */}
      {sessionActive && <div className="touch-blocker" aria-hidden="true" />}

      <Finger />
      {toast && <div className="toast" role="status">{toast}</div>}
    </main>
  );
}

// ---------------- the food kiosk (Raising Cane's) ----------------

function FoodBody({ qrUrl, status, sessionActive }: { qrUrl: string | null; status: ConnectionStatus; sessionActive: boolean }) {
  const screen = useKiosk((s) => s.screen);
  const editingFromCart = useKiosk((s) => Boolean(s.draft?.editingLineId));
  useInactivityReset(sessionActive);
  return (
    <>
      {screen === "welcome" && <FoodWelcome qrUrl={qrUrl} status={status} />}
      {(screen === "menu" || (screen === "item" && !editingFromCart)) && <MenuScreen />}
      {(screen === "cart" || (screen === "item" && editingFromCart)) && <CartScreen />}
      {screen === "checkout" && <CheckoutScreen />}
      {screen === "paying" && <PayingScreen />}
      {screen === "complete" && <CompleteScreen />}
      {screen === "item" && <ItemModal />}
      <Popup />
    </>
  );
}

function FoodWelcome({ qrUrl, status }: { qrUrl: string | null; status: ConnectionStatus }) {
  const start = useKiosk((s) => s.start);
  return (
    <section className="welcome">
      <div className="welcome-hero">
        <p className="eyebrow">Welcome to Raising Cane&apos;s</p>
        <h1>Skip the line.<br />Order here.</h1>
        <p className="welcome-sub">Chicken fingers, crinkle-cut fries and Cane&apos;s sauce, made fresh when you order.</p>
        <button className="btn-red start-btn" data-kiosk-id={ids.start} type="button" onClick={start}>
          Start order
        </button>
      </div>
      <AccessCard qrUrl={qrUrl} status={status} task={brand.task} />
    </section>
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
        s.showStillThere(Math.round(STILL_THERE_MS / 1000));
      }
    }, 1000);
    return () => { window.removeEventListener("pointerdown", touch); unsub(); clearInterval(timer); };
  }, [sessionActive]);
}
