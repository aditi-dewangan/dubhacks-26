# Agent integration (Eliana)

Hour 1 is a scaffold. The exported handlers still produce stub replies; there are
no model calls, history updates, or live tool executions yet. No API key is needed
to run the server or tests at this stage.

## Files

- `index.ts`: unchanged public handler signatures, wired to realtime.
- `service.ts`: dependency-injected handlers for offline testing.
- `tools.ts`: eight JSON Schema tool declarations and an allowlisted dispatcher.
- `config.ts`: lazy Gemini configuration and the six-round loop limit.
- `agent.test.ts`: offline session, dispatch, and configuration checks.

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

## Gemini next

The planned SDK is Google's `@google/genai`, using `parametersJsonSchema` for
these declarations: https://googleapis.github.io/js-genai/release_docs/index.html
Live model compatibility will be verified when the adapter is implemented.

Set `GEMINI_API_KEY` and `GEMINI_MODEL` in the ignored root `.env` before live
testing. `LLM_API_KEY` is a legacy fallback. No key belongs in a `VITE_` variable.
The SDK, model selection, system prompt, history, and tool loop come next.

## Integration follow-ups

- Bridge owns spoken checkout confirmation interception before a model turn.
  A prefix match alone must not accept “yes, but change the fries.”
- Realtime already serializes user messages. Proactive events will need
  serialization and deduplication when the model loop is added.
- Existing smoke tests assert stub echo replies within 300 ms. Adapt that test
  to a deterministic fake model when live Gemini replaces the stub.
- These tests cover infrastructure, not the later 15-case conversation suite.
- Phone UI and `speech.ts` are later phases; no phone workspace is created here.
