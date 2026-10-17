# Agent handoff after Hours 1–15

The server agent, Gemini adapter, bounded tool loop, menu grounding, history,
preflight validation, event announcements, spoken cleanup, conversation fixtures,
browser speech and frontend voice adapter are implemented. Tests use scripted
models and simulated browser/Bridge implementations. They do not certify live
language accuracy, payment safety, microphone compatibility or an end-to-end demo.

## Remaining integration

| Owner | Required work | Acceptance check |
| --- | --- | --- |
| Bridge | Replace `apps/server/src/bridge/index.ts` stubs; enforce command validation, acknowledgements and payment gate | A large no-onion cheeseburger appears on the real kiosk; invalid calls cannot change it |
| Bridge | Intercept explicit checkout confirmation and invalidate stale snapshots | “Yes, but change the fries” does not pay; a changed cart requires fresh review |
| Bridge | Schedule unsolicited popup events via `handleKioskEvent` | A popup is explained once without auto-acceptance; do not await an event from inside `executeTool` |
| Frontend | Wire `createAgentVoice` and `bindVoiceSocket`; retain chat, text input and Confirm UI | Transcripts send once, cleanup removes listeners, order number finishes speaking |
| Agent + demo-phone owners | Use local Gemini credentials and run live evaluation, then test iPhone and Android over HTTPS | Review every response, confirm real cart changes, measure reply latency and test microphone failure paths |

Keep keys in the ignored root `.env`. Do not use `VITE_` for provider keys or paste
keys into chat. The current implementation does not add a transcription API;
evaluate that optional fallback only if browser recognition fails on demo phones.

## Reproducible checks

From the repository root:

```sh
corepack pnpm test:agent
corepack pnpm typecheck
corepack pnpm agent:eval --runs 5 --output /tmp/kiosk-agent-report.json
```

Use a fresh output filename on each run. Offline reports clearly label scripted
mode and include structural checks plus human-review expectations. The same
cases can exercise Gemini with `--live`, but that flag makes paid API requests.
It still uses a simulated Bridge and cannot establish real kiosk behavior.

For realtime smoke tests use `AGENT_MODE=stub` and `DEV_ROUTES=1`, following the
root README. A successful echo smoke test is transport validation only.

## Real demo rehearsal, once integrated

1. Pair a phone and ask “What burgers do you have?” Check menu names and prices.
2. Say “A large cheeseburger, no onions.” Verify the options on the actual kiosk.
3. Decline the combo. Verify no upgrade was added.
4. Say “That's it.” Verify the readback and total match the kiosk. The starter
   menu produces $7.99 subtotal and $8.80 total for that burger; updated menu data
   and the real kiosk totals are authoritative.
5. Change the cart before confirming and verify the old confirmation cannot pay.
   Request checkout again and use the explicit confirmation path.
6. Complete mock card payment. Hear the actual order number once, then ensure
   later microphone results cannot send another order.
7. Repeat with text input, a screen reader, denied microphone permission and a
   temporary kiosk disconnect. Run five clean integrated rehearsals before demo.

The offline five-repeat evaluation is not a substitute for these five integrated
rehearsals. Large-cart checkout summaries retain counts and total and explicitly
ask for individual-item review when the full detail cannot fit in 300 characters.
