# games

Simple client-side web games — single-player and serverless P2P multiplayer.
No build step, no server, no dependencies to install. Just open the HTML files
or serve the folder over HTTP.

## Games

### Single Player

- **[Neon Survival](neon-survival.html)** — Dodge the red, collect the green.
  How long can you survive? Canvas-based, touch and mouse input.

### Party

- **[Start a Party](party.html)** — everyone connects once, then the host
  switches between games without anybody reconnecting. Pick teams, watch as a
  spectator, hand the party over before you leave.

### Multiplayer (P2P, no server)

All multiplayer games connect browsers directly over WebRTC, with **no server
and no third-party service** of any kind. Since two browsers cannot discover
each other unaided, the players carry the handshake themselves: someone
generates an invite link (also shown as a QR code), the newcomer opens it and
sends one reply code back. After that all game data flows directly between
players, end-to-end encrypted.

That cost is paid **once per person**. Every connection after the first is
negotiated over the connections that already exist, so nobody scans anything
twice — and any member can do the inviting, not just the host.

- **[Connect 4](connect4.html)** — Drop your pieces, line up four in a row.
  2-player turn-based. Host-authoritative board with win detection.
- **[Draw & Guess](draw-guess.html)** — One player draws, the rest guess!
  Real-time canvas stroke sync and chat. 2–8 players.
- **[Neon Survival Co-op](neon-survival-mp.html)** — Survive the swarm
  together! Co-op real-time survival. 2–8 players, host-authoritative enemies.

## How to play

### Single player

Open `neon-survival.html` directly in a browser (`file://` works fine).

### A party (several people, several games)

1. Open `party.html` and click **ADD PLAYER**.
2. Send the invite link — any chat app works, or let them scan the QR off your
   screen.
3. They open it and get a short reply code.
4. If they are next to you, hit **SCAN REPLY** and point your camera at their
   screen. Otherwise they send the code and you hit **PASTE** (or paste it and
   hit **CONNECT**).
5. Repeat per person — anyone already in can do this, not just the host.
6. Assign teams, then pick a game. Switch games any time; nobody reconnects.

If the host leaves, the party carries on: the longest-present member is offered
the crown. Only **DELETE PARTY** ends it.

### One game on its own

Each game also has its own page (`connect4.html` and friends) with the plain
two-player lobby: **CREATE GAME**, send the invite, take the reply, **START
GAME**. Use **INVITE ANOTHER** to add more players.

`file://` works for testing on the same machine (open two tabs). For
cross-device play, serve the folder over HTTP:

```sh
python3 -m http.server 8000
```

Then visit `http://<your-ip>:8000` on each device.

## Project structure

```
index.html              # Arcade portal — links to everything
party.html              # Persistent party — roster, teams, game switching
neon-survival.html      # Single-player survival
connect4.html           # Deep link into one game (thin wrapper)
draw-guess.html         #   "
neon-survival-mp.html   #   "
games/                  # One file per game; each registers itself
  connect4.js           # 1v1 teams
  draw-guess.js         # free-for-all, 2–8
  neon-survival-mp.js   # co-op, 2–8
lib/
  net.js                # P2P core — handshake, mesh, party record, actions
  games.js              # Game registry + the mount contract
  party.js              # Party screen (roster, teams, switching, succession)
  lobby.js              # Two-player lobby UI (link, QR, copy, paste, scan)
  qr.js                 # Dependency-free QR encoder
  qr-decode.js          # Dependency-free QR decoder + camera scanner
  styles.css            # Shared neon theme
  README.md             # lib API documentation
assets/                 # Portal preview GIFs
scripts/                # Preview GIF generation + tests
```

## Shared library (`lib/`)

The multiplayer games share a common P2P layer loaded as traditional scripts
(works on both `file://` and `http://`):

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

- **`NeonArcade.createHost(opts)` / `createGuest(opts)`** — create the room and
  drive the handshake (`createInvite()`, `acceptAnswer()`, `answerInvite()`).
  Returns a controller with `isHost()`, `getMembers()`, `makeAction()`, plus the
  party administration (`setTeam`, `setGame`, `transferHost`, `deleteParty`).
- **`NeonArcade.registerGame(def)`** — how a game joins the roster of available
  games. `mount(ctx)` builds it and returns `{ unmount() }`.
- **`NeonArcade.mountParty(container, stage)`** — the party screen: roster,
  teams, recruiting, game switching, host succession.
- **`NeonArcade.mountGamePage(lobbyEl, stage, gameId)`** — one game on its own
  page, through the plain two-player lobby.

See [`lib/README.md`](lib/README.md) for full API documentation.

## Tech stack

- Vanilla HTML/CSS/JS — no framework, no bundler, no build step.
- Raw WebRTC data channels — no networking library, no CDN, no signaling
  server. STUN is the only external contact, and it never sees game data.
  Topology is a mesh; the signalling for each new connection rides over the
  connections that already exist.
- Canvas 2D for rendering.
- Mobile-first: responsive layouts, touch + mouse + keyboard input.

## Preview GIFs

Portal preview GIFs are generated headlessly via Playwright:

```sh
scripts/make-preview.sh connect4        # one game
scripts/make-preview.sh all             # all games
```

See [`docs/index.md`](docs/index.md) for more details.

## Tests

```sh
node scripts/test-codec.mjs    # signalling codec round-trip, no browser needed
node scripts/test-party.mjs    # three real browser peers: recruiting, teams,
                               # game switching, host succession
```

## Adding a game

One file in `games/` that calls `NeonArcade.registerGame({ ... })`, plus a
script tag in `party.html` (and its own page, if you want a deep link). The
party's game switcher lists whatever registered itself — no shell code changes.
The contract is documented at the top of [`lib/games.js`](lib/games.js).
