// Light Rail: ticket machine (fares are made up).
// welcome → origin → destination → ticket → review → paying → complete

import { create } from "zustand";
import type { ConnectionStatus } from "@kiosk-access/sdk";
import type { Cart } from "@kiosk-access/shared";
import { EMPTY_CART, type GenericKiosk } from "../generic.ts";
import { brand } from "../kinds.ts";
import { ids, money, round2 } from "../model.ts";
import { AccessCard, CardReaderScreen } from "../ui.tsx";

type Screen = "welcome" | "origin" | "destination" | "ticket" | "review" | "paying" | "complete";
type TicketType = "single" | "round" | "day";
type Fare = "adult" | "youth" | "senior" | "reduced";

const STATIONS = [
  { id: "westlake",       name: "Westlake",            zone: 1 },
  { id: "capitol_hill",   name: "Capitol Hill",         zone: 1 },
  { id: "u_district",     name: "U District",           zone: 1 },
  { id: "view_district",  name: "View District",        zone: 1 },
  { id: "northgate",      name: "Northgate",            zone: 2 },
  { id: "stadium",        name: "Stadium / SoDo",       zone: 1 },
  { id: "beacon_hill",    name: "Beacon Hill",          zone: 2 },
  { id: "columbia_city",  name: "Columbia City",        zone: 2 },
  { id: "rainier_beach",  name: "Rainier Beach",        zone: 2 },
  { id: "airport",        name: "Sea-Tac Airport",      zone: 3 },
  { id: "bellevue",       name: "Downtown Bellevue",    zone: 3 },
  { id: "lynnwood",       name: "Lynnwood City Ctr",    zone: 3 },
];

const ADULT_BY_ZONE: Record<number, number> = { 1: 2.75, 2: 3.25, 3: 3.75 };
const TICKETS: Record<TicketType, string> = { single: "One way", round: "Round trip", day: "Day pass" };
const FARES: Record<Fare, string> = { adult: "Adult", youth: "Youth (6–18)", senior: "Senior (65+)", reduced: "Reduced fare" };

function unitPrice(destZone: number, ticket: TicketType, fare: Fare): number {
  if (ticket === "day") return fare === "adult" ? 8 : 3;
  const oneWay = fare === "adult" ? ADULT_BY_ZONE[destZone] : 1;
  return ticket === "round" ? oneWay * 2 : oneWay;
}

interface State {
  screen: Screen;
  origin?: string;
  dest?: string;
  ticket: TicketType;
  fare: Fare;
  qty: number;
  processing: boolean;
  code?: string;
  go(screen: Screen): void;
  pickOrigin(id: string): void;
  pickDestination(id: string): void;
  setTicket(t: TicketType): void;
  setFare(f: Fare): void;
  changeQty(delta: number): void;
  cardTapped(): void;
  reset(): void;
}

let codeCounter = 7310;
const initial = {
  screen: "welcome" as Screen,
  origin: undefined,
  dest: undefined,
  ticket: "single" as TicketType,
  fare: "adult" as Fare,
  qty: 1,
  processing: false,
  code: undefined,
};

const useTransit = create<State>()((set, get) => ({
  ...initial,
  go: (screen) => set({ screen }),
  pickOrigin: (origin) => set({ origin, screen: "destination" }),
  pickDestination: (dest) => set({ dest, screen: "ticket" }),
  setTicket: (ticket) => set({ ticket }),
  setFare: (fare) => set({ fare }),
  changeQty: (delta) => set({ qty: Math.max(1, Math.min(6, get().qty + delta)) }),
  cardTapped: () => {
    if (get().screen !== "paying" || get().processing) return;
    set({ processing: true });
    setTimeout(() => {
      if (get().screen === "paying") set({ screen: "complete", processing: false, code: String(++codeCounter) });
    }, 1600);
  },
  reset: () => set({ ...initial }),
}));

function cartOf(s: State): Cart {
  const dest = STATIONS.find((x) => x.id === s.dest);
  if (!dest) return EMPTY_CART;
  const origin = STATIONS.find((x) => x.id === s.origin);
  const each = unitPrice(dest.zone, s.ticket, s.fare);
  const lineTotal = round2(each * s.qty);
  return {
    lines: [{
      lineId: "ticket",
      itemId: `${s.ticket}_${s.fare}`,
      name: `${TICKETS[s.ticket]}, ${FARES[s.fare]}, ${origin?.name ?? "—"} to ${dest.name}`,
      qty: s.qty,
      options: { ticket: [s.ticket], fare: [s.fare] },
      lineTotal,
    }],
    subtotal: lineTotal,
    tax: 0,
    total: lineTotal,
  };
}

function Body({ qrUrl, status }: { qrUrl: string | null; status: ConnectionStatus }) {
  const s = useTransit();
  const origin = STATIONS.find((x) => x.id === s.origin);
  const dest = STATIONS.find((x) => x.id === s.dest);
  const cart = cartOf(s);
  const each = dest ? unitPrice(dest.zone, s.ticket, s.fare) : 0;

  switch (s.screen) {
    case "welcome":
      return (
        <section className="welcome">
          <div className="welcome-hero">
            <p className="eyebrow">{brand.name}</p>
            <h1 data-kiosk-title="">Where are you headed?</h1>
            <p className="welcome-sub">Buy light-rail tickets and day passes. Pay by card at this machine.</p>
            <button className="btn-red start-btn" type="button" data-kiosk-id="btn-start" onClick={() => s.go("origin")}>
              Buy a ticket
            </button>
          </div>
          <AccessCard qrUrl={qrUrl} status={status} task={brand.task} />
        </section>
      );

    case "origin":
      return (
        <section className="gen-page">
          <h2 className="section-title" data-kiosk-title="">Where are you departing from?</h2>
          <p className="section-sub">Select your starting station</p>
          <div className="station-grid">
            {STATIONS.map((st) => (
              <button
                key={st.id}
                type="button"
                className="station"
                aria-label={`Depart from ${st.name}`}
                data-kiosk-id={`origin-${st.id}`}
                onClick={() => s.pickOrigin(st.id)}
              >
                <span className="station-name">{st.name}</span>
                <span className="muted small">Zone {st.zone}</span>
              </button>
            ))}
          </div>
          <div className="gen-actions">
            <button className="btn-grey" type="button" data-kiosk-id="btn-cancel" onClick={s.reset}>Cancel</button>
          </div>
        </section>
      );

    case "destination":
      return (
        <section className="gen-page">
          <h2 className="section-title" data-kiosk-title="">Choose your destination</h2>
          <p className="section-sub">From {origin?.name}</p>
          <div className="station-grid">
            {STATIONS.filter((st) => st.id !== s.origin).map((st) => (
              <button
                key={st.id}
                type="button"
                className="station"
                aria-label={`${st.name}, zone ${st.zone}`}
                data-kiosk-id={`dest-${st.id}`}
                onClick={() => s.pickDestination(st.id)}
              >
                <span className="station-name">{st.name}</span>
                <span className="muted small">Zone {st.zone} · {money(ADULT_BY_ZONE[st.zone])} adult</span>
              </button>
            ))}
          </div>
          <div className="gen-actions">
            <button className="btn-grey" type="button" data-kiosk-id="btn-back" onClick={() => s.go("origin")}>Back</button>
          </div>
        </section>
      );

    case "ticket":
      return (
        <section className="gen-page narrow">
          <h2 className="section-title" data-kiosk-title="">{origin?.name} → {dest?.name}</h2>
          <p className="section-sub" data-kiosk-info="">Zone {dest?.zone} destination</p>
          <fieldset className="yn-group">
            <legend>Ticket</legend>
            <div className="choice-row">
              {(Object.keys(TICKETS) as TicketType[]).map((t) => (
                <button key={t} type="button" className={`choice ${s.ticket === t ? "on" : ""}`} aria-pressed={s.ticket === t}
                  aria-label={`Ticket: ${TICKETS[t]}`} data-kiosk-id={`opt-ticket-${t}`} onClick={() => s.setTicket(t)}>
                  {TICKETS[t]}
                </button>
              ))}
            </div>
          </fieldset>
          <fieldset className="yn-group">
            <legend>Fare</legend>
            <div className="choice-row">
              {(Object.keys(FARES) as Fare[]).map((f) => (
                <button key={f} type="button" className={`choice ${s.fare === f ? "on" : ""}`} aria-pressed={s.fare === f}
                  aria-label={`Fare: ${FARES[f]}`} data-kiosk-id={`opt-fare-${f}`} onClick={() => s.setFare(f)}>
                  {FARES[f]}
                </button>
              ))}
            </div>
          </fieldset>
          <div className="qty-row">
            <strong>How many?</strong>
            <div className="stepper">
              <button type="button" aria-label="Fewer tickets" data-kiosk-id={ids.qtyMinus} disabled={s.qty <= 1} onClick={() => s.changeQty(-1)}>−</button>
              <span>{s.qty}</span>
              <button type="button" aria-label="More tickets" data-kiosk-id={ids.qtyPlus} disabled={s.qty >= 6} onClick={() => s.changeQty(1)}>+</button>
            </div>
          </div>
          <p className="row-between strong total-line" data-kiosk-info="">
            <span>{s.qty} × {money(each)}</span><span>{money(cart.total)}</span>
          </p>
          <div className="gen-actions">
            <button className="btn-grey" type="button" data-kiosk-id="btn-back" onClick={() => s.go("destination")}>Back</button>
            <button className="btn-red grow" type="button" data-kiosk-id="btn-continue" onClick={() => s.go("review")}>Review</button>
          </div>
        </section>
      );

    case "review":
      return (
        <section className="page-layout">
          <div className="page-main">
            <h2 className="section-title" data-kiosk-title="">Review your ticket</h2>
            <div className="info-card">
              <p className="info-big" data-kiosk-info="">{origin?.name} → {dest?.name}</p>
              <p data-kiosk-info="">{s.qty} × {TICKETS[s.ticket]}, {FARES[s.fare]}</p>
              <p data-kiosk-info="">{s.ticket === "day" ? "Valid on all lines until 3 AM" : "Valid for 2 hours after purchase"}</p>
            </div>
          </div>
          <aside className="summary-card">
            <h3>Payment</h3>
            <dl className="totals">
              <div className="grand"><dt>Total</dt><dd data-kiosk-info="">{money(cart.total)}</dd></div>
            </dl>
            <button className="btn-red block big" type="button" data-kiosk-id={ids.pay} onClick={() => s.go("paying")}>
              Pay {money(cart.total)}
            </button>
            <button className="btn-text" type="button" data-kiosk-id="btn-back" onClick={() => s.go("ticket")}>Back</button>
          </aside>
        </section>
      );

    case "paying":
      return <CardReaderScreen total={cart.total} processing={s.processing} onTap={s.cardTapped} />;

    case "complete":
      return (
        <section className="center-page">
          <span className="check-circle" aria-hidden="true">✓</span>
          <h2 data-kiosk-title="">Take your {s.qty > 1 ? "tickets" : "ticket"} below</h2>
          <p className="muted">Ticket code</p>
          <p className="order-number" data-kiosk-info="">{s.code}</p>
          <p className="muted" data-kiosk-info="">{origin?.name} → {dest?.name} · {TICKETS[s.ticket]} · {FARES[s.fare]}</p>
          <p className="muted" data-kiosk-info="">Trains depart every 8 minutes from the platform below.</p>
          <button className="btn-red wide" type="button" data-kiosk-id="btn-done" onClick={s.reset}>Done</button>
        </section>
      );
  }
}

export const transitKiosk: GenericKiosk = {
  kind: "transit",
  Body,
  getModel: () => {
    const s = useTransit.getState();
    return { screen: s.screen, cart: cartOf(s), orderNumber: s.screen === "complete" ? s.code : undefined };
  },
  subscribe: (fn) => useTransit.subscribe(fn),
  reset: () => useTransit.getState().reset(),
};
