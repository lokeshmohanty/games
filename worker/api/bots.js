// worker/api/bots.js — wins against bots, on a board of their own (Lokesh,
// 2026-11-15: every game with bots gets a "wins against bots" board, kept
// apart from the ranked boards because it can be farmed and is not
// comparable across games).
//
// A win counts when the player who reports it was the only person in the
// match — every other seat a bot — and the match ran under a run the server
// issued as it began:
//
//   POST /api/run/start { game, vs: "bots" }  (signed in, a BOTS game)  → { run, seed, at }
//   POST /api/match/report { game, run, kind, ranking, roster, … }     (the win)
//
// The report goes through match.js like any other; a ranking with bots in it
// comes here, never to the confirmed matches, the ratings or Elo.
// checkBotsWin() refuses, with a `why`, a game not in BOTS; a kind with no
// winner (co-op, one-phone); a match with another person in it, or with no
// bot; a result the reporter did not win alone in first place; a run that is missing,
// unknown, another account's, another game's, a solo run, expired or already
// used; the account's BOTS_PER_DAY counted wins of that game in the last day;
// and a win sooner after the run began than the game's `minMs`. Only then is
// the run claimed — once, and under the cap, in one conditional UPDATE
// (runs.js claimStatement) — and the win added, in the same batch.
//
// The board ranks by wins, all time; a tie goes to whoever reached that count
// first (`at`). It has the same scopes as the ranked boards: everyone (not
// hidden), friends, or a group's members (worker/api/lb.js).
//
// What this does not stop: the host's browser plays the bots, so a player can
// make them lose. The daily cap and the minimum match length bound how fast a
// board can be climbed; they do not prove a game was played.

import { HttpError, randomId } from "./http.js";
import { RUN_TTL_MS, claimStatement, countedToday, unclaimedWhy } from "./runs.js";

/** Counted wins against bots per account, per game, per day (env BOTS_PER_DAY). */
export const BOTS_PER_DAY = 20;

/**
 * The games whose wins against bots count, and the shortest legal win in
 * each, `minMs`: from the run's start (just before the match's) to the
 * report (just after its result), on the server's clock. Each is the game's
 * fastest possible win against its bots' delays — searched or simulated
 * with the real rules and bots, 2026-11-15 (docs/accounts.md "Against
 * bots" has how) — less about 1 s: the page does not wait for this run, so
 * the server stamps it up to a request's latency after the match began. A managed turn-based bot waits
 * at least 600 ms a move (lib/sdk-managed.js BOT_MS). Adding a game is one
 * entry here.
 */
export const BOTS = {
	// The bot (win, block, centre, first free) is deterministic: every line
	// searched, the fewest bot moves before a win is 3 (4 moving second).
	"tic-tac-toe-js": { minMs: 800 },
	// Depth-5 minimax, deterministic: no win in under 6 bot moves, either seat.
	connect4: { minMs: 2_600 },
	// The rules allow a win after one bot move (600 ms), though none was found
	// within 3 human moves for any bot seed searched: two bot moves, 1.2 s, so
	// no real win is refused (here the margin is the bot's own slowness).
	"neon-fission": { minMs: 1_200 },
	// 12 lots, each with a 3.2 s show, and the result only after the last.
	"neon-bid": { minMs: 37_000 },
	// 12 fleet cells, one shot a volley, 0.9 s between volleys: 11 × 0.9 s.
	"lokeshmohanty/battleship": { minMs: 8_500 },
	// 5 dice; the bot loses one only in a round where it acts (0.75 s), with a
	// 3.5 s reveal between rounds: 5 × 0.75 + 4 × 3.5 s.
	"lokeshmohanty/liars-dice": { minMs: 16_500 },
	// The 3.2 s countdown, then a step every 100 ms: no bot can be made to
	// crash before step 7 (six bots; step 20 against one).
	"lokeshmohanty/light-cycles": { minMs: 2_900 },
	// A race: the human's own solve sets the pace (the bot fills a cell every
	// few seconds), so the solo floor for the easiest puzzle (sudoku.js).
	"lokeshmohanty/sudoku": { minMs: 29_000 },
};

const KINDS = ["duel", "ffa", "teams"]; // a kind with a winner
const isBot = (id) => typeof id === "string" && id.startsWith("bot_");
const refuse = (why) => ({ counted: false, why });

/**
 * A win against bots, reported (match.js, for any ranking with a bot in it):
 * checked, then counted. Resolves { counted: true, board: "bots", wins } or
 * { counted: false, why }.
 */
export async function reportBotsWin(env, me, b, t) {
	const rule = BOTS[b.game];
	if (!rule) return refuse("games with bots are not ranked, and this one has no board for wins against bots");
	if (!KINDS.includes(b.kind)) return refuse("games with bots are not ranked, and this kind of game has no winner");
	if (!b.ranking.every(Array.isArray)) return refuse("ranking is a list of places");
	const ids = b.ranking.flat();
	const people = ids.filter((id) => !isBot(id));
	if (people.length !== 1 || people.length === ids.length || b.roster?.[people[0]] !== me.id) {
		return refuse("a win against bots counts only when you are the one person playing");
	}
	// Outright: first place alone, whatever the kind — bot teammates sharing
	// it could do the winning (review, 2026-11-15), and no game in BOTS has
	// teams of people and bots.
	const first = b.ranking[0];
	if (b.ranking.length < 2 || first.length !== 1 || first[0] !== people[0]) {
		return refuse("only a win against bots counts");
	}
	if (typeof b.run !== "string") return refuse("a win against bots counts only with a run the server issued as the match began");
	const row = await env.DB.prepare("SELECT account, game, at, used, vs FROM runs WHERE id = ?").bind(b.run).first();
	if (!row) return refuse("a win against bots counts only with a run the server issued as the match began (this one is unknown or expired)");
	if (row.account !== me.id) return refuse("that run is another player's");
	if (row.game !== b.game) return refuse("that run was issued for another game");
	if (row.vs !== "bots") return refuse("that run was issued for a game played alone, not against bots");
	if (t - row.at > RUN_TTL_MS) return refuse("that run expired");
	if (row.used != null) return refuse("that run was already reported");
	const perDay = Number(env.BOTS_PER_DAY ?? BOTS_PER_DAY);
	const capWhy = `${perDay} wins against bots count a day in each game; this one does not`;
	// Refused early here; the claim below is what holds against parallel posts.
	if ((await countedToday(env, me.id, "bots", b.game, t)) >= perDay) return refuse(capWhy);
	const elapsed = t - row.at;
	if (elapsed < rule.minMs) return refuse(`too fast: a win takes at least ${rule.minMs / 1000} s, and this one took ${(elapsed / 1000).toFixed(1)} s`);
	// One batch (one transaction): the claim — unused, and under the day's cap,
	// in a single conditional UPDATE that stamps this report's own nonce — and
	// the win, added only where the run carries that nonce. Not `changes()`
	// (undocumented across a D1 batch) and not `used = t` (two reports in the
	// same millisecond): only the report that claimed the run adds its win. A
	// failure spends no run without its win, and no win is added without it.
	const nonce = randomId(12);
	const [claim, added] = await env.DB.batch([
		claimStatement(env, { run: b.run, t, account: me.id, vs: "bots", game: b.game, perDay, claim: nonce }),
		env.DB.prepare(
			`INSERT INTO bot_wins (account, game, wins, first, at) SELECT ?, ?, 1, ?, ? WHERE EXISTS (SELECT 1 FROM runs WHERE id = ? AND claim = ?)
			 ON CONFLICT (account, game) DO UPDATE SET wins = wins + 1, at = excluded.at RETURNING wins`,
		).bind(me.id, b.game, t, t, b.run, nonce),
	]);
	if (!claim.meta?.changes) return refuse(await unclaimedWhy(env, b.run, capWhy));
	return { counted: true, board: "bots", wins: added.results?.[0]?.wins ?? null };
}

const all = async (stmt) => (await stmt.all()).results ?? [];

/** An account's wins against bots, by game, most first (profiles). */
export const botWinsOf = (env, account) =>
	all(env.DB.prepare("SELECT game, wins FROM bot_wins WHERE account = ? ORDER BY wins DESC, game LIMIT 50").bind(account));
const row = (r, i) => ({ rank: i + 1, id: r.account, name: r.name, avatar: r.avatar ?? null, wins: r.wins, first: r.first, at: r.at });

/**
 * A game's board of wins against bots: `only` limits it to those accounts
 * (friends, a group's members); `includeHidden` keeps players hidden from
 * public boards (friends and groups see them). With `me`, also where they
 * stand, even below the rows shown.
 */
export async function botsBoard(env, me, game, { only = null, includeHidden = false, limit = 100 } = {}) {
	if (!BOTS[game]) throw new HttpError(400, "this game has no board for wins against bots");
	if (only && !only.length) return { rows: [], me: null };
	const where = ["w.game = ?"];
	const args = [game];
	if (!includeHidden) where.push("a.hide_public = 0");
	if (only) {
		// One JSON parameter, not one `?` each: D1 allows 100 a query.
		where.push("w.account IN (SELECT value FROM json_each(?))");
		args.push(JSON.stringify(only));
	}
	const rows = (
		await all(
			env.DB.prepare(
				`SELECT w.account, w.wins, w.first, w.at, a.name, a.avatar FROM bot_wins w JOIN accounts a ON a.id = w.account
				 WHERE ${where.join(" AND ")} ORDER BY w.wins DESC, w.at ASC LIMIT ?`,
			).bind(...args, limit),
		)
	).map(row);
	if (!me) return { rows };
	const listed = rows.find((r) => r.id === me.id);
	if (listed) return { rows, me: listed };
	const mine = await env.DB.prepare(
		"SELECT w.account, w.wins, w.first, w.at, a.name, a.avatar, a.hide_public FROM bot_wins w JOIN accounts a ON a.id = w.account WHERE w.game = ? AND w.account = ?",
	)
		.bind(game, me.id)
		.first();
	if (!mine) return { rows, me: null };
	if (mine.hide_public && !includeHidden) return { rows, me: { ...row(mine, 0), rank: null, hidden: true } };
	const n = await env.DB.prepare(
		`SELECT COUNT(*) AS n FROM bot_wins w JOIN accounts a ON a.id = w.account WHERE ${where.join(" AND ")} AND (w.wins > ? OR (w.wins = ? AND w.at < ?))`,
	)
		.bind(...args, mine.wins, mine.wins, mine.at)
		.first();
	return { rows, me: row(mine, n?.n ?? 0) };
}
