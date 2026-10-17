import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { CommandAck, CreateSessionRequest, KioskCommand } from "@kiosk-access/shared";
import { config } from "./config.ts";
import { onKioskAck, sendToKiosk } from "./realtime/index.ts";
import { getEvents } from "./realtime/log.ts";
import { currentCode } from "./realtime/pairing.ts";
import { createSession } from "./realtime/sessions.ts";
import { kiosks } from "./realtime/store.ts";

export const routes = Router();

routes.get("/", (_req, res) => {
  res.json({ ok: true, service: "kiosk-access-server" });
});

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

  // Send one command to a kiosk and wait for its ack. Lets anyone drive the kiosk
  // before the Bridge and Agent exist:  curl -XPOST .../api/dev/command/store42-kiosk1
  //   -H 'content-type: application/json' -d '{"command":{"type":"press","buttonId":"btn-start"}}'
  routes.post("/api/dev/command/:kioskId", async (req, res) => {
    const k = kiosks.get(req.params.kioskId);
    const command = (req.body as { command?: KioskCommand } | undefined)?.command;
    if (!k?.online) {
      res.status(503).json({ error: "kiosk_offline" });
      return;
    }
    if (!command || typeof command.type !== "string") {
      res.status(400).json({ error: "Body must be { command: KioskCommand }" });
      return;
    }
    const cmdId = randomUUID();
    const ack = await new Promise<CommandAck | null>((resolve) => {
      const timer = setTimeout(() => { off(); resolve(null); }, 30_000);
      const off = onKioskAck((a) => {
        if (a.cmdId !== cmdId) return;
        clearTimeout(timer);
        off();
        resolve(a);
      });
      sendToKiosk(k.kioskId, { cmdId, sessionId: k.sessionId ?? "dev", command });
    });
    if (!ack) res.status(504).json({ error: "The kiosk didn't respond" });
    else res.json(ack);
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
