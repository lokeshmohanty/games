---
name: game-pages-are-party-shortcuts
description: Why a game's link opens the party (./?game=; the old game pages redirected there, then were deleted on 2026-11-15), how the quick start works, and the test traps that came with retiring the old two-player lobby.
metadata:
  type: project
---

**Lokesh (2026-11-13):** game pages become party shortcuts, and portal cards
go straight into the game. Chosen over teaching the old two-player lobby
(`mountLobby`) the room server: one connection path instead of two.

- **Redirect, not an in-place mount.** A game page loads only its own game; a
  party mounted there could not switch games, and its code link would point at
  that page. So `connect4.html` → `party.html?game=connect4&fresh=1` (query
  kept for `?mockroom` / loopback `?rs=`; a `#i=`/`#c=` link drops `fresh`).
- **The pages went on 2026-11-15** (Lokesh: delete every redirect stub).
  The one-page shell's address is the only one: a portal card links
  `./?game=<id>&fresh=1`, the party is `./?party`, invites are
  `./?party#i=…` (net.js `shareBase`). A link made on `party.html` now 404s;
  accepted. Tests open those addresses directly (docs/spa.md).
- **Quick start** (party.js `quickBlock`): host of a fresh party only, until
  the first START. Seats by the old game-page rule at START. Anyone already in
  (a friend by code) sets the table — START shows without PLAY A BOT. A local
  game shows START only. `askAlone` is off for these parties (one person vs
  bots is never asked before leaving).
- **The quick table** (Lokesh, 2026-11-17, "Quick table before start"):
  SINGLE PLAYER of a game with `seats.max > seats.min` shows Players − n +
  and the seats before START GAME, remembered per game (`neon.table`);
  fixed seats and PLAY SOMETHING (`start=1`) start at once. People on the
  host's phone are bots marked `local` (`room.setBotMeta`), passed to a
  `"sameDevice"` game in `init` — Fission's own setup screen went. A test
  that taps SINGLE PLAYER on such a game must tap START GAME (serve.mjs
  `passTable`); docs/index.md "The party API". PERSON flags are this
  page's own choice: party.js `tidyPeople` clears them when a second person
  joins or the crown moves, and the roster tags/toggles them — a stale
  `local` once hid a pass-the-phone seat behind a BOT tag.
- **`__i` trusts an unsigned `f`.** The host now refuses bot ids, its own
  id, reserved fields and `local`, and relayed self-edits for members it
  links directly; relayed-only members can still be renamed by their relay.
- **Tests must keep off production.** Without a room-server override a party
  probes the deployed room server; test-bots and the preview recorder set
  `localStorage["neon.rs"]` to an unreachable loopback in every context, or
  each run hosts real parties (and its leftover tokens make the next fresh
  start answer "open in another tab"). test-party still reaches production —
  pre-existing, not changed.
- test-room needed a page with the libs and nothing mounted:
  `scripts/room-harness.html` (not precached, not shipped).
- `window.__game` is now an alias of `window.__party` (same getters).

Related: [[reload-mid-game]], [[leaving-and-presence]], [[room-server]].
