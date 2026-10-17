import { describe, expect, it } from "vitest";
import { menu } from "@kiosk-access/shared";
import { setup } from "./harness.ts";
import { describeLine, spokenMoney } from "./spoken.ts";
import { resolveOrderableItem, validateOptions } from "./validate.ts";

const cheeseburger = menu.items.find((i) => i.id === "cheeseburger")!;

describe("validation before anything reaches the kiosk", () => {
  it("rejects an unknown item with the closest suggestion", async () => {
    const t = setup();
    expect(await t.tool("add_item", { itemId: "chicken burger", qty: 1, options: {} }))
      .toBe('No item "chicken burger". Closest: crispy chicken sandwich.');
    expect(await t.tool("add_item", { itemId: "oat milk latte", qty: 1 })).toBe('No item "oat milk latte" on this menu.');
    expect(t.sent).toHaveLength(0);
  });

  it("asks for a missing required option", async () => {
    const t = setup();
    expect(await t.tool("add_item", { itemId: "cheeseburger", qty: 1, options: {} })).toBe("Size is required: regular or large.");
    expect(await t.tool("add_item", { itemId: "soda", qty: 1 }))
      .toBe("Flavor is required: cola, diet cola, lemon-lime or root beer. Size is required: small, medium or large.");
    expect(t.sent).toHaveLength(0);
  });

  it("rejects a hidden item (only the upsell popup adds it)", async () => {
    const t = setup();
    const reply = await t.tool("add_item", { itemId: "combo_upgrade", qty: 1, options: { drink: ["cola"] } });
    expect(reply).toMatch(/can't be ordered directly/);
    expect(await t.tool("add_item", { itemId: "combo", qty: 1 })).toMatch(/can't be ordered directly/);
    expect(t.sent).toHaveLength(0);
  });

  it("rejects choices that aren't real, and extra groups", async () => {
    const t = setup();
    expect(await t.tool("add_item", { itemId: "cheeseburger", options: { size: ["medium"] } }))
      .toBe('"medium" isn\'t a size choice for the cheeseburger. Choices: regular or large.');
    expect(await t.tool("add_item", { itemId: "cheeseburger", options: { size: ["regular", "large"] } }))
      .toBe("Pick one size: regular or large.");
    expect(await t.tool("add_item", { itemId: "cheeseburger", options: { size: ["large"], sauce: ["bbq"] } }))
      .toBe('The cheeseburger has no "sauce" option. Its options are: size and remove.');
    expect(await t.tool("add_item", { itemId: "fries", qty: 11, options: { size: ["large"] } }))
      .toBe("Quantity must be a whole number from 1 to 10.");
    expect(t.sent).toHaveLength(0);
  });

  it("resolves aliases: coke, fries, and burger as a category", async () => {
    expect(resolveOrderableItem("coke")).toMatchObject({ ok: true, value: { item: { id: "soda" }, presetOptions: { flavor: ["cola"] } } });
    expect(resolveOrderableItem("fries")).toMatchObject({ ok: true, value: { item: { id: "fries" } } });
    expect(resolveOrderableItem("burger")).toEqual({
      ok: false,
      error: '"burger" could be any of these: cheeseburger, double cheeseburger, crispy chicken sandwich or garden veggie burger. Which one?',
    });

    const t = setup();
    expect(await t.tool("add_item", { itemId: "coke", qty: 1 })).toBe("Size is required: small, medium or large.");
    expect(await t.tool("add_item", { itemId: "coke", qty: 2, options: { size: ["small"] } }))
      .toBe("Added 2 small fountain sodas, cola. Cart total four thirty-eight with tax.");
    expect(t.sent.map((e) => e.command)).toEqual([
      { type: "add_item", itemId: "soda", qty: 2, options: { flavor: ["cola"], size: ["small"] } },
    ]);
  });

  it("accepts names for groups and choices, and fixes small typos", () => {
    expect(validateOptions(cheeseburger, { Size: "Large", remove: ["onions", "no pickles"] }, true))
      .toEqual({ ok: true, value: { size: ["large"], remove: ["no_onions", "no_pickles"] } });
    expect(resolveOrderableItem("chesseburger")).toMatchObject({ ok: true, value: { item: { id: "cheeseburger" } } });
  });

  it("only presses buttons that are on the popup", async () => {
    const t = setup();
    expect(await t.tool("respond_to_popup", { buttonId: "popup-yes" })).toBe("There's no popup showing right now.");
    await t.tool("add_item", { itemId: "cheeseburger", options: { size: ["regular"] } });
    expect(await t.tool("respond_to_popup", { buttonId: "btn-pay" })).toMatch(/^No "btn-pay" button on the popup/);
    expect(t.sent.map((e) => e.command.type)).toEqual(["add_item"]);
  });
});

describe("spoken summaries", () => {
  it("says prices the way people do", () => {
    expect(spokenMoney(7.99)).toBe("seven ninety-nine");
    expect(spokenMoney(6.49)).toBe("six forty-nine");
    expect(spokenMoney(2)).toBe("two dollars");
    expect(spokenMoney(1)).toBe("one dollar");
    expect(spokenMoney(0.5)).toBe("fifty cents");
    expect(spokenMoney(8.05)).toBe("eight oh five");
    expect(spokenMoney(11)).toBe("eleven dollars");
  });

  it("describes lines as short phrases", () => {
    expect(describeLine({ itemId: "cheeseburger", qty: 1, options: { size: ["large"], remove: ["no_onions"] } }))
      .toBe("1 large cheeseburger, no onions");
    expect(describeLine({ itemId: "fries", qty: 2, options: { size: ["medium"] } })).toBe("2 medium french fries");
  });

  it("summarizes add_item with the total and the popup", async () => {
    const t = setup();
    const reply = await t.tool("add_item", { itemId: "cheeseburger", qty: 1, options: { size: ["large"], remove: ["no_onions"] } });
    expect(reply).toBe(
      'Added 1 large cheeseburger, no onions. Cart total eight eighty with tax. A popup is showing: ' +
        '"Make it a combo with medium fries and a drink for $2.00 more?" Buttons: popup-yes ("Yes, make it a combo (+$2.00)"), ' +
        'popup-no ("No thanks"). Ask the customer before answering it.',
    );
  });
});
