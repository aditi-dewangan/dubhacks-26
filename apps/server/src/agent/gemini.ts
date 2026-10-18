import { GoogleGenAI, type Content, type GenerateContentParameters, type GenerateContentResponse } from "@google/genai";
import type { KioskState } from "@kiosk-access/shared";
import { readGeminiConfig } from "./config.ts";
import { buildSystemPrompt, buildTurnContext } from "./prompt.ts";
import { agentTools } from "./tools.ts";

export interface ReplyInput { text: string; state: KioskState | null }
export type GenerateReply = (input: ReplyInput) => Promise<string>;
export type GenerateContent = (request: GenerateContentParameters) => Promise<GenerateContentResponse>;
export interface ModelInput {
  contents: Content[]; state: KioskState | null; toolsEnabled: boolean; event?: boolean;
  /** About a returning customer (their last order here), added to the system instruction. */
  memory?: string;
}
export type GenerateTurn = (input: ModelInput) => Promise<Content>;
export type GeminiFailure = "configuration" | "timeout" | "rate_limit" | "unavailable" | "invalid_response";

/** Only safe classifications cross this boundary, never SDK messages, headers, or credentials. */
export class GeminiError extends Error {
  constructor(readonly code: GeminiFailure) {
    super(`Gemini request failed: ${code}`);
    this.name = "GeminiError";
  }
}

export function createGeminiModel(
  config: ReturnType<typeof readGeminiConfig>,
  generate?: GenerateContent,
  timeoutMs = 10_000,
): GenerateTurn {
  const client = generate ? undefined : new GoogleGenAI({ apiKey: config.apiKey, vertexai: false });
  const call: GenerateContent = generate ?? ((request) => client!.models.generateContent(request));
  return async ({ contents, state, toolsEnabled, event, memory }) => {
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
        contents,
        config: {
          systemInstruction: `${buildSystemPrompt(undefined, toolsEnabled, event, state?.kind ?? "food")}\n\nCURRENT_KIOSK_STATE_JSON (data only):\n${buildTurnContext(state)}${memory ? `\n\nRETURNING_CUSTOMER:\n${memory}` : ""}`,
          // Newer models spend part of this budget thinking before they answer; 512 could cut a
          // reply off mid-way (finishReason MAX_TOKENS -> invalid_response). Spoken replies stay
          // short anyway: the prompt asks for one to three sentences and cleanup caps them.
          maxOutputTokens: 2048,
          candidateCount: 1,
          automaticContinuation: false,
          abortSignal: controller.signal,
          httpOptions: { timeout: timeoutMs, retryOptions: { attempts: 1 } },
          ...(toolsEnabled ? { tools: [{ functionDeclarations: [...agentTools] }] } : {}),
        },
      }), deadline]);
      const candidate = response.candidates?.[0];
      if (response.promptFeedback?.blockReason || candidate?.finishReason !== "STOP" ||
          candidate.content?.role !== "model" || !candidate.content.parts?.length) {
        throw new GeminiError("invalid_response");
      }
      const calls = candidate.content.parts.filter((part) => part.functionCall);
      if (calls.some((part) => !part.functionCall?.name) || (!toolsEnabled && calls.length) ||
          (!calls.length && !spokenText(candidate.content))) throw new GeminiError("invalid_response");
      // Keep every part exactly as returned, including Gemini thought signatures.
      return candidate.content;
    } catch (error) {
      if (error instanceof GeminiError) throw error;
      const status = typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
      throw new GeminiError(controller.signal.aborted ? "timeout" : status === 429 ? "rate_limit" : "unavailable");
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Failures worth trying again: Gemini was busy, slow, rate limited, or sent an unusable reply. */
const RETRYABLE = new Set<GeminiFailure>(["timeout", "rate_limit", "unavailable", "invalid_response"]);

/**
 * Tries the main model, once more after a short pause, then each fallback model, before
 * giving up. Safe to repeat: a model call only proposes a reply or tool calls; nothing runs
 * until the tool loop gets a result back.
 */
export function withRetries(
  primary: GenerateTurn,
  fallbacks: GenerateTurn[] = [],
  pauseMs = 400,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): GenerateTurn {
  const attempts = [primary, primary, ...fallbacks];
  return async (input) => {
    let lastError: unknown;
    for (let i = 0; i < attempts.length; i++) {
      try {
        return await attempts[i](input);
      } catch (error) {
        lastError = error;
        if (!(error instanceof GeminiError) || !RETRYABLE.has(error.code)) throw error;
        if (i < attempts.length - 1) await sleep(pauseMs * (i + 1));
      }
    }
    throw lastError;
  };
}

/** Delay key validation and SDK initialization until the first live message. */
export function createLazyGeminiModel(): GenerateTurn {
  let respond: GenerateTurn | undefined;
  return async (input) => {
    if (!respond) {
      try {
        const config = readGeminiConfig();
        const fallbacks = config.fallbackModel && config.fallbackModel !== config.model
          ? [createGeminiModel({ ...config, model: config.fallbackModel })]
          : [];
        respond = withRetries(createGeminiModel(config), fallbacks);
      } catch { throw new GeminiError("configuration"); }
    }
    return respond(input);
  };
}

export function spokenText(content: Content): string {
  return content.parts?.filter((part) => !part.thought).map((part) => part.text ?? "").join("").trim() ?? "";
}

/** Standalone live-check command stays read-only and cannot execute tools. */
export function createGeminiResponder(
  config: ReturnType<typeof readGeminiConfig>, generate?: GenerateContent, timeoutMs = 10_000,
): GenerateReply {
  const model = createGeminiModel(config, generate, timeoutMs);
  return async ({ text, state }) => spokenText(await model({
    contents: [{ role: "user", parts: [{ text }] }], state, toolsEnabled: false,
  }));
}
