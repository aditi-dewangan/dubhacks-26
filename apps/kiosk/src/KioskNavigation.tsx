import { useEffect, useRef, useState } from "react";
import type { KioskKind } from "@kiosk-access/shared";
import { kind } from "./kinds.ts";
import imgRaisingCanes  from "./assets/logos/raising-canes.png";
import imgAmcLogo       from "./assets/logos/amc.png";
import imgChildrensLogo from "./assets/logos/seattle-childrens.png";
import imgLightRailLogo from "./assets/logos/lightrail.png";

const destinations: {
  kind: KioskKind;
  label: string;
  description: string;
  logo: string;
  color: string;
  colorLight: string;
}[] = [
  { kind: "food",    label: "Raising Cane's",           description: "Order food at the kiosk",           logo: imgRaisingCanes,  color: "#c8102e", colorLight: "#fff5f5" },
  { kind: "transit", label: "Light Rail",                description: "Buy tickets & check schedules",      logo: imgLightRailLogo, color: "#047857", colorLight: "#ecfdf5" },
  { kind: "clinic",  label: "Seattle Children's",       description: "Check in for your appointment",      logo: imgChildrensLogo, color: "#0077C8", colorLight: "#eff6ff" },
  { kind: "cinema",  label: "AMC Theaters",              description: "Browse movies & book seats",         logo: imgAmcLogo,       color: "#CC0000", colorLight: "#fff5f5" },
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
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
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
            <h2 id="kiosk-navigation-title">Switch kiosk</h2>
            <button className="kiosk-menu-button" type="button" aria-label="Close kiosk menu" onClick={() => dialog.current?.close()}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                <path d="m6 6 12 12M18 6 6 18" />
              </svg>
            </button>
          </div>
          <p className="kiosk-drawer-intro">Choose a venue to continue</p>
          <nav className="kiosk-drawer-links" aria-label="Kiosks">
            {destinations.map((dest) => {
              const active = dest.kind === kind;
              return (
                <a
                  key={dest.kind}
                  href={destinationUrl(dest.kind)}
                  className={`kiosk-drawer-card${active ? " active" : ""}`}
                  aria-current={active ? "page" : undefined}
                  style={{ "--dest-color": dest.color, "--dest-color-light": dest.colorLight } as React.CSSProperties}
                  onClick={(e) => { if (active) { e.preventDefault(); dialog.current?.close(); } }}
                >
                  <div className="kiosk-drawer-logo-wrap">
                    <img src={dest.logo} alt={dest.label} className="kiosk-drawer-logo" />
                  </div>
                  <div className="kiosk-drawer-info">
                    <span className="kiosk-drawer-label">{dest.label}</span>
                    <span className="kiosk-drawer-description">{dest.description}</span>
                  </div>
                  {active && <span className="kiosk-drawer-check" aria-hidden="true">✓</span>}
                </a>
              );
            })}
          </nav>
        </div>
      </dialog>
    </>
  );
}
