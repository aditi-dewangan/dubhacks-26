import type { KioskState } from "./types.ts";

// Sample states so the phone app, agent and bridge can be built before the real kiosk exists.

const emptyCart = { lines: [], subtotal: 0, tax: 0, total: 0 };

export const welcomeState: KioskState = {
  kioskId: "store42-kiosk1",
  screen: "welcome",
  title: "Welcome",
  buttons: [{ id: "btn-start", label: "Start order", enabled: true }],
  cart: emptyCart,
  sessionActive: true,
};

export const menuState: KioskState = {
  kioskId: "store42-kiosk1",
  screen: "menu",
  title: "Chicken",
  buttons: [
    { id: "cat-combos", label: "Combos", enabled: true },
    { id: "cat-chicken", label: "Chicken", enabled: true },
    { id: "cat-sides", label: "Sides", enabled: true },
    { id: "cat-drinks", label: "Drinks", enabled: true },
    { id: "cat-desserts", label: "Desserts", enabled: true },
    { id: "item-chicken_sandwich", label: "Chicken Sandwich $7.49", enabled: true },
    { id: "item-chicken_finger", label: "Chicken Finger $2.29", enabled: true },
    { id: "btn-cart", label: "View order", enabled: false },
  ],
  cart: emptyCart,
  sessionActive: true,
};

export const upsellState: KioskState = {
  kioskId: "store42-kiosk1",
  screen: "item",
  title: "Chicken Sandwich",
  buttons: [],
  popup: {
    id: "popup-upsell",
    text: "Make it a combo with medium fries and a drink for $2.00 more?",
    buttons: [
      { id: "popup-yes", label: "Yes, make it a combo" },
      { id: "popup-no", label: "No thanks" },
    ],
  },
  cart: {
    lines: [
      { lineId: "L1", itemId: "chicken_sandwich", name: "Chicken Sandwich", qty: 1,
        options: { remove: ["no_lettuce"] }, lineTotal: 7.49 },
    ],
    subtotal: 7.49, tax: 0.76, total: 8.25,
  },
  sessionActive: true,
};

export const completeState: KioskState = {
  kioskId: "store42-kiosk1",
  screen: "complete",
  title: "Thank you",
  buttons: [{ id: "btn-done", label: "Done", enabled: true }],
  cart: upsellState.cart,
  orderNumber: "142",
  sessionActive: true,
};
