import type { GenerateTurn } from "../gemini.ts";
import { runConversation, type ConversationCase } from "./conversations.ts";

export function latencySummary(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
  return { samples: sorted.length, medianMs: percentile(0.5), p95Ms: percentile(0.95), maxMs: sorted.at(-1)! };
}

export async function evaluateConversations(cases: ConversationCase[], runs: number, model?: GenerateTurn) {
  const results = [];
  const timings: number[] = [];
  for (let run = 1; run <= runs; run++) {
    for (const scenario of cases) {
      const observed: { text: string; milliseconds: number }[] = [];
      try {
        const result = await runConversation(scenario, model, (reply) => {
          observed.push(reply); timings.push(reply.milliseconds);
        });
        results.push({ run, scenario: scenario.id, status: "pass", ...result });
      } catch {
        results.push({ run, scenario: scenario.id, status: "fail", replies: observed,
          review: scenario.review, failure: "Conversation assertions or provider execution failed; review the recorded replies and scenario expectations." });
      }
    }
  }
  const failed = results.filter((result) => result.status === "fail").length;
  return {
    mode: model ? "live" : "offline-scripted", createdAt: new Date().toISOString(), runs,
    scenarios: cases.length, passed: results.length - failed, failed,
    latency: latencySummary(timings),
    naturalLanguageReview: "Manual review required. Structural checks do not grade factual wording, comprehension, or voice quality.",
    results,
  };
}
