// A command-line phone for testing without the phone app.
// Usage: pnpm fake-phone [kioskId]     (server needs DEV_ROUTES=1, kiosk must be online)
//
// Type a message and press enter to talk to the agent. Commands:
//   /yes   confirm checkout      /no   don't confirm
//   /ping  ping the kiosk        /end  end the session

import { createInterface } from "node:readline";
import { io, type Socket } from "socket.io-client";
import type { ClientToServerEvents, KioskState, ServerToClientEvents } from "@kiosk-access/shared";

const SERVER = process.env.SERVER_URL ?? `http://localhost:${process.env.PORT ?? 3001}`;
const kioskId = process.argv[2] ?? process.env.VITE_KIOSK_ID ?? "store42-kiosk1";

const codeRes = await fetch(`${SERVER}/api/dev/pairing/${encodeURIComponent(kioskId)}`);
if (!codeRes.ok) {
  console.error(`No pairing code for ${kioskId}. Is the kiosk running and DEV_ROUTES=1 set?`);
  process.exit(1);
}
const { token } = (await codeRes.json()) as { token: string };

const sessionRes = await fetch(`${SERVER}/api/sessions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ kioskId, token }),
});
const session = await sessionRes.json();
if (!sessionRes.ok) {
  console.error("Could not start a session:", session.message ?? session);
  process.exit(1);
}

const phone: Socket<ServerToClientEvents, ClientToServerEvents> = io(SERVER, {
  auth: { role: "phone", sessionId: session.sessionId, sessionSecret: session.sessionSecret },
});

const summarize = (s: KioskState) => {
  const cart = s.cart.lines.map((l) => `${l.qty}x ${l.name}`).join(", ") || "empty";
  const popup = s.popup ? ` | popup: "${s.popup.text}"` : "";
  return `[kiosk] ${s.screen} "${s.title}" | cart: ${cart} | total $${s.cart.total.toFixed(2)}${popup}`;
};

phone.on("connect", () => console.log(`Connected to ${kioskId}. Type a message.`));
phone.on("kiosk:state", (s) => console.log(summarize(s)));
phone.on("agent:message", (m) =>
  console.log(`\nAssistant: ${m.text}${m.awaitingConfirmation ? "  (type /yes to confirm)" : ""}\n`),
);
phone.on("debug:ping", (p) => console.log(`[ping from ${p.from}] ${p.text}`));
phone.on("session:ended", (info) => {
  console.log(`Session ended (${info.reason}).`);
  process.exit(0);
});
phone.on("connect_error", (e) => console.error("connect error:", e.message));

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  if (text === "/yes") phone.emit("user:confirm", { confirmed: true });
  else if (text === "/no") phone.emit("user:confirm", { confirmed: false });
  else if (text === "/end") phone.emit("user:end-session");
  else if (text.startsWith("/ping")) phone.emit("debug:ping", { text: text.slice(5).trim() || "ping" });
  else phone.emit("user:message", { text });
});
