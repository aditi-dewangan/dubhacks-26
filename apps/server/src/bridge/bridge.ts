// The Bridge: agent tools, the payment gate, and kiosk event detection.
// Built from injected dependencies so tests can run it against the fake kiosk.

import { randomUUID } from "node:crypto";
import {
  menu,
  type AgentMessage,
  type Cart,
  type CommandAck,
  type CommandEnvelope,
  type KioskState,
  type LoggedEventType,
  type SessionEndReason,
} from "@kiosk-access/shared";
import { CommandError, createCommandSender, FINAL_BUTTONS, KIOSK_NO_RESPONSE, type FinalAction, type SafeCommand } from "./commands.ts";
import { isAffirmative, sameReview, snapshotOf, type ReviewSnapshot } from "./gate.ts";
import {
  cartTotalSentence,
  describeCart,
  describeLine,
  describePopup,
  describeScreen,
  popupSentence,
  spokenDelta,
  spokenMoney,
} from "./spoken.ts";
import {
  normalize,
  resolveCategory,
  resolveLine,
  resolveOrderableItem,
  resolvePopupButton,
  validateOptions,
  validateQty,
} from "./validate.ts";

export interface BridgeSession {
  sessionId: string;
  kioskId: string;
  ended: boolean;
  pendingCheckout: Cart | null;
}

export interface BridgeDeps {
  sendToKiosk(kioskId: string, env: CommandEnvelope): boolean;
  onKioskAck(handler: (ack: CommandAck, kioskId: string) => void): () => void;
  onKioskStateChange(
    handler: (kioskId: string, prev: KioskState | null, next: KioskState, session: BridgeSession | null) => void,
  ): () => void;
  onSessionEnded(handler: (session: BridgeSession, reason: SessionEndReason) => void): () => void;
  getSession(sessionId: string): BridgeSession | undefined;
  getKioskState(kioskId: string): KioskState | null;
  sendAgentMessage(sessionId: string, msg: AgentMessage): void;
  handleKioskEvent(sessionId: string, note: string): Promise<void>;
  logEvent(type: LoggedEventType, fields: { kioskId?: string; sessionId?: string; data?: Record<string, unknown> }): void;
  commandTimeoutMs?: number;
  newId?: () => string;
}

interface PendingCheckout {
  checkoutId: string;
  snapshot: ReviewSnapshot;
  /** start_payment, or submit for a check-in (clinic). */
  action: FinalAction;
}

type Input = Record<string, unknown>;

const TOOLS = [
  "get_menu",
  "get_kiosk_state",
  "add_item",
  "update_item",
  "remove_item",
  "respond_to_popup",
  "request_checkout",
  "cancel_order",
  "press_button",
  "type_text",
] as const;

/** Tools that only make sense on the food kiosk, which has a menu and high-level cart commands. */
const FOOD_ONLY = new Set(["get_menu", "add_item", "update_item", "remove_item"]);

const kindOf = (state: KioskState) => state.kind ?? "food";

/** Fields whose values are personal. Their text is kept out of tool replies and the bridge's log. */
const SENSITIVE_FIELD = /birth|dob|insurance|member|ssn|social|phone|address/i;

const NOT_CONFIRMED = "Payment has not started.";

export function createBridge(deps: BridgeDeps) {
  const commands = createCommandSender({
    sendToKiosk: deps.sendToKiosk,
    onKioskAck: deps.onKioskAck,
    timeoutMs: deps.commandTimeoutMs ?? 10_000,
    newId: deps.newId,
  });
  const newId = deps.newId ?? randomUUID;

  // ---------------- payment gate ----------------

  const checkouts = new Map<string, PendingCheckout>(); // sessionId -> pending checkout

  function openGate(session: BridgeSession, state: KioskState, action: FinalAction): PendingCheckout {
    const pending = { checkoutId: newId(), snapshot: snapshotOf(state), action };
    checkouts.set(session.sessionId, pending);
    session.pendingCheckout = pending.snapshot.cart;
    return pending;
  }

  function clearGate(sessionId: string) {
    if (!checkouts.delete(sessionId)) return;
    const session = deps.getSession(sessionId);
    if (session) session.pendingCheckout = null;
  }

  /**
   * The ONLY path that sends start_payment or completes a check-in. It needs the current
   * checkoutId, and what's on the kiosk (cart line by line, fields, info) must still match
   * what was read back to the customer.
   */
  async function confirmCheckout(sessionId: string, checkoutId: string): Promise<AgentMessage> {
    const reply = (text: string): AgentMessage => ({ text, awaitingConfirmation: false });
    const session = deps.getSession(sessionId);
    const pending = checkouts.get(sessionId);
    if (!session || session.ended) return reply("This session has ended.");
    if (!pending) return reply("There's no order waiting to be confirmed. Tell me when you're ready to check out.");
    const what = pending.action === "submit" ? "completed the check-in" : "started payment";
    const noun = pending.action === "submit" ? "check-in" : "order";
    if (pending.checkoutId !== checkoutId) {
      clearGate(sessionId);
      return reply(`That confirmation was for an earlier version of your ${noun}, so I haven't ${what}. Let's review it again.`);
    }

    clearGate(sessionId); // single use, whatever happens next
    const state = deps.getKioskState(session.kioskId);
    if (!state || !sameReview(pending.snapshot, state)) {
      const now = state ? (kindOf(state) === "food" ? describeCart(state.cart) : "") : "";
      return reply(`Your ${noun} changed since I read it back, so I haven't ${what}. ${now}`.trim());
    }
    if (state.popup) return reply(`A popup is showing on the kiosk, so I haven't ${what}. ${describePopup(state.popup)}`);

    deps.logEvent("checkout_confirmed", {
      kioskId: session.kioskId, sessionId, data: { checkoutId, action: pending.action, total: state.cart.total },
    });
    try {
      const ack = await commands.sendFinalAction(session.kioskId, sessionId, pending.action);
      if (!ack.ok) return reply(`The kiosk couldn't finish: ${ack.error ?? "unknown error"}`);
      if (pending.action === "submit") {
        return reply(`You're checked in.${ack.state.orderNumber ? ` Your number is ${ack.state.orderNumber}.` : ""} Please have a seat; you'll be called.`);
      }
      return reply(`Payment started. Please tap your card on the reader below the screen. The total is ${spokenMoney(ack.state.cart.total)}.`);
    } catch (err) {
      const why = err instanceof CommandError ? err.message : KIOSK_NO_RESPONSE;
      return reply(`${why} I haven't ${what}.`);
    }
  }

  /** user:confirm from the phone's Confirm / Change order buttons. */
  async function handleConfirm(sessionId: string, confirmed: boolean): Promise<void> {
    const session = deps.getSession(sessionId);
    if (!session || session.ended) return;
    if (!confirmed) {
      clearGate(sessionId);
      deps.sendAgentMessage(sessionId, { text: "Okay, nothing has been submitted. What would you like to change?", awaitingConfirmation: false });
      return;
    }
    // The current contract's user:confirm carries no checkoutId, so the phone confirms the latest one.
    const pending = checkouts.get(sessionId);
    deps.sendAgentMessage(sessionId, await confirmCheckout(sessionId, pending?.checkoutId ?? ""));
  }

  /**
   * Call with every user message before the model sees it. While a checkout is pending, a
   * plain "yes" confirms it here, in code, and the reply is returned. Anything else clears
   * the gate and returns null so the agent handles it as a change.
   */
  async function interceptUserMessage(sessionId: string, text: string): Promise<AgentMessage | null> {
    const pending = checkouts.get(sessionId);
    if (!pending) return null;
    if (isAffirmative(text)) return confirmCheckout(sessionId, pending.checkoutId);
    clearGate(sessionId);
    return null;
  }

  // ---------------- tools ----------------

  async function run(sessionId: string, command: SafeCommand): Promise<CommandAck> {
    const session = deps.getSession(sessionId)!;
    return commands.sendCommand(session.kioskId, sessionId, command);
  }

  /** Common checks before a command that changes the order. Returns an error or null. */
  function blockedChange(state: KioskState, allowPopup = false): string | null {
    if (state.screen === "paying") return "Payment is in progress, so the order can't change now.";
    if (state.screen === "complete") return `The order is finished${state.orderNumber ? ` (order number ${state.orderNumber})` : ""}.`;
    if (state.popup && !allowPopup) return `${describePopup(state.popup)} Ask the customer and answer it with respond_to_popup first.`;
    return null;
  }

  const tools: Record<(typeof TOOLS)[number], (session: BridgeSession, state: KioskState, input: Input) => Promise<string>> = {
    async get_menu(_session, _state, input) {
      const cat = resolveCategory(input.categoryId);
      if (!cat.ok) return cat.error;
      if (!cat.value) {
        return menu.categories
          .map((c) => {
            const items = menu.items.filter((i) => i.categoryId === c.id && !i.hidden);
            return `${c.name}: ${items.map((i) => `${i.name.toLowerCase()} [${i.id}] ${spokenMoney(i.price)}`).join(", ")}.`;
          })
          .join(" ");
      }
      const items = menu.items.filter((i) => i.categoryId === cat.value && !i.hidden);
      return items
        .map((i) => {
          const tags = i.tags.filter((t) => t === "vegetarian" || t === "vegan");
          const groups = i.optionGroups.map((g) => {
            const choices = g.choices.map((c) => `${c.name.toLowerCase()}${c.priceDelta ? ` (${spokenDelta(c.priceDelta)})` : ""}`);
            return `${g.name.toLowerCase()} ${g.required ? "required" : "optional"}: ${choices.join(", ")}`;
          });
          return [`${i.name} [${i.id}], ${spokenMoney(i.price)}${tags.length ? ` (${tags.join(", ")})` : ""}`, i.description, ...groups].join(". ");
        })
        .join(" | ");
    },

    async get_kiosk_state(session, state) {
      if (kindOf(state) !== "food") {
        const gate = checkouts.has(session.sessionId) ? " Waiting for the customer to confirm." : "";
        return `${describeScreen(state, FINAL_BUTTONS)}${gate}`;
      }
      const screen = `The kiosk is on the ${state.screen} screen.`;
      const cart = state.cart.lines.length ? `Order: ${describeCart(state.cart, true)}` : "The order is empty.";
      const popup = state.popup ? ` ${describePopup(state.popup)}` : "";
      const gate = checkouts.has(session.sessionId) ? " Waiting for the customer to confirm checkout." : "";
      const order = state.orderNumber ? ` Order number ${state.orderNumber}.` : "";
      return `${screen} ${cart}${popup}${gate}${order}`;
    },

    async add_item(session, state, input) {
      const blocked = blockedChange(state);
      if (blocked) return blocked;
      const item = resolveOrderableItem(input.itemId ?? input.name);
      if (!item.ok) return item.error;
      const qty = validateQty(input.qty, 1);
      if (!qty.ok) return qty.error;
      const given = validateOptions(item.value.item, input.options, false);
      if (!given.ok) return given.error;
      const options = validateOptions(item.value.item, { ...item.value.presetOptions, ...given.value }, true);
      if (!options.ok) return options.error;

      clearGate(session.sessionId);
      const ack = await run(session.sessionId, { type: "add_item", itemId: item.value.item.id, qty: qty.value, options: options.value });
      if (!ack.ok) return `The kiosk couldn't add it: ${ack.error}`;
      const added = describeLine({ itemId: item.value.item.id, qty: qty.value, options: options.value });
      return `Added ${added}. ${cartTotalSentence(ack.state.cart)}${popupSentence(ack.state)}`;
    },

    async update_item(session, state, input) {
      const blocked = blockedChange(state);
      if (blocked) return blocked;
      const line = resolveLine(state, input.lineId);
      if (!line.ok) return line.error;
      if (input.qty === undefined && input.options === undefined) return "What should change: the quantity or the options?";
      const item = menu.items.find((i) => i.id === line.value.itemId)!;
      let qty: number | undefined;
      if (input.qty !== undefined) {
        const q = validateQty(input.qty);
        if (!q.ok) return q.error;
        qty = q.value;
      }
      let changed: Record<string, string[]> | undefined;
      if (input.options !== undefined) {
        const o = validateOptions(item, input.options, false);
        if (!o.ok) return o.error;
        changed = o.value;
        const merged = validateOptions(item, { ...line.value.options, ...changed }, true);
        if (!merged.ok) return merged.error;
      }

      clearGate(session.sessionId);
      const command: SafeCommand = { type: "update_item", lineId: line.value.lineId };
      if (qty !== undefined) command.qty = qty;
      if (changed) command.options = changed;
      const ack = await run(session.sessionId, command);
      if (!ack.ok) return `The kiosk couldn't change it: ${ack.error}`;
      const after = ack.state.cart.lines.find((l) => l.lineId === line.value.lineId);
      return `Changed it to ${after ? describeLine(after) : "the new choice"}. ${cartTotalSentence(ack.state.cart)}${popupSentence(ack.state)}`;
    },

    async remove_item(session, state, input) {
      const blocked = blockedChange(state);
      if (blocked) return blocked;
      const line = resolveLine(state, input.lineId);
      if (!line.ok) return line.error;

      clearGate(session.sessionId);
      const ack = await run(session.sessionId, { type: "remove_item", lineId: line.value.lineId });
      if (!ack.ok) return `The kiosk couldn't remove it: ${ack.error}`;
      const gone = state.cart.lines.filter((l) => !ack.state.cart.lines.some((n) => n.lineId === l.lineId));
      const alsoCombo = gone.some((l) => l.lineId !== line.value.lineId) ? " and its combo" : "";
      return `Removed ${describeLine(line.value)}${alsoCombo}. ${cartTotalSentence(ack.state.cart)}`;
    },

    async respond_to_popup(session, state, input) {
      const blocked = blockedChange(state, true);
      if (blocked) return blocked;
      const button = resolvePopupButton(state, input.buttonId);
      if (!button.ok) return button.error;

      clearGate(session.sessionId);
      const ack = await run(session.sessionId, { type: "press", buttonId: button.value });
      if (!ack.ok) return `The kiosk couldn't press it: ${ack.error}`;
      const added = ack.state.cart.lines.filter((l) => !state.cart.lines.some((o) => o.lineId === l.lineId));
      if (ack.state.popup) return `Pressed. ${describePopup(ack.state.popup)} Ask the customer before answering it.`;
      if (added.length) return `Added ${added.map((l) => describeLine(l)).join(" and ")}. ${cartTotalSentence(ack.state.cart)}`;
      return `Done, nothing was added. ${cartTotalSentence(ack.state.cart)}`;
    },

    async press_button(session, state, input) {
      if (state.screen === "paying") return "Payment is in progress. The customer taps their card on the reader.";
      const ref = typeof input.buttonId === "string" ? input.buttonId.trim() : "";
      if (!ref) return "Which button? Call get_kiosk_state to see the buttons on screen.";
      const all = [...(state.popup?.buttons.map((b) => ({ ...b, enabled: true })) ?? []), ...state.buttons];
      const r = normalize(ref);
      const button = all.find((b) => b.id === ref) ?? all.find((b) => normalize(b.label) === r);
      if (!button) {
        const ids = all.filter((b) => b.enabled && !FINAL_BUTTONS[b.id]).map((b) => `${b.id} ("${b.label}")`);
        return `No "${ref}" button on screen. Buttons: ${ids.join(", ") || "none"}.`;
      }
      if (FINAL_BUTTONS[button.id]) return FINAL_BUTTONS[button.id];
      if (!button.enabled) return `"${button.label}" can't be pressed yet. Something on screen still needs an answer.`;

      clearGate(session.sessionId);
      const ack = await run(session.sessionId, { type: "press", buttonId: button.id });
      if (!ack.ok) return `The kiosk couldn't press it: ${ack.error}`;
      return `Pressed "${button.label}". ${kindOf(ack.state) === "food" ? cartTotalSentence(ack.state.cart) + popupSentence(ack.state) : describeScreen(ack.state, FINAL_BUTTONS)}`;
    },

    async type_text(session, state, input) {
      if (state.screen === "paying") return "Payment is in progress, so nothing can be typed now.";
      const fields = state.fields ?? [];
      if (!fields.length) return "There are no text fields on this screen.";
      const ref = typeof input.fieldId === "string" ? input.fieldId.trim() : "";
      const field = fields.find((f) => f.id === ref) ?? fields.find((f) => normalize(f.label) === normalize(ref));
      if (!field) return `No "${ref}" field on screen. Fields: ${fields.map((f) => `${f.id} ("${f.label}")`).join(", ")}.`;
      if (typeof input.text !== "string" || !input.text.trim()) return `What should go in "${field.label}"?`;
      if (input.text.length > 80) return "That's too long for this field.";

      clearGate(session.sessionId);
      const ack = await run(session.sessionId, { type: "type_text", fieldId: field.id, text: input.text });
      if (!ack.ok) return `The kiosk couldn't type it: ${ack.error}`;
      const shown = SENSITIVE_FIELD.test(`${field.id} ${field.label}`) ? "" : ` "${input.text}"`;
      return `Typed${shown} into ${field.label}. ${describeScreen(ack.state, FINAL_BUTTONS)}`;
    },

    async request_checkout(session, state) {
      const blocked = blockedChange(state);
      if (blocked) return blocked;
      const food = kindOf(state) === "food";
      const has = (id: string) => state.buttons.some((b) => b.id === id && b.enabled);
      let action: FinalAction;
      if (!food && has("btn-submit")) action = "submit";
      else if (!state.cart.lines.length) return food ? "The order is empty, so there's nothing to check out." : "There's nothing to confirm yet. Finish the steps on screen first.";
      else if (!food && !has("btn-pay")) return "Go to the review screen first (it shows the Pay button), then call request_checkout.";
      else action = "start_payment";

      const pending = openGate(session, state, action);
      deps.logEvent("checkout_requested", {
        kioskId: session.kioskId,
        sessionId: session.sessionId,
        data: { checkoutId: pending.checkoutId, action, total: state.cart.total, lines: state.cart.lines.length },
      });
      const confirm = "Then ask the customer to confirm by pressing Confirm or saying yes.";
      if (action === "submit") {
        return `Read this back: ${state.info?.join("; ") ?? state.title}. ${confirm} The check-in is not complete yet, and you cannot complete it.`;
      }
      const details = !food && state.info?.length ? ` Also on screen: ${state.info.join("; ")}.` : "";
      return `Read this back: ${describeCart(state.cart)}${details} ${confirm} ${NOT_CONFIRMED} You cannot start it.`;
    },

    async cancel_order(session) {
      clearGate(session.sessionId);
      const ack = await run(session.sessionId, { type: "cancel_order" });
      if (!ack.ok) return `The kiosk couldn't clear the order: ${ack.error}`;
      return "The order is cleared. We can start over.";
    },
  };

  /** Runs one agent tool. Returns a short text summary for the model. Never throws. */
  async function executeTool(sessionId: string, name: string, input: unknown): Promise<string> {
    const session = deps.getSession(sessionId);
    if (!session || session.ended) return "This session has ended.";
    const tool = (TOOLS as readonly string[]).includes(name) ? tools[name as (typeof TOOLS)[number]] : undefined;
    let result: string;
    if (!tool) {
      result = `Unknown tool "${name}". Tools: ${TOOLS.join(", ")}.`;
    } else {
      const state = deps.getKioskState(session.kioskId);
      const args = input && typeof input === "object" && !Array.isArray(input) ? (input as Input) : {};
      try {
        if (!state) result = "I can't see the kiosk right now. It may be offline.";
        else if (FOOD_ONLY.has(name) && kindOf(state) !== "food") {
          result = `This is a ${kindOf(state)} kiosk with no menu, so ${name} doesn't apply. Call get_kiosk_state to read the screen, then use press_button and type_text.`;
        } else result = await tool(session, state, args);
      } catch (err) {
        result = err instanceof CommandError ? err.message : "Something went wrong talking to the kiosk.";
        if (!(err instanceof CommandError)) console.error("[bridge] tool failed", name, err);
      }
    }
    deps.logEvent("tool_call", { kioskId: session.kioskId, sessionId, data: { name, input: redact(name, input), result } });
    return result;
  }

  /** Keeps personal values (date of birth, insurance) out of the event log. */
  function redact(name: string, input: unknown): unknown {
    if (name !== "type_text" || !input || typeof input !== "object") return input;
    const { fieldId, text } = input as { fieldId?: unknown; text?: unknown };
    return SENSITIVE_FIELD.test(String(fieldId ?? "")) ? { fieldId, text: "[redacted]" } : { fieldId, text };
  }

  /** True while a checkout is waiting for the customer's confirm. The agent sets awaitingConfirmation from it. */
  function isAwaitingConfirmation(sessionId: string): boolean {
    return checkouts.has(sessionId);
  }

  // ---------------- kiosk events ----------------

  const knownPopup = new Map<string, string | null>(); // kioskId -> popup we already told the agent about
  const popupKey = (s: KioskState) => (s.popup ? `${s.popup.id}|${s.popup.text}` : null);

  deps.onKioskAck((ack, kioskId) => knownPopup.set(kioskId, popupKey(ack.state)));

  deps.onKioskStateChange((kioskId, prev, next, session) => {
    const key = popupKey(next);
    const busy = commands.pendingCount(kioskId) > 0;
    const wasKnown = knownPopup.get(kioskId) ?? null;
    knownPopup.set(kioskId, key);
    if (!session || session.ended) return;

    const pending = checkouts.get(session.sessionId);
    if (pending && !sameReview(pending.snapshot, next)) clearGate(session.sessionId);

    const notify = (note: string) =>
      deps.handleKioskEvent(session.sessionId, note).catch((err) => console.error("[bridge] handleKioskEvent failed", err));

    // A popup no command caused (a timeout warning, or something staff did) means the agent speaks first.
    if (key && key !== wasKnown && !busy && next.popup) {
      notify(`A popup appeared on the kiosk: "${next.popup.text}" Buttons: ${next.popup.buttons.map((b) => `${b.id} ("${b.label}")`).join(", ")}.`);
    }
    if (next.screen === "complete" && next.orderNumber && prev?.screen !== "complete") {
      notify(kindOf(next) === "clinic"
        ? `Check-in is complete. The customer's number is ${next.orderNumber}.`
        : `Payment went through. The order number is ${next.orderNumber}.`);
    }
  });

  deps.onSessionEnded((session) => {
    clearGate(session.sessionId);
    commands.cancelSession(session.sessionId);
  });

  return { executeTool, handleConfirm, interceptUserMessage, isAwaitingConfirmation, confirmCheckout };
}

export type Bridge = ReturnType<typeof createBridge>;
