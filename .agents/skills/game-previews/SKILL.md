---
name: game-previews
description: Use when a game's portal preview gif in assets/ needs to be created, refreshed, or is missing/broken on index.html — including after changing a game's visuals, adding a new game, or when someone asks to "record" or "make a gif of" a game. Covers the automated browser-driven recorder, not hand-recording.
---

# Game preview gifs

The portal (`index.html`) shows one looping gif per game, from `assets/<game>.gif`.
Regenerate them with the recorder in `scripts/` — **do not ask the user to play the
game while you screen-record.** The recorder drives the game in a headless browser,
so it needs no human and does not take over the screen.

## Make a gif

```sh
scripts/make-preview.sh connect4          # one game
scripts/make-preview.sh all               # every game
scripts/make-preview.sh draw-guess --seconds 20 --width 700
scripts/make-preview.sh neon-survival --trim-end 3   # drop an unwanted tail
```

That is the whole job: it plays the game, records it, converts it, and writes
`assets/<game>.gif` in place. `index.html` already points at that path, so a
successful run needs **no HTML edit**.

Games: `onitama`, `light-cycles`, `connect4`, `draw-guess`, `neon-survival-mp`,
`tug-of-war`. `scripts/preview.mjs --list` is the authority.

## What it does

1. `scripts/preview.mjs <game>` opens the game from `file://` in the system Chrome
   under Playwright and plays a scripted scenario, recording the first page to webm.
   For the P2P games it opens **two** pages and performs the invite/answer handshake
   between them (`connectPeers`), so the gif shows real multiplayer.
2. It prints `video=`, `start=`, `duration=`; `start` is how much lobby/connection
   time to trim so the gif opens on gameplay.
3. `make-preview.sh` converts with the `screen-rec` CLI (plain ffmpeg if absent) using
   a per-game profile — 600px/12fps for the board games, 480px/10fps/low colour for the
   Neon Survival games, whose constant motion over a dark field defeats gif compression
   (2.7MB → 290KB when that profile was applied).

## Adding a game

Add an entry to `GAMES` in `scripts/preview.mjs`: `file`, `peers` (2 for anything using
`lib/lobby.js`), `seconds`, an optional `beforeStart(pages)` (seat bots while the lobby is
still up — Light Cycles does), and a `play(pages, seconds)` scenario. The shared helpers
`connectPeers` / `startGame` handle the lobby, so a scenario only describes
gameplay. Page 0 is always the host — only it can start the game. Add the game to `GAMES` in `scripts/make-preview.sh` too, and give it a profile
if it is motion-heavy.

## Traps (learned 2026-08-09, all already handled in the scripts)

- **Playwright's bundled chromium cannot run on NixOS** — it exits 127 (unpatched
  dynamic linker). The scripts always launch the nix-provided Chrome by
  `executablePath`. Never "fix" this by installing playwright browsers.
- **Playwright itself is not vendored** — this repo has no build step and no
  `node_modules`. `preview.mjs` finds an existing copy (npx cache) and only installs
  into `~/.cache/game-previews` as a fallback. Keep it out of the repo.
- **Draw & Guess roles**: the drawer's `#chat-input` is *disabled*. Detect the guesser
  by `isEnabled()`, not by reading `#word-display` — both peers see text there.
  Strokes drawn during the round-start reveal are cleared, hence the settle delay.
- **Neon Survival needs real play, not a blind mouse sweep** — a sweep walks into
  hazards and the clip ends on "You're down! Spectating…". `dodgeLoop` reads the live
  `player` / `enemies` / `gems` bindings via `page.evaluate` (they are top-level
  bindings in a classic script, so they resolve in global scope) and steers to the
  safest column. Expect a short clip (~4-6s), which loops fine.
- **Death is detected by `gameActive`, not `player.alive`.** Only the multiplayer game
  has `player.alive`; single-player Neon Survival's `player` is `{x,y,size,color}` and
  it ends the round by setting `gameActive = false`. Checking `player.alive` alone made
  the single-player clip run on and show nothing but GAME OVER (2026-08-09). `gameActive`
  is *also* false before the game starts, so the loop latches on having seen it true
  before treating false as death — otherwise it exits instantly.
- If a run still ends on something you don't want looping, `--trim-end N` drops the last
  N seconds (it refuses to leave under 1s).
- **The "not started yet" flag and the "already over" flag are the same flag** — and it
  has now caught two different games. Neon Survival's `gameActive` is false before the
  round as well as after it; Light Cycles' `racing` is false during the opening countdown
  as well as after the crash. A `play` loop that stops on the falsy value stops
  immediately and records two seconds of nothing (measured: an 8s clip became 2s). Latch
  on having seen it true first — `await page.waitForFunction(() => ...racing)` — before
  treating false as the end.
- **Games built on `lib/ui.js` have no `#game` element**, they have `.g-stage`. The
  harness waits for `#game, .g-stage`; waiting for the old selector alone was a silent
  20-second stall per recording, hidden behind a `.catch(() => {})`.
- **Onitama's scenario picks its move inside the page**, via
  `NeonArcade.onitamaRules.legalMoves`, and then clicks card → piece → square like a
  person. Re-deriving legality in the recorder would be a second implementation of the
  rules to keep in step.
- **Connect 4** stops early once someone wins, holding the win overlay ~1.4s.
- The P2P games no longer need any signaling service: the handshake is passed directly
  between the two pages. STUN is still contacted for candidate discovery, but two pages
  on one machine connect over host candidates even offline.
- The guest must be navigated **away from the game file first** (`about:blank`) before
  opening the invite: same-file navigation differing only in the `#i=` fragment does not
  re-run the page. The lobby also reloads itself on `hashchange` for real users.

## Checking the result

`identify assets/<game>.gif` for size/frames. To eyeball a frame, coalesce first —
GIF frames are deltas and a bare `magick 'x.gif[40]'` gives a tiny sub-rectangle:

```sh
magick assets/connect4.gif -coalesce /tmp/f-%03d.png
```

Keep each gif under ~1MB. `assets/neon-survival.gif` predates this tooling and is
1.1MB; regenerating it with `scripts/make-preview.sh neon-survival` shrinks it.

## Memory

- `memory/p2p-handshake.md` — how `connectPeers` drives the invite/answer lobby,
  the fragment-navigation trap that hangs the guest, and why back-to-back peer
  joins hid a real connection bug for months.
