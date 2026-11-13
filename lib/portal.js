// lib/portal.js — the portal's game cards, drawn from the catalogs.
//
// Every game the arcade lists is in NeonArcade.CATALOG: this repo's
// (lib/catalog.js) and every pinned outside repo's (community/catalog.js).
// A card per game, in that order; nothing is written by hand any more, so a
// merged registry PR shows up here with no edit to this page.
//
// Also here, from lib/stats.js (this device only): a star on each card
// (favourites), a FAVOURITES filter, a "Recently played" row, and what you
// have played of each game. The filter chips keep their old rule — one at a
// time, "All" one tap away.

window.NeonArcade = window.NeonArcade || {};

(() => {
	const S = () => NeonArcade.stats;
	const linkOf = (g, mode) => `party.html?${new URLSearchParams({ game: g.id, fresh: "1", ...(mode ? { mode } : {}) })}`;
	const el = (tag, cls, text) => {
		const n = document.createElement(tag);
		if (cls) n.className = cls;
		if (text != null) n.textContent = text;
		return n;
	};

	/** "2 players · bots", "1–8 players · bots", "2–8 players · people only". */
	function meta(g) {
		const { min, max } = g.seats;
		if (g.local) return `${g.players?.min ?? min}–${g.players?.max ?? max} players · one device`;
		const players = min === max ? `${min} players` : `${min}–${max} players`;
		return g.bots ? `${players} · bots` : `${players} · people only`;
	}

	function card(g) {
		const c = el("div", "game-card");
		c.dataset.game = g.id;
		const tags = [...g.tags];
		if (S()?.isFav(g.id)) tags.push("favs");
		c.dataset.tags = tags.join(" ");
		// The card itself opens its two choices (a tap on a touch screen; a mouse
		// sees them on hover, a keyboard on focus): no PLAY NOW in between.
		c.tabIndex = 0;
		c.addEventListener("click", () => {
			for (const o of document.querySelectorAll(".game-card.is-open")) if (o !== c) o.classList.remove("is-open");
			c.classList.toggle("is-open");
		});

		const img = el("img");
		img.alt = `${g.title} preview`;
		img.loading = "lazy";
		img.src = g.preview || "assets/placeholder.svg";
		img.onerror = () => {
			img.onerror = null;
			img.src = "assets/placeholder.svg";
		};

		const star = el("button", "fav");
		const fav = !!S()?.isFav(g.id);
		star.type = "button";
		star.setAttribute("aria-pressed", String(fav));
		star.setAttribute("aria-label", `${fav ? "Remove" : "Add"} ${g.title} ${fav ? "from" : "to"} favourites`);
		star.textContent = fav ? "★" : "☆";
		star.addEventListener("click", (e) => {
			e.stopPropagation();
			S()?.toggleFav(g.id);
		});

		const m = el("p", "game-meta");
		const t = meta(g);
		if (!g.bots && !g.local) {
			const [players, how] = t.split(" · ");
			m.append(`${players} · `, el("span", "no-bots", how));
		} else m.textContent = t;

		const mine = S()?.read()[g.id];
		const you = el("p", "game-you");
		if (mine?.played) {
			you.textContent =
				g.kind === "coop" || g.local
					? `You: ${mine.played} played${mine.bestScore != null ? ` · best ${mine.bestScore}` : ""}`
					: `You: ${mine.won} won of ${mine.played}`;
		} else you.hidden = true;

		// Play with bots / with friends (Lokesh, 2026-11-13). A one-device game
		// has one way to play; a people-only game has no bots.
		const actions = el("div", "card-actions");
		const go = (label, mode, cls) => {
			const a = el("a", `card-play ${cls}`, label);
			a.href = linkOf(g, mode);
			a.addEventListener("click", (e) => e.stopPropagation());
			return a;
		};
		if (g.local) actions.append(go("PLAY", null, "is-bots"));
		else {
			if (g.bots) actions.append(go("PLAY WITH BOTS", "bots", "is-bots"));
			actions.append(go("PLAY WITH FRIENDS", "friends", "is-friends"));
		}

		const by = g.community ? el("p", "game-by", `by ${g.author}`) : null;
		const plays = el("p", "game-plays");
		plays.hidden = true;
		const fb = el("button", "fb", "💬");
		fb.type = "button";
		fb.setAttribute("aria-label", `Feedback on ${g.title}`);
		fb.addEventListener("click", (e) => {
			e.stopPropagation();
			NeonArcade.accountUi?.feedback(g.id, g.title);
		});
		c.append(img, fb, star, el("h3", null, g.title), el("p", "game-desc", g.description), m, you, plays, ...(by ? [by] : []), actions);
		return c;
	}

	/** "1,204 plays" on each card, from the server or the public snapshot. */
	let counts = null;
	function paintCounts() {
		if (!counts) return;
		for (const c of document.querySelectorAll(".games-grid .game-card")) {
			const n = counts.games?.[c.dataset.game]?.played;
			const p = c.querySelector(".game-plays");
			if (!p) continue;
			p.hidden = !n;
			if (n) p.textContent = `${n.toLocaleString()} ${n === 1 ? "play" : "plays"}`;
		}
	}
	function loadCounts() {
		NeonArcade.account
			?.summary()
			.then((s) => {
				counts = s;
				paintCounts();
			})
			.catch(() => {});
	}

	function recentRow(byId) {
		const row = document.querySelector("[data-recent]");
		if (!row) return;
		const ids = (S()?.recent() ?? []).filter((id) => byId.has(id)).slice(0, 6);
		row.hidden = !ids.length;
		const list = row.querySelector(".recent-list");
		list.replaceChildren(
			...ids.map((id) => {
				const a = el("a", "recent-game", byId.get(id).title);
				a.href = linkOf(byId.get(id));
				return a;
			}),
		);
	}

	// ------------------------------------------------------------ search

	/**
	 * A search, parsed: free words match the title, description and tags;
	 * `field:value` narrows — author: (or by:), type: (or kind:), tag:,
	 * players: (a number the game seats), from: (arcade | community | an
	 * owner). Quotes keep spaces: author:"some one". Pure; exported for tests.
	 */
	function parseQuery(q) {
		const terms = [];
		for (const m of String(q ?? "").matchAll(/(\w+):"([^"]*)"|(\w+):(\S+)|"([^"]*)"|(\S+)/g)) {
			const [, k1, v1, k2, v2, quoted, word] = m;
			const key = (k1 ?? k2)?.toLowerCase();
			const value = (v1 ?? v2 ?? quoted ?? word ?? "").toLowerCase();
			if (value) terms.push({ key: key ?? null, value });
		}
		return terms;
	}
	const KEYS = { by: "author", author: "author", kind: "type", type: "type", tag: "tag", tags: "tag", players: "players", from: "from" };
	function matches(g, terms) {
		return terms.every(({ key, value }) => {
			const k = KEYS[key] ?? (key ? "unknown" : null);
			if (k === "author") return (g.author ?? "").toLowerCase().includes(value);
			if (k === "type") return [g.kind, g.shape, g.local ? "local one-device" : ""].join(" ").toLowerCase().includes(value);
			if (k === "tag") return g.tags.some((t) => t.toLowerCase().includes(value));
			if (k === "players") {
				const n = Number(value);
				return Number.isFinite(n) && n >= (g.players?.min ?? g.seats.min) && n <= (g.players?.max ?? g.seats.max);
			}
			if (k === "from") return value === "arcade" ? !g.community : value === "community" ? g.community : (g.author ?? "").toLowerCase() === value;
			if (k === "unknown") return false;
			return [g.title, g.name, g.description, g.blurb, g.author, g.kind, ...g.tags].join(" ").toLowerCase().includes(value);
		});
	}

	let want = "all";
	let query = new URLSearchParams(location.search).get("q") ?? "";
	function applyFilter() {
		const cards = [...document.querySelectorAll(".games-grid .game-card")];
		const byId = new Map((NeonArcade.CATALOG ?? []).map((g) => [g.id, g]));
		const terms = parseQuery(query);
		let shown = 0;
		for (const c of cards) {
			const g = byId.get(c.dataset.game);
			const chip = want === "all" || (c.dataset.tags || "").split(/\s+/).includes(want);
			const match = chip && (!g || matches(g, terms));
			c.hidden = !match;
			if (match) shown++;
		}
		for (const chip of document.querySelectorAll(".filter")) {
			chip.setAttribute("aria-pressed", String(chip.dataset.filter === want));
		}
		const empty = document.querySelector(".filter-empty");
		if (empty) {
			empty.textContent =
				want === "favs" && !query ? "No favourites yet — tap ☆ on a game." : query ? `No game matches "${query}".` : "Nothing matches that yet.";
			empty.hidden = shown > 0;
		}
	}

	function draw() {
		const grid = document.querySelector(".games-grid");
		const games = NeonArcade.CATALOG ?? [];
		grid.replaceChildren(...games.map(card));
		recentRow(new Map(games.map((g) => [g.id, g])));
		applyFilter();
		paintCounts();
	}

	NeonArcade.portal = { draw, linkOf, meta, parseQuery, matches };

	document.addEventListener("DOMContentLoaded", () => {
		for (const chip of document.querySelectorAll(".filter")) {
			chip.addEventListener("click", () => {
				want = chip.dataset.filter;
				applyFilter();
			});
		}
		const box = document.querySelector("[data-search]");
		if (box) {
			box.value = query;
			box.addEventListener("input", () => {
				query = box.value;
				// The search is in the address, so it can be shared or linked to.
				const u = new URL(location.href);
				if (query) u.searchParams.set("q", query);
				else u.searchParams.delete("q");
				history.replaceState(history.state, "", u);
				applyFilter();
			});
		}
		draw();
		loadCounts();
		NeonArcade.account?.onChange(draw);
		// A star tapped, or a game played in another tab: redraw.
		S()?.onChange(draw);
		addEventListener("storage", (e) => e.key?.startsWith("neon.") && draw());
		addEventListener("pageshow", (e) => e.persisted && draw());
	});
})();
