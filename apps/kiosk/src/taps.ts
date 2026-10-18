// The visible "finger": every assistant action on any kiosk kind goes through these helpers,
// which move the finger, show a ripple and click the real element, so the screen always
// matches what the assistant did.

import { moveFingerTo, pressFinger, PRESS_MS, TRAVEL_MS } from "./finger.tsx";

/** An error the assistant can read aloud. Anything else is a bug. */
export class KioskError extends Error {}

// When the kiosk window is hidden or covered, Chrome pauses animation frames and slows timers
// to about once a minute, which froze every tap sequence. Nobody can see the finger then, so
// skip the animation pauses and only let the page update, with a message-channel tick that
// Chrome doesn't throttle. When the window is visible, everything animates as before.
const hidden = () => document.visibilityState === "hidden";
const tick = () => new Promise<void>((r) => {
  const channel = new MessageChannel();
  channel.port1.onmessage = () => r();
  channel.port2.postMessage(0);
});

export const sleep = (ms: number) => (hidden() ? tick() : new Promise<void>((r) => setTimeout(r, ms)));

/** Runs fn after the next paint, or right away (after one tick) if the browser isn't painting. */
export const afterPaint = (fn: () => void) => {
  let done = false;
  const run = () => { if (!done) { done = true; fn(); } };
  if (hidden()) { void tick().then(run); return; }
  requestAnimationFrame(() => requestAnimationFrame(run));
  setTimeout(run, 60);
};
export const nextPaint = () => new Promise<void>((r) => afterPaint(r));

export function findTarget(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-kiosk-id="${CSS.escape(id)}"]`);
}

/** Move the finger to an element and click it, exactly like a person would. */
export async function tap(id: string) {
  const frame = document.querySelector<HTMLElement>(".kiosk");
  const el = findTarget(id);
  if (!frame || !el) throw new KioskError(`The "${id}" button isn't on the screen right now.`);
  if ((el as HTMLButtonElement).disabled) throw new KioskError(`The "${id}" button is disabled right now.`);

  if (scrollIntoList(el)) await sleep(280);

  moveFingerTo(el, frame);
  await sleep(TRAVEL_MS);
  pressFinger();
  await sleep(PRESS_MS);
  el.click();
  el.focus?.();
  await nextPaint();
}

/** Tap a text field, clear it, and type into it one character at a time. */
export async function typeInto(fieldId: string, text: string) {
  const el = findTarget(fieldId);
  if (!(el instanceof HTMLInputElement)) throw new KioskError(`There's no "${fieldId}" text field on the screen.`);
  await tap(fieldId);
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  const value = text.slice(0, el.maxLength > 0 ? el.maxLength : 80);
  // React only notices changes made through the native setter followed by an input event.
  for (let i = 0; i <= value.length; i++) {
    setValue.call(el, value.slice(0, i));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    if (i < value.length) await sleep(35);
  }
  await nextPaint();
}

/**
 * Scroll only the nearest scrolling list (menu grid, cart, modal body) so the target is visible.
 * Element.scrollIntoView would also scroll the kiosk frame itself and shove the banner off screen.
 */
export function scrollIntoList(el: HTMLElement): boolean {
  let box = el.parentElement;
  while (box && !/(auto|scroll)/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
  if (!box) return false;
  const b = box.getBoundingClientRect();
  const t = el.getBoundingClientRect();
  const pad = 16;
  let delta = 0;
  if (t.top < b.top + pad) delta = t.top - b.top - pad;
  else if (t.bottom > b.bottom - pad) delta = t.bottom - b.bottom + pad;
  if (!delta) return false;
  box.scrollBy({ top: delta, behavior: "smooth" });
  return true;
}
