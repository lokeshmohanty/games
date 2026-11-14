// Package arcade writes a managed arcade game (docs/sdk-v2.md "Managed state")
// in Go, compiled to WebAssembly with TinyGo.
//
// A game is a value that satisfies Game. Run hands it to the platform, which
// calls it on the host and sends every phone its view:
//
//	func main() { arcade.Run(newGame, restoreGame) }
//
// The platform's rules protocol (protocol.json rulesCall / rulesOut) is one
// function of JSON strings; this package owns it, so a game never sees JSON
// except the action, inputs and snapshot it chooses to decode.
package arcade

import "errors"

// Seat is one seated player, in party order.
type Seat struct {
	ID   string  `json:"id"`
	Name string  `json:"name"`
	Team *string `json:"team"` // nil: no team
	Bot  bool    `json:"bot"`
}

// Setup is what a new match starts from (the rule `init`).
type Setup struct {
	Seats []Seat
	Opts  RawJSON // the manifest's opts
	Seed  int64   // a random seed
	Match int     // 0, then 1 on the first rematch, ...
}

// Result is how a match ended (docs/sdk.md "Reporting a result").
type Result struct {
	Kind    string             `json:"kind"`    // "duel", "ffa", "teams", "coop" or "local"
	Ranking [][]string         `json:"ranking"` // places: Ranking[0] won; several ids in a place tie
	Scores  map[string]float64 `json:"scores,omitempty"`
}

// Game is one match's state and its rules. Every method runs on the host.
type Game interface {
	// Apply makes a move by the player (or bot) `by`. Return nil to allow it,
	// or Refuse(reason) / any error to refuse it: the error's text is shown
	// to that player.
	Apply(action RawJSON, by string) error
	// View is what `seat` may see; nil is a spectator. It is sent as JSON.
	View(seat *string) any
	// Turn is whose move it is: it drives bots and the turn-wait banner.
	Turn() []string
	// Bot is a bot's move, applied next through Apply; nil for none.
	Bot(seat string) any
	// Result is nil while the match runs.
	Result() *Result
	// Snapshot is the whole state, as JSON, for the heir; the restore
	// function given to Run reads it back.
	Snapshot() any
}

// Skipper is a Game the host may skip past (SKIP TURN on the turn-wait
// banner). Skip returns whether it skipped.
type Skipper interface {
	Skip(seat string) bool
}

// Ticker is a Game with a fixed step (manifest "tick"): inputs holds each
// seat's latest input as JSON, dt the seconds since the last tick.
type Ticker interface {
	Tick(inputs map[string]RawJSON, dt float64)
}

// NewGame starts a match; RestoreGame rebuilds one from what Snapshot
// returned (on the heir, when the host leaves).
type (
	NewGame     func(Setup) Game
	RestoreGame func(snapshot RawJSON) (Game, error)
)

// Refuse is a refused move's reason, for Apply to return.
func Refuse(reason string) error { return errors.New(reason) }
