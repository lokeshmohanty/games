# worker/ — the room server

A Cloudflare Worker plus one Durable Object per room code. It is the
rendezvous point `docs/room-server.md` designs for: it draws each host's
6-digit code (`/room/new`), ferries packed invite/reply strings between
sockets, holds and releases rejoin claims, and issues member passes. It serves no ICE
config and there is no TURN: NAT traversal is the clients' own STUN, exactly
as in the classic invite flow. **It never sees game data** — after the
handshake, every byte flows over WebRTC data channels, direct or
peer-relayed, exactly as before. The static site stays on GitHub Pages; this
is a separate deploy.

## Files

- `hub.js` — every rule (reservations, capacity, claims, release, rate
  limits, TTLs, member passes) as pure logic behind an adapter, no
  Cloudflare imports. `scripts/test-hub.mjs` drives it
  directly, zero dependencies.
- `index.js` — the dumb routing Worker (a code becomes an object) and two
  Durable Object classes. `RoomSignal` is one room: WebSocket hibernation
  with attachments (`{ip, code, dial, host, reservedAt, id, at}`, written at accept so
  the rate limit sees the real IP), claims persisted to storage, alarms for
  the TTL sweep; every handler rebuilds the hub after an eviction, not only
  `fetch`. `IpGate` is one client IP's counters, which every room charges a
  join against — rooms are separate objects, so only a shared counter
  sees a guesser trying different codes. It also counts *dials*: the
  routing Worker charges every `/room/<code>` upgrade that carries no valid
  member pass before touching a room (past 10 unrefunded per 5 min — the
  guess limit — the Worker accepts the socket itself, says `blocked` and
  hangs up 4429, so a browser can tell the player; 503 if the gate cannot
  answer), and the room refunds it
  on the socket's first successful join/release — the timing-oracle price,
  docs/room-server.md. And *hosts*: `/room/new` spends one of 30 per 5 min
  (`HOST_ROOMS`; an IPv6 sender also one of 120 per /48,
  `HOST_SITE_ROOMS`), then the Worker draws a code and asks that code's
  object to take the socket only if the code is free (`/room/<code>/new`,
  409 when live, redrawn). The code is held 15 s (`RESERVE_MS`) for the
  socket to say `host`, then hung up (4408) and freed.
  `ROOM_DEBUG` (a `--var`, tests only) adds `X-Room-Instance` to the 101 so
  `scripts/test-live.mjs` can prove hibernation, and `X-Room-Draws` to a
  `/room/new` 101; with `ROOM_TEST_FORCE_REDRAW` too, `/room/new?draw=<code>`
  forces the first draw (test-live `redraw`). Never set either for real.
  No Cloudflare imports and no RPC,
  so both classes run in plain Node under a fake `state`.
- `wrangler.toml` — two DO classes (`ROOM`, `GATE`), SQLite-backed (free
  tier); migration `v2` adds `IpGate`.

## Run it locally

```sh
nix shell nixpkgs#wrangler -c wrangler dev --port 8787   # from worker/
```

(`npx wrangler` may fail on NixOS linking `workerd`; the nixpkgs build works.)
Without a pass key `wrangler dev` runs as a deployment without the secret
does: no member passes, so members' re-dials are charged like any upgrade
(the Worker logs it once). For passes locally, put a key in
`worker/.dev.vars` (gitignored — `.dev.vars*` in `.gitignore`; never
commit it):

```sh
echo "ROOM_PASS_KEY=$(openssl rand -base64 32)" > worker/.dev.vars
```

The test suites do not need it: `scripts/test-worker.mjs` and
`scripts/test-nat.mjs` pass a fresh random key each run
(`--var ROOM_PASS_KEY:…`, which overrides `.dev.vars`).

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
openssl rand -base64 32 | npx wrangler secret put ROOM_PASS_KEY   # once, from worker/
npx wrangler deploy         # from worker/
```

(`nix shell nixpkgs#wrangler -c wrangler …` in place of `npx wrangler` on
NixOS.) `ROOM_PASS_KEY` is the HMAC key member passes are signed with
(`docs/room-server.md` → Member passes): any long random string, kept only
in Cloudflare. `wrangler secret put` reads it from stdin, so it never lands
in shell history; `npx wrangler secret list` shows it is set (not its
value). Without it the worker still runs — it issues no passes and logs
that once — but a shared address (LAN party, CGNAT) that spends its 10
dials loses its members' re-dials until the window closes. Rotating it
(the same command with a new key) voids every outstanding pass: each
member's next re-dial is charged once, and the seat it gets brings a new
pass.

Deployed 2026-11-11, last redeployed 2026-11-13 (version 5b7a8599, the
`released:true` notice) at **https://neon-arcade-room.lokeshmohanty.workers.dev** (account subdomain
`lokeshmohanty`, `preview_urls = false`). That base is
`NeonArcade.roomServerUrl` in `lib/room-join.js`. One secret:
`ROOM_PASS_KEY`, above.
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
    plus the cross-room guess limit through `IpGate`, `/room/new` hosting
    and its cap, and member passes past an exhausted dial gate.
  - `just test-worker` (`node scripts/test-worker.mjs`) — starts `wrangler
    dev` itself (on free ports, fresh state) and drives it with node sockets
    and real browsers; skips with a message if wrangler cannot start.
  Real hibernation on Cloudflare is unverified until the first deploy; see
  `docs/room-server.md` → Honest gaps.


## The account API (2026-11-13)

The same Worker serves `/api/*`, `/auth/*` and `/live` (worker/api/, design
and one-time setup in docs/accounts.md): a D1 database `arcade`, the
`UserLive` Durable Object, an hourly cron for the public snapshot, and
secrets `SESSION_KEY`, `GITHUB_CLIENT_ID/SECRET`, `GOOGLE_CLIENT_ID/SECRET`,
`GH_APP_ID`, `GH_APP_KEY`. Without the D1 binding those routes answer 503 and
the room server works as before. Locally: `just test-accounts`,
`just test-social` (scripts/wrangler.mjs applies the migrations to a
throwaway local D1). Backup: D1 Time Travel, or
`wrangler d1 export arcade --remote --output arcade.sql`.
