// worker/api/match.js — results: anonymous play counts, confirmed matches,
// ratings, match history, public profiles.
//
// Counts (no sign-in): the host reports each finished match once —
//   POST /api/stats/played { game, bots }   → plays[game].count++
//   GET  /api/stats/summary                 → { games: { id: { played } } }
//
// A game is known by the generated table only (worker/api/games.js, from the
// catalogs the site lists): any other id is refused — counts, results,
// boards — and a result must be of its game's kind (kindFits).
//
// Leaderboard matches (signed in): every signed-in player in a match reports
// it — POST /api/match/report { game, run, match, kind, ranking, scores?,
// roster, seats, left? } — where `roster` maps the party ids in `ranking`
// and `left` to account ids (party members publish theirs, lib/account.js),
// `seats` is how many seats the match began with and `left` who of them left
// the party for good before the result. The server turns ranking into
// accounts (players without an account drop out of it, their place kept) and
// keeps the report. A match **counts** when accounts that played in it have
// sent the *same* result — for those accounts only (below); a different
// result from anyone in it voids the match; a report nobody confirms within
// 15 minutes is dropped. Bots never count (Lokesh, 2026-11-13: leaderboards
// are human-only), nor does a match with fewer than two accounts, nor "local"
// (one-phone) games — except a SOLO run (one player, no bots, `seats` 1, in a
// game listed in runs.js SOLO: Sudoku, Neon Survival alone), which counts on
// its player's own report (Lokesh, 2026-11-15). Nobody can confirm
// it, so the server takes part instead: a solo report's `run` must be one the
// server issued as the game began (POST /api/run/start), unused, the
// reporter's own and for this game, and the score must be plausible for the
// time since — or, for Sudoku, the solved grid checks out (worker/api/runs.js,
// worker/api/sudoku.js). It is recorded as a run (games, best score; for a
// "time" board the lowest; Sudoku on one board per difficulty), never a win
// over anybody, and never Elo.
//
// A ranking with a bot in it never reaches the ratings either. If its one
// person won, under a run the server issued for a match against bots, the
// win goes to the game's separate board of wins against bots
// (worker/api/bots.js; Lokesh, 2026-11-15) — and nowhere else.
//
// Ratings, per account per game: duel, free-for-all and teams → a skill
// rating in `elo` (pairwise Elo, ratingDeltas; K 48 for an account's first 10
// rated games of a game — "provisional" — then 32; from 1200); every kind →
// games and wins (first place); coop → best score.
//
// Who a confirmed match is recorded for (an audit, 2026-11-15: two accounts
// could record a match for a third that never reported it; account ids are
// public). Only the accounts that **themselves reported** the agreeing
// result, plus — under the leaver rule — an account that left:
//   - at once, when every account named in the result (and not marked as
//     having left) sent the same result;
//   - else after MATCH_GRACE_MS from the first report (at the next report, or
//     when the reports expire, worker sweep), with only the reporters, when at
//     least two agree.
// A named account that did not report gets nothing: no row in the match, no
// rating, no game counted — except under the leaver rule.
//
// Leaving is a loss (Lokesh, 2026-11-16). A report's `left` names the party
// ids seated when the match began (lib/account.js matchStart) that left the
// party for good before its result — after the reconnect grace, or by LEAVE
// PARTY — and every reporter must agree on it (it is part of the result).
// Leaving forfeits — a last place (teams: by team, toAccounts) — and such an
// account is recorded with the others only when all of these hold (departures()):
//   1. its own page said, as *this* match began, that it was seated in it —
//      POST /api/match/start { game, run, match }, kept as a `reports` row
//      with digest "start" keyed by sha256("start|game|run|match") — before
//      the match's first report; not used up by any report of its own of
//      that match (even one refused), and not withdrawn by its page because
//      the match ended without a result while it was still in the party
//      (END GAME, the host leaving, being removed — DELETE /api/match/start);
//   2. the departure is confirmed by at least two reporting accounts, or by
//      the one still there when everybody else left (a duel);
//   3. the grace has passed with no report of its own (its own, different,
//      report would have voided the match);
//   4. its seated page has stopped beating: a page in a match re-posts its
//      start every 2 minutes (lib/account.js), and a departure needs the
//      start's last beat older than MATCH_STALE_MS (3 min) — whatever any
//      other page of that account says (a review, 2026-11-16: presence was
//      one row per account, so a second page on the home screen made a
//      player still in the match look gone).
// A colluder therefore cannot name an account that never sat down with them
// in that very match (1), nor one still playing it (3, 4). A report from an
// account recorded as having left is told the match counted against it. Only managed
// games know a match's number as it begins (lib/sdk-managed.js), so only
// they send starts; in a game that runs its own matches a departure is never
// recorded (the leaver simply gets nothing).
//
// The report's answer carries the reporter's new rating and its change
// (`rating`: { elo, delta, provisional, rated }), so the end card can say
// "+12 → 1534" (lib/account.js endCard); so does a repeat after it counted.

import { botWinsOf, reportBotsWin } from "./bots.js";
import { GAMES, NO_BOARD } from "./games.js";
import { HttpError, body, now, randomId, sha256 } from "./http.js";
import { SOLO_PER_DAY, boardKind, checkSoloRun, claimRun } from "./runs.js";

export const REPORT_TTL_MS = 15 * 60_000;
/** How long a match waits for every named account before it counts with the reporters only (env MATCH_GRACE_MS). */
export const MATCH_GRACE_MS = 45_000;
/** A start (POST /api/match/start) is kept this long after its last beat. */
export const START_TTL_MS = 3600_000;
/** A seated page beats (re-posts its start) every 2 min; older than this, it has stopped (env MATCH_STALE_MS). */
export const MATCH_STALE_MS = 3 * 60_000;
/** A voided match stays void this long (kv `void:<match>`), then the row goes. */
export const VOID_TTL_MS = 3600_000;
export const ELO_START = 1200;
export const ELO_K = 32;
/** K for an account's first PROVISIONAL_GAMES rated games of a game: a new player finds their level sooner. */
export const ELO_K_PROVISIONAL = 48;
export const PROVISIONAL_GAMES = 10;
const KINDS = ["duel", "ffa", "teams", "coop"];
/** The kinds with a winner, rated, and with the leaver rule. */
export const RATED = ["duel", "ffa", "teams"];

const all = async (stmt) => (await stmt.all()).results ?? [];
const startKey = (game, run, match) => sha256(`start|${game}|${run}|${match}`);

/**
 * Rating changes for one match: `places` of accounts (an empty place is a
 * guest's or someone not recorded: it keeps the order, and rates nobody),
 * `cur` account → { elo, rated } (rated: rated games so far). Pure.
 *
 * Pairwise Elo: every two players in different places are a game, the one
 * ahead winning it (the same place: a draw), and each player's change is the
 * sum over their opponents of K × (score − expected), divided by the number
 * of opponents — so beating a stronger player counts more, and a duel is
 * plain Elo. Teams: each place is a side rated at its members' mean, the
 * sides are the players, and every member moves by their side's sum (with
 * their own K). K is ELO_K_PROVISIONAL for a player's first
 * PROVISIONAL_GAMES rated games, then ELO_K.
 */
export function ratingDeltas(kind, places, cur) {
	const out = new Map();
	// Plain loops over arrays, no closures: a group board runs this for up to
	// GROUP_REPLAY matches in one request (worker/api/lb.js, docs "CPU").
	const units = []; // [members, rating, place] — a side's change is shared by its members, scaled (zeroSum)
	for (let i = 0; i < places.length; i++) {
		const slot = places[i];
		if (!slot.length) continue;
		if (kind === "teams") {
			let sum = 0;
			for (const a of slot) sum += cur.get(a)?.elo ?? ELO_START;
			units.push([slot, sum / slot.length, i]);
		} else for (const a of slot) units.push([[a], cur.get(a)?.elo ?? ELO_START, i]);
	}
	const n = units.length;
	if (n < 2 || (kind === "teams" && units.every((u) => u[2] === units[0][2]))) return out;
	for (let x = 0; x < n; x++) {
		const [members, rx, px] = units[x];
		let sum = 0;
		for (let y = 0; y < n; y++) {
			if (y === x) continue;
			const py = units[y][2];
			sum += (px < py ? 1 : px === py ? 0.5 : 0) - 1 / (1 + 10 ** ((units[y][1] - rx) / 400));
		}
		// Teams: a side's change is its members' to share — each moves by it
		// times the mean side size over their own side's size, so uneven sides
		// (3 against 1) still sum to zero (a review, 2026-11-16).
		const scale = kind === "teams" ? units.reduce((t, u) => t + u[0].length, 0) / n / members.length : 1;
		for (const a of members) out.set(a, (((cur.get(a)?.rated ?? 0) < PROVISIONAL_GAMES ? ELO_K_PROVISIONAL : ELO_K) * sum * scale) / (n - 1));
	}
	return out;
}

/** A result of `kind` for `game`: its manifest's kind (the table), or a scored free-for-all of a co-op game (Neon Survival's multi-ship runs). */
export const kindFits = (game, kind) => kind === GAMES[game] || (GAMES[game] === "coop" && kind === "ffa");

/**
 * A ratings row as the API shows it: `rated`, the games behind its rating,
 * and `provisional` while that is under PROVISIONAL_GAMES — on a rated board.
 * A free-for-all or teams board keeps that count in `best` (it has no best
 * score; no migration), so `best` is shown only where it is a score.
 */
export function shownRating(row, kind = boardKind(row.game)) {
	const counter = kind === "ffa" || kind === "teams";
	const rated = kind === "duel" ? row.games : counter ? (row.best ?? 0) : null;
	const out = { ...row, best: counter ? null : (row.best ?? null) };
	if (rated != null) Object.assign(out, { rated, provisional: rated < PROVISIONAL_GAMES });
	return out;
}

/**
 * The result in accounts: `ranking` of party ids → of account ids (via
 * `roster`). A guest (no account) drops out of their place but the place
 * stays, so a player second behind a guest is second, not first; trailing
 * empty places go. Throws on anything malformed. Pure.
 *
 * `left` (party ids) — players who left for good (duel, ffa, teams): leaving
 * forfeits. Places the game left empty (an emptied side keeps an empty slot
 * for the devices' stats) go first, then:
 *   - duel, free-for-all: each leaver out of their place (a place only
 *     leavers held goes) and into a last place shared by the leavers;
 *   - teams, with `teams` (party id → team, from the match's start): a team
 *     all of whose players left forfeits as a side, in a last place; a
 *     player who left a team that plays on stays in their side's place —
 *     unless that side won, then in a last place alone — so the others'
 *     outcome is the game's: a draw stays a draw. Their loss is rated against
 *     the opposing teams only, never their own (`sides`, `forfeits`, rated
 *     by sideDeltas). Without `teams` (an older page): as free-for-all.
 */
export function toAccounts({ kind, ranking, roster, scores, left, teams }) {
	if (!KINDS.includes(kind)) throw new HttpError(400, "this kind of game is not ranked");
	if (!Array.isArray(ranking) || !ranking.length || ranking.length > 16 || !ranking.every(Array.isArray)) throw new HttpError(400, "ranking is a list of places");
	if (!roster || typeof roster !== "object") throw new HttpError(400, "roster maps players to accounts");
	const ids = ranking.flat();
	if (!ids.every((id) => typeof id === "string") || ids.length > 16 || new Set(ids).size !== ids.length) {
		throw new HttpError(400, "every player appears once");
	}
	const gone = left == null ? [] : left;
	if (!Array.isArray(gone) || gone.length > 16 || !gone.every((id) => typeof id === "string")) throw new HttpError(400, "left lists the players who left");
	if (teams != null && (typeof teams !== "object" || Object.keys(teams).length > 16)) throw new HttpError(400, "teams maps players to their teams");
	if (ids.some((id) => id.startsWith("bot_"))) return { bots: true };
	const acct = (id) => (typeof roster[id] === "string" && roster[id] && roster[id].length < 40 ? roster[id] : null);
	const departed = RATED.includes(kind) ? [...new Set(gone.map(acct).filter(Boolean))].sort() : [];
	const out = new Set(departed);
	// An emptied side's empty place goes once the leaver rule applies (else it
	// would stand first, ahead of the player who stayed).
	const raw = departed.length ? ranking.filter((slot) => slot.length) : ranking;
	// Team of each account, by its party id (teams only; a short label).
	const teamOf = new Map();
	if (kind === "teams" && teams) {
		for (const [pid, t] of Object.entries(teams)) {
			const a = acct(pid);
			if (a && (typeof t === "string" || typeof t === "number") && String(t).length <= 24) teamOf.set(a, String(t));
		}
	}
	let places;
	let sides = null;
	let forfeits = null;
	// Without departures, or a team for every account in it: as the game ranked it.
	const byTeam = kind === "teams" && departed.length && [...raw.flat().map(acct).filter(Boolean), ...departed].every((a) => teamOf.has(a));
	if (byTeam) {
		// The game's places among those still here (a guest's place stays).
		const kept = raw
			.filter((slot) => slot.some((id) => !acct(id)) || slot.some((id) => acct(id) && !out.has(acct(id))))
			.map((slot) => slot.map(acct).filter((a) => a && !out.has(a)).sort());
		const at = new Map(); // team → its place among `kept`
		kept.forEach((slot, i) => slot.forEach((a) => at.has(teamOf.get(a)) || at.set(teamOf.get(a), i)));
		const goneTeams = [...new Set(departed.filter((a) => !at.has(teamOf.get(a))).map((a) => teamOf.get(a)))].sort();
		const won = (t) => at.get(t) === 0 && (kept.filter((x) => x.length).length > 1 || goneTeams.length > 0);
		places = kept.map((slot) => [...slot]);
		const tail = [];
		forfeits = [];
		for (const a of departed) {
			const t = teamOf.get(a);
			if (!at.has(t)) continue; // their whole team left: below
			if (won(t)) tail.push(a);
			else places[at.get(t)].push(a);
			forfeits.push({ a, against: kept.flat().filter((b) => teamOf.get(b) !== t) });
		}
		for (const t of goneTeams) places.push(departed.filter((a) => teamOf.get(a) === t));
		if (tail.length) places.push(tail);
		places = places.map((slot) => slot.sort());
		// Rated as teams: each team still here at its place; each team that left, last.
		sides = [
			...[...at].map(([t, i]) => ({ members: kept[i].filter((a) => teamOf.get(a) === t), at: i })),
			...goneTeams.map((t) => ({ members: departed.filter((a) => teamOf.get(a) === t), at: kept.length })),
		];
	} else {
		// A place only leavers held goes with them (a guest's stays: it keeps the order).
		places = raw.filter((slot) => !slot.length || !slot.every((id) => out.has(acct(id)))).map((slot) => slot.map(acct).filter((a) => a && !out.has(a)).sort());
		if (departed.length) places.push(departed);
	}
	while (places.length && !places.at(-1).length) places.pop();
	const accounts = places.flat();
	if (new Set(accounts).size !== accounts.length) throw new HttpError(400, "an account plays one seat");
	const s = {};
	for (const [pid, a] of Object.entries(roster)) {
		const v = scores?.[pid];
		if (accounts.includes(a) && typeof v === "number" && Number.isFinite(v)) s[a] = v;
	}
	return { places, accounts, departed, scores: Object.keys(s).length ? s : null, ...(sides ? { sides, forfeits } : {}) };
}

/**
 * Rating changes from teams as sides (toAccounts `sides`: { members, at },
 * a lower `at` ahead, equal a draw) and leavers' forfeits ({ a, against }):
 * each side rated at its members' mean, pairwise Elo between sides; a
 * player who left a team that played on loses one game against the mean of
 * `against` — the opposing teams — and moves nobody else. Pure.
 */
export function sideDeltas(sides, forfeits, cur) {
	const out = new Map();
	const r = (a) => cur.get(a)?.elo ?? ELO_START;
	const k = (a) => ((cur.get(a)?.rated ?? 0) < PROVISIONAL_GAMES ? ELO_K_PROVISIONAL : ELO_K);
	const mean = (xs) => xs.reduce((t, a) => t + r(a), 0) / xs.length;
	const live = sides.filter((x) => x.members.length);
	if (live.length > 1) {
		const m = live.map((x) => mean(x.members));
		const size = live.reduce((t, x) => t + x.members.length, 0) / live.length; // the mean side size
		live.forEach((x, i) => {
			let sum = 0;
			for (let j = 0; j < live.length; j++) if (j !== i) sum += (x.at < live[j].at ? 1 : x.at === live[j].at ? 0.5 : 0) - 1 / (1 + 10 ** ((m[j] - m[i]) / 400));
			// Shared by the side, scaled so uneven sides still sum to zero.
			for (const a of x.members) out.set(a, (k(a) * sum * (size / x.members.length)) / (live.length - 1));
		});
	}
	for (const { a, against } of forfeits ?? []) {
		if (against.length) out.set(a, k(a) * (0 - 1 / (1 + 10 ** ((mean(against) - r(a)) / 400))));
	}
	return out;
}

/** POST /api/stats/played — the host's count of a finished match (a game in the table only). */
export async function played(env, request) {
	const b = await body(request);
	if (typeof b.game !== "string" || !GAMES[b.game]) throw new HttpError(400, "unknown game");
	await env.DB.prepare(
		`INSERT INTO plays (game, count, with_bots, updated) VALUES (?, 1, ?, ?)
		 ON CONFLICT (game) DO UPDATE SET count = count + 1, with_bots = with_bots + excluded.with_bots, updated = excluded.updated`,
	)
		.bind(b.game, b.bots ? 1 : 0, now())
		.run();
	return { counted: true };
}

export async function summary(env) {
	const rows = await all(env.DB.prepare("SELECT game, count FROM plays"));
	return { games: Object.fromEntries(rows.filter((r) => GAMES[r.game]).map((r) => [r.game, { played: r.count }])), at: now() };
}

/**
 * POST /api/match/start { game, run, match } — "I am seated in this match":
 * the evidence a departure needs (the leaver rule, above). The page sends it
 * as a ranked match with people begins (lib/account.js matchStart) and again
 * every 2 minutes while the match runs — its heartbeat. One row per account
 * and match: `payload` keeps when it was first said, `at` the last beat.
 */
export async function startMatch(env, me, request) {
	const b = await body(request);
	if (typeof b.game !== "string" || !RATED.includes(GAMES[b.game]) || NO_BOARD.has(b.game)) throw new HttpError(400, "only a ranked game with a winner records who began it");
	if (typeof b.run !== "string" || !b.run || b.run.length > 40) throw new HttpError(400, "run is the party's run id");
	if (!Number.isInteger(b.match) || b.match < 0) throw new HttpError(400, "match is the match's number in its run");
	const t = now();
	await env.DB.prepare(
		`INSERT INTO reports (match, account, digest, payload, at) VALUES (?, ?, 'start', ?, ?)
		 ON CONFLICT (match, account) DO UPDATE SET at = excluded.at WHERE digest = 'start'`,
	)
		.bind(await startKey(b.game, b.run, b.match), me.id, String(t), t)
		.run();
	return { started: true };
}

/**
 * DELETE /api/match/start { game, run, match } — withdrawn: the match ended
 * without a result while this page was still in the party (END GAME, the
 * host leaving, being removed). Nothing can then name this account as having
 * left it.
 */
export async function withdrawStart(env, me, request) {
	const b = await body(request);
	if (typeof b.game !== "string" || typeof b.run !== "string" || !Number.isInteger(b.match)) throw new HttpError(400, "game, run and match name the match");
	await env.DB.prepare("DELETE FROM reports WHERE match = ? AND account = ? AND digest = 'start'")
		.bind(await startKey(b.game, b.run, b.match), me.id)
		.run();
	return { withdrawn: true };
}

/** POST /api/match/report */
export async function report(env, me, request) {
	const b = await body(request);
	if (typeof b.game !== "string" || !GAMES[b.game]) throw new HttpError(400, "unknown game");
	// "leaderboard": false in its manifest: nothing of it is ranked (the page does not send this).
	if (NO_BOARD.has(b.game)) return { counted: false, why: "this game has no leaderboard", code: "no-board" };
	if (typeof b.run !== "string" || !b.run || b.run.length > 40) throw new HttpError(400, "run is the party's run id (played alone: the server's, POST /api/run/start)");
	const match = Number.isInteger(b.match) ? b.match : 1;
	if (b.kind === "local") return { counted: false, why: "one-phone games are not ranked" };
	const r = toAccounts(b);
	// Never ranked: at most a win on the game's board against bots.
	if (r.bots) return reportBotsWin(env, me, b, now());
	if (!r.accounts.includes(me.id)) throw new HttpError(400, "you can only report a match you played");
	// Alone only when the match *began* with one seat (`seats`, lib/account.js):
	// a match whose other players all left also ends with one id in it, and is
	// not a run played alone (review, 2026-11-16).
	const solo = b.seats === 1 && b.ranking.flat().length === 1 && r.accounts.length === 1 && !r.departed.length;
	const key = await sha256(`${b.game}|${b.run}|${match}`);
	const t = now();
	// Reporting a match is being there: our own start of it is used up (rule
	// 1) whatever becomes of this report — refused, voided, or too late.
	if (!solo) await env.DB.prepare("DELETE FROM reports WHERE match = ? AND account = ? AND digest = 'start'").bind(await startKey(b.game, b.run, match), me.id).run();
	await sweep(env, t);
	const done = await countedFor(env, key, me.id);
	if (done) return done;
	if (solo) {
		// Nobody confirms a run played alone: its server-issued run does. All
		// the checks first, then the run is claimed (once), then committed —
		// to the board the check names (Sudoku: one per difficulty), with the
		// score it names (Sudoku's: raised to the server's clock).
		const v = await checkSoloRun(env, me, b, r.scores?.[me.id], t);
		if (!v.ok) return { counted: false, why: v.why, ...(v.code ? { code: v.code } : {}) };
		const claimed = await claimRun(env, { run: b.run, t, daily: v.daily, account: me.id, game: b.game, perDay: Number(env.SOLO_PER_DAY ?? SOLO_PER_DAY) });
		if (claimed !== true) return { counted: false, why: claimed };
		return commit(env, { id: key, game: v.game, kind: "coop", places: [[me.id]], scores: { [me.id]: v.score }, recorded: [me.id], t, low: v.low, solo: true, who: me.id });
	}
	if (!kindFits(b.game, b.kind)) throw new HttpError(400, `${b.game} is a ${GAMES[b.game]} game; a ${b.kind} result for it does not count`);
	if (r.accounts.length < 2) return { counted: false, why: "a ranked match needs two signed-in players" };
	if (await env.DB.prepare("SELECT 1 FROM kv WHERE k = ?").bind(`void:${key}`).first()) {
		return { counted: false, why: "the players disagreed about this match, so it does not count" };
	}
	const canonical = JSON.stringify({ game: b.game, run: b.run, match, kind: b.kind, places: r.places, left: r.departed, scores: r.scores, ...(r.sides ? { sides: r.sides, forfeits: r.forfeits } : {}) });
	const digest = await sha256(canonical);
	// A re-sent report keeps the time of the first: the grace runs from it.
	await env.DB.prepare(
		`INSERT INTO reports (match, account, digest, payload, at) VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT (match, account) DO UPDATE SET digest = excluded.digest, payload = excluded.payload`,
	)
		.bind(key, me.id, digest, canonical, t)
		.run();
	return settle(env, key, me.id, t);
}

/** The answer for an account asking about a match that already counted, or null when it has not. */
async function countedFor(env, key, who) {
	const m = await env.DB.prepare(
		`SELECT (SELECT 1 FROM match_players WHERE match = ? AND account = ?) AS mine,
		        (SELECT payload FROM reports WHERE match = ? AND account = ? AND digest = 'counted') AS outcome
		 FROM matches WHERE id = ?`,
	)
		.bind(key, who, key, who, key)
		.first();
	if (!m) return null;
	if (!m.mine) return { counted: false, why: "this match counted without your report: it came after the others had waited for it" };
	let outcome = null;
	try {
		outcome = m.outcome ? JSON.parse(m.outcome) : null;
	} catch {}
	const rating = outcome?.elo != null ? { rating: { elo: outcome.elo, delta: outcome.delta, rated: outcome.rated, provisional: outcome.provisional } } : {};
	// Recorded as having left it: not "counted" — counted against you.
	if (outcome?.left) return { counted: false, left: true, why: "this match counted against you: the others reported that you left it", ...rating };
	return { counted: true, already: true, ...rating };
}

/**
 * Decide a match from its reports (D1 `reports`): void it, wait, or commit it
 * — for whom, by the rules at the top. `who`: the account asking (null from
 * the sweep). Resolves the asker's answer.
 */
async function settle(env, key, who, t) {
	const grace = Number(env.MATCH_GRACE_MS ?? MATCH_GRACE_MS);
	const rows = (await all(env.DB.prepare("SELECT account, digest, payload, at FROM reports WHERE match = ?").bind(key)))
		.filter((x) => x.digest !== "counted" && x.digest !== "start")
		.map((x) => ({ ...x, p: JSON.parse(x.payload) }));
	if (!rows.length) return { counted: false, why: "this match was not reported" };
	// A different result from anyone that another report names voids it.
	for (const x of rows) {
		for (const y of rows) {
			if (x.digest !== y.digest && x.p.places.flat().includes(y.account)) {
				await env.DB.batch([
					env.DB.prepare("DELETE FROM reports WHERE match = ?").bind(key),
					env.DB.prepare("INSERT OR IGNORE INTO kv (k, v) VALUES (?, ?)").bind(`void:${key}`, String(t)),
				]);
				return { counted: false, why: "the players disagree about this match, so it does not count" };
			}
		}
	}
	const groups = new Map();
	for (const x of rows) groups.set(x.digest, [...(groups.get(x.digest) ?? []), x]);
	const agreed = [...groups.values()].sort((a, b) => b.length - a.length)[0];
	const P = agreed[0].p;
	const agreeing = agreed.map((x) => x.account);
	const left = P.left ?? [];
	const present = P.places.flat().filter((a) => !left.includes(a));
	const first = Math.min(...rows.map((x) => x.at));
	const base = { id: key, game: P.game, kind: P.kind, places: P.places, scores: P.scores, sides: P.sides ?? null, forfeits: P.forfeits ?? null, t, who };
	if (!left.length && agreeing.length >= 2 && present.every((a) => agreeing.includes(a))) return commit(env, { ...base, recorded: agreeing });
	if (t < first + grace) return { counted: false, pending: true, settleAt: first + grace };
	const confirmed = agreeing.length >= 2 || (present.length === 1 && agreeing.length === 1);
	const departed = left.length && confirmed ? await departures(env, P, left, first, t) : [];
	if (agreeing.length + departed.length < 2 || (agreeing.length < 2 && !departed.length)) {
		return { counted: false, pending: true, why: "the other players have not confirmed this match" };
	}
	return commit(env, { ...base, recorded: [...agreeing, ...departed], departed, startOf: await startKey(P.game, P.run, P.match) });
}

/**
 * Of `left`, the accounts a departure can be recorded for (rules 1 and 4 at
 * the top): seated as this match began by their own word, before its first
 * report (`first`; the start's `payload`), not used up or withdrawn since,
 * still an account, and its page no longer beating: the last beat (`at`)
 * older than MATCH_STALE_MS. One query, one row per leaver.
 */
async function departures(env, P, left, first, t) {
	if (!Number.isInteger(P.match)) return [];
	const rows = await all(
		env.DB.prepare(
			`SELECT s.account FROM reports s JOIN accounts a ON a.id = s.account
			 WHERE s.match = ? AND s.digest = 'start' AND s.account IN (SELECT value FROM json_each(?))
			 AND CAST(s.payload AS INTEGER) <= ? AND s.at < ?`,
		).bind(await startKey(P.game, P.run, P.match), JSON.stringify(left), first, t - Number(env.MATCH_STALE_MS ?? MATCH_STALE_MS)),
	);
	return rows.map((x) => x.account);
}

/**
 * Record a match for `recorded` (and nobody else) and move their ratings, in
 * one batch — one transaction. Its first statement is a plain INSERT of the
 * match, so a second commit of the same match (two last reports at once)
 * fails on the primary key and the whole batch rolls back: a match counts
 * once, and an account that is missing (deleted since) makes nothing half
 * written. Ratings change by increments (`games + 1`, `elo + delta`, MAX/MIN
 * of best), so two matches committing at once for one account both count.
 * `low`: the scores are times, and the best is the lowest (a "time" board,
 * worker/api/runs.js). Resolves `who`'s answer.
 */
async function commit(env, { id, game, kind, places, scores, sides = null, forfeits = null, recorded, departed = [], startOf = null, t, low = false, solo = false, who }) {
	const exist = new Set(
		(await all(env.DB.prepare("SELECT id FROM accounts WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(recorded)))).map((x) => x.id),
	);
	const keep = new Set(recorded.filter((a) => exist.has(a)));
	if (keep.size < (solo ? 1 : 2)) return { counted: false, why: "a ranked match needs two signed-in players" };
	const ranked = places.map((s) => s.filter((a) => keep.has(a)));
	while (ranked.length && !ranked.at(-1).length) ranked.pop();
	const kept = scores ? Object.fromEntries(Object.entries(scores).filter(([a]) => keep.has(a))) : null;
	const score = kept && Object.keys(kept).length ? kept : null;
	const board = boardKind(game);
	const rated = RATED.includes(board) && RATED.includes(kind);
	const counter = board === "ffa" || board === "teams"; // `best` counts rated games (shownRating)
	const accounts = [...keep];
	const cur = new Map();
	if (rated) {
		const rows = await all(
			env.DB.prepare("SELECT account, elo, games, best FROM ratings WHERE game = ? AND account IN (SELECT value FROM json_each(?))").bind(game, JSON.stringify(accounts)),
		);
		for (const x of rows) cur.set(x.account, { elo: x.elo, rated: counter ? (x.best ?? 0) : x.games });
	}
	// Teams with a leaver: by team (toAccounts `sides`), only those recorded.
	const deltas = !rated
		? new Map()
		: sides
			? sideDeltas(
					sides.map((x) => ({ ...x, members: x.members.filter((a) => keep.has(a)) })),
					(forfeits ?? []).filter((f) => keep.has(f.a)).map((f) => ({ a: f.a, against: f.against.filter((b) => keep.has(b)) })),
					cur,
				)
			: ratingDeltas(kind, ranked, cur);
	// First place is a win, unless everyone shares it (a draw, or co-op).
	const winners = new Set(ranked.length > 1 ? ranked[0] : []);
	const bestScores = !!score && (kind === "coop" || board === "coop");
	const bestSql = rated && counter ? "COALESCE(best, 0) + 1" : bestScores ? `CASE WHEN excluded.best IS NULL THEN best WHEN best IS NULL THEN excluded.best ELSE ${low ? "MIN" : "MAX"}(best, excluded.best) END` : "best";
	const outcome = new Map(
		accounts.map((a) => {
			if (!rated) return [a, {}];
			const was = cur.get(a) ?? { elo: ELO_START, rated: 0 };
			const delta = deltas.get(a) ?? 0;
			return [a, { elo: Math.round(was.elo + delta), delta: Math.round(delta), rated: was.rated + 1, provisional: was.rated + 1 < PROVISIONAL_GAMES }];
		}),
	);
	const stmts = [
		env.DB.prepare("INSERT INTO matches (id, game, kind, ranking, scores, at) VALUES (?, ?, ?, ?, ?, ?)").bind(id, game, kind, JSON.stringify(ranked), score ? JSON.stringify(score) : null, t),
		...ranked.flatMap((slot, place) => slot.map((a) => env.DB.prepare("INSERT INTO match_players (match, account, place) VALUES (?, ?, ?)").bind(id, a, place))),
		...accounts.map((a) => {
			const d = deltas.get(a) ?? 0;
			const b = rated && counter ? 1 : bestScores ? (score[a] ?? null) : null;
			return env.DB.prepare(
				`INSERT INTO ratings (account, game, elo, games, wins, best) VALUES (?, ?, ?, 1, ?, ?)
				 ON CONFLICT (account, game) DO UPDATE SET elo = elo + ?, games = games + 1, wins = wins + excluded.wins, best = ${bestSql}`,
			).bind(a, game, ELO_START + d, winners.has(a) ? 1 : 0, b, d);
		}),
		// Each player's outcome waits in a report row for a repeat to read
		// (countedFor) — a leaver's too, marked, so a late report of theirs is
		// told the match counted against them.
		...accounts.map((a) =>
			env.DB.prepare("INSERT OR REPLACE INTO reports (match, account, digest, payload, at) VALUES (?, ?, 'counted', ?, ?)").bind(
				id,
				a,
				JSON.stringify(departed.includes(a) ? { ...outcome.get(a), left: true } : outcome.get(a)),
				t,
			),
		),
		env.DB.prepare("DELETE FROM reports WHERE match = ? AND digest <> 'counted'").bind(id),
	];
	// A departure uses up the leaver's start (rule 1): it counts once.
	if (departed.length && startOf) stmts.push(env.DB.prepare("DELETE FROM reports WHERE match = ? AND account IN (SELECT value FROM json_each(?))").bind(startOf, JSON.stringify(departed)));
	try {
		await env.DB.batch(stmts);
	} catch (err) {
		// Committed by someone else a moment ago: theirs stands.
		if (/UNIQUE|PRIMARY KEY/i.test(String(err?.message ?? err))) return (who && (await countedFor(env, id, who))) || { counted: true, already: true };
		throw err;
	}
	if (!who) return { counted: true };
	if (!keep.has(who)) return { counted: false, why: "this match counted without your report" };
	const mine = outcome.get(who);
	return { counted: true, ...(mine?.elo != null ? { rating: mine } : {}) };
}

/**
 * The upkeep each report does first (and the hourly cron): reports about to
 * expire are settled one last time — the grace is long past, so a match two
 * agreed on counts even if nobody asked again — then dropped; outcomes, old
 * starts and old void marks go too. At most SWEEP_MATCHES matches a call.
 */
const SWEEP_MATCHES = 5;
export async function sweep(env, t = now()) {
	const due = await all(
		// DISTINCT, not GROUP BY: the planner then walks reports_at, not every row.
		env.DB.prepare("SELECT DISTINCT match FROM reports WHERE at < ? AND digest NOT IN ('start', 'counted') LIMIT ?").bind(t - REPORT_TTL_MS, SWEEP_MATCHES),
	);
	for (const { match } of due) {
		try {
			await settle(env, match, null, t);
		} catch (err) {
			console.error("settle", err);
		}
		await env.DB.prepare("DELETE FROM reports WHERE match = ? AND digest NOT IN ('start', 'counted')").bind(match).run();
	}
	await env.DB.batch([
		env.DB.prepare("DELETE FROM reports WHERE digest = 'counted' AND at < ?").bind(t - REPORT_TTL_MS),
		env.DB.prepare("DELETE FROM reports WHERE digest = 'start' AND at < ?").bind(t - START_TTL_MS),
		// The void marks (kv `void:<match>`), by the key's range: the primary key's index.
		env.DB.prepare("DELETE FROM kv WHERE k >= 'void:' AND k < 'void;' AND CAST(v AS INTEGER) < ?").bind(t - VOID_TTL_MS),
	]);
}

/** A list of matches with players' names: for history and profiles. */
export async function matchesOf(env, account, limit = 30) {
	const rows = await all(
		env.DB.prepare(
			`SELECT m.id, m.game, m.kind, m.ranking, m.scores, m.at, p.place FROM match_players p JOIN matches m ON m.id = p.match
			 WHERE p.account = ? ORDER BY m.at DESC LIMIT ?`,
		).bind(account, limit),
	);
	const ids = [...new Set(rows.flatMap((r) => JSON.parse(r.ranking).flat()))];
	const names = new Map();
	// One bound parameter however many players (D1 allows 100 a query; 30
	// matches of 16 is 480 ids).
	if (ids.length) {
		for (const a of await all(env.DB.prepare("SELECT id, name FROM accounts WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(ids)))) {
			names.set(a.id, a.name);
		}
	}
	return rows.map((r) => ({
		id: r.id,
		game: r.game,
		kind: r.kind,
		at: r.at,
		place: r.place,
		won: r.place === 0 && JSON.parse(r.ranking).length > 1,
		ranking: JSON.parse(r.ranking).map((slot) => slot.map((a) => ({ id: a, name: names.get(a) ?? "(deleted)" }))),
		scores: r.scores ? JSON.parse(r.scores) : null,
	}));
}

/** An account's ratings, as shown (shownRating: `rated`, `provisional`); boards of games no longer listed are left out. */
export async function ratingsOf(env, account) {
	const rows = await all(env.DB.prepare("SELECT game, elo, games, wins, best FROM ratings WHERE account = ? ORDER BY games DESC").bind(account));
	return rows.filter((r) => boardKind(r.game)).map((r) => shownRating(r));
}

/** GET /api/u/:id — a public profile, unless its owner hid it. */
export async function publicProfile(env, id) {
	const a = await env.DB.prepare("SELECT id, name, avatar, created, hide_public FROM accounts WHERE id = ?").bind(id).first();
	if (!a || a.hide_public) throw new HttpError(404, "no such player");
	return {
		id: a.id,
		name: a.name,
		avatar: a.avatar,
		since: a.created,
		ratings: await ratingsOf(env, a.id),
		matches: await matchesOf(env, a.id, 20),
		botWins: await botWinsOf(env, a.id),
	};
}

export const newRun = () => randomId(8);
