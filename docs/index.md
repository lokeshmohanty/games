# games — Documentation

*Last synced: 2026-08-15.*

Entry point for all project documentation. Any LLM should be able to answer
questions about this project from this folder alone.

## Contents

- [Connecting players](#connecting-players) — the serverless handshake, paid once per person
- [Parties](#parties) — the persistent group, teams, switching games, host succession
- [Adding a game](#adding-a-game) — the module contract
- [Installing it](#installing-it) — the PWA: manifest, icons, service worker, offline
- [`../lib/README.md`](../lib/README.md) — the P2P core, registry, party, lobby and QR APIs
- (still missing: per-game design notes, decision log)

## How-to (verified commands)

| Task | Command |
|---|---|
| Test the signalling codec | `node scripts/test-codec.mjs` — no browser needed |
| Test the party end to end | `node scripts/test-party.mjs` — three real browser peers at 390x844: guest-side recruiting, teams, game switching, host succession |
| Regenerate a portal preview gif | `scripts/make-preview.sh <game>` (or `all`) — plays the game headless and writes `assets/<game>.gif` |
| Play locally with several peers | open `party.html`, click ADD PLAYER, open the invite link in another tab, paste the reply back (`file://` works; `python3 -m http.server 8000` also fine) |
| Test reply-code **scanning** | `node scripts/test-scan.mjs` — renders a real-sized reply code into a camera frame and feeds it to Chrome as a fake capture device. Scanning needs a camera *and* a secure context, so `file://` and plain `http://<ip>` will not do; the test serves the repo over `http://127.0.0.1` for that reason |
| Test installability and offline | `node scripts/test-pwa.mjs` — checks the manifest and icons, asks **Chrome itself** whether anything blocks installing, then cuts the network and loads the pages |
| Rebuild the app icons | `node scripts/make-icons.mjs` after editing `assets/icon.svg` — renders the PNGs the manifest needs |
| Get back to the portal | every page has a fixed `.portal-link` ("← ALL GAMES") linking to `index.html` |

Per-game recorder scenarios, the conversion profiles, and the NixOS/Playwright
traps live in the `game-previews` skill (`.agents/skills/game-previews/SKILL.md`).

Two more skills hold the traps that this document only summarises — read them
before changing either subsystem:

- `.agents/skills/multiplayer/` — the P2P layer. Its memory records why SCAN
  REPLY has failed twice, and the one test shape that catches it.
- `.agents/skills/pwa/` — installability and offline. Its memories record why an
  SVG in `manifest.icons` makes the app uninstallable, and why code is fetched
  network-first.

## Connecting players

The handshake is carried by the players — there is no signalling server and no
third-party relay (see `MEMORY.md` → no-third-party-services).

| Step | Same room | Apart |
|---|---|---|
| Inviter → newcomer | newcomer scans the invite QR with their phone camera | inviter sends the invite link over any chat app |
| Newcomer → inviter | inviter taps **SCAN REPLY** and points the camera at the newcomer's screen | newcomer sends the reply code back; inviter taps **PASTE**, or pastes it and taps **CONNECT** |

**That cost is paid once per person, by whoever is next to them.** Any member
can invite, not only the host, and once someone is connected the rest of the
party negotiates with them automatically over the links that already exist.
This is why the topology is a mesh rather than the star it used to be: the
expensive part of a mesh was never the connections, it was the copy-pastes.

**SCAN REPLY** is served by `lib/qr-decode.js`, a from-scratch QR decoder plus
camera scanner. It prefers the browser's `BarcodeDetector` where that exists
(Android Chrome) and falls back to its own decoder, because desktop Chrome and
iOS Safari do not ship one. Always call the returned `stop()` — it releases the
camera, which the browser will not do on its own.

Two things about that scanner are load-bearing, and both were learned by it not
working:

- **Resolution is never traded for speed.** A reply code is a 70-90 module grid
  read off somebody else's screen, so pixels per module is the scarce resource.
  The scanner used to lower its working resolution when a decode ran long —
  and the frames that run long are the *empty* ones, the ones the camera sees
  while its owner is still lining the phone up. It therefore threw away the
  detail it needed before it had seen anything, and from then on could not read
  a reply code at all: camera live, preview fine, nothing ever scanned. Cost is
  managed instead by decoding the centred square (what the preview shows) and
  by running the cheap binarisation pass on most frames and the full ladder on
  every third.
- **A platform decoder that fails must not take ours with it.** Chrome exposes
  `BarcodeDetector` on platforms where the service behind it is missing, and
  `detect()` then rejects on every frame; the rejection used to skip the
  fallback entirely. It is now dropped permanently on first failure.

`scripts/test-scan.mjs` covers both, including the aiming that precedes a real
scan and a CPU throttled to phone speed.

## Parties

`party.html` is the shell that keeps a group together. Because every game is a
mountable module and the room is a mesh, **switching games is a DOM swap, not a
page navigation** — nobody reconnects and nobody re-scans.

- **Roster** — everyone's name, editable and remembered in `localStorage`.
- **Teams** — each member is Team A, Team B, or WATCHING. Each game declares the
  shape it wants (`teams` / `coop` / `free`) and the switcher refuses to start
  one whose roster does not fit, saying why.
- **Spectators** are excluded from `players()`, so a game seats and scores only
  the people actually playing.
- **Host controls** — assign teams, remove a member, hand over the crown, or
  delete the party.

### When the host goes

The party outlives it. A dropped link is not assumed to be a departure: the
party probes first, and anyone still connected to that member vouches for them.
Only silence counts as gone, and that conclusion is broadcast so everyone drops
them together.

If the host was the one who went, the longest-present remaining member (ties
broken by id, so everyone nominates the same person) is **offered** the crown —
never given it silently. Everyone else is told who is taking over. The only
thing that ends a party is the host explicitly choosing DELETE PARTY.

A page reload is the one case that cannot be rescued: WebRTC credentials are
per-connection, so a reloaded browser must handshake again — though any member
can invite them straight back in.

## Adding a game

One file in `games/`, one script tag in `party.html`, one in its own page.
Nothing in the shell changes; the switcher lists whatever registered itself.
The contract is documented at the top of `lib/games.js` and summarised in
[`../lib/README.md`](../lib/README.md#adding-a-game).

The rule that matters: `mount(ctx)` must return an object with `unmount()` that
stops every loop, timer and window listener it started. Games are swapped
without a page reload, so anything left running fights the next game for input.

Each game keeps a standalone page (`connect4.html` and friends) as a deep link
into that one game. Those pages mount the same module through the plain
two-player lobby, so a game is implemented exactly once.

`games/tug-of-war.js` was written specifically to test that contract, and is
worth reading first when adding a game: it is the only one with more than one
player per side, so it is where `seats("A")` is read as a group rather than as
`seats("A")[0]`. Adding it needed no change to anything in `lib/` — one file,
one script tag in `party.html`, one thin page, one recorder scenario.

## Installing it

The arcade is a PWA: `manifest.webmanifest`, icons under `assets/`, and `sw.js`
at the repo root so its scope covers every page. `lib/pwa.js` registers the
worker and fills any `[data-install-slot]` element with an INSTALL APP button
when the browser says the app can be installed (the portal has one under the
title); on iOS, which has no install event, it leaves the Add to Home Screen
hint instead. On `file://` there is no secure context and none of this runs.

**The caching split is the design decision.** Code — the pages, `lib/`,
`games/` — is fetched **network-first**: those files must agree with each other,
and serving one from a stale cache beside another fetched fresh breaks the app
silently, days after the deploy responsible. Icons and preview gifs are
**cache-first**, being large, stable, and harmless when slightly old. The
offline copy is precached in one go at install, so with no network you get one
coherent deploy rather than an accumulation. The preview gifs are deliberately
left out of that precache (~2 MB, and nobody asked for them yet), which is why
`assets/placeholder.svg` exists.

**Do not put an SVG in the manifest's `icons`.** Listed with `sizes: "any"`,
Chrome selects it as *the* install icon, refuses it, and reports
`no-acceptable-icon` for the entire set — the app becomes uninstallable while
every hand-written check still passes. This was caught only by asking Chrome
through CDP, which `scripts/test-pwa.mjs` now does on every run. The SVG remains
the favicon via `<link rel="icon">`.

## Honest gaps

- Per-game design notes and a decision log are still missing.
- Scanning is verified at realistic code density — a reply code occupying part
  of a full-resolution frame, preceded by seconds of empty aiming frames, on a
  CPU throttled to phone speed — but via a fake capture device, **not** a real
  phone camera. Nothing here reproduces glare, autofocus or motion blur. A
  640x480 webcam is recorded as passing at close range only; below that, PASTE
  is the answer.
- The mesh is tested with three peers; nothing has exercised the 8-player cap,
  and no test forces a pair to fail so the relay path runs in anger.
- Cross-network play over mobile data is expected to fail on carriers using
  CGNAT/symmetric NAT — confirmed in the wild on 2026-08-10. This is the
  no-TURN trade-off, not a bug; the error now names which case you hit.
- There is no TURN server by choice, so players behind symmetric NAT cannot
  connect at all; this surfaces as an explicit error, not a hang.
- Installability and offline are verified against headless Chrome only. No real
  phone has been asked to install it, and iOS in particular is unverified: it
  ignores the manifest's icons, gets no install event, and Safari's service
  worker eviction rules are its own.
- The service worker's `VERSION` is bumped by hand, there being no build step to
  hash anything. Forgetting it costs an out-of-date *offline* copy; because code
  is network-first it can never serve a stale app to a player who is online.
