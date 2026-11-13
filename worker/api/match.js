// worker/api/match.js — results: anonymous play counts, confirmed matches,
// ratings, match history, public profiles.
//
// Counts (no sign-in): the host reports each finished match once —
//   POST /api/stats/played { game, bots }   → plays[game].count++
//   GET  /api/stats/summary                 → { games: { id: { played } } }
//
// Leaderboard matches (signed in): every signed-in player in a match reports
// it — POST /api/match/report { game, run, match, kind, ranking, scores?,
// roster } — where `roster` maps the party ids in `ranking` to account ids
// (party members publish theirs, lib/account.js). The server turns ranking
// into accounts (players without an account drop out of it) and keeps the
// report. A match **counts** when two different accounts that played in it
// have sent the *same* result; a different result from anyone in it voids
// the match; a report nobody confirms within 15 minutes is dropped. Bots
// never count (Lokesh, 2026-11-13: leaderboards are human-only), nor does a
// match with fewer than two accounts, nor "local" (one-phone) games.
//
// Ratings, per account per game: duel → Elo (K 32, from 1200); every kind →
// games and wins (first place); coop → best score.

import { GAME_ID, HttpError, body, now, randomId, sha256 } from "./http.js";

export const REPORT_TTL_MS = 15 * 60_000;
export const ELO_START = 1200;
export const ELO_K = 32;
const KINDS = ["duel", "ffa", "teams", "coop"];

const all = async (stmt) => (await stmt.all()).results ?? [];

/** Elo after a duel: `score` is 1 (a won), 0 (a lost) or 0.5. Pure. */
export function elo(a, b, score, k = ELO_K) {
	const expect = 1 / (1 + 10 ** ((b - a) / 400));
	return [a + k * (score - expect), b + k * (1 - score - (1 - expect))];
}

/**
 * The result in accounts: `ranking` of party ids → of account ids (via
 * `roster`), players without an account dropped, empty places dropped.
 * Throws on anything malformed. Pure.
 */
export function toAccounts({ kind, ranking, roster, scores }) {
	if (!KINDS.includes(kind)) throw new HttpError(400, "this kind of game is not ranked");
	if (!Array.isArray(ranking) || !ranking.length || ranking.length > 16) throw new HttpError(400, "ranking is a list of places");
	if (!roster || typeof roster !== "object") throw new HttpError(400, "roster maps players to accounts");
	const ids = ranking.flat();
	if (!ids.every((id) => typeof id === "string") || ids.length > 16 || new Set(ids).size !== ids.length) {
		throw new HttpError(400, "every player appears once");
	}
	if (ids.some((id) => id.startsWith("bot_"))) return { bots: true };
	const accounts = new Set();
	const places = ranking
		.map((slot) =>
			slot
				.map((id) => roster[id])
				.filter((a) => typeof a === "string" && a.length < 40)
				.sort(),
		)
		.filter((slot) => slot.length);
	for (const a of places.flat()) {
		if (accounts.has(a)) throw new HttpError(400, "an account plays one seat");
		accounts.add(a);
	}
	const s = {};
	for (const [pid, acct] of Object.entries(roster)) {
		const v = scores?.[pid];
		if (accounts.has(acct) && typeof v === "number" && Number.isFinite(v)) s[acct] = v;
	}
	return { places, accounts: [...accounts], scores: Object.keys(s).length ? s : null };
}

/** POST /api/stats/played — the host's count of a finished match. */
export async function played(env, request) {
	const b = await body(request);
	if (!GAME_ID.test(b.game ?? "")) throw new HttpError(400, "unknown game");
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
	return { games: Object.fromEntries(rows.map((r) => [r.game, { played: r.count }])), at: now() };
}

/** POST /api/match/report */
export async function report(env, me, request) {
	const b = await body(request);
	if (!GAME_ID.test(b.game ?? "")) throw new HttpError(400, "unknown game");
	if (typeof b.run !== "string" || !b.run || b.run.length > 40) throw new HttpError(400, "run is the party's run id");
	const match = Number.isInteger(b.match) ? b.match : 1;
	if (b.kind === "local") return { counted: false, why: "one-phone games are not ranked" };
	const r = toAccounts(b);
	if (r.bots) return { counted: false, why: "games with bots are not ranked" };
	if (!r.accounts.includes(me.id)) throw new HttpError(400, "you can only report a match you played");
	if (r.accounts.length < 2) return { counted: false, why: "a ranked match needs two signed-in players" };

	const key = await sha256(`${b.game}|${b.run}|${match}`);
	const canonical = JSON.stringify({ game: b.game, kind: b.kind, places: r.places, scores: r.scores });
	const digest = await sha256(canonical);
	const t = now();
	await env.DB.prepare("DELETE FROM reports WHERE at < ?").bind(t - REPORT_TTL_MS).run();
	if (await env.DB.prepare("SELECT 1 FROM matches WHERE id = ?").bind(key).first()) return { counted: true, already: true };

	await env.DB.prepare("INSERT OR REPLACE INTO reports (match, account, digest, payload, at) VALUES (?, ?, ?, ?, ?)")
		.bind(key, me.id, digest, canonical, t)
		.run();
	const reports = await all(env.DB.prepare("SELECT account, digest FROM reports WHERE match = ?").bind(key));
	// Only reports from accounts that are in the result itself.
	const fromPlayers = reports.filter((x) => r.accounts.includes(x.account));
	if (new Set(fromPlayers.map((x) => x.digest)).size > 1) {
		await env.DB.prepare("DELETE FROM reports WHERE match = ?").bind(key).run();
		await env.DB.prepare("INSERT OR IGNORE INTO kv (k, v) VALUES (?, ?)").bind(`void:${key}`, String(t)).run();
		return { counted: false, why: "the players disagree about this match, so it does not count" };
	}
	if (await env.DB.prepare("SELECT 1 FROM kv WHERE k = ?").bind(`void:${key}`).first()) {
		return { counted: false, why: "the players disagreed about this match, so it does not count" };
	}
	if (fromPlayers.length < 2) return { counted: false, pending: true };
	await commit(env, key, b.game, b.kind, r, t);
	return { counted: true };
}

/** Record a confirmed match and move everyone's ratings. */
async function commit(env, id, game, kind, r, t) {
	const inserted = await env.DB.prepare("INSERT OR IGNORE INTO matches (id, game, kind, ranking, scores, at) VALUES (?, ?, ?, ?, ?, ?)")
		.bind(id, game, kind, JSON.stringify(r.places), r.scores ? JSON.stringify(r.scores) : null, t)
		.run();
	if (!inserted.meta?.changes) return; // two confirmations raced; the first one counted it
	const rows = await all(
		env.DB.prepare(`SELECT account, elo, games, wins, best FROM ratings WHERE game = ? AND account IN (${r.accounts.map(() => "?").join(",")})`).bind(
			game,
			...r.accounts,
		),
	);
	const cur = new Map(r.accounts.map((a) => [a, { elo: ELO_START, games: 0, wins: 0, best: null }]));
	for (const row of rows) cur.set(row.account, row);
	const next = new Map([...cur].map(([a, v]) => [a, { ...v, games: v.games + 1 }]));
	// First place is a win, unless everyone shares it (a draw, or co-op).
	if (r.places.length > 1) for (const a of r.places[0]) next.get(a).wins++;
	if (kind === "duel" && r.accounts.length === 2) {
		const [x, y] = r.places.length > 1 ? [r.places[0][0], r.places[1][0]] : r.places[0];
		const [ex, ey] = elo(cur.get(x).elo, cur.get(y).elo, r.places.length > 1 ? 1 : 0.5);
		next.get(x).elo = ex;
		next.get(y).elo = ey;
	}
	if (kind === "coop" && r.scores) {
		for (const [a, s] of Object.entries(r.scores)) next.get(a).best = Math.max(next.get(a).best ?? -Infinity, s);
	}
	await env.DB.batch([
		...r.places.flatMap((slot, place) =>
			slot.map((a) => env.DB.prepare("INSERT OR IGNORE INTO match_players (match, account, place) VALUES (?, ?, ?)").bind(id, a, place)),
		),
		...[...next].map(([a, v]) =>
			env.DB.prepare(
				`INSERT INTO ratings (account, game, elo, games, wins, best) VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT (account, game) DO UPDATE SET elo = excluded.elo, games = excluded.games, wins = excluded.wins, best = excluded.best`,
			).bind(a, game, v.elo, v.games, v.wins, v.best),
		),
		env.DB.prepare("DELETE FROM reports WHERE match = ?").bind(id),
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
	if (ids.length) {
		for (const a of await all(env.DB.prepare(`SELECT id, name FROM accounts WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids))) {
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

export async function ratingsOf(env, account) {
	return all(env.DB.prepare("SELECT game, elo, games, wins, best FROM ratings WHERE account = ? ORDER BY games DESC").bind(account));
}

/** GET /api/u/:id — a public profile, unless its owner hid it. */
export async function publicProfile(env, id) {
	const a = await env.DB.prepare("SELECT id, name, avatar, created, hide_public FROM accounts WHERE id = ?").bind(id).first();
	if (!a || a.hide_public) throw new HttpError(404, "no such player");
	return { id: a.id, name: a.name, avatar: a.avatar, since: a.created, ratings: await ratingsOf(env, a.id), matches: await matchesOf(env, a.id, 20) };
}

export const newRun = () => randomId(8);
