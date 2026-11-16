---
name: ghost-seats
description: Why the room server's `busy` is not "open in another tab" — Chrome's back/forward cache keeps a page's WebSocket open up to 10 min; the seat's Web Lock decides instead (found on Lokesh's phone, 2026-11-15).
metadata:
  type: project
---

**Found on Lokesh's phone (2026-11-15, Chrome 157 / Android 16):** after a
reload, every SINGLE PLAYER said "This party is open in another tab" for ten
minutes (19:19 → 19:29), and LEAVE PARTY did not help.

- **Chrome keeps a page in the back/forward cache with its WebSockets open**
  (Chrome 156 measured with Playwright, bfcache re-enabled via
  `ignoreDefaultArgs: ["--disable-back-forward-cache"]`: the server saw the
  close frame only on restore or eviction). Chrome's cache lifetime is 10 min
  — the stuck window. Playwright turns the cache **off** by default, so no
  suite could see this until test-worker section 15.
- The page that held it: the reload's reconnectFlow page (a lone host's
  rejoin binds its seat and waits 30 s for an answer nobody gives), left by
  App.tsx's plain `location.assign` (the guard's path when no party is live).
  Every fresh load after it got `busy` from `releaseRejoin`, kept the token,
  and showed the displaced screen — and LEAVE PARTY with no live room only
  navigated (lobby.js), never touching the token.
- **The fix's rules:** `busy` means "a socket is bound", nothing more. The
  page whose room has a seat holds Web Lock `neon.seat.<id>` (taken with
  `steal`; released on leave, stand-down, pagehide-persisted); `releaseRejoin`
  on `busy` with the lock free takes the ghost seat (`join`, 4409s it) and
  gives it back. `pagehide` with `persisted` closes every room socket
  silently; `pageshow` restored → stand down if a live page took the seat,
  else the party reloads. A fresh bots / one-device start never waits on
  any of it (release runs in the background). USE IT HERE must drop `fresh`
  from the URL or its reload lands on the same screen.
- **Review traps (2026-11-16):** take the lock only after the server *bound*
  the seat — a lock stolen at dial time by a reconnect that then failed left
  the live tab with no lock, a "ghost" any release would hand away; and a
  stolen lock is queued for again (never stolen back) while the page is
  live. A bots start beside a live seat must not `ensureCode` (it would
  overwrite that tab's token). A pre-fix tab holds no lock: after a deploy,
  the first new-code release may take its seat once.
- **Trap — a held Web Lock does not keep a page out of the cache**, but
  another page querying/requesting that lock evicts it (observed, not
  documented — VERIFY on other Chrome versions). Do not rely on it; the
  pagehide close is what makes the seat free.
- Tests: test-room 7b (mock seeded with a ghost seat), test-worker 15
  (real bfcache, real worker).
