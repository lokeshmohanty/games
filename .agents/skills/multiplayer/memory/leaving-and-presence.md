---
name: leaving-and-presence
description: How leaving a party is confirmed and announced (lobby.js guardParty/leaveParty/presence) — Lokesh's decisions and the browser traps behind the back-button guard.
metadata:
  type: feedback
---

**Lokesh (2026-11-12):** "All actions leading to the host/guest leaving the party
need confirmation… Any host/guest leaving should alert all other party members."
Choices he made when asked:

- **Browser exits:** trap back/swipe-back with an in-page question, plus the
  native `beforeunload` prompt on tab close/reload while in a party. Going ahead
  with a close/reload is *not* a leave — the seat stays held (reload is how a
  seat is kept).
- **Confirm UI:** an in-page `<dialog>` (`NeonArcade.ask`), never `confirm()`.
  **Why:** `confirm()` freezes the page's JS, so a host's game loop and the
  mesh relaying stall for everyone while it is up.
- **Alerts:** non-blocking toasts plus roster state, never a blocking modal
  per leave.

How to apply: any new way off a page (link, button, navigation) must go through
`NeonArcade.leaveParty()` or carry `data-leaves`; any new roster callback in a
shell must feed `presence.sync/left`. A game page with only bots is never asked;
the party shell asks even a lone host (`askAlone`).

Traps found building it:

- Chrome **skips history entries pushed without a user gesture** when going
  back, so the guard entry is pushed on the first `pointerdown`/`keydown`, not
  on load.
- `popstate` also fires on **fragment navigation** (`#i=`/`#a=`/`#c=` links
  opened into the tab) — the guard must ignore those; the shells' `hashchange`
  handlers own them.
- `clearHash()` must keep `history.state` (it used to pass `null`), or it wipes
  the guard entry's marker.
- Playwright's `page.reload()`/`goto()` **bypass** `beforeunload`, so the reload
  tests are unaffected; to test the prompt itself use
  `page.close({ runBeforeUnload: true })` and expect a `beforeunload` dialog.
- `onPeerLeave` fires after the member is already out of the roster —
  `nameOf(id)` returns "Player". net.js now passes `{ name, reason }`.

Related: [[bots-as-members]], [[room-server]].

**Stalled turns (Lokesh, 2026-11-13):** a turn game whose player to move is
RECONNECTING shows a countdown banner, then **the host decides** (WAIT /
SKIP TURN / END GAME) after **30 s** — he chose this over a bot taking the
seat. `NeonArcade.turnWait` (games.js); test-worker 11. Test traps: a
member's team survives across games, so a closed guest still on team B takes
the next game's B seat; with the 3 s test wait, check every page's countdown
at once or it has already run out.
