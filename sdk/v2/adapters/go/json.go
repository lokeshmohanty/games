package arcade

// A small JSON codec, because encoding/json costs about 1 MB of WebAssembly
// under TinyGo and this costs a few tens of KB. It reads and writes the same
// `json:"name,omitempty"` / `json:"-"` struct tags as encoding/json, so the
// game's types work with either. What it does not do: base64 for []byte (a
// []byte is an array of numbers), the ",string" option, or encoding/json's
// rules for two embedded structs that share a field name (the first wins).

import (
	"errors"
	"math"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// RawJSON is a JSON value left undecoded: an action, an input, a snapshot or
// the manifest's opts. Decode it with Unmarshal; Marshal writes it as is.
type RawJSON []byte

// Marshaler and Unmarshaler let a type write and read its own JSON; they are
// encoding/json's interfaces of the same names.
type (
	Marshaler   interface{ MarshalJSON() ([]byte, error) }
	Unmarshaler interface{ UnmarshalJSON([]byte) error }
)

var rawType = reflect.TypeOf(RawJSON(nil))

// MarshalJSON and UnmarshalJSON make RawJSON work with encoding/json too, as
// json.RawMessage does.
func (r RawJSON) MarshalJSON() ([]byte, error) {
	if len(r) == 0 {
		return []byte("null"), nil
	}
	return r, nil
}

func (r *RawJSON) UnmarshalJSON(b []byte) error {
	*r = append((*r)[:0], b...)
	return nil
}

// Marshal writes v as JSON.
func Marshal(v any) ([]byte, error) {
	var e encoder
	if err := e.value(reflect.ValueOf(v)); err != nil {
		return nil, err
	}
	return e.b, nil
}

// Unmarshal reads JSON into what v points to.
func Unmarshal(data []byte, v any) error {
	rv := reflect.ValueOf(v)
	if rv.Kind() != reflect.Pointer || rv.IsNil() {
		return errors.New("arcade.Unmarshal: needs a non-nil pointer")
	}
	d := decoder{b: data}
	d.space()
	if err := d.value(rv.Elem()); err != nil {
		return err
	}
	if d.space(); d.i < len(d.b) {
		return d.fail("unexpected data after the value")
	}
	return nil
}

// -- writing -----------------------------------------------------------------

type encoder struct{ b []byte }

func (e *encoder) value(v reflect.Value) error {
	if !v.IsValid() {
		e.b = append(e.b, "null"...)
		return nil
	}
	if v.Type() == rawType {
		if v.Len() == 0 {
			e.b = append(e.b, "null"...)
		} else {
			e.b = append(e.b, v.Bytes()...)
		}
		return nil
	}
	if v.CanInterface() {
		if m, ok := v.Interface().(Marshaler); ok && !(v.Kind() == reflect.Pointer && v.IsNil()) {
			b, err := m.MarshalJSON()
			e.b = append(e.b, b...)
			return err
		}
	}
	switch v.Kind() {
	case reflect.Pointer, reflect.Interface:
		if v.IsNil() {
			e.b = append(e.b, "null"...)
			return nil
		}
		return e.value(v.Elem())
	case reflect.Bool:
		e.b = strconv.AppendBool(e.b, v.Bool())
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		e.b = strconv.AppendInt(e.b, v.Int(), 10)
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Uintptr:
		e.b = strconv.AppendUint(e.b, v.Uint(), 10)
	case reflect.Float32, reflect.Float64:
		return e.float(v.Float(), v.Type().Bits())
	case reflect.String:
		e.str(v.String())
	case reflect.Slice:
		if v.IsNil() {
			e.b = append(e.b, "null"...)
			return nil
		}
		return e.list(v)
	case reflect.Array:
		return e.list(v)
	case reflect.Map:
		return e.mapping(v)
	case reflect.Struct:
		e.b = append(e.b, '{')
		n := 0
		if err := e.fields(v, &n); err != nil {
			return err
		}
		e.b = append(e.b, '}')
	default:
		return errors.New("arcade.Marshal: cannot write a " + v.Type().String())
	}
	return nil
}

// float writes a number as JavaScript's JSON.stringify does.
func (e *encoder) float(f float64, bits int) error {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return errors.New("arcade.Marshal: NaN or Inf is not JSON")
	}
	if a := math.Abs(f); a != 0 && (a < 1e-6 || a >= 1e21) {
		e.b = strconv.AppendFloat(e.b, f, 'e', -1, bits)
		if n := len(e.b); e.b[n-4] == 'e' && e.b[n-2] == '0' { // 1e-07 → 1e-7
			e.b = append(e.b[:n-2], e.b[n-1])
		}
		return nil
	}
	e.b = strconv.AppendFloat(e.b, f, 'f', -1, bits)
	return nil
}

func (e *encoder) str(s string) {
	const hex = "0123456789abcdef"
	e.b = append(e.b, '"')
	for i := 0; i < len(s); {
		c := s[i]
		if c >= 0x20 && c != '"' && c != '\\' && c < utf8.RuneSelf {
			e.b = append(e.b, c)
			i++
			continue
		}
		switch c {
		case '"', '\\':
			e.b = append(e.b, '\\', c)
		case '\n':
			e.b = append(e.b, '\\', 'n')
		case '\r':
			e.b = append(e.b, '\\', 'r')
		case '\t':
			e.b = append(e.b, '\\', 't')
		default:
			if c < 0x20 {
				e.b = append(e.b, '\\', 'u', '0', '0', hex[c>>4], hex[c&15])
				break
			}
			r, size := utf8.DecodeRuneInString(s[i:])
			if r == utf8.RuneError && size == 1 {
				e.b = append(e.b, `�`...)
			} else {
				e.b = append(e.b, s[i:i+size]...)
			}
			i += size
			continue
		}
		i++
	}
	e.b = append(e.b, '"')
}

func (e *encoder) list(v reflect.Value) error {
	e.b = append(e.b, '[')
	for i := 0; i < v.Len(); i++ {
		if i > 0 {
			e.b = append(e.b, ',')
		}
		if err := e.value(v.Index(i)); err != nil {
			return err
		}
	}
	e.b = append(e.b, ']')
	return nil
}

// mapping writes a map with its keys sorted, as encoding/json does.
func (e *encoder) mapping(v reflect.Value) error {
	if v.IsNil() {
		e.b = append(e.b, "null"...)
		return nil
	}
	type entry struct {
		k string
		v reflect.Value
	}
	var all []entry
	for it := v.MapRange(); it.Next(); {
		k := it.Key()
		var s string
		switch k.Kind() {
		case reflect.String:
			s = k.String()
		case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
			s = strconv.FormatInt(k.Int(), 10)
		case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
			s = strconv.FormatUint(k.Uint(), 10)
		default:
			return errors.New("arcade.Marshal: a map key must be a string or an integer")
		}
		all = append(all, entry{s, it.Value()})
	}
	sort.Slice(all, func(i, j int) bool { return all[i].k < all[j].k })
	e.b = append(e.b, '{')
	for i, en := range all {
		if i > 0 {
			e.b = append(e.b, ',')
		}
		e.str(en.k)
		e.b = append(e.b, ':')
		if err := e.value(en.v); err != nil {
			return err
		}
	}
	e.b = append(e.b, '}')
	return nil
}

// fields writes a struct's exported fields in order, flattening embedded
// structs; n counts the fields written so far, for the commas.
func (e *encoder) fields(v reflect.Value, n *int) error {
	t := v.Type()
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		name, omit, skip := tagOf(f)
		if skip {
			continue
		}
		fv := v.Field(i)
		if f.Anonymous && name == "" {
			if fv.Kind() == reflect.Pointer {
				if fv.IsNil() {
					continue
				}
				fv = fv.Elem()
			}
			if fv.Kind() == reflect.Struct {
				if err := e.fields(fv, n); err != nil {
					return err
				}
				continue
			}
		}
		if !f.IsExported() || (omit && empty(fv)) {
			continue
		}
		if name == "" {
			name = f.Name
		}
		if *n > 0 {
			e.b = append(e.b, ',')
		}
		*n++
		e.str(name)
		e.b = append(e.b, ':')
		if err := e.value(fv); err != nil {
			return err
		}
	}
	return nil
}

// tagOf reads a field's `json:"name,omitempty"` tag; "-" skips it.
func tagOf(f reflect.StructField) (name string, omit, skip bool) {
	tag := f.Tag.Get("json")
	if tag == "-" {
		return "", false, true
	}
	name, opts, _ := strings.Cut(tag, ",")
	return name, strings.Contains(","+opts+",", ",omitempty,"), false
}

func empty(v reflect.Value) bool {
	switch v.Kind() {
	case reflect.Array, reflect.Map, reflect.Slice, reflect.String:
		return v.Len() == 0
	case reflect.Bool:
		return !v.Bool()
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return v.Int() == 0
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Uintptr:
		return v.Uint() == 0
	case reflect.Float32, reflect.Float64:
		return v.Float() == 0
	case reflect.Interface, reflect.Pointer:
		return v.IsNil()
	}
	return false
}

// -- reading -----------------------------------------------------------------

type decoder struct {
	b []byte
	i int
}

func (d *decoder) fail(what string) error {
	return errors.New("arcade.Unmarshal: " + what + " at offset " + strconv.Itoa(d.i))
}

func (d *decoder) space() {
	for d.i < len(d.b) {
		switch d.b[d.i] {
		case ' ', '\t', '\n', '\r':
			d.i++
		default:
			return
		}
	}
}

// value reads the next value into v (settable), with d.i at its first byte.
func (d *decoder) value(v reflect.Value) error {
	if d.i >= len(d.b) {
		return d.fail("unexpected end")
	}
	if v.Type() == rawType {
		start := d.i
		if err := d.skip(); err != nil {
			return err
		}
		v.SetBytes(append(RawJSON(nil), d.b[start:d.i]...))
		return nil
	}
	if v.CanAddr() {
		if u, ok := v.Addr().Interface().(Unmarshaler); ok {
			start := d.i
			if err := d.skip(); err != nil {
				return err
			}
			return u.UnmarshalJSON(d.b[start:d.i])
		}
	}
	c := d.b[d.i]
	if c == 'n' {
		if err := d.word("null"); err != nil {
			return err
		}
		switch v.Kind() {
		case reflect.Pointer, reflect.Interface, reflect.Map, reflect.Slice:
			v.Set(reflect.Zero(v.Type()))
		}
		return nil
	}
	switch v.Kind() {
	case reflect.Pointer:
		if v.IsNil() {
			v.Set(reflect.New(v.Type().Elem()))
		}
		return d.value(v.Elem())
	case reflect.Interface:
		if v.NumMethod() != 0 {
			return d.fail("cannot read into a non-empty interface " + v.Type().String())
		}
		x, err := d.any()
		if err == nil && x != nil {
			v.Set(reflect.ValueOf(x))
		}
		return err
	}
	switch c {
	case 't', 'f':
		if v.Kind() != reflect.Bool {
			return d.mismatch("a boolean", v)
		}
		if c == 't' {
			v.SetBool(true)
			return d.word("true")
		}
		v.SetBool(false)
		return d.word("false")
	case '"':
		s, err := d.str()
		if err != nil {
			return err
		}
		if v.Kind() != reflect.String {
			return d.mismatch("a string", v)
		}
		v.SetString(s)
		return nil
	case '[':
		return d.list(v)
	case '{':
		return d.object(v)
	}
	num, err := d.number()
	if err != nil {
		return err
	}
	switch v.Kind() {
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		n, err := strconv.ParseInt(num, 10, 64)
		if err != nil || v.OverflowInt(n) {
			return d.mismatch("the integer "+num, v)
		}
		v.SetInt(n)
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Uintptr:
		n, err := strconv.ParseUint(num, 10, 64)
		if err != nil || v.OverflowUint(n) {
			return d.mismatch("the integer "+num, v)
		}
		v.SetUint(n)
	case reflect.Float32, reflect.Float64:
		f, err := strconv.ParseFloat(num, v.Type().Bits())
		if err != nil {
			return d.mismatch("the number "+num, v)
		}
		v.SetFloat(f)
	default:
		return d.mismatch("a number", v)
	}
	return nil
}

func (d *decoder) mismatch(what string, v reflect.Value) error {
	return d.fail("cannot put " + what + " in a " + v.Type().String())
}

func (d *decoder) word(w string) error {
	if !strings.HasPrefix(string(d.b[d.i:]), w) {
		return d.fail("a bad literal")
	}
	d.i += len(w)
	return nil
}

func (d *decoder) list(v reflect.Value) error {
	if v.Kind() != reflect.Slice && v.Kind() != reflect.Array {
		return d.mismatch("an array", v)
	}
	if v.Kind() == reflect.Slice {
		v.Set(reflect.MakeSlice(v.Type(), 0, 0))
	}
	d.i++ // [
	d.space()
	n := 0
	if d.i < len(d.b) && d.b[d.i] == ']' {
		d.i++
	} else {
		for ; ; n++ {
			if v.Kind() == reflect.Slice {
				v.Set(reflect.Append(v, reflect.Zero(v.Type().Elem())))
			}
			var err error
			if n < v.Len() {
				err = d.value(v.Index(n))
			} else {
				err = d.skip() // past the end of an array
			}
			if err != nil {
				return err
			}
			done, err := d.next(']')
			if err != nil {
				return err
			}
			if done {
				n++
				break
			}
		}
	}
	for ; v.Kind() == reflect.Array && n < v.Len(); n++ {
		v.Index(n).Set(reflect.Zero(v.Type().Elem()))
	}
	return nil
}

// next steps past a ',' (false) or the closing byte (true).
func (d *decoder) next(end byte) (bool, error) {
	d.space()
	if d.i >= len(d.b) {
		return true, d.fail("unexpected end")
	}
	switch d.b[d.i] {
	case ',':
		d.i++
		d.space()
		return false, nil
	case end:
		d.i++
		return true, nil
	}
	return true, d.fail("expected ',' or '" + string(end) + "'")
}

func (d *decoder) object(v reflect.Value) error {
	switch v.Kind() {
	case reflect.Map:
		if v.Type().Key().Kind() != reflect.String {
			return d.fail("a map key must be a string")
		}
		if v.IsNil() {
			v.Set(reflect.MakeMap(v.Type()))
		}
	case reflect.Struct:
	default:
		return d.mismatch("an object", v)
	}
	d.i++ // {
	d.space()
	if d.i < len(d.b) && d.b[d.i] == '}' {
		d.i++
		return nil
	}
	for {
		if d.i >= len(d.b) || d.b[d.i] != '"' {
			return d.fail("expected a key")
		}
		key, err := d.str()
		if err != nil {
			return err
		}
		if d.space(); d.i >= len(d.b) || d.b[d.i] != ':' {
			return d.fail("expected ':'")
		}
		d.i++
		d.space()
		if v.Kind() == reflect.Map {
			el := reflect.New(v.Type().Elem()).Elem()
			if err := d.value(el); err != nil {
				return err
			}
			v.SetMapIndex(reflect.ValueOf(key).Convert(v.Type().Key()), el)
		} else if f := field(v, key); f.IsValid() {
			if err := d.value(f); err != nil {
				return err
			}
		} else if err := d.skip(); err != nil {
			return err
		}
		if done, err := d.next('}'); err != nil || done {
			return err
		}
	}
}

// field finds the struct field a key names: by tag or name, exactly, then
// ignoring case, as encoding/json does; embedded structs' fields included.
func field(v reflect.Value, key string) reflect.Value {
	var fold reflect.Value
	var walk func(v reflect.Value) reflect.Value
	walk = func(v reflect.Value) reflect.Value {
		t := v.Type()
		for i := 0; i < t.NumField(); i++ {
			f := t.Field(i)
			name, _, skip := tagOf(f)
			if skip {
				continue
			}
			if f.Anonymous && name == "" {
				fv := v.Field(i)
				if fv.Kind() == reflect.Pointer && fv.Type().Elem().Kind() == reflect.Struct {
					if fv.IsNil() {
						if !fv.CanSet() {
							continue
						}
						fv.Set(reflect.New(fv.Type().Elem()))
					}
					fv = fv.Elem()
				}
				if fv.Kind() == reflect.Struct {
					if got := walk(fv); got.IsValid() {
						return got
					}
					continue
				}
			}
			if !f.IsExported() {
				continue
			}
			if name == "" {
				name = f.Name
			}
			if name == key {
				return v.Field(i)
			}
			if !fold.IsValid() && strings.EqualFold(name, key) {
				fold = v.Field(i)
			}
		}
		return reflect.Value{}
	}
	if got := walk(v); got.IsValid() {
		return got
	}
	return fold
}

// any reads the next value as encoding/json does into an empty interface:
// nil, bool, float64, string, []any or map[string]any.
func (d *decoder) any() (any, error) {
	switch c := d.b[d.i]; {
	case c == 'n':
		return nil, d.word("null")
	case c == 't':
		return true, d.word("true")
	case c == 'f':
		return false, d.word("false")
	case c == '"':
		return d.str()
	case c == '[':
		var out []any
		err := d.list(reflect.ValueOf(&out).Elem())
		return out, err
	case c == '{':
		out := map[string]any{}
		err := d.object(reflect.ValueOf(out))
		return out, err
	}
	num, err := d.number()
	if err != nil {
		return nil, err
	}
	f, err := strconv.ParseFloat(num, 64)
	if err != nil {
		return nil, d.fail("a bad number")
	}
	return f, nil
}

// skip steps over the next value, checking it.
func (d *decoder) skip() error {
	_, err := d.any()
	return err
}

func (d *decoder) number() (string, error) {
	start := d.i
	digits := func() bool {
		s := d.i
		for d.i < len(d.b) && d.b[d.i] >= '0' && d.b[d.i] <= '9' {
			d.i++
		}
		return d.i > s
	}
	if d.i < len(d.b) && d.b[d.i] == '-' {
		d.i++
	}
	if d.i < len(d.b) && d.b[d.i] == '0' {
		d.i++
	} else if !digits() {
		return "", d.fail("a bad value")
	}
	if d.i < len(d.b) && d.b[d.i] == '.' {
		d.i++
		if !digits() {
			return "", d.fail("a bad number")
		}
	}
	if d.i < len(d.b) && (d.b[d.i] == 'e' || d.b[d.i] == 'E') {
		d.i++
		if d.i < len(d.b) && (d.b[d.i] == '+' || d.b[d.i] == '-') {
			d.i++
		}
		if !digits() {
			return "", d.fail("a bad number")
		}
	}
	return string(d.b[start:d.i]), nil
}

func (d *decoder) str() (string, error) {
	d.i++ // "
	start := d.i
	for d.i < len(d.b) && d.b[d.i] != '"' && d.b[d.i] != '\\' && d.b[d.i] >= 0x20 {
		d.i++
	}
	if d.i < len(d.b) && d.b[d.i] == '"' { // the common case: nothing escaped
		d.i++
		return string(d.b[start : d.i-1]), nil
	}
	out := append([]byte(nil), d.b[start:d.i]...)
	for d.i < len(d.b) {
		c := d.b[d.i]
		switch {
		case c == '"':
			d.i++
			return string(out), nil
		case c < 0x20:
			return "", d.fail("a control character in a string")
		case c != '\\':
			out = append(out, c)
			d.i++
			continue
		}
		if d.i+1 >= len(d.b) {
			break
		}
		esc := d.b[d.i+1]
		d.i += 2
		switch esc {
		case '"', '\\', '/':
			out = append(out, esc)
		case 'b':
			out = append(out, '\b')
		case 'f':
			out = append(out, '\f')
		case 'n':
			out = append(out, '\n')
		case 'r':
			out = append(out, '\r')
		case 't':
			out = append(out, '\t')
		case 'u':
			r, ok := d.hex4()
			if !ok {
				return "", d.fail("a bad \\u escape")
			}
			if utf16.IsSurrogate(r) { // a pair, \uD83D\uDE00, or else U+FFFD
				at := d.i
				lo := rune(0)
				if d.i+1 < len(d.b) && d.b[d.i] == '\\' && d.b[d.i+1] == 'u' {
					d.i += 2
					lo, _ = d.hex4()
				}
				if r = utf16.DecodeRune(r, lo); r == utf8.RuneError {
					d.i = at // leave the second escape to be read on its own
				}
			}
			out = utf8.AppendRune(out, r)
		default:
			return "", d.fail("a bad escape")
		}
	}
	return "", d.fail("an unterminated string")
}

func (d *decoder) hex4() (rune, bool) {
	if d.i+4 > len(d.b) {
		return 0, false
	}
	n, err := strconv.ParseUint(string(d.b[d.i:d.i+4]), 16, 32)
	if err != nil {
		return 0, false
	}
	d.i += 4
	return rune(n), true
}
