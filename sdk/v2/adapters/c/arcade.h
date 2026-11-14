/* arcade.h — write an SDK v2 managed game's rules in C (or C++).
 *
 * The platform calls a managed game's rules through one function of strings
 * (docs/sdk-v2.md "Managed state", protocol.json `rulesCall` / `rulesOut`):
 *
 *     dispatch('{"fn":"apply","action":{"i":4},"by":"pX"}')  ->  '{"v":null}'
 *
 * This header writes that function for you. You write the rules as plain C
 * functions, list them with ARCADE_GAME(...), and never see the protocol:
 *
 *     #include "arcade.h"
 *     static void init(const arcade_setup *s) { ... }
 *     static const char *apply(arcade_val action, const char *by) { ... }  // NULL allows
 *     static void view(arcade_out *o, const char *seat) { ... }            // seat NULL: a spectator
 *     ...
 *     ARCADE_GAME(.init = init, .apply = apply, .view = view, .turn = turn, .bot = bot,
 *                 .result = result, .snapshot = snapshot, .restore = restore, .skip = skip)
 *
 * Reading: a call's JSON arguments come as `arcade_val` (a read-only view
 * into the parsed call): arcade_get / arcade_at / arcade_len / arcade_int /
 * arcade_num / arcade_bool / arcade_str / arcade_str_is.
 * Writing: a rule that returns a value writes it into an `arcade_out` with
 * arcade_begin_obj / arcade_key / arcade_put_* / arcade_end. Writing nothing
 * means null.
 *
 * Memory: every pointer a rule is handed (strings, arcade_val, the setup)
 * lives only until the rule returns; copy what you keep (arcade_dup). The
 * string dispatch() returns belongs to this header and stays valid until the
 * next dispatch() call: the caller reads it and must not free it. The caller
 * owns the string it passes in. (sdk/v2/adapters/c/arcade-c.js does both.)
 *
 * Safety: the reader is strict JSON, bounded (ARCADE_MAX_DEPTH nesting), and
 * never reads past its input; a malformed call is answered with {"err": ...}.
 * The writer escapes strings and checks that what a rule built is one
 * well-formed value; if not, the call answers {"err": ...}.
 *
 * Compiles as C99 and as C++11 (C++20 for ARCADE_GAME's designated
 * initialisers, which must then follow the field order of arcade_game; or
 * fill an arcade_game yourself and use ARCADE_DISPATCH(game)).
 */
#ifndef ARCADE_H
#define ARCADE_H

#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#define ARCADE_EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define ARCADE_EXPORT
#endif
#ifdef __cplusplus
#define ARCADE_EXTERN_C extern "C"
extern "C" {
#else
#define ARCADE_EXTERN_C
#endif

#ifndef ARCADE_MAX_DEPTH
#define ARCADE_MAX_DEPTH 64 /* nesting, for reading and for writing */
#endif

/* -- reading ------------------------------------------------------------- */

enum { ARCADE_MISSING, ARCADE_NULL, ARCADE_BOOL, ARCADE_NUMBER, ARCADE_STRING, ARCADE_ARRAY, ARCADE_OBJECT };

typedef struct {
	unsigned char type;
	size_t start, end; /* the value's text: src[start, end) (a string's includes its quotes) */
	size_t skip;       /* the node after this one's subtree */
	size_t count;      /* an array's or object's members */
} arcade__node;

typedef struct {
	const char *src;
	arcade__node *nodes;
	size_t n, cap;
} arcade__doc;

/** One JSON value inside a call. A missing one (a key that is not there, an
 *  index past the end, anything asked of a non-container) has type
 *  ARCADE_MISSING, and every accessor gives its fallback for it. */
typedef struct {
	const arcade__doc *doc;
	size_t i;
} arcade_val;

static const arcade_val arcade__missing = {NULL, 0};

static inline int arcade_type(arcade_val v) {
	return v.doc && v.i < v.doc->n ? (int)v.doc->nodes[v.i].type : (int)ARCADE_MISSING;
}

/** An array's or object's member count; 0 for anything else. */
static inline int arcade_len(arcade_val v) {
	int t = arcade_type(v);
	return t == ARCADE_ARRAY || t == ARCADE_OBJECT ? (int)v.doc->nodes[v.i].count : 0;
}

static inline int arcade__hex4(const char *s, unsigned *out) {
	unsigned u = 0;
	int k;
	for (k = 0; k < 4; k++) {
		char c = s[k];
		u <<= 4;
		if (c >= '0' && c <= '9') u |= (unsigned)(c - '0');
		else if (c >= 'a' && c <= 'f') u |= (unsigned)(c - 'a' + 10);
		else if (c >= 'A' && c <= 'F') u |= (unsigned)(c - 'A' + 10);
		else return 0;
	}
	*out = u;
	return 1;
}
static inline int arcade__utf8(unsigned cp, unsigned char *b) {
	if (cp < 0x80) { b[0] = (unsigned char)cp; return 1; }
	if (cp < 0x800) { b[0] = (unsigned char)(0xC0 | cp >> 6); b[1] = (unsigned char)(0x80 | (cp & 63)); return 2; }
	if (cp < 0x10000) {
		b[0] = (unsigned char)(0xE0 | cp >> 12); b[1] = (unsigned char)(0x80 | (cp >> 6 & 63)); b[2] = (unsigned char)(0x80 | (cp & 63));
		return 3;
	}
	b[0] = (unsigned char)(0xF0 | cp >> 18); b[1] = (unsigned char)(0x80 | (cp >> 12 & 63));
	b[2] = (unsigned char)(0x80 | (cp >> 6 & 63)); b[3] = (unsigned char)(0x80 | (cp & 63));
	return 4;
}
/* The next UTF-8 sequence of a validated string's text at *pos (an escape
 * decoded); writes 1-4 bytes to b, returns how many. */
static inline int arcade__next(const char *s, size_t *pos, size_t end, unsigned char *b) {
	size_t p = *pos;
	unsigned char c = (unsigned char)s[p];
	if (c != '\\') {
		/* raw bytes: a whole UTF-8 sequence, clamped to the string */
		int n = c < 0xC0 ? 1 : c < 0xE0 ? 2 : c < 0xF0 ? 3 : 4, k;
		if ((size_t)n > end - p) n = (int)(end - p);
		for (k = 0; k < n; k++) b[k] = (unsigned char)s[p + k];
		*pos = p + (size_t)n;
		return n;
	}
	c = (unsigned char)s[p + 1];
	*pos = p + 2;
	switch (c) {
	case 'b': b[0] = '\b'; return 1;
	case 'f': b[0] = '\f'; return 1;
	case 'n': b[0] = '\n'; return 1;
	case 'r': b[0] = '\r'; return 1;
	case 't': b[0] = '\t'; return 1;
	case 'u': {
		unsigned u = 0, lo = 0;
		arcade__hex4(s + p + 2, &u); /* validated by the parser */
		*pos = p + 6;
		if (u >= 0xD800 && u < 0xDC00 && end - *pos >= 6 && s[*pos] == '\\' && s[*pos + 1] == 'u' &&
		    arcade__hex4(s + *pos + 2, &lo) && lo >= 0xDC00 && lo < 0xE000) {
			*pos += 6;
			u = 0x10000 + ((u - 0xD800) << 10) + (lo - 0xDC00);
		} else if (u >= 0xD800 && u < 0xE000) {
			u = 0xFFFD; /* a lone surrogate */
		}
		return arcade__utf8(u, b);
	}
	default: b[0] = c; return 1; /* " \ / */
	}
}

/** Copies a string value into buf (always NUL-terminated when cap > 0, cut
 *  at a whole character) and returns its full length in bytes; -1 if v is
 *  not a string. A return >= cap means it was cut short. */
static inline int arcade_str(arcade_val v, char *buf, size_t cap) {
	size_t pos, end, n = 0;
	int cut = 0;
	if (arcade_type(v) != ARCADE_STRING) {
		if (cap) buf[0] = 0;
		return -1;
	}
	pos = v.doc->nodes[v.i].start + 1;
	end = v.doc->nodes[v.i].end - 1;
	while (pos < end) {
		unsigned char b[4];
		int k = arcade__next(v.doc->src, &pos, end, b), j;
		if (!cut && cap && n + (size_t)k <= cap - 1) {
			for (j = 0; j < k; j++) buf[n + (size_t)j] = (char)b[j];
		} else {
			if (!cut && cap) buf[n] = 0;
			cut = 1;
		}
		n += (size_t)k;
	}
	if (!cut && cap) buf[n] = 0;
	return n > 0x7fffffff ? 0x7fffffff : (int)n;
}

/** A string value, copied with malloc (the caller frees it); NULL if v is
 *  not a string or memory ran out. */
static inline char *arcade_strdup(arcade_val v) {
	int n = arcade_str(v, NULL, 0);
	char *s;
	if (n < 0) return NULL;
	s = (char *)malloc((size_t)n + 1);
	if (s) arcade_str(v, s, (size_t)n + 1);
	return s;
}

/** Whether v is a string equal to s (s NULL: never). */
static inline int arcade_str_is(arcade_val v, const char *s) {
	size_t pos, end, n = 0;
	if (!s || arcade_type(v) != ARCADE_STRING) return 0;
	pos = v.doc->nodes[v.i].start + 1;
	end = v.doc->nodes[v.i].end - 1;
	while (pos < end) {
		unsigned char b[4];
		int k = arcade__next(v.doc->src, &pos, end, b), j;
		for (j = 0; j < k; j++, n++)
			if (s[n] == 0 || (unsigned char)s[n] != b[j]) return 0;
	}
	return s[n] == 0;
}

/** An object's member by key (the last, if repeated, as JSON.parse does). */
static inline arcade_val arcade_get(arcade_val obj, const char *key) {
	arcade_val found = arcade__missing, k;
	size_t i, j;
	if (arcade_type(obj) != ARCADE_OBJECT) return found;
	k.doc = obj.doc;
	for (i = 0, j = obj.i + 1; i < obj.doc->nodes[obj.i].count; i++) {
		k.i = j;
		if (arcade_str_is(k, key)) {
			found.doc = obj.doc;
			found.i = j + 1;
		}
		j = obj.doc->nodes[j + 1].skip;
	}
	return found;
}

/* The index'th member's node: an array's value, or an object's key. */
static inline arcade_val arcade__member(arcade_val v, int index, int type) {
	arcade_val r = arcade__missing;
	size_t i, j;
	if (arcade_type(v) != type || index < 0 || (size_t)index >= v.doc->nodes[v.i].count) return r;
	for (i = 0, j = v.i + 1; i < (size_t)index; i++) j = v.doc->nodes[type == ARCADE_OBJECT ? j + 1 : j].skip;
	r.doc = v.doc;
	r.i = j;
	return r;
}
/** An array's index'th value, or an object's index'th member's value. */
static inline arcade_val arcade_at(arcade_val v, int index) {
	arcade_val r = arcade__member(v, index, ARCADE_ARRAY);
	if (arcade_type(v) == ARCADE_OBJECT && (r = arcade__member(v, index, ARCADE_OBJECT)).doc) r.i++;
	return r;
}
/** An object's index'th key (a string value), to walk a map such as tick's inputs. */
static inline arcade_val arcade_key_at(arcade_val obj, int index) {
	return arcade__member(obj, index, ARCADE_OBJECT);
}

/** Whether v is a number whose exact decimal value is an integer that fits a
 *  long long; if so, stores it (4, 4.0, 4e0 and 40e-1 all do; 4.5 does not). */
static inline int arcade_int64(arcade_val v, long long *out) {
	const char *s;
	size_t p, end;
	int neg = 0, exp = 0, eneg = 0, nd = 0, k;
	unsigned long long m = 0;
	char d[24]; /* the significant digits, at most 19 + 1 */
	if (arcade_type(v) != ARCADE_NUMBER) return 0;
	s = v.doc->src;
	p = v.doc->nodes[v.i].start;
	end = v.doc->nodes[v.i].end;
	if (s[p] == '-') { neg = 1; p++; }
	/* digits before and after the point, leading zeros dropped; trailing
	 * fraction digits count against the exponent */
	for (; p < end && s[p] >= '0' && s[p] <= '9'; p++) {
		if (nd == 0 && s[p] == '0') continue;
		if (nd >= 20) { exp++; if (s[p] != '0') return 0; continue; } /* too big for 2^63 */
		d[nd++] = s[p];
	}
	if (p < end && s[p] == '.')
		for (p++; p < end && s[p] >= '0' && s[p] <= '9'; p++) {
			if (nd == 0 && s[p] == '0') { exp--; continue; }
			if (nd >= 20) { if (s[p] != '0') return 0; continue; } /* digits past 2^63: must be 0 */
			d[nd++] = s[p];
			exp--;
		}
	if (p < end && (s[p] == 'e' || s[p] == 'E')) {
		int e = 0;
		p++;
		if (s[p] == '-') { eneg = 1; p++; } else if (s[p] == '+') p++;
		for (; p < end; p++) { if (e < 100000) e = e * 10 + (s[p] - '0'); }
		exp += eneg ? -e : e;
	}
	while (nd > 0 && d[nd - 1] == '0') { nd--; exp++; }
	if (nd == 0) { *out = 0; return 1; }
	if (exp < 0 || nd + exp > 19) return 0;
	for (k = 0; k < nd; k++) m = m * 10 + (unsigned long long)(d[k] - '0');
	for (k = 0; k < exp; k++) m *= 10;
	if (m > (neg ? 9223372036854775808ULL : 9223372036854775807ULL)) return 0;
	*out = neg ? (long long)(0 - m) : (long long)m;
	return 1;
}
/** As arcade_int64, for an int. */
static inline int arcade_int(arcade_val v, int *out) {
	long long x;
	if (!arcade_int64(v, &x) || x < -2147483647LL - 1 || x > 2147483647LL) return 0;
	*out = (int)x;
	return 1;
}
/** A number's value; `otherwise` for anything else. */
static inline double arcade_num(arcade_val v, double otherwise) {
	long long x;
	if (arcade_type(v) != ARCADE_NUMBER) return otherwise;
	if (arcade_int64(v, &x) && x > -9007199254740992LL && x < 9007199254740992LL) return (double)x;
	return strtod(v.doc->src + v.doc->nodes[v.i].start, NULL);
}
/** 1 for true, 0 for false, `otherwise` for anything else. */
static inline int arcade_bool(arcade_val v, int otherwise) {
	if (arcade_type(v) != ARCADE_BOOL) return otherwise;
	return v.doc->src[v.doc->nodes[v.i].start] == 't';
}

/* The parser: strict JSON (RFC 8259), into a flat array of nodes. */
typedef struct {
	const char *s;
	size_t len, pos;
	arcade__doc *d;
	int oom;
} arcade__parser;

static inline size_t arcade__push(arcade__parser *p, int type) {
	arcade__doc *d = p->d;
	if (d->n == d->cap) {
		size_t cap = d->cap ? d->cap * 2 : 32;
		arcade__node *nodes = (arcade__node *)realloc(d->nodes, cap * sizeof *nodes);
		if (!nodes || cap < d->cap) { p->oom = 1; return (size_t)-1; }
		d->nodes = nodes;
		d->cap = cap;
	}
	d->nodes[d->n].type = (unsigned char)type;
	d->nodes[d->n].start = p->pos;
	d->nodes[d->n].count = 0;
	return d->n++;
}
static inline void arcade__ws(arcade__parser *p) {
	while (p->pos < p->len && (p->s[p->pos] == ' ' || p->s[p->pos] == '\t' || p->s[p->pos] == '\n' || p->s[p->pos] == '\r')) p->pos++;
}
static inline int arcade__digits(arcade__parser *p) {
	size_t from = p->pos;
	while (p->pos < p->len && p->s[p->pos] >= '0' && p->s[p->pos] <= '9') p->pos++;
	return p->pos > from;
}
static inline int arcade__value(arcade__parser *p, int depth);
static inline int arcade__string(arcade__parser *p) {
	size_t at;
	unsigned u;
	if (p->pos >= p->len || p->s[p->pos] != '"') return 0;
	at = arcade__push(p, ARCADE_STRING);
	if (p->oom) return 0;
	for (p->pos++;; p->pos++) {
		unsigned char c;
		if (p->pos >= p->len) return 0;
		c = (unsigned char)p->s[p->pos];
		if (c == '"') break;
		if (c < 0x20) return 0;
		if (c != '\\') continue;
		if (++p->pos >= p->len) return 0;
		c = (unsigned char)p->s[p->pos];
		if (c == 'u') {
			if (p->len - p->pos < 5 || !arcade__hex4(p->s + p->pos + 1, &u)) return 0;
			p->pos += 4;
		} else if (!strchr("\"\\/bfnrt", c) || c == 0) {
			return 0;
		}
	}
	p->pos++;
	p->d->nodes[at].end = p->pos;
	p->d->nodes[at].skip = at + 1;
	return 1;
}
static inline int arcade__value(arcade__parser *p, int depth) {
	size_t at;
	char c;
	arcade__ws(p);
	if (p->pos >= p->len || depth > ARCADE_MAX_DEPTH) return 0;
	c = p->s[p->pos];
	if (c == '"') return arcade__string(p);
	if (c == '{' || c == '[') {
		char close = c == '{' ? '}' : ']';
		at = arcade__push(p, c == '{' ? ARCADE_OBJECT : ARCADE_ARRAY);
		if (p->oom) return 0;
		p->pos++;
		arcade__ws(p);
		if (p->pos < p->len && p->s[p->pos] == close) {
			p->pos++;
		} else {
			for (;;) {
				if (c == '{') {
					arcade__ws(p);
					if (!arcade__string(p)) return 0;
					arcade__ws(p);
					if (p->pos >= p->len || p->s[p->pos] != ':') return 0;
					p->pos++;
				}
				if (!arcade__value(p, depth + 1)) return 0;
				p->d->nodes[at].count++;
				arcade__ws(p);
				if (p->pos >= p->len) return 0;
				if (p->s[p->pos] == ',') { p->pos++; continue; }
				if (p->s[p->pos] != close) return 0;
				p->pos++;
				break;
			}
		}
		p->d->nodes[at].end = p->pos;
		p->d->nodes[at].skip = p->d->n;
		return 1;
	}
	if (c == 't' || c == 'f' || c == 'n') {
		const char *word = c == 't' ? "true" : c == 'f' ? "false" : "null";
		size_t n = strlen(word);
		if (p->len - p->pos < n || memcmp(p->s + p->pos, word, n) != 0) return 0;
		at = arcade__push(p, c == 'n' ? ARCADE_NULL : ARCADE_BOOL);
		if (p->oom) return 0;
		p->pos += n;
	} else {
		at = arcade__push(p, ARCADE_NUMBER);
		if (p->oom) return 0;
		if (p->s[p->pos] == '-') p->pos++;
		if (p->pos < p->len && p->s[p->pos] == '0') p->pos++;
		else if (!arcade__digits(p)) return 0;
		if (p->pos < p->len && p->s[p->pos] == '.') {
			p->pos++;
			if (!arcade__digits(p)) return 0;
		}
		if (p->pos < p->len && (p->s[p->pos] == 'e' || p->s[p->pos] == 'E')) {
			p->pos++;
			if (p->pos < p->len && (p->s[p->pos] == '+' || p->s[p->pos] == '-')) p->pos++;
			if (!arcade__digits(p)) return 0;
		}
	}
	p->d->nodes[at].end = p->pos;
	p->d->nodes[at].skip = at + 1;
	return 1;
}
/* 1: parsed; 0: not JSON; -1: out of memory. The caller frees d->nodes. */
static inline int arcade__parse(arcade__doc *d, const char *s, size_t len) {
	arcade__parser p;
	int ok;
	d->src = s;
	d->nodes = NULL;
	d->n = d->cap = 0;
	p.s = s;
	p.len = len;
	p.pos = 0;
	p.d = d;
	p.oom = 0;
	ok = arcade__value(&p, 0);
	if (p.oom) return -1;
	arcade__ws(&p);
	return ok && p.pos == len;
}

/* -- writing ------------------------------------------------------------- */

/** Where a rule writes the value it returns. */
typedef struct arcade_out {
	char *buf;
	size_t len, cap;
	char stack[ARCADE_MAX_DEPTH]; /* '{' or '[' */
	int depth, comma, keyed, values, bad; /* bad: 1 malformed, 2 out of memory */
} arcade_out;

static inline void arcade__raw(arcade_out *o, const char *s, size_t n) {
	if (o->bad == 2) return;
	if (n > o->cap - o->len) {
		size_t cap = o->cap ? o->cap : 64;
		char *b;
		while (cap - o->len < n) {
			if (cap > ((size_t)-1) / 2) { o->bad = 2; return; }
			cap *= 2;
		}
		b = (char *)realloc(o->buf, cap);
		if (!b) { o->bad = 2; return; }
		o->buf = b;
		o->cap = cap;
	}
	memcpy(o->buf + o->len, s, n);
	o->len += n;
}
/* Before any value: the comma, and whether a value may go here. */
static inline void arcade__before(arcade_out *o) {
	if (o->depth == 0) {
		if (o->values++) o->bad = o->bad ? o->bad : 1; /* one value only */
	} else if (o->stack[o->depth - 1] == '{') {
		if (!o->keyed) o->bad = o->bad ? o->bad : 1; /* a value in an object needs a key */
	} else if (o->comma) {
		arcade__raw(o, ",", 1);
	}
	o->keyed = 0;
	o->comma = 1;
}
static inline void arcade__quoted(arcade_out *o, const char *s, size_t n) {
	static const char hex[] = "0123456789abcdef";
	size_t i, from = 0;
	arcade__raw(o, "\"", 1);
	for (i = 0; i < n; i++) {
		unsigned char c = (unsigned char)s[i];
		char esc[7] = {'\\', 0, 0, 0, 0, 0, 0};
		size_t k = 2;
		if (c >= 0x20 && c != '"' && c != '\\') continue;
		arcade__raw(o, s + from, i - from);
		from = i + 1;
		switch (c) {
		case '"': esc[1] = '"'; break;
		case '\\': esc[1] = '\\'; break;
		case '\n': esc[1] = 'n'; break;
		case '\r': esc[1] = 'r'; break;
		case '\t': esc[1] = 't'; break;
		case '\b': esc[1] = 'b'; break;
		case '\f': esc[1] = 'f'; break;
		default:
			esc[1] = 'u'; esc[2] = '0'; esc[3] = '0'; esc[4] = hex[c >> 4]; esc[5] = hex[c & 15];
			k = 6;
		}
		arcade__raw(o, esc, k);
	}
	arcade__raw(o, s + from, n - from);
	arcade__raw(o, "\"", 1);
}

static inline void arcade_put_null(arcade_out *o) { arcade__before(o); arcade__raw(o, "null", 4); }
static inline void arcade_put_bool(arcade_out *o, int b) { arcade__before(o); arcade__raw(o, b ? "true" : "false", b ? 4 : 5); }
static inline void arcade_put_int(arcade_out *o, long long x) {
	char d[24];
	int n = 0;
	unsigned long long u = x < 0 ? 0 - (unsigned long long)x : (unsigned long long)x;
	do { d[sizeof d - 1 - n++] = (char)('0' + u % 10); u /= 10; } while (u);
	if (x < 0) d[sizeof d - 1 - n++] = '-';
	arcade__before(o);
	arcade__raw(o, d + sizeof d - n, (size_t)n);
}
/** A double (NaN and infinities become null, as JSON.stringify does). */
static inline void arcade_put_num(arcade_out *o, double x) {
	char d[32];
	int n;
	if (x != x || x - x != 0) { arcade_put_null(o); return; }
	if (x > -1e15 && x < 1e15 && x == (double)(long long)x) { arcade_put_int(o, (long long)x); return; }
	n = snprintf(d, sizeof d, "%.17g", x);
	arcade__before(o);
	arcade__raw(o, d, n > 0 && (size_t)n < sizeof d ? (size_t)n : 0);
}
/** A string of n bytes (UTF-8). */
static inline void arcade_put_strn(arcade_out *o, const char *s, size_t n) { arcade__before(o); arcade__quoted(o, s, n); }
/** A NUL-terminated string; NULL writes null. */
static inline void arcade_put_str(arcade_out *o, const char *s) {
	if (!s) arcade_put_null(o);
	else arcade_put_strn(o, s, strlen(s));
}
/** A value read from the call, copied as it is (missing writes null). */
static inline void arcade_put_val(arcade_out *o, arcade_val v) {
	const arcade__node *n;
	if (arcade_type(v) == ARCADE_MISSING) { arcade_put_null(o); return; }
	n = &v.doc->nodes[v.i];
	arcade__before(o);
	arcade__raw(o, v.doc->src + n->start, n->end - n->start);
}
static inline void arcade__open(arcade_out *o, char c) {
	arcade__before(o);
	if (o->depth >= ARCADE_MAX_DEPTH) { o->bad = o->bad ? o->bad : 1; return; }
	o->stack[o->depth++] = c;
	o->comma = 0;
	arcade__raw(o, &c, 1);
}
/** Starts an object: then arcade_key + a value, for each member; arcade_end. */
static inline void arcade_begin_obj(arcade_out *o) { arcade__open(o, '{'); }
/** Starts an array: then each value; arcade_end. */
static inline void arcade_begin_arr(arcade_out *o) { arcade__open(o, '['); }
/** Ends the innermost object or array. */
static inline void arcade_end(arcade_out *o) {
	char c;
	if (o->depth == 0 || o->keyed) { o->bad = o->bad ? o->bad : 1; return; }
	c = o->stack[--o->depth] == '{' ? '}' : ']';
	arcade__raw(o, &c, 1);
	o->comma = 1;
}
/** An object member's key; its value comes next. */
static inline void arcade_key(arcade_out *o, const char *key) {
	if (o->depth == 0 || o->stack[o->depth - 1] != '{' || o->keyed || !key) { o->bad = o->bad ? o->bad : 1; return; }
	if (o->comma) arcade__raw(o, ",", 1);
	arcade__quoted(o, key, strlen(key));
	arcade__raw(o, ":", 1);
	o->keyed = 1;
}

/* -- the game ------------------------------------------------------------ */

/** A seated player. team is NULL when the player has none. */
typedef struct {
	const char *id, *name, *team;
	int bot;
} arcade_seat;

/** init's arguments. */
typedef struct {
	const arcade_seat *seats; /* in party order */
	int nseats;
	arcade_val opts; /* the game's options (manifest `opts`) */
	long long seed;  /* a random seed */
	int match;       /* 0, then 1 on the first rematch, ... */
} arcade_setup;

/** The rules. Any may be NULL: skip then answers false ("cannot skip"), the
 *  others an error. Strings are UTF-8 and NUL-terminated; seat and by are
 *  member ids. */
typedef struct {
	void (*init)(const arcade_setup *setup);
	/** NULL allows the move; a string refuses it, and is the reason shown. */
	const char *(*apply)(arcade_val action, const char *by);
	/** What this seat may see; seat NULL is a spectator. */
	void (*view)(arcade_out *out, const char *seat);
	/** Whose move it is: an array of ids (drives bots and the turn-wait banner). */
	void (*turn)(arcade_out *out);
	/** A bot's move, an action as apply takes it; nothing written is null (none). */
	void (*bot)(arcade_out *out, const char *seat);
	/** Nothing (null) while the game runs; then {kind, ranking, scores?}. */
	void (*result)(arcade_out *out);
	/** Everything the heir needs to carry on; restore gets it back. */
	void (*snapshot)(arcade_out *out);
	void (*restore)(arcade_val snapshot);
	/** The host chose SKIP TURN for seat: 1 if it skipped. */
	int (*skip)(const char *seat);
	/** With manifest "tick": one fixed step; inputs maps each seat id to its latest input. */
	void (*tick)(arcade_val inputs, double dt);
} arcade_game;

static char *arcade__fail_msg;
/** Make the current rule answer {"err": message} instead of a value (C has no
 *  throw). The message is copied; the rule should still return. */
static inline void arcade_fail(const char *message) {
	size_t n = message ? strlen(message) : 0;
	if (arcade__fail_msg) return; /* the first failure is the one reported */
	arcade__fail_msg = (char *)malloc(n + 1);
	if (arcade__fail_msg) { if (n) memcpy(arcade__fail_msg, message, n); arcade__fail_msg[n] = 0; }
}

/** A copy of s with malloc (the caller frees it); NULL for NULL. */
static inline char *arcade_dup(const char *s) {
	size_t n;
	char *c;
	if (!s) return NULL;
	n = strlen(s);
	c = (char *)malloc(n + 1);
	if (c) memcpy(c, s, n + 1);
	return c;
}

static char *arcade__last; /* the previous answer, freed on the next call */

/* Answers {"err": a b c} (b, c may be NULL), kept as the call's answer. */
static inline const char *arcade__err(const char *a, const char *b, const char *c) {
	arcade_out m, o;
	memset(&m, 0, sizeof m);
	memset(&o, 0, sizeof o);
	arcade__raw(&m, a, strlen(a));
	if (b) arcade__raw(&m, b, strlen(b));
	if (c) arcade__raw(&m, c, strlen(c));
	arcade__raw(&o, "{\"err\":", 7);
	arcade__quoted(&o, m.buf ? m.buf : "", m.bad ? 0 : m.len);
	arcade__raw(&o, "}", 2); /* with the NUL */
	free(m.buf);
	if (m.bad || o.bad) {
		free(o.buf);
		return "{\"err\":\"out of memory\"}";
	}
	arcade__last = o.buf;
	return o.buf;
}

/** The body of dispatch(); ARCADE_GAME / ARCADE_DISPATCH write the function. */
static inline const char *arcade__dispatch(const arcade_game *g, const char *call) {
	arcade__doc doc;
	arcade_val root, fnv;
	arcade_out o;
	char fn[16];
	char *by = NULL, *seat = NULL;
	arcade_seat *seats = NULL;
	int nseats = 0, ok, i, ran = 1;
	const char *answer;

	free(arcade__last);
	arcade__last = NULL;
	free(arcade__fail_msg);
	arcade__fail_msg = NULL;
	if (!call) return arcade__err("dispatch: no call", NULL, NULL);
	ok = arcade__parse(&doc, call, strlen(call));
	if (ok <= 0) {
		free(doc.nodes);
		return ok < 0 ? "{\"err\":\"out of memory\"}" : arcade__err("dispatch: the call is not JSON", NULL, NULL);
	}
	root.doc = &doc;
	root.i = 0;
	fnv = arcade_get(root, "fn");
	i = arcade_str(fnv, fn, sizeof fn);
	if (i < 0 || i >= (int)sizeof fn) fn[0] = 0; /* no rule has a longer name */

	memset(&o, 0, sizeof o);
	arcade__raw(&o, "{\"v\":", 5);
	if (arcade_type(arcade_get(root, "by")) == ARCADE_STRING) by = arcade_strdup(arcade_get(root, "by"));
	if (arcade_type(arcade_get(root, "seat")) == ARCADE_STRING) seat = arcade_strdup(arcade_get(root, "seat"));

	if (!strcmp(fn, "init") && g->init) {
		arcade_setup s;
		arcade_val list = arcade_get(root, "seats");
		long long seed = 0;
		int match = 0;
		nseats = arcade_len(list);
		if (nseats) seats = (arcade_seat *)calloc((size_t)nseats, sizeof *seats);
		if (nseats && !seats) o.bad = 2;
		for (i = 0; seats && i < nseats; i++) {
			arcade_val p = arcade_at(list, i);
			seats[i].id = arcade_strdup(arcade_get(p, "id"));
			seats[i].name = arcade_strdup(arcade_get(p, "name"));
			seats[i].team = arcade_strdup(arcade_get(p, "team"));
			seats[i].bot = arcade_bool(arcade_get(p, "bot"), 0);
		}
		arcade_int64(arcade_get(root, "seed"), &seed);
		arcade_int(arcade_get(root, "match"), &match);
		s.seats = seats;
		s.nseats = seats ? nseats : 0;
		s.opts = arcade_get(root, "opts");
		s.seed = seed;
		s.match = match;
		if (!o.bad) g->init(&s);
	} else if (!strcmp(fn, "apply") && g->apply) {
		const char *reason = g->apply(arcade_get(root, "action"), by);
		arcade_put_str(&o, reason);
	} else if (!strcmp(fn, "view") && g->view) {
		g->view(&o, seat);
	} else if (!strcmp(fn, "turn") && g->turn) {
		g->turn(&o);
	} else if (!strcmp(fn, "bot") && g->bot) {
		g->bot(&o, seat);
	} else if (!strcmp(fn, "result") && g->result) {
		g->result(&o);
	} else if (!strcmp(fn, "snapshot") && g->snapshot) {
		g->snapshot(&o);
	} else if (!strcmp(fn, "restore") && g->restore) {
		g->restore(arcade_get(root, "snapshot"));
	} else if (!strcmp(fn, "skip")) {
		arcade_put_bool(&o, g->skip ? g->skip(seat) != 0 : 0);
	} else if (!strcmp(fn, "tick") && g->tick) {
		g->tick(arcade_get(root, "inputs"), arcade_num(arcade_get(root, "dt"), 0));
	} else {
		ran = 0;
	}

	free(by);
	free(seat);
	for (i = 0; seats && i < nseats; i++) {
		free((void *)seats[i].id);
		free((void *)seats[i].name);
		free((void *)seats[i].team);
	}
	free(seats);

	if (!ran) {
		char name[16];
		int n = arcade_str(fnv, name, sizeof name);
		free(o.buf);
		free(doc.nodes);
		return arcade__err("no rule \"", n < 0 ? "undefined" : name, n >= (int)sizeof name ? "...\"" : "\"");
	}
	free(doc.nodes);
	if (arcade__fail_msg) {
		free(o.buf);
		answer = arcade__err(arcade__fail_msg, NULL, NULL);
		free(arcade__fail_msg);
		arcade__fail_msg = NULL;
		return answer;
	}
	if (o.bad == 2) { free(o.buf); return "{\"err\":\"out of memory\"}"; }
	if (o.bad || o.depth) { free(o.buf); return arcade__err(fn, ": the value it wrote is not one JSON value", NULL); }
	if (!o.values) arcade__raw(&o, "null", 4);
	arcade__raw(&o, "}", 2); /* with the NUL */
	if (o.bad) { free(o.buf); return "{\"err\":\"out of memory\"}"; }
	arcade__last = o.buf;
	return o.buf;
}

#ifdef __cplusplus
}
#endif

/** Defines `const char *dispatch(const char *call)` for an arcade_game. */
#define ARCADE_DISPATCH(game) \
	ARCADE_EXTERN_C ARCADE_EXPORT const char *dispatch(const char *call) { return arcade__dispatch(&(game), call); }

/** The game's rules, by name: ARCADE_GAME(.init = init, .apply = apply, ...). */
#define ARCADE_GAME(...) \
	static const arcade_game arcade__the_game = {__VA_ARGS__}; \
	ARCADE_DISPATCH(arcade__the_game)

#endif /* ARCADE_H */
