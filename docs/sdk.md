# The game SDK (v1) — writing a game for the platform

*Started 2026-11-13 on branch `platform`. Plan of record:
`~/.claude/plans/1-a-b-2-generic-whistle.md`. Status: the bridge, the frame
loader, the catalogs and the registry are built; all ten games run framed
(four here, six from `lokeshmohanty/arcade-games`). The dev kit,
`validate-game`, the PR check and the deploy step are built too; the portal
does not list community games yet (**planned** below).*

## What changed, and why

The arcade is becoming a platform: other people write games, keep them in
their own public GitHub repository, and the platform gives them everything
that is not the game — connections, the party, bots' seats, host handover,
and (later) accounts, stats and leaderboards.

Their code must not be able to touch any of that. So every game — ours
included — runs in

```html
<iframe sandbox="allow-scripts" srcdoc="…">
```

with **no `allow-same-origin`**: the frame's origin is opaque (`null`), its
`localStorage` throws `SecurityError`, and it cannot reach the party page's
DOM. It talks to the party only through `sdk/v1/client.js`, over a
`MessageChannel`, and `lib/bridge.js` answers on the party's side.

## How a game is laid out

```
games/connect4/
  game.json        the manifest (below)
  index.html       the entry page: the game's own <script>/<link> tags only
  connect4.js      the game, calling NeonArcade.registerGame({...}) once
```

The entry page does **not** include the SDK: the shell inlines the runtime
(`sdk/v1/client.js`, `lib/games.js`, `lib/ui.js`, `lib/secrets.js`,
`lib/rounds.js`, `lib/styles.css`) ahead of the game's own scripts.

### `game.json`

| Field | Rule |
|---|---|
| `sdk` | `1` |
| `id` | 2–32 of `a-z 0-9 -`; community ids are shown as `<owner>/<id>` |
| `name`, `blurb` | ≤ 40 / ≤ 140 characters |
| `entry` | an `.html` path inside the game folder |
| `kind` | `duel` · `ffa` · `teams` · `coop` · `local` (what a result means) · `shared` (a web app: no seats, bots or results) |
| `app` | an existing web app and its server, run unchanged — see "Web apps" below |
| `shape` | `teams` · `coop` · `free` (how the party reads teams) |
| `seats` | `{ min, max }`, 1 ≤ min ≤ max ≤ 16 |
| `bots` | can the host fill seats with bots |
| `tags`, `preview` | portal filters, preview gif path |
| `license` | an OSI licence that allows redistribution (`scripts/manifest.mjs`) |
| `author`, `repo` | GitHub user, `https://github.com/…` |

`scripts/manifest.mjs` is the one validator; `scripts/build-catalog.mjs`
gathers every manifest into `lib/catalog.js` (`just catalog`, checked by
`--check`), which registers each game with `NeonArcade.registerFramedGame`.

## What a game gets: `mount(ctx)`

The same contract the in-page games always had (lib/games.js), so a game
written before the platform needs no changes beyond moving into a folder:

`ctx.root`, `ctx.isHost`, `seatOf(id)`, `seats(team)`, `players()`,
`nameOf(id)`, `isBot(id)`, `botSeats(team)`, `end()`, `canEnd`, and
`ctx.room` — a stand-in for net.js's Room with `selfId`, `isHost()`,
`hostId()`, `getMembers()`, `getMember(id)`, `self()`, `makeAction(name)`,
`emitAs(botId, name, data, opts)`, `setMeta(patch)`. Helpers in the frame:
`gameShell`, `makeRounds`, `makeSecrets`, `turnWait`, `hostPause`,
`toast`, `ask`, `hostNewGameButton`.

New with the SDK:

| | |
|---|---|
| `ctx.reportResult(r)` | the outcome, for stats and leaderboards — below |
| `ctx.storage.get(key)` / `.set(key, value)` | per game, per device; 64 KB of JSON |
| `ctx.assets.url(path)` | `Promise<blob: URL>` for a file in the game folder (images, sounds, fonts) |
| `NeonArcade.sessionStore` | this tab's session storage (`getItem`/`setItem`/`removeItem`), kept by the party page — the frame has none of its own. `lib/secrets.js` keeps commitments here across a reload |

### Colours and type: the theme

Players choose a theme (Paper — the default, following the system's light or
dark — or Neon). A game never names a colour: CSS uses the tokens from
`lib/theme.css` (`--bg`, `--surface`, `--surface-2`, `--ink`, `--ink-2`,
`--ink-3`, `--rule`, `--accent`/`--on-accent`, `--accent-2`/`--on-accent-2`,
`--good`, `--warn`, `--danger`, `--glow`, players `--p1`…`--p8`), and a canvas
asks `NeonArcade.palette()` — `{ bg, surface, surface2, ink, ink2, ink3, rule,
accent, onAccent, accent2, good, warn, danger, player(i), alpha(name, a),
glows, fonts }` — then redraws on `window`'s `neon:theme` event. A colour that
travels between players is sent as an index (a seat, a pen), so each peer
draws it in its own theme. Type: `--font-display`, `--font-body`,
`--font-mono` (values). First-party games follow this strictly
(`just check-colours` fails on a literal colour unless its line says
`theme-exempt`). An outside game may keep its own colours (Lokesh,
2026-11-14: "allow his own hard-coded colours"): `validate-game` warns, and
`fetch-community.mjs` marks its published manifest `ownColours: true`.

### Reporting a result

Call `ctx.reportResult(r)` on **every peer** when a match ends (each one saw
it); the platform counts it once per run, `match` and ranking.

```js
ctx.reportResult({
  kind: "duel",            // "duel" | "ffa" | "teams" | "coop" | "local"
  match: 3,                // which match of this run: count up on a rematch
  ranking: [["a"], ["b"]], // places; ranking[0] won; a slot of several = tie/team
  scores: { a: 12, b: 7 }, // optional
});
```

A draw is everyone in one slot; co-op is one slot (played, with scores);
`local` (one phone) counts as played. Leave out seats that emptied. The
optional manifest fields `title` and `description` (≤ 300) are the portal
card's; `players: { min, max }` is the people at the table for a `local`
game.

The returned handle keeps its old hooks: `unmount`, `onRoster`,
`onPeerJoin(id, info)`, `onPeerLeave(id, info)`, `takeOver()` (the crown
moved to us mid-game; return `true` to carry on).

## The rules a game must follow

1. **One bundle per `<script>`.** The shell inlines each script; nothing may
   `import` another file at runtime (no code-splitting, no dynamic import).
   Plain scripts need nothing; bundlers: inline dynamic imports / single-file
   output. *Why:* only inlined scripts run in an opaque-origin frame offline
   (spikes below).
2. **No network.** The frame's CSP is `default-src 'none'` with inline
   script/style and `data:`/`blob:` media: no fetch, no WebSocket, no CDN.
   Everything comes from the game folder via `ctx.assets`.
3. **Scripts and stylesheets only from the game's own folder.**
4. **Host-authoritative**, bots run on the host (as before).

## The protocol (for whoever changes the bridge)

Shell → frame: `init {state}` · `party {state, roster}` · `msg {a, d, from}`
· `join {id, info}` · `leave {id, info}` · `answer` / `asset {id,…}` ·
`takeOver {id}` · `unmount`. Frame → shell: `ready` · `listen {a}` ·
`send {a, d, to}` · `emitAs {bot, a, d, to}` · `meta {patch}` · `end` ·
`toast` · `ask {id,…}` · `hostNew` · `result {r}` · `store {key, value}` ·
`session {key, value}` ·
`asset {id, path}` · `reply {id, ok}`.

- Game channels travel as `g:<name>` on the wire, so a game cannot speak on
  the party's own channels (`p$…`).
- Messages for a channel the frame has not opened yet (it is still loading)
  are held — net.js `onStray` — and replayed when it opens.
- The roster mirror is refreshed on a 250 ms poll (away / reconnecting
  flags); only a real roster event reaches the game's `onRoster`. Calling
  it on every refresh reset Connect 4's board — found by test-party.
- Frame → shell is capped at 1000 messages a second.

## Spike results (2026-11-13, headless Chrome)

- **Isolation:** sandboxed frame origin `null`, `localStorage` →
  `SecurityError`.
- **Latency:** `MessageChannel` round trip with a 64-item state: p50 0.1 ms,
  p95 0.2 ms over 500 trips. Not a constraint. (Phone: still to measure.)
- **Offline:** a `src=` sandboxed frame is *not* served by the service
  worker. A `srcdoc` frame whose scripts the shell inlines works offline.
  `blob:` script URLs made by the shell do *not* load in the opaque frame.
- **Not yet checked on a real phone:** wake lock, fullscreen and audio
  autoplay inside the sandbox (the shell already holds the wake lock).

## Testing a framed game

- Framed games need http(s): `fetch()` cannot read `file://`. Accepted by
  Lokesh 2026-11-13 — opening a game from `file://` is no longer supported. The browser
  suites serve the repo (`scripts/serve.mjs`); `gameScope(page)` returns the
  frame a game runs in, where `window.__game.{handle, ctx}` lives.
- Bring a page to the front before clicking into its game frame
  (`page.bringToFront()`): a sandboxed frame is its own process, and a click
  on a background page that has not drawn since the frame mounted lands on
  the `<iframe>` element instead.

## Outside repos: the registry (built 2026-11-13)

One file per **repository** — a repo may hold several games:

```json
// registry/<owner>/<repo>.json
{
  "repo": "https://github.com/<owner>/<repo>",
  "commit": "<full 40-character sha>",
  "games": ["battleship", "draw-guess"]
}
```

`just community` (`scripts/fetch-community.mjs`) unpacks exactly that commit
— GitHub's tarball, or `git archive` from a clone at `../<repo>` that has the
commit (`NEON_LOCAL_REPOS=owner/repo=path` names another) — and copies only
the listed folders, minus `test-*.mjs`, into `community/<owner>/<repo>/`
(git-ignored). It refuses a bad pin, a missing `game.json`, an invalid
manifest, a duplicate id or a game over 5 MB. Nothing is built or run. It
writes `community/catalog.js` (party.html loads it after `lib/catalog.js`)
and `community/precache.js` (sw.js `importScripts` it; gifs left out).

Community ids are `<owner>/<id>` — `lokeshmohanty/battleship` — in party
state and URLs (`party.html?game=lokeshmohanty%2Fbattleship`). The old pages
(`battleship.html` …) redirect there.

**`lokeshmohanty/arcade-games`** holds battleship, draw-guess, liars-dice,
light-cycles and tug-of-war (Onitama left out
2026-11-13: a recreation of a published game), registered exactly like an outsider's
repo (branch `import`, not yet pushed). Its rules tests load the platform
runtime from a checkout of this repo (`NEON_PLATFORM`, default `../../games/`).
`just test` runs `community` first; the browser suites play those games
through it.

## Pins move by the contributor's pull request (2026-11-13)

Lokesh: the pull request is the contributor's to open — "add a button/command
to open the create PR page (pre-filled)" — and "once merged, it should auto
deploy" (deploy.yml already runs on every push to main). No workflow opens
or merges pins. `just propose owner/repo` (`scripts/propose.mjs`) and the
browser twin `lib/propose.js` (contribute.html's form, Contributors' "Check
for updates") ask the GitHub API for the repo's head: a new repo gets GitHub's
`/new/main?filename=registry/<owner>/<repo>.json&value=…` page filled in
(head commit, every folder with a game.json); a pinned repo that moved gets
its pin's edit page and the commit to paste (GitHub cannot pre-fill an edit).
The pins' commits ride in the catalog (`CONTRIBUTORS[].pins`).

**Checking a submission** (Lokesh, 2026-11-13). `submission.yml` runs on
every `pull_request` touching `registry/` (GitHub's path filter is what picks
contributor PRs out; a label added by a workflow could not trigger another
run): read-only token, no secrets. `scripts/check-submission.mjs` judges it —
only `registry/<owner>/<repo>.json` changes; the author's own owner folder
unless their `author_association` is OWNER/MEMBER/COLLABORATOR; a valid
entry; the commit exists (GitHub API) and an update is `ahead` of the old
pin — then fetches and runs `validate-game` on every listed game, writing
`result.json` + `summary.md` as an artifact. `submission-report.yml`
(`workflow_run`, write access, never checks out PR code) reads that artifact
as data, confirms the PR's head is the judged commit, and sets labels
`game-submission`, `submission: new|update|removal|mixed`, `checks passed` /
`changes needed`, and keeps one result comment current. The rules are tested
without network by `scripts/test-submission.mjs` (`just test-submission`).
`platform-check.yml` (was registry-check.yml) checks changes to the
platform itself.

## The dev kit (built 2026-11-13)

`party.html?dev=http://127.0.0.1:PORT/<folder>/&game=dev%2F<id>&fresh=1`
loads the game whose `game.json` is in that folder into the real party, as
`dev/<id>` (lib/bridge.js `NeonArcade.devGame`; party.html waits for it
before mounting the party). Only loopback hosts — the `?rs=` rule
(`NeonArcade.onLoopback`, room-join.js); anything else is refused with a
toast. Invite links keep the query, so a second tab joins with the same dev
game.

`sdk/v1/dev-server.mjs` is what authors run: no dependencies, serves a folder
on 127.0.0.1 with `Access-Control-Allow-Origin: *`,
`Access-Control-Allow-Private-Network: true` and `no-store`, refuses paths
outside the folder, and prints a link per `game.json` found
(`NEON_PLATFORM` picks another arcade, e.g. `just run`'s).
**VERIFY:** Safari and Chrome's Local Network Access prompt against the live
https site — tested only arcade-on-127.0.0.1 so far (`just test-devkit`).

`sdk/v1/example/tic-tac-toe/` is the template and the dev kit's test game.

## Checking a game (built 2026-11-13)

`just validate-game <folder>…` (`scripts/validate-game.mjs`; `--static`
skips the browser): manifest; entry page exists; scripts/stylesheets inside
the folder and present; no runtime code loading (import, `import()`,
`importScripts`, `new Worker("…")`); no network (fetch, XHR, WebSocket,
EventSource, remote URLs); ≤ 5 MB; then, through the dev kit, mounted with
bots at 390×844 for 5 s with no page/console error and no sideways scroll.

`.github/workflows/registry-check.yml` runs it on every PR touching
`registry/`, `games/`, `sdk/`, `lib/` or the checking scripts — no secrets,
read-only, safe for forks. `.github/workflows/deploy.yml` runs
`fetch-community.mjs` before uploading the Pages artifact. The author
workflow is [`CONTRIBUTING.md`](../CONTRIBUTING.md).

## Web apps: an existing site and its server, unchanged (built 2026-11-14)

**Why.** Lokesh, 2026-11-14, about a friend's React + FastAPI chess variant
(rajarshi99/locale-chess): "I don't want people to have to do significant
changes to their code to be able to use my platform. My platform is supposed
to be plug-n-play." So the platform absorbs the gap: a manifest with `app`
(`scripts/manifest.mjs` `validateApp`) is a web app, built and run as it is.
The author adds `game.json` and a licence (CONTRIBUTING.md, "Already have a
web app?").

**Build** (`scripts/app-build.mjs`, called by `fetch-community.mjs`).
`app.build.run` runs in `app.build.dir` inside a throwaway
`node:22-bookworm-slim` container: no env, no tokens, caps dropped, only the
tarball checkout mounted (`--userns=keep-id` under rootless Podman). In
`deploy.yml` that happens in a `build-community` job with `contents: read`
only; the Pages job downloads its output, so author code never runs beside a
deploy token. The published folder:

```
web/            the built site (app.build.out, or app.web); every script's
                location/history rewritten to __neon.location/__neon.history
                by esbuild --define (parses, runs nothing)
server/         the Python source (no dotfiles, caches, >512 KB files)
server/wheels/  pure-Python wheels of what it imports that Pyodide lacks
game.json       entry web/<page>; app { web, server { kind, target, path,
                files, deps, wheels, stubs } }; ownColours
```

`scripts/py-deps.py` walks the server's `pyproject.toml` /
`requirements.txt` by name (no version solving): in the vendored Pyodide
lock → `deps`; else the newest pure wheel (`pip download --only-binary
--platform any`, so no package code runs) → `wheels`; else, and every
package needing it → `stubs`. Runners (uvicorn, gunicorn…) are skipped.
Size: 5 MB for web/ + server/, 5 MB apart for the wheels.

**The app's frame** (`lib/bridge.js` `buildFrameDoc` with `app`): only
`client.js` and `games.js` of the runtime (no arcade styles), then
`NeonArcade.webApp = { id, address }`, then `sdk/v1/web-shim.js`, then the
app. Root-absolute paths (`/assets/x.js`) resolve to `web/`; icons and
preloads are dropped; the app's CSS `url()`s are inlined. The shim:

- registers the game itself (`takeOver` → false);
- `fetch`/`XMLHttpRequest`: a same-address GET that is a file of `web/` is
  served from it (`asset`); everything else — any origin — is `{t:"http"}`
  to the shell;
- `__neon.location`/`__neon.history`: a virtual address on
  `https://app.invalid`. `pushState`/`replaceState` send `{t:"address"}`;
  `location.href = …`/`assign`/`reload` send it with `reload`.
  `History.prototype` is pointed at it too, for inline scripts the build
  did not rewrite;
- `<img>/<source>/<video>/<audio>` `src` and SVG `href`: a path is caught in
  `setAttribute`/the `src` setter — before the browser starts a load the CSP
  would block (a console error, which validate-game fails) — and swapped
  for a blob: URL; markup inserted as HTML is caught by a MutationObserver;
- `window.open` of a file in `web/` shows it in an overlay frame
  (`sandbox=""`, no scripts).

**The server** (`lib/py-server.js`, host only): a hidden
`sandbox="allow-scripts"` frame, CSP `default-src 'none'; script-src
'unsafe-inline' 'wasm-unsafe-eval'`. Pyodide's two ES modules are inlined
with their exports turned into globals (`createPyodideModule` is a
`loadPyodide` option, so the loader imports nothing); its `fetch` asks the
shell for each file (runtime from `sdk/v1/pyodide/`, wheels from the game's
`server/wheels/`). `sdk/v1/arcade_server.py` installs a stub importer
(missing names are classes: `X | None` and subclassing work, calling raises),
replaces `anyio.to_thread.run_sync` (Pyodide has no threads; Starlette runs
plain `def` endpoints through it), imports the app — stubbing and retrying
any installed package that fails to import — and answers each request as
one ASGI call (or a WSGI call). Requests wait until it is up; 20 s timeout.

**Routing** (`NeonArcade.mountApp`): the host's frame calls the server
directly; a guest's goes `p$http` → host → `p$httpr`, bodies base64, 1 MB
cap each way. Addressed messages can be relayed through other phones in
plaintext (memory: addressed-is-not-private) — fine for a shared screen,
not for hidden information. The address: `p$addr` to everyone; a phone whose
address differs remounts its frame there; a late guest asks the host
(`p$addrq`). A crown change ends the game: the server's memory left with the
host.

**Runtime** (`scripts/vendor-pyodide.mjs`, `just pyodide`): Pyodide
314.0.7 from npm (tarball sha512 pinned) plus the wheels of FastAPI and NumPy
and their dependencies from Pyodide's CDN (each checked against the lock's
sha256), into `sdk/v1/pyodide/` (git-ignored, ~18 MB) with a lock trimmed to
them. Fetched at deploy and in the check workflows; never by a phone from
anywhere but this site. `sw.js` does not precache it (only a host of a web
app needs it) and serves it cache-first.

**Spikes (2026-11-14, headless Chrome):** Pyodide boots in an opaque
`srcdoc` frame (≈1.7 s core, 0.3 s FastAPI's packages, 1.3 s importing the
app — desktop; phone not measured); a JS `fetch` out of it is refused; FastAPI
with the thread patch and a stubbed `supabase` answered locale-chess's
`/state`, `/new-game`, `/click`. `pushState` to `about:srcdoc?game=X` is a
SecurityError by spec and `location` cannot be redefined — hence the
build-time rewrite.

**Dev kit:** `dev-server.mjs` serves a source-form app in its published
layout (game.json synthesized, `web/` = your build output, `server/` = your
server folder, scripts rewritten through `npx esbuild`); packages Pyodide
lacks are stubs there.

**Tests:** `just test-webapp` — `scripts/fixtures/webapp/` (plain JS +
FastAPI importing `psycopg2`) with two peers: server on the host only,
both phones answered, shared address, a guest's click seen by the host's
poll, images, the rules overlay, no network from JS or Python, the game
ends when the host leaves.

**Not done / limits:** no caching of builds between deploys (each deploy
rebuilds every app); Python state is lost on host handover; no WebSocket or
server-sent events; a server that needs threads, subprocesses or a real
database does not run; versions of non-Pyodide wheels are not solved.

## Planned (not built yet)

- Phases 1–6 of the plan: `ctx.reportResult` → stats, accounts,
  leaderboards, feedback, friends, groups.
