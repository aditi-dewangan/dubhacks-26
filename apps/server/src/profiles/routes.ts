// REST routes for "remember this phone". The phone sends its profile token as
// "Authorization: Bearer <token>"; the token is never logged.

import { timingSafeEqual } from "node:crypto";
import { Router, type Request } from "express";
import { cleanPreferences, type Profile, type ProfileStore, type SavedOrder } from "./store.ts";

export interface ProfileRouteDeps {
  store: ProfileStore;
  getSession(sessionId: string): { sessionSecret: string; ended: boolean; kioskId: string } | undefined;
  /** "a double cheeseburger and a large vanilla shake" */
  describeOrder?(order: SavedOrder): string;
}

const bearer = (req: Request) => req.get("authorization")?.match(/^Bearer (.+)$/)?.[1];

/** What the phone may see about its own profile. Never the hash. */
const view = (p: Profile) => ({
  profileId: p.profileId, createdAt: p.createdAt, visits: p.visits, returning: p.visits > 1,
  preferences: p.preferences ?? {}, savedOrders: p.orders?.length ?? 0,
});

function sameSecret(a: string, b: unknown) {
  if (typeof b !== "string") return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createProfileRoutes({ store, getSession, describeOrder }: ProfileRouteDeps) {
  const routes = Router();

  // First visit on this phone: make a profile. The token is returned once.
  routes.post("/api/profiles", (_req, res) => {
    const { profile, token } = store.create();
    res.status(201).json({ ...view(profile), profileToken: token });
  });

  // Is this phone's saved token still valid? (A server redeploy can forget profiles.)
  routes.get("/api/profiles/me", (req, res) => {
    const profile = store.verify(bearer(req));
    if (!profile) {
      res.status(401).json({ error: "unknown_profile", message: "This phone's profile isn't recognised." });
      return;
    }
    res.json(view(profile));
  });

  // Save the customer's preferences (name, speaking speed, diet, allergies).
  routes.patch("/api/profiles/me", (req, res) => {
    const profile = store.verify(bearer(req));
    if (!profile) {
      res.status(401).json({ error: "unknown_profile", message: "This phone's profile isn't recognised." });
      return;
    }
    const prefs = cleanPreferences(req.body);
    if (!prefs.ok) {
      res.status(400).json({ error: "bad_request", message: prefs.error });
      return;
    }
    res.json(view(store.setPreferences(profile, prefs.value)));
  });

  // "Forget me": delete the profile and all its history.
  routes.delete("/api/profiles/me", async (req, res) => {
    const profile = store.verify(bearer(req));
    if (!profile) {
      res.status(401).json({ error: "unknown_profile", message: "This phone's profile isn't recognised." });
      return;
    }
    await store.remove(profile);
    res.status(204).end();
  });

  // Link the profile to the ordering session the phone just started. Needs both secrets.
  routes.post("/api/profiles/attach", (req, res) => {
    const profile = store.verify(bearer(req));
    if (!profile) {
      res.status(401).json({ error: "unknown_profile", message: "This phone's profile isn't recognised." });
      return;
    }
    const { sessionId, sessionSecret } = (req.body ?? {}) as { sessionId?: unknown; sessionSecret?: unknown };
    const session = typeof sessionId === "string" ? getSession(sessionId) : undefined;
    if (!session || session.ended || !sameSecret(session.sessionSecret, sessionSecret)) {
      res.status(403).json({ error: "bad_session", message: "That ordering session isn't valid." });
      return;
    }
    store.attach(sessionId as string, profile);
    // Last time at this restaurant, so the phone can offer "the same again?"
    const last = store.lastOrder(profile, session.kioskId);
    res.json({
      ...view(profile),
      lastOrder: last ? { spoken: describeOrder?.(last) ?? last.lines.map((l) => `${l.qty} ${l.name}`).join(" and "), total: last.total, at: last.at } : null,
    });
  });

  return routes;
}
