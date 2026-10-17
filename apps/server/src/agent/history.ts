import type { Content } from "@google/genai";

// Store whole exchanges so trimming never separates a call from its result or signature.
interface HistoryTurn { kind: "agent-turn-v1"; contents: Content[] }
export const MAX_HISTORY_TURNS = 12;

function isTurn(value: unknown): value is HistoryTurn {
  return typeof value === "object" && value !== null && "kind" in value &&
    value.kind === "agent-turn-v1" && "contents" in value && Array.isArray(value.contents);
}

export function readHistory(history: unknown[]): Content[] {
  return history.filter(isTurn).slice(-MAX_HISTORY_TURNS).flatMap((turn) => turn.contents);
}

export function saveTurn(history: unknown[], contents: Content[]): void {
  const turns = history.filter(isTurn).slice(-(MAX_HISTORY_TURNS - 1));
  history.splice(0, history.length, ...turns, { kind: "agent-turn-v1", contents: structuredClone(contents) });
}
