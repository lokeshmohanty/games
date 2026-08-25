# STATUS — volatile state

*Update in place; keep short; absolute dates. History lives in git log.*
*Not loaded by default — `AGENTS.md` points here on demand. Keep it that way:
if this file grows past ~10KB, split the archive out rather than making every
session pay for it.*

# TODO(user added)

*Updates/tasks/queries added by the owner; process only when he says, then
act → record → clear the item. This is the single inbox — do not create a
separate `TODO.md`.*

## Current focus (2026-08-26)

Every game is multiplayer, and every game is playable by one person.

The portal used to sort itself into "Single Player", "Party" and "Multiplayer",
which told anybody holding one phone that three of the four games were not for
them. That split is gone. Bots replaced it: a bot is an ordinary member of the
party record that the host's browser plays for, so "single player" is now just a
table whose other seats are bots — one tap from any game page.

Shipped this session:
- **Bots** — `net.js` gains `addBot`, `bots()`, `emitAs`, and `bot_`-prefixed
  ids that the routing excludes from the mesh, from broadcast relay, from
  succession, and from surviving the host. Brains live in the game files, host
  side only: Connect 4 minimax + alpha-beta at 5 plies, Tug of War a ~9/s tap
  rate with jitter, Neon Survival a steered ship. Draw & Guess sets
  `bots: false` and says why.
- **Lobby** — deep-link pages now offer INVITE A FRIEND *or* PLAY A BOT / PLAY
  ALONE. START refuses on the seat count, not the peer count. Party screen gets
  ADD BOT and a BOT tag.
- **Neon Survival is one game.** `neon-survival.html` is a redirect;
  `games/neon-survival-mp.js` (`seats.min: 1`) is the only copy, renamed from
  "NEON SURVIVAL CO-OP". `assets/neon-survival.gif` retired.
- **Renamed to "Arcade Games"** — manifest, page titles, portal `<h1>`,
  `apple-mobile-web-app-title`. `sw.js` VERSION → `arcade-games-v2`. The
  `NeonArcade` JS namespace is deliberately unchanged: it is internal, and
  renaming it would touch every file to buy nothing.
- **Firefox install answered.** The button is `beforeinstallprompt`, which is
  Chromium-only; `lib/pwa.js` now shows a hint per browser instead of an empty
  slot. Offline was never affected — Firefox caches fine.
- `scripts/test-bots.mjs` (new, 22 checks) and portal layout assertions at
  390x844 in `test-pwa.mjs`. All five suites pass.

## Next actions

- [ ] Verify on real phones — scanning and installing are both still only
      tested against headless Chrome. iOS is wholly unverified: no install
      event, manifest icons ignored, its own service-worker eviction rules.
- [ ] **The Firefox hints have never been seen in Firefox.** They are reasoned
      from the platform. Open the portal in Firefox desktop and Android once.
- [ ] Bot strength is asserted only negatively (Connect 4 is never left an open
      win). Nothing measures whether any of the three is fun to lose to.
- [ ] No test forces a pair to fail, so the two-hop relay path is unexercised;
      the 8-player cap is likewise untested.
- [ ] `sw.js`'s `VERSION` is bumped by hand. Harmless while online (code is
      network-first), but the offline copy goes stale if it is forgotten.
