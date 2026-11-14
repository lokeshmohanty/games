# The game SDK v2: a protocol, so a game can be written in any language

*Built 2026-11-14 on branch `platform-v2` (Phase 2 of the plan of record,
`~/.claude/plans/ethereal-honking-beaver.md`). The protocol, the shell's end
of it (`lib/sdk-host.js`), the frame runtime, WebAssembly, the generated
bindings and two examples (JavaScript, Rust) are built and tested. Still to
come: managed state (Layer 2), adapters for the other languages, porting the
ten games and dropping v1 (Phase 3). v1 ([sdk.md](sdk.md)) keeps working
until then.*

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

The sandbox has not changed (sdk.md, "What changed"): the frame is still
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
  result() { return null | { kind, ranking, scores? } },   // sdk.md "Reporting a result"
  snapshot() { return state },                // for the heir
  restore({ snapshot }) { … },
  skip({ seat }) { … return true },           // optional: the host chose SKIP TURN
  tick({ inputs, dt }) { … },                 // with manifest "tick": a fixed step
});
arcade.on("view", ({ state }) => draw(state));  // every phone, on change only
button.onclick = () => arcade.act({ i: 4 });    // your move; a refusal comes back as "rejected"
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
  on every phone (with `match`), and the shell draws the end card: the
  winner's name, PLAY AGAIN for the host, and SEE THE BOARD. PLAY AGAIN
  calls `init` again with `match + 1`.
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

A managed game may still use Layer 1 channels for ephemeral streams (a
drawing's strokes), and Layer 1 services.

**The HTML/CSS lane.** A managed game can be markup plus its rules, with no
rendering code:

| Attribute | Effect |
|---|---|
| `data-arcade-text="board.3"` | shows that path of the view |
| `data-arcade-show="mine"` | shows the element while the path is truthy |
| `data-arcade-class="o:isO"` | toggles a class |
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
| Managed (Layer 2) | `act {a}` · `input {i}` | `rules {calls}` (request) → `{out}` · `view {state}` · `rejected {a, reason}` |
| Runtimes | `runtime.file {path}` → `{bytes, type}` (Pyodide, for `runtime: "python"`) | |

What the services do, briefly. The long explanations are in the files they
come from, which the shell now runs:

- **Channels.** These work as in v1. A channel is wired as `g:<name>`, so a
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
- **`result`** works as in v1 (sdk.md, "Reporting a result"). Every peer may
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
a warning (sdk.md, "Colours and type").

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
  `wasm_bindgen.initSync({ module: init.wasm })`.
- **Emscripten** with `-sSINGLE_FILE`, or the bytes given to `Module.wasmBinary`.
- **TinyGo**: `wasm_exec.js`, then `WebAssembly.instantiate(init.wasm, go.importObject)`.

Engines are welcome up to the 10 MB cap. Godot and Unity are out (decided
2026-11-14).

The Rust example, `sdk/v2/examples/tic-tac-toe-rust`, keeps its rules, bot
and host authority in Rust, behind one function:

- **Input:** `dispatch(json)` takes a protocol message or a page event
  (`click`, `again`, `wake`, `debug`).
- **Output:** it returns `{ out: [messages to post], view, wake?, answer? }`.
- **The rest:** `glue.js` (59 lines, generic) pumps messages in, posts `out`,
  draws `view` and runs the `wake` timer.

This is the shape Phase 3's adapters will standardise on for every language
that is not JavaScript.

| File | Size |
|---|---|
| `.wasm` | 87 KB (38 KB gzipped), without wasm-opt |
| wasm-bindgen glue | 7.7 KB |

Build it with `./build.sh` (Nix: rustc 1.99, wasm-bindgen-cli 0.2.129). The
built `pkg/` is committed, because CI never builds contributor code.

**A wasm-bindgen pitfall:**
- **What breaks:** the `no-modules` output runs `new URL(document.currentScript.src,
  location.href)`. Inlined into a srcdoc frame, `src` is `""` and the base is
  `about:srcdoc`, so it throws "Invalid URL" at load.
- **The workaround today:** `build.sh` patches that one condition, and fails
  if the generated line ever changes.
- **Later:** the Phase 3 Rust adapter owns the patch.

Learned from building the Rust example (2026-11-14), and carried into
Phase 3:
- `arcade.on("*")` delivers every message (added).
- `arcade.wasm` holds the bytes outside `init` (added), so init can be
  serialised as JSON.
- A catch-all game with no `answer` registered sends its own `reply` (added).
- Still to do: binary `d` should reach a JSON `dispatch` as `{$bin}`, and the
  adapters should standardise `wake`.

## Bindings

`scripts/gen-bindings.mjs` turns protocol.json into types for TypeScript,
Rust (serde), Go and Python, in `sdk/v2/bindings/`. Run `just bindings`
after changing the schema. `just check-bindings`, which is part of
`just test`, fails if the bindings are stale. C has no common JSON library,
so its binding will be JSON strings plus a header, coming with the adapters.

Why JSON Schema: the wire is JSON, and every target language has validators
and code generators for it. Not chosen:

- **WIT / the component model:** browsers cannot load components without a
  `jco` transpile step.
- **A custom IDL:** we would own its code generator forever.

## The manifest

v2 adds these fields to sdk.md's `game.json`:

| Field | |
|---|---|
| `"sdk": 2` | required for v2 |
| `"runtime"` | `"js"` (default) or `"wasm"`. `"python"` arrives with its adapter. |
| `"wasm"` | with `runtime: "wasm"` only: the module's path inside the folder |

A web app (`app`, `kind: "shared"`) stays on `sdk: 1` until Phase 3 moves
its shim to the v2 envelope.

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
- **Known gap, as in v1:** a frame may also navigate itself (`location =
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
- **`just test-devkit`** plays each example (v1, v2 JavaScript, v2 Rust)
  against a bot to the end, through the dev kit, at 390×844. It checks that
  a v2 frame has no v1 runtime in it.

## What is deliberately not here yet

- **Adapters and ports (rest of Phase 3).** The adapters for Rust, C/C++,
  Go, Python, TypeScript/Solid and HTML/CSS, then porting the ten games and
  dropping v1.
- **The roster event.** The shell still compares the party every 250 ms,
  because away and reconnecting change without a roster event. It only
  *sends* on a change. A net.js event replaces the poll in Phase 4.
- **Web apps** stay on v1 for now (see the manifest section above).
