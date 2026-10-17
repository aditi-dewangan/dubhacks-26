// Test harness: the bridge wired to an in-memory realtime layer and the fake kiosk.

import type { AgentMessage, CommandAck, CommandEnvelope, KioskCommand, KioskState, SessionEndReason } from "@kiosk-access/shared";
import { FakeKiosk } from "@kiosk-access/sdk/fake";
import { createBridge, type BridgeDeps, type BridgeSession } from "./bridge.ts";

/** Anything that runs commands and reports its screen, like the fake food kiosk. */
export interface KioskLike {
  run(command: KioskCommand): Omit<CommandAck, "cmdId">;
  state(): KioskState;
}

export function setup<K extends KioskLike = FakeKiosk>(
  opts: { autoAck?: boolean; timeoutMs?: number; online?: boolean; kiosk?: K } = {},
) {
  const autoAck = opts.autoAck ?? true;
  const kiosk = (opts.kiosk ?? Object.assign(new FakeKiosk("k1"), { sessionActive: true })) as K;
  let lastState: KioskState = kiosk.state();

  const ackHandlers: ((ack: CommandAck, kioskId: string) => void)[] = [];
  const stateHandlers: Parameters<BridgeDeps["onKioskStateChange"]>[0][] = [];
  const endedHandlers: ((s: BridgeSession, r: SessionEndReason) => void)[] = [];

  const session: BridgeSession = { sessionId: "s1", kioskId: "k1", ended: false, pendingCheckout: null };
  const sessions = new Map([[session.sessionId, session]]);
  const sent: CommandEnvelope[] = [];
  const messages: AgentMessage[] = [];
  const kioskEvents: string[] = [];
  const logged: { type: string; data?: Record<string, unknown> }[] = [];
  let ids = 0;

  /** The kiosk runs a command and acks it. */
  function deliver(env: CommandEnvelope) {
    const result = kiosk.run(env.command);
    lastState = result.state;
    const ack: CommandAck = { cmdId: env.cmdId, ...result };
    for (const h of ackHandlers) h(ack, "k1");
  }

  const deps: BridgeDeps = {
    sendToKiosk(_kioskId, env) {
      if (opts.online === false) return false;
      sent.push(env);
      if (autoAck) queueMicrotask(() => deliver(env));
      return true;
    },
    onKioskAck: (h) => (ackHandlers.push(h), () => {}),
    onKioskStateChange: (h) => (stateHandlers.push(h), () => {}),
    onSessionEnded: (h) => (endedHandlers.push(h), () => {}),
    getSession: (id) => sessions.get(id),
    getKioskState: () => lastState,
    sendAgentMessage: (_id, msg) => void messages.push(msg),
    handleKioskEvent: async (_id, note) => void kioskEvents.push(note),
    logEvent: (type, fields) => void logged.push({ type, data: fields.data }),
    commandTimeoutMs: opts.timeoutMs ?? 1000,
    newId: () => `id${++ids}`,
  };
  const bridge = createBridge(deps);

  return {
    bridge,
    kiosk,
    session,
    sent,
    messages,
    kioskEvents,
    logged,
    deliver,
    /** Ack a command the test already ran on the kiosk by hand. */
    ackWithCurrentState(env: CommandEnvelope) {
      lastState = kiosk.state();
      for (const h of ackHandlers) h({ cmdId: env.cmdId, ok: true, state: lastState }, "k1");
    },
    /** How many start_payment commands ever reached the kiosk. */
    startPayments: () => sent.filter((e) => e.command.type === "start_payment").length,
    /** The kiosk publishes a new screen (kiosk:state), e.g. after a touch or a timeout. */
    publish(next: KioskState = kiosk.state()) {
      const prev = lastState;
      lastState = next;
      for (const h of stateHandlers) h("k1", prev, next, session.ended ? null : session);
    },
    /** Change what the server thinks the kiosk shows, without any event. */
    setStateSilently(next: KioskState) {
      lastState = next;
    },
    endSession(reason: SessionEndReason = "staff_ended") {
      session.ended = true;
      sessions.delete(session.sessionId);
      for (const h of endedHandlers) h(session, reason);
    },
    tool: (name: string, input: unknown = {}) => bridge.executeTool("s1", name, input),
  };
}
