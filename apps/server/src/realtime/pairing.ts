import { randomBytes } from "node:crypto";
import { config } from "../config.ts";
import { io } from "./io.ts";
import { kioskRoom, type KioskRecord } from "./store.ts";

// Each kiosk shows a QR code with a short-lived token. Codes rotate every minute and
// stay valid a little longer, so someone mid-scan doesn't fail. A token can only start
// one session: starting a session clears every token for that kiosk.

export function pairingUrl(kioskId: string, token: string) {
  return `${config.phoneAppUrl}/k/${encodeURIComponent(kioskId)}?t=${token}`;
}

export function issueCode(k: KioskRecord) {
  const now = Date.now();
  for (const [t, exp] of k.tokens) if (exp <= now) k.tokens.delete(t);

  const token = randomBytes(9).toString("base64url");
  const expiresAt = now + config.codeTtlMs;
  k.tokens.set(token, expiresAt);
  io().to(kioskRoom(k.kioskId)).emit("kiosk:pairing-code", { url: pairingUrl(k.kioskId, token), expiresAt });
  return token;
}

export function startRotation(k: KioskRecord) {
  stopRotation(k);
  issueCode(k);
  k.rotateTimer = setInterval(() => issueCode(k), config.codeRotateMs);
}

export function stopRotation(k: KioskRecord) {
  if (k.rotateTimer) clearInterval(k.rotateTimer);
  k.rotateTimer = null;
}

export function isTokenValid(k: KioskRecord, token: string) {
  const exp = k.tokens.get(token);
  return exp !== undefined && exp > Date.now();
}

export function clearTokens(k: KioskRecord) {
  k.tokens.clear();
}

/** The newest valid code, for dev scripts. */
export function currentCode(k: KioskRecord): { token: string; url: string } | null {
  let best: [string, number] | null = null;
  for (const entry of k.tokens) if (!best || entry[1] > best[1]) best = entry;
  if (!best || best[1] <= Date.now()) return null;
  return { token: best[0], url: pairingUrl(k.kioskId, best[0]) };
}
