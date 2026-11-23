---
name: game-previews
description: Use when a game's portal preview (assets/<game>.webp poster, .webm and .mp4) needs to be created, refreshed, or is missing/broken on the portal — including after changing a game's visuals, adding a new game, or when someone asks to "record" a game or "make a gif/preview" of it. Covers the automated browser-driven recorder, not hand-recording.
---

# Game previews

The portal shows one looping clip per game: `assets/<game>.webm` (or `.mp4`)
over the poster `assets/<game>.webp`, which is also what the game's `game.json`
`"preview"` names. **No gif is committed for the arcade's own games** (since
2026-11-15, ~3.5 MB): the recorder makes one in a temporary folder, derives the
three files from it, and deletes it. An outside repo's `preview.gif` is its own;
`scripts/fetch-community.mjs` makes the same three beside it at deploy.
Regenerate them with the recorder in `scripts/` — **do not ask the user to play
the game while you screen-record.** The recorder drives the game in a headless
browser, so it needs no human and does not take over the screen.

## Make a preview

```sh
scripts/make-preview.sh connect4          # one game
scripts/make-preview.sh all               # every game
scripts/make-preview.sh draw-guess --seconds 20 --width 700
scripts/make-preview.sh neon-survival --trim-end 3   # drop an unwanted tail
scripts/make-preview.sh five-in-a-row --gif ../web-games/five-in-a-row/preview.gif
scripts/make-preview.sh glowdown --gif ../card-games/glowdown/preview.gif
```

`--gif FILE` is for a game in an outside repo (web-games, card-games): its
card is its own `preview.gif`, so the gif is written there and nothing in
`assets/` is touched; commit it in that repo. Build the site with that repo's
games first (`NEON_LOCAL_REPOS` / `NEON_PIN_OVERRIDE`, scripts/fetch-community.mjs
header; the override also builds game folders the registry does not list yet).
The card games' scenarios open their SINGLE PLAYER address with `&mode=bots`
and seat the quick table with `cardTable(page, n)`.

That is the whole job: it plays the game, records it, converts it to a gif in
a temp folder, writes `assets/<game>.webp`, `.webm` and `.mp4` from it
(`scripts/preview-media.mjs --out`), and deletes the gif. The game's
`game.json` already names the poster, so a successful run needs **no edit**.
A new game: set `"preview": "../../assets/<game>.webp"` and run `just catalog`.

Games: `scripts/preview.mjs --list` is the authority (2026-11-22: undercover,
liars-dice, neon-bid, battleship, light-cycles, bubble-rush, connect4,
draw-guess, neon-fission, tic-tac-toe-js, five-in-a-row, snakes-and-ladders,
neon-survival-mp). This repo's own: games/ and `tic-tac-toe-js`, the Tic Tac
Toe listed under Strategy (its game.json names `../../../../assets/
tic-tac-toe-js.webp`). The rest live in web-games, whose own preview.gif is
what the portal shows: record those with `--gif`. Five in a Row, Snakes &
Ladders and Tic Tac Toe were recorded 2026-11-22; whether the older community
scenarios (battleship, liars-dice, light-cycles, draw-guess) still run
against the community ids is unverified (VERIFY).

A one-phone scenario against bots uses `soloTable(page, n)` in its
`beforeStart` (SINGLE PLAYER, n at the quick table, START GAME, off camera).

## What it does

1. `scripts/preview.mjs <game>` serves the built site (scripts/serve.mjs) and opens the
   game's address (`?game=<id>&fresh=1`) in the system Chrome
   under Playwright and plays a scripted scenario, recording the first page to webm.
   For the P2P games it opens **two** pages and performs the invite/answer handshake
   between them (`connectPeers`), so the gif shows real multiplayer.
2. It prints `video=`, `start=`, `duration=`; `start` is how much lobby/connection
   time to trim so the gif opens on gameplay.
3. `make-preview.sh` converts to a gif with the `screen-rec` CLI (plain ffmpeg if absent)
   using a per-game profile — 600px/12fps for the board games, 480px/10fps/low colour for
   the Neon Survival games, whose constant motion over a dark field defeats gif compression
   (2.7MB → 290KB when that profile was applied). The profile still shapes the clip: the
   WebM/MP4 are made from that gif.
4. `preview-media.mjs` writes the poster (first frame, WebP), VP9 WebM and H.264 MP4
   (needs ffmpeg with libwebp, libvpx-vp9, libx264: `nix shell nixpkgs#ffmpeg`).

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
- **Playwright is a pinned dev dependency** (package.json, `just install`).
  `preview.mjs`, like every browser script, loads it through
  `scripts/playwright.mjs`, which looks only in the repo's `node_modules` and says
  to run `just install` when it is missing (changed 2026-11-16; the old npx-cache
  and `~/.cache/game-previews` lookups found nothing on a CI runner).
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
- **Games that lay out a `.g-stage` (Neon Bid, Undercover) have no `#game` element.** The
  harness waits for `#game, .g-stage`; waiting for the old selector alone was a silent
  20-second stall per recording, hidden behind a `.catch(() => {})`.
- **A scenario picks its move inside the page** when the rules already live there
  (the old Onitama scenario, removed with the game 2026-11-13, used the game's own
  `legalMoves`), then clicks like a person. Re-deriving legality in the recorder would
  be a second implementation of the rules to keep in step.
- **Connect 4** stops early once someone wins, holding the win overlay ~1.4s.
- The P2P games no longer need any signaling service: the handshake is passed directly
  between the two pages. STUN is still contacted for candidate discovery, but two pages
  on one machine connect over host candidates even offline.
- The guest must be navigated **away from the game file first** (`about:blank`) before
  opening the invite: same-file navigation differing only in the `#i=` fragment does not
  re-run the page. The lobby also reloads itself on `hashchange` for real users.

## Checking the result

`ffprobe assets/<game>.webm` for size and duration; open the poster to eyeball it,
and the portal at 390x844 to see it play (`test-portal` checks that the first screen
plays its clips over their posters, and that each clip is fetched once however many
sections show the game). To inspect the intermediate gif, keep it: run
`scripts/preview.mjs <game>` yourself and convert its `video=` output by hand.
A clip is ~15–60 KB; much more means the profile needs lowering.

## Memory

- `memory/p2p-handshake.md` — how `connectPeers` drives the invite/answer lobby,
  the fragment-navigation trap that hangs the guest, and why back-to-back peer
  joins hid a real connection bug for months.
- `memory/screenshot-breaks-frame-clicks.md` — after a screenshot in an
  `isMobile` context, Playwright clicks into the game frame stopped firing
  (2026-11-22, not root-caused); click inside the frame instead.
