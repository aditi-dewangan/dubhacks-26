import { useEffect } from "react";
import { menu } from "@kiosk-access/shared";
import {
  categoryEmoji,
  deltaLabel,
  getItem,
  ids,
  itemEmoji,
  itemPhoto,
  missingRequired,
  money,
  unitPrice,
  visibleItems,
} from "./model.ts";
import { cartTotals, useKiosk } from "./store.ts";

// Every tappable element carries data-kiosk-id so the command executor can find it.
// Ids must stay unique on screen and match toKioskState() in store.ts.

// ---------------- menu: categories | items | cart summary ----------------

export function MenuScreen() {
  const { categoryId, selectCategory, openItem } = useKiosk();
  const category = menu.categories.find((c) => c.id === categoryId);
  const items = visibleItems(categoryId);

  return (
    <section className="menu-layout">
      <nav className="sidebar" aria-label="Categories">
        <p className="sidebar-label">Menu</p>
        {menu.categories.map((c) => (
          <button
            key={c.id}
            type="button"
            data-kiosk-id={ids.category(c.id)}
            className={`side-cat ${c.id === categoryId ? "active" : ""}`}
            aria-pressed={c.id === categoryId}
            onClick={() => selectCategory(c.id)}
          >
            <span className="side-emoji" aria-hidden="true">{categoryEmoji(c.id)}</span>
            {c.name}
          </button>
        ))}
      </nav>

      <div className="menu-main">
        <h2 className="section-title">{category?.name}</h2>
        <p className="section-sub">{items.length} items</p>
        <div className="item-grid">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              className="item-card"
              data-kiosk-id={ids.item(item.id)}
              onClick={() => openItem(item.id)}
            >
              <span className="item-photo" aria-hidden="true">
                {itemPhoto(item.id)
                  ? <img src={itemPhoto(item.id)!} alt="" className="item-photo-img" />
                  : <span className="item-emoji">{itemEmoji(item.id)}</span>}
                <span className="add-dot">+</span>
              </span>
              <span className="item-name">{item.name}</span>
              <span className="item-desc">{item.description}</span>
              <span className="item-price">{money(item.price)}</span>
            </button>
          ))}
        </div>
      </div>

      <CartPanel />
    </section>
  );
}

function CartPanel() {
  const { lines, openCart, cancelOrder } = useKiosk();
  const totals = cartTotals(lines);
  return (
    <aside className="cart-panel" aria-label="Your order">
      <h3>Your order</h3>
      {totals.lines.length === 0 ? (
        <div className="cart-empty">
          <span aria-hidden="true">🛒</span>
          <p>Your cart is empty</p>
          <p className="muted small">Add items to get started</p>
        </div>
      ) : (
        <ul className="mini-lines">
          {totals.lines.map((l) => (
            <li key={l.lineId} className={l.parentLineId ? "child" : ""}>
              <span className="qty-badge">{l.qty}×</span>
              <span className="mini-name">
                {l.name}
                {l.detail && <span className="muted small">{l.detail}</span>}
              </span>
              <span className="mini-price">{money(l.lineTotal)}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="panel-foot">
        <div className="row-between strong"><span>Subtotal</span><span>{money(totals.subtotal)}</span></div>
        <button type="button" className="btn-red block" data-kiosk-id={ids.cart} disabled={!lines.length} onClick={openCart}>
          Review order{lines.length ? ` · ${money(totals.total)}` : ""}
        </button>
        <button type="button" className="btn-text" data-kiosk-id={ids.cancel} disabled={!lines.length} onClick={cancelOrder}>
          Start over
        </button>
      </div>
    </aside>
  );
}

// ---------------- item: modal over the menu (or over the cart when editing) ----------------

export function ItemModal() {
  const { draft, toggleChoice, changeQty, saveDraft, backFromItem } = useKiosk();
  const item = draft && getItem(draft.itemId);
  if (!draft || !item) return null;
  const missing = missingRequired(item, draft.options);
  const total = unitPrice(item, draft.options) * draft.qty;

  return (
    <div className="modal-backdrop">
      <div className="modal item-modal" role="dialog" aria-modal="true" aria-label={item.name}>
        <button type="button" className="close-btn" data-kiosk-id={ids.back} onClick={backFromItem} aria-label="Back">
          ✕
        </button>
        <div className="modal-scroll">
          <div className="modal-hero" aria-hidden="true">
          {itemPhoto(item.id)
            ? <img src={itemPhoto(item.id)!} alt="" className="modal-hero-img" />
            : <span>{itemEmoji(item.id)}</span>}
        </div>
          <h2 className="modal-title">{item.name}</h2>
          <p className="muted">{item.description}</p>
          <p className="modal-price">{money(item.price)}</p>

          {item.optionGroups.map((g) => (
            <fieldset key={g.id} className="opt-group">
              <legend>
                <span>
                  {g.name}
                  <span className="muted small">{g.type === "single" ? "Select 1" : "Select any"}</span>
                </span>
                <span className={`req-pill ${g.required ? (draft.options[g.id]?.length ? "done" : "") : "optional"}`}>
                  {g.required ? (draft.options[g.id]?.length ? "✓ Required" : "Required") : "Optional"}
                </span>
              </legend>
              {g.choices.map((c) => {
                const selected = (draft.options[g.id] ?? []).includes(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    className={`opt-row ${selected ? "on" : ""}`}
                    aria-pressed={selected}
                    data-kiosk-id={ids.option(g.id, c.id)}
                    onClick={() => toggleChoice(g.id, c.id)}
                  >
                    <span>
                      {c.name}
                      {c.priceDelta ? <span className="muted small">{deltaLabel(c.priceDelta)}</span> : null}
                    </span>
                    <span className={`mark ${g.type === "single" ? "radio" : "check"}`} aria-hidden="true" />
                  </button>
                );
              })}
            </fieldset>
          ))}
        </div>

        <footer className="modal-foot">
          <div className="stepper" aria-label="Quantity">
            <button type="button" data-kiosk-id={ids.qtyMinus} disabled={draft.qty <= 1} onClick={() => changeQty(-1)} aria-label="Fewer">−</button>
            <span>{draft.qty}</span>
            <button type="button" data-kiosk-id={ids.qtyPlus} disabled={draft.qty >= 10} onClick={() => changeQty(1)} aria-label="More">+</button>
          </div>
          <button type="button" className="btn-red grow" data-kiosk-id={ids.add} disabled={missing.length > 0} onClick={saveDraft}>
            {missing.length
              ? `Choose ${missing.map((g) => g.name.toLowerCase()).join(", ")}`
              : `${draft.editingLineId ? "Save changes" : "Add to order"} · ${money(total)}`}
          </button>
        </footer>
      </div>
    </div>
  );
}

// ---------------- cart ----------------

export function CartScreen() {
  const { lines, editLine, removeLine, addMore, goToCheckout, cancelOrder } = useKiosk();
  const totals = cartTotals(lines);
  return (
    <section className="page-layout">
      <div className="page-main">
        <h2 className="section-title">Your order</h2>
        <p className="section-sub">{lines.length} {lines.length === 1 ? "item" : "items"} · Raising Cane&apos;s</p>
        <ul className="order-lines">
          {totals.lines.map((l) => (
            <li key={l.lineId} className={l.parentLineId ? "child" : ""}>
              <span className="line-photo" aria-hidden="true">
                {itemPhoto(l.itemId)
                  ? <img src={itemPhoto(l.itemId)!} alt="" className="line-photo-img" />
                  : itemEmoji(l.itemId)}
              </span>
              <div className="line-main">
                <span className="line-name">{l.name}</span>
                {l.detail && <span className="muted small">{l.detail}</span>}
                <span className="line-actions">
                  <button type="button" className="btn-pill" data-kiosk-id={ids.lineEdit(l.lineId)} onClick={() => editLine(l.lineId)}>Edit</button>
                  <button type="button" className="btn-pill" data-kiosk-id={ids.lineRemove(l.lineId)} onClick={() => removeLine(l.lineId)}>Remove</button>
                </span>
              </div>
              <span className="line-qty">{l.qty}×</span>
              <span className="line-price">{money(l.lineTotal)}</span>
            </li>
          ))}
        </ul>
        <button type="button" className="btn-pill add-more" data-kiosk-id={ids.addMore} onClick={addMore}>+ Add more items</button>
      </div>
      <aside className="summary-card">
        <h3>Order summary</h3>
        <Totals subtotal={totals.subtotal} tax={totals.tax} total={totals.total} />
        <button type="button" className="btn-red block" data-kiosk-id={ids.checkout} disabled={!lines.length} onClick={goToCheckout}>
          Checkout · {money(totals.total)}
        </button>
        <button type="button" className="btn-text" data-kiosk-id={ids.cancel} onClick={cancelOrder}>Start over</button>
      </aside>
    </section>
  );
}

// ---------------- checkout ----------------

export function CheckoutScreen() {
  const { lines, backToCart, pay } = useKiosk();
  const totals = cartTotals(lines);
  return (
    <section className="page-layout">
      <div className="page-main">
        <button type="button" className="btn-back" data-kiosk-id={ids.backToCart} onClick={backToCart}>← Back to order</button>
        <h2 className="section-title">Review and pay</h2>
        <p className="section-sub">Pickup at the counter · ready in about 8 minutes</p>
        <ul className="review-lines">
          {totals.lines.map((l) => (
            <li key={l.lineId}>
              <span className="line-qty">{l.qty}×</span>
              <span className="line-main">
                <span className="line-name">{l.name}</span>
                {l.detail && <span className="muted small">{l.detail}</span>}
              </span>
              <span className="line-price">{money(l.lineTotal)}</span>
            </li>
          ))}
        </ul>
      </div>
      <aside className="summary-card">
        <h3>Payment</h3>
        <Totals subtotal={totals.subtotal} tax={totals.tax} total={totals.total} />
        <button type="button" className="btn-red block big" data-kiosk-id={ids.pay} onClick={pay}>Pay {money(totals.total)}</button>
        <p className="muted small center">Card, phone or watch</p>
      </aside>
    </section>
  );
}

// ---------------- paying / complete ----------------

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
    <section className="center-page">
      <p className="muted">Amount due</p>
      <p className="pay-amount">{money(totals.total)}</p>
      <h2>{processingPayment ? "Processing payment…" : "Tap, insert or swipe your card"}</h2>
      <p className="muted">{processingPayment ? "Please don't remove your card" : "Use the card reader below the screen"}</p>
      <button
        type="button"
        className={`card-reader ${processingPayment ? "busy" : ""}`}
        data-kiosk-id={ids.cardTap}
        disabled={processingPayment}
        onClick={cardTapped}
        aria-label="Card reader"
      >
        <span className="reader-waves" aria-hidden="true">)))</span>
        <span>{processingPayment ? "Reading…" : "Tap card here"}</span>
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
    <section className="center-page">
      <span className="check-circle" aria-hidden="true">✓</span>
      <h2>Order placed!</h2>
      <p className="muted">Your order number</p>
      <p className="order-number">{orderNumber}</p>
      <p className="muted">We'll call your number at the counter in about 8 minutes.</p>
      <button type="button" className="btn-red wide" data-kiosk-id={ids.done} onClick={finish}>Done</button>
    </section>
  );
}

function Totals({ subtotal, tax, total }: { subtotal: number; tax: number; total: number }) {
  return (
    <dl className="totals">
      <div><dt>Subtotal</dt><dd>{money(subtotal)}</dd></div>
      <div><dt>Tax</dt><dd>{money(tax)}</dd></div>
      <div className="grand"><dt>Total</dt><dd>{money(total)}</dd></div>
    </dl>
  );
}

// ---------------- popups ----------------

export function Popup() {
  const { popup, answerPopup } = useKiosk();
  if (!popup) return null;
  const many = popup.buttons.length > 2;
  return (
    <div className="modal-backdrop top">
      <div className="modal popup" role="dialog" aria-modal="true" aria-label={popup.text}>
        <p className="popup-text">{popup.text}</p>
        <div className={`popup-buttons ${many ? "grid" : ""}`}>
          {popup.buttons.map((b, i) => (
            <button
              key={b.id}
              type="button"
              className={!many && i === 0 ? "btn-red block" : "btn-grey block"}
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
