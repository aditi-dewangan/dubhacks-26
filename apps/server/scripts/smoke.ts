// End-to-end check of the realtime layer against a running server.
// Usage: pnpm smoke   (server must be running with DEV_ROUTES=1)

import { io, type Socket } from "socket.io-client";
import { fixtures, type ClientToServerEvents, type ServerToClientEvents } from "@kiosk-access/shared";

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;

const SERVER = process.env.SERVER_URL ?? `http://localhost:${process.env.PORT ?? 3001}`;
const KIOSK_ID = `smoke-${Date.now()}`;
const KIOSK_KEY = process.env.KIOSK_KEY ?? "dev-kiosk-key";

let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};

function waitFor<T>(sock: Client, event: keyof ServerToClientEvents, ms = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${String(event)}`)), ms);
    sock.once(event as never, ((payload: T) => {
      clearTimeout(t);
      resolve(payload);
    }) as never);
  });
}

async function createSession(token: string) {
  const res = await fetch(`${SERVER}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kioskId: KIOSK_ID, token }),
  });
  return { status: res.status, body: await res.json() };
}

async function main() {
  // 1. Kiosk registers and receives a pairing code
  const kiosk: Client = io(SERVER, { transports: ["websocket"] });
  const firstCode = waitFor<{ url: string }>(kiosk, "kiosk:pairing-code");
  const reg = await kiosk.emitWithAck("kiosk:register", { kioskId: KIOSK_ID, kioskKey: KIOSK_KEY });
  check(reg.ok, "kiosk registers");
  const code = await firstCode;
  const token = new URL(code.url).searchParams.get("t")!;
  check(code.url.includes(`/k/${KIOSK_ID}`) && token, "kiosk receives a pairing URL with a token");

  const badReg = io(SERVER, { transports: ["websocket"] }) as Client;
  const bad = await badReg.emitWithAck("kiosk:register", { kioskId: "x", kioskKey: "wrong" });
  check(!bad.ok, "wrong kiosk key is rejected");
  badReg.close();

  // 2. Bad token is rejected
  const expired = await createSession("not-a-token");
  check(expired.status === 410, "invalid code returns 410");

  // 3. Phone creates a session
  const started = waitFor<{ sessionId: string }>(kiosk, "session:started");
  const created = await createSession(token);
  check(created.status === 201 && created.body.sessionSecret, "phone creates a session (201)");
  const kioskStarted = await started;
  check(kioskStarted.sessionId === created.body.sessionId, "kiosk is told the session started");

  // 4. Second phone gets 409
  const second = await createSession(token);
  check(second.status === 409, "second phone on the same kiosk gets 409");

  // 5. Bad secret cannot connect
  const intruder: Client = io(SERVER, {
    transports: ["websocket"],
    auth: { role: "phone", sessionId: created.body.sessionId, sessionSecret: "nope" },
  });
  const intruderErr = await new Promise<string>((r) => intruder.once("connect_error", (e) => r(e.message)));
  check(intruderErr === "invalid_session", "wrong session secret is refused");
  intruder.close();

  // 6. Phone connects and gets state
  kiosk.emit("kiosk:state", { ...fixtures.menuState, kioskId: KIOSK_ID });
  await new Promise((r) => setTimeout(r, 100));
  const phone: Client = io(SERVER, {
    transports: ["websocket"],
    auth: { role: "phone", sessionId: created.body.sessionId, sessionSecret: created.body.sessionSecret },
  });
  const phoneState = waitFor<{ screen: string }>(phone, "kiosk:state");
  check((await phoneState).screen === "menu", "phone receives the kiosk's latest state on connect");

  // 7. Ping both ways
  const kioskPing = waitFor<{ from: string; text: string }>(kiosk, "debug:ping");
  phone.emit("debug:ping", { text: "hello kiosk" });
  const kp = await kioskPing;
  check(kp.from === "phone" && kp.text === "hello kiosk", "ping travels phone -> server -> kiosk");

  const phonePing = waitFor<{ from: string }>(phone, "debug:ping");
  kiosk.emit("debug:ping", { text: "hello phone" });
  check((await phonePing).from === "kiosk", "ping travels kiosk -> server -> phone");

  // 8. State relay
  const relayed = waitFor<{ popup?: unknown }>(phone, "kiosk:state");
  kiosk.emit("kiosk:state", { ...fixtures.upsellState, kioskId: KIOSK_ID });
  check(Boolean((await relayed).popup), "kiosk state changes reach the phone");

  // 9. Agent stub replies, in order
  const replies: string[] = [];
  let resolveReplies!: (replies: string[]) => void;
  let rejectReplies!: (error: Error) => void;
  const repliesReady = new Promise<string[]>((resolve, reject) => {
    resolveReplies = resolve;
    rejectReplies = reject;
  });
  const onAgentMessage = (m: { text: string }) => {
    // Popup announcements are also agent messages; this check measures user replies only.
    if (!m.text.startsWith("Stub agent heard:")) return;
    replies.push(m.text);
    if (replies.length === 2) resolveReplies(replies);
  };
  const repliesTimeout = setTimeout(() => rejectReplies(new Error("timed out waiting for ordered agent replies")), 3000);
  phone.on("agent:message", onAgentMessage);
  phone.emit("user:message", { text: "first" });
  phone.emit("user:message", { text: "second" });
  const receivedReplies = await repliesReady;
  clearTimeout(repliesTimeout);
  phone.off("agent:message", onAgentMessage);
  check(receivedReplies[0].includes("first") && receivedReplies[1].includes("second"),
    `user messages get agent replies, one at a time, in order: ${receivedReplies.join(" | ")}`);

  // 10. Staff ends session; kiosk gets a fresh code
  const phoneEnded = waitFor<{ reason: string }>(phone, "session:ended");
  const newCode = waitFor<{ url: string }>(kiosk, "kiosk:pairing-code");
  kiosk.emit("kiosk:end-session");
  check((await phoneEnded).reason === "staff_ended", "staff can end the session; phone is told why");
  const fresh = new URL((await newCode).url).searchParams.get("t");
  check(fresh && fresh !== token, "kiosk gets a fresh code after the session ends");

  // 11. Old token can't be reused
  const reuse = await createSession(token);
  check(reuse.status === 410, "a used code cannot start another session");

  // 12. Events are logged
  const events = (await (await fetch(`${SERVER}/api/events`)).json()) as { type: string; kioskId?: string }[];
  const mine = new Set(events.filter((e) => e.kioskId === KIOSK_ID).map((e) => e.type));
  check(["session_start", "user_message", "agent_message", "session_end"].every((t) => mine.has(t)),
    "session events are written to the event log");

  phone.close();
  kiosk.close();
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
