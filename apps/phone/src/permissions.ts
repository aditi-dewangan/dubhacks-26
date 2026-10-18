// Camera / microphone permission helpers: what the browser says right now, and
// step-by-step instructions to turn access back on. A web page can't open the
// phone's Settings app or change the permission itself, so we explain the steps.

export type Device = "camera" | "microphone";
export type PermissionStatus = "granted" | "denied" | "prompt" | "unknown";

/** Ask the browser whether access is already granted, without prompting. */
export async function queryPermission(device: Device): Promise<PermissionStatus> {
  try {
    const status = await navigator.permissions?.query({ name: device as PermissionName });
    return status?.state ?? "unknown";
  } catch {
    return "unknown"; // older Safari / Firefox don't support querying camera or microphone
  }
}

type Platform = "ios-safari" | "ios-chrome" | "ios-firefox" | "ios-edge" | "android" | "desktop";

export function detectPlatform(ua = navigator.userAgent): Platform {
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  if (ios) {
    if (/CriOS/.test(ua)) return "ios-chrome";
    if (/FxiOS/.test(ua)) return "ios-firefox";
    if (/EdgiOS/.test(ua)) return "ios-edge";
    return "ios-safari";
  }
  return /Android/.test(ua) ? "android" : "desktop";
}

/** iPhone browsers other than Safari can't use built-in speech recognition. */
export function iosNonSafari(ua?: string) {
  const p = detectPlatform(ua);
  return p === "ios-chrome" || p === "ios-firefox" || p === "ios-edge";
}

const APP_NAME: Partial<Record<Platform, string>> = { "ios-chrome": "Chrome", "ios-firefox": "Firefox", "ios-edge": "Edge" };

export function permissionSteps(device: Device, platform = detectPlatform()): string[] {
  const Device = device === "camera" ? "Camera" : "Microphone";
  switch (platform) {
    case "ios-safari":
      return [
        `Tap the page menu on the left of the address bar, then Website Settings.`,
        `Set ${Device} to Allow. Safari will stop asking every visit.`,
        `Still blocked? Open the Settings app, tap Apps, then Safari, and set ${Device} to Allow.`,
      ];
    case "ios-chrome":
    case "ios-firefox":
    case "ios-edge":
      return [
        `Open the Settings app on your iPhone.`,
        `Tap Apps, then ${APP_NAME[platform]}.`,
        `Turn on ${Device}.`,
        `Come back here and tap Try again. If ${APP_NAME[platform]} asks, tap Allow.`,
      ];
    case "android":
      return [
        `Tap the icon on the left of the address bar, then Permissions.`,
        `Set ${Device} to Allow.`,
        `Still blocked? Open the Settings app, tap Apps, then your browser, then Permissions, and allow ${Device}.`,
      ];
    default:
      return [
        `Click the icon on the left of the address bar.`,
        `Set ${Device} to Allow, then tap Try again.`,
      ];
  }
}
