import { parseArgs } from "node:util";
import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { conversationCases } from "../src/agent/testing/conversations.ts";
import { evaluateConversations } from "../src/agent/testing/evaluation.ts";
import { createGeminiModel } from "../src/agent/gemini.ts";
import { readGeminiConfig } from "../src/agent/config.ts";

async function main() {
  const { values } = parseArgs({ options: {
    live: { type: "boolean", default: false }, runs: { type: "string", default: "1" },
    case: { type: "string" }, output: { type: "string" }, list: { type: "boolean", default: false },
  } });
  if (values.list) { console.log(conversationCases.map((c) => `${c.id}: ${c.review}`).join("\n")); return; }
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1 || runs > 10) throw new Error("invalid_arguments");
  const cases = values.case ? conversationCases.filter((c) => c.id === values.case) : conversationCases;
  if (!cases.length || (values.output && existsSync(values.output))) throw new Error("invalid_arguments");
  // Configuration validation happens before any live request. Offline runs never initialize the SDK.
  const model = values.live ? createGeminiModel(readGeminiConfig()) : undefined;
  console.log(values.live ? "LIVE Gemini evaluation against a simulated Bridge. Paid API calls enabled." :
    "OFFLINE scripted contract replay. This does not evaluate natural-language model accuracy.");
  const report = await evaluateConversations(cases, runs, model);
  for (const result of report.results) console.log(`${result.status.toUpperCase()} run ${result.run}: ${result.scenario}`);
  console.log(JSON.stringify({ mode: report.mode, passed: report.passed, failed: report.failed, latency: report.latency }));
  if (values.output) {
    await writeFile(values.output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
    console.log(`Saved report: ${values.output}`);
  }
  console.log(report.naturalLanguageReview);
  if (report.failed) process.exitCode = 1;
}
try { await main(); }
catch {
  console.error("Evaluation could not run or save its report. Check --case, --runs (1–10), an unused writable --output path, and live credentials if --live is set.");
  process.exitCode = 1;
}
