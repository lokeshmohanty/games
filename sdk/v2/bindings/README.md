# SDK v2 bindings

Types for every message in [`../protocol.json`](../protocol.json), the wire
between a game's sandboxed frame and the party shell. **Generated — do not
edit.** Change `protocol.json`, then regenerate:

    node scripts/gen-bindings.mjs        # or: just bindings

`just test` runs `just check-bindings` (`--check`), which fails when any file
here no longer matches the schema.

| File | What it is |
| --- | --- |
| `protocol.ts` | TypeScript: an interface per message, the discriminated unions `ToShell`, `ToFrame`, `Message`, and `TO_SHELL` / `TO_FRAME`. `json` is `unknown`. |
| `protocol.rs` | Rust (serde 1 + serde_json 1): a struct per message, `#[serde(tag = "t")]` enums `ToShell` / `ToFrame` (with an `Unknown` catch-all), and `V2`, which (de)serialises as the integer 2. `json` is `serde_json::Value`. `send` and `result` are `SendMessage` and `ResultMessage`, so that a glob import does not shadow std's prelude. |
| `protocol.go` | Go, `package arcade`: a struct per message with `V` / `T` fields, a `Type…` constant for every `t`, and `DecodeToShell` / `DecodeToFrame`. `json` is `json.RawMessage`. |
| `protocol.py` | Python 3.11+: a `TypedDict` per message (optional fields `NotRequired`), the `Literal` type names, and `TO_SHELL` / `TO_FRAME`. |

`reply` and `member` allow fields the schema does not name. TypeScript gives
them an index signature, Rust an `extra` map (`#[serde(flatten)]`) and Go an
`Extra` map. A Python `TypedDict` cannot say so before 3.13.

A `json` value may hold ArrayBuffers: frame to shell they are transferables,
and between phones they travel as `{ "$bin": <base64> }`. How a non-JavaScript
game sees them is up to its adapter.

C has no bindings here. It will use JSON strings plus a header, which come with
the adapters.
