// Pieces every kiosk kind shares: the accessible-ordering QR card and the card reader.

import { useEffect } from "react";
import { QRCodeSVG } from "qrcode.react";
import type { ConnectionStatus } from "@kiosk-access/sdk";
import { ids, money } from "./model.ts";

export function AccessCard({ qrUrl, status, task }: { qrUrl: string | null; status: ConnectionStatus; task: string }) {
  if (qrUrl === null && status === "online") return null; // hidden during a session
  return (
    <aside className="access-card" aria-label="Accessible mode">
      <p className="access-badge">Accessible mode</p>
      <div className="qr-frame">
        {qrUrl ? (
          <QRCodeSVG value={qrUrl} size={220} marginSize={0} level="M" />
        ) : (
          <div className="qr-placeholder">{status === "online" ? "Loading code" : "Connecting"}</div>
        )}
      </div>
      <p className="access-title">Blind or low vision?</p>
      <p className="access-body">Scan with your phone camera to finish {task} by voice from your own phone.</p>
    </aside>
  );
}

/** The payment screen: amount due and a tappable card reader (press "c" as a presenter shortcut). */
export function CardReaderScreen({ total, processing, onTap }: { total: number; processing: boolean; onTap: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "c") onTap(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onTap]);

  return (
    <section className="center-page">
      <p className="muted">Amount due</p>
      <p className="pay-amount" data-kiosk-info="">{money(total)}</p>
      <h2 data-kiosk-title="">{processing ? "Processing payment…" : "Tap, insert or swipe your card"}</h2>
      <p className="muted" data-kiosk-info="">{processing ? "Please don't remove your card" : "Use the card reader below the screen"}</p>
      <button
        type="button"
        className={`card-reader ${processing ? "busy" : ""}`}
        data-kiosk-id={ids.cardTap}
        disabled={processing}
        onClick={onTap}
        aria-label="Card reader"
      >
        <span className="reader-waves" aria-hidden="true">)))</span>
        <span>{processing ? "Reading…" : "Tap card here"}</span>
      </button>
    </section>
  );
}
