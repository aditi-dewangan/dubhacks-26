import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { ApiError, CreateSessionResponse, SessionEndReason } from "@kiosk-access/shared";
import { config } from "../config.ts";
import { runSafely, sessionEndedHandlers } from "./hooks.ts";
import { io } from "./io.ts";
import { logEvent } from "./log.ts";
import { clearTokens, isTokenValid, issueCode } from "./pairing.ts";
import { kioskRoom, kiosks, sessionRoom, sessions, type Session } from "./store.ts";

export type CreateResult =
  | { ok: true; body: CreateSessionResponse }
  | { ok: false; status: number; body: ApiError };

export function createSession(kioskId: string, token: string): CreateResult {
  const k = kiosks.get(kioskId);
  if (!k || !k.online) {
    return { ok: false, status: 503, body: { error: "kiosk_offline", message: "This kiosk isn't connected right now." } };
  }
  if (k.sessionId) {
    return { ok: false, status: 409, body: { error: "kiosk_busy", message: "This kiosk is being used by someone else." } };
  }
  if (!isTokenValid(k, token)) {
    return { ok: false, status: 410, body: { error: "code_expired", message: "This code expired. Please scan again." } };
  }

  clearTokens(k); // a code starts at most one session
  const now = Date.now();
  const session: Session = {
    sessionId: randomUUID(),
    sessionSecret: randomBytes(24).toString("base64url"),
    kioskId,
    createdAt: now,
    lastActivity: now,
    phoneSocketId: null,
    history: [],
    pendingCheckout: null,
    queue: Promise.resolve(),
    idleTimer: null,
    phoneGraceTimer: null,
    completeTimer: null,
    ended: false,
  };
  sessions.set(session.sessionId, session);
  k.sessionId = session.sessionId;
  touchSession(session);

  // The phone has a few seconds to connect its socket before the grace timer would end it.
  startPhoneGrace(session);

  io().to(kioskRoom(kioskId)).emit("session:started", { sessionId: session.sessionId, active: true });
  logEvent("session_start", { kioskId, sessionId: session.sessionId });

  return {
    ok: true,
    body: { sessionId: session.sessionId, sessionSecret: session.sessionSecret, kioskId },
  };
}

export function verifySecret(session: Session, secret: string) {
  const a = Buffer.from(session.sessionSecret);
  const b = Buffer.from(secret ?? "");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Call on every sign of life from the user. Resets the idle timeout. */
export function touchSession(session: Session) {
  session.lastActivity = Date.now();
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => endSession(session.sessionId, "idle_timeout"), config.sessionIdleMs);
}

export function startPhoneGrace(session: Session) {
  if (session.phoneGraceTimer) clearTimeout(session.phoneGraceTimer);
  session.phoneGraceTimer = setTimeout(
    () => endSession(session.sessionId, "phone_disconnected"),
    config.phoneGraceMs,
  );
}

export function cancelPhoneGrace(session: Session) {
  if (session.phoneGraceTimer) clearTimeout(session.phoneGraceTimer);
  session.phoneGraceTimer = null;
}

/** End the session after the user has had time to hear the order number. */
export function scheduleEndAfterComplete(session: Session) {
  if (session.completeTimer) return;
  session.completeTimer = setTimeout(
    () => endSession(session.sessionId, "order_complete"),
    config.endAfterCompleteMs,
  );
}

export function endSession(sessionId: string, reason: SessionEndReason) {
  const session = sessions.get(sessionId);
  if (!session || session.ended) return;
  session.ended = true;

  for (const t of [session.idleTimer, session.phoneGraceTimer, session.completeTimer]) if (t) clearTimeout(t);

  const info = { sessionId, active: false, reason };
  io().to(sessionRoom(sessionId)).emit("session:ended", info);
  io().to(kioskRoom(session.kioskId)).emit("session:ended", info);
  io().in(sessionRoom(sessionId)).socketsLeave(sessionRoom(sessionId));

  const k = kiosks.get(session.kioskId);
  if (k && k.sessionId === sessionId) {
    k.sessionId = null;
    if (k.online) issueCode(k); // fresh code for the next customer
  }

  sessions.delete(sessionId);
  logEvent("session_end", {
    kioskId: session.kioskId,
    sessionId,
    data: { reason, durationMs: Date.now() - session.createdAt },
  });
  runSafely("sessionEnded", sessionEndedHandlers, session, reason);
}
