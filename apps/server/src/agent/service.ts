import type { AgentMessage, KioskState } from "@kiosk-access/shared";

export interface AgentDependencies {
  getSession(sessionId: string): { kioskId: string; ended: boolean } | undefined;
  getKioskState(kioskId: string): KioskState | null;
  sendAgentMessage(sessionId: string, message: AgentMessage): void;
}

/** Hour 1 scaffold: preserve stub behavior until the model loop is implemented. */
export function createAgent(deps: AgentDependencies) {
  return {
    async handleUserMessage(sessionId: string, text: string): Promise<AgentMessage> {
      const session = deps.getSession(sessionId);
      if (!session || session.ended) {
        return { text: "This session has ended. Please scan the kiosk code to start again.", awaitingConfirmation: false };
      }
      const state = deps.getKioskState(session.kioskId);
      const where = state ? ` The kiosk is on the ${state.screen} screen.` : "";
      return { text: `Stub agent heard: "${text}".${where}`, awaitingConfirmation: false };
    },

    async handleKioskEvent(sessionId: string, note: string): Promise<void> {
      const session = deps.getSession(sessionId);
      if (!session || session.ended) return;
      deps.sendAgentMessage(sessionId, { text: `Stub agent: ${note}`, awaitingConfirmation: false });
    },
  };
}
