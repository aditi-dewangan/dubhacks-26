import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server, type Socket } from "socket.io";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandAck, KioskState } from "@kiosk-access/shared";
import { AccessKiosk, type ConnectionStatus } from "./index.ts";

// A tiny stand-in for the realtime server: it checks the key and, like the real one,
// only listens for kiosk:state and kiosk:ack after a successful kiosk:register.

const state = (title: string): KioskState => ({
  kioskId: "k1",
  screen: "menu",
  title,
  buttons: [],
  cart: { lines: [], subtotal: 0, tax: 0, total: 0 },
  sessionActive: false,
});

let io: Server;
let url: string;
let kiosk: AccessKiosk | null;
let sockets: Socket[];
let registers: number;
let states: KioskState[];
let acks: CommandAck[];

beforeEach(async () => {
  const http = createServer();
  io = new Server(http);
  sockets = [];
  registers = 0;
  states = [];
  acks = [];
  io.on("connection", (socket) => {
    socket.on("kiosk:register", (reg, done) => {
      registers++;
      if (reg.kioskKey !== "key") return done({ ok: false, error: "bad key" });
      sockets.push(socket);
      socket.on("kiosk:state", (s) => states.push(s));
      socket.on("kiosk:ack", (a) => acks.push(a));
      done({ ok: true });
      socket.emit("kiosk:pairing-code", { url: "https://phone/k/k1?t=abc", expiresAt: Date.now() + 90_000 });
    });
  });
  await new Promise<void>((r) => http.listen(0, r));
  url = `http://localhost:${(http.address() as AddressInfo).port}`;
  kiosk = null;
});

afterEach(async () => {
  kiosk?.disconnect();
  await new Promise<void>((r) => io.close(() => r()));
});

const connect = (kioskKey = "key") => {
  kiosk = AccessKiosk.connect({ serverUrl: url, kioskId: "k1", kioskKey });
  return kiosk;
};

const waitForStatus = (k: AccessKiosk, want: ConnectionStatus) =>
  new Promise<void>((resolve) => {
    const off = k.onStatus((s) => {
      if (s === want) {
        queueMicrotask(() => off());
        resolve();
      }
    });
  });

describe("AccessKiosk", () => {
  it("registers and hands over the pairing URL", async () => {
    const k = connect();
    const urlSeen = new Promise<string>((r) => k.onPairingCode(r));
    await waitForStatus(k, "online");
    expect(await urlSeen).toBe("https://phone/k/k1?t=abc");
    expect(registers).toBe(1);
  });

  it("reports a rejected key", async () => {
    const k = connect("wrong");
    await waitForStatus(k, "rejected");
  });

  it("debounces publishState and sends only the latest state", async () => {
    const k = connect();
    await waitForStatus(k, "online");
    k.publishState(state("a"));
    k.publishState(state("b"));
    k.publishState(state("c"));
    await vi.waitFor(() => expect(states.length).toBe(1));
    await new Promise((r) => setTimeout(r, 200));
    expect(states.map((s) => s.title)).toEqual(["c"]);
  });

  it("runs commands one at a time and acks each with its cmdId", async () => {
    const k = connect();
    const order: string[] = [];
    k.onCommand(async (cmd) => {
      order.push(`start ${cmd.type}`);
      await new Promise((r) => setTimeout(r, 30));
      order.push(`end ${cmd.type}`);
      return cmd.type === "cancel_order"
        ? { ok: false, error: "Nothing to cancel.", state: state("menu") }
        : { ok: true, state: state("cart") };
    });
    await waitForStatus(k, "online");
    sockets[0].emit("kiosk:command", { cmdId: "c1", sessionId: "s", command: { type: "remove_item", lineId: "L1" } });
    sockets[0].emit("kiosk:command", { cmdId: "c2", sessionId: "s", command: { type: "cancel_order" } });
    await vi.waitFor(() => expect(acks.length).toBe(2));
    expect(order).toEqual(["start remove_item", "end remove_item", "start cancel_order", "end cancel_order"]);
    expect(acks[0]).toMatchObject({ cmdId: "c1", ok: true });
    expect(acks[1]).toMatchObject({ cmdId: "c2", ok: false, error: "Nothing to cancel." });
  });

  it("turns a throwing handler into a failed ack", async () => {
    const k = connect();
    k.onCommand(async () => {
      throw new Error("Size is required: regular or large.");
    });
    await waitForStatus(k, "online");
    sockets[0].emit("kiosk:command", { cmdId: "c1", sessionId: "s", command: { type: "cancel_order" } });
    await vi.waitFor(() => expect(acks.length).toBe(1));
    expect(acks[0]).toMatchObject({ cmdId: "c1", ok: false, error: "Size is required: regular or large." });
    expect(acks[0].state.kioskId).toBe("k1");
  });

  it("re-acks a repeated cmdId instead of running it twice", async () => {
    const k = connect();
    const handler = vi.fn(async () => ({ ok: true, state: state("cart") }));
    k.onCommand(handler);
    await waitForStatus(k, "online");
    const env = { cmdId: "c1", sessionId: "s", command: { type: "cancel_order" as const } };
    sockets[0].emit("kiosk:command", env);
    await vi.waitFor(() => expect(acks.length).toBe(1));
    sockets[0].emit("kiosk:command", env);
    await vi.waitFor(() => expect(acks.length).toBe(2));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("re-registers after a dropped connection without duplicate listeners", async () => {
    const k = connect();
    const handler = vi.fn(async () => ({ ok: true, state: state("cart") }));
    k.onCommand(handler);
    const pairing = vi.fn();
    k.onPairingCode(pairing);
    await waitForStatus(k, "online");

    sockets[0].conn.close(); // network drop: the client reconnects on its own
    await waitForStatus(k, "offline");
    await waitForStatus(k, "online");
    expect(registers).toBe(2);

    sockets[1].emit("kiosk:command", { cmdId: "c9", sessionId: "s", command: { type: "cancel_order" } });
    await vi.waitFor(() => expect(acks.length).toBe(1));
    await new Promise((r) => setTimeout(r, 100));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(acks).toHaveLength(1);
    expect(pairing).toHaveBeenCalledTimes(2); // once per registration, not doubled
  });

  it("holds an ack finished while offline and sends it after re-registering", async () => {
    const k = connect();
    let release!: () => void;
    k.onCommand(() => new Promise((r) => (release = () => r({ ok: true, state: state("cart") }))));
    await waitForStatus(k, "online");
    sockets[0].emit("kiosk:command", { cmdId: "c1", sessionId: "s", command: { type: "cancel_order" } });
    await vi.waitFor(() => expect(release).toBeDefined());

    sockets[0].conn.close();
    await waitForStatus(k, "offline");
    release(); // the command finishes while the kiosk is offline
    await waitForStatus(k, "online");
    await vi.waitFor(() => expect(acks.map((a) => a.cmdId)).toEqual(["c1"]));
  });

  it("republishes the latest state after reconnecting", async () => {
    const k = connect();
    await waitForStatus(k, "online");
    k.publishState(state("cart"));
    await vi.waitFor(() => expect(states.length).toBe(1));
    sockets[0].conn.close();
    await waitForStatus(k, "offline");
    await waitForStatus(k, "online");
    await vi.waitFor(() => expect(states.map((s) => s.title)).toEqual(["cart", "cart"]));
  });

  it("forwards session events and ends the session on request", async () => {
    const k = connect();
    const seen: boolean[] = [];
    k.onSession((s) => seen.push(s.active));
    await waitForStatus(k, "online");
    const ended = new Promise<void>((r) => sockets[0].on("kiosk:end-session", () => r()));
    sockets[0].emit("session:started", { sessionId: "s", active: true });
    await vi.waitFor(() => expect(seen).toEqual([true]));
    k.endSession();
    await ended;
    sockets[0].emit("session:ended", { sessionId: "s", active: false, reason: "staff_ended" });
    await vi.waitFor(() => expect(seen).toEqual([true, false]));
  });
});
