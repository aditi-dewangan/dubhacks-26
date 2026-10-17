import type { KioskState, PhoneAuth } from "@kiosk-access/shared";
import { handleUserMessage } from "../agent/index.ts";
import { handleConfirm } from "../bridge/index.ts";
import { config } from "../config.ts";
import { ackHandlers, runSafely, stateHandlers } from "./hooks.ts";
import type { IoServer, IoSocket } from "./io.ts";
import { logEvent } from "./log.ts";
import { startRotation, stopRotation } from "./pairing.ts";
import {
  cancelPhoneGrace,
  endSession,
  scheduleEndAfterComplete,
  startPhoneGrace,
  touchSession,
  verifySecret,
} from "./sessions.ts";
import { getOrCreateKiosk, kioskRoom, kiosks, sessionRoom, sessions } from "./store.ts";

const MAX_MESSAGE_CHARS = 1000;

export function registerSocketHandlers(io: IoServer) {
  // Phones authenticate in the handshake; kiosks connect bare and send kiosk:register.
  io.use((socket, next) => {
    const auth = socket.handshake.auth as Partial<PhoneAuth> | undefined;
    if (auth?.role !== "phone") return next();
    const session = auth.sessionId ? sessions.get(auth.sessionId) : undefined;
    if (!session || !verifySecret(session, auth.sessionSecret ?? "")) {
      return next(new Error("invalid_session"));
    }
    socket.data.role = "phone";
    socket.data.sessionId = session.sessionId;
    next();
  });

  io.on("connection", (socket) => {
    if (socket.data.role === "phone") onPhoneConnected(io, socket);
    else onUnknownConnected(io, socket);
  });
}

// ---------------- kiosk ----------------

function onUnknownConnected(io: IoServer, socket: IoSocket) {
  socket.on("kiosk:register", (reg, done) => {
    const reply = typeof done === "function" ? done : () => {};
    if (!reg || typeof reg.kioskId !== "string" || !reg.kioskId || reg.kioskKey !== config.kioskKey) {
      reply({ ok: false, error: "Invalid kiosk id or key" });
      return;
    }

    const k = getOrCreateKiosk(reg.kioskId);
    if (k.socketId && k.socketId !== socket.id) {
      io.sockets.sockets.get(k.socketId)?.disconnect(true); // a reloaded kiosk takes over
    }
    if (k.offlineTimer) clearTimeout(k.offlineTimer);
    k.offlineTimer = null;
    k.socketId = socket.id;
    k.online = true;
    socket.data.role = "kiosk";
    socket.data.kioskId = k.kioskId;
    socket.join(kioskRoom(k.kioskId));
    reply({ ok: true });

    startRotation(k);
    if (k.sessionId) socket.emit("session:started", { sessionId: k.sessionId, active: true }); // resume after reload
    logEvent("kiosk_registered", { kioskId: k.kioskId });
    attachKioskHandlers(io, socket, k.kioskId);
  });
}

function attachKioskHandlers(io: IoServer, socket: IoSocket, kioskId: string) {
  socket.on("kiosk:state", (state: KioskState) => {
    const k = kiosks.get(kioskId);
    if (!k || k.socketId !== socket.id || !state || state.kioskId !== kioskId) return;
    const prev = k.lastState;
    k.lastState = state;

    const session = k.sessionId ? sessions.get(k.sessionId) ?? null : null;
    if (session) {
      io.to(sessionRoom(session.sessionId)).emit("kiosk:state", state);
      if (state.screen === "complete" && state.orderNumber && prev?.screen !== "complete") {
        logEvent("order_complete", {
          kioskId,
          sessionId: session.sessionId,
          data: { orderNumber: state.orderNumber, total: state.cart.total, items: state.cart.lines.length },
        });
        scheduleEndAfterComplete(session);
      }
    }
    runSafely("kioskState", stateHandlers, kioskId, prev, state, session);
  });

  socket.on("kiosk:ack", (ack) => {
    if (!ack || typeof ack.cmdId !== "string") return;
    const k = kiosks.get(kioskId);
    if (k && ack.state) k.lastState = ack.state;
    runSafely("kioskAck", ackHandlers, ack, kioskId);
  });

  socket.on("kiosk:end-session", () => {
    const k = kiosks.get(kioskId);
    if (k?.sessionId) endSession(k.sessionId, "staff_ended");
  });

  socket.on("debug:ping", (p) => {
    const k = kiosks.get(kioskId);
    if (k?.sessionId) {
      io.to(sessionRoom(k.sessionId)).emit("debug:ping", { from: "kiosk", text: String(p?.text ?? ""), at: Date.now() });
    }
  });

  socket.on("disconnect", () => {
    const k = kiosks.get(kioskId);
    if (!k || k.socketId !== socket.id) return; // already replaced by a newer socket
    k.online = false;
    k.socketId = null;
    stopRotation(k);
    if (k.sessionId) {
      const sessionId = k.sessionId;
      k.offlineTimer = setTimeout(() => endSession(sessionId, "kiosk_disconnected"), config.kioskGraceMs);
    }
  });
}

// ---------------- phone ----------------

function onPhoneConnected(io: IoServer, socket: IoSocket) {
  const sessionId = socket.data.sessionId!;
  const session = sessions.get(sessionId);
  if (!session) {
    socket.disconnect(true);
    return;
  }

  if (session.phoneSocketId && session.phoneSocketId !== socket.id) {
    io.sockets.sockets.get(session.phoneSocketId)?.disconnect(true); // newest phone tab wins
  }
  session.phoneSocketId = socket.id;
  cancelPhoneGrace(session);
  socket.join(sessionRoom(sessionId));

  socket.emit("session:started", { sessionId, active: true });
  const k = kiosks.get(session.kioskId);
  if (k?.lastState) socket.emit("kiosk:state", k.lastState);

  socket.on("user:message", (p) => {
    const text = typeof p?.text === "string" ? p.text.trim().slice(0, MAX_MESSAGE_CHARS) : "";
    const s = sessions.get(sessionId);
    if (!text || !s) return;
    touchSession(s);
    logEvent("user_message", { kioskId: s.kioskId, sessionId, data: { text } });

    // One message at a time per session, in order.
    s.queue = s.queue.then(async () => {
      if (s.ended) return;
      try {
        const reply = await handleUserMessage(sessionId, text);
        if (s.ended) return;
        io.to(sessionRoom(sessionId)).emit("agent:message", reply);
        logEvent("agent_message", { kioskId: s.kioskId, sessionId, data: { ...reply } });
      } catch (err) {
        console.error("[agent] handleUserMessage failed", err);
        logEvent("error", { kioskId: s.kioskId, sessionId, data: { where: "agent", message: String(err) } });
        io.to(sessionRoom(sessionId)).emit("agent:message", {
          text: "Sorry, something went wrong on my end. Could you say that again?",
          awaitingConfirmation: false,
        });
      }
    });
  });

  socket.on("user:confirm", (p) => {
    const s = sessions.get(sessionId);
    if (!s) return;
    touchSession(s);
    s.queue = s.queue.then(async () => {
      if (s.ended) return;
      try {
        await handleConfirm(sessionId, Boolean(p?.confirmed));
      } catch (err) {
        console.error("[bridge] handleConfirm failed", err);
        logEvent("error", { kioskId: s.kioskId, sessionId, data: { where: "confirm", message: String(err) } });
      }
    });
  });

  socket.on("user:end-session", () => endSession(sessionId, "user_ended"));

  socket.on("debug:ping", (p) => {
    const s = sessions.get(sessionId);
    if (!s) return;
    touchSession(s);
    io.to(kioskRoom(s.kioskId)).emit("debug:ping", { from: "phone", text: String(p?.text ?? ""), at: Date.now() });
  });

  socket.on("disconnect", () => {
    const s = sessions.get(sessionId);
    if (s && s.phoneSocketId === socket.id) {
      s.phoneSocketId = null;
      startPhoneGrace(s);
    }
  });
}
