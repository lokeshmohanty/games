// Tic Tac Toe — SDK v2 managed state, in JavaScript (docs/sdk-v2.md).
//
// The whole game is its rules and a draw function. The platform runs the
// rules on the host, sends each phone its view, moves the bots, shows the
// turn-wait banner, reports the result, draws the end card with PLAY AGAIN,
// and hands the game to the heir if the host leaves. Compare ../tic-tac-toe,
// the same game written against the raw protocol (Layer 1).
//
// These rules are the conformance reference: the Rust, C, Go, Python,
// TypeScript and HTML versions must produce exactly the same views and
// results for the same moves (scripts/test-conformance.mjs).

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

// -- the view, on every phone ------------------------------------------------

const hud = document.getElementById("hud");
const grid = document.getElementById("ttt");
const cells = Array.from({ length: 9 }, (_, i) => {
	const b = document.createElement("button");
	b.setAttribute("aria-label", `square ${i + 1}`);
	b.onclick = () => arcade.act({ i });
	grid.append(b);
	return b;
});
const nameOf = (id) => arcade.party.members.find((m) => m.id === id)?.name ?? "Player";

// The last mark placed is ringed. The view does not say which it was, and it
// stays as the other six lanes have it (the conformance test compares them),
// so it is found here: the square that filled since the board drawn before.
let drawn = null; // the board drawn last
let last = -1; // the square holding the last mark, or -1 for none
function lastMark(v) {
	// A board that lost a mark is a new match: compare it with an empty one.
	const before = drawn && drawn.every((m, i) => !m || m === v.board[i]) ? drawn : null;
	const added = v.board.flatMap((m, i) => (m && !before?.[i] ? [i] : []));
	if (added.length === 1) return added[0];
	// A first sight of a game under way (a phone that joined late) has no
	// before to compare with: no ring rather than a guess.
	if (!before) return -1;
	if (!added.length) return last; // the same board again (a new host's first view)
	// Views missed: the mover's own new mark, if only one. The turn has passed
	// after every move, a winning one too.
	const mine = added.filter((i) => v.board[i] === 3 - v.turn);
	return mine.length === 1 ? mine[0] : -1;
}

arcade.on("view", ({ state: v }) => {
	last = lastMark(v);
	drawn = [...v.board];
	v.board.forEach((m, i) => {
		cells[i].textContent = m === 1 ? "X" : m === 2 ? "O" : "";
		cells[i].className = (m === 2 ? "o" : "") + (i === last ? " last" : "");
		cells[i].setAttribute("aria-label", `square ${i + 1}${i === last ? ", the last move" : ""}`);
	});
	const mover = v.turn === 1 ? v.x : v.o;
	hud.textContent = v.winner !== null ? "" : !v.you ? "SPECTATING" : v.turn === v.you ? "YOUR TURN" : `${nameOf(mover)} TO MOVE`;
});
arcade.on("rejected", (m) => arcade.toast(m.reason, "warn"));
arcade.debug = () => arcade.view; // for tests: { board, turn, winner, x, o, you }
