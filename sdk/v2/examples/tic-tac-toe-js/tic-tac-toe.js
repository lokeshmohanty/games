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
/** The last mark's square in `board`, given the board drawn `before` and the square ringed then (`kept`). */
function lastMark(before, kept, board) {
	// A board that lost a mark is a new match: compare it with an empty one.
	const base = before && before.every((m, i) => !m || m === board[i]) ? before : null;
	const added = board.flatMap((m, i) => (m && !base?.[i] ? [i] : []));
	if (added.length === 1) return added[0];
	if (base && !added.length) return kept; // the same board again (a new host's first view)
	// Several new marks (views missed, a phone that joined a game under way):
	// which came last cannot be told, so no ring rather than a guess.
	return -1;
}

arcade.on("view", ({ state: v }) => {
	last = lastMark(drawn, last, v.board);
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
