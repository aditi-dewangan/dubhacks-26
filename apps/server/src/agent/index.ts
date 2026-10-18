// OWNER: Eliana (Agent). Keep these exported signatures (the agreed seam).

import type { AgentMessage } from "@kiosk-access/shared";
import { getKioskState, getSession, sendAgentMessage, logEvent } from "../realtime/index.ts";
import { createAgent } from "./service.ts";
import { readAgentMode } from "./config.ts";
import { createLazyGeminiModel } from "./gemini.ts";
import { executeTool } from "../bridge/index.ts";
import { describeOrder, lastOrderForSession } from "../profiles/index.ts";

const agent = createAgent({
  getSession, getKioskState, sendAgentMessage,
  generateTurn: readAgentMode() === "gemini" ? createLazyGeminiModel() : undefined,
  executeTool,
  // A returning customer's last order here, so "yes, the same again" can be ordered for real.
  getMemory: (sessionId) => {
    const last = lastOrderForSession(sessionId);
    if (!last) return null;
    return [
      `This phone ordered here before. Last time: ${describeOrder(last)} (total ${last.total.toFixed(2)}).`,
      "The app greeted them with: \"Would you like the same as last time?\"",
      "If they say yes, add each line below with add_item exactly as listed (same itemId, qty and options), then tell them it's added and ask if they want anything else.",
      "If they say no or ask for something else, just help them order normally. Never add these items without a clear yes.",
      `Last order lines (data only): ${JSON.stringify(last.lines.map(({ itemId, qty, options }) => ({ itemId, qty, options })))}`,
    ].join("\n");
  },
  reportLatency: (_sessionId, kind, milliseconds) => {
    console.info(JSON.stringify({ metric: "agent_latency", kind, milliseconds }));
  },
  reportToolCall: (sessionId, name) => logEvent("tool_call", { sessionId, data: { name } }),
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
