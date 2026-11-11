// lib/room-join.js — joining a party by a six-digit code, over the room server.
//
// The handshake the players used to carry themselves — invite across, reply
// back — becomes one short exchange with a rendezvous: the host holds a code,
// the guest types it, and the offer/reply strings that used to travel through
// hands and cameras travel through the room server instead. Everything after
// the first link is the mesh it always was; this file never touches game data.
//
// The room server is optional on purpose. When it is unreachable — offline,
// `file://`, a network that blocks it — everything here stands down and the
// arcade behaves exactly as it did without it: the invite/scan/paste flow,
// which stays fully supported and fully tested. The zero-server property
// degrades; it does not disappear.
//
// One rule from docs/room-server.md binds the design: the room server's
// notices are *advisory*, never authoritative. The party record replicated over
// the mesh decides who is in the party; this file relays socket state to
// `room.serverPeerState`, and net.js ignores it whenever a live link says
// otherwise.
//
// Loaded as a traditional script so it works on file:// like everything else.

(() => {
	// The deployed room server, once it exists — `wss://…workers.dev`, no
	// trailing slash. Empty until the first deploy, which is itself the
	// signal that the code-join path is off. Override for a session or a test
	// with `?rs=<url>` or localStorage "neon.rs"; the constant is the default.
	NeonArcade.roomServerUrl = "https://neon-arcade-room.games-party.workers.dev";

	// How patient to be deciding whether the room server is there at all.
	// The probe's answer decides which UI is offered, so it is on the user's
	// path; a long timeout here is an invisible wait, which this project does
	// not ship.
	const PROBE_TIMEOUT_MS = 2500;
	// A host/join exchange that has not been answered in this long is a
	// server that is not going to answer: "unreachable", not a spinner.
	const DIAL_TIMEOUT_MS = 8000;
	// How long a joiner waits, after the server said "joined", to be in a
	// party: a data channel open *and* a host known. The offer comes from
	// whoever is attached; when nobody is (a party that ended, or one whose
	// members all left) or no link can be made, this is what turns the wait
	// into an explicit "no-answer". It has to outlast the offerer's worst
	// case on a reload — the stale-link watch below (12s), then gathering on
	// both ends (ICE_TIMEOUT_MS, 4s each in net.js), then the connect — or a
	// rejoin that was about to succeed is told nobody answered.
	const JOIN_ANSWER_MS = 30000;
	// A peer announced as back on the server while we still hold a link to
	// them is usually a reload whose old link has not closed yet (it does
	// within seconds). Look again this often, this many times, before
	// concluding the link is genuinely live and no offer is needed. 12s
	// covers the slowest close net.js measured (a killed tab: 11s, see
	// DISCONNECT_GRACE_MS) and leaves JOIN_ANSWER_MS its margin.
	const STALE_LINK_POLL_MS = 1000;
	const STALE_LINK_POLLS = 12;
	// What an offerer sends, in place of an offer, to a newcomer it cannot
	// seat because the party is full. It rides the offer relay the server
	// already has, so the server stays ignorant of parties and their sizes;
	// no packed signal can ever equal it.
	const FULL_SDP = "full";
	// Reconnecting the signalling socket: quick at first, capped later. The
	// mesh does not notice any of this — only the next newcomer's offer and
	// our own rejoin claim ride this socket, so a slow retry costs nobody a
	// game turn.
	const RETRY_FIRST_MS = 1000;
	const RETRY_CAP_MS = 30000;
	// net.js's onLeave reasons that mean "I am giving the seat back": a
	// deliberate leave, an eviction, the party being deleted. A reload never
	// calls onLeave at all, so its seat stays claimed for the rejoin.
	const RELEASING = new Set(["left", "evicted", "closed"]);

	const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
	/** Random id/secret material: member ids for claims, secrets for the same. */
	const randToken = (n = 12) =>
		[...crypto.getRandomValues(new Uint8Array(n))]
			.map((b) => ALPHABET[b % ALPHABET.length])
			.join("");

	/** The room-server base URL for this session, or "" when there is none. */
	function resolveBase() {
		let base = NeonArcade.roomServerUrl || "";
		try {
			base = new URLSearchParams(location.search).get("rs") || localStorage.getItem("neon.rs") || base;
		} catch {}
		// WebSocket wants ws(s)://. Newer browsers accept http(s):// too, older
		// ones throw a SyntaxError — so the conversion is done here, once.
		return base.replace(/\/+$/, "").replace(/^http/, "ws");
	}

	/** The mock server tests drive this code against — see makeMockRoomServer. */
	function mock() {
		return window.__neonRoomMock ?? null;
	}

	const ERRORS = {
		aborted: "The join was cancelled.",
		"no-room": "That party is no longer meeting — its code expired or the party ended.",
		"bad-code": "That is not a six-digit party code.",
		"id-taken": "Somebody else answered for that seat. Ask them to reconnect instead.",
		full: "That party is full.",
		blocked: "Too many attempts. Wait a few minutes and try again.",
		unreachable: "Could not reach the room server.",
		taken: "Could not find a free code. Try again in a moment.",
		"no-answer": "Nobody in that party answered. It may have ended, or your networks cannot reach each other.",
	};
	const failure = (reason) => Object.assign(new Error(ERRORS[reason] ?? reason), { reason });

	/**
	 * Open the signalling socket — to the room server, or to the mock, which
	 * is the same protocol in one page — send `hello`, and wait for the one
	 * reply that settles it. Resolves { ws, reply } on "room", "joined" or
	 * "pong"; rejects with the protocol's reason on an error reply, and
	 * "unreachable" on a socket that could not be made, died first, or
	 * stayed silent past `timeoutMs`. Every failure is a verdict; none is a
	 * wait.
	 */
	function dial(code, hello, timeoutMs = DIAL_TIMEOUT_MS) {
		return new Promise((resolve, reject) => {
			let ws;
			let settled = false;
			const fail = (reason) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				try {
					ws?.close();
				} catch {}
				reject(failure(reason));
			};
			const timer = setTimeout(() => fail("unreachable"), timeoutMs);
			try {
				ws = mock() ? mock().connect(`/room/${code}`) : new WebSocket(`${resolveBase()}/room/${code}`);
			} catch {
				return fail("unreachable");
			}
			ws.onopen = () => ws.send(JSON.stringify({ ...hello, code }));
			ws.onmessage = (e) => {
				let msg;
				try {
					msg = JSON.parse(e.data);
				} catch {
					return;
				}
				if (msg.t === "error") return fail(msg.reason);
				if (settled || !["room", "joined", "pong"].includes(msg.t)) return;
				settled = true;
				clearTimeout(timer);
				resolve({ ws, reply: msg });
			};
			ws.onclose = () => fail("unreachable");
			ws.onerror = () => {}; // onclose follows; one verdict is enough
		});
	}

	let probedOk = false;
	/**
	 * Is the room server reachable? Asked before offering the code-join UI,
	 * because a dead server behind a live-looking button is an indefinite
	 * wait — the exact failure this project refuses. The probe is a `ping`
	 * to a code no room can have: it touches no room and counts against no
	 * rate limit, so a player browsing page to page cannot block themselves.
	 *
	 * Success is cached; failure is not, so a network that comes up later in
	 * the session is noticed without a reload.
	 */
	NeonArcade.roomServerReachable = () => {
		if (probedOk) return Promise.resolve(true);
		if (!mock() && !resolveBase()) return Promise.resolve(false);
		return dial("000000", { t: "ping" }, PROBE_TIMEOUT_MS).then(
			({ ws }) => {
				try {
					ws.close();
				} catch {}
				return (probedOk = true);
			},
			() => false,
		);
	};

	// ------------------------------------------------------------ the token

	/**
	 * The rejoin token: proof this browser has a seat in a room. Written on
	 * every host/join, cleared when we leave or the room is gone. It is what
	 * turns a reload from a re-invite into a reconnect: the id is the seat, the
	 * secret is the claim on it, and neither crosses the mesh — only the room
	 * server ever sees the secret, hashed at that.
	 */
	function readToken() {
		try {
			const raw = localStorage.getItem("neon.room");
			const t = raw ? JSON.parse(raw) : null;
			if (t && /^\d{6}$/.test(t.code ?? "") && t.id && t.secret) return t;
		} catch {}
		return null;
	}
	function writeToken(token) {
		try {
			localStorage.setItem("neon.room", JSON.stringify(token));
		} catch {}
	}
	function clearToken() {
		try {
			localStorage.removeItem("neon.room");
		} catch {}
	}
	NeonArcade.rejoinToken = readToken;
	/** Drop the rejoin token — "start fresh" on the reconnect screen. */
	NeonArcade.clearRejoinToken = clearToken;

	// ------------------------------------------------------------- the room

	/**
	 * Host or join a room by code, then keep the signalling socket alive
	 * alongside the mesh it handed the newcomer to. One wiring serves host,
	 * join and rejoin; only the dial differs. A join resolves once the first
	 * data channel to the party is open — "joined" from the server only means
	 * the code was right, not that anybody is there to answer.
	 */
	async function makeRoom(code, { role, id, secret, rejoin = false, opts }) {
		if (!mock() && !resolveBase()) throw failure("unreachable");
		const { signal } = opts;
		if (signal?.aborted) throw failure("aborted");
		let ws;
		try {
			({ ws } = await dial(code, { t: role, id, secret }));
		} catch (err) {
			throw signal?.aborted ? failure("aborted") : err;
		}
		if (signal?.aborted) {
			// Cancelled while dialling: the server has just seated us, so
			// hand the seat straight back rather than leave it to the TTL.
			clearToken();
			try {
				ws.send(JSON.stringify({ t: "leave", id, secret }));
				ws.close();
			} catch {}
			throw failure("aborted");
		}

		let dead = false;
		let retry = RETRY_FIRST_MS;
		// The live signalling socket — replaced on each redial, so the one
		// onLeave must close is always the current one.
		let current = ws;
		// Members this wire has an offer out to: the guard that stops one
		// arrival minting two invites. It is cleared the moment the offer is
		// settled either way — the link opened, the peer's socket dropped, the
		// invite could not be made, our own socket was replaced — so a member
		// who reconnects a second and a third time is offered to every time.
		const inflight = new Set();
		// Members announced as back while a link to them still looks alive,
		// watched until it closes (see STALE_LINK_POLL_MS).
		const watching = new Set();
		// Every member this wire linked through the room server, either end of
		// the offer. Their seat holds through a reload (`member.rs`); a
		// scan/paste member keeps the shorter fuse.
		const viaServer = new Set();
		// A rejoin nobody answered keeps its claim: the party may only be
		// slow, and the token is what RETRY and the next reload reconnect
		// with. Only that one exit sets this; every other leave releases.
		let holding = false;
		// A join's verdict, settled once: "ok", or the reason it failed.
		// Null for a host, which has nobody to wait for.
		let settleJoin = null;
		const joined = role === "join" ? new Promise((resolve) => (settleJoin = resolve)) : null;
		const settle = (outcome) => {
			const done = settleJoin;
			settleJoin = null;
			done?.(outcome);
		};
		/**
		 * In a party means a link open *and* a host known. A link alone is
		 * not enough: two members who both arrive with no record — a lone
		 * host back from a reload, and a newcomer who typed the code
		 * meanwhile — link to each other and neither has a host to name.
		 * Nobody crowns here: a crown minted at term 0 could outrank the real
		 * party's record later. The host is learned from a record (`__p`),
		 * or the deadline says nobody answered.
		 */
		const checkJoined = () => {
			if (room && room.directPeers().length && room.hostId() !== null) settle("ok");
		};

		const markRs = (peerId) => {
			const member = room?.party?.members?.find((m) => m.id === peerId);
			if (member && viaServer.has(peerId)) member.rs = true;
		};

		// The token dies with the room, and the socket dies with the room:
		// onLeave is the one hook net.js promises on every deliberate exit
		// (leave(), eviction, party-closed), so this is the one place to
		// detach in — and the one place a seat is handed back to the server,
		// so a long party's departed members do not fill it up.
		const onLeave = (reason) => {
			if (!holding) clearToken();
			dead = true;
			if (!holding && RELEASING.has(reason)) {
				try {
					current.send(JSON.stringify({ t: "leave", id, secret }));
				} catch {} // mid-redial: the claim lapses with the TTL instead
			}
			try {
				current.close();
			} catch {}
			opts.onLeave?.(reason);
		};
		const onOpen = (peerId) => {
			inflight.delete(peerId);
			markRs(peerId);
			checkJoined();
			opts.onOpen?.(peerId);
		};
		const onPeerJoin = (peerId) => {
			markRs(peerId);
			opts.onPeerJoin?.(peerId);
		};
		const onParty = (...args) => {
			checkJoined();
			opts.onParty?.(...args);
		};

		const roomOpts = { ...opts, selfId: id, onLeave, onOpen, onPeerJoin, onParty };
		delete roomOpts.signal;
		const room = role === "host" ? NeonArcade.createHost(roomOpts) : NeonArcade.createGuest(roomOpts);

		/**
		 * Offer to a member the server says we should — exactly the role any
		 * member plays when they stand next to a newcomer and press ADD
		 * PLAYER. A link we still hold to them is either live (a signalling
		 * hiccup: no offer needed, the link outranks the server) or the
		 * leftover of a reload that has not closed yet; we cannot tell which
		 * at once, so we watch it for a while and offer the moment it closes.
		 */
		const offerTo = (peerId, polls = 0) => {
			if (dead || room.closed || inflight.has(peerId)) return;
			if (room.directPeers().includes(peerId)) {
				if (polls === 0 && watching.has(peerId)) return;
				if (polls >= STALE_LINK_POLLS) return void watching.delete(peerId);
				watching.add(peerId);
				setTimeout(() => offerTo(peerId, polls + 1), STALE_LINK_POLL_MS);
				return;
			}
			watching.delete(peerId);
			inflight.add(peerId);
			viaServer.add(peerId);
			const socket = current;
			room
				// Naming the peer lets a member who already holds a seat back
				// into a party that is full with them in it.
				.createInvite({ forPeer: peerId })
				.then(({ code: sdp }) => socket.send(JSON.stringify({ t: "offer", to: peerId, sdp })))
				.catch((err) => {
					// No offer went out, so nothing is in flight and the next
					// notice may retry. A full party says so, or the newcomer
					// would wait out the deadline and hear "nobody answered".
					inflight.delete(peerId);
					if (err?.reason === "full") {
						try {
							socket.send(JSON.stringify({ t: "offer", to: peerId, sdp: FULL_SDP }));
						} catch {}
					}
				});
		};

		/**
		 * The signalling socket dropped without the room leaving — a server
		 * restart, a flaky network, an eviction. The mesh does not care; only
		 * our future rejoin claim and the next newcomer's offer ride this
		 * socket, so quietly re-dial with the same claim and carry on. A room
		 * that ended answers "no-room", and that is the one answer that stops
		 * the loop rather than scheduling the next one.
		 */
		const redial = () => {
			if (dead || room.closed) return;
			const delay = retry;
			retry = Math.min(retry * 2, RETRY_CAP_MS);
			setTimeout(async () => {
				if (dead || room.closed) return;
				try {
					const again = await dial(code, { t: "join", id, secret });
					if (dead || room.closed) return void again.ws.close();
					retry = RETRY_FIRST_MS;
					current = again.ws;
					wire(again.ws);
				} catch (err) {
					// An unreachable server is worth another try; a room that
					// refused us ("no-room", "full", "blocked") will refuse
					// the next try too, so that is the answer, not a loop.
					if (err.reason === "unreachable") return redial();
					dead = true;
					if (err.reason === "no-room") clearToken();
					room.onError?.(err.message);
				}
			}, delay);
		};

		/**
		 * The room server's messages, in net.js terms. Every path here ends
		 * in an existing net.js method — the offer is the same packed string
		 * a human used to carry, which is why the scan/paste flow and this
		 * one can never drift apart.
		 */
		const wire = (socket) => {
			// Offers made on the previous socket went to a server that has
			// since forgotten it; whoever is still waiting will be announced
			// again, and must find no stale guard in the way.
			inflight.clear();
			socket.onmessage = (e) => {
				let msg;
				try {
					msg = JSON.parse(e.data);
				} catch {
					return;
				}
				if (msg.t === "peer") {
					room.serverPeerState(msg.id, msg.connected);
					if (!msg.connected) inflight.delete(msg.id);
					else if (msg.offering === room.selfId) offerTo(msg.id);
				} else if (msg.t === "offer" && msg.sdp === FULL_SDP) {
					// Only news while we are still waiting to get in; a member
					// already inside has nothing to learn from it.
					settle("full");
				} else if (msg.t === "offer") {
					// Somebody is offering us a link: answer exactly as the
					// `#i=` flow does.
					viaServer.add(msg.from);
					room
						.answerInvite(msg.sdp)
						.then((sdp) => socket.send(JSON.stringify({ t: "answer", to: msg.from, sdp })))
						.catch(() => {}); // a malformed offer: the offerer can re-offer
				} else if (msg.t === "answer") {
					room.acceptAnswer(msg.sdp).catch(() => {}); // stale slot: ignored, as a stale paste is
				}
			};
			socket.onclose = () => {
				if (socket === current) redial();
			};
			socket.onerror = () => {}; // onclose handles it; one verdict is enough
		};

		wire(ws);
		writeToken({ code, id, secret });

		if (joined) {
			const timer = setTimeout(() => settle("no-answer"), opts.answerTimeoutMs ?? JOIN_ANSWER_MS);
			// Synchronous on purpose: by the time abort() returns, the seat has
			// been handed back and the token is gone, so a caller that
			// navigates straight after leaves nothing claimed behind it.
			const onAbort = () => {
				if (!settleJoin) return;
				settle("aborted");
				room.leave();
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			const outcome = await joined;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			if (outcome !== "ok") {
				// A rejoin nobody answered keeps its seat and its token (see
				// `holding`). A first join gives the seat back rather than
				// hold it for a party that is not there; a full party has no
				// seat to keep.
				if (outcome === "no-answer" && rejoin) holding = true;
				room.leave(); // a no-op after an abort, which already left
				throw failure(outcome);
			}
		}
		return { room, code };
	}

	/**
	 * Host a room and draw its code. The client draws the code, not the
	 * server: a collision answers "taken" and this redraws, which is one
	 * retry on a one-in-a-million event rather than a server-side mint
	 * nobody can check.
	 */
	NeonArcade.hostRoom = async (opts = {}) => {
		const secret = randToken();
		for (let attempt = 0; attempt < 3; attempt++) {
			const code = String(100000 + Math.floor(Math.random() * 900000));
			try {
				return await makeRoom(code, { role: "host", id: randToken(), secret, opts });
			} catch (err) {
				if (err.reason !== "taken") throw err;
			}
		}
		throw failure("taken");
	};

	/**
	 * Join a room by its code. A token for this same code means a rejoin:
	 * the old member id is adopted rather than minted, so the seat, the
	 * team and the name the party record still holds are the ones that come
	 * back. A different token is simply overwritten — a browser that joins a
	 * new party has left the old one.
	 *
	 * Resolves once a data channel to the party is open *and* the party has
	 * a host this browser knows of; rejects with `err.reason` "no-answer" if
	 * that has not happened within `opts.answerTimeoutMs` (default
	 * JOIN_ANSWER_MS) of the server's "joined", and "full" if the member
	 * asked to offer says the party has no seat. A rejoin's "no-answer"
	 * keeps the claim and the token, for a retry; every other failure gives
	 * the seat back.
	 *
	 * `opts.signal` (an AbortSignal) cancels a join still in progress: the
	 * seat is released, the token cleared, and the promise rejects
	 * "aborted".
	 */
	NeonArcade.joinRoom = async (code, opts = {}) => {
		if (!/^\d{6}$/.test(code ?? "")) throw failure("bad-code");
		const token = readToken();
		const rejoin = token?.code === code;
		const id = rejoin ? token.id : randToken();
		const secret = rejoin ? token.secret : randToken();
		return makeRoom(code, { role: "join", id, secret, rejoin, opts });
	};

	/**
	 * Give back the seat the rejoin token claims, and drop the token. For a
	 * page that holds a claim but no room — a rejoin nobody answered — and
	 * is about to start over: without this the old party keeps a seat for a
	 * browser that will never come back to it, until the TTL. Best-effort
	 * and bounded; a server that cannot be reached lets the claim lapse.
	 */
	NeonArcade.releaseRejoin = async () => {
		const token = readToken();
		clearToken();
		if (!token || (!mock() && !resolveBase())) return;
		try {
			const { ws } = await dial(token.code, { t: "join", id: token.id, secret: token.secret }, PROBE_TIMEOUT_MS);
			ws.send(JSON.stringify({ t: "leave", id: token.id, secret: token.secret }));
			ws.close();
		} catch {}
	};

	/** A room code handed over as a link fragment, like the invite's `#i=`. */
	NeonArcade.codeFromUrl = () => location.hash.match(/[#&]c=(\d{6})/)?.[1] ?? null;

	// ------------------------------------------------------------- the mock

	/**
	 * An in-page room server for the tests: the real protocol, the real
	 * client, no network. It mirrors the rules of worker/hub.js the client
	 * can observe — codes, claims, release, notices with `offering` (the
	 * oldest attached member other than the subject), offer/answer relay,
	 * socket drops as `connected:false` — and deliberately not the ones only
	 * a server under attack or a clock can exhibit (rate limits, TTLs,
	 * pruning), which scripts/test-hub.mjs covers against the real hub.
	 * (It cannot simply *be* hub.js: that is an ES module, and module
	 * scripts do not load on file://.)
	 *
	 * `drop(id)` kills a member's socket from the server side, which is what
	 * a reload or a dead network looks like to everyone else.
	 */
	function makeMockRoomServer() {
		const rooms = new Map(); // code -> Map(id -> { id, secret, socket, joinedAt })

		const send = (socket, msg) => setTimeout(() => socket.onmessage?.({ data: JSON.stringify(msg) }), 0);
		const announce = (room, member) => {
			const others = [...room.values()]
				.filter((m) => m.socket && m.id !== member.id)
				.sort((a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : 1));
			if (!others.length) return;
			const msg = { t: "peer", id: member.id, connected: !!member.socket, offering: others[0].id };
			for (const m of others) send(m.socket, msg);
		};
		const attach = (room, socket, { id, secret }) => {
			let member = room.get(id);
			if (member && member.secret !== secret) return { t: "error", reason: "id-taken" };
			if (!member) {
				if (room.size >= 8) return { t: "error", reason: "full" };
				member = { id, secret, joinedAt: Date.now() };
				room.set(id, member);
			}
			member.socket = socket;
			announce(room, member);
			return null;
		};

		return {
			rooms,
			drop(id) {
				for (const room of rooms.values()) room.get(id)?.socket?.close();
			},
			connect(path) {
				const code = path.match(/\/room\/(\d{6})$/)?.[1];
				const ws = {
					readyState: 0,
					onopen: null,
					onmessage: null,
					onclose: null,
					onerror: null,
					send(raw) {
						let msg;
						try {
							msg = JSON.parse(raw);
						} catch {
							return;
						}
						const room = rooms.get(code);
						const me = [...(room?.values() ?? [])].find((m) => m.socket === ws);
						if (msg.t === "ping") {
							send(ws, { t: "pong" });
						} else if ((msg.t === "host" || msg.t === "join") && msg.code !== code) {
							send(ws, { t: "error", reason: "bad-code" });
						} else if (msg.t === "host") {
							if (room) return send(ws, { t: "error", reason: "taken" });
							const fresh = new Map();
							rooms.set(code, fresh);
							const refused = attach(fresh, ws, msg);
							if (refused) rooms.delete(code);
							send(ws, refused ?? { t: "room", code });
						} else if (msg.t === "join") {
							if (!room) return send(ws, { t: "error", reason: "no-room" });
							send(ws, attach(room, ws, msg) ?? { t: "joined" });
						} else if (msg.t === "offer" || msg.t === "answer") {
							const to = room?.get(msg.to);
							if (me && to?.socket) send(to.socket, { t: msg.t, from: me.id, sdp: msg.sdp });
						} else if (msg.t === "leave") {
							if (me && me.id === msg.id && me.secret === msg.secret) {
								room.delete(me.id);
								me.socket = null;
								announce(room, me);
								if (!room.size) rooms.delete(code);
							}
							ws.close();
						}
					},
					close() {
						if (ws.readyState === 3) return;
						ws.readyState = 3;
						// Find this socket's member by the socket, not an id the
						// closer no longer has: a probe or a dead socket has none.
						for (const m of rooms.get(code)?.values() ?? []) {
							if (m.socket === ws) {
								m.socket = null;
								announce(rooms.get(code), m);
							}
						}
						setTimeout(() => ws.onclose?.(), 0);
					},
				};
				setTimeout(() => {
					if (ws.readyState !== 3) {
						ws.readyState = 1;
						ws.onopen?.();
					}
				}, 0);
				return ws;
			},
		};
	}

	// The test hook: with ?mockroom=1 the page carries its own room server,
	// so every client path above runs without a deploy. The fake camera in
	// test-scan.mjs is the precedent: the real code under test, the transport
	// faked, no network involved. A deployed page never carries the param,
	// and a user who types it in gets a server that talks to nobody but
	// their own tab.
	if (new URLSearchParams(location.search).has("mockroom")) {
		window.__neonRoomMock = makeMockRoomServer();
	}
})();
