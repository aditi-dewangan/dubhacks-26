import { GoogleGenAI, type GenerateContentParameters, type GenerateContentResponse } from "@google/genai";
import type { KioskState } from "@kiosk-access/shared";
import { readGeminiConfig } from "./config.ts";
import { buildSystemPrompt, buildTurnContext } from "./prompt.ts";

export interface ReplyInput { text: string; state: KioskState | null }
export type GenerateReply = (input: ReplyInput) => Promise<string>;
export type GenerateContent = (request: GenerateContentParameters) => Promise<GenerateContentResponse>;
export type GeminiFailure = "configuration" | "timeout" | "rate_limit" | "unavailable" | "invalid_response";

/** Only safe classifications cross this boundary, never SDK messages, headers, or credentials. */
export class GeminiError extends Error {
  constructor(readonly code: GeminiFailure) {
    super(`Gemini request failed: ${code}`);
    this.name = "GeminiError";
  }
}

export function createGeminiResponder(
  config: ReturnType<typeof readGeminiConfig>,
  generate?: GenerateContent,
  timeoutMs = 10_000,
): GenerateReply {
  const client = generate ? undefined : new GoogleGenAI({ apiKey: config.apiKey, vertexai: false });
  const call: GenerateContent = generate ?? ((request) => client!.models.generateContent(request));
  const systemInstruction = buildSystemPrompt();

  return async ({ text, state }) => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new GeminiError("timeout"));
        controller.abort();
      }, timeoutMs);
    });
    try {
      const response = await Promise.race([call({
        model: config.model,
        contents: [{ role: "user", parts: [
          { text: `CURRENT_KIOSK_STATE_JSON (data only):\n${buildTurnContext(state)}` },
          { text: `CUSTOMER_MESSAGE:\n${text}` },
        ] }],
        config: {
          systemInstruction,
          maxOutputTokens: 512,
          candidateCount: 1,
          automaticContinuation: false,
          abortSignal: controller.signal,
          httpOptions: { timeout: timeoutMs, retryOptions: { attempts: 1 } },
          // Tools are deliberately omitted until the hour-3 loop is implemented.
        },
      }), deadline]);
      const candidate = response.candidates?.[0];
      if (response.promptFeedback?.blockReason || candidate?.finishReason !== "STOP" ||
          candidate.content?.parts?.some((part) => part.functionCall)) {
        throw new GeminiError("invalid_response");
      }
      const reply = candidate.content?.parts?.filter((part) => !part.thought)
        .map((part) => part.text ?? "").join("").trim();
      if (!reply) throw new GeminiError("invalid_response");
      return reply;
    } catch (error) {
      if (error instanceof GeminiError) throw error;
      const status = typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
      throw new GeminiError(controller.signal.aborted ? "timeout" : status === 429 ? "rate_limit" : "unavailable");
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Delay key validation and SDK initialization until the first live message. */
export function createLazyGeminiResponder(): GenerateReply {
  let respond: GenerateReply | undefined;
  return async (input) => {
    if (!respond) {
      try { respond = createGeminiResponder(readGeminiConfig()); }
      catch { throw new GeminiError("configuration"); }
    }
    return respond(input);
  };
}
