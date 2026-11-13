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
// Skipped when nothing changed since the last commit (digest in D1 kv).
// The portal reads these from raw.githubusercontent.com when the Worker is
// unreachable (lib/account.js). Runs on the Worker's cron (wrangler.toml).

import { configured, repoOf, rest } from "./github.js";
import { sha256 } from "./http.js";
import { topOfEveryGame } from "./lb.js";
import { summary } from "./match.js";

export const fileOf = (game) => `stats/lb/${game.replace(/\//g, "__")}.json`;

/** The files, as { path: text }. `at` is left out of the digest. */
export async function buildSnapshot(env) {
	const sum = await summary(env);
	const boards = await topOfEveryGame(env);
	const files = { "stats/summary.json": { games: sum.games } };
	for (const [game, b] of Object.entries(boards)) files[fileOf(game)] = { game, kind: b.kind, rows: b.rows };
	files["stats/index.json"] = { games: Object.keys(boards).sort() };
	return files;
}

/** Commit the snapshot if it changed; returns what happened. */
export async function runSnapshot(env) {
	if (!configured(env)) return { skipped: "no GitHub App configured" };
	const files = await buildSnapshot(env);
	const digest = await sha256(JSON.stringify(files));
	const last = (await env.DB.prepare("SELECT v FROM kv WHERE k = 'snapshot:digest'").first())?.v;
	if (last === digest) return { skipped: "unchanged" };
	const at = new Date().toISOString();
	const repo = repoOf(env);
	const branch = env.GH_STATS_BRANCH ?? "stats";
	const ref = await rest(env, "GET", `/repos/${repo}/git/ref/heads/${branch}`);
	const tree = await rest(env, "POST", `/repos/${repo}/git/trees`, {
		tree: Object.entries(files).map(([path, data]) => ({
			path,
			mode: "100644",
			type: "blob",
			content: JSON.stringify({ at, ...data }, null, 1) + "\n",
		})),
	});
	const commit = await rest(env, "POST", `/repos/${repo}/git/commits`, {
		message: `stats: snapshot ${at}`,
		tree: tree.sha,
		parents: ref ? [ref.object.sha] : [],
	});
	if (ref) await rest(env, "PATCH", `/repos/${repo}/git/refs/heads/${branch}`, { sha: commit.sha, force: false });
	else await rest(env, "POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
	await env.DB.prepare("INSERT OR REPLACE INTO kv (k, v) VALUES ('snapshot:digest', ?)").bind(digest).run();
	return { committed: commit.sha, files: Object.keys(files).length };
}
