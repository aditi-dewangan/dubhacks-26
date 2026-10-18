import { menu, type KioskState } from "@kiosk-access/shared";

const list = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : xs.join(""));

/** What the assistant says first, right after the customer taps to start. Short: the sections, then one question. */
export function greeting(state: KioskState | null): string {
  switch (state?.kind ?? "food") {
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
