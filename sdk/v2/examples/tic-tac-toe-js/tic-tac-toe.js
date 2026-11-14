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

arcade.on("view", ({ state: v }) => {
	v.board.forEach((m, i) => {
		cells[i].textContent = m === 1 ? "X" : m === 2 ? "O" : "";
		cells[i].className = m === 2 ? "o" : "";
	});
	const mover = v.turn === 1 ? v.x : v.o;
	hud.textContent = v.winner !== null ? "" : !v.you ? "SPECTATING" : v.turn === v.you ? "YOUR TURN" : `${nameOf(mover)} TO MOVE`;
});
arcade.on("rejected", (m) => arcade.toast(m.reason, "warn"));
arcade.debug = () => arcade.view; // for tests: { board, turn, winner, x, o, you }
