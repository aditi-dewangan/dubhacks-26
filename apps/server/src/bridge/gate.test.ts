import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isAffirmative, isChangeRequest, sameCart } from "./gate.ts";
import { setup } from "./harness.ts";

const toast = { itemId: "texas_toast", qty: 2, options: {} };

async function readyToPay() {
  const t = setup();
  await t.tool("add_item", toast);
  const readBack = await t.tool("request_checkout");
  expect(readBack).toBe(
    "Read this back: 2 texas toasts, two fifty-eight. Total with tax two eighty-four. " +
      "Then ask the customer to confirm by pressing Confirm or saying yes. Payment has not started. You cannot start it.",
  );
  expect(t.bridge.isAwaitingConfirmation("s1")).toBe(true);
  expect(t.session.pendingCheckout?.lines.map((l) => l.itemId)).toEqual(["texas_toast"]);
  return t;
}

describe("payment gate", () => {
  it("sends start_payment after request_checkout and the confirm", async () => {
    const t = await readyToPay();
    await t.bridge.handleConfirm("s1", true);
    expect(t.startPayments()).toBe(1);
    expect(t.messages.at(-1)).toEqual({
      text: "Payment started. Please tap your card on the reader below the screen. The total is two eighty-four.",
      awaitingConfirmation: false,
    });
    expect(t.bridge.isAwaitingConfirmation("s1")).toBe(false);
    await t.bridge.handleConfirm("s1", true); // a second confirm can't pay twice
    expect(t.startPayments()).toBe(1);
  });

  it("makes start_payment impossible without a confirm", async () => {
    const t = setup();
    await t.tool("add_item", toast);
    // Everything the agent can do, including things it shouldn't try.
    for (const [name, input] of [
      ["request_checkout", {}],
      ["get_kiosk_state", {}],
      ["get_menu", {}],
      ["respond_to_popup", { buttonId: "btn-pay" }],
      ["add_item", { itemId: "start_payment" }],
      ["update_item", { lineId: "L1", qty: 3 }],
      ["start_payment", {}],
      ["press", { buttonId: "btn-pay" }],
      ["request_checkout", {}],
    ] as const) {
      await t.tool(name, input);
    }
    expect(t.startPayments()).toBe(0);
    expect(await t.tool("start_payment")).toMatch(/^Unknown tool "start_payment"/);

    const t2 = setup(); // a confirm with no checkout requested
    await t2.tool("add_item", toast);
    await t2.bridge.handleConfirm("s1", true);
    expect(t2.startPayments()).toBe(0);
    expect(t2.messages.at(-1)?.text).toMatch(/no order waiting to be confirmed/);
  });

  it("rejects a stale checkoutId", async () => {
    const t = await readyToPay();
    const reply = await t.bridge.confirmCheckout("s1", "id-from-an-older-checkout");
    expect(reply.text).toMatch(/earlier version of your order/);
    expect(t.startPayments()).toBe(0);
    expect(t.bridge.isAwaitingConfirmation("s1")).toBe(false);
    await t.bridge.handleConfirm("s1", true);
    expect(t.startPayments()).toBe(0);
  });

  it("cancels the gate when the agent changes the cart after request_checkout", async () => {
    const t = await readyToPay();
    await t.tool("update_item", { lineId: "L1", qty: 3 });
    expect(t.bridge.isAwaitingConfirmation("s1")).toBe(false);
    expect(t.session.pendingCheckout).toBeNull();
    await t.bridge.handleConfirm("s1", true);
    expect(t.startPayments()).toBe(0);
  });

  it("cancels the gate when the kiosk's cart changes on its own", async () => {
    const t = await readyToPay();
    t.kiosk.run({ type: "add_item", itemId: "coleslaw", qty: 1, options: {} }); // e.g. a touch on the kiosk
    t.publish();
    expect(t.bridge.isAwaitingConfirmation("s1")).toBe(false);
    await t.bridge.handleConfirm("s1", true);
    expect(t.startPayments()).toBe(0);
  });

  it("refuses to pay if the cart differs from the snapshot, even without a state event", async () => {
    const t = await readyToPay();
    t.kiosk.run({ type: "update_item", lineId: "L1", qty: 5 });
    t.setStateSilently(t.kiosk.state());
    await t.bridge.handleConfirm("s1", true);
    expect(t.startPayments()).toBe(0);
    expect(t.messages.at(-1)?.text).toMatch(/^Your order changed since I read it back/);
  });

  it("clears the gate on cancel_order, decline, and end of session", async () => {
    const a = await readyToPay();
    await a.tool("cancel_order");
    expect(a.bridge.isAwaitingConfirmation("s1")).toBe(false);

    const b = await readyToPay();
    await b.bridge.handleConfirm("s1", false);
    expect(b.bridge.isAwaitingConfirmation("s1")).toBe(false);
    await b.bridge.handleConfirm("s1", true);
    expect(b.startPayments()).toBe(0);

    for (const reason of ["staff_ended", "user_ended"] as const) {
      const c = await readyToPay();
      c.endSession(reason); // kiosk:end-session or user:end-session
      expect(c.bridge.isAwaitingConfirmation("s1")).toBe(false);
      expect(await c.bridge.confirmCheckout("s1", "id1")).toMatchObject({ text: "This session has ended." });
      expect(c.startPayments()).toBe(0);
    }
  });

  it("compares carts line by line, ignoring prices and option order", () => {
    const line = { lineId: "L1", itemId: "box_combo", name: "The Box Combo", qty: 1, options: { remove: ["no_toast", "no_coleslaw"], drink: ["lemonade"] }, lineTotal: 7.99 };
    const cart = { lines: [line], subtotal: 7.99, tax: 0.81, total: 8.8 };
    const sameButFloaty = { lines: [{ ...line, options: { drink: ["lemonade"], remove: ["no_coleslaw", "no_toast"] }, lineTotal: 7.990000001 }], subtotal: 7.99, tax: 0.8069, total: 8.799999 };
    expect(sameCart(cart, sameButFloaty)).toBe(true);
    expect(sameCart(cart, { ...cart, lines: [{ ...line, qty: 2 }] })).toBe(false);
    expect(sameCart(cart, { ...cart, lines: [{ ...line, options: { drink: ["cola"] } }] })).toBe(false);
    expect(sameCart(cart, { ...cart, lines: [line, line] })).toBe(false);
  });
});

describe('"yes" check', () => {
  it.each(["yes", "Yes please.", "confirm", "yeah", "Yep!", "correct", "that's right", "That’s right.", "yes, please", "  YES  ",
    "I confirm", "i confirm.", "Yes, I confirm", "confirm my order", "Confirm the check-in", "complete check-in",
    "Complete my checkin.", "check me in", "place my order", "confirm tickets"])(
    "%j confirms",
    (text) => expect(isAffirmative(text)).toBe(true),
  );

  it.each(["yes but make it large", "Yes, but make it large", "yeah no", "yes add fries", "no", "yes?", "yesterday", "confirm and add fries", ""])(
    "%j does not confirm",
    (text) => expect(isAffirmative(text)).toBe(false),
  );

  it.each(["change", "Change order", "change my order", "no", "I want to change something", "go back", "edit order"])(
    "%j asks to change",
    (text) => expect(isChangeRequest(text)).toBe(true),
  );

  it.each(["there's a change in my address", "change the drink to lemonade", "yes", "no fries", "confirm"])(
    "%j is not a plain change request",
    (text) => expect(isChangeRequest(text)).toBe(false),
  );

  it("saying change does what the Change button does: nothing submitted, gate closed", async () => {
    const t = await readyToPay();
    const reply = await t.bridge.interceptUserMessage("s1", "change order");
    expect(reply?.text).toMatch(/nothing has been submitted/);
    expect(reply?.awaitingConfirmation).toBe(false);
    expect(t.bridge.isAwaitingConfirmation("s1")).toBe(false);
    expect(t.startPayments()).toBe(0);
  });

  it("saying I confirm pays, like the Confirm button", async () => {
    const t = await readyToPay();
    await t.bridge.interceptUserMessage("s1", "I confirm");
    expect(t.startPayments()).toBe(1);
  });

  it("a plain yes pays; anything else clears the gate and goes to the agent", async () => {
    const t = await readyToPay();
    expect(await t.bridge.interceptUserMessage("s1", "yes but make it large")).toBeNull();
    expect(t.bridge.isAwaitingConfirmation("s1")).toBe(false);
    expect(await t.bridge.interceptUserMessage("s1", "yes")).toBeNull(); // the gate is closed now
    expect(t.startPayments()).toBe(0);

    await t.tool("request_checkout");
    const reply = await t.bridge.interceptUserMessage("s1", "Yes please.");
    expect(reply?.text).toMatch(/^Payment started/);
    expect(t.startPayments()).toBe(1);
  });

  it("does nothing when no checkout is pending", async () => {
    const t = setup();
    expect(await t.bridge.interceptUserMessage("s1", "yes")).toBeNull();
    expect(t.sent).toHaveLength(0);
  });
});

describe("start_payment has exactly one sender", () => {
  const src = join(fileURLToPath(new URL(".", import.meta.url)), "..");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") && !p.endsWith(".test.ts") ? [p] : [];
    });

  it("only commands.ts builds start_payment or a btn-submit press, and only confirmCheckout calls it", () => {
    const builders: string[] = [];
    const callers: string[] = [];
    for (const f of files(src)) {
      const code = readFileSync(f, "utf8");
      if (/type:\s*["']start_payment["']|buttonId:\s*["']btn-submit["']/.test(code)) builders.push(relative(src, f));
      for (const _ of code.matchAll(/sendFinalAction\(/g)) callers.push(relative(src, f));
    }
    expect(builders).toEqual(["bridge/commands.ts"]);
    expect(callers.sort()).toEqual(["bridge/bridge.ts", "bridge/commands.ts"]); // the call, and the definition
  });
});
