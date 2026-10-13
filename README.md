# Raw City Spades — Multiplayer Server

Node.js + WebSocket (`ws`) game server. Authoritative Spades engine, room
management with 6-character room codes, and per-player hand privacy.

## Files

- `game.js` — authoritative Spades engine (bidding, play validation,
  trick resolution, scoring, match end). No AI; all 4 seats are humans.
- `rooms.js` — room create/join, host team setup, 60-second reconnect hold.
- `server.js` — WebSocket server + JSON protocol.
- `test-client.js` — end-to-end test: 4 scripted clients play a full hand.

## Start the server

```sh
cd ~/workspace/goals/raw-city-spades-subscription-game/server
npm install   # once
node server.js            # default port 8080
PORT=9000 node server.js  # custom port
```

## Run the test

```sh
npm test
# -> spawns the server on port 18080, plays a full hand, prints ALL TESTS PASSED
```

## Protocol (JSON over WebSocket)

Client -> server: `create_room {name, options?}`, `join_room {code,name,token?}`,
`set_teams {teams}`, `start_game {}`, `bid {bid}`, `play_card {cardId}`

Server -> client: `room_state`, `game_state` (your hand only),
`bid_prompt`, `play_prompt {legalCards[]}`, `trick_result`, `hand_result`,
`match_result`, `error`

`start_game` is also how the host deals the next hand after `hand_done`,
or starts a fresh match after `match_result`.

## Game options

Options are set once at room creation via `create_room {name, options}` and
apply to the whole match. They are echoed back in `room_state.options` (and in
each `game_state` view) so clients can display the active rules.

Defaults: `{ targetScore: 500, spadesMustBreak: true, sandbags: true }`

- `targetScore`: `250` or `500` — the match ends when a team reaches it
  (or drops below -200). Anything else is rejected.
- `spadesMustBreak`: boolean — when `false`, spades may be led at any time,
  even before spades are broken.
- `sandbags`: boolean — when `false`, overtricks still score +1 each but bags
  are never tracked and the 10-bag -100 penalty never applies.

Unknown option fields are ignored, so older clients keep working. Invalid
values get a clear `error` message and the room is not created.

## Subscriptions (Blackcity Spades Premium — $1.99/mo)

Premium unlocks private tables, chosen teams, and custom house rules.
Free players create public tables with default options (500 / spades must
break / sandbags on) and default teams (0&2 vs 1&3).

Environment:
- `STRIPE_SECRET_KEY` — Stripe secret key (test or live). Without it, the
  subscription endpoints are disabled and premium checks fail closed.
- `STRIPE_PRICE_ID` — override (default: the $1.99/mo price).
- `SUBSCRIBE_SUCCESS_URL` / `SUBSCRIBE_CANCEL_URL` — checkout redirects.

REST:
- `POST /api/create-checkout { playerId, playerName }` -> `{ url }`
- `POST /api/verify-session { sessionId, playerId }` -> `{ subscribed }`
- `GET /api/subscription-status?playerId=` -> `{ subscribed }`

No webhooks: the server verifies checkout sessions and subscription status
on demand via the Stripe API. Tests: `node test-client.js` (game logic,
run with `SUBS_BYPASS=1`), `node test-subs.js` (gating, no key needed).
