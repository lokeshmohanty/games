---
name: multiplayer
description: Use when working on the serverless P2P layer — the invite/reply handshake, the QR encoder or decoder, the SCAN REPLY camera scanner, the mesh and relayed signalling, the party/lobby connection UI, or ICE and STUN behaviour. Covers lib/net.js, lib/qr.js, lib/qr-decode.js, lib/lobby.js and lib/party.js. Also use when a connection or a scan "isn't working".
---

# Multiplayer (P2P core)

Two browsers cannot find each other on their own, and this project refuses a
signalling server, a relay and a TURN server. The **players** carry the
handshake instead: one side mints an invite, the other sends one code back, and
every connection after the first is negotiated over the links that already
exist. STUN is the only outside contact.

## Read these first, do not re-derive them

- [`lib/README.md`](../../../lib/README.md) — the API: room controller,
  `registerGame`, `mountParty`, `mountLobby`, `scanQr`, the topology, the
  connectivity rules.
- [`docs/index.md`](../../../docs/index.md) — how a handshake is paid once per
  person, parties and succession, and the **Honest gaps** section, which is the
  authoritative list of what is *not* verified.

Neither file is a summary of the code — they record decisions the code cannot
tell you. Read them before changing anything here.

## Verify with the real tests, not by reasoning

```sh
node scripts/test-codec.mjs    # signalling codec round-trip, no browser
node scripts/test-party.mjs    # three real browser peers: recruiting, teams,
                               # game switching, host succession
node scripts/test-scan.mjs     # SCAN REPLY against a fake camera
node scripts/test-bots.mjs     # every game playable by one person, and no peer
                               # opening a connection to a bot
```

`test-scan.mjs` and `test-pwa.mjs` need a **secure context**, so they serve the
repo over `http://127.0.0.1`; `file://` and `http://<lan-ip>` will not do.
`test-party.mjs` runs on `file://` deliberately.

## Rules that hold across this subsystem

- **Never shorten a code by dropping candidates**, except the ICE-TCP
  `tcptype active` placeholder. `.local` mDNS candidates look useless and are
  the only path two browsers have on a LAN with no route to STUN.
- **Never trade scan resolution for speed.** See [[reply-code-scanning]].
- **A failure must surface as an explicit error, never as an indefinite wait.**
  The no-TURN trade-off means some networks genuinely cannot connect; the player
  is told which case they hit.
- Changing the handshake breaks `scripts/preview.mjs` too — it drives the same
  UI. See [[../../game-previews/memory/p2p-handshake]].
- **A bot is a party member, not a mode.** Anything that walks the roster or
  routes a message has to know a `bot_` id has no connection behind it and never
  will. See [[bots-as-members]] for the four places in `net.js` that get this
  wrong if you forget.

## Memory

- `memory/reply-code-scanning.md` — why SCAN REPLY broke twice, the two traps
  that caused it, and the only test shape that catches them.
- `memory/bots-as-members.md` — why bots are roster members rather than a game
  mode, and the routing that must exclude them.
