# STATUS — volatile state

*Update in place; keep short; absolute dates. History lives in git log.*
*Not loaded by default — `AGENTS.md` points here on demand. Keep it that way:
if this file grows past ~10KB, move finished sections to `STATUS-archive.md`
rather than making every session pay for it.*

# TODO(user added)

*Updates/tasks/queries added by the owner; process only when he says, then
act → record → clear the item. This is the single inbox — do not create a
separate `TODO.md`.*

(empty — the Tug of War item was processed 2026-11-15; its block is in
`STATUS-archive.md`)

## Now (2026-11-15)

**main** has SDK v2 (docs/sdk-v2.md), the one-page Solid shell (docs/spa.md),
the features round, Neon Fission, the web-games rename and pin (63360fd), the
Community tab and ☰ menu, and one listed Tic Tac Toe. Tug of War is retired
(unlisted; its folder is deleted on web-games `bubble-rush-v2`).
**Worker deployed 2026-11-15** from 3510c58, migration 0003 applied remotely
(version b112bde4): solo runs and Sudoku verification are live (main b8909c6).

**This branch, `cleanup-v1`** (not merged): removes SDK v1 and the old page
stubs (the shell's addresses are the only ones), creates docs/platform.md
(was docs/sdk.md), and shortens lib/README.md to an index (its API and
connectivity detail moved to docs/index.md "The party API" / "Connectivity").

**In progress on other branches:**
- **Bubble Rush on SDK v2** — web-games `bubble-rush-v2` (../arcade-games-v2)
  and this repo's `game-bubble-rush`: fixing review findings, bots being
  softened. Its pin moves by PR.
- **Solo and vs-bots leaderboards** — `solo-boards` (../games-boards) plus
  web-games `light-cycles-solo` (../web-games-lc). Adds D1 migration
  `0004_bot_wins.sql`: Claude applies it remotely and deploys the worker after
  the merge (Lokesh approved).
- **Match integrity and ratings** — `social-ratings` (../games-ratings,
  2026-11-16, not merged): a match counts only for accounts that reported
  it; leaving a ranked match is a loss (with the leaver's own start as
  evidence); pairwise-Elo rating for free-for-all and teams, provisional
  for 10 games; the rating change on the end card; the Worker's generated
  table of games (worker/api/games.js); no migration. Deploy:
  `just deploy-worker` after the merge (docs/accounts.md "Deploying the
  ratings and integrity changes"). Also optional boards: `"leaderboard":
  false` for Tic Tac Toe, Connect 4, Undercover; Draw & Guess on web-games
  branch `no-board-draw-guess` (../web-games-dg, 5521041), its pin to move.
  Parallel: `social-friends` (friends, groups, profile UI, migration 0005).
- **Real-device testing** on Lokesh's Android phone (scanning, installing,
  Neon Fission, web-app start-up time). iOS and Firefox's install hints remain
  unverified (docs/index.md "Honest gaps").
- **Then, approved by Lokesh:** frame prebuild at deploy; edge caching of
  leaderboard GETs; preview GIFs out of the repo; the rating change on the end
  card; quick play; sound/vibration settings and an accessibility pass;
  free-plan usage limits; join-failure measurement; parallel CI; fix the
  `just` variadic-recipe gotcha; worker deploy from CI with approval (Lokesh
  will add a `CLOUDFLARE_API_TOKEN` secret) plus D1 backups.

**Waiting on others:** Locale (rajarshi99/locale-chess) PR #1 is still open
(checked 2026-11-15); after he merges, he proposes his own registry pin, and
its submission check is the first real container build of a web app — none
has run on Actions yet, and no app is in the registry.

**Known leftovers:** the local clones are still ../arcade-games and
../arcade-games-v2 (the Sudoku cross-check in test-accounts skips until they
are ../web-games-v2); adapters' result types lack title/details/names; the
Neon Survival preview ends early; Neon Fission is untested at 8 seats in a
browser; a pass-the-phone game counts as a game against bots in the owner's
stats.

## Archive

Finished work is in `STATUS-archive.md`. Durable gaps (untested 8-player
cap, bot strength, Draw & Guess's addressed word, `secrets.channel()` with no
user, iOS) are in docs/index.md "Honest gaps", not here.

## Next actions

- [ ] **2027-02-15: remove the dev kit's transition copy.** `scripts/assemble.mjs`
      publishes `sdk/dev-server.mjs` at the old address `sdk/v1/dev-server.mjs`
      (SDK v1 removed 2026-11-15, branch `cleanup-v1`; docs/platform.md "The dev
      kit"). Then drop its copy step, the check in `scripts/test-devkit.mjs`,
      and the notes in docs/platform.md, docs/spa.md, docs/sdk-v2.md,
      docs/development.md and the Justfile, and update web-games' README
      dev-kit curl line to `sdk/dev-server.mjs`.
- [ ] **More one-device party games.** `local: true` makes them cheap now, and
      the category is the one the arcade was missing. Candidates, roughly in
      order of how different they are from Undercover: a **hot-potato word
      game** (a letter combo and a timer that goes off when it likes — frantic
      rather than deductive), **charades/fishbowl** (teams, a timer, words
      everyone types in first), and a **werewolf narrator** (deal roles by
      passing, then the phone runs night and day).
- [ ] `lib/rounds.js` (the `timer.*` service, Neon Bid's clock) does not
      survive host succession; managed games are handed over (docs/sdk-v2.md
      "Handover"), this clock is not.
- [ ] Light Cycles' bot may be too strong to be fun (30/30 against a
      never-crash baseline), and there is no bot-difficulty concept; if one is
      wanted, decide it once for every game (Bubble Rush's bots are being
      softened now).
