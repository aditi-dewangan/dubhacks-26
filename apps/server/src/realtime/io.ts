import type { Server, Socket } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@kiosk-access/shared";

export interface SocketData {
  role?: "kiosk" | "phone";
  kioskId?: string;
  sessionId?: string;
}

export type IoServer = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
export type IoSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

let instance: IoServer | null = null;

export function setIo(io: IoServer) {
  instance = io;
}

export function io(): IoServer {
  if (!instance) throw new Error("Socket.io server not started yet");
  return instance;
}
