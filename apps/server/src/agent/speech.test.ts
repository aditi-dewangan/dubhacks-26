import assert from "node:assert/strict";
import { test } from "node:test";
import { createSpeechController, type Recognition, SpeechError } from "../../../phone/src/speech.ts";
import { createAgentVoice } from "../../../phone/src/agentSpeech.ts";

function fixture() {
  const instances: FakeRecognition[] = [];
  class FakeRecognition implements Recognition {
    lang = ""; continuous = false; interimResults = false;
    onresult: Recognition["onresult"] = null;
    onerror: Recognition["onerror"] = null;
    onend: Recognition["onend"] = null;
    constructor() { instances.push(this); }
    start() {}
    abort() {}
    result(text: string) { this.onresult?.({ results: [{ isFinal: true, 0: { transcript: text } }] }); }
  }
  const spoken: SpeechSynthesisUtterance[] = [];
  let cancels = 0;
  const controller = createSpeechController(() => ({ recognition: FakeRecognition,
    utterance: class { constructor(readonly text: string) {} } as unknown as new (text: string) => SpeechSynthesisUtterance,
    synthesis: { cancel: () => { cancels++; }, speak: (value) => { spoken.push(value); } },
  }));
  return { controller, instances, spoken, cancels: () => cancels };
}
test("recognition emits one final transcript and restarting settles the old listener", async () => {
  const h = fixture();
  const first = h.controller.listen();
  const cancelled = assert.rejects(first, (error: unknown) => error instanceof SpeechError && error.code === "cancelled");
  const second = h.controller.listen();
  h.instances[0].result("stale");
  h.instances[1].result("  large burger  ");
  await cancelled;
  assert.equal(await second, "large burger");
  assert.equal(h.instances[1].onresult, null);
});
test("unsupported recognition, permission denial and timeout offer text fallback", async () => {
  await assert.rejects(createSpeechController(() => ({})).listen(), /Please type/);
  const h = fixture();
  const listening = h.controller.listen();
  h.instances[0].onerror?.({ error: "not-allowed" });
  await assert.rejects(listening, /denied/);
  await assert.rejects(h.controller.listen({ timeoutMs: 1 }), /timed out/);
});
test("starting recognition cancels speech; replacing speech settles both promises", async () => {
  const h = fixture();
  const first = h.controller.speak("First");
  const second = h.controller.speak("Second");
  await first;
  const listening = h.controller.listen();
  await second;
  assert.ok(h.cancels() >= 3);
  h.instances[0].result("hello");
  await listening;
});
test("phone adapter sends transcripts once and prevents sends after disposal", async () => {
  const h = fixture();
  const sent: string[] = [];
  const voice = createAgentVoice({ sendText: (text) => { sent.push(text); }, showTranscript: () => {}, showStatus: () => {} }, () => 1, h.controller);
  const listening = voice.listenAndSend();
  h.instances[0].result("One water");
  await listening;
  assert.deepEqual(sent, ["One water"]);
  const late = voice.listenAndSend();
  voice.dispose();
  h.instances[1].result("two waters");
  await late;
  voice.sendTyped("late text");
  assert.deepEqual(sent, ["One water"]);
});

test("completion announces the actual number once and survives completed-session teardown", async () => {
  const h = fixture();
  const statuses: string[] = [];
  const voice = createAgentVoice({ sendText: () => assert.fail("completed orders cannot send"),
    showTranscript: () => {}, showStatus: (text) => { statuses.push(text); } }, () => 1, h.controller);
  voice.setEnabled(true);
  await voice.receiveKioskState({ screen: "paying", orderNumber: "142" });
  assert.equal(h.spoken.length, 0);
  const done = voice.receiveKioskState({ screen: "complete", orderNumber: "142" });
  const cancels = h.cancels();
  voice.endSession("order_complete");
  await voice.receiveKioskState({ screen: "complete", orderNumber: "142" });
  await voice.receiveReply({ text: "late model reply" });
  voice.sendTyped("late message");
  assert.equal(h.cancels(), cancels);
  assert.equal(h.spoken.length, 1);
  assert.match(h.spoken[0].text, /order number is 142/);
  assert.equal(statuses.length, 1);
  h.spoken[0].onend?.({} as SpeechSynthesisEvent);
  await done;
  voice.dispose();
});

test("completion can arrive after order_complete but not after another end reason", async () => {
  for (const reason of ["order_complete", "staff_ended"]) {
    const h = fixture();
    const statuses: string[] = [];
    const voice = createAgentVoice({ sendText: () => {}, showTranscript: () => {},
      showStatus: (text) => { statuses.push(text); } }, () => 1, h.controller);
    voice.endSession(reason);
    await voice.receiveKioskState({ screen: "complete", orderNumber: "142" });
    assert.equal(statuses.length, reason === "order_complete" ? 1 : 0);
    voice.dispose();
  }
});

test("socket binding removes its listeners and cancels speech on cleanup", async () => {
  const { EventEmitter } = await import("node:events");
  const { bindVoiceSocket } = await import("../../../phone/src/voiceSocket.ts");
  const socket = new EventEmitter();
  const h = fixture();
  const voice = createAgentVoice({ sendText: () => {}, showTranscript: () => {}, showStatus: () => {} }, () => 1, h.controller);
  const cleanup = bindVoiceSocket(socket, voice);
  assert.equal(socket.listenerCount("kiosk:state"), 1);
  cleanup(); cleanup();
  assert.equal(socket.listenerCount("agent:message"), 0);
  assert.equal(socket.listenerCount("kiosk:state"), 0);
  assert.equal(socket.listenerCount("session:ended"), 0);
});

test("falls back to recording when the browser refuses its own recognition (Chrome on iPhone)", async () => {
  let fallbackCalls = 0;
  class RefusingRecognition implements Recognition {
    lang = ""; continuous = false; interimResults = false;
    onresult: Recognition["onresult"] = null; onerror: Recognition["onerror"] = null; onend: Recognition["onend"] = null;
    start() { queueMicrotask(() => this.onerror?.({ error: "service-not-allowed" })); }
    abort() {}
  }
  const controller = createSpeechController(() => ({
    recognition: RefusingRecognition,
    fallback: () => { fallbackCalls++; return { result: Promise.resolve("two cheeseburgers"), cancel() {} }; },
  }));
  assert.equal(await controller.listen(), "two cheeseburgers");
  // Later listens go straight to the fallback.
  assert.equal(await controller.listen(), "two cheeseburgers");
  assert.equal(fallbackCalls, 2);
});

test("uses the fallback when there is no browser recognition, and it can be cancelled", async () => {
  let cancelled = false;
  const controller = createSpeechController(() => ({
    fallback: () => ({ result: new Promise<string>(() => {}), cancel() { cancelled = true; } }),
  }));
  assert.equal(controller.support().recognition, true);
  const pending = controller.listen();
  controller.stopListening();
  await assert.rejects(pending, (e: unknown) => e instanceof SpeechError && e.code === "cancelled");
  assert.equal(cancelled, true);
});

test("without a fallback, a refused mic is still reported as denied", async () => {
  class Refusing implements Recognition {
    lang = ""; continuous = false; interimResults = false;
    onresult: Recognition["onresult"] = null; onerror: Recognition["onerror"] = null; onend: Recognition["onend"] = null;
    start() { queueMicrotask(() => this.onerror?.({ error: "not-allowed" })); }
    abort() {}
  }
  const controller = createSpeechController(() => ({ recognition: Refusing }));
  await assert.rejects(controller.listen(), (e: unknown) => e instanceof SpeechError && e.code === "permission_denied");
});

test("preferFallback skips the browser's recognition entirely (Chrome on iPhone)", async () => {
  let started = 0;
  class Never implements Recognition {
    lang = ""; continuous = false; interimResults = false;
    onresult: Recognition["onresult"] = null; onerror: Recognition["onerror"] = null; onend: Recognition["onend"] = null;
    start() { started++; }
    abort() {}
  }
  const controller = createSpeechController(() => ({
    recognition: Never, preferFallback: true,
    fallback: () => ({ result: Promise.resolve("a large fries"), cancel() {} }),
  }));
  assert.equal(await controller.listen(), "a large fries");
  assert.equal(started, 0);
});

test("Safari's 'not-allowed' (needs a tap) uses the fallback once but keeps trying the browser", async () => {
  let started = 0;
  let remembered = 0;
  class NeedsTap implements Recognition {
    lang = ""; continuous = false; interimResults = false;
    onresult: Recognition["onresult"] = null; onerror: Recognition["onerror"] = null; onend: Recognition["onend"] = null;
    start() { started++; queueMicrotask(() => this.onerror?.({ error: "not-allowed" })); }
    abort() {}
  }
  const controller = createSpeechController(() => ({
    recognition: NeedsTap, rememberFallback() { remembered++; },
    fallback: () => ({ result: Promise.resolve("a shake"), cancel() {} }),
  }));
  assert.equal(await controller.listen(), "a shake");
  assert.equal(await controller.listen(), "a shake");
  assert.equal(started, 2);
  assert.equal(remembered, 0);
});
test("speech the phone won't start is reported as blocked; a touch replays it, or the fallback", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  type FakeUtterance = { text: string; onstart?: () => void; onend?: () => void };
  const h = fixture();
  const blocked: boolean[] = [];
  const voice = createAgentVoice({ sendText: () => {}, showTranscript: () => {}, showStatus: () => {},
    speechBlocked: (value) => { blocked.push(value); } }, () => 1, h.controller);
  voice.setEnabled(true, { handsFree: false });
  const greeting = voice.speakFeedback("Welcome");
  t.mock.timers.tick(3000); // iPhone before the first touch: speech never starts
  await greeting;
  assert.deepEqual(blocked, [true]);

  voice.replaySilent("Last message");
  const replay = h.spoken.at(-1) as unknown as FakeUtterance;
  assert.equal(replay.text, "Welcome"); // what it couldn't say wins over the fallback
  replay.onstart?.();
  assert.deepEqual(blocked, [true, false]);
  replay.onend?.();
  await new Promise((resolve) => setImmediate(resolve)); // let the replay finish

  voice.replaySilent("Last message"); // nothing waiting: says the fallback
  assert.equal((h.spoken.at(-1) as unknown as FakeUtterance).text, "Last message");
});
test("Safari's 'not-allowed' before the first touch counts as blocked, so the Tap to hear button shows", async () => {
  type FakeUtterance = { text: string; onstart?: () => void; onend?: () => void; onerror?: (event: { error: string }) => void };
  const h = fixture();
  const blocked: boolean[] = [];
  const voice = createAgentVoice({ sendText: () => {}, showTranscript: () => {}, showStatus: () => assert.fail("no error message for a blocked greeting"),
    speechBlocked: (value) => { blocked.push(value); } }, () => 1, h.controller);
  voice.setEnabled(true, { handsFree: false });
  const greeting = voice.greet("Welcome", { auto: true });
  (h.spoken[0] as unknown as FakeUtterance).onerror?.({ error: "not-allowed" });
  await greeting;
  assert.deepEqual(blocked, [true]);
  voice.replaySilent(); // the touch
  assert.equal((h.spoken.at(-1) as unknown as FakeUtterance).text, "Welcome");
});
