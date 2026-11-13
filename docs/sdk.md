# The game SDK (v1) — writing a game for the platform

*Started 2026-11-13 on branch `platform`. Plan of record:
`~/.claude/plans/1-a-b-2-generic-whistle.md`. Status: the bridge, the frame
loader and the catalog are built and tested with Connect 4; the registry of
outside repos, the dev kit, `validate-game` and the PR check are not built
yet (marked **planned** below).*

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
| `kind` | `duel` · `ffa` · `teams` · `coop` · `local` (what a result means) |
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
| `ctx.reportResult(r)` | the outcome, for stats/leaderboards (shape: Phase 1 of the plan) |
| `ctx.storage.get(key)` / `.set(key, value)` | per game, per device; 64 KB of JSON |
| `ctx.assets.url(path)` | `Promise<blob: URL>` for a file in the game folder (images, sounds, fonts) |

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

- Framed games need http(s): `fetch()` cannot read `file://`. The browser
  suites serve the repo (`scripts/serve.mjs`); `gameScope(page)` returns the
  frame a game runs in, where `window.__game.{handle, ctx}` lives.
- Bring a page to the front before clicking into its game frame
  (`page.bringToFront()`): a sandboxed frame is its own process, and a click
  on a background page that has not drawn since the frame mounted lands on
  the `<iframe>` element instead.

## Planned (not built yet)

- **Registry of outside repos:** `registry/<owner>/<repo>.json =
  {repo, commit, games: [paths]}` — one file per repository, which may hold
  several games; fetched at the pinned commit into `community/` at deploy.
- **Dev kit:** `party.html?dev=http://localhost:PORT/` (loopback only).
- **`just validate-game <path>`** and the matching PR check.
- **Moved games:** battleship, draw-guess, liars-dice, light-cycles, onitama
  and tug-of-war live in `lokeshmohanty/arcade-games` (branch `import`, not
  yet pushed) and come back through the registry.
