// worker/api/lb.js — leaderboards.
//
//   GET /api/lb/<game>?scope=global          everyone not hidden, ≥ LB_MIN_GAMES games
//   GET /api/lb/<game>?scope=friends         you and your friends (signed in)
//   GET /api/lb/<game>?scope=group:<id>      a group you are in (signed in)
//
// Order: duel by Elo; free-for-all and teams by wins, then win rate; co-op by
// best score. A group's board is computed from the matches its members played
// *only against each other* (Lokesh, 2026-11-13: group leaderboards), with its
// own Elo — so a group of friends has a ladder that the rest of the world
// cannot move.

import { ELO_START, elo } from "./match.js";
import { GAME_ID, HttpError } from "./http.js";
import { friendIds } from "./social.js";

export const MIN_GAMES = 5;
const all = async (stmt) => (await stmt.all()).results ?? [];

const order = (kind) =>
	kind === "duel" ? "elo DESC, games DESC" : kind === "coop" ? "best DESC, games DESC" : "wins DESC, (wins * 1.0 / games) DESC, games DESC";

/** The kind of a game, from its ranked matches (no match: unknown). */
async function kindOf(env, game) {
	return (await env.DB.prepare("SELECT kind FROM matches WHERE game = ? ORDER BY at DESC LIMIT 1").bind(game).first())?.kind ?? null;
}

const row = (r, i) => ({
	rank: i + 1,
	id: r.account,
	name: r.name,
	avatar: r.avatar ?? null,
	elo: Math.round(r.elo),
	games: r.games,
	wins: r.wins,
	best: r.best,
});

/** Global and friends: straight from `ratings`. */
async function fromRatings(env, game, kind, { only = null, includeHidden = false, min = 1, limit = 100 }) {
	const where = ["r.game = ?", "r.games >= ?"];
	const args = [game, min];
	if (!includeHidden) where.push("a.hide_public = 0");
	if (only) {
		if (!only.length) return [];
		where.push(`r.account IN (${only.map(() => "?").join(",")})`);
		args.push(...only);
	}
	const rows = await all(
		env.DB.prepare(
			`SELECT r.account, r.elo, r.games, r.wins, r.best, a.name, a.avatar FROM ratings r JOIN accounts a ON a.id = r.account
			 WHERE ${where.join(" AND ")} ORDER BY ${order(kind ?? "ffa")} LIMIT ?`,
		).bind(...args, limit),
	);
	return rows.map(row);
}

/** A group: replay the matches played only among its members. */
async function forGroup(env, game, kind, members) {
	if (!members.length) return [];
	const set = new Set(members);
	const matches = await all(
		env.DB.prepare(
			`SELECT m.id, m.kind, m.ranking, m.scores FROM matches m WHERE m.game = ? AND m.id IN (
				SELECT p.match FROM match_players p GROUP BY p.match HAVING SUM(CASE WHEN p.account IN (${members.map(() => "?").join(",")}) THEN 0 ELSE 1 END) = 0
			) ORDER BY m.at ASC`,
		).bind(game, ...members),
	);
	const st = new Map();
	const get = (a) => st.get(a) ?? st.set(a, { account: a, elo: ELO_START, games: 0, wins: 0, best: null }).get(a);
	for (const m of matches) {
		const places = JSON.parse(m.ranking);
		if (!places.flat().every((a) => set.has(a))) continue;
		for (const a of places.flat()) get(a).games++;
		if (places.length > 1) for (const a of places[0]) get(a).wins++;
		if (m.kind === "duel" && places.flat().length === 2) {
			const [x, y] = places.length > 1 ? [places[0][0], places[1][0]] : places[0];
			[get(x).elo, get(y).elo] = elo(get(x).elo, get(y).elo, places.length > 1 ? 1 : 0.5);
		}
		if (m.kind === "coop" && m.scores) {
			for (const [a, s] of Object.entries(JSON.parse(m.scores))) get(a).best = Math.max(get(a).best ?? -Infinity, s);
		}
	}
	const names = new Map(
		(await all(env.DB.prepare(`SELECT id, name, avatar FROM accounts WHERE id IN (${members.map(() => "?").join(",")})`).bind(...members))).map(
			(a) => [a.id, a],
		),
	);
	const k = kind ?? "ffa";
	const cmp =
		k === "duel"
			? (a, b) => b.elo - a.elo || b.games - a.games
			: k === "coop"
				? (a, b) => (b.best ?? -Infinity) - (a.best ?? -Infinity)
				: (a, b) => b.wins - a.wins || b.wins / b.games - a.wins / a.games;
	return [...st.values()]
		.filter((r) => names.has(r.account))
		.sort(cmp)
		.map((r, i) => row({ ...r, name: names.get(r.account).name, avatar: names.get(r.account).avatar }, i));
}

export async function leaderboard(env, me, game, scope = "global") {
	if (!GAME_ID.test(game)) throw new HttpError(400, "unknown game");
	const kind = await kindOf(env, game);
	if (scope === "global") {
		const min = Number(env.LB_MIN_GAMES ?? MIN_GAMES);
		return { game, kind, scope, min, rows: await fromRatings(env, game, kind, { min }) };
	}
	if (!me) throw new HttpError(401, "sign in to see your friends' and groups' boards");
	if (scope === "friends") {
		const only = [me.id, ...(await friendIds(env, me.id))];
		return { game, kind, scope, rows: await fromRatings(env, game, kind, { only, includeHidden: true }) };
	}
	const grp = scope.startsWith("group:") ? scope.slice(6) : null;
	if (!grp) throw new HttpError(400, "scope is global, friends or group:<id>");
	const members = (await all(env.DB.prepare("SELECT account FROM group_members WHERE grp = ?").bind(grp))).map((r) => r.account);
	if (!members.includes(me.id)) throw new HttpError(403, "you are not in that group");
	const g = await env.DB.prepare("SELECT name FROM groups WHERE id = ?").bind(grp).first();
	return { game, kind, scope, group: { id: grp, name: g?.name }, rows: await forGroup(env, game, kind, members) };
}

/** The top of every game, for the public snapshot (snapshot.js). */
export async function topOfEveryGame(env, limit = 100) {
	const games = (await all(env.DB.prepare("SELECT DISTINCT game FROM ratings"))).map((r) => r.game);
	const out = {};
	const min = Number(env.LB_MIN_GAMES ?? MIN_GAMES);
	for (const game of games) {
		const kind = await kindOf(env, game);
		out[game] = { kind, rows: await fromRatings(env, game, kind, { min, limit }) };
	}
	return out;
}
