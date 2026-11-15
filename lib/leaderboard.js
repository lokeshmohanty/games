// lib/leaderboard.js — the leaderboard view: one game's board, for everyone,
// your friends, or one of your groups (worker/api/lb.js).
//
//   ./?page=leaderboard&game=<id>&scope=global|friends|group:<id>[&vs=bots]
//
// src/views/Leaderboard.tsx renders the markup and calls
// NeonArcade.leaderboard.mount(root), which returns the cleanup: the view
// mounts and unmounts as people move around the one page (docs/spa.md).
//
// Only games between people who are signed in count (docs/accounts.md). When
// the server cannot be reached, the global board comes from the last public
// snapshot on GitHub, and says so.
//
// The top three stand on a podium; everyone after is a row. Signed in, the
// board also says where you stand (`lb.me`, even below the rows shown), in a
// bar kept at the bottom of the screen while your own row is not on it.
//
// A game with bots also has a board of wins against bots (worker/api/bots.js),
// behind its own switch — Ranked · Against bots — under the games, and never
// mixed into the ranked board: it can be farmed, and its numbers mean
// nothing next to a rating.

window.NeonArcade = window.NeonArcade || {};

(() => {
	const A = () => NeonArcade.account;
	const el = (tag, cls, text) => {
		const n = document.createElement(tag);
		if (cls) n.className = cls;
		if (text != null) n.textContent = text;
		return n;
	};
	// One-phone games have nobody to rank.
	const games = () => (NeonArcade.CATALOG ?? []).filter((g) => !g.local);

	// What a kind of game is ranked by, and how a row says it. "time": a game
	// whose solo runs are timed (Sudoku), best = lowest, in seconds (worker/api/lb.js).
	const BY = { duel: "Rating", coop: "Best score", time: "Best time", ffa: "Wins", teams: "Wins", bots: "Wins vs bots" };
	const by = (kind) => BY[kind] ?? "Wins";
	// The board's score unit, when it has one (lb.unit: Light Cycles alone, "s").
	let unit = null;
	const day = (t) => new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
	const clock = (secs) => {
		const s = Math.round(secs);
		return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
	};
	const value = (kind, r) =>
		String(
			kind === "duel" ? r.elo
			: kind === "coop" ? (r.best == null ? "–" : unit ? `${r.best} ${unit}` : r.best)
			: kind === "time" ? (r.best == null ? "–" : clock(r.best))
			: r.wins,
		);
	function detail(kind, r) {
		// Wins against bots: a tie goes to whoever got there first, so say when.
		if (kind === "bots") return r.at ? `reached ${day(r.at)}` : "";
		const n = `${r.games} ${r.games === 1 ? "game" : "games"}`;
		if (kind === "coop" || kind === "time" || !r.games) return n;
		return `${n} · ${Math.round((100 * r.wins) / r.games)}% won`;
	}

	/** An avatar, over initials in a colour that is always the same for this player. */
	function face(r) {
		const box = el("span", "face");
		const words = (r.name ?? "?").trim().split(/\s+/);
		box.textContent = (words[0][0] + (words.length > 1 ? words.at(-1)[0] : "")).toUpperCase();
		let h = 0;
		for (const c of String(r.id ?? r.name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
		box.style.setProperty("--face", `var(--p${1 + (h % 8)})`);
		if (r.avatar) {
			const img = el("img");
			img.alt = "";
			img.loading = "lazy";
			img.referrerPolicy = "no-referrer";
			img.src = r.avatar;
			img.onerror = () => img.remove();
			box.append(img);
		}
		return box;
	}

	const profile = (r) => `./?page=profile&u=${encodeURIComponent(r.id)}`;
	const isMe = (r) => !!A()?.me && r.id === A().me.id;

	function spot(kind, r) {
		const a = el("a", isMe(r) ? "spot me" : "spot");
		a.href = profile(r);
		a.dataset.player = r.id;
		a.append(face(r), el("span", "name", r.name), el("span", "score", value(kind, r)), el("span", "sub", detail(kind, r)), el("span", "plinth", String(r.rank)));
		a.setAttribute("aria-label", `${r.rank}. ${r.name}, ${by(kind).toLowerCase()} ${value(kind, r)}, ${detail(kind, r)}`);
		return a;
	}

	function entry(kind, r, { rank = String(r.rank), sub = detail(kind, r), score = value(kind, r) } = {}) {
		const a = el("a", isMe(r) ? "entry me" : "entry");
		a.href = profile(r);
		a.dataset.player = r.id;
		const who = el("span", "who");
		const name = el("div", "name", r.name);
		if (isMe(r)) name.append(el("span", "tag", "YOU"));
		who.append(name, el("div", "sub", sub));
		a.append(el("span", "rank", rank), face(r), who, el("span", "score", score));
		return a;
	}

	function ghost() {
		const box = el("div", "ghost");
		box.setAttribute("aria-label", "Loading");
		const rows = el("ol", "rows");
		for (let i = 0; i < 6; i++) {
			const e = el("div", "entry");
			const who = el("span", "who");
			const bar = (w) => Object.assign(el("div", "bar"), { style: `width:${w}` });
			who.append(bar(`${55 - i * 4}%`), bar("35%"));
			e.append(bar("1.4rem"), el("span", "face"), who, bar("2.5rem"));
			const li = el("li");
			li.append(e);
			rows.append(li);
		}
		box.append(rows);
		return box;
	}

	/** Draw the board into `root` (the view's <main>); returns the cleanup. */
	function mount(root) {
		const $ = (sel) => root.querySelector(sel);
		const q = new URLSearchParams(location.search);
		let game = q.get("game");
		let scope = q.get("scope") ?? "global";
		// A game whose solo runs rank per difficulty (Sudoku: lb.levels) has a
		// board per level, `<game>@<level>`, beside its own (races).
		let level = q.get("level") || null;
		// "bots": the game's board of wins against bots instead of its ranked one.
		let vs = q.get("vs") === "bots" ? "bots" : null;
		let groups = [];
		let asked = 0; // the latest board asked for; older answers are dropped
		let watch = null; // the IntersectionObserver on your own row
		let gone = false; // unmounted: late answers touch nothing

		// The choice, in the address (the shell's: `page=leaderboard` stays).
		function remember() {
			if (gone) return;
			const p = new URLSearchParams(location.search);
			p.set("game", game);
			p.set("scope", scope);
			if (level) p.set("level", level);
			else p.delete("level");
			if (vs) p.set("vs", vs);
			else p.delete("vs");
			history.replaceState(null, "", `${location.pathname}?${p}`);
		}

		/** The bar at the bottom: your row, or why you do not have one. */
		function you(kind, lb, meta) {
			const box = $("[data-you]");
			watch?.disconnect();
			box.replaceChildren();
			box.dataset.away = "false";
			const signedIn = !!A()?.me;
			if (!signedIn) {
				if (lb.fromSnapshot) return;
				const ask = el("div", "entry ask");
				const who = el("span", "who");
				const how = kind === "bots" ? "Sign in, then beat the bots with nobody else in the game." : "Sign in, then play people who are signed in too.";
				who.append(el("div", "name", "Where do you rank?"), el("div", "sub", how));
				const b = el("button", "neon-btn", "SIGN IN");
				b.type = "button";
				b.onclick = () => NeonArcade.accountUi?.signInChooser();
				ask.append(who, b);
				box.append(ask);
				box.dataset.away = "true";
				return;
			}
			const me = lb.me ?? null;
			if (!me) {
				if (!("me" in lb)) return; // an offline snapshot: we do not know
				const r = { ...A().me, games: 0, wins: 0 };
				const none = kind === "bots" ? `No wins against bots${meta ? ` in ${meta.title}` : ""} yet` : `No ranked ${meta ? `${meta.title} games` : "games"} yet`;
				box.append(entry(kind, r, { rank: "–", sub: none, score: "" }));
				box.dataset.away = "true";
				return;
			}
			if (me.rank == null) {
				const sub = me.hidden ? "Hidden from public boards (your profile)" : `${me.need} more ranked ${me.need === 1 ? "game" : "games"} to get a rank`;
				box.append(entry(kind, me, { rank: "–", sub }));
				box.dataset.away = "true";
				return;
			}
			box.append(entry(kind, me, { rank: `#${me.rank}` }));
			const mine = $(`[data-board] [data-player="${CSS.escape(me.id)}"]`);
			if (!mine) {
				box.dataset.away = "true";
				return;
			}
			// Show the bar only while your own row is off screen (or under the bar,
			// which sits higher over the shell's BACK TO GAME pill: leaderboard.css).
			const under = document.querySelector(".back-to-game") ? 160 : 96;
			watch = new IntersectionObserver(([e]) => (box.dataset.away = String(!e.isIntersecting)), { rootMargin: `0px 0px -${under}px 0px` });
			watch.observe(mine);
		}

		function scopes() {
			const box = $("[data-scopes]");
			const list = [["global", "Everyone"]];
			if (A()?.me) {
				list.push(["friends", "Friends"]);
				for (const g of groups) list.push([`group:${g.id}`, g.name]);
			}
			if (!list.some(([k]) => k === scope)) scope = "global";
			box.replaceChildren(
				...list.map(([key, label]) => {
					const b = el("button", "scope", label);
					b.type = "button";
					b.dataset.scope = key;
					b.setAttribute("aria-pressed", String(key === scope));
					b.onclick = () => {
						scope = key;
						remember();
						scopes();
						board();
					};
					return b;
				}),
			);
		}

		function picks() {
			const box = $("[data-games]");
			box.replaceChildren(
				...games().map((g) => {
					const b = el("button", "pick");
					b.type = "button";
					b.dataset.game = g.id;
					b.setAttribute("aria-pressed", String(g.id === game));
					// What the board showing ranks by: the bots board's, while it is up.
					b.append(el("b", null, g.title), el("small", null, by(vs && g.id === game ? "bots" : g.kind)));
					b.onclick = () => {
						if (g.id === game) return;
						game = g.id;
						level = null;
						vs = null;
						remember();
						picks();
						board();
					};
					return b;
				}),
			);
			box.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: "nearest", inline: "center" });
		}

		/**
		 * Ranked · Against bots, under the games: only for a game with a board of
		 * wins against bots (lb.botsBoard), or while that board is showing.
		 */
		function versus(has) {
			const box = $("[data-vs]");
			box.hidden = !has && !vs;
			if (box.hidden) return box.replaceChildren();
			box.replaceChildren(
				...[[null, "Ranked"], ["bots", "Against bots"]].map(([key, label]) => {
					const b = el("button", "scope", label);
					b.type = "button";
					b.dataset.against = key ?? "";
					b.setAttribute("aria-pressed", String(key === vs));
					b.onclick = () => {
						if (key === vs) return;
						vs = key;
						level = null;
						remember();
						picks();
						board();
					};
					return b;
				}),
			);
		}

		/** The difficulty strip, under the scopes: only for a game with levels. */
		function levels(list) {
			let box = $("[data-levels]");
			if (!box) {
				box = el("div", "strip");
				box.dataset.levels = "";
				box.setAttribute("role", "group");
				box.setAttribute("aria-label", "Board");
				$("[data-scopes]").after(box);
			}
			box.hidden = !list?.length;
			if (!list?.length) return box.replaceChildren();
			const cap = (w) => w[0].toUpperCase() + w.slice(1);
			box.replaceChildren(
				...[[null, "Races"], ...list.map((l) => [l, cap(l)])].map(([key, label]) => {
					const b = el("button", "scope", label);
					b.type = "button";
					b.dataset.level = key ?? "";
					b.setAttribute("aria-pressed", String(key === level));
					b.onclick = () => {
						level = key;
						remember();
						board();
					};
					return b;
				}),
			);
		}

		async function board() {
			const holder = $("[data-board]");
			const note = $("[data-note]");
			const mine = ++asked;
			holder.replaceChildren(ghost());
			note.textContent = "";
			watch?.disconnect();
			$("[data-you]").replaceChildren();
			const meta = games().find((g) => g.id === game);
			try {
				const lb = vs ? await A().leaderboard(game, scope, vs) : await A().leaderboard(level ? `${game}@${level}` : game, scope);
				if (mine !== asked) return;
				if (level && !lb.levels?.includes(level)) level = null;
				versus(!!lb.botsBoard);
				levels(vs ? null : lb.levels);
				const kind = lb.kind ?? meta?.kind;
				unit = lb.unit ?? null;
				if (lb.fromSnapshot) note.textContent = "Offline: this is the last hourly snapshot.";
				else if (vs) note.textContent = `Wins against bots: games where you were the only person, signed in and online as they start. Kept apart from the ranked boards — up to ${lb.perDay ?? 20} a day in each game count.`;
				else if (level && kind === "time") note.textContent = `Fastest ${level} puzzles solved alone, signed in and online as they start.`;
				else if (level) note.textContent = "Best rounds played alone, signed in and online as they start.";
				else if (scope === "global") note.textContent = `Signed-in players with at least ${lb.min ?? 5} ranked games. Games against bots do not count; a game played alone counts when you are signed in and online as it starts.`;
				else if (scope === "friends") note.textContent = "You and your friends.";
				else note.textContent = `Only games played among "${lb.group?.name ?? "the group"}".`;
				if (!lb.rows.length) {
					const empty = el("div", "empty");
					empty.append(
						el(
							"p",
							"muted",
							vs
								? "Nobody here yet. Sign in, play against bots with nobody else in the game, and win."
								: "Nobody here yet. A game is ranked when at least two of its players are signed in — or, for a game played alone, when you are.",
						),
					);
					if (meta) {
						const go = el("a", "neon-btn", vs ? NeonArcade.playLabels(meta).solo : NeonArcade.playLabels(meta).multi);
						go.href = `./?${new URLSearchParams({ game: meta.id, fresh: "1", mode: vs ? "bots" : "friends" })}`;
						empty.append(go);
					}
					holder.replaceChildren(empty);
					you(kind, lb, meta);
					return;
				}
				const top = el("ol", "podium");
				for (const r of lb.rows.slice(0, 3)) {
					const li = el("li");
					li.append(spot(kind, r));
					top.append(li);
				}
				const out = [top];
				const rest = lb.rows.slice(3);
				if (rest.length) {
					const head = el("div", "head");
					head.append(el("span", null, "Player"), el("span", null, by(kind)));
					const rows = el("ol", "rows");
					rows.start = 4;
					for (const r of rest) {
						const li = el("li");
						li.append(entry(kind, r));
						rows.append(li);
					}
					out.push(head, rows);
				}
				holder.replaceChildren(...out);
				you(kind, lb, meta);
			} catch (err) {
				if (mine !== asked) return;
				// A ?vs=bots link for a game without that board: its ranked board.
				if (vs && err.status === 400) {
					vs = null;
					remember();
					picks();
					return board();
				}
				holder.replaceChildren(el("p", "muted empty", err.status === 401 ? "Sign in to see this board." : `Could not load the board (${err.message}).`));
			}
		}

		async function start() {
			const list = games();
			if (!list.some((g) => g.id === game)) game = list[0]?.id;
			picks();
			if (A()?.signedIn()) {
				await A().load();
				if (A().me) groups = (await A().api("/api/groups").catch(() => ({ groups: [] }))).groups;
			}
			if (gone) return;
			scopes();
			remember();
			board();
		}

		start();
		return () => {
			gone = true;
			asked++;
			watch?.disconnect();
		};
	}

	NeonArcade.leaderboard = { mount };
})();
