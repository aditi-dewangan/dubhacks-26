// Menu lookups, prices and button ids. Everything here is pure so the UI, the
// store and the command executor all agree on names and numbers.

import { menu, type MenuItem, type MenuOptionGroup } from "@kiosk-access/shared";
import imgBoxCombo        from "./assets/menu/box_combo_new.avif";
import img3Finger         from "./assets/menu/3finger_combo_new.avif";
import imgCaniac          from "./assets/menu/caniac_combo.avif";
import imgSandwich        from "./assets/menu/sandwich_combo_new.avif";
import imgChickenFinger   from "./assets/menu/chicken-finger-medium0830.avif";
import imgTailgate        from "./assets/menu/canestailgate-25.avif";
import imgFries           from "./assets/menu/fries_recrop.avif";
import imgSauce           from "./assets/menu/sauce-medium0830.avif";
import imgColeslaw        from "./assets/menu/coleslaw.avif";
import imgTexasToast      from "./assets/menu/texas_toast.avif";
import imgFountainDrink   from "./assets/menu/fountain_drink.avif";
import imgLemonade        from "./assets/menu/lemonade.avif";
import imgSweetTea        from "./assets/menu/sweet_tea.avif";

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
  box_combo: "🍱",
  three_finger_combo: "🍗",
  caniac_combo: "🍗",
  sandwich_combo: "🥪",
  chicken_sandwich: "🥪",
  chicken_finger: "🍗",
  tailgate: "🎉",
  fries: "🍟",
  coleslaw: "🥗",
  texas_toast: "🍞",
  canes_sauce: "🥫",
  lemonade: "🍋",
  sweet_tea: "🧋",
  fountain_drink: "🥤",
  combo_upgrade: "🍟",
};

const PHOTOS: Record<string, string> = {
  box_combo:          imgBoxCombo,
  three_finger_combo: img3Finger,
  caniac_combo:       imgCaniac,
  sandwich_combo:     imgSandwich,
  chicken_sandwich:   imgSandwich,
  chicken_finger:     imgChickenFinger,
  tailgate:           imgTailgate,
  fries:              imgFries,
  canes_sauce:        imgSauce,
  coleslaw:           imgColeslaw,
  texas_toast:        imgTexasToast,
  fountain_drink:     imgFountainDrink,
  lemonade:           imgLemonade,
  sweet_tea:          imgSweetTea,
};

const CATEGORY_EMOJI: Record<string, string> = { combos: "🍱", chicken: "🍗", sides: "🍟", drinks: "🥤" };

export const itemEmoji  = (itemId: string) => EMOJI[itemId] ?? "🍽️";
export const itemPhoto  = (itemId: string): string | null => PHOTOS[itemId] ?? null;
export const categoryEmoji = (categoryId: string) => CATEGORY_EMOJI[categoryId] ?? "🍽️";

export function deltaLabel(delta: number) {
  if (!delta) return "";
  return delta > 0 ? `+${money(delta)}` : `-${money(-delta)}`;
}
