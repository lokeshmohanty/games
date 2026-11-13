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
// GitHub's public API, no token: 60 requests an hour per address, so nothing
// is asked until a button is pressed.

window.NeonArcade = window.NeonArcade || {};

(() => {
	const ARCADE = "lokeshmohanty/games";
	const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/;

	async function gh(path) {
		const res = await fetch(`https://api.github.com${path}`, { headers: { Accept: "application/vnd.github+json" } });
		if (res.status === 404) throw new Error("no such public repository");
		if (res.status === 403) throw new Error("GitHub's limit for this hour is used up — try later");
		if (!res.ok) throw new Error(`GitHub: HTTP ${res.status}`);
		return res.json();
	}

	const head = async (repo) => (await gh(`/repos/${repo}/commits/HEAD`)).sha;

	async function gamesAt(repo, sha) {
		const tree = await gh(`/repos/${repo}/git/trees/${sha}?recursive=1`);
		return tree.tree
			.filter((t) => t.type === "blob" && /(^|\/)game\.json$/.test(t.path))
			.map((t) => t.path.replace(/\/?game\.json$/, ""))
			.filter(Boolean)
			.sort();
	}

	function pinText(repo, commit, games) {
		return `${JSON.stringify({ repo: `https://github.com/${repo}`, commit, games }, null, 2).replace(/\[\n\s+([\s\S]*?)\n\s+\]/, (_, inner) => `[${inner.replace(/\s*\n\s*/g, " ")}]`)}\n`;
	}
	const newFileUrl = (repo, text) => `https://github.com/${ARCADE}/new/main?${new URLSearchParams({ filename: `registry/${repo}.json`, value: text })}`;
	const editUrl = (repo) => `https://github.com/${ARCADE}/edit/main/registry/${repo}.json`;

	/**
	 * What to propose for `repo` ("owner/name"): { kind: "new", url, text, games }
	 * | { kind: "update", url, from, to } | { kind: "current", at }. `pinned` is
	 * the commit the arcade has now, if it has one.
	 */
	async function plan(repo, pinned = null) {
		repo = repo.trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$|\/$/g, "");
		if (!REPO.test(repo)) throw new Error("a repository is owner/name");
		const to = await head(repo);
		if (pinned) return pinned === to ? { kind: "current", repo, at: to } : { kind: "update", repo, url: editUrl(repo), from: pinned, to };
		const games = await gamesAt(repo, to);
		if (!games.length) throw new Error(`no game.json in ${repo} — see the guide above`);
		const text = pinText(repo, to, games);
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

	NeonArcade.propose = { plan, pinText, newFileUrl, editUrl, pinnedOf };
})();
