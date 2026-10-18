import assert from "node:assert/strict";
import { test } from "node:test";
import { GoogleGenAI, type Content, type FunctionCall } from "@google/genai";
import { fixtures, type KioskState } from "@kiosk-access/shared";
import { createGeminiModel, GeminiError, type ModelInput } from "./gemini.ts";
import { createAgent, type AgentDependencies } from "./service.ts";
import { readHistory, MAX_HISTORY_TURNS } from "./history.ts";
import type { AgentSession } from "./loop.ts";

const answer = (text: string): Content => ({ role: "model", parts: [{ text }] });
const calls = (...functions: FunctionCall[]): Content => ({
  role: "model", parts: functions.map((functionCall, i) => ({ functionCall, thoughtSignature: `signed-${i}` })),
});
const request = (name: string, args: Record<string, unknown> = {}, id = name): FunctionCall => ({ name, args, id });

function harness(script: ((input: ModelInput) => Content | Promise<Content>)[]) {
  const session: AgentSession = { kioskId: "kiosk-a", ended: false, history: [], pendingCheckout: null };
  let state: KioskState = structuredClone(fixtures.menuState);
  const seen: ModelInput[] = [];
  const executed: { name: string; input: unknown }[] = [];
  const deps: AgentDependencies = {
    getSession: (id) => id === "a" ? session : undefined,
    getKioskState: () => state,
    sendAgentMessage: () => assert.fail("User replies must not be pushed twice"),
    generateTurn: async (input) => {
      seen.push(structuredClone(input));
      const next = script.shift();
      assert.ok(next, "Unexpected extra model call");
      return next(input);
    },
    executeTool: async (_id, name, input) => {
      executed.push({ name, input });
      if (name === "add_item") {
        state = structuredClone(fixtures.upsellState);
        return "Added one large cheeseburger, no onions. Total $8.80. Combo popup needs a response.";
      }
      if (name === "request_checkout") session.pendingCheckout = structuredClone(state.cart);
      return "Success";
    },
  };
  return { session, seen, executed, deps, agent: createAgent(deps) };
}

test("multi-turn clarification remembers choices, calls Bridge, and refreshes cart context", async () => {
  const add = calls(request("add_item", { itemId: "cheeseburger", qty: 1, options: { size: ["large"], remove: ["no_onions"] } }));
  const h = harness([
    () => answer("Regular or large?"),
    ({ contents }) => {
      assert.equal(contents[0].parts?.[0].text, "A cheeseburger, no onions");
      assert.equal(contents[1].parts?.[0].text, "Regular or large?");
      assert.equal(contents[2].parts?.[0].text, "Large");
      return add;
    },
    ({ contents, state }) => {
      assert.deepEqual(contents[3], add);
      assert.equal(contents[4].parts?.[0].functionResponse?.id, "add_item");
      assert.match(String(contents[4].parts?.[0].functionResponse?.response?.result), /Added one/);
      assert.equal(state?.cart.total, 8.8);
      assert.equal(state?.popup?.id, "popup-upsell");
      return answer("Added. Would you like the combo for two dollars more?");
    },
  ]);
  assert.equal((await h.agent.handleUserMessage("a", "A cheeseburger, no onions")).text, "Regular or large?");
  assert.equal(h.executed.length, 0);
  assert.match((await h.agent.handleUserMessage("a", "Large")).text, /Would you like/);
  assert.equal(h.executed.length, 1);
  assert.equal(h.session.history.length, 2);
  assert.deepEqual(readHistory(h.session.history)[3], add);
});

test("required size is asked before add_item reaches Bridge; a later answer is remembered", async () => {
  const h = harness([
    () => calls(request("add_item", { itemId: "cheeseburger", qty: 1, options: { remove: ["no_onions"] } })),
    ({ contents }) => {
      assert.match(String(contents[2].parts?.[0].functionResponse?.response?.result), /Size is required/);
      return answer("Regular or large?");
    },
    ({ contents }) => {
      assert.equal(contents[4].parts?.[0].text, "Regular");
      return calls(request("add_item", { itemId: "cheeseburger", qty: 1, options: { size: ["regular"], remove: ["no_onions"] } }));
    },
    ({ contents }) => {
      assert.match(String(contents[6].parts?.[0].functionResponse?.response?.result), /Added one/);
      return answer("Added your regular cheeseburger without onions.");
    },
  ]);
  assert.match((await h.agent.handleUserMessage("a", "One cheeseburger, no onions")).text, /Regular or large/);
  assert.equal(h.executed.length, 0, "missing size must not reach Bridge");
  assert.match((await h.agent.handleUserMessage("a", "Regular")).text, /regular cheeseburger/);
  assert.equal(h.executed.length, 1);
});

test("two differently customized copies use separate quantity-one calls", async () => {
  const burger = { itemId: "cheeseburger", qty: 1 };
  const h = harness([
    () => calls(
      request("add_item", { ...burger, options: { size: ["regular"], remove: ["no_onions"] } }, "no-onion"),
      request("add_item", { ...burger, options: { size: ["regular"] } }, "plain"),
    ),
    ({ contents }) => {
      const results = contents[2].parts!.map((p) => p.functionResponse!.response!.result as string);
      assert.match(results[0], /Added one no-onion burger/);
      assert.match(results[1], /popup/i);
      return answer("I added the first burger. There's a combo popup to answer before I add the second.");
    },
  ]);
  let current = structuredClone(fixtures.menuState);
  h.deps.getKioskState = () => current;
  h.deps.executeTool = async (_id, name, input) => {
    h.executed.push({ name, input });
    current = structuredClone(fixtures.upsellState);
    return "Added one no-onion burger; combo popup is showing.";
  };
  const message = await h.agent.handleUserMessage("a", "Two cheeseburgers, one with no onions. Regular size for both.");
  assert.equal(h.executed.length, 1);
  assert.deepEqual(h.executed[0], { name: "add_item", input: { ...burger, options: { size: ["regular"], remove: ["no_onions"] } } });
  assert.match(message.text, /popup/);
});

test("multiple calls run sequentially and every response retains its name and ID", async () => {
  let inFlight = 0;
  const order: string[] = [];
  const h = harness([
    () => calls(request("get_menu", {}, "m1"), request("get_kiosk_state", {}, "s1")),
    ({ contents }) => {
      assert.deepEqual(contents[2].parts?.map((part) => part.functionResponse), [
        { name: "get_menu", id: "m1", response: { result: "get_menu done" } },
        { name: "get_kiosk_state", id: "s1", response: { result: "get_kiosk_state done" } },
      ]);
      return answer("Here is your order.");
    },
  ]);
  h.deps.executeTool = async (_id, name) => {
    assert.equal(inFlight++, 0);
    order.push(name);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight--;
    return `${name} done`;
  };
  await h.agent.handleUserMessage("a", "Show my order");
  assert.deepEqual(order, ["get_menu", "get_kiosk_state"]);
});

test("bridge rejection reaches the model unchanged and is not treated as success", async () => {
  const rejection = "Size is required: regular or large.";
  const h = harness([
    () => calls(request("add_item", { itemId: "water", qty: 1, options: {} })),
    ({ contents }) => {
      assert.equal(contents[2].parts?.[0].functionResponse?.response?.result, rejection);
      return answer("Regular or large?");
    },
  ]);
  h.deps.executeTool = async () => rejection;
  assert.equal((await h.agent.handleUserMessage("a", "A burger")).text, "Regular or large?");
});

test("tool exceptions are safe context and prevent replaying uncertain mutations", async () => {
  const h = harness([
    () => calls(request("add_item", { itemId: "water", qty: 1, options: {} })),
    ({ contents }) => {
      assert.match(String(contents[2].parts?.[0].functionResponse?.response?.result), /outcome may be unknown/);
      return calls(request("get_kiosk_state"), request("add_item", { itemId: "water", qty: 1, options: {} }));
    },
    ({ contents }) => {
      assert.match(String(contents[4].parts?.[1].functionResponse?.response?.result), /Not executed/);
      assert.ok(!JSON.stringify(contents).includes("secret-key"));
      return answer("Please review your order before another change.");
    },
  ]);
  const executed: string[] = [];
  h.deps.executeTool = async (_id, name) => {
    executed.push(name);
    if (name === "add_item") throw new Error("request had secret-key");
    return "Current cart";
  };
  await h.agent.handleUserMessage("a", "A burger");
  assert.deepEqual(executed, ["add_item", "get_kiosk_state"]);
});

test("unknown and direct payment calls cannot reach Bridge", async () => {
  const h = harness([
    () => calls(request("start_payment"), request("press", { buttonId: "btn-pay" })),
    ({ contents }) => {
      assert.ok(contents[2].parts?.every((p) => String(p.functionResponse?.response?.result).startsWith("Unknown agent tool")));
      return answer("Payment requires your explicit confirmation.");
    },
  ]);
  assert.equal((await h.agent.handleUserMessage("a", "Pay now")).awaitingConfirmation, false);
  assert.deepEqual(h.executed, []);
});

test("six model rounds is a hard cap and call/result pairs survive the fallback", async () => {
  const h = harness(Array.from({ length: 6 }, () => () => calls(request("get_kiosk_state"))));
  assert.match((await h.agent.handleUserMessage("a", "What's happening?")).text, /limit/);
  assert.equal(h.seen.length, 6);
  assert.equal(h.executed.length, 6);
  const saved = readHistory(h.session.history);
  assert.equal(saved.filter((c) => c.parts?.some((p) => p.functionCall)).length, 6);
  assert.equal(saved.filter((c) => c.parts?.some((p) => p.functionResponse)).length, 6);
  assert.match(saved.at(-1)!.parts![0].text!, /limit/);
});

test("oversized batches execute nothing and receive a result for every call", async () => {
  const h = harness([
    () => calls(...Array.from({ length: 9 }, (_, i) => request("add_item", {}, String(i)))),
    ({ contents }) => {
      assert.equal(contents[2].parts?.length, 9);
      assert.match(String(contents[2].parts?.[0].functionResponse?.response?.result), /too many/);
      return answer("Please tell me one item at a time.");
    },
  ]);
  await h.agent.handleUserMessage("a", "Many burgers");
  assert.equal(h.executed.length, 0);
});

test("confirmation flag comes from the Bridge snapshot rather than model wording", async () => {
  const h = harness([
    () => answer("Your order is confirmed."),
    () => calls(request("request_checkout")),
    () => answer("Please confirm the order."),
  ]);
  assert.equal((await h.agent.handleUserMessage("a", "Done")).awaitingConfirmation, false);
  assert.equal((await h.agent.handleUserMessage("a", "Checkout")).awaitingConfirmation, true);
});

test("failed generation after a mutation preserves the result for the next turn", async () => {
  const h = harness([
    () => calls(request("add_item", { itemId: "water", qty: 1, options: {} })),
    () => { throw new GeminiError("timeout"); },
    ({ contents }) => {
      assert.ok(contents.some((c) => c.parts?.some((p) => p.functionResponse?.name === "add_item")));
      return answer("Your cheeseburger is already in the cart.");
    },
  ]);
  assert.match((await h.agent.handleUserMessage("a", "A burger")).text, /may have changed/);
  await h.agent.handleUserMessage("a", "Did it work?");
  assert.equal(h.executed.length, 1);
});

test("session ending during a model call prevents tools and history writes", async () => {
  const h = harness([() => { h.session.ended = true; return calls(request("add_item")); }]);
  assert.match((await h.agent.handleUserMessage("a", "A burger")).text, /session has ended/);
  assert.equal(h.executed.length, 0);
  assert.equal(h.session.history.length, 0);
});

test("session ending during a tool prevents later calls in the batch", async () => {
  const h = harness([() => calls(request("get_menu"), request("add_item"))]);
  let count = 0;
  h.deps.executeTool = async () => { count++; h.session.ended = true; return "Session ended"; };
  assert.match((await h.agent.handleUserMessage("a", "Order")).text, /session has ended/);
  assert.equal(count, 1);
  assert.equal(h.session.history.length, 0);
});

test("simultaneous sessions never share conversation history", async () => {
  const sessions = new Map<string, AgentSession>(["a", "b"].map((id) => [id, {
    kioskId: id, ended: false, history: [], pendingCheckout: null,
  }]));
  const agent = createAgent({
    getSession: (id) => sessions.get(id), getKioskState: () => null, sendAgentMessage: () => {},
    generateTurn: async ({ contents }) => answer(contents.at(-1)!.parts![0].text!),
  });
  await Promise.all([agent.handleUserMessage("a", "Only Alice"), agent.handleUserMessage("b", "Only Bob")]);
  assert.ok(!JSON.stringify(sessions.get("a")!.history).includes("Bob"));
  assert.ok(!JSON.stringify(sessions.get("b")!.history).includes("Alice"));
});

test("history trims complete oldest exchanges, keeping tool pairs and signatures intact", async () => {
  const h = harness([]);
  h.deps.generateTurn = async ({ contents }) => {
    if (contents.at(-1)?.parts?.some((part) => part.functionResponse)) return answer("Done");
    return calls(request("get_menu"));
  };
  for (let i = 0; i < MAX_HISTORY_TURNS + 1; i++) await h.agent.handleUserMessage("a", `turn-${i}`);
  assert.equal(h.session.history.length, MAX_HISTORY_TURNS);
  const history = readHistory(h.session.history);
  assert.equal(history[0].parts?.[0].text, "turn-1");
  assert.equal(history[1].parts?.[0].thoughtSignature, "signed-0");
  assert.equal(history[2].parts?.[0].functionResponse?.name, "get_menu");
});

test("real SDK carries tool declarations and signed tool exchanges across model calls", async () => {
  let round = 0;
  const signed = calls(request("get_menu", { categoryId: "burgers" }, "call-123"));
  const client = new GoogleGenAI({ apiKey: "offline-test", vertexai: false, httpOptions: {
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.tools[0].functionDeclarations.length, 10);
      assert.ok(!JSON.stringify(body.tools).includes('"name":"start_payment"'));
      if (round++ > 0) {
        assert.deepEqual(body.contents[1], signed);
        assert.equal(body.contents[2].parts[0].functionResponse.id, "call-123");
      }
      return new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: round === 1 ? signed : answer("Burgers start at six forty-nine.") }] }),
        { status: 200, headers: { "content-type": "application/json" } });
    },
  } });
  const h = harness([]);
  h.deps.generateTurn = createGeminiModel({ apiKey: "offline-test", model: "test-model" }, (input) => client.models.generateContent(input));
  assert.match((await h.agent.handleUserMessage("a", "What burgers?")).text, /six forty-nine/);
  assert.equal(round, 2);
  assert.equal(h.executed[0].name, "get_menu");
});
