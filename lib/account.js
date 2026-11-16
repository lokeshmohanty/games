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
//             counts it when two players' reports agree — or a run played
//             alone, under the run the server issued as it began (startRun),
//             or a win against bots (alone with them), under its own run, for
//             the game's separate board of wins against bots.
//   party     our account rides in the party record (member meta `acct`), so
//             the others can map seats to accounts and offer ADD FRIEND.
//   live      a socket per page for presence, pushed invites and friend
//             requests; invites that waited for us (worker/api/social.js,
//             10 minutes) are shown as the page loads.
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
	// (the leaderboard's ?game=), and the server must not change under them.
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
		} else if (/(?:^#|&)(signin|connected)=/.test(location.hash)) {
			// Back from a provider without a new session: say what happened.
			const h = new URLSearchParams(location.hash.slice(1));
			const who = { github: "GitHub", google: "Google" }[h.get("provider") ?? h.get("connected")] ?? "That";
			const say =
				h.get("connected") ? [`${who} connected.`, "good"]
				: h.get("signin") === "taken" ? [`${who} account is already connected to another arcade account.`, "warn"]
				: ["Sign-in cancelled.", "warn"];
			history.replaceState(history.state, "", location.pathname + location.search);
			addEventListener("DOMContentLoaded", () => NeonArcade.toast?.(...say));
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
	async function api(path, { method = "GET", body, auth = true, keepalive = false } = {}) {
		const token = read(TOKEN);
		const res = await fetch(base() + path, {
			method,
			keepalive,
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
		if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { status: res.status, code: data.code });
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
				waitingInvites();
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

	// Games, contributors and collections in one list (lib/stats.js favId).
	// A server from before contributor:/collection: ids refuses the list
	// (400): it still gets the games, and the rest stays on this device.
	let pushing = null;
	const putFavs = (favs) =>
		api("/api/me/favs", { method: "PUT", body: { favs } }).catch((err) => {
			if (err.status !== 400) throw err;
			return api("/api/me/favs", { method: "PUT", body: { favs: favs.filter(NeonArcade.stats.isGameFav) } });
		});
	async function syncFavs() {
		const S = NeonArcade.stats;
		if (!S || !me) return;
		try {
			const { favs } = await api("/api/me/favs");
			const merged = S.mergeFavs(S.favs(), favs);
			S.setFavs(merged);
			if (merged.length !== favs.length) await putFavs(merged);
		} catch {}
	}
	NeonArcade.stats?.onChange((what) => {
		if (what !== "favs" || !me) return;
		clearTimeout(pushing);
		pushing = setTimeout(() => putFavs(NeonArcade.stats.favs()).catch(() => {}), 600);
	});

	// -------------------------------------------------------------- results

	/** lib/party.js calls this for every result this device counted. */
	NeonArcade.onResult = ({ game, run, result, room }) => {
		if (!run || String(game).startsWith("dev/")) return;
		const ids = result.ranking.flat();
		const bots = ids.some((id) => NeonArcade.isBotId?.(id) ?? id.startsWith("bot_"));
		// Anonymous count: the host's, once per match.
		if (room?.isHost()) api("/api/stats/played", { method: "POST", body: { game, bots }, auth: false }).catch(() => {});
		const ticket = issued.get(game);
		issued.delete(game); // one result per run, whatever becomes of it
		if (!me || result.kind === "local") return;
		if (bots) return reportBotsWin({ game, result, ticket, room });
		const roster = {};
		for (const id of ids) {
			const acct = room?.getMember(id)?.acct?.id;
			if (acct) roster[id] = acct;
		}
		// Two signed-in players confirm each other; a solo run (one player, no
		// bots: Sudoku, Neon Survival alone) is ranked on its own report
		// (Lokesh, 2026-11-15) — with the run the server issued as it began
		// (startRun), which the report names instead of the party's run, and
		// the game's proof (Sudoku: its solved grid). No run, no ranking.
		const solo = ids.length === 1 && Object.keys(roster).length === 1;
		if (Object.keys(roster).length < 2 && !solo) return;
		if (solo && ticket?.vs !== "solo") return;
		// A result with nothing to rank by — no score of ours, no proof — is a
		// version of the game from before its solo score (Light Cycles until its
		// pin moves): not sent, and no more runs for it this session.
		if (solo && typeof result.scores?.[ids[0]] !== "number" && result.proof == null) return unrankable(game);
		const body = { game, run: solo ? ticket.run : run, match: result.match ?? 1, kind: result.kind, ranking: result.ranking, scores: result.scores, roster };
		if (solo && result.proof != null) body.proof = result.proof;
		// The first to report waits for a second; sending the same report again
		// is harmless, and is how this player learns that it counted.
		const send = (tries) =>
			api("/api/match/report", { method: "POST", body })
				.then((r) => {
					if (r.counted && (!r.already || tries < 3)) NeonArcade.toast?.("Counted on the leaderboard.", "good");
					else if (r.pending && tries > 0) setTimeout(() => send(tries - 1), [20_000, 8_000, 3_000][tries - 1]);
					else if (solo && !r.counted && r.code === "unrankable") unrankable(game);
					else if (solo && !r.counted && r.why) once(game, r.why, () => NeonArcade.toast?.(`Not ranked: ${r.why}.`, "warn"));
				})
				.catch(() => {});
		send(3);
	};

	/**
	 * A win against bots (docs/accounts.md "Against bots"): reported only when
	 * this player is the one person in the match — every other seat a bot —
	 * and won it, under the run issued as it began. A bot seat the game names
	 * as a person (result `names`: Neon Fission's PLAYER seats, people passing
	 * this phone round) makes it a one-phone game among people, which is not
	 * a game against bots. Nor does a match in which a bot was removed: most
	 * games hand the win to whoever is left (review, 2026-11-15), so every bot
	 * seated when the run began, and every bot in the result, must still be
	 * in the party. Never a rating, never a ranked board.
	 */
	function reportBotsWin({ game, result, ticket, room }) {
		const ids = result.ranking.flat();
		const people = ids.filter((id) => !(NeonArcade.isBotId?.(id) ?? id.startsWith("bot_")));
		const self = room?.selfId;
		if (people.length !== 1 || people[0] !== self) return;
		if (result.names && Object.keys(result.names).length) return;
		const isBot = (id) => NeonArcade.isBotId?.(id) ?? id.startsWith("bot_");
		if ([...(ticket?.bots ?? []), ...ids.filter(isBot)].some((id) => !room?.getMember(id))) return;
		const first = result.ranking[0] ?? [];
		const won = result.ranking.length > 1 && first.length === 1 && first[0] === self;
		if (!won || ticket?.vs !== "bots") return;
		const body = { game, run: ticket.run, match: result.match ?? 1, kind: result.kind, ranking: result.ranking, roster: { [self]: me.id } };
		api("/api/match/report", { method: "POST", body })
			.then((r) => {
				if (r.counted) NeonArcade.toast?.(`Counted: ${r.wins ?? "another"} ${r.wins === 1 ? "win" : "wins"} against bots.`, "good");
				else if (r.why) once(game, r.why, () => NeonArcade.toast?.(`Not counted against bots: ${r.why}.`, "warn"));
			})
			.catch(() => {});
	}

	// Games whose results this session showed cannot rank alone (`unrankable`),
	// and the refusals already shown, by game: a reason is toasted once per game
	// per session, then only logged — a round every few seconds must not raise
	// the same warning every time.
	const noSolo = new Set();
	const said = new Set();
	function unrankable(game) {
		if (noSolo.has(game)) return;
		noSolo.add(game);
		console.info(`${game}: its results carry no score to rank alone; no solo runs for it this session.`);
	}
	function once(game, why, show) {
		const k = `${game}\n${why}`;
		if (said.has(k)) return console.info(`${game}: not ranked: ${why}`);
		said.add(k);
		show();
	}

	// The run the server issued as a game began — alone (`vs` "solo") or
	// against bots ("bots") — by game, until that game's next result names it
	// or another start replaces it (one report per run).
	const issued = new Map();
	const asked = new Map(); // game -> the latest start's number: older answers are dropped
	const RUN_WAIT_MS = 2500; // the game waits this long at most before a local seed
	/**
	 * Ask the server for a run as a game begins (lib/sdk-managed.js, before the
	 * rules' init; lib/party.js for a game that runs its own matches). Alone,
	 * the game waits for it: its seed is the server's. Against bots
	 * (`{ vs: "bots", bots }`, the bots seated) nothing waits — the run is
	 * only the clock a win is checked against. Resolves { run, seed, at, vs }, or null — signed out,
	 * offline, a dev-kit game, or no answer in time — and the game then plays
	 * on a local seed, unranked.
	 */
	async function startRun(game, { vs = "solo", bots = [] } = {}) {
		issued.delete(game);
		const n = (asked.get(game) ?? 0) + 1;
		asked.set(game, n);
		if (!read(TOKEN) || String(game).startsWith("dev/") || navigator.onLine === false) return null;
		if (vs === "solo" && noSolo.has(game)) return null; // nothing to rank: no run, and no wait
		const ask = api("/api/run/start", { method: "POST", body: vs === "bots" ? { game, vs } : { game } }).catch(() => null);
		const r = await Promise.race([ask, new Promise((done) => setTimeout(done, RUN_WAIT_MS, null))]);
		if (!r || typeof r.run !== "string" || !Number.isInteger(r.seed) || asked.get(game) !== n) return null;
		const ticket = { ...r, vs, bots: vs === "bots" ? [...bots] : [] };
		issued.set(game, ticket);
		return ticket;
	}

	// ---------------------------------------------------------------- party

	let attached = null;
	/** Put our account in the party record (idempotent; party.js calls it). */
	function attach(room) {
		if (!room || !me) return;
		const mine = room.self?.()?.acct;
		const hide = !!me.hidePublic;
		if (attached === room && mine?.id === me.id && mine.name === me.name && !!mine.hide === hide) return;
		attached = room;
		// `hide`: out of public lists, so "Players you just played" leaves us out.
		room.setMeta({ acct: { id: me.id, name: me.name, avatar: me.avatar ?? null, ...(hide ? { hide } : {}) } });
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
				// A request: ACCEPT and DECLINE right there (lib/account-ui.js).
				if (msg.state === "asked" && NeonArcade.accountUi?.requestNotice) NeonArcade.accountUi.requestNotice(msg);
				else NeonArcade.toast?.(msg.state === "friends" ? `${msg.name} accepted your friend request.` : `${msg.name} wants to be friends.`, "good");
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

	/**
	 * The stack the notices go in — an invite, a friend request — at the
	 * bottom of the screen, each under the last, never on top of each other.
	 */
	function notices() {
		let stack = document.querySelector(".neon-notices");
		if (!stack) {
			stack = document.createElement("div");
			stack.className = "neon-notices";
			document.body.append(stack);
		}
		return stack;
	}
	// Invites on screen, one at a time; the rest wait their turn.
	const inviteQueue = [];
	/**
	 * A party invite: pushed while a page is open, or waiting for us on the
	 * server since a friend sent it (the last 10 minutes). JOIN and NOT NOW
	 * both forget it there, so it is not shown again on the next page.
	 */
	function showInvite(msg) {
		const from = msg.from?.id ?? null;
		const k = `${from}:${msg.code}`;
		if (document.querySelector(`.neon-invite[data-invite="${CSS.escape(k)}"]`) || inviteQueue.some((m) => `${m.from?.id ?? null}:${m.code}` === k)) return;
		if (document.querySelector(".neon-invite[data-invite]")) return void inviteQueue.push(msg);
		const box = document.createElement("div");
		box.className = "neon-invite";
		box.dataset.invite = k;
		box.setAttribute("role", "alert");
		const p = document.createElement("p");
		const who = document.createElement("span");
		who.className = "neon-invite-name";
		who.textContent = msg.from?.name ?? "A friend";
		p.append(who, " invited you to a party.");
		const forget = () => (from ? api(`/api/invites/${encodeURIComponent(from)}`, { method: "DELETE", keepalive: true }).catch(() => {}) : Promise.resolve());
		const next = () => {
			box.remove();
			const more = inviteQueue.shift();
			if (more) showInvite(more);
		};
		const join = document.createElement("a");
		join.className = "neon-btn neon-btn--accent";
		join.textContent = "JOIN";
		join.href = `./?party#c=${encodeURIComponent(msg.code)}`;
		join.addEventListener("click", () => {
			forget();
			inviteQueue.length = 0;
			box.remove();
		});
		const no = document.createElement("button");
		no.className = "neon-btn";
		no.textContent = "NOT NOW";
		no.onclick = () => {
			forget();
			next();
		};
		const row = document.createElement("div");
		row.className = "neon-invite-row";
		row.append(join, no);
		box.append(p, row);
		notices().append(box);
		// Off the screen after a minute; still waiting on the server until it expires.
		setTimeout(() => box.isConnected && next(), 60_000);
	}
	/** Invites friends sent while no page of ours was open. */
	function waitingInvites() {
		api("/api/invites")
			.then((r) => {
				for (const msg of r.invites ?? []) showInvite(msg); // newest first
			})
			.catch(() => {}); // a server from before waiting invites: 404
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
	/**
	 * A board; signed in, it also carries `me` — where you stand (worker/api/lb.js).
	 * `vs` "bots": the game's board of wins against bots (no offline copy).
	 */
	async function leaderboard(game, scope = "global", vs = null) {
		const path = `/api/lb/${game.split("/").map(encodeURIComponent).join("/")}?scope=${encodeURIComponent(scope)}${vs === "bots" ? "&vs=bots" : ""}`;
		const withMe = scope === "global" && !!read(TOKEN);
		try {
			return await api(withMe ? `${path}&me=1` : path, { auth: scope !== "global" || withMe });
		} catch (err) {
			// A session that ended still gets the public board.
			if (withMe && err.status === 401) return leaderboard(game, scope, vs);
			if (scope !== "global" || vs || err.status) throw err;
			const res = await fetch(`${SNAPSHOT}/lb/${game.replace(/\//g, "__")}.json`).catch(() => null);
			if (!res?.ok) throw err;
			return { ...(await res.json()), scope, fromSnapshot: true };
		}
	}

	NeonArcade.account = {
		base,
		notices,
		api,
		summary,
		leaderboard,
		startRun,
		attach,
		status,
		load,
		get me() {
			return me;
		},
		signedIn: () => !!read(TOKEN),
		/** Does this account have `provider` connected? (GitHub: needed for feedback.) */
		has: (provider) => !!me?.identities?.some((i) => i.provider === provider),
		/** Connect another sign-in to this account: off to the provider and back. */
		async connect(provider) {
			const { url } = await api(`/api/me/link/${provider}`, { method: "POST", body: { back: location.href.split("#")[0] } });
			location.href = url;
		},
		async disconnect(provider) {
			me = await api(`/api/me/identities/${provider}`, { method: "DELETE" });
			changed();
		},
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
			const wasOffline = !!me?.appearOffline;
			me = p;
			changed();
			// Back from "appear offline": say where we are at once (audit D16).
			if (wasOffline && !p?.appearOffline) status(playing);
		},
	};

	load();
})();
