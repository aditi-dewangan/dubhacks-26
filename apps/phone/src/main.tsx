import { createRoot } from "react-dom/client";
import { App, DemoApp } from "./App.tsx";
import "./styles.css";

// No StrictMode: connection runs once on mount; strict double-invoke would
// consume the single-use token and fail on the second attempt.
const hasKioskUrl = window.location.pathname.startsWith("/k/");
const isDemo = import.meta.env.DEV && (
  new URLSearchParams(window.location.search).has("demo") || !hasKioskUrl
);
createRoot(document.getElementById("root")!).render(isDemo ? <DemoApp /> : <App />);
