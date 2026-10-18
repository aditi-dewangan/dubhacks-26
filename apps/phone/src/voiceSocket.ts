import type { createAgentVoice } from "./agentSpeech.ts";

interface VoiceEvents {
  "agent:message": (message: { text: string; awaitingConfirmation: boolean }) => void;
  "kiosk:state": (state: { screen: string; orderNumber?: string; kind?: string }) => void;
  "session:ended": (info: { reason?: string }) => void;
}
interface VoiceSocket {
  on<E extends keyof VoiceEvents>(event: E, handler: VoiceEvents[E]): unknown;
  off<E extends keyof VoiceEvents>(event: E, handler: VoiceEvents[E]): unknown;
}

/** Attach once per session. Cleanup removes exactly these listeners and stops speech. */
export function bindVoiceSocket(socket: VoiceSocket, voice: ReturnType<typeof createAgentVoice>): () => void {
  const reply: VoiceEvents["agent:message"] = (message) => { void voice.receiveReply(message); };
  const state: VoiceEvents["kiosk:state"] = (value) => { void voice.receiveKioskState(value); };
  const ended: VoiceEvents["session:ended"] = (info) => { voice.endSession(info.reason); };
  socket.on("agent:message", reply);
  socket.on("kiosk:state", state);
  socket.on("session:ended", ended);
  return () => {
    socket.off("agent:message", reply);
    socket.off("kiosk:state", state);
    socket.off("session:ended", ended);
    voice.dispose();
  };
}
