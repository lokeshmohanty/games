// games/connect4/connect4.js — Connect 4, an SDK v2 managed game.
//
// The game is its rules and a canvas. The platform (lib/sdk-managed.js) runs
// the rules on the host, sends each phone its view, plays the bot seat with
// `bot()`, shows the turn-wait banner, reports the result, draws the end
// card with PLAY AGAIN, and hands the board to the heir if the host leaves.
// (The v1 version wrote all of that by hand: 576 lines.)
//
// Seats come from the party's teams: Team A plays red, Team B yellow.

const COLS = 7;
const ROWS = 6;
const RED = 1;
const YELLOW = 2;

// ------------------------------------------------------------------ rules

const emptyBoard = () => Array.from({ length: ROWS }, () => Array(COLS).fill(0));
const dropRowIn = (board, col) => {
	for (let r = ROWS - 1; r >= 0; r--) if (board[r][col] === 0) return r;
	return -1;
};
function checkWin(board, row, col, player) {
	for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
		let count = 1;
		for (const sign of [1, -1]) {
			for (let d = 1; d < 4; d++) {
				const r = row + dr * d * sign;
				const c = col + dc * d * sign;
				if (r < 0 || r >= ROWS || c < 0 || c >= COLS || board[r][c] !== player) break;
				count++;
			}
		}
		if (count >= 4) return true;
	}
	return false;
}
const isDraw = (board) => board[0].every((v) => v !== 0);

// The bot: plain minimax with alpha-beta over a 7x6 board, small enough that
// a full-width search to five plies finishes well inside a frame. Five sees
// a double threat being built two moves out, which is where Connect 4 is
// won, while stopping short of a solved game's deadening perfection.
const BOT_DEPTH = 5;
// Centre-out: alpha-beta prunes far more when the likely-best move comes first.
const BOT_ORDER = [3, 2, 4, 1, 5, 0, 6];
// Every 4-in-a-row line, computed once: the evaluation walks these.
const WINDOWS = (() => {
	const out = [];
	for (let r = 0; r < ROWS; r++) {
		for (let c = 0; c < COLS; c++) {
			if (c + 3 < COLS) out.push([[r, c], [r, c + 1], [r, c + 2], [r, c + 3]]);
			if (r + 3 < ROWS) out.push([[r, c], [r + 1, c], [r + 2, c], [r + 3, c]]);
			if (r + 3 < ROWS && c + 3 < COLS) out.push([[r, c], [r + 1, c + 1], [r + 2, c + 2], [r + 3, c + 3]]);
			if (r + 3 < ROWS && c - 3 >= 0) out.push([[r, c], [r + 1, c - 1], [r + 2, c - 2], [r + 3, c - 3]]);
		}
	}
	return out;
})();

/** A quiet position's worth, from `me`'s side. */
function evaluate(board, me) {
	const foe = me === RED ? YELLOW : RED;
	let score = 0;
	for (let r = 0; r < ROWS; r++) if (board[r][3] === me) score += 6; // the centre takes part in most lines
	for (const w of WINDOWS) {
		let mine = 0;
		let theirs = 0;
		for (const [r, c] of w) {
			if (board[r][c] === me) mine++;
			else if (board[r][c] === foe) theirs++;
		}
		if (mine && theirs) continue; // a line both colours sit in is dead
		if (mine === 3) score += 50;
		else if (mine === 2) score += 8;
		else if (theirs === 3) score -= 60;
		else if (theirs === 2) score -= 8;
	}
	return score;
}

/** Minimax with alpha-beta, scored from `me`'s side; `board` is restored in place. */
function search(board, depth, alpha, beta, turn, me) {
	const cols = BOT_ORDER.filter((c) => board[0][c] === 0);
	if (!cols.length) return 0;
	const maximising = turn === me;
	let best = maximising ? -Infinity : Infinity;
	for (const c of cols) {
		const r = dropRowIn(board, c);
		board[r][c] = turn;
		let value;
		// Depth is added so a sooner win outranks a later one, and a loss is
		// postponed rather than walked into.
		if (checkWin(board, r, c, turn)) value = maximising ? 10000 + depth : -10000 - depth;
		else if (depth === 0) value = evaluate(board, me);
		else value = search(board, depth - 1, alpha, beta, turn === RED ? YELLOW : RED, me);
		board[r][c] = 0;
		if (maximising) {
			best = Math.max(best, value);
			alpha = Math.max(alpha, best);
		} else {
			best = Math.min(best, value);
			beta = Math.min(beta, best);
		}
		if (alpha >= beta) break;
	}
	return best;
}

/** The column the side `me` plays. Never a full column. */
function chooseColumn(board0, me) {
	const board = board0.map((row) => [...row]);
	const cols = BOT_ORDER.filter((c) => board[0][c] === 0);
	let bestCol = cols[0];
	let bestValue = -Infinity;
	for (const c of cols) {
		const r = dropRowIn(board, c);
		board[r][c] = me;
		const value = checkWin(board, r, c, me) ? Infinity : search(board, BOT_DEPTH - 1, -Infinity, Infinity, me === RED ? YELLOW : RED, me);
		board[r][c] = 0;
		if (value > bestValue) {
			bestValue = value;
			bestCol = c;
		}
	}
	return bestCol;
}

let s = null; // { match, board, turn, winner, started, red, yellow }
const colourOf = (id) => (id === s.red ? RED : id === s.yellow ? YELLOW : 0);
const idOf = (colour) => (colour === RED ? s.red : s.yellow);

arcade.managed({
	init({ seats, match }) {
		const team = (t, i) => (seats.find((p) => p.team === t) ?? seats[i])?.id ?? null;
		s = { match: match + 1, board: emptyBoard(), turn: RED, winner: null, started: true, red: team("A", 0), yellow: team("B", 1) };
	},
	apply({ action, by }) {
		const col = action?.col;
		if (s.winner !== null) return "the game is over";
		if (colourOf(by) !== s.turn) return "not your turn";
		if (!Number.isInteger(col) || col < 0 || col >= COLS) return "no such column";
		const row = dropRowIn(s.board, col);
		if (row < 0) return "that column is full";
		s.board[row][col] = s.turn;
		if (checkWin(s.board, row, col, s.turn)) s.winner = s.turn;
		else if (isDraw(s.board)) s.winner = 0;
		else s.turn = s.turn === RED ? YELLOW : RED;
	},
	view: ({ seat }) => ({ ...s, board: s.board.map((r) => [...r]), you: seat ? colourOf(seat) : 0 }),
	turn: () => (s.winner === null && s.red && s.yellow ? [idOf(s.turn)] : []),
	bot: () => ({ col: chooseColumn(s.board, s.turn) }),
	result() {
		if (s.winner === null) return null;
		const places = (...slots) => slots.map((x) => x.filter(Boolean)).filter((x) => x.length);
		const ranking = s.winner === 0 ? places([s.red, s.yellow]) : places([idOf(s.winner)], [idOf(s.winner === RED ? YELLOW : RED)]);
		return { kind: "duel", ranking };
	},
	skip() {
		s.turn = s.turn === RED ? YELLOW : RED;
		return true;
	},
	// A seated player left the party for good: the one still sitting wins.
	leave({ seat }) {
		const gone = colourOf(seat);
		if (!gone || s.winner !== null) return false;
		s.winner = gone === RED ? YELLOW : RED;
		return true;
	},
	snapshot: () => s,
	restore({ snapshot }) {
		s = snapshot;
	},
});

// ------------------------------------------------------------- the board

const style = document.createElement("style");
style.textContent = `
	#game { position: absolute; inset: 0; display: flex; flex-direction: column;
		align-items: center; justify-content: center; gap: 12px; padding: 12px; }
	#hud { font-size: clamp(0.9rem, 3vw, 1.2rem); color: var(--accent);
		text-shadow: 0 0 8px var(--accent-glow); text-align: center; min-height: 1.5em; }
	#hud .you-red { color: var(--p1); text-shadow: 0 0 8px var(--glow); }
	#hud .you-yellow { color: var(--p2); text-shadow: 0 0 8px var(--glow); }
	#hud .you-spec { color: var(--muted); }
	#board { border: 3px solid var(--rule); border-radius: 12px;
		box-shadow: 0 0 30px var(--glow); max-width: 95vw; max-height: 70vh; }
`;
document.head.append(style);
const hudEl = document.getElementById("hud");
const canvas = document.getElementById("board");
const c2d = canvas.getContext("2d");
let view = null;
let hoverCol = -1;

/** "rgba(r, g, b, a)" with its alpha replaced. */
const alpha = (rgba, a) => rgba.replace(/,\s*[\d.]+\)$/, `, ${a})`);

function resize() {
	const maxW = Math.min(window.innerWidth - 24, 560);
	const maxH = window.innerHeight - 140;
	const cell = Math.max(20, Math.floor(Math.min(maxW / COLS, maxH / ROWS)));
	canvas.width = cell * COLS;
	canvas.height = cell * ROWS;
	draw();
}

const myTurn = () => view && view.winner === null && view.you && view.turn === view.you;

function draw() {
	const t = arcade.theme;
	if (!t || !view) return;
	const { tokens, players } = t;
	const glows = !/,\s*0\)$/.test(tokens.glow ?? ", 0)");
	const cell = canvas.width / COLS;
	c2d.fillStyle = tokens.surface2;
	c2d.fillRect(0, 0, canvas.width, canvas.height);
	if (hoverCol >= 0 && hoverCol < COLS && myTurn()) {
		c2d.fillStyle = alpha(tokens.accent, 0.12);
		c2d.fillRect(hoverCol * cell, 0, cell, canvas.height);
	}
	for (let r = 0; r < ROWS; r++) {
		for (let c = 0; c < COLS; c++) {
			const v = view.board[r][c];
			c2d.beginPath();
			c2d.arc(c * cell + cell / 2, r * cell + cell / 2, cell * 0.4, 0, Math.PI * 2);
			if (v === 0) {
				c2d.fillStyle = tokens.bg;
				c2d.fill();
			} else {
				const colour = players[v === RED ? 0 : 1];
				c2d.shadowBlur = glows ? 15 : 0;
				c2d.shadowColor = colour;
				c2d.fillStyle = colour;
				c2d.fill();
				c2d.shadowBlur = 0;
			}
		}
	}
}

function updateHud() {
	if (!view) return;
	const mine = view.you;
	const tag = document.createElement("span");
	tag.className = mine === RED ? "you-red" : mine === YELLOW ? "you-yellow" : "you-spec";
	tag.textContent = mine === RED ? "RED" : mine === YELLOW ? "YELLOW" : "SPECTATOR";
	let msg = "";
	if (view.winner !== null) msg = view.winner === 0 ? " — DRAW" : view.winner === mine ? " — YOU WIN!" : mine ? " — YOU LOSE" : "";
	else if (!view.red || !view.yellow) msg = " — Waiting for opponent…";
	else if (mine) msg = view.turn === mine ? " — YOUR TURN" : " — Opponent's turn";
	hudEl.replaceChildren(tag, document.createTextNode(msg));
}

const colAt = (clientX) => {
	const rect = canvas.getBoundingClientRect();
	return Math.floor((clientX - rect.left) / (rect.width / COLS));
};
function play(clientX) {
	const col = colAt(clientX);
	if (myTurn() && col >= 0 && col < COLS) arcade.act({ col });
}
canvas.addEventListener("click", (e) => play(e.clientX));
canvas.addEventListener("touchstart", (e) => {
	play(e.touches[0].clientX);
	e.preventDefault();
}, { passive: false });
canvas.addEventListener("mousemove", (e) => {
	const col = colAt(e.clientX);
	if (col !== hoverCol) {
		hoverCol = col;
		draw();
	}
});
canvas.addEventListener("mouseleave", () => {
	hoverCol = -1;
	draw();
});
addEventListener("resize", resize);
arcade.on("theme.set", draw);
arcade.on("view", ({ state }) => {
	view = state;
	draw();
	updateHud();
});
arcade.on("rejected", (m) => arcade.toast(m.reason, "warn"));
arcade.init.then(resize);

/** The board as every phone sees it, for the tests: { board, turn, winner, started, red, yellow, match, you }. */
arcade.debug = () => view ?? { started: false, board: [] };
