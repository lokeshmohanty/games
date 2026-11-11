# worker/ — the room server

A Cloudflare Worker plus one Durable Object per room code. It is the
rendezvous point `docs/room-server.md` designs for: it mints nothing itself
(the client draws its own 6-digit code), ferries packed invite/reply strings
between sockets, and holds and releases rejoin claims. It serves no ICE
config and there is no TURN: NAT traversal is the clients' own STUN, exactly
as in the classic invite flow. **It never sees game data** — after the
handshake, every byte flows over WebRTC data channels, direct or
peer-relayed, exactly as before. The static site stays on GitHub Pages; this
is a separate deploy.

## Files

- `hub.js` — every rule (capacity, claims, release, rate limits, TTLs) as pure logic
  behind an adapter, no Cloudflare imports. `scripts/test-hub.mjs` drives it
  directly, zero dependencies.
- `index.js` — the dumb routing Worker (a code becomes an object) and two
  Durable Object classes. `RoomSignal` is one room: WebSocket hibernation
  with attachments (`{ip, code, dial, id, at}`, written at accept so the rate
  limit sees the real IP), claims persisted to storage, alarms for the TTL
  sweep; every handler rebuilds the hub after an eviction, not only `fetch`.
  `IpGate` is one client IP's guess counter, which every room charges a
  host/join against — rooms are separate objects, so only a shared counter
  sees a guesser trying different codes. It also counts *dials*: the
  routing Worker charges every `/room/<code>` upgrade before touching a room
  (429 past 20 unrefunded per 5 min), and the room refunds it on the
  socket's first success — the timing-oracle cap, docs/room-server.md.
  `ROOM_DEBUG` (a `--var`, tests only) adds `X-Room-Instance` to the 101 so
  `scripts/test-live.mjs` can prove hibernation; never set it for real.
  No Cloudflare imports and no RPC,
  so both classes run in plain Node under a fake `state`.
- `wrangler.toml` — two DO classes (`ROOM`, `GATE`), SQLite-backed (free
  tier); migration `v2` adds `IpGate`.

## Run it locally

```sh
nix shell nixpkgs#wrangler -c wrangler dev --port 8787   # from worker/
```

(`npx wrangler` may fail on NixOS linking `workerd`; the nixpkgs build works.)
Then point a page at it. `?rs=http://127.0.0.1:8787` works because it names
a loopback server — the only kind a link may choose; for anything else
(another machine, a self-hosted deploy) set it in storage, in the page's
console: `localStorage["neon.rs"] = "https://…"`. A link that could choose
the room server could rewrite the SDP it relays (`docs/room-server.md`).
The client converts http(s) to ws(s) itself, and probes `GET /ping`, which
the routing Worker answers without waking a room.

## Deploy (once)

```sh
npx wrangler login          # once, per machine
npx wrangler deploy         # from worker/
```

Deployed 2026-11-11 at **https://neon-arcade-room.lokeshmohanty.workers.dev** (account subdomain
`lokeshmohanty`, `preview_urls = false`). That base is
`NeonArcade.roomServerUrl` in `lib/room-join.js`. No secrets are needed.
Check it with `just test-live https://neon-arcade-room.lokeshmohanty.workers.dev`.

## Notes

- `compatibility_date` is deliberately conservative; a newer wrangler may
  ask you to bump it — its error says exactly what it wants.
- The Durable Object name for a room is `code:<digits>`, so one object owns
  one room and `list` in the dashboard reads like a party list.
- Tests:
  - `node scripts/test-hub.mjs` — every rule, no network, no Cloudflare.
  - `node scripts/test-worker-do.mjs` — the DO shell in Node over a fake
    `state`, evicted by hand (a fresh instance over the same storage and
    sockets) before a message, a close, a connection, an alarm and a leave;
    plus the cross-room guess limit through `IpGate`.
  - `just test-worker` (`node scripts/test-worker.mjs`) — starts `wrangler
    dev` itself (on free ports, fresh state) and drives it with node sockets
    and real browsers; skips with a message if wrangler cannot start.
  Real hibernation on Cloudflare is unverified until the first deploy; see
  `docs/room-server.md` → Honest gaps.
