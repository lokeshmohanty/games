// games/neon-fission/neon-fission.js — Neon Fission, an SDK v2 managed game.
//
// The rules are rules.js (pure, seat numbers); this file maps them onto the
// party and draws. The platform (lib/sdk-managed.js) runs the rules on the
// host, sends each phone its view, plays bot seats with `bot()`, shows the
// turn-wait banner, draws the end card and hands over to the heir.
//
// Different devices: each phone is a seat, bots fill the rest. Same device:
// the platform's quick table (SINGLE PLAYER / SAME DEVICE, lib/party.js;
// "sameDevice" in game.json) may make any bot seat a person beside the one
// player, and says so with `local` on that seat in init. Such a seat is
// still a bot id to the platform, but its turn is reported as the person's
// (turn()), so no bot plays it and no "waiting for" banner shows; the
// person's tap is applied for it. (Until 2026-11-17 the game set that table
// itself, on a screen before the first move.)

const R = globalThis.neonFissionRules;

// ------------------------------------------------------------------ rules

/** mulberry32 over a state kept in the snapshot, so an heir's bots carry on the same stream. */
function draw01() {
	s.rng = (s.rng + 0x6d2b79f5) | 0;
	let t = Math.imul(s.rng ^ (s.rng >>> 15), 1 | s.rng);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// { match, g, ids, names, kinds: "human"|"bot"|"local", owner, last, rng }
let s = null;
const seatOf = (id) => (s ? s.ids.indexOf(id) : -1);
const hasLocal = () => s.kinds.includes("local");
/** The party id that moves for seat `i`: a local seat's person is the owner. */
const moverOf = (i) => (s.kinds[i] === "local" ? s.owner : s.ids[i]);
const nameFor = (kind, seat, name) => (kind === "local" ? `Player ${seat + 1}` : name);

arcade.managed({
	init({ seats, seed, match }) {
		const humans = seats.filter((p) => !p.bot);
		// The one person seated plays the seats of the people beside them
		// (the platform's `local`; it keeps them for PLAY AGAIN). With more
		// than one person there is no one phone to pass: those are bots.
		const owner = humans.length === 1 ? humans[0].id : null;
		const kinds = seats.map((p) => (!p.bot ? "human" : owner && p.local ? "local" : "bot"));
		s = {
			match: match + 1,
			g: R.newGame(seats.length),
			ids: seats.map((p) => p.id),
			bare: seats.map((p) => p.name ?? "Player"),
			names: seats.map((p, i) => nameFor(kinds[i], i, p.name ?? "Player")),
			kinds,
			owner,
			last: null,
			rng: seed | 0,
		};
	},
	apply({ action, by }) {
		if (!action || typeof action !== "object") return "no such move";
		const g = s.g;
		if (g.winner !== null) return "the game is over";
		if (moverOf(g.turn) !== by) return "not your turn";
		// A tap carries the move it was meant for: on one phone the same person
		// moves for several seats, so a late second tap must not land on the next.
		if (action.n !== undefined && action.n !== g.moves) return "that move has passed";
		const before = { owner: [...g.owner], count: [...g.count] };
		const r = R.play(g, action.cell);
		if (typeof r === "string") return r;
		s.last = { n: g.moves, cell: r.cell, seat: r.seat, waves: r.waves, before };
	},
	view({ seat }) {
		const g = s.g;
		const { cells, orbs } = R.holdings(g);
		return {
			match: s.match,
			cols: g.cols,
			rows: g.rows,
			owner: g.owner,
			count: g.count,
			turn: g.turn,
			moves: g.moves,
			winner: g.winner,
			players: s.ids.map((id, i) => ({ name: s.names[i], kind: s.kinds[i], out: g.out[i] !== null, gone: g.gone[i], cells: cells[i], orbs: orbs[i] })),
			you: seat ? seatOf(seat) : -1,
			// This phone plays the local seats.
			setter: !!seat && seat === s.owner,
			ownerName: s.owner ? s.names[seatOf(s.owner)] : null,
			last: s.last,
		};
	},
	turn() {
		if (s.g.winner !== null) return [];
		return [moverOf(s.g.turn)];
	},
	bot({ seat }) {
		if (s.g.winner !== null || s.ids[s.g.turn] !== seat || s.kinds[s.g.turn] !== "bot") return null;
		return { cell: R.botMove(s.g, draw01) };
	},
	result() {
		const g = s.g;
		if (g.winner === null) return null;
		const ranking = R.standings(g).map((slot) => slot.map((i) => s.ids[i]));
		const { cells, orbs } = R.holdings(g);
		const details = [
			{ label: "Turns played", value: g.moves },
			{ label: "Biggest chain", value: g.biggest.bursts ? `${g.biggest.bursts} bursts in ${g.biggest.waves} waves` : "no bursts" },
		];
		if (g.winner >= 0) details.push({ label: "Cells held at the end", value: `${cells[g.winner]} cells, ${orbs[g.winner]} orbs` });
		details.push({ label: "Grid", value: `${g.cols} × ${g.rows}` });
		const out = { kind: "ffa", ranking, details };
		// Players on this device are bot seats to the platform: the end card
		// names them as the game does (lib/sdk-managed.js, result `names`).
		if (hasLocal()) {
			out.names = Object.fromEntries(s.ids.flatMap((id, i) => (s.kinds[i] === "local" ? [[id, s.names[i]]] : [])));
			if (g.winner >= 0) out.title = `${s.names[g.winner]} wins`.slice(0, 40);
		}
		return out;
	},
	// The host's SKIP TURN: a move is missed.
	skip() {
		return R.skip(s.g);
	},
	leave({ seat }) {
		const i = seatOf(seat);
		if (i < 0) return false;
		if (seat === s.owner) {
			// Nobody is left to play the local seats: bots take them over.
			s.kinds = s.kinds.map((k) => (k === "local" ? "bot" : k));
			s.names = s.names.map((n, j) => nameFor(s.kinds[j], j, s.bare[j]));
			s.owner = null;
		}
		return R.leave(s.g, i);
	},
	snapshot: () => s,
	restore({ snapshot }) {
		s = snapshot;
	},
});

// ------------------------------------------------------------- the board

const turnEl = document.getElementById("turn");
const seatsEl = document.getElementById("seats");
const wrapEl = document.getElementById("wrap");
const canvas = document.getElementById("board");
const c2d = canvas.getContext("2d");
const reduced = matchMedia("(prefers-reduced-motion: reduce)");

let view = null;
let cell = 40; // CSS px per cell
let anim = null; // the chain being shown: { frames, waves, seat, cell, t0, placeMs, waveMs, settleMs, total, taken, final, timer }
let shownMove = -1; // the move whose chain has been shown (or skipped)
let painted = null; // the owners last drawn, for the tests

// How fast a chain replays is rules.js `pace`. The platform keeps the end
// card back until `arcade.idle()` says the winning one has been shown.

const seatVar = (i) => `var(--p${(i % 8) + 1})`;
const alpha = (rgba, a) => rgba.replace(/,\s*[\d.]+\)$/, `, ${a})`);
const glows = () => !/,\s*0\)$/.test(arcade.theme?.tokens?.glow ?? ", 0)");

function resize() {
	if (!view) return;
	const w = wrapEl.clientWidth;
	const h = wrapEl.clientHeight;
	cell = Math.max(24, Math.floor(Math.min(w / view.cols, h / view.rows, 72)));
	const dpr = Math.min(window.devicePixelRatio || 1, 3);
	canvas.style.width = `${cell * view.cols}px`;
	canvas.style.height = `${cell * view.rows}px`;
	canvas.width = Math.round(cell * view.cols * dpr);
	canvas.height = Math.round(cell * view.rows * dpr);
	c2d.setTransform(dpr, 0, 0, dpr, 0, 0);
	paint();
}

/** Orb offsets inside a cell, for 1…4 orbs (more draw as four). */
const LAYOUT = [[], [[0, 0]], [[-0.17, 0], [0.17, 0]], [[0, -0.16], [-0.16, 0.12], [0.16, 0.12]], [[-0.16, -0.16], [0.16, -0.16], [-0.16, 0.16], [0.16, 0.16]]];

function orb(x, y, colour, r) {
	const { tokens } = arcade.theme;
	c2d.beginPath();
	c2d.arc(x, y, r, 0, Math.PI * 2);
	c2d.fillStyle = colour;
	c2d.shadowBlur = glows() ? r * 1.6 : 0;
	c2d.shadowColor = colour;
	c2d.fill();
	c2d.shadowBlur = 0;
	// A small highlight: a nucleus, not a flat dot.
	c2d.beginPath();
	c2d.arc(x - r * 0.3, y - r * 0.3, r * 0.32, 0, Math.PI * 2);
	c2d.fillStyle = alpha(arcade.theme.dark ? tokens.ink : tokens.bg, 0.55);
	c2d.fill();
}

/** One board: `owner`/`count` arrays; `hide`: cells drawn empty (mid-burst). */
function board(owner, count, { hide = null, lastCell = -1 } = {}) {
	painted = owner;
	const { tokens, players } = arcade.theme;
	const { cols, rows } = view;
	const W = cols * cell;
	const H = rows * cell;
	c2d.clearRect(0, 0, W, H);
	c2d.fillStyle = tokens.surface;
	c2d.fillRect(0, 0, W, H);
	for (let i = 0; i < owner.length; i++) {
		const o = owner[i];
		if (o < 0 || hide?.has(i)) continue;
		c2d.fillStyle = alpha(players[o % 8], 0.12);
		c2d.fillRect((i % cols) * cell, Math.floor(i / cols) * cell, cell, cell);
	}
	c2d.strokeStyle = tokens.rule;
	c2d.lineWidth = 1;
	c2d.beginPath();
	for (let c = 1; c < cols; c++) {
		c2d.moveTo(c * cell + 0.5, 0);
		c2d.lineTo(c * cell + 0.5, H);
	}
	for (let r = 1; r < rows; r++) {
		c2d.moveTo(0, r * cell + 0.5);
		c2d.lineTo(W, r * cell + 0.5);
	}
	c2d.stroke();
	const sh = R.shape(cols, rows);
	for (let i = 0; i < owner.length; i++) {
		const o = owner[i];
		const n = hide?.has(i) ? 0 : count[i];
		if (o < 0 || !n) continue;
		const cx = (i % cols) * cell + cell / 2;
		const cy = Math.floor(i / cols) * cell + cell / 2;
		const colour = players[o % 8];
		// One orb short of bursting: a dashed halo says "unstable".
		if (n === sh.cap[i] - 1) {
			c2d.beginPath();
			c2d.setLineDash([3, 3]);
			c2d.arc(cx, cy, cell * 0.4, 0, Math.PI * 2);
			c2d.strokeStyle = alpha(colour, 0.75);
			c2d.lineWidth = 1.5;
			c2d.stroke();
			c2d.setLineDash([]);
		}
		for (const [dx, dy] of LAYOUT[Math.min(n, 4)]) orb(cx + dx * cell, cy + dy * cell, colour, cell * 0.14);
	}
	if (lastCell >= 0) {
		const x = (lastCell % cols) * cell;
		const y = Math.floor(lastCell / cols) * cell;
		c2d.strokeStyle = alpha(players[(owner[lastCell] >= 0 ? owner[lastCell] : view.last?.seat ?? 0) % 8], 0.9);
		c2d.lineWidth = 2;
		c2d.strokeRect(x + 2, y + 2, cell - 4, cell - 4);
	}
}

// One frame loop at most, however many things ask for a repaint mid-chain.
let raf = 0;
const again = () => {
	if (!raf) raf = requestAnimationFrame(() => ((raf = 0), paint()));
};

function paint(now = performance.now()) {
	if (!view || !arcade.theme) return;
	if (!anim) return board(view.owner, view.count, { lastCell: view.last?.cell ?? -1 });
	const { frames, waves, seat, t0, placeMs, waveMs, settleMs, total } = anim;
	const t = now - t0;
	if (t >= total) return finish();
	if (t < placeMs) {
		board(frames[0].owner, frames[0].count, { lastCell: anim.cell });
		return again();
	}
	const k = Math.floor((t - placeMs) / waveMs);
	if (k >= waves.length) {
		// The settle: the final board, each cell this move took ringed, fading.
		board(view.owner, view.count, { lastCell: anim.cell });
		const p = (t - placeMs - waves.length * waveMs) / settleMs;
		c2d.strokeStyle = alpha(arcade.theme.players[seat % 8], 0.9 * (1 - p));
		c2d.lineWidth = 3;
		for (const i of anim.taken) c2d.strokeRect((i % view.cols) * cell + 3.5, Math.floor(i / view.cols) * cell + 3.5, cell - 7, cell - 7);
		return again();
	}
	const p = (t - placeMs - k * waveMs) / waveMs;
	const e = 1 - (1 - p) * (1 - p);
	const wave = new Set(waves[k]);
	board(frames[k].owner, frames[k].count, { hide: wave });
	const { players } = arcade.theme;
	const colour = players[seat % 8];
	const sh = R.shape(view.cols, view.rows);
	for (const i of wave) {
		const cx = (i % view.cols) * cell + cell / 2;
		const cy = Math.floor(i / view.cols) * cell + cell / 2;
		// The flash, then one orb flying to each neighbour.
		c2d.beginPath();
		c2d.arc(cx, cy, cell * (0.2 + 0.35 * e), 0, Math.PI * 2);
		c2d.strokeStyle = alpha(colour, 0.8 * (1 - p));
		c2d.lineWidth = 2;
		c2d.stroke();
		for (const j of sh.nbr[i]) {
			const nx = (j % view.cols) * cell + cell / 2;
			const ny = Math.floor(j / view.cols) * cell + cell / 2;
			orb(cx + (nx - cx) * e, cy + (ny - cy) * e, colour, cell * 0.13);
		}
	}
	again();
}

/**
 * The chain is over (played out, tapped past, or replaced): the board as it
 * is, and the platform told this phone is idle, so a held end card shows.
 */
function finish() {
	if (anim) clearTimeout(anim.timer);
	anim = null;
	hud();
	paint();
	// `?.`: a shell from before `idle` (2026-11-15) has no such call.
	arcade.idle?.();
}

/** Start showing the chain of `last` (a move this phone has not shown yet). */
function animate(last) {
	if (reduced.matches || !last?.before || !last.waves.length) return;
	const { cols, rows } = view;
	const sh = R.shape(cols, rows);
	const o = [...last.before.owner];
	const c = [...last.before.count];
	o[last.cell] = last.seat;
	c[last.cell]++;
	const frames = [{ owner: [...o], count: [...c] }];
	for (const wave of last.waves) {
		for (const i of wave) {
			c[i] -= sh.cap[i];
			if (c[i] <= 0) {
				c[i] = 0;
				o[i] = -1;
			}
			for (const j of sh.nbr[i]) {
				o[j] = last.seat;
				c[j]++;
			}
		}
		frames.push({ owner: [...o], count: [...c] });
	}
	// A long chain runs faster, within its budget (rules.js `pace`).
	const final = view.winner !== null;
	const { placeMs, waveMs, settleMs, total } = R.pace(last.waves.length, final);
	const taken = view.owner.flatMap((o, i) => (o === last.seat && last.before.owner[i] !== last.seat ? [i] : []));
	anim = { frames, waves: last.waves, seat: last.seat, cell: last.cell, t0: performance.now(), placeMs, waveMs, settleMs, total, taken, final };
	// Frames stop in a hidden tab; this does not, so the end card is not held for nothing.
	anim.timer = setTimeout(() => anim && performance.now() - anim.t0 >= anim.total && finish(), total + 50);
}

const canPlay = () =>
	!!view && view.winner === null && (view.turn === view.you || (view.setter && view.players[view.turn]?.kind === "local"));

function hud() {
	if (!view) return;
	const { players } = view;
	const turnSeat = view.winner !== null ? view.winner : view.turn;
	const local = players.some((p) => p.kind === "local");
	let text = "";
	let sub = "";
	if (view.winner !== null) text = view.winner >= 0 ? (view.winner === view.you && !local ? "You win" : `${players[view.winner].name} wins`) : "Game over";
	else if (players[view.turn].kind === "local" && view.setter) {
		text = players[view.turn].name;
		sub = "pass the phone";
	} else if (view.turn === view.you) {
		text = local ? view.ownerName ?? "Your turn" : "Your turn";
		if (local) sub = "your turn";
	} else text = `${players[view.turn].name}'s turn`;
	const dot = document.createElement("span");
	dot.className = "dot";
	const label = document.createElement("span");
	label.textContent = text;
	const parts = [dot, label];
	if (sub) {
		const s2 = document.createElement("span");
		s2.className = "sub";
		s2.textContent = `— ${sub}`;
		parts.push(s2);
	}
	turnEl.replaceChildren(...parts);
	turnEl.style.setProperty("--seat", turnSeat < 0 ? "var(--accent)" : seatVar(turnSeat));
	seatsEl.replaceChildren(
		...players.map((p, i) => {
			const chip = document.createElement("span");
			chip.className = "chip" + (view.winner === null && i === view.turn ? " is-turn" : "") + (p.out || p.gone ? " is-out" : "");
			chip.style.setProperty("--seat", seatVar(i));
			chip.title = p.name;
			const d = document.createElement("span");
			d.className = "dot";
			const nm = document.createElement("span");
			nm.className = "name";
			nm.textContent = i === view.you ? "You" : p.name;
			const n = document.createElement("span");
			n.className = "n";
			n.textContent = String(p.cells);
			chip.append(d, nm, n);
			return chip;
		}),
	);
}

canvas.addEventListener("click", (e) => {
	if (anim) {
		// A tap during a chain skips it to the end; it is not a move.
		return finish();
	}
	if (!canPlay()) return;
	const rect = canvas.getBoundingClientRect();
	const c = Math.floor((e.clientX - rect.left) / cell);
	const r = Math.floor((e.clientY - rect.top) / cell);
	if (c < 0 || c >= view.cols || r < 0 || r >= view.rows) return;
	const i = r * view.cols + c;
	const o = view.owner[i];
	if (o !== -1 && o !== view.turn) return arcade.toast("That cell is taken: play an empty one or your own.", "warn");
	arcade.act({ cell: i, n: view.moves });
});

// The grid fits the room left under the turn line and the chips, which are
// filled in after the first resize: with eight players their rows took
// another 50px, and the grid ran 20px off a 354x696 phone. So the grid
// follows #wrap's own size, not just the window's.
// (scripts/test-neon-fission.mjs runs this file in node, with no ResizeObserver.)
if (typeof ResizeObserver === "function") new ResizeObserver(() => resize()).observe(wrapEl);
addEventListener("resize", resize); // a new devicePixelRatio, at the same size
arcade.on("theme.set", () => paint());
arcade.on("view", ({ state }) => {
	const first = !view;
	const reshaped = !view || view.cols !== state.cols || view.rows !== state.rows;
	const fresh = view && state.match !== view.match;
	view = state;
	if (fresh) shownMove = -1;
	if (reshaped) resize();
	const last = state.last;
	if (last && last.n !== shownMove) {
		// A phone that (re)joins mid-game draws the board as it is.
		const showIt = !first && last.n === state.moves;
		shownMove = last.n;
		if (anim) clearTimeout(anim.timer);
		anim = null;
		if (showIt) animate(last);
	} else if (!last && anim) {
		clearTimeout(anim.timer);
		anim = null;
	}
	// The turn line and chips wait for a winning chain to play out, so they
	// do not announce the winner over it (finish() draws them).
	if (!anim?.final) hud();
	paint();
	// Nothing to replay: this view is shown (else finish() says so).
	if (!anim) arcade.idle?.();
});
arcade.on("rejected", (m) => arcade.toast(m.reason, "warn"));
arcade.init.then(resize);

/** The game as this phone sees it, for the tests. */
arcade.debug = () => (view ? { ...view, canPlay: canPlay(), animating: !!anim, replayMs: anim ? Math.round(anim.total) : 0, painted, cell } : { match: null });
