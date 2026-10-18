// Public surface of "remember this phone". The agent and bridge use profileForSession
// to recognise a returning customer; saved orders build on this next.

import { getSession, onSessionEnded } from "../realtime/index.ts";
import { createProfileRoutes } from "./routes.ts";
import { createProfileStore, type Profile } from "./store.ts";

export type { Profile } from "./store.ts";

const store = createProfileStore({ file: process.env.PROFILES_FILE ?? "profiles.json" });

onSessionEnded((session) => store.detach(session.sessionId));

export const profileRoutes = createProfileRoutes({ store, getSession });

/** The returning customer's profile for this ordering session, or null. */
export function profileForSession(sessionId: string): Profile | null {
  return store.forSession(sessionId);
}
