# STATUS — volatile state

*Update in place; keep short; absolute dates. History lives in git log.*
*Not loaded by default — `AGENTS.md` points here on demand. Keep it that way:
if this file grows past ~10KB, split the archive out rather than making every
session pay for it.*

# TODO(user added)

*Updates/tasks/queries added by the owner; process only when he says, then
act → record → clear the item. This is the single inbox — do not create a
separate `TODO.md`.*

## Current focus (2026-08-15)

SCAN REPLY works again, and the arcade installs.

The scanner had been broken by its own optimisation: it lowered its working
resolution whenever a decode ran long, and the frames that run long are the
*empty* ones the camera sees while somebody is still aiming. It therefore threw
away the pixels-per-module a reply code needs before it had seen anything, and
from then on read nothing — camera live, preview fine, no result, no error. The
old test never caught it because its code sat in frame from the first instant.

Shipped this session:
- `lib/qr-decode.js` — no resolution backoff; decode the centred square at the
  camera's own resolution; cheap binarisation pass on most frames and the full
  ladder every third; loop paced by measured cost. A platform `BarcodeDetector`
  whose `detect()` rejects is now dropped instead of silently disabling the
  fallback. `onError` is always async, so a caller's `scanner` handle exists.
- `scripts/test-scan.mjs` — aim-then-show feeds at 1x/4x/6x CPU (the case that
  was broken), broken-detector fallbacks, async error delivery.
- PWA: `manifest.webmanifest`, `sw.js`, `lib/pwa.js`, `assets/icon.svg` +
  generated PNGs, `scripts/make-icons.mjs`, INSTALL APP button on the portal.
  Code is network-first, assets cache-first; single-player games work offline.
- `scripts/test-pwa.mjs` — including Chrome's own installability verdict over
  CDP, which caught a manifest that passed every hand-written check and was
  still uninstallable (an SVG in `icons` poisons the whole set).
- `assets/placeholder.svg` replaces the `via.placeholder.com` fallback. The
  project now contacts nothing but STUN.

## Next actions

- [ ] Verify on real phones — scanning and installing are both still only
      tested against headless Chrome. iOS is wholly unverified: no install
      event, manifest icons ignored, its own service-worker eviction rules.
- [ ] No test forces a pair to fail, so the two-hop relay path is unexercised;
      the 8-player cap is likewise untested.
- [ ] `sw.js`'s `VERSION` is bumped by hand. Harmless while online (code is
      network-first), but the offline copy goes stale if it is forgotten.

## Open obligations / blockers

- (none)
