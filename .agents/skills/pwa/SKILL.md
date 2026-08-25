---
name: pwa
description: Use when changing anything about the arcade being installable or working offline — manifest.webmanifest, sw.js, lib/pwa.js, the app icons in assets/, the install button, caching strategy, or when someone reports that the app will not install, will not update, or fails offline. Also use before adding any new page or lib/ file, which must be added to the service worker's precache list.
---

# PWA (installable + offline)

The arcade installs and plays offline with no build step and no toolchain:
a hand-written manifest, a hand-written service worker, and icons rendered from
one SVG by a script.

| File | Role |
|---|---|
| `manifest.webmanifest` | name, icons, `start_url`, `display`. All paths **relative**, so it works under a GitHub Pages subpath. |
| `sw.js` | **Must stay at the repo root** — a worker's scope cannot rise above its own directory. |
| `lib/pwa.js` | Registers the worker; fills `[data-install-slot]` with an INSTALL APP button. |
| `assets/icon.svg` | The one drawing. Everything else is generated from it. |
| `scripts/make-icons.mjs` | Renders the PNGs. Run after editing the SVG; the PNGs are committed. |

## Verify — and let Chrome be the judge

```sh
node scripts/test-pwa.mjs      # manifest, icons, worker, offline, the portal's
                               # layout at 390x844, and Chrome's own
                               # installability verdict over CDP
node scripts/make-icons.mjs    # only after editing assets/icon.svg
```

**Never conclude the app is installable from reading the manifest.** See
[[installability-verdict]] — a manifest that passed every hand-written check was
refused by Chrome, and nothing visible said so.

## When you add or rename a page or a lib/ file

Add it to `SHELL` in `sw.js`. It is a hand-maintained list; a file missing from
it simply will not be there offline, and nothing warns you. Then bump `VERSION`.

## Rules

- **"It will not install in Firefox" is not a bug.** The button comes from
  `beforeinstallprompt`, which is Chromium-only and always has been. Do not
  audit the manifest over it — read [[install-prompt-is-chromium-only]] first.
  Offline is a *separate* capability and does work in Firefox.
- **Code is network-first, assets are cache-first.** Do not "optimise" this into
  cache-first everywhere — see [[caching-split]] for what that would break.
- **Nothing here may break `file://`.** `lib/pwa.js` must stay inert without a
  secure context, and no page may depend on it. Games load and run identically
  with the manifest, the worker and the install button all absent.
- **Never add a fixed-position install affordance.** The offer appears only when
  the browser says so, i.e. after layout; the slot sits in the flow under the
  portal title and is empty (zero height) the rest of the time. Verify at
  390x844 with assertions.
- Do not add `controllerchange` → `location.reload()`. With `skipWaiting()` that
  is the classic infinite reload loop.

## Memory

- `memory/installability-verdict.md` — why an SVG in `icons` makes the whole app
  uninstallable, and why CDP is the only honest check.
- `memory/caching-split.md` — why code is network-first, and the hand-bumped
  `VERSION` trade-off.
- `memory/install-prompt-is-chromium-only.md` — why no button can ever appear in
  Firefox or Safari, what each browser actually does, and why offline is fine
  there anyway.
