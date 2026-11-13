// lib/leaderboard.js — leaderboard.html: one game's board, for everyone, your
// friends, or one of your groups (worker/api/lb.js).
//
//   leaderboard.html?game=<id>&scope=global|friends|group:<id>
//
// Only games between people who are signed in count (docs/accounts.md). When
// the server cannot be reached, the global board comes from the last public
// snapshot on GitHub, and says so.
//
// The top three stand on a podium; everyone after is a row. Signed in, the
// board also says where you stand (`lb.me`, even below the rows shown), in a
// bar kept at the bottom of the screen while your own row is not on it.

window.NeonArcade = window.NeonArcade || {};

(() => {
	const A = () => NeonArcade.account;
	const el = (tag, cls, text) => {
		const n = document.createElement(tag);
		if (cls) n.className = cls;
		if (text != null) n.textContent = text;
		return n;
	};
	const q = new URLSearchParams(location.search);
	// One-phone games have nobody to rank.
	const games = () => (NeonArcade.CATALOG ?? []).filter((g) => !g.local);
	let game = q.get("game");
	let scope = q.get("scope") ?? "global";
	let groups = [];
	let asked = 0; // the latest board asked for; older answers are dropped
	let watch = null; // the IntersectionObserver on your own row

	// What a kind of game is ranked by, and how a row says it.
	const BY = { duel: "Rating", coop: "Best score", ffa: "Wins", teams: "Wins" };
	const by = (kind) => BY[kind] ?? "Wins";
	const value = (kind, r) => String(kind === "duel" ? r.elo : kind === "coop" ? (r.best ?? "–") : r.wins);
	function detail(kind, r) {
		const n = `${r.games} ${r.games === 1 ? "game" : "games"}`;
		if (kind === "coop" || !r.games) return n;
		return `${n} · ${Math.round((100 * r.wins) / r.games)}% won`;
	}

	function remember() {
		const p = new URLSearchParams(location.search);
		p.set("game", game);
		p.set("scope", scope);
		history.replaceState(null, "", `${location.pathname}?${p}`);
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

	const profile = (r) => `profile.html?u=${encodeURIComponent(r.id)}`;
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

	/** The bar at the bottom: your row, or why you do not have one. */
	function you(kind, lb, meta) {
		const box = document.querySelector("[data-you]");
		watch?.disconnect();
		box.replaceChildren();
		box.dataset.away = "false";
		const signedIn = !!A()?.me;
		if (!signedIn) {
			if (lb.fromSnapshot) return;
			const ask = el("div", "entry ask");
			const who = el("span", "who");
			who.append(el("div", "name", "Where do you rank?"), el("div", "sub", "Sign in, then play people who are signed in too."));
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
			box.append(entry(kind, r, { rank: "–", sub: `No ranked ${meta ? `${meta.title} games` : "games"} yet`, score: "" }));
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
		const mine = document.querySelector(`[data-board] [data-player="${CSS.escape(me.id)}"]`);
		if (!mine) {
			box.dataset.away = "true";
			return;
		}
		// Show the bar only while your own row is off screen (or under the bar).
		watch = new IntersectionObserver(([e]) => (box.dataset.away = String(!e.isIntersecting)), { rootMargin: "0px 0px -96px 0px" });
		watch.observe(mine);
	}

	function scopes() {
		const box = document.querySelector("[data-scopes]");
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
		const box = document.querySelector("[data-games]");
		box.replaceChildren(
			...games().map((g) => {
				const b = el("button", "pick");
				b.type = "button";
				b.dataset.game = g.id;
				b.setAttribute("aria-pressed", String(g.id === game));
				b.append(el("b", null, g.title), el("small", null, by(g.kind)));
				b.onclick = () => {
					if (g.id === game) return;
					game = g.id;
					remember();
					picks();
					board();
				};
				return b;
			}),
		);
		box.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: "nearest", inline: "center" });
	}

	async function board() {
		const holder = document.querySelector("[data-board]");
		const note = document.querySelector("[data-note]");
		const mine = ++asked;
		holder.replaceChildren(ghost());
		note.textContent = "";
		watch?.disconnect();
		document.querySelector("[data-you]").replaceChildren();
		const meta = games().find((g) => g.id === game);
		try {
			const lb = await A().leaderboard(game, scope);
			if (mine !== asked) return;
			const kind = lb.kind ?? meta?.kind;
			if (lb.fromSnapshot) note.textContent = "Offline: this is the last hourly snapshot.";
			else if (scope === "global") note.textContent = `Signed-in players with at least ${lb.min ?? 5} ranked games. Games against bots do not count.`;
			else if (scope === "friends") note.textContent = "You and your friends.";
			else note.textContent = `Only games played among "${lb.group?.name ?? "the group"}".`;
			if (!lb.rows.length) {
				const empty = el("div", "empty");
				empty.append(el("p", "muted", "Nobody here yet. Ranked games are ones where at least two players are signed in."));
				if (meta) {
					const go = el("a", "neon-btn", "PLAY WITH FRIENDS");
					go.href = `party.html?${new URLSearchParams({ game: meta.id, fresh: "1", mode: "friends" })}`;
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
		scopes();
		remember();
		board();
	}

	document.addEventListener("DOMContentLoaded", start);
})();
