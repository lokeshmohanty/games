# lib/ — shared P2P multiplayer core

Multiplayer for vanilla-JS browser games with **no server and no third-party
service**. No build step, no dependencies, no accounts.

Two browsers cannot find each other on their own, so instead of outsourcing
that to a signaling server or a public relay, the *players* carry the handshake
once: someone generates an invite, sends it however they already talk, and the
newcomer sends one code back. After that all game data flows directly between
the browsers over encrypted WebRTC data channels.

The important word is **once**. Every connection after the first is negotiated
over the connections that already exist, so a party of six costs one manual
handshake per person and nothing else.

## Files

- **`net.js`** — `NeonArcade.createHost()` / `createGuest()`: the mesh, the party record, typed message channels.
- **`games.js`** — `NeonArcade.registerGame()`: the registry every game plugs into, plus `mountGamePage` for single-game pages.
- **`party.js`** — `NeonArcade.mountParty()`: the persistent party screen — roster, teams, game switching, host handover.
- **`lobby.js`** — `NeonArcade.mountLobby()`: the invite/answer UI used by the per-game pages, plus the bot controls that let one person start a game alone.
- **`room-join.js`** — `NeonArcade.hostRoom()` / `joinRoom(code, { signal })` / `rejoinToken()` / `releaseRejoin()` / `roomServerReachable()`: client-side glue for the optional Cloudflare-Worker room server (`worker/`). Joins are by six-digit code over a WebSocket; `joinRoom` resolves only once a link is open *and* a host is known (never into a hostless party), and an `AbortSignal` cancels it, releasing the claim; rejoin tokens survive a reload. `releaseRejoin()` gives a claim back with a `release` that never binds, resolving `"busy"` (token kept) when another tab holds the seat live. The server is `localStorage["neon.rs"]` or the default; `?rs=` only when it names a loopback server; the reachability probe is `GET /ping`. A tab whose seat another tab of the same browser took over (same token; the server hangs up with 4409) stands down and calls `opts.onDisplaced()` instead of re-dialling. Falls back to the classic scan/paste flow when the server is unreachable. See `docs/room-server.md` for the design and `worker/README.md` for deployment.
- **`qr.js`** — `NeonArcade.qrCanvas()`: a self-contained QR encoder, so invites can be scanned instead of typed.
- **`qr-decode.js`** — `NeonArcade.qrDecode()` / `scanQr()`: a self-contained QR *decoder* plus a camera scanner.
- **`secrets.js`** — `NeonArcade.makeSecrets(room)`: sealed private channels (so a *relaying player* cannot read a dealt secret) and commit-reveal (so the host cannot either). Optional. `games/battleship.js` is the worked example for commit-reveal, where verifying the digest is only half the check; **no game currently uses the sealed channel** — see `docs/index.md` for why.
- **`rounds.js`** — `NeonArcade.makeRounds(ctx, spec)`: the host-owned round/phase clock, including `collect` phases that end when everyone has submitted and `next()` for a phase that ends on a game event. Optional. `games/draw-guess.js` is the game it was generalised from and now runs on.
- **`ui.js`** — `NeonArcade.gameShell(root, opts)`: the stage, status line and overlay every game was rebuilding. Optional, but new games should use it.

A game registered with `local: true` (`games/undercover.js`) is played by people in one room on one device: `checkRoster` stops enforcing seats and the lobby offers a plain START. See `docs/index.md` → "Games played on one device".
- **`pwa.js`** — registers `../sw.js` and fills `[data-install-slot]` with an install button. Optional; nothing else depends on it.
- **`styles.css`** — shared neon theme (link from each game's HTML).

## The handshake

```
INVITER                               NEWCOMER
[ADD PLAYER]
  -> invite link + QR   --(chat/QR)-->  opens the link
                                          -> reply code + QR
  <---(chat, or [SCAN REPLY])------------
  [CONNECT] / [PASTE]
                     …and everyone else connects to them automatically
```

Same room? Nobody types anything: the newcomer scans the invite QR with their
camera, and the inviter scans the reply QR straight back with **SCAN REPLY**.
Apart? The link and the reply code both travel fine through any chat app, and
**PASTE** reads the reply straight off the clipboard.

**Any member can invite, not just the host.** Whoever is standing next to the
new player does the scanning; the introduction reaches the host over the mesh.

## Topology

A **mesh**: every member holds a direct connection to every other member.

This used to be a star, on the reasoning that a mesh would need a manual
handshake for every pair (O(n²) copy-pastes). That is only true without an
existing connection to carry the signalling. Once any link exists, offers and
answers travel over it, so the extra connections cost nothing a player can see
— and `_openRelayed` in `net.js` is where that happens.

The mesh is what makes the party independent of any one member. The host is a
field in the party record, not the shape of the network, so it can be handed
over or inherited without anybody re-scanning anything.

Pairs that cannot connect directly (a NAT that defeats one particular pair) are
not fatal: messages to them are relayed through a member who can reach both,
capped at two hops and deduplicated by envelope id.

## Departure and succession

A dropped link is not the same as a member leaving, so `net.js` asks before
concluding: it broadcasts a probe, and anyone still holding a live link to that
member vouches for them. Silence means gone, and the conclusion is broadcast so
the whole party drops them at the same moment.

A deliberate `leave()` skips the probe: the leaver broadcasts its own `__gone`
before closing, so peers drop the seat at once — including a room-server seat
that would otherwise be held RECONNECTING for the reconnect grace. A reload or
a closed tab never calls `leave()`, which is exactly why that seat *is* held.

If the member who went was the host, the crown passes to the longest-present
remaining member automatically (bots and reconnecting seats excluded); every
browser computes the same heir from the same roster, so no UI offer is needed.
`room.heir()` names that member in advance. The party continues. The only thing
that ends a party is the host explicitly deleting it.

The record carries a crown **term**, bumped by whoever takes or hands over the
crown. A record with a higher term always wins, so a host that was cut off and
comes back steps down on hearing the newer one, and carries the members only it
could reach into the winning record. Two hosts at the same term (a partition
that crowned on both sides) settle on the lower id. A member that merely
*computed* an heir yields to a host that is still speaking at the old term,
which is how a false alarm heals.

A relayed negotiation that has not opened after 15 s is abandoned — and, the
first time, tried once more the other way round (the higher id offers: some
NATs connect only when *they* offer) — so the next roster change can try that
pair again; nobody offers to a seat held for a
reconnect until its owner is back. A link reported `disconnected` gets 3 s to
recover (a briefly lost signal often does) before it counts as dropped — which
also adds 3 s to noticing a closed tab, since that arrives the same way.

## Adding a game

A game is one file in `games/` that registers itself, plus a script tag. The
party screen lists whatever registered; no shell code changes.

```js
NeonArcade.registerGame({
  id: "tic-tac-toe",           // stable; used in party state
  name: "TIC TAC TOE",
  blurb: "Three in a row.",    // one line, shown in the switcher
  shape: "teams",              // "teams" | "coop" | "free"
  seats: { min: 2, max: 2 },   // active players, spectators excluded
  bots: true,                  // default; set false if a bot has nothing to do
  mount(ctx) {
    ctx.root.append(/* build your markup */);
    return { unmount() { /* stop timers, drop listeners */ } };
  },
});
```

`mount(ctx)` receives `root`, `room`, `isHost`, `seatOf(id)`, `seats(team)`,
`players()`, `nameOf(id)`, `isBot(id)`, `botSeats(team)` and `end()`. It
**must** return an object with
`unmount()`: games are swapped without a page reload, so anything left running
— a `requestAnimationFrame` loop, an interval, a window listener — will fight
the next game for input. Optional `onPeerJoin` / `onPeerLeave` / `onRoster`
handlers on the same object are called when the party changes under you.

`shape` tells the party screen how to read team assignments: `teams` is Team A
against Team B, `coop` puts everyone on one side, `free` ignores teams. Whatever
the shape, members marked **WATCHING** are excluded from `players()`.

### Bots

A bot is a party member the host simulates. It is in `getMembers()`, it takes a
team and a seat, and every other peer sees it as a player — so **a game that
ignores bots entirely still runs**; it will simply wait for a move that never
comes. To give one a brain:

- Do it **host-side only** (`if (!room.isHost()) return`). Every game here is
  host-authoritative, so the host is already the one deciding.
- Use `ctx.isBot(id)` to notice a bot in a seat, and `ctx.botSeats(team)` to
  list them.
- Apply the bot's move through the same path a person's move takes — the
  broadcast that follows carries it to everyone with no special case.
- Only when the *game's own peers* are what carry the information (Neon
  Survival publishes every ship's position as a `pos` message) reach for
  `room.emitAs(botId, action, data)`, which sends as that bot **and** delivers
  locally.

Set `bots: false` in the registration when a bot would be a parlour trick rather
than an opponent; the lobby and party screen then say so instead of offering a
button. Draw & Guess is the only one.

## Loading

Traditional scripts (not ES modules), so everything works on `file://` as well
as `http://`. Load in this order before the game script:

```html
<link rel="stylesheet" href="lib/styles.css" />
<script src="lib/qr.js"></script>
<script src="lib/qr-decode.js"></script>
<script src="lib/net.js"></script>
<script src="lib/games.js"></script>
<script src="lib/ui.js"></script>      <!-- games built on gameShell -->
<script src="lib/secrets.js"></script> <!-- games with hidden information -->
<script src="lib/rounds.js"></script>  <!-- games with timed or simultaneous phases -->
<script src="lib/lobby.js"></script>
<script src="lib/party.js"></script>   <!-- party.html only; needs lobby.js loaded first -->
<script src="games/connect4.js"></script>
```

## API

### `NeonArcade.mountParty(container, stage)`

The party screen in `container`; mounted games build themselves into `stage`.
Handles joining (`#i=` in the URL), recruiting, teams, switching and succession.

### Shared handshake pieces (`lib/lobby.js`)

The party shell and the game-page lobby walk the same handshake, so
`lobby.js` exports the pieces both use, and **`party.js` requires `lobby.js`
to be loaded before it**.

| export | description |
| --- | --- |
| `NeonArcade.el(tag, props)` | the small DOM builder both screens use |
| `NeonArcade.savedName()` / `rememberName(name)` | the display name remembered in `localStorage` (`neon.name`) |
| `NeonArcade.goJoinCode(raw)` | navigate to `party.html#c=<6 digits>`; returns `false` (and stays put) for anything but six digits |
| `NeonArcade.shareBlock({ label, hint, value, qrValue, linkValue, title })` | a code box with a copy button and a QR; a labelled `.share` card when `label` is given. `linkValue` adds a second copy-as-link button so the QR stays small |
| `NeonArcade.replyEntry({ room, setStatus, placeholder, scanPrompt, onConnected })` | the inviter's reply box with CONNECT / PASTE / SCAN REPLY. Returns `{ nodes, row, close }` — place `nodes`, add buttons to `row`, and always call `close()` on teardown (it stops the camera) |
| `NeonArcade.REPLY_NOW` / `NeonArcade.replyFailed(setStatus)` | the replier's side of a hand-carried reply: the "do it right away" sentence for the reply screen (between some networks a reply works for ~15 s — docs/index.md Honest gaps), and, on a `no-route` before the link ever opened, the error status plus `{ hint, again }` — a hint node and a MAKE A NEW REPLY button (a reload: the same `#i=` invite answered afresh) for the caller to place |

### `NeonArcade.mountGamePage(lobbyEl, stage, gameId)`

One game on its own page, through the plain lobby. Returns `{ game, room,
handle }` with live getters — each page publishes it as `window.__game`, which
is how `scripts/test-bots.mjs` drives the real page.

Seats fall back to a rule rather than a choice. A one-against-one game keeps the
old one: the host is Team A, the first other player is Team B, anyone else
spectates. A team game with `seats.max > 2` deals players out **alternately**
instead, which is the only way a deep link can seat several bots without most of
them watching. `coop`/`free` games put everybody on one side.

### `NeonArcade.mountLobby(container, opts)`

The lobby itself: `gameName`, `game` (the registered def, for seat counts and
bots), `onReady(room)`, `onStart()`, `onPeerJoin(id)`, `onPeerLeave(id)`.

It offers two host paths: **INVITE A FRIEND** (the handshake) and **PLAY A
BOT** / **PLAY ALONE** (no handshake at all — it seats enough bots to make the
game legal and goes straight to START). START refuses on the **seat** count, not
the peer count, so a game with bots in it is startable with nobody connected.

### Scanning

`NeonArcade.scanQr({ onResult, onError })` returns `{ video, stop }` — mount
`video`, and **always call `stop()`**, which releases the camera. It uses the
browser's `BarcodeDetector` when there is one (Android Chrome) and the decoder
in `qr-decode.js` otherwise, since desktop Chrome and iOS Safari have none. A
platform detector that fails is dropped permanently rather than retried: Chrome
exposes one on platforms where the service behind it is missing, and its
rejection must not take the fallback down with it.

`onError` is always delivered asynchronously, so `scanner = scanQr({ ... })` has
finished assigning before any callback can try to clean `scanner` up.

Each frame is decoded from the **centred square at the camera's own
resolution** — the region the 1:1 preview shows. Resolution is never lowered to
save time: a reply code is a 70-90 module grid photographed off another screen,
pixels per module is what decides whether it reads at all, and the frames that
cost the most are the empty ones somebody is still aiming through. Cost is
managed by pass count and pacing instead (`qrDecode(data, { passes })` runs the
cheap binarisation alone; the scanner uses the full ladder every third frame).

Camera access needs a secure context, so scanning works on the deployed
`https://` site but not from `file://`; the lobby says so and falls back to
pasting.

### Room controller

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
| `removeMember(id)` | host only: remove someone (a bot included) |
| `addBot(team?)` | host only: seat a simulated member; defaults to the emptier side. Returns its id |
| `bots()` | every bot in the roster (readable by anyone) |
| `emitAs(botId, action, data, opts?)` | host only: send as a bot, and deliver locally too |
| `NeonArcade.isBotId(id)` | a bot's id is prefixed `bot_`, so routing can tell without the record |
| `deleteParty()` | host only: end it for everyone |
| `leave()` | tell the party we are going (the seat drops at once), then close every connection. Never called on reload/unload |
| `detach()` | close every connection *without* telling anyone, as a reload would — the seat is held as RECONNECTING. For when the same member id is reconnecting from elsewhere (another tab took the seat; room-join's "displaced") |
| `createInvite({ forPeer, retry, hard }?)` | mint an invite (any member). Refuses with `err.reason === "full"` at `maxMembers` — unless `forPeer` names a member who already holds a seat (a reload coming back), whose own seat is not counted against them. `retry` marks the role-swapped second try (below); `NeonArcade._codec.isRetrySignal(code)` reads that mark synchronously. `hard` marks an offer from a hard-NAT network (`natHard`, below; `h.` prefix, `isHardSignal`) for the far side's glare rule. Rejects with `reason: "withdrawn"` if the invite was dropped while it gathered |
| `natHard` | this network's NAT maps one local port to different public ports per destination (`true`), does not (`false`), or unknown (`null`). Set by room-join from `NeonArcade.classifyNat()` — in parallel with the dial, never awaited, and asked again on isolation and on `online` / `navigator.connection` `change`; pin it with the `natHard` option |
| `dropInvites(forPeer)` | close every invite minted `forPeer` that no answer has taken — an invite never expires on its own, so whoever knows it will not be answered (the far side's glare rule set it aside, the peer went away) drops it. One that took an answer is left to finish. Returns how many it closed |

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
this over the room server. And
`onIsolated()` fires when the *last* link closes while the roster still has
people: the mesh has nothing left to renegotiate over, so room-join re-dials
the room server to be offered to again (see docs/network-testing.md).

A direct link both ends have described that has not opened 20 s later
(`room.openTimeoutMs`) is failed as ICE `failed` would be — once ICE is up
(DTLS/SCTP still retrying) it gets one more period first. The offerer's
clock starts in `acceptAnswer`. The answerer's starts only with
`answerInvite(code, { watch: true })`, which is for an answer a machine
delivers (room-join passes it). The scan/paste flows (party.js, lobby.js)
call `answerInvite(code)` without it: a person carries that reply back, for
as long as it takes.

`makeAction` is idempotent: calling it twice with one name returns the same
channel, so `room.makeAction("state").send(...)` inside a helper is fine.

## Connectivity

Messages larger than ~12 KB are chunked and reassembled automatically, and
sends are paused when the channel's buffer fills, so per-frame broadcasts
cannot grow it without bound.

The only external contact is **STUN** (`stun.cloudflare.com`,
`stun.l.google.com`), used to discover each peer's public IP:port. It never
sees game data. Pass `iceServers` to `createHost`/`createGuest` to override,
or `localStorage["neon.stun"] = "host:port"` (or two, comma-separated) for a
whole session — the NAT lab's hook (`scripts/test-nat.mjs`), STUN only.
Deliberately not a query param: a link anyone can send must not choose a
player's STUN server.

`NeonArcade.classifyNat(iceServers?, { fresh }?)` asks those two STUN servers
(two hosts, two ports) where one local socket appears from, remembered per set
of servers unless `fresh` (fewer than two servers: `null`, never remembered):
two different
public ports for one base mean a **hard** NAT (endpoint/port-dependent
mapping), which connects only as the ICE *offerer*. Resolves `true` (two
ports for one base, at once), `false` (an address family with one mapping and
no STUN error of its own, 2 s after its first mapping or at gathering
complete — another family's timeouts do not veto it), or `null` (fewer than
two servers, every mapped family erroring, nothing by 5 s). No
traffic but STUN to servers already configured. room-join stores it as
`room.natHard`, marks that side's offers `h.`, and its glare rule lets a hard
offer stand over a plain one (docs/room-server.md, "Who offers to whom").

Gathering stops shortly after the first server-reflexive candidate rather than
waiting for `complete`, because the rest is usually redundant interfaces — this
is what makes the invite QR appear promptly instead of after the full timeout.
Candidates are otherwise kept as they are, including `.local` mDNS ones: they
look useless off the originating machine, but peers resolve them over multicast
DNS, and on a LAN with no route to STUN they are the *only* way two browsers
connect. The one exception is the ICE-TCP `tcptype active` placeholder, which
two browsers can never pair with each other.

There is deliberately **no TURN server** — running one would reintroduce the
dependency this design removes. A minority of networks (symmetric NAT, some
mobile carriers, locked-down corporate wifi) block direct connections; those
surface as an explicit error rather than an indefinite wait. If you ever want to
cover them, pass a TURN entry in `iceServers`.

## Testing

Games work on both `file://` (double-click the HTML) and `http://`.

```sh
node scripts/test-codec.mjs    # signalling codec round-trip, no browser needed
node scripts/test-party.mjs    # three real browser peers: recruiting, teams,
                               # game switching, host succession
node scripts/test-scan.mjs     # SCAN REPLY against a fake camera, including the
                               # aiming before the code arrives
node scripts/test-pwa.mjs      # installability, portal layout, and offline
node scripts/test-bots.mjs     # every game playable by one person, and no peer
                               # opening a connection to a bot
node scripts/test-plumbing.mjs # sealed channels, commitments and the round
                               # clock, over real routing and a fake transport
node scripts/test-onitama.mjs  # Onitama's rules and search, with no document
node scripts/test-light-cycles.mjs  # the arena simulation and the rider bot
node scripts/test-battleship.mjs    # fleets, sinking, and the reveal audit —
                                    # tested by breaking it four ways
node scripts/test-liars-dice.mjs    # wilds, the bid ladder, the at-least rule,
                                    # and the reveal race that once accused an
                                    # honest player of cheating
node scripts/test-undercover.mjs    # the deal, the win conditions, and the
                                    # table sizes that survive a wrong vote
```

To test two peers by hand, open a game twice — the invite link works between two
tabs, two browsers, or two devices. Note that opening an invite for a page you
already have open is a fragment-only navigation, so the lobby reloads itself on
`hashchange` to pick it up.

```sh
python3 -m http.server 8000
```
