// lib/contributors.js — contributors.html: everyone whose games the arcade
// lists, from the catalogs (NeonArcade.CONTRIBUTORS: one card per repo owner,
// from their contributor.json at the pinned commit).
//
// A card: their GitHub avatar and login, the name, bio, location and links
// they chose, how many games, their games repo(s), and SEE THEIR GAMES —
// the portal searched by `author:<login>`.

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

	function card(c) {
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
		const login = el("a", "person-login", `@${c.login}`);
		login.href = `https://github.com/${encodeURIComponent(c.login)}`;
		login.target = "_blank";
		login.rel = "noopener";
		who.append(login);
		if (c.location) who.append(el("div", "person-meta", c.location));
		head.append(img, who);
		box.append(head);
		if (c.bio) box.append(el("p", "person-bio", c.bio));
		const facts = el("div", "person-meta", `${c.games} game${c.games === 1 ? "" : "s"}`);
		box.append(facts);
		const links = el("div", "person-links");
		const games = el("a", "neon-btn neon-btn--accent", "SEE THEIR GAMES");
		games.href = `index.html?${new URLSearchParams({ q: `author:${c.login}` })}`;
		links.append(games);
		for (const r of c.repos) {
			const a = el("a", "neon-btn", r.replace("https://github.com/", "") + " ↗");
			a.href = r;
			a.target = "_blank";
			a.rel = "noopener";
			links.append(a);
		}
		for (const l of c.links ?? []) {
			if (!/^https:\/\//.test(l.url)) continue;
			const a = el("a", "neon-btn", `${l.label} ↗`);
			a.href = l.url;
			a.target = "_blank";
			a.rel = "noopener nofollow";
			links.append(a);
		}
		box.append(links);
		// A pinned repo whose head has moved on: its owner proposes the bump —
		// a pull request is theirs to open (lib/propose.js).
		const pinned = Object.entries(c.pins ?? {});
		if (pinned.length && NeonArcade.propose) {
			const upd = el("div", "person-update");
			const btn = el("button", "party-mini", "CHECK FOR UPDATES");
			btn.type = "button";
			btn.onclick = async () => {
				btn.disabled = true;
				upd.querySelector(".person-update-out")?.remove();
				const out = el("div", "person-update-out");
				for (const [url, commit] of pinned) {
					const repo = url.replace("https://github.com/", "");
					try {
						const p = await NeonArcade.propose.plan(repo, commit);
						if (p.kind === "current") out.append(el("p", "person-meta", `${repo}: up to date (${commit.slice(0, 7)})`));
						else {
							const row = el("p", "person-meta", `${repo}: ${p.from.slice(0, 7)} → ${p.to.slice(0, 7)}. `);
							const go = el("a", null, "Propose update ↗");
							go.href = p.url;
							go.target = "_blank";
							go.rel = "noopener";
							go.onclick = () => navigator.clipboard?.writeText(p.to).then(() => NeonArcade.toast?.("New commit copied — paste it as \"commit\".", "good"), () => {});
							row.append(go, el("code", "person-sha", p.to));
							out.append(row);
						}
					} catch (err) {
						out.append(el("p", "person-meta", `${repo}: ${err.message}`));
					}
				}
				upd.append(out);
				btn.disabled = false;
			};
			upd.append(btn);
			box.append(upd);
		}
		return box;
	}

	function draw() {
		const list = merged(NeonArcade.CONTRIBUTORS, NeonArcade.CATALOG);
		const holder = document.querySelector("[data-people]");
		holder.replaceChildren(...list.map(card));
		const n = document.querySelector("[data-count]");
		if (n) n.textContent = `${list.length} contributor${list.length === 1 ? "" : "s"}, ${(NeonArcade.CATALOG ?? []).length} games.`;
	}

	NeonArcade.contributors = { merged, draw };
	document.addEventListener("DOMContentLoaded", draw);
})();
