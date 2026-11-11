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
// A failed join (unknown code, wrong claim secret, a code that turned out to
// be live) counts against the sender's IP. The 6-digit space is small enough
// to guess at, so the limit is what makes a live code hard to find within its
// TTL; 10 failures per 5 minutes lets a mistyping friend through and stops a
// loop of guesses.
const JOIN_FAILS = 10;
const JOIN_FAIL_WINDOW_MS = 5 * 60 * 1000;
// Every WebSocket to a room is charged one *dial* at the routing Worker,
// refunded once its first host/join/release succeeds (index.js). Measured on
// real Cloudflare, 2026-11-11: a never-used code's object answers the upgrade
// ~180 ms later than a live one's (it is being created), which told a live
// code from a dead one ~90% of the time in one try — for free, since a socket
// that sends nothing was never charged. Unrefunded dials are what a prober
// spends; a real member's are refunded. Twice the guess budget, because a
// member's legitimate failures (a party that ended under a reload, a dial
// cut off mid-way) cost one each too.
export const DIAL_FAILS = 2 * JOIN_FAILS;

const CODE = /^\d{6}$/;
// What one member may send another through the hub.
const RELAYED = new Set(["offer", "answer", "full"]);

/** Hex SHA-256 of a string, via the WebCrypto every runtime here provides. */
async function sha256(str) {
	const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
	return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The per-IP guess limiter. Failures count per IP, never per room: a
 * per-room counter would let one stranger's ten wrong guesses lock everybody
 * out of that party.
 *
 * Every attempt is *charged up front* and a success is refunded, rather
 * than counting failures after the fact. The difference is concurrency: a
 * check-then-record limiter lets a guesser open a thousand sockets at once,
 * pass a thousand checks before the first failure is recorded, and guess a
 * thousand codes per window. Charged up front, at most JOIN_FAILS attempts
 * are ever outstanding, however many sockets are open.
 *
 * Pure, like the hub. In production one of these lives in a per-IP Durable
 * Object (`IpGate` in index.js), because every room is its own object and a
 * limiter inside the hub would only ever see guesses at its own code.
 *
 * @param {object} [opts]
 * @param {() => number} [opts.now]
 * @param {Map} [opts.entries]  ip -> { count, firstAt }; the gate passes the
 *   map it persists.
 * @param {number} [opts.max]  attempts per window (JOIN_FAILS; the gate's
 *   dial counter uses DIAL_FAILS).
 */
export function makeLimiter({ now = Date.now, entries = new Map(), max = JOIN_FAILS } = {}) {
	/** The ip's entry while its window is open; a closed window is forgotten. */
	const live = (ip) => {
		const entry = entries.get(ip);
		if (entry && now() - entry.firstAt < JOIN_FAIL_WINDOW_MS) return entry;
		entries.delete(ip);
		return null;
	};
	return {
		entries,
		/** Spend one attempt; false when the ip has none left this window. */
		charge(ip) {
			let entry = live(ip);
			if (entry && entry.count >= max) return false;
			if (!entry) entries.set(ip, (entry = { count: 0, firstAt: now() }));
			entry.count++;
			return true;
		},
		/** The attempt succeeded: it was never a guess. */
		refund(ip) {
			const entry = live(ip);
			if (!entry) return;
			if (--entry.count <= 0) entries.delete(ip);
		},
		/** When the ip's window closes, or null with nothing counted. */
		expires(ip) {
			const entry = live(ip);
			return entry ? entry.firstAt + JOIN_FAIL_WINDOW_MS : null;
		},
	};
}

/**
 * @param {object} adapter  `{ send(socket, msg), close?(socket) }` — how the
 *   hub talks back. `close` hangs up a socket a rejoin has replaced.
 * @param {object} [opts]
 * @param {() => number} [opts.now]  clock injection for the TTL tests.
 * @param {object} [opts.limiter]  `{ charge(ip), refund(ip) }`, sync or
 *   async — the Durable Object passes one backed by its per-IP gate. The
 *   default is a limiter local to this hub, which is all a test needs.
 */
export function makeHub(adapter, { now = Date.now, limiter = makeLimiter({ now }) } = {}) {
	// code -> { code, members: Map(id -> member), lastTouch, createdAt }
	// member -> { id, secretHash, socket, joinedAt, leftAt }
	const rooms = new Map();
	// The reverse index sockets are looked up by, so a relay costs one map
	// hop instead of a scan of every member of every room.
	const socketRoom = new Map(); // socket -> { room, id }

	/**
	 * Run one host/join under the limiter: charged before anything is
	 * looked up, refunded only when it succeeded. Every refusal stays
	 * charged — "taken" and "full" included, because each says a code is
	 * live, which is exactly what a guesser is fishing for.
	 *
	 * Only for attempts that prove nothing. A rejoin with a valid claim
	 * never comes here (see `join`): it is the one request a guesser
	 * cannot make, and charging it is how a LAN party behind one address
	 * — or a carrier's CGNAT — got its own members blocked by a few typos
	 * and one simultaneous re-dial.
	 */
	const limited = async (ip, attempt) => {
		if (!(await limiter.charge(ip))) return { t: "error", reason: "blocked" };
		const answer = await attempt();
		if (answer.t !== "error") await limiter.refund(ip);
		return answer;
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
		// A rejoin over a socket the server still thinks is open (the old
		// one died half-open): hang the old one up and forget it, so nothing
		// is ever sent down it again and a wake-up cannot rebind it.
		const stale = member.socket;
		if (stale && stale !== socket) {
			socketRoom.delete(stale);
			adapter.close?.(stale);
		}
		member.socket = socket;
		member.leftAt = null;
		socketRoom.set(socket, { room, id: member.id });
		touch(room);
		announce(room, member);
	};

	/**
	 * Drop a claim the owner gave back (its socket already unbound). The
	 * others hear `connected:false`, which is all a departure ever is to
	 * the hub; the mesh's own `__gone` does the rest. The last claim out
	 * takes the room with it, so the code returns to the pool at once.
	 */
	const forget = (room, member) => {
		room.members.delete(member.id);
		touch(room);
		announce(room, member);
		if (!room.members.size) rooms.delete(room.code);
	};

	/**
	 * The member `id` names in `room`, if `secret` proves the claim — else
	 * null. Nothing is charged and nothing changes, so it is safe to ask
	 * before the limiter; the caller binds synchronously after the answer,
	 * with no await in between for a release to slip into.
	 */
	const claimed = async (room, id, secret) => {
		if (!room || typeof id !== "string" || !id) return null;
		const secretHash = await sha256(String(secret ?? ""));
		if (rooms.get(room.code) !== room) return null; // swept or released meanwhile
		prune(room);
		const member = room.members.get(id);
		return member && member.secretHash === secretHash ? member : null;
	};

	/**
	 * Attach a socket to a room under `id`. An existing claim means a
	 * rejoin: the secret hash proves it is the same browser, the seat was
	 * never released, and the answer says joined just like a first arrival
	 * did. (A live socket being replaced is the stale-socket case — last
	 * writer wins — not a second member; ids are random and unique.)
	 */
	const attach = async (room, socket, { id, secret }) => {
		if (typeof id !== "string" || !id) return { t: "error", reason: "bad-code" };
		const secretHash = await sha256(String(secret ?? ""));
		prune(room);
		let member = room.members.get(id);
		if (member && member.secretHash !== secretHash) return { t: "error", reason: "id-taken" };
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
		 * one party's offers to another. Charged before the room exists, so
		 * a refused host cannot leave a memberless room squatting on the
		 * code — and "taken" stays charged, or hosting would be a free way
		 * to ask which codes are live.
		 */
		async host(socket, ip, msg) {
			const { code } = msg;
			if (!CODE.test(code ?? "")) return { t: "error", reason: "bad-code" };
			return limited(ip, async () => {
				if (rooms.has(code)) return { t: "error", reason: "taken" };
				const room = { code, members: new Map(), lastTouch: now(), createdAt: now() };
				rooms.set(code, room);
				const refused = await attach(room, socket, msg);
				if (refused) {
					rooms.delete(code);
					return refused;
				}
				return { t: "room", code };
			});
		},

		async join(socket, ip, msg) {
			const { code } = msg;
			if (!CODE.test(code ?? "")) return { t: "error", reason: "bad-code" };
			// A valid claim is checked first and never charged: it proves
			// the sender already holds a seat here, so it guesses nothing —
			// and it is exactly what every member of a party re-dials with
			// after a blip, all at once, often from one shared address.
			const live = rooms.get(code);
			const known = await claimed(live, msg.id, msg.secret);
			if (known) {
				bind(live, known, socket);
				return { t: "joined" };
			}
			// Anything else is a guess as often as a typo. After 10 of them
			// in 5 minutes, the answer is "blocked" for a while, not another
			// round of guesses.
			return limited(ip, async () => {
				const room = rooms.get(code);
				if (!room) return { t: "error", reason: "no-room" };
				return (await attach(room, socket, msg)) ?? { t: "joined" };
			});
		},

		/**
		 * Ferry one message from one member to another: a packed offer or
		 * answer string, or `full` — the offerer's word that the party has
		 * no seat for the newcomer. The hub carries `full` without knowing
		 * what a party's size is, which is the point: the mesh counts seats
		 * (bots included), and the hub never learns it.
		 */
		relay(socket, msg) {
			const { t, to, sdp } = msg;
			if (!RELAYED.has(t)) return;
			const here = socketRoom.get(socket);
			if (!here) return; // a socket that never joined has nothing to say
			const room = here.room;
			const toMember = room.members.get(to);
			if (!toMember?.socket) return; // dropped member: the mesh relays now
			touch(room);
			adapter.send(toMember.socket, t === "full" ? { t, from: here.id } : { t, from: here.id, sdp });
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
			member.socket = null;
			forget(room, member);
		},

		/**
		 * Give back a claim from a socket that holds no seat — a page that
		 * kept a rejoin token but has no room any more (a rejoin nobody
		 * answered) and is starting over. `{t:"release", code, id, secret}`
		 * as a socket's first message; answered `released` or `busy`.
		 *
		 * Never through `join`: a join with the claim binds it, and when
		 * another tab of the same browser holds that seat live, binding hung
		 * it up (4409) and the leave that followed gave its seat away — a
		 * ghost in the party for 5 minutes and a live tab told it was
		 * elsewhere. So the claim is checked without binding, and a seat
		 * with a socket attached is somebody's live seat: `busy`, and
		 * nothing is touched. (A half-open socket also reads as live; its
		 * claim lapses with the grace, which errs towards keeping a seat.)
		 *
		 * A verified claim is never charged, as in `join`; anything else
		 * is a guess and is charged like one.
		 */
		async releaseClaim(ip, { code, id, secret }) {
			if (!CODE.test(code ?? "")) return { t: "error", reason: "bad-code" };
			const room = rooms.get(code);
			const known = await claimed(room, id, secret);
			if (known) {
				if (known.socket) return { t: "busy" };
				forget(room, known);
				return { t: "released" };
			}
			return limited(ip, async () => ({ t: "error", reason: rooms.has(code) ? "no-claim" : "no-room" }));
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
