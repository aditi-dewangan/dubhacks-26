import assert from "node:assert/strict";
import { test } from "node:test";
import { fixtures } from "@kiosk-access/shared";
import { greeting, kioskKind, placeName, WELCOME } from "../../../phone/src/greeting.ts";

// The phone starts greeting the moment it connects, before the kiosk's first screen arrives.
// Which kiosk it is must come from the kiosk id (the QR or code), not default to food.

test("the kiosk id decides the kind until the kiosk reports its own screen", () => {
  assert.equal(kioskKind(null, "store42-kiosk1"), "food");
  assert.equal(kioskKind(null, "cinema-kiosk1"), "cinema");
  assert.equal(kioskKind(null, "clinic-kiosk1"), "clinic");
  assert.equal(kioskKind(null, "transit-kiosk1"), "transit");
  assert.equal(kioskKind(null, null), "food");
  assert.equal(kioskKind({ ...fixtures.menuState, kind: "cinema" }, "store42-kiosk1"), "cinema", "the kiosk's own report wins");
});

test("a cinema, clinic or transit QR never greets as the restaurant", () => {
  assert.match(greeting(null, null, "cinema-kiosk1"), /^Welcome to AMC Theaters/);
  assert.match(greeting(null, null, "clinic-kiosk1"), /^Welcome to Seattle Children's Hospital/);
  assert.match(greeting(null, null, "transit-kiosk1"), /^Welcome to Light Rail/);
  assert.match(greeting(null, null, "store42-kiosk1"), /^Welcome to Raising Cane's. We have combos, chicken, sides and drinks/);
  for (const id of ["cinema-kiosk1", "clinic-kiosk1", "transit-kiosk1"]) assert.doesNotMatch(greeting(null, null, id), /Cane/);
});

test("the welcome screen and the start question match the kiosk", () => {
  assert.equal(placeName(null, "cinema-kiosk1"), "AMC Theaters");
  assert.match(WELCOME.cinema.question, /movie tickets/);
  assert.match(WELCOME.clinic.heading, /check in/);
  assert.doesNotMatch(Object.values(WELCOME.cinema).join(" "), /Cane|burger/i);
});

test("a saved name is used at every kind, and 'same as last time' is only offered at the restaurant", () => {
  const sam = { profileId: "p", visits: 2, returning: true, preferences: { name: "Sam" }, lastOrder: { spoken: "a box combo", total: 14.85, at: "2026-10-18T00:00:00Z" } };
  assert.equal(greeting(null, sam, "store42-kiosk1"), "Welcome back, Sam, to Raising Cane's! Last time you had a box combo. Would you like the same as last time?");
  assert.match(greeting(null, sam, "cinema-kiosk1"), /^Hi Sam! Welcome to AMC Theaters/);
  assert.doesNotMatch(greeting(null, sam, "cinema-kiosk1"), /same as last time/);
});
