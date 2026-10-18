// An in-memory kiosk that behaves like apps/kiosk at the level of commands and acks:
// same button ids, same popups (upsell, then combo drink), same refusals. No DOM, no
// animation, no sockets, so the Bridge tests can use it directly and the fake-kiosk
// script can put it behind the SDK.

import { menu, type CommandAck, type KioskCommand, type KioskState, type MenuItem, type Screen } from "@kiosk-access/shared";

type Options = Record<string, string[]>;

interface Line {
  lineId: string;
  itemId: string;
  qty: number;
  options: Options;
  parentLineId?: string;
}

interface Popup {
  kind: "upsell" | "combo-drink";
  id: string;
  text: string;
  buttons: { id: string; label: string }[];
  forLineId: string;
}

export type CommandResult = Omit<CommandAck, "cmdId">;

const COMBO_ITEM = "combo_upgrade";
const itemsById = new Map(menu.items.map((i) => [i.id, i]));
const round2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => `$${n.toFixed(2)}`;

class KioskError extends Error {}

export class FakeKiosk {
  screen: Screen = "welcome";
  categoryId = menu.categories[0].id;
  lines: Line[] = [];
  popup: Popup | null = null;
  orderNumber?: string;
  sessionActive = false;
  private nextLine = 1;
  private orderCounter = 140;

  constructor(readonly kioskId = "store42-kiosk1") {}

  run(command: KioskCommand): CommandResult {
    try {
      this.execute(command);
      return { ok: true, state: this.state() };
    } catch (err) {
      if (!(err instanceof KioskError)) throw err;
      return { ok: false, error: err.message, state: this.state() };
    }
  }

  /** The customer taps their card on the reader. */
  tapCard() {
    if (this.screen !== "paying") return;
    this.screen = "complete";
    this.orderNumber = String(++this.orderCounter);
  }

  reset() {
    this.screen = "welcome";
    this.lines = [];
    this.popup = null;
    this.orderNumber = undefined;
  }

  state(): KioskState {
    const cart = this.cart();
    const buttons: KioskState["buttons"] = [];
    const btn = (id: string, label: string, enabled = true) => buttons.push({ id, label, enabled });
    let title = "Menu";
    switch (this.screen) {
      case "welcome":
        title = "Welcome to Raising Cane's";
        btn("btn-start", "Start order");
        break;
      case "menu":
        title = menu.categories.find((c) => c.id === this.categoryId)?.name ?? title;
        for (const c of menu.categories) btn(`cat-${c.id}`, c.name);
        for (const i of menu.items.filter((i) => i.categoryId === this.categoryId && !i.hidden)) {
          btn(`item-${i.id}`, `${i.name} ${money(i.price)}`);
        }
        btn("btn-cart", `View order (${this.lines.length}) ${money(cart.total)}`, this.lines.length > 0);
        btn("btn-cancel", "Start over", this.lines.length > 0);
        break;
      case "cart":
        title = "Your order";
        for (const l of cart.lines) {
          btn(`line-edit-${l.lineId}`, `Edit ${l.name}`);
          btn(`line-remove-${l.lineId}`, `Remove ${l.name}`);
        }
        btn("btn-add-more", "Add more items");
        btn("btn-checkout", `Checkout ${money(cart.total)}`, this.lines.length > 0);
        btn("btn-cancel", "Start over");
        break;
      case "checkout":
        title = "Review and pay";
        btn("btn-back-cart", "Back to order");
        btn("btn-pay", `Pay ${money(cart.total)}`);
        break;
      case "paying":
        title = "Tap, insert or swipe your card";
        btn("btn-card-tap", "Card reader");
        break;
      case "complete":
        title = `Order ${this.orderNumber}`;
        btn("btn-done", "Done");
        break;
      case "item":
        title = "Item";
        break;
    }
    const popup = this.popup ? { id: this.popup.id, text: this.popup.text, buttons: this.popup.buttons } : undefined;
    return {
      kioskId: this.kioskId,
      screen: this.screen,
      title,
      buttons,
      ...(popup ? { popup } : {}),
      cart,
      ...(this.orderNumber ? { orderNumber: this.orderNumber } : {}),
      sessionActive: this.sessionActive,
    };
  }

  private cart(): KioskState["cart"] {
    const lines = this.lines.map((l) => {
      const item = itemsById.get(l.itemId)!;
      return {
        lineId: l.lineId,
        itemId: l.itemId,
        name: item.name,
        qty: l.qty,
        options: l.options,
        lineTotal: round2(unitPrice(item, l.options) * l.qty),
      };
    });
    const subtotal = round2(lines.reduce((s, l) => s + l.lineTotal, 0));
    const tax = round2(subtotal * menu.taxRate);
    return { lines, subtotal, tax, total: round2(subtotal + tax) };
  }

  private execute(command: KioskCommand) {
    const popupButtons = this.popup?.buttons.map((b) => b.id) ?? [];
    if (this.popup && !(command.type === "press" && popupButtons.includes(command.buttonId))) {
      throw new KioskError(
        `A popup is showing: "${this.popup.text}" Answer it first by pressing one of: ${popupButtons.join(", ")}.`,
      );
    }
    if ((this.screen === "paying" || this.screen === "complete") && command.type !== "press") {
      throw new KioskError(
        this.screen === "paying"
          ? "Payment is in progress, so the order can't change now."
          : `The order is finished (order number ${this.orderNumber}).`,
      );
    }
    switch (command.type) {
      case "add_item": return this.addItem(command.itemId, command.qty, command.options);
      case "update_item": return this.updateItem(command.lineId, command.qty, command.options);
      case "remove_item": return this.removeItem(command.lineId);
      case "press": return this.press(command.buttonId);
      case "start_payment": return this.startPayment();
      case "cancel_order": return this.reset();
      default: throw new KioskError(`Unknown command "${(command as { type: string }).type}".`);
    }
  }

  private addItem(itemId: string, qty: number, options: Options = {}) {
    const item = itemsById.get(itemId);
    if (!item) throw new KioskError(`There's no menu item "${itemId}".`);
    if (item.hidden) throw new KioskError("A combo is added by answering the combo popup after adding a chicken sandwich or chicken finger.");
    checkQty(qty);
    validateOptions(item, options, true);

    const lineId = `L${this.nextLine++}`;
    this.lines.push({ lineId, itemId, qty, options: clean(options) });
    this.screen = "menu";
    this.categoryId = item.categoryId;
    if (item.upsell) {
      this.popup = {
        kind: "upsell",
        id: "popup-upsell",
        text: item.upsell.text,
        forLineId: lineId,
        buttons: [
          { id: "popup-yes", label: `Yes, make it a combo (+${money(item.upsell.priceDelta)})` },
          { id: "popup-no", label: "No thanks" },
        ],
      };
    }
  }

  private updateItem(lineId: string, qty?: number, options?: Options) {
    const line = this.lines.find((l) => l.lineId === lineId);
    if (!line) throw new KioskError(`There's no line "${lineId}" in the order. ${this.linesHint()}`);
    const item = itemsById.get(line.itemId)!;
    if (qty !== undefined) checkQty(qty);
    const merged = { ...line.options, ...(options ?? {}) };
    validateOptions(item, merged, true);
    line.options = clean(merged);
    if (qty !== undefined) line.qty = qty;
    this.screen = "cart";
  }

  private removeItem(lineId: string) {
    if (!this.lines.some((l) => l.lineId === lineId)) {
      throw new KioskError(`There's no line "${lineId}" in the order. ${this.linesHint()}`);
    }
    this.lines = this.lines.filter((l) => l.lineId !== lineId && l.parentLineId !== lineId);
    this.screen = this.lines.length ? "cart" : "menu";
  }

  private press(buttonId: string) {
    if (buttonId === "btn-pay") throw new KioskError("Payment can only start after the customer confirms the order.");
    if (buttonId === "btn-card-tap") throw new KioskError("The customer taps their own card on the reader.");

    const popup = this.popup;
    if (popup) {
      if (popup.kind === "upsell") {
        if (buttonId !== "popup-yes") {
          this.popup = null;
          return;
        }
        const drinks = itemsById.get(COMBO_ITEM)!.optionGroups.find((g) => g.id === "drink")!;
        this.popup = {
          kind: "combo-drink",
          id: "popup-combo-drink",
          text: "Which drink would you like with your combo?",
          forLineId: popup.forLineId,
          buttons: [
            ...drinks.choices.map((c) => ({ id: `popup-drink-${c.id}`, label: c.name })),
            { id: "popup-no", label: "Never mind, no combo" },
          ],
        };
        return;
      }
      this.popup = null;
      if (!buttonId.startsWith("popup-drink-")) return;
      const parent = this.lines.find((l) => l.lineId === popup.forLineId);
      this.lines.push({
        lineId: `L${this.nextLine++}`,
        itemId: COMBO_ITEM,
        qty: parent?.qty ?? 1,
        options: { drink: [buttonId.slice("popup-drink-".length)] },
        parentLineId: popup.forLineId,
      });
      return;
    }

    const available = this.state().buttons.filter((b) => b.enabled).map((b) => b.id);
    if (!available.includes(buttonId)) {
      throw new KioskError(`There's no "${buttonId}" button on screen. Available: ${available.join(", ") || "none"}.`);
    }
    if (buttonId === "btn-start" || buttonId === "btn-add-more" || buttonId === "btn-back-cart") {
      this.screen = buttonId === "btn-back-cart" ? "cart" : "menu";
    } else if (buttonId.startsWith("cat-")) this.categoryId = buttonId.slice(4);
    else if (buttonId === "btn-cart") this.screen = "cart";
    else if (buttonId === "btn-checkout") this.screen = "checkout";
    else if (buttonId === "btn-cancel" || buttonId === "btn-done") this.reset();
    else if (buttonId.startsWith("line-remove-")) this.removeItem(buttonId.slice("line-remove-".length));
  }

  private startPayment() {
    if (!this.lines.length) throw new KioskError("The order is empty, so there's nothing to pay for.");
    this.screen = "paying";
  }

  private linesHint() {
    const lines = this.cart().lines;
    return lines.length ? `Lines: ${lines.map((l) => `${l.lineId} (${l.name})`).join(", ")}.` : "The order is empty.";
  }
}

function unitPrice(item: MenuItem, options: Options) {
  let price = item.price;
  for (const g of item.optionGroups) {
    for (const c of options[g.id] ?? []) price += g.choices.find((x) => x.id === c)?.priceDelta ?? 0;
  }
  return round2(price);
}

function clean(options: Options): Options {
  const out: Options = {};
  for (const [k, v] of Object.entries(options)) if (v.length) out[k] = [...v];
  return out;
}

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
    const missing = item.optionGroups.find((g) => g.required && !options[g.id]?.length);
    if (missing) {
      throw new KioskError(`${missing.name} is required for ${item.name}: ${missing.choices.map((c) => c.id).join(" or ")}.`);
    }
  }
}
