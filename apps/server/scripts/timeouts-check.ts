// Checks session timeouts against a server started with short timers, e.g.
// SESSION_IDLE_MS=1500 PHONE_GRACE_MS=1000 END_AFTER_COMPLETE_MS=500 DEV_ROUTES=1 pnpm dev:server

import { io, type Socket } from "socket.io-client";
import { fixtures, type ClientToServerEvents, type ServerToClientEvents } from "@kiosk-access/shared";

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;
const SERVER = process.env.SERVER_URL ?? `http://localhost:${process.env.PORT ?? 3001}`;
const KEY = process.env.KIOSK_KEY ?? "dev-kiosk-key";
let failures = 0;
const check = (c: unknown, l: string) => { console.log(`${c ? "PASS" : "FAIL"}  ${l}`); if (!c) failures++; };

async function startSession(kioskId: string) {
  const kiosk: Client = io(SERVER, { transports: ["websocket"] });
  await kiosk.emitWithAck("kiosk:register", { kioskId, kioskKey: KEY });
  await new Promise((r) => setTimeout(r, 100));
  const { token } = await (await fetch(`${SERVER}/api/dev/pairing/${kioskId}`)).json();
  const s = await (await fetch(`${SERVER}/api/sessions`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kioskId, token }),
  })).json();
  return { kiosk, s };
}

const ended = (sock: Client, ms: number) =>
  new Promise<string | null>((r) => {
    const t = setTimeout(() => r(null), ms);
    sock.once("session:ended", (i) => { clearTimeout(t); r(i.reason ?? ""); });
  });

// Phone never connects -> phone_disconnected
{
  const { kiosk } = await startSession(`t-grace-${Date.now()}`);
  check((await ended(kiosk, 4000)) === "phone_disconnected", "session ends if the phone never connects");
  kiosk.close();
}
// Phone connects, then goes quiet -> idle_timeout
{
  const { kiosk, s } = await startSession(`t-idle-${Date.now()}`);
  const phone: Client = io(SERVER, { transports: ["websocket"], auth: { role: "phone", ...s } });
  check((await ended(kiosk, 5000)) === "idle_timeout", "session ends after inactivity");
  phone.close(); kiosk.close();
}
// Order completes -> order_complete
{
  const kioskId = `t-done-${Date.now()}`;
  const { kiosk, s } = await startSession(kioskId);
  const phone: Client = io(SERVER, { transports: ["websocket"], auth: { role: "phone", ...s } });
  await new Promise((r) => setTimeout(r, 100));
  kiosk.emit("kiosk:state", { ...fixtures.completeState, kioskId });
  check((await ended(phone, 3000)) === "order_complete", "session ends shortly after the order completes");
  phone.close(); kiosk.close();
}
process.exit(failures ? 1 : 0);
