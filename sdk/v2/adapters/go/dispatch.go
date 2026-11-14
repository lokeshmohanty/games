package arcade

import (
	"errors"
	"strconv"
)

// call is one rulesCall (protocol.json): fn and its arguments.
type call struct {
	Fn       string             `json:"fn"`
	Seats    []Seat             `json:"seats"`
	Opts     RawJSON            `json:"opts"`
	Seed     int64              `json:"seed"`
	Match    int                `json:"match"`
	Action   RawJSON            `json:"action"`
	By       string             `json:"by"`
	Inputs   map[string]RawJSON `json:"inputs"`
	Dt       float64            `json:"dt"`
	Seat     *string            `json:"seat"`
	Snapshot RawJSON            `json:"snapshot"`
}

// value and failure are the two shapes of a rulesOut.
type (
	value struct {
		V any `json:"v"`
	}
	failure struct {
		Err string `json:"err"`
	}
)

// Dispatcher holds the live game and answers rules calls. Run makes one;
// tests may drive one directly.
type Dispatcher struct {
	New     NewGame
	Restore RestoreGame
	game    Game
}

// Dispatch answers one rulesCall, given and returned as JSON: {"v": …} with
// what the rule returned, or {"err": "…"}.
func (d *Dispatcher) Dispatch(in string) string {
	v, err := d.call(in)
	if err != nil {
		return fail(err.Error())
	}
	b, err := Marshal(value{v})
	if err != nil {
		return fail("arcade: the answer is not JSON: " + err.Error())
	}
	return string(b)
}

func (d *Dispatcher) call(in string) (v any, err error) {
	defer func() {
		if r := recover(); r != nil {
			v, err = nil, panicked(r)
		}
	}()
	var c call
	if err := Unmarshal([]byte(in), &c); err != nil {
		return nil, errors.New("arcade: a bad rules call: " + err.Error())
	}
	switch c.Fn {
	case "init":
		d.game = d.New(Setup{Seats: c.Seats, Opts: c.Opts, Seed: c.Seed, Match: c.Match})
		return nil, nil
	case "restore":
		g, err := d.Restore(c.Snapshot)
		if err != nil {
			return nil, err
		}
		d.game = g
		return nil, nil
	}
	g := d.game
	if g == nil {
		return nil, errors.New("arcade: " + strconv.Quote(c.Fn) + " before init")
	}
	switch c.Fn {
	case "apply":
		if err := g.Apply(c.Action, c.By); err != nil {
			return err.Error(), nil // refused: the reason is the value
		}
		return nil, nil
	case "view":
		return g.View(c.Seat), nil
	case "turn":
		t := g.Turn()
		if t == nil {
			t = []string{}
		}
		return t, nil
	case "bot":
		return g.Bot(deref(c.Seat)), nil
	case "result":
		if r := g.Result(); r != nil {
			return r, nil
		}
		return nil, nil
	case "snapshot":
		return g.Snapshot(), nil
	case "skip":
		if s, ok := g.(Skipper); ok {
			return s.Skip(deref(c.Seat)), nil
		}
		return false, nil // the shell says this game cannot skip
	case "tick":
		if t, ok := g.(Ticker); ok {
			t.Tick(c.Inputs, c.Dt)
			return nil, nil
		}
	}
	return nil, errors.New("no rule " + strconv.Quote(c.Fn))
}

// panicked is a recovered panic as an error (fmt is too big for TinyGo).
func panicked(r any) error {
	switch r := r.(type) {
	case error:
		return r
	case string:
		return errors.New(r)
	}
	return errors.New("panic")
}

func fail(msg string) string {
	b, _ := Marshal(failure{msg})
	return string(b)
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
