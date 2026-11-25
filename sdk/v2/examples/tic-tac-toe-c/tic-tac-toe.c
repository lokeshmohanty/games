/* Tic Tac Toe — SDK v2 managed state, in C (docs/sdk-v2.md).
 *
 * The same rules as ../tic-tac-toe-js, the conformance reference: the
 * platform runs them on the host, sends each phone its view, moves the bots
 * and reports the result. arcade.h turns these functions into the one
 * `dispatch(json) -> json` the page's glue hands to arcade.managedJson.
 * Build with ./build.sh. */
#include <string.h>
#include "arcade.h"

static const int LINES[8][3] = {{0, 1, 2}, {3, 4, 5}, {6, 7, 8}, {0, 3, 6}, {1, 4, 7}, {2, 5, 8}, {0, 4, 8}, {2, 4, 6}};
#define RUNNING (-1) /* winner while the game goes on; 0 is a draw, 1 X, 2 O */

static struct {
	int board[9]; /* 0 empty, 1 X, 2 O */
	int turn;     /* 1 or 2 */
	int winner;
	char *x, *o; /* the players' ids; NULL when nobody sits there */
	long long seed; /* the bot's, for equal squares: in the snapshot, not the view */
} s = {{0}, 1, RUNNING, NULL, NULL, 0};

/* Which of n equal squares the bot takes: one Park-Miller step over the
 * match's seed and the marks on the board, the same in every lane. */
static int pick_of(long long seed, int marks, int n) {
	long long x = (seed < 0 ? -seed : seed) % 2147483647LL + marks + 1;
	return (int)(x * 48271LL % 2147483647LL % n);
}

static int winner_of(const int *b) {
	int k, i;
	for (k = 0; k < 8; k++) {
		int m = b[LINES[k][0]];
		if (m && m == b[LINES[k][1]] && m == b[LINES[k][2]]) return m;
	}
	for (i = 0; i < 9; i++)
		if (!b[i]) return RUNNING;
	return 0;
}
static int same(const char *a, const char *b) { return a && b && !strcmp(a, b); }
static int mark_of(const char *id) { return same(id, s.x) ? 1 : same(id, s.o) ? 2 : 0; }
static const char *id_of(int mark) { return mark == 1 ? s.x : s.o; }
static void seat_ids(char *x, char *o) {
	free(s.x);
	free(s.o);
	s.x = x;
	s.o = o;
}

/* The seat on team t, else seats[i]: its id, or NULL. */
static const char *team(const arcade_setup *setup, const char *t, int i) {
	int k;
	for (k = 0; k < setup->nseats; k++)
		if (same(setup->seats[k].team, t)) return setup->seats[k].id;
	return i < setup->nseats ? setup->seats[i].id : NULL;
}

static void init(const arcade_setup *setup) {
	memset(s.board, 0, sizeof s.board);
	s.turn = 1;
	s.winner = RUNNING;
	s.seed = setup->seed;
	seat_ids(arcade_dup(team(setup, "A", 0)), arcade_dup(team(setup, "B", 1)));
	/* The platform's first moves first: it takes turns between rematches
	 * (docs/sdk-v2.md "Who starts"). X otherwise, as from an older shell. */
	if (same(setup->first, s.o)) s.turn = 2;
}

static const char *apply(arcade_val action, const char *by) {
	int i;
	if (s.winner != RUNNING) return "the game is over";
	if (mark_of(by) != s.turn) return "not your turn";
	if (!arcade_int(arcade_get(action, "i"), &i) || i < 0 || i > 8 || s.board[i]) return "that square is taken";
	s.board[i] = s.turn;
	s.turn = 3 - s.turn;
	s.winner = winner_of(s.board);
	return NULL;
}

/* The state, as the view and the snapshot share it: board, turn, winner, x, o. */
static void put_state(arcade_out *o) {
	int i;
	arcade_key(o, "board");
	arcade_begin_arr(o);
	for (i = 0; i < 9; i++) arcade_put_int(o, s.board[i]);
	arcade_end(o);
	arcade_key(o, "turn");
	arcade_put_int(o, s.turn);
	arcade_key(o, "winner");
	if (s.winner == RUNNING) arcade_put_null(o);
	else arcade_put_int(o, s.winner);
	arcade_key(o, "x");
	arcade_put_str(o, s.x); /* NULL writes null */
	arcade_key(o, "o");
	arcade_put_str(o, s.o);
}

static void view(arcade_out *o, const char *seat) {
	arcade_begin_obj(o);
	put_state(o);
	arcade_key(o, "you");
	arcade_put_int(o, seat ? mark_of(seat) : 0);
	arcade_end(o);
}

static void turn(arcade_out *o) {
	arcade_begin_arr(o);
	if (s.winner == RUNNING) arcade_put_str(o, id_of(s.turn));
	arcade_end(o);
}

/* The free squares where `mark` would win, into out: how many. */
static int wins(int mark, int *out) {
	int i, n = 0, b[9];
	for (i = 0; i < 9; i++) {
		if (s.board[i]) continue;
		memcpy(b, s.board, sizeof b);
		b[i] = mark;
		if (winner_of(b) == mark) out[n++] = i;
	}
	return n;
}

/* Win if it can, block if it must, else the centre, else any free square;
 * between equal squares, one picked from the seed (pick_of). */
static void bot(arcade_out *o, const char *seat) {
	int take[9], n, i, marks = 0;
	(void)seat;
	for (i = 0; i < 9; i++) marks += s.board[i] != 0;
	n = wins(s.turn, take);
	if (!n) n = wins(3 - s.turn, take);
	if (!n && !s.board[4]) take[n++] = 4;
	if (!n)
		for (i = 0; i < 9; i++)
			if (!s.board[i]) take[n++] = i;
	if (!n) return; /* nothing written: null, no move */
	i = take[pick_of(s.seed, marks, n)];
	arcade_begin_obj(o);
	arcade_key(o, "i");
	arcade_put_int(o, i);
	arcade_end(o);
}

static void result(arcade_out *o) {
	if (s.winner == RUNNING) return; /* null: still going */
	arcade_begin_obj(o);
	arcade_key(o, "kind");
	arcade_put_str(o, "duel");
	arcade_key(o, "ranking");
	arcade_begin_arr(o);
	if (s.winner == 0) {
		arcade_begin_arr(o);
		arcade_put_str(o, s.x);
		arcade_put_str(o, s.o);
		arcade_end(o);
	} else {
		arcade_begin_arr(o);
		arcade_put_str(o, id_of(s.winner));
		arcade_end(o);
		arcade_begin_arr(o);
		arcade_put_str(o, id_of(3 - s.winner));
		arcade_end(o);
	}
	arcade_end(o);
	arcade_end(o);
}

static int skip(const char *seat) {
	(void)seat;
	s.turn = 3 - s.turn;
	return 1;
}

static void snapshot(arcade_out *o) {
	arcade_begin_obj(o);
	put_state(o);
	arcade_key(o, "seed");
	arcade_put_int(o, s.seed);
	arcade_end(o);
}

static void restore(arcade_val snap) {
	int board[9], i, turn = 0, winner = RUNNING;
	arcade_val b = arcade_get(snap, "board"), w = arcade_get(snap, "winner");
	for (i = 0; i < 9; i++)
		if (arcade_len(b) != 9 || !arcade_int(arcade_at(b, i), &board[i]) || board[i] < 0 || board[i] > 2) break;
	if (i < 9 || !arcade_int(arcade_get(snap, "turn"), &turn) || turn < 1 || turn > 2 ||
	    (arcade_type(w) != ARCADE_NULL && (!arcade_int(w, &winner) || winner < 0 || winner > 2))) {
		arcade_fail("restore: not a snapshot of this game");
		return;
	}
	memcpy(s.board, board, sizeof board);
	s.turn = turn;
	s.winner = winner;
	if (!arcade_int64(arcade_get(snap, "seed"), &s.seed)) s.seed = 0; /* a snapshot from before the seed */
	seat_ids(arcade_strdup(arcade_get(snap, "x")), arcade_strdup(arcade_get(snap, "o")));
}

ARCADE_GAME(.init = init, .apply = apply, .view = view, .turn = turn, .bot = bot, .result = result,
            .snapshot = snapshot, .restore = restore, .skip = skip)
