# worker/ — the room server

A Cloudflare Worker plus one Durable Object per room code. It is the
rendezvous point `docs/room-server.md` designs for: it mints nothing itself
(the client draws its own 6-digit code), ferries packed invite/reply strings
between sockets, holds rejoin claims, and hands out ICE (STUN, plus TURN when
a credential is configured). **It never sees game data** — after the
handshake, every byte flows over WebRTC data channels, direct or
peer-relayed, exactly as before. The static site stays on GitHub Pages; this
is a separate deploy.

## Files

- `hub.js` — every rule (capacity, claims, rate limits, TTLs) as pure logic
  behind an adapter, no Cloudflare imports. `scripts/test-hub.mjs` drives it
  directly, zero dependencies.
- `index.js` — the dumb routing Worker (a code becomes an object) and the
  Durable Object shell: WebSocket hibernation with attachments, claims
  persisted to storage, alarms for the TTL sweep.
- `wrangler.toml` — one DO class, SQLite-backed (free tier).

## Deploy (once)

```sh
npx wrangler login          # once, per machine
npx wrangler deploy         # from worker/
```

The URL is `wss://neon-arcade-room.<your-subdomain>.workers.dev/room/<code>`.
Put the base — `wss://neon-arcade-room.<your-subdomain>.workers.dev` — into
`NeonArcade.roomServerUrl` in `lib/room-join.js`, commit, and the 6-digit
join path is live. Until then the constant is empty and the arcade behaves
exactly as it did without a room server.

## TURN (optional, cross-network pairs)

Without TURN, players behind symmetric NAT / CGNAT carriers still cannot
connect — that limitation is what this removes. A free Metered / Open Relay
account gives 5 GB/month of TURN, ample for a friends-and-family arcade where
TURN carries only the pairs hole-punching can't:

1. Sign up at dashboard.metered.ca, create one TURN credential.
2. Note the app name (the `<app>.metered.live` domain) and the credential's
   `apiKey` — credential-scoped, the kind Metered documents as safe for
   front-end use, and now it lives server-side instead.
3. Set both:

```sh
npx wrangler secret put TURN_APP      # e.g. yourapp
npx wrangler secret put TURN_API_KEY  # the credential's apiKey
npx wrangler deploy
```

The object fetches fresh `iceServers` (rotation handled by Metered), caches
an hour, and serves them in the join reply. Unset or unreachable, it serves
the STUN-only list — never silence, never a hang.

## Notes

- `compatibility_date` is deliberately conservative; a newer wrangler may
  ask you to bump it — its error says exactly what it wants.
- The Durable Object name for a room is `code:<digits>`, so one object owns
  one room and `list` in the dashboard reads like a party list.
- Tests: `node scripts/test-hub.mjs` (no network, no Cloudflare, no
  dependencies). The DO shell itself is covered by that suite indirectly
  (all its rules live in hub.js) and not by a live-Cloudflare test — the
  first real deploy is its first real exercise; see `docs/room-server.md`
  → Honest gaps.
