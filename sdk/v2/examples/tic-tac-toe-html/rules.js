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

let s = null; // { board, turn, winner, x, o }
const markOf = (id) => (id === s.x ? 1 : id === s.o ? 2 : 0);
const idOf = (mark) => (mark === 1 ? s.x : s.o);

arcade.managed({
	init({ seats }) {
		const team = (t, i) => (seats.find((p) => p.team === t) ?? seats[i])?.id ?? null;
		s = { board: Array(9).fill(0), turn: 1, winner: null, x: team("A", 0), o: team("B", 1) };
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
	view: ({ seat }) => ({ ...s, board: [...s.board], you: seat ? markOf(seat) : 0 }),
	turn: () => (s.winner === null ? [idOf(s.turn)] : []),
	bot() {
		// Win if it can, block if it must, else the centre, else the first free.
		const free = s.board.flatMap((m, i) => (m ? [] : [i]));
		const wins = (mark) => free.find((i) => winnerOf(s.board.map((m, j) => (j === i ? mark : m))) === mark);
		const i = wins(s.turn) ?? wins(3 - s.turn) ?? (free.includes(4) ? 4 : free[0]);
		return i === undefined ? null : { i };
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
