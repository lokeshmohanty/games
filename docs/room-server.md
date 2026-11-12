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

- **It is** a matchmaker: it holds 6-digit room codes (it draws them for
  hosts, since 2026-11-12), ferries offer/reply strings between sockets,
  verifies and releases rejoin claims, and issues member passes. It hands
  out no ICE config.
- **It is not** a relay for game data. After the handshake, every byte of game
  traffic stays on WebRTC data channels, direct or peer-relayed, exactly as
  today. The server never sees a game message.
- **It sees SDP** — the same thing STUN already sees. This is the stated trust
  level; sealing offers against the server was offered and declined (default
  privacy option chosen 2026-10-13). Recorded here so it is a decision, not an
  oversight.

## The protocol

One WebSocket endpoint per room: `wss://<ROOM_SERVER>/room/<code>`. The
worker routes it to the Durable Object named `code:<code>`. A member's
re-dial adds its pass to the query — `/room/<code>?id=<memberId>&exp=<ms>&pass=<mac>`
(see "Member passes" below); anything else in the query is ignored. Hosting
has its own endpoint, `wss://<ROOM_SERVER>/room/new`: the Worker draws a
free code and the `room` reply names it. One plain HTTP endpoint besides: `GET /ping` → `204` (with `Access-Control-Allow-Origin: *`
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
| `{"t":"host","id":"<memberId>","secret":"<token>"}` | on a `/room/new` socket only: open the room under the code the server drew for it; the caller becomes its first claim. On any other socket: `bad-code` |
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
| `{"t":"room","code":"123456","pass":"<mac>","exp":<ms>}` | reply to `host`: the code the server drew, and the host's member pass (`pass`/`exp` absent when the deployment has no `ROOM_PASS_KEY`) |
| `{"t":"joined","pass":"<mac>","exp":<ms>}` | reply to a successful `join` (first or rejoin), with a fresh member pass — the code and claim were good; it does **not** mean anyone is there to answer |
| `{"t":"released"}` / `{"t":"busy"}` | reply to `release`: the claim is gone / the seat is live on another socket (another tab), nothing changed |
| `{"t":"peer","id":"...","connected":true\|false,"offering":"<memberId>"}` | a member arrived, came back, dropped their socket, or released their seat (`connected:false`) |
| `{"t":"offer","from":"...","sdp":"..."}` | a relayed offer |
| `{"t":"answer","from":"...","sdp":"..."}` | a relayed answer |
| `{"t":"full","from":"..."}` | the offerer says the party has no seat for you |
| `{"t":"error","reason":"no-room"\|"bad-code"\|"bad-id"\|"full"\|"id-taken"\|"blocked"\|"no-claim"\|"expired"}` | always explicit, never a hang; the socket closes after it |
| `{"t":"error","reason":"bound"}` | a second `host`/`join`/`release` on a socket that already asked; nothing changes and the socket stays open with what its first ask got |

**Past a dial or host budget the upgrade is refused on a socket of the
routing Worker's own** (2026-11-12): it accepts with a `WebSocketPair` —
never a room object's — sends `{"t":"error","reason":"blocked"}` and hangs
up `4429`, the same for every code. A browser WebSocket never sees an HTTP
status, so a plain `429` reached the player as "Could not reach the room
server"; now it reads "Too many attempts". The other refusals before any
socket exists stay HTTP statuses (a browser sees a failed socket):
`503` when the gate cannot answer or every drawn code was live, `426`
without an upgrade, `404` for any other path.

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

- **Codes**: 6 digits, **drawn by the server** (2026-11-12). `/room/new`
  draws one (100000–999999, `crypto.getRandomValues`) and forwards the
  upgrade to that code's object as `/room/<code>/new` — a path only the
  Worker can make (from outside it is 404) — which takes the socket only
  if the code has no room (*create-if-free*), else answers the Worker
  `409` and it draws again (8 draws, then `503`). The object *reserves* the
  code for that socket: until it says `host`, a `join` or `release` there
  answers `no-room` exactly as on a dead code, a second draw gets `409`,
  and the socket closing gives the code back. **A reservation lapses**
  (2026-11-12): `RESERVE_MS` (15 s) after the draw — the attachment keeps
  `reservedAt`, and the reservation arms the object's alarm — the socket
  is hung up (`4408 unhosted`) and the code freed; a `host` that arrives
  later is `expired`. A wake-up re-reserves only a reservation still
  inside its 15 s, on its original clock; a lapsed one (or an attachment
  without `reservedAt`) is hung up instead. Before, a silent `/room/new`
  socket held its code for as long as it stayed open, and an eviction
  re-reserved it with a fresh clock — squatting. The client only ever hears
  the code it got. (Until 2026-11-12 the client drew codes and redrew on
  `taken` — so a host's success *was* the answer "that code is dead",
  and hosting had to be charged as a guess.) Room **TTL 15 min** from the
  last touch once nobody is attached; attached rooms live until the
  **24 h cap**. The last claim released closes the room at once.
- **Rate limit**: 10 failed attempts **per IP** per 5 min → `blocked`, for
  joins and claim-less releases, **across every room**. A failure is any
  refusal — `no-room`, `id-taken`, `full`, `no-claim` — since each says
  whether a code is live. Hosting is not a guess and is never charged here. Every attempt is *charged before the lookup* and
  refunded on success, so opening many sockets at once buys a guesser
  nothing (at most 10 attempts are ever outstanding), and a friend who
  rejoins all evening never runs out. Per IP, never per room, so one
  stranger's guesses cannot lock a party's friends out. The IP is
  `CF-Connecting-IP`, recorded when the socket is accepted; an IPv6 address
  counts by its **/64** (one customer is routinely handed a whole /64, so a
  fresh address per guess must not be a fresh budget). The `GET /ping`
  probe never reaches a room or the gate, so it is never charged.
- **Every unproven upgrade spends a dial** (`DIAL_FAILS`, = the guess
  limit: 10 per 5 min per address). An upgrade to `/room/<code>` without a
  valid member pass is charged at the sender's `IpGate` before any room
  object is touched; `blocked` past the budget, `503` if the gate cannot
  answer (fails *closed*). The room refunds the dial on the socket's first
  successful `join` or `release`. So every code anybody tests and finds
  dead costs one dial, whichever way they ask (see the timing oracle under
  Honest gaps). Only `/room/<6 ASCII digits>` (and `/room/new`) with
  `Upgrade: websocket` reaches a room — a trailing slash, a seventh digit,
  percent-encoding, other case, `/room/<code>/new` or a non-upgrade request
  is answered by the Worker alone (404/426) and charged nothing; a query
  string is the same room and is charged unless it is a valid pass.
- **Member passes** (2026-11-12). Every seat the room grants — `room` to a
  host, `joined` to a first join or a rejoin — carries
  `pass = base64url(HMAC-SHA256(ROOM_PASS_KEY, "<code>.<id>.<exp>"))` and
  `exp` (now + 24 h, the room cap). The client keeps both in its rejoin
  token and puts them on the URL of every later dial of that room (redial,
  reload rejoin, owed leave, `releaseRejoin`). The routing Worker verifies
  the pass with Web Crypto (constant-time HMAC verify) **before touching
  `IpGate` or any room**; only the canonical base64url spelling is a pass
  (43 characters carry 2 slack bits, so four spellings decode alike — the
  others are refused): valid and unexpired → forwarded uncharged;
  anything else (forged, expired, another code, another id, no id) → an
  unproven upgrade, charged as above. A pass waives only the *dial*: the
  socket's `join` still needs the claim's secret (the pass is not the
  claim), and a wrong claim on it is charged as a guess. It reveals
  nothing to a prober: it proves a seat in one room, which its holder
  already knows, and nobody without the key can make one. The room
  re-checks the pass *ignoring expiry* to decide whether its socket was
  dial-charged: a pass that expires between the two checks must never read
  as "uncharged" there and be refunded a dial nobody paid — the error runs
  the other way (a member loses one dial at the very edge). The key is a
  Worker secret, `ROOM_PASS_KEY` (`worker/README.md`); **without it no
  pass is issued or honoured** and members' re-dials are charged like any
  upgrade, as before passes (the Worker logs that once per isolate).
- **Hosting is capped per address, not charged as a guess**: `/room/new`
  spends one of `HOST_ROOMS` (30 per 5 min per address, never refunded) at
  the same `IpGate`, before any room is touched — `blocked` past it, `503`
  if the gate cannot answer. An IPv6 sender also spends one of
  `HOST_SITE_ROOMS` (120 per 5 min) at its **/48**'s gate
  (`ip:<prefix>::/48`, the `site` counter): a /48 holds 65 536 /64s, so
  counted by /64 alone one site could open millions of rooms per window —
  every code. IPv4 is counted per address only. It is a cap on creating objects, not a guess
  limit: a host learns nothing about any code but the one it gets, so it
  spends no dial and no guess.
- **A valid claim is never charged** (2026-11-11). A `join` whose `id` and
  secret match a live claim is checked *before* the limiter and bound
  without touching it — it proves the sender already holds the seat, so it
  guesses nothing. Before, every reconnect was charged: a LAN party or a
  carrier's CGNAT behind one address, after a few typos, re-dialling together
  after a blip, was answered `blocked`, and the client took that as final.
  Only unproven attempts (new joins, wrong secrets) are charged.
- **Where the counter lives**: every room is its own Durable Object, so a
  counter inside one only sees guesses at its own code. The counts —
  guesses, dials and hosts, one window each — live in a second Durable
  Object class, `IpGate`, one per IP (`idFromName("ip:<ip>")`,
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
  replacements cannot produce one (rejoinServer retires the socket its new
  dial replaces; a redial's predecessor had already closed), so a 4409 means
  **another tab of the same browser** reconnected with the same token. The
  displaced tab stands down — `room.detach()` closes its links with no
  `__gone` (the member id lives on in the other tab), the claim and token
  are left alone — and the party screen says "This party is open in another
  tab" with USE THIS TAB INSTEAD (a reload, which displaces the other one).
  Before 2026-11-11 the two tabs traded the seat every second, forever.
- **One ask per socket** (2026-11-12): a socket gets one `host`, `join` or
  `release`; any later one — pipelined behind the first, or after its
  seat — is `bound`, changes nothing and is never charged. The ask is
  claimed synchronously before any await, and the dial refund reads the
  *live* attachment and clears `dial` before its own await: before, six
  `join`s pipelined on one socket interleaved across the gate's await,
  each refunded the one upgrade's dial (six back for one paid), and the
  hub bound the socket under all six ids.
- **Member ids** are at most 64 characters (`bad-id`), the same cap
  `checkPass` applies, so every seat granted has a pass that verifies.
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
invite failure, socket replaced after it dropped) and after 20 s regardless, so a member who
reconnects any number of times is offered to every time. Under the glare rule
the side whose offer stands (the hard-NAT side's, else the lower id's —
below) sets the other's offer aside rather than dropping it: if its
own offer then cannot be made, it answers the set-aside one, which is the
pair's only offer left. If the offerer still holds a link to the
returning member, it is either live (a signalling hiccup — no offer needed) or
the leftover of a reload; the client re-checks every second for 12 s (the
slowest close net.js measured is a killed tab, ~11 s) and offers the moment it
closes. The offer is minted with `createInvite({ forPeer })`, so a member who
holds a seat in a full party is not refused their own seat.

**After a reload the member who stayed offers.** The reload costs the
stayer its last link, so it re-announces (below) — and until 2026-11-12 it
did so by closing its socket and re-dialling a second later. A member back
inside that gap found nobody attached; when the stayer re-attached, the
only "other" the hub could name was the returner, so *the returner* offered.
On two real networks that direction could not connect (15 of 16 guest
reloads failed, `docs/network-testing.md`). `rejoinServer` now dials first
and lets the hub's 4409 replace the retired socket, so the seat is never
unattended. That new socket keeps the offer guard for an offer the peer has
*answered* (they negotiate directly; a fresh invite would be a second link),
and clears the rest as any redial does, closing their unanswered invites:
an offer sent down a socket already dead but not yet noticed (a network
switch) was lost, and keeping its guard would stall the re-offer to the
20 s backstop (test-room 6e13). While that dial is out, an `offering`
notice arriving on the old socket is deferred until the dial lands, not acted
on: in a blackout the old socket still delivers while the new dial waits on
the network, and an offer gathered then carries host candidates only — once
answered it muted the peer's own offer and failed, and the pair never healed
(NAT lab scenario 5; test-room 6e15). Tests: test-room 6e9; NAT lab scenario 10.

**…but in practice both offer, and a hard NAT's offer stands.** On two real
networks (2026-11-12) the stayer noticed its isolation only after the
returner had re-attached: the returner's attach named the stayer, the
stayer's re-announce named the returner, so both offered and the glare rule
decided — by the lower id, a coin flip. Across a port-dependent ("hard")
carrier NAT, which connects only as the ICE offerer, half the reloads took
the failing direction and waited ~18 s for the role swap. So each client
classifies its own NAT at room start (net.js `classifyNat`: one socket, the
two STUN servers in DEFAULT_ICE on two ports, different mapped ports for
one candidate foundation + public address = hard; in parallel, never
awaited — unknown is `null` and the old rule), exposes it as `room.natHard`, and marks its offers (`h.` prefix,
outside the compressed body like `r.`; `isHardSignal` reads it
synchronously). The glare rule (`glareWinner`): if exactly one of the two
crossing offers is marked hard, it stands and the other side answers;
otherwise the lower id's. The mark weighed for our own offer is the one it
was minted with (`offeredHard`), so both ends reach the same verdict even if
classification lands mid-gather. And a hard member offered to with nothing
of its own in flight (a host reload: only the stayer is named) does not
answer: it sets the offer aside and offers back, marked — on the far side
that meets the far side's own offer in flight, and wins. Bounded: only a
hard side does it, never to a hard offer, never to the marked retry; if its
own offer cannot be made it answers the set-aside one. Two hard members
(both carrier NATs, symmetric ones) fall back to the lower id and the swap.
The mesh relay (`_openRelayed`) is unchanged — it knows nothing of NATs, so
a relayed pair in the wrong direction still waits for the swap. Tests:
test-codec (the mark), test-room 6e19 (the rule, the offer-back, a hard
guest's own offer making the link), NAT lab scenario 10 (every reload in
both directions < 6 s on the carrier's own first-try offer; 15.4 s with the
classification switched off).

*An offer set aside is answered if ours is not.* A tab still on the build
before the mark (open across a deploy: the network-first service worker
updates a page only when it reloads) cannot read an `h.`/`r.` code — its
base64 decode throws and the throw is swallowed — so it never answers ours.
Without more, a hard member that set that tab's plain offer aside (to offer
back, or as the glare winner) waited for the 20 s backstop, which dropped
theirs as well, and the join ended `no-answer` where the old build had
connected. Now, once our offer has left while theirs is set aside, ours has
`GLARE_FALLBACK_MS` (6 s, from the later of the two) to be answered; if it
is not, ours is withdrawn (`dropInvites`) and theirs answered. 6 s exceeds a
current client's answer — its gather (≤ 4 s, `ICE_TIMEOUT_MS`) plus two hops
— so between two current clients it never fires. The backstop answers a
still-held offer too (when ours was never answered) instead of dropping it.
test-room 6e8 (backstop), 6e20 (offer-back and glare winner, both linked
~6 s after ours left; an answered offer keeps the other set aside).

*The classification is asked again.* It is remembered per set of STUN
servers (a set of fewer than two answers `null` and is never remembered,
so it cannot stand in for another), and room-join re-asks it (`fresh`)
when it finds itself isolated (`rejoinServer`) and on the browser's
`online` / `navigator.connection` `change` events: a phone that left its
carrier's hard NAT for Wi-Fi would otherwise keep offering back for the
life of the page. The last verdict stands until the new one lands; the
newest ask wins. A room given `natHard` never asks. test-room 6e21.

*Per address family.* A host with an unroutable IPv6 address (bhaskara's
Tailscale `fd7a:`) answered IPv4 from both servers in 45 ms and timed out
every IPv6 request (701, ~40 s); one error flag and the 5 s cap made that
`null`. Now two ports for one base is hard at once; a family with a mapping
and no STUN error of its own is soft `NAT_SOFT_SETTLE_MS` (2 s) after its
first mapping (Chrome never reports the identical second answer, so the
settle is the evidence); an error whose `address` shows no family vetoes
every family. Only `natHard === true` changes behaviour, so soft and
unknown act alike; the cost of the settle is that a hard NAT whose second
answer is more than 2 s late reads soft (the old rule). test-room, stubbed
candidate stream.

*VERIFY — Firefox.* Grouping by foundation assumes foundation = base
(address + protocol), as Chrome and Safari compute it; Firefox has not
been checked. Its failure would only read a hard NAT as not hard — the old
lower-id rule — never the reverse, since two ports are still required
within one group.

**A pair whose first try fails is tried once with the roles swapped.** Some
NATs open only to a peer whose checks arrive first, and the ICE answerer
checks first, so for such a pair only one direction works — and no offerer
rule can know which. When a link negotiated through the room server fails
ICE (net.js `_routeFailed` → room-join `onRouteFailed`), the side that
answered offers back over the room server, once; the side that offered holds
its no-route verdict up to 8 s (`SWAP_WAIT_MS`) for that offer. The second
offer is marked on the packed code itself (an `r.` prefix, outside the
compressed body, so `isRetrySignal` reads it synchronously), so it is never
swapped again — and that mark, and only it, exempts an offer from the glare
rule: it often arrives before our own end has noticed the failure. (Until
2026-11-12 *any* offer from a member who had answered ours skipped glare;
a plain one made a second link for the pair, and each end's replace closed
the other's.) It is an ordinary relayed `offer`: no protocol change, no hub
change.

**An invite nobody will answer is closed, and never mutes a verdict.** An
invite does not expire on its own. The glue drops its own unanswered one
(net.js `dropInvites(peer)`) when the far side's glare rule will set it
aside (we are the higher id and are answering theirs), when the 20 s offer
backstop fires, and on `connected:false`. And net.js counts only a
negotiation both ends are in (`_trying`: an answer taken, or an offer we
are answering) as "still trying" — until 2026-11-12 a bare invite minted
for the peer counted too, and one left over silenced the swap and the
no-route verdict for good: the join waited out the deadline as `no-answer`.
Tests: test-room 6e11–6e14.
A direct link that is still not open 20 s after both descriptions are in (net.js `OPEN_TIMEOUT_MS`) is treated as an ICE failure — Chrome was seen leaving an answering link in `connecting` for good, which blocked the swap (test-room 6e16).
The mesh relay does the same (`_openRelayed(peer, { retry: true })`, the
higher id offering, on ICE failure or the 15 s relay expiry). Only for a
member reached through the server — a scan/paste pair has no path to swap
over, and fails as before.

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
the party answered, ICE failed, and the join rejects with net.js's own
message naming the paths tried — RETRY is offered, and a rejoin keeps its
claim. Since 2026-11-12 that is after the role-swapped second try (see "Who
offers to whom"): the first fails at ~15 s, the second would take as long
again, so the join deadline usually ends it — and a deadline that falls
after a failed first try says `no-route` with that try's message, never
"nobody answered". A swap still under way when the 30 s deadline falls gets
`SWAP_WAIT_MS` (8 s) more, once: a reload's stale-link wait (≤ 12 s), two
gathers and ICE's ~15 s verdict put the swapped try at ~31–36 s, and the
plain deadline killed it a second short. **Worst case for a join: 38 s**,
always ending in a verdict. A first try that has not failed by 30 s (no
swap yet) still ends `no-answer`; RETRY recovers it. A dial (host/join/release) that gets no reply
within 8 s, or whose `new WebSocket` throws, rejects with `"unreachable"`.
Reasons a caller can see: `unreachable | blocked | no-room | id-taken |
bad-code | full | no-answer | no-route | aborted | displaced`, each
with a neutral sentence in `err.message` (`displaced`: another tab took the
seat while this one was still joining).

**Redials.** A signalling socket that drops while the room is live is
re-dialled with the claim, backing off 1 s → 30 s. `unreachable` and
`blocked` retry (a valid claim is never charged, so `blocked` only means the
server could not check ours just then); `no-room`, `full` and `id-taken` end
signalling, and a 4409 stands the tab down (above). A deliberate leave that
finds the socket mid-redial is *owed* (before 2026-11-11 the dial landed, was
hung up without a word, and the party held the seat for 5 minutes). A
scheduled redial is cancelled and the leave is paid with a `release`, which
never binds (2026-11-12; it was a `join` then `leave`, which 4409'd a second
tab holding the seat live and then gave that tab's seat away). `busy` is
usually our own old socket the server has not seen close yet, so it is asked
again every 1.5 s, four tries in all; a seat still busy after that is another
tab's, and is left alone. A redial already *on the wire* when the leave comes
binds as any redial would, and the socket it lands with carries the `leave`.
`roomSettled()` waits for the owed leave for at most **6 s** (the last try
starts at 4.5 s, plus the 1.5 s ack) — that long only when the seat stays
busy throughout; otherwise one round trip.

## Rejoin — the design that fixes the brittleness

**Client side (`lib/room-join.js`):** on hosting or joining, write
`localStorage["neon.room"] = {code, id, secret, pass, exp}` (`pass`/`exp`
when the server issued one; a redial that lands refreshes them, but only
while the token still names this seat). On page load, if present and
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
by code, ~15–30 s), never a hang. Measured in the NAT lab:
[network-testing.md](network-testing.md).

**Losing every link re-announces.** A member whose last link closes while the
party still has people (net.js `onIsolated`) re-dials the room server with its
claim — the new socket first, the old one replaced by it (never a gap in
which the seat is unattended) — and the hub's notice makes the elected
member offer again. That is what
heals a network switch (~10.5 s) and a long blackout. Two members doing it at
once may both be told to offer; the client's glare rule keeps the hard-NAT
side's offer, else the lower id's. (An earlier design served Metered TURN credentials
from the worker; it was removed before the first deploy.)

## Client surface (`lib/room-join.js`)

- `NeonArcade.roomServerUrl` — the base URL (`https://` or `wss://`); deployed at `https://neon-arcade-room.lokeshmohanty.workers.dev`.
  Overridden by `localStorage["neon.rs"]` (a self-hosted server, a test).
  **`?rs=` is honoured only when it names a loopback server** (`localhost`,
  `127.x.x.x`, `[::1]`) — since 2026-11-11. The room server relays the SDP
  every link is made from, DTLS fingerprints included, so a server a link
  could choose could swap them and sit in the middle of every data channel.
  The STUN server has a storage-only override for the same reason,
  `localStorage["neon.stun"] = "host:port"` or two of them comma-separated
  (net.js; anything else is ignored). NEW PARTY carries no query to the new party: a stored server
  needs no carrying, and a loopback `?rs=` is a developer's own session.
- `NeonArcade.roomServerReachable()` — `GET <base>/ping` with a 2.5 s
  timeout (silent past it is unreachable); the UI shows JOIN WITH CODE only
  when true. Success cached per page; the in-page mock is always reachable.
- `NeonArcade.hostRoom(opts)` / `NeonArcade.joinRoom(code, opts)` — return
  `{ room, code }` (`hostRoom` dials `/room/new` and takes the code from
  the reply; no client draws or names one); they drive the WS handshake
  and hand over to the same
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

- `worker/hub.js` — the pure logic (`makeHub`: reservations, claims, TTL,
  relay; `signPass`/`checkPass`) with an adapter interface, no Cloudflare
  imports. **This is what makes it
  testable with zero dependencies** — the same trick as `Room` over a fake
  transport in `test-plumbing.mjs`.
- `worker/index.js` — the DO + WebSocket shell (hibernatable WebSockets), the
  `IpGate` object, and the `wrangler.toml` wiring (two SQLite-backed DO
  classes, free tier). Every handler (message, close, error, alarm) rebuilds
  the hub from storage and socket attachments (`{ip, code, dial, host,
  reservedAt, id, at}`) if the object was evicted; `at` orders a member's
  sockets so the newest is the one rebound, and a `host` socket that has
  not yet said `host` re-reserves its code from `reservedAt` — or, past
  `RESERVE_MS`, is hung up.
- `scripts/test-hub.mjs` — the hub driven directly: host/join/relay/rejoin/
  release/prune/rate-limit/TTL/eviction, including the failure paths above,
  50 concurrent guesses getting 10 lookups, the `full` relay, a valid
  claim never charged (a whole party behind one address rejoining together
  after its address ran out of guesses), a reserved code answering like a
  dead one until its socket hosts, and passes (forged, flipped, other
  code/id/key, stretched or expired, a non-canonical last character →
  false); one ask per socket (pipelined joins: one seat, the rest
  `bound`); ids over 64 → `bad-id`; a reservation lapsing at
  `RESERVE_MS`, on its draw's clock.
- `scripts/test-worker-do.mjs` — the Durable Object *shell* (`RoomSignal`,
  `IpGate`) in plain Node over a fake `state` and fake sockets, evicted by
  hand: a fresh instance over the same storage and sockets, then a message,
  a close, a new connection, an alarm and a leave each as the first thing
  the cold object sees. Also guesses across eleven rooms hitting the gate,
  an evicted gate still blocking, a half-open socket never winning a
  wake-up, a failing gate refusing unproven joins (and refunding nothing)
  while a member's rejoin never touches it, and IPv6 counted by /64.
  `/room/new`: 30 hosts from one address all open server-drawn, distinct
  codes and spend no dial or guess, the 31st is `blocked` before any object, a
  live draw is redrawn unseen, eight live draws give `503`, a reservation
  survives an eviction. A refused upgrade is the Worker's own socket
  saying `blocked`. Six `join`s pipelined on one socket: one seat, five
  `bound`, one dial refunded (and a pipelined release + join: one ask).
  An unhosted reservation lapses on the fake clock (alarm armed at the
  draw, socket 4408, code free), a late `host` is `expired`, and a
  wake-up never resurrects or re-clocks one. 120 hosts across one IPv6
  /48's /64s, then `blocked` before any object; another /48 unaffected.
  The redraw hook only under both vars, with `X-Room-Draws`. Passes: a party behind one address whose dials are
  spent re-dials on its passes (and releases), uncharged and unrefunded,
  while newcomers and pass-less re-dials get `blocked`; forged, other-code,
  other-member, stretched, id-less and expired passes are charged; an
  expired pass's join refunds nothing; a pass socket's wrong claim is still
  a guess; with no key nothing is issued or honoured. In the default
  `just test`.
- `scripts/test-worker.mjs` (`just test-worker`, not in `just test`: it needs
  wrangler) — starts `wrangler dev` itself and drives it with node sockets
  and real browser contexts: the cross-room guess limit (a second IP
  unaffected), NEW PARTY / ALL GAMES releasing the seat before navigating,
  the reconnect screen's RETRY and START A NEW PARTY after a no-answer, a
  `#c=` link into a live party asking first, a classic invite dropping an old
  token, a reconnect with the server unreachable keeping the token and
  offering RETRY, and two tabs of one browser context sharing a token (the
  displaced one stands down, says so, never re-dials; USE THIS TAB INSTEAD
  swaps them), and a leave owed mid-redial while a second tab holds the seat
  (`release` ×4, `busy` each time, never a `join`, the live tab undisturbed).
  And (section 9) a party behind one shared address whose 10 dials went on
  typos: newcomers `blocked`, a forged pass `blocked`, a newcomer's
  browser told "Too many attempts" (not "Could not reach"), the members'
  reloads land back in their seats on their passes (no RETRY), and the
  address still
  hosts — a browser and twelve more parties; a second address opens 30 and
  is refused the 31st. Runs with a fresh random `--var ROOM_PASS_KEY` per
  run. Each browser context sends its own `CF-Connecting-IP` except
  section 9's. Skips with a message if wrangler cannot start.
- `scripts/test-room.mjs` — the *client* over the in-page mock: code join,
  guest reloads (three times), host reload, grace expiry, `no-answer` on a
  code nobody answers, a rejoin nobody answers keeping its claim, two
  hostless members never resolving, a full party (member reconnects, newcomer
  hears `full`), an aborted rejoin releasing its claim, a leave during a
  scheduled or in-flight redial still releasing it, an owed leave never
  taking a twin tab's live seat (and releasing our own stale socket's after
  a retry), glare followed by a
  failed offer answering the set-aside one, the role swap (a leftover
  unanswered invite not muting it; only the marked retry skipping glare;
  the deadline waiting for a swap under way), unanswered invites closed
  (glare lost, backstop, `connected:false`), a set-aside offer answered
  when ours goes unanswered (6 s fallback, backstop), the NAT re-asked on
  isolation and network events, a re-announce keeping its
  answered offers and re-offering the rest once, a redial answered `blocked`
  retrying, two same-token rooms not fighting (the mock hangs up a replaced
  socket with 4409, as the hub does), every host dialling `/room/new` and
  getting a distinct server-drawn code, every redial / reload rejoin /
  release presenting a pass the mock finds valid (it logs each dial in
  `mock.dials`), `#c=` auto-join, fallback when unreachable. The real `test-party.mjs` (three browsers, `file://`) keeps
  passing untouched — it exercises exactly the path that must not regress.
  `test-pwa.mjs`'s precache check must keep passing: **`lib/room-join.js`
  must be added to `sw.js`'s `SHELL` and `VERSION` bumped** (see the pwa skill
  before touching `sw.js`).
- `?mockroom=1` installs an in-page mock (`window.__neonRoomMock`, private to
  `room-join.js`) so browser tests drive the code-join UI with no network, the
  same philosophy as the fake capture device in `test-scan.mjs`. It mirrors
  the hub's observable rules; it cannot *be* `hub.js`, which is an ES module,
  and module scripts do not load on `file://`.
- Deploy: `npx wrangler login` once, `wrangler secret put ROOM_PASS_KEY`
  once, then `npx wrangler deploy` in `worker/` (documented in
  `worker/README.md`). Live since 2026-11-11 at
  `https://neon-arcade-room.lokeshmohanty.workers.dev`. GitHub Pages is
  untouched.

## Honest gaps left by this design

- **Which side offers now knows one thing about the NATs** (2026-11-12,
  undeployed): a client whose own mapping is port-dependent says so on its
  offers and its offer stands (above). In the lab every reload, both
  directions, reconnects on the carrier's first-try offer in ~0.3–0.6 s.
  **Not yet measured on the real pair** (`just test-pair`, VERIFY): the
  real carrier must classify hard (it showed two srflx ports, :3478 vs
  :19302, from this machine on 2026-11-12) and the institute NAT soft.
  Still blind: a NAT that is hard in *filtering* only (classification sees
  one mapping), two hard sides, a STUN server that is silent (`null`, old
  rule), and the mesh relay — those still rely on the role swap (~18 s).
  A tab on the previous build costs a hard member ~6 s
  (`GLARE_FALLBACK_MS`) before it answers that tab's offer. Firefox's
  candidate foundations are unchecked (VERIFY; harmless if wrong).

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
- **The timing oracle: measured, then priced like a guess.** Measured on
  real Cloudflare (2026-11-11, 30 samples each, interleaved, a fresh TLS
  connection per sample): WebSocket 101 for a live code median 543 ms / p90
  681 ms, for a never-used code 727 / 878 ms; first (uncharged) reply 699 /
  772 vs 921 / 1108 ms. A one-shot midpoint classifier told them apart 93%
  of the time from the 101 alone — the never-used code's object is created
  by the request. **The latency gap remains; it is no longer worth anything
  a plain guess is not.** The argument (2026-11-12): every request that can
  reach a room object is an upgrade to `/room/<code>` or to `/room/new`
  (path variants, non-upgrades and `/ping` never reach a room; tested).
  `/room/new` names no code: the Worker draws one, a live draw is redrawn
  out of the client's sight, and the client hears only the code it got —
  a code that was dead a moment ago, which it now holds. An upgrade to
  `/room/<code>` either carries a valid member pass — which only the
  server can mint, for a seat it granted in *that* code, so its holder
  learns nothing new — or spends a dial before the room is touched. A dial
  comes back only on a successful `join` (which on a live code lets the
  sender *in* — strictly more than learning it is live) or a `release`
  (which needs the claim's secret). So a code tested and found dead costs
  exactly one unrefunded dial whether it was tested by timing or `join`,
  and an address tests at most `DIAL_FAILS` codes per 5 min — the same 10
  as the guess limit, so the oracle is never cheaper per code than
  guessing. Three holes were closed
  to make that true: `DIAL_FAILS` was 20 (twice the guess rate, by timing);
  a successful `host` refunded its dial (and its guess), so hosting at
  chosen codes scanned the dead ones for free and paid only for the live
  ones it hit — unbounded scanning, independent of the oracle (closed
  first by never refunding a host, then for good by `/room/new`: no client
  chooses a code to host); and the dial
  gate failed *open*, so an attacker who flooded their own gate object into
  errors got free upgrades, whose sockets the room then "refunded", minting
  budget. **Residuals:** a refund credits the address's *current* window,
  so it can land in a later window than its charge (never more than that
  window has charged — budget cannot be banked); the usual fixed-window 2×
  burst across a window edge; and many addresses mean many budgets, as for
  guesses. A pass holder may dial *its own* code uncharged for up to 24 h,
  even after leaving — so it can watch that one code's liveness, and if
  the room died and the server later draws the same code for a stranger's
  party, see that it is live again; it still pays a guess to join it, and
  it is one code in 900 000, never a scan. Tests: test-worker-do "Every
  upgrade spends a dial", "Only a room path with an upgrade reaches a
  room", "Hosting is /room/new" and "Members re-dial on a pass"; test-hub
  "Member passes"; test-worker sections 1 and 9; test-live `oracle`/`gate`
  (updated for `/room/new`, passes, a budget of 10 and refusals as
  `blocked` sockets, **not yet run against a deployment — VERIFY after
  the next deploy**).
- **A shared address: only its newcomers pay for its typos** (2026-11-12).
  Equal budgets (`DIAL_FAILS` = `JOIN_FAILS` = 10) used to cost a LAN party
  or a carrier-CGNAT address everything: a member's re-dial had to pass the
  dial gate before its claim could be checked, and hosts spent dials too,
  so 10 typos or hosted parties in 5 minutes meant `429` on *every* upgrade
  — members' signalling re-dials included (a reload landed on RETRY) — and
  the 11th host fell back to the classic flow. Now members re-dial on
  their passes, which the Worker checks before the gate, and hosting is
  `/room/new`, which spends no dial or guess. What is still true: what such
  an address spends — typos, joins to a party that ended, probes — is still
  a budget of 10 per 5 min, shared by everyone behind it, and when it is
  gone **a newcomer's join from that address** (someone at the party typing
  the code for the first time) is refused until the window closes; they
  see "Too many attempts" on the code screen (since 2026-11-12 — before,
  the bare `429` read "Could not reach the room server"), and the classic
  invite (or waiting out the window) still works. Members' re-dials,
  reloads, owed leaves and `releaseRejoin`, and hosting (up to
  `HOST_ROOMS`, 30 per 5 min per address), are untouched. The budgets
  stay equal on purpose: raising the dial budget for everyone would make
  the timing oracle cheaper than guessing. **Depends on the secret:** a
  deployment without `ROOM_PASS_KEY` issues no passes and members' re-dials
  are charged as before (hosting is still free); rotating the key voids
  every outstanding pass until each member's next granted seat (a
  rejoin's `joined`) brings a new one — the first re-dial after a rotation
  is charged. The pass rides the URL query, so it may appear in request
  logs; it is not the claim (the secret never leaves the message body) and
  only waives a dial to one code. Tests: test-worker-do "Members re-dial on
  a pass", test-worker section 9, test-live `gate`.
- **A leave owed mid-redial: resolved, with one residual.** It used to dial
  `join` with the claim and then `leave` — if a second tab had taken the
  seat in between, the join 4409'd that live tab and the leave gave its seat
  away. Since 2026-11-12 it is a `release` (never binds), retried on `busy`
  until 4.5 s in case the busy socket is our own old one; tests: test-room
  6e2b, test-worker section 8. **Residual:** a redial already *on the wire*
  when the leave comes binds as any redial does — if a second tab held the
  seat, that redial displaces it (the ordinary two-tab rule), and the leave
  then gives back the seat that tab's USE THIS TAB INSTEAD would reclaim
  (its re-join then goes through as a newcomer's would — not tested). And a seat still `busy`
  after the last try because the server has not noticed our own half-open
  socket is not released; its claim lapses with the 5-minute seat grace.
- **Real Cloudflare has not run three things yet — VERIFY after the next
  deploy** (2026-11-12; all green under `wrangler dev`, which is real
  workerd). (1) The **redraw**: after a `409` the Worker forwards the
  client's upgrade a second time (`new Request(url, request)` again).
  test-worker-do drives it over fakes; test-live `redraw` drives it on a
  *debug* deployment — `--var ROOM_DEBUG:1 --var ROOM_TEST_FORCE_REDRAW:1`
  makes `/room/new?draw=<live code>` force the first draw, and
  `X-Room-Draws` proves two were taken — and skips with a note
  otherwise. Neither var may be set on the real deployment (ROOM_DEBUG
  re-opens the timing oracle; the hook lets a client choose its first
  draw). (2) The **`blocked` refusal socket**: accepted in the routing
  Worker, sent one frame and closed at once — test-worker shows a browser
  reading it under `wrangler dev`; test-live `gate`/`oracle` read it on
  a deployment. (3) The **reservation alarm** firing 15 s after a draw.
- **Reservation squatting: bounded, not gone.** An address can still hold
  `HOST_ROOMS` codes for 15 s each per window (a /48 `HOST_SITE_ROOMS`),
  and *hosting* holds a code for real — up to the 24 h cap while a socket
  stays attached. A /48 opens at most 120 rooms per 5 min (~35 000 per
  day if each is kept attached all day); many /48s or many IPv4
  addresses mean many budgets. `HOST_SITE_ROOMS` = 4 × `HOST_ROOMS` is a
  judgement call (one site with several busy LANs), not a measurement.
- Symmetric-NAT pairs cannot connect (no TURN, by choice); they fail with an
  explicit error, as in the classic flow.
- The room server is one more thing that can be down. That is why the
  fallback is not a degraded mode but the existing, fully tested zero-server
  path.
