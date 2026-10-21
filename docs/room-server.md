# The room server — a rendezvous for the handshake

*Decision made 2026-10-13, at Lokesh's call, after the three standing problems
below. This document is the design the code is built from; the protocol shapes
here are the contract between `worker/` and `lib/room-join.js`.*

## The problems it answers

All three come from one root: there is no rendezvous point, so the handshake is
carried by the players and every connection's credentials live exactly once.

1. **The party is brittle.** A page reload, an accidental back-swipe or a
   suspended tab ends the connection, and there is nothing to dial back into —
   the member must be re-invited by hand (`DEPARTURE_GRACE_MS` is 2.5 s with
   3 vouch retries, so a reload concludes "gone" within seconds).
2. **Joining needs two trips.** The invite payload *is* the SDP (~2 KB,
   per-connection), so both sides must carry something. A short join code has
   nothing to look the payload up against.
3. **Cross-network pairs fail.** Symmetric NAT / CGNAT defeats hole-punching,
   and with no relay those pairs cannot connect at all.

The fix for all three is the same thing: a small rendezvous service. The
decision is a **Cloudflare Worker + Durable Object** (signalling only) plus a
**TURN relay** served by it. The static site stays on GitHub Pages; the worker
is a separate `wrangler` deploy. **The existing scan/paste handshake remains
the fallback** when the room server is unreachable — progressive enhancement,
not a rewrite. The zero-server path (LAN, `file://`, offline) must keep working
and keep passing its tests.

## What the room server is — and is not

- **It is** a matchmaker: it mints 6-digit room codes, ferries offer/reply
  strings between sockets, verifies rejoin claims, and hands out ICE config.
- **It is not** a relay for game data. After the handshake, every byte of game
  traffic stays on WebRTC data channels, direct or peer-relayed, exactly as
  today. The server never sees a game message.
- **It sees SDP** — the same thing STUN already sees. This is the stated trust
  level; sealing offers against the server was offered and declined (default
  privacy option chosen 2026-10-13). Recorded here so it is a decision, not an
  oversight.

## The protocol

One WebSocket endpoint: `wss://<ROOM_SERVER>/room`. The worker routes by code
to the Durable Object named `code:<6 digits>`. All messages are JSON, one
shape: `{"t": "<type>", ...}`.

### Client → server

| message | meaning |
|---|---|
| `{"t":"host"}` | mint a room; the caller becomes its first member |
| `{"t":"join","code":"123456","id":"<memberId>","secret":"<token>","name":"..."}` | join (or rejoin) a room |
| `{"t":"offer","to":"<memberId>","sdp":"<packed invite string>"}` | relay an offer |
| `{"t":"answer","to":"<memberId>","sdp":"<packed reply string>"}` | relay an answer |
| `{"t":"leave"}` | the socket is going away deliberately |

The `sdp` fields carry the **same packed strings** the invite/reply codes use
today (`packSignal`/`unpackSignal` in `net.js`) — the room server ferries them
opaquely, and the existing codec test keeps covering their round-trip. No
trickle: the packed string already contains the gathered candidate set.

### Server → client

| message | meaning |
|---|---|
| `{"t":"room","code":"123456","ttl":900,"ice":{"servers":[...]}}` | reply to `host` |
| `{"t":"joined","ice":{"servers":[...]}}` | reply to a successful `join` |
| `{"t":"peer","id":"...","name":"...","rejoin":false,"connected":true,"offering":"<memberId>"}` | a member's state changed — arrived, reconnected, or their socket dropped (`connected:false`) |
| `{"t":"offer","from":"...","sdp":"..."}` | a relayed offer |
| `{"t":"answer","from":"...","sdp":"..."}` | a relayed answer |
| `{"t":"error","reason":"no-room"\|"bad-code"\|"full"\|"id-taken"\|"blocked"}` | always explicit, never a hang |

Two deliberate shapes:

- **`offering` names the member who should issue the offer** — the oldest
  attached member, chosen by the server. Every attached member gets the same
  notice, but only the one named in `offering` acts; the rest ignore the
  newcomer until the mesh introduces them. This keeps "any member can recruit"
  deterministic and avoids O(n) offers, without every client tracking join
  order.
- **There is no `gone` from the server.** A dropped socket becomes
  `{"t":"peer",...,​"connected":false}`; a reconnect flips it back to
  `true`. Rejoin claims persist until the room expires. The 5-minute seat
  grace is a party-record concept enforced in `net.js` — the server never
  decides membership, it only reports socket state. This removes a whole class
  of two-sources-of-truth bugs.

### Rules the server enforces

- **Codes**: 6 random digits, no colisting room; mint collision → redraw
  (max 5 tries). Room **TTL 15 min**, refreshed by any attached socket; a room
  with zero attached sockets expires 15 min after the last one left. Hard cap
  24 h.
- **Join rate limit**: 10 failed joins per IP per room per 5 min → then
  `{"t":"error","reason":"blocked"}`. A 6-digit space is 10^6; the TTL plus this
  limit is the whole defence, which is adequate for a party arcade.
- **Capacity**: mirror the party cap — at most 8 attached member sockets
  (`"full"`).
- **Rejoin claims**: on `join`, the server records `id → sha256(secret)`. A
  later `join` with the same `id` and matching `secret` reconnects them
  (`"rejoin": true` in the `peer` notice). Same `id`, wrong `secret` →
  `"id-taken"`. An unknown `id` reusing is impossible (random 12-char ids).
- The member list the server keeps is **for signalling and claims only**. The
  party record in `net.js` remains the single authority on membership.

## Who offers to whom

When a `peer` notice arrives, **the oldest attached member issues the offer**
(join order, deterministic, survives host succession). Everyone else ignores
the notice — once the newcomer has one link, `_openRelayed` in `net.js` meshes
them to the rest, exactly as today. This is the rule that keeps "any member can
recruit" without O(n) offers.

## Rejoin — the design that fixes the brittleness

**Client side (`lib/room-join.js`):** on hosting or joining, write
`localStorage["neon.room"] = {code, id, secret}`. On page load, if present and
the room server is reachable, offer **RECONNECT** automatically: re-`join`
with the stored `id`+`secret`, show "rejoining…" with a visible escape
("start fresh"). The guest connects with its **old member id** (`Room` needs a
new constructor option to adopt a chosen `selfId`). The token is cleared on
`leave()`, `deleteParty()`, and when the server reports the room gone.

**Seat grace:** a member who arrived via the room server is not concluded
"gone" on departure — their seat, name and team are held for **5 minutes** as a
reconnectable member (shown as RECONNECTING in the roster UI, driven by the
`connected:false` peer notices). Within the grace, a rejoin restores identity
and seat; after it, the member is dropped with today's `__gone` broadcast.
Members who never joined via the room server keep today's behaviour untouched.

## TURN — how cross-network pairs are covered

The static Open Relay credentials are **not** baked in: they now require an
account and are reported unreliable. Instead the worker holds a Metered
**credential-scoped `apiKey`** (the kind Metered documents as safe for
front-end use) as a Worker secret. On join, the DO fetches fresh
`iceServers` from `https://<app>.metered.live/api/v1/turn/credentials?apiKey=…`
(free plan, 5 GB/month — ample for a friends-and-family arcade where TURN
carries only the pairs hole-punching can't), caches it, and serves it in the
`ice` message. No TURN credential ever lands in the repo. With no secret
configured, the DO serves today's STUN-only list and behaviour is unchanged.

## Client surface (`lib/room-join.js`)

- `NeonArcade.roomServerUrl` — the constant `wss://…` (set once, after first
  deploy; overridable by `?rs=` query and `localStorage["neon.rs"]` for tests).
- `NeonArcade.roomServerReachable()` — probe with a short timeout; the UI
  shows JOIN WITH CODE only when true. Result cached per session.
- `NeonArcade.hostRoom(opts)` / `NeonArcade.joinRoom(code, opts)` — return a
  live `Room` plus the room code; they drive the WS handshake and then hand
  over to the same `Room` machinery the invite flow uses.
- The lobby and party screens gain **JOIN WITH CODE** (a 6-digit input) and
  the host panel gains the code, big, plus a QR of
  `<site>/party.html#c=123456` — tiny compared with today's 70-90 module
  grids, and scanning it *auto-joins*. `#c=` follows the existing `#i=`/`#a=`
  fragment pattern. The old invite/scan/paste flow remains, one button away,
  and is what shows when the room server is unreachable.

## Layout and testing

- `worker/hub.js` — the pure logic (`RoomHub`: codes, claims, TTL, relay) with
  an adapter interface, no Cloudflare imports. **This is what makes it
  testable with zero dependencies** — the same trick as `Room` over a fake
  transport in `test-plumbing.mjs`.
- `worker/index.js` — the DO + WebSocket shell (hibernatable WebSockets) and
  the `wrangler.toml` wiring (SQLite-backed DO, free tier).
- `scripts/test-hub.mjs` — `RoomHub` driven directly: mint/join/relay/rejoin/
  rate-limit/TTL, including the failure paths above.
- `scripts/test-room.mjs` — the *client* over a fake room-server transport:
  code join, `#c=` auto-join, rejoin restores identity, fallback when
  unreachable. The real `test-party.mjs` (three browsers, `file://`) keeps
  passing untouched — it exercises exactly the path that must not regress.
  `test-pwa.mjs`'s precache check must keep passing: **`lib/room-join.js`
  must be added to `sw.js`'s `SHELL` and `VERSION` bumped** (see the pwa skill
  before touching `sw.js`).
- A `MockRoomServer` window hook lets browser tests drive the code-join UI
  with no network, the same philosophy as the fake capture device in
  `test-scan.mjs`.
- Deploy: `npx wrangler login` once, then `npx wrangler deploy` in `worker/`
  (documented in `worker/README.md`); add `just deploy-room`. GitHub Pages is
  untouched.

## Honest gaps left by this design

- The DO is verified against a hub fake and `wrangler dev` at best until the
  first real deploy; production DO behaviour (hibernation, eviction) is
  unverified until then.
- A room code is guessable within its TTL by a determined attacker who knows
  the room-server URL and can evade the per-IP limit (botnet). Accepted for a
  party arcade; sealing offers with a key derived from the code is the
  documented next step if it ever matters.
- TURN coverage is only as good as Metered's free plan; if it lapses, pairs
  behind symmetric NAT degrade to today's explicit error, which still names
  the case.
- The room server is one more thing that can be down. That is why the
  fallback is not a degraded mode but the existing, fully tested zero-server
  path.
