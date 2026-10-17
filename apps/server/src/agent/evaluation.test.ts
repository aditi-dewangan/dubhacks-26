import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateConversations, latencySummary } from "./testing/evaluation.ts";
import { conversationCases } from "./testing/conversations.ts";

test("evaluation records failed assertions without stopping subsequent scenarios", async () => {
  const failure = { ...conversationCases[0], id: "intentional-failure", check: () => { throw new Error("private diagnostic"); } };
  const report = await evaluateConversations([failure, conversationCases[0]], 2);
  assert.equal(report.mode, "offline-scripted");
  assert.equal(report.passed, 2);
  assert.equal(report.failed, 2);
  assert.equal(report.latency?.samples, 4);
  assert.ok(!JSON.stringify(report).includes("private diagnostic"));
  assert.ok(report.results[0].replies.length > 0);
});

test("latency percentiles are sorted without changing the source samples", () => {
  const values = [3000, 1, 20, 100];
  assert.deepEqual(latencySummary(values), { samples: 4, medianMs: 20, p95Ms: 3000, maxMs: 3000 });
  assert.deepEqual(values, [3000, 1, 20, 100]);
  assert.equal(latencySummary([]), null);
});
