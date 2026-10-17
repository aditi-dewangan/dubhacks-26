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
  title: "Burgers",
  buttons: [
    { id: "cat-burgers", label: "Burgers", enabled: true },
    { id: "cat-sides", label: "Sides", enabled: true },
    { id: "cat-drinks", label: "Drinks", enabled: true },
    { id: "cat-desserts", label: "Desserts", enabled: true },
    { id: "item-cheeseburger", label: "Cheeseburger $6.49", enabled: true },
    { id: "item-double_cheeseburger", label: "Double Cheeseburger $8.29", enabled: true },
    { id: "btn-cart", label: "View order", enabled: false },
  ],
  cart: emptyCart,
  sessionActive: true,
};

export const upsellState: KioskState = {
  kioskId: "store42-kiosk1",
  screen: "item",
  title: "Cheeseburger",
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
      { lineId: "L1", itemId: "cheeseburger", name: "Cheeseburger", qty: 1,
        options: { size: ["large"], remove: ["no_onions"] }, lineTotal: 7.99 },
    ],
    subtotal: 7.99, tax: 0.81, total: 8.8,
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
