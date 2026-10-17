/** Read lazily so the stub and offline tests never require credentials. */
export function readGeminiConfig(env: NodeJS.ProcessEnv = process.env) {
  const apiKey = env.GEMINI_API_KEY?.trim() || env.LLM_API_KEY?.trim();
  const model = env.GEMINI_MODEL?.trim();
  if (!apiKey) throw new Error("Set GEMINI_API_KEY in the root .env before enabling live Gemini calls.");
  if (!model) throw new Error("Set GEMINI_MODEL in the root .env before enabling live Gemini calls.");
  return { apiKey, model };
}

export const MAX_TOOL_ROUNDS = 6;

/** Default stub preserves the existing realtime smoke tests without an API key. */
export function readAgentMode(env: NodeJS.ProcessEnv = process.env): "stub" | "gemini" {
  const mode = env.AGENT_MODE?.trim() || "stub";
  if (mode !== "stub" && mode !== "gemini") throw new Error("AGENT_MODE must be stub or gemini.");
  return mode;
}
