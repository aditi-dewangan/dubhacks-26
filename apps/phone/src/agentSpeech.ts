import { createSpeechController, SpeechError } from "./speech.ts";

export interface VoiceCallbacks {
  sendText(text: string): void;
  showTranscript(text: string): void;
  showStatus(message: string): void;
}

/** UI adapter: socket/UI ownership stays with the frontend. Call dispose on unmount/end-session. */
export function createAgentVoice(callbacks: VoiceCallbacks, speech = createSpeechController()) {
  let disposed = false;
  let enabled = false;
  let generation = 0;
  let ended = false;
  let endReason: string | undefined;
  let completion: string | undefined;
  const report = (error: unknown) => {
    if (!disposed && !(error instanceof SpeechError && error.code === "cancelled")) {
      callbacks.showStatus(error instanceof SpeechError ? error.message : "Speech failed. Please use text input.");
    }
  };
  return {
    support: speech.support,
    // Enable from a user gesture; do not start the microphone automatically.
    setEnabled(value: boolean) { if (!disposed) { enabled = value; if (!value) { generation++; speech.stop(); } } },
    async listenAndSend() {
      if (disposed || ended || completion) return;
      const current = ++generation;
      try {
        const text = await speech.listen();
        if (disposed || ended || completion || current !== generation) return;
        callbacks.showTranscript(text);
        callbacks.sendText(text);
      } catch (error) { if (current === generation) report(error); }
    },
    sendTyped(text: string) {
      if (disposed || ended || completion || !text.trim()) return;
      generation++; speech.stop();
      callbacks.sendText(text.trim());
    },
    async receiveReply(message: { text: string }) {
      if (disposed || ended || completion || !enabled) return;
      const current = ++generation;
      try { await speech.speak(message.text); } catch (error) { if (current === generation) report(error); }
    },
    async receiveKioskState(state: { screen: string; orderNumber?: string }) {
      if (disposed || completion || (ended && endReason !== "order_complete") ||
          state.screen !== "complete" || !state.orderNumber?.trim()) return;
      completion = `Your order is complete. Your order number is ${state.orderNumber.trim()}.`;
      const current = ++generation;
      speech.stop();
      callbacks.showStatus(completion);
      if (enabled) {
        try { await speech.speak(completion); } catch (error) { if (current === generation) report(error); }
      }
    },
    endSession(reason?: string) {
      if (disposed) return;
      ended = true; endReason = reason;
      // Let an order-number announcement finish when the server closes a completed session.
      if (reason !== "order_complete" || !completion) { generation++; speech.stop(); }
    },
    dispose() { disposed = true; generation++; speech.stop(); },
  };
}
