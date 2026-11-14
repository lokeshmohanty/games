# Why code comes from one versioned snapshot (network-first before 2026-11-14)

The invariant has not changed since `sw.js` was written on 2026-08-15: **a
page must run one coherent deploy.** The strategy that keeps it did change.

**Why:** the files here are a set that must agree. `party.js` calls into
`net.js`, every game registers against `games.js`, and the bridge inlines
`lib/` into game frames. Serve one file from an old deploy beside another from
a new one and the app breaks silently, days after the deploy responsible, on
one user's device. "Cache-first for speed" is the default advice, and plain
stale-while-revalidate is its most tempting form. **It is wrong here**: a
per-file background refresh writes new files into the old set.

## 2026-08-15 to 2026-11-14: network-first

Code was always asked of the network, so an online player ran the latest
deploy; the cache was only a fallback, with a 3 s timeout. `VERSION` was bumped
by hand, and forgetting it only staled the offline copy. That cost a round trip
per file, plus a 3 s stall per file on a bad link. Measured in `docs/perf.md`
when the speed refactor started.

## Since 2026-11-14: one snapshot per VERSION

| what | strategy |
|---|---|
| pages, `lib/`, `games/`, `sdk/` | **from this VERSION's precache, as-is**. The network only for a file outside SHELL, which is then kept. |
| icons, fonts, posters, gifs | **cache-first**, nothing downloaded behind a hit |
| preview videos (`.webm`, `.mp4`) and Range requests | **not handled**: Safari refuses a whole cached file for a media request |
| loopback (`just run`) | code **network-first**, so an edit shows on reload. Tests opt in to the snapshot with localStorage `neon.sw=snapshot`, which makes lib/pwa.js register `sw.js?snapshot`. |

Coherence is now structural rather than a network round trip:

- **`VERSION` is a content hash** of every precached file and of sw.js itself
  (`scripts/sw-version.mjs`). `just test` (`check-sw-version`) and
  platform-check fail on a stale one, and the deploy rehashes with
  `--with-community` after fetching the pinned games.
- **A deploy is therefore a new sw.js.** The browser's own update check
  installs the new snapshot beside the old one, `skipWaiting`, then `activate`
  deletes the old cache, and the next page load is the new deploy, whole.
- Install uses `fetch(…, {cache: "no-cache"}) + cache.put`. "no-cache" turns
  files the first page just loaded into 304s. It is fetch + put rather than
  `cache.add` so a test can see the request.

The one window where two deploys meet: an open page that loads a file *later*
(qr-decode.js on a first scan, a game frame's files) after the new worker has
activated. It was the same under network-first.

## Testing an update: stage a real deploy

`test-pwa` serves a **temporary copy of the site** and changes real files in it
(`lib/games.js`, then `sw.js`'s VERSION). It checks three things: the page
still gets the old file (the snapshot holds), the new file arrives once the
new snapshot is in, and it never arrives while that snapshot is still
installing.

What did not work, so don't retry it:

- **Playwright `ctx.route` fulfilling `sw.js` and `lib/games.js`.** The worker
  that `update()` brought in installed only a fragment, or never fetched the
  routed script at all. Interception of a worker's own install is unreliable.
- **`page.waitForFunction(async () => …)`.** In Playwright 1.62 it resolves at
  once, because its Promise is truthy. It had made an existing check ("the
  precache holds all N shell files") pass without waiting, and it made the
  update look instant. Poll from Node.

## Testing offline: `setOffline` is not enough

`context.setOffline(true)` does **not** reach the fetches the service worker
itself makes, which are the ones under test. Use route interception to cut the
network instead:

```js
const disconnect = (route) => route.abort("internetdisconnected");
await ctx.route("**/*", disconnect);
```

Related: [[installability-verdict]].
