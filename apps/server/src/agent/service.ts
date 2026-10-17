import type { AgentMessage, KioskState } from "@kiosk-access/shared";
import { GeminiError, type GenerateReply, type GeminiFailure } from "./gemini.ts";

export interface AgentDependencies {
  getSession(sessionId: string): { kioskId: string; ended: boolean } | undefined;
  getKioskState(kioskId: string): KioskState | null;
  sendAgentMessage(sessionId: string, message: AgentMessage): void;
  generateReply?: GenerateReply;
  reportFailure?(sessionId: string, code: GeminiFailure): void;
}

const endedReply = (): AgentMessage => ({
  text: "This session has ended. Please scan the kiosk code to start again.", awaitingConfirmation: false,
});

/** Gemini is read-only for hour 2. Stub mode remains available for integration tests. */
export function createAgent(deps: AgentDependencies) {
  return {
    async handleUserMessage(sessionId: string, text: string): Promise<AgentMessage> {
      const session = deps.getSession(sessionId);
      if (!session || session.ended) {
        return endedReply();
      }
      const state = deps.getKioskState(session.kioskId);
      if (deps.generateReply) {
        try {
          const reply = await deps.generateReply({ text, state });
          const current = deps.getSession(sessionId);
          if (!current || current.ended) return endedReply();
          return { text: reply, awaitingConfirmation: false };
        } catch (error) {
          const current = deps.getSession(sessionId);
          if (!current || current.ended) return endedReply();
          const code = error instanceof GeminiError ? error.code : "unavailable";
          deps.reportFailure?.(sessionId, code);
          return {
            text: code === "configuration"
              ? "The assistant is not connected yet. Please ask a staff member for help."
              : "I'm having trouble answering right now. Please try again in a moment.",
            awaitingConfirmation: false,
          };
        }
      }
      const where = state ? ` The kiosk is on the ${state.screen} screen.` : "";
      return { text: `Stub agent heard: "${text}".${where}`, awaitingConfirmation: false };
    },

    async handleKioskEvent(sessionId: string, note: string): Promise<void> {
      const session = deps.getSession(sessionId);
      if (!session || session.ended) return;
      // Event model turns, serialization and deduplication are a later phase.
      deps.sendAgentMessage(sessionId, {
        text: deps.generateReply ? note : `Stub agent: ${note}`, awaitingConfirmation: false,
      });
    },
  };
}
