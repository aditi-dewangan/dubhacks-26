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
function geminiTranscriber(): Transcribe | null {
  if (cached !== undefined) return cached;
  // Local testing without a key: DEV_ROUTES=1 TRANSCRIBE_STUB="two cheeseburgers"
  const stub = process.env.TRANSCRIBE_STUB;
  if (config.devRoutes && stub) return (cached = async () => stub);
  try {
    const { apiKey, model } = readGeminiConfig();
    const client = new GoogleGenAI({ apiKey, vertexai: false });
    cached = async (audio, mimeType) => {
      const response = await client.models.generateContent({
        model,
        contents: [{ role: "user", parts: [{ inlineData: { mimeType, data: audio.toString("base64") } }, { text: PROMPT }] }],
        config: { maxOutputTokens: 1024, temperature: 0, httpOptions: { timeout: TIMEOUT_MS, retryOptions: { attempts: 1 } } },
      });
      return response.text ?? "";
    };
  } catch {
    cached = null; // no Gemini key configured
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
