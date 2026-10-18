# Agent integration (Eliana)

Hour 3 adds session history and a bounded Gemini tool loop wired to Bridge's
`executeTool`. Hour 4 adds menu based preflight checks for item IDs, quantities,
choices, required options, and visible popups. The system prompt clarifies
per-item customizations and asks for required choices instead of picking a
default. Agent replies now pass through spoken cleanup that removes common
formatting and emoji and caps replies at 300 characters. The exported handler
signatures are unchanged. The real Bridge
is still a stub, so actual kiosk ordering depends on Shruti's implementation;
offline tests exercise the loop with a fake bridge and scripted model responses.
Offline tests and stub mode need no API key.

## Hours 6–10

- Hour 6: model-driven kiosk event announcements, a shared per-session turn queue,
  duplicate suppression, and stale-event/session checks. Event turns have no action tools.
- Hour 7: 15 conversation scenarios and a simulated Bridge with menu-based cart totals,
  edits, removals, popup choices and pending checkout. Offline replays use scripted model
  outputs; the same scenarios can exercise live Gemini explicitly.
- Hour 8: browser recognition and synthesis in `apps/phone/src/speech.ts`, with cancellation,
  timeout, permission/unsupported errors, and no microphone request on import.
- Hour 9: `apps/phone/src/agentSpeech.ts` connects speech to frontend callbacks. See
  `apps/phone/README.md` for socket wiring and real-device checks. The phone UI is still
  owned by Frontend; these modules do not create a full phone app.
- Hour 10: latency reporting, offline evaluation command, speech typecheck, and regression
  checks. Live latency, real Bridge integration and real-phone voice quality remain unverified.

## Hours 11–15

- Hour 11: cart-edit preflight validates real line IDs, merged option patches, quantity,
  duplicate choices, required options, and edits after payment. Popup responses require
  a currently visible popup. Bridge remains authoritative for all commands.
- Hour 12: successful checkout requests read the Bridge's pending snapshot directly,
  preserving the total and item options and saving one model round. Mutations later in
  the same tool batch are blocked. Orders whose full readback exceeds 300 characters
  get a count and total with an explicit request to review individual items; details
  are never silently truncated in that checkout summary.
- Hour 13: the phone can announce the actual order number from a complete kiosk state,
  deduplicate completion notices, and finish that announcement through an order-complete
  session end. Late input is blocked. `voiceSocket.ts` attaches and removes voice listeners.
- Hour 14: evaluation supports case selection, repeats, saved JSON reports, failure
  counts and latency percentiles. Offline remains the default; live mode is explicit.
- Hour 15: regression checks are recorded.
  Live API accuracy/latency, real payment-gate integration, and real-device microphone
  checks remain pending; completion of these code milestones does not certify the demo.

## Files

- `index.ts`: unchanged public handler signatures, wired to realtime.
- `service.ts`: dependency-injected handlers for offline testing.
- `loop.ts`: sequential tool execution, result feedback, and session checks.
- `history.ts`: bounded, session-owned history retaining complete exchanges.
- `tools.ts`: eight JSON Schema tool declarations and an allowlisted dispatcher.
- `config.ts`: lazy Gemini configuration and the six-round loop limit.
- `agent.test.ts`: offline session, dispatch, and configuration checks.
- `prompt.ts`: spoken-response rules, shared menu grounding, and current cart context.
- `gemini.ts`: Gemini SDK adapter with a 10-second deadline and sanitized errors.
- `gemini.test.ts`: prompt, real SDK HTTP serialization, and failure-path tests.
- `loop.test.ts`: multi-turn, fake-bridge, lifecycle, and tool-protocol tests.
- `spoken.ts`: markdown/emoji cleanup and spoken reply length limit.
- `spoken.test.ts`: offline spoken cleanup checks.
- `../../scripts/agent-check.ts`: one live read-only question with timing.

Run from the repository root:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @kiosk-access/server test:agent
corepack pnpm -r typecheck
```

If the `pnpm` command is already on PATH, `pnpm test:agent` and `pnpm typecheck`
are equivalent root shortcuts.

## Bridge contract

Shruti implements `executeTool(sessionId, name, input): Promise<string>`.
These are the inputs the agent will send; `{}` is used for no-argument tools.

| Tool | Input |
| --- | --- |
| `get_menu` | `{ categoryId?: string }` |
| `get_kiosk_state` | `{}` |
| `add_item` | `{ itemId: string, qty: number, options: Record<string, string[]> }` |
| `update_item` | `{ lineId: string, qty?: number, options?: Record<string, string[]> }` |
| `remove_item` | `{ lineId: string }` |
| `respond_to_popup` | `{ buttonId: string }` |
| `request_checkout` | `{}` |
| `cancel_order` | `{}` |

Quantities are integers from 1 through 10, matching the current kiosk. Option
keys/values are real menu group/choice IDs. Updates must supply quantity or
options; an empty array clears an optional group. Bridge must validate those
semantic rules and item-specific required options. Schemas guide the model;
they do not replace runtime validation.

Bridge results must distinguish failures from successes and include relevant
cart state or popup details. The agent must not claim success after a rejection.
`request_checkout` sets `session.pendingCheckout`; the loop derives
`awaitingConfirmation` from that state, not a model's assertion.
When a request produces a pending snapshot, the agent reads that snapshot using
`checkout.ts` instead of asking Gemini to calculate or paraphrase the final order.
The Bridge must still invalidate pending checkout on changes and validate the
snapshot again on confirmation. The agent readback is not a payment gate.

Payment and generic button presses are absent from the model's tool list.
Bridge must still restrict `respond_to_popup` to actual popup buttons and enforce
its payment gate. The dispatcher is not a substitute for that gate.

## Conversation loop

Each user message runs at most six model calls. Each response can request up to
eight tools, executed sequentially; larger batches are rejected without execution.
Every result is returned as a Gemini function response with the original name
and optional call ID. Fresh kiosk state is supplied before each model call.
Intermediate model text accompanying tool calls is not spoken as an action result.

History lives in `session.history` as versioned whole-turn records. The last 12
turns are retained; trimming never separates tool calls from results. Full model
content, including thought signatures, is preserved for the next request, while
thought text is excluded from spoken replies. The agent serializes user and kiosk-event
turns using the same per-session queue. Realtime retains its outer queue for user
messages and checkout confirmations. Independent sessions can proceed concurrently.

`handleKioskEvent` uses current state and history, pushes a cleaned reply, and records
the event exchange. Consecutive identical notes for identical state are deduplicated
until a user turn. Events whose state changes while queued or generating are discarded.
Bridge remains responsible for detecting unsolicited changes. Its hook should schedule
the event without awaiting it inside `executeTool`, since the event waits for that turn.
Do not announce popups already explained by a command result. Ended sessions discard
events; completion delivery must occur before session teardown or be handled by phone state.

Readable Bridge rejections pass through to the model. Unexpected exceptions
become safe tool-error results. After an uncertain mutation, further mutations
are blocked for that turn; read tools remain available. Completed tool results
are saved even if a later model call fails, with a reply asking the user to review
their order before repeating it. No application-level automatic retries are made.
Bridge owns command/ack timeouts; the agent's 10-second timeout applies per model
call, not to the entire turn or Bridge execution.

The loop checks the session before each model/tool call and after model replies.
It does not execute further tools or save history once the session ends. It
cannot undo a command already handed to Bridge when a session ends.

## Running Gemini

Create a root `.env` from `.env.example` if you do not have one. Set:

```dotenv
AGENT_MODE=gemini
GEMINI_API_KEY=your-local-key
GEMINI_MODEL=gemini-3.8-flash
```

The model is configurable; use an ID available to your AI Studio project.
The example uses the Flash model listed in Google's model catalog:
https://ai.google.dev/gemini-api/docs/models

Run one live call without a server or kiosk:

```sh
corepack pnpm --filter @kiosk-access/server agent:check
corepack pnpm --filter @kiosk-access/server agent:check "What is vegetarian?"
```

This command always makes a live Gemini call, regardless of `AGENT_MODE`, and
prints the reply and latency. Review the answer against `packages/shared/menu.json`;
a successful response alone does not prove price accuracy or conversational quality.

For the phone path, run the server, kiosk, and fake-phone CLI as described in the
root README. Restart the server after changing `.env`. Missing credentials in
Gemini mode produce a setup-unavailable reply, rather than silently using the stub.

The adapter uses Google's `@google/genai` SDK and `models.generateContent`:
https://googleapis.github.io/js-genai/release_docs/index.html
It sends the menu, selected kiosk state fields, conversation history, and the current customer message.
It does not send session credentials. Automatic retries and continuation are
disabled; partial, blocked, empty, or malformed model responses are rejected.
The standalone `agent:check` remains read-only; server Gemini mode enables tools.
Only safe failure categories enter the event log, never raw provider errors.

Set `GEMINI_API_KEY` and `GEMINI_MODEL` in the ignored root `.env` before live
testing. `LLM_API_KEY` is a legacy fallback. No key belongs in a `VITE_` variable.

## Offline and realtime tests

`AGENT_MODE=stub` keeps the original echo behavior for teammate integration.
An unset `AGENT_MODE` also selects stub mode. To run the existing realtime smoke
test, start its server explicitly in stub mode, even if `.env` enables Gemini:

```sh
AGENT_MODE=stub corepack pnpm --filter @kiosk-access/server start
# In another terminal, with DEV_ROUTES=1 in .env:
corepack pnpm --filter @kiosk-access/server smoke
```

The unit suite never loads `.env` and uses a fake HTTP transport, so it makes no
paid requests. These checks verify integration, not live model answer quality.

Replay the 15 conversation contracts without an API key:

```sh
corepack pnpm agent:eval
corepack pnpm test:agent
corepack pnpm typecheck
```

For a saved rehearsal report or a focused case:

```sh
corepack pnpm agent:eval --list
corepack pnpm agent:eval --case checkout
corepack pnpm agent:eval --runs 5 --output /tmp/kiosk-agent-report.json
```

The output path must be new and its parent directory must exist. Reports contain
synthetic scenario replies, cart results, and median/p95/max elapsed times. Failed
cases retain replies observed before failure. Runs are limited to 1–10; failures
set a nonzero exit status. Reports do not overwrite previous results.

Only when live testing is intended, run `corepack pnpm agent:eval --live` with a locally
configured key. This makes paid Gemini calls against a **simulated** Bridge, never a real
kiosk. Each scenario reports structural assertions and a human review criterion. Review
language, prices and whether questions are appropriate; a scripted pass is not a model
quality score. Provider failures cause evaluation failure. No transcription service or
Whisper fallback was added; the plan reserves it for failed real-device recognition checks.

Server console metrics named `agent_latency` report turn execution time in milliseconds,
excluding queue wait. They contain no transcript, key or session identity. The evaluation
runner reports elapsed time per utterance. The under-three-second target needs live
measurement; offline execution times cannot establish it.

## Integration follow-ups

- Bridge owns spoken checkout confirmation interception before a model turn.
  A prefix match alone must not accept “yes, but change the fries.”
- Bridge must connect unsolicited state-change detection to `handleKioskEvent`.
- Existing smoke tests assert stub echo replies within 300 ms; use stub mode.
- Real Bridge integration and live Gemini tool-schema acceptance still need
  verification. Offline scripted model tests do not prove natural-language accuracy.
- Frontend must wire the voice adapter into its phone UI and test on the demo phones.
