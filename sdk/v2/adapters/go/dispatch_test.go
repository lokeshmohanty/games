package arcade

import "testing"

// counter is the smallest Game: one shared number, anyone may add to it.
type counter struct {
	N     int    `json:"n"`
	First string `json:"first"`
}

func (c *counter) Apply(a RawJSON, by string) error {
	var m struct{ Add int }
	if err := Unmarshal(a, &m); err != nil || m.Add <= 0 {
		return Refuse("add a positive number")
	}
	if m.Add == 13 {
		panic("unlucky")
	}
	c.N += m.Add
	return nil
}
func (c *counter) View(seat *string) any { return map[string]any{"n": c.N, "spectator": seat == nil} }
func (c *counter) Turn() []string        { return nil }
func (c *counter) Bot(string) any        { return nil }
func (c *counter) Result() *Result {
	if c.N < 10 {
		return nil
	}
	return &Result{Kind: "coop", Ranking: [][]string{{c.First}}}
}
func (c *counter) Snapshot() any { return c }

func TestDispatch(t *testing.T) {
	d := &Dispatcher{
		New: func(s Setup) Game { return &counter{First: s.Seats[0].ID} },
		Restore: func(snap RawJSON) (Game, error) {
			c := &counter{}
			return c, Unmarshal(snap, c)
		},
	}
	steps := [][2]string{
		{`{"fn":"view","seat":null}`, `{"err":"arcade: \"view\" before init"}`},
		{`{"fn":"init","seats":[{"id":"a","name":"A","team":null,"bot":false}],"opts":{},"seed":1,"match":0}`, `{"v":null}`},
		{`{"fn":"apply","action":{"add":4},"by":"a"}`, `{"v":null}`},
		{`{"fn":"apply","action":{"add":-1},"by":"a"}`, `{"v":"add a positive number"}`},
		{`{"fn":"apply","action":{"add":13},"by":"a"}`, `{"err":"unlucky"}`},
		{`{"fn":"view","seat":"a"}`, `{"v":{"n":4,"spectator":false}}`},
		{`{"fn":"view","seat":null}`, `{"v":{"n":4,"spectator":true}}`},
		{`{"fn":"turn"}`, `{"v":[]}`},
		{`{"fn":"bot","seat":"a"}`, `{"v":null}`},
		{`{"fn":"skip","seat":"a"}`, `{"v":false}`},
		{`{"fn":"tick","inputs":{},"dt":0.1}`, `{"err":"no rule \"tick\""}`},
		{`{"fn":"snapshot"}`, `{"v":{"n":4,"first":"a"}}`},
		{`{"fn":"restore","snapshot":{"n":9,"first":"b"}}`, `{"v":null}`},
		{`{"fn":"result"}`, `{"v":null}`},
		{`{"fn":"apply","action":{"add":1},"by":"a"}`, `{"v":null}`},
		{`{"fn":"result"}`, `{"v":{"kind":"coop","ranking":[["b"]]}}`},
		{`{"fn":"nope"}`, `{"err":"no rule \"nope\""}`},
	}
	for _, s := range steps {
		if got := d.Dispatch(s[0]); got != s[1] {
			t.Errorf("Dispatch(%s)\n got %s\nwant %s", s[0], got, s[1])
		}
	}
}
