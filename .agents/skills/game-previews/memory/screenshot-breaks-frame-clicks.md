# A screenshot can stop page clicks reaching a game's frame

Observed 2026-11-22 (Snakes & Ladders, building its preview and test-taps
entry), not root-caused.

**What:** in a Playwright context with `isMobile: true, hasTouch: true`
(DPR 2), after one `page.screenshot()`, `G.locator(".sl-die").click()` on a
button inside the sandboxed game frame reported success and fired no
`click` — every time, for the rest of the page's life. Without the
screenshot the same clicks worked; `element.click()` in the frame always did.

**Why it matters:** a scenario or suite that screenshots (test-taps with
`NEON_TAPS_SHOTS`, a debugging script) can look like the game ignoring taps.

**How to apply:** in a one-phone recorder scenario, do not screenshot before
the clicks you need. In a suite that must screenshot, press frame buttons with
`element.click()` (or dispatched PointerEvents, as test-taps does for Five in
a Row's canvas) inside the frame, which is the suites' usual way anyway.
