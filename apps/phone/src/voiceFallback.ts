// Fallback for when the browser's own speech recognition is missing or refused
// (Chrome and Firefox on iPhone, some Android browsers, privacy settings).
// Records one utterance from the mic, stops when the customer stops talking,
// and sends a small WAV clip to the server, which transcribes it.

import { SERVER_URL } from "./connection.ts";
import { SpeechError, setSpeechFallback, type ListenOptions } from "./speech.ts";

const TARGET_RATE = 16_000;      // plenty for speech, keeps uploads small
const MAX_MS = 15_000;           // longest single answer
const NO_SPEECH_MS = 8_000;      // give up if nobody talks
const END_SILENCE_MS = 1_200;    // this much quiet after talking = done
const MIN_THRESHOLD = 0.012;     // RMS level that counts as speech in a quiet room
const STALL_MS = 2_000;          // no audio frames by now = audio processing is blocked (iPhone, no tap yet)
const PLAIN_RECORD_MS = 6_000;   // fixed-length answer when we can't detect the pause

type AudioCtx = typeof AudioContext;
const AudioContextImpl: AudioCtx | undefined =
  typeof window === "undefined" ? undefined
    : window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioCtx }).webkitAudioContext;

let ctx: AudioContext | null = null;
/** iOS only lets audio start from a tap. Call this from tap handlers (Start, mic button). */
export function unlockAudio() {
  if (!AudioContextImpl) return;
  try {
    ctx ??= new AudioContextImpl();
    if (ctx.state === "suspended") void ctx.resume();
  } catch { /* not fatal; recording will try again */ }
}

export function voiceFallbackAvailable() {
  return Boolean(AudioContextImpl && typeof navigator !== "undefined" && navigator.mediaDevices?.getUserMedia);
}

// One microphone stream for the whole visit, so the browser asks at most once
// (some iPhone browsers ask again every time a page opens the mic).
let mic: MediaStream | null = null;
async function getMic(): Promise<MediaStream> {
  if (mic && mic.getAudioTracks().some((t) => t.readyState === "live")) return mic;
  mic = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  return mic;
}
/** Open the mic now (from the Start tap) so the browser asks right away, not after the greeting. */
export async function prepareMic(): Promise<"ok" | "denied" | "failed"> {
  try { await getMic(); return "ok"; }
  catch (err) { return micError(err).code === "permission_denied" ? "denied" : "failed"; }
}

/** Turn the microphone off (session over or page closed). */
export function releaseMic() {
  mic?.getTracks().forEach((t) => t.stop());
  mic = null;
}
if (typeof window !== "undefined") window.addEventListener("pagehide", releaseMic);

function micError(err: unknown): SpeechError {
  const name = (err as { name?: string })?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return new SpeechError("permission_denied");
  if (name === "NotFoundError" || name === "NotReadableError" || name === "OverconstrainedError") return new SpeechError("audio_unavailable");
  return new SpeechError("failed");
}

/** Record until the speaker pauses. Resolves with 16 kHz mono samples. */
function recordUtterance(isCancelled: () => boolean, onCancel: (fn: () => void) => void): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    let stream: MediaStream | null = null;
    let processor: ScriptProcessorNode | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let done = false;
    let watchdog = 0;
    let plain: { stop(): void } | null = null;
    const chunks: Float32Array[] = [];

    const cleanup = () => {
      window.clearInterval(watchdog);
      plain?.stop();
      try { processor?.disconnect(); source?.disconnect(); } catch { /* already gone */ }
      if (processor) processor.onaudioprocess = null;
      // The stream stays open for the next answer; releaseMic() turns it off at the end.
    };
    const finish = (error?: SpeechError) => {
      if (done) return;
      done = true;
      cleanup();
      if (error) { reject(error); return; }
      resolve(downsample(chunks, ctx!.sampleRate));
    };
    onCancel(() => finish(new SpeechError("cancelled")));

    (async () => {
      try {
        unlockAudio();
        if (!ctx) throw new SpeechError("unsupported");
        stream = await getMic();
      } catch (err) {
        finish(err instanceof SpeechError ? err : micError(err));
        return;
      }
      if (done || isCancelled()) { finish(new SpeechError("cancelled")); return; }
      try { if (ctx.state !== "running") await ctx.resume(); } catch { /* checked below */ }

      source = ctx.createMediaStreamSource(stream);
      processor = ctx.createScriptProcessor(4096, 1, 1);
      const started = performance.now();
      let noise = Infinity;
      let frames = 0;
      let loudFrames = 0;
      let heardSpeech = false;
      let lastLoud = 0;

      processor.onaudioprocess = (event) => {
        if (done) return;
        const input = event.inputBuffer.getChannelData(0);
        chunks.push(new Float32Array(input));
        let sum = 0;
        for (let i = 0; i < input.length; i++) sum += input[i]! * input[i]!;
        const rms = Math.sqrt(sum / input.length);
        const now = performance.now();
        // The first few frames tell us how loud the room is.
        if (frames++ < 3) { noise = Math.min(noise, rms); return; }
        const threshold = Math.max(MIN_THRESHOLD, noise * 2.5);
        if (rms > threshold) {
          if (++loudFrames >= 2) heardSpeech = true;
          lastLoud = now;
        } else {
          loudFrames = 0;
        }
        if (heardSpeech && now - lastLoud > END_SILENCE_MS) finish();
        else if (!heardSpeech && now - started > NO_SPEECH_MS) finish(new SpeechError("no_speech"));
        else if (now - started > MAX_MS) finish(heardSpeech ? undefined : new SpeechError("no_speech"));
      };
      source.connect(processor);
      processor.connect(ctx.destination); // Chrome only runs the processor when it's connected

      // A wall clock, not audio frames, decides when to give up, so listening can never hang.
      // iPhones can keep audio processing paused until the first tap: then record a fixed-length
      // clip with MediaRecorder instead (it works without a tap) and decode it afterwards.
      watchdog = window.setInterval(() => {
        if (done) return;
        const elapsed = performance.now() - started;
        if (frames === 0 && elapsed > STALL_MS && !plain) {
          try { processor!.onaudioprocess = null; processor!.disconnect(); source!.disconnect(); } catch { /* ok */ }
          plain = recordPlain(stream!, PLAIN_RECORD_MS, (result) => {
            if (done) return;
            if (result instanceof SpeechError) { finish(result); return; }
            done = true;
            window.clearInterval(watchdog);
            resolve(result);
          });
          return;
        }
        if (!plain && elapsed > MAX_MS + 1_000) finish(heardSpeech ? undefined : new SpeechError("no_speech"));
      }, 250);
    })();
  });
}

/** Record `ms` of audio with MediaRecorder, then decode to 16 kHz samples (no running AudioContext needed). */
function recordPlain(stream: MediaStream, ms: number, done: (result: Float32Array | SpeechError) => void): { stop(): void } {
  if (typeof MediaRecorder === "undefined" || !ctx) { done(new SpeechError("audio_unavailable")); return { stop() {} }; }
  let recorder: MediaRecorder;
  try { recorder = new MediaRecorder(stream); } catch { done(new SpeechError("audio_unavailable")); return { stop() {} }; }
  const parts: Blob[] = [];
  let cancelled = false;
  recorder.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
  recorder.onstop = async () => {
    if (cancelled) return;
    try {
      const audio = await ctx!.decodeAudioData(await new Blob(parts, { type: recorder.mimeType }).arrayBuffer());
      done(downsample([audio.getChannelData(0)], audio.sampleRate));
    } catch {
      done(new SpeechError("failed"));
    }
  };
  recorder.start();
  const timer = window.setTimeout(() => { if (recorder.state !== "inactive") recorder.stop(); }, ms);
  return {
    stop() {
      cancelled = true;
      window.clearTimeout(timer);
      if (recorder.state !== "inactive") recorder.stop();
    },
  };
}

/** Average down to 16 kHz mono. */
function downsample(chunks: Float32Array[], rate: number): Float32Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const ratio = rate / TARGET_RATE;
  const out = new Float32Array(Math.floor(total / ratio));
  let pos = 0;
  let chunk = 0;
  let offset = 0;
  for (let i = 0; i < out.length; i++) {
    const end = Math.floor((i + 1) * ratio);
    let sum = 0;
    let count = 0;
    while (pos < end && chunk < chunks.length) {
      sum += chunks[chunk]![offset]!;
      count++;
      pos++;
      if (++offset >= chunks[chunk]!.length) { chunk++; offset = 0; }
    }
    out[i] = count ? sum / count : 0;
  }
  return out;
}

function wav(samples: Float32Array, rate = TARGET_RATE): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (at: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i)); };
  text(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); text(8, "WAVE");
  text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/** Turn on the fallback for this ordering session. Returns a function that turns it off. */
export function enableVoiceFallback(sessionId: string, sessionSecret: string): () => void {
  if (!voiceFallbackAvailable()) return () => {};
  setSpeechFallback((_options: ListenOptions) => {
    let cancelled = false;
    let cancelRecording = () => {};
    const controller = new AbortController();
    const result = (async () => {
      const samples = await recordUtterance(() => cancelled, (fn) => { cancelRecording = fn; });
      let res: Response;
      try {
        res = await fetch(`${SERVER_URL}/api/transcribe`, {
          method: "POST",
          headers: { "content-type": "audio/wav", "x-session-id": sessionId, "x-session-secret": sessionSecret },
          body: wav(samples),
          signal: controller.signal,
        });
      } catch {
        throw new SpeechError(cancelled ? "cancelled" : "network");
      }
      if (res.status === 503) throw new SpeechError("unsupported");
      if (!res.ok) throw new SpeechError("failed");
      const { text } = (await res.json()) as { text?: string };
      if (!text?.trim()) throw new SpeechError("no_speech");
      return text.trim();
    })();
    return {
      result,
      cancel() { cancelled = true; cancelRecording(); controller.abort(); },
    };
  });
  return () => { setSpeechFallback(null); releaseMic(); };
}
