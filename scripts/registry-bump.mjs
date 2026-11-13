// scripts/registry-bump.mjs — which registered repos have moved on.
//
// Lokesh, 2026-11-13: a pin never changes by hand — "send a PR, merge and
// then auto update using a GitHub action". .github/workflows/registry-bump.yml
// runs this, and for each repo whose default branch is past its pin opens a
// pull request that changes only `commit`, checks it, and merges it when the
// owner is trusted (registry/trusted.txt).
//
//   node scripts/registry-bump.mjs                 → JSON [{ file, repo, from, to }]
//   node scripts/registry-bump.mjs --only o/r      → just that repo
//   node scripts/registry-bump.mjs --apply FILE SHA → rewrite that pin
//
// The head of the default branch comes from the GitHub API (GITHUB_TOKEN
// when set: higher limits; the repos are public either way).

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = join(ROOT, "registry");
const SHA = /^[0-9a-f]{40}$/;

function pins() {
	const out = [];
	for (const owner of readdirSync(REGISTRY, { withFileTypes: true })) {
		if (!owner.isDirectory()) continue;
		for (const f of readdirSync(join(REGISTRY, owner.name))) {
			if (!f.endsWith(".json")) continue;
			const file = join(REGISTRY, owner.name, f);
			out.push({ file, entry: JSON.parse(readFileSync(file, "utf8")) });
		}
	}
	return out;
}

async function head(repoUrl) {
	const [, owner, repo] = repoUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/) ?? [];
	if (!owner) throw new Error(`not a GitHub repo: ${repoUrl}`);
	const headers = { Accept: "application/vnd.github+json", "User-Agent": "neon-arcade-registry" };
	if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
	const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/HEAD`, { headers });
	if (!res.ok) throw new Error(`${owner}/${repo}: HTTP ${res.status}`);
	const sha = (await res.json()).sha;
	if (!SHA.test(sha ?? "")) throw new Error(`${owner}/${repo}: no commit sha`);
	return sha;
}

const args = process.argv.slice(2);
if (args[0] === "--apply") {
	const [, file, sha] = args;
	if (!SHA.test(sha ?? "")) throw new Error("--apply FILE SHA: a full 40-character sha");
	const path = resolve(ROOT, file);
	const entry = JSON.parse(readFileSync(path, "utf8"));
	entry.commit = sha;
	writeFileSync(path, JSON.stringify(entry, null, 2).replace(/\[\n\s+"([^\]]+?)"\n\s+\]/gs, (m) => m.replace(/\s*\n\s*/g, " ").replace("[ ", "[").replace(" ]", "]")) + "\n");
	console.log(`${relative(ROOT, path)}: ${sha}`);
} else {
	const only = args[0] === "--only" ? `https://github.com/${args[1]}` : null;
	const moved = [];
	for (const { file, entry } of pins()) {
		if (only && entry.repo !== only) continue;
		const to = await head(entry.repo);
		if (to !== entry.commit) moved.push({ file: relative(ROOT, file), repo: entry.repo.replace("https://github.com/", ""), from: entry.commit, to });
	}
	console.log(JSON.stringify(moved));
}
