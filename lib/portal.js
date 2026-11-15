// lib/portal.js — the home screen's game cards, drawn from the catalogs.
//
// Every game the arcade lists is in NeonArcade.CATALOG: this repo's
// (lib/catalog.js) and every pinned outside repo's (community/catalog.js).
// Nothing is written by hand, so a merged registry PR shows up here with no
// edit to this page.
//
// The home screen is sections (Lokesh, 2026-11-15; SECTIONS below): your
// favourites, the most played, then the catalog's categories — a game sits
// in every section it belongs to. A search replaces them all with one grid
// of what matches. Also, from lib/stats.js: a "Recently played" row and what
// you have played of each game. A game is starred, and given feedback, from
// inside it (party.js, top right; Lokesh, 2026-11-14), not from its card.
//
// The page is one page now (docs/spa.md): src/views/Portal.tsx renders the
// static markup and calls NeonArcade.portal.mount(root) each time the view
// opens; the cleanup it returns drops every listener the visit added.

window.NeonArcade = window.NeonArcade || {};

(() => {
	const S = () => NeonArcade.stats;
	const linkOf = (g, mode) => `./?${new URLSearchParams({ game: g.id, fresh: "1", ...(mode ? { mode } : {}) })}`;
	/** The mounted view (mount), or null: everything below looks inside it. */
	let root = null;
	const $ = (sel) => root?.querySelector(sel) ?? null;
	const $$ = (sel) => (root ? [...root.querySelectorAll(sel)] : []);
	const el = (tag, cls, text) => {
		const n = document.createElement(tag);
		if (cls) n.className = cls;
		if (text != null) n.textContent = text;
		return n;
	};

	/**
	 * A card's preview. The video twins (scripts/preview-media.mjs: ~15 KB
	 * WebM / ~30 KB MP4 with a ~5 KB poster) when the catalog lists them,
	 * playing only while the card is on screen; else the still `preview` (the
	 * arcade's games name their poster; an outside repo's may be a gif).
	 * Nothing loads until the card nears the viewport. The home screen holds
	 * a card per game per section, so two observers: `near` fetches a little
	 * ahead of the scroll, `seen` plays only what is at least half on screen
	 * (a card scrolled out of its row, or in a hidden section, is not).
	 */
	/** A video not fetched yet → its game. */
	const unfetched = new WeakMap();
	/** The videos at least half on screen: the ones that play. */
	const onScreen = new WeakSet();
	/**
	 * One fetch per clip, however many cards show it: a game sits in several
	 * sections at once (Favourites, Popular, Party, Strategy), and each card's
	 * own <source> fetched the file again — neon-bid.webm three times on one
	 * load, with the HTTP cache on or off (2026-11-15). The first card near
	 * the screen fetches it; every card plays the same blob: URL, for the
	 * page's life. A failure is kept too: those cards show their posters.
	 */
	const clips = new Map(); // absolute video URL → Promise<blob: URL>
	const clip = (src) => {
		const url = new URL(src, document.baseURI).href;
		if (!clips.has(url)) clips.set(url, fetch(url).then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`${r.status}`)))).then((b) => URL.createObjectURL(b)));
		return clips.get(url);
	};
	/**
	 * Give a video its clip, and fetch it. Only now, when the card nears the
	 * screen: every card fetching at once was the whole catalog's videos
	 * before the first screenful had played.
	 */
	const fetchVideo = (v) => {
		const g = unfetched.get(v);
		if (!g) return;
		unfetched.delete(v);
		// WebM first, as the <source> order was; only formats this browser
		// says it may play.
		const options = [
			[g.webm, "video/webm"],
			[g.mp4, "video/mp4"],
		].filter(([src, type]) => src && v.canPlayType(type));
		// No clip would play (offline: sw.js leaves videos to the network; or
		// neither format): the poster, still. Never the gif: a perf run
		// (2026-11-14) caught every video failing at once on a cold load, and
		// the gifs that replaced them cost 5.9 MB.
		const next = () => {
			const [src] = options.shift() ?? [];
			if (!src) {
				near?.unobserve(v);
				seen?.unobserve(v);
				v.replaceWith(still(g, g.poster ?? g.preview));
				return;
			}
			clip(src).then((url) => {
				v.src = url;
				if (onScreen.has(v)) v.play().catch(() => {});
			}, next);
		};
		v.addEventListener("error", next); // a clip it could not decode: the next format
		next();
	};
	const observer = (fn, options) =>
		"IntersectionObserver" in window
			? new IntersectionObserver((entries) => {
					for (const e of entries) fn(e.target, e);
				}, options)
			: null;
	const near = observer((v, e) => e.isIntersecting && fetchVideo(v), { rootMargin: "200px" });
	const seen = observer(
		(v, e) => {
			if (!e.isIntersecting || e.intersectionRatio < 0.5) {
				onScreen.delete(v);
				return v.pause();
			}
			onScreen.add(v);
			fetchVideo(v);
			if (v.src) v.play().catch(() => {});
		},
		{ threshold: 0.5 },
	);
	/** Stop watching the videos under `node` (its cards are being replaced). */
	const unwatch = (node) => {
		for (const v of node.querySelectorAll("video")) {
			near?.unobserve(v);
			seen?.unobserve(v);
		}
	};
	const still = (g, src = g.preview) => {
		const img = el("img", "card-preview");
		img.alt = `${g.title} preview`;
		img.loading = "lazy";
		img.src = src || "assets/placeholder.svg";
		img.onerror = () => {
			img.onerror = null;
			img.src = "assets/placeholder.svg";
		};
		return img;
	};
	const preview = (g) => {
		if (seen && (g.webm || g.mp4)) {
			const v = el("video", "card-preview");
			v.muted = true;
			v.loop = true;
			v.playsInline = true;
			v.preload = "none";
			v.setAttribute("aria-label", `${g.title} preview`);
			if (g.poster) v.poster = g.poster;
			unfetched.set(v, g); // its sources come when the card is near
			near.observe(v);
			seen.observe(v);
			return v;
		}
		return still(g);
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
			for (const o of $$(".game-card.is-open")) if (o !== c) o.classList.remove("is-open");
			c.classList.toggle("is-open");
		});

		const img = preview(g);

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
		const label = NeonArcade.playLabels(g);
		if (g.local) actions.append(go(label.solo, null, "is-bots"));
		else {
			if (g.bots) actions.append(go(label.solo, "bots", "is-bots"));
			actions.append(go(label.multi, "friends", "is-friends"));
		}

		const by = g.community ? el("p", "game-by", `by ${g.author}`) : null;
		const plays = el("p", "game-plays");
		plays.hidden = true;
		c.append(img, el("h3", null, g.title), el("p", "game-desc", g.description), m, you, plays, ...(by ? [by] : []), actions);
		return c;
	}

	/**
	 * How often each game was played, by everybody ({ [id]: n }): the server's
	 * summary, else the public snapshot (lib/account.js). Kept on this device,
	 * so the next visit paints its counts and its Popular row at once.
	 */
	const PLAYS = "neon.plays";
	let plays = null;
	const readPlays = () => {
		try {
			return JSON.parse(localStorage.getItem(PLAYS)) ?? null;
		} catch {
			return null;
		}
	};
	/** "1,204 plays" on each card. */
	function paintCounts() {
		if (!plays) return;
		for (const c of $$(".game-card")) {
			const n = plays[c.dataset.game];
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
				const next = Object.fromEntries(Object.entries(s?.games ?? {}).map(([id, r]) => [id, r?.played ?? 0]));
				// Offline the summary is { games: {} }: no news, keep what we had.
				if (!Object.keys(next).length) return;
				plays = next;
				try {
					localStorage.setItem(PLAYS, JSON.stringify(plays));
				} catch {}
				drawSection("popular"); // only if the order moved
				paintCounts();
			})
			.catch(() => {});
	}

	// ------------------------------------------------------------ sections

	const cats = (g) => g.categories ?? [];
	const inCategory = (c) => (games) => games.filter((g) => cats(g).includes(c));
	const POPULAR = 5;
	/** A favourite that is a contributor or a collection (lib/stats.js favId). */
	const OTHER_FAV = /^(contributor|collection):(.+)$/;
	/**
	 * The home screen, top to bottom (Lokesh, 2026-11-15). `pick` chooses a
	 * section's games, in order, from the catalog; an empty section is hidden.
	 * The categories are the catalog's (scripts/manifest.mjs CATEGORIES).
	 */
	const SECTIONS = [
		{ id: "favs", title: "★ Favourites", pick: (games, byId) => (S()?.favs() ?? []).map((id) => byId.get(id)).filter(Boolean) },
		// Most played first. A tie, or no counts at all (offline on a first
		// visit), keeps the catalog's order: sort is stable.
		{
			id: "popular",
			title: "Popular",
			pick: (games) =>
				[...games]
					.sort((a, b) => (plays?.[b.id] ?? 0) - (plays?.[a.id] ?? 0))
					.slice(0, POPULAR),
		},
		{ id: "arcade", title: "Arcade", pick: inCategory("arcade") },
		{ id: "party", title: "Party", pick: inCategory("party") },
		{ id: "strategy", title: "Strategy", pick: inCategory("strategy") },
		// Not only the puzzles: anything one person can start on their own.
		{ id: "solo", title: "Puzzle / Single player", pick: (games) => games.filter((g) => cats(g).includes("puzzle") || g.seats.min <= 1) },
		// A game none of the categories above take (its manifest and tags give
		// none) is still on the home screen, not only behind a search.
		{
			id: "other",
			title: "More games",
			pick: (games) => games.filter((g) => !SECTIONS.some((s) => !["favs", "popular", "other"].includes(s.id) && s.pick([g]).length)),
		},
	];

	/** A section's empty frame: a heading, its row of cards (and, for favourites, the people and repos starred). */
	function shell({ id, title }) {
		const n = el("section", "portal-section");
		n.dataset.section = id;
		n.hidden = true;
		n.append(el("h2", "section-title", title), el("div", "section-row"));
		if (id === "favs") {
			const more = el("div", "fav-more");
			more.hidden = true;
			n.append(more);
		}
		return n;
	}

	/** Fill one section. Unless `force`d, its cards are left alone when the same games would be drawn. */
	function drawSection(id, force = false) {
		const sec = SECTIONS.find((s) => s.id === id);
		const node = $(`[data-section="${id}"]`);
		if (!sec || !node) return;
		const games = NeonArcade.CATALOG ?? [];
		const list = sec.pick(games, new Map(games.map((g) => [g.id, g])));
		const row = node.querySelector(".section-row");
		const ids = list.map((g) => g.id).join(" ");
		if (force || row.dataset.ids !== ids) {
			unwatch(row);
			row.replaceChildren(...list.map(card));
			row.dataset.ids = ids;
			paintCounts();
		}
		row.hidden = !list.length;
		let others = 0;
		const more = node.querySelector(".fav-more");
		if (more) {
			// Starred on Contributors and Collections: each opens its games here.
			const favs = (S()?.favs() ?? []).map((f) => f.match(OTHER_FAV)).filter(Boolean);
			more.replaceChildren(
				...favs.map(([, kind, name]) => {
					const b = el("button", "fav-more-item", name);
					b.type = "button";
					b.dataset.q = kind === "contributor" ? `author:${name}` : `from:${name}`;
					return b;
				}),
			);
			more.hidden = !favs.length;
			others = favs.length;
		}
		node.hidden = !list.length && !others;
	}

	function recentRow(byId) {
		const row = $("[data-recent]");
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
	 * owner | a collection, owner/repo). Quotes keep spaces: author:"some one".
	 * Pure; exported for tests.
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
			if (k === "from") {
				if (value === "arcade") return !g.community;
				if (value === "community") return g.community;
				// A collection (lib/collections.js): the games repo it came from.
				if (value.includes("/")) return (g.repo ?? "").toLowerCase().replace(/^https:\/\/github\.com\//, "").replace(/\.git$|\/$/g, "") === value;
				return (g.author ?? "").toLowerCase() === value;
			}
			if (k === "unknown") return false;
			return [g.title, g.name, g.description, g.blurb, g.author, g.kind, ...g.tags].join(" ").toLowerCase().includes(value);
		});
	}

	let query = "";
	/** The sections, or — while a search is typed — one grid of what matches it. */
	function applySearch() {
		const grid = $(".games-grid");
		if (!grid) return;
		const games = NeonArcade.CATALOG ?? [];
		const terms = parseQuery(query);
		const searching = terms.length > 0;
		const sections = $("[data-sections]");
		if (sections) sections.hidden = searching;
		const recent = $("[data-recent]");
		if (recent) recent.hidden = searching || !recent.querySelector(".recent-game");
		grid.hidden = !searching;
		// A card per game, made on the first search: until then nobody needs them.
		if (searching && !grid.childElementCount) {
			grid.replaceChildren(...games.map(card));
			paintCounts();
		}
		const byId = new Map(games.map((g) => [g.id, g]));
		let shown = 0;
		for (const c of grid.children) {
			const g = byId.get(c.dataset.game);
			const match = !g || matches(g, terms);
			c.hidden = !match;
			if (match) shown++;
		}
		const empty = $(".filter-empty");
		if (empty) {
			empty.textContent = `No game matches "${query.trim()}".`;
			empty.hidden = !searching || shown > 0;
		}
	}

	function draw() {
		const grid = $(".games-grid");
		if (!grid) return; // not mounted
		const games = NeonArcade.CATALOG ?? [];
		// The old cards' videos; the new ones observe themselves.
		near?.disconnect();
		seen?.disconnect();
		for (const s of SECTIONS) drawSection(s.id, true);
		grid.replaceChildren(); // the search's cards: made again when wanted
		recentRow(new Map(games.map((g) => [g.id, g])));
		applySearch();
	}

	/**
	 * Draw the portal into `r` (src/views/Portal.tsx: the search,
	 * [data-recent], [data-sections], .games-grid) and keep it current.
	 * Returns the cleanup: the view mounts and unmounts many times in one page.
	 */
	function mount(r) {
		root = r;
		query = new URLSearchParams(location.search).get("q") ?? "";
		plays ??= readPlays();
		const off = [];
		const on = (target, type, fn) => {
			target.addEventListener(type, fn);
			off.push(() => target.removeEventListener(type, fn));
		};
		$("[data-sections]")?.replaceChildren(...SECTIONS.map(shell));
		const box = $("[data-search]");
		const search = (q) => {
			query = q;
			// The search is in the address, so it can be shared or linked to.
			// replaceState, not the router's navigate: the view stays mounted.
			const u = new URL(location.href);
			if (query) u.searchParams.set("q", query);
			else u.searchParams.delete("q");
			history.replaceState(history.state, "", u);
			applySearch();
		};
		if (box) {
			box.value = query;
			on(box, "input", () => search(box.value));
		}
		// A starred contributor or collection: its games, as a search.
		on(r, "click", (e) => {
			const b = e.target.closest?.(".fav-more-item");
			if (!b) return;
			if (box) box.value = b.dataset.q;
			search(b.dataset.q);
		});
		draw();
		loadCounts();
		off.push(NeonArcade.account?.onChange(draw) ?? (() => {}));
		// A star tapped, or a game played in another tab: redraw.
		off.push(S()?.onChange(draw) ?? (() => {}));
		on(window, "storage", (e) => e.key?.startsWith("neon.") && e.key !== PLAYS && draw());
		on(window, "pageshow", (e) => e.persisted && draw());
		return () => {
			for (const f of off) f();
			near?.disconnect();
			seen?.disconnect();
			if (root === r) root = null;
		};
	}

	NeonArcade.portal = { mount, draw, linkOf, meta, parseQuery, matches };
})();
