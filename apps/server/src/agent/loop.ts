import type { Content, FunctionCall, Part } from "@google/genai";
import type { Cart, AgentMessage, KioskState } from "@kiosk-access/shared";
import { MAX_TOOL_ROUNDS } from "./config.ts";
import { GeminiError, spokenText, type GenerateTurn, type GeminiFailure } from "./gemini.ts";
import { readHistory, saveTurn } from "./history.ts";
import { dispatchAgentTool } from "./tools.ts";
import { validateActionForState, validateAddItemInput, validateCartEdit } from "./ordering.ts";
import { cleanSpokenReply } from "./spoken.ts";
import { checkoutReadback } from "./checkout.ts";

export interface AgentSession {
  kioskId: string;
  ended: boolean;
  history: unknown[];
  pendingCheckout: Cart | null;
}
export interface LoopDependencies {
  getSession(sessionId: string): AgentSession | undefined;
  getKioskState(kioskId: string): KioskState | null;
  generateTurn: GenerateTurn;
  executeTool(sessionId: string, name: string, input: unknown): Promise<string>;
  reportFailure?(sessionId: string, code: GeminiFailure): void;
  reportToolCall?(sessionId: string, name: string): void;
  /** What we remember about a returning customer, for the model's context. */
  getMemory?(sessionId: string): string | null;
}

export const endedReply = (): AgentMessage => ({
  text: "This session has ended. Please scan the kiosk code to start again.", awaitingConfirmation: false,
});

export async function runToolLoop(deps: LoopDependencies, sessionId: string, text: string): Promise<AgentMessage> {
  const session = deps.getSession(sessionId);
  if (!session || session.ended) return endedReply();
  const active = () => !session.ended && deps.getSession(sessionId) === session;
  const previous = readHistory(session.history);
  const turn: Content[] = [{ role: "user", parts: [{ text }] }];
  let attemptedAction = false;
  // After an exception, action outcome can be unknown. Do not replay mutations this turn.
  let actionOutcomeUnknown = false;
  let checkoutRequested = false;
  const finish = (reply: string, modelAlreadyStored = false): AgentMessage => {
    if (!active()) return endedReply();
    const spokenReply = cleanSpokenReply(reply);
    if (!modelAlreadyStored) turn.push({ role: "model", parts: [{ text: spokenReply }] });
    saveTurn(session.history, turn);
    return { text: spokenReply, awaitingConfirmation: session.pendingCheckout !== null };
  };

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (!active()) return endedReply();
      const content = await deps.generateTurn({
        contents: structuredClone([...previous, ...turn]),
        state: deps.getKioskState(session.kioskId), toolsEnabled: true,
        memory: deps.getMemory?.(sessionId) ?? undefined,
      });
      if (!active()) return endedReply();
      const calls = content.parts?.flatMap((part) => part.functionCall ? [part.functionCall] : []) ?? [];
      if (!calls.length) {
        const reply = spokenText(content);
        if (!cleanSpokenReply(reply)) throw new GeminiError("invalid_response");
        turn.push(content);
        return finish(reply, true);
      }
      if (calls.some((call) => !call.name)) throw new GeminiError("invalid_response");
      turn.push(content); // includes signed parts; do not reconstruct from functionCalls
      const results: Part[] = [];
      for (const call of calls) {
        if (!active()) return endedReply();
        const name = call.name!;
        const mutation = !["get_menu", "get_kiosk_state"].includes(name);
        let result: string;
        const currentState = deps.getKioskState(session.kioskId);
        const addValidation = name === "add_item" ? validateAddItemInput(call.args ?? {}) : null;
        const stateValidation = mutation ? validateActionForState(name, call.args ?? {}, currentState) : null;
        const validation = stateValidation ?? addValidation ?? validateCartEdit(name, call.args ?? {}, currentState);
        if (calls.length > 8) {
          result = "Rejected: too many tool calls in one response. No actions in this batch were executed; use at most eight.";
        } else if (checkoutRequested && mutation) {
          result = "Not executed: checkout review is now pending. Wait for the customer's next instruction before making changes.";
        } else if (validation) {
          result = `Not executed: ${validation}`;
        } else if (actionOutcomeUnknown && mutation) {
          result = "Not executed: a previous action's outcome is unknown. Ask the customer to review the current order before another change.";
        } else {
          try {
            deps.reportToolCall?.(sessionId, name);
            result = await dispatchAgentTool(async (...args) => {
              if (mutation) attemptedAction = true;
              return deps.executeTool(...args);
            }, sessionId, name, call.args ?? {});
            if (name === "request_checkout" && session.pendingCheckout !== null) checkoutRequested = true;
          } catch {
            if (mutation) actionOutcomeUnknown = true;
            result = "Tool failed unexpectedly. Its outcome may be unknown. Read current kiosk state before discussing the order; do not retry this action automatically.";
          }
        }
        // Complete every call/result pair in order, even when a tool fails.
        results.push(toolResult(call, result));
      }
      turn.push({ role: "user", parts: results });
      if (checkoutRequested && session.pendingCheckout !== null) {
        return finish(checkoutReadback(session.pendingCheckout));
      }
    }
    return finish("I've reached the limit for this request. Please review your current order before asking for another change.");
  } catch (error) {
    if (!active()) return endedReply();
    const code = error instanceof GeminiError ? error.code : "unavailable";
    deps.reportFailure?.(sessionId, code);
    return finish(code === "configuration"
      ? "The assistant is not connected yet. Please ask a staff member for help."
      : attemptedAction
        ? "I'm having trouble finishing my reply. Your order may have changed; please review it before repeating the request."
        : "I'm having trouble answering right now. Please try again in a moment.");
  }
}

function toolResult(call: FunctionCall, result: string): Part {
  return { functionResponse: {
    name: call.name!, ...(call.id !== undefined ? { id: call.id } : {}), response: { result },
  } };
}
