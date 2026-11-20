# Developing the arcade

*Moved out of README.md on 2026-11-15, so the README is for visitors. The
architecture is in [index.md](index.md); this page covers running, testing
and maintaining the site.*

## Run it

```sh
just run          # Vite's dev server at http://127.0.0.1:8000; edits reload
just serve-lan    # the same on every interface, so a phone on the wifi can reach it
just build        # type check, vite build, scripts/assemble.mjs → dist/
just --list       # everything else
```

The recipes install the shell's dependencies first, with pnpm and the exact
`pnpm-lock.yaml`. Two tabs on one machine are enough to test a party.

**Over the LAN, SCAN REPLY doesn't work.** The camera and the service worker
need a secure context. `127.0.0.1` counts as one, but `http://<lan-ip>` does
not. Use PASTE for the reply code there.

## Where things are

```
index.html, src/        the one-page shell: Solid + Vite + TypeScript (docs/spa.md);
                        the only page (views are ./?page=…, the party ./?party)
lib/                    framework-free libraries: networking (net.js), the party
                        (party.js, lobby.js), the SDK host (sdk-host.js,
                        sdk-managed.js), QR, accounts, the theme. lib/README.md
games/<id>/             this repository's games, each with game.json and RULES.md
sdk/v2/                 the game protocol (protocol.json), runtime, web-app shim,
                        adapters for 7 languages, generated bindings, and the
                        tic-tac-toe example in each (docs/sdk-v2.md)
sdk/dev-server.mjs      the dev kit authors run (docs/platform.md); the build also
                        publishes it at sdk/v1/dev-server.mjs until 2027-02-15
sdk/arcade_server.py    a web app's Python server glue, run in Pyodide
sdk/pyodide/            (vendored, git-ignored: just pyodide) the Python runtime
registry/<owner>/<repo>.json   contributors' repositories, each pinned to a commit
community/              (generated, git-ignored) the pinned games, fetched at deploy
worker/                 the Cloudflare Worker: room server, accounts, leaderboards
                        (docs/room-server.md, docs/accounts.md)
scripts/                build, tests, preview recorder, icon generator, PR checks
assets/                 app icons, previews (webp posters, webm, mp4; no gifs since 2026-11-15)
sw.js                   the service worker template; scripts/assemble.mjs writes dist/sw.js
```

## Tech stack, and why

- **The shell** is one page in Solid + Vite + TypeScript, built with pnpm. Its
  libraries stay framework-free modules. The reasons and measurements are in
  [spa.md](spa.md) and [perf.md](perf.md).
- **Games** are framework-free. Each runs in a sandboxed frame and talks a
  message protocol that any language can speak ([sdk-v2.md](sdk-v2.md)).
- **Networking** is raw WebRTC data channels, with no networking library and no
  CDN. STUN is the only outside contact, and it never sees game data. The
  mesh carries the signalling for every new connection, so the handshake is paid
  once per person. The room server is a rendezvous for that handshake only,
  and the scan/paste handshake still works without it ([room-server.md](room-server.md)).
- **Bots** run in the host's browser, next to the game the host already
  referees. Each is a search function and a timer, with no model and no
  service ([index.md#bots](index.md#bots)).
- **Rendering** is Canvas 2D. Input is touch, mouse and keyboard, laid out for
  a 390×844 phone first.

## Tests

`just test` runs every suite, one after another, fastest first. `just --list`
names each one with a one-line summary. The suites that need the Worker run
under wrangler, and `just test` leaves them out: `just test-wrangler` runs
`test-worker`, `test-accounts` and `test-social`.

**Run one recipe per `just` call.** `just a b` runs both, unless `a` takes
`*args`: then `b` becomes an argument to `a`, never runs, and the exit is
still 0. So every such recipe refuses an argument that is a recipe's name
(except `propose`'s game folders, which may be called anything), while
test-conformance refuses an unknown lane and `catalog` refuses anything but
`--check`. `just test-just` checks all of them.

**Which `just`.** The Justfile uses no attribute and no function newer than
just 1.0, so Ubuntu's packaged just should read it. It has been run with just
1.58, which is also the version CI pins; older versions are untested.

To run beside another test run, set `NEON_DIST=dist-<name>` and
`NEON_PORT_OFFSET=<n>`. A separate build folder and separate ports keep two
runs apart.

**Firefox.** A few checks are Firefox's (test-theme, test-party,
test-portal): a phone's larger text, which Firefox for Android applies as
text zoom (emulated with the prefs `browser.display.os-zoom-behavior=2`
and `ui.textScaleFactor`), and the frame's theme. They use Playwright's own
Firefox (`scripts/playwright.mjs` `launchFirefox`) when it starts, and say
"skip Firefox" when it does not; `NEON_FIREFOX=1` makes that a failure. CI
installs no Firefox. On NixOS it needs its libraries from Nix:

```sh
node_modules/.bin/playwright install firefox   # once
LD_LIBRARY_PATH=$(scripts/firefox-libs.sh) NEON_FIREFOX=1 just test-portal
```

### CI runs the suites in parallel

`.github/workflows/test.yml` runs on every push except main's, and on pull
requests from forks, game submissions (`registry/` only) included.
`submission.yml` judges the entry, and the suites show before the merge
whether the new pin passes what the deploy will run. `deploy.yml` calls the
same workflow before every deploy, so nothing deploys unless every suite
passes. It then deploys the very site the suites passed against: the build
job's `site` artifact, not a second build.

| Job | Runs | Locally | Local, 2026-11-15 | Runner (run 43774429667) |
|---|---|---|---|---|
| static | bindings, colours, `catalog --check`, stats, submission rules, codec, the Justfile, hub, Durable Object, plumbing, rules | `just test-static` | 17 s | 17 s |
| build | Pyodide, the community games, the Worker's table of games (`check-games`, a warning here), `pnpm build` with the prebuilt frames, uploaded once as the `site` artifact | `just pyodide community check-games build` | 14 s | 54 s |
| shard 1 | test-bots | `just test-shard 1` | 264 s | 377 s |
| shard 2 | test-room, test-party, test-scan, test-theme | `just test-shard 2` | 218 s | 317 s |
| shard 3 | test-pwa, test-devkit, test-managed, test-portal, test-protocol, test-webapp, test-rules-screen, test-conformance | `just test-shard 3` | 191 s | 257 s |
| shard 4 | test-wrangler (wrangler dev with a throwaway local D1, so no secret) | `just test-shard 4` | 285 s | 340 s |

The local times are the suites' own, one after another on Lokesh's machine.
The runner times are whole jobs, setup included. A serial `just test` takes
about 11 minutes locally. CI's longest path is build, then the slowest shard:
about 7 minutes.

The shards wait for both static and build, and each one downloads that build.
`check-games` fails `just test` locally, but in CI it only warns. A merged
pin leaves `worker/api/games.js` stale until `just games-table` is committed
and `just deploy-worker` run (docs/accounts.md), and that must not hold up
the site's deploy.
The groups are the `_shard-<n>` recipes in the Justfile, so a shard runs the
same way locally. Locally, `just test-shard <n>` vendors Pyodide, fetches the
community games and builds first; `NEON_BUILT=1` skips that. A suite added to
`test` must also go into a shard. `just test-just` fails until it is in
exactly one, and also fails if the CI matrix and the Justfile disagree. In CI,
a wrangler suite that skips because wrangler would not start counts as a
failure.

**A community game without a test-pwa driver still passes.** A pin moves by
a registry-only pull request, which can't add a driver to `test-pwa.mjs`, so
a new community game only has to mount offline in SINGLE PLAYER and say
ready. The missing driver shows as an `info` line. This repo's own games must
have a driver.

**Emergencies only: deploying without the tests.** Run "Deploy to Pages" by
hand (Actions → Deploy to Pages → Run workflow) with `skip_tests` ticked. It
skips the suites and builds the site in the deploy workflow, as before the
gate existed. Use it only when a broken test, not a broken site, is blocking
a fix that has to ship. Then fix the test.

## Offline and the service worker

`scripts/assemble.mjs` generates `dist/sw.js` with its precache list, and its
`VERSION` is a hash over the files.
- **Code** (the shell, `lib/`, `games/`) is served from one precached snapshot
  per deploy, because those files have to agree with each other. A deploy
  therefore arrives whole on the next load.
- **Icons, fonts and previews** are served from the cache first.

The details are in the `pwa` skill (`.agents/skills/pwa/`) and in [spa.md](spa.md).

The INSTALL APP button depends on `beforeinstallprompt`, which only Chromium
browsers implement. `lib/pwa.js` explains on the page what Firefox users can do
instead.

## Previews and icons

- **Portal previews:** `just preview <game>` or `just preview all` records a
  game headlessly. The recorder and its scenarios are described in the
  `game-previews` skill (`.agents/skills/game-previews/`).
- **App icons:** edit `assets/icon.svg`, then run `just icons`. The portal
  header draws the same glyph inline (`index.html`, `h1.brand`) in the theme's
  colours, so redraw it there too.
