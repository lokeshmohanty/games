// Tic Tac Toe — SDK v2 managed state, in Go (TinyGo to WebAssembly).
//
// The same rules as ../tic-tac-toe-js, the conformance reference: the same
// views, refusals, bot and result for the same moves
// (scripts/test-conformance.mjs). The platform does the rest; the drawing is
// tic-tac-toe.js. Build with ./build.sh.
package main

import arcade "github.com/lokeshmohanty/games/sdk/v2/adapters/go"

var lines = [8][3]int{{0, 1, 2}, {3, 4, 5}, {6, 7, 8}, {0, 3, 6}, {1, 4, 7}, {2, 5, 8}, {0, 4, 8}, {2, 4, 6}}

// winnerOf is the winning mark, 0 for a draw, or nil while the game goes on.
func winnerOf(b [9]int) *int {
	for _, l := range lines {
		if m := b[l[0]]; m != 0 && m == b[l[1]] && m == b[l[2]] {
			return &m
		}
	}
	for _, m := range b {
		if m == 0 {
			return nil
		}
	}
	draw := 0
	return &draw
}

// game is the whole state: also the snapshot, and the view minus "you".
type game struct {
	Board  [9]int  `json:"board"`
	Mover  int     `json:"turn"`   // the mark to move: 1 (X) or 2 (O)
	Winner *int    `json:"winner"` // nil: still going; 0: a draw
	X      *string `json:"x"`
	O      *string `json:"o"`
}

type view struct {
	game
	You int `json:"you"` // this seat's mark; 0 for a spectator
}

type move struct {
	I any `json:"i"`
}

func newGame(s arcade.Setup) arcade.Game {
	team := func(t string, i int) *string {
		for _, p := range s.Seats {
			if p.Team != nil && *p.Team == t {
				return &p.ID
			}
		}
		if i < len(s.Seats) {
			return &s.Seats[i].ID
		}
		return nil
	}
	return &game{Mover: 1, X: team("A", 0), O: team("B", 1)}
}

func restoreGame(snapshot arcade.RawJSON) (arcade.Game, error) {
	g := &game{}
	return g, arcade.Unmarshal(snapshot, g)
}

func (g *game) markOf(id string) int {
	switch {
	case g.X != nil && id == *g.X:
		return 1
	case g.O != nil && id == *g.O:
		return 2
	}
	return 0
}

func (g *game) idOf(mark int) *string {
	if mark == 1 {
		return g.X
	}
	return g.O
}

func (g *game) Apply(action arcade.RawJSON, by string) error {
	if g.Winner != nil {
		return arcade.Refuse("the game is over")
	}
	if g.markOf(by) != g.Mover {
		return arcade.Refuse("not your turn")
	}
	var m move
	arcade.Unmarshal(action, &m) // anything else is no square at all
	f, ok := m.I.(float64)
	i := int(f)
	if !ok || float64(i) != f || i < 0 || i > 8 || g.Board[i] != 0 {
		return arcade.Refuse("that square is taken")
	}
	g.Board[i] = g.Mover
	g.Mover = 3 - g.Mover
	g.Winner = winnerOf(g.Board)
	return nil
}

func (g *game) View(seat *string) any {
	v := view{game: *g}
	if seat != nil && *seat != "" {
		v.You = g.markOf(*seat)
	}
	return v
}

func (g *game) Turn() []string {
	if g.Winner != nil {
		return nil
	}
	if id := g.idOf(g.Mover); id != nil {
		return []string{*id}
	}
	return nil
}

// Bot wins if it can, blocks if it must, else takes the centre, else the
// first free square.
func (g *game) Bot(string) any {
	var free []int
	for i, m := range g.Board {
		if m == 0 {
			free = append(free, i)
		}
	}
	wins := func(mark int) int {
		for _, i := range free {
			b := g.Board
			b[i] = mark
			if w := winnerOf(b); w != nil && *w == mark {
				return i
			}
		}
		return -1
	}
	i := wins(g.Mover)
	if i < 0 {
		i = wins(3 - g.Mover)
	}
	if i < 0 && g.Board[4] == 0 {
		i = 4
	}
	if i < 0 && len(free) > 0 {
		i = free[0]
	}
	if i < 0 {
		return nil
	}
	return map[string]int{"i": i}
}

func (g *game) Result() *arcade.Result {
	if g.Winner == nil {
		return nil
	}
	if *g.Winner == 0 {
		return &arcade.Result{Kind: "duel", Ranking: [][]string{{deref(g.X), deref(g.O)}}}
	}
	w := *g.Winner
	return &arcade.Result{Kind: "duel", Ranking: [][]string{{deref(g.idOf(w))}, {deref(g.idOf(3 - w))}}}
}

func (g *game) Skip(string) bool {
	g.Mover = 3 - g.Mover
	return true
}

func (g *game) Snapshot() any { return g }

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func main() { arcade.Run(newGame, restoreGame) }
