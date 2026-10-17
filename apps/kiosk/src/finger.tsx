import { useEffect, useRef } from "react";

// The on-screen "finger" that shows the audience what the assistant is tapping.
// The executor drives it imperatively; React only mounts the element.

export const TRAVEL_MS = 320;
export const PRESS_MS = 140;

let el: HTMLDivElement | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;

export function Finger() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    el = ref.current;
    return () => { el = null; };
  }, []);
  return (
    <div ref={ref} className="finger" aria-hidden="true">
      <span className="finger-ripple" />
    </div>
  );
}

/** Move the finger to the centre of a target element (coordinates relative to the kiosk frame). */
export function moveFingerTo(target: HTMLElement, frame: HTMLElement) {
  if (!el) return;
  if (hideTimer) clearTimeout(hideTimer);
  const t = target.getBoundingClientRect();
  const f = frame.getBoundingClientRect();
  const x = t.left - f.left + t.width / 2;
  const y = t.top - f.top + t.height / 2;
  el.classList.add("visible");
  el.style.transform = `translate(${x}px, ${y}px)`;
}

export function pressFinger() {
  if (!el) return;
  el.classList.remove("pressing");
  void el.offsetWidth; // restart the ripple animation
  el.classList.add("pressing");
}

export function hideFingerSoon(ms = 900) {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => el?.classList.remove("visible", "pressing"), ms);
}
