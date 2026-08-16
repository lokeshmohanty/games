# Why code is network-first and assets are cache-first

Decided 2026-08-15, when `sw.js` was written.

**Why:** "cache-first for speed" is the default advice for a service worker and
it is wrong for this repo. The reasoning is not obvious from the code, so it
would be optimised away by anyone who read `sw.js` as a performance artefact.

## The split

| what | strategy | reason |
|---|---|---|
| pages, `lib/`, `games/` | **network-first**, cache as fallback | these files must agree with each other |
| `assets/` (icons, preview gifs) | **cache-first**, revalidated in background | large, stable, harmless when slightly stale |

## The failure cache-first would cause

The files here are a set that has to be internally consistent: `party.js` calls
into `net.js`, every game registers against `games.js`, `lobby.js` depends on
`qr-decode.js`. Serve one from a stale cache while another arrives fresh and the
app breaks — **silently, and days after the deploy responsible**, on one user's
device, in a way nobody would connect back to a release. There is no build step
here to hash filenames and make that impossible, so the worker has to be the
thing that prevents it.

Network-first means an online player always runs one coherent deploy. The cache
is a fallback, not a source of truth. The offline snapshot is written in a
single `install` precache, so with no network you also get one coherent deploy
rather than an accumulation of whatever happened to be fetched when.

Cost: a network round trip per file while online. Accepted. It is a small static
site behind GitHub Pages' CDN, HTTP caching still applies, and `networkFirst`
falls back to the cache after `NETWORK_TIMEOUT_MS` (3 s) so a bad connection
never leaves somebody staring at nothing.

## The `VERSION` trade-off

`VERSION` in `sw.js` is bumped by hand — there is no build step to hash
anything. This is a deliberate, bounded cost: **forgetting it can only stale the
offline copy, never serve a stale app to a player who is online**, precisely
because code is network-first. Under a cache-first worker the same slip would be
unbounded and near-undiagnosable. Recorded as an Honest gap in `docs/index.md`.

## Testing offline: `setOffline` is not enough

`context.setOffline(true)` does **not** reach the fetches the service worker
itself makes, which are the ones under test — pages appeared to load while the
worker was quietly still talking to the server. Use route interception instead:

```js
const disconnect = (route) => route.abort("internetdisconnected");
await ctx.route("**/*", disconnect);
```

`ctx.route` does intercept worker-originated requests (proven both ways: it is
also how `test-pwa.mjs` fakes a redeploy to check that network-first actually
picks up a changed file). Related: [[installability-verdict]].
