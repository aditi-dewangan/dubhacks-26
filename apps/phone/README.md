# Agent voice handoff

These are standalone browser modules for the Frontend owner's phone app. They introduce
no package dependencies and do not create or replace the React application.

`speech.ts` exports `listen(): Promise<string>`, `speak(text): Promise<void>`,
`stopListening`, `stopSpeaking`, `stopSpeech`, and `speechSupport`. Recognition uses
`SpeechRecognition` or `webkitSpeechRecognition`. Synthesis uses `speechSynthesis`.
Listening cancels existing speech; speaking cancels recognition. Starting a new listener
rejects the old promise with `SpeechError("cancelled")`. Replaced speech resolves normally.
All listeners/timers are detached on completion, error or cancellation.

`agentSpeech.ts` supplies the frontend adapter:

```ts
const voice = createAgentVoice({
  sendText: (text) => socket.emit("user:message", { text }),
  showTranscript: (text) => setInputText(text),
  showStatus: (message) => setLiveStatus(message),
});
const unbindVoice = bindVoiceSocket(socket, voice);
// Keep the UI's own chat/state listeners: always render text, even if speech is unavailable.

// Call from a user gesture, with a clearly labelled voice control.
voice.setEnabled(true); // Opts into spoken replies; does not open the microphone.
await voice.listenAndSend(); // Microphone button only; sends one final transcript.
voice.sendTyped(inputText); // Cancels voice before sending the typed message.

// On component unmount or switching sessions:
unbindVoice();
```

Use `voice.support()` to disable unsupported voice controls, retain text input, and expose
status via a polite ARIA live region. Avoid simultaneously auto-reading every chat entry
and speaking it through synthesis. Error messages contain no captured audio. Browser
recognition may use the browser vendor's recognition service; this is not a promise of
on-device processing. No audio is sent to this project's server by these modules.

Import `createAgentVoice` from `./src/agentSpeech.ts` and `bindVoiceSocket` from
`./src/voiceSocket.ts` (adjust relative paths inside the frontend). Bind once per
session; always call the returned cleanup before binding a new session.
The binder handles `agent:message`, `kiosk:state`, and `session:ended`. It never
sends payment confirmation. Frontend continues to own the explicit Confirm button.

`receiveKioskState` announces an order number only on a `complete` screen with a
nonempty number, once per voice instance. `endSession("order_complete")` lets that
announcement finish, including when the completion state arrives just after the
end notification. Other end reasons stop speech immediately. Late messages and
transcripts cannot restart an ended order. Keep the completed-session view mounted
while the announcement plays; immediate unmount/cleanup intentionally cancels all
speech. Do not call `dispose` directly from a session-ended listener if the order
number should finish speaking; use the binder's `endSession` handling instead.

The module is typechecked by root `pnpm typecheck` and its lifecycle is covered by the
server's `pnpm test:agent` using fake browser APIs. Real microphone/voice behavior has
not been tested here. After Frontend wiring, use HTTPS and check both demo phones:

1. Tap the microphone and allow access. Say “one large cheeseburger, no onions.”
   Verify one final transcript and one `user:message`.
2. Deny permission and confirm that the status explains how to use text instead.
3. Start listening during a spoken reply; the old reply must stop without transcribing itself.
4. Send typed text while listening; no later recognition result may send another message.
5. Receive two replies quickly; only the newest should continue speaking.
6. End the session while listening; no late transcript may be sent.
7. Try a silent microphone, screen-reader navigation, and an unsupported browser.

If recognition is unreliable on a demo phone, keep text available and then evaluate
the plan's optional transcription fallback. Do not add API secrets to this browser code.
