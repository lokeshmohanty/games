# Arcade Games

Simple client-side web games. Serverless P2P multiplayer, with bots so you
never need a second person to play. No build step, no server, no dependencies
to install. Just open the HTML files or serve the folder over HTTP.

## Games

**Every game here is multiplayer.** There is no single-player section, because
there is no single-player mode to put in one: every game seats bots, and a bot
is an ordinary member of the roster that the host's browser plays for. So
"single player" is just a table where the other seats happen to be bots, and it
takes one tap to get there.

- **[Start a Party](party.html)** — everyone connects once, then the host
  switches between games without anybody reconnecting. Pick teams, add bots,
  watch as a spectator, hand the party over before you leave.
- **[Neon Survival](neon-survival-mp.html)** — Dodge the red, collect the
  green. Alone, with bots, or keeping each other alive. 1–8 players.
- **[Connect 4](connect4.html)** — Drop your discs, line up four in a row.
  The bot searches five moves ahead. 2 players.
- **[Tug of War](tug-of-war.html)** — Tap to pull; the knot goes to whoever
  taps hardest. Two teams of any sizes, and a tap counts for more on a smaller
  team, so 1-against-4 is still a game. 2–8 players.
- **[Draw & Guess](draw-guess.html)** — One player draws, the rest guess!
  Real-time canvas stroke sync and chat. **The one game with no bots** — a bot
  that draws is replaying a canned doodle and a bot that guesses is reading the
  answer it was handed, and neither is an opponent. 2–8 people.

### Multiplayer (P2P, no server)

Games connect browsers directly over WebRTC, with **no server and no
third-party service** of any kind. Since two browsers cannot discover each
other unaided, the players carry the handshake themselves: someone generates an
invite link (also shown as a QR code), the newcomer opens it and sends one
reply code back. After that all game data flows directly between players,
end-to-end encrypted.

That cost is paid **once per person**. Every connection after the first is
negotiated over the connections that already exist, so nobody scans anything
twice — and any member can do the inviting, not just the host.

### Bots

A bot joins the roster like a player: it has a name, a seat and a team, and
every other peer sees it exactly as it sees a person. The difference is that
the host's browser decides what it does, and nobody ever tries to open a
connection to it. Every game here is already host-authoritative, so the side
that plays a bot is the side that was refereeing anyway.

- **Connect 4** — minimax with alpha-beta, five plies. It will take a win and
  it will block yours; it is not trying to be unbeatable.
- **Tug of War** — taps at about 9 a second with jitter. Mash properly and you
  beat it; ignore the button and you lose.
- **Neon Survival** — flies a ship that flees the nearest enemies and drifts
  toward gems, capped at a speed you are not. It dies like anyone else.

## How to play

### Alone, or against bots

Open any game's page and take the second button — **PLAY A BOT**, or **PLAY
ALONE** for Neon Survival, which seats one player perfectly well. Add or drop
bots until it looks like a fair fight, then **START GAME**. Nothing is sent
anywhere; `file://` works fine.

### A party (several people, several games)

1. Open `party.html` and click **ADD PLAYER**.
2. Send the invite link — any chat app works, or let them scan the QR off your
   screen.
3. They open it and get a short reply code.
4. If they are next to you, hit **SCAN REPLY** and point your camera at their
   screen. Otherwise they send the code and you hit **PASTE** (or paste it and
   hit **CONNECT**).
5. Repeat per person — anyone already in can do this, not just the host.
6. **ADD BOT** as many times as you like — bots take teams like anybody else.
7. Assign teams, then pick a game. Switch games any time; nobody reconnects.

If the host leaves, the party carries on: the longest-present member is offered
the crown. Only **DELETE PARTY** ends it.

### One game on its own

Each game also has its own page (`connect4.html` and friends) with the plain
two-player lobby: **INVITE A FRIEND**, send the invite, take the reply, **START
GAME**. Use **INVITE ANOTHER** to add more players, and **ADD BOT** to fill the
rest of the seats.

`file://` works for testing on the same machine (open two tabs). To serve it:

```sh
just run          # http://127.0.0.1:8000
just serve-lan    # every interface, so a phone on the same wifi can reach it
```

`just --list` shows the rest (tests, preview gifs, icons). There is nothing to
install first — the recipes wrap `python3 -m http.server` and `node`, which is
all this project has ever needed.

Two notes on `serve-lan`. The camera scanner and the service worker need a
**secure context**: `127.0.0.1` counts, `http://<lan-ip>` does not. So over the
LAN everything works except **SCAN REPLY** — use PASTE for the reply code.

## Project structure

```
index.html              # Arcade portal — links to everything
party.html              # Persistent party — roster, teams, bots, switching
neon-survival.html      # Redirect — the solo game merged into the co-op one
connect4.html           # Deep link into one game (thin wrapper)
tug-of-war.html         #   "
draw-guess.html         #   "
neon-survival-mp.html   #   "
games/                  # One file per game; each registers itself
  connect4.js           # 1v1 teams
  tug-of-war.js         # teams of any size, 2–8
  draw-guess.js         # free-for-all, 2–8
  neon-survival-mp.js   # co-op, 1–8 — also the solo game
lib/
  net.js                # P2P core — handshake, mesh, party record, actions
  games.js              # Game registry + the mount contract
  party.js              # Party screen (roster, teams, switching, succession)
  lobby.js              # Lobby UI (link, QR, copy, paste, scan, bots)
  qr.js                 # Dependency-free QR encoder
  qr-decode.js          # Dependency-free QR decoder + camera scanner
  pwa.js                # Service worker registration + the install button
  styles.css            # Shared neon theme
  README.md             # lib API documentation
manifest.webmanifest    # Makes the arcade installable
sw.js                   # Service worker — offline play, at the root for scope
assets/                 # App icons + portal preview GIFs
scripts/                # Preview GIFs, icon generation, tests
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
  games. `mount(ctx)` builds it and returns `{ unmount() }`. Set `bots: false`
  to opt out of bots; everything else gets them.
- **`room.addBot()` / `room.bots()` / `room.emitAs(botId, ...)`** — host-only.
  Seat a simulated member, list them, and send an action as one.
- **`NeonArcade.mountParty(container, stage)`** — the party screen: roster,
  teams, recruiting, game switching, host succession.
- **`NeonArcade.mountGamePage(lobbyEl, stage, gameId)`** — one game on its own
  page, through the plain two-player lobby.

See [`lib/README.md`](lib/README.md) for full API documentation.

## Tech stack

- Vanilla HTML/CSS/JS — no framework, no bundler, no build step.
- Bots run in the host's browser, alongside the game it is already refereeing.
  No worker, no model, no service — a search function and a timer.
- Raw WebRTC data channels — no networking library, no CDN, no signaling
  server. STUN is the only external contact, and it never sees game data.
  Topology is a mesh; the signalling for each new connection rides over the
  connections that already exist.
- Canvas 2D for rendering.
- Mobile-first: responsive layouts, touch + mouse + keyboard input.
- Installable (PWA): a manifest, generated icons and a service worker, all
  hand-written — no toolchain and nothing added to the page load.

## Install it

Open the portal on the deployed `https://` site and take the **INSTALL APP**
button under the title, or the browser's own install item; on iOS it is Share →
Add to Home Screen. It then has its own icon and its own window, and any game
played against bots works with no network at all.

**Firefox will not show that button, and cannot.** It is driven by
`beforeinstallprompt`, which is not a standard and is implemented only by
Chromium browsers. Firefox on Android installs from its own ⋮ menu; Firefox on
desktop removed web-app installing in Firefox 85 and has not brought it back,
so there the tab is all there is. None of that touches the service worker —
Firefox caches and plays offline exactly like Chrome. `lib/pwa.js` says so on
the page rather than leaving an empty space.

Being installed changes nothing about how multiplayer works: peers still find
each other through an invite somebody carries, and a game with real people in
it still needs a network to reach them.

What the service worker does with your files is deliberately split. Code — the
pages, `lib/`, `games/` — is fetched **network-first**, because those files have
to agree with each other and a half-updated app breaks in ways nobody would
connect to a deploy from last week. Icons and preview gifs are served from the
cache first, since they are large and a slightly old one costs nothing. See
[`sw.js`](sw.js), which explains itself at length.

To change the icon, edit [`assets/icon.svg`](assets/icon.svg) and run:

```sh
node scripts/make-icons.mjs
```

## Preview GIFs

Portal preview GIFs are generated headlessly via Playwright:

```sh
scripts/make-preview.sh connect4        # one game
scripts/make-preview.sh all             # all games
```

See [`docs/index.md`](docs/index.md) for more details.

## Tests

`just test` runs all of them, slowest last. Individually:

```sh
node scripts/test-codec.mjs    # signalling codec round-trip, no browser needed
node scripts/test-party.mjs    # three real browser peers: recruiting, teams,
                               # game switching, host succession
node scripts/test-scan.mjs     # SCAN REPLY against a fake camera: the code
                               # sized as it lands on a real screen, and the
                               # aiming that comes before it
node scripts/test-pwa.mjs      # installability (including Chrome's own
                               # verdict), the portal's layout at 390x844, and
                               # the pages loading with no network
node scripts/test-bots.mjs     # every game playable by one person: the bots
                               # actually play, and no peer tries to connect
                               # to one
node scripts/test-plumbing.mjs # sealed private channels, commit-reveal and the
                               # round clock, over real routing on a fake
                               # transport
node scripts/test-onitama.mjs       # Onitama's rules and search, no document
node scripts/test-light-cycles.mjs  # the arena simulation and the rider bot
node scripts/test-battleship.mjs    # fleets, sinking, and the reveal audit —
                                    # tested by breaking it four ways
```

`just check-precache` catches the one mistake `sw.js` cannot warn about: a page
or module added to the repo but not to its `SHELL` list, which then simply is
not there offline.

## Adding a game

One file in `games/` that calls `NeonArcade.registerGame({ ... })`, plus a
script tag in `party.html` (and its own page, if you want a deep link). The
party's game switcher lists whatever registered itself — no shell code changes.
The contract is documented at the top of [`lib/games.js`](lib/games.js).
