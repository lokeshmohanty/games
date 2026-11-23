// lib/portal.js — the home screen's game cards, drawn from the catalogs.
//
// Every game the arcade lists is in NeonArcade.CATALOG: this repo's
// (lib/catalog.js) and every pinned outside repo's (community/catalog.js).
// Nothing is written by hand, so a merged registry PR shows up here with no
// edit to this page.
//
// The home screen is sections (Lokesh, 2026-11-15; SECTIONS below) under two
// sub-tabs of Games (Lokesh, 2026-11-15: "All favourites land under My
// Games"):
//
//   My Games   Recently played and ★ Favourites (games, contributors,
//              collections); a line on how to star, when there is neither
//   All Games  PLAY SOMETHING, the search, Popular, then the catalog's
//              categories — a game sits in every section it belongs to;
//              each category's SEE ALL opens its own page (&genre=<id>)
//
// My Games and a genre's page draw their cards as a grid that scrolls down
// (.is-grid); All Games' sections are rows (Lokesh, 2026-11-21). A tap on a
// game starts it against bots (tapLink).
//
// The address names the sub-tab (src/router.ts); only its sections are
// drawn. A search replaces All Games' sections with one grid of what
// matches. From lib/stats.js: what you have played of each game. A game is
// starred, and given feedback, only from inside it (party.js, top right;
// Lokesh, 2026-11-14, and again 2026-11-16: "Only inside games"); a
// contributor or a collection from its own page. Every star lands in My Games.
//
// The page is one page now (docs/spa.md): src/views/Portal.tsx renders the
// static markup and calls NeonArcade.portal.mount(root) each time the view
// opens; the cleanup it returns drops every listener the visit added.

window.NeonArcade = window.NeonArcade || {};

(() => {
	const S = () => NeonArcade.stats;
	const linkOf = (g, mode) => `./?${new URLSearchParams({ game: g.id, fresh: "1", ...(mode ? { mode } : {}) })}`;
	/** A card's SINGLE PLAYER: against bots, or a one-device game; null for a people-only game. */
	const soloLink = (g) => (g.local ? linkOf(g) : g.bots ? linkOf(g, "bots") : null);
	/** A card's tap: the same, starting at once with the remembered table, PERSON seats included (party.js, ?start=1). */
	const quickLink = (g) => soloLink(g) && `${soloLink(g)}&start=1`;
	/** PLAY SOMETHING's random pick: the remembered table's size, bots in every other seat (?start=pick; Lokesh, 2026-11-23: "Bots only for random picks"). */
	const pickLink = (g) => soloLink(g) && `${soloLink(g)}&start=pick`;
	/**
	 * A tap on a game (its card, its SINGLE PLAYER, Recently played): the
	 * game running at once against bots, with the remembered table (Lokesh,
	 * 2026-11-21: "directly take to the single-player game page … this
	 * prevents the delay the user has to face waiting for party creation").
	 * A one-device game starts at once too; a people-only game, which has no
	 * bots to start against, opens straight on its lobby with friends.
	 */
	const tapLink = (g) => quickLink(g) ?? linkOf(g, "friends");
	/** Move within the shell (src/main.tsx), or load the page outside it. */
	const go = (href) => (NeonArcade.navigate ? NeonArcade.navigate(href) : location.assign(href));
	/** The sub-tab showing: "mine" (My Games) or "all" (All Games). */
	let tab = "all";
	/**
	 * A genre's own page on All Games (Lokesh, 2026-11-21: "tapping on a game
	 * genre … should open a similar page with vertical scrollable with
	 * multiple columns"): a category section's id (GENRES), from
	 * `./?page=games&tab=all&genre=<id>`, or null for All Games itself.
	 */
	let genre = null;
	const genreOf = (t) => {
		const g = t === "all" ? new URLSearchParams(location.search).get("genre") : null;
		if (g === null) return null;
		if (GENRES.includes(g)) return g;
		dropGenre(); // an unknown id: All Games, and the address says so
		return null;
	};
	/** The address without its genre (in place: no history entry). */
	const dropGenre = () => {
		const u = new URL(location.href);
		if (!u.searchParams.has("genre")) return;
		u.searchParams.delete("genre");
		try {
			history.replaceState(history.state, "", u);
		} catch {}
	};
	/** Has genre `id` no game (More games, while every game has a category)? Asked once the catalogs are in. */
	const emptyGenre = (id) => {
		const games = NeonArcade.CATALOG ?? [];
		return !SECTIONS.find((x) => x.id === id).pick(games, new Map(games.map((g) => [g.id, g]))).length;
	};
	/** SEE ALL was the way here: "← All Games" is Back then, not a new entry. */
	let fromAll = false;
	/** A genre page's address: a real one, so a reload or a shared link opens it, and Back returns to All Games. */
	const genreLink = (id) => `./?${new URLSearchParams({ page: "games", tab: "all", genre: id })}`;
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
		c.dataset.tags = [...g.tags, ...(S()?.isFav(g.id) ? ["favs"] : [])].join(" ");
		// One tap (a click; Enter or Space on its title) starts the game
		// against bots (tapLink; Lokesh, 2026-11-21). Lokesh, 2026-11-18: on
		// a phone the first tap only showed the card's two buttons, so a game
		// took two. The title is the card's button
		// (.card-open, named by the game): what a keyboard and assistive tech
		// reach. The two buttons (SINGLE PLAYER, MULTI-PLAYER) are a mouse's
		// on hover and a keyboard's on focus; a touch screen long-presses for
		// them (is-open), and a tap off them closes them again. A row
		// scrolled sideways under the finger, or dragged with a mouse, is not
		// a tap: the click that may follow is dropped. A click with no
		// pointer behind it (detail 0: the keyboard, element.click(),
		// assistive tech) always counts.
		let down = null;
		c.addEventListener("pointerdown", (e) => (down = { x: e.clientX, y: e.clientY, at: c.parentElement?.scrollLeft ?? 0 }));
		c.addEventListener("pointercancel", () => (down = null)); // a scroll took the gesture
		c.addEventListener("click", (e) => {
			if (e.target.closest?.(".card-play")) return;
			const moved = e.detail !== 0 && !!down && (Math.abs(e.clientX - down.x) > 10 || Math.abs(e.clientY - down.y) > 10 || Math.abs((c.parentElement?.scrollLeft ?? 0) - down.at) > 2);
			down = null;
			if (moved) return;
			if (c.classList.contains("is-open")) {
				c.classList.remove("is-open");
				return settle(); // a row whose card just closed may have a redraw waiting
			}
			go(tapLink(g));
		});
		c.addEventListener("contextmenu", (e) => {
			if (!matchMedia("(hover: none)").matches || e.target.closest?.("a")) return;
			e.preventDefault(); // the long press is ours, not the image's menu
			for (const o of $$(".game-card.is-open")) if (o !== c) o.classList.remove("is-open");
			c.classList.add("is-open");
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
		const play = (label, href, cls) => {
			const a = el("a", `card-play ${cls}`, label);
			a.href = href;
			a.addEventListener("click", (e) => e.stopPropagation());
			return a;
		};
		const label = NeonArcade.playLabels(g);
		if (soloLink(g)) actions.append(play(label.solo, quickLink(g), "is-bots"));
		if (!g.local) actions.append(play(label.multi, linkOf(g, "friends"), "is-friends"));

		const by = g.community ? el("p", "game-by", `by ${g.author}`) : null;
		const plays = el("p", "game-plays");
		plays.hidden = true;
		const title = el("h3");
		const open = el("button", "card-open", g.title);
		open.type = "button";
		title.append(open);
		c.append(img, title, el("p", "game-desc", g.description), m, you, plays, ...(by ? [by] : []), actions);
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
				paintQuick();
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
	/** Most played first. A tie, or no counts at all (offline on a first visit), keeps the catalog's order: sort is stable. */
	const byPlays = (games) => [...games].sort((a, b) => (plays?.[b.id] ?? 0) - (plays?.[a.id] ?? 0));
	/** `tab`: the sub-tab a section is on (My Games: mine; All Games: all). */
	const SECTIONS = [
		{ id: "favs", tab: "mine", title: "★ Favourites", pick: (games, byId) => (S()?.favs() ?? []).map((id) => byId.get(id)).filter(Boolean) },
		{ id: "popular", tab: "all", title: "Popular", pick: (games) => byPlays(games).slice(0, POPULAR) },
		{ id: "arcade", tab: "all", title: "Arcade", pick: inCategory("arcade") },
		{ id: "party", tab: "all", title: "Party", pick: inCategory("party") },
		{ id: "strategy", tab: "all", title: "Strategy", pick: inCategory("strategy") },
		// Not only the puzzles: anything one person can start on their own.
		{ id: "solo", tab: "all", title: "Puzzle / Single player", pick: (games) => games.filter((g) => cats(g).includes("puzzle") || g.seats.min <= 1) },
		// A game none of the categories above take (its manifest and tags give
		// none) is still on the home screen, not only behind a search.
		{
			id: "other",
			tab: "all",
			title: "More games",
			pick: (games) => games.filter((g) => !SECTIONS.some((s) => !["favs", "popular", "other"].includes(s.id) && s.pick([g]).length)),
		},
	];

	/** The sections with a page of their own: the categories (not ★ Favourites or Popular). */
	const GENRES = SECTIONS.filter((s) => s.tab === "all" && s.id !== "popular").map((s) => s.id);
	/** Is section `sec` drawn now: its sub-tab's, and on a genre page only that genre. */
	const showing = (sec) => sec.tab === tab && (!genre || sec.id === genre);

	// ------------------------------------------------------------ quick play

	/**
	 * PLAY SOMETHING (approved 2026-11-15): one tap into a popular game in
	 * single player, the card's own SINGLE PLAYER address, so it plays offline
	 * after one visit like the card — plus `start=pick`: the game's remembered
	 * table's size (or its smallest), every other seat a bot (2026-11-23), never
	 * the table screen, so it stays one tap.
	 * The pool is the QUICK most played games one person can play now: with bots, or one-device and playable alone —
	 * never people-only, and never a Python game (Pyodide is ~13 MB). The pick
	 * varies: at random each visit, never the one the last visit offered.
	 */
	const QUICK = 5;
	const QUICK_LAST = "neon.quick";
	const alone = (g) => g.bots || (g.local && (g.players?.min ?? g.seats.min) <= 1);
	const quickPool = (games = NeonArcade.CATALOG ?? []) => byPlays(games.filter((g) => alone(g) && g.runtime !== "python")).slice(0, QUICK);
	/**
	 * This visit's pick (an id). Chosen once per visit and kept, even when
	 * late play counts reorder the pool: it never changes under a finger.
	 */
	let quick = null;
	/** Has this visit's pick been on screen (and so saved as the last one)? */
	let quickShown = false;
	function quickPick() {
		const kept = quick && (NeonArcade.CATALOG ?? []).find((g) => g.id === quick);
		if (kept) return kept;
		const pool = quickPool();
		let last = null;
		try {
			last = localStorage.getItem(QUICK_LAST);
		} catch {}
		const fresh = pool.length > 1 ? pool.filter((g) => g.id !== last) : pool;
		const g = fresh[Math.floor(Math.random() * fresh.length)] ?? null;
		quick = g?.id ?? null;
		return g;
	}
	/**
	 * Point every PLAY SOMETHING ([data-quick]) at this visit's pick: Popular's
	 * heading and My Games' (Recently played's, else ★ Favourites'), and the
	 * empty state. The pick is saved as the last one once it is on screen, so
	 * the next visit offers another.
	 */
	function paintQuick() {
		const g = quickPick();
		const recent = !$("[data-recent]")?.hidden;
		for (const a of $$("[data-quick]")) {
			a.hidden = !g || (recent && !!a.closest('[data-section="favs"]'));
			if (!g) continue;
			a.href = pickLink(g);
			a.dataset.game = g.id;
			a.title = `${g.title}, single player`;
		}
		if (g && !quickShown && $$("[data-quick]").some((a) => a.getClientRects().length)) {
			quickShown = true;
			try {
				localStorage.setItem(QUICK_LAST, g.id);
			} catch {}
		}
	}

	/**
	 * Is someone using this row of cards: a finger (or button) down on it,
	 * one long-pressed open, or hovered with a mouse, or reached by
	 * keyboard? (A tap focuses a card too, and keeps it focused; that is no
	 * reason to hold the row back once the finger is up.)
	 */
	const inUse = (row) => row.dataset.pressed === "1" || !!row.querySelector(".game-card.is-open, :focus-visible") || (matchMedia("(hover: hover)").matches && row.matches(":hover"));

	/** Redraw the rows held back while in use (drawSection) that nobody is using now. */
	const settle = () =>
		setTimeout(() => {
			for (const row of $$(".section-row[data-pending]")) if (!inUse(row)) drawSection(row.closest("[data-section]").dataset.section, row.dataset.pending === "force");
		});

	/** A section's empty frame: a heading, its row of cards (and, for favourites, the people and repos starred; for Popular, PLAY SOMETHING). */
	function shell({ id, title }) {
		const n = el("section", "portal-section");
		n.dataset.section = id;
		n.hidden = true;
		const heading = el("h2", "section-title", title);
		heading.id = `section-${id}`;
		if (id === "popular" || id === "favs") {
			const head = el("div", "section-head");
			const q = el("a", "quick-play-btn", "PLAY SOMETHING");
			q.dataset.quick = "";
			head.append(heading, q);
			n.append(head);
		} else {
			// A genre: SEE ALL opens its page (genreLink), hidden on that page.
			const head = el("div", "section-head");
			const all = el("a", "see-all", "SEE ALL");
			all.href = genreLink(id);
			all.dataset.seeAll = id;
			all.setAttribute("aria-label", `See all ${title} games`);
			head.append(heading, all);
			n.append(head);
		}
		const row = el("div", "section-row");
		row.setAttribute("aria-labelledby", heading.id);
		// Held while pressed: a redraw under a finger would slide another game
		// beneath it. Released wherever the press ends, in the row or not (a
		// mouse let go outside it).
		row.addEventListener("pointerdown", () => {
			row.dataset.pressed = "1";
			const up = () => {
				removeEventListener("pointerup", up, true);
				removeEventListener("pointercancel", up, true);
				delete row.dataset.pressed;
				settle();
			};
			addEventListener("pointerup", up, true);
			addEventListener("pointercancel", up, true);
		});
		for (const type of ["click", "pointerleave", "focusout"]) row.addEventListener(type, settle);
		n.append(row);
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
		// Another sub-tab's section (or genre's): drawn when it shows, not before.
		const list = showing(sec) ? sec.pick(games, new Map(games.map((g) => [g.id, g]))) : [];
		const row = node.querySelector(".section-row");
		// My Games and a genre page: a grid that scrolls down, several
		// columns (two on a phone); All Games' sections stay rows (Lokesh,
		// 2026-11-21).
		row.classList.toggle("is-grid", tab === "mine" || !!genre);
		const all = node.querySelector("[data-see-all]");
		if (all) all.hidden = !!genre;
		const ids = list.map((g) => g.id).join(" ");
		if (force || row.dataset.ids !== ids) {
			// Someone is using this row (a card tapped open, hovered or
			// focused): replacing it would close that card, or slide another
			// under their finger — the play counts arrive late on a slow phone.
			// Redrawn when they leave it (shell: the row's listeners).
			// (Never a section of the other sub-tab: nobody can be using it.)
			if (showing(sec) && row.childElementCount && inUse(row)) row.dataset.pending = force || row.dataset.pending === "force" ? "force" : "1";
			else {
				const x = row.scrollLeft; // where they had scrolled it to
				unwatch(row);
				row.replaceChildren(...list.map(card));
				row.dataset.ids = ids;
				delete row.dataset.pending;
				row.scrollLeft = x;
				paintCounts();
			}
		}
		row.hidden = !list.length;
		let others = 0;
		const more = node.querySelector(".fav-more");
		if (more) {
			// Starred on Contributors and Collections: each opens its games (All Games, searched).
			const favs = sec.tab === tab ? (S()?.favs() ?? []).map((f) => f.match(OTHER_FAV)).filter(Boolean) : [];
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
		const ids = tab === "mine" ? (S()?.recent() ?? []).filter((id) => byId.has(id)).slice(0, 6) : [];
		row.hidden = !ids.length;
		const list = row.querySelector(".recent-list");
		list.replaceChildren(
			...ids.map((id) => {
				const a = el("a", "recent-game", byId.get(id).title);
				a.href = tapLink(byId.get(id));
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
		// A space after the colon is the same field (a phone's keyboard puts
		// one there: "type: duel" found nothing, 2026-11-21); a field still
		// waiting for its value ("author:") narrows nothing yet.
		for (const m of String(q ?? "").matchAll(/(\w+):\s*"([^"]*)"|(\w+):\s*([^\s"]+)|(\w+):\s*$|"([^"]*)"|(\S+)/g)) {
			const [, k1, v1, k2, v2, , quoted, word] = m;
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

	/** My Games with nothing in it: how to star, PLAY SOMETHING and All Games. */
	function paintEmpty() {
		const empty = $("[data-my-empty]");
		if (!empty) return;
		empty.hidden = tab !== "mine" || !!$("[data-recent] .recent-game") || !$$('[data-section="favs"]').every((n) => n.hidden);
	}

	let query = "";
	/** All Games' sections, or — while a search is typed — one grid of what matches it. */
	function applySearch() {
		const grid = $(".games-grid");
		if (!grid) return;
		const games = NeonArcade.CATALOG ?? [];
		const terms = tab === "all" && !genre ? parseQuery(query) : [];
		const searching = terms.length > 0;
		const box = $(".search");
		if (box) box.hidden = tab !== "all" || !!genre;
		// A genre page: its title's way back to All Games (Back does the same).
		const back = $("[data-genre-back]");
		if (back) back.hidden = !genre;
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
		// A row held back (in use) keeps its cards: watch their videos again.
		for (const v of $$(".section-row[data-pending] video")) {
			near?.observe(v);
			seen?.observe(v);
		}
		grid.replaceChildren(); // the search's cards: made again when wanted
		recentRow(new Map(games.map((g) => [g.id, g])));
		applySearch();
		paintEmpty();
		paintQuick();
	}

	/** Mark the view with the genre page showing (lib/portal.js CSS hooks: the heading, the grid). */
	function setGenre() {
		if (genre) root.dataset.genre = genre;
		else delete root.dataset.genre;
		// Arrived by SEE ALL: the entry remembers it (a reload keeps it), so
		// "← All Games" goes Back to the entry before rather than adding one.
		if (genre && fromAll) {
			fromAll = false;
			try {
				history.replaceState({ ...(history.state ?? {}), genreFrom: "all" }, "");
			} catch {}
		}
	}
	/**
	 * A genre with no game (More games, while every game has a category) is
	 * a blank page: All Games instead, its address fixed. Only once the
	 * community games are in, which may fill it.
	 */
	function checkGenre() {
		Promise.resolve(NeonArcade.catalogs).then(() => {
			if (!root || !genre || !emptyGenre(genre)) return;
			genre = null;
			dropGenre();
			setGenre();
			draw();
		});
	}

	/** A star changed (inside a game, on Contributors or Collections, from the account): My Games. */
	function favsChanged() {
		const favs = new Set(S()?.favs() ?? []);
		const byId = new Map((NeonArcade.CATALOG ?? []).map((g) => [g.id, g]));
		for (const c of $$(".game-card")) {
			const g = byId.get(c.dataset.game);
			if (!g) continue;
			const fav = favs.has(g.id);
			c.dataset.tags = [...g.tags, ...(fav ? ["favs"] : [])].join(" ");
		}
		drawSection("favs");
		paintEmpty();
	}

	/** Show sub-tab `t` ("mine" | "all"), the search and the genre page taken from the address. */
	function show(t) {
		const next = t === "mine" ? "mine" : "all";
		query = next === "all" ? (new URLSearchParams(location.search).get("q") ?? "") : "";
		const box = $("[data-search]");
		if (box && box.value !== query) box.value = query;
		const g = genreOf(next);
		if (next === tab && root?.dataset.tab === next && g === genre) return applySearch();
		genre = g;
		if (root) setGenre();
		checkGenre();
		// A card left open on the sub-tab being left would hold its row back
		// (inUse) when that sub-tab shows again: close them all first.
		for (const c of $$(".game-card.is-open")) c.classList.remove("is-open");
		tab = next;
		if (root) root.dataset.tab = tab;
		draw();
	}

	/**
	 * Draw the portal into `r` (src/views/Portal.tsx: the search,
	 * [data-recent], [data-sections], .games-grid) and keep it current.
	 * Returns the cleanup: the view mounts and unmounts many times in one page.
	 */
	function mount(r, t = new URLSearchParams(location.search).get("tab")) {
		root = r;
		tab = t === "mine" ? "mine" : "all";
		r.dataset.tab = tab;
		genre = genreOf(tab);
		setGenre();
		checkGenre();
		query = tab === "all" ? (new URLSearchParams(location.search).get("q") ?? "") : "";
		quick = null; // a new pick each visit
		quickShown = false;
		plays ??= readPlays();
		const off = [];
		const on = (target, type, fn, capture = false) => {
			target.addEventListener(type, fn, capture);
			off.push(() => target.removeEventListener(type, fn, capture));
		};
		// SEE ALL, and "← All Games" as Back when SEE ALL led here. On the
		// window, capturing: before the router's own handler (src/router.ts,
		// document, capturing) turns the link into a new entry.
		on(
			window,
			"click",
			(e) => {
				if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
				if (e.target.closest?.("[data-see-all]") && root?.contains(e.target)) fromAll = true;
				else if (e.target.closest?.("[data-genre-back]") && root?.contains(e.target) && history.state?.genreFrom === "all") {
					e.preventDefault();
					e.stopPropagation();
					history.back();
				}
			},
			true,
		);
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
		// A starred contributor or collection: its games, as a search on All Games.
		on(r, "click", (e) => {
			const b = e.target.closest?.(".fav-more-item");
			if (b) go(`./?${new URLSearchParams({ page: "games", tab: "all", q: b.dataset.q })}`);
		});
		draw();
		loadCounts();
		off.push(NeonArcade.account?.onChange(draw) ?? (() => {}));
		// A star changed (My Games only: All Games' rows keep
		// their place), or a game played: redraw.
		off.push(S()?.onChange((what) => (what === "favs" ? favsChanged() : draw())) ?? (() => {}));
		on(window, "storage", (e) => e.key?.startsWith("neon.") && e.key !== PLAYS && e.key !== QUICK_LAST && draw());
		on(window, "pageshow", (e) => e.persisted && draw());
		return () => {
			for (const f of off) f();
			near?.disconnect();
			seen?.disconnect();
			if (root === r) root = null;
		};
	}

	NeonArcade.portal = { mount, draw, show, linkOf, soloLink, tapLink, genreLink, GENRES, meta, parseQuery, matches, quickPool, quickPick };
})();
