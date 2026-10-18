import assert from "node:assert/strict";
import { test } from "node:test";
import { fixtures, menu } from "@kiosk-access/shared";
import { buildSystemPrompt } from "./prompt.ts";
import { validateActionForState, validateAddItemInput } from "./ordering.ts";

test("missing required box combo drink gets real spoken choices and does not invent a default", () => {
  const result = validateAddItemInput({ itemId: "box_combo", qty: 1, options: { remove: ["no_coleslaw"] } });
  assert.equal(result, "Drink is required for The Box Combo: Lemonade (ID lemonade) or Sweet tea (ID sweet_tea) or Unsweet tea (ID unsweet_tea) or Cola (ID cola). Do not choose a default. Ask the customer.");
});

test("a valid explicit drink and optional removal pass preflight", () => {
  assert.equal(validateAddItemInput({
    itemId: "box_combo", qty: 1, options: { drink: ["sweet_tea"], remove: ["no_coleslaw"] },
  }), null);
});

test("an option ID from another item does not pass validation", () => {
  assert.match(validateAddItemInput({
    itemId: "box_combo", qty: 1, options: { drink: ["sweet_tea"], spice: ["spicy"] },
  })!, /does not have a spice option/);
});

test("a choice from the wrong option group does not pass validation", () => {
  assert.match(validateAddItemInput({
    itemId: "box_combo", qty: 1, options: { drink: ["no_coleslaw"] },
  })!, /not a drink choice/);
});

test("the same customization applies consistently to every item in a quantity", () => {
  assert.equal(validateAddItemInput({
    itemId: "box_combo", qty: 2, options: { drink: ["lemonade"], remove: ["no_coleslaw"] },
  }), null);
  // Mixed preferences must be represented as distinct qty-one calls by the model.
  assert.match(buildSystemPrompt(menu, true), /separate add_item calls/);
  assert.match(buildSystemPrompt(menu, true), /one with.*remove:\\?\["no_coleslaw"\]/s);
});

test("choice wording is generated from the current shared menu", () => {
  const item = structuredClone(menu);
  item.items.find((i) => i.id === "tailgate")!.name = "Party Platter";
  const prompt = buildSystemPrompt(item, true);
  assert.match(prompt, /Party Platter/);
  assert.doesNotMatch(prompt, /Tailgate \(25 Fingers\)/);
});

test("hidden combo upgrades cannot be added as standalone menu items", () => {
  assert.match(validateAddItemInput({ itemId: "combo_upgrade", qty: 1, options: { drink: ["cola"] } })!, /No available item/);
});

test("quantities must be whole numbers from one to ten", () => {
  for (const qty of [0, -1, 1.5, 11, "2"]) {
    assert.match(validateAddItemInput({ itemId: "texas_toast", qty, options: {} })!, /Quantity must be a whole number/);
  }
});

test("missing popup answer pauses an add and describes the current choices", () => {
  const result = validateActionForState("add_item", {
    itemId: "texas_toast", qty: 1, options: {},
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
  assert.equal(validateCartEdit("update_item", { lineId: "L1", options: { remove: ["no_sauce"] } }, state), null);
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
  assert.match(validateAddItemInput({ itemId: "box_combo", qty: 1,
    options: { drink: ["lemonade"], remove: ["no_cheese", "no_cheese"] } })!, /only once/);
  assert.match(validateActionForState("respond_to_popup", { buttonId: "popup-yes" }, fixtures.menuState)!, /no current popup/);
});

test("a transit or cinema ticket is read back by its own name, never as an unrecognized option", async () => {
  const { checkoutReadback } = await import("./checkout.ts");
  const text = checkoutReadback({ lines: [{ lineId: "ticket", itemId: "day_adult", name: "Day pass, Adult, Westlake to Airport",
    qty: 2, options: { ticket: ["day"], fare: ["adult"] }, lineTotal: 12 }], subtotal: 12, tax: 0, total: 12 });
  assert.match(text, /^2 Day pass, Adult, Westlake to Airport\. Total 12 dollars/);
  assert.doesNotMatch(text, /unrecognized/);
});
