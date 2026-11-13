// lib/leaderboard.js — leaderboard.html: one game's board, for everyone, your
// friends, or one of your groups (worker/api/lb.js).
//
//   leaderboard.html?game=<id>&scope=global|friends|group:<id>
//
// Only games between people who are signed in count (docs/accounts.md). When
// the server cannot be reached, the global board comes from the last public
// snapshot on GitHub, and says so.

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

	function remember() {
		const p = new URLSearchParams(location.search);
		p.set("game", game);
		p.set("scope", scope);
		history.replaceState(null, "", `${location.pathname}?${p}`);
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

	async function board() {
		const holder = document.querySelector("[data-board]");
		const note = document.querySelector("[data-note]");
		holder.replaceChildren(el("p", "muted", "Loading…"));
		note.textContent = "";
		const meta = games().find((g) => g.id === game);
		try {
			const lb = await A().leaderboard(game, scope);
			const kind = lb.kind ?? meta?.kind;
			if (lb.fromSnapshot) note.textContent = "Offline: this is the last hourly snapshot.";
			else if (scope === "global") note.textContent = `Signed-in players with at least ${lb.min ?? 5} ranked games. Games against bots do not count.`;
			else if (scope === "friends") note.textContent = "You and your friends.";
			else note.textContent = `Only games played among "${lb.group?.name ?? "the group"}".`;
			if (!lb.rows.length) {
				holder.replaceChildren(el("p", "muted", "Nobody here yet. Ranked games are ones where at least two players are signed in."));
				return;
			}
			const t = el("table");
			const col = kind === "duel" ? "Rating" : kind === "coop" ? "Best" : "Won";
			t.innerHTML = `<thead><tr><th>#</th><th>Player</th><th class="n">${col}</th><th class="n">Games</th></tr></thead>`;
			const tb = el("tbody");
			for (const r of lb.rows) {
				const tr = el("tr", r.id === A()?.me?.id ? "me" : "");
				const name = el("a", null, r.name);
				name.href = `profile.html?u=${encodeURIComponent(r.id)}`;
				const who = el("td");
				who.append(name);
				tr.append(el("td", null, String(r.rank)), who, el("td", "n", String(kind === "duel" ? r.elo : kind === "coop" ? (r.best ?? "–") : r.wins)), el("td", "n", String(r.games)));
				tb.append(tr);
			}
			t.append(tb);
			holder.replaceChildren(t);
		} catch (err) {
			holder.replaceChildren(el("p", "muted", err.status === 401 ? "Sign in to see this board." : `Could not load the board (${err.message}).`));
		}
	}

	async function start() {
		const select = document.querySelector("[data-game]");
		const list = games();
		if (!list.some((g) => g.id === game)) game = list[0]?.id;
		select.replaceChildren(
			...list.map((g) => {
				const o = el("option", null, g.title);
				o.value = g.id;
				o.selected = g.id === game;
				return o;
			}),
		);
		select.onchange = () => {
			game = select.value;
			remember();
			board();
		};
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
