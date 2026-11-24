// games/neon-fission/rules.js — Neon Fission's rules: pure functions, no DOM, no wire.
//
// A grid. On your turn you add one orb to an empty cell or to one of yours.
// A cell holds at most one orb fewer than it has neighbours (corner 2, edge
// 3, inside 4); reaching that many it bursts: it loses that many orbs and
// sends one to each orthogonal neighbour, which becomes yours, orbs and all.
// Bursts run in waves until the board is still, or until one player owns
// every orb (a board that is all yours would burst for ever). A player who
// has had a turn and owns no cells is out; the last one with cells wins.
//
// Its own file so scripts/test-neon-fission.mjs can load the rules alone; the
// game's frame inlines it ahead of neon-fission.js (index.html), which reads
// `globalThis.neonFissionRules`. Seats are numbers here (0 … n-1, seat order =
// colour order); the managed layer maps them to party ids.

(() => {
	/** 2–4 players: 6 across, 9 down; 5–8: 8 × 12. Both fit a 390 px phone with 44 px cells. */
	const dims = (players) => (players <= 4 ? { cols: 6, rows: 9 } : { cols: 8, rows: 12 });
	// A chain on a board with an opponent left always settles, long before
	// this; the cap is only there so no bug can hang the host.
	const MAX_WAVES = 2000;

	/**
	 * Per board shape, computed once: each cell's neighbours and capacity.
	 * `voids`: cells that are not there (the "Voids" option). A void has no
	 * neighbours and capacity 0, and is nobody's neighbour, so a cell beside
	 * one bursts an orb sooner.
	 */
	const shapes = new Map();
	function shape(cols, rows, voids = []) {
		const key = `${cols}x${rows}${voids?.length ? `:${voids.join(",")}` : ""}`;
		let sh = shapes.get(key);
		if (sh) return sh;
		const n = cols * rows;
		const gone = new Set(voids ?? []);
		const nbr = [];
		const cap = new Uint8Array(n);
		for (let i = 0; i < n; i++) {
			const r = Math.floor(i / cols);
			const c = i % cols;
			const list = [];
			if (!gone.has(i)) {
				if (r > 0) list.push(i - cols);
				if (c < cols - 1) list.push(i + 1);
				if (r < rows - 1) list.push(i + cols);
				if (c > 0) list.push(i - 1);
			}
			nbr.push(list.filter((j) => !gone.has(j)));
			cap[i] = nbr[i].length;
		}
		sh = { cols, rows, n, nbr, cap };
		shapes.set(key, sh);
		return sh;
	}
	const capacity = (cols, rows, i, voids) => shape(cols, rows, voids).cap[i];
	/** The shape of game `g`, voids and all. */
	const shapeOf = (g) => shape(g.cols, g.rows, g.voids);

	/**
	 * The "Voids" option (Lokesh, 2026-11-24): one or two pairs of cells taken
	 * out of the board, each pair turned 180° about the centre (so neither
	 * side of the board is the better one), dealt from the match's `seed`.
	 * Never on the border, so no corner is left with one neighbour (every
	 * cell still bursts at 2 or more), and never touching another void, so
	 * the board stays one piece.
	 */
	function voidsFor(cols, rows, seed) {
		let a = (seed ^ 0x7015) >>> 0;
		const next = () => {
			a = (a + 0x6d2b79f5) >>> 0;
			let t = a;
			t = Math.imul(t ^ (t >>> 15), t | 1);
			t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
		const n = cols * rows;
		const pairs = next() < 0.5 ? 1 : 2;
		const out = [];
		const touches = (i) => out.some((j) => Math.abs((i % cols) - (j % cols)) <= 1 && Math.abs(Math.floor(i / cols) - Math.floor(j / cols)) <= 1);
		for (let tries = 0; out.length < pairs * 2 && tries < 100; tries++) {
			const c = 1 + Math.floor(next() * (cols - 2));
			const r = 1 + Math.floor(next() * (rows - 2));
			const i = r * cols + c;
			const j = n - 1 - i;
			if (touches(i) || touches(j) || Math.abs((i % cols) - (j % cols)) <= 1 && Math.abs(Math.floor(i / cols) - Math.floor(j / cols)) <= 1) continue;
			out.push(i, j);
		}
		return out.sort((x, y) => x - y);
	}

	/**
	 * A new game for `players` seats. `owner[i]` is the seat owning cell i
	 * (-1: empty), `count[i]` its orbs. `played[s]`: seat s has had a turn;
	 * `out[s]`: the move number that knocked it out (null: still in);
	 * `gone[s]`: it left the party.
	 */
	function newGame(players, size = dims(players), voids = []) {
		const n = size.cols * size.rows;
		return {
			cols: size.cols,
			rows: size.rows,
			voids: [...voids],
			players,
			owner: Array(n).fill(-1),
			count: Array(n).fill(0),
			turn: 0,
			moves: 0,
			played: Array(players).fill(false),
			out: Array(players).fill(null),
			gone: Array(players).fill(false),
			winner: null,
			biggest: { bursts: 0, waves: 0 },
		};
	}

	const inGame = (g, s) => g.out[s] === null && !g.gone[s];
	const alive = (g) => [...Array(g.players).keys()].filter((s) => inGame(g, s));
	const isVoid = (g, i) => !!g.voids?.includes(i);
	const legal = (g, i, s = g.turn) => Number.isInteger(i) && i >= 0 && i < g.owner.length && !isVoid(g, i) && (g.owner[i] === -1 || g.owner[i] === s);
	const legalCells = (g, s = g.turn) => g.owner.flatMap((o, i) => ((o === -1 || o === s) && !isVoid(g, i) ? [i] : []));

	/** Cells and orbs per seat. */
	function holdings(g) {
		const cells = Array(g.players).fill(0);
		const orbs = Array(g.players).fill(0);
		g.owner.forEach((o, i) => {
			if (o >= 0) {
				cells[o]++;
				orbs[o] += g.count[i];
			}
		});
		return { cells, orbs };
	}

	/**
	 * Seat `s` adds an orb at `cell` and the chain runs, in place on `owner`
	 * and `count` (arrays or typed arrays). Returns the waves: each the list
	 * of cells that burst in it. Stops the moment `s` owns every orb.
	 */
	function react(owner, count, sh, cell, s) {
		const { nbr, cap } = sh;
		owner[cell] = s;
		count[cell]++;
		const waves = [];
		if (count[cell] < cap[cell]) return waves;
		// Everyone else's cells, so "s owns every orb" is a counter, not a scan.
		let others = 0;
		for (let i = 0; i < owner.length; i++) if (owner[i] >= 0 && owner[i] !== s) others++;
		const mark = new Uint32Array(owner.length);
		let now = [cell];
		while (now.length && waves.length < MAX_WAVES) {
			const stamp = waves.length + 1;
			const next = [];
			for (const i of now) {
				count[i] -= cap[i];
				if (count[i] === 0) owner[i] = -1;
				else if (count[i] >= cap[i] && mark[i] !== stamp) {
					mark[i] = stamp;
					next.push(i);
				}
				for (const j of nbr[i]) {
					if (owner[j] >= 0 && owner[j] !== s) others--;
					owner[j] = s;
					count[j]++;
					if (count[j] >= cap[j] && mark[j] !== stamp) {
						mark[j] = stamp;
						next.push(j);
					}
				}
			}
			waves.push(now);
			if (others === 0) break; // every orb is s's: the rest would never settle
			now = next;
		}
		return waves;
	}

	/** The next seat still in after `s`, or `s` itself. */
	function nextSeat(g, s) {
		for (let k = 1; k <= g.players; k++) {
			const t = (s + k) % g.players;
			if (inGame(g, t)) return t;
		}
		return s;
	}

	/**
	 * After any change: knock out whoever has had a turn and holds nothing,
	 * and crown the last one standing.
	 */
	function settle(g) {
		const { cells } = holdings(g);
		for (let s = 0; s < g.players; s++) if (inGame(g, s) && g.played[s] && cells[s] === 0) g.out[s] = g.moves;
		const left = alive(g);
		if (left.length === 1) g.winner = left[0];
		else if (left.length === 0) g.winner = -1; // only if everybody left
	}

	/**
	 * The seat on turn plays `cell`. Returns a reason string when refused,
	 * else `{ cell, seat, waves, bursts }`.
	 */
	function play(g, cell) {
		if (g.winner !== null) return "the game is over";
		if (isVoid(g, cell)) return "there is no cell there";
		if (!legal(g, cell)) return "that cell is someone else's";
		const s = g.turn;
		const waves = react(g.owner, g.count, shapeOf(g), cell, s);
		g.moves++;
		g.played[s] = true;
		const bursts = waves.reduce((n, w) => n + w.length, 0);
		if (bursts > g.biggest.bursts) g.biggest = { bursts, waves: waves.length };
		settle(g);
		if (g.winner === null) g.turn = nextSeat(g, s);
		return { cell, seat: s, waves, bursts };
	}

	/**
	 * The seat on turn misses it (the host's SKIP TURN). A seat that has never
	 * played is spared once: its second skip counts as its turn, so one who
	 * stepped away is not knocked out at once, and one who is gone still is.
	 */
	function skip(g) {
		if (g.winner !== null) return false;
		const s = g.turn;
		const skips = (g.skips ||= []);
		skips[s] = (skips[s] || 0) + 1;
		if (skips[s] >= 2) g.played[s] = true;
		settle(g);
		if (g.winner === null) g.turn = nextSeat(g, s);
		return true;
	}

	/** Seat `s` left the party: its cells stay on the board, and anyone may take them. */
	function leave(g, s) {
		if (g.winner !== null || !inGame(g, s)) return false;
		g.gone[s] = true;
		settle(g);
		if (g.winner === null && g.turn === s) g.turn = nextSeat(g, s);
		return true;
	}

	/**
	 * Places: the winner, then the last knocked out, and so on; seats knocked
	 * out by the same move share a place. Seats that left are not ranked.
	 */
	function standings(g) {
		const places = [];
		if (g.winner >= 0) places.push([g.winner]);
		const outs = [...Array(g.players).keys()].filter((s) => !g.gone[s] && g.out[s] !== null).sort((a, b) => g.out[b] - g.out[a]);
		for (const s of outs) {
			const last = places.at(-1);
			if (last && last.length && g.out[last[0]] === g.out[s] && last[0] !== g.winner) last.push(s);
			else places.push([s]);
		}
		return places;
	}

	// ------------------------------------------------------------------ the bot
	//
	// One ply over every legal cell, simulated in full (chains included), scored
	// by a position judgement; then the best few are checked against the next
	// player's strongest reply. Under 10 ms at 8 × 12 on a laptop, well within a
	// phone's 50 ms.

	/** How good the board is for `me`: material, safe cells, loaded cells. */
	function judge(owner, count, sh, me, early) {
		const { nbr, cap, n } = sh;
		let score = 0;
		let mine = 0;
		let theirs = 0;
		for (let i = 0; i < n; i++) {
			const o = owner[i];
			if (o < 0) continue;
			if (o !== me) {
				theirs += count[i];
				continue;
			}
			mine += count[i];
			// A cell beside an enemy cell that is one orb from bursting is lost
			// on their turn, unless it would burst first.
			let threatened = false;
			for (const j of nbr[i]) {
				if (owner[j] >= 0 && owner[j] !== me && count[j] === cap[j] - 1) {
					threatened = true;
					break;
				}
			}
			const loaded = count[i] === cap[i] - 1;
			if (threatened) score -= loaded ? 2 : 4 + count[i];
			else {
				score += 5 - cap[i]; // corners hold best: 3, edges 2, inside 1
				if (early && cap[i] === 2) score += 3;
				if (loaded) score += 2;
			}
			// Loaded cells beside loaded enemy cells: whoever moves first wins the
			// exchange. Ours is a threat they must answer.
			if (loaded)
				for (const j of nbr[i]) if (owner[j] >= 0 && owner[j] !== me && count[j] === cap[j] - 1) score += 1;
		}
		return score + 2 * mine - 2 * theirs;
	}

	/** Whether `me` has won on this board: every other seat in play has played and holds nothing. */
	function wins(g, owner, me) {
		for (let s = 0; s < g.players; s++) if (s !== me && inGame(g, s) && !g.played[s]) return false;
		for (let i = 0; i < owner.length; i++) if (owner[i] >= 0 && owner[i] !== me) return false;
		return true;
	}

	/** The cell the seat on turn should play. `rng`: a () => [0, 1) for tie noise. */
	function botMove(g, rng = Math.random) {
		const me = g.turn;
		const sh = shapeOf(g);
		const own0 = Int8Array.from(g.owner);
		const cnt0 = Uint8Array.from(g.count);
		const own = new Int8Array(sh.n);
		const cnt = new Uint8Array(sh.n);
		const early = g.moves < g.players * 3;
		const foe = nextSeat(g, me);
		const scored = [];
		for (let i = 0; i < sh.n; i++) {
			if ((own0[i] !== -1 && own0[i] !== me) || !sh.cap[i]) continue; // theirs, or a void
			own.set(own0);
			cnt.set(cnt0);
			react(own, cnt, sh, i, me);
			if (wins(g, own, me)) return i; // finish it
			scored.push({ i, v: judge(own, cnt, sh, me, early) + rng() * 0.5 });
		}
		scored.sort((a, b) => b.v - a.v);
		// The best few, against the next player's strongest reply.
		const own2 = new Int8Array(sh.n);
		const cnt2 = new Uint8Array(sh.n);
		const started = Date.now();
		let best = scored[0];
		let bestV = -Infinity;
		for (const cand of scored.slice(0, 8)) {
			if (Date.now() - started > 25) break; // a slow phone keeps the one-ply choice
			own.set(own0);
			cnt.set(cnt0);
			react(own, cnt, sh, cand.i, me);
			let worst = Infinity;
			// The next player answers, unless this move has knocked them out.
			if (foe !== me && own.includes(foe)) {
				for (let j = 0; j < sh.n; j++) {
					if ((own[j] !== -1 && own[j] !== foe) || !sh.cap[j]) continue;
					own2.set(own);
					cnt2.set(cnt);
					react(own2, cnt2, sh, j, foe);
					const v = judge(own2, cnt2, sh, me, early);
					if (v < worst) worst = v;
				}
			}
			const v = (worst === Infinity ? cand.v : worst) + cand.v * 0.1;
			if (v > bestV) {
				bestV = v;
				best = cand;
			}
		}
		return best?.i ?? legalCells(g)[0];
	}

	// How a chain is replayed (neon-fission.js), pure so it can be tested.
	// An ordinary move stays snappy: ~1.5 s at most, however long. The move
	// that ends the game is the one the loser most needs to read (Lokesh,
	// 2026-11-15: a winning chain flipped half the board and the end card came
	// at once), so it runs wave by wave within a 4.3 s budget, then holds the
	// final board with the cells it took marked. A wave is the budget shared
	// out (at most `maxWave`), never a fixed minimum: the longest chains seen
	// (85 waves with bots on 8 × 12, 104 random) must still end, settle
	// included, well inside the platform's end-card hold (lib/sdk-managed.js
	// HOLD_MS, 6 s). Then a wave is ~40 ms.
	const PACE = {
		move: { placeMs: 120, budget: 1400, maxWave: 170, settleMs: 0 },
		final: { placeMs: 250, budget: 4300, maxWave: 300, settleMs: 700 },
	};

	/** The replay of a chain of `waves` waves: { placeMs, waveMs, settleMs, total }. */
	function pace(waves, final = false) {
		const p = final ? PACE.final : PACE.move;
		const waveMs = waves > 0 ? Math.min(p.maxWave, p.budget / waves) : 0;
		return { placeMs: p.placeMs, waveMs, settleMs: p.settleMs, total: p.placeMs + waves * waveMs + p.settleMs };
	}

	globalThis.neonFissionRules = {
		dims, MAX_WAVES, shape, shapeOf, capacity, voidsFor, isVoid, newGame, inGame, alive, legal, legalCells, holdings,
		react, nextSeat, play, skip, leave, standings, botMove, PACE, pace,
	};
})();
