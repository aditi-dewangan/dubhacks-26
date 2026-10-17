import type { Cart, KioskState } from "@kiosk-access/shared";

export interface KioskRecord {
  kioskId: string;
  socketId: string | null;
  online: boolean;
  lastState: KioskState | null;
  sessionId: string | null;
  /** Valid pairing tokens and when each expires (epoch ms). */
  tokens: Map<string, number>;
  rotateTimer: NodeJS.Timeout | null;
  offlineTimer: NodeJS.Timeout | null;
}

export interface Session {
  sessionId: string;
  sessionSecret: string;
  kioskId: string;
  createdAt: number;
  lastActivity: number;
  phoneSocketId: string | null;
  /** Conversation history. Owned by the agent; the server never reads it. */
  history: unknown[];
  /** Cart snapshot taken at request_checkout. Owned by the Bridge's payment gate. */
  pendingCheckout: Cart | null;
  /** Serializes user messages so a session handles one at a time. */
  queue: Promise<void>;
  idleTimer: NodeJS.Timeout | null;
  phoneGraceTimer: NodeJS.Timeout | null;
  completeTimer: NodeJS.Timeout | null;
  ended: boolean;
}

export const kiosks = new Map<string, KioskRecord>();
export const sessions = new Map<string, Session>();

export function getOrCreateKiosk(kioskId: string): KioskRecord {
  let k = kiosks.get(kioskId);
  if (!k) {
    k = {
      kioskId,
      socketId: null,
      online: false,
      lastState: null,
      sessionId: null,
      tokens: new Map(),
      rotateTimer: null,
      offlineTimer: null,
    };
    kiosks.set(kioskId, k);
  }
  return k;
}

export const kioskRoom = (kioskId: string) => `kiosk:${kioskId}`;
export const sessionRoom = (sessionId: string) => `session:${sessionId}`;
