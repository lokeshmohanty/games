# games

Simple client-side web games — single-player and serverless P2P multiplayer.
No build step, no server, no dependencies to install. Just open the HTML files
or serve the folder over HTTP.

## Games

### Single Player

- **[Neon Survival](neon-survival.html)** — Dodge the red, collect the green.
  How long can you survive? Canvas-based, touch and mouse input.

### Multiplayer (P2P, no server)

All multiplayer games connect browsers directly over WebRTC, with **no server
and no third-party service** of any kind. Since two browsers cannot discover
each other unaided, the players carry the handshake themselves: the host
generates an invite link (also shown as a QR code), the guest opens it and
sends one reply code back. After that all game data flows directly between
players, end-to-end encrypted.

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

1. Open the game and click **CREATE GAME**.
2. Send the invite link to a friend — any chat app works, or let them scan the
   QR code off your screen.
3. They open it and get a short reply code.
4. If they are next to you, hit **SCAN REPLY** and point your camera at their
   screen. Otherwise they send you the code and you paste it and hit
   **CONNECT**.
5. Click **START GAME**.

Use **INVITE ANOTHER** to add more players — each one gets its own invite.

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
  net.js                # P2P core — invite/answer handshake, star topology, actions
  lobby.js              # Invite-link lobby UI (link, QR, copy, paste-reply)
  qr.js                 # Dependency-free QR encoder
  qr-decode.js          # Dependency-free QR decoder + camera scanner
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
<script src="lib/qr.js"></script>
<script src="lib/qr-decode.js"></script>
<script src="lib/net.js"></script>
<script src="lib/lobby.js"></script>
<script>
  const { mountLobby } = window.NeonArcade;
  // ...
</script>
```

- **`NeonArcade.createHost(opts)` / `createGuest(opts)`** — create the room and
  drive the handshake (`createInvite()`, `acceptAnswer()`, `answerInvite()`).
  Returns a controller with `isHost()`, `peerCount()`, `makeAction()`, etc.
- **`NeonArcade.mountLobby(container, { gameName, onReady, onStart, ... })`**
  — renders the invite/answer lobby and picks the host or guest path
  automatically. Calls `onReady(room)` once the room exists and `onStart()` on
  all peers when the host starts.

See [`lib/README.md`](lib/README.md) for full API documentation.

## Tech stack

- Vanilla HTML/CSS/JS — no framework, no bundler, no build step.
- Raw WebRTC data channels — no networking library, no CDN, no signaling
  server. STUN is the only external contact, and it never sees game data.
- Canvas 2D for rendering.
- Mobile-first: responsive layouts, touch + mouse + keyboard input.

## Preview GIFs

Portal preview GIFs are generated headlessly via Playwright:

```sh
scripts/make-preview.sh connect4        # one game
scripts/make-preview.sh all             # all games
```

See [`docs/index.md`](docs/index.md) for more details.
