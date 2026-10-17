// Which kiosk this page is. One build serves all four demo kiosks:
//   /                 Harbor Burger (food)       kiosk id from VITE_KIOSK_ID
//   /?kind=clinic     Evergreen Family Clinic    clinic-kiosk1
//   /?kind=cinema     Starlight Cinemas          cinema-kiosk1
//   /?kind=transit    MetroLink ticket machine   transit-kiosk1

import type { KioskKind } from "@kiosk-access/shared";

export interface Brand {
  name: string;
  meta: string;
  mark: string;
  color: string;
  dark: string;
  /** What the customer does here, for banners and the QR card. */
  task: string;
  pageTitle: string;
}

export const BRANDS: Record<KioskKind, Brand> = {
  food: { name: "Harbor Burger", meta: "Pickup · Order at the kiosk", mark: "HB", color: "#eb1700", dark: "#c41300", task: "ordering", pageTitle: "Harbor Burger Kiosk" },
  clinic: { name: "Evergreen Family Clinic", meta: "Patient check-in", mark: "EF", color: "#0f766e", dark: "#0b5a54", task: "checking in", pageTitle: "Evergreen Clinic Check-in" },
  cinema: { name: "Starlight Cinemas", meta: "Tickets · Screens 1–8", mark: "SC", color: "#6d28d9", dark: "#5b21b6", task: "buying tickets", pageTitle: "Starlight Cinemas Tickets" },
  transit: { name: "MetroLink", meta: "Ticket machine · Westlake Station", mark: "ML", color: "#047857", dark: "#065f46", task: "buying a ticket", pageTitle: "MetroLink Ticket Machine" },
};

const requested = new URLSearchParams(window.location.search).get("kind");
export const kind: KioskKind =
  requested === "clinic" || requested === "cinema" || requested === "transit" ? requested : "food";

export const brand = BRANDS[kind];

export const kioskId =
  kind === "food" ? (import.meta.env.VITE_KIOSK_ID ?? "store42-kiosk1") : `${kind}-kiosk1`;
