// Kiosk connection codes: two letters for the kind of kiosk plus five digits, e.g. FD48213.
// Each kiosk's code is fixed and derived from its kiosk id, so the server, the kiosk and the
// phone all compute the same code without sharing any state. Fixed codes can be printed on a
// braille or tactile sign next to the kiosk, or read out by staff.

import type { KioskKind } from "./types.ts";

export const CODE_PREFIX: Record<KioskKind, string> = {
  food: "FD",
  cinema: "CN",
  transit: "TR",
  clinic: "HP", // hospital / clinic check-in
};

const CODE_PATTERN = /^(FD|CN|TR|HP)\d{5}$/;

/** The kind of kiosk, from its id (clinic-kiosk1, cinema-kiosk1, transit-kiosk1; anything else is food). */
export function kindFromKioskId(kioskId: string): KioskKind {
  const id = kioskId.toLowerCase();
  if (id.startsWith("clinic") || id.startsWith("hospital")) return "clinic";
  if (id.startsWith("cinema") || id.startsWith("movie")) return "cinema";
  if (id.startsWith("transit")) return "transit";
  return "food";
}

/** The fixed code for a kiosk, e.g. "FD48213". */
export function kioskCode(kioskId: string, kind: KioskKind = kindFromKioskId(kioskId)): string {
  // FNV-1a hash of the id → 5 digits from 10000 to 99999.
  let hash = 0x811c9dc5;
  for (let i = 0; i < kioskId.length; i++) {
    hash ^= kioskId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${CODE_PREFIX[kind]}${10000 + (hash % 90000)}`;
}

/**
 * Clean up what someone typed or said ("fd 48213", "FD-48213") into "FD48213".
 * Returns null if it isn't a valid code.
 */
export function normalizeCode(raw: string): string | null {
  const code = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return CODE_PATTERN.test(code) ? code : null;
}
