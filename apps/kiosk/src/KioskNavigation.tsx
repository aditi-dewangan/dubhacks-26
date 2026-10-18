import { useEffect, useRef, useState } from "react";
import type { KioskKind } from "@kiosk-access/shared";
import { kind } from "./kinds.ts";

const destinations: { kind: KioskKind; label: string; description: string; icon: string }[] = [
  { kind: "food", label: "Food", description: "Order food and drinks", icon: "🍔" },
  { kind: "transit", label: "Transit", description: "Plan your ride and buy fares", icon: "🚆" },
  { kind: "clinic", label: "Hospital Check-ins", description: "Check in for your appointment", icon: "🏥" },
  { kind: "cinema", label: "Tickets", description: "Browse movies and book seats", icon: "🎟️" },
];

function destinationUrl(destination: KioskKind) {
  const url = new URL(window.location.href);
  if (destination === "food") url.searchParams.delete("kind");
  else url.searchParams.set("kind", destination);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function KioskNavigation({ sessionActive }: { sessionActive: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);

  // Keep kiosk switching consistent with the existing pause on touch during a phone session.
  useEffect(() => {
    if (sessionActive) dialog.current?.close();
  }, [sessionActive]);

  return (
    <>
      <button
        className="kiosk-menu-button"
        type="button"
        aria-label="Open kiosk menu"
        aria-haspopup="dialog"
        aria-controls="kiosk-navigation"
        aria-expanded={open}
        disabled={sessionActive}
        onClick={() => { dialog.current?.showModal(); setOpen(true); }}
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>
      <dialog
        ref={dialog}
        id="kiosk-navigation"
        className="kiosk-drawer"
        aria-labelledby="kiosk-navigation-title"
        onClose={() => setOpen(false)}
        onClick={(event) => { if (event.target === event.currentTarget) dialog.current?.close(); }}
      >
        <div className="kiosk-drawer-panel">
          <div className="kiosk-drawer-heading">
            <h2 id="kiosk-navigation-title">Choose a kiosk</h2>
            <button className="kiosk-menu-button" type="button" aria-label="Close kiosk menu" onClick={() => dialog.current?.close()}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="m6 6 12 12M18 6 6 18" />
              </svg>
            </button>
          </div>
          <p className="kiosk-drawer-intro">What would you like to do?</p>
          <nav className="kiosk-drawer-links" aria-label="Kiosks">
            {destinations.map((destination) => (
              <a
                key={destination.kind}
                href={destinationUrl(destination.kind)}
                aria-current={destination.kind === kind ? "page" : undefined}
                onClick={(event) => {
                  if (destination.kind === kind) {
                    event.preventDefault();
                    dialog.current?.close();
                  }
                }}
              >
                <span className="kiosk-drawer-icon" aria-hidden="true">{destination.icon}</span>
                <span>
                  <span className="kiosk-drawer-label">{destination.label}</span>
                  <span className="kiosk-drawer-description">{destination.description}</span>
                </span>
                <span className="kiosk-drawer-arrow" aria-hidden="true">{destination.kind === kind ? "✓" : "→"}</span>
              </a>
            ))}
          </nav>
        </div>
      </dialog>
    </>
  );
}
