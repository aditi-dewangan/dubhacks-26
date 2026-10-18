import { createRoot } from "react-dom/client";
import { App, DemoApp } from "./App.tsx";
import "./styles.css";

// No StrictMode: connection runs once on mount; strict double-invoke would
// consume the single-use token and fail on the second attempt.
// /k/... is a kiosk QR link, /c/... is a kiosk code typed into the app.
const hasKioskUrl = /^\/(k|c)\//.test(window.location.pathname);
// Kiosk QR links (/k/:kioskId?t=...) open the real ordering flow. Anything else, such as
// opening allscreen.work directly, shows the demo, in dev and in the deployed site alike.
const isDemo = new URLSearchParams(window.location.search).has("demo") || !hasKioskUrl;
createRoot(document.getElementById("root")!).render(isDemo ? <DemoApp /> : <App />);
