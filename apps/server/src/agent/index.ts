// OWNER: Eliana (Agent). This is a STUB so the rest of the system runs end to end.
// Replace the bodies; keep the two exported signatures (they're the agreed seam).

import type { AgentMessage } from "@kiosk-access/shared";
import { getKioskState, getSession, sendAgentMessage } from "../realtime/index.ts";
import { createAgent } from "./service.ts";

const agent = createAgent({ getSession, getKioskState, sendAgentMessage });

export async function handleUserMessage(sessionId: string, text: string): Promise<AgentMessage> {
  return agent.handleUserMessage(sessionId, text);
}

/** Called by the Bridge when the kiosk shows something the user should know about. */
export async function handleKioskEvent(sessionId: string, note: string): Promise<void> {
  return agent.handleKioskEvent(sessionId, note);
}
