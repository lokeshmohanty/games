# games — Documentation

*Last synced: 2026-11-15 (SDK v1 and the old pages removed; docs/platform.md; lib/README.md's API and connectivity moved here).*

Entry point for all project documentation. Any LLM should be able to answer
questions about this project from this folder alone.

## Contents

- [The portal](#the-portal) — the home screen's sub-tabs (My Games · All Games), sections, PLAY SOMETHING, the phone layout and the search
- [Connecting players](#connecting-players) — the serverless handshake, paid once per person; `scanQr`; connectivity (relaying, STUN, NAT classification, no TURN)
- [Parties](#parties) — the persistent group, teams, switching games, host succession; the party API (`mountParty`, the room controller, lib/lobby.js)
- [Bots](#bots) — why there is no single-player section, and what a bot actually is
- [Hidden information](#hidden-information) — sealed private state, and commit-reveal
- [Rounds and phases](#rounds-and-phases) — the shared clock for timed and simultaneous-turn games
- [Adding a game](#adding-a-game) — where the author's guide and the protocol live
- [Accounts and the social layer](accounts.md) — sign-in, ranked matches, leaderboards (ranked, solo runs, and wins against bots kept apart), friends, invites, groups, feedback, the public snapshot; what is stored; the one-time setup
- [A prompt for contributors' AI](contributor-prompt.md) — paste into an AI assistant to adapt or write a game for the platform
- [Suggestions](suggestions.md) — formalising and improving the platform: contract, contributors, quality, trust, players, operations
- [Developing the arcade](development.md) — running it, where the code is, the stack and why, tests, the service worker, previews and icons
- [The shell is one page](spa.md) — Solid + Vite, the query router, the party kept across views, the build and the generated service worker
- [The game SDK v2](sdk-v2.md) — the language-neutral message protocol (sdk/v2/protocol.json), shell services, managed state, WebAssembly, adapters, bindings, examples
- [The platform](platform.md) — the sandbox, the manifest's base fields, theme, results, the rules a game follows, the registry and pins, the submission check, the dev kit, validate-game, web apps
- [Installing it](#installing-it) — the PWA: manifest, icons, service worker, offline
- [Performance](perf.md) — the phone-speed harness (`just perf`), the 2026-11-14 baseline, and each refactor phase measured against it
- [Testing across real networks](network-testing.md) — the NAT lab: symmetric NAT, network switches, lossy links, a blocked room server
- [`../lib/README.md`](../lib/README.md) — every lib/ file in a line, with pointers here for depth
- [Neon Bid](neon-bid.md) — the sealed-bid gem auction's design, as approved
- Neon Fission (`games/neon-fission/`, rules in its `RULES.md`) — the chain-reaction grid for 2–8: a managed ffa game; one person with bots can hand bot seats to people on the same phone before the first move (those seats' turns are reported as the person's, so no bot plays them; the end card names them via the result's `names`, docs/sdk-v2.md). Each move's chain is replayed on every phone, about 1.5 s at most, and a tap skips it. The move that ends the game plays wave by wave and then marks the cells it took: 5.25 s at most for any chain, its waves sharing a 4.3 s budget (at most 300 ms each, about 40 ms in a 104-wave chain), so it always ends inside the end card's 6 s hold. The turn line and chips wait for it, and so does the end card (`arcade.idle()`, docs/sdk-v2.md; rules.js `pace`). Under reduced motion nothing animates
- (still missing: design notes for the other games, decision log)

## How-to (verified commands)

| Task | Command |
|---|---|
| Test the signalling codec | `node scripts/test-codec.mjs` — no browser needed |
| Test the party end to end | `node scripts/test-party.mjs` — three real browser peers at 390x844: guest-side recruiting, teams, game switching, host succession |
| Test the room hub (codes, claims, TTLs) | `node scripts/test-hub.mjs` — pure hub logic against the real rules, no browser, no Cloudflare account needed |
| Test the join-by-code path | `node scripts/test-room.mjs` — the real client (lib/room-join.js, net.js, the party and lobby screens) against the in-page mock room server; WebRTC handshake itself is real |
| Test across real (simulated) networks | `just test-nat` — NAT routers built from network namespaces (cone, full cone, symmetric), netem loss/latency, a network switch mid-party, a blocked room server; real Chrome per device and the real worker under `wrangler dev`. Needs `nix shell`, so not in `just test`. See [network-testing.md](network-testing.md) |
| Regenerate a portal preview | `scripts/make-preview.sh <game>` (or `all`) — plays the game headless and writes `assets/<game>.webp` (poster), `.webm` and `.mp4`; no gif is kept |
| Serve it locally | `just run` — http://127.0.0.1:8000. `just serve-lan` binds every interface for phone testing, but a plain LAN http:// address is not a secure context, so SCAN REPLY will not work there (use PASTE) |
| Run everything | `just test`, or `just --list` for the rest |
| Check the offline precache | `just build` — `scripts/assemble.mjs` derives the precache list from what it built and copied, and fails if a listed file is missing; `just test-pwa` then plays every game offline |
| Play locally with several peers | `just run`, open http://127.0.0.1:8000/?party, click ADD PLAYER, open the invite link in another tab, paste the reply back |
| Test reply-code **scanning** | `node scripts/test-scan.mjs` — renders a real-sized reply code into a camera frame and feeds it to Chrome as a fake capture device. Scanning needs a camera *and* a secure context, so a plain `http://<ip>` will not do; the test serves the site over `http://127.0.0.1` for that reason |
| Test installability and offline | `node scripts/test-pwa.mjs` — checks the manifest and icons, asserts the portal's layout at 390x844, asks **Chrome itself** whether anything blocks installing, then cuts the network and loads the pages |
| Test that every game is playable alone | `node scripts/test-bots.mjs` — starts each game with bots and no second browser, checks the bots actually play (Connect 4 is never left an open win), and checks no peer opens a connection to one |
| Test the private-state and round layers | `node scripts/test-plumbing.mjs` — real `Room` routing over a fake transport: a sealed message is unreadable by the peer relaying it, a tampered one is refused, commitments verify, phases advance |
| Test Battleship's rules and audit | `node battleship/test-battleship.mjs` in the web-games repo (lokeshmohanty/web-games) — fleets, sinking, and the audit tested by *breaking* it four ways |
| Test Undercover | `node scripts/test-undercover.mjs` — the deal, the win conditions, and the table sizes that survive a wrong vote |
| Test Liar's Dice | `node liars-dice/test-liars-dice.mjs` in the web-games repo — wilds, the bid ladder, the at-least rule, and the reveal race that once accused an honest player |
| Test Neon Bid's rules, audit and bot | `node scripts/test-neon-bid.mjs` — second price, the reserve, tie refunds, scoring and tie-breaks, the bid audit broken six ways, and the bot measured against a random and an even-spending bidder |
| Test Neon Fission's rules and bot | `node scripts/test-neon-fission.mjs` — capacities, a three-wave chain (RULES.md's example), conversion, knock-outs only after a first turn, the chain stopping once one player owns every orb, the bot (legal, fast, takes a win; vs random and greedy players), 210 whole bot games that all end, and the same-device seats in the managed layer |
| Test the Light Cycles arena | `node light-cycles/test-light-cycles.mjs` in the web-games repo — head-on collisions, spawn symmetry, and the bot measured against a rider that only avoids crashing |
| Rebuild the app icons | `node scripts/make-icons.mjs` after editing `assets/icon.svg` — renders the PNGs the manifest needs |
| Get back to the portal | the party has a fixed `.portal-link` ("← Games", in index.html) linking to `./`; it keeps the party (LEAVE PARTY leaves it) |

Per-game recorder scenarios, the conversion profiles, and the NixOS/Playwright
traps live in the `game-previews` skill (`.agents/skills/game-previews/SKILL.md`).

Two more skills hold the traps that this document only summarises — read them
before changing either subsystem:

- `.agents/skills/multiplayer/` — the P2P layer. Its memory records why SCAN
  REPLY has failed twice, and the one test shape that catches it.
- `.agents/skills/pwa/` — installability and offline. Its memories record why an
  SVG in `manifest.icons` makes the app uninstallable, and why code is served
  from one versioned snapshot (network-first until 2026-11-14).

## The portal

The portal (`./`, the manifest's `start_url`) is the first thing an installed app shows.
**Since 2026-11-13 its cards are drawn, not written** (`lib/portal.js`): one
per game in `NeonArcade.CATALOG` — this repo's manifests and every pinned
outside repo's — so a merged registry PR appears with no edit here. Each card
has your own record on this device and, for a community game, its author. A
game is starred (☆, `lib/stats.js`) and given feedback (💬) only from
inside it, at the party's top right beside PARTY (2026-11-14; a star on the
cards was tried on 2026-11-15 and taken out the next day, Lokesh: "Only
inside games"); a contributor or a collection is starred on its own page.
Every star lands in My Games at once. Its layout is asserted rather than
eyeballed, in `test-pwa.mjs` and `test-portal.mjs` "My Games · All Games"
(390x844, Lokesh's phone at 354x696, and 320x640); what is in each section,
in `test-portal.mjs`.

**Two sub-tabs** (Lokesh, 2026-11-15: "All favourites land under My
Games"). Under the tab row, Games has **My Games · All Games**, each an
address (`./?page=games&tab=mine` / `tab=all`); `./` opens on My Games once
the device has a favourite or a recently played game, else on All Games,
decided before the first paint ([spa.md](spa.md) "The portal's sub-tabs").
Under the brand and the party banner:

- **My Games** — the Recently played row (PLAY SOMETHING at its heading's
  right), then ★ Favourites (the button in its heading instead when nothing
  was played yet). With neither, a line on how to star (★, from inside a
  game), PLAY SOMETHING and ALL GAMES.
- **All Games** — the search, then Popular (with **PLAY SOMETHING** at its
  right: one tap into the single player of a popular game with bots, never
  people-only or Python, varied per visit) and the categories.

Changing sub-tab closes any card left open, so a row on the other sub-tab is
never held back as "in use" and is current when you return (review,
2026-11-16).

**The home screen is sections** (Lokesh, 2026-11-15: "show the favourites,
then the top 3~5 games based on popularity, and then pre-defined
categories"). Top to bottom (`lib/portal.js` `SECTIONS`, each with its
sub-tab; an empty one is hidden):

- **★ Favourites** (My Games) — the games starred, in the order starred,
  then the contributors and collections starred (`contributor:<login>`,
  `collection:<owner>/<repo>`) as buttons that search for their games on
  All Games.
- **Popular** — the five most played (`/api/stats/summary`, else the public
  snapshot), examples aside. The counts are kept on the device
  (`neon.plays`), so the row paints at once and in the same order offline;
  with no counts ever, the catalog's order. Counts that land late never
  replace a row someone is using (a card tapped open, hovered with a mouse,
  or reached by keyboard): the row is redrawn when they leave it, at the
  scroll it had (`lib/portal.js` `inUse`; a slow phone had the card close
  under the finger, review 2026-11-16).
- **Arcade · Party · Strategy · Puzzle / Single player · Examples** — the
  catalog's `categories` (`scripts/manifest.mjs`); a game sits in every one
  it is in. Puzzle / Single player also takes any game one person can start
  (`seats.min ≤ 1`). **More games** catches a game no category takes.

A game therefore has several cards. Preview videos get their sources only
when the card nears the screen and play only while at least half of it is
on screen, so the home screen plays a handful, not dozens; on a phone each
section is one row that scrolls sideways inside itself (two cards and the
edge of a third), and every row (Recently played's too) scrolls to the
screen's edges while its first card lines up with the column above, with no
scrollbar. **Search** replaces All Games' sections with one grid of the
matches, one card per game; the query stays in `?q=`.

**Real-device findings (Lokesh's OnePlus, 354x696 at DPR 3.5, 2026-11-15)**,
fixed and asserted: every home tap target is at least 44px (START A PARTY
and JOIN WITH A CODE were 34px, the sub-tabs 36px); every line on a card is
at least 12px (the meta line was 9.9px; it keeps one line by dropping its
letter-spacing and narrowing the card's side margins to 4px); Recently
played and the search were 80% wide on a phone, narrower than the cards,
because their base rules came after the phone rules in portal.css. On a
phone the party banner is its two buttons (the heading said what START A
PARTY says), which paid for the sub-tab row.

**Nine games have to fit a phone.** They did not: a `minmax(300px, 1fr)` column
at 80% width is a single column on a 390px screen, and a 200px image plus a
heading plus a paragraph plus a button is taller than the viewport — you
arrived at one card. Below 560px a row holds two cards (the search's grid two
columns), the artwork is a
ratio rather than a fixed height, the blurb is dropped (at that width it is four
words a line, and the meta line already says the thing somebody standing there
wants to know), and the header — title, tagline, party banner — is roughly
halved. Four whole cards now fit on screen *from the top of the page*, header
and all, which is the number the test enforces.

**One trap, and it had been there from the start.** `.game-card p` outranks a
bare `.game-meta` on specificity, so every rule ever written for the meta line
was silently ignored: it rendered at the blurb's size and margins, and on a
phone that wrapped it onto a second line. The rules are scoped
`.game-card .game-meta` now, and the test checks the computed size rather than
trusting the stylesheet.

**Tags and search.** The filter chips are gone (2026-11-15): the sections do
their job. Each card still carries `data-tags`, and the search reads them
(`tag:quick`, `type:duel`, `players:4`, `author:`, `from:`; `lib/portal.js`
`parseQuery`). The tags are `alone` · `duel` · `party` · `one-phone` ·
`strategy` · `quick`, and a new game should be given whichever apply. A
search matching nothing says so rather than leaving a blank page.

## Contributors and collections

*Lokesh, 2026-11-15: "Contributors can share multiple game repositories …
add a collections page … always sorted by popularity. Both Contributor and
Collections can be favourited."*

A **collection** is one games repository the arcade lists: an outside one
pinned in `registry/<owner>/<repo>.json`, and the arcade's own
(`lokeshmohanty/games`). Every catalog entry carries its `repo`, so the
collections are derived, never listed by hand (`lib/collections.js` `list`).
A contributor (a GitHub login; `NeonArcade.CONTRIBUTORS`, merged to one per
person) can own several.

- **Collections** (`./?page=collections`, `src/views/Collections.tsx`): one
  card per repo, **most played first** — the sum of its games' plays from
  `/api/stats/summary` (else the public snapshot), the same counts the
  portal's cards show; ties by `owner/repo`. Each card: name, owner, games
  and plays, up to three posters (the ~5 KB webp, never a gif) and a few game
  names, ★, SEE ITS GAMES and the repo on GitHub.
- **Contributors** (`./?page=contributors`): one card per person — their
  games and the games' total plays, each of their collections (games, plays,
  a link to its games, GitHub, and CHECK FOR UPDATES when it is pinned:
  `lib/propose.js`), their profile links, ★.
- **A collection's games** are the portal searched by
  `from:<owner>/<repo>` (`lib/portal.js` `matches`: a `from:` value with a
  slash is a repo; without, still arcade, community or an owner).
- **★ favourites** go in the same list as games' (`lib/stats.js`,
  `neon.favs`) as `contributor:<login>` and `collection:<owner>/<repo>`;
  games keep their plain ids. Starred cards come first on each page, the
  rest keep their order. Signed in, they sync like game favourites
  (`/api/me/favs`; the worker accepts the two prefixes since 2026-11-15, no
  migration). A worker from before that refuses the list with 400, and the
  page then sends only the games', so a stale deploy never stops game
  favourites syncing. The profile lists them as `@login` and `owner/repo`.
- The cards are made once per visit and moved, not redrawn, when a star or
  the counts arrive and reorder them (a CHECK FOR UPDATES answer stays). The
  four tabs fit 390 px (and 360) with a narrower tab below 480 px
  (`lib/styles.css`). Tests: `test-portal.mjs` "contributors" and
  "collections"; `test-stats`, `test-accounts`, `test-social` for the ids.

## Connecting players

The handshake is carried by the players — there is no signalling server and no
third-party relay (see `MEMORY.md` → no-third-party-services). **Update
(2026-10): a room server now exists as an optional layer.** See
[`room-server.md`](room-server.md) for the design; the summary below is what
changed.

**What the room server adds:**

- **Join by code.** The host reads a six-digit code off their screen; the
  newcomer types it. The signalling WebSocket handles the offer/answer exchange,
  so the two-sided scan/paste handshake is no longer the only path in.
- **Reconnect.** A reloaded browser keeps a rejoin token in `localStorage`;
  the room server routes them back to their seat, so a page refresh no longer
  costs a party seat. The old mesh-level reconnect grace still covers the
  gaps the room server cannot see.
- **Progressive enhancement.** When the room server is unreachable, the
  classic invite/scan/paste flow is unchanged — same code paths, same
  errors, just without the code-join button.

**What the room server does not change:**

- Game data still flows peer-to-peer over WebRTC data channels. The room
  server sees only signalling (SDP offers/answers), never game bytes.
- The party record is still replicated over the mesh; the room server's
  peer-state notices are advisory, and a live link always outranks them.
- The classic handshake still works for any pair that cannot reach the room
  server.

Deploy instructions live in `worker/README.md`; the client-side glue is
`lib/room-join.js`.

| Step | Same room | Apart |
|---|---|---|
| Inviter → newcomer | newcomer scans the invite QR with their phone camera | inviter sends the invite link over any chat app |
| Newcomer → inviter | inviter taps **SCAN REPLY** and points the camera at the newcomer's screen | newcomer sends the reply code back; inviter taps **PASTE**, or pastes it and taps **CONNECT** |

**That cost is paid once per person, by whoever is next to them.** Any member
can invite, not only the host, and once someone is connected the rest of the
party negotiates with them automatically over the links that already exist.
This is why the topology is a mesh rather than the star it used to be: the
expensive part of a mesh was never the connections, it was the copy-pastes.

**SCAN REPLY** is served by `lib/qr-decode.js`, a from-scratch QR decoder plus
camera scanner. It prefers the browser's `BarcodeDetector` where that exists
(Android Chrome) and falls back to its own decoder, because desktop Chrome and
iOS Safari do not ship one. Always call the returned `stop()` — it releases the
camera, which the browser will not do on its own.

Two things about that scanner are load-bearing, and both were learned by it not
working:

- **Resolution is never traded for speed.** A reply code is a 70-90 module grid
  read off somebody else's screen, so pixels per module is the scarce resource.
  The scanner used to lower its working resolution when a decode ran long —
  and the frames that run long are the *empty* ones, the ones the camera sees
  while its owner is still lining the phone up. It therefore threw away the
  detail it needed before it had seen anything, and from then on could not read
  a reply code at all: camera live, preview fine, nothing ever scanned. Cost is
  managed instead by decoding the centred square (what the preview shows) and
  by running the cheap binarisation pass on most frames and the full ladder on
  every third.
- **A platform decoder that fails must not take ours with it.** Chrome exposes
  `BarcodeDetector` on platforms where the service behind it is missing, and
  `detect()` then rejects on every frame; the rejection used to skip the
  fallback entirely. It is now dropped permanently on first failure.

`scripts/test-scan.mjs` covers both, including the aiming that precedes a real
scan and a CPU throttled to phone speed.

`NeonArcade.scanQr({ onResult, onError })` returns `{ video, stop }`: mount
`video`, and always call `stop()`. `onError` is always delivered
asynchronously, so `scanner = scanQr({ ... })` has finished assigning before
any callback can try to clean `scanner` up. Camera access needs a secure
context, so scanning works on the deployed `https://` site and on loopback but
not over a plain `http://` LAN address; the lobby says so and falls back to
pasting.

### Connectivity

Moved here from lib/README.md on 2026-11-15; net.js is the code.

- **Relayed signalling.** Once any link exists, offers and answers for every
  further pair travel over it (`_openRelayed` in `net.js`), which is why the
  mesh costs a player nothing the star did not. The host is a field in the
  party record, not the shape of the network.
- **Relayed messages.** A pair that cannot connect directly is not fatal:
  messages to it are relayed through a member who can reach both, capped at two
  hops and deduplicated by envelope id. A relayed negotiation that has not
  opened after 15 s is abandoned and, the first time, tried once more the other
  way round ([Honest gaps](#honest-gaps)). Nobody offers to a seat held for a reconnect until
  its owner is back.
- **Big messages.** Anything over ~12 KB is chunked and reassembled, and sends
  pause when the channel's buffer fills, so per-frame broadcasts cannot grow it
  without bound.
- **STUN is the only outside contact** (`stun.cloudflare.com`,
  `stun.l.google.com`), used to discover each peer's public IP:port; it never
  sees game data. Pass `iceServers` to `createHost`/`createGuest` to override,
  or set `localStorage["neon.stun"] = "host:port"` (or two, comma-separated)
  for a whole session — the NAT lab's hook (`scripts/test-nat.mjs`), STUN only.
  Deliberately not a query param: a link anyone can send must not choose a
  player's STUN server.
- **NAT classification.** `NeonArcade.classifyNat(iceServers?, { fresh }?)`
  asks those two STUN servers (two hosts, two ports) where one local socket
  appears from, remembered per set of servers unless `fresh`. Two public ports
  for one base mean a **hard** NAT (endpoint/port-dependent mapping), which
  connects only as the ICE offerer. Resolves `true` (two ports for one base, at
  once), `false` (an address family with one mapping and no STUN error of its
  own, 2 s after its first mapping or at gathering complete — another family's
  timeouts do not veto it), or `null` (fewer than two servers, every mapped
  family erroring, nothing by 5 s). No traffic but STUN to servers already
  configured. room-join stores it as `room.natHard`, marks that side's offers
  `h.`, and its glare rule lets a hard offer stand over a plain one
  ([room-server.md](room-server.md), "Who offers to whom").
- **Gathering** stops shortly after the first server-reflexive candidate rather
  than waiting for `complete` (the rest is usually redundant interfaces), which
  is what makes the invite QR appear promptly. Candidates are otherwise kept,
  including `.local` mDNS ones: peers resolve them over multicast DNS, and on a
  LAN with no route to STUN they are the only way two browsers connect. The one
  exception is the ICE-TCP `tcptype active` placeholder, which two browsers can
  never pair.
- **No TURN server**, deliberately: running one would reintroduce the
  dependency this design removes. Networks that block direct connections
  surface as an explicit error rather than an indefinite wait. To cover them
  anyway, pass a TURN entry in `iceServers`.

## Parties

The party (`./?party`, lib/party.js) is the shell that keeps a group together. Because every game is a
mountable module and the room is a mesh, **switching games is a DOM swap, not a
page navigation** — nobody reconnects and nobody re-scans.

- **Roster** — everyone's name, editable and remembered in `localStorage`.
- **Teams** — each member is Team A, Team B, or WATCHING. Each game declares the
  shape it wants (`teams` / `coop` / `free`) and the switcher refuses to start
  one whose roster does not fit, saying why.
- **Spectators** are excluded from `players()`, so a game seats and scores only
  the people actually playing.
- **Host controls** — assign teams, add or remove a bot, remove a member, hand
  over the crown, or delete the party.
- **PARTY, mid-game** — a pill top-right while a game runs pulls the party
  screen up over it (the game keeps running underneath): BACK TO GAME for
  everyone, END GAME (asked first) for the host. Picking another game from
  there asks too, since it ends the one running.
- **A turn game waiting on a lost player** (Connect 4, Liar's Dice)
  says so: "Waiting for X — reconnecting (0:30)" for everyone. After 30 s the
  host decides — WAIT (another 30 s, for everyone), SKIP TURN (the game's own rule
  for passing a turn) or END GAME (asked first). Lokesh chose
  "host decides" over a bot taking the seat. The seat itself is still held for
  the full grace; a player who leaves for good is handled by each game
  (Connect 4: the side that stays wins). The collecting games (Battleship, Neon
  Bid, Draw & Guess) never stall — their phases have deadlines.
- **Leaving the app** (another app, a locked phone). The screen is kept on while
  a game runs (Screen Wake Lock), since a phone that dims suspends the page. A
  hidden page publishes `away`: the roster says AWAY and a turn game's banner
  says "switched away". A host out of the app stops its simulation anyway — a
  hidden page gets no frames — so a game the host simulates (Neon Survival)
  pauses for everyone and says why, takes no input meanwhile (it used to land
  all at once on return), and resumes after a 3-2-1. Lokesh's choices,
  2026-11-13.

### When the host goes

The party outlives it. A dropped link is not assumed to be a departure: the
party probes first, and anyone still connected to that member vouches for them.
Only silence counts as gone, and that conclusion is broadcast so everyone drops
them together.

Leaving on purpose is not a dropped link: `room.leave()` broadcasts the
leaver's own `__gone` first, so everyone drops the seat (and passes the crown,
if it was the host's) immediately. A reload or a closed tab never calls it.

**Every way out asks first, and everyone left is told** (lib/lobby.js
`guardParty` / `leaveParty` / `presence`). The fixed "← Games" link, ALL
GAMES, NEW PARTY, HOST A NEW GAME, opening another party's link, and the back
button or swipe-back (a history entry of the page's own, pushed on the first
tap — Chrome skips one pushed without a gesture) all raise the same in-page
question, which names the heir for a host; REMOVE and MAKE HOST ask too. The
question is a `<dialog>`, never `confirm()`, which would freeze the host's game
loop and relaying for everyone while it was up. A tab close or reload can only
get the browser's own "Leave site?" prompt, and only with another person in
the party; going ahead is not a leave — the seat is held, as a reload should.
The party shell asks even a host who is alone (the party ends) — except in a
party a game page opened, where one person against the bots is never asked.

Everyone else gets a toast, over the game if one is running: who joined, who
left and how (on purpose, lost connection, removed by the host), who lost
connection and came back, and who holds the crown now. A reconnecting mark or a
crown move is announced only if it still holds a moment later (2.5 s / 1.2 s),
so a blip that heals is not news.

If the host was the one who went, the longest-present remaining member (ties
broken by id, so everyone nominates the same person; bots and reconnecting
seats skipped) **takes the crown automatically** — no offer, no button.
`room.heir()` names that member beforehand, for the host's leave prompt. The
only thing that ends a party is the host explicitly choosing DELETE PARTY.

The party record carries a crown **term**. The member who takes the crown (or
the host who hands it over) bumps it and publishes; everyone else only
*computes* the heir and waits for that record. Ordering records by term is what
reconciles two hosts:

- a higher term always wins — a host cut off by a partition steps down when it
  hears the newer record, and introduces the members only it could reach to the
  new host;
- two hosts at the same term (both sides of a partition crowned someone) settle
  on the lower id, which every browser agrees on;
- a member that computed an heir yields to a host still speaking at the old
  term, which is how a false "the host is gone" heals.

**A split party: one side carries on, never two** (Lokesh, 2026-11-16
"heir side only", and 2026-11-17 "skip hidden + quorum"). The host's departure
can leave the rest in pieces that cannot reach each other: two guests that
talked only through the host (no TURN, by design), or a re-dial that had not
landed yet. The heir is named by `_successor` from the roster the host last
published (`lastRecord`). Every input comes from that record and none from
this browser's own copy, which a probe, a relink or a goodbye may have
changed since, so every piece names the same member. A review found two
pieces naming different heirs, and both crowning, because one read a held
seat that its relink had cleared. `_successor` skips:

- held seats (`reconnecting` on the record);
- heirs already passed over;
- while anyone else could take it, members whose phone is in the background
  (`away` on the record, from `visibilitychange`).

A member gone by its own goodbye since the record is not on the record
either: if it was the heir, it is passed over after the wait.

**An election decides who may crown** (2026-11-17; Raft's vote, without
terms). The member named stands for the crown: it grants itself and asks
everyone (`__c`). Every member grants **one** candidate per vacancy and
replies (`__gr`, relayed). A candidate crowns when its grants are more than
half of the record's humans, or exactly half with the first heir among them.
The old crown holder is left out of both sides of the fraction.

Grant sets are disjoint, so at most one candidate ever crowns: at most one
can hold more than half, and two exact halves cannot both hold the first
heir. An earlier version counted who had said "here" through the mesh
instead. A member that reached both sides before a split was counted twice,
and a review got two crowns that way, three once. Any presence count fails
like that.

Members vote only on an equal key: who left, the record's term, the first
heir and the record's humans. Two records of one term can differ, and
different fractions could both be met.

A page with no record heard from a crown holder (a fresh reload, a newcomer)
has no vote. That is also what stops a page reloaded mid-vote from granting
a second candidate: its grant died with the old page, and so did its record.
It waits for the crown's record, and is lost after the heir's wait. A member
still linked to the host that left grants nobody, because the host is not
gone for it.

**Waiting, standing aside, and being lost:**

- Every member that only computed the heir (`computed`, which is not the
  same as never having heard anyone: a fresh page has done neither) waits up
  to 10 s for its record (net.js `HEIR_WAIT_MS`).
- A silent or frozen heir never asks, so nobody is bound to it. When its
  wait runs out, or the member's own piece concludes it gone (anything but
  the heir's own goodbye), the next in line is named.
- A candidate without a quorum within the heir's wait releases its grants
  (`__r`) and never counts them again. It steps aside for the next in line.
  A voter is free again only when it hears that release.
- A member named with nobody left, or bound to a candidate it cannot reach,
  is **lost** (`room.lost`, `onLost(true)`).

A lost member:

- **Stops its game and says so.** The screen reads "Lost connection to the
  party", with TRY AGAIN where a room server may still reach the others, and
  LEAVE PARTY. A ranked start without a result is withdrawn at once, so
  leaving while lost is never booked as a departure.
  - TRY AGAIN calls `room.rejoin()`, the re-announce an isolated member
    makes. It is also made at once, and again after 5, 15 and 30 s.
  - The game frame is hidden, not torn down, for 60 s. A phone back in touch
    within that time resumes it, its own hidden state included, but only if
    it is the same run of the same game. A new run mounts fresh.
- **Rejoins rather than forks when a path comes back.** Its loss ends in any
  of these cases (`onLost(false)`):
  - a record at a newer term than it lost at;
  - the heir itself speaking;
  - the old host at the old term, but only if that record still seats the
    heir (otherwise it would put us in a second party beside the heir's).

  A member the heir dropped meanwhile carries its own seat back in.
- **Can still win an election.** After the heir's wait, lost phones that
  link up again stand again in a new round of the same election: the member
  that ranks first among them and the members it now links to directly. The
  key is the same, so the same grants bind, and a member still bound to a
  candidate that never released it does not grant. Without a room server,
  that, or LEAVE PARTY, is the way forward.

**Cases that are not splits.** An heir that left by its own goodbye is not a
split: it is passed over after the wait, and the next in line takes the
crown. A host whose seat the room server
holds sends no `__gone`. Whoever concludes it gone broadcasts that the crown
is vacant (`__v`), so an heir that reached the host only through a relay
still learns it. The receiver does not take it on trust: it probes the host
itself and concludes in its turn, so one member's false alarm (a host
reloading) cannot move the crown for everyone.

**Known gaps.** A partition between a *live* host and the rest is not a
departure: both sides keep a crown, and term ordering heals it on
reconnection. If the host and every candidate on the majority side fail
together, nobody carries on. Tested in test-plumbing ("a split party",
"…reviewed", "…re-reviewed", "…by election") and test-party (the lost
screen).

A link reported `disconnected` gets 3 s to recover before it counts as dropped,
because a phone on a briefly lost signal often recovers the same connection.
The cost is paid by a closed tab, which also arrives as `disconnected`: in
headless Chrome, closing the host's tab re-crowned the heir after 8 s without
the grace and 11 s with it. A deliberate `leave()` is not affected.

A page reload is the one case that cannot be rescued: WebRTC credentials are
per-connection, so a reloaded browser must handshake again — though any member
can invite them straight back in, and a room-server member does so on its own.

### The party API

Moved here from lib/README.md on 2026-11-15. The shell's internal contract:
games never call it (they speak [sdk-v2.md](sdk-v2.md) from a frame).

**`NeonArcade.mountParty(container, stage)`** (lib/party.js) mounts the party
screen in `container`; mounted games build themselves into `stage`. It handles
joining (`#i=` / `#c=` in the URL), recruiting, teams, switching and
succession.

**A game's address is a shortcut into it** (2026-11-13): `./?game=<id>&fresh=1`,
a portal card's link ([spa.md](spa.md)). With `?game=` the host of a fresh
party gets a **quick start** first: the game's name as the title, INVITE A
FRIEND and PLAY A BOT / PLAY ALONE (enough bots to make it legal), then ADD
BOT / REMOVE BOT and START GAME (START alone for a local game, which shows
nothing else). START seats people by the rule the old game pages had — host on
A; a one-against-one game puts the first other member on B and the rest watch;
a bigger team game deals the others out alternately, B first; any other game
seats everyone on one side; past the game's seats, the rest watch. After the
first game it is an ordinary party. A party opened this way does not ask a
lone host before leaving.

**The room controller** (lib/net.js `createHost` / `createGuest`):

| method | description |
| --- | --- |
| `selfId` | this peer's random id |
| `peerCount()` | number of other members |
| `getMembers()` | `[{ id, name, team, joined, bot? }]`, in join order |
| `getMember(id)` / `self()` | one member record |
| `isHost()` / `hostId()` | who holds the crown |
| `directPeers()` | peers this browser has an actual connection to |
| `getGame()` | the mounted game's id, or null |
| `makeAction(name)` | `{ send(data, { target }?), onMessage }` — broadcast or targeted |
| `setName(name)` | change your display name |
| `setTeam(id, team)` | host only: `"A"`, `"B"` or `"spectator"` |
| `setGame(id)` | host only: everyone mounts it; `null` returns to the party |
| `transferHost(id)` | host only: hand over the crown (never to a bot) |
| `heir()` | who would take the crown if we left now; skips us, bots and reconnecting seats; `null` if nobody |
| `lost` / `onLost(on)` | this side of a split party cannot take the crown or reach the side that did (see "A split party") |
| `canRejoin` / `rejoin()` | whether a room server may put us back in touch, and asking it to |
| `removeMember(id)` | host only: remove someone (a bot included) |
| `addBot(team?)` | host only: seat a simulated member; defaults to the emptier side. Returns its id |
| `bots()` | every bot in the roster (readable by anyone) |
| `emitAs(botId, action, data, opts?)` | host only: send as a bot, and deliver locally too |
| `NeonArcade.isBotId(id)` | a bot's id is prefixed `bot_`, so routing can tell without the record |
| `deleteParty()` | host only: end it for everyone |
| `leave()` | tell the party we are going (the seat drops at once), then close every connection. Never called on reload/unload |
| `detach()` | close every connection *without* telling anyone, as a reload would — the seat is held as RECONNECTING. For when the same member id is reconnecting from elsewhere (another tab took the seat; room-join's "displaced") |
| `createInvite({ forPeer, retry, hard }?)` | mint an invite (any member). Refuses with `err.reason === "full"` at `maxMembers` — unless `forPeer` names a member who already holds a seat (a reload coming back), whose own seat is not counted against them. `retry` marks the role-swapped second try (below); `NeonArcade._codec.isRetrySignal(code)` reads that mark synchronously. `hard` marks an offer from a hard-NAT network (`natHard`, below; `h.` prefix, `isHardSignal`) for the far side's glare rule. Rejects with `reason: "withdrawn"` if the invite was dropped while it gathered. Resolves `{ code, link, withdraw }`: `withdraw()` closes the invite's PeerConnection unless an answer already took it — call it when the invite is cancelled or replaced |
| `natHard` | this network's NAT maps one local port to different public ports per destination (`true`), does not (`false`), or unknown (`null`). Set by room-join from `NeonArcade.classifyNat()` — in parallel with the dial, never awaited, and asked again on isolation and on `online` / `navigator.connection` `change`; pin it with the `natHard` option |
| `dropInvites(forPeer)` | close every invite minted `forPeer` that no answer has taken — an invite never expires on its own, so whoever knows it will not be answered (the far side's glare rule set it aside, the peer went away) drops it. One that took an answer is left to finish. Returns how many it closed |

`makeAction` is idempotent: calling it twice with one name returns the same
channel, so `room.makeAction("state").send(...)` inside a helper is fine.

`createHost`/`createGuest` take `onLeave(reason)`, called once on every exit:
`"left"` (`leave()`), `"evicted"` (the host removed us), `"closed"` (the
party was deleted) or `"detached"` (`detach()`). `lib/room-join.js` uses it to
release the room-server claim — on every reason but `"detached"`.

`onError(message, info?)` carries `info.reason === "no-route"` when a link
failed ICE and we hold no other — the pair has no path (no TURN).
`onRouteFailed(peerId, { offered, message })` comes first, for a link made
with `createInvite`/`answerInvite` on its first try: return true when you can
still signal that peer, and swap the roles — offer back with
`createInvite({ forPeer, retry: true })` if we answered, or expect their offer
if we offered (the no-route verdict then waits 8 s for it). room-join does
this over the room server. And `onIsolated()` fires when the *last* link
closes while the roster still has people: the mesh has nothing left to
renegotiate over, so room-join re-dials the room server to be offered to again
([network-testing.md](network-testing.md)).

A direct link both ends have described that has not opened 20 s later
(`room.openTimeoutMs`) is failed as ICE `failed` would be — once ICE is up
(DTLS/SCTP still retrying) it gets one more period first. The offerer's clock
starts in `acceptAnswer`. The answerer's starts only with
`answerInvite(code, { watch: true })`, which is for an answer a machine
delivers (room-join passes it). The scan/paste flows (party.js, lobby.js) call
`answerInvite(code)` without it: a person carries that reply back, for as long
as it takes.

**Shared handshake pieces** (lib/lobby.js; `party.js` requires it to be loaded
first, which `src/main.tsx`'s import order does):

| export | description |
| --- | --- |
| `NeonArcade.el(tag, props)` | the small DOM builder the party screen uses |
| `NeonArcade.savedName()` / `rememberName(name)` | the display name remembered in `localStorage` (`neon.name`) |
| `NeonArcade.shareBlock({ label, hint, value, qrValue, linkValue, title })` | a code box with a copy button and a QR; a labelled `.share` card when `label` is given. `linkValue` adds a second copy-as-link button so the QR stays small |
| `NeonArcade.replyEntry({ room, setStatus, placeholder, scanPrompt, onConnected })` | the inviter's reply box with CONNECT / PASTE / SCAN REPLY. Returns `{ nodes, row, close }` — place `nodes`, add buttons to `row`, and always call `close()` on teardown (it stops the camera) |
| `NeonArcade.ask(question, { ok, cancel })` | a yes/no question in the page's own `<dialog class="neon-ask">` (buttons `[data-ask="yes"]` / `[data-ask="no"]`); resolves `true` for yes. Never `confirm()`: it freezes the page's JS — the host's game loop and the mesh's relaying with it. Escape and a tap outside mean no; a second question dismisses the first |
| `NeonArcade.toast(text, kind)` | a notice over whatever is on screen (`.neon-toasts`, under the portal link), `kind` `"good"` / `"warn"`; takes no taps, gone after 4.5 s, at most 3 |
| `NeonArcade.presence()` | `{ sync(room), left(room, id, info) }`: feed it every roster callback and it toasts what changed — joined, left (with the reason), lost connection (after 2.5 s still lost) and back, the crown moving (after 1.2 s still moved). The first sync with a room is silent |
| `NeonArcade.guardParty({ room, askAlone })` | register the page's party: `room()` returns the live room or null. From then on "← Games" (and any `a[data-leaves]`), back / swipe-back (a history entry pushed on the first tap) and `beforeunload` (only with another person present) all go through `leaveParty`. `askAlone` (boolean or function): ask even with nobody else here (the party shell, except a party a game's address opened) |
| `NeonArcade.leaveParty(question)` / `leaveQuestion(room, question)` | ask (naming the heir, for a host), then `leave()` and wait for `roomSettled()`; resolves `true` once it may navigate, `false` if they stayed. Not asked, it still leaves — that is what drops the rejoin token |
| `NeonArcade.REPLY_NOW` / `NeonArcade.replyFailed(setStatus)` | the replier's side of a hand-carried reply: the "do it right away" sentence for the reply screen (between some networks a reply works for ~15 s — [Honest gaps](#honest-gaps)), and, on a `no-route` before the link ever opened, the error status plus `{ hint, again }` — a hint node and a MAKE A NEW REPLY button (a reload: the same `#i=` invite answered afresh) for the caller to place |

## Bots

**There is no single-player section, and no single-player mode.** Every game is
multiplayer; a game played alone is one whose other seats are bots. That
collapsed a split the portal used to advertise — "Single Player" and
"Multiplayer" as separate shelves — which had the effect of telling somebody
holding one phone that three of the four games were not for them.

A bot is **an ordinary member of the party record**. It has an id, a name, a
team and a seat, it appears in every peer's roster, and `seats()`, `players()`
and `checkRoster()` count it exactly like a person. Two consequences follow, and
they are the whole design:

1. **No game module had to learn what a bot is.** A game reads `seats("B")[0]`
   and neither knows nor cares whether a browser is behind it. `ctx.isBot(id)`
   and `ctx.botSeats(team)` exist for the games that want to give one a brain.
2. **Only the host runs them.** Every game here is already host-authoritative —
   the host owns the board, the knot, the swarm — so the side that plays a bot
   is the side that was refereeing anyway. A bot's move is applied through the
   same function a person's tap goes through, and the broadcast that follows is
   indistinguishable. When the crown moves the bots stay, and the new host
   plays them — from the running game if it is handed over (below, Honest
   gaps), else from the next one. They used to be dropped, which cost the
   party its bots every time a host's connection blinked.

Bot ids are prefixed `bot_` so the **routing** code can recognise one from an id
alone, without consulting the record. That matters in four places in `net.js`,
and each is a bug if forgotten: `_meshUp` must not try to open a connection to
one (a full ICE timeout, every roster change, forever); a broadcast must not
count one as a peer somebody has to relay to; `_ranked` (behind `_heir` and
`heir()`) must never nominate one for the crown, and neither may
`transferHost`; and `_vacateCrown` must drop them all, because the only browser
simulating them has gone.

Where the brains live:

| Game | Brain | Where |
|---|---|---|
| Connect 4 | minimax + alpha-beta, 5 plies, centre-first move ordering | `games/connect4/connect4.js` |
| Neon Survival | steering: inverse-square flee from enemies, drift to gems, wall push-off, speed-capped | `games/neon-survival-mp/neon-survival-mp.js` |
| Neon Bid | marginal points (plus a share of the rainbow) + half the leader's gain, scaled by credits per lot it can expect to win, ±15% noise | `games/neon-bid/neon-bid.js` (`NeonArcade.neonBidRules.botBid`) |
| Neon Fission | every legal cell simulated in full (chains included) and judged (material, safe corners and edges, loaded cells, cells beside an enemy one orb from bursting); the best 8 checked against the next player's strongest reply; takes a win at once | `games/neon-fission/rules.js` (`botMove`) |
| Draw & Guess | none — `bots: false` in its registration | — |

Draw & Guess opts out on purpose. A bot that draws is replaying a canned doodle
and a bot that guesses is reading the word it was handed; neither is an
opponent, and both make the round worse for the people actually playing. The
lobby and the party screen both say so rather than offering a button that
disappoints.

Neon Survival's bots are the one case that needs the wire: every ship's position
reaches other players as a `pos` message, so the host publishes a bot's with
`room.emitAs(botId, "pos", …)`, which sends to real peers **and** delivers
locally (an ordinary broadcast never comes back to its sender, so without that
the one browser running the bot would be the one that never saw it move).

## Hidden information

Two problems stand between this architecture and any game with a secret, and
they need different answers. `lib/secrets.js` has both, and a game reaches
them as SDK v2 shell services: `seal.*`, `commit`, `verify` (docs/sdk-v2.md,
"The catalogue").

**A "private" message is not private.** `makeAction().send(data, { target })`
is *addressed*, not sealed. With no TURN server, a pair that cannot connect
directly is routine, and `net.js` then relays the envelope through whichever
peer can reach both — another player's browser. Your hand travels through the
hands of the people you are hiding it from.

```js
arcade.send("seal.listen", { ch: "hand" });   // every phone: publishes its key too
arcade.on("sealed", ({ ch, d, from, to }) => ch === "hand" && render(d));
await arcade.request("seal.send", { ch: "hand", to: playerId, d: cards });  // sealed end to end
```

Each browser publishes an ECDH public key on its own **party record** — chosen
over a broadcast because the record already replicates to late joiners
wholesale, so somebody arriving mid-hand learns every key published before they
existed with no re-announcement protocol to get wrong. `room.setMeta()` is the
door to that record; it refuses the fields the record owns (`id`, `name`,
`team`, `bot`, `joined`, `host`).

A message to a **bot** never reaches the wire at all: the host plays it, so the
channel delivers it locally with `to` naming the bot, and a bot brain reads its
private state through the same handler a person's does.

**The host can read everything**, because it is a player refereeing state it is
a legitimate recipient of. No addressing fixes that; commitment does.

```js
const c = await arcade.request("commit", { value: myFleet });   // { digest, nonce }
publish(c.digest);                                               // now
publish({ value: myFleet, nonce: c.nonce });                     // at the reveal
const { valid } = await arcade.request("verify", { digest, nonce, value });  // everyone checks
arcade.send("session.set", { key: "fleet", value: JSON.stringify({ myFleet, ...c }) });  // survives a reload of this tab
(await arcade.init).session.fleet;                               // ...and comes back after one
```

**A reload must not turn an honest player into a cheat.** A reload keeps the
seat but not the page, so a commitment held only in a closure is gone: the
player cannot open it, and the audit then flags them. `session.set` keeps it
in this tab's session storage, which the shell holds for the frame (a
sandboxed frame has none), and `init.session` hands it back after a reload
(lib/secrets.js `keep`/`kept` is the same idea in the shell). A kept value is never
trusted by itself — Battleship, Liar's Dice and Neon Bid take it back only
when the digest the host published for them is its digest (or, for a bid
still being collected, when the host already counts them in). Battleship
also re-sends a returner the last volley, whose answer they owed while away.
The re-sync itself comes from the party shell: a member who mounts a running
game says so, and the host's game re-sends its state (`onPeerJoin(id,
{ back: true })`, lib/party.js). Draw & Guess replays the canvas so far.
test-worker section 10 reloads a guest mid-game in six games.

The digest is taken over a **canonical** serialisation — object keys sorted at
every depth — because `JSON.stringify` preserves insertion order, so a value
that has been through the network can serialise differently from the one that
was hashed. That is a verification failure with no bug behind it.

Both halves need WebCrypto, which needs a secure context. The arcade is served
over https (or loopback), which is one — but the check is made at runtime: with
no WebCrypto, `seal.send` is refused ("no WebCrypto") rather than silently
sending in the clear (lib/secrets.js `privacy()` is `"plain"`). A game with a
secret should refuse to deal then.

### The worked example: Battleship

`web-games: battleship/battleship.js` is what this was built for, and it shows the pattern in
full. Nobody holds anybody else's fleet — not even the host. Each player commits
to a fleet before a shot is fired, answers hit-or-miss for their *own* board
during play, and opens the commitment at the end.

**Verifying the digest is not enough**, and this is the part that is easy to get
half right. A digest proves only that the fleet was decided before the shooting
started; a player can commit honestly and then simply lie about a hit. So the
reveal runs two checks — the digest against the revealed fleet, **and** every
answer replayed against it. A third catches the fleet that was legal-looking but
overlapping. `battleship/test-battleship.mjs` (web-games) tests the audit by breaking it four
ways, because a commitment nobody can fail is decoration.

Battleship uses `commit`/`verify` but **not** the sealed channel: a fleet never
crosses the network during play at all, so there is nothing to seal.

### Liar's Dice, and the correction it forced

Liar's Dice was expected to be the sealed channel's first user — the host deals
five dice to each player, privately. **That build is wrong**, and the reasoning
is worth keeping. `secrets.channel()` seals a message against the *peers
relaying it*; it cannot seal anything against the sender. A host that deals is a
host that has read every cup, and the host is a player.

So Liar's Dice does what Battleship does: each player rolls **their own** dice
locally and publishes a commitment before a bid is made. Nothing about anybody's
hand crosses the wire until somebody calls, and then everything does at once and
every commitment is checked.

The generalisation: **commit-reveal is the answer whenever players can generate
their own secret.** The sealed channel only earns its place when one party must
know something the others must not — a **shared deck**, dealt without
replacement, where the hands must be disjoint and no player can roll their own.

### Neon Bid: a bid is a commitment

`games/neon-bid/neon-bid.js` ([design](neon-bid.md)) is the third user of the pattern,
and the simplest: the secret is a single number. Each player commits to
their bid in a `collect` phase, opens it only after everyone has committed,
and the host audits each opening **twice** — against its digest, and against
the bidder's credits *snapshotted before the await* (the Liar's Dice race).
A bad opening counts as 0, so it neither wins the lot nor sets the winner's
price. The lot order is shuffled once and published before the first bid, so
the host — a player — knows nothing the others do not.

Bots' bids are decided and committed while the previous lot is on show,
because `botSubmit` is synchronous and `commit` is not (the Battleship
trap); a backstop `submitFor` covers a commitment that is late.

### The sealed channel has no user

Nothing in the arcade uses `secrets.channel()` today. That is worth stating
plainly rather than leaving the module looking load-bearing.

It was built for a real problem — an addressed send is relayed *in plaintext
through another player's browser* whenever a pair has no direct link — and it is
proven against that by `scripts/test-plumbing.mjs`, which reads the bytes that
cross a relaying peer. But no game has needed it. Twice now the obvious
candidate turned out not to: a fleet and a roll of dice can each be generated by
the player who owns them, so both games commit instead and send nothing.

**Oh Hell, a trick-taking game off a shared deck, was built and then removed.**
It did use the channel — hands off one deck must be disjoint, so somebody has to
deal — and it worked. It was dropped because of what sealing *cannot* do:
protect a hand from the dealer. The host deals, the host is a player, and no
commitment fixes that because the host also chooses the shuffle it would be
committing to. The real answer is mental poker — a deck encrypted commutatively
by every player, which nobody can read and everybody can shuffle — and until
that exists, a dealt game here has a player who knows everything.

So the rule stands, and it is the useful part: **commit-reveal is the answer
whenever players can generate their own secret.** The sealed channel is for the
case where they cannot — and that case also needs a dealer nobody has to trust.

## Rounds and phases

`lib/rounds.js` is the clock Draw & Guess wrote by hand, generalised. The host
owns it and peers mirror; time crosses the wire as a **duration, never a
timestamp**, because two phones' clocks disagree by more than these phases last.
A game reaches it as the SDK v2 `timer.*` service (docs/sdk-v2.md); the shell
runs the clock.

```js
// every phone opens the same clock; the host's runs it
arcade.send("timer.open", { name: "t", rounds: 5, bots: true,
  phases: [{ name: "lock", ms: 20000, collect: true }, { name: "resolve", ms: 3000 }] });
arcade.on("timer", (m) => {
  if (m.ev === "phase") render(m.info);                          // every phone
  if (m.ev === "bot") arcade.send("timer.do", { name: "t", op: "submitFor", bot: m.bot, value: chooseFor(m.bot) });  // host
  if (m.ev === "collect") resolve(m.entries);                    // host only
});
if (arcade.isHost()) arcade.send("timer.do", { name: "t", op: "start" });
arcade.send("timer.do", { name: "t", op: "submit", value: answer });   // anybody
```

A phase marked `collect` ends **as soon as every seated player has submitted**,
or at its deadline, whichever is first. That one rule is what makes
simultaneous-turn games work over this transport: nobody is racing anybody, so
a slow link costs its owner nothing and the host never arbitrates who acted
first. The `bot` event (`botSubmit` in lib/rounds.js) exists because a
collecting phase would otherwise wait out its deadline for a seat with no
browser behind it.

Peers see *who* has submitted, never *what* — the submissions themselves never
leave the host until its `collect` event decides what is public.

Battleship runs **two** schedulers, which is what `name` is for: placement is a
single collecting phase that ends the moment both fleets are committed, and the
battle is many, each ending the moment both players have picked a square. One
trap worth knowing — `botSubmit` is synchronous and `commit` is not, so a bot's
fleet and commitment have to be built and cached *before* the placement phase
opens. Liar's Dice cannot do that, because the number of dice changes every
round; it uses `rounds.submitFor(botId, digest)` from inside the phase instead.

`next` (`timer.do` op `next`, lib/rounds.js `rounds.next()`) ends the current phase immediately. Liar's Dice needed it — the
bidding is over when somebody calls a bluff, which is a game event and not a
clock — and Draw & Guess uses it too, so that everybody guessing correctly ends
the drawing phase instead of running out its sixty seconds.

**Draw & Guess now runs on this.** It is the game the scheduler was generalised
*from*, and moving it over is what proved the generalisation was real: a `phase`
string, a chain of `setTimeout`s, and a re-check inside every callback that the
phase it woke in was still the phase it was scheduled for, all became one
declaration. The re-check is gone entirely, because a disposed scheduler fires
nothing. `timeLeft` also stopped being broadcast — every peer counts down for
itself from the duration the host sent, and `test-party.mjs` asserts that three
peers agree on the clock to within a second.

## Games played on one device

`local: true` in the registration (`"kind": "local"` in game.json) says a game is
played by people **in the same room, on one phone, passed from hand to hand**.
`games/undercover/undercover.js` is the first; since 2026-11-14 it is an SDK v2
game on Layer 1 that speaks only to the shell (storage, session, result).

This is not a lesser kind of multiplayer. It is the answer to the cost this
whole project is organised around: a handshake is paid once per person, and for
six people round a table that is five handshakes to play a game nobody needed a
second screen for. A local game skips all of it — there is no room, no peers,
and no invite.

What the flag changes is small and deliberate:

- `NeonArcade.checkRoster` stops enforcing seats. A local game's players are
  names typed into one phone, not rows in the party record, so one member in
  the party is a perfectly good six-player game.
- `lib/lobby.js` offers a plain **START** instead of INVITE A FRIEND / PLAY A
  BOT. There is nothing to connect and nobody to wait for.

Everything else is the ordinary game contract. The game keeps its own list of
players and ignores the party's members entirely.

**What such a game is actually responsible for** is narrower than it looks. The
describing, the arguing and the voting happen between people; the phone deals
the secrets, remembers who is out, and — the only part that really matters —
never shows a secret to the wrong person. Undercover takes two deliberate taps
to reveal a word and one to hide it, and `scripts/test-bots.mjs` asserts that
nothing is on screen (or in the DOM) before the tap and nothing is left after
the pass. The hand in progress is kept in the game's session (`session.set`
"hand"), so a reload mid-hand carries on, but `revealed` is never kept: a hand
reloaded mid-deal comes back on "Pass to …" and needs the tap again (also
asserted there).

Two traps found building it, both of which look like a sulky game rather than a
bug:

- **The table must survive one wrong vote.** The undercovers win at parity, so a
  table needs `n >= 2*others + 2`. Five players with one undercover *and* a
  blank does not: three against two, over the moment the table guesses wrong,
  before anybody has spoken twice.
- **No word may appear in two word-pairs.** A player who has seen the list
  before could otherwise rule out the other half. The test caught "Violin" in
  two pairs.

**The words** live in `games/undercover/words.js`: about 750 pairs across 14
topics (Food & drink … Science & space), each split into *easy* pairs (the same
family, pulled apart within a round) and *hard* ones (nearly the same thing —
Butterfly / Moth). The host ticks any set of topics and a difficulty on the
WORDS screen; everyone is told the topic on the reveal, never the word. The
phone keeps the keys of pairs it has dealt in its storage (`store.set` "seen") and draws
only unseen pairs until a pool is spent (`drawPair`), so a table that plays
every week works through the whole list before meeting a pair again. Points
carry across hands, and across reloads (storage "scores") — civilian 1, undercover 3,
blank 4, to everyone on the winning side — and reset on RESET SCORES.
`scripts/test-undercover.mjs` holds every topic to at least 20 pairs per
difficulty and still forbids a word in two pairs anywhere in the list.

## Adding a game

The author's guide is [CONTRIBUTING.md](../CONTRIBUTING.md) (layout, the
seven Tic Tac Toe examples, the dev kit, checking, proposing); the protocol a
game speaks is [sdk-v2.md](sdk-v2.md); what the platform asks of a game — the
manifest, the sandbox, results, the rules — is [platform.md](platform.md). A
game is a folder with a `game.json` (`"sdk": 2`) in this repo's `games/` or in
the author's own repository, pinned in `registry/`.

A game's address, `./?game=<id>&fresh=1`, is a **shortcut into the party
shell** (since 2026-11-13): the host gets a quick start for that game (INVITE
A FRIEND, PLAY A BOT, START GAME) before the ordinary party screen
([The party API](#the-party-api), `mountParty`). There used to be a separate two-player lobby on
each game's own page, without join by code, rejoin after a reload, PARTY, END
GAME or the turn banner's choices; Lokesh chose one connection path over
teaching it all that, and the pages themselves were deleted on 2026-11-15. A
game is implemented exactly once, and connected exactly once.

**The shell is Solid + Vite since 2026-11-15** ([spa.md](spa.md)). It was
weighed and rejected on 2026-08-10 and 2026-08-27, when the reactive surface
was about a fifth of the code and opening the HTML from disk (`file://`) was a
supported way to run the arcade. The re-measure of 2026-11-14 found two things changed:
- **The reactive surface** had grown to 35–40% of the shell.
- **Running from disk** (`file://`) was already gone for games, and Lokesh
  dropped it for the shell too.

Moving between pages also dropped the party, which only one page can fix.
The games stay framework-free in their frames, and so do the shell's
libraries (lib/*.js, bundled as modules).

No game the platform tests has more than one player per side of a `teams`
game. Connect 4 reads `seats("A")[0]`; a game with several per side would be
the first to exercise the group reading — test it in the party with a
2-against-1 roster.

## Installing it

The arcade is a PWA: `manifest.webmanifest`, icons under `assets/`, and `sw.js`
at the repo root so its scope covers every page. `lib/pwa.js` registers the
worker and fills any `[data-install-slot]` element with an INSTALL APP button
when the browser says the app can be installed (the portal has one under the
title). Without a secure context (a plain `http://` LAN address) none of
this runs, and the arcade works as before, online.

**The install button is Chromium-only, and that is not a bug here.** It is
driven by `beforeinstallprompt`, a non-standard event that only Chromium
implements — so Chrome, Edge and their relatives get a button and nothing else
ever will. `lib/pwa.js` therefore fills the slot with a sentence instead of
leaving it empty:

| Browser | What happens |
|---|---|
| Chrome / Edge / Chromium | INSTALL APP button, from the held `beforeinstallprompt` |
| Firefox on Android | hint: install from the ⋮ menu — Firefox can, the page cannot ask |
| Firefox on desktop | hint: it cannot install web apps at all (removed in Firefox 85, not restored) — but the page still works offline |
| iOS Safari | hint: Share → Add to Home Screen |

**Offline is unaffected by any of that.** Firefox supports service workers and
the Cache API fully, so the arcade caches and plays with no network there
exactly as it does in Chrome — it just lives in a tab. (Firefox does disable
service workers in Private Browsing windows.)

**The caching design (2026-11-14).** Code — the pages, `lib/`, `games/` — must
agree with each other: serving one file from an old deploy beside another from a
new one breaks the app silently, days after the deploy responsible. So code is
served from **one precached snapshot per `VERSION`**, written whole at install
and never refreshed file by file. A page opens from the phone's own storage,
and is always one coherent deploy. `VERSION` is a content hash of every
precached file, written by `scripts/assemble.mjs` into `dist/sw.js` at build
time (with the community games; docs/spa.md), so a deploy is a new
`sw.js`, which the browser's own update check installs beside the old snapshot
and activates — the next page load is the new deploy, whole. The install is
all or nothing: a deploy that cannot be fetched whole leaves the old snapshot in
place. A page already open stays on the snapshot it was loaded from until it
closes, lazy loads and game frames included: each navigation records which
VERSION served it ("pins"), and old snapshots are pruned once no open page uses
them. `test-pwa` checks each of those against a staged deploy.

Until 2026-11-14 code was **network-first** for the same coherence reason, at a
round trip per file and a 3 s wait for any file on a bad link (docs/perf.md).
On a loopback address (`just run`) it still is, so an edited file shows on
reload; tests opt into the real strategy with localStorage `neon.sw=snapshot`.

Icons, fonts, posters and an outside repo's preview gif are **cache-first**,
with no download behind a hit (every portal visit used to refetch every
preview). Preview videos are left to the network: the portal fetches each clip
once with `fetch()` and every card showing that game plays the same `blob:`
URL (lib/portal.js; a card per section had fetched it again, 2026-11-15).
Offline a card shows its precached ~5 KB poster; `assets/placeholder.svg` is
for a card with none.

**A page offline is matched without its query** when the exact URL was never
cached: `./?game=connect4&fresh=1` gets the precached shell, whose script
reads the query. Before 2026-11-13 it fell straight to the portal, so a game
link opened offline depended on having visited that exact URL online. A
framed game's files (`games/<id>/`) are precached like the rest, and so is
its frame, prebuilt at deploy (`frames/<id>.html`, docs/sdk-v2.md). The Python runtime
(`sdk/pyodide/`) is the exception: cached on first use, in its own cache.

**Do not put an SVG in the manifest's `icons`.** Listed with `sizes: "any"`,
Chrome selects it as *the* install icon, refuses it, and reports
`no-acceptable-icon` for the entire set — the app becomes uninstallable while
every hand-written check still passes. This was caught only by asking Chrome
through CDP, which `scripts/test-pwa.mjs` now does on every run. The SVG remains
the favicon via `<link rel="icon">`.

**The app mark is "linked players"**: two joysticks, one per player, joined by
one cable (2026-11-14). `assets/icon.svg` holds it in the Paper theme's
dark-mode colours as fixed hex: slate tile `#111419`, player 1 in the accent,
player 2 in accent-2. An installed icon cannot follow the theme. The manifest's
`background_color` and `theme_color` match the tile. The portal's title is a
lockup (`h1.brand` in `index.html`). It draws the same glyph inline, coloured by
theme tokens, so it follows Paper light, Paper dark and Neon. Change one and you
must change the other. The SVG must also stay strict XML, because a browser
loads the favicon as a standalone file and refuses the whole thing over one
`--` in a comment. `make-icons.mjs` pastes the SVG into HTML, which forgives
that, so the PNGs give no warning. From 2026-08-16 to 2026-11-14 no tab showed
the icon for exactly this reason. `test-pwa` now parses the file.

## Honest gaps

- Per-game design notes and a decision log are still missing.
- Scanning is verified at realistic code density — a reply code occupying part
  of a full-resolution frame, preceded by seconds of empty aiming frames, on a
  CPU throttled to phone speed — but via a fake capture device, **not** a real
  phone camera. Nothing here reproduces glare, autofocus or motion blur. A
  640x480 webcam is recorded as passing at close range only; below that, PASTE
  is the answer.
- The mesh is tested with three peers; nothing has exercised the 8-player cap.
  The relay path *does* now run in anger: `test-nat.mjs` scenario 4 puts two
  peers behind symmetric NATs, which cannot link, and their messages arrive
  through the third.
- Bot *strength* is now measured for two. Neon Bid's wins every one of 2,000 games against a
  random bidder and against one that spends evenly (`test-neon-bid.mjs`, which
  prints the rates); Light Cycles' wins 30 of 30 against a rider that only
  avoids crashing, and a per-tick budget assertion keeps the search inside its
  own tick with eight bots running. The other four are still asserted only
  negatively — Connect 4's is checked never to leave an immediate win on the
  board, which is not the same as checking it plays well — and **nothing
  measures whether any of them is fun to lose to**. Light Cycles' bot may in
  fact be too strong; that is a judgement no test here makes.
- **`secrets.channel()` has no user.** It is proven by `test-plumbing.mjs` and
  by nothing else. See the section above for why two likely candidates turned
  out not to need it, and why the one that did was removed.
- **Undercover trusts the room.** Anyone can look over a shoulder during the
  deal, and the phone cannot know. Two deliberate taps and an immediate hide are
  the whole defence, which is the same defence the card game it descends from
  has.
- `scripts/test-bots.mjs`'s Neon Survival check "the bot ships are being
  flown, not parked" is **intermittently flaky** — failed 2 of 8 runs on
  2026-11-12 (both inside a full `just test`; standalone 0 of 5, and 0 of 1
  with the new Neon Bid section removed). Not investigated; the page is
  reloaded between sections, so no state is shared with the section before it.
- The crown term converges two hosts on one, but **the term itself is not
  authenticated**: any member can publish a record with a higher term and take
  the crown, exactly as before the term existed any member could publish one
  naming itself host. A member that wrongly concludes the host is gone *and* is
  its own computed heir crowns itself, and the real host steps down; the party
  converges, but on the wrong host. Tested over a fake transport only
  (`test-plumbing.mjs`); no real partition has been staged.
- When two direct links to the same peer open at once, each side keeps the one
  that opened *last* and closes the other. If the two sides disagree on the
  order, both links close and the pair falls back to relaying until the next
  roster change. Not observed; reasoned from the code. The one place two
  offers were *made* likely — two isolated members re-announcing to the room
  server together, or a reload's returner and the member who stayed — now
  has a glare rule in room-join (a hard-NAT side's offer stands, else the
  lower id's); relayed negotiation already had one.
- **A reply carried by hand has ~15 s between some networks.** Measured
  2026-11-12 between a carrier NAT that connects only as the offerer and an
  institute NAT: the replying side's own ICE gives up ~15.6 s after its
  reply is made (Chrome's verdict, not ours), and the scan/paste flow has no
  signalling channel to rebuild the link over — inherent without TURN. A
  reply carried back later links to nothing; with the restrictive side
  replying it never links. The reply screen says to carry it back right
  away; a reply that fails says it was not used in time or the networks
  cannot connect directly, and offers MAKE A NEW REPLY (the same invite,
  answered afresh) or a new invite if the old reply was used. Nothing waits.
  Join by code has no such window (the room server carries the reply and the
  role swap). The UI is tested with a forced ICE failure (test-party,
  test-bots); the 15 s itself only on the real pair.
- A relayed negotiation is abandoned after 15 s and tried once the other way
  round (2026-11-12, for NATs that connect in one direction only); after
  that nothing retries it on a timer — the next roster change does. A pair that failed once stays
  relay-only until somebody joins, leaves or is edited. A direct link that *drops* while
  the member stays reachable is different. The second vouch for it, 2.5 s
  after the drop, dials it again (net.js `_vouch`, 2026-11-16). The second,
  not the first, so that a stale vouch for a member who is leaving does not
  cost an offer. Left relay-only, a pair split in two when their relay, the
  host, left. A drop is often seen at one end first. When the higher id still
  holds the dead link, it sets aside the lower id's offer, and a resend of
  that offer would be dropped as already seen. So when the higher id notices
  and asks about the lower id (`__q`), the lower id abandons its offer and
  makes a fresh one (`_redial`). It abandons only an offer already sent: one
  still gathering is left to go out, and an offer abandoned while it gathers
  is never sent. Each offer carries a nonce that its answer echoes, so an
  answer to an abandoned offer cannot land on the one that replaced it.
- The 3 s grace on `disconnected` is observed in the NAT lab, not on a phone:
  4 s and 8 s blackouts keep the link; Chrome itself declares `disconnected`
  some seconds in, so a link survives a blackout of roughly 9 s. It cannot
  rescue a network *switch* (nothing performs an ICE restart); that heals by
  the member re-announcing itself to the room server once its last link
  drops, measured at ~10.5 s from switch to links back. A classic (no room
  server) party has no such path: a switched member is simply gone.
- `leave()`'s `__gone` is best-effort: it is handed to the channel, which is
  kept alive 250 ms to drain. A page that navigates away instantly may cut it
  off, and the peers then fall back to the probe (and, for a room-server
  member, the reconnect grace).
- **A crown that moves under a running game hands it over** (2026-11-13). Every
  game keeps its state on its host, but each sends it to everyone, so 1.5 s
  after the move (a flicker that settles back changes nothing) the new host
  calls the game's `takeOver()` and carries on from what it was sent; the old
  host's seat is held like any lost player's (the turn banner covers a turn
  of theirs), and an old host whose tab survived the blip remounts as a guest.
  What is lost is whatever lived only on the old host, so: Connect 4
  continues where it was; Light
  Cycles restarts the round, wins kept; Neon Survival takes the bots' ships
  over from where they were last seen; Draw & Guess goes on if the new host
  knows the word, else restarts the round with a new one; Liar's Dice re-rolls
  the round, dice kept; Neon Bid reopens the unsettled lot, credits and gems
  kept (Lokesh's choices). **Battleship ends** ("…so the game ended."): the
  bots' fleets left with the old host. Undercover is one device. Not covered:
  a game's in-flight message the old host never relayed; Neon Survival's
  first seconds under the new host include the 3-2-1 (the old host's closed
  tab read as out of the app). test-worker 14, test-party.
- **Battleship's audit is never triggered in real play**, because no player here
  can cheat: every client runs the same honest `answerShot`. The audit is tested
  against deliberately corrupted answers, which is the right test, but a genuine
  modified client has never been pointed at it.
- Battleship's placement auto-commits a few seconds before the deadline so a
  player who walks away cannot stall the game. That path is not covered by any
  test — it takes 142 seconds to reach.
- Neon Bid's bot may be too strong for a casual table: it beats both baseline
  bidders in every measured game, and nothing here measures it against people.
  Its audit, like Battleship's, has only been tripped by deliberately broken
  openings in the rules test — every real client opens honestly.
- Liar's Dice trusts each player's *roll*. The commitment stops a player
  changing dice after seeing a bid, which is the cheat that decides rounds; it
  does nothing about a modified client that re-rolls until it likes its hand,
  and nothing short of a shared random beacon would.
- Draw & Guess's word still goes to the drawer **addressed, not sealed**. A
  relaying player could read it. That is the honest level of protection for a
  party game whose worst case is a spoiled round, but it is a choice, not an
  oversight.
- Onitama was removed 2026-11-13 (Lokesh): it recreated a published board
  game, which the platform's own rules (CONTRIBUTING.md) do not allow.
- The Firefox install hints are reasoned from the platform, not observed.
  Firefox's *multiplayer* is verified (2026-11-12): `just test-pair
  --browser=firefox` on production, Firefox↔Chrome and Firefox↔Firefox
  across two real networks, every phase passed, and `classifyNat` reads the
  carrier NAT hard there as in Chrome (docs/network-testing.md). Every other
  suite runs headless Chrome.
- Cross-network play over mobile data is expected to fail on carriers using
  CGNAT/symmetric NAT — confirmed in the wild on 2026-08-10, and reproduced in
  the NAT lab (symmetric vs symmetric, and symmetric vs a port-restricted
  cone: explicit error at ~15 s, ~30 s for a code join since the role-swapped
  second try of 2026-11-12). This is the no-TURN trade-off, not a bug;
  the error now names which case you hit. The lab's NATs are Linux's; no real
  carrier's has been modelled (see network-testing.md, "What it cannot show").
- There is no TURN server by choice, so players behind symmetric NAT cannot
  connect at all; this surfaces as an explicit error, not a hang.
- Installability and offline are verified against headless Chrome only. No real
  phone has been asked to install it, and iOS in particular is unverified: it
  ignores the manifest's icons, gets no install event, and Safari's service
  worker eviction rules are its own.
- A deploy reaches an open page only on its next load; an installed app left
  open for days stays on the deploy it opened with. Nothing tells the player a
  newer one is waiting.
