import assert from "node:assert/strict";
import test from "node:test";
import type { Content } from "@google/genai";
import { GeminiError, withRetries, type GenerateTurn, type GeminiFailure } from "./gemini.ts";

const reply: Content = { role: "model", parts: [{ text: "Sure." }] };
const input = { contents: [], state: null, toolsEnabled: true };
const noWait = async () => {};

/** A model that fails with the given codes, in order, then answers. */
function flaky(...failures: GeminiFailure[]) {
  const model: GenerateTurn & { calls: number } = Object.assign(async () => {
    model.calls++;
    const code = failures.shift();
    if (code) throw new GeminiError(code);
    return reply;
  }, { calls: 0 });
  return model;
}

test("a busy or slow moment is retried quietly", async () => {
  for (const code of ["rate_limit", "unavailable", "timeout", "invalid_response"] as const) {
    const model = flaky(code);
    assert.deepEqual(await withRetries(model, [], 0, noWait)(input), reply);
    assert.equal(model.calls, 2);
  }
});

test("falls back to the second model when the main one keeps failing", async () => {
  const main = flaky("rate_limit", "rate_limit");
  const backup = flaky();
  assert.deepEqual(await withRetries(main, [backup], 0, noWait)(input), reply);
  assert.equal(main.calls, 2);
  assert.equal(backup.calls, 1);
});

test("gives up with the last error after every attempt fails", async () => {
  const main = flaky("timeout", "timeout");
  const backup = flaky("unavailable");
  await assert.rejects(withRetries(main, [backup], 0, noWait)(input), (e: unknown) => e instanceof GeminiError && e.code === "unavailable");
});

test("a configuration problem is not retried", async () => {
  const main = flaky("configuration");
  await assert.rejects(withRetries(main, [flaky()], 0, noWait)(input), (e: unknown) => e instanceof GeminiError && e.code === "configuration");
  assert.equal(main.calls, 1);
});

test("waits a little longer before each retry", async () => {
  const waits: number[] = [];
  await withRetries(flaky("rate_limit", "rate_limit"), [flaky()], 400, async (ms) => { waits.push(ms); })(input);
  assert.deepEqual(waits, [400, 800]);
});
