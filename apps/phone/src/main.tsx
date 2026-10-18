import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App, DemoApp, ProfilePage, QrScannerScreen } from "./App.tsx";
import { onNavigate } from "./nav.ts";
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
  const path = window.location.pathname;
  const isKiosk = /^\/(k|c)\//.test(path);
  const isDemo = import.meta.env.DEV && new URLSearchParams(window.location.search).has("demo");
  // key: a new kiosk link starts a fresh connection
  return isDemo ? <DemoApp /> : isKiosk ? <App key={url} /> : path.startsWith("/profile") ? <ProfilePage /> : <QrScannerScreen />;
}

createRoot(document.getElementById("root")!).render(<Root />);
