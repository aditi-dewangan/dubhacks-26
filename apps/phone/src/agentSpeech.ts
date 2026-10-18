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

/** UI adapter: socket/UI ownership stays with the frontend. Call dispose on unmount/end-session. */
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
  return {
    support: speech.support,
    // Enable from a user gesture. With handsFree, the mic reopens after each spoken reply.
    setEnabled(value: boolean, options: { handsFree?: boolean } = {}) {
      if (disposed) return;
      enabled = value;
      handsFree = value && Boolean(options.handsFree);
      if (!value) { generation++; speech.stop(); }
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
    sendTyped(text: string) {
      if (disposed || ended || completion || !text.trim()) return;
      generation++; speech.stop();
      callbacks.sendText(text.trim());
    },
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
    async receiveKioskState(state: { screen: string; orderNumber?: string }) {
      if (disposed || completion || (ended && endReason !== "order_complete") ||
          state.screen !== "complete" || !state.orderNumber?.trim()) return;
      completion = `Your order is complete. Your order number is ${state.orderNumber.trim()}.`;
      const current = ++generation;
      speech.stop();
      callbacks.showStatus(completion);
      if (enabled) {
        callbacks.setSpeaking?.(true);
        try { await speech.speak(completion, "en-US", getRate()); }
        catch (error) { if (current === generation) report(error); }
        finally { if (current === generation) callbacks.setSpeaking?.(false); }
      }
    },
    /** Speaks text regardless of enabled state — for explicit user-triggered repeats. */
    async speakFeedback(text: string) {
      if (disposed || !text.trim()) return;
      const current = ++generation;
      callbacks.setSpeaking?.(true);
      try { await speech.speak(text, "en-US", getRate()); }
      catch { /* user-triggered, ignore errors */ }
      finally { if (current === generation) callbacks.setSpeaking?.(false); }
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
