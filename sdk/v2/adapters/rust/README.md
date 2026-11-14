# `arcade` — SDK v2 managed games in Rust

Write the rules as an `arcade::Game`; the platform does sync, bots, the
turn-wait banner, results, the end card, rejoin and host handover
(docs/sdk-v2.md, "Managed state (Layer 2)"). You never see JSON or the
protocol. The worked example is
[`../../examples/tic-tac-toe-rust`](../../examples/tic-tac-toe-rust), the
conformance version of `tic-tac-toe-js`.

## The game

`Cargo.toml`:

```toml
[lib]
crate-type = ["cdylib"]

[dependencies]
arcade = { path = "../../adapters/rust" }   # wherever this folder is
serde = { version = "1", default-features = false, features = ["derive", "alloc"] }
serde_json = { version = "1", default-features = false, features = ["alloc"] }

[profile.release]
opt-level = "z"
lto = true
codegen-units = 1
panic = "abort"
strip = true
```

`src/lib.rs`:

```rust
use arcade::{Game, Kind, Outcome, Seat};
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
pub struct Race { at: Vec<(String, u32)>, turn: usize }

#[derive(Serialize, Deserialize)]
pub struct Step { by: u32 }                       // arcade.act({ by: 2 })

impl Game for Race {
    type Action = Step;                          // what the page sends; what bot() returns
    type View = Race;                            // what each phone draws
    type Snapshot = Race;                        // what the heir needs

    fn init(seats: Vec<Seat>, _opts: serde_json::Value, _seed: i64, _match_no: i64) -> Self {
        Race { at: seats.into_iter().map(|s| (s.id, 0)).collect(), turn: 0 }
    }
    fn apply(&mut self, step: Step, by: &str) -> Result<(), String> {
        if self.at[self.turn].0 != by { return Err("not your turn".into()) }
        if !(1..=3).contains(&step.by) { return Err("1 to 3 steps".into()) }
        self.at[self.turn].1 += step.by;
        self.turn = (self.turn + 1) % self.at.len();
        Ok(())
    }
    fn view(&self, _seat: Option<&str>) -> Race { self.clone() }
    fn turn(&self) -> Vec<String> {
        if self.result().is_some() { vec![] } else { vec![self.at[self.turn].0.clone()] }
    }
    fn bot(&self, _seat: &str) -> Option<Step> { Some(Step { by: 2 }) }
    fn result(&self) -> Option<Outcome> {
        let (won, _) = self.at.iter().find(|(_, n)| *n >= 10)?;
        let rest = self.at.iter().filter(|(id, _)| id != won).map(|(id, _)| id.clone());
        Some(Outcome::new(Kind::Ffa, vec![vec![won.clone()], rest.collect()]))
    }
    fn snapshot(&self) -> Race { self.clone() }
    fn restore(snapshot: Race) -> Self { snapshot }
    // Optional: fn skip(&mut self, seat: &str) -> bool   (SKIP TURN; default: cannot)
    //           fn tick(&mut self, inputs, dt)           (manifest "tick"; default: nothing)
}

arcade::export!(Race);
```

`export!` makes the module's one function, a wasm-bindgen
`dispatch(call: &str) -> String`: a `rulesCall` in, its `rulesOut` out
(sdk/v2/protocol.json). It holds the one game in a `thread_local`.

What to know:

- **JSON shape.** The three types are what the page sees. A struct's fields
  come out in declaration order; a `serde_json::Value` object (and `json!`)
  comes out with its keys sorted. `Option::None` is `null`.
- **A move the type cannot read** is refused with `arcade::NOT_A_MOVE`, before
  your `apply` runs. To refuse such moves yourself, make `Action` an untagged
  enum with a catch-all `Other(serde_json::Value)` (the example does, to match
  the reference's refusal order).
- **Don't panic.** With `panic = "abort"` a panic traps the module; that call
  comes back as an error, and every later call says the game panicked.
- **Test natively.** `arcade::dispatch(&RefCell<Option<G>>, json)` is the body
  of the exported function, so `cargo test` drives the game exactly as the
  platform will (see the example's tests).

## The page

`game.json` adds `"runtime": "wasm"`, `"wasm": "pkg/<crate>_bg.wasm"` and
`"state": "managed"`. `index.html` names the glue, then your draw script:

```html
<script src="pkg/<crate>.js"></script>
<script src="game.js"></script>
```

`game.js` starts the rules, then draws each view:

```js
(async () => {
	await arcade.init;                                  // the module's bytes are in it
	wasm_bindgen.initSync({ module: arcade.wasm });
	arcade.managedJson(wasm_bindgen.dispatch);
})();
arcade.on("view", ({ state }) => draw(state));
button.onclick = () => arcade.act({ by: 2 });
```

## Building

```sh
sdk/v2/adapters/rust/build.sh path/to/crate     # → path/to/crate/pkg/
```

Nix only: it takes rustc, cargo, lld and wasm-bindgen-cli from nixpkgs, runs
`cargo build --release --target wasm32-unknown-unknown` and `wasm-bindgen
--target no-modules`, and stops if the CLI's version is not the one in your
`Cargo.lock` (this crate pins `wasm-bindgen = "=0.2.129"`; bump both together).

It also patches the glue. wasm-bindgen's no-modules output runs
`new URL(document.currentScript.src, location.href)` at load, to find its
`.wasm`. The arcade inlines every script into an `about:srcdoc` frame, where
`src` is `""` and that throws. The module comes in `init` instead, so the
patch skips the lookup when `src` is empty.

Commit `pkg/` (the arcade's CI never builds contributor code); gitignore
`target/`.

## Sizes

The example, built 2026-11-14 (rustc 1.99, wasm-bindgen 0.2.129):

| File | Raw | gzip -9 |
|---|---|---|
| `pkg/tic_tac_toe_rust_bg.wasm` | 98.5 KB | 42.1 KB |
| `pkg/tic_tac_toe_rust.js` (glue) | 7.6 KB | 2.1 KB |

Most of the module is serde_json and `core::fmt`, not the game. `wasm-opt -Oz`
(binaryen 133) saves only 6% (95 KB), so the build leaves it out.
