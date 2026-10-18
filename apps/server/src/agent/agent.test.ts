import assert from "node:assert/strict";
import { test } from "node:test";
import { fixtures, type AgentMessage } from "@kiosk-access/shared";
import { readGeminiConfig } from "./config.ts";
import { createAgent } from "./service.ts";
import { agentTools, dispatchAgentTool } from "./tools.ts";

function harness() {
  const sessions = new Map([
    ["a", { kioskId: "kiosk-a", ended: false, history: [], pendingCheckout: null }],
    ["b", { kioskId: "kiosk-b", ended: false, history: [], pendingCheckout: null }],
  ]);
  const pushed: { sessionId: string; message: AgentMessage }[] = [];
  const reads: string[] = [];
  const agent = createAgent({
    getSession: (id) => sessions.get(id),
    getKioskState: (id) => {
      reads.push(id);
      return id === "kiosk-a" ? fixtures.menuState : fixtures.completeState;
    },
    sendAgentMessage: (sessionId, message) => { pushed.push({ sessionId, message }); },
  });
  return { agent, sessions, pushed, reads };
}

test("each session reads its own kiosk and returns, rather than pushes, a reply", async () => {
  const h = harness();
  const [a, b] = await Promise.all([
    h.agent.handleUserMessage("a", "first"), h.agent.handleUserMessage("b", "second"),
  ]);
  assert.match(a.text, /first.*menu/);
  assert.match(b.text, /second.*complete/);
  assert.equal(a.awaitingConfirmation, false);
  assert.deepEqual(h.reads, ["kiosk-a", "kiosk-b"]);
  assert.deepEqual(h.pushed, []);
});

test("missing and ended sessions cannot read kiosk state or push events", async () => {
  const h = harness();
  h.sessions.get("a")!.ended = true;
  for (const id of ["a", "missing"]) {
    assert.match((await h.agent.handleUserMessage(id, "hello")).text, /session has ended/);
    await h.agent.handleKioskEvent(id, "popup");
  }
  assert.deepEqual(h.reads, []);
  assert.deepEqual(h.pushed, []);
});

test("proactive messages are pushed only to the requested active session", async () => {
  const h = harness();
  await h.agent.handleKioskEvent("b", "Order complete");
  assert.deepEqual(h.pushed, [{ sessionId: "b", message: {
    text: "Stub agent: Order complete", awaitingConfirmation: false,
  } }]);
});

test("an active session can respond before the kiosk has published state", async () => {
  const session = { kioskId: "k", ended: false, history: [], pendingCheckout: null };
  const agent = createAgent({
    getSession: () => session,
    getKioskState: () => null,
    sendAgentMessage: () => assert.fail("User replies must be returned"),
  });
  assert.deepEqual(await agent.handleUserMessage("s", "hello"), {
    text: 'Stub agent heard: "hello".', awaitingConfirmation: false,
  });
});

test("tool dispatch preserves session, input, and the bridge result", async () => {
  const input = { itemId: "cheeseburger", qty: 1, options: { size: ["large"] } };
  const result = await dispatchAgentTool(async (sessionId, name, received) => {
    assert.equal(sessionId, "a");
    assert.equal(name, "add_item");
    assert.equal(received, input);
    return "Rejected: a popup needs an answer first.";
  }, "a", "add_item", input);
  assert.equal(result, "Rejected: a popup needs an answer first.");
});

test("payment, generic press, confirm and unknown tools never reach the bridge", async () => {
  for (const name of ["start_payment", "press", "handleConfirm", "unknown"]) {
    const result = await dispatchAgentTool(async () => {
      assert.fail("Forbidden tool reached bridge");
    }, "a", name, { buttonId: "btn-pay" });
    assert.match(result, /Unknown agent tool/);
  }
  assert.equal(agentTools.length, 10);
  assert.equal(new Set(agentTools.map((t) => t.name)).size, 10);
});

test("bridge exceptions remain observable to the future tool loop", async () => {
  await assert.rejects(dispatchAgentTool(async () => {
    throw new Error("The kiosk didn't respond");
  }, "a", "get_kiosk_state", {}), /kiosk didn't respond/);
});

test("Gemini configuration is explicit, server-side, and supports the legacy key", () => {
  assert.deepEqual(readGeminiConfig({ GEMINI_API_KEY: "primary", LLM_API_KEY: "legacy", GEMINI_MODEL: " test-model " }),
    { apiKey: "primary", model: "test-model" });
  assert.deepEqual(readGeminiConfig({ LLM_API_KEY: "legacy", GEMINI_MODEL: "test-model" }),
    { apiKey: "legacy", model: "test-model" });
  assert.throws(() => readGeminiConfig({}), /GEMINI_API_KEY/);
  assert.throws(() => readGeminiConfig({ GEMINI_API_KEY: "test-secret" }), /GEMINI_MODEL/);
});
