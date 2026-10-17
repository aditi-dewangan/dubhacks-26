import assert from "node:assert/strict";
import { test } from "node:test";
import { fixtures } from "@kiosk-access/shared";
import { checkoutReadback } from "./checkout.ts";
import { fakeBridge } from "./testing/fake-bridge.ts";
import { createAgent } from "./service.ts";
import { readHistory } from "./history.ts";

test("checkout readback retains exact pending total and item customizations", () => {
  const text = checkoutReadback(fixtures.upsellState.cart);
  assert.match(text, /1 Cheeseburger, Large, No onions/);
  assert.match(text, /8 dollars and 80 cents/);
  assert.match(text, /confirm/);
  assert.ok(text.length <= 300);
});

test("large carts preserve the total and disclose abbreviated item detail", () => {
  const cart = structuredClone(fixtures.upsellState.cart);
  cart.lines = Array.from({ length: 20 }, (_, index) => ({ ...cart.lines[0], lineId: String(index) }));
  cart.total = 176;
  const text = checkoutReadback(cart);
  assert.ok(text.length <= 300);
  assert.match(text, /20 items/);
  assert.match(text, /176 dollars/);
  assert.match(text, /individual items before confirming/);
  assert.ok(!text.endsWith("…"));
});

test("checkout reads the snapshot without another model call and blocks later batch mutations", async () => {
  const state = structuredClone(fixtures.upsellState);
  delete state.popup;
  const bridge = fakeBridge(state);
  let rounds = 0;
  const agent = createAgent({ getSession: () => bridge.session, getKioskState: () => bridge.state,
    sendAgentMessage: () => {}, executeTool: bridge.executeTool, generateTurn: async () => {
      rounds++;
      return { role: "model", parts: [
        { functionCall: { name: "request_checkout", args: {}, id: "checkout" } },
        { functionCall: { name: "remove_item", args: { lineId: "L1" }, id: "remove" } },
      ] };
    } });
  const reply = await agent.handleUserMessage("s", "That's it");
  assert.equal(rounds, 1);
  assert.equal(reply.awaitingConfirmation, true);
  assert.match(reply.text, /8 dollars and 80 cents/);
  assert.deepEqual(bridge.calls.map((c) => c.name), ["request_checkout"]);
  assert.equal(bridge.state.cart.lines.length, 1);
  assert.match(JSON.stringify(readHistory(bridge.session.history)), /checkout review is now pending/);
});
