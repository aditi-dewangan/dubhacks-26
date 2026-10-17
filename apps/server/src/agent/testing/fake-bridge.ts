// Test/evaluation fixture only. Production always imports ../bridge/index.ts.
import { fixtures, menu, type KioskState } from "@kiosk-access/shared";
import { validateAddItemInput } from "../ordering.ts";
import type { AgentSession } from "../loop.ts";

export function fakeBridge(initial: KioskState = fixtures.menuState) {
  const state = structuredClone(initial);
  const session: AgentSession = { kioskId: state.kioskId, history: [], ended: false, pendingCheckout: null };
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  let nextId = 100;
  const recalculate = () => {
    const round = (n: number) => Math.round(n * 100) / 100;
    for (const line of state.cart.lines) {
      const item = menu.items.find((item) => item.id === line.itemId)!;
      const delta = item.optionGroups.flatMap((group) => group.choices.filter((choice) =>
        line.options[group.id]?.includes(choice.id))).reduce((sum, choice) => sum + choice.priceDelta, 0);
      line.lineTotal = round((item.price + delta) * line.qty);
    }
    state.cart.subtotal = round(state.cart.lines.reduce((sum, line) => sum + line.lineTotal, 0));
    state.cart.tax = round(state.cart.subtotal * menu.taxRate);
    state.cart.total = round(state.cart.subtotal + state.cart.tax);
    session.pendingCheckout = null;
  };
  return { state, session, calls, executeTool: async (_id: string, name: string, raw: unknown): Promise<string> => {
    const input = raw as Record<string, unknown>;
    calls.push({ name, input: structuredClone(input) });
    if (name === "get_menu") return JSON.stringify(menu);
    if (name === "get_kiosk_state") return JSON.stringify(state);
    if (state.popup && name !== "respond_to_popup") return "Rejected: answer the current popup first.";
    if (name === "add_item") {
      const error = validateAddItemInput(input);
      if (error) return `Rejected: ${error}`;
      const item = menu.items.find((item) => item.id === input.itemId)!;
      state.cart.lines.push({ lineId: `L${nextId++}`, itemId: item.id, name: item.name,
        qty: input.qty as number, options: structuredClone(input.options as Record<string, string[]>), lineTotal: 0 });
      if (item.upsell) state.popup = structuredClone(fixtures.upsellState.popup);
      recalculate();
    } else if (name === "update_item" || name === "remove_item") {
      const line = state.cart.lines.find((line) => line.lineId === input.lineId);
      if (!line) return "Rejected: no such cart line.";
      if (name === "remove_item") state.cart.lines = state.cart.lines.filter((candidate) => candidate !== line);
      else {
        const options = { ...line.options, ...(input.options as Record<string, string[]> ?? {}) };
        const qty = input.qty ?? line.qty;
        const error = validateAddItemInput({ itemId: line.itemId, options, qty });
        if (error) return `Rejected: ${error}`;
        line.options = options; line.qty = qty as number;
      }
      recalculate();
    } else if (name === "respond_to_popup") {
      if (!state.popup?.buttons.some((button) => button.id === input.buttonId)) return "Rejected: unavailable popup button.";
      if (state.popup.id === "popup-upsell" && input.buttonId === "popup-yes") {
        state.popup = { id: "popup-combo-drink", text: "Which drink would you like with the combo?", buttons:
          menu.items.find((item) => item.id === "combo_upgrade")!.optionGroups[0].choices.map((choice) =>
            ({ id: `popup-drink-${choice.id}`, label: choice.name })) };
      } else {
        if (state.popup.id === "popup-combo-drink") {
          state.cart.lines.push({ lineId: `L${nextId++}`, itemId: "combo_upgrade", name: "Combo upgrade", qty: 1,
            options: { drink: [(input.buttonId as string).replace("popup-drink-", "")] }, lineTotal: 0 });
          recalculate();
        }
        delete state.popup;
      }
    } else if (name === "cancel_order") {
      state.cart.lines = []; recalculate(); state.screen = "menu";
    } else if (name === "request_checkout") {
      if (!state.cart.lines.length) return "Rejected: the cart is empty.";
      session.pendingCheckout = structuredClone(state.cart);
    } else return "Rejected: unsupported tool; payment is never available in this fixture.";
    return `Success: ${name}. Current kiosk state: ${JSON.stringify(state)}`;
  } };
}
