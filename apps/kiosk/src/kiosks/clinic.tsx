// Seattle Children's: patient check-in kiosk.
// welcome → identify (type last name + date of birth) → appointment → questions → review → complete

import { create } from "zustand";
import type { ConnectionStatus } from "@kiosk-access/sdk";
import { EMPTY_CART, type GenericKiosk } from "../generic.ts";
import { brand } from "../kinds.ts";
import { AccessCard } from "../ui.tsx";
import imgChildrensLogo from "../assets/logos/seattle-childrens.png";

type Screen = "welcome" | "identify" | "appointment" | "questions" | "review" | "complete";
type Answer = "yes" | "no";

const QUESTIONS = [
  { id: "insurance", text: "Has your insurance changed since your last visit?" },
  { id: "contact", text: "Has your address or phone number changed?" },
  { id: "symptoms", text: "Do you have a fever, cough or rash today?" },
] as const;

const DOB = /^(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])\/(19|20)\d\d$/;

interface State {
  screen: Screen;
  lastName: string;
  dob: string;
  answers: Record<string, Answer>;
  queue?: string;
  go(screen: Screen): void;
  setField(field: "lastName" | "dob", value: string): void;
  answer(id: string, value: Answer): void;
  submit(): void;
  reset(): void;
}

let queueCounter = 16;
const initial = { screen: "welcome" as Screen, lastName: "", dob: "", answers: {}, queue: undefined };

const useClinic = create<State>()((set) => ({
  ...initial,
  go: (screen) => set({ screen }),
  setField: (field, value) => set({ [field]: value } as Pick<State, typeof field>),
  answer: (id, value) => set((s) => ({ answers: { ...s.answers, [id]: value } })),
  submit: () => set({ screen: "complete", queue: `A${++queueCounter}` }),
  reset: () => set({ ...initial }),
}));

const titleCase = (s: string) => s.trim().replace(/\b\w/g, (c) => c.toUpperCase());

function Body({ qrUrl, status }: { qrUrl: string | null; status: ConnectionStatus }) {
  const s = useClinic();
  const allAnswered = QUESTIONS.every((q) => s.answers[q.id]);
  const canFind = s.lastName.trim().length > 1 && DOB.test(s.dob.trim());

  switch (s.screen) {
    case "welcome":
      return (
        <section className="welcome">
          <div className="welcome-hero">
            <img src={imgChildrensLogo} alt={brand.name} className="venue-logo" />
            <h1 data-kiosk-title="">Check in for your appointment.</h1>
            <p className="welcome-sub">It takes about a minute. Have your date of birth ready.</p>
            <button className="btn-red start-btn" type="button" data-kiosk-id="btn-start" onClick={() => s.go("identify")}>
              Check in
            </button>
          </div>
          <AccessCard qrUrl={qrUrl} status={status} task={brand.task} />
        </section>
      );

    case "identify":
      return (
        <section className="gen-page narrow">
          <h2 className="section-title" data-kiosk-title="">Find your appointment</h2>
          <p className="section-sub" data-kiosk-info="">Enter your last name and date of birth.</p>
          <label className="field">
            <span>Last name</span>
            <input
              data-kiosk-id="field-last-name"
              aria-label="Last name"
              autoComplete="off"
              maxLength={40}
              value={s.lastName}
              onChange={(e) => s.setField("lastName", e.target.value)}
            />
          </label>
          <label className="field">
            <span>Date of birth</span>
            <input
              data-kiosk-id="field-dob"
              aria-label="Date of birth"
              placeholder="MM/DD/YYYY"
              inputMode="numeric"
              maxLength={10}
              value={s.dob}
              onChange={(e) => s.setField("dob", e.target.value)}
            />
          </label>
          {s.dob && !DOB.test(s.dob.trim()) && (
            <p className="field-hint" data-kiosk-info="">Date of birth must look like 04/12/1988.</p>
          )}
          <div className="gen-actions">
            <button className="btn-grey" type="button" data-kiosk-id="btn-cancel" onClick={s.reset}>Cancel</button>
            <button className="btn-red grow" type="button" data-kiosk-id="btn-find" disabled={!canFind} onClick={() => s.go("appointment")}>
              Find my appointment
            </button>
          </div>
        </section>
      );

    case "appointment":
      return (
        <section className="gen-page narrow">
          <h2 className="section-title" data-kiosk-title="">Is this your appointment?</h2>
          <div className="info-card">
            <p className="info-big" data-kiosk-info="">Patient: {titleCase(s.lastName)}</p>
            <p data-kiosk-info="">Dr. Maya Patel, Family Medicine</p>
            <p data-kiosk-info="">Today at 2:30 PM, Room 4</p>
          </div>
          <div className="gen-actions">
            <button className="btn-grey" type="button" data-kiosk-id="btn-not-me" onClick={() => { s.setField("dob", ""); s.go("identify"); }}>
              That's not me
            </button>
            <button className="btn-red grow" type="button" data-kiosk-id="btn-confirm" onClick={() => s.go("questions")}>
              Yes, that's me
            </button>
          </div>
        </section>
      );

    case "questions":
      return (
        <section className="gen-page narrow">
          <h2 className="section-title" data-kiosk-title="">A few quick questions</h2>
          {QUESTIONS.map((q) => (
            <fieldset key={q.id} className="yn-group">
              <legend data-kiosk-info="">{q.text}</legend>
              <div className="yn-buttons">
                {(["yes", "no"] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    className={`choice ${s.answers[q.id] === v ? "on" : ""}`}
                    aria-pressed={s.answers[q.id] === v}
                    aria-label={`${q.text} ${v === "yes" ? "Yes" : "No"}`}
                    data-kiosk-id={`opt-${q.id}-${v}`}
                    onClick={() => s.answer(q.id, v)}
                  >
                    {v === "yes" ? "Yes" : "No"}
                  </button>
                ))}
              </div>
            </fieldset>
          ))}
          <div className="gen-actions">
            <button className="btn-grey" type="button" data-kiosk-id="btn-back" onClick={() => s.go("appointment")}>Back</button>
            <button className="btn-red grow" type="button" data-kiosk-id="btn-continue" disabled={!allAnswered} onClick={() => s.go("review")}>
              Continue
            </button>
          </div>
        </section>
      );

    case "review":
      return (
        <section className="gen-page narrow">
          <h2 className="section-title" data-kiosk-title="">Review your check-in</h2>
          <div className="info-card">
            <p className="info-big" data-kiosk-info="">{titleCase(s.lastName)} · born {s.dob}</p>
            <p data-kiosk-info="">Dr. Maya Patel, today at 2:30 PM, Room 4</p>
            {QUESTIONS.map((q) => (
              <p key={q.id} data-kiosk-info="">{q.text} {s.answers[q.id] === "yes" ? "Yes" : "No"}</p>
            ))}
          </div>
          <div className="gen-actions">
            <button className="btn-grey" type="button" data-kiosk-id="btn-back" onClick={() => s.go("questions")}>Back</button>
            <button className="btn-red grow" type="button" data-kiosk-id="btn-submit" onClick={s.submit}>
              Complete check-in
            </button>
          </div>
        </section>
      );

    case "complete":
      return (
        <section className="center-page">
          <span className="check-circle" aria-hidden="true">✓</span>
          <h2 data-kiosk-title="">You're checked in</h2>
          <p className="muted">Your number</p>
          <p className="order-number" data-kiosk-info="">{s.queue}</p>
          <p className="muted" data-kiosk-info="">Please take a seat. We'll call {s.queue} when Dr. Patel is ready.</p>
          {s.answers.insurance === "yes" && (
            <p className="notice" data-kiosk-info="">Please stop at the front desk to update your insurance.</p>
          )}
          <button className="btn-red wide" type="button" data-kiosk-id="btn-done" onClick={s.reset}>Done</button>
        </section>
      );
  }
}

export const clinicKiosk: GenericKiosk = {
  kind: "clinic",
  Body,
  getModel: () => {
    const s = useClinic.getState();
    return { screen: s.screen, cart: EMPTY_CART, orderNumber: s.screen === "complete" ? s.queue : undefined };
  },
  subscribe: (fn) => useClinic.subscribe(fn),
  reset: () => useClinic.getState().reset(),
};
