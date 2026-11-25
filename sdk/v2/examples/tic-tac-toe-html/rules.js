// Tic Tac Toe's rules — the HTML/CSS lane (docs/sdk-v2.md "Managed state").
//
// The same rules as ../tic-tac-toe-js (copied: they are the conformance
// reference). There is no rendering code: index.html binds to the view with
// data-arcade-* attributes and tic-tac-toe.css draws the marks.

const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
const winnerOf = (b) => {
	for (const [x, y, z] of LINES) if (b[x] && b[x] === b[y] && b[x] === b[z]) return b[x];
	return b.every(Boolean) ? 0 : null; // 0: a draw; null: still going
};
// Which of `n` equal squares the bot takes: one Park–Miller step over the
// match's seed and the marks on the board — the same in every lane, and
// exact in a double (the product stays under 2^53).
const pickOf = (seed, marks, n) => ((((Math.abs(seed) % 2147483647) + marks + 1) * 48271) % 2147483647) % n;

let s = null; // { board, turn, winner, x, o, seed } — the seed is the bot's, not in the view
const markOf = (id) => (id === s.x ? 1 : id === s.o ? 2 : 0);
const idOf = (mark) => (mark === 1 ? s.x : s.o);

arcade.managed({
	init({ seats, seed, first }) {
		const team = (t, i) => (seats.find((p) => p.team === t) ?? seats[i])?.id ?? null;
		s = { board: Array(9).fill(0), turn: 1, winner: null, x: team("A", 0), o: team("B", 1), seed: Number(seed) || 0 };
		// The platform's `first` moves first: it takes turns between rematches
		// (docs/sdk-v2.md "Who starts"). X otherwise, as from an older shell.
		if (first && first === s.o) s.turn = 2;
	},
	apply({ action, by }) {
		const i = action?.i;
		if (s.winner !== null) return "the game is over";
		if (markOf(by) !== s.turn) return "not your turn";
		if (!Number.isInteger(i) || i < 0 || i > 8 || s.board[i]) return "that square is taken";
		s.board[i] = s.turn;
		s.turn = 3 - s.turn;
		s.winner = winnerOf(s.board);
	},
	view: ({ seat }) => {
		const { seed, ...shown } = s;
		return { ...shown, board: [...s.board], you: seat ? markOf(seat) : 0 };
	},
	turn: () => (s.winner === null ? [idOf(s.turn)] : []),
	bot() {
		// Win if it can, block if it must, else the centre, else any free
		// square; between equal squares, one picked from the seed (pickOf).
		const free = s.board.flatMap((m, i) => (m ? [] : [i]));
		const wins = (mark) => free.filter((i) => winnerOf(s.board.map((m, j) => (j === i ? mark : m))) === mark);
		const take = [wins(s.turn), wins(3 - s.turn), free.includes(4) ? [4] : [], free].find((c) => c.length);
		return take ? { i: take[pickOf(s.seed ?? 0, 9 - free.length, take.length)] } : null;
	},
	result() {
		if (s.winner === null) return null;
		if (s.winner === 0) return { kind: "duel", ranking: [[s.x, s.o]] };
		return { kind: "duel", ranking: [[idOf(s.winner)], [idOf(3 - s.winner)]] };
	},
	skip() {
		s.turn = 3 - s.turn;
		return true;
	},
	snapshot: () => s,
	restore({ snapshot }) {
		s = snapshot;
	},
});

arcade.debug = () => arcade.view; // for tests
