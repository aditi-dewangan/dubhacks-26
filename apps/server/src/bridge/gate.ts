// The payment gate's rules, kept pure so tests can pin them down.

import type { Cart, CartLine } from "@kiosk-access/shared";

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
