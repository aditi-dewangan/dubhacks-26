// Public surface of "remember this phone": recognising a returning customer and their
// last order at this restaurant, so the assistant can offer "the same again?".

import { describeLine } from "../bridge/spoken.ts";
import { getSession, onKioskStateChange, onSessionEnded } from "../realtime/index.ts";
import { createProfileRoutes } from "./routes.ts";
import { createProfileStore, type Profile, type SavedOrder } from "./store.ts";

export type { Profile, SavedOrder } from "./store.ts";

const store = createProfileStore({ file: process.env.PROFILES_FILE ?? "profiles.json" });

/** "a double cheeseburger and 1 large vanilla shake" */
export function describeOrder(order: SavedOrder): string {
  // "1 large vanilla shake" reads better aloud as "a large vanilla shake".
  const parts = order.lines.map((l) => describeLine(l).replace(/^1 (?=[aeiou])/i, "an ").replace(/^1 /, "a "));
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts.join("");
}

// Remember an order once it's paid (the kiosk reaches its complete screen during a session).
onKioskStateChange((kioskId, prev, next, session) => {
  if (!session || next.screen !== "complete" || prev?.screen === "complete" || !next.cart.lines.length) return;
  store.saveOrder(session.sessionId, {
    kioskId,
    lines: next.cart.lines.map(({ itemId, name, qty, options }) => ({ itemId, name, qty, options })),
    total: next.cart.total,
  });
});

onSessionEnded((session) => store.detach(session.sessionId));

export const profileRoutes = createProfileRoutes({ store, getSession, describeOrder });

/** The returning customer's profile for this ordering session, or null. */
export function profileForSession(sessionId: string): Profile | null {
  return store.forSession(sessionId);
}

/** Their last completed order at this session's restaurant, or null. */
export function lastOrderForSession(sessionId: string): SavedOrder | null {
  const profile = store.forSession(sessionId);
  const session = getSession(sessionId);
  return profile && session ? store.lastOrder(profile, session.kioskId) : null;
}
