import assert from "node:assert/strict";
import { test } from "node:test";
import { fixtures, menu } from "@kiosk-access/shared";
import { buildSystemPrompt } from "./prompt.ts";
import { validateActionForState, validateAddItemInput } from "./ordering.ts";

test("missing required cheeseburger size gets real spoken choices and does not invent a default", () => {
  const result = validateAddItemInput({ itemId: "cheeseburger", qty: 1, options: { remove: ["no_onions"] } });
  assert.equal(result, "Size is required for Cheeseburger: Regular (ID regular) or Large (ID large). Do not choose a default. Ask the customer.");
});

test("a valid explicit size and optional removal pass preflight", () => {
  assert.equal(validateAddItemInput({
    itemId: "cheeseburger", qty: 1, options: { size: ["large"], remove: ["no_onions"] },
  }), null);
});

test("an option ID from another item does not pass validation", () => {
  assert.match(validateAddItemInput({
    itemId: "cheeseburger", qty: 1, options: { size: ["large"], spice: ["spicy"] },
  })!, /does not have a spice option/);
});

test("a choice from the wrong option group does not pass validation", () => {
  assert.match(validateAddItemInput({
    itemId: "cheeseburger", qty: 1, options: { size: ["no_onions"] },
  })!, /not a size choice/);
});

test("the same customization applies consistently to every item in a quantity", () => {
  assert.equal(validateAddItemInput({
    itemId: "cheeseburger", qty: 2, options: { size: ["regular"], remove: ["no_onions"] },
  }), null);
  // Mixed preferences must be represented as distinct qty-one calls by the model.
  assert.match(buildSystemPrompt(menu, true), /separate add_item calls/);
  assert.match(buildSystemPrompt(menu, true), /one with.*remove:\\?\["no_onions"\]/s);
});

test("choice wording is generated from the current shared menu", () => {
  const item = structuredClone(menu);
  item.items[0].optionGroups[0].choices[0].name = "Standard";
  const prompt = buildSystemPrompt(item, true);
  assert.match(prompt, /Standard/);
  assert.doesNotMatch(prompt, /Regular \(ID regular\)/);
});

test("hidden combo upgrades cannot be added as standalone menu items", () => {
  assert.match(validateAddItemInput({ itemId: "combo_upgrade", qty: 1, options: { drink: ["cola"] } })!, /No available item/);
});

test("quantities must be whole numbers from one to ten", () => {
  for (const qty of [0, -1, 1.5, 11, "2"]) {
    assert.match(validateAddItemInput({ itemId: "water", qty, options: {} })!, /Quantity must be a whole number/);
  }
});

test("missing popup answer pauses an add and describes the current choices", () => {
  const result = validateActionForState("add_item", {
    itemId: "water", qty: 1, options: {},
  }, fixtures.upsellState);
  assert.match(result!, /Not executed/);
  assert.match(result!, /\$2\.00 more/);
  assert.match(result!, /No thanks/);
});

test("popup button must exactly match a button on that popup", () => {
  assert.match(validateActionForState("respond_to_popup", { buttonId: "popup-drink-cola" }, fixtures.upsellState)!, /popup choice is unavailable/);
  assert.equal(validateActionForState("respond_to_popup", { buttonId: "popup-no" }, fixtures.upsellState), null);
});

test("without an active popup normal tools pass the popup guard", () => {
  assert.equal(validateActionForState("add_item", {}, fixtures.menuState), null);
});

// Patches must be validated against an actual cart line, not only a model schema.
test("cart edits preserve omitted groups and reject stale IDs, invalid quantities and cleared required options", async () => {
  const { validateCartEdit } = await import("./ordering.ts");
  const state = structuredClone(fixtures.upsellState);
  delete state.popup;
  assert.equal(validateCartEdit("update_item", { lineId: "L1", options: { remove: [] } }, state), null);
  assert.equal(validateCartEdit("update_item", { lineId: "L1", options: { size: ["regular"] } }, state), null);
  for (const input of [{ lineId: "missing", qty: 1 }, { lineId: "L1", qty: null },
    { lineId: "L1", qty: 0 }, { lineId: "L1" }, { lineId: "L1", options: {} },
    { lineId: "L1", options: { size: [] } }, { lineId: "L1", options: { size: ["small"] } }]) {
    assert.notEqual(validateCartEdit("update_item", input, state), null);
  }
  assert.match(validateCartEdit("remove_item", { lineId: "missing" }, state)!, /no longer exists/);
  assert.match(validateCartEdit("remove_item", { lineId: "L1" }, null)!, /unavailable/);
  assert.match(validateCartEdit("remove_item", { lineId: "L1" }, fixtures.completeState)!, /complete/);
});

test("duplicate modifiers and stale popup responses are rejected", () => {
  assert.match(validateAddItemInput({ itemId: "cheeseburger", qty: 1,
    options: { size: ["regular"], remove: ["no_cheese", "no_cheese"] } })!, /only once/);
  assert.match(validateActionForState("respond_to_popup", { buttonId: "popup-yes" }, fixtures.menuState)!, /no current popup/);
});
