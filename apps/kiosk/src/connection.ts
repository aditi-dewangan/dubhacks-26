import { AccessKiosk } from "@kiosk-access/sdk";
import { kioskId } from "./kinds.ts";

// One connection for the whole app (created at module load so React StrictMode
// double-renders don't open two sockets).
export { kioskId };

export const access = AccessKiosk.connect({
  serverUrl: import.meta.env.VITE_SERVER_URL ?? "http://localhost:3001",
  kioskId,
  kioskKey: import.meta.env.VITE_KIOSK_KEY ?? "dev-kiosk-key",
});
