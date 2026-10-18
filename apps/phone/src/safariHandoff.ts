// On iPhone, Chrome/Firefox/Edge can't do speech recognition and ask for the camera and
// microphone on every visit. Safari can, and can be set to always allow. So when the app opens
// in another iPhone browser, it hands the page to Safari (x-safari-https://, iOS 17+).
// The handoff happens before connecting, so the kiosk isn't held by the abandoned tab.

import { kioskCode, normalizeCode } from "@kiosk-access/shared";
import { iosNonSafari } from "./permissions.ts";

const STAY_KEY = "allscreen.stayInBrowser";

/** Should this page try to reopen in Safari? */
export function shouldHandOff(): boolean {
  if (!iosNonSafari()) return false;
  const params = new URLSearchParams(window.location.search);
  if (params.has("stay") || params.has("demo")) return false;
  try { if (sessionStorage.getItem(STAY_KEY) === "1") return false; } catch { /* storage blocked */ }
  return true;
}

/** The address to open in Safari. QR links (one-time token) become the kiosk's fixed code. */
export function safariPath(): string {
  const { pathname, search } = window.location;
  const qr = pathname.match(/^\/k\/([^/?#]+)/);
  if (qr?.[1]) {
    const code = normalizeCode(kioskCode(decodeURIComponent(qr[1])));
    if (code) return `/c/${code}`;
  }
  return pathname + search;
}

export function safariUrl(): string {
  return `x-safari-https://${window.location.host}${safariPath()}`;
}

/** Stay in this browser from now on (this tab). */
export function stayHere() {
  try { sessionStorage.setItem(STAY_KEY, "1"); } catch { /* storage blocked */ }
  // A QR token may be spent or about to expire; the fixed code always works.
  const path = safariPath();
  if (path !== window.location.pathname + window.location.search) window.history.replaceState(null, "", path);
}

/**
 * Try to open Safari. Resolves "left" if the page went to the background (Safari took over),
 * or "stayed" if nothing happened within `waitMs` (older iOS, or the person declined).
 */
export function handOffToSafari(waitMs = 6000): Promise<"left" | "stayed"> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result: "left" | "stayed") => {
      if (done) return;
      done = true;
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onLeave);
      window.clearTimeout(timer);
      resolve(result);
    };
    const onHide = () => { if (document.visibilityState === "hidden") finish("left"); };
    const onLeave = () => finish("left");
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onLeave);
    const timer = window.setTimeout(() => finish("stayed"), waitMs);
    window.location.href = safariUrl();
  });
}
