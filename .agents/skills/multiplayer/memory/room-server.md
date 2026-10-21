# The room server is optional and the mesh is authoritative

*Established 2026-10-18, when the join-by-code layer shipped.*

## The decision

The room server is a **rendezvous point, not a relay**. It sees SDP offers and
answers — never game data, never party state. The mesh stays authoritative for
membership and game play; the room server's peer-state notices are advisory,
and a live link always outranks them. This is why `serverPeerState` and the
`_confirmGone` reconnect path both check for a live link before marking.

Progressive enhancement is non-negotiable: when the room server is unreachable,
the classic scan/paste flow is offered unchanged. The same errors surface, the
same UI paths run, and no game or test notices its absence.

## The two invariants the client enforces

1. **The rejoin token is the only thing that survives a reload.** It holds
   `{code, id, secret}` in `localStorage`. The id is the seat; the secret is
   the claim on it. Everything else — the WebSocket, the data channels, the
   party record — is rebuilt from scratch on every page load.

2. **`serverPeerState` marks, `_linkOpened` clears.** A reconnecting mark is
   advisory and cheap to set; a live link clears it. The grace timer that
   drops a seat after `reconnectGraceMs` runs through `_confirmGone`, which
   checks `member.rs` — set by the wire's `onPeerJoin` when a member joins
   through the room server's offer path.

## Traps

- **A test page's mock room server is per-page.** Two pages on the same origin
  do not share a mock; each has its own rooms. A test that wants a guest to
  join a host's room must either use the same page (via `evaluate`) or accept
  that cross-page testing needs a real deploy.
- **`localStorage` is shared across tabs in a test context.** A host's rejoin
  token written in one `evaluate` leaks into the next. Tests must clear it
  before a fresh join, or the guest adopts the host's id and the room ends up
  with one member.
- **The `rs` flag on a member is set by the wire's `onPeerJoin`**, not by the
  join message. It marks "this member's offer came through the room server."
  Without it, `_confirmGone` drops them immediately instead of holding the
  seat for the reconnect grace.

## Files

- `lib/room-join.js` — client glue: `hostRoom`, `joinRoom`, `rejoinToken`,
  `roomServerReachable`, `makeMockRoomServer` (for tests).
- `worker/` — the Cloudflare Worker + Durable Object. `hub.js` is the pure
  logic; `index.js` is the DO shell. `wrangler.toml` is the deploy config.
- `scripts/test-hub.mjs` — the hub rules (codes, claims, TTLs, rate limits).
- `scripts/test-room.mjs` — the client against the in-page mock.
