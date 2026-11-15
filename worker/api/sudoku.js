// worker/api/sudoku.js — the server's check of a solo Sudoku run.
//
// COPIED, NOT IMPORTED: everything between the two "copy" lines below is
// sudoku/sudoku-rules.js lines 12–145 from lokeshmohanty/web-games
// (branch platform-v2, commit b90aafb), one tab of indent removed: the grid,
// the seeded random streams and the randomized full-grid search, up to
// solutionFor(). Not the removal, not the uniqueness checks — those cost up
// to tens of ms, and the server stays within the Workers free plan's 10 ms
// of CPU a request (Lokesh, 2026-11-15).
//
// Why that is enough: the game's generate() deals attempt k of a puzzle from
// its own stream, full grid first (solutionFor(key, k)), then takes cells
// away while the puzzle keeps exactly one solution. So the one grid that
// solves the dealt puzzle is solutionFor(key, k), and a submitted grid equal
// to it is a solution of that puzzle, every clue kept — nothing else to
// check. The proof names k. If the game's generator ever changes, this copy
// must change with it and the pin must move to that commit;
// scripts/test-accounts.mjs compares solutionFor here with the game's
// generate() for many seeds whenever ../web-games-v2 is checked out.
//
// What is checked (verifySudoku), cheapest first: the difficulty, how the
// puzzle was dealt (from the run's seed, or the daily puzzle of a date near
// now), the attempt, the grid's format, that neither the server's clock nor
// the reported time is below the difficulty's fastest plausible solve
// (MIN_SOLVE_S), one ranked daily per day and difficulty, and then the grid
// against solutionFor. The time recorded is the reported one, raised to the
// server's clock less CLOCK_SLACK_S; lower is better.

// ---- copy: sudoku-rules.js, from here ----
const CELLS = 81;
const rowOf = (i) => Math.floor(i / 9);
const colOf = (i) => i % 9;
const boxOf = (i) => Math.floor(rowOf(i) / 3) * 3 + Math.floor(colOf(i) / 3);

/** For each cell, the 20 others that share its row, column or box. */
const PEERS = Array.from({ length: CELLS }, (_, i) => {
	const out = [];
	for (let j = 0; j < CELLS; j++) {
		if (j !== i && (rowOf(j) === rowOf(i) || colOf(j) === colOf(i) || boxOf(j) === boxOf(i))) out.push(j);
	}
	return out;
});

/** The 27 units: nine rows, nine columns, nine boxes. */
const UNITS = [
	...Array.from({ length: 9 }, (_, r) => Array.from({ length: 9 }, (_, c) => r * 9 + c)),
	...Array.from({ length: 9 }, (_, c) => Array.from({ length: 9 }, (_, r) => r * 9 + c)),
	...Array.from({ length: 9 }, (_, b) => Array.from({ length: CELLS }, (_, i) => i).filter((i) => boxOf(i) === b)),
];

const ALL = 0b1111111110; // bits 1..9

/** Digits still possible in cell `i`, as a bitmask over bits 1..9. */
function candidates(grid, i) {
	let used = 0;
	for (const j of PEERS[i]) used |= 1 << grid[j];
	return ALL & ~used;
}

const bitCount = (m) => {
	let n = 0;
	for (; m; m &= m - 1) n++;
	return n;
};

/** A seeded generator (mulberry32), so the daily puzzle is the same everywhere. */
function rngFrom(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** A 32-bit hash of a string, for seeding. */
function hashString(text) {
	let h = 2166136261;
	for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
	return h >>> 0;
}

const shuffle = (list, rng) => {
	const out = [...list];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
};

/**
 * Count solutions, stopping at `limit`. Backtracking on the most
 * constrained cell first, which keeps it to milliseconds for any real
 * puzzle. Passing `rng` makes it try digits in random order — that is also
 * how a full grid is made from an empty one.
 */
function search(grid, { limit = 2, rng = null, onSolution = null } = {}) {
	const g = grid.slice();
	let count = 0;
	const digits = [1, 2, 3, 4, 5, 6, 7, 8, 9];
	const step = () => {
		let best = -1;
		let bestMask = 0;
		let bestN = 10;
		for (let i = 0; i < CELLS; i++) {
			if (g[i]) continue;
			const m = candidates(g, i);
			const n = bitCount(m);
			if (n === 0) return;
			if (n < bestN) {
				best = i;
				bestMask = m;
				bestN = n;
				if (n === 1) break;
			}
		}
		if (best < 0) {
			count++;
			onSolution?.(g.slice());
			return;
		}
		for (const d of rng ? shuffle(digits, rng) : digits) {
			if (!(bestMask & (1 << d))) continue;
			g[best] = d;
			step();
			if (count >= limit) break;
		}
		g[best] = 0;
	};
	step();
	return count;
}

/**
 * A generator's random stream: one per puzzle key and attempt, so what an
 * attempt deals depends on (key, attempt) alone — never on how many draws
 * the attempts before it took.
 */
const streamOf = (key, attempt) => rngFrom(hashString(`${key}:${attempt}`));

/** A full grid: the first draws of `rng`, an empty grid searched in random order. */
function fullGrid(rng) {
	let solution = null;
	search(Array(CELLS).fill(0), { limit: 1, rng, onSolution: (g) => (solution = g) });
	return solution;
}

/** The key of a run's puzzle (the platform's init seed), and of a day's. */
const seedKey = (seed, level) => `sudoku:seed:${seed >>> 0}:${level}`;
const dailyKey = (date, level) => `sudoku:${date}:${level}`;

/**
 * The solved grid of attempt `attempt` of the puzzle `key`: what generate()
 * starts that attempt from, and — the puzzle having one solution — the only
 * grid that solves it. The arcade's server checks a ranked solo grid with
 * this alone (a copy of this file from CELLS to here: games:
 * worker/api/sudoku.js),
 * never running the removal; keep the copy in step.
 */
const solutionFor = (key, attempt) => fullGrid(streamOf(key, attempt));
// ---- copy: sudoku-rules.js, to here ----

/** The difficulties, by name (their rules live in the game). */
export const LEVELS = { easy: "Easy", medium: "Medium", hard: "Hard", expert: "Expert" };
export const LEVEL_IDS = Object.keys(LEVELS);
/** generate()'s attempts per puzzle (the game's ATTEMPTS). */
export const ATTEMPTS = 12;

/**
 * The fastest plausible solve per difficulty, in seconds: a phone takes a
 * tap to pick a cell and a tap for its digit, and easy leaves 43 cells to
 * fill. Below this, a time is not believed. Lokesh may tune these.
 */
export const MIN_SOLVE_S = { easy: 30, medium: 45, hard: 60, expert: 90 };

/**
 * A reported time is raised to the server's clock less this slack: the run
 * begins before the puzzle is picked (and the first-open rules sheet may sit
 * in between), so a time well under the server's is not believed.
 */
export const CLOCK_SLACK_S = 60;

/** The daily puzzle of `date` may be reported this long either side of it (time zones). */
const DAILY_SLACK_MS = 36 * 3600_000;

export { solutionFor, seedKey, dailyKey };

const refuse = (why) => ({ ok: false, why });

/**
 * A solo Sudoku report, checked. `proof` is the game's result proof
 * ({ start, level, daily, attempt, grid }), `seed` the run's, `elapsed` the
 * server's ms since it issued the run, `score` the reported time in seconds,
 * `at` now, `dailyTaken(key)` whether this account already ranked that daily
 * puzzle. Resolves { ok: true, low: true, level, score, daily } — the time to
 * record, max(reported, elapsed − CLOCK_SLACK_S), and "<date>:<level>" for a
 * daily puzzle — or { ok: false, why }.
 */
export async function verifySudoku({ proof, seed, elapsed, score, at, dailyTaken = async () => false }) {
	if (!proof || typeof proof !== "object") return refuse("a Sudoku run is ranked with its solved grid, and this report has none");
	const level = proof.level;
	if (!Object.hasOwn(LEVELS, level)) return refuse("unknown Sudoku difficulty");
	let date = null;
	if (proof.start === "daily") {
		date = typeof proof.daily === "string" && /^\d{4}-\d{2}-\d{2}$/.test(proof.daily) ? proof.daily : null;
		const noon = date ? Date.parse(`${date}T12:00:00Z`) : NaN;
		if (!Number.isFinite(noon) || Math.abs(noon - at) > DAILY_SLACK_MS) return refuse("that is not today's puzzle");
	} else if (proof.start !== "new") return refuse("a resumed puzzle is not ranked: it was not dealt in this run");
	if (!Number.isInteger(proof.attempt) || proof.attempt < 0 || proof.attempt >= ATTEMPTS) return refuse("the proof does not say which puzzle was dealt");
	if (typeof proof.grid !== "string" || !/^[1-9]{81}$/.test(proof.grid)) return refuse("the solved grid is missing or not full");
	const min = MIN_SOLVE_S[level];
	if (elapsed < min * 1000) return refuse(`too fast: a ${LEVELS[level]} Sudoku takes at least ${min} s, and this run was ${Math.floor(elapsed / 1000)} s old`);
	if (typeof score !== "number" || !Number.isFinite(score)) return refuse("a Sudoku run is ranked by its time, and this report has none");
	if (score < min) return refuse(`too fast: a ${LEVELS[level]} Sudoku takes at least ${min} s`);
	const daily = date ? `${date}:${level}` : null;
	if (daily && (await dailyTaken(daily))) return refuse("you already ranked that day's puzzle at this difficulty");
	// Under a millisecond (docs/accounts.md "Solo runs").
	const solution = solutionFor(date ? dailyKey(date, level) : seedKey(seed, level), proof.attempt).join("");
	if (proof.grid !== solution) return refuse("that grid is not the solution of this run's puzzle");
	return { ok: true, low: true, level, score: Math.max(Math.round(score), Math.floor(elapsed / 1000) - CLOCK_SLACK_S), daily };
}
