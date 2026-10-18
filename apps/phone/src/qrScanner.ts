import jsQR from "jsqr";

// Live QR scanning that works in every mobile browser:
// - Chrome on Android has BarcodeDetector built in, so we use it.
// - iPhone Safari, Firefox and others don't, so we draw frames to a canvas and decode with jsQR.

type Detector = { detect(src: CanvasImageSource): Promise<{ rawValue: string }[]> };
type DetectorCtor = new (opts: { formats: string[] }) => Detector;

const NativeDetector = (globalThis as unknown as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;

export type CameraProblem = "insecure" | "unsupported" | "denied" | "not_found" | "in_use" | "failed";

export const CAMERA_PROBLEM_TEXT: Record<CameraProblem, string> = {
  insecure: "The camera only works on a secure (https) page.",
  unsupported: "This browser can't open the camera. Use your phone's camera app to scan the QR code instead.",
  denied: "Camera access is blocked. Allow the camera for this site in your browser settings, then tap Turn on camera.",
  not_found: "No camera was found on this device.",
  in_use: "Another app is using the camera. Close it, then tap Turn on camera.",
  failed: "The camera couldn't start. Tap Turn on camera to try again.",
};

export class CameraError extends Error {
  constructor(public problem: CameraProblem) { super(problem); }
}

function problemFrom(err: unknown): CameraProblem {
  const name = (err as { name?: string })?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return "denied";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "not_found";
  if (name === "NotReadableError" || name === "AbortError") return "in_use";
  return "failed";
}

/**
 * Open the back camera into `video` and call `onCode` with each QR code's text until it returns true.
 * Resolves once the camera is showing; rejects with CameraError. Call the returned function to stop.
 */
export async function startQrScanner(
  video: HTMLVideoElement,
  onCode: (text: string) => boolean,
): Promise<() => void> {
  if (!window.isSecureContext) throw new CameraError("insecure");
  if (!navigator.mediaDevices?.getUserMedia) throw new CameraError("unsupported");

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
  } catch (err) {
    throw new CameraError(problemFrom(err));
  }

  let stopped = false;
  let timer = 0;
  const stop = () => {
    stopped = true;
    window.clearTimeout(timer);
    stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  };

  // iOS needs these set before play() or the video shows black / goes full screen.
  video.setAttribute("playsinline", "true");
  video.muted = true;
  video.srcObject = stream;
  try {
    await video.play();
  } catch (err) {
    stop();
    throw new CameraError(problemFrom(err));
  }

  let native: Detector | null = null;
  if (NativeDetector) {
    try { native = new NativeDetector({ formats: ["qr_code"] }); } catch { native = null; }
  }
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  const decode = async (): Promise<string | null> => {
    if (video.readyState < 2 || !video.videoWidth) return null;
    if (native) {
      try {
        const found = await native.detect(video);
        return found[0]?.rawValue ?? null;
      } catch {
        native = null; // fall back to jsQR from now on
      }
    }
    if (!ctx) return null;
    // Scale down: jsQR is fast enough at ~640px and much slower at full resolution.
    const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" })?.data ?? null;
  };

  const tick = async () => {
    if (stopped) return;
    const text = await decode();
    if (stopped) return;
    if (text && onCode(text)) { stop(); return; }
    timer = window.setTimeout(tick, 150);
  };
  tick();

  return stop;
}
