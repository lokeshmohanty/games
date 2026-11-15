---
name: pwa
description: Use when changing anything about the arcade being installable or working offline — manifest.webmanifest, sw.js, lib/pwa.js, the app icons in assets/, the install button, caching strategy, or when someone reports that the app will not install, will not update, or fails offline. Also use before adding a new page, lib/ file or asset, or changing scripts/assemble.mjs, which writes dist/sw.js and its precache list.
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

Nothing to list, since 2026-11-15: `just build` (scripts/assemble.mjs) derives
the precache list from what it built and copied — pages, `lib/`, every file in
`games/`, frame runtimes, posters, the app's chunks — and writes `dist/sw.js` with
a `VERSION` hashed over exactly those bytes. Every game must play offline in
single player; `test-pwa` plays each one from the portal with the network cut
(a new game needs a `PLAY` driver there). Pyodide is the one exception: cached
on first use, in `RUNTIME` ([[caching-split]]). Only a file outside those (an icon, a font) goes in the
template's `SHELL` in `sw.js`; assemble fails the build if a listed file is
missing. Never edit `VERSION` (the repo's says `arcade-dev`). docs/spa.md.

## Rules

- **"It will not install in Firefox" is not a bug.** The button comes from
  `beforeinstallprompt`, which is Chromium-only and always has been. Do not
  audit the manifest over it — read [[install-prompt-is-chromium-only]] first.
  Offline is a *separate* capability and does work in Firefox.
- **Code comes from one versioned snapshot, assets are cache-first.** Never add a
  per-file background refresh for code (stale-while-revalidate): it mixes two
  deploys — see [[caching-split]]. Loopback is network-first for development.
- **Never use `page.waitForFunction` with an `async` predicate** in a test: in
  Playwright 1.62 the returned Promise is truthy, so it passes without waiting.
  Poll from Node instead (test-pwa does).
- **`assets/icon.svg` must stay strict XML.** It is the favicon, loaded as a
  standalone SVG, and one `--` inside its header comment makes the browser drop
  it. `make-icons.mjs` pastes it into HTML, which forgives that, so the PNGs give
  no warning. `test-pwa` parses it. The header lockup in `index.html` (`.brand`)
  is the same glyph drawn with theme tokens, so redraw both together
  ([[app-mark-direction]]).
- **Nothing here may break a page without a service worker.** `lib/pwa.js`
  must stay inert without a secure context (a plain `http://` LAN address),
  and no page may depend on it. Games load and run identically
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
- `memory/caching-split.md` — why code is served from one versioned snapshot
  (and was network-first before 2026-11-14), and how a deploy arrives.
- `memory/install-prompt-is-chromium-only.md` — why no button can ever appear in
  Firefox or Safari, what each browser actually does, and why offline is fine
  there anyway.
- `memory/app-mark-direction.md` — the icon follows the Paper theme, not Neon;
  the "linked players" concept and the choices made for the 2026-11-14 redesign.
