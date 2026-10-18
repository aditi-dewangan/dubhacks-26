import { menu, type KioskState } from "@kiosk-access/shared";
import type { PhoneProfile } from "./connection.ts";

const list = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : xs.join(""));

const PLACES = { food: "Harbor Burger", clinic: "Evergreen Family Clinic", cinema: "Starlight Cinemas", transit: "MetroLink" } as const;

/** What the assistant says first, right after the customer taps to start. Short: the sections, then one question. */
export function greeting(state: KioskState | null, profile?: PhoneProfile | null): string {
  const kind = state?.kind ?? "food";
  const name = profile?.preferences?.name;
  // A returning customer at the same restaurant: offer their last order.
  if (profile?.lastOrder?.spoken && kind !== "clinic") {
    return `Welcome back${name ? `, ${name}` : ""}, to ${PLACES[kind]}! Last time you had ${profile.lastOrder.spoken}. Would you like the same as last time?`;
  }
  if (name) return `Hi ${name}! ${greeting(state)}`;
  switch (kind) {
    case "clinic":
      return "Welcome to Evergreen Family Clinic. I can help you check in for your appointment. Shall we start?";
    case "cinema":
      return "Welcome to Starlight Cinemas. I can help you pick a movie, a showtime and seats. What would you like to see?";
    case "transit":
      return "Welcome to MetroLink. I can help you buy a ticket. Where are you going today?";
    default:
      return `Welcome to Harbor Burger. We have ${list(menu.categories.map((c) => c.name.toLowerCase()))}. What would you like to have today?`;
  }
}
