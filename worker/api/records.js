// worker/api/records.js — the account's copy of a player's personal records
// and achievements (docs/accounts.md "Records and achievements"; the rules
// are lib/achievements.js, the same file the device runs).
//
//   GET /api/me/records       { games: { [game]: state } } — every game's, and "*"
//   PUT /api/me/records       { games: { [game]: state } } → the same, merged:
//                             each game's stored copy and the sent one become
//                             one by taking the best of each (an unlock at the
//                             earlier time, the larger count, the better
//                             record). Never a replace: a device that has less
//                             cannot lower anything.
//   records in GET /api/u/<who>  the player's, for the player and their
//                             friends only (worker/api/people.js)
//
// The device's word is taken (memory casual-not-competitive): nothing here
// is checked against results, and nothing ranks by it. What is checked is
// shape and size: `clean` drops anything malformed and bounds every list,
// a game's row is at most RECORD_BYTES, an account at most RECORD_GAMES rows.

import { PLATFORM_ID, clean, merge } from "../../lib/achievements.js";
import { GAME_ID, HttpError, body, now } from "./http.js";

export const RECORD_BYTES = 8 * 1024;
export const RECORD_GAMES = 200;
const PUT_GAMES = 64;

const all = async (stmt) => (await stmt.all()).results ?? [];
const okGame = (g) => g === PLATFORM_ID || GAME_ID.test(g);
const parse = (text) => {
	try {
		return JSON.parse(text);
	} catch {
		return {};
	}
};

/** An account's records: `{ [game]: state }`. */
export async function recordsOf(env, account) {
	const rows = await all(env.DB.prepare("SELECT game, data FROM records WHERE account = ? ORDER BY game").bind(account));
	return Object.fromEntries(rows.map((r) => [r.game, clean(parse(r.data), r.game)]));
}

export async function getRecords(env, me) {
	return { games: await recordsOf(env, me.id) };
}

export async function putRecords(env, me, request) {
	const { games } = await body(request, 256 * 1024);
	if (!games || typeof games !== "object" || Array.isArray(games)) throw new HttpError(400, "games is { [game]: state }");
	const ids = Object.keys(games);
	if (ids.length > PUT_GAMES) throw new HttpError(400, `at most ${PUT_GAMES} games at once`);
	const bad = ids.find((g) => !okGame(g));
	if (bad) throw new HttpError(400, `not a game id: ${String(bad).slice(0, 80)}`);
	if (!ids.length) return { games: {} };
	// What is kept, for the games sent: one read, then one batch of writes.
	const held = await all(
		env.DB.prepare(`SELECT game, data FROM records WHERE account = ? AND game IN (${ids.map(() => "?").join(",")})`).bind(me.id, ...ids),
	);
	const kept = new Map(held.map((r) => [r.game, parse(r.data)]));
	if (kept.size < ids.length) {
		const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM records WHERE account = ?").bind(me.id).first();
		if (n + ids.length - kept.size > RECORD_GAMES) throw new HttpError(400, `records are kept for at most ${RECORD_GAMES} games`);
	}
	const t = now();
	const out = {};
	const writes = [];
	for (const g of ids) {
		const merged = merge(kept.get(g), games[g], g);
		const data = JSON.stringify(merged);
		if (data.length > RECORD_BYTES) throw new HttpError(413, `the records for ${g} are too large`);
		out[g] = merged;
		if (kept.has(g) && JSON.stringify(clean(kept.get(g), g)) === data) continue; // nothing new
		writes.push(
			env.DB.prepare("INSERT INTO records (account, game, data, at) VALUES (?, ?, ?, ?) ON CONFLICT (account, game) DO UPDATE SET data = excluded.data, at = excluded.at").bind(
				me.id,
				g,
				data,
				t,
			),
		);
	}
	if (writes.length) await env.DB.batch(writes);
	return { games: out };
}
