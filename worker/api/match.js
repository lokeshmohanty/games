// worker/api/match.js — results: anonymous play counts, confirmed matches,
// match history and head-to-head records.
//
// Counts (no sign-in): the host reports each finished match once —
//   POST /api/stats/played { game, bots }   → plays[game].count++
//   GET  /api/stats/summary                 → { games: { id: { played } } }
//
// A game is known by the generated table only (worker/api/games.js, from the
// catalogs the site lists): any other id is refused, and a result must be of
// its game's kind (kindFits).
//
// No boards, no ratings (Lokesh, 2026-11-25: casual, not competitive — party
// standings and head-to-head only). What is kept of a match is who played it
// and in what place, so two people can see how they do against each other
// (headToHead, below; worker/api/people.js, lib/profile.js).
//
// Matches among people (signed in): every signed-in player in a match reports
// it — POST /api/match/report { game, run, match, kind, ranking, scores?,
// roster, seats, left? } — where `roster` maps the party ids in `ranking`
// and `left` to account ids (party members publish theirs, lib/account.js),
// `seats` is how many seats the match began with and `left` who of them left
// the party for good before the result. The server turns ranking into
// accounts (players without an account drop out of it, their place kept) and
// keeps the report. A match **counts** when accounts that played in it have
// sent the *same* result — for those accounts only (below); a different
// result from anyone in it voids the match; a report nobody confirms within
// 15 minutes is dropped. This is what keeps one player from writing another's
// head-to-head record alone; it is not anti-cheat beyond that. A match with a
// bot in it, with fewer than two accounts, or a "local" (one-phone) game is
// not recorded: head-to-head is between people (the device keeps its own
// stats and records either way, lib/stats.js, lib/records.js).
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
// A named account that did not report gets nothing: no row in the match —
// except under the leaver rule.
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
//      start every 60 s (lib/account.js), and a departure needs the start's
//      last beat older than MATCH_STALE_MS (4.5 min) — whatever any
//      other page of that account says.
// A colluder therefore cannot name an account that never sat down with them
// in that very match (1), nor one still playing it (3, 4). A report from an
// account recorded as having left is told the match counted against it. Only managed
// games know a match's number as it begins (lib/sdk-managed.js), so only
// they send starts; in a game that runs its own matches a departure is never
// recorded (the leaver simply gets nothing).
//
// The report's answer carries the reporter's head-to-head record against
// each other account in the match, in this game (`vs`: [{ id, name, wins,
// losses, draws }]), so the end card can say "You 5–3 Asha" (lib/account.js
// endCard); so does a repeat after it counted.
//
// The old ranked surfaces answer 410 (worker/api/index.js): the boards
// (/api/lb/…) and server-issued runs (/api/run/start). Their tables —
// ratings, runs, bot_wins — are no longer written; dropping them is a later,
// explicit step (STATUS.md).

import { GAMES, KINDS as RESULT_KINDS } from "./games.js";
import { HttpError, body, now, requestNow, sha256 } from "./http.js";

export const REPORT_TTL_MS = 15 * 60_000;
/** How long a match waits for every named account before it counts with the reporters only (env MATCH_GRACE_MS). */
export const MATCH_GRACE_MS = 45_000;
/** A start (POST /api/match/start) is kept this long after its last beat. */
export const START_TTL_MS = 3600_000;
/**
 * A seated page beats (re-posts its start) every 60 s, a failed beat once
 * more 15 s later; older than this, it has stopped (env MATCH_STALE_MS) —
 * room for three lost beats in a row.
 */
export const MATCH_STALE_MS = 4.5 * 60_000;
/** A beat writes its row at most this often; more often is answered, not written (env MATCH_BEAT_WRITE_MS; keep it well under MATCH_STALE_MS). */
export const BEAT_WRITE_MS = 30_000;
/** A start is kept alive by beats this long at most from when it was first said; then it ages out. */
export const START_MAX_MS = 2 * 3600_000;
/** An account's live starts: a new one evicts the oldest past this. */
export const START_LIVE = 3;
/** A voided match stays void this long (kv `void:<match>`), then the row goes. */
export const VOID_TTL_MS = 3600_000;
const KINDS = ["duel", "ffa", "teams", "coop"];
/** The kinds with a winner, and with the leaver rule. */
export const RATED = ["duel", "ffa", "teams"];

const all = async (stmt) => (await stmt.all()).results ?? [];
const startKey = (game, run, match) => sha256(`start|${game}|${run}|${match}`);

/**
 * A result of `kind` for `game`: one of its kinds — the manifest's, or the
 * table's extra ones (KINDS: Bubble Rush's teams mode on its ffa board) —
 * or a scored free-for-all of a co-op game (Neon Survival's multi-ship runs).
 */
export const kindFits = (game, kind) => (RESULT_KINDS[game] ?? [GAMES[game]]).includes(kind) || (GAMES[game] === "coop" && kind === "ffa");

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
 *     outcome is the game's: a draw stays a draw (`sides`, `forfeits`: part
 *     of the canonical result every reporter must agree on). Without `teams`
 *     (an older page): as free-for-all.
 */
export function toAccounts({ kind, ranking, roster, scores, left, teams }) {
	if (!KINDS.includes(kind)) throw new HttpError(400, "this kind of game is not recorded");
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
		// By team: each team still here at its place; each team that left, last.
		// `size`: the team's players as the match began — those still here and
		// its leavers. Part of the canonical result (report), so every
		// reporter must agree on who played for whom.
		sides = [
			...[...at].map(([t, i]) => ({ members: kept[i].filter((a) => teamOf.get(a) === t), size: [...kept[i], ...departed].filter((a) => teamOf.get(a) === t).length, at: i })),
			...goneTeams.map((t) => ({ members: departed.filter((a) => teamOf.get(a) === t), size: departed.filter((a) => teamOf.get(a) === t).length, at: kept.length })),
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
	// Teams: who played for whom, kept with each player of the match
	// (match_players.team, 0008) so head-to-head never counts a teammate as
	// beaten — a leaver from the winning side goes last, but only the other
	// team gets the win over them (a review, 2026-11-25). From `teams` when it
	// names everyone, else (an older page) from the game's own slots: a side
	// is a slot of `ranking`. A leaver the game dropped from its ranking, with
	// no `teams`, has none and is compared by place alone.
	let team = null;
	if (kind === "teams") {
		team = {};
		if (accounts.every((a) => teamOf.has(a))) for (const a of accounts) team[a] = teamOf.get(a);
		else
			ranking.forEach((slot, i) =>
				slot.forEach((id) => {
					const a = acct(id);
					if (a && accounts.includes(a)) team[a] = `#${i}`;
				}),
			);
	}
	return { places, accounts, departed, scores: Object.keys(s).length ? s : null, ...(sides ? { sides, forfeits } : {}), ...(team ? { team } : {}) };
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
 * as a match among signed-in people begins (lib/account.js matchStart) and again
 * every 2 minutes while the match runs — its heartbeat. One row per account
 * and match: `payload` keeps when it was first said, `at` the last beat.
 */
export async function startMatch(env, me, request, { gate = async () => true } = {}) {
	const b = await body(request);
	if (typeof b.game !== "string" || !RATED.includes(GAMES[b.game])) throw new HttpError(400, "only a game with a winner records who began it");
	if (typeof b.run !== "string" || !b.run || b.run.length > 40) throw new HttpError(400, "run is the party's run id");
	if (!Number.isInteger(b.match) || b.match < 0) throw new HttpError(400, "match is the match's number in its run");
	const t = now();
	const key = await startKey(b.game, b.run, b.match);
	// A beat — the start is already there — is free of the per-address write
	// limit, so a page that beats every minute never spends its writes; and
	// it writes at most once per BEAT_WRITE_MS per row, and not past
	// START_MAX_MS from the start, so beats can never be a flood of D1 writes
	// nor keep a start alive for ever (a review, 2026-11-16: 400 beats in 4 s
	// were 400 writes). A new start is charged like any write (index.js passes
	// the gate here), and an account keeps at most START_LIVE of them.
	const beat = await env.DB.prepare(
		"UPDATE reports SET at = ? WHERE match = ? AND account = ? AND digest = 'start' AND at < ? AND CAST(payload AS INTEGER) > ?",
	)
		.bind(t, key, me.id, t - Number(env.MATCH_BEAT_WRITE_MS ?? BEAT_WRITE_MS), t - START_MAX_MS)
		.run();
	// `wrote`: whether this call wrote anything (tests count it).
	if (beat.meta?.changes) return { started: true, beat: true, wrote: true };
	// Nothing written: fresh already (or past its lifetime), or not there at all.
	if (await env.DB.prepare("SELECT 1 FROM reports WHERE match = ? AND account = ? AND digest = 'start'").bind(key, me.id).first()) {
		return { started: true, beat: true, wrote: false };
	}
	if (!(await gate())) throw new HttpError(429, "too many changes from this address; wait a few minutes");
	await env.DB.batch([
		env.DB.prepare("INSERT OR IGNORE INTO reports (match, account, digest, payload, at) VALUES (?, ?, 'start', ?, ?)").bind(key, me.id, String(t), t),
		// Only the account's newest START_LIVE starts stand.
		env.DB.prepare(
			`DELETE FROM reports WHERE account = ? AND digest = 'start' AND match NOT IN (
				SELECT match FROM reports WHERE account = ? AND digest = 'start' ORDER BY CAST(payload AS INTEGER) DESC LIMIT ?
			)`,
		).bind(me.id, me.id, START_LIVE),
	]);
	return { started: true, wrote: true };
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
	const t = requestNow(env, request);
	const b = await body(request);
	if (typeof b.game !== "string" || !GAMES[b.game]) throw new HttpError(400, "unknown game");
	if (typeof b.run !== "string" || !b.run || b.run.length > 40) throw new HttpError(400, "run is the party's run id");
	const match = Number.isInteger(b.match) ? b.match : 1;
	if (b.kind === "local") return { counted: false, why: "one-phone games are not recorded" };
	const r = toAccounts(b);
	// Head-to-head is between people: a match with a bot in it is the device's alone.
	if (r.bots) return { counted: false, why: "matches with bots are not recorded", code: "bots" };
	if (!r.accounts.includes(me.id)) throw new HttpError(400, "you can only report a match you played");
	const key = await sha256(`${b.game}|${b.run}|${match}`);
	// Reporting a match is being there: our own start of it is used up (rule
	// 1) whatever becomes of this report — refused, voided, or too late.
	await env.DB.prepare("DELETE FROM reports WHERE match = ? AND account = ? AND digest = 'start'").bind(await startKey(b.game, b.run, match), me.id).run();
	await sweep(env, t);
	const done = await countedFor(env, key, me.id);
	if (done) return done;
	if (!kindFits(b.game, b.kind)) throw new HttpError(400, `${b.game} is a ${GAMES[b.game]} game; a ${b.kind} result for it does not count`);
	// A co-op game is played together, whatever its result says: a scored
	// free-for-all of one (Neon Survival's multi-ship runs) is kept as co-op,
	// so it never counts towards head-to-head (Lokesh, 2026-11-25). Its play
	// count and the devices' records count as ever.
	const kind = GAMES[b.game] === "coop" ? "coop" : b.kind;
	if (r.accounts.length < 2) return { counted: false, why: "a match is recorded with two signed-in players" };
	if (await env.DB.prepare("SELECT 1 FROM kv WHERE k = ?").bind(`void:${key}`).first()) {
		return { counted: false, why: "the players disagreed about this match, so it does not count" };
	}
	const canonical = JSON.stringify({ game: b.game, run: b.run, match, kind, places: r.places, left: r.departed, scores: r.scores, ...(r.sides ? { sides: r.sides, forfeits: r.forfeits } : {}), ...(r.team ? { team: r.team } : {}) });
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
	const vs = await versusIn(env, key, who);
	// Recorded as having left it: not "counted" — counted against you.
	if (outcome?.left) return { counted: false, left: true, why: "this match counted against you: the others reported that you left it", vs };
	return { counted: true, already: true, vs };
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
	const base = { id: key, game: P.game, kind: P.kind, places: P.places, scores: P.scores, team: P.team ?? null, t, who };
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
 * Record a match for `recorded` (and nobody else), in one batch — one
 * transaction. Its first statement is a plain INSERT of the match, so a
 * second commit of the same match (two last reports at once) fails on the
 * primary key and the whole batch rolls back: a match counts once, and an
 * account that is missing (deleted since) makes nothing half written.
 * Resolves `who`'s answer, with their head-to-head against the others.
 */
async function commit(env, { id, game, kind, places, scores, team = null, recorded, departed = [], startOf = null, t, who }) {
	const exist = new Set(
		(await all(env.DB.prepare("SELECT id FROM accounts WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(recorded)))).map((x) => x.id),
	);
	const keep = new Set(recorded.filter((a) => exist.has(a)));
	if (keep.size < 2) return { counted: false, why: "a match is recorded with two signed-in players" };
	const ranked = places.map((s) => s.filter((a) => keep.has(a)));
	while (ranked.length && !ranked.at(-1).length) ranked.pop();
	const kept = scores ? Object.fromEntries(Object.entries(scores).filter(([a]) => keep.has(a))) : null;
	const score = kept && Object.keys(kept).length ? kept : null;
	const accounts = [...keep];
	const stmts = [
		env.DB.prepare("INSERT INTO matches (id, game, kind, ranking, scores, at) VALUES (?, ?, ?, ?, ?, ?)").bind(id, game, kind, JSON.stringify(ranked), score ? JSON.stringify(score) : null, t),
		...ranked.flatMap((slot, place) => slot.map((a) => env.DB.prepare("INSERT INTO match_players (match, account, place, team) VALUES (?, ?, ?, ?)").bind(id, a, place, team?.[a] ?? null))),
		// Each player's outcome waits in a report row for a repeat to read
		// (countedFor) — a leaver's marked, so a late report of theirs is told
		// the match counted against them.
		...accounts.map((a) =>
			env.DB.prepare("INSERT OR REPLACE INTO reports (match, account, digest, payload, at) VALUES (?, ?, 'counted', ?, ?)").bind(
				id,
				a,
				JSON.stringify(departed.includes(a) ? { left: true } : {}),
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
	return { counted: true, vs: await versusIn(env, id, who) };
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

// ------------------------------------------------------------ head-to-head

/**
 * How `a` did against each other account, from the matches both are
 * recorded in: a place ahead is a win, behind a loss, the same place a draw —
 * except in a team game, where the same team (match_players.team, 0008; a
 * leaver's last place included) or the same place (two sides level)
 * counts as neither. Co-op matches are played together and never count.
 * Only games the Worker still knows (GAMES) count, in every total alike.
 * Grouped by opponent or by game. Never a rating, never a ranking of
 * anybody. Its last bound parameter is GAME_LIST.
 */
const GAME_LIST = JSON.stringify(Object.keys(GAMES));
const H2H_SQL = (filter, group) => `SELECT q.account AS other, ${group === "game" ? "m.game AS game," : ""}
	SUM(p.place < q.place) AS wins, SUM(p.place > q.place) AS losses,
	SUM(p.place = q.place) AS draws, MAX(m.at) AS last
	FROM match_players p JOIN match_players q ON q.match = p.match AND q.account <> p.account
	JOIN matches m ON m.id = p.match
	WHERE p.account = ? ${filter} AND m.kind <> 'coop'
	AND NOT (m.kind = 'teams' AND (p.place = q.place OR COALESCE(p.team = q.team, 0)))
	AND m.game IN (SELECT value FROM json_each(?))
	GROUP BY q.account${group === "game" ? ", m.game" : ""}`;

const tally = (x) => ({ wins: x.wins ?? 0, losses: x.losses ?? 0, draws: x.draws ?? 0 });

/** `a`'s record against `b`: { wins, losses, draws, games: { <game>: { wins, losses, draws } } }. */
export async function headToHead(env, a, b) {
	const rows = await all(env.DB.prepare(H2H_SQL("AND q.account = ?", "game")).bind(a, b, GAME_LIST));
	const out = { wins: 0, losses: 0, draws: 0, games: {} };
	for (const r of rows) {
		const t = tally(r);
		out.games[r.game] = t;
		out.wins += t.wins;
		out.losses += t.losses;
		out.draws += t.draws;
	}
	return out;
}

/** Everyone `a` has a record against, most recently played first: [{ id, name, wins, losses, draws, last }]. */
export async function rivalsOf(env, a, limit = 50) {
	const rows = await all(
		env.DB.prepare(
			`SELECT h.*, acc.name FROM (${H2H_SQL("", "other")}) h JOIN accounts acc ON acc.id = h.other ORDER BY h.last DESC LIMIT ?`,
		).bind(a, GAME_LIST, limit),
	);
	return rows.map((r) => ({ id: r.other, name: r.name, ...tally(r), last: r.last }));
}

/** `who`'s record in match `id`'s game against each other account in it (its end card): [{ id, name, wins, losses, draws }]. */
async function versusIn(env, id, who) {
	const rows = await all(
		env.DB.prepare(
			`SELECT h.*, acc.name FROM (${H2H_SQL("AND q.account IN (SELECT account FROM match_players WHERE match = ?) AND m.game = (SELECT game FROM matches WHERE id = ?)", "other")}) h
			 JOIN accounts acc ON acc.id = h.other ORDER BY acc.name`,
		).bind(who, id, id, GAME_LIST),
	);
	return rows.map((r) => ({ id: r.other, name: r.name, ...tally(r) }));
}
