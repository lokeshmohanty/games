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
- **`qr.js`** — `NeonArcade.qrCanvas()`: a self-contained QR encoder, so invites can be scanned instead of typed.
- **`qr-decode.js`** — `NeonArcade.qrDecode()` / `scanQr()`: a self-contained QR *decoder* plus a camera scanner.
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

If the member who went was the host, the crown is **offered** — never assigned
behind someone's back — to the longest-present remaining member, ties broken by
id so everyone nominates the same person. The party continues. The only thing
that ends a party is the host explicitly deleting it.

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
<script src="lib/lobby.js"></script>
<script src="lib/party.js"></script>   <!-- party.html only -->
<script src="games/connect4.js"></script>
```

## API

### `NeonArcade.mountParty(container, stage)`

The party screen in `container`; mounted games build themselves into `stage`.
Handles joining (`#i=` in the URL), recruiting, teams, switching and succession.

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
| `getPeers()` | array of other member ids |
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
| `transferHost(id)` | host only: hand over the crown |
| `removeMember(id)` | host only: remove someone (a bot included) |
| `addBot(team?)` | host only: seat a simulated member; defaults to the emptier side. Returns its id |
| `bots()` | every bot in the roster (readable by anyone) |
| `emitAs(botId, action, data, opts?)` | host only: send as a bot, and deliver locally too |
| `NeonArcade.isBotId(id)` | a bot's id is prefixed `bot_`, so routing can tell without the record |
| `claimHost()` | take a vacant crown (only the nominated heir is offered it) |
| `deleteParty()` | host only: end it for everyone |
| `leave()` | close every connection |

`makeAction` is idempotent: calling it twice with one name returns the same
channel, so `room.makeAction("state").send(...)` inside a helper is fine.

## Connectivity

Messages larger than ~12 KB are chunked and reassembled automatically, and
sends are paused when the channel's buffer fills, so per-frame broadcasts
cannot grow it without bound.

The only external contact is **STUN** (`stun.cloudflare.com`,
`stun.l.google.com`), used to discover each peer's public IP:port. It never
sees game data. Pass `iceServers` to `createHost`/`createGuest` to override.

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
```

To test two peers by hand, open a game twice — the invite link works between two
tabs, two browsers, or two devices. Note that opening an invite for a page you
already have open is a fragment-only navigation, so the lobby reloads itself on
`hashchange` to pick it up.

```sh
python3 -m http.server 8000
```
