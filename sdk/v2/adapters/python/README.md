# The Python adapter (SDK v2, managed state)

Write a managed game's rules as a Python class. The platform runs them in
Pyodide (CPython 3.14 in WebAssembly) on the host's phone and does everything
else: views, bots, the turn-wait banner, results, the end card, the heir.
docs/sdk-v2.md "Managed state" says what each rule means. The example is
`sdk/v2/examples/tic-tac-toe-python`. It passes the conformance test against
the JavaScript reference.

| File | What it is |
|---|---|
| `arcade.py` | The module your game imports: `arcade.Game`, `arcade.Seat`, `arcade.run`. Turns the platform's calls into method calls. |
| `arcade-python.js` | The boot script, named in your `index.html`. Loads Pyodide from the shell, runs your Python, and passes the adapter's `dispatch` to `arcade.managedJson`. |

## A game

`game.py`:

```python
import arcade

class Coin(arcade.Game):
    def __init__(self, seats, opts, seed, match):    # seats: [arcade.Seat(id, name, team, bot)]
        self.ids = [s.id for s in seats]
        self.heads = None

    def apply(self, action, by):                     # None allows the move; a str refuses it
        if self.heads is not None:
            return "the game is over"
        self.heads = bool(action.get("heads")) if isinstance(action, dict) else False
        return None

    def view(self, seat):                            # what this seat sees; seat None = a spectator
        return {"heads": self.heads}

    def turn(self):                                  # whose move it is: drives bots and the banner
        return [self.ids[0]] if self.heads is None else []

    def bot(self, seat):                             # a bot's move, or None
        return {"heads": True}

    def result(self):                                # None while playing
        if self.heads is None:
            return None
        a, b = self.ids
        return {"kind": "duel", "ranking": [[a], [b]] if self.heads else [[b], [a]]}

arcade.run(Coin)
```

These are optional:
- **`skip(self, seat)`**: the host chose SKIP TURN. Return `True`, or nothing,
  to say it was done. Without it, the game says it cannot skip.
- **`tick(self, inputs, dt)`**: for `"tick"` in game.json.
- **`snapshot(self)` and `@classmethod restore(cls, snapshot)`**: handover to
  the heir. The defaults copy the instance's attributes out and back. A
  `Seat` you keep comes back as a dict, so keep ids instead, or override both.

What a rule returns must be JSON: dicts, lists, str, int, float, bool, None.
Dataclasses become dicts. **Dict order is kept.** The platform sees keys in
the order you built them.

An exception in a rule is not fatal. It becomes that call's error, and the
game keeps running.

`index.html` names the boot script and your draw code. Rendering is ordinary
DOM or canvas code in JavaScript, drawing from `arcade.on("view", …)`. Your
Python files are listed in a meta tag, and the first is run. Without the tag,
the boot script runs `game.py`.

```html
<meta name="arcade-python" content="game.py helpers.py" />
…
<script src="arcade-python.js"></script>
<script src="draw.js"></script>
```

game.json: `"sdk": 2, "state": "managed", "runtime": "python"`.

## Testing without the arcade

`python3 game.py` (where `arcade.py` sits beside it) plays the game's bots
against each other through the same `dispatch` and prints the result.
`arcade.run` does that whenever it is not inside Pyodide.

## Building

There is nothing to compile. The shell inlines only scripts inside the game's
folder, so `arcade.py` and `arcade-python.js` are copied into it:

```sh
sdk/v2/examples/tic-tac-toe-python/build.sh   # copy the adapter in, then run the bots under CPython 3.14 (nix)
```

The copies are committed, like every built output.

## How it boots

1. The frame can fetch nothing, so the boot script asks the shell for
   Pyodide's four files with `runtime.file`. The asks go out at once, in
   parallel. It asks for your `.py` files with `asset`.
2. Pyodide's two ES modules run as injected inline module scripts. Their
   exports become callbacks, as in `lib/py-server.js`.
3. While `loadPyodide` runs, `fetch` is replaced by one that answers from
   those files. It is put back afterwards.
4. Only the core boots. No package and no micropip, so nothing more is asked
   for.
5. The `.py` files go into `/home/pyodide/game/`, and the main one runs as
   `__main__`.
6. `dispatch` goes to `arcade.managedJson`, which says `ready`.
7. `arcade.python` holds `{ pyodide, ms }` afterwards, for debugging.

## Sizes

The game's folder: 17.3 KB raw, 6.6 KB gzipped (adapter 10.8 KB raw,
4.5 KB gzipped).

Pyodide is the platform's runtime, not the game's. It sits outside the 10 MB
cap, and a game asks for it as `runtime.file`:

| File | Raw | Gzipped |
|---|---|---|
| `pyodide.asm.wasm` | 9.2 MB | 3.4 MB |
| `python_stdlib.zip` | 2.4 MB | 2.4 MB |
| `pyodide.asm.mjs` | 1.2 MB | 255 KB |
| `pyodide.mjs` | 18 KB | 7 KB |
| **Total** | **12.8 MB** | |

## Boot time

Measured on a desktop with Chrome, 2026-11-14:
- **Conformance harness**, from `hello` to `ready`: about 2.0 s. A cold
  browser context and a warm HTTP cache measure the same, because compiling
  the WebAssembly dominates.
- **Real party**, from START GAME to the first view: 5.3 s on the first mount
  of a fresh context.

Phones will be slower. `STARTING PYTHON…` shows in the HUD until the first
view.
