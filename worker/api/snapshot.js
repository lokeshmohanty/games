// worker/api/snapshot.js — the hourly public snapshot, committed to GitHub.
//
// D1 is the live store; GitHub holds a public, versioned copy of the
// *aggregates* (Lokesh, 2026-11-13): play counts only — never accounts,
// sessions, friends, groups or match rosters. One commit per run, to branch
// GH_STATS_BRANCH (default "stats") of GH_REPO, holding only:
//
//   stats/summary.json        { at, games: { id: { played } } }
//
// It once held each game's top 100 too (stats/lb/<game>.json and
// stats/index.json); there are no boards since 2026-11-25 (casual, not
// competitive), and the first run after that deletes any it finds in its
// state. Skipped when nothing changed since the last commit (digests in D1
// kv). The portal reads the summary from raw.githubusercontent.com when the
// Worker is unreachable (lib/account.js). Runs on the Worker's cron
// (wrangler.toml).

import { configured, repoOf, rest } from "./github.js";
import { sha256 } from "./http.js";
import { summary } from "./match.js";

const STATE = "snapshot:files"; // kv: { path: { d: digest of the file without `at`, t: when last looked at } }
/** Files an older snapshot wrote that no longer exist: deleted on the next run. */
const GONE = (path) => path.startsWith("stats/lb/") || path === "stats/index.json";

/** The files a run writes, as { path: data }. */
export async function buildSnapshot(env) {
	return { files: { "stats/summary.json": { games: (await summary(env)).games } } };
}

/**
 * Commit what changed since the last run, on top of it (`base_tree`: the
 * files unchanged stay as they are); an old board file is deleted. Returns what happened.
 */
export async function runSnapshot(env) {
	if (!configured(env)) return { skipped: "no GitHub App configured" };
	const t = Date.now();
	let state = {};
	try {
		state = JSON.parse((await env.DB.prepare("SELECT v FROM kv WHERE k = ?").bind(STATE).first())?.v ?? "{}");
	} catch {}
	const { files } = await buildSnapshot(env);
	// Each file stringified once: its digest leaves `at` out, and `at` is
	// spliced in after the opening brace for the files that are sent.
	const changed = [];
	for (const [path, data] of Object.entries(files)) {
		const body = JSON.stringify(data, null, 1);
		const d = await sha256(body);
		if (state[path]?.d !== d) changed.push({ path, body, d });
		state[path] = { d: state[path]?.d ?? null, t };
	}
	const gone = Object.keys(state).filter(GONE);
	const save = () => env.DB.prepare("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)").bind(STATE, JSON.stringify(state)).run();
	if (!changed.length && !gone.length) {
		await save();
		return { skipped: "unchanged" };
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
	return { committed: commit.sha, files: changed.length, removed: gone.length };
}
