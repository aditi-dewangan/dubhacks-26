// Speech-to-text fallback for phones whose browser can't do it (Chrome/Firefox on iPhone,
// or any browser that refuses its built-in recognition). The phone records a short WAV clip
// and posts it here; Gemini turns it into text. Only a phone with a live session can use it.

import express, { Router } from "express";
import { GoogleGenAI } from "@google/genai";
import { readGeminiConfig } from "./agent/config.ts";
import { config } from "./config.ts";
import { verifySecret, touchSession } from "./realtime/sessions.ts";
import { sessions } from "./realtime/store.ts";

const MAX_BYTES = 2 * 1024 * 1024; // ~60s of 16 kHz mono WAV; clips are capped at 15s on the phone
const TIMEOUT_MS = 12_000;
const PROMPT =
  "Transcribe this short voice clip from a customer ordering at a self-service kiosk. " +
  "Reply with only the exact words spoken, in plain text, with no quotes, labels or commentary. " +
  "If there is no clear speech, reply with an empty response.";

/** Turns audio into text. Swappable in tests. */
export type Transcribe = (audio: Buffer, mimeType: string) => Promise<string>;

let cached: Transcribe | null | undefined;

/** What happened last time, for GET /api/transcribe/status (never includes audio, text or keys). */
const status = {
  configured: false,
  models: [] as string[],
  lastOk: null as string | null,
  lastError: null as null | { at: string; model: string; reason: string },
};
const redact = (text: string) => text.replace(/key=[^&\s"]+/gi, "key=…").replace(/AIza[0-9A-Za-z_-]{20,}/g, "…").slice(0, 300);
function recordError(model: string, error: unknown) {
  const e = error as { status?: number; message?: string };
  const reason = redact(`${e?.status ?? ""} ${e?.message ?? String(error)}`.trim());
  status.lastError = { at: new Date().toISOString(), model, reason };
  console.warn(`[transcribe] ${model} failed: ${reason}`);
}

function geminiTranscriber(): Transcribe | null {
  if (cached !== undefined) return cached;
  // Local testing without a key: DEV_ROUTES=1 TRANSCRIBE_STUB="two cheeseburgers"
  const stub = process.env.TRANSCRIBE_STUB;
  if (config.devRoutes && stub) { status.configured = true; status.models = ["stub"]; return (cached = async () => stub); }
  try {
    const { apiKey, model, fallbackModel } = readGeminiConfig();
    const client = new GoogleGenAI({ apiKey, vertexai: false });
    const models = fallbackModel && fallbackModel !== model ? [model, fallbackModel] : [model];
    status.configured = true;
    status.models = models;
    cached = async (audio, mimeType) => {
      let lastError: unknown;
      // Try the main model, then the fallback model if it fails.
      for (const m of models) {
        try {
          const response = await client.models.generateContent({
            model: m,
            contents: [{ role: "user", parts: [{ inlineData: { mimeType, data: audio.toString("base64") } }, { text: PROMPT }] }],
            config: { maxOutputTokens: 2048, temperature: 0, httpOptions: { timeout: TIMEOUT_MS, retryOptions: { attempts: 1 } } },
          });
          const text = response.text ?? "";
          const finish = response.candidates?.[0]?.finishReason;
          if (!text.trim() && finish && finish !== "STOP") throw new Error(`empty reply (finishReason ${finish})`);
          status.lastOk = new Date().toISOString();
          return text;
        } catch (error) {
          lastError = error;
          recordError(m, error);
        }
      }
      throw lastError;
    };
  } catch (error) {
    recordError("config", error); // no Gemini key or model configured
    cached = null;
  }
  return cached;
}

/** Clean up what the model returns: trim, strip quotes, drop "no speech" style answers. */
export function cleanTranscript(raw: string): string {
  const text = raw.trim().replace(/^["'“”]+|["'“”]+$/g, "").replace(/\s+/g, " ").trim();
  if (!text || /^\(?\[?(no (clear )?speech|silence|inaudible|empty)[^a-z]*$/i.test(text)) return "";
  return text.slice(0, 500);
}

export function createTranscribeRoutes(transcribe: () => Transcribe | null = geminiTranscriber) {
  const routes = Router();
  // Is voice transcription set up and working? Safe to open in a browser.
  routes.get("/api/transcribe/status", (_req, res) => {
    const ready = transcribe() !== null;
    res.json({ ready, ...status });
  });
  routes.post(
    "/api/transcribe",
    express.raw({ type: ["audio/*", "application/octet-stream"], limit: MAX_BYTES }),
    async (req, res) => {
      const session = sessions.get(req.get("x-session-id") ?? "");
      if (!session || session.ended || !verifySecret(session, req.get("x-session-secret") ?? "")) {
        res.status(403).json({ error: "bad_session", message: "That ordering session isn't valid." });
        return;
      }
      const audio = req.body;
      if (!Buffer.isBuffer(audio) || audio.length < 1000) {
        res.status(400).json({ error: "bad_request", message: "No audio was received." });
        return;
      }
      const run = transcribe();
      if (!run) {
        res.status(503).json({ error: "unavailable", message: "Voice isn't available right now. Please type your order." });
        return;
      }
      touchSession(session);
      console.log(`[transcribe] ${audio.length} bytes ${req.get("content-type") ?? ""}`);
      try {
        const text = cleanTranscript(await run(audio, (req.get("content-type") ?? "audio/wav").split(";")[0]!));
        res.json({ text });
      } catch {
        res.status(502).json({ error: "failed", message: "I couldn't understand that. Please try again or type." });
      }
    },
  );
  return routes;
}
