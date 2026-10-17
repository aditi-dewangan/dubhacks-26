// The kiosk's single source of truth. Every screen renders from this store, every
// button calls one of these actions, and toKioskState() turns it into the shared
// KioskState the phone and agent see.

import { create } from "zustand";
import { menu, type KioskButton, type KioskPopup, type KioskState, type Screen } from "@kiosk-access/shared";
import {
  describeOptions,
  deltaLabel,
  getItem,
  ids,
  missingRequired,
  money,
  round2,
  unitPrice,
  visibleItems,
  type Options,
} from "./model.ts";

export interface Line {
  lineId: string;
  itemId: string;
  qty: number;
  options: Options;
  /** A combo upgrade belongs to the burger it was added for. */
  parentLineId?: string;
}

export interface Draft {
  itemId: string;
  qty: number;
  options: Options;
  editingLineId?: string;
}

export type PopupKind = "upsell" | "combo-drink" | "still-there";
export interface PopupState extends KioskPopup {
  kind: PopupKind;
  forLineId?: string;
}

export interface KioskModel {
  screen: Screen;
  categoryId: string;
  draft: Draft | null;
  lines: Line[];
  popup: PopupState | null;
  orderNumber?: string;
  processingPayment: boolean;
  nextLineNumber: number;
}

interface Actions {
  start(): void;
  selectCategory(categoryId: string): void;
  openItem(itemId: string): void;
  toggleChoice(groupId: string, choiceId: string): void;
  changeQty(delta: number): void;
  backFromItem(): void;
  saveDraft(): void;
  answerPopup(buttonId: string): void;
  showStillThere(seconds: number): void;
  openCart(): void;
  addMore(): void;
  editLine(lineId: string): void;
  removeLine(lineId: string): void;
  goToCheckout(): void;
  backToCart(): void;
  pay(): void;
  cardTapped(): void;
  finish(): void;
  cancelOrder(): void;
}

const firstCategory = menu.categories[0].id;
const COMBO_ITEM = "combo_upgrade";
let orderCounter = 140;

const initial: KioskModel = {
  screen: "welcome",
  categoryId: firstCategory,
  draft: null,
  lines: [],
  popup: null,
  processingPayment: false,
  nextLineNumber: 1,
};

export const useKiosk = create<KioskModel & Actions>()((set, get) => ({
  ...initial,

  start: () => set({ screen: "menu", categoryId: firstCategory }),

  selectCategory: (categoryId) => set({ categoryId }),

  openItem: (itemId) => set({ screen: "item", draft: { itemId, qty: 1, options: {} } }),

  toggleChoice: (groupId, choiceId) => {
    const { draft } = get();
    const item = draft && getItem(draft.itemId);
    const group = item?.optionGroups.find((g) => g.id === groupId);
    if (!draft || !group) return;
    const current = draft.options[groupId] ?? [];
    let next: string[];
    if (group.type === "single") next = [choiceId];
    else next = current.includes(choiceId) ? current.filter((c) => c !== choiceId) : [...current, choiceId];
    set({ draft: { ...draft, options: { ...draft.options, [groupId]: next } } });
  },

  changeQty: (delta) => {
    const { draft } = get();
    if (!draft) return;
    set({ draft: { ...draft, qty: Math.min(10, Math.max(1, draft.qty + delta)) } });
  },

  backFromItem: () => {
    const { draft } = get();
    set({ screen: draft?.editingLineId ? "cart" : "menu", draft: null });
  },

  saveDraft: () => {
    const { draft, lines, nextLineNumber } = get();
    const item = draft && getItem(draft.itemId);
    if (!draft || !item || missingRequired(item, draft.options).length) return;

    const options = cleanOptions(draft.options);
    if (draft.editingLineId) {
      set({
        lines: lines.map((l) => (l.lineId === draft.editingLineId ? { ...l, qty: draft.qty, options } : l)),
        screen: "cart",
        draft: null,
      });
      return;
    }

    const lineId = `L${nextLineNumber}`;
    const line: Line = { lineId, itemId: item.id, qty: draft.qty, options };
    const popup: PopupState | null = item.upsell
      ? {
          kind: "upsell",
          id: "popup-upsell",
          text: item.upsell.text,
          forLineId: lineId,
          buttons: [
            { id: ids.popupYes, label: `Yes, make it a combo (${deltaLabel(item.upsell.priceDelta)})` },
            { id: ids.popupNo, label: "No thanks" },
          ],
        }
      : null;
    set({ lines: [...lines, line], nextLineNumber: nextLineNumber + 1, screen: "menu", draft: null, popup });
  },

  answerPopup: (buttonId) => {
    const { popup, lines, nextLineNumber } = get();
    if (!popup) return;

    if (popup.kind === "upsell") {
      if (buttonId !== ids.popupYes) return set({ popup: null });
      const combo = getItem(COMBO_ITEM)!;
      const drinkGroup = combo.optionGroups.find((g) => g.id === "drink")!;
      set({
        popup: {
          kind: "combo-drink",
          id: "popup-combo-drink",
          text: "Which drink would you like with your combo?",
          forLineId: popup.forLineId,
          buttons: [
            ...drinkGroup.choices.map((c) => ({ id: ids.popupDrink(c.id), label: c.name })),
            { id: ids.popupNo, label: "Never mind, no combo" },
          ],
        },
      });
      return;
    }

    if (popup.kind === "combo-drink") {
      const prefix = ids.popupDrink("");
      if (!buttonId.startsWith(prefix)) return set({ popup: null });
      const drink = buttonId.slice(prefix.length);
      const parent = lines.find((l) => l.lineId === popup.forLineId);
      const comboLine: Line = {
        lineId: `L${nextLineNumber}`,
        itemId: COMBO_ITEM,
        qty: parent?.qty ?? 1,
        options: { drink: [drink] },
        parentLineId: popup.forLineId,
      };
      set({ lines: [...lines, comboLine], nextLineNumber: nextLineNumber + 1, popup: null });
      return;
    }

    if (popup.kind === "still-there") set({ popup: null });
  },

  showStillThere: (seconds) =>
    set({
      popup: {
        kind: "still-there",
        id: "popup-still-there",
        text: `Still there? Your order will reset in ${seconds} seconds.`,
        buttons: [{ id: ids.stillHere, label: "I'm still here" }],
      },
    }),

  openCart: () => {
    if (get().lines.length) set({ screen: "cart" });
  },

  addMore: () => set({ screen: "menu" }),

  editLine: (lineId) => {
    const line = get().lines.find((l) => l.lineId === lineId);
    if (!line) return;
    set({
      screen: "item",
      draft: { itemId: line.itemId, qty: line.qty, options: structuredClone(line.options), editingLineId: lineId },
    });
  },

  removeLine: (lineId) => {
    const lines = get().lines.filter((l) => l.lineId !== lineId && l.parentLineId !== lineId);
    set({ lines, screen: lines.length ? get().screen : "menu" });
  },

  goToCheckout: () => {
    if (get().lines.length) set({ screen: "checkout" });
  },

  backToCart: () => set({ screen: "cart" }),

  pay: () => {
    if (get().lines.length) set({ screen: "paying", processingPayment: false });
  },

  cardTapped: () => {
    if (get().screen !== "paying" || get().processingPayment) return;
    set({ processingPayment: true });
    setTimeout(() => {
      if (get().screen === "paying") {
        set({ screen: "complete", processingPayment: false, orderNumber: String(++orderCounter) });
      }
    }, 1600);
  },

  finish: () => set({ ...initial }),

  cancelOrder: () => set({ ...initial }),
}));

function cleanOptions(options: Options): Options {
  const out: Options = {};
  for (const [k, v] of Object.entries(options)) if (v.length) out[k] = [...v];
  return out;
}

// ---------------- derived values ----------------

export function cartTotals(lines: Line[]) {
  const cartLines = lines.map((l) => {
    const item = getItem(l.itemId)!;
    return {
      lineId: l.lineId,
      itemId: l.itemId,
      name: item.name,
      qty: l.qty,
      options: l.options,
      lineTotal: round2(unitPrice(item, l.options) * l.qty),
      parentLineId: l.parentLineId,
      detail: describeOptions(item, l.options),
    };
  });
  const subtotal = round2(cartLines.reduce((s, l) => s + l.lineTotal, 0));
  const tax = round2(subtotal * menu.taxRate);
  return { lines: cartLines, subtotal, tax, total: round2(subtotal + tax) };
}

const TITLES: Record<Screen, string> = {
  welcome: "Welcome to Harbor Burger",
  menu: "Menu",
  item: "Item",
  cart: "Your order",
  checkout: "Review and pay",
  paying: "Tap, insert or swipe your card",
  complete: "Thank you",
};

/** What the phone and the agent see. Button ids match the DOM's data-kiosk-id. */
export function toKioskState(m: KioskModel, kioskId: string, sessionActive: boolean): KioskState {
  const totals = cartTotals(m.lines);
  const cart = {
    lines: totals.lines.map(({ lineId, itemId, name, qty, options, lineTotal }) => ({
      lineId, itemId, name, qty, options, lineTotal,
    })),
    subtotal: totals.subtotal,
    tax: totals.tax,
    total: totals.total,
  };
  const buttons: KioskButton[] = [];
  const btn = (id: string, label: string, enabled = true) => buttons.push({ id, label, enabled });
  let title = TITLES[m.screen];

  switch (m.screen) {
    case "welcome":
      btn(ids.start, "Start order");
      break;
    case "menu": {
      const cat = menu.categories.find((c) => c.id === m.categoryId);
      title = cat?.name ?? title;
      for (const c of menu.categories) btn(ids.category(c.id), c.name);
      for (const i of visibleItems(m.categoryId)) btn(ids.item(i.id), `${i.name} ${money(i.price)}`);
      btn(ids.cart, `View order (${m.lines.length}) ${money(totals.total)}`, m.lines.length > 0);
      btn(ids.cancel, "Start over", m.lines.length > 0);
      break;
    }
    case "item": {
      const item = m.draft && getItem(m.draft.itemId);
      if (!item || !m.draft) break;
      title = item.name;
      btn(ids.back, "Back");
      for (const g of item.optionGroups) {
        for (const c of g.choices) {
          const selected = (m.draft.options[g.id] ?? []).includes(c.id);
          btn(ids.option(g.id, c.id), `${g.name}: ${c.name}${c.priceDelta ? ` ${deltaLabel(c.priceDelta)}` : ""}${selected ? " (selected)" : ""}`);
        }
      }
      btn(ids.qtyMinus, "Fewer", m.draft.qty > 1);
      btn(ids.qtyPlus, "More", m.draft.qty < 10);
      const ready = missingRequired(item, m.draft.options).length === 0;
      const total = money(unitPrice(item, m.draft.options) * m.draft.qty);
      btn(ids.add, m.draft.editingLineId ? `Save changes ${total}` : `Add to order ${total}`, ready);
      break;
    }
    case "cart":
      for (const l of totals.lines) {
        btn(ids.lineEdit(l.lineId), `Edit ${l.name}`);
        btn(ids.lineRemove(l.lineId), `Remove ${l.name}`);
      }
      btn(ids.addMore, "Add more items");
      btn(ids.checkout, `Checkout ${money(totals.total)}`, m.lines.length > 0);
      btn(ids.cancel, "Start over");
      break;
    case "checkout":
      btn(ids.backToCart, "Back to order");
      btn(ids.pay, `Pay ${money(totals.total)}`);
      break;
    case "paying":
      btn(ids.cardTap, "Card reader", !m.processingPayment);
      if (m.processingPayment) title = "Processing payment";
      break;
    case "complete":
      btn(ids.done, "Done");
      title = `Order ${m.orderNumber}`;
      break;
  }

  const popup = m.popup ? { id: m.popup.id, text: m.popup.text, buttons: m.popup.buttons } : undefined;
  return { kioskId, screen: m.screen, title, buttons, popup, cart, orderNumber: m.orderNumber, sessionActive };
}
