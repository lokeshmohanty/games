// worker/api/lb.js — leaderboards.
//
//   GET /api/lb/<game>?scope=global          everyone not hidden, ≥ LB_MIN_GAMES games
//   GET /api/lb/<game>?scope=friends         you and your friends (signed in)
//   GET /api/lb/<game>?scope=group:<id>      a group you are in (signed in)
//   GET /api/lb/<game>?vs=bots&scope=…       wins against bots (worker/api/bots.js)
//
// A board's kind is fixed by the server, never by a report: SOLO's pin
// (worker/api/runs.js) or else its game's manifest kind from the generated
// table (worker/api/games.js); an id that is not there has no board.
//
// Order: duel, free-for-all and teams by rating (`elo`, match.js
// ratingDeltas; wins and win rate still shown); co-op by best score; "time"
// (a game whose solo runs are timed, worker/api/runs.js SOLO: Sudoku, one
// board per difficulty, `<game>@<level>`) by best — lowest — time, in
// seconds. Rows on a rated board say `provisional` for a player's first 10
// rated games; the global board still needs LB_MIN_GAMES games, friends and
// groups show everyone. A group's board is computed from the
// matches its members played *only against each other* (Lokesh, 2026-11-13: group leaderboards), with its
// own rating — so a group of friends has a ladder that the rest of the world
// cannot move.
//
// Lists of accounts (friends, members) travel as one JSON parameter
// (`json_each(?)`) or a subquery, never one `?` each: D1 allows 100 bound
// parameters a query (an audit, 2026-11-15: friends boards failed at about 97
// friends, group boards at 99 members).
//
// The board of wins against bots is another table (`bot_wins`) and another
// order — wins, then who reached them first — and never mixes with these. A
// ranked board says whether its game has one (`botsBoard`), so the page can
// offer it; its group scope lists the members' wins (bots play no member).

import { ELO_START, RATED, ratingDeltas, shownRating } from "./match.js";
import { BOTS, BOTS_PER_DAY, botsBoard } from "./bots.js";
import { boardKind, isBoardKey, levelsOf, unitOf } from "./runs.js";
import { HttpError } from "./http.js";
import { NO_BOARD } from "./games.js";
import { friendIds } from "./social.js";

export const MIN_GAMES = 5;
const all = async (stmt) => (await stmt.all()).results ?? [];

const rated = (kind) => RATED.includes(kind);
const order = (kind) =>
	rated(kind) ? "elo DESC, games DESC"
	: kind === "coop" ? "best DESC, games DESC"
	: kind === "time" ? "best IS NULL, best ASC, games DESC"
	: "wins DESC, (wins * 1.0 / games) DESC, games DESC";

/** A board's row: rank, who, and the numbers (shownRating: `rated`, `provisional`, `best` only as a score). */
const row = (r, i, kind) => {
	const s = shownRating(r, kind);
	return {
		rank: i + 1,
		id: r.account,
		name: r.name,
		avatar: r.avatar ?? null,
		elo: Math.round(r.elo),
		games: r.games,
		wins: r.wins,
		best: s.best,
		...(s.rated != null ? { rated: s.rated, provisional: s.provisional } : {}),
	};
};

/** Global and friends: straight from `ratings`. `only`: those accounts, as one JSON parameter. */
async function fromRatings(env, game, kind, { only = null, includeHidden = false, min = 1, limit = 100 }) {
	const where = ["r.game = ?", "r.games >= ?"];
	const args = [game, min];
	if (!includeHidden) where.push("a.hide_public = 0");
	if (only) {
		if (!only.length) return [];
		where.push("r.account IN (SELECT value FROM json_each(?))");
		args.push(JSON.stringify(only));
	}
	const rows = await all(
		env.DB.prepare(
			`SELECT r.account, r.elo, r.games, r.wins, r.best, a.name, a.avatar FROM ratings r JOIN accounts a ON a.id = r.account
			 WHERE ${where.join(" AND ")} ORDER BY ${order(kind ?? "ffa")} LIMIT ?`,
		).bind(...args, limit),
	);
	return rows.map((r, i) => row(r, i, kind));
}

/**
 * Where `me` stands on a `fromRatings` board even past its LIMIT: their row
 * with `rank` (players ahead of them by the board's order, plus one), or
 * `rank: null` with why — `need` more games, or `hidden` from public boards.
 * null when they have no ranked game of this one.
 */
async function standing(env, game, kind, me, rows, { only = null, includeHidden = false, min = 1 }) {
	const listed = rows.find((r) => r.id === me.id);
	if (listed) return listed;
	const mine = await env.DB.prepare(
		"SELECT r.account, r.elo, r.games, r.wins, r.best, a.name, a.avatar, a.hide_public FROM ratings r JOIN accounts a ON a.id = r.account WHERE r.game = ? AND r.account = ?",
	)
		.bind(game, me.id)
		.first();
	if (!mine) return null;
	if (mine.games < min) return { ...row(mine, 0, kind), rank: null, need: min - mine.games };
	if (mine.hide_public && !includeHidden) return { ...row(mine, 0, kind), rank: null, hidden: true };
	// "Ahead" in the same order as order(kind); a tie on every key is not ahead.
	const k = kind ?? "ffa";
	const [ahead, aheadArgs] =
		rated(k)
			? ["r.elo > ? OR (r.elo = ? AND r.games > ?)", [mine.elo, mine.elo, mine.games]]
			: k === "coop"
				? ["COALESCE(r.best, -1e18) > ? OR (COALESCE(r.best, -1e18) = ? AND r.games > ?)", [mine.best ?? -1e18, mine.best ?? -1e18, mine.games]]
				: k === "time"
					? ["COALESCE(r.best, 1e18) < ? OR (COALESCE(r.best, 1e18) = ? AND r.games > ?)", [mine.best ?? 1e18, mine.best ?? 1e18, mine.games]]
					: // wins, then win rate (cross-multiplied, so integers), then games
					[
						"r.wins > ? OR (r.wins = ? AND r.wins * ? > ? * r.games) OR (r.wins = ? AND r.wins * ? = ? * r.games AND r.games > ?)",
						[mine.wins, mine.wins, mine.games, mine.wins, mine.wins, mine.games, mine.wins, mine.games],
					];
	const where = ["r.game = ?", "r.games >= ?", `(${ahead})`];
	const args = [game, min, ...aheadArgs];
	if (!includeHidden) where.push("a.hide_public = 0");
	if (only) {
		where.push("r.account IN (SELECT value FROM json_each(?))");
		args.push(JSON.stringify(only));
	}
	const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ratings r JOIN accounts a ON a.id = r.account WHERE ${where.join(" AND ")}`)
		.bind(...args)
		.first();
	return row(mine, n?.n ?? 0, kind);
}

/**
 * The most recent matches a group's board replays. Replaying is CPU on the
 * Worker (~1 ms a thousand, more on a cold isolate; docs/accounts.md "CPU"),
 * and the free plan allows 10 ms a request: past this, the oldest drop out.
 */
export const GROUP_REPLAY = 500;
/**
 * And at most this many pairs of players across them: the rating compares
 * every two players of a match (match.js ratingDeltas), so a 16-player match
 * costs 240 pairs (it is 16 × 15) and a duel 2: ~330 four-player matches, or
 * 500 duels — half the first budget, whose 9.2 ms jitless was at the 10 ms
 * limit (a review, 2026-11-16; docs/accounts.md "CPU").
 */
export const GROUP_PAIRS = 4_000;
/**
 * And the most recent matches of the game it looks through for them: the
 * query is driven from the game's matches (index matches_game_at, newest
 * first) and stops here, so its reads are bounded by this, not by the size
 * of match_players (an audit, 2026-11-15: it scanned all of it, every game's,
 * on every view). A group's matches older than the game's last GROUP_SCAN
 * drop out of its board.
 */
export const GROUP_SCAN = 3000;

/**
 * The SQL of a group's matches: binds (game, GROUP_SCAN, group id,
 * GROUP_REPLAY). Exported for its query plan's test (scripts/test-accounts.mjs).
 */
export const GROUP_MATCHES_SQL = `SELECT m.id, m.kind, m.ranking, m.scores FROM (
	SELECT id, kind, ranking, scores, at FROM matches WHERE game = ? ORDER BY at DESC LIMIT ?
) m
WHERE NOT EXISTS (
	SELECT 1 FROM match_players p WHERE p.match = m.id AND p.account NOT IN (SELECT g.account FROM group_members g WHERE g.grp = ?)
)
ORDER BY m.at DESC LIMIT ?`;

/** A group: replay the matches played only among its members. */
async function forGroup(env, game, kind, grp, members) {
	if (!members.length) return [];
	const set = new Set(members);
	const newest = await all(env.DB.prepare(GROUP_MATCHES_SQL).bind(game, GROUP_SCAN, grp, GROUP_REPLAY));
	// The newest within GROUP_PAIRS, replayed oldest first.
	let pairs = 0;
	let n = 0;
	for (; n < newest.length; n++) {
		const text = newest[n].ranking;
		let k = 0; // players: half its quotes, counted without parsing or allocating
		for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 34) k++;
		k /= 2;
		if ((pairs += k * (k - 1)) > GROUP_PAIRS && n) break;
	}
	const matches = newest.slice(0, n).reverse();
	const st = new Map();
	const get = (a) => st.get(a) ?? st.set(a, { account: a, elo: ELO_START, games: 0, wins: 0, best: null, rated: 0 }).get(a);
	for (const m of matches) {
		const places = JSON.parse(m.ranking);
		const players = places.flat();
		if (!players.length || !players.every((a) => set.has(a))) continue;
		for (const a of players) get(a).games++;
		if (places.length > 1) for (const a of places[0]) get(a).wins++;
		if (rated(kind) && RATED.includes(m.kind)) {
			const deltas = ratingDeltas(m.kind, places, st);
			for (const a of players) {
				get(a).elo += deltas.get(a) ?? 0;
				get(a).rated++;
			}
		}
		if (m.scores && (m.kind === "coop" || kind === "coop" || kind === "time")) {
			for (const [a, s] of Object.entries(JSON.parse(m.scores))) {
				const was = get(a).best;
				get(a).best = was == null ? s : kind === "time" ? Math.min(was, s) : Math.max(was, s);
			}
		}
	}
	const names = new Map(
		(await all(env.DB.prepare("SELECT id, name, avatar FROM accounts WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(members)))).map((a) => [
			a.id,
			a,
		]),
	);
	const k = kind ?? "ffa";
	const cmp = rated(k)
		? (a, b) => b.elo - a.elo || b.games - a.games
		: k === "coop"
			? (a, b) => (b.best ?? -Infinity) - (a.best ?? -Infinity)
			: k === "time"
				? (a, b) => (a.best ?? Infinity) - (b.best ?? Infinity) || b.games - a.games
				: (a, b) => b.wins - a.wins || b.wins / b.games - a.wins / a.games;
	// A free-for-all or teams row carries its rated games where `best` is (shownRating).
	const counter = k === "ffa" || k === "teams";
	return [...st.values()]
		.filter((r) => names.has(r.account))
		.sort(cmp)
		.map((r, i) => row({ ...r, best: counter ? r.rated : r.best, name: names.get(r.account).name, avatar: names.get(r.account).avatar }, i, kind));
}

/**
 * A board. With `me` (signed in), it also carries `me`: where they stand on
 * it, even below the rows shown (standing()). The global board without `me`
 * is the same for everyone, so it is the one that is cached.
 */
export async function leaderboard(env, me, game, scope = "global", vs = null) {
	// "leaderboard": false (Lokesh, 2026-11-16): no board of any kind; its old rows stay, unserved.
	if (NO_BOARD.has(game.split("@")[0])) throw new HttpError(404, "this game has no leaderboard");
	if (vs === "bots") return againstBots(env, me, game, scope);
	if (!isBoardKey(game)) throw new HttpError(400, "unknown game");
	const kind = boardKind(game);
	// A game with a board per difficulty for its solo runs says which (Sudoku),
	// a board's score its unit (Light Cycles alone: seconds), and a game with a
	// board of wins against bots that it has one.
	const levels = levelsOf(game);
	const unit = unitOf(game);
	const bots = !!BOTS[game.split("@")[0]];
	const out = (x) => ({ ...x, ...(levels ? { levels } : {}), ...(unit ? { unit } : {}), ...(bots ? { botsBoard: true } : {}) });
	if (scope === "global") {
		const min = Number(env.LB_MIN_GAMES ?? MIN_GAMES);
		const rows = await fromRatings(env, game, kind, { min });
		if (!me) return out({ game, kind, scope, min, rows });
		return out({ game, kind, scope, min, rows, me: await standing(env, game, kind, me, rows, { min }) });
	}
	if (!me) throw new HttpError(401, "sign in to see your friends' and groups' boards");
	if (scope === "friends") {
		const only = [me.id, ...(await friendIds(env, me.id))];
		const rows = await fromRatings(env, game, kind, { only, includeHidden: true });
		return out({ game, kind, scope, rows, me: await standing(env, game, kind, me, rows, { only, includeHidden: true }) });
	}
	const grp = scope.startsWith("group:") ? scope.slice(6) : null;
	if (!grp) throw new HttpError(400, "scope is global, friends or group:<id>");
	const members = (await all(env.DB.prepare("SELECT account FROM group_members WHERE grp = ?").bind(grp))).map((r) => r.account);
	if (!members.includes(me.id)) throw new HttpError(403, "you are not in that group");
	const g = await env.DB.prepare("SELECT name FROM groups WHERE id = ?").bind(grp).first();
	const rows = await forGroup(env, game, kind, grp, members);
	return out({ game, kind, scope, group: { id: grp, name: g?.name }, rows, me: rows.find((r) => r.id === me.id) ?? null });
}

/** A game's board of wins against bots, in the same scopes (bots.js botsBoard). */
async function againstBots(env, me, game, scope) {
	const head = { game, kind: "bots", vs: "bots", scope, perDay: Number(env.BOTS_PER_DAY ?? BOTS_PER_DAY) };
	if (scope === "global") return { ...head, ...(await botsBoard(env, me, game)) };
	if (!me) throw new HttpError(401, "sign in to see your friends' and groups' boards");
	if (scope === "friends") {
		const only = [me.id, ...(await friendIds(env, me.id))];
		return { ...head, ...(await botsBoard(env, me, game, { only, includeHidden: true })) };
	}
	const grp = scope.startsWith("group:") ? scope.slice(6) : null;
	if (!grp) throw new HttpError(400, "scope is global, friends or group:<id>");
	const members = (await all(env.DB.prepare("SELECT account FROM group_members WHERE grp = ?").bind(grp))).map((r) => r.account);
	if (!members.includes(me.id)) throw new HttpError(403, "you are not in that group");
	const g = await env.DB.prepare("SELECT name FROM groups WHERE id = ?").bind(grp).first();
	return { ...head, group: { id: grp, name: g?.name }, ...(await botsBoard(env, me, game, { only: members, includeHidden: true })) };
}

/** Every board with a ranked player (snapshot.js) — of a game still in the table (worker/api/games.js). */
export async function boardsWithRatings(env) {
	return (await all(env.DB.prepare("SELECT DISTINCT game FROM ratings"))).map((r) => r.game).filter(isBoardKey);
}

/** The top of each of `games` (default: every board), for the public snapshot. */
export async function topOfEveryGame(env, limit = 100, games = null) {
	games ??= await boardsWithRatings(env);
	const out = {};
	const min = Number(env.LB_MIN_GAMES ?? MIN_GAMES);
	for (const game of games) {
		const kind = boardKind(game);
		out[game] = { kind, rows: await fromRatings(env, game, kind, { min, limit }) };
	}
	return out;
}
