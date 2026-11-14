# The C / C++ adapter (SDK v2, managed state)

You write a managed game's rules as plain C functions. `arcade.h` turns them into the one function the platform calls, `dispatch(json) -> json` (docs/sdk-v2.md "Managed state", protocol.json `rulesCall` / `rulesOut`). Emscripten compiles them to WebAssembly. Your rules never touch JSON plumbing or the protocol.

| File | What it is |
|---|---|
| `arcade.h` | Header-only, ~800 lines: a strict JSON reader and writer, the `arcade_game` struct and `ARCADE_GAME(...)`. C99 and C++11. |
| `arcade-c.js` | The page glue. It starts the module from `init.wasm` and calls `arcade.managedJson(dispatch)`. |
| `emcc-game.sh` | The build: `emcc-game.sh <out-dir> <sources…> [-- emcc flags]`. It writes `rules.wasm`, `rules.js` (the loader, `ArcadeC`) and a copy of `arcade-c.js`. |

The worked example is `sdk/v2/examples/tic-tac-toe-c`. It follows the same rules as the JavaScript reference, call for call (`node scripts/test-conformance.mjs c`).

## A game

```c
#include "arcade.h"

static int board[9], mover = 1;

static void init(const arcade_setup *s) { memset(board, 0, sizeof board); mover = 1; /* s->seats[i].id, .team … */ }

static const char *apply(arcade_val action, const char *by) {   /* NULL allows; a string refuses */
	int i;
	if (!arcade_int(arcade_get(action, "i"), &i) || i < 0 || i > 8 || board[i]) return "that square is taken";
	board[i] = mover; mover = 3 - mover;
	return NULL;
}

static void view(arcade_out *o, const char *seat) {             /* seat NULL: a spectator */
	arcade_begin_obj(o);
	arcade_key(o, "board"); arcade_begin_arr(o);
	for (int i = 0; i < 9; i++) arcade_put_int(o, board[i]);
	arcade_end(o);
	arcade_end(o);
}
/* turn, bot, result, snapshot, restore, skip, tick: the same way */

ARCADE_GAME(.init = init, .apply = apply, .view = view, .turn = turn, .bot = bot,
            .result = result, .snapshot = snapshot, .restore = restore, .skip = skip)
```

### The rules

These are the fields of `arcade_game`, in order. Leave out any you don't need:

| Field | Signature | Returns |
|---|---|---|
| `init` | `void (const arcade_setup *)` | `seats` (`id`, `name`, `team` or NULL, `bot`), `nseats`, `opts`, `seed`, `match` |
| `apply` | `const char *(arcade_val action, const char *by)` | NULL allows the move; a string refuses it, and is the reason shown |
| `view` | `void (arcade_out *, const char *seat)` | what this seat may see |
| `turn` | `void (arcade_out *)` | an array of ids |
| `bot` | `void (arcade_out *, const char *seat)` | an action, or nothing (null: no move) |
| `result` | `void (arcade_out *)` | nothing while the game runs, then `{kind, ranking, scores?}` |
| `snapshot` / `restore` | `void (arcade_out *)` / `void (arcade_val)` | everything the heir needs |
| `skip` | `int (const char *seat)` | 1 if it skipped. Left out, it answers false ("cannot skip"). |
| `tick` | `void (arcade_val inputs, double dt)` | for a game with manifest `"tick"` |

Writing nothing is null. A rule can fail with `arcade_fail("message")`, which answers `{"err": …}`, since C has no throw. A rule you leave out answers `no rule "x"`, as in JavaScript. A rule you leave out costs nothing in the module: the compiler drops its branch.

**C++.** `ARCADE_GAME`'s designated initialisers need C++20, in field order; `-Wextra` warns about the fields you leave out. Before C++20, fill an `arcade_game` yourself and write `ARCADE_DISPATCH(game)`. The header is wrapped in `extern "C"`.

### Reading and writing JSON

**Reading.** An `arcade_val` is a read-only view into the parsed call. Asking for something that is not there gives a value of type `ARCADE_MISSING`, and every accessor then returns its fallback. Nothing crashes.

- `arcade_get(obj, "key")`, `arcade_at(arr, i)` (on an object, its i-th value), `arcade_key_at(obj, i)`, `arcade_len`, `arcade_type`
- `arcade_int(v, &i)` and `arcade_int64`: true only when the number's exact decimal value is an integer that fits (`4`, `4.0` and `40e-1` count; `4.5` and `"4"` don't)
- `arcade_num(v, otherwise)`, `arcade_bool(v, otherwise)`
- `arcade_str(v, buf, cap)`: copies, always NUL-terminated, cut at a whole character. It returns the full length, or -1 if `v` is not a string.
- `arcade_strdup(v)` (malloc'd), `arcade_str_is(v, "pX")`, `arcade_dup(s)`

**Writing.**
- `arcade_begin_obj` / `arcade_begin_arr` / `arcade_end`, and `arcade_key(o, "k")` before each member
- `arcade_put_null` / `_bool` / `_int` / `_num` / `_str` (NULL writes null) / `_strn` / `_val` (copies a value read from the call)
- If what a rule writes is not exactly one well-formed value, the call answers `{"err": …}`.

**Limits.** Nesting is at most `ARCADE_MAX_DEPTH` (64) levels, both reading and writing. Input is strict RFC 8259 JSON, and the parser never reads past its input. A call that is not JSON is answered `{"err":"dispatch: the call is not JSON"}`. A fuzz run of 4,000 mutated calls under ASan and UBSan gave no faults, and the parser accepted and refused the same inputs as JSON.parse, except deeper nesting.

### Memory

- **What your rules are given** (strings, `arcade_val`s, the setup) lives only until the rule returns. Copy what you keep, with `arcade_dup` or `arcade_strdup`.
- **What `dispatch()` returns** belongs to `arcade.h`, and stays valid until the next `dispatch()`. The caller reads it and does not free it.
- **What the caller passes in** belongs to the caller. `arcade-c.js` mallocs it in the module, calls `dispatch`, and frees it.
- **One file.** `arcade_fail` uses state that is private to each file. Call it from the file that holds `ARCADE_GAME`, or pass errors back to that file.

## The page

```html
<script src="pkg/rules.js"></script>      <!-- the module's loader (ArcadeC) -->
<script src="pkg/arcade-c.js"></script>   <!-- this adapter's glue, vendored by the build -->
<script src="draw.js"></script>           <!-- arcade.on("view", …) and arcade.act({...}) -->
```

The manifest needs `"state": "managed"`, `"runtime": "wasm"` and `"wasm": "pkg/rules.wasm"`.

## Building

```sh
sdk/v2/adapters/c/emcc-game.sh pkg game.c          # in the game's folder; or the example's ./build.sh
```

- **Emscripten** comes from `nix shell nixpkgs#emscripten`, 6.0.9 when this was written. Its warning that binaryen is 133 rather than 132 is silenced, and harmless.
- **The cache.** The first build compiles Emscripten's libc into `$EM_CACHE` (default `~/.cache/arcade-emscripten`), which takes about 40 s.
- **Why the flags.** The comment at the top of `emcc-game.sh` explains each one. In short: one classic modularised script; the module comes as bytes from `init` rather than fetched; no eval; no filesystem; emmalloc; `-Oz` with closure; 1 MB of starting memory.
- **The loader check.** The arcade inlines scripts into a srcdoc frame, where import, `import.meta` and the script's own URL do not exist. Emscripten 6.0.9 needs no patch for this. The script fails if a later version emits `import`/`import.meta`, or reads its own URL outside a `try`.

## Sizes (the example)

| What ships | Raw | gzip |
|---|---|---|
| `rules.wasm` (JSON reader and writer, malloc, the rules) | 12.7 KB | 6.3 KB |
| `rules.js` (Emscripten loader, closure) | 2.6 KB | 1.3 KB |
| `arcade-c.js` | 1.4 KB | 0.8 KB |

`validate-game.mjs` gives one warning: `rules.js` contains `fetch()`. That is the loader's fallback for when no bytes are given, and it is never taken here.
