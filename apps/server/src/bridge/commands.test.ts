import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandAck, CommandEnvelope, KioskState } from "@kiosk-access/shared";
import { createCommandSender, KIOSK_NO_RESPONSE, KIOSK_OFFLINE, SESSION_ENDED } from "./commands.ts";

const state = { kioskId: "k1", screen: "menu", title: "", buttons: [], cart: { lines: [], subtotal: 0, tax: 0, total: 0 }, sessionActive: true } satisfies KioskState;

function harness(online = true) {
  let ackHandler!: (ack: CommandAck, kioskId: string) => void;
  const sent: CommandEnvelope[] = [];
  let n = 0;
  const sender = createCommandSender({
    sendToKiosk: (_k, env) => (online ? (sent.push(env), true) : false),
    onKioskAck: (h) => ((ackHandler = h), () => {}),
    timeoutMs: 10_000,
    newId: () => `c${++n}`,
  });
  const ack = (cmdId: string, kioskId = "k1") => ackHandler({ cmdId, ok: true, state }, kioskId);
  return { sender, sent, ack };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("sendCommand", () => {
  it("resolves with the matching ack", async () => {
    const t = harness();
    const p = t.sender.sendCommand("k1", "s1", { type: "cancel_order" });
    expect(t.sent[0]).toEqual({ cmdId: "c1", sessionId: "s1", command: { type: "cancel_order" } });
    t.ack("c1");
    await expect(p).resolves.toMatchObject({ cmdId: "c1", ok: true });
  });

  it("times out with \"The kiosk didn't respond.\"", async () => {
    const t = harness();
    const p = t.sender.sendCommand("k1", "s1", { type: "cancel_order" });
    const check = expect(p).rejects.toThrow(KIOSK_NO_RESPONSE);
    vi.advanceTimersByTime(10_000);
    await check;
  });

  it("ignores a late ack and acks for unknown cmdIds", async () => {
    const t = harness();
    const p1 = t.sender.sendCommand("k1", "s1", { type: "cancel_order" });
    const check = expect(p1).rejects.toThrow(KIOSK_NO_RESPONSE);
    vi.advanceTimersByTime(10_000);
    await check;

    const p2 = t.sender.sendCommand("k1", "s1", { type: "remove_item", lineId: "L1" });
    t.ack("c1"); // late ack for the timed-out command
    t.ack("nope"); // never sent
    t.ack("c2", "other-kiosk"); // right id, wrong kiosk
    expect(t.sender.pendingCount()).toBe(1);
    t.ack("c2");
    await expect(p2).resolves.toMatchObject({ cmdId: "c2" });
  });

  it("starts the timeout only when a queued command reaches the front", async () => {
    const t = harness();
    const first = t.sender.sendCommand("k1", "s1", { type: "add_item", itemId: "cookie", qty: 1, options: {} });
    const second = t.sender.sendCommand("k1", "s1", { type: "cancel_order" });
    let secondDone = false;
    second.then(() => (secondDone = true), () => (secondDone = true));

    vi.advanceTimersByTime(9_000); // the first command is still being tapped through
    t.ack("c1");
    await expect(first).resolves.toMatchObject({ cmdId: "c1" });

    vi.advanceTimersByTime(9_000); // 18 s after it was sent, but only 9 s at the front
    await Promise.resolve();
    expect(secondDone).toBe(false);

    const check = expect(second).rejects.toThrow(KIOSK_NO_RESPONSE);
    vi.advanceTimersByTime(1_000);
    await check;
  });

  it("fails fast when the kiosk is offline", async () => {
    const t = harness(false);
    await expect(t.sender.sendCommand("k1", "s1", { type: "cancel_order" })).rejects.toThrow(KIOSK_OFFLINE);
    expect(t.sender.pendingCount()).toBe(0);
  });

  it("fails pending commands when the session ends", async () => {
    const t = harness();
    const p = t.sender.sendCommand("k1", "s1", { type: "cancel_order" });
    t.sender.cancelSession("s1");
    await expect(p).rejects.toThrow(SESSION_ENDED);
  });

  it("refuses start_payment", async () => {
    const t = harness();
    // @ts-expect-error start_payment is not a SafeCommand
    await expect(t.sender.sendCommand("k1", "s1", { type: "start_payment" })).rejects.toThrow(/payment gate/);
    expect(t.sent).toHaveLength(0);
  });

  it("refuses final buttons: pay, the card reader and Complete check-in", async () => {
    const t = harness();
    for (const buttonId of ["btn-pay", "btn-card-tap", "btn-submit"]) {
      await expect(t.sender.sendCommand("k1", "s1", { type: "press", buttonId })).rejects.toThrow();
    }
    expect(t.sent).toHaveLength(0);
  });
});
