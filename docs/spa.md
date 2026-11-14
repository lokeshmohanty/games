# The shell is one page (Solid + Vite)

*Built 2026-11-15 on branch `platform-spa` (Phase 4 of the plan of record,
`~/.claude/plans/ethereal-honking-beaver.md`). Lokesh chose pnpm.*

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
| `./` | the portal |
| `./?page=leaderboard` (or `profile`, `contribute`, `contributors`) | that view; its own query parameters ride along |
| `./?game=connect4`, `?mode`, `?fresh`, `?dev`, `?party`, or an invite or code hash | the party |

The old pages (`party.html`, `leaderboard.html`, …) are redirect stubs that
keep their query and hash, so links, bookmarks and installed shortcuts
still work. The game shortcut pages (`connect4.html`, …) go straight to
`./?game=…`.

Every same-origin link to an old page name, including those in the shell's
vanilla code, is caught by one click handler and becomes an in-app
navigation (`navigate()`, `history.pushState`). party.js and net.js always
leave a party word in the address when they rewrite it, so Back and Forward
find the party again.

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
- **Back** asks only when it would leave the arcade, not when it goes to
  another of its views.
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
     community/, the old pages, the manifest, and CONTRIBUTING.md.
   - It writes `dist/sw.js` from `sw.js`. The precache list is the
     template's own entries (icons, fonts) plus everything derived: every
     built chunk, page, lib/ script and stylesheet, game file and frame
     runtime.
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
