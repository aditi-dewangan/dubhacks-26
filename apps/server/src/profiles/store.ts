// "Remember this phone": a returning customer is recognised without any login screen.
// The first visit creates a profile; the phone keeps its token (profileId.secret) in the
// browser and sends it on later visits. Only a hash of the secret is stored.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { ProfilePersistence } from "./persistence.ts";

export interface Profile {
  profileId: string;
  secretHash: string;
  createdAt: string;
  lastSeenAt: string;
  /** Ordering sessions this phone has started, including the current one. */
  visits: number;
  /** Completed orders, newest last (a few per place). */
  orders?: SavedOrder[];
  /** What the customer chose to have remembered. */
  preferences?: Preferences;
}

export interface Preferences {
  /** For the greeting: "Welcome back, Sam!" */
  name?: string;
  /** Speaking speed for spoken replies, 0.5 (slow) to 2 (fast). */
  speechRate?: number;
  diet?: Diet[];
  /** In the customer's own words, e.g. "peanuts". The menu has no allergen data, so these are only flagged, never promised. */
  allergies?: string[];
}

export const DIETS = ["vegetarian", "vegan"] as const;
export type Diet = (typeof DIETS)[number];

/** Cleans what the customer (or the model) asked to save. Returns an error to say aloud, or the clean values. */
export function cleanPreferences(raw: unknown): { ok: true; value: Preferences } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Nothing to save." };
  const r = raw as Record<string, unknown>;
  const out: Preferences = {};
  if (r.name !== undefined) {
    const name = typeof r.name === "string" ? r.name.replace(/[^\p{L}\p{M}' .-]/gu, "").trim().slice(0, 40) : "";
    if (!name) return { ok: false, error: "That name didn't sound right. What should I call you?" };
    out.name = name;
  }
  if (r.speechRate !== undefined) {
    const rate = Number(r.speechRate);
    if (!Number.isFinite(rate) || rate < 0.5 || rate > 2) return { ok: false, error: "Speaking speed must be between half speed and double speed." };
    out.speechRate = Math.round(rate * 100) / 100;
  }
  if (r.diet !== undefined) {
    const list = (Array.isArray(r.diet) ? r.diet : [r.diet]).map((d) => String(d).toLowerCase().trim());
    const bad = list.filter((d) => !(DIETS as readonly string[]).includes(d));
    if (bad.length) return { ok: false, error: `I can remember vegetarian or vegan, not "${bad[0]}".` };
    out.diet = [...new Set(list)] as Diet[];
  }
  if (r.allergies !== undefined) {
    const list = (Array.isArray(r.allergies) ? r.allergies : [r.allergies])
      .map((a) => String(a).replace(/[^\p{L}\p{M}' -]/gu, "").trim().toLowerCase().slice(0, 30))
      .filter(Boolean);
    out.allergies = [...new Set(list)].slice(0, 10);
  }
  return { ok: true, value: out };
}

/** A completed order, kept so the customer can reorder it next time at the same place. */
export interface SavedOrder {
  /** The restaurant or location: the kiosk id without its "-kioskN" suffix. */
  place: string;
  kioskId: string;
  at: string;
  lines: { itemId: string; name: string; qty: number; options: Record<string, string[]> }[];
  total: number;
}

const ORDERS_PER_PLACE = 3;

/** "store42-kiosk1" and "store42-kiosk2" are the same restaurant. */
export const placeOf = (kioskId: string) => kioskId.replace(/-kiosk\d+$/i, "");

const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");

function sameHash(a: string, b: string) {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Profiles live in memory for fast, synchronous lookups; every change is written through to
 * the persistence (Postgres or a file) in order. Call load() once at startup.
 */
export function createProfileStore(opts: { persistence?: ProfilePersistence; now?: () => Date } = {}) {
  const now = opts.now ?? (() => new Date());
  const profiles = new Map<string, Profile>();
  const bySession = new Map<string, string>(); // sessionId -> profileId

  // Writes go one at a time, in order, so a later change never lands before an earlier one.
  let writing: Promise<void> = Promise.resolve();
  function save(changed: Profile) {
    const persistence = opts.persistence;
    if (!persistence) return writing;
    const snapshot = structuredClone(changed);
    const all = [...profiles.values()].map((p) => structuredClone(p));
    writing = writing
      .then(() => persistence.save(snapshot, all))
      .catch((err) => console.error(`[profiles] couldn't save to ${persistence.name}`, err));
    return writing;
  }

  return {
    /** Reads every saved profile. Ordering still works if this fails; profiles just start empty. */
    async load() {
      if (!opts.persistence) return;
      try {
        for (const p of await opts.persistence.load()) profiles.set(p.profileId, p);
        console.log(`[profiles] ${profiles.size} profile(s) loaded from ${opts.persistence.name}`);
      } catch (err) {
        console.error(`[profiles] couldn't load from ${opts.persistence.name}`, err);
      }
    },

    /** A new profile. The token is shown to the phone once and never stored in plain text. */
    create(): { profile: Profile; token: string } {
      const secret = randomBytes(32).toString("base64url");
      const at = now().toISOString();
      const profile: Profile = { profileId: randomUUID(), secretHash: hash(secret), createdAt: at, lastSeenAt: at, visits: 0 };
      profiles.set(profile.profileId, profile);
      void save(profile);
      return { profile, token: `${profile.profileId}.${secret}` };
    },

    /** The profile a token belongs to, or null if the token is wrong or unknown. */
    verify(token: unknown): Profile | null {
      if (typeof token !== "string" || token.length > 200) return null;
      const dot = token.indexOf(".");
      if (dot < 1) return null;
      const profile = profiles.get(token.slice(0, dot));
      if (!profile || !sameHash(profile.secretHash, hash(token.slice(dot + 1)))) return null;
      return profile;
    },

    /** Links a profile to an ordering session and counts the visit (once per session). */
    attach(sessionId: string, profile: Profile): Profile {
      if (bySession.get(sessionId) !== profile.profileId) {
        bySession.set(sessionId, profile.profileId);
        profile.visits += 1;
        profile.lastSeenAt = now().toISOString();
        void save(profile);
      }
      return profile;
    },

    /** The profile using this session, if the phone attached one. */
    forSession(sessionId: string): Profile | null {
      const id = bySession.get(sessionId);
      return id ? profiles.get(id) ?? null : null;
    },

    /** Remembers a completed order for the profile using this session. */
    saveOrder(sessionId: string, order: Omit<SavedOrder, "place" | "at">): SavedOrder | null {
      const profile = this.forSession(sessionId);
      if (!profile || !order.lines.length) return null;
      const saved: SavedOrder = { ...order, place: placeOf(order.kioskId), at: now().toISOString() };
      const others = (profile.orders ?? []).filter((o) => o.place !== saved.place);
      const here = (profile.orders ?? []).filter((o) => o.place === saved.place);
      profile.orders = [...others, ...here.slice(-(ORDERS_PER_PLACE - 1)), saved];
      void save(profile);
      return saved;
    },

    /** The most recent completed order at this kiosk's restaurant. */
    lastOrder(profile: Profile, kioskId: string): SavedOrder | null {
      const place = placeOf(kioskId);
      return [...(profile.orders ?? [])].reverse().find((o) => o.place === place) ?? null;
    },

    detach(sessionId: string) {
      bySession.delete(sessionId);
    },

    /** Resolves once pending writes are on disk (for tests). */
    /** Saves the customer's preferences (only the fields given; an empty list clears one). */
    setPreferences(profile: Profile, prefs: Preferences): Profile {
      profile.preferences = { ...profile.preferences, ...prefs };
      void save(profile);
      return profile;
    },

    /** "Forget me": removes the profile and all its history, here and in storage. */
    remove(profile: Profile) {
      profiles.delete(profile.profileId);
      for (const [sessionId, id] of bySession) if (id === profile.profileId) bySession.delete(sessionId);
      const persistence = opts.persistence;
      if (persistence) {
        const all = [...profiles.values()].map((p) => structuredClone(p));
        writing = writing
          .then(() => persistence.remove(profile.profileId, all))
          .catch((err) => console.error(`[profiles] couldn't delete from ${persistence.name}`, err));
      }
      return writing;
    },

    flush: () => writing,
    size: () => profiles.size,
  };
}

export type ProfileStore = ReturnType<typeof createProfileStore>;
