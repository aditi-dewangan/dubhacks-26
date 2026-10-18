// OWNER: Shruti (Bridge). The SDK a kiosk vendor adds. All socket code lives here.
//
//   const access = AccessKiosk.connect({ serverUrl, kioskId, kioskKey });
//   access.onPairingCode((url) => setQrUrl(url));
//   access.onSession((s) => setSessionActive(s.active));
//   access.publishState(toKioskState());
//   access.onCommand(async (cmd) => runCommand(cmd)); // returns { ok, error?, state }

import { io, type Socket } from "socket.io-client";
import type {
  ClientToServerEvents,
  CommandAck,
  KioskCommand,
  KioskState,
  ServerToClientEvents,
  SessionInfo,
} from "@kiosk-access/shared";

export interface ConnectOptions {
  serverUrl: string;
  kioskId: string;
  kioskKey: string;
  /** How long publishState waits for more changes before sending. Default 100 ms. */
  debounceMs?: number;
  /** How long to wait for the server to answer kiosk:register. Default 5000 ms. */
  registerTimeoutMs?: number;
  /**
   * A command that hasn't started within this long of arriving is refused instead of run
   * (the server has given up on it by then, so running it late would surprise the customer).
   * Default 15000 ms.
   */
  commandTtlMs?: number;
}

export type CommandResult = { ok: boolean; error?: string; state: KioskState };
export type CommandHandler = (command: KioskCommand) => Promise<CommandResult>;
export type ConnectionStatus = "connecting" | "online" | "offline" | "rejected";

type Listener<T> = (value: T) => void;

/** Acks for this many recent commands are kept, so a repeated cmdId is re-acked, not re-run. */
const RECENT_ACKS = 50;

export class AccessKiosk {
  private socket: Socket<ServerToClientEvents, ClientToServerEvents>;
  private commandHandler: CommandHandler | null = null;
  private commandQueue: Promise<void> = Promise.resolve();
  private lastState: KioskState | null = null;
  private lastPairingUrl: string | null = null;
  private session: SessionInfo | null = null;
  private status: ConnectionStatus = "connecting";

  private stateTimer: ReturnType<typeof setTimeout> | null = null;
  /** Acks finished while offline. Sent after the next successful kiosk:register. */
  private unsentAcks: CommandAck[] = [];
  /** cmdId -> ack (or the pending run) for recent commands. */
  private recentAcks = new Map<string, CommandAck | "running">();
  /** Sessions that have ended; their leftover commands are refused, never run. */
  private endedSessions = new Set<string>();

  private pairingListeners = new Set<Listener<string>>();
  private sessionListeners = new Set<Listener<SessionInfo>>();
  private statusListeners = new Set<Listener<ConnectionStatus>>();
  private pingListeners = new Set<Listener<{ from: string; text: string }>>();

  static connect(options: ConnectOptions): AccessKiosk {
    return new AccessKiosk(options);
  }

  private constructor(private options: ConnectOptions) {
    this.socket = io(options.serverUrl, { transports: ["websocket", "polling"] });

    // Socket.io reuses this socket object across reconnects, so each handler is attached
    // exactly once. Registration runs again on every connect.
    this.socket.on("connect", () => void this.register());
    this.socket.on("disconnect", () => this.setStatus("offline"));
    this.socket.on("connect_error", () => this.setStatus("offline"));

    this.socket.on("kiosk:pairing-code", ({ url }) => {
      this.lastPairingUrl = url;
      this.pairingListeners.forEach((l) => l(url));
    });
    this.socket.on("session:started", (info) => this.setSession(info));
    this.socket.on("session:ended", (info) => {
      if (info?.sessionId) this.endedSessions.add(info.sessionId);
      this.setSession(info);
    });
    this.socket.on("debug:ping", (p) => this.pingListeners.forEach((l) => l(p)));
    this.socket.on("kiosk:command", (env) => {
      if (!env || typeof env.cmdId !== "string") return;
      const seen = this.recentAcks.get(env.cmdId);
      if (seen === "running") return; // already queued or running
      if (seen) return this.sendAck(seen); // the server missed our ack; resend it

      this.remember(env.cmdId, "running");
      const receivedAt = Date.now();
      // Run commands strictly one at a time, in arrival order.
      this.commandQueue = this.commandQueue.then(async () => {
        let result: CommandResult;
        try {
          if (this.endedSessions.has(env.sessionId)) throw new Error("That ordering session has ended, so nothing was changed.");
          if (Date.now() - receivedAt > (this.options.commandTtlMs ?? 15_000)) {
            throw new Error("That request waited too long and was cancelled, so nothing was changed.");
          }
          if (!this.commandHandler) throw new Error("This kiosk can't take commands yet.");
          result = await this.commandHandler(env.command);
        } catch (err) {
          result = {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            state: this.lastState ?? emptyState(this.options.kioskId),
          };
        }
        this.lastState = result.state;
        const ack: CommandAck = { cmdId: env.cmdId, ok: result.ok, state: result.state };
        if (result.error) ack.error = result.error;
        this.remember(env.cmdId, ack);
        this.sendAck(ack);
      });
    });
  }

  /** Publish what is on screen. Call it every time the screen changes; sends are debounced. */
  publishState(state: KioskState) {
    this.lastState = state;
    if (this.stateTimer) clearTimeout(this.stateTimer);
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      this.flushState();
    }, this.options.debounceMs ?? 100);
  }

  /** Handle commands from the accessible-ordering assistant. */
  onCommand(handler: CommandHandler) {
    this.commandHandler = handler;
  }

  /** The QR code URL. Called right away with the current one, and again on every rotation. */
  onPairingCode(listener: Listener<string>) {
    this.pairingListeners.add(listener);
    if (this.lastPairingUrl) listener(this.lastPairingUrl);
    return () => this.pairingListeners.delete(listener);
  }

  /** An accessible session started (active: true) or ended (active: false). */
  onSession(listener: Listener<SessionInfo>) {
    this.sessionListeners.add(listener);
    if (this.session) listener(this.session);
    return () => this.sessionListeners.delete(listener);
  }

  onStatus(listener: Listener<ConnectionStatus>) {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  onPing(listener: Listener<{ from: string; text: string }>) {
    this.pingListeners.add(listener);
    return () => this.pingListeners.delete(listener);
  }

  /** Staff pressed "End accessible session". */
  endSession() {
    this.socket.emit("kiosk:end-session");
  }

  ping(text: string) {
    this.socket.emit("debug:ping", { text });
  }

  disconnect() {
    if (this.stateTimer) clearTimeout(this.stateTimer);
    this.stateTimer = null;
    this.socket.disconnect();
  }

  private async register() {
    this.setStatus("connecting");
    let res;
    try {
      res = await this.socket.timeout(this.options.registerTimeoutMs ?? 5000).emitWithAck("kiosk:register", {
        kioskId: this.options.kioskId,
        kioskKey: this.options.kioskKey,
      });
    } catch {
      // No answer. Drop the connection and let socket.io's backoff try again.
      if (this.socket.connected) {
        this.socket.disconnect();
        this.socket.connect();
      }
      return;
    }
    if (!this.socket.connected) return;
    if (!res.ok) {
      this.setStatus("rejected");
      console.error("[AccessKiosk] registration rejected:", res.error);
      return;
    }
    this.setStatus("online");
    // The server only listens for state and acks after registering, so send them now.
    for (const ack of this.unsentAcks.splice(0)) this.socket.emit("kiosk:ack", ack);
    this.flushState();
  }

  private flushState() {
    if (this.stateTimer) clearTimeout(this.stateTimer);
    this.stateTimer = null;
    if (this.lastState && this.isOnline()) this.socket.emit("kiosk:state", this.lastState);
  }

  private sendAck(ack: CommandAck) {
    if (this.isOnline()) this.socket.emit("kiosk:ack", ack);
    else this.unsentAcks.push(ack);
  }

  private isOnline() {
    return this.status === "online" && this.socket.connected;
  }

  private remember(cmdId: string, value: CommandAck | "running") {
    this.recentAcks.delete(cmdId);
    this.recentAcks.set(cmdId, value);
    if (this.recentAcks.size > RECENT_ACKS) {
      const oldest = this.recentAcks.keys().next().value;
      if (oldest !== undefined) this.recentAcks.delete(oldest);
    }
  }

  private setStatus(status: ConnectionStatus) {
    if (this.status === status) return;
    this.status = status;
    this.statusListeners.forEach((l) => l(status));
  }

  private setSession(info: SessionInfo) {
    this.session = info;
    this.sessionListeners.forEach((l) => l(info));
  }
}

function emptyState(kioskId: string): KioskState {
  return {
    kioskId,
    screen: "welcome",
    title: "",
    buttons: [],
    cart: { lines: [], subtotal: 0, tax: 0, total: 0 },
    sessionActive: false,
  };
}
