// scripts/check-submission.mjs — is a contributor's pull request one the
// arcade can merge? Run by .github/workflows/submission.yml on every PR that
// touches registry/ (Lokesh, 2026-11-13: "verify if a contributor PR is valid
// with the required settings").
//
// The rules (`judge`, pure, tested by scripts/test-submission.mjs):
//
//   1. only registry/<owner>/<repo>.json files change — a submission is not a
//      place to edit the arcade itself;
//   2. each file is the PR author's own (<owner> is their GitHub login), unless
//      the author maintains this repo (OWNER / MEMBER / COLLABORATOR);
//   3. each entry is well formed and names its own repo (validateEntry);
//   4. an update moves its pin forward: the new commit is ahead of the old,
//      never behind or on another branch (the compare API's "ahead");
//   5. the commit exists in that public repo.
//
// Then the wrapper fetches the pinned commits and runs the same checks as
// `just validate-game` on every listed game (manifest, bundle, no network,
// theme colours, 5 MB, contributor.json, and each game played with bots at
// 390x844). It writes result.json and summary.md for the report workflow.
//
//   node scripts/check-submission.mjs [--base origin/main] [--out dir]
//   (in Actions: GITHUB_EVENT_PATH gives the author and their association)

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateEntry } from "./fetch-community.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = /^registry\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)\.json$/;
export const MAINTAINER = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/**
 * The verdict on a submission. Pure: everything it needs is passed in.
 *   changed      paths the PR changes (added, modified, deleted)
 *   author       the PR author's login; association: GitHub's author_association
 *   before(p)    the file's JSON on the base branch, or null
 *   after(p)     the file's JSON in the PR, or null when deleted
 *   compare(repo, from, to) → "ahead" | "behind" | "diverged" | "identical" | "missing"
 * Resolves { ok, kind: "new"|"update"|"removal"|"mixed", problems, entries }.
 */
export async function judge({ changed, author, association, before, after, compare }) {
	const problems = [];
	const entries = [];
	const maintainer = MAINTAINER.has(association);
	const outside = changed.filter((p) => !FILE.test(p));
	if (outside.length) problems.push(`only registry/<owner>/<repo>.json may change in a game submission — also changed: ${outside.join(", ")}`);
	const kinds = new Set();
	for (const path of changed.filter((p) => FILE.test(p))) {
		const [, owner, repo] = path.match(FILE);
		if (owner.toLowerCase() !== String(author).toLowerCase() && !maintainer) {
			problems.push(`${path}: a contributor proposes their own repos — this one is ${owner}'s, the PR is ${author}'s`);
		}
		const old = before(path);
		const next = after(path);
		if (!next) {
			kinds.add("removal");
			entries.push({ path, owner, repo, kind: "removal" });
			continue;
		}
		const bad = validateEntry(next, owner, repo);
		if (bad.length) {
			problems.push(`${path}: ${bad.join("; ")}`);
			continue;
		}
		const kind = old ? "update" : "new";
		kinds.add(kind);
		entries.push({ path, owner, repo, kind, commit: next.commit, games: next.games, from: old?.commit ?? null });
		const where = await compare(`${owner}/${repo}`, old?.commit ?? null, next.commit);
		if (where === "missing") problems.push(`${path}: commit ${next.commit.slice(0, 7)} is not in https://github.com/${owner}/${repo} (is the repo public, and the commit pushed?)`);
		else if (old && where === "identical") problems.push(`${path}: the pin is unchanged`);
		else if (old && where !== "ahead") problems.push(`${path}: an update moves forward — ${next.commit.slice(0, 7)} is ${where} of the current pin ${old.commit.slice(0, 7)}`);
	}
	if (!changed.some((p) => FILE.test(p))) problems.push("no registry/<owner>/<repo>.json changes");
	const kind = kinds.size === 1 ? [...kinds][0] : kinds.size ? "mixed" : "none";
	return { ok: !problems.length, kind, problems, entries, maintainer };
}

// ------------------------------------------------------------------ the wrapper

function git(...args) {
	return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 26 });
}
const jsonAt = (ref, path) => {
	try {
		return JSON.parse(git("show", `${ref}:${path}`));
	} catch {
		return null;
	}
};

async function compareOnGitHub(repo, from, to) {
	const headers = { Accept: "application/vnd.github+json", "User-Agent": "neon-arcade-submission" };
	if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
	const url = from ? `https://api.github.com/repos/${repo}/compare/${from}...${to}` : `https://api.github.com/repos/${repo}/commits/${to}`;
	const res = await fetch(url, { headers });
	if (res.status === 404 || res.status === 422) return "missing";
	if (!res.ok) throw new Error(`GitHub ${res.status} for ${url}`);
	return from ? (await res.json()).status : "ahead";
}

async function main() {
	const args = process.argv.slice(2);
	const opt = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
	const base = opt("--base", "origin/main");
	const out = resolve(opt("--out", join(ROOT, "submission")));
	mkdirSync(out, { recursive: true });
	const event = process.env.GITHUB_EVENT_PATH && existsSync(process.env.GITHUB_EVENT_PATH) ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")) : {};
	const pr = event.pull_request ?? {};
	const author = pr.user?.login ?? process.env.SUBMISSION_AUTHOR ?? "";
	const association = pr.author_association ?? process.env.SUBMISSION_ASSOCIATION ?? "NONE";
	const mergeBase = git("merge-base", base, "HEAD").trim();
	const changed = git("diff", "--name-only", `${mergeBase}...HEAD`).split("\n").filter(Boolean);

	const verdict = await judge({
		changed,
		author,
		association,
		before: (p) => jsonAt(mergeBase, p),
		after: (p) => (existsSync(join(ROOT, p)) ? JSON.parse(readFileSync(join(ROOT, p), "utf8")) : null),
		compare: compareOnGitHub,
	});

	// The games themselves: fetched at their pins, checked like `just validate-game`.
	let gameLog = "";
	if (verdict.ok && verdict.entries.some((e) => e.kind !== "removal")) {
		try {
			gameLog += execFileSync("node", ["scripts/fetch-community.mjs"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
			const dirs = verdict.entries.filter((e) => e.kind !== "removal").flatMap((e) => e.games.map((g) => `community/${e.owner}/${e.repo}/${g}`));
			gameLog += execFileSync("node", ["scripts/validate-game.mjs", ...dirs], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 26 });
		} catch (err) {
			gameLog += `${err.stdout ?? ""}${err.stderr ?? ""}`;
			verdict.ok = false;
			verdict.problems.push("the games did not pass their checks — see the output below");
		}
	}

	const result = { pr: pr.number ?? null, head: pr.head?.sha ?? null, author, ...verdict };
	writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2));
	const lines = [
		`### Game submission: ${verdict.ok ? "✅ ready for review" : "❌ changes needed"}`,
		"",
		...verdict.entries.map((e) =>
			e.kind === "removal" ? `- **${e.owner}/${e.repo}** — removed` : `- **${e.owner}/${e.repo}** — ${e.kind === "new" ? "new" : `update ${e.from.slice(0, 7)} → `}\`${e.commit.slice(0, 7)}\`, games: ${e.games.join(", ")}`,
		),
		"",
		...(verdict.problems.length ? ["**To fix:**", ...verdict.problems.map((p) => `- ${p}`), ""] : []),
		...(gameLog ? ["<details><summary>Game checks</summary>", "", "```", gameLog.slice(-50_000), "```", "</details>"] : []),
	];
	writeFileSync(join(out, "summary.md"), lines.join("\n") + "\n");
	if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n", { flag: "a" });
	console.log(lines.join("\n"));
	process.exit(verdict.ok ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
