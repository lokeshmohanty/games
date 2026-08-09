# games

Simple client-side web games — single-player and serverless P2P multiplayer.
No build step, no server, no dependencies to install. Just open the HTML files
or serve the folder over HTTP.

## Games

### Single Player

- **[Neon Survival](neon-survival.html)** — Dodge the red, collect the green.
  How long can you survive? Canvas-based, touch and mouse input.

### Multiplayer (P2P, no server)

All multiplayer games use [Trystero](https://github.com/dmotz/trystero) for
serverless WebRTC peer-to-peer networking. Peers discover each other via
public Nostr relays; all game data flows directly between players,
end-to-end encrypted. Share a room code to play together.

- **[Connect 4](connect4.html)** — Drop your pieces, line up four in a row.
  2-player turn-based. Host-authoritative board with win detection.
- **[Draw & Guess](draw-guess.html)** — One player draws, the rest guess!
  Real-time canvas stroke sync and chat. 2–8 players.
- **[Neon Survival Co-op](neon-survival-mp.html)** — Survive the swarm
  together! Co-op real-time survival. 2–8 players, host-authoritative enemies.

## How to play

### Single player

Open `neon-survival.html` directly in a browser (`file://` works fine).

### Multiplayer

1. Open the game in your browser.
2. Enter a room code (or use the auto-generated one).
3. Share the code with a friend — they open the same game and enter the code.
4. The host clicks **START GAME**; everyone plays together in real time.

`file://` works for testing on the same machine (open two tabs). For
cross-device play, serve the folder over HTTP:

```sh
python3 -m http.server 8000
```

Then visit `http://<your-ip>:8000` on each device.

## Project structure

```
index.html              # Arcade portal — links to all games
neon-survival.html      # Single-player survival
connect4.html           # 2-player P2P Connect 4
draw-guess.html         # 2–8 player P2P drawing & guessing
neon-survival-mp.html   # 2–8 player P2P co-op survival
lib/
  net.js                # P2P networking core (Trystero wrapper, host election)
  lobby.js              # Reusable room-code lobby UI + host-gated start
  styles.css            # Shared neon theme
  README.md             # lib API documentation
assets/                 # Portal preview GIFs
scripts/                # Preview GIF generation (headless browser recording)
```

## Shared library (`lib/`)

The multiplayer games share a common P2P layer loaded as traditional scripts
(works on both `file://` and `http://`):

```html
<link rel="stylesheet" href="lib/styles.css" />
<script src="lib/net.js"></script>
<script src="lib/lobby.js"></script>
<script>
  const { mountLobby } = window.NeonArcade;
  // ...
</script>
```

- **`NeonArcade.createRoom({ appId, roomId, onPeerJoin, onPeerLeave, onHostChange })`**
  — joins a P2P room, tracks peers, elects a host (lowest `selfId` wins).
  Returns a room controller with `isHost()`, `peerCount()`, `makeAction()`, etc.
- **`NeonArcade.mountLobby(container, { appId, gameName, onReady, onStart, ... })`**
  — renders a neon-styled lobby (room code input, peer roster, Start button).
  Calls `onReady(room)` on connect and `onStart()` on all peers when the host starts.

See [`lib/README.md`](lib/README.md) for full API documentation.

## Tech stack

- Vanilla HTML/CSS/JS — no framework, no bundler, no build step.
- [Trystero](https://github.com/dmotz/trystero) — serverless WebRTC P2P
  multiplayer (loaded from CDN via dynamic `import()`).
- Canvas 2D for rendering.
- Mobile-first: responsive layouts, touch + mouse + keyboard input.

## Preview GIFs

Portal preview GIFs are generated headlessly via Playwright:

```sh
scripts/make-preview.sh connect4        # one game
scripts/make-preview.sh all             # all games
```

See [`docs/index.md`](docs/index.md) for more details.
