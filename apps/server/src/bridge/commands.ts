// Sends commands to a kiosk and resolves each one with its ack.
//
// The kiosk runs commands one at a time in arrival order, so only the oldest unacked
// command per kiosk is actually executing. Its timeout starts then, not when it was queued:
// a command waiting behind a long tap sequence doesn't time out while it waits.

import { randomUUID } from "node:crypto";
import type { CommandAck, CommandEnvelope, KioskCommand } from "@kiosk-access/shared";

export const KIOSK_NO_RESPONSE = "The kiosk didn't respond.";
export const KIOSK_OFFLINE = "The kiosk is offline right now.";
export const SESSION_ENDED = "The session has ended.";

/** Every command except start_payment, which only the payment gate can send. */
export type SafeCommand = Exclude<KioskCommand, { type: "start_payment" }>;

/**
 * Buttons that finish something for good. Only the gate may press btn-submit (it completes a
 * clinic check-in); pay and the card reader are never pressed by the server at all.
 */
export const FINAL_BUTTONS: Record<string, string> = {
  "btn-pay": "Payment starts only after the customer confirms. Call request_checkout so they can review it.",
  "btn-card-tap": "The customer taps their own card on the reader.",
  "btn-submit": "That finishes the check-in for good. Call request_checkout so the customer can review and confirm it first.",
};

/** What the gate does once the customer confirms. */
export type FinalAction = "start_payment" | "submit";

export class CommandError extends Error {}

export interface CommandDeps {
  sendToKiosk(kioskId: string, env: CommandEnvelope): boolean;
  onKioskAck(handler: (ack: CommandAck, kioskId: string) => void): () => void;
  timeoutMs: number;
  newId?: () => string;
}

interface Pending {
  cmdId: string;
  kioskId: string;
  sessionId: string;
  timer: ReturnType<typeof setTimeout> | null;
  resolve(ack: CommandAck): void;
  reject(err: Error): void;
}

export function createCommandSender(deps: CommandDeps) {
  const pending = new Map<string, Pending>();
  const queues = new Map<string, string[]>(); // kioskId -> cmdIds in the order sent
  const newId = deps.newId ?? randomUUID;

  deps.onKioskAck((ack, kioskId) => {
    const p = pending.get(ack.cmdId);
    if (!p || p.kioskId !== kioskId) return; // late (after a timeout) or not ours
    settle(p, () => p.resolve(ack));
  });

  function startClock(kioskId: string) {
    const head = queues.get(kioskId)?.[0];
    const p = head ? pending.get(head) : undefined;
    if (!p || p.timer) return;
    p.timer = setTimeout(() => settle(p, () => p.reject(new CommandError(KIOSK_NO_RESPONSE))), deps.timeoutMs);
  }

  function settle(p: Pending, finish: () => void) {
    if (!pending.delete(p.cmdId)) return;
    if (p.timer) clearTimeout(p.timer);
    const q = queues.get(p.kioskId) ?? [];
    const i = q.indexOf(p.cmdId);
    if (i >= 0) q.splice(i, 1);
    if (!q.length) queues.delete(p.kioskId);
    startClock(p.kioskId);
    finish();
  }

  function send(kioskId: string, sessionId: string, command: KioskCommand): Promise<CommandAck> {
    return new Promise((resolve, reject) => {
      const cmdId = newId();
      const p: Pending = { cmdId, kioskId, sessionId, timer: null, resolve, reject };
      pending.set(cmdId, p);
      const q = queues.get(kioskId) ?? [];
      q.push(cmdId);
      queues.set(kioskId, q);
      if (!deps.sendToKiosk(kioskId, { cmdId, sessionId, command })) {
        settle(p, () => reject(new CommandError(KIOSK_OFFLINE)));
        return;
      }
      startClock(kioskId);
    });
  }

  return {
    /** Any command except start_payment. */
    sendCommand(kioskId: string, sessionId: string, command: SafeCommand): Promise<CommandAck> {
      if ((command as KioskCommand).type === "start_payment") {
        return Promise.reject(new CommandError("start_payment can only be sent by the payment gate."));
      }
      if (command.type === "press" && FINAL_BUTTONS[command.buttonId]) {
        return Promise.reject(new CommandError(FINAL_BUTTONS[command.buttonId]));
      }
      return send(kioskId, sessionId, command);
    },

    /** Only for the payment gate. Not exported from the bridge. */
    sendFinalAction(kioskId: string, sessionId: string, action: FinalAction): Promise<CommandAck> {
      return send(kioskId, sessionId, action === "submit" ? { type: "press", buttonId: "btn-submit" } : { type: "start_payment" });
    },

    /** Fail every command still waiting for this session (it ended). */
    cancelSession(sessionId: string) {
      for (const p of [...pending.values()]) {
        if (p.sessionId === sessionId) settle(p, () => p.reject(new CommandError(SESSION_ENDED)));
      }
    },

    pendingCount(kioskId?: string) {
      return kioskId ? (queues.get(kioskId)?.length ?? 0) : pending.size;
    },
  };
}

export type CommandSender = ReturnType<typeof createCommandSender>;
