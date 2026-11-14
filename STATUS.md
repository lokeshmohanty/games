# STATUS — volatile state

*Update in place; keep short; absolute dates. History lives in git log.*
*Not loaded by default — `AGENTS.md` points here on demand. Keep it that way:
if this file grows past ~10KB, move finished sections to `STATUS-archive.md`
rather than making every session pay for it.*

# TODO(user added)

*Updates/tasks/queries added by the owner; process only when he says, then
act → record → clear the item. This is the single inbox — do not create a
separate `TODO.md`.*

## Web apps run unchanged; CI on Node 24 (2026-11-14) — pushed to main, deployed

14eeec2: an existing site + Python server joins without a rewrite (docs/sdk.md
"Web apps", CONTRIBUTING "Already have a web app?"). Manifest `app` +
`kind: "shared"` (seatless, no bots/results); the arcade builds the site in a
no-secrets container (`scripts/app-build.mjs`; deploy.yml's read-only
`build-community` job); the ASGI/WSGI server runs in Pyodide 314.0.7 on the
host (`lib/py-server.js`, `sdk/v1/arcade_server.py`, runtime vendored by
`just pyodide` into git-ignored `sdk/v1/pyodide/`); `sdk/v1/web-shim.js`
forwards fetch/XHR, shares the address, serves images and `window.open`.
Own colours warn, not fail. sw.js v36. test-webapp + full suite green.
Live: the deploy serves the runtime; **the container build has not yet run on
Actions** — no app is in the registry yet.
Locale (rajarshi99/locale-chess): his PR #1 (branch `arcade`: game.json + MIT
LICENSE) is open; after he merges, he proposes his own registry pin — its
submission check is the first real container build.
ac106f3: actions bumped to Node 24 (checkout/setup-node/upload-artifact v7,
download-artifact v8, configure-pages v6, upload-pages-artifact v5).
f557928: every job pinned to `ubuntu-24.04`. Deploys now run warning-free.
Follow-ups: build caching per pinned commit; start-up time on a real phone.

## In-game FEEDBACK / FAVOURITE (2026-11-14) — pushed to main

The ☆ and 💬 left the portal cards (lib/portal.js, index.html). Inside a game,
party.html's top right now holds 💬 FEEDBACK, ☆ FAVOURITE and PARTY
(`.top-actions`, lib/party.js + styles.css), across from ← All games; on a
phone (<560px) the two are icons only. The ★ FAVOURITES filter on the portal
stays. sw.js v35. test-party, test-social, test-portal, test-pwa green.

## Leaderboard UI; Undercover starts easy (2026-11-14) — pushed to main

leaderboard.html + lib/leaderboard.js: game cards (with what each ranks by),
podium for the top 3, avatar rows, win %, skeleton while loading, a sticky
"you" bar (sign-in ask when signed out). worker/api/lb.js: boards carry `me`
(rank past the top 100, or `need`/`hidden`); global takes `&me=1`, uncached.
test-accounts + test-social green; past-100 rank checked against a JS sort.
Worker deployed 2026-11-14 (version 2dd27a0a): `&me=1` live — 401 without a
token, public board still `max-age=60`.
Undercover: a new phone starts on the 9 everyday topics (`simple: true` in
words.js) at EASY; EVERYDAY button on WORDS; names, undercovers and blank are
saved per device like the words (`players`). test-undercover + test-bots green.

## Undercover topics, no-repeat deal, scores (2026-11-13) — pushed to main

`games/undercover/words.js`: 754 pairs in 14 topics × easy/hard; WORDS screen
(topics multi-select + EASY/MIXED/HARD, saved per device); deal avoids pairs
already dealt on this phone (`ctx.storage` "seen"); topic shown on reveal;
running scores (civ 1 / undercover 3 / blank 4), saved per device, with RESET SCORES. sw.js v32
precaches words.js. test-undercover + test-bots green. Preview gif re-recorded (preview.mjs now
serves over http so framed games load, and exits explicitly).

## Themes, search, contributors, PR-only pins (2026-11-13) — live (9f3c0bd)

Built and green (every `just test` suite + accounts + social): lib/theme.css
+ theme.js (Paper default from lokeshmohanty.github.io, Neon; fonts
self-hosted; frames follow; check-colours lint), two-choice game pages
(PLAY WITH BOTS / PLAY WITH FRIENDS, code only for friends), portal search
(author: type: tag: players: from:), lib/nav.js (GitHub + Add your game top
left, tabs), contribute.html (CONTRIBUTING.md rendered), contributors.html
(contributor.json), registry-bump.yml (pins move only by PR; trusted owners
auto-merged). arcade-games branch `themes`: palette + contributor.json.
Published 2026-11-13: games main 9f3c0bd (site deployed, checked live in
both themes), arcade-games main 4ae4d37. The site still pins arcade-games
efabb70 (old colours).
Then (branch `propose`, not pushed): Lokesh dropped the bump workflow — PRs
are the contributor's; `just propose` / the site's Propose form and Check
for updates open GitHub's page filled in; merge → deploy.yml. Cards: PLAY
WITH BOTS / PLAY WITH FRIENDS on hover or tap, no PLAY NOW.
Live 2026-11-13 (a6fb6bf): propose + cards, verified on a phone.
Then (branch `submissions`): submission.yml + submission-report.yml check and
label every PR touching registry/ (rules in check-submission.mjs, tested;
the full check passed on a trial bump of arcade-games to 4ae4d37 and refused
it from another author). platform-check.yml is the old registry-check.
Next: Lokesh opens the arcade-games pin PR himself (edit link from `just
propose lokeshmohanty/arcade-games`) — the first live run of the check.

## Phases 1–6 (2026-11-13) — merged, site and Worker deployed (b35232de)

Built and green locally: stats/favourites/recents + portal from catalogs
(Phase 1); accounts, ranked matches, leaderboards, hourly GitHub snapshot,
feedback, friends + presence + invites, groups (worker/api/, D1, UserLive;
lib/account*.js, profile.html, leaderboard.html) — docs/accounts.md.
test-worker converted to frames: it caught that sandboxed games lost
`secrets.keep` across a reload (no sessionStorage in the frame) — **live on
main since b597fb6**; fixed here (NeonArcade.sessionStore via the bridge).
Green 2026-11-13: every `just test` suite + test-accounts (100) + test-social
+ test-worker. arcade-games: branch `platform-2` (titles, reportResult),
registry pinned to its local commit — push + re-pin before merging.
Setup done 2026-11-13: D1 `arcade` (APAC), all secrets, OAuth apps, GitHub
App, Worker deployed; live API/redirects/room server verified.
Identities live 2026-11-13 (main 16c0777, D1 migration 0002 applied, Worker
ff2ca98d): one account connects Google + GitHub; GitHub sign-in is the GitHub
App (client Iv23…); its user token kept AES-GCM encrypted; feedback requires
GitHub and posts as the player's own comment. The one live Google account was
copied into `identities`. Old OAuth app secrets (GITHUB_CLIENT_ID/SECRET)
still set — delete them and the OAuth app (GitHub sign-in now verified).
Seen live 2026-11-13: GitHub connected to the Google account, and feedback
posted as the player's own comment (undercover thread, author lokeshmohanty).
Still to see live: a ranked game between two real accounts, the first
`stats` snapshot commit; real-phone check (sandbox wake lock / audio /
fullscreen; dev kit from Safari).

## Platform rework (2026-11-13) — merged to main on Lokesh's confirmation

Plan: `~/.claude/plans/1-a-b-2-generic-whistle.md`; design: docs/sdk.md;
author workflow: CONTRIBUTING.md. All games framed: four in `games/<id>/`,
five from `lokeshmohanty/arcade-games` (pushed, main 24eeffe) via
`registry/lokeshmohanty/arcade-games.json`. Onitama removed everywhere
(Lokesh: "leave onitama out" — a recreation of a published game); a local
branch `backup/import-with-onitama` in ../arcade-games keeps the old import.
Dev kit, example game, `validate-game`, PR check, deploy fetch step built.
Green 2026-11-13: full `just test` incl. devkit; validate-game on all games.
Next: portal cards from the catalogs; then Phases 1–6 (stats → accounts → …).
Not yet: test-worker (wrangler) still drives games in-page — needs the
frame rewrite test-party got; real-phone check of wake lock / audio /
fullscreen in the sandbox; dev kit from Safari / Chrome LNA prompt.

## Archive

Finished work from 2026-11-12 and earlier is in `STATUS-archive.md`.

## Next actions

- [ ] **More one-device party games.** `local: true` makes them cheap now, and
      the category is the one the arcade was missing. Candidates, roughly in
      order of how different they are from Undercover: a **hot-potato word
      game** (a letter combo and a timer that goes off when it likes — frantic
      rather than deductive), **charades/fishbowl** (teams, a timer, words
      everyone types in first), and a **werewolf narrator** (deal roles by
      passing, then the phone runs night and day).
- [ ] `secrets.channel()` has no user again. Leave it — it is proven, it is
      small, and the next game that genuinely needs a dealer nobody has to trust
      will need **mental poker** underneath it anyway (commutative encryption
      over BigInt, no dependency), not just a sealed pipe.
- [x] `scripts/test-party.mjs`'s host-succession section flaked once in five
      runs on 2026-08-27 (timed out waiting for the crown to be offered after
      the host's page closed). Fixed by making succession automatic: the heir
      takes the crown the moment it vacates, with no offer/button, so the test
      no longer waits on a UI action.
- [ ] Draw & Guess's word is sent to the drawer addressed, not sealed — a
      relaying player can read it. Fine for a party game; worth a line in the
      game if anyone ever cares.
- [ ] Light Cycles' bot may be too strong to be fun (30/30 against a
      never-crash baseline). There is no difficulty concept anywhere in the
      arcade; if one is wanted, decide it once and apply it to all six.
- [ ] Onitama's per-card first-player stamps are ours, not the published deck.
      Marked `VERIFY` in the source — correct them against a real box.
- [ ] `lib/rounds.js` does not survive host succession. Neither does any game,
      but this one is new and it is written down now.
- [ ] Retrofit the other four games onto `lib/ui.js`. Deferred deliberately:
      they are tested and working, and the shell was proven on the two new games
      first.
- [ ] Verify on real phones — scanning and installing are both still only
      tested against headless Chrome. iOS is wholly unverified: no install
      event, manifest icons ignored, its own service-worker eviction rules.
- [ ] **The Firefox hints have never been seen in Firefox.** They are reasoned
      from the platform. Open the portal in Firefox desktop and Android once.
- [ ] No test forces a pair to fail, so the two-hop relay path is unexercised;
      the 8-player cap is likewise untested.
- [ ] `sw.js`'s `VERSION` is bumped by hand. Harmless while online (code is
      network-first), but the offline copy goes stale if it is forgotten.
