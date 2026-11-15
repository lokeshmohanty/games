// lib/contributors.js — the Contributors view (src/views/Contributors.tsx):
// everyone whose games the arcade lists, from the catalogs
// (NeonArcade.CONTRIBUTORS: one entry per repo owner per catalog, from their
// contributor.json at the pinned commit; merged here into one per person).
//
// A card: their GitHub avatar and login, the name, bio, location and links
// they chose, ★ (lib/stats.js favId.contributor), their games and the
// games' total plays, and their collections — each games repo they share
// (lib/collections.js), with its games and plays, a link to its games in the
// portal, the repo on GitHub, and CHECK FOR UPDATES when it is pinned
// (lib/propose.js). SEE THEIR GAMES is the portal searched by
// `author:<login>`. Starred contributors come first.

window.NeonArcade = window.NeonArcade || {};

(() => {
	const el = (tag, cls, text) => {
		const n = document.createElement(tag);
		if (cls) n.className = cls;
		if (text != null) n.textContent = text;
		return n;
	};

	/** One card per login: a person with two repos is one contributor. Pure. */
	function merged(list, catalog) {
		const by = new Map();
		for (const c of list ?? []) {
			const had = by.get(c.login);
			if (!had) by.set(c.login, { ...c, repos: [...c.repos], pins: { ...(c.pins ?? {}) } });
			else {
				for (const r of c.repos) if (!had.repos.includes(r)) had.repos.push(r);
				Object.assign(had.pins, c.pins ?? {});
				for (const k of ["name", "bio", "location"]) had[k] ??= c[k];
				if (!had.links.length) had.links = c.links;
			}
		}
		const counts = new Map();
		for (const g of catalog ?? []) counts.set(g.author, (counts.get(g.author) ?? 0) + 1);
		return [...by.values()]
			.map((c) => ({ ...c, games: counts.get(c.login) ?? 0 }))
			.sort((a, b) => b.games - a.games || a.login.localeCompare(b.login));
	}

	const C = () => NeonArcade.collections;
	const outLink = (cls, text, href, rel = "noopener") => {
		const a = el("a", cls, text);
		a.href = href;
		a.target = "_blank";
		a.rel = rel;
		return a;
	};

	// A pinned repo whose head has moved on: its owner proposes the bump —
	// a pull request is theirs to open (lib/propose.js).
	function checkUpdates(repo, commit) {
		const upd = el("div", "person-update");
		const btn = el("button", "party-mini", "CHECK FOR UPDATES");
		btn.type = "button";
		btn.onclick = async () => {
			btn.disabled = true;
			upd.querySelector(".person-update-out")?.remove();
			const out = el("div", "person-update-out");
			try {
				const p = await NeonArcade.propose.plan(repo, commit);
				if (p.kind === "current") out.append(el("p", "person-meta", `Up to date (${commit.slice(0, 7)})`));
				else {
					const row = el("p", "person-meta", `${p.from.slice(0, 7)} → ${p.to.slice(0, 7)}. `);
					const go = outLink(null, "Copy the commit & open the pin ↗", p.url);
					go.onclick = () => navigator.clipboard?.writeText(p.to).then(() => NeonArcade.toast?.("New commit copied — on GitHub, select the old one in \"commit\" and paste.", "good"), () => {});
					row.append(go, el("code", "person-sha", p.to));
					out.append(row);
				}
			} catch (err) {
				out.append(el("p", "person-meta", err.message));
			}
			upd.append(out);
			btn.disabled = false;
		};
		upd.append(btn);
		return upd;
	}

	/** One of their collections: name (its games in the portal), games, plays, GitHub, updates. */
	function collectionRow(col) {
		const li = el("li", "person-collection");
		li.dataset.repo = col.repo;
		const top = el("div", "person-collection-top");
		const name = el("a", "person-collection-name", col.repo);
		name.href = `./?${new URLSearchParams({ q: `from:${col.repo}` })}`;
		name.title = `The games in ${col.repo}`;
		top.append(name, outLink("person-collection-gh", "GitHub ↗", col.url));
		const facts = el("div", "person-meta");
		facts.append(C().gamesText(col.games.length), " · ", el("span", "person-collection-plays"));
		li.append(top, facts);
		if (col.pin && NeonArcade.propose) li.append(checkUpdates(col.repo, col.pin));
		return li;
	}

	function card(c, cols) {
		const box = el("article", "person");
		box.dataset.login = c.login;
		const head = el("div", "person-head");
		const img = el("img", "person-avatar");
		img.alt = "";
		img.loading = "lazy";
		img.referrerPolicy = "no-referrer";
		img.src = `https://github.com/${encodeURIComponent(c.login)}.png?size=96`;
		// Offline, or no such avatar: their initial.
		img.onerror = () => {
			const initial = el("div", "person-avatar person-initial", (c.name ?? c.login).slice(0, 1).toUpperCase());
			img.replaceWith(initial);
		};
		const who = el("div", "person-who");
		who.append(el("h2", null, c.name ?? c.login));
		who.append(outLink("person-login", `@${c.login}`, `https://github.com/${encodeURIComponent(c.login)}`));
		if (c.location) who.append(el("div", "person-meta", c.location));
		head.append(img, who, C().star(NeonArcade.stats?.favId.contributor(c.login) ?? `contributor:${c.login}`, c.name ?? c.login));
		box.append(head);
		if (c.bio) box.append(el("p", "person-bio", c.bio));
		const facts = el("div", "person-meta person-facts");
		facts.append(
			C().gamesText(c.games),
			" · ",
			el("span", "person-plays"),
			` · ${cols.length} collection${cols.length === 1 ? "" : "s"}`,
		);
		box.append(facts);
		if (cols.length) {
			const ul = el("ul", "person-collections");
			ul.setAttribute("aria-label", "Collections");
			ul.append(...cols.map(collectionRow));
			box.append(ul);
		}
		const links = el("div", "person-links");
		const games = el("a", "neon-btn neon-btn--accent", "SEE THEIR GAMES");
		games.href = `index.html?${new URLSearchParams({ q: `author:${c.login}` })}`;
		links.append(games);
		for (const l of c.links ?? []) {
			if (!/^https:\/\//.test(l.url)) continue;
			links.append(outLink("neon-btn", `${l.label} ↗`, l.url, "noopener nofollow"));
		}
		box.append(links);
		return box;
	}

	/**
	 * The view, drawn into `root`'s [data-people] and [data-count]; returns
	 * its cleanup. The cards are made once per visit and moved, not redrawn,
	 * when a star or the play counts reorder them, so a CHECK FOR UPDATES
	 * answer stays put. A late answer after cleanup writes into a detached card.
	 */
	function mount(root) {
		const holder = root.querySelector("[data-people]");
		const nodes = new Map(); // login → card
		let counts = null;
		let live = true;
		const paint = () => {
			const people = merged(NeonArcade.CONTRIBUTORS, NeonArcade.CATALOG);
			const cols = C().list(NeonArcade.CATALOG, NeonArcade.CONTRIBUTORS, counts);
			const fav = (c) => !!NeonArcade.stats?.isFav(`contributor:${c.login}`);
			C().arrange(
				holder,
				C()
					.favFirst(people, fav)
					.map((c) => {
						// Theirs: the repos they listed, most played first.
						const mine = cols.filter((col) => c.repos.some((r) => C().repoOf(r) === col.repo));
						if (!nodes.has(c.login)) nodes.set(c.login, card(c, mine));
						const n = nodes.get(c.login);
						const total = mine.reduce((sum, col) => sum + col.plays, 0);
						n.querySelector(".person-plays").textContent = C().playsText(total, counts);
						const ul = n.querySelector(".person-collections");
						for (const col of mine) {
							const li = ul?.querySelector(`[data-repo="${CSS.escape(col.repo)}"]`);
							if (!li) continue;
							li.querySelector(".person-collection-plays").textContent = C().playsText(col.plays, counts);
							ul.append(li);
						}
						return n;
					}),
			);
			const n = root.querySelector("[data-count]");
			if (n) n.textContent = `${people.length} contributor${people.length === 1 ? "" : "s"}, ${cols.length} collection${cols.length === 1 ? "" : "s"}, ${(NeonArcade.CATALOG ?? []).length} games.`;
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
		const off = NeonArcade.stats?.onChange((what) => what === "favs" && paint()) ?? (() => {});
		const storage = (e) => e.key === "neon.favs" && paint();
		addEventListener("storage", storage);
		return () => {
			live = false;
			off();
			removeEventListener("storage", storage);
			holder?.replaceChildren();
		};
	}

	NeonArcade.contributors = { merged, mount };
})();
