import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProfileRoutes } from "./routes.ts";
import { createProfileStore, type ProfileStore } from "./store.ts";

let server: Server;
let base: string;
let store: ProfileStore;
let file: string;
const sessions = new Map<string, { sessionSecret: string; ended: boolean }>();

beforeEach(async () => {
  file = join(mkdtempSync(join(tmpdir(), "profiles-")), "profiles.json");
  store = createProfileStore({ file });
  sessions.clear();
  sessions.set("s1", { sessionSecret: "secret-1", ended: false });
  const app = express();
  app.use(express.json());
  app.use(createProfileRoutes({ store, getSession: (id) => sessions.get(id) }));
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterEach(() => new Promise<void>((r) => server.close(() => r())));

const call = (path: string, opts: { token?: string; body?: unknown; method?: string } = {}) =>
  fetch(`${base}${path}`, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers: { "content-type": "application/json", ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

async function newProfile() {
  const res = await call("/api/profiles", { method: "POST" });
  expect(res.status).toBe(201);
  return (await res.json()) as { profileId: string; profileToken: string; visits: number; returning: boolean };
}

describe("remember this phone", () => {
  it("creates a profile and recognises its token", async () => {
    const p = await newProfile();
    expect(p).toMatchObject({ visits: 0, returning: false });
    expect(p.profileToken.startsWith(`${p.profileId}.`)).toBe(true);
    const me = await call("/api/profiles/me", { token: p.profileToken });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ profileId: p.profileId, visits: 0 });
  });

  it("rejects a wrong, tampered or missing token", async () => {
    const p = await newProfile();
    const [id, secret] = p.profileToken.split(".");
    for (const token of [undefined, "nope", `${id}.wrong`, `${id}.${secret}x`, `other.${secret}`]) {
      expect((await call("/api/profiles/me", { token })).status).toBe(401);
    }
  });

  it("never stores or returns the secret in plain text", async () => {
    const p = await newProfile();
    await store.flush();
    const saved = readFileSync(file, "utf8");
    const secret = p.profileToken.split(".")[1];
    expect(saved).not.toContain(secret);
    expect(saved).toContain(p.profileId);
    const me = await (await call("/api/profiles/me", { token: p.profileToken })).json();
    expect(JSON.stringify(me)).not.toContain("secretHash");
  });

  it("attaches to a session only with the session's secret, and counts visits", async () => {
    const p = await newProfile();
    expect((await call("/api/profiles/attach", { token: p.profileToken, body: { sessionId: "s1", sessionSecret: "wrong" } })).status).toBe(403);
    expect((await call("/api/profiles/attach", { token: p.profileToken, body: { sessionId: "nope", sessionSecret: "x" } })).status).toBe(403);
    expect((await call("/api/profiles/attach", { token: "bad.token", body: { sessionId: "s1", sessionSecret: "secret-1" } })).status).toBe(401);

    const first = await call("/api/profiles/attach", { token: p.profileToken, body: { sessionId: "s1", sessionSecret: "secret-1" } });
    expect(await first.json()).toMatchObject({ visits: 1, returning: false });
    expect(store.forSession("s1")?.profileId).toBe(p.profileId);

    // Attaching the same session again doesn't count twice; a new session does.
    await call("/api/profiles/attach", { token: p.profileToken, body: { sessionId: "s1", sessionSecret: "secret-1" } });
    sessions.set("s2", { sessionSecret: "secret-2", ended: false });
    const second = await call("/api/profiles/attach", { token: p.profileToken, body: { sessionId: "s2", sessionSecret: "secret-2" } });
    expect(await second.json()).toMatchObject({ visits: 2, returning: true });
  });

  it("refuses an ended session", async () => {
    const p = await newProfile();
    sessions.set("s1", { sessionSecret: "secret-1", ended: true });
    expect((await call("/api/profiles/attach", { token: p.profileToken, body: { sessionId: "s1", sessionSecret: "secret-1" } })).status).toBe(403);
  });

  it("remembers profiles across a server restart", async () => {
    const p = await newProfile();
    await store.flush();
    const restarted = createProfileStore({ file });
    expect(restarted.verify(p.profileToken)?.profileId).toBe(p.profileId);
    expect(restarted.verify(`${p.profileId}.wrong`)).toBeNull();
  });
});
