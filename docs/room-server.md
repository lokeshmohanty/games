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
worker routes it to the Durable Object named `code:<code>`. One plain HTTP
endpoint besides: `GET /ping` → `204` (with `Access-Control-Allow-Origin: *`
and `Cache-Control: no-store`), the client's reachability probe, answered by
the routing Worker itself so it never wakes an object. (Until 2026-11-11 the
probe was a WebSocket `{"t":"ping"}` to `/room/000000`: one Durable Object
every client probed on every page.) All messages are
JSON, one shape: `{"t": "<type>", ...}`. A client may give the base as
`https://…`; `lib/room-join.js` converts it to `wss://` itself, because older
browsers throw on an http(s) WebSocket URL.

### Client → server

| message | meaning |
|---|---|
| `{"t":"host","code":"123456","id":"<memberId>","secret":"<token>"}` | open a room under the code the client drew; the caller becomes its first claim |
| `{"t":"join","code":"123456","id":"<memberId>","secret":"<token>"}` | join (or rejoin) a room |
| `{"t":"offer","to":"<memberId>","sdp":"<packed invite string>"}` | relay an offer |
| `{"t":"answer","to":"<memberId>","sdp":"<packed reply string>"}` | relay an answer |
| `{"t":"full","to":"<memberId>"}` | the offerer cannot seat this newcomer: the party is full (bots count) |
| `{"t":"leave","id":"<memberId>","secret":"<token>"}` | give the seat back (deliberate leave only); the server then closes the socket, and that close is the client's receipt |
| `{"t":"release","code":"123456","id":"<memberId>","secret":"<token>"}` | give back a claim from a socket that holds **no** seat (`releaseRejoin`); verified without binding — a seat with a live socket answers `busy` and is untouched. A verified claim is never charged; an unproven one is charged like a guess. The server closes the socket after its answer |

The `sdp` fields carry the **same packed strings** the invite/reply codes use
(`packSignal`/`unpackSignal` in `net.js`) — the room server ferries them
opaquely, and the codec test keeps covering their round-trip. No trickle: the
packed string already contains the gathered candidate set.

An offerer that cannot seat the newcomer because the party is full (bots
count) sends `{"t":"full","to":…}` instead of an offer, and the joiner rejects
`full` at once. The hub relays it like an offer, without an `sdp`, so the
server never learns a party's size — only the mesh counts seats. (Until
2026-11-11 this rode the offer relay as `"sdp":"full"`; it is its own
message now so no packed string can ever be mistaken for it.) The relay
whitelist is exactly `offer`, `answer`, `full`.

### Server → client

| message | meaning |
|---|---|
| `{"t":"room","code":"123456"}` | reply to `host` |
| `{"t":"joined"}` | reply to a successful `join` — the code and claim were good; it does **not** mean anyone is there to answer |
| `{"t":"released"}` / `{"t":"busy"}` | reply to `release`: the claim is gone / the seat is live on another socket (another tab), nothing changed |
| `{"t":"peer","id":"...","connected":true\|false,"offering":"<memberId>"}` | a member arrived, came back, dropped their socket, or released their seat (`connected:false`) |
| `{"t":"offer","from":"...","sdp":"..."}` | a relayed offer |
| `{"t":"answer","from":"...","sdp":"..."}` | a relayed answer |
| `{"t":"full","from":"..."}` | the offerer says the party has no seat for you |
| `{"t":"error","reason":"no-room"\|"bad-code"\|"full"\|"id-taken"\|"blocked"\|"taken"\|"no-claim"}` | always explicit, never a hang; the socket closes after it |

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
- **Rate limit**: 10 failed attempts **per IP** per 5 min → `blocked`, for
  joins and hosts alike, **across every room**. A failure is any refusal —
  `no-room`, `id-taken`, `full`, and `taken` for a host, since each says
  whether a code is live. Every attempt is *charged before the lookup* and
  refunded on success, so opening many sockets at once buys a guesser
  nothing (at most 10 attempts are ever outstanding), and a friend who
  rejoins all evening never runs out. Per IP, never per room, so one
  stranger's guesses cannot lock a party's friends out. A blocked host is
  refused before its room exists, so it cannot squat a code. The IP is
  `CF-Connecting-IP`, recorded when the socket is accepted; an IPv6 address
  counts by its **/64** (one customer is routinely handed a whole /64, so a
  fresh address per guess must not be a fresh budget). The `GET /ping`
  probe never reaches a room or the gate, so it is never charged.
- **A valid claim is never charged** (2026-11-11). A `join` whose `id` and
  secret match a live claim is checked *before* the limiter and bound
  without touching it — it proves the sender already holds the seat, so it
  guesses nothing. Before, every reconnect was charged: a LAN party or a
  carrier's CGNAT behind one address, after a few typos, re-dialling together
  after a blip, was answered `blocked`, and the client took that as final.
  Only unproven attempts (new joins, wrong secrets, hosts) are charged.
- **Where the counter lives**: every room is its own Durable Object, so a
  counter inside one only sees guesses at its own code. The count lives in a
  second Durable Object class, `IpGate`, one per IP (`idFromName("ip:<ip>")`,
  `ip:<prefix>::/64` for IPv6);
  each room charges and refunds against it over `fetch`. The limiter itself
  is `makeLimiter` in `hub.js` — pure, shared by the hub's default and the
  gate. The gate persists its count (an eviction does not forgive a
  guesser) and clears it with an alarm when the window closes. Chosen over
  Cloudflare's Rate Limiting binding (2026-11-11) because the binding is
  per-location and eventually consistent, and a gate object behaves
  identically under `wrangler dev`, so the limit is tested, not assumed. If
  the gate cannot be reached, the attempt **fails closed** (`blocked`):
  falling back to a per-room limiter, as it did until 2026-11-11, let anyone
  who could overload the gate switch the cross-room limit off. Members never
  feel it — their rejoins never reach the gate — and a refund that cannot be
  delivered is dropped. With no `GATE` binding the hub keeps its own
  per-room limiter.
- **A rejoin replaces the socket**: if a claim's old socket is still open
  (it died half-open), the hub closes it (`4409 replaced`) and forgets it.
  The client never redials after a 4409 on its current socket: its own
  replacements cannot produce one (rejoinServer retires the socket it
  closes; a redial's predecessor had already closed), so a 4409 means
  **another tab of the same browser** reconnected with the same token. The
  displaced tab stands down — `room.detach()` closes its links with no
  `__gone` (the member id lives on in the other tab), the claim and token
  are left alone — and the party screen says "This party is open in another
  tab" with USE THIS TAB INSTEAD (a reload, which displaces the other one).
  Before 2026-11-11 the two tabs traded the seat every second, forever.
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
invite failure, socket replaced) and after 20 s regardless, so a member who
reconnects any number of times is offered to every time. Under the glare rule
the lower id sets the higher id's offer aside rather than dropping it: if its
own offer then cannot be made, it answers the set-aside one, which is the
pair's only offer left. If the offerer still holds a link to the
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
ended. START A NEW PARTY calls `NeonArcade.releaseRejoin()` — a `release`
with the token's claim, then drop the token — so the old party does not hold
a seat for a browser that moved on.

**START A NEW PARTY never takes another tab's live seat** (2026-11-11).
`releaseRejoin` used to dial `join` with the claim and then `leave`. Tabs of
one browser share the token, so when a second tab held that seat live, the
join bound it and hung that tab up (`4409`): it said "open in another tab",
the leave then gave its seat away (a ghost in the party for 5 minutes, a
stuck crown if it was host), and its USE THIS TAB reloaded into a brand-new
party. A `release` is checked without binding; a live seat answers `busy`.
On `busy` the token is kept and **no party is started** — a new party's token
would replace the shared one, and the other tab's next reload would walk into
this tab's party. The screen shows "This party is open in another tab." with
USE THIS TAB INSTEAD (which takes the seat over by the usual 4409, and the
other tab stands down). To host a separate party, leave the old one in the
tab that holds it first.

An offerer that cannot seat a newcomer (the party is full) says so (see the
`"sdp":"full"` relay above) and the join rejects `full` at once instead of
waiting out the deadline. `opts.signal` (an `AbortSignal`) cancels a join in
progress: the `leave` is sent and the token cleared *before* `abort()`
returns, and the promise rejects `aborted` — START A NEW PARTY pressed during
a reconnect uses this before navigating away.

**A leave lands before the page goes.** Every `leave` is acknowledged by the
server closing the socket; `NeonArcade.roomSettled()` resolves once every
leave this page sent has been acknowledged, or after 1.5 s
(`LEAVE_ACK_MS`). NEW PARTY, ALL GAMES, START A NEW PARTY, and accepting a
`#c=`/`#i=` link into a live party all await it before navigating, and
`releaseRejoin()` awaits its own. Without it an unload could take the frame
down with it, and the old party would keep a seat for a browser that is
gone. (Over loopback the unwaited frame was never seen lost — 0 in 4 —
so the guarantee is the wait, not a measured race.)

**A reload with a token always tries the reconnect**, even when the
reachability probe would fail: an unreachable server answers `unreachable`,
which keeps the token and offers RETRY beside START A NEW PARTY. (Until
2026-11-11 the boot probed first and, on failure, silently hosted a brand-new
party over the one the player was in.)

`no-answer` covers every remaining "the code was right but nobody is there"
case: a party whose members all left (claims outlive them until the TTL).
A network pair STUN cannot connect is `no-route` instead (since 2026-11-11):
the party answered, ICE failed (~15 s), and the join rejects at once with
net.js's own message naming the paths tried — RETRY is offered, and a rejoin
keeps its claim. A dial (host/join/release) that gets no reply
within 8 s, or whose `new WebSocket` throws, rejects with `"unreachable"`.
Reasons a caller can see: `unreachable | blocked | no-room | id-taken |
bad-code | full | no-answer | no-route | taken | aborted | displaced`, each
with a neutral sentence in `err.message` (`displaced`: another tab took the
seat while this one was still joining).

**Redials.** A signalling socket that drops while the room is live is
re-dialled with the claim, backing off 1 s → 30 s. `unreachable` and
`blocked` retry (a valid claim is never charged, so `blocked` only means the
server could not check ours just then); `no-room`, `full` and `id-taken` end
signalling, and a 4409 stands the tab down (above). A deliberate leave that
finds the socket mid-redial is *owed*: the redial is brought forward if it was
only scheduled, and the socket it gets carries the `leave` (and
`roomSettled()` waits for it). Before 2026-11-11 that dial landed, was hung up
without a word, and the party held the seat for 5 minutes.

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
they do in the classic flow — with an explicit error (`no-route` for a join
by code, ~15 s), never a hang. Measured in the NAT lab:
[network-testing.md](network-testing.md).

**Losing every link re-announces.** A member whose last link closes while the
party still has people (net.js `onIsolated`) re-dials the room server with its
claim; the hub's notice makes the elected member offer again. That is what
heals a network switch (~10.5 s) and a long blackout. Two members doing it at
once may both be told to offer; the client's glare rule keeps the lower id's
offer. (An earlier design served Metered TURN credentials
from the worker; it was removed before the first deploy.)

## Client surface (`lib/room-join.js`)

- `NeonArcade.roomServerUrl` — the base URL (`https://` or `wss://`); deployed at `https://neon-arcade-room.lokeshmohanty.workers.dev`.
  Overridden by `localStorage["neon.rs"]` (a self-hosted server, a test).
  **`?rs=` is honoured only when it names a loopback server** (`localhost`,
  `127.x.x.x`, `[::1]`) — since 2026-11-11. The room server relays the SDP
  every link is made from, DTLS fingerprints included, so a server a link
  could choose could swap them and sit in the middle of every data channel.
  The STUN server has a storage-only override for the same reason,
  `localStorage["neon.stun"] = "host:port"` (net.js; anything else is
  ignored). NEW PARTY carries no query to the new party: a stored server
  needs no carrying, and a loopback `?rs=` is a developer's own session.
- `NeonArcade.roomServerReachable()` — `GET <base>/ping` with a 2.5 s
  timeout (silent past it is unreachable); the UI shows JOIN WITH CODE only
  when true. Success cached per page; the in-page mock is always reachable.
- `NeonArcade.hostRoom(opts)` / `NeonArcade.joinRoom(code, opts)` — return
  `{ room, code }`; they drive the WS handshake and hand over to the same
  `Room` machinery the invite flow uses. `joinRoom` resolves on the first
  open link once a host is known, and takes `opts.signal` to cancel (see
  above).
- `NeonArcade.releaseRejoin()` — give back the seat the rejoin token claims
  (a `release`, never `join`+`leave`) and drop the token; resolves
  `"released"`, `"busy"` (another tab holds the seat live: token kept,
  nothing started — see above) or `"none"` (nothing to give back, or no
  server: the claim lapses). Bounded by 4 s (probe timeout + leave ack).
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
- `worker/index.js` — the DO + WebSocket shell (hibernatable WebSockets), the
  `IpGate` object, and the `wrangler.toml` wiring (two SQLite-backed DO
  classes, free tier). Every handler (message, close, error, alarm) rebuilds
  the hub from storage and socket attachments (`{ip, code, id, at}`) if the
  object was evicted; `at` orders a member's sockets so the newest is the
  one rebound.
- `scripts/test-hub.mjs` — the hub driven directly: host/join/relay/rejoin/
  release/prune/rate-limit/TTL/eviction, including the failure paths above,
  50 concurrent guesses getting 10 lookups, the `full` relay, and a valid
  claim never charged (a whole party behind one address rejoining together
  after its address ran out of guesses).
- `scripts/test-worker-do.mjs` — the Durable Object *shell* (`RoomSignal`,
  `IpGate`) in plain Node over a fake `state` and fake sockets, evicted by
  hand: a fresh instance over the same storage and sockets, then a message,
  a close, a new connection, an alarm and a leave each as the first thing
  the cold object sees. Also guesses across eleven rooms hitting the gate,
  an evicted gate still blocking, a half-open socket never winning a
  wake-up, a failing gate refusing unproven joins (and refunding nothing)
  while a member's rejoin never touches it, and IPv6 counted by /64. In the
  default `just test`.
- `scripts/test-worker.mjs` (`just test-worker`, not in `just test`: it needs
  wrangler) — starts `wrangler dev` itself and drives it with node sockets
  and real browser contexts: the cross-room guess limit (a second IP
  unaffected), NEW PARTY / ALL GAMES releasing the seat before navigating,
  the reconnect screen's RETRY and START A NEW PARTY after a no-answer, a
  `#c=` link into a live party asking first, a classic invite dropping an old
  token, a reconnect with the server unreachable keeping the token and
  offering RETRY, and two tabs of one browser context sharing a token (the
  displaced one stands down, says so, never re-dials; USE THIS TAB INSTEAD
  swaps them). Skips with a message if wrangler cannot start.
- `scripts/test-room.mjs` — the *client* over the in-page mock: code join,
  guest reloads (three times), host reload, grace expiry, `no-answer` on a
  code nobody answers, a rejoin nobody answers keeping its claim, two
  hostless members never resolving, a full party (member reconnects, newcomer
  hears `full`), an aborted rejoin releasing its claim, a leave during a
  scheduled or in-flight redial still releasing it, glare followed by a
  failed offer answering the set-aside one, a redial answered `blocked`
  retrying, two same-token rooms not fighting (the mock hangs up a replaced
  socket with 4409, as the hub does), `#c=` auto-join, fallback when
  unreachable. The real `test-party.mjs` (three browsers, `file://`) keeps
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
  (documented in `worker/README.md`). Live since 2026-11-11 at
  `https://neon-arcade-room.lokeshmohanty.workers.dev`. GitHub Pages is
  untouched.

## Honest gaps left by this design

- **Verified on real Cloudflare — a temporary deployment, not the owner's
  account.** On 2026-11-11 the worker ran on a `wrangler deploy --temporary`
  preview account (wrangler 4.151.1; account and URL expire 60 min after
  creation) and `scripts/test-live.mjs` (`just test-live <url>`) drove it
  with real Chrome and the public STUN servers in `net.js` DEFAULT_ICE:
  join by code, messages, a host reload, two guest reloads, a rejoin nobody
  answered (RETRY, then START A NEW PARTY releasing the claim), two tabs on
  one token (4409; `releaseRejoin` → `busy`), NEW PARTY's leave releasing
  the claim, a full party at eight seats — all green. **Hibernation is
  real-verified:** with the deployment's `ROOM_DEBUG` var the 101 carries
  the object's instance id, and after 40–70 s idle it was a new instance
  every time, yet an offer relayed between the sockets that hibernated, a
  hibernated socket's close was announced, the closed seat's claim was held,
  and browser reloads (guest and host) rejoined. **The alarm is
  real-verified:** a room nobody touched for 16 min was gone (`no-room`;
  `restore` does not sweep, so only the alarm can have deleted it) — across
  two redeploys. **Repeated on the owner's permanent deployment** (2026-11-12,
  `https://neon-arcade-room.lokeshmohanty.workers.dev`): `ping`, `flows`
  over IPv4 and over IPv6, and `hib`'s post-idle checks all green; eviction
  itself is not *proven* there (no `ROOM_DEBUG`, by design).
- **Cloudflare may challenge a client's address.** The temporary preview
  deployment answered this host's IPv4 (a shared ISP address) with a managed
  challenge — `403`, `cf-mitigated: challenge` — which a WebSocket cannot
  solve. The owner's permanent deployment did **not** (2026-11-12: `/ping`
  204 and full flows over IPv4 and IPv6 from the same host). It remains
  possible for other addresses Cloudflare scores badly; such a player sees
  "Could not reach the room server" and gets the classic flow.
- **The guess limit trusts `CF-Connecting-IP`.** Cloudflare sets it in
  production (live check 2026-11-11: ten wrong codes, the eleventh
  `blocked`; see `test-live.mjs` gate); `wrangler dev` passes a client's
  own header through, which is what lets the local test drive two IPs. An
  attacker with many addresses gets 10 guesses per address per 5 minutes.
  A dual-stack client is two addresses — its IPv4 and its IPv6 /64 — so it
  gets two budgets; live tests of the limit pin one family for that reason.
- Sealing offers against the server (a key derived from the code) is the
  documented next step if the server's view of SDP ever matters. Until then
  the room server could rewrite the fingerprints it relays, which is why
  only storage or a loopback `?rs=` may choose it.
- **The timing oracle: measured, then capped.** Measured on real
  Cloudflare (2026-11-11, 30 samples each, interleaved, a fresh TLS
  connection per sample): WebSocket 101 for a live code median 543 ms / p90
  681 ms, for a never-used code 727 / 878 ms; first (uncharged) reply 699 /
  772 vs 921 / 1108 ms. A one-shot midpoint classifier told them apart 93%
  of the time from the 101 alone — the never-used code's object is created
  by the request. It cost nothing, since a socket that sends nothing was
  never charged. **Fix:** the routing Worker charges every upgrade one
  *dial* at the sender's `IpGate` before touching a room, and the room
  refunds it on the socket's first successful host/join/release
  (`RoomSignal.refundDial`). Unrefunded dials are capped at `DIAL_FAILS`
  (20) per 5 min, then `429` for every code alike — so the oracle is no
  cheaper than guessing (it was unlimited). Members never pay (their dials
  come back); the dial gate fails *open*, because a dial cannot prove a
  claim yet and failing closed would let a gate outage cut every member
  off, while the guess limit behind it still fails closed. The latency gap
  itself remains; only its price changed. To the client a `429` upgrade is
  just a socket that could not be made — `unreachable`, retried with the
  usual backoff and offered RETRY. Tests: test-worker-do "Every
  upgrade spends a dial", test-live oracle (refused within the budget).
- **A leave mid-redial still binds.** The owed leave (`oweLeave`) re-dials
  `join` with the claim and then `leave`s, as `releaseRejoin` used to. If a
  second tab took the seat in between, that join hangs it up. Narrower than
  START A NEW PARTY (the first tab must have been mid-redial *and* not yet
  displaced) and left as is.
- Symmetric-NAT pairs cannot connect (no TURN, by choice); they fail with an
  explicit error, as in the classic flow.
- The room server is one more thing that can be down. That is why the
  fallback is not a degraded mode but the existing, fully tested zero-server
  path.
