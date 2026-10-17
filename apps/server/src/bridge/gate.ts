// The payment gate's rules, kept pure so tests can pin them down.

import type { Cart, CartLine, KioskState } from "@kiosk-access/shared";

/** The WHOLE message must be a plain yes. "Yes, but make it large" is a change, not a confirm. */
const AFFIRMATIVE = /^(yes|yeah|yep|confirm|correct|that's right)(,? please)?[.!]*$/i;

export function isAffirmative(text: string): boolean {
  return AFFIRMATIVE.test(text.trim().replace(/[’‘]/g, "'"));
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
