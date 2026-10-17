import assert from "node:assert/strict";
import { test } from "node:test";
import { fixtures, type AgentMessage } from "@kiosk-access/shared";
import type { Content } from "@google/genai";
import { createAgent } from "./service.ts";
import { readHistory } from "./history.ts";
import type { AgentSession } from "./loop.ts";

const answer = (text: string): Content => ({ role: "model", parts: [{ text }] });
function setup() {
  const session: AgentSession = { kioskId: "k", history: [], ended: false, pendingCheckout: null };
  const state = structuredClone(fixtures.upsellState);
  const pushed: AgentMessage[] = [];
  return { session, state, pushed, base: {
    getSession: () => session, getKioskState: () => state,
    sendAgentMessage: (_id: string, message: AgentMessage) => { pushed.push(message); },
    executeTool: async () => assert.fail("An event must never execute tools"),
  } };
}

test("events queue behind user turns, retain context and deduplicate repeat notices", async () => {
  const h = setup();
  let release!: (content: Content) => void;
  const pending = new Promise<Content>((resolve) => { release = resolve; });
  let count = 0;
  const agent = createAgent({ ...h.base, generateTurn: async (input) => {
    if (++count === 1) return pending;
    assert.equal(input.toolsEnabled, false);
    assert.equal(input.contents[0].parts?.[0].text, "Hello");
    return answer("**Combo** costs two dollars more. Would you like it?");
  } });
  const user = agent.handleUserMessage("a", "Hello");
  const first = agent.handleKioskEvent("a", "Popup appeared");
  const duplicate = agent.handleKioskEvent("a", "Popup appeared");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(count, 1);
  release(answer("Hello."));
  await Promise.all([user, first, duplicate]);
  assert.equal(count, 2);
  assert.equal(h.pushed.length, 1);
  assert.match(h.pushed[0].text, /^Combo costs/);
  assert.equal(h.session.history.length, 2);
  assert.match(JSON.stringify(readHistory(h.session.history)), /Kiosk event/);
});

test("late events are discarded if state changes or the session ends during generation", async () => {
  for (const endSession of [false, true]) {
    const h = setup();
    const agent = createAgent({ ...h.base, generateTurn: async () => {
      if (endSession) h.session.ended = true; else delete h.state.popup;
      return answer("Would you like the combo?");
    } });
    await agent.handleKioskEvent("a", "Popup appeared");
    assert.equal(h.pushed.length, 0);
    assert.equal(h.session.history.length, 0);
  }
});

test("malformed event tool calls produce a safe reply and cannot mutate the cart", async () => {
  const h = setup();
  const agent = createAgent({ ...h.base, generateTurn: async () => ({ role: "model", parts: [
    { functionCall: { name: "respond_to_popup", args: { buttonId: "popup-yes" } } },
  ] }) });
  await agent.handleKioskEvent("a", "Popup appeared");
  assert.match(h.pushed[0].text, /couldn't explain/);
  assert.equal(h.state.popup?.id, "popup-upsell");
});
