# The game SDK v2: a protocol, so a game can be written in any language

*Built 2026-11-14 (Phase 2 of the platform plan); managed state, the
adapters and the ports of every game followed (Phase 3). SDK v1 was removed
on 2026-11-15: every game and web app says `"sdk": 2`. What the platform
does around a game — the sandbox, the manifest's base fields, the theme,
results, the registry and the checks — is [platform.md](platform.md).*

## What changed, and why

Lokesh asked (2026-11-14) for contributing a game to be **independent of the
language it is written in**, "with minor modifications", through an API "not
in the traditional sense, rather the way that would suit it".

v1's contract was a JavaScript object: `registerGame({ mount(ctx) })`, plus
helpers (`makeSecrets`, `makeRounds`, `turnWait`, `hostPause`) that ran as
JavaScript *inside* the frame. A game in Rust or Python had to reimplement
them, or carry a JavaScript layer that did.

v2's contract is **the messages themselves**. The frame and the party shell
talk over one `MessagePort`; every message is listed in
[`sdk/v2/protocol.json`](../sdk/v2/protocol.json) (JSON Schema 2020-12). A
game is anything that can read and write those messages, whatever it is
written in. Every helper a game used to carry is now a **shell service**: the
game sends a message and hears the result. The clock, the turn-wait banner,
the host pause and sealing all run in the shell, against the real party.

The sandbox has not changed (platform.md, "The sandbox, and why"): the frame is still
`sandbox="allow-scripts"` with an opaque origin and a CSP that allows no
network. What changed is only what crosses the port.

Two layers (decided 2026-11-14):

| Layer | What the game writes | Status |
|---|---|---|
| 1. The protocol | Messages: channels to other phones, plus services. Host-authoritative, as before. | **built** |
| 2. Managed state | `init / apply / tick / view / turn / bot / result / snapshot / restore`; the platform does sync, bots, rejoin and host handover | **built** (Phase 3) |

## A game, end to end

```
game folder/
  game.json        { "sdk": 2, … }  (+ "runtime": "wasm", "wasm": "pkg/x_bg.wasm")
  index.html       names its own scripts and stylesheets, nothing else
  …
```

1. The shell builds the frame (lib/bridge.js `buildFrameDoc`). It inlines
   `sdk/v2/runtime.js`, the arcade's `lib/theme.css` and `lib/styles.css`,
   then the game's page with its scripts and stylesheets. `<html>` carries
   `data-theme`, `data-mode` and `data-runtime`.
2. The shell posts `{ t: "neon:port" }` to the frame's window, with a
   `MessagePort` attached. This is the only message that is not on the port.
3. The frame says `hello`. The shell answers with `init`: the party, the
   seats, the theme as values, the game's saved storage, the services it
   offers (`features`) and, for a WASM game, the module's bytes.
4. From then on both sides send messages. The game says `ready` once it has
   drawn its first screen.

Every message is `{ v: 2, t: "<type>", … }`. A request carries `id` (unique
per sender), and its answer is `{ t: "reply", re: <id>, ok, … }`, with `err`
when `ok` is false. **Unknown `t` is ignored on both sides**, so a newer
shell works with an older game and the reverse.

### The JavaScript end: `sdk/v2/runtime.js`

```js
await arcade.init                       // the init message
arcade.party                            // { self, host, members }, kept current
arcade.on("roster", (m) => …)           // any message type → off()
arcade.send("toast", { text: "hi" })    // fire and forget
const r = await arcade.request("asset", { path: "level1.json", as: "text" })
arcade.answer("takeOver", () => true)   // the shell's own requests

// One-liners over the same wire:
const moves = arcade.channel("move", (d, from) => …)  // listen + send
moves.send({ i: 4 }, arcade.party.host)
moves.emitAs(botId, { i: 2 })
arcade.isHost(); arcade.ready(); arcade.result(r); arcade.toast(text)
arcade.debug = () => state              // tests read it as __game.handle.debug()
```

The runtime also applies `theme.set` to `<html>`, so a DOM game's CSS
variables follow the page without code.

## Managed state (Layer 2)

*Built 2026-11-14 (Phase 3): `lib/sdk-managed.js`, `arcade.managed()` in the
runtime, the example `sdk/v2/examples/tic-tac-toe-js`, and
`just test-managed`.*

With `"state": "managed"` in game.json, a game writes **rules and a draw
function**, and the platform does everything else that every v1 game wrote
by hand:
- host authority, with views for each phone;
- bots, the turn-wait banner and results;
- the end card with PLAY AGAIN;
- rejoining, and carrying on under the heir when the host leaves.

```js
arcade.managed({
  init({ seats, opts, seed, match }) { … },   // seats: [{ id, name, team, bot }]
  apply({ action, by }) { … },                // return nothing to allow; a string to refuse (the reason)
  view({ seat }) { return … },                // what this seat may see; seat null = a spectator
  turn() { return [ids…] },                   // whose move it is: drives bots and the turn-wait banner
  bot({ seat }) { return action },            // a bot's move (null: none)
  result() { return null | { kind, ranking, scores?, title?, details?, names? } },   // platform.md "Results"; title, details, names: the end card's (below)
  snapshot() { return state },                // for the heir
  restore({ snapshot }) { … },
  skip({ seat }) { … return true },           // optional: the host chose SKIP TURN
  tick({ inputs, dt }) { … },                 // with manifest "tick": a fixed step
});
arcade.on("view", ({ state }) => draw(state));  // every phone, on change only
button.onclick = () => arcade.act({ i: 4 });    // your move; a refusal comes back as "rejected"
arcade.idle();                                  // optional: this view is shown (its animation is over)
```

How it runs:

- **Every phone's frame holds the rules; only the host's are live.** A
  guest's `act` goes to the host shell (`v:m$act`), which calls
  `apply({ action, by })`. On success it calls `turn`, `result` and `view`
  for every phone, all in **one `rules` request**, and sends each phone its
  view, only when that view changed. A refusal goes back to that phone as
  `rejected { reason }`.
- **Bots.** After every change the host asks `turn()`. A bot on turn moves
  after a 0.6–1.1 s pause, through `bot({ seat })` and then `apply`.
- **Waiting.** When exactly one person is on turn and they have switched
  apps, are reconnecting, or have left, the shell's turn-wait banner shows.
  SKIP TURN calls `skip`; a game without `skip` says it cannot.
- **Results.** `result()` is checked after every change. It is reported once
  on every phone (with `match`), and the shell draws the end card. PLAY
  AGAIN calls `init` again with `match + 1`.
- **The end card waits for the last move's animation** (2026-11-15: a
  winning chain in Neon Fission was covered by the card before the loser
  saw a cell flip). A game that animates its moves calls `arcade.idle()`
  whenever it has finished showing the latest view: at once when there is
  nothing to animate, at the end of an animation, and when a tap skips one.
  - Each `view` carries `seq`, rising by one per view on that frame, and
    `idle {seq}` echoes the newest one shown (the runtime fills it in).
  - Once a frame has sent `idle`, the shell holds the end card after the
    final move until the frame is idle on the newest view it was sent, or
    for at most 6 s (`HOLD_MS` in lib/sdk-managed.js). Every phone waits
    for its own frame, at its own pace. A frame that goes quiet (crashed,
    a bug) still gets its card after 6 s.
  - Only the card waits: the result is reported, counted and sent to the
    heir at once, as before.
  - A game that never calls `idle` gets its card at once, as before.
  - Under `prefers-reduced-motion` a game should not animate, so it says
    `idle` at once and the card is not held.
- **Played alone, ranked.** When a signed-in player starts a game alone
  (one seat, no bots), the shell asks the arcade's server for a run before
  `init`, and `seed` is the server's: deal anything random from it and the
  server can deal the same. A result may carry `proof` (any JSON) for a
  server-side check of the run; Sudoku sends its solved grid. Offline or
  signed out, `seed` is local and the run does not rank. docs/accounts.md
  "Solo runs".
- **The end card** (Lokesh, 2026-11-15: everything, with the extra
  information behind a toggle so the screen stays simple). Always shown:
  - the title: `title` (≤ 40 characters) if the result has one, else YOU
    WIN / X WINS / DRAW / GAME OVER (co-op);
  - the ranking: place (a tie or a team shares one; co-op has none), the
    seat's colour (`--p1`…`--p8` in seat order), name, and score when
    `scores` has one; this phone's row is marked;
  - PLAY AGAIN on the host (others read who can start one), and SEE THE
    BOARD, which tucks the card away to look at the final board.

  Behind DETAILS (closed at first; open or closed is remembered on the
  device, localStorage `neon.overDetails`):
  - **Series:** the match number, how long it took (the host times it
    from `init` and sends it with the result; an heir keeps the clock),
    and the matches won since this game was mounted on this phone (only
    players who have won one are listed; draws counted; co-op has none);
  - **Your stats:** this device's record for the game (lib/stats.js:
    played, won, streak and best, against bots and people, best score).
    Rating changes are not shown: the server's match report answers only
    whether it counted;
  - **The game's own details:** an optional `details` in the result,
    `[{ label, value }]`, at most 8 rows of short strings or numbers
    (label ≤ 32 characters, value ≤ 40; anything else is dropped), drawn
    as a small table. Connect 4 gives moves played and the winning line;
    Neon Survival the time survived and each player's gems and time.
  - **Names for bot seats:** an optional `names`, `{ id: name }`, renames
    bot seats on the card (≤ 24 characters; a real member's name is never
    replaced). For people sharing the host's phone, which the platform
    sees as bot seats: Neon Fission's "Player 3". The game still does not
    rank (it has bot seats).

  ```js
  result() {
    return { kind: "duel", ranking, details: [{ label: "Moves played", value: 23 }, { label: "Winning line", value: "c1 d2 e3 f4" }] };
  }
  ```
- **Handover.** After every change the host sends `snapshot()` to the heir
  (net.js `heir()`, the longest-present member), at most once a second when
  ticking. When the crown moves, the heir's shell calls `restore` on its
  own frame and carries on. This replaces every game's hand-written
  `takeOver`. The heir can read the whole state (the trusted-host decision).
- **Rejoin.** A phone that (re)mounts is sent its view at once.
- **Ticking** (manifest `"tick": 1–60`, `"viewRate"` ≤ tick, default 15):
  - The host steps `tick({ inputs, dt })` at a fixed rate, with each seat's
    latest `arcade.input(i)` and each bot's `bot()` as its input.
  - Views go out at `viewRate`; interpolating between them is the game's
    job.
  - While the host's tab is hidden, everyone is paused (`paused`).
  - One tick is one round trip: tick, turn, result and the due views are
    batched together.
- **Determinism is not required:** the host is authoritative.
- **Races, fixed after the review of 2026-11-14:**
  - **Epochs.** Every start (match, rematch, takeover) begins a new epoch,
    and anything still in flight from an older one is dropped. A refresh
    across PLAY AGAIN no longer ends the new match.
  - **Acts carry their match.** A tap meant for the last game is refused,
    not applied to the new one. A guest's acts are capped at 30 a second.
  - **The heir's copy.** It is sent the moment a result lands, and an heir
    keeps a result it already heard. On a takeover, only leaves heard after
    the copy are replayed, and never for someone who came back.
  - **Views are re-sent on every roster change.** A link that drops and
    returns without a reload fires no join, so a view sent into the outage
    would otherwise be lost.
  - **Late joiners** get the end card too.
  - **Ticking inputs** are pruned to the seated players, and cleared on a
    rematch.
  - **The turn-wait banner** shows on every phone; only the host has its
    buttons. SKIP waits for a takeover still settling, and checks `turn()`
    before calling `skip`.
  - **Binary** in acts, inputs, views and snapshots crosses as `{ $bin }`,
    like channel messages.

A managed game may still use Layer 1 channels for ephemeral streams (a
drawing's strokes), and Layer 1 services.

**The HTML/CSS lane.** A managed game can be markup plus its rules, with no
rendering code:

| Attribute | Effect |
|---|---|
| `data-arcade-text="board.3"` | shows that path of the view |
| `data-arcade-show="mine"` | shows the element while the path is truthy |
| `data-arcade-class="o:isO"` | toggles a class |
| `data-arcade-attr="data-mark:board.3"` | sets an attribute (only `data-*`, `aria-*`, `value`, `title`, `alt`, `disabled`, `hidden`, `checked`, `role`, `tabindex`: a view may carry player text, and `href`/`src` could be a `javascript:` URL) |
| `data-arcade-act='{"i":4}'` | on a button: sends that action |

The runtime applies them on every `view`.

**Conformance.** The JS example's rules are the reference: every language's
tic-tac-toe must give the same views and results for the same moves
(`scripts/test-conformance.mjs`).

## The catalogue

The schema is the authority; this table is the map.

| Group | Frame → shell | Shell → frame |
|---|---|---|
| Lifecycle | `hello {sdk, runtime, features}` · `ready` | `init` · `unmount` · `takeOver` (request) |
| Party | `meta {patch}` | `roster {party}` on change only · `join {who}` · `leave {who}` |
| Channels | `listen {ch}` · `send {ch, d, to?}` · `emitAs {bot, ch, d, to?}` | `msg {ch, d, from}` |
| Storage | `store.set {key, value}` · `session.set {key, value}` | (in `init`: `storage`, `session`) |
| Files | `asset {path, as?}` → `{bytes, type}` or `{text, type}` | |
| Outcome | `result {r}` · `end` · `hostNew` | |
| Screen | `toast {text, kind}` · `ask {text, ok, cancel}` → `{yes}` · `haptic {ms}` | `theme.set {theme}` |
| Clock | `timer.open {name, rounds, phases, bots}` · `timer.do {name, op, …}` | `timer {name, ev, info, entries?, bot?}` |
| Waiting | `wait.turn {who}` · `wait.pause {on}` | `wait {ev: "skip", who}` · `paused {on}` |
| Secrets | `seal.listen {ch}` · `seal.send {ch, to, d}` → ok · `commit {value}` → `{digest, nonce}` · `verify {…}` → `{valid}` | `sealed {ch, d, from, to?}` |
| Managed (Layer 2) | `act {a}` · `input {i}` · `idle {seq}` | `rules {calls}` (request) → `{out}` · `view {state, seq}` · `rejected {a, reason}` |
| Runtimes | `runtime.file {path}` → `{bytes, type}` (Pyodide, for `runtime: "python"`) | |

What the services do, briefly. The long explanations are in the files they
come from, which the shell now runs:

- **Channels.** A channel is wired as `g:<name>`, so a
  game cannot speak on the party's own channels. Messages for a channel the
  frame has not opened yet are held (up to 500) and delivered on `listen`.
  `to` addresses one player, but **addressed is not private**: the message
  may be relayed through another phone. Use `seal.send` for secrets.
- **`timer.*`** is lib/rounds.js. Every peer opens the same clock and the
  host's runs it. Phases may `collect`: a collecting phase ends early once
  every seated player has submitted, and the host hears `collect` with each
  player's entry. With `bots: true`, a bot seat's turn arrives at the host
  as `ev: "bot"`, which the host answers with `timer.do` `submitFor`. Times
  travel as durations, never as timestamps.
- **`wait.turn`** is the turn-wait banner (lib/games.js `turnWait`). Say
  whose move it is. While that player is reconnecting or has switched apps,
  the **shell** shows everyone who the game is waiting for and for how long.
  After 30 s the host may WAIT, SKIP TURN or END GAME. SKIP arrives as
  `wait {ev: "skip", who}`; apply the game's own rule for a missed turn.
- **`wait.pause`** is lib/games.js `hostPause`, for real-time games. While
  the host's tab is hidden, every phone gets `paused {on: true}`. When the
  host comes back there is a 3-2-1 countdown, then `paused {on: false}`.
- **`seal.*`, `commit`, `verify`** are lib/secrets.js. Sealed messages carry
  JSON only, never binary: the cipher runs over canonical JSON. `seal.send` encrypts
  end to end (AES-GCM, with keys from ECDH published on the party record), so
  a relaying phone cannot read it. A message to a bot stays on the host and
  arrives back as `sealed` with `to` set to the bot. Every phone in a sealed
  game must `seal.listen`, which also publishes its key. `commit` returns a
  digest to publish now, and the value and nonce are revealed later. The
  host is still trusted with what it referees (the trusted-host decision,
  2026-11-14).
- **`asset`** reads a file from the game's folder (never outside it) as
  bytes or text. A frame cannot load a `blob:` URL that the shell made, so to
  get a URL, make one in the frame from the bytes.
- **`result`** is the outcome (platform.md, "Results"). Every peer may
  send it, and it counts once.

### The theme, as values

`init.theme` and `theme.set.theme` are `{ name, mode, dark, tokens, players,
fonts }`:

- `tokens` holds each colour token as `rgba(r, g, b, a)`, camelCased (bg,
  surface, ink, accent, accent2, good, warn, danger, …).
- `players` holds the eight seat colours in seat order.

These are values, not CSS, so a canvas, a WASM renderer or Python can use
them directly. DOM games also have the CSS variables (`var(--accent)`).
Colours from the theme are still the rule, and a literal colour is still only
a warning (platform.md, "Colours and type: the theme").

### Binary

An `ArrayBuffer` (or typed array) may sit anywhere in a channel message's
`d`:

- **Frame → shell:** it is structured-cloned.
- **Between phones:** the shell encodes it as `{ "$bin": "<base64>" }`, and
  decodes it on arrival.
- **Into the frame:** it is transferred.

A game sees an `ArrayBuffer` at both ends. (A native binary DataChannel frame
waits until a measured game needs one.)

### Limits

| Limit | Value |
|---|---|
| Messages from a frame | 1000 a second; more are dropped, with a warning |
| One message: channel, `meta`, a submission, a sealed message | 256 KB as sent (binary counted as base64); over it, or not JSON, it is dropped with a console warning |
| Open clocks / sealed channels | 16 / 32 per game |
| Channel name | ≤ 64 characters |
| `store` | 64 KB of JSON per game per device |
| One `session` value | 32 KB |
| A game folder | 10 MB (was 5 MB) |

## WebAssembly

The frame's CSP now includes `'wasm-unsafe-eval'`. WebAssembly may compile,
but the frame still cannot fetch, so the shell fetches the module:

```json
{ "sdk": 2, "runtime": "wasm", "wasm": "pkg/tic_tac_toe_bg.wasm", … }
```

The shell starts fetching the module as soon as the game is picked
(`prefetchFrame`, alongside the frame build) and sends the bytes in
`init.wasm`, a fresh copy on each mount. Toolchains fit like this:

- **wasm-bindgen** with `--target no-modules`, then
  `wasm_bindgen.initSync({ module: arcade.wasm })` (adapters/rust).
- **Emscripten** with `-sMODULARIZE`, the bytes given as `wasmBinary`
  (adapters/c). Emscripten 6.0.9's loader works inlined in a srcdoc frame
  without a patch.
- **TinyGo** with `-scheduler=none`: `wasm_exec.js`, then
  `WebAssembly.instantiate(arcade.wasm, go.importObject)` (adapters/go).

Engines are welcome up to the 10 MB cap. Godot and Unity are out (decided
2026-11-14).

## Adapters: the same game in every language

*Built 2026-11-14 (Phase 3).* Every language other than JavaScript reaches
managed state through one function:

- **Input:** `dispatch(json)` takes one `rulesCall`, e.g.
  `{"fn":"apply","action":{"i":4},"by":"pX"}`.
- **Output:** it returns that call's `rulesOut`, `{"v": …}` or `{"err": "…"}`.
- **Wiring it up:** the page calls `arcade.managedJson(dispatch)` once the
  language is up.
- **The adapter's part:** making the rules idiomatic, so an author never
  touches JSON or the protocol.

Each lane ships Tic Tac Toe as a managed game in
`sdk/v2/examples/tic-tac-toe-<lane>`. `just test-conformance` drives each
one's real sandboxed frame through one 25-step scripted match: refusals and
their reasons, bot moves, snapshot → restore, skip, the result and a
rematch. Every answer must equal the JavaScript reference's.

| Lane | Adapter | The author writes | Ships (gzip) |
|---|---|---|---|
| JavaScript | runtime.js `arcade.managed` | an object of rules | 1.5 KB |
| HTML/CSS | runtime.js `data-arcade-*` | markup, CSS, and the rules object | 1.6 KB |
| TypeScript + Solid | `adapters/ts`: `defineGame<State, Action, View>`, `createView` | typed rules (`apply` gets an `Untrusted<Action>`) and a Solid view | 5.7 KB (mostly Solid) |
| Rust | `adapters/rust`: crate `arcade`, `trait Game` with associated serde types, `arcade::export!(G)` | `impl Game` | 43 KB wasm + 2 KB glue |
| Python | `adapters/python`: `arcade.Game`, `arcade.run(cls)`, a boot script | a class | 7 KB, plus the platform's Pyodide (12.8 MB, outside the cap) |
| C/C++ | `adapters/c`: header-only `arcade.h` (bounded JSON reader and writer), `ARCADE_GAME(.init = …, …)` | a struct of rule functions | 6.4 KB wasm + 2 KB loader and glue |
| Go (TinyGo) | `adapters/go`: `Game` interface (+ `Skipper`, `Ticker`), `arcade.Run(new, restore)`, its own small JSON codec | an implementation of `Game` | 65 KB wasm + 5 KB glue |

Each adapter's README has the minimal game and how to build it. Built
output is committed, because CI never builds contributor code. Builds go
through `nix shell` (Rust 1.99 with wasm-bindgen-cli 0.2.129; Node 24 for
the TypeScript lane, whose npm files live only in its example folder).

Lane notes:
- **Rust.** wasm-bindgen's `no-modules` output runs
  `new URL(document.currentScript.src, location.href)`. Inlined into a
  srcdoc frame, `src` is `""` and the base is `about:srcdoc`, so it throws
  at load. `adapters/rust/build.sh` patches that condition, and stops if the
  generated line ever changes or if the wasm-bindgen CLI and crate versions
  differ.
- **Python.** Boot time is 2 s in the harness and 5 s in the real party,
  cold. The game's frame boots Pyodide from files the shell hands it
  (`runtime.file`) and loads only the core: no packages, no network. Every
  phone boots it, because every phone's frame holds the rules for a
  takeover. **Offline:** the core (~13 MB) is not in the install precache;
  it downloads when a Python game is first picked online and then stays on
  the device across deploys (sw.js `RUNTIME`). Opened offline before that,
  the shell refuses `runtime.file` and tells the player, in a dialog, to
  play it once online (lib/sdk-host.js).
- **C/C++.** `dispatch`'s answer belongs to the header until the next call.
  Its JSON parser is strict (RFC 8259) and refuses nesting deeper than 64.
  It was fuzzed under ASan and UBSan with 4,058 malformed calls, and gave
  the same answers as the JS reference natively too. `arcade_fail` works only
  from the file holding `ARCADE_GAME`.
- **Go.** TinyGo with `-scheduler=none`, and no `encoding/json`, `fmt` or
  `syscall/js`. Those cost about 1 MB, 125 KB and double the module
  respectively. JSON crosses through linear memory (`arcade-go.js`, 20
  lines). TinyGo cannot recover a panic in wasm: a panicking rule becomes
  that call's `err`, but the Go side may not be sound afterwards.
  `go test` in `adapters/go` covers the codec against encoding/json.
- **TypeScript.** The protocol types are imported type-only from
  `sdk/v2/bindings/protocol.ts`, so nothing of them ships. The build is
  Vite in library mode, as a single classic IIFE script.

Learned from the first Rust example (Layer 1), and done since:
- `arcade.on("*")` delivers every message.
- `arcade.wasm` holds the module bytes outside `init`.
- A catch-all game sends its own `reply`.
- One `dispatch` shape for every language.

## Bindings

`scripts/gen-bindings.mjs` turns protocol.json into types for TypeScript,
Rust (serde), Go and Python, in `sdk/v2/bindings/`. Run `just bindings`
after changing the schema. `just check-bindings`, which is part of
`just test`, fails if the bindings are stale. C has no common JSON library,
so its adapter carries a small JSON reader and writer instead (adapters/c).

Why JSON Schema: the wire is JSON, and every target language has validators
and code generators for it. Not chosen:

- **WIT / the component model:** browsers cannot load components without a
  `jco` transpile step.
- **A custom IDL:** we would own its code generator forever.

## The manifest

These fields add to the base `game.json` (platform.md, "`game.json`"):

| Field | |
|---|---|
| `"sdk": 2` | required for every game and web app |
| `"runtime"` | `"js"` (default), `"wasm"`, or `"python"` (the platform's Pyodide; adapters/python) |
| `"state"` | `"managed"`: the platform runs the rules (Layer 2) |
| `"tick"`, `"viewRate"` | managed and real-time: steps and views per second |
| `"wasm"` | with `runtime: "wasm"` only: the module's path inside the folder |
| `"rules"` | a Markdown file in the folder (`"RULES.md"`): the rules, shown by the shell on a first open and behind "?" (below) |

**Rules** (Lokesh, 2026-11-15: "the first time the user opens it, a
screen with the game rules (with examples) … and a '?' button so that the
player can see this anytime"). `lib/rules.js` draws the file, with
`lib/markdown.js`, in a sheet over the game, on this phone only.
- **When.** The first time this device mounts the game (localStorage
  `neon.rules.<id>`, set however the sheet closes: GOT IT, ✕, Escape, a tap
  outside), and whenever **?** in the party's top buttons is pressed. A game
  without `rules` has no **?**.
- **Nothing pauses.** The game keeps running underneath, for the others and
  for this phone; nothing is sent to the game or the party, so a guest
  reading the rules holds nobody up.
- **Offline.** The shell fetches the file from the game's folder, so the
  service worker serves it: `scripts/assemble.mjs` precaches every
  first-party game's rules (and fails the build when one is missing), and a
  community game's comes with its folder (`community/precache.js`).
- **Under automation** (`navigator.webdriver`) the first-open sheet stays
  away, so the suites that drive games are not stopped by it. localStorage
  `neon.rules` = `"on"` brings it back, `"off"` turns it off.
  `just test-rules-screen` tests it at 390×844 in every theme, offline too.
- **Content.** CONTRIBUTING.md, "How to play: RULES.md".

**Web apps** (`app`, `kind: "shared"`; platform.md, "Web apps") run on v2,
and since 2026-11-15 their manifest must say `"sdk": 2` like any game's (an
`"sdk": 1` app was upgraded as it mounted until then). The frame gets `sdk/v2/runtime.js` and `sdk/v2/web-shim.js`, which speaks three
protocol messages:
- `asset`, for the app's own files, from `app.web`;
- `http`, a request answered by the app's server on the host's phone (body
  in base64);
- `address`, the party's shared address.

## The rules a game must follow (v2)

1. **One bundle per `<script>`**, as before: the shell inlines each one.
2. **No network.** The CSP forbids it. Files come from `asset`, and a WASM
   module comes in `init`.
3. **Scripts and stylesheets only from the game's own folder.**
4. **Host-authoritative**, and bots run on the host. Layer 2 will do this
   for you.

`validate-game` changed with v2. Two static checks became **warnings**: code
that looks as if it loads more code (`import`, `new Worker`) or uses the
network (`fetch`, `WebSocket`). Compiler glue (wasm-bindgen, Emscripten)
carries such paths and never takes them. For these, the browser check
decides: the game runs under the frame's real CSP, and **any CSP violation
fails it**. A WASM game's module must exist and start with `\0asm`.

**What the CSP does not hold, so stays a static failure.** `RTCPeerConnection`
and `RTCDataChannel` are rejected outright.
- **Why:** WebRTC is outside CSP. The review of 2026-11-14 had a sandboxed
  frame under the bridge's exact CSP gather candidates from a public STUN
  server.
- **Known gap:** a frame may also navigate itself (`location =
  …`), which CSP does not stop either. Its URL could carry data out. The
  static check and review are what stand between a game and that.

## Testing

- **`just test-protocol`** (`scripts/test-protocol.mjs`): three real
  browsers form a party by invites, add a bot, and play
  `scripts/fixtures/protocol-game`. The fixture uses every service once. The
  test also switches the theme, hides the turn player's tab and presses
  SKIP TURN on the host's page, and hides the host's tab.
  - Every message that crossed a frame (189 in a run) is validated against
    protocol.json.
  - The fixture's own report says each service worked.
  - Every message type must have been exercised, except `join`, `leave` and
    `hostNew`, which need a player to come and go.
  - The test watches through `NeonArcade.sdkTrace(direction, message)`.
- **`just test-devkit`** plays the examples (the unlisted `tic-tac-toe` and
  the managed JavaScript, Rust, HTML/CSS, TypeScript, Go and C ones) against
  a bot to the end, through the dev kit, at 390×844. It checks that a frame
  has none of the shell's globals in it (only the protocol), that a `?dev=`
  off this machine is refused, and that the dev kit's old address
  (`sdk/v1/dev-server.mjs`, until 2027-02-15) serves the same file.

## What is deliberately not here yet

- **The roster event.** The shell still compares the party every 250 ms,
  because away and reconnecting change without a roster event. It only
  *sends* on a change. A net.js event replaces the poll in Phase 4.
