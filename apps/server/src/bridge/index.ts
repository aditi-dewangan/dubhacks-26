// OWNER: Shruti (Bridge). Public surface of the bridge: the agent calls executeTool,
// interceptUserMessage and isAwaitingConfirmation; realtime calls handleConfirm.
// The logic lives in bridge.ts, built here from the real realtime and agent functions.

import type { AgentMessage } from "@kiosk-access/shared";
import { handleKioskEvent } from "../agent/index.ts";
import {
  getKioskState,
  getSession,
  logEvent,
  onKioskAck,
  onKioskStateChange,
  onSessionEnded,
  sendAgentMessage,
  sendToKiosk,
} from "../realtime/index.ts";
import { createBridge } from "./bridge.ts";

const bridge = createBridge({
  sendToKiosk,
  onKioskAck,
  onKioskStateChange,
  onSessionEnded,
  getSession,
  getKioskState,
  sendAgentMessage,
  handleKioskEvent: (sessionId, note) => handleKioskEvent(sessionId, note),
  logEvent,
  commandTimeoutMs: Number(process.env.BRIDGE_COMMAND_TIMEOUT_MS ?? 10_000),
});

/** Runs one agent tool. Returns a short text summary for the model. */
export async function executeTool(sessionId: string, name: string, input: unknown): Promise<string> {
  return bridge.executeTool(sessionId, name, input);
}

/** Called when the phone sends user:confirm. Only this path may send start_payment. */
export async function handleConfirm(sessionId: string, confirmed: boolean): Promise<void> {
  return bridge.handleConfirm(sessionId, confirmed);
}

/**
 * The agent calls this first with every user message. While a checkout is pending, a plain
 * "yes" confirms it in code and the reply comes back here; send it instead of running the
 * model. null means the model should handle the message (the pending checkout is cleared).
 */
export async function interceptUserMessage(sessionId: string, text: string): Promise<AgentMessage | null> {
  return bridge.interceptUserMessage(sessionId, text);
}

/** True after request_checkout until the customer confirms or changes anything. */
export function isAwaitingConfirmation(sessionId: string): boolean {
  return bridge.isAwaitingConfirmation(sessionId);
}
