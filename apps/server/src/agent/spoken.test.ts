import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanSpokenReply } from "./spoken.ts";

test("spoken cleanup removes common markdown and emoji but keeps readable text", () => {
  assert.equal(cleanSpokenReply("**Added** the [large burger](https://example.com) 🍔\n- no onions"),
    "Added the large burger no onions");
});

test("spoken cleanup caps long replies at 300 characters on a word boundary", () => {
  const cleaned = cleanSpokenReply(`${"cheeseburger ".repeat(30)}and fries`);
  assert.ok(cleaned.length <= 300);
  assert.ok(cleaned.endsWith("…"));
  assert.ok(!cleaned.slice(0, -1).endsWith(" "));
});

test("short replies and empty replies remain stable", () => {
  assert.equal(cleanSpokenReply("That's right."), "That's right.");
  assert.equal(cleanSpokenReply("  \n  "), "");
});
