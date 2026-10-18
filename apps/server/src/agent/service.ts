import type { AgentMessage, KioskState } from "@kiosk-access/shared";
import type { GenerateTurn, GeminiFailure } from "./gemini.ts";
import { runToolLoop, endedReply, type AgentSession } from "./loop.ts";
import { announceEvent } from "./events.ts";

export interface AgentDependencies {
  getSession(sessionId: string): AgentSession | undefined;
  getKioskState(kioskId: string): KioskState | null;
  sendAgentMessage(sessionId: string, message: AgentMessage): void;
  generateTurn?: GenerateTurn;
  executeTool?(sessionId: string, name: string, input: unknown): Promise<string>;
  reportFailure?(sessionId: string, code: GeminiFailure): void;
  reportToolCall?(sessionId: string, name: string): void;
  reportLatency?(sessionId: string, kind: "user" | "event", milliseconds: number): void;
  getMemory?(sessionId: string): string | null;
}

/** Serialize model history for both user and event turns; unrelated sessions stay independent. */
export function createAgent(deps: AgentDependencies) {
  const queues = new WeakMap<AgentSession, Promise<unknown>>();
  const lastEvents = new WeakMap<AgentSession, string>();
  function enqueue<T>(session: AgentSession, work: () => Promise<T>): Promise<T> {
    const next = (queues.get(session) ?? Promise.resolve()).catch(() => {}).then(work);
    queues.set(session, next);
    void next.finally(() => { if (queues.get(session) === next) queues.delete(session); }).catch(() => {});
    return next;
  }
  return {
    async handleUserMessage(sessionId: string, text: string): Promise<AgentMessage> {
      const session = deps.getSession(sessionId);
      if (!session || session.ended) {
        return endedReply();
      }
      return enqueue(session, async () => {
        if (session.ended || deps.getSession(sessionId) !== session) return endedReply();
        lastEvents.delete(session);
        const started = performance.now();
        try {
          if (deps.generateTurn) {
            return await runToolLoop({
              ...deps, generateTurn: deps.generateTurn,
              executeTool: deps.executeTool ?? (async () => "Tool unavailable: ordering is not connected yet."),
            }, sessionId, text);
          }
          const state = deps.getKioskState(session.kioskId);
          const where = state ? ` The kiosk is on the ${state.screen} screen.` : "";
          return { text: `Stub agent heard: "${text}".${where}`, awaitingConfirmation: false };
        } finally { deps.reportLatency?.(sessionId, "user", Math.round(performance.now() - started)); }
      });
    },

    async handleKioskEvent(sessionId: string, note: string): Promise<void> {
      const session = deps.getSession(sessionId);
      if (!session || session.ended) return;
      const stateKey = JSON.stringify(deps.getKioskState(session.kioskId));
      const key = JSON.stringify([note, stateKey]);
      return enqueue(session, async () => {
        if (session.ended || deps.getSession(sessionId) !== session || lastEvents.get(session) === key) return;
        // A resolved popup or changed cart must not be announced from an old queued note.
        if (JSON.stringify(deps.getKioskState(session.kioskId)) !== stateKey) return;
        const started = performance.now();
        try {
          const message = deps.generateTurn
            ? await announceEvent(deps, sessionId, session, note, stateKey)
            : { text: `Stub agent: ${note}`, awaitingConfirmation: false };
          if (!message || session.ended || deps.getSession(sessionId) !== session) return;
          deps.sendAgentMessage(sessionId, message);
          lastEvents.set(session, key);
        } finally { deps.reportLatency?.(sessionId, "event", Math.round(performance.now() - started)); }
      });
    },
  };
}
