import { useEffect } from "react";
import { menu } from "@kiosk-access/shared";
import {
  deltaLabel,
  getItem,
  ids,
  missingRequired,
  money,
  unitPrice,
  visibleItems,
} from "./model.ts";
import { cartTotals, useKiosk } from "./store.ts";

// Every tappable element carries data-kiosk-id so the command executor can find it.

export function MenuScreen() {
  const { categoryId, lines, selectCategory, openItem, openCart, cancelOrder } = useKiosk();
  const totals = cartTotals(lines);
  return (
    <section className="screen menu-screen">
      <nav className="tabs" aria-label="Categories">
        {menu.categories.map((c) => (
          <button
            key={c.id}
            type="button"
            data-kiosk-id={ids.category(c.id)}
            className={`tab ${c.id === categoryId ? "tab-active" : ""}`}
            aria-pressed={c.id === categoryId}
            onClick={() => selectCategory(c.id)}
          >
            {c.name}
          </button>
        ))}
      </nav>
      <div className="item-grid">
        {visibleItems(categoryId).map((item) => (
          <button
            key={item.id}
            type="button"
            className="item-card"
            data-kiosk-id={ids.item(item.id)}
            onClick={() => openItem(item.id)}
          >
            <span className={`item-art art-${item.categoryId}`} aria-hidden="true">
              {item.name.slice(0, 1)}
            </span>
            <span className="item-name">{item.name}</span>
            <span className="item-desc">{item.description}</span>
            <span className="item-price">{money(item.price)}</span>
          </button>
        ))}
      </div>
      <footer className="bottom-bar">
        <button type="button" className="ghost-btn" data-kiosk-id={ids.cancel} disabled={!lines.length} onClick={cancelOrder}>
          Start over
        </button>
        <button type="button" className="primary-btn" data-kiosk-id={ids.cart} disabled={!lines.length} onClick={openCart}>
          View order ({lines.length}) · {money(totals.total)}
        </button>
      </footer>
    </section>
  );
}

export function ItemScreen() {
  const { draft, toggleChoice, changeQty, saveDraft, backFromItem } = useKiosk();
  const item = draft && getItem(draft.itemId);
  if (!draft || !item) return null;
  const missing = missingRequired(item, draft.options);
  const total = unitPrice(item, draft.options) * draft.qty;

  return (
    <section className="screen item-screen">
      <button type="button" className="back-link" data-kiosk-id={ids.back} onClick={backFromItem}>
        ← Back
      </button>
      <div className="item-hero">
        <span className={`item-art big art-${item.categoryId}`} aria-hidden="true">{item.name.slice(0, 1)}</span>
        <div>
          <h2>{item.name}</h2>
          <p className="muted">{item.description}</p>
          <p className="item-base">{money(item.price)}</p>
        </div>
      </div>

      <div className="groups">
        {item.optionGroups.map((g) => (
          <fieldset key={g.id} className="group">
            <legend>
              {g.name}
              <span className={`req ${g.required ? "" : "opt"}`}>{g.required ? "Required" : "Optional"}</span>
            </legend>
            <div className="chips">
              {g.choices.map((c) => {
                const selected = (draft.options[g.id] ?? []).includes(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    className={`chip ${selected ? "chip-on" : ""}`}
                    aria-pressed={selected}
                    data-kiosk-id={ids.option(g.id, c.id)}
                    onClick={() => toggleChoice(g.id, c.id)}
                  >
                    {c.name}
                    {c.priceDelta ? <span className="delta">{deltaLabel(c.priceDelta)}</span> : null}
                  </button>
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>

      <footer className="bottom-bar">
        <div className="stepper" aria-label="Quantity">
          <button type="button" data-kiosk-id={ids.qtyMinus} disabled={draft.qty <= 1} onClick={() => changeQty(-1)} aria-label="Fewer">−</button>
          <span>{draft.qty}</span>
          <button type="button" data-kiosk-id={ids.qtyPlus} disabled={draft.qty >= 10} onClick={() => changeQty(1)} aria-label="More">+</button>
        </div>
        <button type="button" className="primary-btn grow" data-kiosk-id={ids.add} disabled={missing.length > 0} onClick={saveDraft}>
          {missing.length
            ? `Choose ${missing.map((g) => g.name.toLowerCase()).join(", ")}`
            : `${draft.editingLineId ? "Save changes" : "Add to order"} · ${money(total)}`}
        </button>
      </footer>
    </section>
  );
}

export function CartScreen() {
  const { lines, editLine, removeLine, addMore, goToCheckout, cancelOrder } = useKiosk();
  const totals = cartTotals(lines);
  return (
    <section className="screen cart-screen">
      <h2>Your order</h2>
      <ul className="cart-list">
        {totals.lines.map((l) => (
          <li key={l.lineId} className={`cart-line ${l.parentLineId ? "child" : ""}`}>
            <div className="cart-main">
              <span className="cart-name">{l.qty > 1 ? `${l.qty} × ` : ""}{l.name}</span>
              {l.detail && <span className="muted">{l.detail}</span>}
              <span className="cart-actions">
                <button type="button" className="link-btn" data-kiosk-id={ids.lineEdit(l.lineId)} onClick={() => editLine(l.lineId)}>Edit</button>
                <button type="button" className="link-btn danger" data-kiosk-id={ids.lineRemove(l.lineId)} onClick={() => removeLine(l.lineId)}>Remove</button>
              </span>
            </div>
            <span className="cart-price">{money(l.lineTotal)}</span>
          </li>
        ))}
      </ul>
      <Totals subtotal={totals.subtotal} tax={totals.tax} total={totals.total} />
      <footer className="bottom-bar stack">
        <button type="button" className="ghost-btn" data-kiosk-id={ids.addMore} onClick={addMore}>Add more items</button>
        <button type="button" className="primary-btn" data-kiosk-id={ids.checkout} disabled={!lines.length} onClick={goToCheckout}>
          Checkout · {money(totals.total)}
        </button>
        <button type="button" className="link-btn quiet" data-kiosk-id={ids.cancel} onClick={cancelOrder}>Start over</button>
      </footer>
    </section>
  );
}

export function CheckoutScreen() {
  const { lines, backToCart, pay } = useKiosk();
  const totals = cartTotals(lines);
  return (
    <section className="screen checkout-screen">
      <button type="button" className="back-link" data-kiosk-id={ids.backToCart} onClick={backToCart}>← Back to order</button>
      <h2>Review and pay</h2>
      <ul className="review-list">
        {totals.lines.map((l) => (
          <li key={l.lineId}>
            <span>{l.qty > 1 ? `${l.qty} × ` : ""}{l.name}{l.detail ? <span className="muted"> · {l.detail}</span> : null}</span>
            <span>{money(l.lineTotal)}</span>
          </li>
        ))}
      </ul>
      <Totals subtotal={totals.subtotal} tax={totals.tax} total={totals.total} big />
      <footer className="bottom-bar">
        <button type="button" className="primary-btn grow" data-kiosk-id={ids.pay} onClick={pay}>Pay {money(totals.total)}</button>
      </footer>
    </section>
  );
}

export function PayingScreen() {
  const { lines, processingPayment, cardTapped } = useKiosk();
  const totals = cartTotals(lines);

  // Presenter shortcut: press "c" to tap a card.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "c") cardTapped(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cardTapped]);

  return (
    <section className="screen paying-screen">
      <p className="pay-amount">{money(totals.total)}</p>
      <h2>{processingPayment ? "Processing payment…" : "Tap, insert or swipe your card"}</h2>
      <p className="muted">{processingPayment ? "Please wait" : "Use the card reader below the screen"}</p>
      <button
        type="button"
        className={`card-reader ${processingPayment ? "busy" : ""}`}
        data-kiosk-id={ids.cardTap}
        disabled={processingPayment}
        onClick={cardTapped}
        aria-label="Card reader"
      >
        <span className="reader-slot" aria-hidden="true" />
        <span className="reader-waves" aria-hidden="true">)))</span>
        <span className="reader-label">{processingPayment ? "Reading…" : "Tap card here"}</span>
      </button>
    </section>
  );
}

export function CompleteScreen() {
  const { orderNumber, finish } = useKiosk();

  // Return to the welcome screen for the next customer.
  useEffect(() => {
    const t = setTimeout(finish, 30_000);
    return () => clearTimeout(t);
  }, [finish]);

  return (
    <section className="screen complete-screen">
      <p className="muted">Your order number</p>
      <p className="order-number">{orderNumber}</p>
      <h2>Thanks! We're making it now.</h2>
      <p className="muted">Listen for your number at the counter.</p>
      <button type="button" className="primary-btn" data-kiosk-id={ids.done} onClick={finish}>Done</button>
    </section>
  );
}

function Totals({ subtotal, tax, total, big }: { subtotal: number; tax: number; total: number; big?: boolean }) {
  return (
    <dl className={`totals ${big ? "big" : ""}`}>
      <div><dt>Subtotal</dt><dd>{money(subtotal)}</dd></div>
      <div><dt>Tax</dt><dd>{money(tax)}</dd></div>
      <div className="grand"><dt>Total</dt><dd>{money(total)}</dd></div>
    </dl>
  );
}

export function Popup() {
  const { popup, answerPopup } = useKiosk();
  if (!popup) return null;
  return (
    <div className="popup-backdrop">
      <div className="popup" role="dialog" aria-modal="true" aria-label={popup.text}>
        <p className="popup-text">{popup.text}</p>
        <div className={`popup-buttons ${popup.buttons.length > 2 ? "grid" : ""}`}>
          {popup.buttons.map((b, i) => (
            <button
              key={b.id}
              type="button"
              className={i === 0 && popup.buttons.length <= 2 ? "primary-btn" : "ghost-btn"}
              data-kiosk-id={b.id}
              onClick={() => answerPopup(b.id)}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
