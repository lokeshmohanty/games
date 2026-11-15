// worker/api/snapshot.js — the hourly public snapshot, committed to GitHub.
//
// D1 is the live store; GitHub holds a public, versioned copy of the
// *aggregates* (Lokesh, 2026-11-13): play counts and the top 100 of each
// game's global leaderboard — display name, public id, rating, games, wins —
// never sessions, friends, groups, match rosters, or anyone who chose "hide
// me from public leaderboards". One commit per run, to branch GH_STATS_BRANCH
// (default "stats") of GH_REPO, holding only:
//
//   stats/summary.json        { at, games: { id: { played } } }
//   stats/lb/<game>.json      { at, game, kind, rows: [...] }  ("/" in an id → "__")
//   stats/index.json          { at, games: [id] }
//
// Skipped when nothing changed since the last commit (digests in D1 kv);
// at most BOARDS_PER_RUN boards are looked at per run, and only changed files
// are sent (on top of the last commit's tree).
// The portal reads these from raw.githubusercontent.com when the Worker is
// unreachable (lib/account.js). Runs on the Worker's cron (wrangler.toml).

import { configured, repoOf, rest } from "./github.js";
import { sha256 } from "./http.js";
import { boardsWithRatings, topOfEveryGame } from "./lb.js";
import { summary } from "./match.js";

export const fileOf = (game) => `stats/lb/${game.replace(/\//g, "__")}.json`;

/**
 * Boards looked at per run, the longest-unchecked first: the run's CPU (the
 * Workers free plan allows 10 ms an invocation, the cron's too) then stays
 * the same however many boards there are — with more than this, each board
 * is refreshed every few hours instead of every hour. Measured (Node):
 * 12 boards of 100 rows (and the summary of 300 games) built, digested and
 * all sent is ~2 ms (max 5.5); the App JWT (RSA sign, on a cold isolate) adds 2–4.
 */
export const BOARDS_PER_RUN = 12;
const STATE = "snapshot:files"; // kv: { path: { d: digest of the file without `at`, t: when last looked at } }

/** The files a run looks at, as { path: data }, and every board's game. */
export async function buildSnapshot(env, state = {}) {
	const games = await boardsWithRatings(env);
	const due = [...games].sort((a, b) => (state[fileOf(a)]?.t ?? 0) - (state[fileOf(b)]?.t ?? 0)).slice(0, BOARDS_PER_RUN);
	const boards = await topOfEveryGame(env, 100, due);
	const files = { "stats/summary.json": { games: (await summary(env)).games }, "stats/index.json": { games: [...games].sort() } };
	for (const [game, b] of Object.entries(boards)) files[fileOf(game)] = { game, kind: b.kind, rows: b.rows };
	return { files, games };
}

/**
 * Commit what changed since the last run, on top of it (`base_tree`: the
 * files not looked at, or unchanged, stay as they are); a board with nobody
 * ranked any more is deleted. Returns what happened.
 */
export async function runSnapshot(env) {
	if (!configured(env)) return { skipped: "no GitHub App configured" };
	const t = Date.now();
	let state = {};
	try {
		state = JSON.parse((await env.DB.prepare("SELECT v FROM kv WHERE k = ?").bind(STATE).first())?.v ?? "{}");
	} catch {}
	const { files, games } = await buildSnapshot(env, state);
	// Each file stringified once: its digest leaves `at` out, and `at` is
	// spliced in after the opening brace for the files that are sent.
	const changed = [];
	for (const [path, data] of Object.entries(files)) {
		const body = JSON.stringify(data, null, 1);
		const d = await sha256(body);
		if (state[path]?.d !== d) changed.push({ path, body, d });
		state[path] = { d: state[path]?.d ?? null, t };
	}
	const live = new Set(games.map(fileOf));
	const gone = Object.keys(state).filter((p) => p.startsWith("stats/lb/") && !live.has(p));
	const save = () => env.DB.prepare("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)").bind(STATE, JSON.stringify(state)).run();
	if (!changed.length && !gone.length) {
		await save();
		return { skipped: "unchanged", boards: Object.keys(files).length - 2, of: games.length };
	}
	const at = new Date(t).toISOString();
	const repo = repoOf(env);
	const branch = env.GH_STATS_BRANCH ?? "stats";
	const ref = await rest(env, "GET", `/repos/${repo}/git/ref/heads/${branch}`);
	const base = ref ? (await rest(env, "GET", `/repos/${repo}/git/commits/${ref.object.sha}`))?.tree?.sha : null;
	const tree = await rest(env, "POST", `/repos/${repo}/git/trees`, {
		...(base ? { base_tree: base } : {}),
		tree: [
			...changed.map(({ path, body }) => ({ path, mode: "100644", type: "blob", content: `{\n "at": ${JSON.stringify(at)},\n${body.slice(2)}\n` })),
			...(base ? gone.map((path) => ({ path, mode: "100644", type: "blob", sha: null })) : []),
		],
	});
	const commit = await rest(env, "POST", `/repos/${repo}/git/commits`, {
		message: `stats: snapshot ${at}`,
		tree: tree.sha,
		parents: ref ? [ref.object.sha] : [],
	});
	if (ref) await rest(env, "PATCH", `/repos/${repo}/git/refs/heads/${branch}`, { sha: commit.sha, force: false });
	else await rest(env, "POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
	for (const { path, d } of changed) state[path].d = d;
	for (const path of gone) delete state[path];
	await save();
	return { committed: commit.sha, files: changed.length, removed: gone.length, boards: Object.keys(files).length - 2, of: games.length };
}
