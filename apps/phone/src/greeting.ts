import { kindFromKioskId, menu, type KioskState } from "@kiosk-access/shared";

/** The part of a phone's profile the greeting uses (the full PhoneProfile satisfies this). */
export interface GreetingProfile {
  preferences?: { name?: string };
  lastOrder?: { spoken: string } | null;
}

const list = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : xs.join(""));

const PLACES = { food: "Raising Cane's", clinic: "Evergreen Family Clinic", cinema: "Starlight Cinemas", transit: "MetroLink" } as const;
export type Kind = keyof typeof PLACES;

/**
 * Which kind of kiosk this is. The kiosk's own screen is the best source, but it arrives a moment
 * after the phone connects, so until then the kiosk id (known from the QR or code) decides.
 */
export function kioskKind(state: KioskState | null, kioskId?: string | null): Kind {
  if (state?.kind) return state.kind;
  return kioskId ? kindFromKioskId(kioskId) : "food";
}

/** The name of the place this kiosk belongs to. */
export const placeName = (state: KioskState | null, kioskId?: string | null) => PLACES[kioskKind(state, kioskId)];
export const placeNameForKind = (kind: string | undefined) => PLACES[(kind ?? "food") as Kind] ?? PLACES.food;

/** Wording that changes with the kind of kiosk. */
export const WELCOME: Record<Kind, { heading: string; sub: string; start: string; question: string }> = {
  food: {
    heading: "Hi! Ready to order?",
    sub: "Just talk. I'll tap through the kiosk for you and read everything back before you pay.",
    start: "Start ordering",
    question: "Do you want to start ordering?",
  },
  clinic: {
    heading: "Hi! Ready to check in?",
    sub: "Just talk. I'll fill in the check-in screens for you and read your details back before anything is submitted.",
    start: "Start check-in",
    question: "Do you want to check in for your appointment?",
  },
  cinema: {
    heading: "Hi! Ready for a movie?",
    sub: "Just talk. I'll pick the movie, showtime and seats on the kiosk and read it all back before you pay.",
    start: "Start booking",
    question: "Do you want to buy movie tickets?",
  },
  transit: {
    heading: "Hi! Where to?",
    sub: "Just talk. I'll set up your ticket on the kiosk and read it back before you pay.",
    start: "Start my ticket",
    question: "Do you want to buy a ticket?",
  },
};

/** Did the customer say yes to "Do you want to start ordering?" */
export function wantsToStart(answer: string): boolean {
  const a = answer.toLowerCase();
  return /\b(yes|yeah|yep|yup|sure|ok|okay|start|ready|let'?s go|go ahead|please|i do|of course)\b/.test(a) &&
    !/\b(no|nope|not|don'?t|wait|later)\b/.test(a);
}

/** What the assistant says first, right after the customer says yes. Short: what it can do, then one question. */
export function greeting(state: KioskState | null, profile?: GreetingProfile | null, kioskId?: string | null): string {
  const kind = kioskKind(state, kioskId);
  const name = profile?.preferences?.name;
  // A returning customer at the same restaurant: offer their last order.
  if (profile?.lastOrder?.spoken && kind === "food") {
    return `Welcome back${name ? `, ${name}` : ""}, to ${PLACES[kind]}! Last time you had ${profile.lastOrder.spoken}. Would you like the same as last time?`;
  }
  const hello = (() => {
    switch (kind) {
      case "clinic":
        return "Welcome to Evergreen Family Clinic. I can help you check in for your appointment. Shall we start?";
      case "cinema":
        return "Welcome to Starlight Cinemas. I can help you pick a movie, a showtime and seats. What would you like to see?";
      case "transit":
        return "Welcome to MetroLink. I can help you buy a ticket. Where are you going today?";
      default:
        return `Welcome to Raising Cane's. We have ${list(menu.categories.map((c) => c.name.toLowerCase()))}. What would you like to have today?`;
    }
  })();
  return name ? `Hi ${name}! ${hello}` : hello;
}
