// lib/account.js — signing in, and everything a signed-in player gets:
// favourites on every device, ranked matches, friends online, party invites,
// groups, feedback. The server side is worker/api/ (docs/accounts.md).
//
// Signing in is optional and changes nothing about playing: the arcade works
// without it, offline, from any page. What this file adds when there is an
// account:
//
//   token     localStorage "neon.token", picked up from #token=… after the
//             provider sends the browser back, and sent as a Bearer header.
//             Only ever this page's: game frames are sandboxed away from it.
//   favs      merged with this device's on sign-in, then kept in step.
//   results   lib/stats.js hands every result to NeonArcade.onResult: the
//             host counts the play (anonymous), and a signed-in player
//             reports a match with people for the leaderboards — the server
//             counts it when two players' reports agree.
//   party     our account rides in the party record (member meta `acct`), so
//             the others can map seats to accounts and offer ADD FRIEND.
//   live      a socket per page for presence and pushed invites.
//
// The server is the room server (lib/room-join.js): `?rs=` when it is
// loopback, else localStorage "neon.rs", else the deployed one — the same
// rule, repeated here because the portal does not load room-join.js.

window.NeonArcade = window.NeonArcade || {};

(() => {
	const DEPLOYED = "https://neon-arcade-room.lokeshmohanty.workers.dev";
	// The hourly public snapshot (worker/api/snapshot.js): read when the
	// server cannot be reached.
	const SNAPSHOT = "https://raw.githubusercontent.com/lokeshmohanty/games/stats/stats";
	const TOKEN = "neon.token";
	const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/;

	// Resolved once, at load: pages rewrite their own query string later
	// (leaderboard.html's ?game=), and the server must not change under them.
	const BASE = (() => {
		let b = NeonArcade.roomServerUrl ?? DEPLOYED;
		try {
			const linked = new URLSearchParams(location.search).get("rs");
			if (linked && LOOPBACK.test(new URL(linked).hostname)) b = linked;
			else b = localStorage.getItem("neon.rs") || b;
		} catch {}
		return b.replace(/\/+$/, "").replace(/^ws/, "http");
	})();
	const base = () => BASE;

	const read = (k) => {
		try {
			return localStorage.getItem(k);
		} catch {
			return null;
		}
	};
	const write = (k, v) => {
		try {
			if (v == null) localStorage.removeItem(k);
			else localStorage.setItem(k, v);
		} catch {}
	};

	// A token handed back by the provider: keep it, and take it out of the
	// address bar (and history) at once.
	(() => {
		const m = location.hash.match(/(?:^#|&)token=([^&]+)/);
		if (m) {
			write(TOKEN, decodeURIComponent(m[1]));
			history.replaceState(history.state, "", location.pathname + location.search);
		} else if (/(?:^#|&)signin=cancelled/.test(location.hash)) {
			history.replaceState(history.state, "", location.pathname + location.search);
			addEventListener("DOMContentLoaded", () => NeonArcade.toast?.("Sign-in cancelled.", "warn"));
		}
	})();

	let me = null; // the profile, once fetched
	let meLoad = null;
	const listeners = new Set();
	const changed = () => {
		for (const fn of listeners) {
			try {
				fn(me);
			} catch (err) {
				console.error(err);
			}
		}
	};

	/** Call the API. Resolves the JSON; rejects with `.status` on an error. */
	async function api(path, { method = "GET", body, auth = true } = {}) {
		const token = read(TOKEN);
		const res = await fetch(base() + path, {
			method,
			headers: {
				...(auth && token ? { Authorization: `Bearer ${token}` } : {}),
				...(body ? { "Content-Type": "application/json" } : {}),
			},
			body: body ? JSON.stringify(body) : undefined,
		});
		const data = await res.json().catch(() => ({}));
		if (res.status === 401 && auth && token) {
			// The session ended elsewhere (signed out, account deleted).
			write(TOKEN, null);
			me = null;
			changed();
		}
		if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { status: res.status });
		return data;
	}

	function load() {
		if (!read(TOKEN)) return Promise.resolve(null);
		meLoad ??= api("/api/me")
			.then(async (p) => {
				me = p;
				changed();
				await syncFavs();
				connect();
				return me;
			})
			.catch((err) => {
				// Offline or the server is down: still signed in, just not now.
				if (err.status !== 401) console.warn("account:", err.message);
				return null;
			})
			.finally(() => (meLoad = null));
		return meLoad;
	}

	// ---------------------------------------------------------- favourites

	let pushing = null;
	async function syncFavs() {
		const S = NeonArcade.stats;
		if (!S || !me) return;
		try {
			const { favs } = await api("/api/me/favs");
			const merged = S.mergeFavs(S.favs(), favs);
			S.setFavs(merged);
			if (merged.length !== favs.length) await api("/api/me/favs", { method: "PUT", body: { favs: merged } });
		} catch {}
	}
	NeonArcade.stats?.onChange((what) => {
		if (what !== "favs" || !me) return;
		clearTimeout(pushing);
		pushing = setTimeout(() => api("/api/me/favs", { method: "PUT", body: { favs: NeonArcade.stats.favs() } }).catch(() => {}), 600);
	});

	// -------------------------------------------------------------- results

	/** lib/party.js calls this for every result this device counted. */
	NeonArcade.onResult = ({ game, run, result, room }) => {
		if (!run || String(game).startsWith("dev/")) return;
		const ids = result.ranking.flat();
		const bots = ids.some((id) => NeonArcade.isBotId?.(id) ?? id.startsWith("bot_"));
		// Anonymous count: the host's, once per match.
		if (room?.isHost()) api("/api/stats/played", { method: "POST", body: { game, bots }, auth: false }).catch(() => {});
		if (!me || bots || result.kind === "local") return;
		const roster = {};
		for (const id of ids) {
			const acct = room?.getMember(id)?.acct?.id;
			if (acct) roster[id] = acct;
		}
		if (Object.keys(roster).length < 2) return;
		const body = { game, run, match: result.match ?? 1, kind: result.kind, ranking: result.ranking, scores: result.scores, roster };
		// The first to report waits for a second; sending the same report again
		// is harmless, and is how this player learns that it counted.
		const send = (tries) =>
			api("/api/match/report", { method: "POST", body })
				.then((r) => {
					if (r.counted && (!r.already || tries < 3)) NeonArcade.toast?.("Counted on the leaderboard.", "good");
					else if (r.pending && tries > 0) setTimeout(() => send(tries - 1), [20_000, 8_000, 3_000][tries - 1]);
				})
				.catch(() => {});
		send(3);
	};

	// ---------------------------------------------------------------- party

	let attached = null;
	/** Put our account in the party record (idempotent; party.js calls it). */
	function attach(room) {
		if (!room || !me) return;
		const mine = room.self?.()?.acct;
		if (attached === room && mine?.id === me.id && mine.name === me.name) return;
		attached = room;
		room.setMeta({ acct: { id: me.id, name: me.name, avatar: me.avatar ?? null } });
	}

	// ----------------------------------------------------------------- live

	let ws = null;
	let wsTimer = null;
	let wsBackoff = 2000;
	let playing = null;
	function connect() {
		if (ws || !me || !read(TOKEN) || typeof WebSocket === "undefined") return;
		try {
			ws = new WebSocket(base().replace(/^http/, "ws") + "/live", ["neon", read(TOKEN)]);
		} catch {
			ws = null;
			return;
		}
		ws.onopen = () => {
			wsBackoff = 2000;
			ws.send(JSON.stringify({ t: "status", game: playing }));
			clearInterval(wsTimer);
			wsTimer = setInterval(() => ws?.readyState === 1 && ws.send('{"t":"ping"}'), 4 * 60_000);
		};
		ws.onmessage = (e) => {
			let msg;
			try {
				msg = JSON.parse(e.data);
			} catch {
				return;
			}
			if (msg.t === "invite") showInvite(msg);
			if (msg.t === "friend") {
				NeonArcade.toast?.(msg.state === "friends" ? `${msg.name} accepted your friend request.` : `${msg.name} wants to be friends.`, "good");
				changed();
			}
		};
		ws.onclose = () => {
			ws = null;
			clearInterval(wsTimer);
			if (me) setTimeout(connect, (wsBackoff = Math.min(wsBackoff * 2, 60_000)));
		};
	}
	/** What this page is playing, for friends' lists (party.js). */
	function status(game) {
		playing = game ?? null;
		if (ws?.readyState === 1) ws.send(JSON.stringify({ t: "status", game: playing }));
	}

	function showInvite(msg) {
		document.querySelector(".neon-invite")?.remove();
		const box = document.createElement("div");
		box.className = "neon-invite";
		box.setAttribute("role", "alert");
		const p = document.createElement("p");
		p.textContent = `${msg.from?.name ?? "A friend"} invites you to their party.`;
		const join = document.createElement("a");
		join.className = "neon-btn neon-btn--accent";
		join.textContent = "JOIN";
		join.href = `party.html#c=${encodeURIComponent(msg.code)}`;
		const no = document.createElement("button");
		no.className = "neon-btn";
		no.textContent = "NOT NOW";
		no.onclick = () => box.remove();
		const row = document.createElement("div");
		row.className = "neon-invite-row";
		row.append(join, no);
		box.append(p, row);
		document.body.append(box);
		setTimeout(() => box.remove(), 60_000);
	}

	// ------------------------------------------------- public numbers, offline too

	/** Play counts: the server's, else the last public snapshot's. */
	async function summary() {
		try {
			return await api("/api/stats/summary", { auth: false });
		} catch {
			const res = await fetch(`${SNAPSHOT}/summary.json`).catch(() => null);
			return res?.ok ? res.json() : { games: {} };
		}
	}
	async function leaderboard(game, scope = "global") {
		try {
			return await api(`/api/lb/${game.split("/").map(encodeURIComponent).join("/")}?scope=${encodeURIComponent(scope)}`, {
				auth: scope !== "global",
			});
		} catch (err) {
			if (scope !== "global" || err.status) throw err;
			const res = await fetch(`${SNAPSHOT}/lb/${game.replace(/\//g, "__")}.json`).catch(() => null);
			if (!res?.ok) throw err;
			return { ...(await res.json()), scope, fromSnapshot: true };
		}
	}

	NeonArcade.account = {
		base,
		api,
		summary,
		leaderboard,
		attach,
		status,
		load,
		get me() {
			return me;
		},
		signedIn: () => !!read(TOKEN),
		/** Off to the provider; back to this page (without its hash). */
		signIn(provider) {
			const back = location.href.split("#")[0];
			location.href = `${base()}/auth/${provider}/start?back=${encodeURIComponent(back)}`;
		},
		async signOut() {
			await api("/api/me/signout", { method: "POST" }).catch(() => {});
			write(TOKEN, null);
			me = null;
			ws?.close();
			changed();
		},
		/** Delete everything; the page then knows nothing of the account. */
		async deleteAccount() {
			await api("/api/me", { method: "DELETE" });
			write(TOKEN, null);
			me = null;
			ws?.close();
			changed();
		},
		onChange(fn) {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
		_setMe(p) {
			me = p;
			changed();
		},
	};

	load();
})();
