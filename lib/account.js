// lib/account.js — signing in, and everything a signed-in player gets:
// favourites on every device, head-to-head records, friends online, party
// invites, groups, feedback. The server side is worker/api/ (docs/accounts.md).
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
//             reports a match with other signed-in people — the server
//             records it when their reports agree, for head-to-head (who
//             beat whom, never a rating or a board: Lokesh, 2026-11-25).
//             Matches with bots, alone or on one phone stay on the device.
//   party     our account rides in the party record (member meta `acct`), so
//             the others can map seats to accounts and offer ADD FRIEND.
//   live      a socket per page for presence, pushed invites and friend
//             requests; invites that waited for us (worker/api/social.js,
//             10 minutes) are shown as the page loads — first the one a
//             tapped notification named (./?invite=<sender>, sw.js; the
//             notifications themselves are lib/push.js).
//
// The server is the room server (lib/room-join.js): `?rs=` when it is
// loopback, else localStorage "neon.rs", else the deployed one — the same
// rule, repeated here because the portal does not load room-join.js.

window.NeonArcade = window.NeonArcade || {};

(() => {
	const DEPLOYED = "https://neon-arcade-room.lokeshmohanty.workers.dev";
	// The hourly public snapshot (worker/api/snapshot.js, play counts only):
	// read when the server cannot be reached.
	const SNAPSHOT = "https://raw.githubusercontent.com/lokeshmohanty/games/stats/stats";
	const TOKEN = "neon.token";
	const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/;

	// Resolved once, at load: pages rewrite their own query string later,
	// and the server must not change under them.
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
			// The session ended elsewhere (signed out, account deleted, expired).
			// This device stops getting that account's invites as well, first,
			// or the next person signed in here would get them (lib/push.js).
			write(TOKEN, null);
			NeonArcade.push?.forget?.({ expired: true }).catch(() => {});
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
				waitingInvites(tappedInvite);
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
		// The end card's line for this match: nothing until a report says otherwise.
		const card = `${game}|${run}|${result.match ?? 1}`;
		note(card, null);
		// Who sat down when this match began (matchStart), if it began in this run.
		const began = started.get(game);
		started.delete(game);
		const start = began?.run === run ? began : null;
		// Head-to-head is between people: bots, one phone or nobody signed in, nothing is sent.
		if (!me || result.kind === "local" || bots) return;
		const roster = {};
		for (const id of ids) {
			const acct = room?.getMember(id)?.acct?.id ?? start?.roster[id];
			if (acct) roster[id] = acct;
		}
		// Seated as it began, and gone from the party for good by now — LEAVE
		// PARTY, or a seat no longer held after the reconnect grace (a held
		// seat is still a member). Leaving is a loss (docs/accounts.md
		// "Leaving"), if the server can confirm it.
		const left = start ? start.people.filter((id) => !room?.getMember(id) && start.roster[id]) : [];
		for (const id of left) roster[id] = start.roster[id];
		// Two signed-in players confirm each other; fewer, nothing to record.
		if (Object.keys(roster).length < 2) return;
		const match = result.match ?? 1;
		const body = { game, run, match, kind: result.kind, ranking: result.ranking, scores: result.scores, roster, seats: start?.seats ?? null };
		if (left.length) body.left = left;
		// A team game says who played for whom: a leaver's loss is against the
		// other team only, and the others' outcome stays the game's (worker/api/match.js toAccounts).
		if (result.kind === "teams" && start) body.teams = Object.fromEntries(Object.entries(start.teams).filter(([id]) => roster[id]));
		note(card, { pending: true });
		// The first to report waits for the others; sending the same report
		// again is harmless, and is how this player learns that it counted —
		// past the server's grace (worker/api/match.js MATCH_GRACE_MS, 45 s)
		// for a match someone named in it never reported, or left.
		// `keepalive`: a report sent as the page closes still goes. A report
		// that never reached the server — offline to the last try — leaves our
		// start of this match standing, so it is withdrawn: nobody can then
		// file us as having left a match we finished (review, 2026-11-16).
		// A report naming a leaver waits longer: the server books a departure
		// only once the leaver's page has stopped beating for 4.5 minutes.
		const waits = left.length ? RETRY_LEFT_MS : RETRY_MS;
		const send = (tries) =>
			api("/api/match/report", { method: "POST", body, keepalive: true })
				.then((r) => {
					if (r.counted) note(card, { vs: r.vs ?? [] });
					else if (r.left) note(card, { left: true, vs: r.vs ?? [] });
					else if (!r.pending || !tries) note(card, null);
					if (r.counted && r.vs?.length && (!r.already || tries < waits.length)) NeonArcade.toast?.(versusText(r.vs), "good");
					else if (r.left) once(game, r.why, () => NeonArcade.toast?.("Counted as a loss: the others reported that you left this match.", "warn"));
					else if (r.pending && tries > 0) setTimeout(() => send(tries - 1), waits[tries - 1]);
				})
				.catch((err) => {
					// Offline, the server busy or out of breath: try again. Anything
					// else, or the last try: our start of this match is withdrawn — a
					// report that never counted must not leave it standing (review,
					// 2026-11-16), or we could be filed as having left a match we finished.
					const again = !err.status || err.status >= 500 || err.status === 429;
					if (tries > 0 && again) return void setTimeout(() => send(tries - 1), waits[tries - 1]);
					note(card, null);
					if (start?.posted && start.match === match) withdraw(game, start);
				});
		send(waits.length);
	};
	// Re-sends of a pending report, last first: 3, 8, 20 and 40 s apart — 71 s
	// in all, past the server's 45 s grace. Naming a leaver: three 60 s more,
	// 251 s — past MATCH_STALE_MS (4.5 min) after the leaver's last beat,
	// which was at most 60 s before they left. Past that, the sweep settles it.
	const RETRY_MS = [40_000, 20_000, 8_000, 3_000];
	const RETRY_LEFT_MS = [60_000, 60_000, 60_000, ...RETRY_MS];

	/**
	 * Head-to-head in this game, from a report's answer (`vs`, worker/api/
	 * match.js): "You 5–3 Asha" for one other, "You 5–3 Asha · 1–2 Bo" for
	 * more; a draw count only when there is one. Never a rating.
	 */
	const record = (x) => `${x.wins}–${x.losses}${x.draws ? `–${x.draws}` : ""}`;
	const versusText = (vs) => (vs?.length ? `You ${vs.map((x) => `${record(x)} ${x.name}`).join(" · ")}` : "");

	// The end card's line about this match (lib/sdk-managed.js calls endCard
	// as it draws a card): the head-to-head after it ("You 5–3 Asha"), or
	// waiting for the others to confirm. The report's answer can come after
	// the card is drawn, or the card be drawn again (a takeover, a late
	// join): every line drawn for a match is kept and repainted in place when
	// its answer lands.
	const cardState = new Map(); // `${game}|${run}|${match}` -> { pending } | { vs, left? } | null
	const cardLines = new Map(); // same key -> Set of elements
	function paint(el, st) {
		const text = !st ? "" : st.pending ? "Waiting for the other players to confirm…" : st.left ? `Counted as a loss: you left${st.vs?.length ? ` · ${versusText(st.vs)}` : ""}` : versusText(st.vs);
		el.hidden = !text;
		if (!text) return;
		el.dataset.state = st.pending ? "pending" : st.left ? "left" : "counted";
		el.textContent = text;
	}
	function note(key, st) {
		cardState.set(key, st);
		if (cardState.size > 20) cardState.delete(cardState.keys().next().value);
		for (const el of cardLines.get(key) ?? []) el.isConnected ? paint(el, st) : cardLines.get(key).delete(el);
	}
	/** A card for `match` of `game` in party run `run` was drawn with `el` to fill: now, and whenever its answer changes. */
	function endCard(game, match, el, run = null) {
		const key = `${game}|${run}|${match}`;
		for (const [k, set] of cardLines) for (const x of set) if (!x.isConnected) set.delete(x), set.size || cardLines.delete(k);
		(cardLines.get(key) ?? cardLines.set(key, new Set()).get(key)).add(el);
		paint(el, cardState.get(key) ?? null);
	}

	// The refusals already shown, by game: a reason is toasted once per game
	// per session, then only logged — a round every few seconds must not
	// raise the same warning every time.
	const said = new Set();
	function once(game, why, show) {
		const k = `${game}\n${why}`;
		if (said.has(k)) return console.info(`${game}: not recorded: ${why}`);
		said.add(k);
		show();
	}

	// Each game's match as it began (matchStart): its run, how many seats,
	// the people seated and their accounts — for the result's `seats`, `left`
	// and the roster of whoever has gone since.
	const started = new Map();
	/**
	 * A match begins (lib/sdk-managed.js start; lib/sdk-host.js for a game
	 * that runs its own matches, at its start and after each result). In a
	 * match with a winner among signed-in people, this page also tells the
	 * server it is seated
	 * (POST /api/match/start): the evidence that lets a departure of ours
	 * count as a loss (docs/accounts.md "Leaving").
	 */
	function matchStart(game, { room, seats, kind, match = null }) {
		if (!room || String(game).startsWith("dev/")) return;
		const isBot = (id) => NeonArcade.isBotId?.(id) ?? String(id).startsWith("bot_");
		const people = seats.filter((id) => !isBot(id));
		const roster = {};
		const teams = {}; // party id → team as the match began (a team game's leaver is booked by team)
		for (const id of people) {
			const m = room.getMember(id);
			if (m?.acct?.id) roster[id] = m.acct.id;
			if (m?.team != null) teams[id] = m.team;
		}
		const run = room.getRun?.() ?? null;
		const decided = ["duel", "ffa", "teams"].includes(kind); // a game with a winner
		// Only a match whose number is known as it begins (a managed game's) can
		// be named: the server keys the start by game, run and match.
		const post = !!me && !!run && decided && Number.isInteger(match) && people.length === seats.length && Object.keys(roster).length >= 2 && roster[room.selfId] === me.id;
		const st = { run, match, seats: seats.length, people, roster, teams, posted: post };
		started.set(game, st);
		if (!post) return;
		const live = () => started.get(game) === st && !room.closed;
		// A failed beat is tried once more, 15 s later: one lost request must
		// not let the server think we left (review, 2026-11-16).
		const say = (again = true) =>
			api("/api/match/start", { method: "POST", body: { game, run, match } }).catch(() => {
				if (again) setTimeout(() => live() && say(false), BEAT_RETRY_MS);
			});
		say();
		// The heartbeat: while this match runs and we are in the party, the
		// start is said again every 60 s — the server books a departure only
		// after 4.5 minutes without one (worker/api/match.js MATCH_STALE_MS),
		// whatever our other pages say. Beats are free of the per-address
		// write limit. It stops with the match's result, a withdrawal, the next
		// match, or our leaving the party.
		const beat = setInterval(() => {
			if (!live()) return void clearInterval(beat);
			say();
		}, HEARTBEAT_MS);
	}
	const HEARTBEAT_MS = 60_000;
	const BEAT_RETRY_MS = 15_000;

	// A page being closed or reloaded is not a match ended without a result:
	// its start stays, and if the seat is not taken back, the departure counts.
	// A page put in the back-forward cache (`persisted`) may come back into
	// the party (main e06b4da), so it does not latch (review, 2026-11-16).
	let unloading = false;
	addEventListener("pagehide", (e) => {
		if (!e.persisted) unloading = true;
	});
	addEventListener("pageshow", (e) => {
		if (e.persisted) unloading = false;
	});
	const withdraw = (game, st) => {
		if (started.get(game) === st) started.delete(game);
		api("/api/match/start", { method: "DELETE", body: { game, run: st.run, match: st.match }, keepalive: true }).catch(() => {});
	};
	/**
	 * A game was taken down (lib/sdk-managed.js dispose). If its match had
	 * no result and we are still in the party — END GAME, the host left or
	 * switched games — our start is withdrawn, so nobody can later name us as
	 * having left that match. Leaving the party ourselves (the room closed)
	 * keeps it: that is a departure.
	 */
	function matchEnd(game, { decided, room }) {
		const st = started.get(game);
		if (decided || !st?.posted || unloading || room?.closed) return;
		withdraw(game, st);
	}
	/** We were removed from the party, or the host closed it (lib/party.js): every start without a result is withdrawn. */
	function partyGone() {
		for (const [game, st] of [...started]) if (st.posted) withdraw(game, st);
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
			ws.send(JSON.stringify({ t: "status", game: playing, ...attention() }));
			clearInterval(wsTimer);
			wsTimer = setInterval(() => ws?.readyState === 1 && ws.send(JSON.stringify({ t: "ping", ...attention() })), 4 * 60_000);
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
		if (ws?.readyState === 1) ws.send(JSON.stringify({ t: "status", game: playing, ...attention() }));
	}
	// Whether this page is in view and in use, told to the server as it
	// changes: an invite reaches every open page, but also comes as a
	// notification when none is both (worker/api/live.js `attentive`;
	// lib/push.js). A phone that switches apps hides the page before freezing
	// it. In use: a tap, click or key on the page within IDLE_MS, or a game
	// frame holding the focus (a game's own taps land in its frame, not here).
	const IDLE_MS = 5 * 60_000;
	let lastInput = Date.now();
	const visible = () => document.visibilityState === "visible";
	const active = () => Date.now() - lastInput < IDLE_MS || (document.hasFocus() && document.activeElement?.tagName === "IFRAME");
	const attention = () => ({ visible: visible(), active: active() });
	let told = "";
	const tell = () => {
		const now = attention();
		const key = `${now.visible}${now.active}`;
		if (key === told || ws?.readyState !== 1) return;
		told = key;
		ws.send(JSON.stringify({ t: "vis", ...now }));
	};
	document.addEventListener("visibilitychange", tell);
	for (const type of ["pointerdown", "keydown", "wheel"]) {
		addEventListener(type, () => {
			lastInput = Date.now();
			tell();
		}, { capture: true, passive: true });
	}
	setInterval(tell, 30_000); // going idle has no event of its own

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
	/**
	 * Invites friends sent while no page of ours was open. `first`: a sender
	 * whose invite goes first — the one a notification was tapped for
	 * (sw.js; lib/push.js) — or is said to be gone if it has expired.
	 */
	function waitingInvites(first = null) {
		api("/api/invites")
			.then((r) => {
				const list = r.invites ?? []; // newest first
				const tapped = first ? list.filter((m) => m.from?.id === first) : [];
				if (first && !tapped.length) NeonArcade.toast?.("That invite has expired.", "warn");
				for (const msg of [...tapped, ...list.filter((m) => !tapped.includes(m))]) showInvite(msg);
			})
			.catch(() => {}); // a server from before waiting invites: 404
	}
	// A tapped notification (sw.js): opened at ./?invite=<sender>, or this
	// page was focused and told so.
	const tappedInvite = (() => {
		try {
			const u = new URL(location.href);
			const from = u.searchParams.get("invite");
			if (!from) return null;
			u.searchParams.delete("invite");
			history.replaceState(history.state, "", u.pathname + u.search + u.hash);
			return from;
		} catch {
			return null;
		}
	})();
	navigator.serviceWorker?.addEventListener("message", (e) => {
		if (e.data?.t === "neon-invite" && me) waitingInvites(typeof e.data.from === "string" ? e.data.from : null);
	});

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
	NeonArcade.account = {
		base,
		notices,
		api,
		summary,
		matchStart,
		matchEnd,
		partyGone,
		endCard,
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
			// This device stops getting the account's invites (lib/push.js).
			await NeonArcade.push?.forget?.().catch(() => {});
			await api("/api/me/signout", { method: "POST" }).catch(() => {});
			write(TOKEN, null);
			me = null;
			ws?.close();
			changed();
		},
		/** Delete everything; the page then knows nothing of the account. */
		async deleteAccount() {
			await api("/api/me", { method: "DELETE" });
			await NeonArcade.push?.forget?.({ server: false }).catch(() => {}); // its rows went with the account
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
