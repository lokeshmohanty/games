// worker/api/runs.js — server-issued solo runs: what makes a score played
// alone harder to fake (Lokesh, 2026-11-15: recommendations 1 and 2).
//
// A solo run (one player, no bots) has nobody to confirm it, so the server
// takes part in it instead — and only for the games in SOLO, whose limits it
// knows. Every other game played alone does not rank.
//
//   POST /api/run/start { game }  (signed in, a SOLO game)  → { run, seed, at }
//   POST /api/run/start { game, vs: "bots" }  (a BOTS game: worker/api/bots.js)
//
// issues a random run id and a seed, and keeps them with the account, the
// game and the server's clock (D1 `runs`, worker/migrations/0003_runs.sql).
// The platform passes the seed into the game's `init` (lib/sdk-managed.js),
// and the solo report names the run as its `run` (lib/account.js). A run is
// good for RUN_TTL_MS and for one counted report.
//
// checkSoloRun() refuses, with a `why`, a solo report for a game not in SOLO;
// whose run is missing, unknown, expired, already used, another account's or
// another game's; past the account's SOLO_PER_DAY counted runs of that game;
// one that arrives sooner after the run began than the game's `minMs`; and
// one whose score is not a number from 0 to `base + perSecond × (seconds
// since the run began − leadMs)`, nor over the game's `max`. A game with a
// `verify` (Sudoku: worker/api/sudoku.js) is checked by it instead. Only
// then does claimRun() use the run up — late, so a report that fails (or a
// Worker that runs out of CPU while checking) leaves it to be reported
// again — in one conditional UPDATE (`used IS NULL` and the day's count
// under the cap), so it counts once and parallel reports stop at the cap.
//
// What this does not stop: a player who waits out the clock and then reports
// a made-up score under the ceiling. It makes faking slow and bounded, not
// impossible.

import { BOTS } from "./bots.js";
import { GAME_ID, HttpError, body, now, randomId } from "./http.js";
import { LEVEL_IDS, verifySudoku } from "./sudoku.js";

export const RUN_TTL_MS = 6 * 3600_000; // a run may be reported this long after it began
const KEEP_MS = 4 * 24 * 3600_000; // rows kept this long: the daily counts and Sudoku's daily-once
export const DAY_MS = 24 * 3600_000;
const RUNS_KEPT = 20; // unused runs kept per account; older ones are dropped
const STARTS_PER_DAY = 200; // runs issued per account per game per day, of each kind (solo, bots)
export const SOLO_PER_DAY = 50; // counted solo runs per account per game per day (env SOLO_PER_DAY)

/**
 * The games whose runs played alone rank, and how. `minMs`: the shortest
 * plausible run (server clock, from the run's start to its report); `base` +
 * `perSecond`: the highest plausible score for a run that long, after
 * `leadMs` of it that never score (a countdown); `max`: the highest score
 * the game can make at all, however long the run; `verify`: a
 * check of the game's own proof; `board`: the kind of the game's leaderboard,
 * pinned whatever kind its latest match was ("coop": best score; "time":
 * best, lowest, time). With `levels`, solo runs rank on one board per level,
 * `<game>@<level>`, of kind `board`; the game's own board is then `plain`.
 * A game with levels and no `verify` has one: its solo board (Light Cycles'
 * `@alone`, beside its races). `unit`: what the board's score is in, for the
 * page to say (lb.js passes it on).
 */
export const SOLO = {
	// A gem spawns with chance 0.02 per 60 Hz frame while fewer than 3 are out
	// (games/neon-survival-mp: 1.2 a second at most, 2 to start), and a ship
	// jumps to the finger, so even catching every one is under 1.2 a second.
	// A ship nobody steers can die 2 s after the run is issued (measured,
	// scripts/test-social.mjs): the ceiling, not the minimum, does the work.
	// Its board is best score for every run, alone or not (match.js commit).
	"neon-survival-mp": { minMs: 1_000, base: 5, perSecond: 2, integer: true, board: "coop" },
	// Races (free-for-all) on the game's own board; solo times per difficulty.
	"lokeshmohanty/sudoku": { verify: verifySudoku, board: "time", levels: LEVEL_IDS, plain: "ffa" },
	// Alone, a round's score is the time ridden before the crash, in seconds
	// to the tenth (web-games light-cycles-rules.js: race time only, from GO,
	// never the 3.2 s countdown; it stops while the host's tab is hidden).
	// The page waits for this run before the rules' init (lib/sdk-managed.js
	// start), so the whole countdown — 4 beats of 0.8 s, on ticks that never
	// run fast — lies inside the server's time: a score may be at most that
	// time less 3.2 s, plus 1 s of slack. And the arena is 40 × 40: a rider
	// can take 1599 steps at most (120 each at 100, 90, 80 and 70 ms, the
	// rest at 60), 107.9 s, so nothing scores over 108 however long the run.
	// The fastest crash alone is four steps after GO. Its races (free-for-all,
	// wins) keep the game's own board; solo rounds rank on `…@alone`.
	"lokeshmohanty/light-cycles": {
		minMs: 3_000,
		leadMs: 3_200,
		base: 1,
		perSecond: 1,
		max: 108,
		tenths: true,
		board: "coop",
		levels: ["alone"],
		plain: "ffa",
		unit: "s",
	},
};

/**
 * The pinned kind of a board: `game` (SOLO's `board`, or `plain` for a game
 * with levels) or `game@level`; null when SOLO says nothing (the board then
 * follows its latest match, worker/api/lb.js).
 */
export function boardOf(key) {
	const at = key.indexOf("@");
	const s = SOLO[at < 0 ? key : key.slice(0, at)];
	if (!s) return null;
	if (at >= 0) return s.levels?.includes(key.slice(at + 1)) ? s.board : null;
	return s.levels ? (s.plain ?? null) : (s.board ?? null);
}
/** The solo levels (each its own board) of a game or of one of its boards, or null. */
export const levelsOf = (key) => SOLO[key.split("@")[0]]?.levels ?? null;
/** What a board's score is in (SOLO `unit`, on its solo boards only), or null. */
export const unitOf = (key) => (key.includes("@") ? (SOLO[key.split("@")[0]]?.unit ?? null) : null);
/** A leaderboard key: a game id, or `game@level` for a SOLO game's level. */
export const isBoardKey = (key) =>
	GAME_ID.test(key) || (key.includes("@") && GAME_ID.test(key.slice(0, key.indexOf("@"))) && boardOf(key) != null);

/** A seed as the platform's own: a non-negative 31-bit integer. */
const newSeed = () => crypto.getRandomValues(new Uint32Array(1))[0] >>> 1;

/** POST /api/run/start */
export async function startRun(env, me, request) {
	const b = await body(request);
	if (!GAME_ID.test(b.game ?? "")) throw new HttpError(400, "unknown game");
	const vs = b.vs === "bots" ? "bots" : "solo";
	if (vs === "solo" && !SOLO[b.game]) throw new HttpError(400, "this game does not rank games played alone");
	if (vs === "bots" && !BOTS[b.game]) throw new HttpError(400, "this game has no board for wins against bots");
	const t = now();
	const started = await env.DB.prepare("SELECT COUNT(*) AS n FROM runs WHERE account = ? AND vs = ? AND game = ? AND at > ?")
		.bind(me.id, vs, b.game, t - DAY_MS)
		.first();
	if ((started?.n ?? 0) >= STARTS_PER_DAY) throw new HttpError(429, "enough runs for today; play on, unranked");
	const run = { run: randomId(12), seed: newSeed(), at: t };
	await env.DB.batch([
		env.DB.prepare("DELETE FROM runs WHERE at < ?").bind(t - KEEP_MS),
		env.DB.prepare("INSERT INTO runs (id, account, game, seed, at, vs) VALUES (?, ?, ?, ?, ?, ?)").bind(run.run, me.id, b.game, run.seed, t, vs),
		env.DB.prepare(
			"DELETE FROM runs WHERE account = ? AND used IS NULL AND id NOT IN (SELECT id FROM runs WHERE account = ? AND used IS NULL ORDER BY at DESC LIMIT ?)",
		).bind(me.id, me.id, RUNS_KEPT),
	]);
	return run;
}

const refuse = (why) => ({ ok: false, why });

/**
 * A solo report, checked; nothing is written. `b` is the report, `score` the
 * player's (or undefined), `t` now. Resolves { ok: true, game, score, low,
 * daily } — the board to commit to, the score to record (Sudoku's may be
 * raised to the server's clock), lowest-is-best, and Sudoku's daily key — or
 * { ok: false, why }. claimRun() must then succeed before it is committed.
 */
export async function checkSoloRun(env, me, b, score, t) {
	const rule = SOLO[b.game];
	if (!rule) return refuse("this game does not rank games played alone");
	const row = await env.DB.prepare("SELECT account, game, seed, at, used, vs FROM runs WHERE id = ?").bind(b.run).first();
	if (!row) return refuse("a game played alone ranks only with a run the server issued as it began (this one is unknown or expired)");
	if (row.account !== me.id) return refuse("that run is another player's");
	if (row.game !== b.game) return refuse("that run was issued for another game");
	if (row.vs !== "solo") return refuse("that run was issued for a game against bots");
	if (t - row.at > RUN_TTL_MS) return refuse("that run expired");
	if (row.used != null) return refuse("that run was already reported");
	// Per game, so one game's quick rounds never use up another's. Checked
	// here to refuse early, and again in the claim, which is what holds.
	const perDay = Number(env.SOLO_PER_DAY ?? SOLO_PER_DAY);
	if ((await countedToday(env, me.id, "solo", b.game, t)) >= perDay) return refuse(soloCapWhy(perDay));
	const elapsed = t - row.at;
	if (rule.verify) {
		const dailyTaken = async (key) => !!(await env.DB.prepare("SELECT 1 FROM runs WHERE account = ? AND daily = ?").bind(me.id, key).first());
		const v = await rule.verify({ proof: b.proof, seed: row.seed, elapsed, score, at: t, dailyTaken });
		return v.ok ? { ok: true, game: v.level ? `${b.game}@${v.level}` : b.game, score: v.score, low: !!v.low, daily: v.daily ?? null } : v;
	}
	if (
		typeof score !== "number" ||
		!Number.isFinite(score) ||
		score < 0 ||
		(rule.integer && !Number.isInteger(score)) ||
		(rule.tenths && Math.abs(score * 10 - Math.round(score * 10)) > 1e-6)
	) {
		// "unrankable": this game's results carry nothing to rank (a version from
		// before its solo score); the page stops asking for runs for it.
		return { ...refuse("a game played alone is ranked by its score, and this report has no usable one"), code: "unrankable" };
	}
	if (elapsed < rule.minMs) return refuse(`too fast: a run takes at least ${rule.minMs / 1000} s, and this one was ${Math.floor(elapsed / 1000)} s old`);
	if (rule.max != null && score > rule.max) return refuse(`that score is more than this game can make (at most ${rule.max})`);
	if (score > rule.base + (rule.perSecond * (elapsed - (rule.leadMs ?? 0))) / 1000) return refuse(`that score is more than a ${Math.floor(elapsed / 1000)}-second run can make`);
	// A game with levels and no check of its own has one board for its solo runs.
	return { ok: true, game: rule.levels ? `${b.game}@${rule.levels[0]}` : b.game, score: rule.tenths ? Math.round(score * 10) / 10 : score, low: false, daily: null };
}

export const soloCapWhy = (n) => `${n} games of this one played alone rank a day; this one does not`;

/** An account's counted runs of one kind (`vs`) and game in the day before `t`. */
export async function countedToday(env, account, vs, game, t) {
	const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM runs WHERE account = ? AND vs = ? AND game = ? AND counted = 1 AND used > ?")
		.bind(account, vs, game, t - DAY_MS)
		.first();
	return r?.n ?? 0;
}

/**
 * The claim, as one statement: use the run up, as counted, only while it is
 * unused AND the account has fewer than `perDay` counted runs of this kind
 * and game in the last day. One conditional UPDATE, so reports posted in
 * parallel cannot all pass a count read before any of them claimed (review,
 * 2026-11-15: ten parallel posts beat a cap of three). bots.js batches it
 * with the win it records.
 */
export function claimStatement(env, { run, t, daily = null, account, vs, game, perDay }) {
	return env.DB.prepare(
		`UPDATE runs SET used = ?, counted = 1, daily = ? WHERE id = ? AND used IS NULL
		 AND (SELECT COUNT(*) FROM runs WHERE account = ? AND vs = ? AND game = ? AND counted = 1 AND used > ?) < ?`,
	).bind(t, daily, run, account, vs, game, t - DAY_MS, perDay);
}

/** Why a claim changed nothing: the run was used, or the day's cap was reached. */
export async function unclaimedWhy(env, run, capWhy) {
	const row = await env.DB.prepare("SELECT used FROM runs WHERE id = ?").bind(run).first();
	return row?.used != null ? "that run was already reported" : capWhy;
}

/**
 * Use a solo run up, as counted: true when this report got it, else why not
 * — another report claimed it first, the day's cap for the game filled in
 * the meantime, or (Sudoku) the account already ranked that day's puzzle at
 * that level (the unique index runs_daily decides, so two racing daily
 * reports cannot both count).
 */
export async function claimRun(env, { run, t, daily, account, game, perDay }) {
	try {
		const res = await claimStatement(env, { run, t, daily, account, vs: "solo", game, perDay }).run();
		return res.meta?.changes ? true : await unclaimedWhy(env, run, soloCapWhy(perDay));
	} catch (err) {
		if (/UNIQUE/i.test(String(err?.message ?? err))) return "you already ranked that day's puzzle at this difficulty";
		throw err;
	}
}

/** Tests only (AUTH_TEST, loopback): move a run's start `ms` into the past. */
export async function ageRun(env, request) {
	const b = await body(request);
	await env.DB.prepare("UPDATE runs SET at = at - ? WHERE id = ?").bind(Number(b.ms) || 0, String(b.run ?? "")).run();
	return { aged: true };
}
