# lib/ — shared P2P multiplayer core

Multiplayer for vanilla-JS browser games with **no server and no third-party
service**. No build step, no dependencies, no accounts.

Two browsers cannot find each other on their own, so instead of outsourcing
that to a signaling server or a public relay, the *players* carry the handshake:
the host generates an invite link, sends it however they already talk, and the
guest sends one code back. After that all game data flows directly between the
browsers over an encrypted WebRTC data channel.

## Files

- **`net.js`** — `NeonArcade.createHost()` / `createGuest()`: the connection, the peer roster, typed message channels.
- **`lobby.js`** — `NeonArcade.mountLobby()`: the invite/answer UI (link, QR, copy, paste-reply).
- **`qr.js`** — `NeonArcade.qrCanvas()`: a self-contained QR encoder, so invites can be scanned instead of typed.
- **`qr-decode.js`** — `NeonArcade.qrDecode()` / `scanQr()`: a self-contained QR *decoder* plus a camera scanner, so the host can read a guest's reply off their screen.
- **`styles.css`** — shared neon theme (link from each game's HTML).

## The handshake

```
HOST                                  GUEST
[CREATE GAME]
  -> invite link + QR   --(chat/QR)-->  opens the link
                                          -> reply code + QR
  <---(chat, or [SCAN REPLY])------------
  [CONNECT]
[START GAME]                          game begins on both
```

Same room? Nobody types anything: the guest scans the invite QR with their
camera, and the host scans the reply QR straight back with **SCAN REPLY**.
Apart? The link and the reply code both travel fine through any chat app.

The host repeats the invite step per guest (`INVITE ANOTHER`), because each
guest needs its own offer.

## Loading

Traditional scripts (not ES modules), so everything works on `file://` as well
as `http://`. Load in this order before the game script:

```html
<link rel="stylesheet" href="lib/styles.css" />
<script src="lib/qr.js"></script>
<script src="lib/qr-decode.js"></script>
<script src="lib/net.js"></script>
<script src="lib/lobby.js"></script>
<script>
  const { mountLobby } = window.NeonArcade;
  // ... game code ...
</script>
```

## API

### `NeonArcade.mountLobby(container, { gameName, onReady, onStart, onPeerJoin, onPeerLeave })`

Renders the lobby and drives the whole handshake. Calls `onReady(room)` once
the room exists (register your action channels here) and `onStart()` on **all**
peers when the host starts. `onPeerJoin(peerId)` / `onPeerLeave(peerId)` are
forwarded from the room for late-join state sync.

The lobby decides which side it is on by looking for an `#i=…` invite fragment
in the URL, so a game needs no room-code handling of its own.

### Scanning

`NeonArcade.scanQr({ onResult, onError })` returns `{ video, stop }` — mount
`video`, and **always call `stop()`**, which releases the camera. It uses the
browser's `BarcodeDetector` when there is one (Android Chrome) and the decoder
in `qr-decode.js` otherwise, since desktop Chrome and iOS Safari have none.

Camera access needs a secure context, so scanning works on the deployed
`https://` site but not from `file://`; the lobby says so and falls back to
pasting.

### Room controller

| method | description |
| --- | --- |
| `selfId` | this peer's random id |
| `getPeers()` | array of connected peer ids |
| `peerCount()` | number of connected peers (excl. self) |
| `isHost()` | `true` only on the peer that created the room |
| `hostId()` | the host's id |
| `makeAction(name)` | `{ send(data, { target }?), onMessage }` — broadcast or targeted |
| `leave()` | close every connection |

`makeAction` is idempotent: calling it twice with one name returns the same
channel, so `room.makeAction("state").send(...)` inside a helper is fine.

**Host is permanent.** Whoever created the room is the host for its lifetime —
there is no election, because the host is also the hub every guest is connected
through. If the host leaves, the session is over and guests are told so.

## Topology

A star, not a mesh. The host holds one connection per guest and relays
guest→guest traffic. A mesh would need a separate manual handshake for every
pair of players; the star needs one per guest.

This is invisible to game code: `send()` with no target broadcasts to everyone,
and `send(data, { target })` reaches any peer whether or not it is the host.

## Patterns

### Host-authoritative state (Connect 4, Draw & Guess)

```js
const state = room.makeAction("state");   // host -> all
const input = room.makeAction("input");   // peer -> host

if (room.isHost()) {
  input.onMessage = (data, { peerId }) => {
    gameState = applyMove(gameState, data, peerId);
    state.send(gameState);
  };
} else {
  state.onMessage = (data) => { gameState = data; render(); };
}
```

### Peer-authoritative broadcast (Neon Survival co-op)

```js
const pos = room.makeAction("pos");
pos.send({ x, y });
pos.onMessage = (data, { peerId }) => { peers[peerId] = data; };
```

### Late joiners

When a peer joins mid-game the host should send it the full current state
(targeted, not broadcast). The lobby already re-sends the `start` signal to
late joiners so they enter the running game.

## Connectivity

Messages larger than ~12 KB are chunked and reassembled automatically, and
sends are paused when the channel's buffer fills, so per-frame broadcasts
cannot grow it without bound.

The only external contact is **STUN** (`stun.cloudflare.com`,
`stun.l.google.com`), used to discover each peer's public IP:port. It never
sees game data. Pass `iceServers` to `createHost`/`createGuest` to override.

There is deliberately **no TURN server** — running one would reintroduce the
dependency this design removes. A minority of networks (symmetric NAT, some
mobile carriers, locked-down corporate wifi) block direct connections; those
now surface as an explicit error rather than an indefinite wait. If you ever
want to cover them, pass a TURN entry in `iceServers`.

## Testing

Games work on both `file://` (double-click the HTML) and `http://`.

To test two peers, open the game twice — the invite link works between two
tabs, two browsers, or two devices. Note that opening an invite for a page you
already have open is a fragment-only navigation, so the lobby reloads itself on
`hashchange` to pick it up.

```sh
python3 -m http.server 8000
```
