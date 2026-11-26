// lib/propose.js — open GitHub's own page for proposing games to the arcade,
// filled in, from the browser. The same logic as scripts/propose.mjs.
//
// Lokesh, 2026-11-13: the pull request is the contributor's to open (no
// workflow opens one), and a merge deploys the site. This only saves typing:
//
//   new repo     → GitHub's "new file" page for registry/<owner>/<repo>.json,
//                  filled in with the head commit and every folder holding a
//                  game.json; committing it there offers the pull request.
//   pinned repo  → if its head moved: the pin's edit page and the commit to
//                  paste (GitHub cannot fill an edit page).
//
// "Head" is the default branch's, or the entry's "branch" when it names one
// (`owner/name@branch` or a …/tree/<branch> address picks it for a new repo).
//
// GitHub's public API, no token: 60 requests an hour per address, so nothing
// is asked until a button is pressed.

window.NeonArcade = window.NeonArcade || {};

(() => {
	const ARCADE = "lokeshmohanty/games";
	const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/;
	// scripts/fetch-community.mjs BRANCH, the registry's rule.
	const BRANCH = /^(?![-\/.])(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._\/-]+(?<![\/.])$/;

	async function gh(path) {
		const res = await fetch(`https://api.github.com${path}`, { headers: { Accept: "application/vnd.github+json" } });
		if (res.status === 404) throw new Error("no such public repository");
		if (res.status === 403) throw new Error("GitHub's limit for this hour is used up — try later");
		if (!res.ok) throw new Error(`GitHub: HTTP ${res.status}`);
		return res.json();
	}

	const head = async (repo, branch) => (await gh(`/repos/${repo}/commits/${branch ? encodeURIComponent(branch) : "HEAD"}`)).sha;

	async function gamesAt(repo, sha) {
		const tree = await gh(`/repos/${repo}/git/trees/${sha}?recursive=1`);
		return tree.tree
			.filter((t) => t.type === "blob" && /(^|\/)game\.json$/.test(t.path))
			.map((t) => t.path.replace(/\/?game\.json$/, "") || ".")
			.sort();
	}

	function pinText(repo, commit, games, branch = null) {
		return `${JSON.stringify({ repo: `https://github.com/${repo}`, ...(branch ? { branch } : {}), commit, games }, null, 2).replace(/\[\n\s+([\s\S]*?)\n\s+\]/, (_, inner) => `[${inner.replace(/\s*\n\s*/g, " ")}]`)}\n`;
	}
	const newFileUrl = (repo, text) => `https://github.com/${ARCADE}/new/main?${new URLSearchParams({ filename: `registry/${repo}.json`, value: text })}`;
	const editUrl = (repo) => `https://github.com/${ARCADE}/edit/main/registry/${repo}.json`;

	/**
	 * `owner/name`, `owner/name@branch` or a GitHub address (…/tree/<branch>)
	 * → { repo, branch } (branch null when none is named).
	 */
	function parse(input) {
		const s = input.trim().replace(/^https:\/\/github\.com\//, "").replace(/\/$/, "");
		const m = s.match(/^([^/@]+\/[^/@]+?)(?:\.git)?(?:@(.+)|\/tree\/(.+))?$/);
		const repo = m?.[1] ?? s;
		const branch = m?.[2] ?? m?.[3] ?? null;
		if (!REPO.test(repo)) throw new Error("a repository is owner/name");
		if (branch != null && !BRANCH.test(branch)) throw new Error(`not a branch name: ${branch}`);
		return { repo, branch };
	}

	/**
	 * What to propose for `input` (see parse): { kind: "new", url, text, games }
	 * | { kind: "update", url, from, to } | { kind: "current", at }. `pinned` is
	 * the commit the arcade has now, if it has one; the branch followed is the
	 * one named, else the pin's, else the default.
	 */
	async function plan(input, pinned = null) {
		const named = parse(input);
		const repo = named.repo;
		const branch = named.branch ?? branchOf(repo);
		const to = await head(repo, branch);
		if (pinned) return pinned === to ? { kind: "current", repo, at: to } : { kind: "update", repo, url: editUrl(repo), from: pinned, to };
		const games = await gamesAt(repo, to);
		if (!games.length) throw new Error(`no game.json in ${repo}${branch ? ` on ${branch}` : ""} — see the guide above`);
		const text = pinText(repo, to, games, branch);
		return { kind: "new", repo, url: newFileUrl(repo, text), text, games, to };
	}

	/** The pinned commit of `repo`, from the catalogs (null when not listed). */
	function pinnedOf(repo) {
		for (const c of NeonArcade.CONTRIBUTORS ?? []) {
			const pin = c.pins?.[`https://github.com/${repo}`];
			if (pin) return pin;
		}
		return null;
	}

	/** The branch a pinned `repo` follows, from the catalogs (null: the default). */
	function branchOf(repo) {
		for (const c of NeonArcade.CONTRIBUTORS ?? []) {
			const b = c.branches?.[`https://github.com/${repo}`];
			if (b) return b;
		}
		return null;
	}

	NeonArcade.propose = { plan, parse, pinText, newFileUrl, editUrl, pinnedOf, branchOf };
})();
