// worker/hub.js — the room hub: pure signalling logic, no Cloudflare imports.
//
// This is the brain the Durable Object in index.js drives; keeping it free of
// platform code is what lets scripts/test-hub.mjs exercise every rule with
// zero dependencies, the same trick lib/net.js plays with its fake transports.
//
// What it is not: a membership authority. The party record replicated over
// the data channels in net.js decides who is in the party. The hub only holds
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
// ...but only for as long as the mesh holds the seat. net.js drops a
// reconnecting member after its 5-minute grace, so a claim detached for longer
// is a seat nobody is keeping — and without pruning it, a long party that
// sees a few people close their tabs would answer "full" to its next guest.
const SEAT_GRACE_MS = 5 * 60 * 1000;
// A failed join (unknown code, wrong claim secret) counts against the sender's
// IP. The 6-digit space is small enough to guess at, so the limit is what
// makes a live code hard to find within its TTL; 10 failures per 5 minutes
// lets a mistyping friend through and stops a loop of guesses.
const JOIN_FAILS = 10;
const JOIN_FAIL_WINDOW_MS = 5 * 60 * 1000;

const CODE = /^\d{6}$/;

/** Hex SHA-256 of a string, via the WebCrypto every runtime here provides. */
async function sha256(str) {
	const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
	return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * @param {object} adapter  `{ send(socket, msg) }` — how the hub talks back.
 * @param {object} [opts]
 * @param {() => number} [opts.now]  clock injection for the TTL tests.
 */
export function makeHub(adapter, { now = Date.now } = {}) {
	// code -> { code, members: Map(id -> member), lastTouch, createdAt }
	// member -> { id, secretHash, socket, joinedAt, leftAt }
	const rooms = new Map();
	// Failures count per IP, never per room: a per-room counter would let
	// one stranger's ten wrong guesses lock everybody out of that party.
	const ipFails = new Map(); // ip -> { count, firstAt }
	// The reverse index sockets are looked up by, so a relay costs one map
	// hop instead of a scan of every member of every room.
	const socketRoom = new Map(); // socket -> { room, id }

	const blocked = (ip) => {
		const entry = ipFails.get(ip);
		return !!entry && entry.count >= JOIN_FAILS && now() - entry.firstAt < JOIN_FAIL_WINDOW_MS;
	};

	/** A failure the sender earned. */
	const recordFail = (ip) => {
		const entry = ipFails.get(ip);
		if (entry && now() - entry.firstAt < JOIN_FAIL_WINDOW_MS) entry.count++;
		else ipFails.set(ip, { count: 1, firstAt: now() });
	};

	const touch = (room) => {
		room.lastTouch = now();
	};

	/** Drop claims whose seat the mesh has already given away. */
	const prune = (room) => {
		for (const [id, m] of room.members) {
			if (!m.socket && now() - m.leftAt >= SEAT_GRACE_MS) room.members.delete(id);
		}
	};

	/**
	 * Everyone attached hears about `member`'s socket state, except `member`
	 * — they already know, from their own reply. `offering` names the member
	 * who should issue the WebRTC offer: the oldest attached member *other
	 * than the subject*, ties broken by id, so every peer that hears the
	 * notice nominates the same one. Oldest, not "the host", so the rule
	 * survives host succession exactly the way the crown does.
	 *
	 * Excluding the subject is the whole fix for a returning host: they are
	 * usually the oldest, and naming them as their own offerer meant nobody
	 * offered and the host could never reconnect. It also covers the
	 * newcomer who joined while nobody was attached: when an older member
	 * reattaches, the newcomer is the one told to offer, so neither side
	 * waits for a notice that went to nobody.
	 */
	const announce = (room, member) => {
		const others = [...room.members.values()]
			.filter((m) => m.socket && m.id !== member.id)
			.sort((a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : 1));
		if (!others.length) return;
		const notice = { t: "peer", id: member.id, connected: !!member.socket, offering: others[0].id };
		for (const m of others) adapter.send(m.socket, notice);
	};

	/** Bind a socket to a member: a first arrival and a rejoin end the same way. */
	const bind = (room, member, socket) => {
		member.socket = socket;
		member.leftAt = null;
		socketRoom.set(socket, { room, id: member.id });
		touch(room);
		announce(room, member);
	};

	/**
	 * Attach a socket to a room under `id`. An existing claim means a
	 * rejoin: the secret hash proves it is the same browser, the seat was
	 * never released, and the answer says joined just like a first arrival
	 * did. (A live socket being replaced is the stale-socket case — last
	 * writer wins — not a second member; ids are random and unique.)
	 */
	const attach = async (room, socket, ip, { id, secret }) => {
		if (typeof id !== "string" || !id) return { t: "error", reason: "bad-code" };
		const secretHash = await sha256(String(secret ?? ""));
		prune(room);
		let member = room.members.get(id);
		if (member && member.secretHash !== secretHash) {
			recordFail(ip);
			return { t: "error", reason: "id-taken" };
		}
		if (!member) {
			if (room.members.size >= MAX_MEMBERS) return { t: "error", reason: "full" };
			member = { id, secretHash, socket: null, joinedAt: now(), leftAt: null };
			room.members.set(id, member);
		}
		bind(room, member, socket);
		return null;
	};

	return {
		rooms,

		/**
		 * Open a room under the code the client drew; the caller becomes its
		 * first member and claim. A collision answers "taken" and the client
		 * redraws — never joining a host into a live party, which would hand
		 * one party's offers to another. Checked for "blocked" before the room
		 * exists, so a refused host cannot leave a memberless room squatting
		 * on the code.
		 */
		async host(socket, ip, msg) {
			const { code } = msg;
			if (!CODE.test(code ?? "")) return { t: "error", reason: "bad-code" };
			if (blocked(ip)) return { t: "error", reason: "blocked" };
			if (rooms.has(code)) return { t: "error", reason: "taken" };
			const room = { code, members: new Map(), lastTouch: now(), createdAt: now() };
			rooms.set(code, room);
			const refused = await attach(room, socket, ip, msg);
			if (refused) {
				rooms.delete(code);
				return refused;
			}
			return { t: "room", code };
		},

		async join(socket, ip, msg) {
			const { code } = msg;
			if (!CODE.test(code ?? "")) return { t: "error", reason: "bad-code" };
			if (blocked(ip)) return { t: "error", reason: "blocked" };
			const room = rooms.get(code);
			if (!room) {
				// An unknown code is a guess as often as a typo. After 10 of
				// them in 5 minutes, the answer is "blocked" for a while, not
				// another round of guesses.
				recordFail(ip);
				return { t: "error", reason: "no-room" };
			}
			return (await attach(room, socket, ip, msg)) ?? { t: "joined" };
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
			member.leftAt = now();
			touch(room);
			announce(room, member);
		},

		/**
		 * A deliberate leave: the member gives the seat back. The secret
		 * proves it is the claim's owner speaking, not merely someone holding
		 * a socket. The others hear `connected:false`, which is all a
		 * departure ever is to the hub; the mesh's own `__gone` does the rest.
		 * The last claim out takes the room with it, so the code returns to
		 * the pool at once instead of after the TTL.
		 */
		async release(socket, { id, secret }) {
			const here = socketRoom.get(socket);
			if (!here || here.id !== id) return;
			const { room } = here;
			const member = room.members.get(id);
			if (!member || member.secretHash !== (await sha256(String(secret ?? "")))) return;
			socketRoom.delete(socket);
			room.members.delete(id);
			member.socket = null;
			touch(room);
			announce(room, member);
			if (!room.members.size) rooms.delete(room.code);
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
				members: [...room.members.values()].map(({ id, secretHash, joinedAt, leftAt }) => ({
					id,
					secretHash,
					joinedAt,
					leftAt,
				})),
			};
		},

		/**
		 * Stand a room back up from a snapshot — claims intact, sockets
		 * unbound. A claim that was attached when the snapshot was taken gets
		 * its detach clock started now; `rebind` stops it again for every
		 * socket that survived hibernation.
		 */
		restore(stored) {
			if (rooms.has(stored.code)) return;
			const at = now();
			rooms.set(stored.code, {
				code: stored.code,
				members: new Map(
					stored.members.map((m) => [m.id, { ...m, socket: null, leftAt: m.leftAt ?? at }]),
				),
				lastTouch: stored.lastTouch,
				createdAt: stored.createdAt,
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
			member.leftAt = null;
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
