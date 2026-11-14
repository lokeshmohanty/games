# Performance — measured on a phone-sized, throttled browser

*Started 2026-11-14 for the speed refactor (plan of record:
`~/.claude/plans/ethereal-honking-beaver.md`; decisions in the multiplayer
skill's `gaming-platform-vision` memory). Every phase of that refactor is
measured against the baseline below, with the same harness.*

## The harness: `just perf`

`scripts/perf.mjs` (`just perf`, `just perf --runs 1` for a quick look,
`--label <name>`, `--out results.json`). It is not part of `just test`, and a
full run takes a few minutes.

- **The phone:** a Playwright context at 390×844, DPR 3, `isMobile` and
  `hasTouch`, with 4× CPU throttling through CDP
  (`Emulation.setCPUThrottlingRate`).
- **The link:** a throttling proxy in front of `scripts/serve.mjs`. Every
  request waits 150 ms, and response bytes share one 1.6 Mbps (200,000 B/s)
  bucket. Text is gzipped on the way, because GitHub Pages compresses it and
  Python's static server does not. The first baseline (below, superseded) ran
  without gzip and paid about 3× the real bytes for scripts.
  - **Why not CDP's network emulation:** it throttles only the page.
    Network-first code in `sw.js` would then be fetched by the service
    worker at loopback speed, and the warm runs would flatter it.
  - **Not throttled:** the room server and worker API
    (`neon-arcade-room.lokeshmohanty.workers.dev`) are real and are not
    behind the proxy. The bots path waited for them before it seated anyone
    until Phase 1, so on a real phone the baseline's wait was longer than
    measured here.
  - **Not throttled either:** the game's own frame. It is a sandboxed,
    separate-process iframe, and CDP CPU throttling reaches only the page's
    process.
- **Service worker:** runs in the deployed site's mode (localStorage
  `neon.sw=snapshot`, see sw.js), not loopback's development network-first.
- **Cold vs warm:**
  - **Cold** is a fresh profile.
  - **Warm** is the same profile after one visit, a reload, and the service
    worker in control.
- **Scenarios:**
  - **portal**: `index.html` until `load`, plus 1.5 s for LCP to settle.
  - **bots**: what PLAY WITH BOTS opens (`party.html?game=connect4&fresh=1&mode=bots`).
    - It times the START GAME button appearing, taps it if needed (and
      records that a tap was needed), then times until the game's sandboxed
      frame is up (`gameFrame()`: `window.__game.handle` exists).
  - **leaderboard**: `leaderboard.html` until `load`.
- **Columns:** medians of N runs. FCP and LCP come from the Performance API.
  *to START* and *to frame* are wall-clock times from navigation start.
  *transferred* sums the `transferSize` of the navigation and every resource.
  *JS* is the `.js` resources only: on the wire and decoded. Warm runs show
  ~0 KB on the wire because responses come from the cache.

## Baseline 2026-11-14 (before any refactor, community games present)

Median of 3 runs: 390×844, 4× CPU, 150 ms + 1.6 Mbps shared, gzip. The code is
main @ ba3b260 plus the harness (f2c088b), with `community/` fetched as the
deploy has it.

| Scenario | FCP | LCP | DCL | load | to START | tap? | to frame | transferred | JS (wire / decoded) |
|---|---|---|---|---|---|---|---|---|---|
| portal (cold) | 460 ms | 460 ms | 616 ms | 29737 ms | – | – | – | 5734 KB | 27 KB / 62 KB |
| portal (warm) | 124 ms | 124 ms | 115 ms | 139 ms | – | – | – | 0 KB | 0 KB / 62 KB |
| bots (cold) | 420 ms | – | – | – | 3190 ms | yes | 4901 ms | 313 KB | 152 KB / 463 KB |
| bots (warm) | 260 ms | – | – | – | 1610 ms | yes | 1780 ms | 3 KB | 0 KB / 463 KB |
| leaderboard (cold) | 452 ms | 452 ms | 619 ms | 974 ms | – | – | – | 100 KB | 27 KB / 63 KB |
| leaderboard (warm) | 124 ms | 124 ms | 90 ms | 98 ms | – | – | – | 0 KB | 0 KB / 63 KB |

What the numbers said:

- **PLAY WITH BOTS was the slow path.** A cold start took 4.9 s and a tap
  before the game was on screen, and even warm it took 1.8 s. Most of the
  time before START GAME went to the room-server probe and dial, which bots
  mode does not need. After the tap, building the game's frame meant serial
  fetches and a srcdoc of about 310 KB with inlined fonts.
- **The portal's first paint was fine, but its weight was not.** The preview
  gifs (5.7 MB with the community games) made `load` take 30 s on a cold
  visit, and that bandwidth competed with whatever the player tapped next.
- **party.html parsed 463 KB of JS** before it seated anyone.

*Superseded:* the first baseline (main @ 6dc5444) ran without gzip and
without `community/`, so it had fewer gifs. That gave a 7.3 s cold bots start
and a 14.8 s, 2.8 MB portal. Same story, wrong absolutes.

## Targets for Phase 1 (measured speed fixes)

| Metric | Baseline | Target | Phase 1 |
|---|---|---|---|
| bots (cold) to frame | 4901 ms, tap needed | ≤ 3000 ms, **no tap** | **2164 ms, no tap** ✓ |
| bots (warm) to frame | 1780 ms, tap needed | ≤ 800 ms, no tap | **287 ms, no tap** ✓ |
| party.html JS decoded before the game | 463 KB | ≤ 300 KB | 403 KB ✗ (needs minifying and bundling: Phase 4's build) |
| portal (cold) transferred / load | 5734 KB / 29.7 s | ≤ 900 KB / ≤ 5 s | **471 KB / 2.6 s** ✓ |
| portal and leaderboard FCP | ~0.46 s cold | no regression | 0.47 / 0.42 s ✓ |

## After each phase

### Phase 1 — measured speed fixes (branch platform-v2, 2026-11-14)

Median of 3, same settings as the baseline.

| Scenario | FCP | LCP | DCL | load | to START | tap? | to frame | transferred | JS (wire / decoded) |
|---|---|---|---|---|---|---|---|---|---|
| portal (cold) | 468 ms | 468 ms | 624 ms | 2635 ms | – | – | – | 471 KB | 28 KB / 66 KB |
| portal (warm) | 184 ms | 184 ms | 87 ms | 333 ms | – | – | – | 0 KB | 0 KB / 66 KB |
| bots (cold) | 460 ms | – | – | – | – | no | 2164 ms | 301 KB | 140 KB / 403 KB |
| bots (warm) | 136 ms | – | – | – | – | no | 287 ms | 0 KB | 0 KB / 403 KB |
| leaderboard (cold) | 424 ms | 424 ms | 710 ms | 1068 ms | – | – | – | 100 KB | 27 KB / 65 KB |
| leaderboard (warm) | 108 ms | 108 ms | 90 ms | 97 ms | – | – | – | 0 KB | 0 KB / 65 KB |

What did it, roughly in order of effect:

- **Bots and one-device games start at once** (lib/party.js `autoStart`,
  `ensureCode`). No room-server probe or dial before seating, no START tap.
  The party code is fetched in the background once friends are wanted.
- **Preview videos** (scripts/preview-media.mjs). WebM/MP4 plus a WebP poster
  per gif, at about a tenth of the bytes, played only while on screen. Four
  unreferenced gifs were deleted.
- **The game frame builds in parallel and early** (lib/bridge.js). Every fetch
  goes at once, fetched files and built documents are kept for the page's
  life, and `prefetchFrame` starts as soon as `?game=` is parsed.
- **Less JS before the party.** ui, secrets and rounds run only in frames;
  qr-decode and py-server load on first use (lib/load.js).
- **The service worker serves code from one versioned snapshot** (sw.js,
  scripts/sw-version.mjs). There is no per-file network round trip and no 3 s
  stall on a bad link, and a deploy still arrives whole. Its effect is mostly
  on a real flaky phone, which this harness's steady link does not show.
- **neon-survival-mp** stamps pre-rendered glow sprites instead of drawing
  `shadowBlur` per entity per frame, on a DPR-scaled canvas. In a crowded
  scene (300 enemies, frame throttled 6×) it went from 28 fps (p95 50 ms) to
  35–47 fps (p95 33 ms). On a real DPR-3 phone it now also draws 4× the
  pixels, for sharpness; that has not been measured on a device.

Tried and reverted: **font preloads**. They cost about 250 ms of cold FCP
(portal 764 → 1028 ms, leaderboard 696 → 904 ms, without gzip), because they
compete with render-blocking CSS.

Not done, on purpose:

- **Patching `party.js render()` and portal `draw()` in place** would be
  thrown away when Phase 4 rewrites both in Solid.
- **Replacing bridge.js's 250 ms party poll.** It stringifies a few-member
  object four times a second and backs the away/reconnecting flags that
  turn-wait banners read. There is nothing to measure there, and a risk to
  those flags.

### Phase 2 — SDK v2 protocol and WebAssembly (2026-11-14)

Phase 2 adds `lib/sdk-host.js` (about 20 KB raw) to party.html and changes
no v1 game's path. Median of 3 (portal: 5), same harness:

| Scenario | Phase 1 | Phase 2 |
|---|---|---|
| bots cold, to frame | 2164 ms | 2190 ms |
| bots warm, to frame | 287 ms | 355 ms (runs: 323, 459, 355) |
| bots, JS decoded | 403 KB | 426 KB |
| portal cold, bytes / load | 471 KB / 2.6 s | 482 KB / 2.6 s |

The bots numbers are within the run-to-run spread. The extra 23 KB decoded
is sdk-host.js, which loads even when a v1 game is picked. Phase 4's bundle
splits it out.

**Found by the re-measure, and fixed: the gif fallback.**
- **What happened:** two of three cold portal runs downloaded 1.9 MB and
  5.9 MB, not 0.47 MB. `just perf --debug` (new: each run's five largest
  downloads) showed every preview video failing at once, after which every
  card's error handler (Phase 1) fell back to the 0.4–1 MB gif.
- **The fix:** a failed video now shows the card's ~5 KB poster, still.
  test-portal checks it with every video aborted: posters show, and no gif
  is requested.
- **Afterwards:** five cold runs, 198–482 KB, load ≤ 2.6 s.
- **Not known yet:** why the videos all failed. It may be the throttling
  proxy, or headless Chrome's media stack. **VERIFY** on a real phone; the
  poster fallback makes it cheap either way.

### Phase 3 — Neon Survival as a managed, ticking game (2026-11-14)

The host simulates at 30 Hz (`tick`) and sends views at 15 Hz; guests draw
each enemy along its velocity between views. Method:
- a crowded scene (300 enemies) at 390×844, DPR 3, host alone;
- the frame CPU-throttled through `ctx.newCDPSession(frame)`;
- 8 runs with v1 and v2 interleaved, since other test runs shared the
  machine.

| Throttle | v1 | v2 |
|---|---|---|
| 6× | 60 fps | 60 fps |
| 20× | ~35 fps (p95 33–67 ms) | ~39 fps (p95 33 ms every run) |

v2 was faster in all 8 pairs. Both profiles are dominated by raster and
`drawImage`; messaging is about 3%.
