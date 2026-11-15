// lib/collections.js — the Collections view (src/views/Collections.tsx):
// every games repository the arcade lists, most played first.
//
// A collection is one registered games repo — registry/<owner>/<repo>.json
// for an outside one, and the arcade's own (lokeshmohanty/games). A
// contributor can own several (lib/contributors.js lists theirs). Its
// popularity is the sum of its games' plays, the same counts the portal's
// cards show (NeonArcade.account.summary: /api/stats/summary, else the public
// snapshot); ties go by name. Starred ones (lib/stats.js favId.collection)
// come first.
//
// A card: the repo's name and owner, how many games and plays, a few of its
// games (posters and names), ★, SEE ITS GAMES — the portal searched by
// `from:<owner>/<repo>` (lib/portal.js) — and the repo on GitHub.
//
// Also the pieces lib/contributors.js shares: list, playsText, star.

window.NeonArcade = window.NeonArcade || {};

(() => {
	const S = () => NeonArcade.stats;
	const PREVIEWS = 3;
	const NAMES = 4;
	const el = (tag, cls, text) => {
		const n = document.createElement(tag);
		if (cls) n.className = cls;
		if (text != null) n.textContent = text;
		return n;
	};

	/** "owner/repo" from a repo's URL. Pure. */
	const repoOf = (url) => String(url ?? "").replace(/^https:\/\/github\.com\//, "").replace(/\.git$|\/$/g, "");

	/** How often `games` were played, from a summary ({ games: { id: { played } } }). Pure. */
	const playsOf = (games, counts) => games.reduce((n, g) => n + (counts?.games?.[g.id]?.played ?? 0), 0);

	/** "1,204 plays"; "… plays" while the counts are on their way. */
	const playsText = (n, counts) => (counts ? `${n.toLocaleString()} ${n === 1 ? "play" : "plays"}` : "… plays");
	const gamesText = (n) => `${n} game${n === 1 ? "" : "s"}`;

	/**
	 * Every collection, { repo: "owner/name", url, owner, name, games, plays,
	 * pin }, most played first, ties by name. From the catalog's games (each
	 * carries its `repo`) and the contributors' repos and pins (a registered
	 * repo with no game listed still shows). Pure.
	 */
	function list(catalog, contributors, counts) {
		const by = new Map();
		const add = (url) => {
			const repo = repoOf(url);
			if (!by.has(repo)) {
				const [owner, name = repo] = repo.split("/");
				by.set(repo, { repo, url: `https://github.com/${repo}`, owner, name, games: [], pin: null });
			}
			return by.get(repo);
		};
		for (const c of contributors ?? []) {
			for (const r of c.repos ?? []) {
				const col = add(r);
				col.pin ??= c.pins?.[r] ?? null;
			}
		}
		for (const g of catalog ?? []) if (g.repo) add(g.repo).games.push(g);
		return [...by.values()]
			.map((c) => ({ ...c, plays: playsOf(c.games, counts) }))
			.sort((a, b) => b.plays - a.plays || a.repo.localeCompare(b.repo));
	}

	/** `items` with the starred ones first, each part keeping its order. Pure. */
	const favFirst = (items, isFav) => [...items.filter(isFav), ...items.filter((x) => !isFav(x))];

	/** A ★ toggle for favourite `id` (lib/stats.js favId); `what` names it. */
	function star(id, what) {
		const b = el("button", "fav-star");
		b.type = "button";
		b.dataset.fav = id;
		b.dataset.what = what;
		b.onclick = (e) => {
			e.stopPropagation();
			S()?.toggleFav(id); // the view hears the change, repaints and reorders
		};
		paintStar(b);
		return b;
	}
	function paintStar(b) {
		const on = !!S()?.isFav(b.dataset.fav);
		b.textContent = on ? "★" : "☆";
		b.setAttribute("aria-pressed", String(on));
		b.title = `${on ? "Remove" : "Add"} ${b.dataset.what} ${on ? "from" : "to"} favourites`;
		b.setAttribute("aria-label", b.title);
	}

	/**
	 * Put `items` into `holder` as `nodeOf(item)` gives them, moving the nodes
	 * already there rather than drawing them anew (a contributor's CHECK FOR
	 * UPDATES answer stays), and keep the focus where it was.
	 */
	function arrange(holder, nodes) {
		const focused = holder.contains(document.activeElement) ? document.activeElement : null;
		holder.replaceChildren(...nodes);
		for (const b of holder.querySelectorAll(".fav-star")) paintStar(b);
		if (focused?.isConnected) focused.focus({ preventScroll: true });
	}

	function card(c) {
		const box = el("article", "collection");
		box.dataset.repo = c.repo;
		const head = el("div", "collection-head");
		const who = el("div", "collection-who");
		who.append(el("h2", null, c.name));
		const owner = el("a", "collection-owner", `@${c.owner}`);
		owner.href = `https://github.com/${encodeURIComponent(c.owner)}`;
		owner.target = "_blank";
		owner.rel = "noopener";
		who.append(owner);
		head.append(who, star(S()?.favId.collection(c.repo) ?? `collection:${c.repo}`, c.repo));
		box.append(head);
		const facts = el("p", "collection-meta");
		facts.append(el("span", null, gamesText(c.games.length)), " · ", el("span", "collection-plays"));
		box.append(facts);
		// A few of its games: the ~5 KB posters only (never the gifs), and names.
		const posters = c.games.filter((g) => g.poster).slice(0, PREVIEWS);
		if (posters.length) {
			const strip = el("div", "collection-previews");
			for (const g of posters) {
				const img = el("img", "collection-preview");
				img.alt = "";
				img.loading = "lazy";
				img.src = g.poster;
				img.onerror = () => img.remove();
				strip.append(img);
			}
			box.append(strip);
		}
		if (c.games.length) {
			const more = c.games.length - NAMES;
			box.append(el("p", "collection-games", c.games.slice(0, NAMES).map((g) => g.title).join(", ") + (more > 0 ? ` +${more} more` : "")));
		}
		const links = el("div", "collection-links");
		const see = el("a", "neon-btn neon-btn--accent", "SEE ITS GAMES");
		see.href = `./?${new URLSearchParams({ q: `from:${c.repo}` })}`;
		const gh = el("a", "neon-btn", "GitHub ↗");
		gh.href = c.url;
		gh.target = "_blank";
		gh.rel = "noopener";
		links.append(see, gh);
		box.append(links);
		return box;
	}

	/**
	 * The view, drawn into `root` ([data-collections], [data-count]); returns
	 * its cleanup. The counts arrive late (or never, offline): the cards show
	 * "… plays" until then, and are sorted again when they come.
	 */
	function mount(root) {
		const holder = root.querySelector("[data-collections]");
		const nodes = new Map(); // repo → its card, kept across repaints
		let counts = null;
		let live = true;
		const paint = () => {
			const all = list(NeonArcade.CATALOG, NeonArcade.CONTRIBUTORS, counts);
			const fav = (c) => !!S()?.isFav(`collection:${c.repo}`);
			arrange(
				holder,
				favFirst(all, fav).map((c) => {
					if (!nodes.has(c.repo)) nodes.set(c.repo, card(c));
					const n = nodes.get(c.repo);
					n.querySelector(".collection-plays").textContent = playsText(c.plays, counts);
					return n;
				}),
			);
			const n = root.querySelector("[data-count]");
			if (n) n.textContent = `${all.length} collection${all.length === 1 ? "" : "s"}, ${(NeonArcade.CATALOG ?? []).length} games — most played first.`;
		};
		paint();
		NeonArcade.account
			?.summary()
			.then((s) => {
				if (!live) return;
				counts = s ?? { games: {} };
				paint();
			})
			.catch(() => {});
		const off = S()?.onChange((what) => what === "favs" && paint()) ?? (() => {});
		const storage = (e) => e.key === "neon.favs" && paint();
		addEventListener("storage", storage);
		return () => {
			live = false;
			off();
			removeEventListener("storage", storage);
			holder?.replaceChildren();
		};
	}

	NeonArcade.collections = { repoOf, playsOf, playsText, gamesText, list, favFirst, star, paintStar, arrange, mount };
})();
