import { createSpeechController, SpeechError } from "./speech.ts";

export interface VoiceCallbacks {
  sendText(text: string): void;
  showTranscript(text: string): void;
  showStatus(message: string): void;
  setSpeaking?(speaking: boolean): void;
  setListening?(listening: boolean): void;
  /** The microphone is blocked: show how to turn it on (instead of a chat message). */
  permissionDenied?(): void;
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
  // Hands-free: after the assistant finishes speaking, listen again without a mic tap.
  let handsFree = false;
  // Quiet listens in a row; after a few, stop and wait for a tap instead of listening forever.
  let silentStreak = 0;
  const MAX_SILENT_LISTENS = 3;
  // iPhones need a moment to switch audio from the speaker back to the mic.
  const AFTER_SPEAKING_MS = 300;
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
    // Enable from a user gesture. The conversation is continuous by default: after each spoken
    // reply the mic reopens by itself. Disabling stops any ongoing listen/speak.
    setEnabled(value: boolean, options: { handsFree?: boolean } = {}) {
      if (disposed) return;
      enabled = value;
      handsFree = value && (options.handsFree ?? true);
      if (!value) { generation++; speech.stop(); }
    },

    /** Start the listen loop immediately (call after setEnabled(true)). */
    startListening() {
      if (!disposed && enabled) void this.listenAndSend(true);
    },
    async listenAndSend(auto = false) {
      if (disposed || ended || completion) return;
      if (!auto) silentStreak = 0; // a tap starts fresh
      const current = ++generation;
      callbacks.setListening?.(true);
      try {
        const text = await speech.listen();
        if (disposed || ended || completion || current !== generation) { callbacks.setListening?.(false); return; }
        callbacks.setListening?.(false);
        silentStreak = 0;
        callbacks.showTranscript(text);
        callbacks.sendText(text);
      } catch (error) {
        callbacks.setListening?.(false);
        if (current !== generation) return;
        const code = error instanceof SpeechError ? error.code : "failed";
        if (handsFree && enabled && (code === "no_speech" || code === "timeout" || code === "network")) {
          // Continuous: keep listening through a pause, but not forever.
          if (++silentStreak < MAX_SILENT_LISTENS) { setTimeout(() => this.listenAgain(current), 200); return; }
          silentStreak = 0;
          callbacks.showStatus("I'm still here. Tap the microphone when you're ready.");
          return;
        }
        if (code === "permission_denied" && callbacks.permissionDenied) {
          handsFree = false;
          callbacks.permissionDenied();
          return;
        }
        if (auto && code === "permission_denied") {
          // Some browsers (iPhone Safari) only open the mic from a tap: fall back to tap-to-talk.
          handsFree = false;
          callbacks.showStatus("Tap the microphone to answer.");
          return;
        }
        report(error);
      }
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
      const current = ++generation;
      callbacks.setSpeaking?.(true);
      let spoke = false;
      try { await speech.speak(message.text, "en-US", getRate()); spoke = true; }
      catch (error) { if (current === generation) report(error); }
      finally { if (current === generation) callbacks.setSpeaking?.(false); }
      if (spoke) this.listenAgain(current);
    },
    /** The first thing the customer hears, right after their tap; then the conversation is hands-free. */
    async greet(text: string) {
      if (disposed || !text.trim()) return;
      const current = ++generation;
      callbacks.setSpeaking?.(true);
      let spoke = false;
      try { await speech.speak(text, "en-US", getRate()); spoke = true; }
      catch (error) { if (current === generation) report(error); }
      finally { if (current === generation) callbacks.setSpeaking?.(false); }
      if (spoke) this.listenAgain(current);
    },
    /** Opens the mic after speaking, unless something newer happened (new speech, a tap, typing). */
    listenAgain(after: number) {
      const ok = () => handsFree && enabled && !disposed && !ended && !completion && after === generation;
      if (ok()) setTimeout(() => { if (ok()) void this.listenAndSend(true); }, AFTER_SPEAKING_MS);
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
     * Asks one question and returns what the customer said, without sending it to the assistant
     * (e.g. "Do you want to start ordering?" on the welcome screen). null if nothing was heard.
     */
    async ask(question: string): Promise<string | null> {
      if (disposed) return null;
      const current = ++generation;
      callbacks.setSpeaking?.(true);
      try { await speech.speak(question, "en-US", getRate()); }
      catch { /* speaking failed; still listen */ }
      finally { if (current === generation) callbacks.setSpeaking?.(false); }
      if (current !== generation || disposed) return null;
      await new Promise((r) => setTimeout(r, AFTER_SPEAKING_MS));
      callbacks.setListening?.(true);
      try { return await speech.listen(); }
      catch { return null; }
      finally { callbacks.setListening?.(false); }
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
