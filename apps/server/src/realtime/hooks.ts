import type { CommandAck, KioskState, SessionEndReason } from "@kiosk-access/shared";
import type { Session } from "./store.ts";

// Small subscription lists so the Bridge and Agent can react to realtime events
// without the realtime layer importing their code.

type AckHandler = (ack: CommandAck, kioskId: string) => void;
type StateHandler = (kioskId: string, prev: KioskState | null, next: KioskState, session: Session | null) => void;
type SessionEndedHandler = (session: Session, reason: SessionEndReason) => void;

export const ackHandlers: AckHandler[] = [];
export const stateHandlers: StateHandler[] = [];
export const sessionEndedHandlers: SessionEndedHandler[] = [];

export function runSafely<A extends unknown[]>(label: string, handlers: ((...args: A) => void)[], ...args: A) {
  for (const h of handlers) {
    try {
      h(...args);
    } catch (err) {
      console.error(`[${label}] handler threw`, err);
    }
  }
}
