// OWNER: Shruti (Bridge). This is a STUB so the rest of the system runs end to end.
// Replace the bodies; keep the exported signatures (they're the agreed seam).
//
// Realtime gives you (import from "../realtime/index.ts"):
//   sendToKiosk, onKioskAck, onKioskStateChange, onSessionEnded,
//   getSession, getKioskState, sendAgentMessage, logEvent

import { getSession, sendAgentMessage } from "../realtime/index.ts";

/** Runs one agent tool. Returns a short text summary for the model. */
export async function executeTool(sessionId: string, name: string, _input: unknown): Promise<string> {
  return `Tool ${name} is not implemented yet (session ${sessionId}).`;
}

/** Called when the phone sends user:confirm. Only this path may send start_payment. */
export async function handleConfirm(sessionId: string, confirmed: boolean): Promise<void> {
  const session = getSession(sessionId);
  if (!session) return;
  sendAgentMessage(sessionId, {
    text: confirmed ? "Stub: confirm received. Payment gate not built yet." : "Stub: okay, let's keep editing.",
    awaitingConfirmation: false,
  });
}
