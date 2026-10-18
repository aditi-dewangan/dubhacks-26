import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";
import { postgresPersistence, type Queryable } from "./persistence.ts";
import { createProfileStore } from "./store.ts";

// pg-mem runs the same SQL as Postgres in memory, so these exercise the real queries.
function database(): Queryable {
  const { Pool } = newDb().adapters.createPg();
  return new Pool() as unknown as Queryable;
}

const shake = { itemId: "vanilla_shake", name: "Vanilla Shake", qty: 1, options: { size: ["large"] } };

describe("profiles in Postgres", () => {
  it("creates the table and starts empty", async () => {
    const store = createProfileStore({ persistence: postgresPersistence(database()) });
    await store.load();
    expect(store.size()).toBe(0);
  });

  it("keeps profiles, visits and saved orders across a server restart", async () => {
    const db = database();
    const before = createProfileStore({ persistence: postgresPersistence(db) });
    await before.load();
    const { profile, token } = before.create();
    before.attach("s1", profile);
    before.saveOrder("s1", { kioskId: "store42-kiosk1", lines: [shake], total: 5.49 });
    await before.flush();

    const after = createProfileStore({ persistence: postgresPersistence(db) });
    await after.load();
    const again = after.verify(token);
    expect(again?.profileId).toBe(profile.profileId);
    expect(again?.visits).toBe(1);
    expect(after.lastOrder(again!, "store42-kiosk2")).toMatchObject({ place: "store42", total: 5.49, lines: [shake] });
    expect(after.verify(`${profile.profileId}.wrong`)).toBeNull();
  });

  it("updates the same row instead of adding duplicates", async () => {
    const db = database();
    const store = createProfileStore({ persistence: postgresPersistence(db) });
    await store.load();
    const { profile } = store.create();
    store.attach("s1", profile);
    store.attach("s2", profile);
    await store.flush();
    const { rows } = await db.query("SELECT profile_id, visits FROM profiles");
    expect(rows).toEqual([{ profile_id: profile.profileId, visits: 2 }]);
  });

  it("never stores the secret, only its hash", async () => {
    const db = database();
    const store = createProfileStore({ persistence: postgresPersistence(db) });
    await store.load();
    const { token } = store.create();
    await store.flush();
    const { rows } = await db.query("SELECT * FROM profiles");
    expect(JSON.stringify(rows)).not.toContain(token.split(".")[1]);
  });

  it("keeps working in memory if the database is unreachable", async () => {
    const broken: Queryable = { query: async () => { throw new Error("connection refused"); } };
    const store = createProfileStore({ persistence: postgresPersistence(broken) });
    await store.load(); // logs, doesn't throw
    const { token } = store.create();
    await store.flush(); // the failed write is logged, not thrown
    expect(store.verify(token)).not.toBeNull();
  });
});
