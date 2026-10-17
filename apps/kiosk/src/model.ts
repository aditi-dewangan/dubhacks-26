// Menu lookups, prices and button ids. Everything here is pure so the UI, the
// store and the command executor all agree on names and numbers.

import { menu, type MenuItem, type MenuOptionGroup } from "@kiosk-access/shared";

export const ids = {
  start: "btn-start",
  category: (categoryId: string) => `cat-${categoryId}`,
  item: (itemId: string) => `item-${itemId}`,
  option: (groupId: string, choiceId: string) => `opt-${groupId}-${choiceId}`,
  qtyMinus: "qty-minus",
  qtyPlus: "qty-plus",
  add: "btn-add",
  back: "btn-back",
  cart: "btn-cart",
  cancel: "btn-cancel",
  addMore: "btn-add-more",
  lineEdit: (lineId: string) => `line-edit-${lineId}`,
  lineRemove: (lineId: string) => `line-remove-${lineId}`,
  checkout: "btn-checkout",
  backToCart: "btn-back-cart",
  pay: "btn-pay",
  cardTap: "btn-card-tap",
  done: "btn-done",
  popupYes: "popup-yes",
  popupNo: "popup-no",
  popupDrink: (choiceId: string) => `popup-drink-${choiceId}`,
  stillHere: "popup-still-here",
};

export type Options = Record<string, string[]>;

const itemsById = new Map(menu.items.map((i) => [i.id, i]));

export function getItem(itemId: string): MenuItem | undefined {
  return itemsById.get(itemId);
}

export function visibleItems(categoryId: string): MenuItem[] {
  return menu.items.filter((i) => i.categoryId === categoryId && !i.hidden);
}

export const money = (n: number) => `$${n.toFixed(2)}`;
export const round2 = (n: number) => Math.round(n * 100) / 100;

export function unitPrice(item: MenuItem, options: Options): number {
  let price = item.price;
  for (const group of item.optionGroups) {
    for (const choiceId of options[group.id] ?? []) {
      price += group.choices.find((c) => c.id === choiceId)?.priceDelta ?? 0;
    }
  }
  return round2(price);
}

export function missingRequired(item: MenuItem, options: Options): MenuOptionGroup[] {
  return item.optionGroups.filter((g) => g.required && !(options[g.id]?.length));
}

/** "Large, no onions" — human-readable summary of chosen options. */
export function describeOptions(item: MenuItem, options: Options): string {
  const parts: string[] = [];
  for (const group of item.optionGroups) {
    for (const choiceId of options[group.id] ?? []) {
      const choice = group.choices.find((c) => c.id === choiceId);
      if (choice) parts.push(choice.name);
    }
  }
  return parts.join(", ");
}

const EMOJI: Record<string, string> = {
  cheeseburger: "🍔",
  double_cheeseburger: "🍔",
  crispy_chicken_sandwich: "🍗",
  veggie_burger: "🥬",
  fries: "🍟",
  onion_rings: "🧅",
  nuggets: "🍗",
  soda: "🥤",
  iced_tea: "🧊",
  water: "💧",
  vanilla_shake: "🥛",
  cookie: "🍪",
  combo_upgrade: "🍟",
};
const CATEGORY_EMOJI: Record<string, string> = { burgers: "🍔", sides: "🍟", drinks: "🥤", desserts: "🍪" };

export const itemEmoji = (itemId: string) => EMOJI[itemId] ?? "🍽️";
export const categoryEmoji = (categoryId: string) => CATEGORY_EMOJI[categoryId] ?? "🍽️";

export function deltaLabel(delta: number) {
  if (!delta) return "";
  return delta > 0 ? `+${money(delta)}` : `-${money(-delta)}`;
}
