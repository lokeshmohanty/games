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

import { PLATFORM_BYTES, PLATFORM_ID, RECORD_BYTES, clean, merge } from "../../lib/achievements.js";
import { GAME_ID, HttpError, body, now } from "./http.js";

export { RECORD_BYTES };
export const RECORD_GAMES = 200;
const PUT_GAMES = 64;
// A body of at most 64 KB: parsing, merging and writing 193 KB took 10–20 ms
// of CPU (review, 2026-11-24) against the free plan's 10 ms. The page sends
// at most 16 games a request (lib/records.js PUT_MAX).
export const PUT_BYTES = 64 * 1024;
const TRIES = 8; // a write that lost a race is merged again from what won it (each round, one writer wins)

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

/**
 * PUT: each game merged with what is kept, and written only if nobody wrote
 * it since we read it (`at` unchanged; a new row only if there is none). A
 * game that lost that race is read and merged again, so two devices' PUTs
 * at once never drop an unlock. A game that cannot be kept (a bad id, too
 * large, over the account's games) is refused on its own, in `rejected`,
 * and the rest still are.
 */
export async function putRecords(env, me, request) {
	const { games } = await body(request, PUT_BYTES);
	if (!games || typeof games !== "object" || Array.isArray(games)) throw new HttpError(400, "games is { [game]: state }");
	const ids = Object.keys(games);
	if (ids.length > PUT_GAMES) throw new HttpError(400, `at most ${PUT_GAMES} games at once`);
	const rejected = {};
	let todo = [];
	for (const g of ids) {
		if (!okGame(g)) rejected[g] = "not a game id";
		else todo.push(g);
	}
	const out = {};
	for (let attempt = 0; attempt < TRIES && todo.length; attempt++) {
		const held = await all(env.DB.prepare(`SELECT game, data, at FROM records WHERE account = ? AND game IN (${todo.map(() => "?").join(",")})`).bind(me.id, ...todo));
		const kept = new Map(held.map((r) => [r.game, r]));
		let room = RECORD_GAMES;
		if (kept.size < todo.length) room -= (await env.DB.prepare("SELECT COUNT(*) AS n FROM records WHERE account = ?").bind(me.id).first()).n;
		const t = now();
		const writes = [];
		const written = [];
		for (const g of todo) {
			const row = kept.get(g);
			const merged = merge(row ? parse(row.data) : undefined, games[g], g, { prefer: "y" });
			const data = JSON.stringify(merged);
			if (data.length > (g === PLATFORM_ID ? PLATFORM_BYTES : RECORD_BYTES)) {
				rejected[g] = "too large";
				continue;
			}
			out[g] = merged;
			if (row && JSON.stringify(clean(parse(row.data), g)) === data) continue; // nothing new
			if (!row && room-- <= 0) {
				rejected[g] = `records are kept for at most ${RECORD_GAMES} games`;
				delete out[g];
				continue;
			}
			// `at` moves on with every write, so a reader's `at` names one version.
			const at = row ? Math.max(t, row.at + 1) : t;
			writes.push(
				row
					? env.DB.prepare("UPDATE records SET data = ?, at = ? WHERE account = ? AND game = ? AND at = ?").bind(data, at, me.id, g, row.at)
					: env.DB.prepare("INSERT INTO records (account, game, data, at) VALUES (?, ?, ?, ?) ON CONFLICT (account, game) DO NOTHING").bind(me.id, g, data, at),
			);
			written.push(g);
		}
		const results = writes.length ? await env.DB.batch(writes) : [];
		todo = written.filter((g, i) => !(results[i]?.meta?.changes > 0)); // lost the race: again
		for (const g of todo) delete out[g];
	}
	for (const g of todo) rejected[g] = "busy: try again";
	return { games: out, ...(Object.keys(rejected).length ? { rejected } : {}) };
}
