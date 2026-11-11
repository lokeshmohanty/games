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
- `index.js` — the dumb routing Worker (a code becomes an object) and the
  Durable Object shell: WebSocket hibernation with attachments (`{ip, code,
  id}`, written at accept so the rate limit sees the real IP), claims
  persisted to storage, alarms for the TTL sweep. Every handler rebuilds the
  hub after an eviction, not only `fetch`.
- `wrangler.toml` — one DO class, SQLite-backed (free tier).

## Run it locally

```sh
nix shell nixpkgs#wrangler -c wrangler dev --port 8787   # from worker/
```

(`npx wrangler` may fail on NixOS linking `workerd`; the nixpkgs build works.)
Then open any page with `?rs=http://127.0.0.1:8787` — the client converts
http(s) to ws(s) itself.

## Deploy (once)

```sh
npx wrangler login          # once, per machine
npx wrangler deploy         # from worker/
```

The URL is `https://neon-arcade-room.<your-subdomain>.workers.dev`; that base
is `NeonArcade.roomServerUrl` in `lib/room-join.js`. No secrets are needed.

## Notes

- `compatibility_date` is deliberately conservative; a newer wrangler may
  ask you to bump it — its error says exactly what it wants.
- The Durable Object name for a room is `code:<digits>`, so one object owns
  one room and `list` in the dashboard reads like a party list.
- Tests: `node scripts/test-hub.mjs` (no network, no Cloudflare, no
  dependencies). The DO shell has been exercised under `wrangler dev` with
  real browsers, not on Cloudflare itself — hibernation and eviction are
  unverified until the first real deploy; see `docs/room-server.md` →
  Honest gaps (including the per-room rate-limit gap).
