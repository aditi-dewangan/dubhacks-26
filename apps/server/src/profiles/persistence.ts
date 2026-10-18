// Where profiles are kept. Postgres when DATABASE_URL is set (Render), a JSON file otherwise
// (laptops, so nobody has to install a database to run the server).

import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import type { Profile } from "./store.ts";

export interface ProfilePersistence {
  /** Shown in the startup log. */
  readonly name: string;
  load(): Promise<Profile[]>;
  /** Called after every change to one profile; `all` is every profile, for whole-file stores. */
  save(changed: Profile, all: Profile[]): Promise<void>;
}

/** Profiles in a JSON file, written to a temp file and renamed into place so it's never half-written. */
export function filePersistence(file: string): ProfilePersistence {
  return {
    name: `file ${file}`,
    async load() {
      if (!existsSync(file)) return [];
      return JSON.parse(await readFile(file, "utf8")) as Profile[];
    },
    async save(_changed, all) {
      await writeFile(`${file}.tmp`, JSON.stringify(all, null, 2));
      await rename(`${file}.tmp`, file);
    },
  };
}

/** The part of a pg Pool (or a test double) this needs. */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** One row per phone; saved orders as JSON. The table is created on first use. */
export function postgresPersistence(db: Queryable): ProfilePersistence {
  let ready: Promise<unknown> | null = null;
  const ensureTable = () => (ready ??= (async () => {
    const { rows } = await db.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'profiles'");
    if (rows.length) return;
    await db.query(`
      CREATE TABLE IF NOT EXISTS profiles (
        profile_id   TEXT PRIMARY KEY,
        secret_hash  TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        visits       INTEGER NOT NULL DEFAULT 0,
        orders       JSONB NOT NULL DEFAULT '[]'
      )`);
  })());

  return {
    name: "postgres",
    async load() {
      await ensureTable();
      const { rows } = await db.query("SELECT profile_id, secret_hash, created_at, last_seen_at, visits, orders FROM profiles");
      return rows.map((r) => ({
        profileId: String(r.profile_id),
        secretHash: String(r.secret_hash),
        createdAt: String(r.created_at),
        lastSeenAt: String(r.last_seen_at),
        visits: Number(r.visits),
        orders: (typeof r.orders === "string" ? JSON.parse(r.orders) : r.orders) as Profile["orders"],
      }));
    },
    async save(p) {
      await ensureTable();
      await db.query(
        `INSERT INTO profiles (profile_id, secret_hash, created_at, last_seen_at, visits, orders)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (profile_id) DO UPDATE SET
           last_seen_at = EXCLUDED.last_seen_at, visits = EXCLUDED.visits, orders = EXCLUDED.orders`,
        [p.profileId, p.secretHash, p.createdAt, p.lastSeenAt, p.visits, JSON.stringify(p.orders ?? [])],
      );
    },
  };
}
