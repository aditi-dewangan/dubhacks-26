// Text the agent reads and turns into speech: prices as people say them, order lines
// as short phrases ("1 large cheeseburger, no onions").

import { menu, type Cart, type CartLine, type KioskPopup, type KioskState } from "@kiosk-access/shared";

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

export function numberWords(n: number): string {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : "");
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${numberWords(n % 100)}` : ""}`;
  return String(n);
}

/** 7.99 -> "seven ninety-nine", 2 -> "two dollars", 0.5 -> "fifty cents", 8.05 -> "eight oh five". */
export function spokenMoney(amount: number): string {
  const cents = Math.round(Math.abs(amount) * 100);
  const d = Math.floor(cents / 100);
  const c = cents % 100;
  if (d === 0) return c ? `${numberWords(c)} cents` : "zero dollars";
  if (c === 0) return d === 1 ? "one dollar" : `${numberWords(d)} dollars`;
  return `${numberWords(d)} ${c < 10 ? `oh ${numberWords(c)}` : numberWords(c)}`;
}

/** "one fifty more", "fifty cents less", or "" for no change. */
export function spokenDelta(delta: number): string {
  if (!delta) return "";
  return `${spokenMoney(delta)} ${delta > 0 ? "more" : "less"}`;
}

const itemsById = new Map(menu.items.map((i) => [i.id, i]));

/** "1 large cheeseburger, no onions". Size goes in front; other choices follow. */
export function describeLine(line: Pick<CartLine, "itemId" | "qty" | "options"> & { name?: string }): string {
  const item = itemsById.get(line.itemId);
  let name = (line.name ?? item?.name ?? line.itemId).toLowerCase();
  if (line.qty > 1 && !/[s)]$/.test(name)) name += "s";
  const front: string[] = [];
  const after: string[] = [];
  for (const g of item?.optionGroups ?? []) {
    for (const choiceId of line.options[g.id] ?? []) {
      const choice = g.choices.find((c) => c.id === choiceId)?.name.toLowerCase() ?? choiceId;
      (g.id === "size" ? front : after).push(choice);
    }
  }
  return [`${line.qty} ${[...front, name].join(" ")}`, ...after].join(", ");
}

export function describeCart(cart: Cart, withLineIds = false): string {
  if (!cart.lines.length) return "The order is empty.";
  const lines = cart.lines.map(
    (l) => `${describeLine(l)}${withLineIds ? ` [line ${l.lineId}]` : ""}, ${spokenMoney(l.lineTotal)}`,
  );
  return `${lines.join("; ")}. Total with tax ${spokenMoney(cart.total)}.`;
}

export function cartTotalSentence(cart: Cart): string {
  return cart.lines.length ? `Cart total ${spokenMoney(cart.total)} with tax.` : "The order is now empty.";
}

export function describePopup(popup: KioskPopup): string {
  const buttons = popup.buttons.map((b) => `${b.id} ("${b.label}")`).join(", ");
  return `A popup is showing: "${popup.text}" Buttons: ${buttons}.`;
}

export function popupSentence(state: KioskState): string {
  return state.popup ? ` ${describePopup(state.popup)} Ask the customer before answering it.` : "";
}
