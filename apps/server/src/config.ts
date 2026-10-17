const num = (v: string | undefined, fallback: number) => (v ? Number(v) : fallback);

export const config = {
  port: num(process.env.PORT, 3001),
  kioskKey: process.env.KIOSK_KEY ?? "dev-kiosk-key",
  phoneAppUrl: (process.env.PHONE_APP_URL ?? "http://localhost:5174").replace(/\/$/, ""),
  corsOrigins: process.env.CORS_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean),
  devRoutes: process.env.DEV_ROUTES === "1",
  eventsFile: process.env.EVENTS_FILE ?? "events.jsonl",

  // Timings (ms). Tests can shrink them through env.
  codeRotateMs: num(process.env.CODE_ROTATE_MS, 60_000),
  codeTtlMs: num(process.env.CODE_TTL_MS, 90_000),
  sessionIdleMs: num(process.env.SESSION_IDLE_MS, 3 * 60_000),
  phoneGraceMs: num(process.env.PHONE_GRACE_MS, 30_000),
  kioskGraceMs: num(process.env.KIOSK_GRACE_MS, 15_000),
  endAfterCompleteMs: num(process.env.END_AFTER_COMPLETE_MS, 20_000),
};
