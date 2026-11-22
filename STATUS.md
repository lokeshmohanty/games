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

## Now (2026-11-18)

**Branch `new-games` (2026-11-22, both repos, pushed, not merged):** Five in
a Row and Snakes & Ladders in web-games (`new-games`), and here test-taps,
test-bots and preview scenarios for them, Tic Tac Toe's portal preview
(`assets/tic-tac-toe-js.*`), `make-preview.sh --gif` for web-games cards,
and NEON_PIN_OVERRIDE building a branch's unlisted game folders. To land:
merge, then a pin PR that moves `registry/lokeshmohanty/web-games.json`
(commit and both games) and runs `just games-table` — until then test-taps
and test-bots fail on the two games without the override. Ludo is still to
build (brief from Lokesh, 2026-11-21).

**Branch `quick-start` (2026-11-22, pushed, not merged):** one tap on a game
starts it against bots, PLAY WITH FRIENDS (end card and PARTY, "Bottom,
between rounds" — no bar, boards keep their size), CHANGE PLAYERS, a first
visit's name, My Games and genre pages as grids, "Search games".

**main f41a01e is live** (Pages deploy gated on tests; worker version
7846f9ec deployed 2026-11-18, D1 migrations through 0005 applied remotely).
Everything from the 2026-11-15..18 round is merged: SDK v1 removal and
docs/platform.md, Bubble Rush on v2 (and its tap fix: a tap is judged on the
frame on screen), solo and vs-bots boards, friends/groups/invites, ratings
(pairwise Elo, leaving = loss) and optional boards (none for Tic Tac Toe,
Connect 4, Undercover, Draw & Guess — web-games pin fa18304, PR #11), fonts
after mount, CI-gated deploys, the stuck-party fix, the split-party election
(docs: `.agents/skills/multiplayer/memory/split-party.md`), the quick table
before SINGLE PLAYER, last-move markers, and the flaky-test fixes
(test-accounts pins the server clock with `X-Test-Now`, tests only).

**In review: signed party messages** (branch `signed-party`, not merged;
2026-11-18/19). Ids are key hashes (per tab, IndexedDB), every sender is
proven (link hello or signature), crowns need proof, old clients refused.
docs/index.md "Who said it"; memory `signed-messages.md`. Waits for
Lokesh's review before merge; the open residuals are in Honest gaps.

**Queued (approved by Lokesh, not started):**
- **Web Push** — built on branch `web-push` (2026-11-18..21, pushed, not
  merged or deployed): opt-in per device, party invites only; the review's
  abuse and reliability findings fixed 2026-11-21 (news-only notifications,
  titles by game id, hidden/frozen pages, canonical endpoints, key
  rotation, expired sessions). Deploy needs
  Lokesh's one-time steps (VAPID keys as secrets, migration 0006, then the
  Worker): docs/accounts.md "Deploying invites by notification". Unproven
  until then: real FCM/autopush/Apple delivery and a real notification tap
  (`.agents/skills/pwa/memory/push-testing.md`), and the Worker's CPU on
  Cloudflare itself (`wrangler tail`).
- **Worker** — edge caching of leaderboard GETs; free-plan usage limits;
  D1 backups; worker deploy from CI (Lokesh adds `CLOUDFLARE_API_TOKEN`);
  join-failure counting.
- **Settings** (sound/vibration) and an accessibility pass.
- **Phone fixes** from the Android pass. The shell's are done on branch
  `phone-shell` (2026-11-19, not merged; docs/index.md "The second Android
  pass"): JOIN WITH A CODE's dialog, one-tap cards, Firefox top bars and
  frame theme, tap targets and text sizes. Left, in the games: Connect 4's
  canvas is blurry (DPR); Neon Fission toasts pile up; Neon Survival's thumb
  offset; Connect 4 bot long task. iOS remains unverified.

**Bubble Rush asks every round** (Lokesh, 2026-11-18): no default mode; the
host picks FREE-FOR-ALL or TEAMS before START (web-games `ask-mode`, its pin
to move by PR).

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
