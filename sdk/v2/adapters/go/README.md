# Go adapter: a managed arcade game in Go

Package `arcade` lets you write a managed SDK v2 game in Go (see "Managed state"
in docs/sdk-v2.md). You write the rules as a Go type. TinyGo compiles them to
WebAssembly, and the platform runs them on the host. The platform also handles
views, bots, turn-wait, results, rematches and handover. The JSON protocol
(protocol.json `rulesCall` / `rulesOut`) stays inside this package.

The worked example, and the conformance lane, is `sdk/v2/examples/tic-tac-toe-go`.

## The minimal game

```go
package main

import arcade "github.com/lokeshmohanty/games/sdk/v2/adapters/go"

type game struct {
	N    int    `json:"n"`
	Host string `json:"host"`
}

func newGame(s arcade.Setup) arcade.Game { return &game{Host: s.Seats[0].ID} }

func restoreGame(snap arcade.RawJSON) (arcade.Game, error) {
	g := &game{}
	return g, arcade.Unmarshal(snap, g)
}

func (g *game) Apply(action arcade.RawJSON, by string) error {
	var a struct{ Add int }
	if arcade.Unmarshal(action, &a) != nil || a.Add <= 0 {
		return arcade.Refuse("add a positive number") // shown to that player
	}
	g.N += a.Add
	return nil // allowed
}
func (g *game) View(seat *string) any    { return g } // seat nil: a spectator
func (g *game) Turn() []string           { return nil }
func (g *game) Bot(seat string) any      { return map[string]int{"add": 1} } // nil: no move
func (g *game) Result() *arcade.Result {
	if g.N < 10 {
		return nil
	}
	return &arcade.Result{Kind: "coop", Ranking: [][]string{{g.Host}}}
}
func (g *game) Snapshot() any { return g }

func main() { arcade.Run(newGame, restoreGame) }
```

Optional interfaces:
- `Skip(seat string) bool` (`arcade.Skipper`): the host's SKIP TURN. Without it, the shell says the game cannot skip.
- `Tick(inputs map[string]arcade.RawJSON, dt float64)` (`arcade.Ticker`): needed with manifest `"tick"`.

Rules for the Go side:
- **Use `arcade.Marshal` / `arcade.Unmarshal` / `arcade.RawJSON`, not `encoding/json`.** Under TinyGo, `encoding/json` adds about 1 MB of WebAssembly. This package's codec adds a few tens of KB. It reads the same `json:"name,omitempty"` / `json:"-"` tags, so your types work with both. It differs from `encoding/json` in three ways: a `[]byte` is written as an array of numbers, not base64; there is no `,string` option; and when two embedded structs have a field with the same name, the first one wins. `RawJSON` also works with `encoding/json`.
- **No goroutines, channels or `time.Sleep`.** The module builds with `-scheduler=none`, because every rule is a plain synchronous call.
- **Do not panic.** TinyGo cannot recover a panic in WebAssembly, so a panic traps. `arcade-go.js` reports it as that call's `err`, with a console error, but the Go side may not be sound afterwards. Return an error from `Apply` instead. `go test` and native `go run` do recover, so a panic there shows up as `{"err": …}`.
- **Avoid `fmt`.** It costs about 125 KB under TinyGo; use `strconv` and `errors`.

## The page

```
index.html        <script src="wasm_exec.js">, <script src="arcade-go.js">, then your draw script
wasm_exec.js      TinyGo's, vendored by build.sh from the same TinyGo that built the module
arcade-go.js      this folder's glue, vendored by build.sh
game.wasm         "runtime": "wasm", "wasm": "game.wasm", "state": "managed" in game.json
```

The draw script is ordinary JavaScript. It uses `arcade.on("view", ({ state }) => …)` to draw and `arcade.act(move)` to send a move. `arcade-go.js` instantiates the module from the bytes in `init` (the frame cannot fetch anything), runs `main`, and calls `arcade.managedJson(dispatch)`, which also says `ready`.

How the bridge works: each call's JSON goes through the module's linear memory. The module exports three functions: `arcade_in(n)` returns room for the call, `arcade_dispatch(n)` answers into a buffer and returns its length, and `arcade_out()` returns that buffer's address. There is no `syscall/js`, because `js.FuncOf` needs the asyncify scheduler, and asyncify doubles the module's size (273 KB vs 136 KB here).

## Build

```sh
nix shell nixpkgs#tinygo -c tinygo build -o game.wasm -target wasm -scheduler=none -no-debug .
```

`build.sh` in the example runs this, then vendors `wasm_exec.js` and `arcade-go.js`. It was checked with TinyGo 0.43.0 (Go 1.27.3, LLVM 22), and its output is byte-for-byte reproducible. Commit the outputs: the arcade's CI never builds contributor code.

Try the rules natively. Off the browser, `Run` reads one rulesCall per stdin line:

```sh
echo '{"fn":"init","seats":[{"id":"a","name":"A","bot":false}]}' | go run .
go test ./...          # in this folder: the codec against encoding/json, and Dispatch
```

## Sizes (tic-tac-toe-go, 2026-11-14)

| File | Raw | gzip -9 |
|---|---|---|
| tic-tac-toe.wasm | 135,730 B | 64,869 B |
| wasm_exec.js | 17,729 B | 4,868 B |
| arcade-go.js | 1,457 B | 762 B |

For comparison, the same game built other ways:

| Build | Raw | gzip -9 |
|---|---|---|
| encoding/json + fmt, asyncify | 1,071,499 B | 385,988 B |
| this codec, asyncify (`js.FuncOf`) | 273,629 B | 100,838 B |
| this codec, `-scheduler=none` | 135,730 B | 64,869 B |
| `wasm-opt -Oz` on top (not used) | 118,210 B | 61,797 B |
