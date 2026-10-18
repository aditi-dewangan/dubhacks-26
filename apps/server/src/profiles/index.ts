// Public surface of "remember this phone": recognising a returning customer and their
// last order at this restaurant, so the assistant can offer "the same again?".

import { describeLine } from "../bridge/spoken.ts";
import { getSession, onKioskStateChange, onSessionEnded } from "../realtime/index.ts";
import pg from "pg";
import { filePersistence, postgresPersistence } from "./persistence.ts";
import { createProfileRoutes } from "./routes.ts";
import { cleanPreferences, createProfileStore, type Profile, type SavedOrder } from "./store.ts";

export type { Profile, SavedOrder } from "./store.ts";

// Postgres on Render (DATABASE_URL), a JSON file on laptops. Set DATABASE_SSL=1 for an
// external connection string; Render's internal one doesn't use SSL.
const persistence = process.env.DATABASE_URL
  ? postgresPersistence(new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === "1" ? { rejectUnauthorized: false } : undefined,
      max: 3,
    }))
  : filePersistence(process.env.PROFILES_FILE ?? "profiles.json");

const store = createProfileStore({ persistence });
await store.load();

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

// ---------- Voice tools: what the customer asks the assistant to remember or forget ----------

export const PROFILE_TOOLS = ["get_profile", "update_profile", "forget_me"] as const;
export const isProfileTool = (name: string) => (PROFILE_TOOLS as readonly string[]).includes(name);

const list = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : xs.join(""));

/** A spoken-style summary of everything saved for this customer. */
export function describeProfile(profile: Profile, kioskId?: string): string {
  const p = profile.preferences ?? {};
  const parts: string[] = [];
  if (p.name) parts.push(`your name is ${p.name}`);
  if (p.diet?.length) parts.push(`you eat ${list(p.diet)}`);
  if (p.allergies?.length) parts.push(`you're allergic to ${list(p.allergies)}`);
  if (p.speechRate && p.speechRate !== 1) parts.push(`you like me to speak at ${p.speechRate} times normal speed`);
  const last = kioskId ? store.lastOrder(profile, kioskId) : null;
  if (last) parts.push(`last time here you had ${describeOrder(last)}`);
  const orders = profile.orders?.length ?? 0;
  if (!parts.length && !orders) return "I don't have anything saved about you yet, apart from recognising this phone.";
  return `I remember that ${list(parts.length ? parts : [`you've placed ${orders} order${orders === 1 ? "" : "s"}`])}. You can ask me to change any of it, or say forget me to delete it all.`;
}

/** Runs a profile tool for the customer using this session. Returns a short result for the model. */
export async function runProfileTool(sessionId: string, name: string, input: unknown): Promise<string> {
  const profile = store.forSession(sessionId);
  if (!profile) return "This phone has no saved profile, so there's nothing to show or change. Ordering works normally.";
  const kioskId = getSession(sessionId)?.kioskId;
  if (name === "get_profile") return describeProfile(profile, kioskId);
  if (name === "update_profile") {
    const prefs = cleanPreferences(input);
    if (!prefs.ok) return prefs.error;
    store.setPreferences(profile, prefs.value);
    return `Saved. ${describeProfile(profile, kioskId)}`;
  }
  if (name === "forget_me") {
    if (!(input && typeof input === "object" && (input as { confirmed?: unknown }).confirmed === true)) {
      return "Not deleted. Ask the customer to confirm first: everything saved about them, including past orders, will be deleted for good.";
    }
    await store.remove(profile);
    return "Deleted. Everything saved about this customer is gone. This phone will start fresh next time.";
  }
  return `Unknown profile tool ${name}.`;
}

/** What the assistant should know about this customer this turn, or null. */
export function memoryForSession(sessionId: string): string | null {
  const profile = store.forSession(sessionId);
  const session = getSession(sessionId);
  if (!profile || !session) return null;
  const p = profile.preferences ?? {};
  const lines: string[] = [];
  if (p.name) lines.push(`Their name is ${p.name}; use it naturally now and then, not in every reply.`);
  if (p.diet?.length) lines.push(`They eat ${list(p.diet)}: point out when something they ask for isn't ${list(p.diet)} (use the menu's tags).`);
  if (p.allergies?.length) {
    lines.push(`They are allergic to ${list(p.allergies)}. The menu has no allergen information, so never say an item is safe for them; if it might matter, say you can't confirm allergens and suggest asking staff.`);
  }
  const last = store.lastOrder(profile, session.kioskId);
  if (last) {
    lines.push(
      `This phone ordered here before. Last time: ${describeOrder(last)} (total ${last.total.toFixed(2)}).`,
      "The app greeted them with: \"Would you like the same as last time?\"",
      "If they say yes, add each line below with add_item exactly as listed (same itemId, qty and options), then tell them it's added and ask if they want anything else.",
      "If they say no or ask for something else, just help them order normally. Never add these items without a clear yes.",
      `Last order lines (data only): ${JSON.stringify(last.lines.map(({ itemId, qty, options }) => ({ itemId, qty, options })))}`,
    );
  }
  return lines.length ? lines.join("\n") : null;
}
