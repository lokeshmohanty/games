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
  bucket.
  - **Why not CDP's network emulation:** it throttles only the page.
    Network-first code in `sw.js` would then be fetched by the service
    worker at loopback speed, and the warm runs would flatter it.
  - **Not throttled:** the room server and worker API
    (`neon-arcade-room.lokeshmohanty.workers.dev`) are real and are not
    behind the proxy. The bots path waits for them before it seats anyone
    (`lib/party.js` `hostFlow`, `lib/room-join.js` `roomServerReachable` /
    `hostRoom`), so on a real phone that wait is longer than measured here.
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

## Baseline 2026-11-14 (main @ 6dc5444, before any refactor)

Median of 3 runs: 390×844, 4× CPU, 150 ms + 1.6 Mbps shared.

| Scenario | FCP | LCP | DCL | load | to START | tap? | to frame | transferred | JS (wire / decoded) |
|---|---|---|---|---|---|---|---|---|---|
| portal (cold) | 776 ms | 776 ms | 897 ms | 14844 ms | – | – | – | 2834 KB | 59 KB / 57 KB |
| portal (warm) | 104 ms | 104 ms | 207 ms | 223 ms | – | – | – | 0 KB | 0 KB / 57 KB |
| bots (cold) | 720 ms | – | – | – | 4505 ms | yes | 7319 ms | 597 KB | 413 KB / 458 KB |
| bots (warm) | 244 ms | – | – | – | 1730 ms | yes | 1897 ms | 3 KB | 0 KB / 458 KB |
| leaderboard (cold) | 704 ms | 704 ms | 870 ms | 1227 ms | – | – | – | 162 KB | 60 KB / 58 KB |
| leaderboard (warm) | 72 ms | 72 ms | 217 ms | 223 ms | – | – | – | 0 KB | 0 KB / 58 KB |

The individual cold bots runs were 6.6, 7.3 and 7.5 s to the frame, and 4.0,
4.5 and 5.0 s to START GAME.

What the numbers say:

- **PLAY WITH BOTS is the slow path.** A cold start takes about 7.3 s and a
  tap before a game is on screen, and even warm it is 1.9 s. Most of the time
  before START GAME goes to the room-server probe and dial, which bots mode
  does not need. After the tap, about 2.8 s cold goes to building the game
  frame: serial fetches and a srcdoc of about 310 KB with inlined fonts.
- **The portal's first paint is fine, but its weight is not.** LCP equals FCP
  because the largest element is text: the preview gifs are lazy and come
  later. They still make `load` take 14.8 s and 2.8 MB on a cold visit, and
  that bandwidth competes with whatever the player taps next.
- **Warm loads are already fast** (≤ 0.25 s FCP), because the browser's HTTP
  cache answers the service worker's network-first fetches. That depends on
  the cache heuristics the server's headers allow, so a real phone on a
  flaky link would see the 3 s network-first timeout instead.
- party.html parses **458 KB of JS** before it seats anyone, cold or warm.

## Targets for Phase 1 (measured speed fixes)

| Metric | Baseline | Target |
|---|---|---|
| bots (cold) to frame | 7319 ms, tap needed | ≤ 3000 ms, **no tap** |
| bots (warm) to frame | 1897 ms, tap needed | ≤ 800 ms, no tap |
| party.html JS decoded before the game | 458 KB | ≤ 300 KB |
| portal (cold) transferred / load | 2834 KB / 14.8 s | ≤ 900 KB / ≤ 5 s |
| portal and leaderboard FCP | ~0.7 s cold | no regression |

## After each phase

*(Each phase appends its own table here, with the same harness and the same
settings.)*
