import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App, DemoApp, ProfilePage, QrScannerScreen } from "./App.tsx";
import { onNavigate } from "./nav.ts";
import { handOffToSafari, shouldHandOff, stayHere } from "./safariHandoff.ts";
import "./styles.css";

// No StrictMode: connection runs once on mount; strict double-invoke would
// consume the single-use token and fail on the second attempt.
// /k/... is a kiosk QR link, /c/... is a kiosk code typed into the app: the ordering flow.
// /profile shows saved preferences and order history. Anything else (allscreen.work itself)
// opens the QR scanner. The design preview is only for development, with ?demo.
// Screens change in place (nav.ts) instead of reloading, so permissions aren't asked again.
function Root() {
  const [url, setUrl] = useState(() => window.location.pathname + window.location.search);
  useEffect(() => onNavigate(() => setUrl(window.location.pathname + window.location.search)), []);

  // Chrome/Firefox/Edge on iPhone: reopen in Safari first (voice and permissions work better there).
  const [handoff, setHandoff] = useState<"trying" | "left" | "none">(() => (shouldHandOff() ? "trying" : "none"));
  const stay = () => {
    stayHere();
    setUrl(window.location.pathname + window.location.search);
    setHandoff("none");
  };
  useEffect(() => {
    if (handoff !== "trying") return;
    void handOffToSafari().then((result) => { if (result === "left") setHandoff("left"); else stay(); });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (handoff !== "none") return <SafariHandoffScreen left={handoff === "left"} onStay={stay} />;

  const path = window.location.pathname;
  const isKiosk = /^\/(k|c)\//.test(path);
  const isDemo = import.meta.env.DEV && new URLSearchParams(window.location.search).has("demo");
  // key: a new kiosk link starts a fresh connection
  return isDemo ? <DemoApp /> : isKiosk ? <App key={url} /> : path.startsWith("/profile") ? <ProfilePage /> : <QrScannerScreen />;
}

function SafariHandoffScreen({ left, onStay }: { left: boolean; onStay(): void }) {
  return (
    <div className="page" role="main">
      <p className="page-brand" aria-hidden="true">AllScreen</p>
      <div className="handoff">
        <h1 className="handoff-title" role="status" aria-live="polite">
          {left ? "Continued in Safari" : "Opening in Safari…"}
        </h1>
        <p className="handoff-body">
          {left
            ? "Your order continues in Safari. You can close this tab."
            : "Voice ordering works best in Safari on iPhone. If you're asked, tap Open."}
        </p>
        <button type="button" className="btn btn-outline handoff-stay" onClick={onStay}>
          Stay in this browser instead
        </button>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Root />);
