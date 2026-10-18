import { describe, expect, it } from "vitest";
import { menu } from "@kiosk-access/shared";
import { setup } from "./harness.ts";
import { describeLine, spokenMoney } from "./spoken.ts";
import { resolveOrderableItem, validateOptions } from "./validate.ts";

const boxCombo = menu.items.find((i) => i.id === "box_combo")!;

describe("validation before anything reaches the kiosk", () => {
  it("rejects an unknown item with the closest suggestion", async () => {
    const t = setup();
    expect(await t.tool("add_item", { itemId: "bocks combo", qty: 1, options: {} }))
      .toBe('No item "bocks combo". Closest: the box combo.');
    expect(await t.tool("add_item", { itemId: "oat milk latte", qty: 1 })).toBe('No item "oat milk latte" on this menu.');
    expect(t.sent).toHaveLength(0);
  });

  it("asks for a missing required option", async () => {
    const t = setup();
    expect(await t.tool("add_item", { itemId: "box_combo", qty: 1, options: {} })).toBe("Drink is required: lemonade, sweet tea, unsweet tea or cola.");
    expect(await t.tool("add_item", { itemId: "fountain_drink", qty: 1 }))
      .toBe("Flavor is required: cola, diet cola, lemon-lime or root beer. Size is required: regular or large.");
    expect(t.sent).toHaveLength(0);
  });

  it("rejects a hidden item (only the upsell popup adds it)", async () => {
    const t = setup();
    const reply = await t.tool("add_item", { itemId: "combo_upgrade", qty: 1, options: { drink: ["cola"] } });
    expect(reply).toBe("The combo upgrade (fries + drink) can't be ordered directly. It's offered in a popup after adding a chicken sandwich or chicken finger.");
    expect(await t.tool("add_item", { itemId: "upgrade", qty: 1 })).toMatch(/can't be ordered directly/);
    expect(t.sent).toHaveLength(0);
  });

  it("rejects choices that aren't real, and extra groups", async () => {
    const t = setup();
    expect(await t.tool("add_item", { itemId: "box_combo", options: { drink: ["milkshake"] } }))
      .toBe('"milkshake" isn\'t a drink choice for the box combo. Choices: lemonade, sweet tea, unsweet tea or cola.');
    expect(await t.tool("add_item", { itemId: "box_combo", options: { drink: ["lemonade", "cola"] } }))
      .toBe("Pick one drink: lemonade, sweet tea, unsweet tea or cola.");
    expect(await t.tool("add_item", { itemId: "box_combo", options: { drink: ["lemonade"], spice: ["hot"] } }))
      .toBe('The box combo has no "spice" option. Its options are: drink and remove.');
    expect(await t.tool("add_item", { itemId: "fries", qty: 11 }))
      .toBe("Quantity must be a whole number from 1 to 10.");
    expect(t.sent).toHaveLength(0);
  });

  it("resolves aliases: coke, the box, tenders, and combo as a category", async () => {
    expect(resolveOrderableItem("coke")).toMatchObject({ ok: true, value: { item: { id: "fountain_drink" }, presetOptions: { flavor: ["cola"] } } });
    expect(resolveOrderableItem("the box")).toMatchObject({ ok: true, value: { item: { id: "box_combo" } } });
    expect(resolveOrderableItem("tenders")).toMatchObject({ ok: true, value: { item: { id: "chicken_finger" } } });
    expect(resolveOrderableItem("combo")).toEqual({
      ok: false,
      error: '"combo" could be any of these: the box combo, 3 finger combo, the caniac combo or sandwich combo. Which one?',
    });

    const t = setup();
    expect(await t.tool("add_item", { itemId: "coke", qty: 1 })).toBe("Size is required: regular or large.");
    expect(await t.tool("add_item", { itemId: "coke", qty: 2, options: { size: ["regular"] } }))
      .toBe("Added 2 regular fountain drinks, cola. Cart total four eighty-two with tax.");
    expect(t.sent.map((e) => e.command)).toEqual([
      { type: "add_item", itemId: "fountain_drink", qty: 2, options: { flavor: ["cola"], size: ["regular"] } },
    ]);
  });

  it("accepts names for groups and choices, and fixes small typos", () => {
    expect(validateOptions(boxCombo, { Drink: "Lemonade", remove: ["coleslaw", "no toast"] }, true))
      .toEqual({ ok: true, value: { drink: ["lemonade"], remove: ["no_coleslaw", "no_toast"] } });
    expect(resolveOrderableItem("lemonaid")).toMatchObject({ ok: true, value: { item: { id: "lemonade" } } });
  });

  it("only presses buttons that are on the popup", async () => {
    const t = setup();
    expect(await t.tool("respond_to_popup", { buttonId: "popup-yes" })).toBe("There's no popup showing right now.");
    await t.tool("add_item", { itemId: "chicken_sandwich" });
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
    expect(describeLine({ itemId: "box_combo", qty: 1, options: { drink: ["lemonade"], remove: ["no_coleslaw"] } }))
      .toBe("1 box combo, lemonade, no coleslaw");
    expect(describeLine({ itemId: "lemonade", qty: 2, options: { size: ["large"] } })).toBe("2 large fresh lemonades");
  });

  it("summarizes add_item with the total and the popup", async () => {
    const t = setup();
    const reply = await t.tool("add_item", { itemId: "chicken_sandwich", qty: 1, options: { remove: ["no_lettuce"] } });
    expect(reply).toBe(
      'Added 1 chicken sandwich, no lettuce. Cart total eight twenty-five with tax. A popup is showing: ' +
        '"Make it a combo with crinkle-cut fries and a drink for $3.50 more?" Buttons: popup-yes ("Yes, make it a combo (+$3.50)"), ' +
        'popup-no ("No thanks"). Ask the customer before answering it.',
    );
  });
});
