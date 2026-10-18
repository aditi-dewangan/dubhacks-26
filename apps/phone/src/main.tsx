import { createRoot } from "react-dom/client";
import { App, DemoApp, ProfilePage, QrScannerScreen } from "./App.tsx";
import "./styles.css";

// No StrictMode: connection runs once on mount; strict double-invoke would
// consume the single-use token and fail on the second attempt.
// /k/... is a kiosk QR link, /c/... is a kiosk code typed into the app: the ordering flow.
// /profile shows saved preferences and order history. Anything else (allscreen.work itself)
// opens the QR scanner. The design preview is only for development, with ?demo.
const path = window.location.pathname;
const isKiosk = /^\/(k|c)\//.test(path);
const isDemo = import.meta.env.DEV && new URLSearchParams(window.location.search).has("demo");
createRoot(document.getElementById("root")!).render(
  isDemo ? <DemoApp /> : isKiosk ? <App /> : path.startsWith("/profile") ? <ProfilePage /> : <QrScannerScreen />,
);
