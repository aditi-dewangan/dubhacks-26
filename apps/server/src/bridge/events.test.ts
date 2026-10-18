import { describe, expect, it } from "vitest";
import { setup } from "./harness.ts";

const popup = (id: string, text: string) => ({ id, text, buttons: [{ id: "popup-still-here", label: "I'm still here" }] });

describe("kiosk event detection", () => {
  it("tells the agent about a popup no command caused", async () => {
    const t = setup();
    t.publish({ ...t.kiosk.state(), popup: popup("popup-still-there", "Still there? Your order will reset soon.") });
    expect(t.kioskEvents).toEqual([
      'A popup appeared on the kiosk: "Still there? Your order will reset soon." Buttons: popup-still-here ("I\'m still here").',
    ]);
    t.publish({ ...t.kiosk.state(), popup: popup("popup-still-there", "Still there? Your order will reset soon.") });
    expect(t.kioskEvents).toHaveLength(1); // the same popup again is not news
  });

  it("stays quiet about the upsell popup that add_item caused", async () => {
    const t = setup();
    await t.tool("add_item", { itemId: "chicken_sandwich", options: {} });
    t.publish(); // the kiosk's debounced state arrives after the ack
    expect(t.kioskEvents).toEqual([]);
  });

  it("stays quiet when the popup state arrives before the ack", async () => {
    const t = setup({ autoAck: false });
    const reply = t.tool("add_item", { itemId: "chicken_sandwich", options: {} });
    await new Promise((r) => setTimeout(r, 0));
    const env = t.sent[0];
    t.kiosk.run(env.command);
    t.publish(); // state with the popup, while the command is still in flight
    t.ackWithCurrentState(env);
    expect(await reply).toMatch(/^Added 1 chicken sandwich/);
    expect(t.kioskEvents).toEqual([]);
  });

  it("announces the order number when payment completes", async () => {
    const t = setup();
    await t.tool("add_item", { itemId: "texas_toast", qty: 1 });
    await t.tool("request_checkout");
    await t.bridge.handleConfirm("s1", true);
    t.kiosk.tapCard();
    t.publish();
    expect(t.kioskEvents).toEqual(["Payment went through. The order number is 141."]);
  });

  it("ignores kiosks without a session", async () => {
    const t = setup();
    t.endSession();
    t.publish({ ...t.kiosk.state(), popup: popup("popup-still-there", "Still there?") });
    expect(t.kioskEvents).toEqual([]);
  });
});
