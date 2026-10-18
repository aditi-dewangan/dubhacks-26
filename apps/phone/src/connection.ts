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

// ---------- "Remember this phone" ----------
// The profile token lives only in this browser. There's no login screen: the first visit
// creates a profile silently, and later visits are recognised by the server.

const PROFILE_KEY = "kiosk-access-profile";

function readToken(): string | null {
  try { return localStorage.getItem(PROFILE_KEY); } catch { return null; }
}
function saveToken(token: string) {
  try { localStorage.setItem(PROFILE_KEY, token); } catch { /* private mode: no memory, still works */ }
}

async function newProfileToken(): Promise<string | null> {
  const res = await fetch(`${SERVER_URL}/api/profiles`, { method: "POST" });
  if (!res.ok) return null;
  const { profileToken } = (await res.json()) as { profileToken: string };
  saveToken(profileToken);
  return profileToken;
}

export interface PhoneProfile {
  profileId: string;
  visits: number;
  returning: boolean;
  /** Their last completed order at this restaurant, if any. */
  lastOrder?: { spoken: string; total: number; at: string } | null;
  /** What they asked to be remembered: name, speaking speed, diet, allergies. */
  preferences?: { name?: string; speechRate?: number; diet?: string[]; allergies?: string[] };
  /** Past orders, newest first. */
  history?: { kind: string; place: string; at: string; total: number; spoken: string; lines: { name: string; qty: number }[] }[];
}

/** The saved profile as it is now (e.g. after the customer said "speak slower"). */
export async function fetchProfile(): Promise<PhoneProfile | null> {
  const token = readToken();
  if (!token) return null;
  try {
    const res = await fetch(`${SERVER_URL}/api/profiles/me`, { headers: { authorization: `Bearer ${token}` } });
    return res.ok ? ((await res.json()) as PhoneProfile) : null;
  } catch { return null; }
}

/** Saves preferences (only the fields given). Returns the updated profile, or an error to show. */
export async function updateProfile(prefs: NonNullable<PhoneProfile["preferences"]>): Promise<PhoneProfile | { error: string }> {
  const token = readToken();
  if (!token) return { error: "This phone has no profile yet. Start an order first." };
  try {
    const res = await fetch(`${SERVER_URL}/api/profiles/me`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(prefs),
    });
    const body = await res.json();
    return res.ok ? (body as PhoneProfile) : { error: (body as { message?: string }).message ?? "Couldn't save." };
  } catch { return { error: "Couldn't reach the server." }; }
}

/** "Forget me": deletes the profile and its history on the server, and forgets the token here. */
export async function deleteProfile(): Promise<boolean> {
  const token = readToken();
  try {
    if (token) {
      const res = await fetch(`${SERVER_URL}/api/profiles/me`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
      if (!res.ok && res.status !== 401) return false;
    }
    try { localStorage.removeItem(PROFILE_KEY); } catch { /* nothing stored */ }
    return true;
  } catch { return false; }
}

/**
 * Links this phone's profile to the ordering session, creating the profile on the first
 * visit (or again if the server forgot it). Never throws: ordering works without a profile.
 */
export async function attachProfile(sessionId: string, sessionSecret: string): Promise<PhoneProfile | null> {
  try {
    const attach = (token: string) => fetch(`${SERVER_URL}/api/profiles/attach`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ sessionId, sessionSecret }),
    });
    let token = readToken() ?? (await newProfileToken());
    if (!token) return null;
    let res = await attach(token);
    if (res.status === 401) {
      token = await newProfileToken();
      if (!token) return null;
      res = await attach(token);
    }
    return res.ok ? ((await res.json()) as PhoneProfile) : null;
  } catch {
    return null;
  }
}
