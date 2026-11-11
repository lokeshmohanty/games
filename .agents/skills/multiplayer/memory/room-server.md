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
   `{code, id, secret}` in `localStorage`. The id is the seat; the secret is
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
  host/join and refunded on success — check-then-record let N parallel
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
- **Two tabs with the same token fight.** Same localStorage = same claim. Each
  bind hangs up the other's socket with `4409`; a client that redials on
  every close takes it straight back, so the tabs traded the seat every
  second, forever (2026-11-11). A 4409 on the *current* socket can only be
  another tab — rejoinServer retires the socket it closes, and a redial's
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
  test-worker section 7. The owed leave (`oweLeave`) still binds — a
  documented gap. The mock
  closes a replaced socket with 4409 too. Tests: test-room 6e5 (mock),
  test-worker section 7 (two pages, one context).
- **A leave mid-redial is owed, not dropped.** With no open socket the
  `leave` used to be skipped and the landing redial hung up silently — seat
  held 5 min. `oweLeave` brings the redial forward and its socket carries the
  leave; roomSettled waits for it. **Except after a final refusal**
  (`gaveUp`: no-room/full/id-taken): there is no seat to give back, and the
  owed `join` was charged, held navigation ~4 s and could seat us in a party
  that re-hosted the code (test-room 6e7).
- **The offer backstop clears `glared` too.** OFFERING_MS forgot our offer
  but kept the one set aside for it; a later failed invite answered that
  stale offer (test-room 6e8, `opts.offerBackstopMs`).
- **Only storage chooses the room server.** The server relays SDP, DTLS
  fingerprints included — a link-chosen one could MITM every channel.
  `?rs=` is honoured only when it names loopback (localhost, 127/8, [::1]);
  anything else is `localStorage["neon.rs"]`. NEW PARTY carries no query.
- **The probe is `GET /ping` on the routing Worker**, never a room object
  (it was a WS ping to room 000000: one hot object for every client). The
  mock is always reachable.
- **Every upgrade spends a dial** (2026-11-11). Measured on real CF: a
  never-used code's object answers the 101 ~180 ms later than a live one's
  (93% one-shot accuracy), and a silent socket was free. The routing Worker
  now charges `IpGate` `/dial` before touching a room; the room refunds on
  the socket's first successful host/join/release (`refundDial`, once per
  socket). 20 unrefunded per 5 min, then 429. Fails *open* (a dial can't
  prove a claim; failing closed would cut members off). Test probes count:
  a node `claimOf` is a guess *and* an unrefunded dial — a live run that
  does many burns its own budget (run `gate` after a fresh window).
- **`ROOM_DEBUG` is test-only.** With it the 101 carries `X-Room-Instance`
  (proves eviction in test-live `hib`); on a real deployment it would
  re-open the oracle. Never set it there.
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
- `scripts/test-hub.mjs` — the hub rules (codes, claims, TTLs, rate limits).
- `scripts/test-worker-do.mjs` — the DO shell through simulated evictions.
- `scripts/test-room.mjs` — the client against the in-page mock.
- `scripts/test-worker.mjs` — the client against real `wrangler dev`.
