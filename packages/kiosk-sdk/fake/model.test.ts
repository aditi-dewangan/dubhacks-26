import { describe, expect, it } from "vitest";
import type { KioskCommand } from "@kiosk-access/shared";
import { FakeKiosk } from "./model.ts";

const sandwich = { type: "add_item", itemId: "chicken_sandwich", qty: 1, options: { remove: ["no_lettuce"] } } satisfies KioskCommand;

describe("FakeKiosk", () => {
  it("adds a chicken sandwich and shows the combo popup", () => {
    const k = new FakeKiosk();
    const r = k.run(sandwich);
    expect(r.ok).toBe(true);
    expect(r.state.cart.lines).toEqual([
      { lineId: "L1", itemId: "chicken_sandwich", name: "Chicken Sandwich", qty: 1,
        options: { remove: ["no_lettuce"] }, lineTotal: 7.49 },
    ]);
    expect(r.state.cart).toMatchObject({ subtotal: 7.49, tax: 0.76, total: 8.25 });
    expect(r.state.popup?.buttons.map((b) => b.id)).toEqual(["popup-yes", "popup-no"]);
  });

  it("refuses other commands while the popup shows", () => {
    const k = new FakeKiosk();
    k.run(sandwich);
    const r = k.run({ type: "cancel_order" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/A popup is showing/);
  });

  it("adds the combo after yes and a drink, and removes it with its sandwich", () => {
    const k = new FakeKiosk();
    k.run(sandwich);
    expect(k.run({ type: "press", buttonId: "popup-yes" }).state.popup?.id).toBe("popup-combo-drink");
    const r = k.run({ type: "press", buttonId: "popup-drink-lemonade" });
    expect(r.state.popup).toBeUndefined();
    expect(r.state.cart.lines.map((l) => l.itemId)).toEqual(["chicken_sandwich", "combo_upgrade"]);
    expect(k.run({ type: "remove_item", lineId: "L1" }).state.cart.lines).toEqual([]);
  });

  it("matches the real kiosk's refusals", () => {
    const k = new FakeKiosk();
    expect(k.run({ type: "add_item", itemId: "box_combo", qty: 1, options: {} }).error)
      .toBe("Drink is required for The Box Combo: lemonade or sweet_tea or unsweet_tea or cola.");
    expect(k.run({ type: "add_item", itemId: "combo_upgrade", qty: 1, options: {} }).ok).toBe(false);
    expect(k.run({ type: "press", buttonId: "btn-pay" }).ok).toBe(false);
    expect(k.run({ type: "start_payment" }).error).toMatch(/order is empty/);
  });

  it("goes to paying, then complete with an order number after the card tap", () => {
    const k = new FakeKiosk();
    k.run({ type: "add_item", itemId: "texas_toast", qty: 2, options: {} });
    expect(k.run({ type: "start_payment" }).state.screen).toBe("paying");
    expect(k.run({ type: "add_item", itemId: "texas_toast", qty: 1, options: {} }).ok).toBe(false);
    k.tapCard();
    expect(k.state()).toMatchObject({ screen: "complete", orderNumber: "141" });
  });
});
