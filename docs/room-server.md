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
   and with no relay those pairs cannot connect at all. *Not* addressed by
   the room server — see "No TURN" below.

The fix for the first two is the same thing: a small rendezvous service. The
decision is a **Cloudflare Worker + Durable Object**, signalling only. The static site stays on GitHub Pages; the worker
is a separate `wrangler` deploy. **The existing scan/paste handshake remains
the fallback** when the room server is unreachable — progressive enhancement,
not a rewrite. The zero-server path (LAN, `file://`, offline) must keep working
and keep passing its tests.

## What the room server is — and is not

- **It is** a matchmaker: it holds 6-digit room codes (the client draws
  them), ferries offer/reply strings between sockets, and verifies and
  releases rejoin claims. It hands out no ICE config.
- **It is not** a relay for game data. After the handshake, every byte of game
  traffic stays on WebRTC data channels, direct or peer-relayed, exactly as
  today. The server never sees a game message.
- **It sees SDP** — the same thing STUN already sees. This is the stated trust
  level; sealing offers against the server was offered and declined (default
  privacy option chosen 2026-10-13). Recorded here so it is a decision, not an
  oversight.

## The protocol

One WebSocket endpoint per room: `wss://<ROOM_SERVER>/room/<code>`. The
worker routes it to the Durable Object named `code:<code>`. All messages are
JSON, one shape: `{"t": "<type>", ...}`. A client may give the base as
`https://…`; `lib/room-join.js` converts it to `wss://` itself, because older
browsers throw on an http(s) WebSocket URL.

### Client → server

| message | meaning |
|---|---|
| `{"t":"ping"}` | reachability probe (sent to `/room/000000`); touches no room, counts against no limit |
| `{"t":"host","code":"123456","id":"<memberId>","secret":"<token>"}` | open a room under the code the client drew; the caller becomes its first claim |
| `{"t":"join","code":"123456","id":"<memberId>","secret":"<token>"}` | join (or rejoin) a room |
| `{"t":"offer","to":"<memberId>","sdp":"<packed invite string>"}` | relay an offer |
| `{"t":"answer","to":"<memberId>","sdp":"<packed reply string>"}` | relay an answer |
| `{"t":"leave","id":"<memberId>","secret":"<token>"}` | give the seat back (deliberate leave only), then the socket closes |

The `sdp` fields carry the **same packed strings** the invite/reply codes use
(`packSignal`/`unpackSignal` in `net.js`) — the room server ferries them
opaquely, and the codec test keeps covering their round-trip. No trickle: the
packed string already contains the gathered candidate set.

One `sdp` value is not a packed string: an offerer that cannot seat the
newcomer because the party is full (bots count) relays `{"t":"offer","to":…,
"sdp":"full"}` instead of an offer, and the joiner rejects `full` at once. It
rides the existing relay so the server never learns a party's size.

### Server → client

| message | meaning |
|---|---|
| `{"t":"pong"}` | reply to `ping` |
| `{"t":"room","code":"123456"}` | reply to `host` |
| `{"t":"joined"}` | reply to a successful `join` — the code and claim were good; it does **not** mean anyone is there to answer |
| `{"t":"peer","id":"...","connected":true\|false,"offering":"<memberId>"}` | a member arrived, came back, dropped their socket, or released their seat (`connected:false`) |
| `{"t":"offer","from":"...","sdp":"..."}` | a relayed offer |
| `{"t":"answer","from":"...","sdp":"..."}` | a relayed answer |
| `{"t":"error","reason":"no-room"\|"bad-code"\|"full"\|"id-taken"\|"blocked"\|"taken"}` | always explicit, never a hang; the socket closes after it |

Two deliberate shapes:

- **`offering` names the member who should issue the offer** — the oldest
  attached member *other than the notice's subject*, ties broken by id.
  Every attached member except the subject gets the same notice; only the one
  named acts. Excluding the subject matters twice over: a returning host (the
  oldest member) is offered to by someone else instead of being named as
  their own offerer, and a newcomer who joined while nobody was attached is
  the one told to offer when an older member reattaches. If nobody else is
  attached, no notice is sent at all.
- **There is no `gone` from the server.** A dropped socket or a released seat
  is `connected:false`; a reconnect flips it back to `true`. The 5-minute seat
  grace is a party-record concept enforced in `net.js` — the server never
  decides membership, it only reports socket state.

### Rules the server enforces (`worker/hub.js`)

- **Codes**: 6 digits, drawn by the client; a code with a live room answers
  `taken` and the client redraws (3 tries). Room **TTL 15 min** from the last
  touch once nobody is attached; attached rooms live until the **24 h cap**.
  The last claim released closes the room at once.
- **Rate limit**: 10 failed joins (unknown code, wrong secret) **per IP** per
  5 min → `blocked`, for joins and hosts alike. Per IP, never per room, so one
  stranger's guesses cannot lock a party's friends out. A blocked host is
  refused before its room exists, so it cannot squat a code. The IP is
  `CF-Connecting-IP`, recorded when the socket is accepted.
- **Capacity**: at most 8 *claims* (`full`) — not sockets, so a reloading
  member can always get back into their own seat. A claim detached for longer
  than the mesh's 5-minute seat grace is pruned, and a released claim is gone
  at once, so departed members never fill a long party.
- **Rejoin claims**: the server records `id → sha256(secret)`. A later `join`
  with the same `id` and secret reconnects the seat; the wrong secret is
  `id-taken`. `leave` with the right secret deletes the claim.
- The member list the server keeps is **for signalling and claims only**. The
  party record in `net.js` remains the single authority on membership.

## Who offers to whom

When a `peer` notice with `connected:true` arrives, the member named in
`offering` issues the offer; everyone else ignores it — once the newcomer has
one link, `_openRelayed` in `net.js` meshes them to the rest. The client's
offer guard is cleared whenever an offer settles (link open, `connected:false`,
invite failure, socket replaced), so a member who reconnects any number of
times is offered to every time. If the offerer still holds a link to the
returning member, it is either live (a signalling hiccup — no offer needed) or
the leftover of a reload; the client re-checks every second for 12 s (the
slowest close net.js measured is a killed tab, ~11 s) and offers the moment it
closes. The offer is minted with `createInvite({ forPeer })`, so a member who
holds a seat in a full party is not refused their own seat.

## Joining resolves on a link and a host, not on the server's word

`joinRoom` resolves only once a data channel to a party member is open **and**
the room knows its host (`room.hostId() !== null`, learned from the first
`__p` record). A link alone is not enough: a lone host who reloads comes back
with no record, and if a newcomer types the code meanwhile the server has the
newcomer offer to them — the two link, neither can name a host, and resolving
there left both in a hostless party for good. Nobody crowns themselves to
escape it: a term-0 crown could outrank the real party's record later.

If that has not happened within `JOIN_ANSWER_MS` (30 s; `opts.answerTimeoutMs`
in tests) of `joined`, it rejects with `reason: "no-answer"`. The deadline
outlasts the offerer's worst case on a reload: the 12 s stale-link watch, ICE
gathering on both ends (4 s each), then the connect. A first join calls
`room.leave()`, which releases the claim and clears the token. **A rejoin
(the token's code) keeps both**: the party may only be slow, so the party
screen offers RETRY beside START A NEW PARTY and says the party may have
ended. START A NEW PARTY calls `NeonArcade.releaseRejoin()` — dial with the
token, `leave`, drop the token — so the old party does not hold a seat for a
browser that moved on.

An offerer that cannot seat a newcomer (the party is full) says so (see the
`"sdp":"full"` relay above) and the join rejects `full` at once instead of
waiting out the deadline. `opts.signal` (an `AbortSignal`) cancels a join in
progress: the claim is released and the token cleared *before* `abort()`
returns, and the promise rejects `aborted` — START A NEW PARTY pressed during
a reconnect uses this before navigating away.

`no-answer` covers every remaining "the code was right but nobody is there"
case: a party whose members all left (claims outlive them until the TTL), or a
network pair STUN cannot connect. A dial (host/join/ping) that gets no reply
within 8 s, or whose `new WebSocket` throws, rejects with `"unreachable"`.
Reasons a caller can see: `unreachable | blocked | no-room | id-taken |
bad-code | full | no-answer | taken | aborted`, each with a neutral sentence
in `err.message`.

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

## No TURN

*Owner decision, 2026-11-11.* The room server only exchanges SDP; NAT
traversal is the same STUN path as the classic invite flow (`DEFAULT_ICE` in
`net.js`, or `opts.iceServers`). There is no ICE field in the protocol and no
TURN credential anywhere. Pairs behind symmetric NAT / CGNAT fail exactly as
they do in the classic flow — with an explicit error (`no-answer` for a join
by code), never a hang. (An earlier design served Metered TURN credentials
from the worker; it was removed before the first deploy.)

## Client surface (`lib/room-join.js`)

- `NeonArcade.roomServerUrl` — the base URL (`https://` or `wss://`;
  overridable by `?rs=` query and `localStorage["neon.rs"]` for tests).
- `NeonArcade.roomServerReachable()` — a `ping` with a 2.5 s timeout; the UI
  shows JOIN WITH CODE only when true. Success cached per page.
- `NeonArcade.hostRoom(opts)` / `NeonArcade.joinRoom(code, opts)` — return
  `{ room, code }`; they drive the WS handshake and hand over to the same
  `Room` machinery the invite flow uses. `joinRoom` resolves on the first
  open link once a host is known, and takes `opts.signal` to cancel (see
  above).
- `NeonArcade.releaseRejoin()` — give back the seat the rejoin token claims
  and drop the token; best-effort, bounded by the 2.5 s probe timeout.
- The lobby and party screens gain **JOIN WITH CODE** (a 6-digit input) and
  the host panel gains the code, big, plus a QR of
  `<site>/party.html#c=123456` — tiny compared with today's 70-90 module
  grids, and scanning it *auto-joins*. `#c=` follows the existing `#i=`/`#a=`
  fragment pattern. The old invite/scan/paste flow remains, one button away,
  and is what shows when the room server is unreachable.

## Layout and testing

- `worker/hub.js` — the pure logic (`makeHub`: codes, claims, TTL, relay) with
  an adapter interface, no Cloudflare imports. **This is what makes it
  testable with zero dependencies** — the same trick as `Room` over a fake
  transport in `test-plumbing.mjs`.
- `worker/index.js` — the DO + WebSocket shell (hibernatable WebSockets) and
  the `wrangler.toml` wiring (SQLite-backed DO, free tier). Every handler
  (message, close, error, alarm) rebuilds the hub from storage and socket
  attachments (`{ip, code, id}`) if the object was evicted.
- `scripts/test-hub.mjs` — the hub driven directly: host/join/relay/rejoin/
  release/prune/rate-limit/TTL/eviction, including the failure paths above.
- `scripts/test-room.mjs` — the *client* over the in-page mock: code join,
  guest reloads (three times), host reload, grace expiry, `no-answer` on a
  code nobody answers, a rejoin nobody answers keeping its claim, two
  hostless members never resolving, a full party (member reconnects, newcomer
  hears `full`), an aborted rejoin releasing its claim, `#c=` auto-join, fallback when unreachable. The real `test-party.mjs` (three browsers, `file://`) keeps
  passing untouched — it exercises exactly the path that must not regress.
  `test-pwa.mjs`'s precache check must keep passing: **`lib/room-join.js`
  must be added to `sw.js`'s `SHELL` and `VERSION` bumped** (see the pwa skill
  before touching `sw.js`).
- `?mockroom=1` installs an in-page mock (`window.__neonRoomMock`, private to
  `room-join.js`) so browser tests drive the code-join UI with no network, the
  same philosophy as the fake capture device in `test-scan.mjs`. It mirrors
  the hub's observable rules; it cannot *be* `hub.js`, which is an ES module,
  and module scripts do not load on `file://`.
- Deploy: `npx wrangler login` once, then `npx wrangler deploy` in `worker/`
  (documented in `worker/README.md`); add `just deploy-room`. GitHub Pages is
  untouched.

## Honest gaps left by this design

- **Verified locally, not deployed.** On 2026-11-11 the worker ran under
  `wrangler dev` (wrangler 4.151.1 via `nix shell nixpkgs#wrangler`) and two
  real Chrome pages in separate contexts joined by code, survived two real
  guest reloads and a real host reload, got `no-answer` for a code whose only
  member had closed their tab, and `no-room` after the only member's
  `leave()` released the claim. Production DO behaviour — hibernation and
  eviction in particular — is still unverified until the first real deploy.
- **The code-guessing limit does not span rooms in production.** Each room is
  its own Durable Object, so the per-IP failure counter lives per room: a
  guesser trying *different* codes hits a different object each time and is
  never counted. The 6-digit space plus the TTL is the only defence against
  that today. The fix is a shared counter — Cloudflare's Rate Limiting
  binding in the routing Worker, or one Durable Object per IP — and it is not
  built.
- Sealing offers against the server (a key derived from the code) is the
  documented next step if the server's view of SDP ever matters.
- Symmetric-NAT pairs cannot connect (no TURN, by choice); they fail with an
  explicit error, as in the classic flow.
- The room server is one more thing that can be down. That is why the
  fallback is not a degraded mode but the existing, fully tested zero-server
  path.
