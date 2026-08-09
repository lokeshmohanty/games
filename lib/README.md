# lib/ — shared P2P multiplayer core

Serverless multiplayer for vanilla-JS browser games. No build step, no server.
Peers discover each other via public Nostr relays (Trystero), then all game
data flows directly peer-to-peer over WebRTC, end-to-end encrypted.

## Files

- **`net.js`** — `NeonArcade.createRoom()`: join a P2P room, track peers, elect a host.
- **`lobby.js`** — `NeonArcade.mountLobby()`: reusable room-code UI + host-gated Start.
- **`styles.css`** — shared neon theme (link from each game's HTML).

## Loading

The lib files are **traditional scripts** (not ES modules) so they work on both
`file://` and `http://` origins. Trystero is imported dynamically from the CDN
inside `net.js`. Load them in order before the game script:

```html
<link rel="stylesheet" href="lib/styles.css" />
<script src="lib/net.js"></script>
<script src="lib/lobby.js"></script>
<script>
  const { mountLobby } = window.NeonArcade;
  // ... game code ...
</script>
```

## API

### `NeonArcade.createRoom({ appId, roomId, onPeerJoin, onPeerLeave, onHostChange })`

Async — returns a `Promise` that resolves to a room controller:

| method | description |
| --- | --- |
| `selfId` | this peer's stable random id |
| `getPeers()` | array of connected peer ids |
| `peerCount()` | number of connected peers (excl. self) |
| `isHost()` | `true` only on the elected host (lowest selfId) |
| `hostId()` | current host's id |
| `makeAction(name, opts?)` | returns `{ send(data, { target }?), onMessage }` — broadcast or targeted messages |
| `leave()` | leave the room |

**Host election:** the peer with the lowest `selfId` is host. The host owns
authoritative shared state. Re-elected on join/leave. Use `isHost()` to gate
who broadcasts state vs. who sends inputs.

### `NeonArcade.mountLobby(container, { appId, gameName, onReady, onStart, onPeerJoin, onPeerLeave })`

Renders a neon lobby (room code input, peer roster, Start button) into
`container`. Calls `onReady(room)` once connected (set up game actions here)
and `onStart()` on **all** peers when the host starts (begin gameplay here).
`onPeerJoin(peerId)` and `onPeerLeave(peerId)` are forwarded from the room for
late-join state sync.

## Patterns

### Host-authoritative state (Connect 4, Draw & Guess)

```js
const state = room.makeAction("state");   // host -> all
const input = room.makeAction("input");   // peer -> host

if (room.isHost()) {
  input.onMessage = (data, { peerId }) => {
    gameState = applyMove(gameState, data, peerId);
    state.send(gameState);               // broadcast new state
  };
} else {
  state.onMessage = (data) => { gameState = data; render(); };
}

// Late join: host re-sends full state to the new peer
// onPeerJoin -> if host, state.send(gameState, { target: newPeerId })
```

### Peer-authoritative broadcast (Neon Survival co-op)

```js
const pos = room.makeAction("pos");
pos.send({ x, y });              // broadcast my position every tick
pos.onMessage = (data, { peerId }) => { peers[peerId] = data; };
```

## Late joiners

When a peer joins mid-game, the host should send them the full current state
(targeted, not broadcast) so they sync immediately. See each game for the
specific implementation.

## Testing

Games work on both `file://` (double-click the HTML file) and `http://`.

For P2P testing, serve the project root over HTTP and open the game in two
browser tabs with the same room code:

```sh
python3 -m http.server 8000
```
