import { menu, type Cart } from "@kiosk-access/shared";

/** Read the Bridge's actual pending snapshot; never ask the model to calculate the total. */
export function checkoutReadback(cart: Cart): string {
  if (!cart.lines.length || !Number.isFinite(cart.total) || cart.total < 0) {
    return "I couldn't read a valid order total. Please ask a staff member to check the order before confirming.";
  }
  const cents = Math.round(cart.total * 100);
  const dollars = Math.floor(cents / 100);
  const remainder = cents % 100;
  const price = `${dollars} ${dollars === 1 ? "dollar" : "dollars"}` +
    (remainder ? ` and ${remainder} ${remainder === 1 ? "cent" : "cents"}` : "");
  const tail = `Total ${price}. Please confirm your order on the phone.`;
  const lines = cart.lines.map((line) => {
    const item = menu.items.find((item) => item.id === line.itemId);
    const choices = Object.entries(line.options).flatMap(([groupId, ids]) => ids.map((id) =>
      item?.optionGroups.find((group) => group.id === groupId)?.choices.find((choice) => choice.id === id)?.name ?? "unrecognized option"));
    return `${line.qty} ${item?.name ?? line.name}${choices.length ? `, ${choices.join(", ")}` : ""}`;
  });
  const full = `${lines.join("; ")}. ${tail}`;
  if (full.length <= 300) return full;
  // Do not truncate away a total, modifier, or confirmation instruction in a large cart.
  const count = cart.lines.reduce((sum, line) => sum + line.qty, 0);
  return `Your order has ${count} items across ${cart.lines.length} lines. Total ${price}. ` +
    "The full item readback is too long for one reply. Ask about individual items before confirming on your phone.";
}
