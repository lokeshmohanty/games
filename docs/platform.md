# The platform: how a game is hosted, checked and listed

What the arcade does around a game: the sandbox it runs in, the manifest it
declares, the theme and the result it shares, the rules it must follow, and
how an outside repository's games are registered, checked and built. The
messages a game exchanges with the shell are [sdk-v2.md](sdk-v2.md); the
author's steps are [CONTRIBUTING.md](../CONTRIBUTING.md).

*This page replaced the SDK v1 guide (`sdk.md`) on 2026-11-15, when v1 was removed:
every game and web app now says `"sdk": 2`.*

## The sandbox, and why

The arcade is a platform: other people write games, keep them in their own
public GitHub repository, and the platform gives them everything that is not
the game — connections, the party, bots' seats, host handover, accounts,
stats and leaderboards.

Their code must not be able to touch any of that. So every game — ours
included — runs in

```html
<iframe sandbox="allow-scripts" srcdoc="…">
```

with **no `allow-same-origin`**: the frame's origin is opaque (`null`), its
`localStorage` throws `SecurityError`, and it cannot reach the party page's
DOM. It talks to the party only through `sdk/v2/runtime.js` (or an adapter
that speaks the same messages), over a `MessageChannel`, and
`lib/sdk-host.js` answers on the shell's side. `lib/bridge.js` builds the
frame.

**Why `srcdoc`, and one bundle per script** (spikes, 2026-11-13, headless
Chrome):

- **Isolation:** a sandboxed frame's origin is `null`; `localStorage` →
  `SecurityError`.
- **Latency:** a `MessageChannel` round trip with a 64-item state: p50 0.1 ms,
  p95 0.2 ms over 500 trips. Not a constraint. (Phone: not measured.)
- **Offline:** a `src=` sandboxed frame is *not* served by the service
  worker. A `srcdoc` frame whose scripts the shell inlines works offline.
  `blob:` script URLs made by the shell do *not* load in the opaque frame.
  Hence inlining, hence rule 1 below.
- **Not yet checked on a real phone:** wake lock, fullscreen and audio
  autoplay inside the sandbox (the shell already holds the wake lock).

## How a game is laid out

```
games/connect4/
  game.json        the manifest (below)
  index.html       the entry page: the game's own <script>/<link> tags only
  connect4.js      the game
  RULES.md         its rules, shown by the shell (optional)
```

The entry page does **not** include the SDK: the shell inlines
`sdk/v2/runtime.js`, `lib/theme.css` and `lib/styles.css` ahead of the
game's own scripts and stylesheets.

### `game.json`

| Field | Rule |
|---|---|
| `sdk` | `2` — required. `1` is refused since 2026-11-15, with a message saying to set `"sdk": 2` |
| `id` | 2–32 of `a-z 0-9 -`, starting with a letter or digit; community ids are shown as `<owner>/<id>` |
| `name`, `blurb` | ≤ 40 / ≤ 140 characters |
| `title`, `description` | optional, the portal card's; `description` ≤ 300 characters |
| `entry` | an `.html` path inside the game folder |
| `kind` | `duel` · `ffa` · `teams` · `coop` · `local` (what a result means) · `shared` (a web app: no seats, bots or results; goes with `app`, and only with it) |
| `app` | an existing web app and its server, run unchanged — see "Web apps" below |
| `shape` | `teams` · `coop` · `free` (how the party reads teams) |
| `seats` | `{ min, max }`, 1 ≤ min ≤ max ≤ 16 |
| `players` | `{ min, max }`: the people at the table, for a `local` game |
| `bots` | `true`/`false`: can the host fill seats with bots |
| `tags`, `categories`, `preview` | portal filters; sections (`arcade` · `party` · `strategy` · `puzzle` · `examples`); preview gif path |
| `license` | an OSI licence that allows redistribution (the list is in `scripts/manifest.mjs`) |
| `author`, `repo` | GitHub user, `https://github.com/…` |

SDK v2 adds `runtime`, `wasm`, `state`, `tick`, `viewRate`, `opts` and
`rules`: [sdk-v2.md](sdk-v2.md), "The manifest".

`scripts/manifest.mjs` is the one validator, shared by the catalog build,
`validate-game` and the PR checks. `scripts/build-catalog.mjs` gathers every
first-party manifest into `lib/catalog.js` (`just catalog`, checked by
`--check`).

## Colours and type: the theme

Players choose a theme (Paper — the default, following the system's light or
dark — or Neon). A game never names a colour: CSS uses the tokens from
`lib/theme.css`, which the shell inlines into the frame (`--bg`, `--surface`,
`--surface-2`, `--ink`, `--ink-2`, `--ink-3`, `--rule`,
`--accent`/`--on-accent`, `--accent-2`/`--on-accent-2`, `--good`, `--warn`,
`--danger`, `--glow`, players `--p1`…`--p8`). A canvas, a WASM renderer or
Python reads the same colours as values from `init.theme`, and redraws on
`theme.set` ([sdk-v2.md](sdk-v2.md), "The theme, as values"). A colour that
travels between players is sent as an index (a seat, a pen), so each peer
draws it in its own theme. Type: `--font-display`, `--font-body`,
`--font-mono`.

First-party games follow this strictly (`just check-colours` fails on a
literal colour unless its line says `theme-exempt`). An outside game may keep
its own colours (Lokesh, 2026-11-14: "allow his own hard-coded colours"):
`validate-game` warns, and `fetch-community.mjs` marks its published
manifest `ownColours: true`.

## Results

A game says how a match ended, for stats and leaderboards: the protocol's
`result {r}` message, sent on **every peer** (each one saw it), or a managed
game's `result()` ([sdk-v2.md](sdk-v2.md), "Managed state"). The platform
counts it once per run, `match` and ranking (`lib/stats.js`).

```js
arcade.result({
  kind: "duel",            // "duel" | "ffa" | "teams" | "coop" | "local"
  match: 3,                // which match of this run: count up on a rematch
  ranking: [["a"], ["b"]], // places; ranking[0] won; a slot of several = tie/team
  scores: { a: 12, b: 7 }, // optional
});
```

A draw is everyone in one slot; co-op is one slot (played, with scores);
`local` (one phone) counts as played. Leave out seats that emptied. A
managed game's result may also carry `title`, `details` and `names` for the
end card (sdk-v2.md).

## The rules a game must follow

1. **One bundle per `<script>`.** The shell inlines each script; nothing may
   `import` another file at runtime (no code-splitting, no dynamic import).
   Plain scripts need nothing; bundlers: inline dynamic imports / single-file
   output. *Why:* only inlined scripts run in an opaque-origin frame offline
   (the spikes above).
2. **No network.** The frame's CSP is `default-src 'none'` with inline
   script/style and `data:`/`blob:` media: no fetch, no WebSocket, no CDN.
   Files come from the game folder through the protocol's `asset`; a WASM
   module comes in `init`.
3. **Scripts and stylesheets only from the game's own folder.**
4. **Host-authoritative**, and bots run on the host. A managed game
   (`"state": "managed"`) has the platform do this for it.

## Outside repos: the registry

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
manifest, a duplicate id or a game over 10 MB. A web app's site is built
(below); nothing else is built or run. It writes `community/catalog.js` (the
shell loads it after `lib/catalog.js`) and `community/precache.js` (sw.js
`importScripts` it; gifs left out).

Community ids are `<owner>/<id>` — `lokeshmohanty/battleship` — in party
state and URLs (`./?game=lokeshmohanty%2Fbattleship`).

**`lokeshmohanty/web-games`** holds the games its registry entry lists
(Onitama left out 2026-11-13: a recreation of a published game), registered
exactly like an outsider's repo. `just test`
runs `community` first; the browser suites play those games through it.

## Pins move by the contributor's pull request

Lokesh (2026-11-13): the pull request is the contributor's to open — "add a
button/command to open the create PR page (pre-filled)" — and "once merged,
it should auto deploy" (deploy.yml runs on every push to main). No workflow
opens or merges pins. `just propose owner/repo` (`scripts/propose.mjs`) and
the browser twin `lib/propose.js` (the Add your game view's form,
Contributors' "Check for updates") ask the GitHub API for the repo's head: a
new repo gets GitHub's `/new/main?filename=registry/<owner>/<repo>.json&value=…`
page filled in (head commit, every folder with a game.json); a pinned repo
that moved gets its pin's edit page and the commit to paste (GitHub cannot
pre-fill an edit). The pins' commits ride in the catalog
(`CONTRIBUTORS[].pins`).

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
without network by `scripts/test-submission.mjs` (`just test-submission`),
which also checks that a manifest saying `"sdk": 1` is refused.

`platform-check.yml` checks changes to the platform itself: on every pull
request touching `games/`, `sdk/`, `lib/` or the checking scripts it
re-validates every game — no secrets, read-only, safe for forks.
`deploy.yml` runs every suite first (`test.yml`, docs/development.md "CI runs
the suites in parallel"), and `fetch-community.mjs` before uploading the
Pages artifact.

## The dev kit

`./?dev=http://127.0.0.1:PORT/<folder>/&game=dev%2F<id>&fresh=1` loads the
game whose `game.json` is in that folder into the real party, as `dev/<id>`
(lib/bridge.js `NeonArcade.devGame`; the party waits for it before
mounting). Only loopback hosts — the `?rs=` rule (`NeonArcade.onLoopback`,
room-join.js); anything else is refused with a toast. Invite links keep the
query, so a second tab joins with the same dev game.

`sdk/dev-server.mjs` is what authors run (CONTRIBUTING.md, step 2, fetches it
from `https://www.lokeshmohanty.in/games/sdk/dev-server.mjs`): no
dependencies, serves a folder on 127.0.0.1 with
`Access-Control-Allow-Origin: *`, `Access-Control-Allow-Private-Network:
true` and `no-store`, refuses paths outside the folder, and prints a link per
`game.json` found (`NEON_PLATFORM` picks another arcade, e.g. `just run`'s).
**VERIFY:** Safari and Chrome's Local Network Access prompt against the live
https site — tested only arcade-on-127.0.0.1 so far (`just test-devkit`).

**The old address, until 2027-02-15.** The dev kit used to live at
`sdk/v1/dev-server.mjs`, and authors may still fetch it from there. The
build (`scripts/assemble.mjs`) publishes a copy of `sdk/dev-server.mjs` at
`dist/sdk/v1/dev-server.mjs`; the source tree has no `sdk/v1/`.
`just test-devkit` checks the copy is served and identical. **Remove the
copy on 2027-02-15** (STATUS.md, Next actions).

`sdk/v2/examples/tic-tac-toe/` (unlisted) is the dev kit's simplest test
game; the listed `tic-tac-toe-*` examples are the templates, one per
language (CONTRIBUTING.md).

## Checking a game

`just validate-game <folder>…` (`scripts/validate-game.mjs`; `--static`
skips the browser): manifest; entry page exists; scripts/stylesheets inside
the folder and present; no runtime code loading (import, `import()`,
`importScripts`, `new Worker("…")`) and no network (fetch, XHR, WebSocket,
EventSource) — **warnings since 2026-11-14** (compiler glue carries such
paths; the frame's CSP is what holds, and a CSP violation fails the browser
check); `RTCPeerConnection`/`RTCDataChannel` fail outright (WebRTC is outside
CSP); no remote URLs; ≤ 10 MB; then, through the dev kit, mounted with bots
at 390×844 with no page/console error, no CSP violation and no sideways
scroll, and a v2 game must say `ready`. sdk-v2.md, "The rules a game must
follow (v2)", has the reasoning.

## Web apps: an existing site and its server, unchanged

**Why.** Lokesh, 2026-11-14, about a friend's React + FastAPI chess variant
(rajarshi99/locale-chess): "I don't want people to have to do significant
changes to their code to be able to use my platform. My platform is supposed
to be plug-n-play." So the platform absorbs the gap: a manifest with `app`
(`scripts/manifest.mjs` `validateApp`) and `kind: "shared"` is a web app,
built and run as it is. The author adds `game.json` (with `"sdk": 2`) and a
licence (CONTRIBUTING.md, "Already have a web app?").

**Build** (`scripts/app-build.mjs`, called by `fetch-community.mjs`).
`app.build.run` runs in `app.build.dir` inside a throwaway
`node:22-bookworm-slim` container: no env, no tokens, caps dropped, only the
tarball checkout mounted (`--userns=keep-id` under rootless Podman). In
`deploy.yml` that happens in a `build-community` job with `contents: read`
only; the Pages job downloads its output, so author code never runs beside a
deploy token.

A pinned commit always builds the same, so each build is kept
(`NEON_APP_CACHE=dir`, set in all three workflows and restored with
`actions/cache`). An entry's key hashes the owner, repo, commit, game path
and the build tooling (`app-build.mjs`, `py-deps.py`,
`sdk/pyodide/pyodide-lock.json`), so a new pin or new tooling builds again
and nothing else does; entries no pin uses are dropped at the end of a run.
A pull request reads main's entries, but what it builds is saved where only
that pull request sees it. Locally, without the variable, every run builds.
The published folder:

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
Size: 10 MB for web/ + server/ (a game's limit), 5 MB apart for the wheels
(`fetch-community.mjs` `MAX_GAME_BYTES`, `MAX_WHEEL_BYTES`).

**The app's frame** (`lib/bridge.js` `buildFrameDoc` with `app`):
`sdk/v2/runtime.js` (no arcade styles), then `window.arcadeWebApp = { id,
address }`, then `sdk/v2/web-shim.js`, then the app. Root-absolute paths
(`/assets/x.js`) resolve to `web/`; icons and preloads are dropped; the
app's CSS `url()`s are inlined. The shim speaks three protocol messages
(`asset`, `http`, `address`; sdk-v2.md, "The manifest") and:

- `fetch`/`XMLHttpRequest`: a same-address GET that is a file of `web/` is
  served from it (`asset`); everything else — any origin — is an `http`
  request to the app's server;
- `__neon.location`/`__neon.history`: a virtual address on
  `https://app.invalid`. `pushState`/`replaceState` send `address`;
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
shell for each file (runtime from `sdk/pyodide/`, wheels from the game's
`server/wheels/`). `sdk/arcade_server.py` installs a stub importer
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
sha256), into `sdk/pyodide/` (git-ignored, ~18 MB; it was `sdk/v1/pyodide/`
until 2026-11-15) with a lock trimmed to them. Fetched at deploy and in the
check workflows; never by a phone from anywhere but this site. A Python game
(`runtime: "python"`) uses the same runtime. `sw.js` does not precache it; it
is cached on first use in a cache of its own (`RUNTIME`, named by a hash of
its path, names and bytes, so it survives deploys that leave it alone and is
dropped when it moves or changes; docs/spa.md).

**Spikes (2026-11-14, headless Chrome):** Pyodide boots in an opaque
`srcdoc` frame (≈1.7 s core, 0.3 s FastAPI's packages, 1.3 s importing the
app — desktop; phone not measured); a JS `fetch` out of it is refused; FastAPI
with the thread patch and a stubbed `supabase` answered locale-chess's
`/state`, `/new-game`, `/click`. `pushState` to `about:srcdoc?game=X` is a
SecurityError by spec and `location` cannot be redefined — hence the
build-time rewrite.

**Dev kit:** `sdk/dev-server.mjs` serves a source-form app in its published
layout (game.json synthesized, `web/` = your build output, `server/` = your
server folder, scripts rewritten through `npx esbuild`); packages Pyodide
lacks are stubs there.

**Tests:** `just test-webapp` — `scripts/fixtures/webapp/` (plain JS +
FastAPI importing `psycopg2`) with two peers: server on the host only,
both phones answered, shared address, a guest's click seen by the host's
poll, images, the rules overlay, no network from JS or Python, the game
ends when the host leaves.

**Limits:** Python state is lost on host handover; no WebSocket or
server-sent events; a server that needs threads, subprocesses or a real
database does not run; versions of non-Pyodide wheels are not solved.
