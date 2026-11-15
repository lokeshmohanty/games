// worker/api/sudoku.js — the server's check of a solo Sudoku run.
//
// COPIED, NOT IMPORTED: everything between the two "copy" lines below is
// sudoku/sudoku-rules.js lines 12–216 from lokeshmohanty/arcade-games
// (branch platform-v2, commit d05ae1d), one tab of indent removed. The game
// deals a new puzzle with puzzleFor(seed, level) from the platform's init
// seed; the server issued that seed (worker/api/runs.js), so it makes the same
// puzzle here and checks the player's grid against it. If the game's
// generator ever changes, this copy must change with it and the pin must move
// to that commit — scripts/test-accounts.mjs compares the two for a set of
// seeds whenever ../arcade-games-v2 is checked out beside this repo.
//
// What is checked (verifySudoku): the puzzle was dealt in this run (from its
// seed, or the daily puzzle of a date near now), the grid is a full, valid
// solution that keeps every clue, and neither the server's clock nor the
// reported time is below the difficulty's fastest plausible solve
// (MIN_SOLVE_S). The score is the reported time in seconds, raised to the
// server's clock less CLOCK_SLACK_S; lower is better. Cheap checks first.

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

const countSolutions = (grid, limit = 2) => search(grid, { limit });

function solve(grid) {
	let found = null;
	search(grid, { limit: 1, onSolution: (g) => (found = g) });
	return found;
}

/**
 * Can this be finished with singles alone — a cell with one candidate left,
 * or a digit with one place left in a unit? That is the line between the
 * puzzles anyone can finish by looking and the ones that need real
 * deduction, so it is what separates the difficulties.
 */
function solvesWithSingles(grid) {
	const g = grid.slice();
	for (let progress = true; progress;) {
		progress = false;
		for (let i = 0; i < CELLS; i++) {
			if (g[i]) continue;
			const m = candidates(g, i);
			if (!m) return false;
			if (bitCount(m) === 1) {
				g[i] = Math.log2(m);
				progress = true;
			}
		}
		for (const unit of UNITS) {
			for (let d = 1; d <= 9; d++) {
				if (unit.some((i) => g[i] === d)) continue;
				const spots = unit.filter((i) => !g[i] && candidates(g, i) & (1 << d));
				if (spots.length === 1) {
					g[spots[0]] = d;
					progress = true;
				}
			}
		}
	}
	return g.every(Boolean);
}

/**
 * The difficulties. `clues` is where removing stops; `singles` says the
 * result must (true) or must not (false) be finishable by singles alone.
 * Hard and Expert both need more than singles; Expert also takes away as
 * many clues as the grid allows.
 */
const LEVELS = {
	easy: { label: "Easy", clues: 38, singles: true, botMs: 7000 },
	medium: { label: "Medium", clues: 31, singles: true, botMs: 10000 },
	hard: { label: "Hard", clues: 27, singles: false, botMs: 14000 },
	expert: { label: "Expert", clues: 17, singles: false, botMs: 19000 },
};
const LEVEL_IDS = Object.keys(LEVELS);

/**
 * Make a puzzle with exactly one solution. Returns `{ puzzle, solution }`,
 * both arrays of 81. Deterministic for a given `rng`.
 */
function generate(level, rng) {
	const spec = LEVELS[level];
	let fallback = null;
	// Hard and Expert want a puzzle singles cannot finish. At 27 clues about
	// two in three can be (measured: 26 in 40), so it takes a few tries —
	// twelve find one all but always; the rare run that does not deals the last try rather than stall.
	for (let attempt = 0; attempt < 12; attempt++) {
		let solution = null;
		search(Array(CELLS).fill(0), { limit: 1, rng, onSolution: (g) => (solution = g) });
		const puzzle = solution.slice();
		let clues = CELLS;
		for (const i of shuffle([...Array(CELLS).keys()], rng)) {
			if (clues <= spec.clues) break;
			const keep = puzzle[i];
			puzzle[i] = 0;
			if (countSolutions(puzzle) !== 1 || (spec.singles === true && !solvesWithSingles(puzzle))) {
				puzzle[i] = keep;
			} else {
				clues--;
			}
		}
		fallback = { puzzle, solution };
		if (spec.singles !== false || !solvesWithSingles(puzzle)) return fallback;
	}
	return fallback;
}

/** Today's puzzle for this difficulty: the same on every phone that day. */
const dailyPuzzle = (date, level) => generate(level, rngFrom(hashString(`sudoku:${date}:${level}`)));

/**
 * The puzzle a run's seed deals at this difficulty (the platform's init
 * `seed`). The arcade's server issues the seed of a ranked solo run, makes
 * the same puzzle from it with a copy of this generator
 * (games: worker/api/sudoku.js), and checks the solved grid against it — so
 * this function, generate() and everything they call must not change
 * without that copy changing too.
 */
const puzzleFor = (seed, level) => generate(level, rngFrom(hashString(`sudoku:seed:${seed >>> 0}:${level}`)));
// ---- copy: sudoku-rules.js, to here ----

/**
 * The fastest plausible solve per difficulty, in seconds: a phone takes a
 * tap to pick a cell and a tap for its digit, and easy leaves 43 cells to
 * fill. Below this, a time is not believed. Lokesh may tune these.
 */
export const MIN_SOLVE_S = { easy: 30, medium: 45, hard: 60, expert: 90 };

/** The daily puzzle of `date` may be reported this long either side of it (time zones). */
const DAILY_SLACK_MS = 36 * 3600_000;

export { CELLS, UNITS, LEVELS, LEVEL_IDS, generate, dailyPuzzle, puzzleFor, rngFrom, hashString, countSolutions };

const refuse = (why) => ({ ok: false, why });

/**
 * A reported time is raised to the server's clock less this slack: the run
 * begins before the puzzle is picked (and the first-open rules sheet may sit
 * in between), so a time well under the server's is not believed.
 */
export const CLOCK_SLACK_S = 60;

/**
 * A solo Sudoku report, checked. `proof` is the game's result proof
 * ({ start, level, daily, grid }), `seed` the run's, `elapsed` the server's ms
 * since it issued the run, `score` the reported time in seconds, `at` now,
 * `dailyTaken(key)` whether this account already ranked that daily puzzle.
 * Every cheap check runs before the puzzle is generated (the one costly
 * step). Resolves { ok: true, low: true, level, score, daily } — the time to
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
	if (typeof proof.grid !== "string" || !/^[1-9]{81}$/.test(proof.grid)) return refuse("the solved grid is missing or not full");
	const min = MIN_SOLVE_S[level];
	if (elapsed < min * 1000) return refuse(`too fast: a ${LEVELS[level].label} Sudoku takes at least ${min} s, and this run was ${Math.floor(elapsed / 1000)} s old`);
	if (typeof score !== "number" || !Number.isFinite(score)) return refuse("a Sudoku run is ranked by its time, and this report has none");
	if (score < min) return refuse(`too fast: a ${LEVELS[level].label} Sudoku takes at least ${min} s`);
	const g = [...proof.grid].map(Number);
	if (!UNITS.every((u) => new Set(u.map((i) => g[i])).size === 9)) return refuse("that grid is not a solution: a row, column or box repeats a digit");
	const daily = date ? `${date}:${level}` : null;
	if (daily && (await dailyTaken(daily))) return refuse("you already ranked that day's puzzle at this difficulty");
	// The one costly step, last: up to tens of ms (docs/accounts.md).
	const made = date ? dailyPuzzle(date, level) : puzzleFor(seed, level);
	if (made.puzzle.some((d, i) => d && g[i] !== d)) return refuse("that grid does not keep the puzzle's clues: it is not this run's puzzle");
	return { ok: true, low: true, level, score: Math.max(Math.round(score), Math.floor(elapsed / 1000) - CLOCK_SLACK_S), daily };
}
