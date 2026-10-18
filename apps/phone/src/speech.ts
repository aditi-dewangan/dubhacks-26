/** Browser speech only. Importing this module does not request microphone access. */
export type SpeechErrorCode = "unsupported" | "permission_denied" | "no_speech" | "audio_unavailable" | "network" | "cancelled" | "timeout" | "failed";
export class SpeechError extends Error {
  constructor(readonly code: SpeechErrorCode) {
    super({ unsupported: "Speech is unavailable here. Please type your message.",
      permission_denied: "Microphone access was denied. Please type or enable microphone access.",
      no_speech: "I didn't hear anything. Please try again or type your message.",
      audio_unavailable: "The microphone is unavailable. Please type your message.",
      network: "Speech recognition lost its connection. Please type your message.",
      cancelled: "Speech was cancelled.", timeout: "Listening timed out. Please try again or type your message.",
      failed: "Speech failed. Please type your message." }[code]);
    this.name = "SpeechError";
  }
}

// Recognition is not included in every TypeScript DOM library.
export interface Recognition {
  lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((event: { results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void; abort(): void;
}
export interface SpeechEnvironment {
  recognition?: new () => Recognition;
  synthesis?: Pick<SpeechSynthesis, "cancel" | "speak">;
  utterance?: new (text: string) => SpeechSynthesisUtterance;
}
export interface ListenOptions { lang?: string; timeoutMs?: number }

export function createSpeechController(environment: () => SpeechEnvironment = browserEnvironment) {
  let cancelListening: (() => void) | undefined;
  let cancelSpeaking: (() => void) | undefined;
  const stopListening = () => { cancelListening?.(); };
  const stopSpeaking = () => { cancelSpeaking?.(); environment().synthesis?.cancel(); };
  return {
    support() {
      const env = environment();
      return { recognition: Boolean(env.recognition), synthesis: Boolean(env.synthesis && env.utterance) };
    },
    stopListening, stopSpeaking,
    stop() { stopListening(); stopSpeaking(); },
    listen(options: ListenOptions = {}): Promise<string> {
      stopListening(); stopSpeaking();
      const Constructor = environment().recognition;
      if (!Constructor) return Promise.reject(new SpeechError("unsupported"));
      return new Promise((resolve, reject) => {
        const recognition = new Constructor();
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (text?: string, error?: SpeechError) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          recognition.onresult = recognition.onerror = recognition.onend = null;
          cancelListening = undefined;
          try { recognition.abort(); } catch { /* Already stopped. */ }
          if (error) reject(error); else resolve(text!);
        };
        cancelListening = () => finish(undefined, new SpeechError("cancelled"));
        recognition.lang = options.lang ?? "en-US";
        recognition.continuous = false;
        recognition.interimResults = false;
        recognition.onresult = ({ results }) => {
          const text = Array.from(results).filter((result) => result.isFinal)
            .map((result) => result[0].transcript).join(" ").trim();
          if (text) finish(text);
        };
        recognition.onerror = ({ error }) => finish(undefined, new SpeechError(
          error === "not-allowed" || error === "service-not-allowed" ? "permission_denied" :
          error === "audio-capture" ? "audio_unavailable" : error === "no-speech" ? "no_speech" :
          error === "network" ? "network" : error === "aborted" ? "cancelled" : "failed"));
        recognition.onend = () => finish(undefined, new SpeechError("no_speech"));
        timer = setTimeout(() => finish(undefined, new SpeechError("timeout")), options.timeoutMs ?? 15_000);
        try { recognition.start(); } catch { finish(undefined, new SpeechError("failed")); }
      });
    },
    speak(text: string, lang = "en-US", rate = 1.0): Promise<void> {
      stopListening(); stopSpeaking();
      if (!text.trim()) return Promise.resolve();
      const { synthesis, utterance: Utterance } = environment();
      if (!synthesis || !Utterance) return Promise.reject(new SpeechError("unsupported"));
      return new Promise((resolve, reject) => {
        const utterance = new Utterance(text);
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (error?: SpeechError) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          utterance.onend = utterance.onerror = null;
          cancelSpeaking = undefined;
          if (error) reject(error); else resolve();
        };
        // Replacing speech is expected UI behavior, so resolve the old promise.
        cancelSpeaking = () => finish();
        utterance.lang = lang;
        utterance.rate = rate;
        utterance.onend = () => finish();
        utterance.onerror = () => finish(new SpeechError("failed"));
        timer = setTimeout(() => { finish(new SpeechError("timeout")); synthesis.cancel(); }, 60_000);
        try { synthesis.speak(utterance); } catch { finish(new SpeechError("failed")); }
      });
    },
  };
}

function browserEnvironment(): SpeechEnvironment {
  if (typeof window === "undefined") return {};
  const browser = window as Window & { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return { recognition: browser.SpeechRecognition ?? browser.webkitSpeechRecognition,
    synthesis: window.speechSynthesis, utterance: window.SpeechSynthesisUtterance };
}
const speech = createSpeechController();
export const listen = speech.listen;
export const speak = speech.speak;
export const stopListening = speech.stopListening;
export const stopSpeaking = speech.stopSpeaking;
export const stopSpeech = speech.stop;
export const speechSupport = speech.support;
