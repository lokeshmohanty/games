# The TypeScript adapter (SDK v2, managed state)

Write a managed game's rules as typed functions over your own state, and its
view in Solid (or anything else). The platform runs the rules on the host's
phone and does everything else: views, bots, the turn-wait banner, results,
the end card, the heir. docs/sdk-v2.md "Managed state" says what each rule
means. The example is `sdk/v2/examples/tic-tac-toe-ts`. It passes the
conformance test against the JavaScript reference.

TypeScript compiles to JavaScript, so there is no `dispatch` and no JSON
plumbing: the adapter hands your rules to `arcade.managed` directly, and the
game ships as one plain script (manifest: no `runtime`, no `wasm`).

| File | What it is |
|---|---|
| `arcade.ts` | `defineGame<State, Action, View>(rules)`, the `Rules` interface, and `arcade`: `window.arcade` typed from the generated bindings. |
| `solid.ts` | `createView<View>()`: this phone's view as a Solid signal. Needs `solid-js`. |

## A game

`src/rules.ts`:

```ts
import { defineGame, type MemberId } from "../../../adapters/ts/arcade";

interface State { ids: MemberId[]; heads: boolean | null }
interface Flip { heads: boolean }
export interface View { heads: boolean | null }

export const game = defineGame<State, Flip, View>({
  init: ({ seats }) => ({ ids: seats.map((p) => p.id), heads: null }),
  apply(s, action, by) {                    // nothing allows the move; a string refuses it
    if (s.heads !== null) return "the game is over";
    if (by !== s.ids[0]) return "not your turn";
    s.heads = action?.heads === true;       // action is Untrusted<Flip>: every field unknown
  },
  view: (s, seat) => ({ heads: s.heads }),  // seat null = a spectator
  turn: (s) => (s.heads === null ? [s.ids[0]!] : []),
  bot: () => ({ heads: true }),
  result(s) {
    if (s.heads === null) return null;
    const [a, b] = s.ids as [MemberId, MemberId];
    return { kind: "duel", ranking: s.heads ? [[a], [b]] : [[b], [a]] };
  },
});
```

`src/main.tsx`:

```tsx
import { render } from "solid-js/web";
import { arcade } from "../../../adapters/ts/arcade";
import { createView } from "../../../adapters/ts/solid";
import { game, type View } from "./rules";

function Coin() {
  const view = createView<View>();          // null until the first view
  return <button onClick={() => game.act({ heads: true })}>{String(view()?.heads ?? "flip")}</button>;
}
render(() => <Coin />, document.getElementById("app")!);
arcade.on("rejected", (m) => arcade.toast(m.reason, "warn"));
arcade.debug = () => arcade.view;           // for the tests
```

How the rules are shaped:
- **The adapter keeps the state.** `init` returns it; every other rule gets
  it first. `apply`, `skip` and `tick` change it in place.
- **Moves arrive untrusted.** `apply` sees `Untrusted<Action>`: each field of
  `Action` is `unknown` until you check it, and the whole may be missing. So
  the compiler makes you validate what another phone sent.
- **Optional rules:**
  - `skip(s, seat)`: the host chose SKIP TURN. Return true if it skipped.
    Without it, the game says it cannot skip.
  - `tick(s, inputs, dt)`: for `"tick"` in game.json. Send input with
    `game.input(a)`.
  - `snapshot(s)` / `restore(snapshot)`: the handover to the heir. By default
    the state itself is the snapshot, so keep it JSON (no Map, Set or class
    instances), or give both.
- **Views are JSON**, and key order is what the phones see.
- **The view.** It arrives on every phone, only when it changed. Read it with
  `createView` or `arcade.on("view", (m) => …)`.
- **Moves.** Send them with `game.act(a)`, which is typed by `Action`.

`arcade` is the whole runtime, typed: `arcade.on("roster", (m) => m.party)`,
`arcade.request("ask", { text })` and so on, checked against protocol.json's
messages.

## The protocol types: one source

`arcade.ts` imports its types from `../../bindings/protocol.ts`, which
`scripts/gen-bindings.mjs` generates from protocol.json. These are type-only
imports, erased by the build, so nothing of the bindings ships and there is
no copy to keep in sync. A game outside this repo copies `arcade.ts`,
`solid.ts` and `bindings/protocol.ts`, and fixes the one import path.

## Building

The page names one classic script. The shell inlines it into an offline,
opaque frame, so the build must be a single IIFE: no `type=module`, no
`import()`, no modulepreload. The example's setup:

- **`package.json`.** Pinned exact: `solid-js` 1.9.18, `vite` 8.3.5,
  `vite-plugin-solid` 2.11.15 and `typescript` 7.0.2. Lock:
  `package-lock.json`. `node_modules/` is gitignored, in the example folder
  only: the repo root has no package.json by design.
- **`vite.config.ts`.** Library mode, `formats: ["iife"]`, one file,
  `dist/tic-tac-toe.js`.
  - `resolve.dedupe: ["solid-js"]` lets this adapter's `import "solid-js"`
    resolve from the example's node_modules.
  - Vite 8 minifies with Oxc.
- **`tsconfig.json`.** Strict, with `noUncheckedIndexedAccess`.
  - It includes `../../adapters/ts`.
  - `paths` points `solid-js` at the example's node_modules, for the same
    reason as `dedupe`.
- **`build.sh`.** Runs `npm ci`, `tsc --noEmit`, then `vite build`, with Node
  from `nix shell nixpkgs#nodejs_24`. Two runs give byte-identical output.

`dist/tic-tac-toe.js` is committed, because the arcade's CI never builds
contributor code.

## Sizes (tic-tac-toe-ts, 2026-11-14)

| What ships | Raw | gzip -9 |
|---|---|---|
| `dist/tic-tac-toe.js` (Solid's runtime + adapter + rules + view) | 13.8 KB | 5.7 KB |
| `tic-tac-toe.css` | 1.1 KB | — |

Most of the script is Solid's runtime. The rules and the adapter add about
2 KB minified.
