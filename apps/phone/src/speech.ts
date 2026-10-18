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
/** Records and transcribes one utterance some other way (see voiceFallback.ts). */
export type SpeechFallback = (options: ListenOptions) => { result: Promise<string>; cancel(): void };
export interface SpeechEnvironment {
  recognition?: new () => Recognition;
  /** Used when `recognition` is missing or the browser refuses it (Chrome on iPhone). */
  fallback?: SpeechFallback;
  /** Skip the browser's recognition and go straight to the fallback (it's known not to work here). */
  preferFallback?: boolean;
  /** Called when the browser's recognition turned out not to work, so later visits skip it. */
  rememberFallback?(): void;
  synthesis?: Pick<SpeechSynthesis, "cancel" | "speak"> & Partial<Pick<SpeechSynthesis, "getVoices">>;
  utterance?: new (text: string) => SpeechSynthesisUtterance;
}
export interface ListenOptions { lang?: string; timeoutMs?: number }

// Without a chosen voice, browsers use whatever comes first, which on a Mac can be a novelty
// voice ("Albert", "Bubbles"...). Prefer natural voices on each platform, then any normal one.
const PREFERRED_VOICES = ["Google US English", "Samantha", "Ava", "Allison", "Susan", "Microsoft Aria", "Microsoft Jenny", "Karen", "Daniel"];
const NOVELTY_VOICE = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Wobble|Eddy|Flo|Fred|Good News|Grandma|Grandpa|Jester|Junior|Kathy|Organ|Ralph|Reed|Rocko|Sandy|Shelley|Superstar|Trinoids|Whisper|Zarvox)\b/i;

export function naturalVoice(voices: SpeechSynthesisVoice[], lang = "en-US"): SpeechSynthesisVoice | undefined {
  const base = lang.slice(0, 2);
  for (const name of PREFERRED_VOICES) {
    const v = voices.find((x) => x.name.startsWith(name) && x.lang.startsWith(base));
    if (v) return v;
  }
  return voices.find((x) => x.lang === lang && !NOVELTY_VOICE.test(x.name))
    ?? voices.find((x) => x.lang.startsWith(base) && !NOVELTY_VOICE.test(x.name));
}

export function createSpeechController(environment: () => SpeechEnvironment = browserEnvironment) {
  let cancelListening: (() => void) | undefined;
  let cancelSpeaking: (() => void) | undefined;
  // Set once the browser's recognition has failed; then the fallback is used for the rest of the visit.
  let useFallback = false;
  let listenId = 0;
  const stopListening = () => { listenId++; cancelListening?.(); };
  const stopSpeaking = () => { cancelSpeaking?.(); environment().synthesis?.cancel(); };

  const listenBrowser = (Constructor: new () => Recognition, options: ListenOptions): Promise<string> =>
    new Promise((resolve, reject) => {
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
      recognition.onerror = ({ error }) => finish(undefined, Object.assign(new SpeechError(
        error === "not-allowed" || error === "service-not-allowed" ? "permission_denied" :
        error === "audio-capture" ? "audio_unavailable" : error === "no-speech" ? "no_speech" :
        error === "network" ? "network" : error === "aborted" ? "cancelled" : "failed"), { browserError: error }));
      recognition.onend = () => finish(undefined, new SpeechError("no_speech"));
      timer = setTimeout(() => finish(undefined, new SpeechError("timeout")), options.timeoutMs ?? 15_000);
      try { recognition.start(); } catch { finish(undefined, new SpeechError("failed")); }
    });

  const listenFallback = (fallback: SpeechFallback, options: ListenOptions): Promise<string> =>
    new Promise((resolve, reject) => {
      const run = fallback(options);
      let settled = false;
      const finish = (text?: string, error?: SpeechError) => {
        if (settled) return;
        settled = true;
        cancelListening = undefined;
        if (error) reject(error); else resolve(text!);
      };
      cancelListening = () => { run.cancel(); finish(undefined, new SpeechError("cancelled")); };
      run.result.then((text) => finish(text),
        (error) => finish(undefined, error instanceof SpeechError ? error : new SpeechError("failed")));
    });

  return {
    support() {
      const env = environment();
      return { recognition: Boolean(env.recognition || env.fallback), synthesis: Boolean(env.synthesis && env.utterance) };
    },
    stopListening, stopSpeaking,
    stop() { stopListening(); stopSpeaking(); },
    listen(options: ListenOptions = {}): Promise<string> {
      stopListening(); stopSpeaking();
      const env = environment();
      const { recognition, fallback } = env;
      if (fallback && (useFallback || env.preferFallback || !recognition)) return listenFallback(fallback, options);
      if (!recognition) return Promise.reject(new SpeechError("unsupported"));
      const id = listenId;
      return listenBrowser(recognition, options).catch((error: unknown) => {
        // Chrome on iPhone reports "service-not-allowed" even when the mic itself is allowed.
        const code = error instanceof SpeechError ? error.code : "failed";
        if (fallback && id === listenId && (code === "permission_denied" || code === "failed" || code === "network")) {
          // "not-allowed" can just mean Safari wanted a tap first, so only this answer uses the fallback.
          // Anything else means the browser's recognition doesn't work here: skip it from now on.
          if ((error as { browserError?: string }).browserError !== "not-allowed") {
            useFallback = true;
            env.rememberFallback?.();
          }
          return listenFallback(fallback, options);
        }
        throw error;
      });
    },
    /** startTimeoutMs: give up if speech hasn't started by then (iPhones stay silent until the first tap). */
    speak(text: string, lang = "en-US", rate = 1.0, options: { startTimeoutMs?: number } = {}): Promise<void> {
      stopListening(); stopSpeaking();
      if (!text.trim()) return Promise.resolve();
      const { synthesis, utterance: Utterance } = environment();
      if (!synthesis || !Utterance) return Promise.reject(new SpeechError("unsupported"));
      return new Promise((resolve, reject) => {
        const utterance = new Utterance(text);
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let startTimer: ReturnType<typeof setTimeout> | undefined;
        const finish = (error?: SpeechError) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearTimeout(startTimer);
          utterance.onend = utterance.onerror = utterance.onstart = null;
          cancelSpeaking = undefined;
          if (error) reject(error); else resolve();
        };
        // Replacing speech is expected UI behavior, so resolve the old promise.
        cancelSpeaking = () => finish();
        utterance.lang = lang;
        const voice = naturalVoice(synthesis.getVoices?.() ?? [], lang);
        if (voice) { utterance.voice = voice; utterance.lang = voice.lang; }
        utterance.rate = rate;
        utterance.onend = () => finish();
        utterance.onerror = () => finish(new SpeechError("failed"));
        timer = setTimeout(() => { finish(new SpeechError("timeout")); synthesis.cancel(); }, 60_000);
        if (options.startTimeoutMs) {
          utterance.onstart = () => clearTimeout(startTimer);
          // notStarted: the phone wouldn't speak (iPhones stay silent until the first touch).
          startTimer = setTimeout(() => { finish(Object.assign(new SpeechError("failed"), { notStarted: true })); synthesis.cancel(); }, options.startTimeoutMs);
        }
        try { synthesis.speak(utterance); } catch { finish(new SpeechError("failed")); }
      });
    },
  };
}

const FALLBACK_KEY = "allscreen.speechFallback";
let registeredFallback: SpeechFallback | null = null;
/** Turn the speech fallback on (or off with null) for the browser controller. */
export function setSpeechFallback(fallback: SpeechFallback | null) { registeredFallback = fallback; }

function browserEnvironment(): SpeechEnvironment {
  if (typeof window === "undefined") return {};
  const browser = window as Window & { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  // Chrome, Firefox and Edge on iPhone expose recognition but iOS always refuses it.
  const ua = navigator.userAgent;
  const iosOther = /iPhone|iPad|iPod/.test(ua) && /CriOS|FxiOS|EdgiOS/.test(ua);
  let remembered = false;
  try { remembered = localStorage.getItem(FALLBACK_KEY) === "1"; } catch { /* storage blocked */ }
  return { recognition: browser.SpeechRecognition ?? browser.webkitSpeechRecognition,
    fallback: registeredFallback ?? undefined,
    preferFallback: iosOther || remembered,
    rememberFallback() { try { localStorage.setItem(FALLBACK_KEY, "1"); } catch { /* storage blocked */ } },
    synthesis: window.speechSynthesis, utterance: window.SpeechSynthesisUtterance };
}
// Chrome loads its voice list after page load; asking early makes it ready for the first reply.
if (typeof window !== "undefined") window.speechSynthesis?.getVoices();
const speech = createSpeechController();
export const listen = speech.listen;
export const speak = speech.speak;
export const stopListening = speech.stopListening;
export const stopSpeaking = speech.stopSpeaking;
export const stopSpeech = speech.stop;
export const speechSupport = speech.support;
