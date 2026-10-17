// The generic engine for non-food kiosks (clinic, cinema, transit, and any kiosk added later).
//
// It needs nothing kiosk-specific from the AI side: it reads what is on screen the way a screen
// reader would (every button, text field and info line marked with data-kiosk-*), publishes that
// as KioskState, and carries out the generic commands by tapping and typing on the real screen.

import type { ComponentType } from "react";
import type { CommandResult, ConnectionStatus } from "@kiosk-access/sdk";
import type { Cart, KioskCommand, KioskKind, KioskState } from "@kiosk-access/shared";
import { kioskId } from "./kinds.ts";
import { hideFingerSoon } from "./finger.tsx";
import { ids } from "./model.ts";
import { KioskError, tap, typeInto } from "./taps.ts";

export interface GenericModel {
  screen: string;
  cart: Cart;
  /** Booking, ticket or queue number, shown on the "complete" screen. */
  orderNumber?: string;
}

export interface GenericKiosk {
  kind: KioskKind;
  Body: ComponentType<{ qrUrl: string | null; status: ConnectionStatus }>;
  getModel(): GenericModel;
  subscribe(listener: () => void): () => void;
  reset(): void;
}

export const EMPTY_CART: Cart = { lines: [], subtotal: 0, tax: 0, total: 0 };

const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/** Read the current screen from the page. */
export function readScreen(def: GenericKiosk, sessionActive: boolean): KioskState {
  const root = document.querySelector(".content") ?? document.body;
  const model = def.getModel();

  const buttons = [...root.querySelectorAll<HTMLButtonElement>("button[data-kiosk-id]")].map((el) => ({
    id: el.dataset.kioskId!,
    label: clean(el.getAttribute("aria-label")) || clean(el.innerText),
    enabled: !el.disabled,
  }));
  const fields = [...root.querySelectorAll<HTMLInputElement>("input[data-kiosk-id]")].map((el) => ({
    id: el.dataset.kioskId!,
    label: clean(el.getAttribute("aria-label")) || clean(el.labels?.[0]?.innerText),
    value: el.value,
    placeholder: el.placeholder || undefined,
  }));
  const info = [...root.querySelectorAll<HTMLElement>("[data-kiosk-info]")]
    .map((el) => clean(el.innerText))
    .filter(Boolean);
  const title = clean(root.querySelector<HTMLElement>("[data-kiosk-title]")?.innerText) || model.screen;

  return {
    kioskId,
    kind: def.kind,
    screen: model.screen,
    title,
    buttons,
    fields,
    info,
    cart: model.cart,
    orderNumber: model.orderNumber,
    sessionActive,
  };
}

const BLOCKED: Record<string, string> = {
  [ids.pay]: "Payment can only start after the customer confirms.",
  [ids.cardTap]: "The customer taps their own card on the reader.",
};

export async function runGenericCommand(
  def: GenericKiosk,
  command: KioskCommand,
  sessionActive: () => boolean,
): Promise<CommandResult> {
  try {
    await executeGeneric(def, command);
    return { ok: true, state: readScreen(def, sessionActive()) };
  } catch (err) {
    const error = err instanceof KioskError ? err.message : `Kiosk error: ${String(err)}`;
    if (!(err instanceof KioskError)) console.error(err);
    return { ok: false, error, state: readScreen(def, sessionActive()) };
  } finally {
    hideFingerSoon();
  }
}

async function executeGeneric(def: GenericKiosk, command: KioskCommand) {
  const { screen } = def.getModel();
  if (screen === "paying" && command.type !== "cancel_order") {
    throw new KioskError("Payment is in progress. The customer needs to tap their card on the reader.");
  }

  switch (command.type) {
    case "press": {
      if (BLOCKED[command.buttonId]) throw new KioskError(BLOCKED[command.buttonId]);
      const onScreen = readScreen(def, false).buttons;
      const button = onScreen.find((b) => b.id === command.buttonId);
      if (!button) {
        const available = onScreen.filter((b) => b.enabled).map((b) => b.id).join(", ") || "none";
        throw new KioskError(`There's no "${command.buttonId}" button on screen. Available: ${available}.`);
      }
      if (!button.enabled) throw new KioskError(`"${button.label}" can't be pressed right now.`);
      return tap(command.buttonId);
    }
    case "type_text": {
      if (typeof command.text !== "string") throw new KioskError("type_text needs some text.");
      return typeInto(command.fieldId, command.text);
    }
    case "start_payment": {
      const pay = readScreen(def, false).buttons.find((b) => b.id === ids.pay);
      if (!pay) throw new KioskError("There's no Pay button on this screen. Go to the review screen first.");
      if (!pay.enabled) throw new KioskError("The Pay button is disabled. Something on the review screen is incomplete.");
      return tap(ids.pay);
    }
    case "cancel_order":
      def.reset();
      return;
    default:
      throw new KioskError(
        `This ${def.kind} kiosk doesn't support "${command.type}". Read the buttons and fields in the kiosk state, then use press or type_text.`,
      );
  }
}
