// scripts/propose.mjs — the link that opens GitHub's own page for proposing
// a repo's games (or a newer commit of them) to the arcade.
//
// Lokesh, 2026-11-13: a pull request is the contributor's to open — no
// workflow opens one — and once it is merged the site deploys itself
// (deploy.yml on push). This only saves the typing:
//
//   node scripts/propose.mjs owner/repo [game-folder …]      (just propose …)
//
//   not registered yet → GitHub's "new file" page for registry/<owner>/<repo>.json,
//                        filled in (repo, the head commit, the game folders —
//                        found from every game.json when none are named).
//                        Committing it there offers to open the pull request.
//   registered, moved  → the pin's edit page, and the commit to paste in
//                        (GitHub cannot fill an edit page).
//   registered, current → says so.
//
// The site does the same in the browser: contribute.html's form and the
// Contributors page's "Propose update" (lib/propose.js). Repos are public, so
// the GitHub API needs no token (GITHUB_TOKEN raises the rate limit).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ARCADE = "lokeshmohanty/games";
const SHA = /^[0-9a-f]{40}$/;

const headers = { Accept: "application/vnd.github+json", "User-Agent": "neon-arcade-propose" };
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
async function gh(path) {
	const res = await fetch(`https://api.github.com${path}`, { headers });
	if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
	return res.json();
}

/** The pin file a repo would have, as GitHub shows it in the arcade. */
export function pinText(repo, commit, games) {
	return `${JSON.stringify({ repo: `https://github.com/${repo}`, commit, games }, null, 2).replace(/\[\n\s+([\s\S]*?)\n\s+\]/, (_, inner) => `[${inner.replace(/\s*\n\s*/g, " ")}]`)}\n`;
}

/** GitHub's prefilled "new file" page in the arcade repo. */
export function newFileUrl(repo, text) {
	const q = new URLSearchParams({ filename: `registry/${repo}.json`, value: text });
	return `https://github.com/${ARCADE}/new/main?${q}`;
}
export const editUrl = (repo) => `https://github.com/${ARCADE}/edit/main/registry/${repo}.json`;

async function main() {
	const [repo, ...named] = process.argv.slice(2);
	if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? "")) {
		console.error("usage: propose.mjs owner/repo [game-folder …]");
		process.exit(2);
	}
	const head = (await gh(`/repos/${repo}/commits/HEAD`)).sha;
	if (!SHA.test(head ?? "")) throw new Error("no head commit");
	const pinned = join(ROOT, "registry", `${repo}.json`);

	if (existsSync(pinned)) {
		const entry = JSON.parse(readFileSync(pinned, "utf8"));
		if (entry.commit === head) return console.log(`${repo} is pinned at its head (${head.slice(0, 7)}): nothing to propose.`);
		console.log(`${repo}: pinned ${entry.commit.slice(0, 7)}, head ${head.slice(0, 7)}`);
		console.log(`compare: https://github.com/${repo}/compare/${entry.commit}...${head}`);
		console.log(`\n1. open:   ${editUrl(repo)}`);
		console.log(`2. set "commit" to: ${head}`);
		console.log(`3. "Propose changes" → open the pull request.`);
		return;
	}

	let games = named;
	if (!games.length) {
		const tree = await gh(`/repos/${repo}/git/trees/${head}?recursive=1`);
		games = tree.tree
			.filter((t) => t.type === "blob" && /(^|\/)game\.json$/.test(t.path))
			.map((t) => t.path.replace(/\/?game\.json$/, ""))
			.filter(Boolean)
			.sort();
		if (!games.length) throw new Error(`no game.json in ${repo} at ${head.slice(0, 7)} — see CONTRIBUTING.md`);
	}
	const text = pinText(repo, head, games);
	console.log(`registry/${repo}.json:\n\n${text}`);
	console.log(`open (filled in; "Commit changes…" then opens the pull request):\n${newFileUrl(repo, text)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
