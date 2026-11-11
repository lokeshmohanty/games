// worker/index.js — the room server: a dumb routing Worker plus the
// Durable Object that holds one signalling room.
//
// The Worker only turns a room code into the object that owns it — and
// answers the client's reachability probe, GET /ping, itself, so a probe
// never wakes an object. wss://…/room/<code> routes to the Durable Object
// named code:<code>, and
// the original request is forwarded untouched — mutating a WebSocket
// upgrade request is the fragile path, so nothing mutates it. The client
// draws its own code when hosting and redraws on a collision, so the worker
// mints nothing.
//
// The object is signalling only. It ferries the packed invite/reply strings
// between sockets and holds rejoin claims; game data never crosses it, and
// neither does ICE config — NAT traversal is the same STUN path the classic
// invite flow uses (net.js DEFAULT_ICE), exactly as docs/room-server.md
// records. All the rules — capacity, claims, rate limits, TTLs — live in
// hub.js, which knows nothing about Cloudflare, which is what makes them
// testable.
//
// State survives eviction twice over: claims (the rejoin secrets' hashes)
// persist in storage, and hibernating sockets carry their room code, member
// id and IP as an attachment, so a woken object — whichever handler wakes it —
// rebuilds the hub and rebinds its sockets instead of dropping a live party's
// signalling.
//
// The guess limit is the one rule a room cannot enforce alone. Each code is
// its own object, so a counter inside one only ever sees guesses at its own
// code — and a guesser tries a different code every time. Every host/join
// that does not carry a valid claim is therefore charged against a second
// object, `IpGate`, named by the sender's IP (an IPv6 sender by its /64; see
// ipKey): our own infrastructure, the same platform, nothing third-party, and it
// runs identically under `wrangler dev`. (Cloudflare's Rate Limiting binding
// was the alternative; it is per-colo and eventually consistent, and a
// limiter a test cannot drive deterministically is a limiter nobody knows
// works.)
//
// Nothing here imports "cloudflare:workers", and objects talk over fetch, not
// RPC, so scripts/test-worker-do.mjs can drive both classes in plain Node with
// a fake `state`.

import { DIAL_FAILS, makeHub, makeLimiter } from "./hub.js";

const ROOM_PATH = /^\/room\/(\d{6})$/;

export default {
	/**
	 * Route one connection to the object that owns its room code. Everything
	 * else about the request — the upgrade above all — passes through as
	 * it arrived.
	 */
	async fetch(request, env) {
		const path = new URL(request.url).pathname;
		// The client's reachability probe, answered right here. It used to
		// be a WebSocket `ping` to room 000000 — one object every client
		// probed, on every page — and a probe needs no room at all. Readable
		// cross-origin, because the pages run on another origin or file://
		// (Origin "null"); a plain GET with no credentials needs no preflight.
		if (path === "/ping") {
			return new Response(null, {
				status: 204,
				headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
			});
		}
		const code = path.match(ROOM_PATH)?.[1];
		if (!code) return new Response("not found", { status: 404 });
		if (request.headers.get("Upgrade") !== "websocket") {
			return new Response("websocket required", { status: 426 });
		}
		// The timing oracle (measured on real Cloudflare, 2026-11-11): a
		// never-used code's object is created by this very request and
		// answers ~180 ms later than a live one's, so an upgrade alone told
		// live from dead ~90% of the time — and a socket that sends nothing
		// was never charged. Every upgrade now spends one dial at the
		// sender's gate *before* any room object is touched; the room
		// refunds it when the socket's first host/join/release succeeds
		// (RoomSignal.refundDial). A member's dials cost nothing, a prober's
		// are capped at DIAL_FAILS per window — the oracle is no cheaper
		// than guessing. Fails *open*: unlike a guess, a dial cannot yet
		// prove a claim, so failing closed would let a gate outage cut every
		// member off; the guess limit behind it still fails closed.
		if (!(await gateCall(env, "dial", ip(request)).then((r) => r.ok !== false, () => true))) {
			return new Response("too many connections", { status: 429 });
		}
		return env.ROOM.get(env.ROOM.idFromName("code:" + code)).fetch(request);
	},
};

/** The sender's address as Cloudflare reports it. */
const ip = (request) => request.headers.get("CF-Connecting-IP") ?? "unknown";

/**
 * One request to `ip`'s IpGate: `op` is charge/refund (guesses) or
 * dial/undial (upgrades). Resolves its JSON; `{}` with no GATE bound.
 */
async function gateCall(env, op, address) {
	const gate = env?.GATE;
	if (!gate) return {};
	const key = ipKey(address);
	const res = await gate.get(gate.idFromName("ip:" + key)).fetch("https://gate/" + op, { method: "POST", body: key });
	if (!res.ok) throw new Error("gate " + res.status);
	return res.json();
}

export class RoomSignal {
	constructor(state, env) {
		this.state = state;
		this.env = env;
		this.code = null; // this object is one room; the code names it
		this.ready = null; // Promise<hub>, built once per wake-up
		// Names this wake-up. Sent back only when the ROOM_DEBUG var is set
		// (scripts/test-live.mjs deploys with it), so a live test can prove
		// the object really was evicted while it idled: a new instance, the
		// old sockets still bound. Never set it on the real deployment — it
		// tells a prober whether a room's object is warm.
		this.instance = crypto.randomUUID();
	}

	/**
	 * The hub, built on first use and — after an eviction — stood back up:
	 * claims come back from storage, live sockets from hibernation, and the
	 * two are re-bound by the attachment each socket carries. Every handler
	 * goes through here, because after hibernation the first thing to run
	 * may be a message, a close or an alarm, never a fetch.
	 */
	hub(code) {
		this.code ??= code ?? null;
		this.ready ??= (async () => {
			const hub = makeHub(
				{
					send: (socket, msg) => {
						try {
							socket.send(JSON.stringify(msg));
						} catch {} // a socket mid-close: its own close event follows
					},
					// A rejoin replaced this socket; the server stops talking to it.
					close: (socket) => {
						try {
							socket.close(4409, "replaced");
						} catch {}
					},
				},
				{ limiter: this.limiter() },
			);
			const stored = await this.state.storage.get("room");
			if (stored) {
				this.code ??= stored.code;
				hub.restore(stored);
			}
			// Oldest bind first, so when a member has two sockets — a rejoin
			// over one that died half-open — the newer is the one left bound.
			// getWebSockets() promises no order of its own.
			const sockets = this.state
				.getWebSockets()
				.map((ws) => ({ ws, att: attachmentOf(ws) }))
				.sort((a, b) => (a.att.at ?? 0) - (b.att.at ?? 0));
			for (const { ws, att } of sockets) {
				this.code ??= att.code ?? null;
				hub.rebind(ws, this.code, att.id);
			}
			return hub;
		})();
		return this.ready;
	}

	/**
	 * The hub's limiter: charged against the sender's IpGate, so a guess
	 * counts wherever it lands. Without a GATE binding (an old config) the
	 * hub keeps its own per-room limiter.
	 *
	 * A gate that cannot be reached fails *closed*: the attempt is refused
	 * as "blocked". Falling back to a per-room limiter instead meant anyone
	 * who could overload the gate object switched the cross-room limit off
	 * — the one limit that matters. Members pay nothing for this: a rejoin
	 * with a valid claim never reaches the limiter (hub.js `join`), so a
	 * gate outage only stops newcomers and guessers, and a newcomer's
	 * "blocked" is retryable. A refund that cannot be delivered is dropped:
	 * the attempt stays counted, which errs the same way.
	 */
	limiter() {
		if (!this.env?.GATE) return undefined;
		const call = (op, ip) => gateCall(this.env, op, ip);
		return {
			async charge(ip) {
				try {
					return (await call("charge", ip)).ok === true;
				} catch {
					return false;
				}
			},
			async refund(ip) {
				try {
					await call("refund", ip);
				} catch {}
			},
		};
	}

	async fetch(request) {
		const code = new URL(request.url).pathname.match(ROOM_PATH)?.[1];
		await this.hub(code);
		if (request.headers.get("Upgrade") !== "websocket") {
			return new Response("websocket required", { status: 426 });
		}
		const [client, server] = Object.values(new WebSocketPair());
		this.state.acceptWebSocket(server);
		// Serialized now, not after the first join: the rate limits count
		// failures per IP, and a socket whose first message fails has to be
		// counted under its own address, not under one shared "unknown".
		// `dial`: the routing Worker charged this socket's upgrade, owed back
		// on its first success (refundDial).
		server.serializeAttachment({ ip: ip(request), code, dial: !!this.env?.GATE });
		const headers = this.env?.ROOM_DEBUG ? { "X-Room-Instance": this.instance } : undefined;
		return new Response(null, { status: 101, webSocket: client, headers });
	}

	async webSocketMessage(ws, message) {
		let msg;
		try {
			msg = JSON.parse(message);
		} catch {
			return; // not protocol: ignore rather than guess
		}
		const att = attachmentOf(ws);
		const hub = await this.hub(att.code);
		const reply = (body) => ws.send(JSON.stringify(body));
		if (msg.t === "release") {
			// A claim given back from a socket that holds no seat (hub.js
			// `releaseClaim`): answered, hung up, and never bound — so the
			// attachment never names a member.
			const answer =
				msg.code !== this.code
					? { t: "error", reason: "bad-code" }
					: await hub.releaseClaim(att.ip, msg);
			reply(answer);
			if (answer.t !== "error") await this.refundDial(ws, att);
			ws.close(answer.t === "error" ? 4400 : 1000, answer.reason ?? answer.t);
		} else if (msg.t === "host" || msg.t === "join") {
			// The message's code has to name this object's room; anything
			// else is a misdelivered message, not a guess of this room's code.
			const answer =
				msg.code !== this.code
					? { t: "error", reason: "bad-code" }
					: await hub[msg.t](ws, att.ip, msg);
			reply(answer);
			if (answer.t === "error") return ws.close(4400, answer.reason);
			if (att.dial) await this.refundDial(ws, att);
			// `at` orders a member's sockets on a wake-up (see hub()).
			ws.serializeAttachment({ ...att, dial: false, id: msg.id, at: Date.now() });
		} else if (msg.t === "offer" || msg.t === "answer" || msg.t === "full") {
			hub.relay(ws, msg); // a relay touches, and touches move the TTL
		} else if (msg.t === "leave") {
			await hub.release(ws, msg);
			ws.close(1000, "leave");
		} else {
			return;
		}
		await this.persist();
	}

	/**
	 * Give back the dial the routing Worker charged for this socket: it
	 * reached a seat (or gave one back), so it was never a probe. Once per
	 * socket; a refund that cannot be delivered is dropped (the dial stays
	 * counted, which errs towards the limit).
	 */
	async refundDial(ws, att) {
		if (!att.dial) return;
		ws.serializeAttachment({ ...att, dial: false });
		try {
			await gateCall(this.env, "undial", att.ip);
		} catch {}
	}

	async webSocketClose(ws, code, reason) {
		(await this.hub(attachmentOf(ws).code)).leave(ws);
		await this.persist();
		// Before the 2026-04-07 compatibility date the runtime does not
		// answer a client's Close frame itself; this completes the handshake.
		// (1005/1006 are reserved and throw, hence the guard.)
		try {
			ws.close(code, reason);
		} catch {}
	}

	async webSocketError(ws) {
		(await this.hub(attachmentOf(ws).code)).leave(ws);
		await this.persist();
	}

	async alarm() {
		await this.hub();
		await this.persist();
	}

	/**
	 * Sweep, persist the claims and re-arm the alarm. Called after every
	 * mutation, because a claim that existed only in memory would die with
	 * the object — and a rejoin that fails because the server was busy is
	 * exactly the brittleness the room server exists to remove.
	 */
	async persist() {
		const hub = await this.hub();
		const next = hub.sweep();
		const room = hub.snapshot(this.code);
		if (!room) {
			// Nothing left: the room is gone, so its storage is too.
			await this.state.storage.delete("room");
			await this.state.storage.deleteAlarm();
			return;
		}
		await this.state.storage.put("room", room);
		if (next) await this.state.storage.setAlarm(next);
		else await this.state.storage.deleteAlarm();
	}
}

/**
 * The address a guess is counted under. IPv4 as it is; IPv6 by its /64,
 * because one customer is routinely handed a whole /64 and can pick a fresh
 * address from it for every guess — counting full addresses would give a
 * guesser 2^64 buckets. (An IPv4-mapped address is IPv4.)
 */
function ipKey(ip) {
	const s = String(ip ?? "").trim().toLowerCase();
	if (!s.includes(":")) return s;
	const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
	if (mapped) return mapped[1];
	const [head, tail] = s.split("%")[0].split("::");
	const left = head ? head.split(":") : [];
	const right = tail ? tail.split(":") : [];
	const groups =
		tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
	return groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(":") + "::/64";
}

/** The attachment a socket carries through hibernation, or nothing. */
function attachmentOf(ws) {
	try {
		return ws.deserializeAttachment() ?? {};
	} catch {
		return {};
	}
}

/**
 * One IP's guess counter: the object every room charges a host/join
 * against, named `ip:<address>` (`ip:<prefix>::/64` for IPv6). It is the hub's own limiter (makeLimiter),
 * held in one place per address instead of one per room. Requests are
 * `POST /charge` → `{ok}` and `POST /refund`, the IP as the body.
 *
 * Persisted, so an eviction mid-window does not forgive a guesser; an alarm
 * at the window's close clears the storage again, so an address that stops
 * guessing leaves nothing behind.
 */
export class IpGate {
	constructor(state) {
		this.state = state;
		this.ready = null; // Promise<{ entry: limiter, dial: limiter }>
	}

	/** Two counters, one window each: guesses ("entry") and upgrades ("dial"). */
	limiters() {
		this.ready ??= (async () => {
			const load = async (key, max) => {
				const stored = await this.state.storage.get(key);
				const entries = new Map(stored ? [[stored.ip, { count: stored.count, firstAt: stored.firstAt }]] : []);
				return makeLimiter({ entries, max });
			};
			return { entry: await load("entry"), dial: await load("dial", DIAL_FAILS) };
		})();
		return this.ready;
	}

	async fetch(request) {
		const op = new URL(request.url).pathname;
		const ip = await request.text();
		const { entry, dial } = await this.limiters();
		// Synchronous between the await above and the write below, so two
		// rooms charging at once cannot both spend the last attempt.
		let ok = true;
		if (op === "/charge") ok = entry.charge(ip);
		else if (op === "/refund") entry.refund(ip);
		else if (op === "/dial") ok = dial.charge(ip);
		else if (op === "/undial") dial.refund(ip);
		else return new Response("not found", { status: 404 });
		await this.save(ip);
		return Response.json({ ok });
	}

	async alarm() {
		const stored = (await this.state.storage.get("entry")) ?? (await this.state.storage.get("dial"));
		if (stored) await this.save(stored.ip);
	}

	/** Persist both counters; the alarm wakes at the earlier window's close. */
	async save(ip) {
		const limiters = await this.limiters();
		let until = Infinity;
		for (const key of ["entry", "dial"]) {
			const entry = limiters[key].entries.get(ip);
			const expires = limiters[key].expires(ip);
			if (!entry || !expires) await this.state.storage.delete(key);
			else {
				await this.state.storage.put(key, { ip, ...entry });
				until = Math.min(until, expires);
			}
		}
		if (Number.isFinite(until)) await this.state.storage.setAlarm(until);
		else await this.state.storage.deleteAlarm();
	}
}
