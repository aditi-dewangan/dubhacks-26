// Turns high-level commands from the assistant into visible taps on the kiosk.
// Every step clicks the real button, so the screen always matches the store.
// Errors are written for the AI to read and explain to the customer.

import type { CommandResult } from "@kiosk-access/sdk";
import type { KioskCommand, MenuItem } from "@kiosk-access/shared";
import { access, kioskId } from "./connection.ts";
import { hideFingerSoon } from "./finger.tsx";
import { getItem, ids, type Options } from "./model.ts";
import { toKioskState, useKiosk } from "./store.ts";
import { KioskError, tap } from "./taps.ts";

let sessionActive = false;
access.onSession((s) => { sessionActive = s.active; });

export function currentState() {
  return toKioskState(useKiosk.getState(), kioskId, sessionActive);
}

export async function runCommand(command: KioskCommand): Promise<CommandResult> {
  try {
    await execute(command);
    return { ok: true, state: currentState() };
  } catch (err) {
    const error = err instanceof KioskError ? err.message : `Kiosk error: ${String(err)}`;
    if (!(err instanceof KioskError)) console.error(err);
    return { ok: false, error, state: currentState() };
  } finally {
    hideFingerSoon();
  }
}

async function execute(command: KioskCommand) {
  const s = useKiosk.getState();
  const popupButtons = s.popup?.buttons.map((b) => b.id) ?? [];

  if (s.popup && !(command.type === "press" && popupButtons.includes(command.buttonId))) {
    throw new KioskError(
      `A popup is showing: "${s.popup.text}" Answer it first by pressing one of: ${popupButtons.join(", ")}.`,
    );
  }
  if ((s.screen === "paying" || s.screen === "complete") && command.type !== "press") {
    throw new KioskError(
      s.screen === "paying"
        ? "Payment is in progress, so the order can't change now."
        : `The order is finished (order number ${s.orderNumber}).`,
    );
  }

  switch (command.type) {
    case "add_item": return addItem(command.itemId, command.qty, command.options);
    case "update_item": return updateItem(command.lineId, command.qty, command.options);
    case "remove_item": return removeItem(command.lineId);
    case "press": return press(command.buttonId);
    case "start_payment": return startPayment();
    case "cancel_order": return cancelOrder();
    case "type_text": throw new KioskError("This kiosk has no text fields. Use the menu commands or press.");
    default: throw new KioskError(`Unknown command "${(command as { type: string }).type}".`);
  }
}

// ---------------- navigation ----------------

const screen = () => useKiosk.getState().screen;

async function goToMenu() {
  if (screen() === "welcome") await tap(ids.start);
  if (screen() === "item") await tap(ids.back); // lands on menu, or cart when editing
  if (screen() === "checkout") await tap(ids.backToCart);
  if (screen() === "cart") await tap(ids.addMore);
  if (screen() !== "menu") throw new KioskError("Couldn't get back to the menu.");
}

async function goToCart() {
  if (!useKiosk.getState().lines.length) throw new KioskError("The order is empty.");
  if (screen() === "item") await tap(ids.back);
  if (screen() === "checkout") await tap(ids.backToCart);
  if (screen() === "menu") await tap(ids.cart);
  if (screen() !== "cart") throw new KioskError("Couldn't open the order.");
}

// ---------------- commands ----------------

async function addItem(itemId: string, qty: number, options: Options = {}) {
  const item = getItem(itemId);
  if (!item) throw new KioskError(`There's no menu item "${itemId}".`);
  if (item.hidden) throw new KioskError("A combo is added by answering the combo popup after adding a burger.");
  checkQty(qty);
  validateOptions(item, options, true);

  await goToMenu();
  if (useKiosk.getState().categoryId !== item.categoryId) await tap(ids.category(item.categoryId));
  await tap(ids.item(item.id));
  for (const g of item.optionGroups) {
    for (const choiceId of options[g.id] ?? []) await tap(ids.option(g.id, choiceId));
  }
  for (let i = 1; i < qty; i++) await tap(ids.qtyPlus);
  await tap(ids.add); // may open an upsell popup; we stop there and let the customer decide
}

async function updateItem(lineId: string, qty?: number, options?: Options) {
  const line = useKiosk.getState().lines.find((l) => l.lineId === lineId);
  if (!line) throw new KioskError(`There's no line "${lineId}" in the order. ${linesHint()}`);
  const item = getItem(line.itemId)!;
  if (qty !== undefined) checkQty(qty);
  const merged: Options = { ...line.options, ...(options ?? {}) };
  validateOptions(item, merged, true);

  await goToCart();
  await tap(ids.lineEdit(lineId));
  for (const g of item.optionGroups) {
    if (!options || !(g.id in options)) continue;
    const have = new Set(line.options[g.id] ?? []);
    const want = new Set(options[g.id]);
    if (g.type === "single") {
      const [choice] = want;
      if (choice && !have.has(choice)) await tap(ids.option(g.id, choice));
    } else {
      for (const c of g.choices) if (have.has(c.id) !== want.has(c.id)) await tap(ids.option(g.id, c.id));
    }
  }
  if (qty !== undefined) {
    const diff = qty - line.qty;
    for (let i = 0; i < Math.abs(diff); i++) await tap(diff > 0 ? ids.qtyPlus : ids.qtyMinus);
  }
  await tap(ids.add); // "Save changes"
}

async function removeItem(lineId: string) {
  if (!useKiosk.getState().lines.some((l) => l.lineId === lineId)) {
    throw new KioskError(`There's no line "${lineId}" in the order. ${linesHint()}`);
  }
  await goToCart();
  await tap(ids.lineRemove(lineId));
}

const BLOCKED_PRESSES: Record<string, string> = {
  [ids.pay]: "Payment can only start after the customer confirms the order.",
  [ids.cardTap]: "The customer taps their own card on the reader.",
};

async function press(buttonId: string) {
  if (BLOCKED_PRESSES[buttonId]) throw new KioskError(BLOCKED_PRESSES[buttonId]);
  const state = currentState();
  const available = [...(state.popup?.buttons.map((b) => b.id) ?? []), ...state.buttons.filter((b) => b.enabled).map((b) => b.id)];
  if (!available.includes(buttonId)) {
    throw new KioskError(`There's no "${buttonId}" button on screen. Available: ${available.join(", ") || "none"}.`);
  }
  await tap(buttonId);
}

async function startPayment() {
  if (!useKiosk.getState().lines.length) throw new KioskError("The order is empty, so there's nothing to pay for.");
  if (screen() !== "checkout") {
    await goToCart();
    await tap(ids.checkout);
  }
  await tap(ids.pay);
}

async function cancelOrder() {
  if (screen() === "welcome") return;
  if (screen() === "item") await tap(ids.back);
  if (screen() === "checkout") await tap(ids.backToCart);
  if (!useKiosk.getState().lines.length) {
    useKiosk.getState().cancelOrder(); // nothing to clear on screen
    return;
  }
  await tap(ids.cancel);
}

// ---------------- validation ----------------

function checkQty(qty: number) {
  if (!Number.isInteger(qty) || qty < 1 || qty > 10) throw new KioskError("Quantity must be a whole number from 1 to 10.");
}

function validateOptions(item: MenuItem, options: Options, requireAll: boolean) {
  for (const [groupId, choices] of Object.entries(options)) {
    const g = item.optionGroups.find((x) => x.id === groupId);
    if (!g) {
      const valid = item.optionGroups.map((x) => x.id).join(", ") || "none";
      throw new KioskError(`${item.name} has no "${groupId}" option. Its options are: ${valid}.`);
    }
    if (!Array.isArray(choices)) throw new KioskError(`Options for "${groupId}" must be a list of choice ids.`);
    if (g.type === "single" && choices.length > 1) throw new KioskError(`Pick only one ${g.name.toLowerCase()}.`);
    for (const c of choices) {
      if (!g.choices.some((x) => x.id === c)) {
        throw new KioskError(`"${c}" isn't a ${g.name.toLowerCase()} choice for ${item.name}. Choices: ${g.choices.map((x) => x.id).join(", ")}.`);
      }
    }
  }
  if (requireAll) {
    const missing = item.optionGroups.filter((g) => g.required && !(options[g.id]?.length));
    if (missing.length) {
      const g = missing[0];
      throw new KioskError(`${g.name} is required for ${item.name}: ${g.choices.map((c) => c.id).join(" or ")}.`);
    }
  }
}

function linesHint() {
  const lines = currentState().cart.lines;
  return lines.length ? `Lines: ${lines.map((l) => `${l.lineId} (${l.name})`).join(", ")}.` : "The order is empty.";
}
