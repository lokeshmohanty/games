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
assets/                 app icons, previews (gif, webm, mp4, webp posters)
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
under wrangler, and `just test` leaves them out: `just test-worker`,
`just test-accounts` and `just test-social`.

**Run one recipe per `just` call.** `just a b` runs both, unless `a` takes
`*args`: then `b` becomes an argument to `a`, never runs, and the exit is
still 0. So every such recipe refuses an argument that is a recipe's name,
test-conformance refuses an unknown lane, and catalog takes only `--check`.
`just test-just` checks all of them.

To run beside another test run, set `NEON_DIST=dist-<name>` and
`NEON_PORT_OFFSET=<n>`. A separate build folder and separate ports keep two
runs apart.

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
