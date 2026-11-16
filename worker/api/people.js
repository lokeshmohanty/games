// worker/api/people.js — a player's public profile, and what other people's
// profiles may say about who they played.
//
//   GET /api/u/<who>   <who>: an account id, or a friend code (worker/api/social.js)
//
//   - Not hidden: { id, name, avatar, since, hidden: false, ratings, matches, botWins }.
//   - Hidden from public boards (accounts.hide_public): a signed-in friend (or
//     the player) gets the same, with `hidden: true`; anyone else only
//     { id, name, hidden: true } — enough for ADD FRIEND from a friend link or
//     QR, nothing about how they play (Lokesh, 2026-11-16: audit D6).
//   - In anyone's `matches`, a player hidden from public boards is
//     { id: null, name: "(hidden)" } — unless it is the profile's own player
//     or the one asking (audit D5).
//
// The index routes /api/u/ here (match.js's old publicProfile is gone); it answers a
// personal copy (never cached publicly) when the request is signed in or
// names a friend code, which can be rotated.

import { botWinsOf } from "./bots.js";
import { HttpError } from "./http.js";
import { ratingsOf } from "./match.js";
import { boardKind, unitOf } from "./runs.js";
import { areFriends, findAccount } from "./social.js";

const all = async (stmt) => (await stmt.all()).results ?? [];

/**
 * Each rating with its board's own kind and unit, where the server pins them
 * (worker/api/runs.js SOLO: Sudoku's level boards are times, Light Cycles
 * alone is a best score in seconds); any other board's kind is its game's
 * manifest kind, from the Worker's table (runs.js boardKind).
 */
export const withBoards = (ratings) =>
	ratings.map((r) => {
		const kind = boardKind(r.game);
		const unit = unitOf(r.game);
		return { ...r, ...(kind ? { kind } : {}), ...(unit ? { unit } : {}) };
	});

/**
 * An account's most recent matches, named for `viewer` (an account id or
 * null): hidden players other than `account` and the viewer are "(hidden)".
 * Two bound parameters whatever the matches hold (D1 allows 100).
 */
export async function publicMatches(env, account, viewer = null, limit = 20) {
	const rows = await all(
		env.DB.prepare(
			`SELECT m.id, m.game, m.kind, m.ranking, m.scores, m.at, p.place FROM match_players p JOIN matches m ON m.id = p.match
			 WHERE p.account = ? ORDER BY m.at DESC LIMIT ?`,
		).bind(account, limit),
	);
	const people = new Map();
	if (rows.length) {
		const found = await all(
			env.DB.prepare(
				`SELECT DISTINCT a.id, a.name, a.hide_public FROM match_players q JOIN accounts a ON a.id = q.account
				 WHERE q.match IN (SELECT p.match FROM match_players p JOIN matches m ON m.id = p.match WHERE p.account = ? ORDER BY m.at DESC LIMIT ?)`,
			).bind(account, limit),
		);
		for (const a of found) people.set(a.id, a);
	}
	const named = (id) => {
		const a = people.get(id);
		if (!a) return { id, name: "(deleted)" };
		if (a.hide_public && id !== account && id !== viewer) return { id: null, name: "(hidden)" };
		return { id, name: a.name };
	};
	return rows.map((r) => {
		const ranking = JSON.parse(r.ranking);
		const scores = r.scores ? JSON.parse(r.scores) : null;
		const hiddenIds = new Set(ranking.flat().filter((id) => named(id).id === null));
		return {
			id: r.id,
			game: r.game,
			kind: r.kind,
			at: r.at,
			place: r.place,
			won: r.place === 0 && ranking.length > 1,
			ranking: ranking.map((slot) => slot.map(named)),
			// A hidden player's score keeps its place in the list, not their id.
			scores: scores && Object.fromEntries(Object.entries(scores).filter(([id]) => !hiddenIds.has(id))),
		};
	});
}

/** GET /api/u/<who>. `viewer`: the signed-in account asking, or null. */
export async function publicProfile(env, who, { viewer = null, gate = null } = {}) {
	const a = await findAccount(env, who, gate);
	if (!a) throw new HttpError(404, "no such player");
	const hidden = !!a.hide_public;
	if (hidden && !(viewer && (viewer.id === a.id || (await areFriends(env, viewer.id, a.id))))) {
		return { id: a.id, name: a.name, hidden: true };
	}
	return {
		id: a.id,
		name: a.name,
		avatar: a.avatar,
		since: a.created,
		hidden,
		ratings: withBoards(await ratingsOf(env, a.id)),
		matches: await publicMatches(env, a.id, viewer?.id ?? null, 20),
		botWins: await botWinsOf(env, a.id),
	};
}
