// Public surface of the realtime layer (owner: Aditi).
// The Bridge (Shruti) and Agent (Eliana) import from here and nowhere else in realtime/.

import type { AgentMessage, CommandAck, CommandEnvelope, KioskState, SessionEndReason } from "@kiosk-access/shared";
import { ackHandlers, sessionEndedHandlers, stateHandlers } from "./hooks.ts";
import { io } from "./io.ts";
import { logEvent } from "./log.ts";
import { kioskRoom, kiosks, sessionRoom, sessions, type Session } from "./store.ts";

export type { Session } from "./store.ts";
export { logEvent } from "./log.ts";
export { endSession } from "./sessions.ts";

/** Send a command to a kiosk. Returns false if the kiosk is offline. The ack arrives via onKioskAck. */
export function sendToKiosk(kioskId: string, env: CommandEnvelope): boolean {
  const k = kiosks.get(kioskId);
  if (!k?.online) return false;
  io().to(kioskRoom(kioskId)).emit("kiosk:command", env);
  logEvent("command", { kioskId, sessionId: env.sessionId, data: { cmdId: env.cmdId, command: env.command } });
  return true;
}

/** Called with every ack any kiosk sends. Returns an unsubscribe function. */
export function onKioskAck(handler: (ack: CommandAck, kioskId: string) => void): () => void {
  ackHandlers.push(handler);
  return () => remove(ackHandlers, handler);
}

/**
 * Called whenever a kiosk publishes new state (not for acks). `session` is null when no
 * accessible session is active. Use it to spot popups or timeouts no command caused.
 */
export function onKioskStateChange(
  handler: (kioskId: string, prev: KioskState | null, next: KioskState, session: Session | null) => void,
): () => void {
  stateHandlers.push(handler);
  return () => remove(stateHandlers, handler);
}

export function onSessionEnded(handler: (session: Session, reason: SessionEndReason) => void): () => void {
  sessionEndedHandlers.push(handler);
  return () => remove(sessionEndedHandlers, handler);
}

export function getSession(sessionId: string): Session | undefined {
  return sessions.get(sessionId);
}

/** Latest state the kiosk published or acked. */
export function getKioskState(kioskId: string): KioskState | null {
  return kiosks.get(kioskId)?.lastState ?? null;
}

/** Push an assistant message to the phone (for agent-initiated messages, e.g. a popup appeared). */
export function sendAgentMessage(sessionId: string, msg: AgentMessage) {
  const s = sessions.get(sessionId);
  if (!s || s.ended) return;
  io().to(sessionRoom(sessionId)).emit("agent:message", msg);
  logEvent("agent_message", { kioskId: s.kioskId, sessionId, data: { ...msg, proactive: true } });
}

function remove<T>(list: T[], item: T) {
  const i = list.indexOf(item);
  if (i >= 0) list.splice(i, 1);
}
