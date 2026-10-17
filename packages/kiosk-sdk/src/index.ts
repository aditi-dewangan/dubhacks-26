// OWNER: Shruti (Bridge). Minimal working version written by Aditi so the kiosk can connect today.
// It implements the API from the build plan; harden and extend it freely.
//
//   const access = AccessKiosk.connect({ serverUrl, kioskId, kioskKey });
//   access.onPairingCode((url) => setQrUrl(url));
//   access.onSession((s) => setSessionActive(s.active));
//   access.publishState(toKioskState());
//   access.onCommand(async (cmd) => runCommand(cmd)); // returns { ok, error?, state }

import { io, type Socket } from "socket.io-client";
import type {
  ClientToServerEvents,
  KioskCommand,
  KioskState,
  ServerToClientEvents,
  SessionInfo,
} from "@kiosk-access/shared";

export interface ConnectOptions {
  serverUrl: string;
  kioskId: string;
  kioskKey: string;
}

export type CommandResult = { ok: boolean; error?: string; state: KioskState };
export type CommandHandler = (command: KioskCommand) => Promise<CommandResult>;
export type ConnectionStatus = "connecting" | "online" | "offline" | "rejected";

type Listener<T> = (value: T) => void;

export class AccessKiosk {
  private socket: Socket<ServerToClientEvents, ClientToServerEvents>;
  private commandHandler: CommandHandler | null = null;
  private commandQueue: Promise<void> = Promise.resolve();
  private lastState: KioskState | null = null;
  private lastPairingUrl: string | null = null;
  private session: SessionInfo | null = null;
  private status: ConnectionStatus = "connecting";

  private pairingListeners = new Set<Listener<string>>();
  private sessionListeners = new Set<Listener<SessionInfo>>();
  private statusListeners = new Set<Listener<ConnectionStatus>>();
  private pingListeners = new Set<Listener<{ from: string; text: string }>>();

  static connect(options: ConnectOptions): AccessKiosk {
    return new AccessKiosk(options);
  }

  private constructor(private options: ConnectOptions) {
    this.socket = io(options.serverUrl, { transports: ["websocket", "polling"] });

    // Register on every (re)connect so a dropped connection recovers on its own.
    this.socket.on("connect", async () => {
      const res = await this.socket.emitWithAck("kiosk:register", {
        kioskId: options.kioskId,
        kioskKey: options.kioskKey,
      });
      if (!res.ok) {
        this.setStatus("rejected");
        console.error("[AccessKiosk] registration rejected:", res.error);
        return;
      }
      this.setStatus("online");
      if (this.lastState) this.socket.emit("kiosk:state", this.lastState);
    });
    this.socket.on("disconnect", () => this.setStatus("offline"));
    this.socket.on("connect_error", () => this.setStatus("offline"));

    this.socket.on("kiosk:pairing-code", ({ url }) => {
      this.lastPairingUrl = url;
      this.pairingListeners.forEach((l) => l(url));
    });
    this.socket.on("session:started", (info) => this.setSession(info));
    this.socket.on("session:ended", (info) => this.setSession(info));
    this.socket.on("debug:ping", (p) => this.pingListeners.forEach((l) => l(p)));
    this.socket.on("kiosk:command", (env) => {
      // Run commands strictly one at a time, in arrival order.
      this.commandQueue = this.commandQueue.then(async () => {
        let result: CommandResult;
        try {
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
        this.socket.emit("kiosk:ack", { cmdId: env.cmdId, ...result });
      });
    });
  }

  /** Publish what is on screen. Call it every time the screen changes. */
  publishState(state: KioskState) {
    this.lastState = state;
    if (this.status === "online") this.socket.emit("kiosk:state", state);
  }

  /** Handle commands from the accessible-ordering assistant. */
  onCommand(handler: CommandHandler) {
    this.commandHandler = handler;
  }

  onPairingCode(listener: Listener<string>) {
    this.pairingListeners.add(listener);
    if (this.lastPairingUrl) listener(this.lastPairingUrl);
    return () => this.pairingListeners.delete(listener);
  }

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
    this.socket.disconnect();
  }

  private setStatus(status: ConnectionStatus) {
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
