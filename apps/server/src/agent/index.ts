// OWNER: Eliana (Agent). Keep these exported signatures (the agreed seam).

import type { AgentMessage } from "@kiosk-access/shared";
import { getKioskState, getSession, sendAgentMessage, logEvent } from "../realtime/index.ts";
import { createAgent } from "./service.ts";
import { readAgentMode } from "./config.ts";
import { createLazyGeminiResponder } from "./gemini.ts";

const agent = createAgent({
  getSession, getKioskState, sendAgentMessage,
  generateReply: readAgentMode() === "gemini" ? createLazyGeminiResponder() : undefined,
  reportFailure: (sessionId, code) => logEvent("error", {
    sessionId, data: { where: "agent", provider: "gemini", code },
  }),
});

export async function handleUserMessage(sessionId: string, text: string): Promise<AgentMessage> {
  return agent.handleUserMessage(sessionId, text);
}

/** Called by the Bridge when the kiosk shows something the user should know about. */
export async function handleKioskEvent(sessionId: string, note: string): Promise<void> {
  return agent.handleKioskEvent(sessionId, note);
}
