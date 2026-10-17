import { io, type Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents } from "@kiosk-access/shared";

export type PhoneSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export const SERVER_URL: string = import.meta.env.VITE_SERVER_URL ?? "http://localhost:3001";

/** Extract kioskId and token from /k/:kioskId?t=<token>. Returns null if either is missing. */
export function parseParams(): { kioskId: string; token: string } | null {
  const match = window.location.pathname.match(/^\/k\/([^/?#]+)/);
  const token = new URLSearchParams(window.location.search).get("t");
  if (!match?.[1] || !token) return null;
  return { kioskId: decodeURIComponent(match[1]), token };
}

export async function createSession(kioskId: string, token: string) {
  const res = await fetch(`${SERVER_URL}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kioskId, token }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const err = Object.assign(new Error((body.message as string | undefined) ?? "Session creation failed"), {
      code: body.error as string | undefined,
    });
    throw err;
  }
  return body as { sessionId: string; sessionSecret: string; kioskId: string };
}

export function connectSocket(sessionId: string, sessionSecret: string): PhoneSocket {
  return io(SERVER_URL, {
    auth: { role: "phone", sessionId, sessionSecret },
  });
}
