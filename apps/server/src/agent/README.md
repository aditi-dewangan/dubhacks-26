# Agent integration (Eliana)

Hour 2 adds a real Gemini client and a menu-grounded, read-only assistant.
It answers menu and current-cart questions. It cannot place orders or open
checkout yet: history and the tool loop are hour 3. The exported handler
signatures are unchanged. Offline tests and stub mode need no API key.

## Files

- `index.ts`: unchanged public handler signatures, wired to realtime.
- `service.ts`: dependency-injected handlers for offline testing.
- `tools.ts`: eight JSON Schema tool declarations and an allowlisted dispatcher.
- `config.ts`: lazy Gemini configuration and the six-round loop limit.
- `agent.test.ts`: offline session, dispatch, and configuration checks.
- `prompt.ts`: spoken-response rules, shared menu grounding, and current cart context.
- `gemini.ts`: Gemini SDK adapter with a 10-second deadline and sanitized errors.
- `gemini.test.ts`: prompt, real SDK HTTP serialization, and failure-path tests.
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
`request_checkout` sets `session.pendingCheckout`; the future loop will derive
`awaitingConfirmation` from that state, not a model's assertion.

Payment and generic button presses are absent from the model's tool list.
Bridge must still restrict `respond_to_popup` to actual popup buttons and enforce
its payment gate. The dispatcher is not a substitute for that gate.

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
It sends the menu, selected kiosk state fields, and the current customer message.
It does not send session credentials. Automatic retries and continuation are
disabled; partial, blocked, empty, or unexpected tool responses are rejected.
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

## Integration follow-ups

- Bridge owns spoken checkout confirmation interception before a model turn.
  A prefix match alone must not accept “yes, but change the fries.”
- Realtime already serializes user messages. Proactive events will need
  serialization and deduplication when the model loop is added.
- Existing smoke tests assert stub echo replies within 300 ms; use stub mode.
- Gemini mode currently handles each question independently. History and tool
  calls are not implemented, and `awaitingConfirmation` always remains false.
- Proactive event notes are forwarded directly in Gemini mode. Model-driven
  event replies, spoken cleanup, and length enforcement remain later work.
- These tests cover infrastructure, not the later 15-case conversation suite.
- Phone UI and `speech.ts` are later phases; no phone workspace is created here.
