// worker/index.js — the room server: a dumb routing Worker plus the
// Durable Object that holds one signalling room.
//
// The Worker only turns a room code into the object that owns it — and
// answers the client's reachability probe, GET /ping, itself, so a probe
// never wakes an object. wss://…/room/<code> routes to the Durable Object
// named code:<code>, and the original request is forwarded untouched.
// wss://…/room/new is hosting: the Worker draws a code and asks that
// code's object to take the socket only if the code is free, drawing
// again if not — so no client ever names a code to host, and no answer to
// a host says anything about another code (2026-11-12; the client drew
// codes before, and a host's success was the answer "that code is dead").
// That one forward re-addresses the upgrade (`new Request(url, request)`,
// the pattern Cloudflare's own chat example uses); nothing else is
// mutated.
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
// code — and a guesser tries a different code every time. Every join
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

import { api, scheduledSnapshot } from "./api/index.js";
export { UserLive } from "./api/live.js";
import {
	API_WRITES,
	DIAL_FAILS,
	HOST_ROOMS,
	HOST_SITE_ROOMS,
	PASS_TTL_MS,
	RESERVE_MS,
	checkPass,
	makeHub,
	makeLimiter,
	signPass,
} from "./hub.js";

const ROOM_PATH = /^\/room\/(\d{6})$/;
// What a Durable Object is sent: a room path, `/new` when the Worker is
// asking it to take a host (only the Worker can make that path — it is
// 404 from outside, ROOM_PATH being exact).
const OBJECT_PATH = /^\/room\/(\d{6})(\/new)?$/;
// How many codes `/room/new` draws before giving up (503). Nine hundred
// thousand codes and rooms that live hours: the second draw is already a
// one-in-a-million event.
const HOST_DRAWS = 8;
const CODE = /^\d{6}$/;

export default {
	/**
	 * Route one connection to the object that owns its room code. Everything
	 * else about the request — the upgrade above all — passes through as
	 * it arrived.
	 */
	/** The hourly public snapshot (wrangler.toml [triggers]). */
	async scheduled(_event, env, ctx) {
		ctx.waitUntil(scheduledSnapshot(env));
	},

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
		// Accounts, results and the social layer (worker/api/, docs/accounts.md).
		if (path.startsWith("/api/") || path.startsWith("/auth/") || path === "/live") {
			return api(request, env, {
				gate: () => gateCall(env, "api", ip(request)).then((r) => r.ok !== false, () => false),
			});
		}
		if (path === "/room/new") return hostNew(request, env);
		const code = path.match(ROOM_PATH)?.[1];
		if (!code) return new Response("not found", { status: 404 });
		if (request.headers.get("Upgrade") !== "websocket") {
			return new Response("websocket required", { status: 426 });
		}
		// A member's re-dial carries the pass its seat was issued
		// (`?id=&exp=&pass=`, hub.js signPass), checked here before the
		// gate or any room is touched. A valid one goes through uncharged:
		// it proves a seat in this very room, which its holder already
		// knows, and nobody without the key can make one — so it buys a
		// prober nothing. Anything else is an unproven upgrade, charged
		// below like every other.
		if (await passOf(env, code, new URL(request.url))) return roomOf(env, code).fetch(request);
		// The timing oracle (measured on real Cloudflare, 2026-11-11): a
		// never-used code's object is created by this very request and
		// answers ~180 ms later than a live one's, so an upgrade alone told
		// live from dead ~90% of the time — and a socket that sends nothing
		// was never charged. Every unproven upgrade now spends one dial at
		// the sender's gate *before* any room object is touched; the room
		// refunds it when the socket's first join/release succeeds
		// (RoomSignal.refundDial). A prober's dials are capped at
		// DIAL_FAILS per window (= the guess limit), so the oracle is no
		// cheaper than guessing.
		//
		// Fails *closed* (2026-11-12; it failed open before). An upgrade let
		// through without a charge is a free probe, and an attacker can make
		// their own gate fail — it is one object per address, and flooding
		// it is how — and the room would still refund the dial it was never
		// charged, minting budget. A gate outage now looks like the room
		// server being down to newcomers; members carry passes and never
		// ask it.
		const refused = await gateRefusal(env, "dial", ip(request));
		if (refused) return refused;
		return roomOf(env, code).fetch(request);
	},
};

/**
 * Refuse an upgrade the gate turned down — before any room object is
 * touched, the same answer for every code. A browser WebSocket never sees
 * an HTTP status, so a plain 429 reached the player as "Could not reach
 * the room server", which was wrong and sent them looking at their wifi.
 * Past a budget (429) the routing Worker therefore accepts the socket
 * itself — a WebSocketPair of its own, never a room's — says
 * `{t:"error", reason:"blocked"}` and hangs up (4429), so the client can
 * say "too many attempts". A gate that cannot answer (503) stays an HTTP
 * refusal: that one really is the server being unavailable.
 */
function refusal(status) {
	if (status !== 429) return new Response("busy", { status });
	const [client, server] = Object.values(new WebSocketPair());
	server.accept();
	server.send(JSON.stringify({ t: "error", reason: "blocked" }));
	server.close(4429, "blocked");
	return new Response(null, { status: 101, webSocket: client });
}

/** The object that owns room `code`. */
const roomOf = (env, code) => env.ROOM.get(env.ROOM.idFromName("code:" + code));

/**
 * `/room/new`: open a room under a code the server draws. Charged against
 * the sender's HOST_ROOMS (never refunded; a cap on creating objects, not
 * a guess limit — hosting reveals nothing now) and never against the dial
 * or guess budgets. Each draw asks that code's object to take the socket
 * if the code is free (RoomSignal.fetch, `/new`): 409 means live, so draw
 * again. The client only ever hears the code it got, in the `room` reply.
 */
async function hostNew(request, env) {
	if (request.headers.get("Upgrade") !== "websocket") {
		return new Response("websocket required", { status: 426 });
	}
	// An IPv6 sender is counted by its /48 too: HOST_ROOMS per /64 alone
	// let one /48 (65 536 /64s) open millions of rooms per window — every
	// code (siteKey; HOST_SITE_ROOMS).
	const address = ip(request);
	const site = siteKey(address);
	const refused =
		(await gateRefusal(env, "host", address)) ?? (site ? await gateRefusal(env, "site", address, site) : null);
	if (refused) return refused;
	const forced = forcedDraw(request, env);
	for (let i = 0; i < HOST_DRAWS; i++) {
		const code =
			i === 0 && forced ? forced : String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
		const res = await roomOf(env, code).fetch(new Request(`https://room/room/${code}/new`, request));
		if (res.status !== 409) return env?.ROOM_DEBUG ? withHeader(res, "X-Room-Draws", String(i + 1)) : res;
	}
	return new Response("busy", { status: 503 });
}

/**
 * A test hook for the one path a local run cannot vouch for: the redraw,
 * which forwards the client's upgrade a *second* time
 * (`new Request(url, request)` again, after a 409). Only when the
 * deployment sets both ROOM_DEBUG and ROOM_TEST_FORCE_REDRAW — never on a
 * real one (ROOM_DEBUG already re-opens the timing oracle) —
 * `/room/new?draw=<code>` makes the first draw that code; given a live
 * one, the draw is refused and redrawn, and the 101's `X-Room-Draws`
 * (ROOM_DEBUG only) says how many draws it took. scripts/test-live.mjs
 * `redraw`. Unset, the query is ignored and every draw is random.
 */
function forcedDraw(request, env) {
	if (!env?.ROOM_DEBUG || !env?.ROOM_TEST_FORCE_REDRAW) return null;
	const code = new URL(request.url).searchParams.get("draw");
	return CODE.test(code ?? "") && code >= "100000" ? code : null;
}

/** `res` with one more header (a debug note); a 101 keeps its socket. */
function withHeader(res, name, value) {
	const headers = new Headers(res.headers);
	headers.set(name, value);
	return new Response(res.body, { status: res.status, statusText: res.statusText, headers, webSocket: res.webSocket });
}

/**
 * Charge one `op` (dial, host or site) at the gate `key` names (the
 * sender's, by default); the refusal to send, or null to go on. Past the
 * budget, `blocked` on a socket the Worker itself accepts (`refusal`);
 * 503 when the gate cannot answer — fail closed, see the dial comment
 * above.
 */
async function gateRefusal(env, op, address, key) {
	const status = await gateCall(env, op, address, key).then(
		(r) => (r.ok === false ? 429 : 0),
		() => 503,
	);
	return status ? refusal(status) : null;
}

// Said once per isolate, not per request: an unset key is a deployment
// mistake to notice, not a stream of errors.
let passKeyWarned = false;
/** The pass key, or null (warned once): without one, no pass is issued or honoured. */
function passKey(env) {
	const key = env?.ROOM_PASS_KEY || null;
	if (!key && !passKeyWarned) {
		passKeyWarned = true;
		console.warn("ROOM_PASS_KEY is not set: no member passes, so members' re-dials are charged like any upgrade (worker/README.md)");
	}
	return key;
}

/**
 * Does `url`'s query carry a valid pass for `code`? `ignoreExpiry` is the
 * room's check (see RoomSignal.fetch), never the Worker's.
 */
async function passOf(env, code, url, ignoreExpiry = false) {
	const q = url.searchParams;
	if (!q.has("pass")) return false;
	const key = passKey(env);
	return !!key && checkPass(key, code, q.get("id"), q.get("exp"), q.get("pass"), { ignoreExpiry });
}

/** The sender's address as Cloudflare reports it. */
const ip = (request) => request.headers.get("CF-Connecting-IP") ?? "unknown";

/**
 * One request to `ip`'s IpGate: `op` is charge/refund (guesses),
 * dial/undial (upgrades), host (`/room/new`) or site (`/room/new`, at the
 * IPv6 /48's gate: `key` = siteKey). Resolves its JSON; `{}` with no GATE bound.
 */
async function gateCall(env, op, address, key = ipKey(address)) {
	const gate = env?.GATE;
	if (!gate) return {};
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
					// A rejoin replaced this socket (4409), or its reservation
					// lapsed unhosted (4408); the server stops talking to it.
					close: (socket, code = 4409, reason = "replaced") => {
						try {
							socket.close(code, reason);
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
				// A host socket evicted before it said `host` holds its
				// reservation again — from its original time, so RESERVE_MS
				// still runs from the draw; nothing else can have taken the
				// code, since the reservation is what kept it. One that has
				// lapsed (or predates `reservedAt`) is hung up instead: a
				// wake-up must never hand a squatter a fresh reservation.
				if (att.host && !att.id) {
					if (Date.now() - (att.reservedAt ?? -Infinity) < RESERVE_MS) hub.reserve(ws, this.code, att.reservedAt);
					else {
						try {
							ws.close(4408, "unhosted");
						} catch {}
					}
				} else hub.rebind(ws, this.code, att.id);
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
		const url = new URL(request.url);
		const [, code, fresh] = url.pathname.match(OBJECT_PATH) ?? [];
		const hub = await this.hub(code);
		if (request.headers.get("Upgrade") !== "websocket") {
			return new Response("websocket required", { status: 426 });
		}
		// `/new`: the routing Worker drew this code for a host and asks
		// whether it is free. 409 is for the Worker alone — it draws again,
		// and the client never hears of it.
		if (fresh && hub.rooms.has(code)) return new Response("taken", { status: 409 });
		const [client, server] = Object.values(new WebSocketPair());
		this.state.acceptWebSocket(server);
		const reservedAt = Date.now();
		if (fresh) hub.reserve(server, code, reservedAt); // synchronous since the check: nobody slips in
		// Serialized now, not after the first join: the rate limits count
		// failures per IP, and a socket whose first message fails has to be
		// counted under its own address, not under one shared "unknown".
		// `dial`: the routing Worker charged this socket's upgrade, owed
		// back on its first successful join/release (refundDial). Charged
		// means a GATE exists, it is not a host's (`/new`, never
		// dial-charged), and it carries no pass the Worker let through.
		// The pass is re-checked here *ignoring expiry*: one that expired
		// between the Worker's check and this one must not read as charged,
		// or its refund would mint a dial nobody paid — the error runs the
		// other way, a member losing one dial at the very edge.
		const dial = !!this.env?.GATE && !fresh && !(await passOf(this.env, code, url, true));
		server.serializeAttachment({ ip: ip(request), code, dial, ...(fresh && { host: true, reservedAt }) });
		// A reservation arms the alarm that lapses it (RESERVE_MS): a
		// socket that never says `host` is hung up and the code freed.
		if (fresh) await this.persist();
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
		// Read once, for what never changes on a socket (its code and
		// address). Never for `dial`: messages on one socket interleave
		// across every await below, so this copy can be stale by the time
		// it is used — refundDial reads the live one.
		const att = attachmentOf(ws);
		const hub = await this.hub(att.code);
		const reply = (body) => {
			try {
				ws.send(JSON.stringify(body));
			} catch {} // a socket mid-close: its own close event follows
		};
		if (msg.t === "release") {
			// A claim given back from a socket that holds no seat (hub.js
			// `releaseClaim`): answered, hung up, and never bound — so the
			// attachment never names a member.
			const answer =
				msg.code !== this.code
					? { t: "error", reason: "bad-code" }
					: await hub.releaseClaim(att.ip, msg, ws);
			reply(answer);
			// `bound`: this socket already asked; that ask's answer stands.
			if (answer.reason === "bound") return;
			if (answer.t !== "error") await this.refundDial(ws);
			ws.close(answer.t === "error" ? 4400 : 1000, answer.reason ?? answer.t);
		} else if (msg.t === "host" || msg.t === "join") {
			// A join's code has to name this object's room; anything else is
			// a misdelivered message, not a guess of this room's code. A host
			// names no code: it opens the one its socket reserved, and only
			// a `/room/new` socket reserved one.
			let answer =
				msg.t === "host"
					? await hub.host(ws, msg)
					: msg.code !== this.code
						? { t: "error", reason: "bad-code" }
						: await hub.join(ws, att.ip, msg);
			if (answer.t === "error") {
				reply(answer);
				// `bound`: a second host/join on a socket that already
				// asked (pipelined, or after its seat). Refused, nothing
				// changed, and the socket keeps what its first ask got.
				if (answer.reason === "bound") return;
				return ws.close(4400, answer.reason);
			}
			// Every seat granted comes with a pass for its re-dials.
			answer = { ...answer, ...(await this.pass(msg.id)) };
			reply(answer);
			// A join that got in was no probe. (A host's socket was never
			// dial-charged: `/room/new`.)
			if (msg.t === "join") await this.refundDial(ws);
			// `at` orders a member's sockets on a wake-up (see hub()).
			ws.serializeAttachment({ ...attachmentOf(ws), host: false, dial: false, id: msg.id, at: Date.now() });
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
	 * A pass for `id`'s seat in this room (hub.js signPass): `{pass, exp}`,
	 * or nothing without ROOM_PASS_KEY — the client then re-dials without
	 * one and is charged, which is how it was before passes.
	 */
	async pass(id) {
		const key = passKey(this.env);
		if (!key) return {};
		const exp = Date.now() + PASS_TTL_MS;
		return { pass: await signPass(key, this.code, id, exp), exp };
	}

	/**
	 * Give back the dial the routing Worker charged for this socket: it
	 * reached a seat (or gave one back, which needs the claim's secret), so
	 * it was never a probe. Once per socket, and only the charge this
	 * socket's own upgrade made; a refund that cannot be delivered is
	 * dropped (the dial stays counted, which errs towards the limit).
	 *
	 * The flag is read from the *live* attachment and cleared before any
	 * await, so the check and the clear are one step. It used to trust the
	 * copy webSocketMessage read on entry: six joins pipelined on one
	 * socket each read `dial: true` there, interleaved across the gate's
	 * await, and refunded six dials for one upgrade (2026-11-12, review).
	 */
	async refundDial(ws) {
		const att = attachmentOf(ws);
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
		// No room (gone, or only reserved — a reservation is never stored):
		// nothing in storage. The alarm is armed either way: a reservation
		// needs one to lapse.
		if (room) await this.state.storage.put("room", room);
		else await this.state.storage.delete("room");
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
	return prefixOf(ip, 4) ?? String(ip ?? "").trim().toLowerCase();
}

/**
 * The IPv6 /48 an address is in (`<prefix>::/48`), or null for IPv4: the
 * second gate `/room/new` charges (HOST_SITE_ROOMS). An IPv4 address is
 * one customer already; a /48 is a site of 65 536 /64s.
 */
function siteKey(ip) {
	return prefixOf(ip, 3);
}

/** The first `groups` 16-bit groups of an IPv6 address, as `x:y:…::/<bits>`; null for IPv4 (or IPv4-mapped). */
function prefixOf(ip, groups) {
	const s = String(ip ?? "").trim().toLowerCase();
	if (!s.includes(":")) return null;
	const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
	if (mapped) return groups === 4 ? mapped[1] : null;
	const [head, tail] = s.split("%")[0].split("::");
	const left = head ? head.split(":") : [];
	const right = tail ? tail.split(":") : [];
	const all =
		tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
	return all.slice(0, groups).map((g) => (parseInt(g, 16) || 0).toString(16)).join(":") + "::/" + groups * 16;
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
 * One IP's counters: the object every room charges a join against, named
 * `ip:<address>` (`ip:<prefix>::/64` for IPv6). Each is the hub's own
 * limiter (makeLimiter), held in one place per address instead of one per
 * room. Requests are `POST /charge` → `{ok}` and `POST /refund` (guesses),
 * `/dial` and `/undial` (unproven upgrades), `/host` (rooms opened) and
 * `/site` (rooms opened by an IPv6 /48, at the /48's own gate), the key
 * as the body.
 *
 * Persisted, so an eviction mid-window does not forgive a guesser; an alarm
 * at the window's close clears the storage again, so an address that stops
 * guessing leaves nothing behind.
 */
export class IpGate {
	constructor(state) {
		this.state = state;
		this.ready = null; // Promise<{ entry, dial, host, site }>, one limiter each
	}

	/**
	 * Four counters, one window each: guesses, upgrades, rooms opened, and
	 * rooms opened by a whole IPv6 /48 (`site`, only ever charged at a
	 * /48's gate).
	 */
	limiters() {
		this.ready ??= (async () => {
			const load = async (key, max) => {
				const stored = await this.state.storage.get(key);
				const entries = new Map(stored ? [[stored.ip, { count: stored.count, firstAt: stored.firstAt }]] : []);
				return makeLimiter({ entries, max });
			};
			return {
				entry: await load("entry"),
				dial: await load("dial", DIAL_FAILS),
				host: await load("host", HOST_ROOMS),
				site: await load("site", HOST_SITE_ROOMS),
				api: await load("api", API_WRITES),
			};
		})();
		return this.ready;
	}

	async fetch(request) {
		const op = new URL(request.url).pathname;
		const ip = await request.text();
		const { entry, dial, host, site, api } = await this.limiters();
		// Synchronous between the await above and the write below, so two
		// rooms charging at once cannot both spend the last attempt.
		let ok = true;
		if (op === "/charge") ok = entry.charge(ip);
		else if (op === "/refund") entry.refund(ip);
		else if (op === "/dial") ok = dial.charge(ip);
		else if (op === "/undial") dial.refund(ip);
		else if (op === "/host") ok = host.charge(ip);
		else if (op === "/site") ok = site.charge(ip);
		else if (op === "/api") ok = api.charge(ip);
		else return new Response("not found", { status: 404 });
		await this.save(ip);
		return Response.json({ ok });
	}

	async alarm() {
		const stored =
			(await this.state.storage.get("entry")) ??
			(await this.state.storage.get("dial")) ??
			(await this.state.storage.get("host")) ??
			(await this.state.storage.get("site")) ??
			(await this.state.storage.get("api"));
		if (stored) await this.save(stored.ip);
	}

	/** Persist every counter; the alarm wakes at the earliest window's close. */
	async save(ip) {
		const limiters = await this.limiters();
		let until = Infinity;
		for (const key of ["entry", "dial", "host", "site", "api"]) {
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
