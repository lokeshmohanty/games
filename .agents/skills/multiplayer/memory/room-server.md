# The room server is optional and the mesh is authoritative

*Established 2026-10-18, when the join-by-code layer shipped.*

## The decision

The room server is a **rendezvous point, not a relay**. It sees SDP offers and
answers — never game data, never party state. The mesh stays authoritative for
membership and game play; the room server's peer-state notices are advisory,
and a live link always outranks them. This is why `serverPeerState` and the
`_confirmGone` reconnect path both check for a live link before marking.

Progressive enhancement is non-negotiable: when the room server is unreachable,
the classic scan/paste flow is offered unchanged. The same errors surface, the
same UI paths run, and no game or test notices its absence.

## The two invariants the client enforces

1. **The rejoin token is the only thing that survives a reload.** It holds
   `{code, id, secret, pass, exp}` in `localStorage` (`pass`/`exp`: the
   member pass, when the server issued one). The id is the seat; the secret is
   the claim on it. Everything else — the WebSocket, the data channels, the
   party record — is rebuilt from scratch on every page load.

2. **`serverPeerState` marks, `_linkOpened` clears.** A reconnecting mark is
   advisory and cheap to set; a live link clears it. The grace timer that
   drops a seat after `reconnectGraceMs` runs through `_confirmGone`, which
   checks `member.rs` — set by the wire's `onPeerJoin` when a member joins
   through the room server's offer path.

## Traps

- **A test page's mock room server is per-page.** Two pages on the same origin
  do not share a mock; each has its own rooms. A test that wants a guest to
  join a host's room must either use the same page (via `evaluate`) or accept
  that cross-page testing needs a real deploy.
- **`localStorage` is shared across tabs in a test context.** A host's rejoin
  token written in one `evaluate` leaks into the next. Tests must clear it
  before a fresh join, or the guest adopts the host's id and the room ends up
  with one member.
- **The `rs` flag on a member is set by the wire's `onPeerJoin`**, not by the
  join message. It marks "this member's offer came through the room server."
  Without it, `_confirmGone` drops them immediately instead of holding the
  seat for the reconnect grace. Only the *host* runs `_confirmGone`, so a
  non-host that sets it reports it with `__i {id, rs:true}` (fixed 2026-11-11;
  before that the next `__p` wiped it and the host never held the seat).
- **The offerer is never the member the notice is about.** Found 2026-11-11:
  `announce` ranked the rejoiner itself, so a reloading *oldest* member (the
  host) named itself offerer and nobody ever offered. Rank everyone attached
  *except* the subject. The same trap killed a second reload: an "already
  offered" guard cleared only on a *new* member, so test two reloads, not one.
- **"Joined" is not "connected".** `joinRoom` resolves only when the first data
  channel opens, else rejects `no-answer` (~30s); it also waits for a *host*, since two hostless members can link and look "connected". A rejoin that gets no answer keeps its claim (RETRY), and START A NEW PARTY releases it via `releaseRejoin()`. A claim outlives its party
  (deleted parties, bot-full parties), so the server's `joined` proves nothing.
- **A deliberate leave releases the claim** (`{t:"leave", id, secret}` from
  `onLeave(reason)`); a reload never calls `leave()`, so the seat holds. Test
  reloads by closing links + `mock.drop(id)`, never by `leave()`.
- **Guess limits must span rooms.** Each code is its own Durable Object, so
  a counter in the hub only ever saw guesses at its own code (2026-11-11).
  The count lives in `IpGate` (one DO per IP), charged *before* each
  join and refunded on success — check-then-record let N parallel
  sockets get N guesses. `taken` and `full` count: both say a code is live.
  IPv6 counts by /64. A gate that errors **fails closed** (`blocked`); a
  local fallback let anyone who could overload the gate turn the limit off.
- **A valid claim must never be charged.** Found 2026-11-11 (review): every
  reconnect was charged, and a party behind one address (LAN, carrier CGNAT)
  that had made a few typos and then re-dialled together after a blip got
  `blocked` — which the client treated as final, killing signalling for
  real members. The hub now verifies `id`+secret *before* the limiter
  (`claimed` in hub.js) and binds without charging; only unproven attempts
  pay. The client retries `blocked` on a redial with the backoff, as it does
  `unreachable`. Test shape: test-hub "A valid claim is never charged".
  **The same holds at the upgrade** (2026-11-12): the claim rides the
  socket, so the dial gate could not see it, and with equal budgets a
  LAN/CGNAT address that typo'd 10 codes 429'd its members' re-dials. Every
  seat granted (`room`/`joined`) carries a **member pass**,
  `HMAC-SHA256(ROOM_PASS_KEY, "code.id.exp")`, which the client stores in
  the token and puts on every re-dial's URL (`?id=&exp=&pass=`: redial,
  reload rejoin, owed leave, releaseRejoin); the routing Worker verifies it
  *before* IpGate and forwards uncharged. A pass waives the dial only —
  the join still needs the secret, and a wrong claim on a pass socket is a
  guess. Test shape: test-worker-do "Members re-dial on a pass", test-worker
  section 9 (two browsers on one `CF-Connecting-IP`, 10 typos, reloads).
- **Two tabs with the same token fight.** Same localStorage = same claim. Each
  bind hangs up the other's socket with `4409`; a client that redials on
  every close takes it straight back, so the tabs traded the seat every
  second, forever (2026-11-11). A 4409 on the *current* socket can only be
  another tab — rejoinServer retires the socket its dial replaces (since
  2026-11-12 it dials *before* hanging up, so the seat is never unattended
  — see [[cross-network]]), and a redial's
  predecessor is already closed — so the client stands down: `room.detach()`
  (links closed with no `__gone`, since the id lives on in the other tab),
  claim and token untouched, party screen "open in another tab" + USE THIS
  TAB INSTEAD. Never `leave()` there, and never START A NEW PARTY from the
  displaced screen. **Nor from a stale tab's RETRY screen** (found
  2026-11-11, review): `releaseRejoin` used to dial `join` with the shared
  claim and `leave` — the join bound the seat and 4409'd the *live* tab,
  then the leave gave its seat away (ghost seat 5 min, crown stuck, USE
  THIS TAB reloaded into a new party). Never release a claim with `join`:
  `releaseRejoin` sends `{t:"release", code, id, secret}` (hub
  `releaseClaim`), which checks without binding and answers `busy` for a
  seat with a live socket; on `busy` the token is kept and startFresh shows
  the displaced screen instead of hosting (a new party would overwrite the
  shared token). Tests: test-hub "A claim released from a socket…",
  test-worker-do "released without binding", test-room 6e6 + the screens,
  test-worker section 7. The owed leave (`oweLeave`) is a `release` too
  since 2026-11-12 (see below). The mock
  closes a replaced socket with 4409 too. Tests: test-room 6e5 (mock),
  test-worker section 7 (two pages, one context).
- **A leave mid-redial is owed, not dropped.** With no open socket the
  `leave` used to be skipped and the landing redial hung up silently — seat
  held 5 min. `oweLeave` cancels a scheduled redial and pays with
  `release` (`releaseOwed`), never `join`+`leave` — that 4409'd a twin tab
  holding the seat and gave its seat away (2026-11-12). `busy` is retried
  (1.5 s apart, 4 tries) because it is usually *our own* old socket the
  server has not seen close; still busy = another tab's, left alone.
  roomSettled waits ≤ 6 s (OWED_LEAVE_MS). Only a join already on the wire
  still lands and carries a `leave` (it bound anyway). Tests: test-room
  6e2/6e2b, test-worker section 8 (closing the tab's RTCPeerConnections
  too — with its mesh link alive the host never offers to the twin). **Except after a final refusal**
  (`gaveUp`: no-room/full/id-taken): there is no seat to give back, and the
  owed `join` was charged, held navigation ~4 s and could seat us in a party
  that re-hosted the code (test-room 6e7).
- **The offer backstop clears `glared` too.** OFFERING_MS forgot our offer
  but kept the one set aside for it; a later failed invite answered that
  stale offer (test-room 6e8, `opts.offerBackstopMs`). Since 2026-11-12 it
  answers that offer *at* the backstop (if ours was never answered) and
  keeps nothing — normally `GLARE_FALLBACK_MS` (6 s) has answered it
  already (`opts.glareFallbackMs`; see [[cross-network]], rollout trap).
- **Unanswered invites must not mute verdicts** (2026-11-12, review). An
  invite never expires on its own, and net.js `_trying` counted any invite
  minted `forPeer` as a negotiation under way — so one left over (a glare
  loser's set-aside offer, an offer whose answer never came) silenced the
  role swap *and* the no-route verdict for good; the join ended `no-answer`
  at 30 s instead of connecting. `_trying` now counts only links with a
  `peerId` (an answer taken, or an offer we are answering), and the glue
  closes its own unanswered invite (`room.dropInvites(peer)`) when it loses
  glare (higher id answering theirs), at the OFFERING_MS backstop and on
  `connected:false`. A `createInvite` dropped mid-gather rejects
  `withdrawn`, and the glue's catch leaves the guards alone for it. Test
  shape: a bare `createInvite({forPeer})` on the guest before a join whose
  first offer is broken (test-room 6e11).
- **Glare bypass only for the marked retry.** The swap's offer skips the
  glare rule because it often arrives before our own failure; an earlier
  version skipped it for *any* offer from a member who had answered ours,
  so a plain re-announce offer made two links per pair and the opposite-
  order `prev.close()` killed both. The mark rides the code (`r.` prefix,
  `isRetrySignal`, synchronous — an `await unpackSignal` in the message
  handler would let the next message overtake it). test-room 6e12.
- **A replacing socket keeps only *answered* offer guards.** `wire()`
  clears `inflight`/`glared` because a socket that *dropped* left a server
  that forgot us. rejoinServer's dial replaces a socket still open (the hub
  binds without a gap), but "still open" may be dead-and-unnoticed (a
  network switch): an offer sent down it was lost, and keeping its guard
  would stall the re-offer to the 20 s backstop. Rule:
  `attempt({ replacing: true })` → `wire(ws, { replacing })` keeps a guard
  only if the peer answered (`answered`, set on their `answer`); the rest
  are cleared and their unanswered invites dropped, so the re-offer is the
  only one (test-room 6e13).
- **The join deadline waits once for a swap.** 30 s, plus SWAP_WAIT_MS
  (8 s) once if a swap is under way when it falls: a reload's stale-link
  wait + gathers + ICE's ~15 s put the swap at ~31–36 s. Worst case 38 s,
  always a verdict (test-room 6e14).
- **Only storage chooses the room server.** The server relays SDP, DTLS
  fingerprints included — a link-chosen one could MITM every channel.
  `?rs=` is honoured only when it names loopback (localhost, 127/8, [::1]);
  anything else is `localStorage["neon.rs"]`. NEW PARTY carries no query.
- **The probe is `GET /ping` on the routing Worker**, never a room object
  (it was a WS ping to room 000000: one hot object for every client). The
  mock is always reachable.
- **Every unproven upgrade spends a dial** (2026-11-11). Measured on real
  CF: a never-used code's object answers the 101 ~180 ms later than a live
  one's (93% one-shot accuracy), and a silent socket was free. The routing
  Worker charges `IpGate` `/dial` before touching a room unless the URL
  carries a valid member pass; the room refunds on the socket's first
  successful **join/release** (`refundDial`, once per socket).
  `DIAL_FAILS` **= `JOIN_FAILS`** (10): every dead code tested costs one
  dial however it is asked, so the oracle is never cheaper than a guess —
  at 20 it doubled the search rate. **Keep them equal**: the shared-address
  cost is solved by passes and `/room/new`, never by raising the dial
  budget. Fails **closed** (503): failing open gave an attacker who flooded
  their own gate free upgrades, which the room then "refunded" (minting
  budget). **The room must re-check a pass ignoring expiry** to set the
  attachment's `dial`: if it honoured expiry, a pass that expired between
  the Worker's check and the room's would read "charged" and its join
  would refund a dial nobody paid. Test probes count: a node `claimOf` is
  a guess *and* an unrefunded dial. test-worker still gives each context
  its own `CF-Connecting-IP` (`extraHTTPHeaders` + a `**/ping` route so
  Playwright answers the CORS preflight that header causes), except
  section 9, which shares one on purpose.
- **No client chooses a code to host** (2026-11-12). A client-drawn host
  code made success mean "that code was dead": refunded, it was a free
  scan; charged (dial + guess), a LAN party that hosted ten times blocked
  itself. Hosting is `wss://…/room/new`: the Worker draws, forwards the
  upgrade as `new Request("…/room/<code>/new", request)` (only the Worker
  can make that path; from outside it is 404), and the object either
  *reserves* the code for the socket (create-if-free) or answers 409 and
  the Worker redraws. A reserved room is `pending` in the hub: `join` and
  `release` answer `no-room` there as on a dead code, it is never
  persisted, the socket closing frees it, and a wake-up re-reserves from
  the attachment (`host: true`, no `id`) — see "reservations must
  expire" below. `host` on a plain room socket is `bad-code`. Its only
  limits are `HOST_ROOMS` (30 / 5 min / address) and, for IPv6, also
  `HOST_SITE_ROOMS` (120 / 5 min / **/48**) at the gate — no dial, no
  guess. Per /64 alone, one /48 (65 536 /64s) could hold every code. The mock does the same (`/room/new`, and
  `mock.dials` logs each dial's pass as valid/invalid/none).
- **`ROOM_PASS_KEY` is a deploy-time secret** (`wrangler secret put`,
  worker/README.md). Unset, the worker issues no passes and charges
  members' re-dials as before (logged once). Tests never use a shared key:
  test-worker and test-nat pass `--var ROOM_PASS_KEY:<random>` per run,
  test-worker-do/test-hub make their own. Never commit `worker/.dev.vars`.
- **`ROOM_DEBUG` is test-only.** With it the 101 carries `X-Room-Instance`
  (proves eviction in test-live `hib`) and a `/room/new` 101 `X-Room-Draws`;
  on a real deployment it would re-open the oracle. Never set it there.
  `ROOM_TEST_FORCE_REDRAW` (honoured only *with* ROOM_DEBUG) lets
  `/room/new?draw=<code>` choose the first draw — test-live `redraw`
  forces a live one to exercise the 409 re-forward on real CF. Never set
  it there either: it lets a client pick a code.
- **Pipelined messages vs attachment reads** (2026-11-12, review). A
  client may send many frames before the first is answered; each
  `webSocketMessage` runs concurrently and interleaves at every `await`
  (`this.hub()`, sha256, the gate). An attachment read on entry is stale
  by the time it is used: `refundDial` trusted that copy, so six pipelined
  `join`s each saw `dial: true` and refunded six dials for one upgrade,
  and the hub bound the socket under all six ids. Rule: **check-and-set
  shared per-socket state synchronously, before any await** — refundDial
  re-reads the live attachment and clears `dial` in the same tick; the hub
  claims the socket's one ask (`asked`, host/join/release) at entry, and
  any second ask is `bound` (no close, no charge). Test shape: pipeline
  with `Promise.all` on one socket (test-worker-do "One upgrade, one ask,
  one refund", test-hub "One ask per socket"); sequential sends never
  find it.
- **Reservations must expire** (2026-11-12, review). A `/room/new` socket
  that never says `host` held its code as long as it stayed open, and a
  wake-up re-reserved it with a *fresh* clock — squatting, bounded only by
  HOST_ROOMS sockets per window. Now the attachment carries `reservedAt`,
  the reservation arms the alarm (`persist` arms it even with nothing to
  store), the sweep hangs a reservation up after `RESERVE_MS` (15 s,
  `4408 unhosted`), a late `host` is `expired`, and a wake-up re-reserves
  only inside the 15 s and on the original clock (`hub.reserve(ws, code,
  reservedAt)`); a lapsed or `reservedAt`-less one is closed. Anything a
  wake-up rebuilds from an attachment must keep its original clock.
- **A refused upgrade is a socket, not a status** (2026-11-12). A browser
  WebSocket never sees the HTTP status, so a 429 read as "Could not reach
  the room server". Past a dial/host budget the routing Worker accepts a
  `WebSocketPair` of its *own* (never a room's: the probe invariant), sends
  `{t:"error", reason:"blocked"}` and closes 4429. Tests that want "was it
  refused" read that frame (test-worker `upgradeStatus` sends a `leave`:
  a room closes 1000 silently, a refusal says `blocked`; test-live `dial`
  waits briefly for a first frame). 503 (gate down, draws exhausted) stays
  an HTTP refusal.
- **Passes are canonical base64url only.** 43 characters carry 258 bits
  for a 256-bit MAC: four last characters decode alike. `checkPass`
  re-encodes and compares. Member ids are capped at 64 (`bad-id` at
  attach) — the cap `checkPass` applies, so every issued pass verifies.
- **Navigate only after `roomSettled()`.** A `leave` is acknowledged by the
  server closing the socket; anything that navigates after a leave awaits
  it (capped 1.5 s). Never seen lost over loopback, so it is a guarantee,
  not a measured fix.
- **A token at boot means reconnect, probe or not.** Probing first sent an
  unreachable-server reload into a silent new party; now it is RETRY.
- **Cross-page tests need the real worker**: `scripts/test-worker.mjs`
  starts `wrangler dev` itself; `wrangler dev` passes a client's own
  `CF-Connecting-IP` through, which is how it tests two IPs. Point pages at
  it with `localStorage["neon.rs"]` (init script), not `?rs=` — NEW PARTY
  navigates to `party.html?fresh=1` and drops the query (test-nat does the
  same: its 198.51.100.1 server could not be a `?rs=` anyway). The STUN
  override is storage-only on purpose (`neon.stun`, plain host:port): as a
  `?stun=` param a stranger's link could pick a forging STUN server.
- **No TURN** (reaffirmed 2026-11-11; a Metered fetch had slipped into the
  worker and was removed). The room server only exchanges SDP.
- **Verify against the real worker locally:** `nix shell nixpkgs#wrangler -c
  wrangler dev --port 8787` in `worker/`, then `?rs=http://127.0.0.1:8787` (loopback, so a link may name it)
  with separate browser contexts and real `page.reload()`. Hibernation is not
  exercised by `wrangler dev`; `scripts/test-worker-do.mjs` evicts by hand
  over a fake `state` instead — and `just test-live <url>` against a real
  deployment (2026-11-11, temporary account: eviction, relay, close, rejoin
  and the 15-min alarm all held). Cloudflare challenged this host's IPv4
  (403 `cf-mitigated: challenge`) and not its IPv6: test from IPv6
  (`LIVE_FAMILY=6`) and VERIFY on the permanent deployment.

## Files

- `lib/room-join.js` — client glue: `hostRoom`, `joinRoom`, `rejoinToken`,
  `roomServerReachable`, and an internal mock (`?mockroom=1`) for tests.
- `worker/` — the Cloudflare Worker + Durable Object. `hub.js` is the pure
  logic; `index.js` is the DO shell. `wrangler.toml` is the deploy config.
- `scripts/test-hub.mjs` — the hub rules (reservations, claims, TTLs, rate
  limits, passes).
- `scripts/test-worker-do.mjs` — the DO shell through simulated evictions.
- `scripts/test-room.mjs` — the client against the in-page mock.
- `scripts/test-worker.mjs` — the client against real `wrangler dev`.

**`released:true` (2026-11-13):** the one membership fact the server may
state, because only the owner can cause it (leave/release take the secret).
net.js `serverReleased` drops the seat unless a live link says they are here.
Needed because a browser moving on from a long-closed tab has no `__gone` to
send. The party boot releases a held token before `?fresh=1` / `#c=` / `#i=`
(busy → "open in another tab"); `#c=` to the token's own code reconnects.
Deploy-dependent: until the worker is redeployed, production still holds
such seats for the grace. Test trap: "This party is open in another tab."
renders twice (sub + status) — a strict locator needs `.first()`.

**Perf pass (2026-11-13):** party `render()` returns early while hidden
behind a game — so anything that tests the roster mid-game must pull it up
with PARTY first (the AWAY check had to). A Link more than 8 MB behind is
dropped (`overflowed` ignores further posts); with three members the pair
then relay, by design — net.js does not re-link a dropped direct link between
present members (relay-only is a "legitimate steady state"). With two
members and no room server there is no path at all.
