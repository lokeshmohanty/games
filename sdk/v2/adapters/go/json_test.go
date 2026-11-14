package arcade

import (
	"encoding/json"
	"reflect"
	"testing"
)

type inner struct {
	Board [3]int  `json:"board"`
	Who   *string `json:"who"`
}

type outer struct {
	inner
	You    int            `json:"you"`
	Skip   string         `json:"-"`
	Maybe  []int          `json:"maybe,omitempty"`
	Tags   map[string]int `json:"tags"`
	Any    any            `json:"any"`
	Raw    RawJSON        `json:"raw"`
	Plain  string
	hidden int
}

// The codec must agree with encoding/json on everything a game sends.
func TestMarshalMatchesEncodingJSON(t *testing.T) {
	who := "pX"
	cases := []any{
		nil, true, 0, -12, 3.5, 1e21, 1e-7, 0.1, "", "a\"b\\c\n\t\x01é😀",
		[]int(nil), []int{}, []string{"a"}, [2]bool{true},
		map[string]int{"b": 2, "a": 1}, map[int]string{2: "x", 10: "y"},
		outer{inner: inner{Board: [3]int{1, 0, 2}, Who: &who}, You: 1, Tags: map[string]int{"z": 1}, Any: []any{1.0, "s", nil}, Raw: RawJSON(`{"k":[1]}`), Plain: "p"},
		outer{},
		&Result{Kind: "duel", Ranking: [][]string{{"a", "b"}}},
		map[string]any{"i": 4},
	}
	for _, c := range cases {
		got, err := Marshal(c)
		if err != nil {
			t.Fatalf("Marshal(%#v): %v", c, err)
		}
		want, _ := json.Marshal(c)
		if string(got) != string(want) {
			t.Errorf("Marshal(%#v)\n got %s\nwant %s", c, got, want)
		}
	}
}

func TestUnmarshalMatchesEncodingJSON(t *testing.T) {
	docs := []string{
		`{"board":[1,2,0],"who":"pX","you":2,"maybe":[1,2],"tags":{"a":1},"any":{"x":[1,"two",null,true]},"raw":{"k" : [1, 2]},"Plain":"p","extra":{"deep":[{}]}}`,
		`{"board":[1],"who":null,"plain":"case-folded","any":null}`,
		`{"board":[1,2,3,4],"any":"é😀\n\"\\\/"}`,
		` { } `,
	}
	for _, doc := range docs {
		var got, want outer
		if err := Unmarshal([]byte(doc), &got); err != nil {
			t.Fatalf("Unmarshal(%s): %v", doc, err)
		}
		if err := json.Unmarshal([]byte(doc), &want); err != nil {
			t.Fatal(err)
		}
		// encoding/json keeps RawMessage bytes as written; compare them apart.
		gotRaw, wantRaw := got.Raw, want.Raw
		got.Raw, want.Raw = nil, nil
		if !reflect.DeepEqual(got, want) {
			t.Errorf("Unmarshal(%s)\n got %#v\nwant %#v", doc, got, want)
		}
		if string(gotRaw) != string(wantRaw) {
			t.Errorf("raw: got %s want %s", gotRaw, wantRaw)
		}
	}
}

func TestUnmarshalRejectsBadJSON(t *testing.T) {
	for _, doc := range []string{``, `{`, `{"a":}`, `[1,]`, `nul`, `{"board":[1 2]}`, `"\x01"`, `01`, `{} x`, `{"you":"1"}`, `{"you":1.5}`} {
		var v outer
		if err := Unmarshal([]byte(doc), &v); err == nil {
			t.Errorf("Unmarshal(%q) accepted it", doc)
		}
	}
}
