# Kiosk Access

Accessible ordering for touchscreen kiosks. A blind customer scans the kiosk's QR code, talks to an
assistant on their own phone, and the kiosk taps through the order on screen. The build plan
(roles, contract, timeline) lives in the team doc.

Rendered at: https://kiosk-access-kiosk.onrender.com/ and https://www.allscreen.work/

## Quick start

```bash
corepack enable          # gives you pnpm
pnpm install
cp .env.example .env

pnpm dev:server          # http://localhost:3001
pnpm dev:kiosk           # http://localhost:5173
```

Then, with both running:

```bash
pnpm smoke               # 17 end-to-end checks of pairing, sessions, relay, logging
pnpm fake-phone          # chat with the kiosk from your terminal, no phone app needed
```

Drive the kiosk directly (no Bridge or Agent needed) with the dev command route. The
kiosk animates the taps and the response is its ack:

```bash
curl -XPOST localhost:3001/api/dev/command/store42-kiosk1 -H 'content-type: application/json' \
  -d '{"command":{"type":"add_item","itemId":"box_combo","qty":1,"options":{"drink":["lemonade"],"remove":["no_coleslaw"]}}}'
```

Kiosk command rules the Bridge and Agent can rely on:

- `add_item` validates the item and options first and fails fast with a readable error.
- Any command except a popup answer is refused while a popup is showing.
- `press` on `btn-pay` or `btn-card-tap` is always refused. Only `start_payment` reaches payment.
- Nothing can change once the kiosk is on the paying or complete screen.
- Removing a sandwich or chicken finger also removes its combo upgrade line.

Phones need HTTPS for the microphone. During development, expose the phone app with
`ngrok http 5174` and set `PHONE_APP_URL` to the ngrok URL so the QR code points there.

## Layout and owners

| Path | What | Owner |
| --- | --- | --- |
| `packages/shared` | Contract types, `menu.json`, fixture states | Everyone (menu: Shruti) |
| `packages/kiosk-sdk` | SDK a kiosk vendor adds | Shruti |
| `apps/kiosk` | Mock kiosk UI | Aditi |
| `apps/server/src/realtime` | Sockets, pairing, sessions, event log | Aditi |
| `apps/server/src/bridge` | Commands, validation, tools, payment gate | Shruti |
| `apps/server/src/agent` | LLM loop and prompt | Eliana |
| `apps/phone` | Agent speech modules ready; customer UI still to be built | Nidhi (UI), Eliana (speech) |
| `apps/dashboard` | Business dashboard (not created yet) | Nidhi |

`bridge/index.ts` is a **stub**. The agent supports stub mode and a Gemini tool loop
with session history. Actual ordering depends on the Bridge implementation. See
[agent setup](apps/server/src/agent/README.md) for configuration and live checks.
Use `AGENT_MODE=stub` on the server when running `pnpm smoke`.

## What the realtime layer gives the Bridge and Agent

Import only from `apps/server/src/realtime/index.ts`:

- `sendToKiosk(kioskId, envelope)` → `false` if the kiosk is offline
- `onKioskAck(handler)` → every `CommandAck`
- `onKioskStateChange(handler)` → `(kioskId, prev, next, session)` on every published state
- `onSessionEnded(handler)`
- `getSession(sessionId)`, `getKioskState(kioskId)`
- `sendAgentMessage(sessionId, { text, awaitingConfirmation })` → push a message to the phone
- `logEvent(type, fields)`, `endSession(sessionId, reason)`

The server already routes `user:message` to `handleUserMessage` (one message per session at a
time) and `user:confirm` to the Bridge's `handleConfirm`.

## Phone app: how to connect

1. The QR opens `/k/:kioskId?t=<token>`.
2. `POST /api/sessions` with `{ kioskId, token }` → `{ sessionId, sessionSecret }`.
   Errors: `409 kiosk_busy`, `410 code_expired`, `503 kiosk_offline`.
3. Connect Socket.io with `auth: { role: "phone", sessionId, sessionSecret }`.
4. Listen for `kiosk:state`, `agent:message`, `session:ended`; send `user:message`,
   `user:confirm`, `user:end-session`.

## Contract additions (beyond the doc)

- `kiosk:end-session` (kiosk → server): staff pressed "End accessible session"
- `user:end-session` (phone → server): customer ended the session
- `debug:ping` (both ways): for the hour-0 ping test
- `PairingCode.expiresAt`, `SessionInfo.reason`, phone handshake `PhoneAuth`
- Menu: `taxRate`, and `hidden` items (the combo upgrade only comes from the popup)
- `KioskState.kind`, `KioskState.fields`, `KioskState.info` and the `type_text` command (see below)

## Four demo kiosks, one integration

The same kiosk app runs four different kiosks to show the integration works on any kiosk:

| URL | Kiosk | Kiosk id |
| --- | --- | --- |
| `/` | Raising Cane's (food ordering) | `store42-kiosk1` (`VITE_KIOSK_ID`) |
| `/?kind=clinic` | Evergreen Family Clinic (patient check-in) | `clinic-kiosk1` |
| `/?kind=cinema` | Starlight Cinemas (movie tickets and seats) | `cinema-kiosk1` |
| `/?kind=transit` | MetroLink (train ticket machine) | `transit-kiosk1` |

The clinic, cinema and transit kiosks need **no AI code of their own**. They read their own screen the
way a screen reader would and publish it in `KioskState`:

- `buttons`: every on-screen button, with its label and whether it's enabled
- `fields`: text fields (label, current value, placeholder)
- `info`: other text that matters (appointment details, prices, selected seats)
- `kind`: `"clinic"`, `"cinema"` or `"transit"`; the food kiosk sends `"food"`

They accept four commands: `press { buttonId }`, `type_text { fieldId, text }`, `start_payment` and
`cancel_order`. The food-only commands (`add_item` and friends) are refused with a message telling
the AI to use `press`/`type_text` instead. `btn-pay` and the card reader can never be pressed directly.

**For the AI to use them:** the agent needs two generic tools, `press_button(buttonId)` and
`type_text(fieldId, text)`, plus a prompt rule: when `kind` isn't `"food"`, read `buttons`, `fields`
and `info` from the kiosk state and drive the screen with those. The bridge passes them to the kiosk
as `press` and `type_text`. Checkout still goes through the confirm gate and `start_payment`.

Try it without the AI:

```bash
curl -XPOST localhost:3001/api/dev/command/clinic-kiosk1 -H 'content-type: application/json' \
  -d '{"command":{"type":"press","buttonId":"btn-start"}}'
curl -XPOST localhost:3001/api/dev/command/clinic-kiosk1 -H 'content-type: application/json' \
  -d '{"command":{"type":"type_text","fieldId":"field-last-name","text":"Rivera"}}'
```

## Session rules

| Rule | Default |
| --- | --- |
| QR code rotates | every 60 s, each valid 90 s, single use |
| One phone per kiosk | second phone gets 409 |
| Idle timeout | 3 min without a user message |
| Phone disconnected | ends after 30 s |
| Kiosk disconnected | ends after 15 s (a reload within that keeps the session) |
| Order complete | ends 20 s after the complete screen |

All timings are env vars (see `apps/server/src/config.ts`).

## Deploying

`render.yaml` is a Render blueprint for the server and the kiosk. Open the server URL a few
minutes before the demo so the free tier is awake.
