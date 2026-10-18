// Which kiosk this page is. One build serves all four demo kiosks:
//   /                 Raising Cane's (food)      kiosk id from VITE_KIOSK_ID
//   /?kind=clinic     Seattle Children's         clinic-kiosk1
//   /?kind=cinema     AMC Theaters               cinema-kiosk1
//   /?kind=transit    Light Rail ticket machine  transit-kiosk1

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
  food: { name: "Raising Cane's", meta: "Chicken fingers · Order at the kiosk", mark: "RC", color: "#c8102e", dark: "#a00d25", task: "ordering", pageTitle: "Raising Cane's Kiosk" },
  clinic: { name: "Seattle Children's Hospital", meta: "Patient check-in", mark: "SC", color: "#0077C8", dark: "#005fa3", task: "checking in", pageTitle: "Seattle Children's Check-in" },
  cinema: { name: "AMC Theaters", meta: "Tickets · Screens 1–8", mark: "AMC", color: "#CC0000", dark: "#a80000", task: "buying tickets", pageTitle: "AMC Theaters Tickets" },
  transit: { name: "Light Rail", meta: "Ticket machine · Westlake Station", mark: "LR", color: "#047857", dark: "#065f46", task: "buying a ticket", pageTitle: "Light Rail Ticket Machine" },
};

const requested = new URLSearchParams(window.location.search).get("kind");
export const kind: KioskKind =
  requested === "clinic" || requested === "cinema" || requested === "transit" ? requested : "food";

export const brand = BRANDS[kind];

export const kioskId =
  kind === "food" ? (import.meta.env.VITE_KIOSK_ID ?? "store42-kiosk1") : `${kind}-kiosk1`;
