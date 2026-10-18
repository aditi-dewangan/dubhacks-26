// OWNER: Eliana (Agent). Keep these exported signatures (the agreed seam).

import type { AgentMessage } from "@kiosk-access/shared";
import { getKioskState, getSession, sendAgentMessage, logEvent } from "../realtime/index.ts";
import { createAgent } from "./service.ts";
import { readAgentMode } from "./config.ts";
import { createLazyGeminiModel } from "./gemini.ts";
import { executeTool, interceptUserMessage } from "../bridge/index.ts";
import { isProfileTool, memoryForSession, runProfileTool } from "../profiles/index.ts";

const agent = createAgent({
  getSession, getKioskState, sendAgentMessage,
  generateTurn: readAgentMode() === "gemini" ? createLazyGeminiModel() : undefined,
  // Profile tools (remember or forget the customer) are handled here; everything else goes to the bridge.
  executeTool: (sessionId, name, input) => (isProfileTool(name) ? runProfileTool(sessionId, name, input) : executeTool(sessionId, name, input)),
  // What we remember about this customer: name, diet, allergies, and their last order here.
  getMemory: (sessionId) => memoryForSession(sessionId),
  reportLatency: (_sessionId, kind, milliseconds) => {
    console.info(JSON.stringify({ metric: "agent_latency", kind, milliseconds }));
  },
  reportToolCall: (sessionId, name) => logEvent("tool_call", { sessionId, data: { name } }),
  reportFailure: (sessionId, code) => logEvent("error", {
    sessionId, data: { where: "agent", provider: "gemini", code },
  }),
});

export async function handleUserMessage(sessionId: string, text: string): Promise<AgentMessage> {
  // While a checkout is pending, a whole-message "yes" confirms it here; anything else clears it.
  const confirmed = await interceptUserMessage(sessionId, text);
  if (confirmed) return confirmed;
  return agent.handleUserMessage(sessionId, text);
}

/** Called by the Bridge when the kiosk shows something the user should know about. */
export async function handleKioskEvent(sessionId: string, note: string): Promise<void> {
  return agent.handleKioskEvent(sessionId, note);
}
