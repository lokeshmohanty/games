# STATUS — volatile state

*Update in place; keep short; absolute dates. History lives in git log.*
*Not loaded by default — `AGENTS.md` points here on demand. Keep it that way:
if this file grows past ~10KB, split the archive out rather than making every
session pay for it.*

# TODO(user added)

*Updates/tasks/queries added by the owner; process only when he says, then
act → record → clear the item. This is the single inbox — do not create a
separate `TODO.md`.*

## Current focus (2026-11-11) — multiplayer fix pass

Review of net/party/lobby/room-join + worker, then fixes (uncommitted until
Lokesh reviews). Headlines:

- **TURN removed** (Metered fetch in the worker; Lokesh: join by code "if
  possible without turn, remove it"). Code join = SDP over the room server,
  then plain STUN — identical NAT behaviour to scan/paste.
- Host could never reconnect after reload (hub named the rejoiner as its own
  offerer); a second guest reload never got an offer; code joins could hang
  with no error. `joinRoom` now resolves on first open link or rejects
  `no-answer` (~30s; also waits for a host). Verified against real `wrangler dev`, not deployed CF.
- Claim release on deliberate leave; per-IP rate limit (was one shared
  bucket); hub rebuilt after hibernation; reachability probe is `GET /ping`
  on the routing Worker (was a WS `ping` to one hot room object).
- Review fixes (2026-11-11): `release` op so START A NEW PARTY never knocks
  a live tab off its seat (`busy` → "open in another tab", nothing started);
  `?rs=` honoured only for a loopback server (else storage `neon.rs`) —
  a link-chosen server could swap DTLS fingerprints; no owed leave after a
  final redial failure; the offer backstop drops a set-aside glare offer.
- net.js: `party.term` reconciles two hosts; leave() broadcasts `__gone`,
  clears suspect timers, closes late links; relayed offers time out; public
  `room.heir()`; `claimHost`/`getPeers` removed; 3s `disconnected` grace
  (re-crown after a closed host tab ~11s, was ~8s — set
  `DISCONNECT_GRACE_MS` to 0 to revert).
- party/lobby: leave buttons really leave, RETRY on network errors, QR for
  the party code, invite/reply panel + helpers deduplicated into lobby.js.
- **NAT lab** (`just test-nat`, docs/network-testing.md): namespace NAT routers
  + real Chrome + real `wrangler dev`, 8 scenarios green. Found and fixed: a
  no-path join said "nobody answered" at 30s (now `no-route` at ~15s); network
  switch healed only after 40s+ with two hosts; a blackout just longer than
  the link's patience never healed (isolated member now re-announces to the
  room server; glare rule); hostNewGame dropped `?rs=` (since moot: the lab
  sets `neon.rs` in storage, and NEW PARTY carries no query).

Open:

- [x] Brute-forcing different codes: per-IP `IpGate` Durable Object, charged
      before every host/join (2026-11-11; tested in test-worker-do and under
      wrangler dev in test-worker).
- [x] `full` is its own relayed message (`{t:"full", to}`), not `sdp:"full"`.
- [x] Leaves are acknowledged before navigation (`roomSettled()`); a reload
      with a token reconnects (RETRY) even when the server is unreachable.
- [x] Review follow-ups (2026-11-11): valid claims never charged (LAN/CGNAT
      parties were getting `blocked` for good); gate errors fail closed;
      IPv6 limited by /64; same-token tabs no longer fight (4409 → the
      displaced tab stands down, "open in another tab"); a leave mid-redial
      is owed and paid; `?stun=` removed (storage-only `neon.stun`); glare +
      failed offer answers the set-aside offer.
- [x] Hibernation/eviction on real Cloudflare (2026-11-11, a
      `wrangler deploy --temporary` preview deployment, `just test-live`):
      eviction proven by instance id; relay, close notice, held claim, guest
      and host reload rejoin, and the 15-min alarm all held. Flows (join,
      reloads, RETRY, two tabs/4409/busy, leave, full at 8) and the IpGate
      on real CF-Connecting-IP green too.
- [x] Timing oracle: measured live (101 live 543 ms vs never-used 727 ms
      median, 93% one-shot) → every upgrade now spends a refundable *dial*
      at IpGate, 429 past 20 unrefunded/5 min (live-verified: 20 probes,
      then 429). Latency gap remains; its price is now a guess's.
- [x] **Permanent deploy** (2026-11-12): https://neon-arcade-room.lokeshmohanty.workers.dev
      (`preview_urls = false`), wired into `roomServerUrl`. Live suite
      green there over IPv4 and IPv6 (flows; hib post-idle; gate run
      alone). IPv4 is *not* challenged on this account.
- [ ] Real cross-network *success* (two different public addresses, real
      phones/carriers) untested: `just test-nat-live` (slirp4netns) works,
      but from one public IP behind a non-hairpinning CGNAT every pair is an
      explicit no-route — see docs/network-testing.md live mode.

## Previous focus (2026-10-18)

The room server shipped. A Cloudflare Worker + Durable Object (`worker/`) now
handles rendezvous: join by six-digit code, rejoin after reload (TURN was
served alongside until 2026-11-11). All game data still flows peer-to-peer; the room
server sees only SDP offers/answers. Progressive enhancement throughout —
when it is unreachable, the classic scan/paste flow is offered unchanged.

Shipped this session:

- `worker/hub.js` — pure room-hub logic (codes, claims, TTLs, rate limits),
  imported by `worker/index.js`'s Durable Object shell.
- `lib/room-join.js` — client glue: `hostRoom`, `joinRoom`, rejoin tokens,
  reachability probe, `makeMockRoomServer` for tests.
- `lib/net.js` — `reconnectGraceMs`, `onLeave` hook, `serverPeerState`
  advisory, `_vacateCrown` extraction, `rs`-flag support.
- `lib/party.js` — joinCodeFlow, reconnectFlow, party-code display in the
  roster.
- `lib/lobby.js` — joinCodeFlow with `#c=` hash routing.
- `scripts/test-hub.mjs` + `scripts/test-room.mjs` — hub rules tested without
  a deploy; client tested against the in-page mock with real WebRTC.

Two bugs the room tests caught and fixed:

- `from` was undefined in the mock's offer/answer relay (the guest's answer
  went nowhere). Fixed by reverse-looking-up the sender's ws.
- `rs` was never set on members, so `_confirmGone`/`serverPeerState` never
  held a seat for the reconnect grace. Fixed in the wire's `onPeerJoin`.

One design decision recorded in the multiplayer skill memory: **the mesh is
authoritative**; the room server's peer-state notices are advisory and are
outranked by any live link.

Remaining for deploy (see `worker/README.md`):

- [x] Deployed 2026-11-11: `https://neon-arcade-room.lokeshmohanty.workers.dev`, wired into
      `lib/room-join.js`'s `NeonArcade.roomServerUrl` (it held a dead
      placeholder, `games-party.workers.dev`, before). (A self-hosted server is set per browser with
      `localStorage["neon.rs"]`; `?rs=` is honoured only for loopback.)

## Previous focus (2026-08-27)

Plumbing first, then a deep game, then a casual one — in that order, mobile
first throughout.

Shipped this session:

**Plumbing.**
- `lib/secrets.js` — sealed private channels and commit-reveal. The problem it
  solves is specific: an addressed `send({ target })` is relayed through another
  *player's* browser whenever a pair cannot connect directly, which with no TURN
  server is routine. Keys are ECDH on the party record (it already replicates to
  late joiners), payloads are AES-GCM with the channel, sender and recipient
  authenticated. Commitments hash a **canonical** serialisation, because
  `JSON.stringify` key order is not stable across a round trip.
- `lib/rounds.js` — the round/phase clock Draw & Guess had written by hand, plus
  the two things it lacked: a `collect` phase that ends when everyone has
  submitted (simultaneous turns, which suit this transport better than anything
  else), and `botSubmit` so a collecting phase is not held open by a seat with
  no browser behind it. Durations on the wire, never timestamps.
- `lib/ui.js` — the stage/HUD/overlay chrome four games had each rebuilt.
  Factory functions over plain DOM. `setHud` updates text nodes in place.
- `room.setMeta()` in `net.js`, refusing the fields the party record owns.
- `scripts/test-plumbing.mjs` (31 checks) drives **real `Room` routing over a
  fake transport**, which is the only way to read the wire and prove the relay
  carries ciphertext.

**Onitama** (`games/onitama.js`, `onitama.html`) — the deep one. Rules and the
alpha-beta search live *outside* `mount`, as `NeonArcade.onitamaRules`, so
`scripts/test-onitama.mjs` plays whole games with no document. Iterative
deepening under a 500ms budget. Beats random play 20/20.

**Light Cycles** (`games/light-cycles.js`, `light-cycles.html`) — the casual
one. Grid on a fixed tick, so eight players cost a few dozen bytes per tick and
peers accumulate the trail from head positions. Bot scores **territory**
(Voronoi), not just open space. Beats a never-crash rider 30/30.

**SolidJS was re-weighed and re-rejected** (asked again 2026-08-27). Reactive
surface is ~20% of the code; JSX needs a compiler emitting ESM, which browsers
refuse over `file://`. `lib/ui.js` is the counter-offer from the 2026-08-10
analysis, finally built.

**Battleship** (`games/battleship.js`, `battleship.html`) — the game the
plumbing existed for, built next because two of the three top Next actions said
nothing used it yet. Nobody holds anybody's fleet, not even the host: you commit
to yours, answer hit-or-miss for your own board, and open the commitment at the
end. **Verifying the digest is not enough** — it proves only *when* the fleet was
fixed, so the reveal also replays every answer against it, and refuses a
revealed fleet that is not legal. `test-battleship.mjs` tests the audit by
breaking it four ways. Both players fire in the same round (`rounds.js` with
`collect: true`) rather than taking turns, which is the shape that suits this
transport: nobody waits on a turn order.

**Liar's Dice** (`games/liars-dice.js`) — and a correction. It was meant to be
the sealed channel's first user: host deals five dice to each player, privately.
**That build is wrong.** `secrets.channel()` seals against the *peers relaying*
a message, never against the sender — a host that deals is a host that has read
every cup, and the host is a player. So it does what Battleship does: each
player rolls their own dice and commits before a bid. The generalisation:
commit-reveal is the answer whenever players can generate their own secret; the
sealed channel only earns its place with a **shared deck** dealt without
replacement, which is still unbuilt.

**Draw & Guess moved onto `lib/rounds.js`** — the game the scheduler was
generalised *from*, which is what makes it the proof. A `phase` string, a chain
of `setTimeout`s and a re-check in every callback became one declaration; the
re-check is gone because a disposed scheduler fires nothing. `timeLeft` stopped
being broadcast — each peer counts down from the duration the host sent, and
`test-party.mjs` asserts three peers agree to within a second.

`rounds.next()` was added for both: a phase that ends on a game event rather
than a clock (a called bluff; everyone guessing right).

**Oh Hell removed** (2026-08-27, at Lokesh's call). It was the sealed channel's
only user and it worked, but sealing cannot protect a hand from the *dealer* —
the host deals and the host is a player — and no commitment fixes that, because
the host chooses the shuffle it would commit to. Mental poker is the honest fix
and is not built. So `secrets.channel()` is back to having **no user**, which
the docs now say plainly rather than leaving the module looking load-bearing.

**Undercover** (`games/undercover.js`) — and with it a new category: games
played **on one device**, passed round a table. `local: true` in the
registration is the whole of it. `checkRoster` stops enforcing seats (a local
game's players are names typed into one phone, not rows in the party record) and
`lib/lobby.js` offers a plain START instead of INVITE / PLAY A BOT.

This is the answer to the cost the whole project is organised around: a
handshake is paid once per person, and for six people at one table that is five
handshakes to play a game nobody needed a second screen for.

Two traps found building it, both of which read as a sulky game rather than a
bug:
- **A table must survive one wrong vote** (`n >= 2*others + 2`). Five players
  with one undercover *and* a blank does not — three against two, over on the
  first wrong guess, before anybody had spoken twice.
- **No word may appear in two word-pairs**, or a returning player can rule out
  the other half. The test caught "Violin" in two.

**The portal was rebuilt for phones.** It showed *one card at a time*: a 300px
minimum column at 80% width is one column at 390px, and a 200px image plus a
heading plus a paragraph plus a button is taller than the screen. Now two
columns, artwork on a ratio, blurb dropped below 560px, and the header halved —
**four whole cards from the top of the page**, asserted in `test-pwa.mjs`.

Along the way: `.game-card p` outranks a bare `.game-meta`, so every rule
written for the meta line had been silently ignored since it was added. Scoped
now, and the test checks the computed size rather than trusting the stylesheet.

**Filter chips** on `data-tags`, one at a time: alone · duel · party ·
one-phone · strategy · quick. A new game should be given whichever apply.

All eleven suites pass (457 checks): codec, party, scan, pwa, bots, plumbing,
onitama, light-cycles, battleship, liars-dice, undercover.

## Next actions

- [ ] **More one-device party games.** `local: true` makes them cheap now, and
      the category is the one the arcade was missing. Candidates, roughly in
      order of how different they are from Undercover: a **hot-potato word
      game** (a letter combo and a timer that goes off when it likes — frantic
      rather than deductive), **charades/fishbowl** (teams, a timer, words
      everyone types in first), and a **werewolf narrator** (deal roles by
      passing, then the phone runs night and day).
- [ ] `secrets.channel()` has no user again. Leave it — it is proven, it is
      small, and the next game that genuinely needs a dealer nobody has to trust
      will need **mental poker** underneath it anyway (commutative encryption
      over BigInt, no dependency), not just a sealed pipe.
- [x] `scripts/test-party.mjs`'s host-succession section flaked once in five
      runs on 2026-08-27 (timed out waiting for the crown to be offered after
      the host's page closed). Fixed by making succession automatic: the heir
      takes the crown the moment it vacates, with no offer/button, so the test
      no longer waits on a UI action.
- [ ] Draw & Guess's word is sent to the drawer addressed, not sealed — a
      relaying player can read it. Fine for a party game; worth a line in the
      game if anyone ever cares.
- [ ] Light Cycles' bot may be too strong to be fun (30/30 against a
      never-crash baseline). There is no difficulty concept anywhere in the
      arcade; if one is wanted, decide it once and apply it to all six.
- [ ] Onitama's per-card first-player stamps are ours, not the published deck.
      Marked `VERIFY` in the source — correct them against a real box.
- [ ] `lib/rounds.js` does not survive host succession. Neither does any game,
      but this one is new and it is written down now.
- [ ] Retrofit the other four games onto `lib/ui.js`. Deferred deliberately:
      they are tested and working, and the shell was proven on the two new games
      first.
- [ ] Verify on real phones — scanning and installing are both still only
      tested against headless Chrome. iOS is wholly unverified: no install
      event, manifest icons ignored, its own service-worker eviction rules.
- [ ] **The Firefox hints have never been seen in Firefox.** They are reasoned
      from the platform. Open the portal in Firefox desktop and Android once.
- [ ] No test forces a pair to fail, so the two-hop relay path is unexercised;
      the 8-player cap is likewise untested.
- [ ] `sw.js`'s `VERSION` is bumped by hand. Harmless while online (code is
      network-first), but the offline copy goes stale if it is forgotten.
