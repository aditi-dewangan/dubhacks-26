// A kiosk with no screen, for testing the agent and bridge before the real kiosk is up.
// Usage: pnpm fake-kiosk [kioskId]        then, in another terminal: pnpm fake-phone [kioskId]
//
// It registers through the SDK, acks every command with realistic states from menu.json
// (including the combo popup after a burger), and taps the card itself after payment starts.
// Env: SERVER_URL (or VITE_SERVER_URL), KIOSK_KEY, FAKE_COMMAND_MS (delay per command, default 600).

import { AccessKiosk } from "../src/index.ts";
import { FakeKiosk } from "./model.ts";

const serverUrl = process.env.SERVER_URL ?? process.env.VITE_SERVER_URL ?? `http://localhost:${process.env.PORT ?? 3001}`;
const kioskId = process.argv[2] ?? process.env.VITE_KIOSK_ID ?? "store42-kiosk1";
const kioskKey = process.env.KIOSK_KEY ?? process.env.VITE_KIOSK_KEY ?? "dev-kiosk-key";
const commandMs = Number(process.env.FAKE_COMMAND_MS ?? 600);
const CARD_TAP_MS = 2000;

const kiosk = new FakeKiosk(kioskId);
const access = AccessKiosk.connect({ serverUrl, kioskId, kioskKey });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const describe = () => {
  const s = kiosk.state();
  const cart = s.cart.lines.map((l) => `${l.lineId} ${l.qty}x ${l.name}`).join(", ") || "empty";
  const popup = s.popup ? ` | popup: "${s.popup.text}" [${s.popup.buttons.map((b) => b.id).join(", ")}]` : "";
  return `${s.screen} | cart: ${cart} | total $${s.cart.total.toFixed(2)}${popup}`;
};

access.onStatus((s) => console.log(`[fake-kiosk] ${s} (${kioskId} @ ${serverUrl})`));
access.onPairingCode((url) => console.log(`[fake-kiosk] pairing URL: ${url}`));
access.onSession((s) => {
  kiosk.sessionActive = s.active;
  if (!s.active) kiosk.reset();
  console.log(`[fake-kiosk] session ${s.active ? "started" : `ended (${s.reason})`}`);
  access.publishState(kiosk.state());
});

access.onCommand(async (command) => {
  console.log(`[fake-kiosk] <- ${JSON.stringify(command)}`);
  await sleep(commandMs); // the real kiosk takes about this long to tap through
  const result = kiosk.run(command);
  console.log(`[fake-kiosk] -> ${result.ok ? "ok" : `error: ${result.error}`} | ${describe()}`);

  if (result.ok && command.type === "start_payment") {
    setTimeout(() => {
      kiosk.tapCard();
      console.log(`[fake-kiosk] card tapped | ${describe()}`);
      access.publishState(kiosk.state());
    }, CARD_TAP_MS);
  }
  return result;
});

access.publishState(kiosk.state());

process.on("SIGINT", () => {
  access.disconnect();
  process.exit(0);
});
