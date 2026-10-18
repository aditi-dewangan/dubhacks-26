import assert from "node:assert/strict";
import { test } from "node:test";
import { GoogleGenAI, GenerateContentResponse, FinishReason } from "@google/genai";
import { fixtures, menu } from "@kiosk-access/shared";
import { readAgentMode } from "./config.ts";
import { createGeminiResponder, GeminiError, type GenerateContent } from "./gemini.ts";
import { buildSystemPrompt, buildTurnContext } from "./prompt.ts";
import { createAgent } from "./service.ts";

const config = { apiKey: "fake-key-for-offline-tests", model: "test-model" };
function response(text = "The cheeseburger starts at six forty-nine.") {
  return Object.assign(new GenerateContentResponse(), {
    candidates: [{ finishReason: FinishReason.STOP, content: { role: "model", parts: [{ text }] } }],
  });
}

test("prompt menu is sourced from shared data, including prices, required choices and hidden status", () => {
  const prompt = buildSystemPrompt();
  const embedded = JSON.parse(prompt.split("MENU_JSON:\n")[1].split("\n\nVISIBLE_ITEMS_AND_REQUIRED_CHOICES:")[0]);
  assert.equal(embedded.taxRate, menu.taxRate);
  for (const item of menu.items) {
    const grounded = embedded.items.find((entry: { id: string }) => entry.id === item.id);
    assert.equal(grounded.price, item.price);
    assert.equal(grounded.hidden, item.hidden ?? false);
    assert.deepEqual(grounded.optionGroups, item.optionGroups);
  }
  // A menu edit must reach the model without a second hardcoded copy.
  const edited = structuredClone(menu);
  edited.items[0].price = 12.34;
  assert.equal(JSON.parse(buildSystemPrompt(edited).split("MENU_JSON:\n")[1].split("\n\nVISIBLE_ITEMS_AND_REQUIRED_CHOICES:")[0]).items[0].price, 12.34);
});

test("context uses actual cart totals and excludes identity/extra session fields", () => {
  const context = JSON.parse(buildTurnContext({ ...fixtures.upsellState, sessionSecret: "private" } as typeof fixtures.upsellState));
  assert.deepEqual(context.cart, fixtures.upsellState.cart);
  assert.deepEqual(context.popup, fixtures.upsellState.popup);
  assert.equal(context.kioskId, undefined);
  assert.equal(context.sessionSecret, undefined);
  assert.deepEqual(JSON.parse(buildTurnContext(null)), { stateUnavailable: true });
});

test("SDK sends the grounded prompt, current state and customer text with no action tools", async () => {
  let requests = 0;
  const client = new GoogleGenAI({
    apiKey: config.apiKey, vertexai: false,
    httpOptions: { fetch: async (url, init) => {
      requests++;
      assert.match(String(url), /test-model:generateContent/);
      assert.equal(new Headers(init?.headers).get("x-goog-api-key"), config.apiKey);
      const body = JSON.parse(String(init?.body));
      assert.match(JSON.stringify(body.systemInstruction), /box_combo/);
      assert.match(JSON.stringify(body.contents), /What burgers do you have/);
      assert.match(JSON.stringify(body.systemInstruction), /CURRENT_KIOSK_STATE_JSON/);
      assert.equal(body.tools, undefined);
      assert.equal(body.generationConfig.maxOutputTokens, 2048);
      return new Response(JSON.stringify(response()), { status: 200, headers: { "content-type": "application/json" } });
    } },
  });
  const reply = await createGeminiResponder(config, (request) => client.models.generateContent(request))({
    text: "What burgers do you have?", state: fixtures.menuState,
  });
  assert.equal(reply, "The cheeseburger starts at six forty-nine.");
  assert.equal(requests, 1);
});

test("empty, truncated, safety-blocked and unexpected tool responses are rejected", async () => {
  const truncated = response("Your order is");
  truncated.candidates![0].finishReason = FinishReason.MAX_TOKENS;
  const blocked = response("partial text");
  blocked.candidates![0].finishReason = FinishReason.SAFETY;
  const tool = response();
  tool.candidates![0].content!.parts!.push({ functionCall: { name: "add_item", args: {} } });
  for (const output of [response("  "), new GenerateContentResponse(), truncated, blocked, tool]) {
    await assert.rejects(createGeminiResponder(config, async () => output)({ text: "hello", state: null }),
      (error) => error instanceof GeminiError && error.code === "invalid_response");
  }
});

test("thought text is never spoken", async () => {
  const output = response();
  output.candidates![0].content!.parts!.unshift({ thought: true, text: "Internal reasoning" });
  assert.equal(await createGeminiResponder(config, async () => output)({ text: "hello", state: null }),
    "The cheeseburger starts at six forty-nine.");
});

test("provider failures expose only safe classifications and make no retries", async () => {
  for (const [status, code] of [[429, "rate_limit"], [403, "unavailable"], [503, "unavailable"]] as const) {
    let attempts = 0;
    await assert.rejects(createGeminiResponder(config, async () => {
      attempts++;
      throw Object.assign(new Error(`Request header contained ${config.apiKey}`), { status });
    })({ text: "hello", state: null }), (error) => {
      assert.ok(error instanceof GeminiError);
      assert.equal(error.code, code);
      assert.ok(!String(error).includes(config.apiKey));
      return true;
    });
    assert.equal(attempts, 1);
  }
});

test("deadline aborts a stalled provider and releases the caller", async () => {
  let signal: AbortSignal | undefined;
  const stalled: GenerateContent = (request) => {
    signal = request.config?.abortSignal;
    return new Promise(() => {});
  };
  await assert.rejects(createGeminiResponder(config, stalled, 15)({ text: "hello", state: null }),
    (error) => error instanceof GeminiError && error.code === "timeout");
  assert.equal(signal?.aborted, true);
});

test("Gemini replies preserve the phone response contract without opening checkout", async () => {
  const session = { kioskId: "a", ended: false, history: [], pendingCheckout: null };
  const agent = createAgent({
    getSession: () => session,
    getKioskState: () => fixtures.menuState,
    sendAgentMessage: () => assert.fail("User replies must be returned"),
    generateTurn: async ({ contents, state }) => {
      assert.equal(contents[0].parts?.[0].text, "What burgers?");
      assert.equal(state, fixtures.menuState);
      return { role: "model", parts: [{ text: "The cheeseburger is six forty-nine." }] };
    },
  });
  assert.deepEqual(await agent.handleUserMessage("a", "What burgers?"), {
    text: "The cheeseburger is six forty-nine.", awaitingConfirmation: false,
  });
});

test("late provider replies are discarded after the session ends", async () => {
  const session = { kioskId: "a", ended: false, history: [], pendingCheckout: null };
  const agent = createAgent({
    getSession: () => session, getKioskState: () => fixtures.menuState,
    sendAgentMessage: () => assert.fail("Must not push"),
    generateTurn: async () => { session.ended = true; return { role: "model", parts: [{ text: "Stale reply" }] }; },
  });
  assert.match((await agent.handleUserMessage("a", "hello")).text, /session has ended/);
});

test("provider failure returns a usable reply and logs no raw SDK errors", async () => {
  const logged: unknown[] = [];
  const session = { kioskId: "a", ended: false, history: [], pendingCheckout: null };
  const agent = createAgent({
    getSession: () => session, getKioskState: () => null,
    sendAgentMessage: () => assert.fail("Must not push"),
    generateTurn: async () => { throw new Error(`secret ${config.apiKey}`); },
    reportFailure: (...args) => { logged.push(args); },
  });
  const reply = await agent.handleUserMessage("a", "hello");
  assert.match(reply.text, /try again/);
  assert.equal(reply.awaitingConfirmation, false);
  assert.deepEqual(logged, [["a", "unavailable"]]);
  assert.ok(!JSON.stringify({ reply, logged }).includes(config.apiKey));
});

test("mode selection keeps offline integration explicit and rejects typos", () => {
  assert.equal(readAgentMode({}), "stub");
  assert.equal(readAgentMode({ AGENT_MODE: "gemini" }), "gemini");
  assert.throws(() => readAgentMode({ AGENT_MODE: "gemni" }), /AGENT_MODE/);
});

test("clinic, cinema and transit prompts carry no food menu and never mention Raising Cane's", () => {
  for (const kind of ["clinic", "cinema", "transit"] as const) {
    const prompt = buildSystemPrompt(undefined, true, false, kind);
    assert.doesNotMatch(prompt, /MENU_JSON/);
    assert.match(prompt, /never\s+mention Raising Cane's/);
    assert.match(prompt, /Never say the customer will get a notification/);
  }
  assert.match(buildSystemPrompt(undefined, true, false, "clinic"), /spell it letter by letter/);
  assert.doesNotMatch(buildSystemPrompt(undefined, true, false, "transit"), /spell it letter by letter/);
  // The food kiosk keeps its menu, plus the same payment rule.
  assert.match(buildSystemPrompt(), /MENU_JSON/);
  assert.match(buildSystemPrompt(), /Never say the customer will get a notification/);
});
