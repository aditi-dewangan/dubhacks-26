import { Router } from "express";
import type { CreateSessionRequest } from "@kiosk-access/shared";
import { config } from "./config.ts";
import { getEvents } from "./realtime/log.ts";
import { currentCode } from "./realtime/pairing.ts";
import { createSession } from "./realtime/sessions.ts";
import { kiosks } from "./realtime/store.ts";

export const routes = Router();

routes.get("/health", (_req, res) => {
  res.json({ ok: true, kiosksOnline: [...kiosks.values()].filter((k) => k.online).length });
});

routes.post("/api/sessions", (req, res) => {
  const body = req.body as Partial<CreateSessionRequest> | undefined;
  if (typeof body?.kioskId !== "string" || typeof body?.token !== "string") {
    res.status(400).json({ error: "bad_request", message: "kioskId and token are required." });
    return;
  }
  const result = createSession(body.kioskId, body.token);
  if (result.ok) res.status(201).json(result.body);
  else res.status(result.status).json(result.body);
});

routes.get("/api/events", (req, res) => {
  const since = typeof req.query.since === "string" ? req.query.since : undefined;
  res.json(getEvents(since));
});

if (config.devRoutes) {
  // For test scripts and the fake phone: the kiosk's current QR code without a camera.
  routes.get("/api/dev/pairing/:kioskId", (req, res) => {
    const k = kiosks.get(req.params.kioskId);
    const code = k ? currentCode(k) : null;
    if (!code) {
      res.status(404).json({ error: "No valid code. Is the kiosk online?" });
      return;
    }
    res.json(code);
  });

  routes.get("/api/dev/kiosks", (_req, res) => {
    res.json(
      [...kiosks.values()].map((k) => ({
        kioskId: k.kioskId,
        online: k.online,
        sessionId: k.sessionId,
        screen: k.lastState?.screen ?? null,
      })),
    );
  });
}
