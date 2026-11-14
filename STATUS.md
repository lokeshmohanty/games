# STATUS — volatile state

*Update in place; keep short; absolute dates. History lives in git log.*
*Not loaded by default — `AGENTS.md` points here on demand. Keep it that way:
if this file grows past ~10KB, move finished sections to `STATUS-archive.md`
rather than making every session pay for it.*

# TODO(user added)

*Updates/tasks/queries added by the owner; process only when he says, then
act → record → clear the item. This is the single inbox — do not create a
separate `TODO.md`.*

## Tug of War retired (2026-11-14)

Lokesh chose "remove only": dropped from registry/lokeshmohanty/arcade-games.json
(the pin stays a1eeebf, the published commit); its gif, recorder scenario, bots
and party tests and doc mentions are gone; `tug-of-war.html` redirects to the
portal (an invite hash goes to the party); sw.js v39. Started by the ended
session games-99, finished by games-e1.
**Pending, not shipped:** Bubble Rush, games-99's replacement game, is commit
0d0c40b on the local `bubble-rush` branch of ../arcade-games, unpushed and
unreviewed. Shipping it = review + play it, push that repo, then re-pin here
with "bubble-rush" in the games list.

## Neon Bid fixes (2026-11-14): pushed to main, sw.js v38

Found by a playthrough at a person's pace, 2 to 8 seats, in all three themes:
1. **Lots thrown away in every game against bots.** The open-phase fallback
   timer was armed after the host's and bots' openings had already settled the
   lot, so 4 s later it settled the next lot mid-bidding as everybody passing.
   Screen and game then ran a lot apart: bids landed on the wrong gems, and
   bots were flagged "never opened their bid". Timer now armed first and tied
   to its lot; `settle` only settles the clock's lot while bids open.
2. **Tie deadlock at 6–8 seats.** Bots on 100 credits all bid exactly 100, so
   every lot tied and was discarded from about lot 4 on (100% of 7–8 seat
   games). Bot bids are now capped a random 0–30% below the balance. 93–95%
   of lots sell at every size; strength vs baselines unchanged (~100%).
3. Seat colours = gem colours since the theme commit (a3bdbb5): seats are now
   a ring in their colour with an initial. Lokesh picked this 2026-11-14.
4. The "Cyan" gem is drawn blue under Paper: now named "Blue" under Paper,
   "Cyan" under Neon, switching live. Lokesh picked this 2026-11-14.
5. The game frame's `<title>` was "Cyan": now "Neon Bid".
Tests: test-bots now bids at a person's pace and checks each sealed bid against
the lot it settled (fails on the old code); test-neon-bid checks 2–8 seats for
stalls (fails on the old bot). test-neon-bid and test-bots are green.
sw.js v38 shipped with this; the Tug of War removal (session games-99, shared
tree, uncommitted) also bumped to v38 and must take v39.

## New app mark, "linked players" (2026-11-14): pushed to main, deployed

Lokesh picked option A from https://claude.ai/artifact/MctQN4fSg3imRQTeYPGooc:
two joysticks joined by a cable, in Paper's dark-mode colours (slate tile #111419).
assets/icon.svg redrawn; PNGs rebuilt; manifest background/theme #111419;
portal h1 is now a lockup (`h1.brand`, inline glyph on theme tokens: follows
Paper light/dark and Neon). make-icons reads the backing colour from the tile.
Fixed along the way: the SVG favicon had been invalid XML since 2026-08-16
(`--` in its comment), so no browser drew it. test-pwa now parses it. sw.js v37.
test-pwa, test-theme, test-portal green; header checked at 390x844 and 1280x800
in all three themes. 3dced5f fast-forwarded to main; Pages deploy green; live
site serves the new icon.svg (image/svg+xml), h1.brand and sw.js v37.

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
Build caching per pinned commit (NEON_APP_CACHE, actions/cache in deploy,
platform-check, submission; docs/sdk.md "Build"): Locale cold 42 s → 0.2 s
reused locally, output byte-identical; tooling change rebuilds, removed pin
drops its entry. Follow-up: start-up time on a real phone.

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

## Archive

Finished work from 2026-11-13 and earlier is in `STATUS-archive.md`.

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
