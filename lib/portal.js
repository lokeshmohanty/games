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
	const linkOf = (g) => `party.html?${new URLSearchParams({ game: g.id, fresh: "1" })}`;
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
		c.addEventListener("click", () => (location.href = linkOf(g)));

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

		const play = el("a", "play-btn", "PLAY NOW");
		play.href = linkOf(g);
		play.addEventListener("click", (e) => e.stopPropagation());

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
		c.append(img, fb, star, el("h3", null, g.title), el("p", "game-desc", g.description), m, you, plays, ...(by ? [by] : []), play);
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

	/** LEADERBOARDS, and SIGN IN or who you are. */
	function accountBar() {
		const bar = document.querySelector("[data-account]");
		const A = NeonArcade.account;
		if (!bar || !A) return;
		const lb = el("a", null, "Leaderboards");
		lb.href = "leaderboard.html";
		const parts = [lb];
		if (A.me) {
			const me = el("a", "acct-me");
			me.href = "profile.html";
			if (A.me.avatar) {
				const img = el("img");
				img.src = A.me.avatar;
				img.alt = "";
				img.referrerPolicy = "no-referrer";
				me.append(img);
			}
			me.append(A.me.name);
			parts.push(me);
		} else if (A.signedIn()) {
			const me = el("a", "acct-me", "Profile");
			me.href = "profile.html";
			parts.push(me);
		} else {
			const sign = el("button", null, "Sign in");
			sign.type = "button";
			sign.onclick = () => NeonArcade.accountUi?.signInChooser();
			parts.push(sign);
		}
		bar.replaceChildren(...parts);
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

	let want = "all";
	function applyFilter() {
		const cards = [...document.querySelectorAll(".games-grid .game-card")];
		let shown = 0;
		for (const c of cards) {
			const match = want === "all" || (c.dataset.tags || "").split(/\s+/).includes(want);
			c.hidden = !match;
			if (match) shown++;
		}
		for (const chip of document.querySelectorAll(".filter")) {
			chip.setAttribute("aria-pressed", String(chip.dataset.filter === want));
		}
		const empty = document.querySelector(".filter-empty");
		if (empty) {
			empty.textContent = want === "favs" ? "No favourites yet — tap ☆ on a game." : "Nothing matches that yet.";
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
		accountBar();
	}

	NeonArcade.portal = { draw, linkOf, meta };

	document.addEventListener("DOMContentLoaded", () => {
		for (const chip of document.querySelectorAll(".filter")) {
			chip.addEventListener("click", () => {
				want = chip.dataset.filter;
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
