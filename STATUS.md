# STATUS — volatile state

*Update in place; keep short; absolute dates. History lives in git log.*
*Not loaded by default — `AGENTS.md` points here on demand. Keep it that way:
if this file grows past ~10KB, split the archive out rather than making every
session pay for it.*

# TODO(user added)

*Updates/tasks/queries added by the owner; process only when he says, then
act → record → clear the item. This is the single inbox — do not create a
separate `TODO.md`.*

## Themes, search, contributors, PR-only pins (2026-11-13) — live (9f3c0bd)

Built and green (every `just test` suite + accounts + social): lib/theme.css
+ theme.js (Paper default from lokeshmohanty.github.io, Neon; fonts
self-hosted; frames follow; check-colours lint), two-choice game pages
(PLAY WITH BOTS / PLAY WITH FRIENDS, code only for friends), portal search
(author: type: tag: players: from:), lib/nav.js (GitHub + Add your game top
left, tabs), contribute.html (CONTRIBUTING.md rendered), contributors.html
(contributor.json), registry-bump.yml (pins move only by PR; trusted owners
auto-merged). arcade-games branch `themes`: palette + contributor.json.
Published 2026-11-13: games main 9f3c0bd (site deployed, checked live in
both themes), arcade-games main 4ae4d37. The site still pins arcade-games
efabb70 (old colours).
Then (branch `propose`, not pushed): Lokesh dropped the bump workflow — PRs
are the contributor's; `just propose` / the site's Propose form and Check
for updates open GitHub's page filled in; merge → deploy.yml. Cards: PLAY
WITH BOTS / PLAY WITH FRIENDS on hover or tap, no PLAY NOW.
Live 2026-11-13 (a6fb6bf): propose + cards, verified on a phone.
Then (branch `submissions`): submission.yml + submission-report.yml check and
label every PR touching registry/ (rules in check-submission.mjs, tested;
the full check passed on a trial bump of arcade-games to 4ae4d37 and refused
it from another author). platform-check.yml is the old registry-check.
Next: Lokesh opens the arcade-games pin PR himself (edit link from `just
propose lokeshmohanty/arcade-games`) — the first live run of the check.

## Phases 1–6 (2026-11-13) — merged, site and Worker deployed (b35232de)

Built and green locally: stats/favourites/recents + portal from catalogs
(Phase 1); accounts, ranked matches, leaderboards, hourly GitHub snapshot,
feedback, friends + presence + invites, groups (worker/api/, D1, UserLive;
lib/account*.js, profile.html, leaderboard.html) — docs/accounts.md.
test-worker converted to frames: it caught that sandboxed games lost
`secrets.keep` across a reload (no sessionStorage in the frame) — **live on
main since b597fb6**; fixed here (NeonArcade.sessionStore via the bridge).
Green 2026-11-13: every `just test` suite + test-accounts (100) + test-social
+ test-worker. arcade-games: branch `platform-2` (titles, reportResult),
registry pinned to its local commit — push + re-pin before merging.
Setup done 2026-11-13: D1 `arcade` (APAC), all secrets, OAuth apps, GitHub
App, Worker deployed; live API/redirects/room server verified.
Identities live 2026-11-13 (main 16c0777, D1 migration 0002 applied, Worker
ff2ca98d): one account connects Google + GitHub; GitHub sign-in is the GitHub
App (client Iv23…); its user token kept AES-GCM encrypted; feedback requires
GitHub and posts as the player's own comment. The one live Google account was
copied into `identities`. Old OAuth app secrets (GITHUB_CLIENT_ID/SECRET)
still set — delete them and the OAuth app (GitHub sign-in now verified).
Seen live 2026-11-13: GitHub connected to the Google account, and feedback
posted as the player's own comment (undercover thread, author lokeshmohanty).
Still to see live: a ranked game between two real accounts, the first
`stats` snapshot commit; real-phone check (sandbox wake lock / audio /
fullscreen; dev kit from Safari).

## Platform rework (2026-11-13) — merged to main on Lokesh's confirmation

Plan: `~/.claude/plans/1-a-b-2-generic-whistle.md`; design: docs/sdk.md;
author workflow: CONTRIBUTING.md. All games framed: four in `games/<id>/`,
five from `lokeshmohanty/arcade-games` (pushed, main 24eeffe) via
`registry/lokeshmohanty/arcade-games.json`. Onitama removed everywhere
(Lokesh: "leave onitama out" — a recreation of a published game); a local
branch `backup/import-with-onitama` in ../arcade-games keeps the old import.
Dev kit, example game, `validate-game`, PR check, deploy fetch step built.
Green 2026-11-13: full `just test` incl. devkit; validate-game on all games.
Next: portal cards from the catalogs; then Phases 1–6 (stats → accounts → …).
Not yet: test-worker (wrangler) still drives games in-page — needs the
frame rewrite test-party got; real-phone check of wake lock / audio /
fullscreen in the sandbox; dev kit from Safari / Chrome LNA prompt.

## Leaving and presence (2026-11-12) — committed (e55a33c…c6a9856)

Every exit asks (in-page `<dialog>`, not `confirm()`), back/swipe-back trapped,
`beforeunload` with others present, toasts for join/leave/lost/back/crown —
docs/index.md "When the host goes", lib/README.md lobby.js table. sw.js v13.
Green: test-party, test-bots, test-room, test-worker (wrangler dev), codec,
hub, worker-do, pwa, scan. test-plumbing has 2 failures that come from the
*other* in-flight net.js work (offer resend), not this — HEAD + this change
passes. test-pair/test-nat/test-live helpers moved to the dialog, not run.
Not yet tried on a real phone (iOS swipe-back, Android back gesture).

Audit backlog (2026-11-12), owner to pick — highest first:
- [x] Party: way back from a running game — PARTY pill → party screen over
      the game, BACK TO GAME / END GAME (2026-11-12, test-party).
- [x] Host leaves mid-game → the game *ends* with a notice (new host clears it
      after 1.5 s; game page ends the session with a way on). Not resumed:
      games still keep state on the starting host (2026-11-12, test-party,
      test-bots).
- [x] Game pages are party shortcuts (Lokesh, 2026-11-13): `connect4.html`
      etc. redirect to `party.html?game=<id>&fresh=1`, a quick start (PLAY A
      BOT / INVITE A FRIEND / START GAME) then an ordinary party — code, rejoin,
      PARTY, END GAME, turn banner. `mountLobby` / `mountGamePage` /
      `goJoinCode` removed. test-worker 13, test-bots (ported, kept off the
      deployed server), test-room (scripts/room-harness.html). Preview gifs
      re-recorded through the party shell (b99b69f).
- [x] A crown change hands the running game over (`takeOver()` per game,
      `rounds.adopt()`); the old host's seat is held; hidden-info games resume
      at a clean point; Battleship still ends (Lokesh, 2026-11-13; test-worker
      14, test-party).
- [x] Returner after reload re-synced: party shell's mounted notice →
      host's `onPeerJoin(id, {back})`; draw & guess replays the canvas and
      re-announces its clock (2026-11-12, test-worker 10).
- [x] Reload keeps secrets: `secrets.keep/kept` (sessionStorage), restored
      only against the published digest; battleship re-sends the missed
      volley (2026-11-12, test-worker 10). Not covered: a reload that outlasts
      a call's 4 s opening window (Liar's Dice) or the 4 s open phase (Neon
      Bid) still misses that opening.
- [x] Turn games on a RECONNECTING seat: banner "Waiting for X — reconnecting
      (0:30)", then the host decides WAIT / SKIP TURN / END GAME (Lokesh: host
      decides, 30 s). `NeonArcade.turnWait`, in Connect 4, Onitama, Liar's Dice.
      Onitama: a side that leaves loses (2026-11-13, test-worker 11).
- [x] Wake lock while a game runs (`NeonArcade.keepAwake`); `away` published
      on the member record when the page is hidden (roster AWAY, turn banner
      "switched away"); Tug of War / Neon Survival pause for everyone while
      the host is out of the app, "Resuming in 3" on return
      (`NeonArcade.hostPause`) (2026-11-13, test-party). Wake lock not tried on
      a real phone; headless Chrome grants it.
- [x] Bots stay when the crown moves (`_vacateCrown` no longer drops them; the
      new host plays them next game) (2026-11-13, test-plumbing, test-party).
- [x] Moving on from a held seat (portal START A PARTY, code link, invite)
      releases it first (`busy` → "open in another tab"); a code link to your
      own party reconnects; a release is announced `released:true` and the mesh
      drops the seat at once; `online` redials at once; offline strip
      (2026-11-13, test-worker 12, test-room). Worker deployed 2026-11-13
      (version 5b7a8599): test-live all passing, and a raw probe saw
      `released:true` from production.
- NAT lab scenario 11 is **flaky run alone** (`--only=11`): "cone host
  reload: full mesh back (the carrier pair too) in < 6s" takes ~15.5 s in
  most isolated runs, on the committed code too (3/5) — passes inside the
  full lab. The full run of 2026-11-13 failed once on "…on the first try, no
  swap" with `pair: null` (stats unread; the reload took 0.3 s). Neither
  touches the new release/online paths (instrumented). Not investigated.
- [x] Perf: party `render()` skipped while hidden behind a game (drawn on
      PARTY / game end), keeps a name being typed, QR encoded once; invites
      withdrawn on CANCEL / replace / close (`invite.withdraw()`); Link queue
      capped at 8 MB past the channel buffer — the link is dropped and the
      pair relay (2026-11-13, test-party). Game pages' lobby invites not
      changed.

## Neon Bid (2026-11-12) — shipped in 25c76f2

New game per `docs/neon-bid.md`: `games/neon-bid.js` + `neon-bid.html`,
party/portal/sw.js (VERSION v12) wired, `scripts/test-neon-bid.mjs` in
`test-rules`, a full-table section in `test-bots.mjs`, preview gif recorded
(`just preview neon-bid`, 480px profile). Not yet played by a person on a
phone; bot strength vs humans unmeasured (it wins 100% vs both baselines).

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
- [ ] **Room-server gaps closed (2026-11-12, uncommitted, NOT deployed):**
      owed leave is a `release` (retried on `busy`, ≤ 6 s nav hold); dial
      budget = guess budget (10), a host's dial is never refunded (it was a
      free scan), dial gate fails closed (503). Cost: a shared address with 10
      unrefunded dials 429s its members' re-dials for ≤ 5 min — see
      docs/room-server.md Honest gaps. Needs deploy, then `just test-live`
      oracle/gate (budget 10) — VERIFY.
- [ ] **Shared-address cost removed (2026-11-12, uncommitted, NOT
      deployed):** member passes (HMAC of `code.id.exp`, issued with every
      seat, presented on every re-dial's URL, verified by the routing Worker
      before IpGate → uncharged) and server-drawn host codes (`/room/new`,
      create-if-free reservation, no dial/guess, capped HOST_ROOMS = 30 /
      5 min / address). Budgets stay equal (10). A shared address now loses
      only *newcomers'* joins after 10 typos. sw.js → v11. Before deploy:
      `openssl rand -base64 32 | wrangler secret put ROOM_PASS_KEY` in
      worker/ (orchestrator; worker/README.md). After deploy: `just
      test-live` (flows, hib), then `--only=gate` alone (asserts a pass
      re-dial from the exhausted address) and `--only=oracle` alone —
      VERIFY. Installed PWAs need the new room-join.js before the old
      client's `{t:"host",code}` stops working: the deploy removes
      client-chosen hosting, so old cached clients fall back to the classic
      flow until they update.
- [ ] **Review fixes on the above (2026-11-12, uncommitted, NOT
      deployed):** one ask per socket (`bound`) + atomic dial refund
      (pipelined joins refunded once each); `/room/new` reservations lapse
      after 15 s (`reservedAt`, alarm, never re-clocked on wake); hosting
      also capped per IPv6 /48 (120 / 5 min); canonical-base64url passes
      only, member ids ≤ 64 (`bad-id`); a 429 is now a Worker-accepted
      socket saying `blocked` ("Too many attempts", not "Could not reach").
      After deploy: test-live `redraw` on a *debug* deploy (`--var
      ROOM_DEBUG:1 --var ROOM_TEST_FORCE_REDRAW:1`), and `gate`/`oracle`
      read `blocked` — VERIFY (docs/room-server.md Honest gaps).
- [ ] **One-direction NATs (2026-11-12, uncommitted, NOT deployed):** the
      two-machine test (Airtel CGNAT ↔ bhaskara) connected only when the
      Airtel side offered; guest reloads failed 15/16. Cause verified: the
      isolated host's re-announce closed its socket 1 s before re-dialling,
      and the returning guest landing in that gap was named offerer. Fixes:
      `rejoinServer` dials first (the hub's 4409 replaces the retired
      socket); a pair whose first ICE try fails is retried once with the
      roles swapped (room server and mesh relay; retry flag; no hub
      change). NAT lab `portdep` profile + scenario 10 (reproduced the
      failure before the fix). Cost: unconnectable code joins now report
      no-route at the 30 s deadline (was ~15 s); a wrong-direction pair
      takes ~15 s longer (now every Airtel-*host* reload). After deploy:
      `just test-pair --runs=3` — VERIFY guest reload ok, host reload
      ~20 s. Review fixes (same day, uncommitted): a leftover unanswered
      invite no longer mutes the swap/no-route (`_trying` counts only
      links with a peer; glue `dropInvites` on glare loss, backstop,
      `connected:false`); only the marked retry (`r.` code prefix,
      `isRetrySignal`) skips glare; a rejoinServer replacement keeps the
      guards of answered offers only (drops the unanswered invites); the join deadline waits SWAP_WAIT_MS once for a swap
      under way (worst case 38 s). test-room 6e11–6e14.
      Regression fixed (same day): dialling first left NAT lab scenario 5
      ("blackout outlasting the link by 5s") failing ~half the runs — an
      `offering` notice delivered on the socket being replaced made the
      blacked-out member offer with host-only candidates; answered, it
      muted the peer's offer and failed for good. Such notices are now
      deferred until the replacing dial lands (room-join `owed`); heals
      2.3 s after the network returns. test-room 6e15; trap in
      memory/cross-network.md.
      Open watchdog (same day, uncommitted): a direct link not open 20 s
      after both descriptions (`OPEN_TIMEOUT_MS`) is failed like ICE
      `failed` — an answering link stuck in `connecting` no longer blocks
      the swap/verdict. test-room 6e16; NAT lab 1 run green (5, 6, 10).
      Regression fixed (same day): it also armed the *manual* answerer, so
      a scan/paste reply carried back after 20 s found the guest closed
      (no-route). The answerer now arms only on `answerInvite(code,
      { watch: true })` (room-join alone); a link whose ICE is up gets one
      more period before failing. test-room 6e17, 6e18.
- [ ] **Hard-NAT glare preference + honest manual replies (2026-11-12,
      uncommitted, NOT deployed):** net.js `classifyNat` (two STUN ports,
      one socket; `room.natHard`), offers marked `h.`; glare: a hard offer
      beats a plain one, else lower id; a hard member offered to with
      nothing in flight offers back. NAT lab: `cone` soft, `portdep` hard
      (second STUN port 3479); scenario 10 every reload, both directions,
      < 6 s on the carrier's own offer (15.4 s swaps with it off).
      Manual flow: reply screen says "right away"; a pre-open no-route says
      too late / no direct path + MAKE A NEW REPLY. VERIFY on the real pair
      after deploy (`just test-pair`, both `--remote-hosts` ways): Airtel
      must read hard, bhaskara soft, reloads ~2 s. Mesh relay still swaps.
      Review fixes (same day): a set-aside offer is answered if ours goes
      unanswered for `GLARE_FALLBACK_MS` (6 s) — tabs still on a5a679d
      cannot read `h.`/`r.` and never answer — and the backstop answers a
      held one instead of dropping it (test-room 6e20, 6e8); the NAT is
      re-classified on isolation and `online`/connection `change`, cached
      per STUN set (6e21); Firefox foundation grouping marked VERIFY.
      classifyNat decides per address family: bhaskara (soft IPv4, dead
      Tailscale IPv6 timing out 701) read `null`, now `false` in ~2 s
      (`NAT_SOFT_SETTLE_MS`); stubbed-stream test in test-room.
- [x] **Firefox + two-carrier verification (2026-11-12, against d6c7f18
      as deployed; test/docs changes uncommitted):**
      Firefox groups srflx foundations by base like Chrome —
      `classifyNat()` `true` on Airtel, `false` on bhaskara; its
      `icecandidateerror.address` is `null` (harmless). `just test-pair`
      on production, new `--browser=firefox` / `--remote-browser=firefox`:
      7/7 runs (Firefox↔Chrome both ways ×2, Firefox↔Firefox, Chrome
      control both ways) passed every phase on Airtel's offer, no swap.
      NAT lab scenario 11 (both `portdep`; + a cone third): direct on the
      first try, 0.3 s, also over the mesh relay.
- [ ] **Returning host republishes (2026-11-12, lib/net.js, uncommitted,
      NOT deployed):** found by lab 11 — in a three-member party a host
      reload left a member who had concluded the host gone unlinked with
      its own crown, for good (3/3). `_applyParty` now commits a record
      that newly names us host. test-room 6e22. Sibling (same day): a
      member back from a reload was offered to over the relay before
      anyone had relinked it — offer lost, seat held RECONNECTING, never
      re-meshed. `__alive` on link open, same-envelope resend on it, and a
      fresh offer once after an unanswered expiry. test-room 6e23.
      `just test`, `just test-worker` green; `just test-nat` green but
      for scenario 7 (classic invite textarea never appears — fails the
      same with HEAD's net.js; the tree also carries someone else's
      uncommitted lobby.js/party.js/styles.css work, suspected, VERIFY).
      Needs the owner's review + deploy, then `just test-pair` on
      production (and a three-device party, VERIFY).
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
