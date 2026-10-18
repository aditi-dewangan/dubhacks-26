// AMC Theatres: movie ticket kiosk (all titles are made up).
// welcome → movies (pick a showtime) → tickets → seats → review → paying → complete

import { create } from "zustand";
import type { ConnectionStatus } from "@kiosk-access/sdk";
import type { Cart } from "@kiosk-access/shared";
import { EMPTY_CART, type GenericKiosk } from "../generic.ts";
import { brand } from "../kinds.ts";
import imgAmcLogo from "../assets/logos/amc.png";
import { ids, money, round2 } from "../model.ts";
import { AccessCard, CardReaderScreen } from "../ui.tsx";

type Screen = "welcome" | "movies" | "tickets" | "seats" | "review" | "paying" | "complete";
type TicketType = "adult" | "child" | "senior";

const MOVIES = [
  { id: "lighthouse", title: "The Last Lighthouse", rating: "PG-13", length: "2h 4m", art: "🌊", theater: 4, times: ["4:15 PM", "6:45 PM", "9:30 PM"] },
  { id: "comet", title: "Comet Kids", rating: "PG", length: "1h 38m", art: "☄️", theater: 2, times: ["1:00 PM", "3:30 PM", "6:00 PM"] },
  { id: "signal", title: "Midnight Signal", rating: "R", length: "1h 52m", art: "📡", theater: 7, times: ["7:10 PM", "10:00 PM"] },
  { id: "planets", title: "Paper Planets", rating: "G", length: "1h 30m", art: "🪐", theater: 1, times: ["11:30 AM", "2:00 PM", "4:30 PM"] },
];
const PRICES: Record<TicketType, number> = { adult: 14.5, child: 10.5, senior: 11.5 };
const TYPE_NAMES: Record<TicketType, string> = { adult: "Adult", child: "Child (under 12)", senior: "Senior (65+)" };
const ROWS = ["A", "B", "C", "D", "E", "F"];
const TAKEN = new Set(["A3", "A4", "B5", "B6", "B7", "C1", "C2", "D9", "D10", "E4", "E5", "F5", "F6", "F7", "F8"]);
const TAX_RATE = 0.101;

const timeId = (t: string) => t.replace(/[^0-9APM]/gi, "").toLowerCase();

interface State {
  screen: Screen;
  movieId?: string;
  time?: string;
  qty: Record<TicketType, number>;
  seats: string[];
  processing: boolean;
  booking?: string;
  go(screen: Screen): void;
  pickShowtime(movieId: string, time: string): void;
  changeQty(type: TicketType, delta: number): void;
  toggleSeat(seat: string): void;
  bestAvailable(): void;
  cardTapped(): void;
  reset(): void;
}

let bookingCounter = 4820;
const initial = {
  screen: "welcome" as Screen, movieId: undefined, time: undefined,
  qty: { adult: 0, child: 0, senior: 0 }, seats: [] as string[], processing: false, booking: undefined,
};
const ticketCount = (q: Record<TicketType, number>) => q.adult + q.child + q.senior;

const useCinema = create<State>()((set, get) => ({
  ...initial,
  go: (screen) => set({ screen }),
  pickShowtime: (movieId, time) => set({ movieId, time, screen: "tickets" }),
  changeQty: (type, delta) => {
    const qty = { ...get().qty, [type]: Math.max(0, Math.min(8, get().qty[type] + delta)) };
    set({ qty, seats: get().seats.slice(0, ticketCount(qty)) });
  },
  toggleSeat: (seat) => {
    const { seats, qty } = get();
    if (TAKEN.has(seat)) return;
    if (seats.includes(seat)) return set({ seats: seats.filter((x) => x !== seat) });
    const max = ticketCount(qty);
    set({ seats: [...seats, seat].slice(-max) });
  },
  bestAvailable: () => {
    const need = ticketCount(get().qty);
    // Prefer the middle rows, then seats closest to the center.
    for (const row of ["D", "E", "C", "F", "B", "A"]) {
      for (let start = 1; start + need - 1 <= 10; start++) {
        const block = Array.from({ length: need }, (_, i) => `${row}${start + i}`);
        if (block.some((x) => TAKEN.has(x))) continue;
        const center = start + (need - 1) / 2;
        if (Math.abs(center - 5.5) <= 2) return set({ seats: block });
      }
    }
  },
  cardTapped: () => {
    if (get().screen !== "paying" || get().processing) return;
    set({ processing: true });
    setTimeout(() => {
      if (get().screen === "paying") set({ screen: "complete", processing: false, booking: String(++bookingCounter) });
    }, 1600);
  },
  reset: () => set({ ...initial, qty: { adult: 0, child: 0, senior: 0 }, seats: [] }),
}));

function cartOf(s: State): Cart {
  const movie = MOVIES.find((m) => m.id === s.movieId);
  const lines = (Object.keys(PRICES) as TicketType[])
    .filter((t) => s.qty[t] > 0)
    .map((t) => ({
      lineId: t,
      itemId: `ticket_${t}`,
      name: `${TYPE_NAMES[t]} ticket${movie ? `, ${movie.title} ${s.time}` : ""}`,
      qty: s.qty[t],
      options: {},
      lineTotal: round2(PRICES[t] * s.qty[t]),
    }));
  if (!lines.length) return EMPTY_CART;
  const subtotal = round2(lines.reduce((a, l) => a + l.lineTotal, 0));
  const tax = round2(subtotal * TAX_RATE);
  return { lines, subtotal, tax, total: round2(subtotal + tax) };
}

function Body({ qrUrl, status }: { qrUrl: string | null; status: ConnectionStatus }) {
  const s = useCinema();
  const movie = MOVIES.find((m) => m.id === s.movieId);
  const count = ticketCount(s.qty);
  const cart = cartOf(s);

  switch (s.screen) {
    case "welcome":
      return (
        <section className="welcome">
          <div className="welcome-hero">
            <img src={imgAmcLogo} alt={brand.name} className="venue-logo" />
            <h1 data-kiosk-title="">Grab your seats.</h1>
            <p className="welcome-sub">Buy tickets, pick seats and skip the box office line.</p>
            <button className="btn-red start-btn" type="button" data-kiosk-id="btn-start" onClick={() => s.go("movies")}>
              Buy tickets
            </button>
          </div>
          <AccessCard qrUrl={qrUrl} status={status} task={brand.task} />
        </section>
      );

    case "movies":
      return (
        <section className="gen-page">
          <h2 className="section-title" data-kiosk-title="">Now showing today</h2>
          <p className="section-sub">Choose a showtime</p>
          <div className="movie-list">
            {MOVIES.map((m) => (
              <div key={m.id} className="movie-row">
                <span className="poster" aria-hidden="true">{m.art}</span>
                <div className="movie-main">
                  <p className="movie-title" data-kiosk-info="">{m.title} · {m.rating} · {m.length}</p>
                  <div className="time-chips">
                    {m.times.map((t) => (
                      <button
                        key={t}
                        type="button"
                        className="choice"
                        aria-label={`${m.title} at ${t}`}
                        data-kiosk-id={`show-${m.id}-${timeId(t)}`}
                        onClick={() => s.pickShowtime(m.id, t)}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="gen-actions">
            <button className="btn-grey" type="button" data-kiosk-id="btn-cancel" onClick={s.reset}>Cancel</button>
          </div>
        </section>
      );

    case "tickets":
      return (
        <section className="gen-page narrow">
          <h2 className="section-title" data-kiosk-title="">How many tickets?</h2>
          <p className="section-sub" data-kiosk-info="">{movie?.title} · {s.time} · Theater {movie?.theater}</p>
          {(Object.keys(PRICES) as TicketType[]).map((t) => (
            <div key={t} className="qty-row">
              <span>
                <strong data-kiosk-info="">{TYPE_NAMES[t]}: {money(PRICES[t])}</strong>
              </span>
              <div className="stepper">
                <button type="button" aria-label={`Fewer ${t} tickets`} data-kiosk-id={`qty-${t}-minus`} disabled={!s.qty[t]} onClick={() => s.changeQty(t, -1)}>−</button>
                <span>{s.qty[t]}</span>
                <button type="button" aria-label={`More ${t} tickets`} data-kiosk-id={`qty-${t}-plus`} onClick={() => s.changeQty(t, 1)}>+</button>
              </div>
            </div>
          ))}
          <p className="row-between strong total-line" data-kiosk-info="">
            <span>{count} {count === 1 ? "ticket" : "tickets"}</span><span>{money(cart.subtotal)}</span>
          </p>
          <div className="gen-actions">
            <button className="btn-grey" type="button" data-kiosk-id="btn-back" onClick={() => s.go("movies")}>Back</button>
            <button className="btn-red grow" type="button" data-kiosk-id="btn-continue" disabled={!count} onClick={() => s.go("seats")}>
              Choose seats
            </button>
          </div>
        </section>
      );

    case "seats":
      return (
        <section className="gen-page seats-page">
          <h2 className="section-title" data-kiosk-title="">Choose {count} {count === 1 ? "seat" : "seats"}</h2>
          <p className="section-sub" data-kiosk-info="">
            Selected: {s.seats.length ? s.seats.join(", ") : "none"} ({s.seats.length} of {count})
          </p>
          <div className="screen-bar" aria-hidden="true">SCREEN</div>
          <div className="seat-grid">
            {ROWS.map((r) => (
              <div key={r} className="seat-row">
                <span className="row-label" aria-hidden="true">{r}</span>
                {Array.from({ length: 10 }, (_, i) => {
                  const seat = `${r}${i + 1}`;
                  const taken = TAKEN.has(seat);
                  const on = s.seats.includes(seat);
                  return (
                    <button
                      key={seat}
                      type="button"
                      className={`seat ${on ? "on" : ""} ${i === 4 ? "aisle" : ""}`}
                      disabled={taken}
                      aria-pressed={on}
                      aria-label={`Seat ${seat}${taken ? ", taken" : ""}`}
                      data-kiosk-id={`seat-${seat}`}
                      onClick={() => s.toggleSeat(seat)}
                    >
                      {i + 1}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="gen-actions">
            <button className="btn-grey" type="button" data-kiosk-id="btn-back" onClick={() => s.go("tickets")}>Back</button>
            <button className="btn-grey" type="button" data-kiosk-id="btn-best-available" onClick={s.bestAvailable}>Best available</button>
            <button className="btn-red grow" type="button" data-kiosk-id="btn-continue" disabled={s.seats.length !== count} onClick={() => s.go("review")}>
              Review
            </button>
          </div>
        </section>
      );

    case "review":
      return (
        <section className="page-layout">
          <div className="page-main">
            <h2 className="section-title" data-kiosk-title="">Review your tickets</h2>
            <div className="info-card">
              <p className="info-big" data-kiosk-info="">{movie?.title} · {movie?.rating}</p>
              <p data-kiosk-info="">Today at {s.time} · Theater {movie?.theater}</p>
              <p data-kiosk-info="">Seats {s.seats.join(", ")}</p>
              {cart.lines.map((l) => (
                <p key={l.lineId} data-kiosk-info="">{l.qty} × {TYPE_NAMES[l.lineId as TicketType]}: {money(l.lineTotal)}</p>
              ))}
            </div>
          </div>
          <aside className="summary-card">
            <h3>Payment</h3>
            <dl className="totals">
              <div><dt>Subtotal</dt><dd>{money(cart.subtotal)}</dd></div>
              <div><dt>Tax</dt><dd>{money(cart.tax)}</dd></div>
              <div className="grand"><dt>Total</dt><dd data-kiosk-info="">{money(cart.total)}</dd></div>
            </dl>
            <button className="btn-red block big" type="button" data-kiosk-id={ids.pay} onClick={() => s.go("paying")}>
              Pay {money(cart.total)}
            </button>
            <button className="btn-text" type="button" data-kiosk-id="btn-back" onClick={() => s.go("seats")}>Back to seats</button>
          </aside>
        </section>
      );

    case "paying":
      return <CardReaderScreen total={cart.total} processing={s.processing} onTap={s.cardTapped} />;

    case "complete":
      return (
        <section className="center-page">
          <span className="check-circle" aria-hidden="true">✓</span>
          <h2 data-kiosk-title="">Enjoy the show!</h2>
          <p className="muted">Booking number</p>
          <p className="order-number" data-kiosk-info="">{s.booking}</p>
          <p className="muted" data-kiosk-info="">{movie?.title} at {s.time} · Theater {movie?.theater} · Seats {s.seats.join(", ")}</p>
          <p className="muted" data-kiosk-info="">Your tickets are printing below the screen.</p>
          <button className="btn-red wide" type="button" data-kiosk-id="btn-done" onClick={s.reset}>Done</button>
        </section>
      );
  }
}

export const cinemaKiosk: GenericKiosk = {
  kind: "cinema",
  Body,
  getModel: () => {
    const s = useCinema.getState();
    return { screen: s.screen, cart: cartOf(s), orderNumber: s.screen === "complete" ? s.booking : undefined };
  },
  subscribe: (fn) => useCinema.subscribe(fn),
  reset: () => useCinema.getState().reset(),
};
