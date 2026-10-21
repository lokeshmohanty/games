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
	// Reconnecting the signalling socket: quick at first, capped later. The
	// mesh does not notice any of this — only the next newcomer's offer and
	// our own rejoin claim ride this socket, so a slow retry costs nobody a
	// game turn.
	const RETRY_FIRST_MS = 1000;
	const RETRY_CAP_MS = 30000;

	const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
	/** Random id/secret material: member ids for claims, secrets for the same. */
	const randToken = (n = 12) =>
		[...crypto.getRandomValues(new Uint8Array(n))]
			.map((b) => ALPHABET[b % ALPHABET.length])
			.join("");

	/** The room-server base URL for this session, or "" when there is none. */
	function resolveBase() {
		try {
			const q = new URLSearchParams(location.search).get("rs");
			if (q) return q.replace(/\/+$/, "");
			const stored = localStorage.getItem("neon.rs");
			if (stored) return stored.replace(/\/+$/, "");
		} catch {}
		return (NeonArcade.roomServerUrl || "").replace(/\/+$/, "");
	}

	/** The mock server tests drive this code against — see makeMockRoomServer. */
	function mock() {
		return window.__neonRoomMock ?? null;
	}

	/**
	 * A socket to the room server — or to the mock, which is the same
	 * protocol in one page. The mock is how every client path here is testable
	 * without a deploy, the same way a fake capture device makes the scanner
	 * testable without a camera.
	 */
	function openSocket(base, code) {
		return mock() ? mock().connect(`/room/${code}`) : new WebSocket(`${base}/room/${code}`);
	}

	let probedOk = false;
	/**
	 * Is the room server reachable? Asked before offering the code-join UI,
	 * because a dead server behind a live-looking button is an indefinite
	 * wait — the exact failure this project refuses. The probe joins an
	 * impossible room and takes *any* answer as proof of life; a server that
	 * answers at all is a server that will answer a real join.
	 *
	 * Success is cached; failure is not, so a network that comes up later in
	 * the session is noticed without a reload.
	 */
	NeonArcade.roomServerReachable = () => {
		if (probedOk) return Promise.resolve(true);
		if (mock()) return Promise.resolve(true);
		const base = resolveBase();
		if (!base) return Promise.resolve(false);
		return new Promise((resolve) => {
			let settled = false;
			const finish = (ok) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (ok) probedOk = true;
				resolve(ok);
			};
			const ws = new WebSocket(`${base}/room/000000`);
			const timer = setTimeout(() => {
				try {
					ws.close();
				} catch {}
				finish(false);
			}, PROBE_TIMEOUT_MS);
			ws.onopen = () =>
				ws.send(JSON.stringify({ t: "join", code: "000000", id: "probe", secret: "probe" }));
			ws.onmessage = () => {
				try {
					ws.close();
				} catch {}
				finish(true);
			};
			ws.onclose = () => finish(false);
			ws.onerror = () => {}; // onclose follows; one verdict is enough
		});
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

	// ------------------------------------------------------------ the dial

	const ERRORS = {
		"no-room": "That party is no longer meeting — its code expired or the party ended.",
		"bad-code": "That is not a six-digit party code.",
		"id-taken": "Somebody else answered for that seat. Ask them to reconnect instead.",
		full: "That party is full.",
		blocked: "Too many attempts. Wait a few minutes and try again.",
		unreachable: "Could not reach the room server. The invite flow below still works.",
		taken: "Could not find a free code. Try again in a moment.",
	};

	/**
	 * Open the signalling socket and complete one host/join exchange.
	 * Resolves { ws, reply } on "room"/"joined"; rejects with the protocol
	 * reason on an error reply, "unreachable" on a socket that died first.
	 */
	function dial(code, { role, id, secret, name }) {
		return new Promise((resolve, reject) => {
			let settled = false;
			const fail = (reason) => {
				if (settled) return;
				settled = true;
				try {
					ws.close();
				} catch {}
				reject(Object.assign(new Error(ERRORS[reason] ?? reason), { reason }));
			};
			const ws = openSocket(resolveBase(), code);
			ws.onopen = () => ws.send(JSON.stringify({ t: role, code, id, secret, name }));
			ws.onmessage = (e) => {
				let msg;
				try {
					msg = JSON.parse(e.data);
				} catch {
					return;
				}
				if (msg.t === "room" || msg.t === "joined") {
					if (settled) return;
					settled = true;
					resolve({ ws, reply: msg });
				} else if (msg.t === "error") {
					fail(msg.reason);
				}
			};
			ws.onclose = () => fail("unreachable");
			ws.onerror = () => {};
		});
	}

	/** The room server's ICE plus any the caller had — deduped, never dropped. */
	function mergeIce(reply, userIce) {
		const servers = [...(reply?.ice?.servers ?? []), ...(userIce ?? [])];
		const seen = new Set();
		return servers.filter((s) => {
			const key = JSON.stringify([s.urls, s.username]);
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	}

	/**
	 * Host or join a room by code, then keep the signalling socket alive
	 * alongside the mesh it handed the newcomer to. One wiring serves host,
	 * join and rejoin; only the dial differs.
	 */
	async function makeRoom(code, { role, id, secret, opts }) {
		if (!mock() && !resolveBase()) {
			throw Object.assign(new Error(ERRORS.unreachable), { reason: "unreachable" });
		}
		const displayName = opts.name || NeonArcade.defaultName();
		const { ws, reply } = await dial(code, { role, id, secret, name: displayName });
		const ice = mergeIce(reply, opts.iceServers);
		const token = { code, id, secret };

		let dead = false;
		let retry = RETRY_FIRST_MS;
		// The live signalling socket — replaced on each redial, so the one
		// onLeave must close is always the current one.
		let current = ws;
		// Newcomers this socket has already offered to, so a re-announced
		// arrival (a reconnect cycle on the server) cannot mint two invites
		// for one seat.
		const offered = new Set();

		// The token dies with the room, and the socket dies with the room:
		// onLeave is the one hook net.js promises on every exit path
		// (leave(), eviction, party-closed), so this is the one place to
		// detach in.
		const onLeave = () => {
			clearToken();
			dead = true;
			try {
				current.close();
			} catch {}
			opts.onLeave?.();
		};
		// A link that opened retires the offer guard, so a newcomer whose first
		// offer went nowhere can be offered to again.
		const onPeerJoin = (peerId) => {
			// A peer whose offer this wire made is one who joined through the
			// room server: their seat holds through a reload, and the room
			// server's word on their socket is worth marking. Scan/paste
			// members are not in `offered`, and keep the shorter fuse.
			if (offered.has(peerId)) {
				const member = room?.party?.members?.find((m) => m.id === peerId);
				if (member) member.rs = true;
			}
			offered.delete(peerId);
			opts.onPeerJoin?.(peerId);
		};

		const room =
			role === "host"
				? NeonArcade.createHost({ ...opts, name: displayName, selfId: id, iceServers: ice, onLeave, onPeerJoin })
				: NeonArcade.createGuest({
						...opts,
						name: displayName,
						selfId: id,
						iceServers: ice,
						onLeave,
						onPeerJoin,
				  });

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
					const again = await dial(code, { role: "join", id, secret, name: displayName });
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
			socket.onmessage = (e) => {
				let msg;
				try {
					msg = JSON.parse(e.data);
				} catch {
					return;
				}
				if (msg.t === "peer") {
					room.serverPeerState(msg.id, msg.connected);
					// We are the oldest attached member, so we do the offering —
					// exactly the role any member plays when they stand next to
					// a newcomer and press ADD PLAYER.
					if (
						msg.offering === room.selfId &&
						msg.id !== room.selfId &&
						msg.connected &&
						!room.directPeers().includes(msg.id) &&
						!NeonArcade.isBotId(msg.id) &&
						!offered.has(msg.id)
					) {
						offered.add(msg.id);
						room
							.createInvite()
							.then(({ code: sdp }) =>
								socket.send(JSON.stringify({ t: "offer", to: msg.id, sdp })),
							)
							.catch(() => {}); // party full: there is no offer to make
					}
				} else if (msg.t === "offer") {
					// We are the newcomer: answer exactly as the `#i=` flow does.
					room
						.answerInvite(msg.sdp)
						.then((sdp) =>
							socket.send(JSON.stringify({ t: "answer", to: msg.from, sdp })),
						)
						.catch(() => {}); // a malformed offer: the offerer can re-offer
				} else if (msg.t === "answer") {
					room.acceptAnswer(msg.sdp).catch(() => {}); // stale slot: ignored, as a stale paste is
				} else if (msg.t === "error" && msg.reason === "no-room") {
					// The room died while we were away from it: the token is a
					// promise nobody can keep now.
					dead = true;
					clearToken();
					room.onError?.(ERRORS["no-room"]);
				}
			};
			socket.onclose = redial;
			socket.onerror = () => {}; // onclose handles it; one verdict is enough
		};

		wire(ws);
		writeToken(token);
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
		throw Object.assign(new Error(ERRORS.taken), { reason: "taken" });
	};

	/**
	 * Join a room by its code. A token for this same code means a rejoin:
	 * the old member id is adopted rather than minted, so the seat, the
	 * team and the name the party record still holds are the ones that come
	 * back. A different token is simply overwritten — a browser that joins a
	 * new party has left the old one.
	 */
	NeonArcade.joinRoom = async (code, opts = {}) => {
		if (!/^\d{6}$/.test(code ?? "")) {
			throw Object.assign(new Error(ERRORS["bad-code"]), { reason: "bad-code" });
		}
		const token = readToken();
		const rejoin = token?.code === code;
		const id = rejoin ? token.id : randToken();
		const secret = rejoin ? token.secret : randToken();
		return makeRoom(code, { role: "join", id, secret, opts });
	};

	/** A room code handed over as a link fragment, like the invite's `#i=`. */
	NeonArcade.codeFromUrl = () => location.hash.match(/[#&]c=(\d{6})/)?.[1] ?? null;

	// ------------------------------------------------------------- the mock

	/**
	 * An in-page room server for the tests: the real protocol, the real
	 * client, no network. It implements the rules the client can observe —
	 * codes, claims, notices with `offering`, offer/answer relay, socket
	 * drops as `connected:false` — and deliberately not the ones only a
	 * server under attack can exhibit (rate limits, TTLs), which
	 * scripts/test-hub.mjs covers against the real hub instead.
	 *
	 * Installed by `?mockroom=1` or by hand, and nothing happens without it:
	 * a deployed page never carries the param, and a user who types it in
	 * gets a server that talks to nobody but their own tabs.
	 */
	NeonArcade.makeMockRoomServer = () => {
		const rooms = new Map(); // code -> Map(id -> { secret, socket, joinedAt })

		const send = (socket, msg) => {
			if (socket && socket.onmessage) {
				setTimeout(() => socket.onmessage({ data: JSON.stringify(msg) }), 0);
			}
		};
		const attached = (room) => [...room.values()].filter((m) => m.socket);
		const offering = (room) => {
			const rank = [...attached(room)].sort(
				(a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : 1),
			);
			return rank[0]?.id ?? null;
		};
		const notice = (room, member, { rejoin }) => {
			const msg = {
				t: "peer",
				id: member.id,
				name: member.name,
				rejoin,
				connected: !!member.socket,
				offering: offering(room),
			};
			for (const m of attached(room)) if (m.id !== member.id) send(m.socket, msg);
		};
		const join = (code, id, secret, name, socket, reply) => {
			let room = rooms.get(code);
			if (!room) return { t: "error", reason: "no-room" };
			const member = room.get(id);
			if (member && member.secret !== secret) return { t: "error", reason: "id-taken" };
			if (!member) {
				if (room.size >= 8) return { t: "error", reason: "full" };
				room.set(id, { id, secret, name, socket, joinedAt: Date.now() });
			} else {
				member.socket = socket;
				member.name = name ?? member.name;
			}
			const m = room.get(id);
			notice(room, m, { rejoin: !!member });
			return reply;
		};

		return {
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
						const me = room?.get(msg.id);
						if (msg.t === "host") {
							if (rooms.has(code)) {
								return send(ws, { t: "error", reason: "taken" });
							}
							rooms.set(code, new Map());
							send(ws, join(code, msg.id, msg.secret, msg.name, ws, { t: "room", code, ttl: 900, ice: { servers: [] } }));
						} else if (msg.t === "join") {
							if (msg.code !== code) return send(ws, { t: "error", reason: "bad-code" });
							send(ws, join(code, msg.id, msg.secret, msg.name, ws, { t: "joined", ice: { servers: [] } }));
					} else if (msg.t === "offer" || msg.t === "answer") {
						const to = room?.get(msg.to);
						// The sender is whichever member this socket speaks for.
						const from = [...(room?.values() ?? [])].find((m) => m.socket === ws)?.id;
						if (to?.socket) send(to.socket, { t: msg.t, from, sdp: msg.sdp });
					} else if (msg.t === "leave") {
							ws.close();
						}
					},
					close() {
						if (this.readyState === 3) return;
						this.readyState = 3;
						const room = rooms.get(code);
						// Find this socket's member by the socket, not an id the
						// closer no longer has: a probe or a dead socket has none.
						for (const m of room?.values() ?? []) {
							if (m.socket === ws) {
								m.socket = null;
								notice(room, m, { rejoin: false });
							}
						}
						if (this.onclose) setTimeout(() => this.onclose(), 0);
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
	};

	// The test hook: with ?mockroom=1 the page carries its own room server,
	// so every client path above runs without a deploy. The fake camera in
	// test-scan.mjs is the precedent: the real code under test, the transport
	// faked, no network involved.
	if (new URLSearchParams(location.search).has("mockroom")) {
		window.__neonRoomMock = NeonArcade.makeMockRoomServer();
	}
})();
