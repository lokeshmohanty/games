# The shell is one page (Solid + Vite)

*Built 2026-11-15 on branch `platform-spa` (Phase 4 of the platform plan).
Lokesh chose pnpm.*

## Why

Until Phase 4 every view was its own HTML page. Moving between them
(portal → party → leaderboard → profile) reloaded the page, which dropped
the party's WebRTC connections. The framework re-measure of 2026-11-14
found that the shell's DOM-from-state code had grown to 35–40% of it (the
`webdev` skill's memory `solidjs-vs-vanilla`). And Phase 1 had found the
party page running 426 KB of unminified JavaScript, against a 300 KB
target.

Now there is one document. The views are Solid components, the shell's
libraries are bundled, minified and split, and the party lives outside the
router, so moving around the arcade never drops it.

## How the address names a view

GitHub Pages has no rewrites, and the hash already carries invites (`#i=`,
`#c=`, `#a=`). So views are named in the query, on index.html
(`src/router.ts`):

| Address | View |
|---|---|
| `./` | the portal, on the sub-tab the router picks (below) |
| `./?page=games&tab=mine`, `./?page=games&tab=all` (with `&q=…`, a search) | the portal's sub-tabs, My Games and All Games |
| `./?page=leaderboard` (or `profile`, `contribute`, `contributors`, `collections`) | that view; its own query parameters ride along |
| `./?game=connect4`, `?mode`, `?fresh`, `?dev`, `?party`, or an invite or code hash (`./?party#i=…`) | the party |

These are the only addresses. The old pages (`party.html`,
`leaderboard.html`, `connect4.html`, …) were redirect stubs into them until
2026-11-15, when they were deleted (Lokesh's decision): every link in the
shell, the manifest's `start_url` (`./`) and shortcut (`./?party`), and the
dev kit's printed links use the addresses above. **Every `party.html` link
now 404s**, which Lokesh accepted on 2026-11-15. That covers:

- invites, codes and bookmarks made on an old page (`party.html#i=…`);
- invites, party codes and friend JOIN links made *after* the deploy by a
  phone still running the previous version, until it reloads — an installed
  app's first session after a deploy runs the old snapshot;
- an old installed app's "Party" shortcut;
- a dev kit downloaded before the deploy, which prints `party.html?dev=`
  links.

A phone whose service worker is older than the shell (2026-11-14's snapshot)
may show the old portal for a new invite once, until its worker updates.

### The portal's sub-tabs

*Lokesh, 2026-11-15: "All favourites land under My Games".* The Games tab
has two sub-tabs, like Community's: **My Games** (Recently played and ★
Favourites: games, contributors, collections) and **All Games** (PLAY
SOMETHING, the search, Popular and the categories). lib/portal.js draws only
the sections of the sub-tab showing.

- **The default.** `./` opens on My Games when this device has any
  favourite or any recently played game (localStorage `neon.favs`,
  `neon.recent`), else on All Games; a portal address with `?q=` and no
  sub-tab opens on All Games. The rule is one function,
  `NeonArcade.homeTab()`, defined by an inline script in index.html's head:
  it runs before the first paint, and localStorage is synchronous, so the
  static first frame (below) already shows the right sub-tab.
- **The address always names it.** `src/router.ts` `portalAddress` gives any
  portal address without a sub-tab one (`page=games&tab=…`) as it is
  entered: on load and on Back (replaceState), and in `navigate()`. So a star
  never moves you to the other sub-tab, a sub-tab link is a history entry,
  and Back returns to the sub-tab you left. The sub-tab links are
  `./?page=games&tab=mine` / `tab=all`; the Games tab itself links `./`.
- **The static first frame** (index.html `#app .boot`) draws the nav row as
  lib/nav.js will: the tabs, the ☰ button's place and both sub-tabs, the
  chosen one lit by `html[data-home]` (lib/styles.css). Its height is
  therefore the drawn row's, and test-portal compares the two (with the
  app's code blocked, then loaded): same boxes, same lit sub-tab, the title
  unmoved. **Change nav.js's tabs and that markup together.**
- **PLAY SOMETHING** (Popular's heading, and My Games' empty state) is the
  SINGLE PLAYER address of a game from the five most played that one person
  can play now (bots, or one-device and playable alone), never a people-only
  or Python game; at random per visit, never the last visit's pick
  (`neon.quick`). Being the card's own address, it plays offline after one
  visit (test-pwa).

Every same-origin link to the shell (`./` or `index.html`, with any query
and hash), including those in the shell's vanilla code, is caught by one
click handler and becomes an in-app navigation (`navigate()`,
`history.pushState`). party.js and net.js always leave a party word in the
address when they rewrite it, so Back and Forward find the party again.

## The party layer

`#party-layer` in index.html holds lib/party.js's screen and the game's
stage.
- **Mounting.** It is mounted once, the first time the address names the
  party (`NeonArcade.mountParty`), and never re-rendered.
- **Other views** only hide it. The room, the connections and the running
  game carry on, and a fixed **BACK TO GAME** (or **BACK TO PARTY**) pill
  returns to it.
- **Leaving.** In the shell, "← All games" moves to the portal, and the
  party screen's **LEAVE PARTY** is the way out (lib/lobby.js asks first,
  as before).
- **Back.** The guard entry is pushed only on the party view. Back from the
  party to an earlier view of the arcade keeps the party: src/router.ts
  counts the arcade's entries in `history.state.arcadeDepth`, and
  lib/lobby.js goes on silently when one lies behind. Only Back that would
  leave the arcade asks.
- **A new party while one is mounted** (START A PARTY, a card's PLAY,
  Recently played, JOIN WITH A CODE, an invite): `mountParty` runs once per
  page, so the router's guard (App) asks the leave question when the old
  party is live, then does a full load of the new address.
- **Share links** (invite, code, QR) are built on `./?party` with the
  query, minus `page=` (`NeonArcade.shareBase`), so a link made while the
  host looks at another view still opens the party.
- **A view's chunk gone after a deploy** (hashed names): the view's
  ErrorBoundary reloads once, or shows RELOAD when a party is live. The
  service worker pins every page it takes over, a first visit included, so
  this is rare.
- **Viewport.** It is fixed (no zoom) only while the party view shows.

## The build

`pnpm build` (`just build`) runs three steps:

1. `tsc --noEmit`: the views are TypeScript.
2. `vite build`: index.html → `dist/index.html` + `dist/app/*`.
   `src/main.tsx` imports the shell's libraries (`lib/*.js`, still
   framework-free, still on `window.NeonArcade`) in the order the old pages
   loaded them, and each view is its own chunk. `lib/theme.js`,
   `theme.css` and `styles.css` stay raw files (`vite-ignore`): they paint
   the saved theme before anything else, and the game frames inline the
   same files. The community catalog is generated at deploy, so it is
   loaded at run time.
3. `scripts/assemble.mjs`:
   - It copies what is served as-is beside the build: lib/ (for the
     frames and the lazily loaded scripts), the frame runtimes in sdk/ (not
     its examples, adapters or bindings), games/, assets/, registry/,
     community/, the manifest, and CONTRIBUTING.md. It also publishes the
     dev kit's transition copy at `sdk/v1/dev-server.mjs` (until 2027-02-15,
     docs/platform.md).
   - It writes `dist/sw.js` from `sw.js`. The precache list is the
     template's own entries (icons, fonts) plus everything derived: every
     built chunk, page, lib/ script and stylesheet, frame runtime, preview
     poster (`assets/*.webp`), and every file a game folder ships (RULES.md,
     a wasm module, images; not preview gifs or videos). So every game in
     the catalog plays offline in single player after one online visit, and
     `scripts/test-pwa.mjs` opens each from the portal with the network cut
     and plays it. The one exception is a Python game: Pyodide (~13 MB) is
     cached on first use, in a cache of its own that deploys do not prune
     (`RUNTIME`, named by a hash of `sdk/pyodide/`'s path, file names and
     bytes, so moving the folder renames the cache and the old one is
     pruned; it was `sdk/v1/pyodide/` until 2026-11-15), so a Python game
     needs one online play first; offline before that, the shell says so.
   - VERSION is a hash of exactly those bytes, with the community files.
     A deploy is therefore a new VERSION exactly when the offline copy
     changed, and a forgotten file is no longer possible. This replaces
     `sw-version.mjs` and `check-precache`.

Sizes:

| What | Before | Now |
|---|---|---|
| The shell's code on the party path | 426 KB decoded, unminified, in ~17 files | about 139 KB, 48 KB gzipped, in one bundle |

**Deploy.** deploy.yml fetches the community games, runs `pnpm install
--frozen-lockfile` and `pnpm build`, and uploads `dist/`. platform-check
and submission build the same way before validate-game. Playwright is a
pinned dev dependency (driver only; CI uses the runner's Chrome).

**Local.** `just run` is Vite's dev server on 127.0.0.1:8000. `just test`
builds first, and the browser suites serve `dist/` (scripts/serve.mjs).
`NEON_SERVE_SRC=1` serves the repo instead, and `NEON_DIST=dist-x` builds
and serves another folder, for parallel runs.

## Writing a view

A view is `src/views/<Name>.tsx` (a Solid component, root `.view-<name>`) and
`src/views/<name>.css`. Converted 2026-11-15: portal, leaderboard, profile,
contribute, contributors; collections is new (no old page: the nav links
`./?page=collections`).
- **Its library keeps the logic.** The page's library stays vanilla and
  exposes `mount(root) → cleanup`; the view calls it in `onMount` and
  `onCleanup`. A view mounts many times now, so every listener, observer
  and late answer is undone or ignored after cleanup.
- **Scope the CSS with `:where(.view-<name>)`** (portal and contribute do;
  profile, leaderboard and contributors use a plain `.view-<name>` prefix,
  which works for them). `:where()` adds no specificity, so the old rules
  weigh against lib/styles.css exactly as they did on their own page. A plain `.view-x a` prefix outranked
  `.neon-btn--accent` and turned button text the colour of its background.
- **The site nav** is lib/nav.js, drawn into `nav[data-nav]` in `onMount`.
  It is one row on phone and desktop: the tabs Games · Leaderboards ·
  Community, and a ☰ menu at the right holding Add your game, Theme, sign in
  or the profile, and the source on GitHub. Games has its own sub-tabs, My
  Games · All Games (the portal sets `data-page="mine|all"`), and Community
  Collections · Contributors, opening on Collections; the sub-tab row sits
  under the tab row, every sub-tab 44px tall. The row's height is reserved
  in CSS, and on the portal the static first frame draws it, so nothing
  jumps when it's drawn. This replaced a bar of buttons above the tabs that
  crowded a phone (2026-11-15).
- **Room for the pill:** a live party's BACK TO GAME pill gets room at the
  bottom from one rule in lib/styles.css. The party's own top buttons
  (`.top-actions`) hide on every other view.
- **Query parameters** ride alongside `page=` (`?page=profile&u=…`). A view
  that rewrites them uses `history.replaceState`, keeping `page`.

## What stays framework-free, and why

- **The games** stay framework-free in their sandboxed frames: the SDK is a
  message protocol (docs/sdk-v2.md), not a JavaScript API.
- **The shell's libraries** stay vanilla modules: lib/net.js, room-join,
  party, lobby, bridge, sdk-host, sdk-managed, secrets, rounds, qr,
  qr-decode, stats, account, catalog, theme.
- **The party and lobby screens** (lib/party.js and lib/lobby.js, about
  2,000 lines, the most heavily tested UI here) are still vanilla, mounted
  into the persistent layer. Converting them is the last step of the
  Solid migration, left for after this phase lands.
