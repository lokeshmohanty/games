# The INSTALL APP button can only ever appear in Chromium

*Established 2026-08-26, answering "the PWA works only on Chrome and not on
Firefox, why is this?"*

## The answer

`lib/pwa.js` builds its button from the `beforeinstallprompt` event. That event
is **not a web standard** — it is a Chromium extension to the platform, and no
other engine implements it. Chrome, Edge, Opera, Brave and the rest of the
Chromium family fire it; Firefox and Safari never will.

So this is not a defect in the manifest, the icons or the worker. Nothing can be
fixed to make the button appear in Firefox, and time spent auditing the manifest
over it is wasted. Check this memory before investigating "the app will not
install" reports.

## What is actually true per browser

| Browser | Install | Why |
|---|---|---|
| Chrome / Edge / Chromium | Our button works | fires `beforeinstallprompt` |
| Firefox **Android** | Installable, from the ⋮ menu only | no `beforeinstallprompt`, so a page cannot ask |
| Firefox **desktop** | Not installable at all | Mozilla removed site-specific browsers in Firefox 85 (2021) and has not restored it |
| iOS Safari | Share → Add to Home Screen | no install event, and never had one |

## Offline is a separate question, and the answer is different

**Firefox supports service workers and the Cache API fully.** The arcade caches
and plays with no network in Firefox exactly as it does in Chrome — it just
lives in a tab instead of its own window. Do not conflate "cannot install" with
"does not work"; they are unrelated capabilities.

One real caveat: Firefox disables service workers in **Private Browsing**
windows, so offline genuinely does not work there.

## What we did about it

Filled the slot with a sentence rather than leaving it empty. An empty slot is
indistinguishable from a broken page, and somebody will reasonably conclude the
app failed rather than that their browser has no such button. `lib/pwa.js`
branches: iOS gets the share-sheet hint, Firefox Android gets the menu hint,
Firefox desktop is told plainly that it cannot install web apps *and* that the
page still works offline.

**This is reasoned from the platform, not observed.** Every browser test in this
repo runs headless Chrome; nothing here has ever been opened in Firefox. The
hints are unverified — see `docs/index.md` → Honest gaps.

See also [[installability-verdict]] — the opposite failure, where Chrome refused
to install an app that every hand-written check passed.
