// One live, read-only Gemini call. No server, phone, kiosk, or Bridge is required.
import { performance } from "node:perf_hooks";
import { fixtures } from "@kiosk-access/shared";
import { readGeminiConfig } from "../src/agent/config.ts";
import { createGeminiResponder, GeminiError } from "../src/agent/gemini.ts";

try {
  const config = readGeminiConfig();
  const question = process.argv.slice(2).join(" ") || "What burgers do you have?";
  const started = performance.now();
  const text = await createGeminiResponder(config)({ text: question, state: fixtures.menuState });
  console.log(`Model: ${config.model}`);
  console.log(`Question: ${question}`);
  console.log(`Reply: ${text}`);
  console.log(`Latency: ${Math.round(performance.now() - started)} ms`);
  console.log("Read-only check: no ordering tools were connected. Review item names and prices against menu.json.");
} catch (error) {
  if (error instanceof GeminiError) console.error(`Live check failed (${error.code}). Check the server key, model access, quota, and connection.`);
  else console.error("Live check could not start. Set GEMINI_API_KEY and GEMINI_MODEL in the root .env.");
  process.exitCode = 1;
}
