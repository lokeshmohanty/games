// worker/hub.js — the room hub: pure signalling logic, no Cloudflare imports.
//
// This is the brain the Durable Object in index.js drives; keeping it free of
// platform code is what lets scripts/test-hub.mjs exercise every rule with
// zero dependencies, the same trick lib/net.js plays with its fake transports.
//
// What it is not: a membership authority. The party record replicated over
// the data channels in net.js decides who is in the party. The hub only mints
// rooms, ferries packed SDP strings between sockets, holds rejoin claims, and
// reports socket state. Its notices are advisory — a client that still holds a
// live mesh link to a "connected:false" member ignores the notice, because
// the link is the truth and the socket is not. (Without this rule a dropped
// room-server socket would demote a member whose game connection never broke.)
//
// The sdp strings it relays are the packed invite/reply codes from net.js's
// packSignal — opaque here, and never shortened or parsed, for the same reason
// the codec never drops candidates: the one path a pair could have used is
// often the one that looks useless.

// Rooms die when nobody has signalled for this long (15 minutes).
const ROOM_TTL_MS = 15 * 60 * 1000;
// No room outlives this, attached sockets or not, so a forgotten party cannot
// hold a 6-digit code hostage forever (24 hours).
const ROOM_CAP_MS = 24 * 60 * 60 * 1000;
// The party cap in net.js is 8 members; the hub mirrors it on claims, not on
// live sockets, so a member whose socket dropped keeps their claim and can
// always reconnect into their own seat.
const MAX_MEMBERS = 8;
// A failed join (unknown code, wrong claim secret) counts against the sender's
// IP. The 6-digit space is small enough to guess at, so the limit is what
// makes a live code hard to find within its TTL; 10 failures per 5 minutes
// lets a mistyping friend through and stops a loop of guesses.
const JOIN_FAILS = 10;
const JOIN_FAIL_WINDOW_MS = 5 * 60 * 1000;

/** Hex SHA-256 of a string, via the WebCrypto every runtime here provides. */
async function sha256(str) {
	const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
	return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * @param {object} adapter  `{ send(socket, msg) }` — how the hub talks back.
 * @param {object} [opts]
 * @param {() => object} [opts.ice]  resolved per host/join into the reply, so
 *   the shell can hand out TURN config it fetched and cached (tests pass a
 *   static object; the reply shape stays identical either way).
 * @param {() => number} [opts.now]  clock injection for the TTL tests.
 */
export function makeHub(adapter, { ice = null, now = Date.now } = {}) {
	// code -> { code, members: Map(id -> member), lastTouch, createdAt,
	//           fails: Map(ip -> { count, firstAt }) }
	// member -> { id, name, secretHash, socket, joinedAt }
	const rooms = new Map();
	// Unknown-code guesses are the brute-force path: there is no room to hang
	// a per-room counter on (the room does not exist), so they count against
	// the IP hub-wide. id-taken failures count per room instead.
	const ipFails = new Map(); // ip -> { count, firstAt }
	// The reverse index sockets are looked up by, so a relay costs one map
	// hop instead of a scan of every member of every room.
	const socketRoom = new Map(); // socket -> { room, id }

	const ipBlocked = (ip) => {
		const entry = ipFails.get(ip);
		return !!entry && entry.count >= JOIN_FAILS && now() - entry.firstAt < JOIN_FAIL_WINDOW_MS;
	};

	const recordIpFail = (ip) => {
		const entry = ipFails.get(ip);
		if (entry && now() - entry.firstAt < JOIN_FAIL_WINDOW_MS) entry.count++;
		else ipFails.set(ip, { count: 1, firstAt: now() });
	};

	const touch = (room) => {
		room.lastTouch = now();
	};

	/** A failure the sender earned: count it, maybe answer "blocked". */
	const recordFail = (room, ip) => {
		const entry = room.fails.get(ip);
		if (entry && now() - entry.firstAt < JOIN_FAIL_WINDOW_MS) entry.count++;
		else room.fails.set(ip, { count: 1, firstAt: now() });
	};

	const blocked = (room, ip) => {
		const entry = room.fails.get(ip);
		return !!entry && entry.count >= JOIN_FAILS && now() - entry.firstAt < JOIN_FAIL_WINDOW_MS;
	};

	/**
	 * Everyone attached hears about everyone's socket state, except the
	 * member the notice is about — they already know, from their own reply.
	 * `offering` names the member who should issue the WebRTC offer: the
	 * oldest attached member, ties broken by id so every peer that hears the
	 * notice nominates the same one. Oldest, not "the host", so the rule
	 * survives host succession exactly the way the crown does.
	 */
	const announce = (room, member, { rejoin }) => {
		const attached = [...room.members.values()]
			.filter((m) => m.socket)
			.sort((a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : 1));
		if (!attached.length) return;
		const notice = {
			t: "peer",
			id: member.id,
			name: member.name,
			rejoin,
			connected: !!member.socket,
			offering: attached[0].id,
		};
		for (const m of attached) if (m.id !== member.id) adapter.send(m.socket, notice);
	};

	/**
	 * Attach a socket to a room. An existing claim means a rejoin: the secret
	 * hash proves it is the same browser, the seat was never released, and the
	 * answer says joined just like a first arrival did. (A live socket being
	 * replaced is the stale-socket case — last writer wins — not a second
	 * member; ids are random and unique.)
	 */
	const attach = (room, socket, ip, { id, secret, name, secretHash, ice }) => {
		const member = room.members.get(id);
		if (member) {
			if (member.secretHash !== secretHash) {
				recordFail(room, ip);
				return { t: "error", reason: "id-taken" };
			}
			member.socket = socket;
			member.name = name ?? member.name;
			socketRoom.set(socket, { room, id });
			touch(room);
			announce(room, member, { rejoin: true });
			return { t: "joined", ice };
		}
		if (room.members.size >= MAX_MEMBERS) return { t: "error", reason: "full" };
		// A new claim; the caller registers below.
		return null;
	};

	return {
		rooms,

		/**
		 * Mint a room; the caller becomes its first member and claim. The
		 * Durable Object shell passes `forcedCode` — its room is named after
		 * the code the Worker drew — and answers "taken" to a collision so
		 * the Worker can redraw and try another Durable Object. Free-running
		 * (the tests) mint inside, until a code is free: a collision is (live
		 * rooms / 10^6) likely, and the loop is cheap, and the alternative —
		 * reusing a taken code — hands one party's offers to another.
		 */
		async host(socket, ip, msg, forcedCode = null) {
			let code;
			if (forcedCode) {
				if (rooms.has(forcedCode)) return { t: "error", reason: "taken" };
				code = forcedCode;
			} else {
				do {
					code = String(100000 + Math.floor(Math.random() * 900000));
				} while (rooms.has(code));
			}
			const room = { code, members: new Map(), lastTouch: now(), createdAt: now(), fails: new Map() };
			rooms.set(code, room);
			const joined = await this.join(socket, ip, { ...msg, code });
			if (joined.t === "error") return joined;
			return { t: "room", code, ttl: Math.round(ROOM_TTL_MS / 1000), ice: joined.ice };
		},

		async join(socket, ip, msg) {
			const { code, id, secret, name } = msg;
			if (!/^\d{6}$/.test(code ?? "")) return { t: "error", reason: "bad-code" };
			if (ipBlocked(ip)) return { t: "error", reason: "blocked" };
			const room = rooms.get(code);
			if (!room) {
				// An unknown code is a guess as often as a typo, and there is
				// no room to hang a per-room counter on, so it counts hub-wide
				// against the IP. After 10 of them in 5 minutes, the answer
				// is "blocked" for a while, not another round of guesses.
				recordIpFail(ip);
				return { t: "error", reason: "no-room" };
			}
			if (blocked(room, ip)) return { t: "error", reason: "blocked" };

			const secretHash = await sha256(String(secret ?? ""));
			const iceResult = ice ? await ice() : { servers: [] };
			const taken = attach(room, socket, ip, { id, name, secretHash, ice: iceResult });
			if (taken) return taken;

			const member = { id, name, secretHash, socket, joinedAt: now() };
			room.members.set(id, member);
			socketRoom.set(socket, { room, id });
			touch(room);
			announce(room, member, { rejoin: false });
			return { t: "joined", ice: iceResult };
		},

		/** Ferry one packed string from one member to another. */
		relay(socket, msg) {
			const { t, to, sdp } = msg;
			if (t !== "offer" && t !== "answer") return;
			const here = socketRoom.get(socket);
			if (!here) return; // a socket that never joined has nothing to say
			const room = here.room;
			const toMember = room.members.get(to);
			if (!toMember?.socket) return; // dropped member: the mesh relays now
			touch(room);
			adapter.send(toMember.socket, { t, from: here.id, sdp });
		},

		/** The socket went away. The claim stays; the seat waits. */
		leave(socket) {
			const here = socketRoom.get(socket);
			if (!here) return;
			socketRoom.delete(socket);
			const { room, id } = here;
			const member = room.members.get(id);
			if (!member || member.socket !== socket) return;
			member.socket = null;
			touch(room);
			announce(room, member, { rejoin: false });
		},

		/**
		 * The persistable record of a room: claims and clocks, never sockets.
		 * The Durable Object writes this to storage after every mutation,
		 * because a claim that lived only in memory would die with the
		 * object — and a rejoin that fails because the server was evicted is
		 * exactly the brittleness the room server exists to remove.
		 */
		snapshot(code) {
			const room = rooms.get(code);
			if (!room) return null;
			return {
				code: room.code,
				lastTouch: room.lastTouch,
				createdAt: room.createdAt,
				members: [...room.members.values()].map(({ id, name, secretHash, joinedAt }) => ({
					id,
					name,
					secretHash,
					joinedAt,
				})),
			};
		},

		/** Stand a room back up from a snapshot — claims intact, sockets unbound. */
		restore(stored) {
			if (rooms.has(stored.code)) return;
			rooms.set(stored.code, {
				code: stored.code,
				members: new Map(stored.members.map((m) => [m.id, { ...m, socket: null }])),
				lastTouch: stored.lastTouch,
				createdAt: stored.createdAt,
				fails: new Map(), // five-minute windows; not worth surviving for
			});
		},

		/**
		 * Rebind a live socket to its claim after an eviction. Unannounced on
		 * purpose: everyone still attached already knows each other, and the
		 * party record over the mesh — not the hub — is the authority.
		 */
		rebind(socket, code, id) {
			const room = rooms.get(code);
			const member = id && room?.members.get(id);
			if (!member) return;
			member.socket = socket;
			socketRoom.set(socket, { room, id });
		},

		/**
		 * Drop dead rooms and report when the next one can die, so the shell
		 * can sleep on an alarm instead of polling. A room with nobody
		 * attached expires 15 minutes after it was last touched; one with
		 * members attached is kept alive by the touches their traffic makes,
		 * until the 24-hour cap says even that is enough.
		 */
		sweep() {
			const time = now();
			for (const [code, room] of rooms) {
				const attached = [...room.members.values()].some((m) => m.socket);
				const idle = time - room.lastTouch >= ROOM_TTL_MS;
				const expired = time - room.createdAt >= ROOM_CAP_MS;
				if ((!attached && idle) || expired) rooms.delete(code);
			}
			let next = Infinity;
			for (const room of rooms.values()) {
				const attached = [...room.members.values()].some((m) => m.socket);
				next = Math.min(next, attached ? room.createdAt + ROOM_CAP_MS : room.lastTouch + ROOM_TTL_MS);
			}
			return Number.isFinite(next) ? next : null;
		},
	};
}
