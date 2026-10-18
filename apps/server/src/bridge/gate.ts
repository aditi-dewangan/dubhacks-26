// The payment gate's rules, kept pure so tests can pin them down.

import type { Cart, CartLine, KioskState } from "@kiosk-access/shared";

/**
 * The WHOLE message must be a plain yes, or the words on the phone's Confirm button said out loud
 * ("I confirm", "complete check-in"). "Yes, but make it large" is a change, not a confirm.
 */
const AFFIRMATIVE = new RegExp("^(yes|yeah|yep|correct|that's right|(yes,? )?i confirm|(yes,? )?confirm" +
  "( (my |the )?(order|check-?in|tickets?|purchase))?|(yes,? )?(complete|finish) (my |the )?check-?in|" +
  "(yes,? )?check me in|(yes,? )?place (my |the )?order)(,? please)?[.!]*$", "i");

/** The whole message asks to go back and change things, like the phone's Change button. */
const CHANGE = /^(no|nope|change|change (it|that|something|my order|the order|order|my check-?in)|i want to change( it| that| something| my order)?|edit( my)? order|go back)(,? please)?[.!]*$/i;

const plain = (text: string) => text.trim().replace(/[’‘]/g, "'").replace(/\s+/g, " ");

export function isAffirmative(text: string): boolean {
  return AFFIRMATIVE.test(plain(text));
}

export function isChangeRequest(text: string): boolean {
  return CHANGE.test(plain(text));
}

/** One line as a comparable string: item, quantity and sorted options. Prices are left out on purpose. */
function lineKey(line: Pick<CartLine, "itemId" | "qty" | "options">): string {
  const options = Object.keys(line.options)
    .filter((g) => line.options[g].length)
    .sort()
    .map((g) => `${g}=${[...line.options[g]].sort().join(",")}`)
    .join(";");
  return `${line.itemId}|${line.qty}|${options}`;
}

/** Same items, quantities and options, compared line by line (never by floating-point totals). */
export function sameCart(a: Cart, b: Cart): boolean {
  if (a.lines.length !== b.lines.length) return false;
  const ka = a.lines.map(lineKey).sort();
  const kb = b.lines.map(lineKey).sort();
  return ka.every((k, i) => k === kb[i]);
}

/** What the customer reviewed: the cart, plus the screen's fields and info lines (seats, appointment). */
export interface ReviewSnapshot {
  cart: Cart;
  fields: Record<string, string>;
  info: string[];
}

export function snapshotOf(state: KioskState): ReviewSnapshot {
  const fields: Record<string, string> = {};
  for (const f of state.fields ?? []) fields[f.id] = f.value;
  return { cart: structuredClone(state.cart), fields, info: [...(state.info ?? [])] };
}

/** The cart line by line, every field value, and every info line must be unchanged. */
export function sameReview(snapshot: ReviewSnapshot, state: KioskState): boolean {
  const now = snapshotOf(state);
  const keys = (r: Record<string, string>) => Object.keys(r).sort();
  return (
    sameCart(snapshot.cart, now.cart) &&
    keys(snapshot.fields).join("|") === keys(now.fields).join("|") &&
    keys(now.fields).every((k) => snapshot.fields[k] === now.fields[k]) &&
    [...snapshot.info].sort().join("\n") === [...now.info].sort().join("\n")
  );
}
