import { createSpeechController, SpeechError } from "./speech.ts";

export interface VoiceCallbacks {
  sendText(text: string): void;
  showTranscript(text: string): void;
  showStatus(message: string): void;
  setSpeaking?(speaking: boolean): void;
  setListening?(listening: boolean): void;
}

/**
 * Continuous voice conversation adapter.
 * Once enabled, the loop is: speak reply → listen → send → repeat.
 * Call dispose() on unmount or session end.
 */
export function createAgentVoice(
  callbacks: VoiceCallbacks,
  getRate: () => number = () => 1.0,
  speech = createSpeechController(),
) {
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

  // Listen for one user utterance then call sendText. Auto-called after speaking.
  const doListen = async () => {
    if (disposed || ended || completion || !enabled) return;
    const current = ++generation;
    callbacks.setListening?.(true);
    try {
      const text = await speech.listen();
      if (disposed || ended || completion || current !== generation) {
        callbacks.setListening?.(false);
        return;
      }
      callbacks.setListening?.(false);
      callbacks.showTranscript(text);
      callbacks.sendText(text);
    } catch (error) {
      callbacks.setListening?.(false);
      if (current === generation) report(error);
    }
  };

  // Speak text and, if voice is still enabled, auto-start listening after.
  const doSpeak = async (text: string) => {
    if (disposed || !text.trim()) return;
    const current = ++generation;
    callbacks.setSpeaking?.(true);
    try { await speech.speak(text, "en-US", getRate()); }
    catch (error) { if (current === generation) report(error); }
    finally { if (current === generation) callbacks.setSpeaking?.(false); }
    // Auto-listen for the next turn
    if (!disposed && !ended && !completion && enabled && current === generation) {
      await doListen();
    }
  };

  return {
    support: speech.support,

    /** Enable/disable the conversation loop. Disabling stops any ongoing listen/speak. */
    setEnabled(value: boolean) {
      if (disposed) return;
      enabled = value;
      if (!value) { generation++; speech.stop(); }
    },

    /** Start the listen loop immediately (call after setEnabled(true)). */
    startListening() {
      if (!disposed && enabled) void doListen();
    },

    /** Typed input from text field — stops any ongoing speech/listen and sends. */
    sendTyped(text: string) {
      if (disposed || ended || completion || !text.trim()) return;
      generation++;
      speech.stop();
      callbacks.sendText(text.trim());
    },

    /**
     * Called by bindVoiceSocket when an agent:message arrives.
     * Speaks the reply, then auto-listens for the next user turn.
     */
    async receiveReply(message: { text: string }) {
      if (disposed || ended || completion || !enabled) return;
      await doSpeak(message.text);
    },

    /**
     * Called by bindVoiceSocket when kiosk:state is "complete".
     * Announces the order number then stops the loop.
     */
    async receiveKioskState(state: { screen: string; orderNumber?: string }) {
      if (disposed || completion || (ended && endReason !== "order_complete") ||
          state.screen !== "complete" || !state.orderNumber?.trim()) return;
      completion = `Your order is complete. Your order number is ${state.orderNumber.trim()}.`;
      generation++;
      speech.stop();
      callbacks.showStatus(completion);
      if (enabled) {
        callbacks.setSpeaking?.(true);
        try { await speech.speak(completion, "en-US", getRate()); }
        catch { /* completion announcement — ignore errors */ }
        finally { callbacks.setSpeaking?.(false); }
        // No auto-listen after order complete
      }
    },

    /**
     * One-shot feedback speak (connection confirmed, payment instructions, etc.).
     * Does NOT start the conversation loop — use receiveReply for that.
     */
    async speakFeedback(text: string) {
      if (disposed || !text.trim()) return;
      const current = ++generation;
      callbacks.setSpeaking?.(true);
      try { await speech.speak(text, "en-US", getRate()); }
      catch { /* ignore feedback errors */ }
      finally { if (current === generation) callbacks.setSpeaking?.(false); }
    },

    endSession(reason?: string) {
      if (disposed) return;
      ended = true;
      endReason = reason;
      if (reason !== "order_complete" || !completion) { generation++; speech.stop(); }
    },

    dispose() { disposed = true; generation++; speech.stop(); },
  };
}
