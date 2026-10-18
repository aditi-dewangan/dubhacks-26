import { io, type Socket } from "socket.io-client";
import { normalizeCode, type ClientToServerEvents, type ServerToClientEvents } from "@kiosk-access/shared";

export type PhoneSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export const SERVER_URL: string = import.meta.env.VITE_SERVER_URL ?? "http://localhost:3001";

export type ConnectParams = { kioskId: string; token: string } | { code: string };

/**
 * Read how to connect from the URL:
 *   /k/:kioskId?t=<token>   QR code link
 *   /c/:code                kiosk code typed into the app, e.g. /c/FD48213
 * Returns null if neither is present.
 */
export function parseParams(): ConnectParams | null {
  const codeMatch = window.location.pathname.match(/^\/c\/([^/?#]+)/);
  if (codeMatch?.[1]) {
    const code = normalizeCode(decodeURIComponent(codeMatch[1]));
    return code ? { code } : null;
  }
  const match = window.location.pathname.match(/^\/k\/([^/?#]+)/);
  const token = new URLSearchParams(window.location.search).get("t");
  if (!match?.[1] || !token) return null;
  return { kioskId: decodeURIComponent(match[1]), token };
}

export async function createSession(params: ConnectParams) {
  const res = await fetch(`${SERVER_URL}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
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
