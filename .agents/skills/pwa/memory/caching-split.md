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
| Pyodide (`sdk/pyodide/`) | **cache-first into its own cache**, `RUNTIME` = `arcade-pyodide-<hash of the folder's path, file names and bytes>`, which `prune()` keeps: it survives deploys that leave Pyodide alone. The path joined the hash on 2026-11-15, when the folder moved from `sdk/v1/pyodide/`: a new name is what makes prune drop the old ~13 MB cache (test-pwa checks it) |
| preview videos (`.webm`, `.mp4`) and Range requests | **not handled**: Safari refuses a whole cached file for a media request |
| loopback (`just run`) | code **network-first**, so an edit shows on reload. Tests opt in to the snapshot with localStorage `neon.sw=snapshot`, which makes lib/pwa.js register `sw.js?snapshot`. |

Coherence is now structural rather than a network round trip:

- **`VERSION` is a content hash** of every precached file and of sw.js itself.
  Since 2026-11-15 (one-page shell, docs/spa.md) `scripts/assemble.mjs`
  writes `dist/sw.js` at build time: the precache list is derived from what
  was built and copied (app/ chunks, pages, lib/, games/, frame runtimes) plus
  the template's own entries in the repo's `sw.js` (icons, fonts), and
  VERSION hashes exactly those bytes (with the community files). The repo's
  sw.js holds `arcade-dev`. This replaced `sw-version.mjs` and
  `check-precache`: a forgotten file is no longer possible.
- **A deploy is therefore a new sw.js.** The browser's own update check
  installs the new snapshot beside the old one, then `skipWaiting`. The next
  page load is the new deploy, whole.
- **The install is all or nothing.** One failed fetch deletes the half-built
  cache and rejects, so the old worker stays and the browser retries on its
  next update check. Swallowing failures (the 2026-08 code did this, "so one
  404 doesn't lose everything") let a hollow snapshot replace a whole one;
  sw-version.mjs now catches a listed-but-missing file before deploy instead.
- **A page keeps its deploy (pins).** After `skipWaiting` the new worker
  serves pages already open, and those pages still load files *later*:
  qr-decode.js on a first scan (lib/load.js) and every game frame build
  (lib/bridge.js). So each navigation records `clientId → VERSION` in the
  `arcade-pins` cache (worker memory does not survive the worker stopping),
  and a page's later fetches come from its own snapshot. `prune()` (on
  activate and after each navigation) drops snapshots no open page uses. A
  pin younger than `PIN_GRACE_MS` (10 s) is kept even when its page is not
  yet among the clients: the page is only listed once the navigation commits.
  The first version pruned the brand-new pin straight away, which test-pwa
  caught.
- Install uses `fetch(…, {cache: "no-cache"}) + cache.put`. "no-cache" turns
  files the first page just loaded into 304s. A miss is refilled with
  `no-cache` too, so an HTTP-cached copy from an older deploy (Pages sends
  max-age=600) is never kept under the new VERSION.

Found by an adversarial review on 2026-11-14, after the first snapshot version
had passed every test. It had swallowed install failures and let open pages
read the new deploy.

## Every game offline in single player (2026-11-15)

Lokesh: "Games, when played singleplayer/with bots should work offline."
After one online visit to the portal, every game in the catalog —
first-party, community, the SDK's examples — opens from the portal with
SINGLE PLAYER and plays with the network cut. `test-pwa` checks each one
("every game offline in single player"): it plays a move and waits for the
bot's answer (ticks for a real-time game, a start for a one-phone game),
fails on any same-origin request that missed, and fails if the room server
was asked (`/ping`: lib/party.js skips it for SINGLE PLAYER). A new game
needs an entry in its `PLAY` table or the check fails. A people-only game
(no bots, not one-phone: Draw & Guess) has no SINGLE PLAYER and is skipped.

What it took (found by that test, 2026-11-15):
- The precache missed files a game folder ships besides html/js/css/json.
  assemble.mjs now takes **all of `games/**`** (not gifs/videos), RULES.md
  and images for the examples, and the posters `assets/*.webp` (~5 KB each).
  Community games were already whole (fetch-community's precache.js).
- **Pyodide is the one exception, on purpose.** ~13 MB for a Python game's
  core: not in the install precache, which everybody pays on mobile data.
  It downloads when a Python game is picked online (sdk-host prefetchWasm).
  It used to be stored under VERSION, so **every deploy pruned it** and the
  promise "played once online, plays offline" broke silently on the next
  deploy. Now it lives in `RUNTIME`, which prune keeps; the name changes
  only when the vendored files do (a new worker, the old cache dropped).
- Offline before that one play, `runtime.file` gets sw.js's 504 and
  lib/sdk-host.js says so in a dialog (END GAME / STAY), instead of a frame
  stuck on "STARTING PYTHON…".
- The room server was never asked offline: SINGLE PLAYER skips the probe.
- Trap: a test's `ctx.addInitScript(() => localStorage…)` runs in the
  sandboxed game frames too and throws there (pageerror). Wrap it in try.

## Testing an update: stage a real deploy

`test-pwa` serves a **temporary copy of the site** and changes real files in
it. It checks four things:

- A deploy with a file missing does not install.
- A lone changed file is not mixed in.
- After a real deploy (new VERSION) installs, the open page still reads its
  old snapshot.
- A reload gets the new deploy, and the old snapshot is pruned once its pins
  pass their grace.

What did not work, so don't retry it:

- **Playwright `ctx.route` fulfilling `sw.js` and `lib/games.js`.** It
  looked as though the worker `update()` brought in installed only a
  fragment. The likelier cause was the vacuous wait below: the cache was read
  while the install was still running. Staging real files stays because it is
  what a deploy is. Routing is not proven broken, and not proven reliable.
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
