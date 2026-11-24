// games/connect4/connect4.js — Connect 4, an SDK v2 managed game.
//
// The game is its rules and a canvas. The platform (lib/sdk-managed.js) runs
// the rules on the host, sends each phone its view, plays the bot seat with
// `bot()`, shows the turn-wait banner, reports the result, draws the end
// card with PLAY AGAIN, and hands the board to the heir if the host leaves.
// (The v1 version wrote all of that by hand: 576 lines.)
//
// Seats come from the party's teams: Team A plays red, Team B yellow. Those
// are the sides' names in the rules; each side's discs are drawn in its
// player's own colour (docs/sdk-v2.md "Seat colours": the party's picker),
// which is red and yellow for nobody having picked.

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
/** The cells of `player`'s winning line through (row, col), as "a1" (column, row from the bottom). */
function winLine(board, row, col, player) {
	for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
		const cells = [[row, col]];
		for (const sign of [1, -1]) {
			for (let d = 1; ; d++) {
				const r = row + dr * d * sign;
				const c = col + dc * d * sign;
				if (r < 0 || r >= ROWS || c < 0 || c >= COLS || board[r][c] !== player) break;
				cells[sign > 0 ? "push" : "unshift"]([r, c]);
			}
		}
		if (cells.length >= 4) return cells.sort((a, b) => a[1] - b[1] || b[0] - a[0]).map(([r, c]) => `${"abcdefg"[c]}${ROWS - r}`);
	}
	return null;
}

// The bot: plain minimax with alpha-beta over a 7x6 board, a full-width
// search to five plies. Five sees a double threat being built two moves out,
// which is where Connect 4 is won, while stopping short of a solved game's
// deadening perfection.
//
// It does not fit in a frame on a phone: in one go it held the frame for
// 63-174 ms a move on a OnePlus (2026-11-15), 90-135 ms at 4x CPU here. So
// the same search runs in slices (`sliced`): a generator that yields every
// SLICE_MS, continued on the next macrotask, and `bot()` returns a promise
// of its move, which the runtime awaits (docs/sdk-v2.md "Managed state").
// The search and its answer are unchanged; only when it runs is.
const BOT_DEPTH = 5;
const SLICE_MS = 8; // the longest stretch the search keeps the frame
let sliceEnd = Infinity; // when the running slice should yield
let nodes = 0; // positions searched; the clock is read every 64th
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

/**
 * Minimax with alpha-beta, scored from `me`'s side; `board` is restored in
 * place. A generator: it pauses (yield) when the slice is spent, and returns
 * the value.
 */
function* search(board, depth, alpha, beta, turn, me) {
	if ((++nodes & 63) === 0 && performance.now() >= sliceEnd) yield;
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
		else value = yield* search(board, depth - 1, alpha, beta, turn === RED ? YELLOW : RED, me);
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

/** The column the side `me` plays. Never a full column. A generator, as `search`. */
function* columnFor(board0, me) {
	const board = board0.map((row) => [...row]);
	const cols = BOT_ORDER.filter((c) => board[0][c] === 0);
	let bestCol = cols[0];
	let bestValue = -Infinity;
	for (const c of cols) {
		const r = dropRowIn(board, c);
		board[r][c] = me;
		const value = checkWin(board, r, c, me) ? Infinity : yield* search(board, BOT_DEPTH - 1, -Infinity, Infinity, me === RED ? YELLOW : RED, me);
		board[r][c] = 0;
		if (value > bestValue) {
			bestValue = value;
			bestCol = c;
		}
	}
	return bestCol;
}

/**
 * Run generator `gen` in slices of SLICE_MS, each its own macrotask (a
 * MessageChannel message: no setTimeout's 4 ms clamp), so the frame can draw
 * and take taps between them. Resolves to what it returns.
 */
function sliced(gen) {
	return new Promise((done, fail) => {
		const ch = new MessageChannel();
		const step = () => {
			sliceEnd = performance.now() + SLICE_MS;
			try {
				const r = gen.next();
				if (!r.done) return ch.port2.postMessage(0);
				ch.port1.close();
				done(r.value);
			} catch (err) {
				ch.port1.close();
				fail(err);
			} finally {
				sliceEnd = Infinity;
			}
		};
		ch.port1.onmessage = step;
		step();
	});
}

/** The column the side `me` plays, without holding the frame: a promise. */
const chooseColumn = (board, me) => sliced(columnFor(board, me));

let s = null; // { match, board, turn, winner, started, red, yellow, moves, line, last }
const colourOf = (id) => (id === s.red ? RED : id === s.yellow ? YELLOW : 0);
const idOf = (colour) => (colour === RED ? s.red : s.yellow);

arcade.managed({
	init({ seats, match, first }) {
		const team = (t, i) => (seats.find((p) => p.team === t) ?? seats[i])?.id ?? null;
		s = { match: match + 1, board: emptyBoard(), turn: RED, winner: null, started: true, red: team("A", 0), yellow: team("B", 1), moves: 0, line: null, last: null };
		// Who drops first: the platform's `first`, which takes turns between
		// rematches (docs/sdk-v2.md "Who starts"). Red stays red; only the
		// opening move changes hands. An older shell sends none: red starts.
		if (first && first === s.yellow) s.turn = YELLOW;
	},
	apply({ action, by }) {
		const col = action?.col;
		if (s.winner !== null) return "the game is over";
		if (colourOf(by) !== s.turn) return "not your turn";
		if (!Number.isInteger(col) || col < 0 || col >= COLS) return "no such column";
		const row = dropRowIn(s.board, col);
		if (row < 0) return "that column is full";
		s.board[row][col] = s.turn;
		s.moves = (s.moves ?? 0) + 1;
		s.last = [row, col]; // the disc dropped last, ringed on every phone
		if (checkWin(s.board, row, col, s.turn)) {
			s.winner = s.turn;
			s.line = winLine(s.board, row, col, s.turn);
		}
		else if (isDraw(s.board)) s.winner = 0;
		else s.turn = s.turn === RED ? YELLOW : RED;
	},
	view: ({ seat }) => ({ ...s, board: s.board.map((r) => [...r]), you: seat ? colourOf(seat) : 0 }),
	turn: () => (s.winner === null && s.red && s.yellow ? [idOf(s.turn)] : []),
	// A promise: the runtime awaits it, and the platform's queue holds every
	// other rules call until it settles, so `s` cannot change under it.
	bot: async () => ({ col: await chooseColumn(s.board, s.turn) }),
	result() {
		if (s.winner === null) return null;
		const places = (...slots) => slots.map((x) => x.filter(Boolean)).filter((x) => x.length);
		const ranking = s.winner === 0 ? places([s.red, s.yellow]) : places([idOf(s.winner)], [idOf(s.winner === RED ? YELLOW : RED)]);
		// The end card's DETAILS (docs/sdk-v2.md, result `details`).
		const details = [{ label: "Moves played", value: s.moves ?? 0 }];
		if (s.line) details.push({ label: "Winning line", value: s.line.join(" ") });
		return { kind: "duel", ranking, details };
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
	#hud .you-side { text-shadow: 0 0 8px var(--glow); }
	#hud .you-spec { color: var(--muted); }
	#moved { font-size: clamp(0.8rem, 2.6vw, 1rem); color: var(--muted); min-height: 1.4em; text-align: center; }
	#board { box-sizing: content-box; border: 3px solid var(--rule); border-radius: 12px;
		box-shadow: 0 0 30px var(--glow); }
`;
document.head.append(style);
const hudEl = document.getElementById("hud");
// The last move in words, for anyone who cannot see the ring: "Yellow dropped
// in column 6". Said for a move this phone sees made; a first view says nothing.
const movedEl = document.getElementById("moved");
const canvas = document.getElementById("board");
const c2d = canvas.getContext("2d");
let view = null;
let hoverCol = -1;
// The last move: the disc in view.last is ringed in the accent with a dot at
// its heart — a shape as well as a colour, so it reads in every theme and
// without colour. A move this phone sees made falls into place first (`drop`);
// a first view (a joiner, a new host's frame), a rematch, a jump of several
// moves, or reduced motion draws the ring at once.
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
const FALL_MS = 260; // the longest fall, top row to bottom
const SETTLE_MS = 220; // the ring's pulse as it lands
let drop = null; // { row, col, t0, fall } while a disc falls and settles
let drops = 0; // falls started, for the tests
let marked = null; // [row, col] the ring was last painted on, for the tests
let raf = 0;

/** "rgba(r, g, b, a)" with its alpha replaced. */
const alpha = (rgba, a) => rgba.replace(/,\s*[\d.]+\)$/, `, ${a})`);

// The board is cell x 7 by cell x 6 CSS px; its backing store holds dpr times
// that a side, so a phone's screen draws it sharp (at 1x it was blurry on a
// DPR-3.5 OnePlus, 2026-11-15). DPR is capped at 3, as Neon Fission's: past
// that the fill grows and the eye cannot tell. Drawing and hit-testing stay in
// CSS px; only the transform knows about dpr.
const DPR_MAX = 3;
let cell = 20; // CSS px per cell
let dpr = 1; // backing pixels per CSS px
// The size is set here and only here: a CSS max-width/max-height on #board
// squeezed one axis of it (at 1280x650, 70vh made it 553x455, discs 4% wide,
// review 2026-11-19), so its old limits (95vw, 70vh) are in these sums.
function resize() {
	const maxW = Math.min(window.innerWidth - 24, window.innerWidth * 0.95, 560);
	const maxH = Math.min(window.innerHeight - 176, window.innerHeight * 0.7); // 176: the HUD, the move line under the board, the gaps
	cell = Math.max(20, Math.floor(Math.min(maxW / COLS, maxH / ROWS)));
	dpr = Math.min(window.devicePixelRatio || 1, DPR_MAX);
	canvas.style.width = `${cell * COLS}px`;
	canvas.style.height = `${cell * ROWS}px`;
	canvas.width = Math.round(cell * COLS * dpr);
	canvas.height = Math.round(cell * ROWS * dpr);
	c2d.setTransform(dpr, 0, 0, dpr, 0, 0);
	draw();
}

// Each side's colour, an index into the theme's players: its player's pick,
// never the other side's (sdk/v2/runtime.js seatColors); the theme's first
// two, red and yellow, on an older shell or before anyone picks.
let sideCols = [0, 1];
const sideIdx = (v) => sideCols[v === RED ? 0 : 1];
// And each side's mark, so the two never differ by colour alone (picked
// colours can be close, or one under colour blindness: review, 2026-11-24):
// red's discs are solid, yellow's have a hollow centre.
const MARKS = ["solid", "ring"];
const GLYPHS = ["●", "◎"];
/** Punch yellow's hollow into the disc just filled at (x, y). */
function mark(v, x, y, tokens) {
	if (v !== YELLOW) return;
	c2d.beginPath();
	c2d.arc(x, y, cell * 0.17, 0, Math.PI * 2);
	c2d.fillStyle = tokens.bg;
	c2d.fill();
}
/** "Red", "Blue"…: a side's colour in this theme's words. */
const sideName = (v) => arcade.theme?.playerNames?.[sideIdx(v)] ?? (v === RED ? "Red" : "Yellow");

const myTurn = () => view && view.winner === null && view.you && view.turn === view.you;

function draw() {
	const t = arcade.theme;
	if (!t || !view) return;
	const { tokens, players } = t;
	const glows = !/,\s*0\)$/.test(tokens.glow ?? ", 0)");
	const W = cell * COLS;
	const H = cell * ROWS;
	// Where the falling disc is: p (0..1) of its fall, then q (0..1) of the settle.
	const at = drop ? performance.now() - drop.t0 : 0;
	if (drop && at >= drop.fall + SETTLE_MS) drop = null;
	const falling = drop && at < drop.fall;
	c2d.fillStyle = tokens.surface2;
	c2d.fillRect(0, 0, W, H);
	if (hoverCol >= 0 && hoverCol < COLS && myTurn()) {
		c2d.fillStyle = alpha(tokens.accent, 0.12);
		c2d.fillRect(hoverCol * cell, 0, cell, H);
	}
	for (let r = 0; r < ROWS; r++) {
		for (let c = 0; c < COLS; c++) {
			const v = falling && r === drop.row && c === drop.col ? 0 : view.board[r][c];
			c2d.beginPath();
			c2d.arc(c * cell + cell / 2, r * cell + cell / 2, cell * 0.4, 0, Math.PI * 2);
			if (v === 0) {
				c2d.fillStyle = tokens.bg;
				c2d.fill();
			} else {
				const colour = players[sideIdx(v)];
				c2d.shadowBlur = glows ? 15 * dpr : 0; // backing px: shadowBlur ignores the transform
				c2d.shadowColor = colour;
				c2d.fillStyle = colour;
				c2d.fill();
				c2d.shadowBlur = 0;
				mark(v, c * cell + cell / 2, r * cell + cell / 2, tokens);
			}
		}
	}
	const last = view.last;
	marked = null;
	if (!last || view.board[last[0]]?.[last[1]] == null) return;
	const [row, col] = last;
	const cx = col * cell + cell / 2;
	const cy = row * cell + cell / 2;
	if (falling) {
		// Gravity: from above the board to its row, quickening.
		const p = at / drop.fall;
		const y = -cell / 2 + (cy + cell / 2) * p * p;
		c2d.beginPath();
		c2d.arc(cx, y, cell * 0.4, 0, Math.PI * 2);
		c2d.fillStyle = players[sideIdx(view.board[row][col])];
		c2d.fill();
		mark(view.board[row][col], cx, y, tokens);
		return again();
	}
	marked = [row, col];
	c2d.shadowBlur = glows ? 8 * dpr : 0;
	c2d.shadowColor = tokens.accent;
	c2d.lineWidth = Math.max(2, cell * 0.06);
	c2d.strokeStyle = tokens.accent;
	c2d.beginPath();
	c2d.arc(cx, cy, cell * 0.455, 0, Math.PI * 2);
	c2d.stroke();
	c2d.shadowBlur = 0;
	c2d.beginPath();
	c2d.arc(cx, cy, Math.max(2.5, cell * 0.08), 0, Math.PI * 2);
	c2d.fillStyle = tokens.accent;
	c2d.fill();
	c2d.lineWidth = Math.max(1.5, cell * 0.03);
	c2d.strokeStyle = tokens.bg;
	c2d.stroke();
	if (drop) {
		// The landing: a second ring spreads out from the first and fades.
		const q = (at - drop.fall) / SETTLE_MS;
		c2d.lineWidth = Math.max(1.5, cell * 0.04);
		c2d.strokeStyle = alpha(tokens.accent, 0.8 * (1 - q));
		c2d.beginPath();
		c2d.arc(cx, cy, cell * (0.455 + 0.12 * q), 0, Math.PI * 2);
		c2d.stroke();
		again();
	}
}
/** One frame loop at most, while a disc falls or settles. */
function again() {
	if (!raf) raf = requestAnimationFrame(() => ((raf = 0), draw()));
}

function updateHud() {
	if (!view) return;
	const mine = view.you;
	const tag = document.createElement("span");
	tag.className = mine ? "you-side" : "you-spec";
	if (mine) tag.style.color = `var(--p${sideIdx(mine) + 1})`;
	tag.textContent = mine ? `${GLYPHS[mine - 1]} ${sideName(mine).toUpperCase()}` : "SPECTATOR";
	let msg = "";
	if (view.winner !== null) msg = view.winner === 0 ? " — DRAW" : view.winner === mine ? " — YOU WIN!" : mine ? " — YOU LOSE" : "";
	else if (!view.red || !view.yellow) msg = " — Waiting for opponent…";
	else if (mine) msg = view.turn === mine ? " — YOUR TURN" : " — Opponent's turn";
	else {
		// A watcher: whose turn, by colour and name, as who opens takes turns
		// between matches (docs/sdk-v2.md "Who starts").
		const colour = sideName(view.turn);
		const name = arcade.party?.members?.find((m) => m.id === (view.turn === RED ? view.red : view.yellow))?.name;
		msg = ` — ${name ? `${name} (${colour})` : colour} to move`;
	}
	hudEl.replaceChildren(tag, document.createTextNode(msg));
}

// In CSS px, inside the board's border.
const colAt = (clientX) => {
	const rect = canvas.getBoundingClientRect();
	return Math.floor((clientX - rect.left - canvas.clientLeft) / ((canvas.clientWidth || rect.width) / COLS));
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
arcade.on("theme.set", () => (draw(), updateHud())); // the HUD names the colour, which a theme renames
arcade.on("view", ({ state }) => {
	const before = view;
	view = state;
	sideCols = arcade.seatColors?.([state.red ?? "", state.yellow ?? ""]) ?? [0, 1];
	// One more disc in the same match, seen arrive: it falls. Anything else
	// (the same move again, a first view, a rematch) stops a fall in flight.
	const fresh = before && state.last && before.match === state.match && state.moves === (before.moves ?? 0) + 1;
	if (fresh) {
		const [row, col] = state.last;
		movedEl.textContent = `${sideName(state.board[row][col])} dropped in column ${col + 1}`;
	} else if (!before || before.match !== state.match || state.moves !== before.moves) movedEl.textContent = "";
	if (fresh && !reduced.matches) {
		drop = { row: state.last[0], col: state.last[1], t0: performance.now(), fall: FALL_MS * Math.sqrt((state.last[0] + 1) / ROWS) };
		drops++;
	} else if (!before || before.match !== state.match || state.moves !== before.moves) drop = null;
	draw();
	updateHud();
});
arcade.on("rejected", (m) => arcade.toast(m.reason, "warn"));
arcade.init.then(resize);

/**
 * The board as every phone sees it, for the tests: { board, turn, winner,
 * started, red, yellow, match, moves, last, you }, with `marked` (the cell
 * ringed as the last move, [row, col] or null), `drops` (falls shown) and
 * `px` (the canvas: CSS cell, backing pixels per CSS px, backing size).
 */
arcade.debug = () => ({ ...(view ?? { started: false, board: [] }), marked, drops, colors: [...sideCols], marks: [...MARKS], px: { cell, dpr, w: canvas.width, h: canvas.height } });
