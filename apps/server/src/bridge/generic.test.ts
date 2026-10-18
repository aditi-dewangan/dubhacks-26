import { describe, expect, it } from "vitest";
import type { Cart, KioskCommand, KioskState } from "@kiosk-access/shared";
import { setup, type KioskLike } from "./harness.ts";

// Small stand-ins for Aditi's clinic and cinema kiosks: same button ids, fields and info
// lines, driven only by press / type_text / start_payment / cancel_order.

const EMPTY: Cart = { lines: [], subtotal: 0, tax: 0, total: 0 };

class FakeClinic implements KioskLike {
  screen: "identify" | "appointment" | "review" | "complete" = "identify";
  lastName = "";
  dob = "";

  state(): KioskState {
    const base = { kioskId: "k1", kind: "clinic" as const, cart: EMPTY, sessionActive: true };
    const btn = (id: string, label: string, enabled = true) => ({ id, label, enabled });
    switch (this.screen) {
      case "identify":
        return { ...base, screen: "identify", title: "Find your appointment",
          info: ["Enter your last name and date of birth."],
          fields: [
            { id: "field-last-name", label: "Last name", value: this.lastName },
            { id: "field-dob", label: "Date of birth", value: this.dob, placeholder: "MM/DD/YYYY" },
          ],
          buttons: [btn("btn-cancel", "Cancel"), btn("btn-find", "Find my appointment", !!(this.lastName && this.dob))] };
      case "appointment":
        return { ...base, screen: "appointment", title: "Is this you?",
          info: [`Patient: ${this.lastName}`, "Dr. Maya Patel, Family Medicine", "Today at 2:30 PM, Room 4"],
          buttons: [btn("btn-not-me", "Not me"), btn("btn-confirm", "Yes, that's me")] };
      case "review":
        return { ...base, screen: "review", title: "Review your check-in",
          info: [`${this.lastName} · born ${this.dob}`, "Dr. Maya Patel, today at 2:30 PM, Room 4"],
          buttons: [btn("btn-back", "Back"), btn("btn-submit", "Complete check-in")] };
      case "complete":
        return { ...base, screen: "complete", title: "You're checked in", info: ["A1"], orderNumber: "A1",
          buttons: [btn("btn-done", "Done")] };
    }
  }

  run(command: KioskCommand) {
    const fail = (error: string) => ({ ok: false, error, state: this.state() });
    if (command.type === "type_text") {
      if (command.fieldId === "field-last-name") this.lastName = command.text;
      else if (command.fieldId === "field-dob") this.dob = command.text;
      else return fail(`No field ${command.fieldId}.`);
    } else if (command.type === "press") {
      const b = this.state().buttons.find((x) => x.id === command.buttonId);
      if (!b?.enabled) return fail(`There's no "${command.buttonId}" button on screen.`);
      if (b.id === "btn-find") this.screen = "appointment";
      if (b.id === "btn-confirm") this.screen = "review";
      if (b.id === "btn-back") this.screen = "appointment";
      if (b.id === "btn-submit") this.screen = "complete"; // the real kiosk doesn't block this, so the bridge must
    } else if (command.type === "cancel_order") {
      Object.assign(this, { screen: "identify", lastName: "", dob: "" });
    } else {
      return fail(`This clinic kiosk doesn't support "${command.type}".`);
    }
    return { ok: true, state: this.state() };
  }
}

class FakeCinema implements KioskLike {
  screen: "seats" | "review" | "paying" = "seats";
  seats = "F7, F8";

  state(): KioskState {
    const cart: Cart = {
      lines: [{ lineId: "adult", itemId: "adult", name: "Adult", qty: 2, options: {}, lineTotal: 29 }],
      subtotal: 29, tax: 2.61, total: 31.61,
    };
    const btn = (id: string, label: string) => ({ id, label, enabled: true });
    const buttons = this.screen === "seats"
      ? [btn("btn-best-seats", "Best available"), btn("btn-review", "Review order")]
      : this.screen === "review" ? [btn("btn-change-seats", "Change seats"), btn("btn-pay", "Pay $31.61")] : [btn("btn-card-tap", "Card reader")];
    return { kioskId: "k1", kind: "cinema", screen: this.screen, title: "Dune: Part Three", sessionActive: true, cart, buttons,
      info: ["Today 7:30 PM, Screen 4", `Seats ${this.seats}`] };
  }

  run(command: KioskCommand) {
    if (command.type === "press" && command.buttonId === "btn-review") this.screen = "review";
    else if (command.type === "press" && command.buttonId === "btn-change-seats") { this.seats = "A1, A2"; this.screen = "seats"; }
    else if (command.type === "press" && command.buttonId === "btn-best-seats") this.seats = "F7, F8";
    else if (command.type === "start_payment" && this.screen === "review") this.screen = "paying";
    else return { ok: false, error: `Can't do ${command.type} here.`, state: this.state() };
    return { ok: true, state: this.state() };
  }
}

async function clinicAtReview() {
  const t = setup({ kiosk: new FakeClinic() });
  await t.tool("type_text", { fieldId: "field-last-name", text: "Rivera" });
  await t.tool("type_text", { fieldId: "Date of birth", text: "04/12/1988" });
  await t.tool("press_button", { buttonId: "btn-find" });
  await t.tool("press_button", { buttonId: "Yes, that's me" });
  return t;
}

const submits = (t: ReturnType<typeof setup>) =>
  t.sent.filter((e) => e.command.type === "press" && e.command.buttonId === "btn-submit").length;

describe("generic kiosks (clinic, cinema, transit)", () => {
  it("points food-only tools at press_button and type_text, without touching the kiosk", async () => {
    const t = setup({ kiosk: new FakeClinic() });
    expect(await t.tool("add_item", { itemId: "box_combo", qty: 1 })).toBe(
      "This is a clinic kiosk with no menu, so add_item doesn't apply. Call get_kiosk_state to read the screen, then use press_button and type_text.",
    );
    expect(await t.tool("get_menu")).toMatch(/^This is a clinic kiosk with no menu/);
    expect(t.sent).toHaveLength(0);
  });

  it("describes the screen: info, fields and usable buttons", async () => {
    const t = setup({ kiosk: new FakeClinic() });
    expect(await t.tool("get_kiosk_state")).toBe(
      'The clinic kiosk shows "Find your appointment" (screen identify). On screen: Enter your last name and date of birth. ' +
        'Fields: field-last-name ("Last name") is empty, field-dob ("Date of birth") is empty. Buttons: btn-cancel ("Cancel"). ' +
        'Not available yet: "Find my appointment".',
    );
  });

  it("types into fields by id or label, and keeps a date of birth out of the reply and the log", async () => {
    const t = setup({ kiosk: new FakeClinic() });
    expect(await t.tool("type_text", { fieldId: "field-last-name", text: "Rivera" })).toMatch(/^Typed "Rivera" into Last name\./);
    const dob = await t.tool("type_text", { fieldId: "Date of birth", text: "04/12/1988" });
    expect(dob).toMatch(/^Typed into Date of birth\./);
    expect(t.sent.at(-1)?.command).toEqual({ type: "type_text", fieldId: "field-dob", text: "04/12/1988" });
    const logged = t.logged.filter((e) => e.type === "tool_call").map((e) => e.data?.input);
    expect(logged).toContainEqual({ fieldId: "Date of birth", text: "[redacted]" });
    expect(JSON.stringify(t.logged)).not.toContain('"text":"04/12/1988"');
  });

  it("checks buttons against the screen before pressing", async () => {
    const t = setup({ kiosk: new FakeClinic() });
    expect(await t.tool("press_button", { buttonId: "btn-find" })).toBe(
      '"Find my appointment" can\'t be pressed yet. Something on screen still needs an answer.',
    );
    expect(await t.tool("press_button", { buttonId: "btn-launch" })).toBe('No "btn-launch" button on screen. Buttons: btn-cancel ("Cancel").');
    expect(await t.tool("type_text", { fieldId: "field-ssn", text: "x" })).toMatch(/^No "field-ssn" field on screen/);
    expect(t.sent).toHaveLength(0);
  });

  it("never presses Complete check-in, Pay or the card reader directly", async () => {
    const t = await clinicAtReview();
    const before = t.sent.length;
    expect(await t.tool("press_button", { buttonId: "btn-submit" })).toMatch(/^That finishes the check-in for good/);
    expect(await t.tool("press_button", { buttonId: "Complete check-in" })).toMatch(/^That finishes the check-in for good/);
    expect(await t.tool("press_button", { buttonId: "btn-pay" })).toMatch(/^No "btn-pay" button/);
    expect(t.sent.length).toBe(before);
    expect(submits(t)).toBe(0);

    const c = setup({ kiosk: new FakeCinema() });
    await c.tool("press_button", { buttonId: "btn-review" });
    expect(await c.tool("press_button", { buttonId: "btn-pay" })).toMatch(/^Payment starts only after the customer confirms/);
    expect(c.startPayments()).toBe(0);
  });

  it("completes a check-in only after the customer confirms", async () => {
    const t = await clinicAtReview();
    const readBack = await t.tool("request_checkout");
    expect(readBack).toMatch(/^Read this back: Rivera · born 04\/12\/1988; Dr\. Maya Patel, today at 2:30 PM, Room 4\./);
    expect(readBack).toMatch(/The check-in is not complete yet, and you cannot complete it\.$/);
    expect(t.bridge.isAwaitingConfirmation("s1")).toBe(true);
    expect(submits(t)).toBe(0);

    expect(await t.bridge.interceptUserMessage("s1", "yes")).toEqual({
      text: "You're checked in. Your number is A1. Please have a seat; you'll be called.",
      awaitingConfirmation: false,
    });
    expect(submits(t)).toBe(1);
    expect(t.startPayments()).toBe(0);
  });

  it("cancels the check-in gate if a field changes after the read-back", async () => {
    const t = await clinicAtReview();
    await t.tool("request_checkout");
    const clinic = t.kiosk as FakeClinic;
    clinic.dob = "04/13/1988"; // corrected on the kiosk
    t.setStateSilently(clinic.state());
    await t.bridge.handleConfirm("s1", true);
    expect(submits(t)).toBe(0);
    expect(t.messages.at(-1)?.text).toMatch(/^Your check-in changed since I read it back, so I haven't completed the check-in/);
  });

  it("makes cinema checkout start from the review screen", async () => {
    const t = setup({ kiosk: new FakeCinema() });
    expect(await t.tool("request_checkout")).toBe("Go to the review screen first (it shows the Pay button), then call request_checkout.");
    await t.tool("press_button", { buttonId: "Review order" });
    const readBack = await t.tool("request_checkout");
    expect(readBack).toMatch(/Also on screen: Today 7:30 PM, Screen 4; Seats F7, F8\./);
    await t.bridge.handleConfirm("s1", true);
    expect(t.startPayments()).toBe(1);
  });

  it("cancels the cinema gate if the seats change, even though the cart is the same", async () => {
    const t = setup({ kiosk: new FakeCinema() });
    await t.tool("press_button", { buttonId: "btn-review" });
    await t.tool("request_checkout");
    const cinema = t.kiosk as FakeCinema;
    cinema.seats = "A1, A2";
    t.setStateSilently(cinema.state());
    await t.bridge.handleConfirm("s1", true);
    expect(t.startPayments()).toBe(0);
  });

  it("any press or typing after the read-back closes the gate", async () => {
    const t = await clinicAtReview();
    await t.tool("request_checkout");
    await t.tool("press_button", { buttonId: "btn-back" });
    expect(t.bridge.isAwaitingConfirmation("s1")).toBe(false);
  });
});
