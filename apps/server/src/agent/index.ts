// OWNER: Eliana (Agent). This is a STUB so the rest of the system runs end to end.
// Replace the bodies; keep the two exported signatures (they're the agreed seam).

import type { AgentMessage } from "@kiosk-access/shared";
import { getKioskState, getSession, sendAgentMessage } from "../realtime/index.ts";

export async function handleUserMessage(sessionId: string, text: string): Promise<AgentMessage> {
  const session = getSession(sessionId);
  const state = session ? getKioskState(session.kioskId) : null;
  const where = state ? ` The kiosk is on the ${state.screen} screen.` : "";
  return { text: `Stub agent heard: "${text}".${where}`, awaitingConfirmation: false };
}

/** Called by the Bridge when the kiosk shows something the user should know about. */
export async function handleKioskEvent(sessionId: string, note: string): Promise<void> {
  sendAgentMessage(sessionId, { text: `Stub agent: ${note}`, awaitingConfirmation: false });
}
