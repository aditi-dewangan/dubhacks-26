// REST routes for "remember this phone". The phone sends its profile token as
// "Authorization: Bearer <token>"; the token is never logged.

import { timingSafeEqual } from "node:crypto";
import { Router, type Request } from "express";
import type { Profile, ProfileStore } from "./store.ts";

export interface ProfileRouteDeps {
  store: ProfileStore;
  getSession(sessionId: string): { sessionSecret: string; ended: boolean } | undefined;
}

const bearer = (req: Request) => req.get("authorization")?.match(/^Bearer (.+)$/)?.[1];

/** What the phone may see about its own profile. Never the hash. */
const view = (p: Profile) => ({ profileId: p.profileId, createdAt: p.createdAt, visits: p.visits, returning: p.visits > 1 });

function sameSecret(a: string, b: unknown) {
  if (typeof b !== "string") return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createProfileRoutes({ store, getSession }: ProfileRouteDeps) {
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
    res.json(view(store.attach(sessionId as string, profile)));
  });

  return routes;
}
