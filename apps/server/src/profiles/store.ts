// "Remember this phone": a returning customer is recognised without any login screen.
// The first visit creates a profile; the phone keeps its token (profileId.secret) in the
// browser and sends it on later visits. Only a hash of the secret is stored.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";

export interface Profile {
  profileId: string;
  secretHash: string;
  createdAt: string;
  lastSeenAt: string;
  /** Ordering sessions this phone has started, including the current one. */
  visits: number;
  /** Completed orders, newest last (a few per place). */
  orders?: SavedOrder[];
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

export function createProfileStore(opts: { file?: string; now?: () => Date } = {}) {
  const now = opts.now ?? (() => new Date());
  const profiles = new Map<string, Profile>();
  const bySession = new Map<string, string>(); // sessionId -> profileId

  if (opts.file && existsSync(opts.file)) {
    try {
      for (const p of JSON.parse(readFileSync(opts.file, "utf8")) as Profile[]) profiles.set(p.profileId, p);
    } catch (err) {
      console.error("[profiles] couldn't read", opts.file, err);
    }
  }

  // Writes go one at a time, to a temp file renamed into place, so a crash never leaves half a file.
  let writing: Promise<void> = Promise.resolve();
  function save() {
    if (!opts.file) return writing;
    const file = opts.file;
    const body = JSON.stringify([...profiles.values()], null, 2);
    writing = writing
      .then(() => writeFile(`${file}.tmp`, body))
      .then(() => rename(`${file}.tmp`, file))
      .catch((err) => console.error("[profiles] couldn't save", err));
    return writing;
  }

  return {
    /** A new profile. The token is shown to the phone once and never stored in plain text. */
    create(): { profile: Profile; token: string } {
      const secret = randomBytes(32).toString("base64url");
      const at = now().toISOString();
      const profile: Profile = { profileId: randomUUID(), secretHash: hash(secret), createdAt: at, lastSeenAt: at, visits: 0 };
      profiles.set(profile.profileId, profile);
      void save();
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
        void save();
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
      void save();
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
    flush: () => writing,
    size: () => profiles.size,
  };
}

export type ProfileStore = ReturnType<typeof createProfileStore>;
