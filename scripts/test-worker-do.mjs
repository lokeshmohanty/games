#!/usr/bin/env node
// scripts/test-worker-do.mjs — the Durable Object shell, through an eviction.
//
// test-hub.mjs proves the rules; this proves the shell that carries them
// survives what Cloudflare does to it. `wrangler dev` never hibernates or
// evicts an object, so the one way to exercise a wake-up before a deploy is
// to do it by hand: drive worker/index.js's RoomSignal with a fake `state`
// (storage, getWebSockets, acceptWebSocket, attachments) and fake sockets,
// then throw the instance away and build a FRESH one over the same storage
// and the same sockets — which is exactly, and only, what an eviction leaves
// behind. Every handler is then the first thing to run on a cold object:
// a message, a close, an alarm, a new connection.
//
// The per-IP gate (IpGate) is driven the same way, as the real
// namespace-of-objects it is: one fake object per name.
//
// What this cannot prove: that workerd's getWebSockets() hands back the
// very objects its handlers later receive. The fake does; the docs say so;
// only a deploy shows it.

import worker, { RoomSignal, IpGate } from "../worker/index.js";
import { DIAL_FAILS, HOST_ROOMS, HOST_SITE_ROOMS, JOIN_FAILS, RESERVE_MS, signPass } from "../worker/hub.js";

let failures = 0;
const check = (label, ok, detail = "") => {
	console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
	if (!ok) failures++;
};

// A clock the test owns: the shell reads Date.now() for attachments, and the
// hub for TTLs, so advancing it is how an alarm finds something to sweep.
let clock = 1_700_000_000_000;
Date.now = () => clock;
const tick = (ms = 1) => (clock += ms);

// ------------------------------------------------------------- the fakes

/** The server end of a hibernatable socket: what it was sent, and its attachment. */
function serverSocket(label) {
	return {
		label,
		received: [],
		closed: null, // { code, reason } once the server hung up
		att: undefined,
		send(raw) {
			if (this.closed) throw new Error("send on a closed socket");
			this.received.push(JSON.parse(raw));
		},
		close(code, reason) {
			this.closed ??= { code, reason };
		},
		accept() {
			this.accepted = true; // only the routing Worker's own sockets: a room's go through state.acceptWebSocket
		},
		serializeAttachment(value) {
			this.att = structuredClone(value);
		},
		deserializeAttachment() {
			return this.att === undefined ? null : structuredClone(this.att);
		},
	};
}

// The runtime pair the shell constructs: index [1] is the end it accepts.
let pairLabel = "?";
globalThis.WebSocketPair = class {
	constructor() {
		this[1] = serverSocket(pairLabel);
		this[0] = { client: true, server: this[1] }; // the test's window on the far end
	}
};
/**
 * The status a browser could act on: an upgrade the routing Worker refused
 * past a budget is a 101 on a socket of its own that says `blocked` and
 * hangs up 4429 (index.js `refusal`) — read here as the 429 it stands for.
 */
const statusOf = (res) => {
	const far = res.webSocket?.server;
	return res.status === 101 && far?.accepted && far.received[0]?.reason === "blocked" && far.closed?.code === 4429
		? 429
		: res.status;
};
// Node's Response refuses status 101; the Workers runtime does not.
const NodeResponse = globalThis.Response;
globalThis.Response = class extends NodeResponse {
	constructor(body, init = {}) {
		super(body, init.status === 101 ? { ...init, status: 200 } : init);
		if (init.status === 101) Object.defineProperty(this, "status", { value: 101 });
		this.webSocket = init.webSocket;
	}
};

/**
 * Durable Object state. Storage is structured-cloned in and out, as the
 * real one is. `getWebSockets()` returns sockets newest-first and keeps the
 * ones the server closed: the runtime promises no order, and a socket mid-
 * close may still be listed — the harsher case is the one worth testing.
 */
function makeState() {
	const data = new Map();
	const sockets = [];
	const state = {
		data,
		sockets,
		alarm: null,
		storage: {
			get: async (k) => structuredClone(data.get(k)),
			put: async (k, v) => void data.set(k, structuredClone(v)),
			delete: async (k) => data.delete(k),
			setAlarm: async (t) => void (state.alarm = t),
			deleteAlarm: async () => void (state.alarm = null),
			getAlarm: async () => state.alarm,
		},
		acceptWebSocket: (ws) => void sockets.push(ws),
		getWebSockets: () => [...sockets].reverse(),
	};
	return state;
}

/** A namespace of IpGate objects; an eviction is `gates.evict()`. */
function makeGates() {
	const states = new Map();
	const live = new Map();
	return {
		states,
		idFromName: (name) => name,
		get(name) {
			if (!states.has(name)) states.set(name, makeState());
			if (!live.has(name)) live.set(name, new IpGate(states.get(name)));
			const obj = live.get(name);
			return { fetch: (url, init) => obj.fetch(new Request(url, init)) };
		},
		evict: () => live.clear(),
	};
}

const gates = makeGates();
const env = { GATE: gates };

/** Open a socket to `obj` for room `code` from `ip`; returns the server end. */
async function connect(obj, state, code, ip, label) {
	pairLabel = label;
	const res = await obj.fetch(
		new Request(`https://room.test/room/${code}`, {
			headers: { Upgrade: "websocket", "CF-Connecting-IP": ip },
		}),
	);
	if (res.status !== 101) throw new Error(`no upgrade: ${res.status}`);
	return state.sockets.at(-1);
}
/**
 * Open room `code` with a host, as `/room/new` does: the routing Worker
 * drew `code` and forwards the upgrade to `/room/<code>/new`, and the
 * socket's `host` opens it. Returns the host's server end.
 */
async function hostIn(obj, state, code, ip, label, { id, secret }) {
	pairLabel = label;
	const res = await obj.fetch(
		new Request(`https://room/room/${code}/new`, { headers: { Upgrade: "websocket", "CF-Connecting-IP": ip } }),
	);
	if (res.status !== 101) throw new Error(`no host upgrade: ${res.status}`);
	const ws = state.sockets.at(-1);
	await say(obj, ws, { t: "host", id, secret });
	return ws;
}
const say = (obj, ws, msg) => obj.webSocketMessage(ws, JSON.stringify(msg));
const last = (ws, pred = () => true) => ws.received.filter(pred).at(-1);

// ------------------------------------------------------------------ tests

console.log("\nA room survives eviction");
{
	const state = makeState();
	let obj = new RoomSignal(state, env);
	const a = await hostIn(obj, state, "300001", "1.1.1.1", "a", { id: "a", secret: "sa" });
	check("host answered", last(a)?.t === "room", JSON.stringify(last(a)));
	tick();
	const b = await connect(obj, state, "300001", "2.2.2.2", "b");
	await say(obj, b, { t: "join", code: "300001", id: "b", secret: "sb" });
	check("join answered", last(b)?.t === "joined", JSON.stringify(last(b)));
	check("host told to offer", last(a, (m) => m.t === "peer")?.offering === "a");
	check("claims are in storage", state.data.get("room")?.members?.length === 2);
	check("an alarm is armed", typeof state.alarm === "number");

	// ---- eviction 1: the first thing a cold object sees is a relay
	obj = new RoomSignal(state, env);
	await say(obj, a, { t: "offer", to: "b", sdp: "OFFER-1" });
	check("a cold object relays an offer to the right socket", last(b)?.sdp === "OFFER-1", JSON.stringify(last(b)));
	check("from the right member", last(b)?.from === "a");
	await say(obj, b, { t: "answer", to: "a", sdp: "ANSWER-1" });
	check("and the answer back", last(a)?.sdp === "ANSWER-1");
	await say(obj, a, { t: "full", to: "b" });
	check("full is relayed, with no sdp", last(b)?.t === "full" && last(b)?.from === "a" && !("sdp" in last(b)));
	check("the wake-up announced nothing", !b.received.some((m) => m.t === "peer"));

	// ---- eviction 2: the first thing is a close
	obj = new RoomSignal(state, env);
	await obj.webSocketClose(b, 1006, "");
	const gone = last(a, (m) => m.t === "peer");
	check("a cold object's close reaches the others", gone?.id === "b" && gone?.connected === false, JSON.stringify(gone));
	check("the claim outlives the socket", state.data.get("room")?.members?.some((m) => m.id === "b" && m.leftAt));

	// ---- eviction 3: the first thing is a new connection (b reloading)
	obj = new RoomSignal(state, env);
	tick();
	const b2 = await connect(obj, state, "300001", "2.2.2.2", "b2");
	await say(obj, b2, { t: "join", code: "300001", id: "b", secret: "sb" });
	check("the claim survived: b rejoins its seat", last(b2)?.t === "joined", JSON.stringify(last(b2)));
	const back = last(a, (m) => m.t === "peer");
	check("the host hears b is back, and is told to offer", back?.connected === true && back?.offering === "a");
	await say(obj, a, { t: "offer", to: "b", sdp: "OFFER-2" });
	check("offers go to the new socket", last(b2)?.sdp === "OFFER-2");
	check("never the dead one", !b.received.some((m) => m.sdp === "OFFER-2"));

	// ---- eviction 4: the first thing is an alarm
	obj = new RoomSignal(state, env);
	await obj.alarm();
	check("a cold alarm keeps a live room", !!state.data.get("room") && typeof state.alarm === "number");
	await say(obj, b2, { t: "answer", to: "a", sdp: "ANSWER-2" });
	check("and the room it rebuilt still relays", last(a)?.sdp === "ANSWER-2");

	// ---- eviction 5: a deliberate leave from a cold object
	obj = new RoomSignal(state, env);
	await say(obj, b2, { t: "leave", id: "b", secret: "sb" });
	check("leave closes the socket as its receipt", b2.closed?.code === 1000, JSON.stringify(b2.closed));
	check("the claim is gone", !state.data.get("room").members.some((m) => m.id === "b"));
	check("and the host hears it", last(a, (m) => m.t === "peer")?.connected === false);

	// ---- the 24-hour cap, swept by an alarm on a cold object
	obj = new RoomSignal(state, env);
	tick(24 * 60 * 60 * 1000 + 1);
	await obj.alarm();
	check("the cap sweeps the room from storage", !state.data.has("room"));
	check("and disarms the alarm", state.alarm === null);
}

console.log("\nA half-open socket never wins a wake-up");
{
	// b's first socket died without the server noticing; b rejoins on a new
	// one. The hub hangs up the old one, and after an eviction the rebuilt
	// hub must bind b to the new socket even though getWebSockets() lists
	// the old one too, and lists it last.
	const state = makeState();
	let obj = new RoomSignal(state, env);
	const a = await hostIn(obj, state, "300002", "1.1.1.1", "a", { id: "a", secret: "sa" });
	tick();
	const old = await connect(obj, state, "300002", "2.2.2.2", "old");
	await say(obj, old, { t: "join", code: "300002", id: "b", secret: "sb" });
	tick();
	const fresh = await connect(obj, state, "300002", "2.2.2.2", "fresh");
	await say(obj, fresh, { t: "join", code: "300002", id: "b", secret: "sb" });
	check("the replaced socket is hung up", old.closed?.code === 4409, JSON.stringify(old.closed));

	obj = new RoomSignal(state, env);
	await say(obj, a, { t: "offer", to: "b", sdp: "AFTER-WAKE" });
	check("after a wake-up the newer socket gets the offer", last(fresh)?.sdp === "AFTER-WAKE");
	check("the stale one gets nothing", !old.received.some((m) => m.sdp === "AFTER-WAKE"));
}

console.log("\nThe reachability probe never reaches an object");
{
	// It used to be a WebSocket `ping` to room 000000: one hot object every
	// client in the world probed. Now the routing Worker answers it.
	let routed = 0;
	const ns = { idFromName: (n) => n, get: () => (routed++, { fetch: async () => new Response("room") }) };
	const res = await worker.fetch(new Request("https://room.test/ping"), { ROOM: ns, GATE: gates });
	check("GET /ping is a 204", res.status === 204, String(res.status));
	check("readable cross-origin (file:// and any https page)", res.headers.get("Access-Control-Allow-Origin") === "*");
	check("never cached", /no-store/.test(res.headers.get("Cache-Control") ?? ""));
	check("no Durable Object was touched", routed === 0);
	const ws = await worker.fetch(new Request("https://room.test/room/123456"), { ROOM: ns });
	check("(a room path without an upgrade is still refused)", ws.status === 426 && routed === 0);
}

console.log("\nA claim is released without binding (release)");
{
	const state = makeState();
	const obj = new RoomSignal(state, env);
	const h = await hostIn(obj, state, "300010", "1.1.1.1", "h", { id: "h", secret: "sh" });
	const x = await connect(obj, state, "300010", "2.2.2.2", "x");
	await say(obj, x, { t: "join", code: "300010", id: "x", secret: "sx" });
	const gateOps = () => gates.states.get("ip:3.3.3.3")?.data.get("entry")?.count ?? 0;
	const r1 = await connect(obj, state, "300010", "3.3.3.3", "r1");
	await say(obj, r1, { t: "release", code: "300010", id: "x", secret: "sx" });
	check("a live seat answers busy", last(r1)?.t === "busy", JSON.stringify(last(r1)));
	check("the asking socket is hung up", r1.closed?.code === 1000, JSON.stringify(r1.closed));
	check("the live socket is not", x.closed === null, JSON.stringify(x.closed));
	check("and is still bound: offers reach it", (await say(obj, h, { t: "offer", to: "x", sdp: "O" }), last(x)?.sdp === "O"));
	check("the asking socket was never bound", !r1.att?.id);
	await obj.webSocketClose(x, 1006, "");
	const r2 = await connect(obj, state, "300010", "3.3.3.3", "r2");
	await say(obj, r2, { t: "release", code: "300010", id: "x", secret: "sx" });
	check("a detached seat is released", last(r2)?.t === "released", JSON.stringify(last(r2)));
	check("the claim is gone from storage", !state.data.get("room").members.some((m) => m.id === "x"));
	check("a verified release is never charged", gateOps() === 0, String(gateOps()));
	const r3 = await connect(obj, state, "300010", "3.3.3.3", "r3");
	await say(obj, r3, { t: "release", code: "300010", id: "h", secret: "wrong" });
	check("an unproven release is refused", last(r3)?.reason === "no-claim", JSON.stringify(last(r3)));
	check("and charged like a guess", gateOps() === 1, String(gateOps()));
	check("with the error close", r3.closed?.code === 4400, JSON.stringify(r3.closed));
}

console.log("\nGuesses count across rooms (IpGate)");
{
	// Ten different codes are ten different objects; only the gate sees all
	// ten guesses.
	const guess = async (code, ip) => {
		const state = makeState();
		const obj = new RoomSignal(state, env);
		const ws = await connect(obj, state, code, ip, "g");
		await say(obj, ws, { t: "join", code, id: "x", secret: "y" });
		return ws.received.at(-1)?.reason;
	};
	const answers = [];
	for (let i = 0; i < 10; i++) answers.push(await guess(String(400000 + i), "6.6.6.6"));
	check("ten wrong codes in ten rooms: no-room each", answers.every((r) => r === "no-room"), answers.join());
	check("the eleventh, in an eleventh room, is blocked", (await guess("400010", "6.6.6.6")) === "blocked");
	check("another IP is unaffected", (await guess("400011", "7.7.7.7")) === "no-room");

	gates.evict();
	check("an evicted gate still blocks", (await guess("400012", "6.6.6.6")) === "blocked");
	check("the gate's storage carries an expiry alarm", typeof gates.states.get("ip:6.6.6.6").alarm === "number");

	const live = makeState();
	const lobj = new RoomSignal(live, env);
	await hostIn(lobj, live, "400100", "8.8.8.8", "h", { id: "h", secret: "s" });
	// No client names a code to host any more: a `host` on a plain room
	// socket is refused, and asks nothing of the gate.
	const stray = await connect(lobj, live, "400100", "9.9.9.9", "t");
	await say(lobj, stray, { t: "host", code: "400100", id: "t", secret: "s" });
	check("a host on a plain room socket is bad-code", stray.received.at(-1)?.reason === "bad-code", JSON.stringify(stray.received.at(-1)));
	check("and is no guess", !gates.states.get("ip:9.9.9.9")?.data.has("entry"));

	// A success costs nothing: a friend who joins and rejoins all evening
	// never runs out of attempts.
	const friendly = [];
	for (let i = 0; i < 15; i++) {
		const ws = await connect(lobj, live, "400100", "5.5.5.5", "f");
		await say(lobj, ws, { t: "join", code: "400100", id: "friend", secret: "fs" });
		friendly.push(ws.received.at(-1)?.t);
	}
	check("successful joins are refunded", friendly.every((t) => t === "joined"), friendly.join());

	// The window closes; the gate's alarm forgets the address.
	tick(5 * 60 * 1000 + 1);
	const gate = gates.states.get("ip:6.6.6.6");
	gates.evict();
	await new IpGate(gate).alarm();
	check("the alarm clears an expired gate", !gate.data.has("entry") && gate.alarm === null);
	check("and the guesser may try again", (await guess("400013", "6.6.6.6")) === "no-room");
}

console.log("\nA gate that fails, fails closed");
{
	// Before: a gate error fell back to a per-room limiter, so anybody who
	// could overload the gate object switched the cross-room limit off.
	const ops = [];
	let down = false;
	const flaky = {
		idFromName: (name) => name,
		get: (name) => ({
			fetch: async (url) => {
				const op = new URL(url).pathname.slice(1);
				ops.push(op);
				if (down && op === "charge") throw new Error("gate overloaded");
				return Response.json({ ok: true });
			},
		}),
	};
	const state = makeState();
	const obj = new RoomSignal(state, { GATE: flaky });
	const h = await hostIn(obj, state, "400300", "1.1.1.1", "h", { id: "h", secret: "sh" });
	const m = await connect(obj, state, "400300", "2.2.2.2", "m");
	await say(obj, m, { t: "join", code: "400300", id: "m", secret: "sm" });
	check("(a room with a member)", last(m)?.t === "joined", JSON.stringify(last(m)));

	down = true;
	ops.length = 0;
	const reasons = [];
	for (let i = 0; i < 12; i++) {
		const ws = await connect(obj, state, "400300", "6.6.6.6", "g");
		await say(obj, ws, { t: "join", code: "400300", id: `g${i}`, secret: "y" });
		reasons.push(ws.received.at(-1)?.reason);
	}
	check("every unproven join is blocked while the gate is down", reasons.every((r) => r === "blocked"), reasons.join());
	check("and nothing is refunded to the gate for them", !ops.includes("refund"), ops.join());

	ops.length = 0;
	const back = await connect(obj, state, "400300", "2.2.2.2", "m2");
	await say(obj, back, { t: "join", code: "400300", id: "m", secret: "sm" });
	// It does give back the dial its upgrade was charged (undial) — a
	// refund, which needs no answer, so a gate outage cannot hold it up.
	check(
		"a member's rejoin never needs the guess gate",
		last(back)?.t === "joined" && ops.every((op) => op === "undial"),
		`${JSON.stringify(last(back))} ${ops.join()}`,
	);
}

console.log("\nEvery upgrade spends a dial; a member's comes back (timing oracle)");
{
	// Measured on real Cloudflare (2026-11-11): a never-used code's object
	// answers its upgrade ~180 ms later than a live one's. A socket that
	// sends nothing used to cost nothing, so the oracle was free.
	const rooms = new Map();
	let touched = 0;
	const ns = {
		idFromName: (n) => n,
		get(name) {
			touched++;
			if (!rooms.has(name)) {
				const state = makeState();
				rooms.set(name, { state, obj: new RoomSignal(state, env) });
			}
			const { obj } = rooms.get(name);
			return { fetch: (req) => obj.fetch(req) };
		},
	};
	const workerEnv = { ROOM: ns, GATE: gates };
	const upgrade = (code, ip) =>
		worker.fetch(new Request(`https://room.test/room/${code}`, { headers: { Upgrade: "websocket", "CF-Connecting-IP": ip } }), workerEnv);
	const dials = (ip) => gates.states.get("ip:" + ip)?.data.get("dial")?.count ?? 0;

	// Never more probes than guesses: a dead code costs a prober one dial
	// however it asks, so the 101's timing must buy no more codes per
	// window than `join` does (2026-11-12; it was 2x).
	check("the probe budget is the guess budget", DIAL_FAILS === JOIN_FAILS, `${DIAL_FAILS} vs ${JOIN_FAILS}`);
	const statuses = [];
	for (let i = 0; i < DIAL_FAILS; i++) statuses.push(statusOf(await upgrade(String(500000 + i), "11.0.0.1")));
	check(`${DIAL_FAILS} silent upgrades are let through`, statuses.every((s) => s === 101), statuses.join());
	const before = touched;
	const refused = await upgrade("500020", "11.0.0.1");
	check("the next is refused: blocked (429)", statusOf(refused) === 429, String(refused.status));
	check(
		"on a socket the routing Worker accepted itself, saying blocked",
		refused.webSocket?.server?.accepted === true &&
			JSON.stringify(refused.webSocket.server.received) === JSON.stringify([{ t: "error", reason: "blocked" }]),
		JSON.stringify(refused.webSocket?.server?.received),
	);
	check("before any room object is touched", touched === before);
	check("another address is unaffected", (await upgrade("500021", "11.0.0.2")).status === 101);
	check("/ping is never limited", (await worker.fetch(new Request("https://room.test/ping", { headers: { "CF-Connecting-IP": "11.0.0.1" } }), workerEnv)).status === 204);

	// A member's dials are refunded (this gate has no pass key: the
	// fallback when ROOM_PASS_KEY is unset). Host, then rejoin thirty times.
	ns.get("code:500100");
	const { state, obj } = rooms.get("code:500100");
	await hostIn(obj, state, "500100", "11.0.0.3", "h", { id: "h", secret: "sh" });
	await upgrade("500100", "11.0.0.3");
	await say(obj, state.sockets.at(-1), { t: "join", code: "500100", id: "m", secret: "sm" });
	check("(a member, whose join refunded its dial)", dials("11.0.0.3") === 0, String(dials("11.0.0.3")));
	const answers = [];
	for (let i = 0; i < 30; i++) {
		const r = await upgrade("500100", "11.0.0.3");
		if (statusOf(r) !== 101) {
			answers.push(statusOf(r));
			continue;
		}
		const ws = state.sockets.at(-1);
		await say(obj, ws, { t: "join", code: "500100", id: "m", secret: "sm" });
		answers.push(last(ws)?.t);
	}
	check("thirty rejoins never run out of dials", answers.every((t) => t === "joined"), answers.join());
	check("and leave nothing counted", dials("11.0.0.3") === 0, String(dials("11.0.0.3")));
	// A dial is refunded once, not once per message.
	const r2 = await upgrade("500100", "11.0.0.4");
	const ws2 = state.sockets.at(-1);
	check("(upgraded)", r2.status === 101);
	await say(obj, ws2, { t: "join", code: "500100", id: "n", secret: "sn" });
	await say(obj, ws2, { t: "join", code: "500100", id: "n", secret: "sn" });
	check("a second join on one socket is refused (bound)", last(ws2)?.reason === "bound" && !ws2.closed, JSON.stringify(last(ws2)));
	check("and refunds nothing more", (gates.states.get("ip:11.0.0.4")?.data.get("dial")?.count ?? 0) === 0);
	await upgrade("500101", "11.0.0.4");
	check("so the next silent dial still counts", dials("11.0.0.4") === 1, String(dials("11.0.0.4")));

	// The window closes; the alarm forgets both counters.
	tick(5 * 60 * 1000 + 1);
	const gate = gates.states.get("ip:11.0.0.1");
	gates.evict();
	await new IpGate(gate).alarm();
	check("the alarm clears an expired dial count", !gate.data.has("dial") && gate.alarm === null);
	check("and the prober may dial again", (await upgrade("500022", "11.0.0.1")).status === 101);

	// A gate that cannot answer refuses the upgrade (2026-11-12; it let it
	// through). Failing open was a free probe for anyone who could make
	// their own gate fail by flooding it — and the room then refunded a
	// dial that was never charged, minting budget.
	const broken = { idFromName: (n) => n, get: () => ({ fetch: async () => { throw new Error("down"); } }) };
	const beforeBroken = touched;
	const r3 = await worker.fetch(new Request("https://room.test/room/500200", { headers: { Upgrade: "websocket", "CF-Connecting-IP": "11.0.0.5" } }), { ROOM: ns, GATE: broken });
	check("a gate outage fails closed for upgrades (503)", r3.status === 503, String(r3.status));
	check("before any room object is touched", touched === beforeBroken);

	// A release refunds only with the claim's secret: a prober's release
	// on a code it guessed is an error, and its dial stays spent.
	const rp = await upgrade("500100", "11.0.0.7");
	check("(upgraded)", rp.status === 101);
	await say(obj, state.sockets.at(-1), { t: "release", code: "500100", id: "h", secret: "guess" });
	check("an unproven release keeps its dial spent", dials("11.0.0.7") === 1, String(dials("11.0.0.7")));
	const rm = await upgrade("500100", "11.0.0.7");
	check("(upgraded)", rm.status === 101);
	const mws = state.sockets.at(-1);
	await obj.webSocketClose(state.sockets.find((w) => w.att?.id === "m" && !w.closed) ?? mws, 1006, "");
	await say(obj, mws, { t: "release", code: "500100", id: "m", secret: "sm" });
	check("a verified release gives its own dial back", last(mws)?.t === "released" && dials("11.0.0.7") === 1, `${JSON.stringify(last(mws))} ${dials("11.0.0.7")}`);
}

console.log("\nOnly a room path with an upgrade reaches a room, and every one is charged");
{
	// Every request that could touch a room object must have spent a dial
	// first; everything else must be answered by the routing Worker alone.
	let touched = 0;
	const ns = { idFromName: (n) => n, get: () => (touched++, { fetch: async () => new Response(null, { status: 101 }) }) };
	const workerEnv = { ROOM: ns, GATE: gates };
	const dials = (ip) => gates.states.get("ip:" + ip)?.data.get("dial")?.count ?? 0;
	const send = (path, headers = { Upgrade: "websocket" }, method = "GET") =>
		worker.fetch(new Request("https://room.test" + path, { method, headers: { ...headers, "CF-Connecting-IP": "11.0.1.1" } }), workerEnv);
	const variants = [
		["/room/123456/", 404],
		["/room/0123456", 404],
		["/room/12345", 404],
		["/room/12345a", 404],
		["/room/%31%32%33%34%35%36", 404],
		["/room/１２３４５６", 404], // fullwidth digits: \d is ASCII only
		["//room/123456", 404],
		["/ROOM/123456", 404],
		["/room/123456/x", 404],
		["/room/123456/new", 404], // only the Worker addresses an object's /new
		["/room/new/", 404],
		["/room/NEW", 404],
		["/ping", 204],
	];
	const got = [];
	for (const [path, want] of variants) {
		const r = await send(path);
		got.push(`${path}:${r.status}`);
		if (r.status !== want) check(`${path} answers ${want}`, false, String(r.status));
	}
	check("path variants are refused by the Worker", touched === 0 && dials("11.0.1.1") === 0, `${got.join(" ")} touched=${touched}`);
	const plain = await send("/room/123456", {});
	const cased = await send("/room/123456", { Upgrade: "WebSocket" });
	check("a room path without a websocket upgrade is 426, untouched", plain.status === 426 && cased.status === 426 && touched === 0);
	check("and uncharged (nothing reached a room)", dials("11.0.1.1") === 0);
	const q = await send("/room/123456?x=1#y");
	check("a query string is the same room, and charged", q.status === 101 && touched === 1 && dials("11.0.1.1") === 1, `${q.status} ${touched} ${dials("11.0.1.1")}`);
	await send("/room/123456", { Upgrade: "websocket" }, "POST");
	check("so is any other method", touched === 2 && dials("11.0.1.1") === 2, `${touched} ${dials("11.0.1.1")}`);
}

console.log("\nHosting is /room/new: the server draws the code, and it costs no dial");
{
	// Until 2026-11-12 the client drew its code and the host's success
	// said "that code was dead", so every host had to spend a dial and a
	// guess — and a LAN party that hosted ten times blocked itself. Now the
	// Worker draws, asks the room to take it only if free, and redraws.
	const rooms = new Map();
	let touched = 0;
	const ns = {
		idFromName: (n) => n,
		get(name) {
			touched++;
			if (!rooms.has(name)) {
				const state = makeState();
				rooms.set(name, { state, obj: new RoomSignal(state, workerEnv) });
			}
			const { obj } = rooms.get(name);
			return { fetch: (req) => obj.fetch(req) };
		},
	};
	const workerEnv = { ROOM: ns, GATE: gates, ROOM_PASS_KEY: "test-pass-key" };
	const counts = (ip, key) => gates.states.get("ip:" + ip)?.data.get(key)?.count ?? 0;
	/** `/room/new` from `ip`, then `host`: the reply, or the HTTP status. */
	const hostNew = async (ip, id = "h" + Math.random().toString(36).slice(2, 8)) => {
		const res = await worker.fetch(
			new Request("https://room.test/room/new", { headers: { Upgrade: "websocket", "CF-Connecting-IP": ip } }),
			workerEnv,
		);
		if (statusOf(res) !== 101) return { status: statusOf(res) };
		const [, room] = [...rooms.entries()].find(([, r]) => r.state.sockets.some((w) => w.att?.host)) ?? [];
		const ws = room.state.sockets.find((w) => w.att?.host);
		await say(room.obj, ws, { t: "host", id, secret: "s" + id });
		return { ...ws.received.at(-1), ws, room, id };
	};

	const ip = "12.0.0.1";
	const made = [];
	for (let i = 0; i < HOST_ROOMS; i++) made.push(await hostNew(ip));
	check(`${HOST_ROOMS} hosts from one address all open a room`, made.every((r) => r.t === "room"), made.map((r) => r.t ?? r.status).join());
	check("each under a server-drawn six-digit code", made.every((r) => /^\d{6}$/.test(r.code)));
	check("all different", new Set(made.map((r) => r.code)).size === HOST_ROOMS);
	check("each the code of the object that holds it", made.every((r) => rooms.get("code:" + r.code)?.obj.code === r.code));
	check("each reply carries a member pass", made.every((r) => /^[A-Za-z0-9_-]{43}$/.test(r.pass) && r.exp > Date.now()));
	check("hosting spent no dial and no guess", counts(ip, "dial") === 0 && counts(ip, "entry") === 0, `${counts(ip, "dial")} ${counts(ip, "entry")}`);
	const before = touched;
	const capped = await hostNew(ip);
	check(`the ${HOST_ROOMS + 1}st is refused 429 (HOST_ROOMS)`, capped.status === 429, JSON.stringify(capped.status ?? capped.t));
	check("before any room object is touched", touched === before);
	check("another address still hosts", (await hostNew("12.0.0.2")).t === "room");
	check("and the capped address still joins", await (async () => {
		const r = await worker.fetch(new Request(`https://room.test/room/${made[0].code}`, { headers: { Upgrade: "websocket", "CF-Connecting-IP": ip } }), workerEnv);
		const { state, obj } = rooms.get("code:" + made[0].code);
		await say(obj, state.sockets.at(-1), { t: "join", code: made[0].code, id: "j", secret: "sj" });
		return r.status === 101 && last(state.sockets.at(-1))?.t === "joined";
	})());

	// A drawn code that is live is drawn again, and the client never hears
	// of it: force the draws to 100000 (live) and then 100001.
	const draws = [0, 0, 1];
	const random = crypto.getRandomValues.bind(crypto);
	crypto.getRandomValues = (arr) => (arr instanceof Uint32Array && draws.length ? ((arr[0] = draws.shift()), arr) : random(arr));
	const first = await hostNew("12.0.0.3");
	const second = await hostNew("12.0.0.3");
	crypto.getRandomValues = random;
	check("(the first draw opened 100000)", first.code === "100000", JSON.stringify(first.code));
	check("a live draw is redrawn: the host gets 100001", second.t === "room" && second.code === "100001", JSON.stringify(second.code ?? second.status));
	check("the live party's host is untouched", rooms.get("code:100000").obj.code === "100000" && !first.ws.closed);
	const all = [0, 0, 0, 0, 0, 0, 0, 0];
	crypto.getRandomValues = (arr) => (arr instanceof Uint32Array && all.length ? ((arr[0] = all.shift()), arr) : random(arr));
	const stuck = await hostNew("12.0.0.4");
	crypto.getRandomValues = random;
	check("only draws that all collide give up, 503", stuck.status === 503, JSON.stringify(stuck.status ?? stuck.t));

	const plain = await worker.fetch(new Request("https://room.test/room/new", { headers: { "CF-Connecting-IP": "12.0.0.5" } }), workerEnv);
	check("/room/new without an upgrade is 426", plain.status === 426);
	check("and charged nothing", counts("12.0.0.5", "host") === 0);
	const broken = { idFromName: (n) => n, get: () => ({ fetch: async () => { throw new Error("down"); } }) };
	const down = await worker.fetch(
		new Request("https://room.test/room/new", { headers: { Upgrade: "websocket", "CF-Connecting-IP": "12.0.0.6" } }),
		{ ROOM: ns, GATE: broken },
	);
	check("a gate outage fails closed for hosting too (503)", down.status === 503, String(down.status));

	// The reservation survives an eviction before the host speaks.
	const state = makeState();
	let obj = new RoomSignal(state, env);
	pairLabel = "early";
	await obj.fetch(new Request("https://room/room/700100/new", { headers: { Upgrade: "websocket", "CF-Connecting-IP": "12.0.0.7" } }));
	const early = state.sockets.at(-1);
	obj = new RoomSignal(state, env);
	const rival = await obj.fetch(new Request("https://room/room/700100/new", { headers: { Upgrade: "websocket" } }));
	check("an evicted object still holds the reservation (409 to a second draw)", rival.status === 409, String(rival.status));
	await say(obj, early, { t: "host", id: "e", secret: "se" });
	check("and the host's socket opens it", last(early)?.t === "room" && last(early)?.code === "700100", JSON.stringify(last(early)));
}

console.log("\nOne upgrade, one ask, one refund — however messages are pipelined");
{
	// Found 2026-11-12 (review): webSocketMessage read the attachment once
	// on entry and refundDial trusted that copy, so joins pipelined on one
	// socket — each awaiting the gate in turn — all read `dial: true` and
	// each refunded: one upgrade, six joins, six dials back. And the hub
	// bound the one socket under every id it was sent.
	const rooms = new Map();
	const workerEnv = { ROOM: null, GATE: gates, ROOM_PASS_KEY: "pipe-key" };
	workerEnv.ROOM = {
		idFromName: (n) => n,
		get(name) {
			if (!rooms.has(name)) {
				const state = makeState();
				rooms.set(name, { state, obj: new RoomSignal(state, workerEnv) });
			}
			const { obj } = rooms.get(name);
			return { fetch: (req) => obj.fetch(req) };
		},
	};
	const dials = (ip) => gates.states.get("ip:" + ip)?.data.get("dial")?.count ?? 0;
	const up = (path, ip) =>
		worker.fetch(new Request("https://room.test" + path, { headers: { Upgrade: "websocket", "CF-Connecting-IP": ip } }), workerEnv);
	const z = "13.0.0.1";
	await up("/room/new", z);
	const [name, room] = [...rooms.entries()].find(([, r]) => r.state.sockets.length);
	const code = name.slice(5);
	await say(room.obj, room.state.sockets.at(-1), { t: "host", id: "h", secret: "sh" });
	for (let i = 0; i < 5; i++) await up(`/room/${900000 + i}`, z);
	check("(five silent probes: five dials)", dials(z) === 5, String(dials(z)));
	await up(`/room/${code}`, z);
	const ws = room.state.sockets.at(-1);
	check("(the sixth upgrade is charged too)", dials(z) === 6, String(dials(z)));
	const ids = ["x1", "x2", "x3", "x4", "x5", "x6"];
	await Promise.all(ids.map((id) => say(room.obj, ws, { t: "join", code, id, secret: "s" })));
	const replies = ws.received.map((m) => m.t === "error" ? m.reason : m.t);
	check("six pipelined joins: one joined, five bound", replies.filter((r) => r === "joined").length === 1 && replies.filter((r) => r === "bound").length === 5, replies.join());
	check("one upgrade refunds one dial, at most", dials(z) === 5, String(dials(z)));
	const held = ids.filter((id) => room.state.data.get("room").members.some((m) => m.id === id));
	check("and the socket holds one seat, not six", held.length === 1, held.join());
	check("bound is no error close: the socket keeps its seat", !ws.closed, JSON.stringify(ws.closed));
	await say(room.obj, room.state.sockets.find((w) => w.att?.id === "h"), { t: "offer", to: held[0], sdp: "O" });
	check("and offers reach it under that one id", last(ws)?.sdp === "O", JSON.stringify(last(ws)));
	// A release pipelined with a join is one ask too.
	await up(`/room/${code}`, z);
	const ws2 = room.state.sockets.at(-1);
	await Promise.all([
		say(room.obj, ws2, { t: "release", code, id: held[0], secret: "s" }),
		say(room.obj, ws2, { t: "join", code, id: "y", secret: "s" }),
	]);
	const r2 = ws2.received.map((m) => m.t === "error" ? m.reason : m.t);
	check("a join pipelined behind a release is bound", r2.join() === "bound,busy" || r2.join() === "busy,bound", r2.join());
	check("and binds nothing", !room.state.data.get("room").members.some((m) => m.id === "y"));
}

console.log("\nA reservation nobody hosts lapses (RESERVE_MS)");
{
	// Found 2026-11-12 (review): a `/room/new` socket that never said
	// `host` held its code as long as it stayed open, and an eviction
	// re-reserved it with a fresh clock — HOST_ROOMS silent sockets per
	// window, per address, were codes squatted for good.
	const draw = (obj, code, ip = "13.1.0.1", label = "r") => {
		pairLabel = label;
		return obj.fetch(new Request(`https://room/room/${code}/new`, { headers: { Upgrade: "websocket", "CF-Connecting-IP": ip } }));
	};
	const state = makeState();
	let obj = new RoomSignal(state, env);
	const t0 = Date.now();
	await draw(obj, "700300");
	const squat = state.sockets.at(-1);
	check("a reservation arms the alarm for its lapse", state.alarm === t0 + RESERVE_MS, `${state.alarm} vs ${t0 + RESERVE_MS}`);
	check("and stores nothing (it is no room yet)", !state.data.has("room"));
	check("(held meanwhile: a second draw is 409)", (await draw(obj, "700300")).status === 409);
	tick(RESERVE_MS);
	await obj.alarm();
	check("the alarm hangs the silent socket up (4408)", squat.closed?.code === 4408, JSON.stringify(squat.closed));
	check("and disarms", state.alarm === null, String(state.alarm));
	const next = await draw(obj, "700300", "13.1.0.2", "next");
	check("the code is free again: the next draw takes it", next.status === 101, String(next.status));
	const taker = state.sockets.at(-1);
	await say(obj, taker, { t: "host", id: "t", secret: "st" });
	check("and hosts it", last(taker)?.t === "room" && last(taker)?.code === "700300", JSON.stringify(last(taker)));
	await say(obj, squat, { t: "host", id: "q", secret: "sq" });
	check("a host on the hung-up socket seats nobody", !state.data.get("room").members.some((m) => m.id === "q"));

	// A late host the alarm has not caught yet (alarms can run late).
	const s2 = makeState();
	const o2 = new RoomSignal(s2, env);
	await draw(o2, "700301");
	const slow = s2.sockets.at(-1);
	tick(RESERVE_MS);
	await say(o2, slow, { t: "host", id: "s", secret: "ss" });
	check("a host past RESERVE_MS is refused, alarm or not (expired)", last(slow)?.reason === "expired", JSON.stringify(last(slow)));
	check("and the code is free", (await draw(o2, "700301", "13.1.0.3")).status === 101);

	// An eviction must not resurrect a lapsed reservation, nor restart its clock.
	const s3 = makeState();
	let o3 = new RoomSignal(s3, env);
	await draw(o3, "700302");
	const evicted = s3.sockets.at(-1);
	tick(RESERVE_MS - 5000);
	o3 = new RoomSignal(s3, env); // evicted, 10 s in
	check("(10 s in, a woken object still holds it)", (await draw(o3, "700302")).status === 409);
	tick(5000);
	o3 = new RoomSignal(s3, env); // evicted again, now past RESERVE_MS from the draw
	const after = await draw(o3, "700302", "13.1.0.4", "after");
	check("past RESERVE_MS from the draw, a wake-up does not re-reserve it", after.status === 101, String(after.status));
	check("it hangs the stale socket up instead (4408)", evicted.closed?.code === 4408, JSON.stringify(evicted.closed));
	await o3.alarm();
	check("(the alarm keeps the new taker's reservation)", !s3.sockets.at(-1).closed);

	const s4 = makeState();
	let o4 = new RoomSignal(s4, env);
	await draw(o4, "700303");
	const old = s4.sockets.at(-1);
	delete old.att.reservedAt; // an attachment from before reservedAt existed
	o4 = new RoomSignal(s4, env);
	check("an attachment with no reservedAt counts as lapsed on wake", (await draw(o4, "700303")).status === 101 && old.closed?.code === 4408, JSON.stringify(old.closed));
}

console.log("\nIPv6 hosting is capped per /48 as well as per /64");
{
	// One /48 holds 65 536 /64s: counted by /64 alone, a /48 could open
	// millions of rooms per window and hold every code.
	const rooms = new Map();
	let touched = 0;
	const workerEnv = { ROOM: null, GATE: gates };
	workerEnv.ROOM = {
		idFromName: (n) => n,
		get(name) {
			touched++;
			if (!rooms.has(name)) {
				const state = makeState();
				rooms.set(name, { state, obj: new RoomSignal(state, workerEnv) });
			}
			const { obj } = rooms.get(name);
			return { fetch: (req) => obj.fetch(req) };
		},
	};
	const hostFrom = async (ip) =>
		statusOf(await worker.fetch(new Request("https://room.test/room/new", { headers: { Upgrade: "websocket", "CF-Connecting-IP": ip } }), workerEnv));
	const statuses = [];
	// HOST_ROOMS from each /64, across enough /64s to fill the /48.
	for (let i = 0; statuses.length < HOST_SITE_ROOMS; i++) {
		for (let j = 0; j < HOST_ROOMS && statuses.length < HOST_SITE_ROOMS; j++) statuses.push(await hostFrom(`2001:db8:5:${i.toString(16)}::${(j + 1).toString(16)}`));
	}
	check(`${HOST_SITE_ROOMS} hosts across one /48's /64s all open`, statuses.every((s) => s === 101), statuses.filter((s) => s !== 101).join());
	const before = touched;
	check("the next, from a fresh /64 in the same /48, is blocked", (await hostFrom("2001:db8:5:ff::1")) === 429);
	check("before any room object is touched", touched === before);
	check("another /48 still hosts", (await hostFrom("2001:db8:6::1")) === 101);
	check("the /48's gate is named by its prefix", gates.states.has("ip:2001:db8:5::/48"), [...gates.states.keys()].filter((k) => k.endsWith("/48")).join());
	check("IPv4 is never counted by site", ![...gates.states.keys()].some((k) => k.endsWith("/48") && !k.includes(":")));
	check("nor is IPv4-mapped IPv6", (await hostFrom("::ffff:13.2.0.1")) === 101 && ![...gates.states.keys()].some((k) => k.startsWith("ip:0:0:0::/48")));
}

console.log("\nThe redraw test hook (ROOM_DEBUG + ROOM_TEST_FORCE_REDRAW only)");
{
	// The one path wrangler dev cannot vouch for is the second forward of
	// a client's upgrade after a 409. `?draw=<live code>` forces it, so
	// test-live can run it on a debug deployment; unset, nothing changes.
	const make = (vars) => {
		const rooms = new Map();
		const workerEnv = { ROOM: null, GATE: gates, ...vars };
		workerEnv.ROOM = {
			idFromName: (n) => n,
			get(name) {
				if (!rooms.has(name)) {
					const state = makeState();
					rooms.set(name, { state, obj: new RoomSignal(state, workerEnv) });
				}
				const { obj } = rooms.get(name);
				return { fetch: (req) => obj.fetch(req) };
			},
		};
		const open = (query = "") =>
			worker.fetch(new Request("https://room.test/room/new" + query, { headers: { Upgrade: "websocket", "CF-Connecting-IP": "13.3.0." + (1 + Math.floor(Math.random() * 250)) } }), workerEnv);
		return { rooms, open };
	};
	const liveCode = async (w) => {
		await w.open();
		const [name, room] = [...w.rooms.entries()].at(-1);
		await say(room.obj, room.state.sockets.at(-1), { t: "host", id: "h", secret: "sh" });
		return name.slice(5);
	};
	const debug = make({ ROOM_DEBUG: "1", ROOM_TEST_FORCE_REDRAW: "1" });
	const live = await liveCode(debug);
	const forced = await debug.open(`?draw=${live}`);
	check("a forced live first draw is redrawn: X-Room-Draws 2", forced.status === 101 && forced.headers.get("X-Room-Draws") === "2", `${forced.status} ${forced.headers.get("X-Room-Draws")}`);
	check("the 101 keeps its socket and the room's own debug header", !!forced.webSocket && !!forced.headers.get("X-Room-Instance"));
	const [, landed] = [...debug.rooms.entries()].at(-1);
	check("into another code", landed.obj.code !== live, landed.obj.code);
	check("the live room is untouched", !debug.rooms.get("code:" + live).state.sockets.some((w) => w.closed));
	check("an unforced draw takes one", (await debug.open()).headers.get("X-Room-Draws") === "1");
	check("a malformed draw is ignored", (await debug.open("?draw=012345")).headers.get("X-Room-Draws") === "1");

	const noForce = make({ ROOM_DEBUG: "1" });
	const live2 = await liveCode(noForce);
	check("without ROOM_TEST_FORCE_REDRAW, ?draw= is ignored", (await noForce.open(`?draw=${live2}`)).headers.get("X-Room-Draws") === "1");
	const prod = make({ ROOM_TEST_FORCE_REDRAW: "1" });
	const live3 = await liveCode(prod);
	const p = await prod.open(`?draw=${live3}`);
	check("without ROOM_DEBUG, it is ignored and nothing is said", p.status === 101 && p.headers.get("X-Room-Draws") === null && [...prod.rooms.keys()].at(-1) !== "code:" + live3);
}

console.log("\nMembers re-dial on a pass, past an exhausted dial gate");
{
	// The cost equal budgets put on a shared address (a LAN party, a
	// carrier's CGNAT): ten typos and every upgrade from it was 429 —
	// members' re-dials included. A pass the room issued with the seat is
	// checked by the Worker before the gate, so members never ask it.
	const rooms = new Map();
	let touched = 0;
	const KEY = "pass-key-" + Math.random();
	const workerEnv = { ROOM: null, GATE: gates, ROOM_PASS_KEY: KEY };
	workerEnv.ROOM = {
		idFromName: (n) => n,
		get(name) {
			touched++;
			if (!rooms.has(name)) {
				const state = makeState();
				rooms.set(name, { state, obj: new RoomSignal(state, workerEnv) });
			}
			const { obj } = rooms.get(name);
			return { fetch: (req) => obj.fetch(req) };
		},
	};
	const dials = (ip) => gates.states.get("ip:" + ip)?.data.get("dial")?.count ?? 0;
	const upgrade = (path, ip) =>
		worker.fetch(new Request("https://room.test" + path, { headers: { Upgrade: "websocket", "CF-Connecting-IP": ip } }), workerEnv);
	const withPass = (code, id, { exp, pass }) => `/room/${code}?${new URLSearchParams({ id, exp, pass })}`;
	const lan = "100.64.7.1"; // the whole party, one address

	// Host and a member, both from the shared address.
	const code = "800100";
	workerEnv.ROOM.get("code:" + code);
	const { state, obj } = rooms.get("code:" + code);
	const h = await hostIn(obj, state, code, lan, "h", { id: "h", secret: "sh" });
	const hostPass = last(h);
	check("the host's room reply carries a pass", !!hostPass.pass && hostPass.exp > Date.now(), JSON.stringify(hostPass));
	await upgrade(`/room/${code}`, lan);
	const m = state.sockets.at(-1);
	await say(obj, m, { t: "join", code, id: "m", secret: "sm" });
	const memberPass = last(m);
	check("a join's joined reply carries one too", memberPass.t === "joined" && !!memberPass.pass, JSON.stringify(memberPass));

	// Ten typos: the shared address's dial budget is gone.
	for (let i = 0; i < DIAL_FAILS; i++) {
		const r = await upgrade(`/room/${810000 + i}`, lan);
		if (statusOf(r) !== 101) break;
		const room = rooms.get("code:" + (810000 + i));
		await say(room.obj, room.state.sockets.at(-1), { t: "join", code: String(810000 + i), id: "x", secret: "y" });
	}
	check("(the address is out of dials)", dials(lan) === DIAL_FAILS, String(dials(lan)));
	check("a newcomer from it is refused 429", statusOf(await upgrade(`/room/${code}`, lan)) === 429);
	check("and so is a member's re-dial without its pass", statusOf(await upgrade(`/room/${code}`, lan)) === 429);

	// The whole party re-dials with its passes, as after a wifi blip.
	const back = [];
	for (const [id, secret, pass] of [["h", "sh", hostPass], ["m", "sm", memberPass]]) {
		const r = await upgrade(withPass(code, id, pass), lan);
		if (statusOf(r) !== 101) {
			back.push(statusOf(r));
			continue;
		}
		const ws = state.sockets.at(-1);
		await say(obj, ws, { t: "join", code, id, secret });
		back.push(last(ws)?.t);
		check(`${id}'s rejoin is answered with a fresh pass`, !!last(ws)?.pass && last(ws).exp >= pass.exp);
	}
	check("every member of the exhausted address re-dials and rejoins", back.every((t) => t === "joined"), back.join());
	check("charging nothing, and refunding nothing", dials(lan) === DIAL_FAILS, String(dials(lan)));
	const many = [];
	for (let i = 0; i < 20; i++) many.push(statusOf(await upgrade(withPass(code, "m", memberPass), lan)));
	check("twenty re-dials on a pass: all through", many.every((s) => s === 101), many.join());
	// A pass also lets a seat be given back (releaseRejoin, an owed leave).
	const rel = await upgrade(withPass(code, "m", memberPass), lan);
	check("(a release on a pass is let through)", rel.status === 101);
	for (const w of state.sockets) if (w.att?.id === "m" && !w.closed) await obj.webSocketClose(w, 1006, "");
	const rws = state.sockets.at(-1);
	await say(obj, rws, { t: "release", code, id: "m", secret: "sm" });
	check("and releases the seat", last(rws)?.t === "released", JSON.stringify(last(rws)));
	check("still charging nothing", dials(lan) === DIAL_FAILS, String(dials(lan)));

	// Anything a prober could present is an unproven upgrade: charged.
	const probe = "12.1.0.1";
	const forged = { exp: Date.now() + 60_000, pass: "A".repeat(43) };
	const cases = [
		["a forged pass", withPass(code, "h", forged)],
		["a pass for another code", withPass("800101", "h", hostPass)],
		["a pass for another member", withPass(code, "z", hostPass)],
		["a stretched expiry", withPass(code, "h", { ...hostPass, exp: hostPass.exp + 1 })],
		["a pass with no id", `/room/${code}?${new URLSearchParams({ exp: hostPass.exp, pass: hostPass.pass })}`],
	];
	for (const [label, path] of cases) {
		const was = dials(probe);
		const r = await upgrade(path, probe);
		check(`${label} is charged a dial`, r.status === 101 && dials(probe) === was + 1, `${r.status} ${dials(probe)}`);
	}
	// Expired: the Worker charges it. The room checks the MAC ignoring
	// expiry, so it never refunds a dial the Worker might not have charged
	// — at the edge a member loses one dial; budget is never minted.
	const exp = Date.now() - 1;
	const expired = { exp, pass: await signPass(KEY, code, "h", exp) };
	const late = "12.1.0.2";
	const r = await upgrade(withPass(code, "h", expired), late);
	check("an expired pass is charged", r.status === 101 && dials(late) === 1, `${r.status} ${dials(late)}`);
	await say(obj, state.sockets.at(-1), { t: "join", code, id: "h", secret: "sh" });
	check("and its join refunds nothing (errs towards the limit)", last(state.sockets.at(-1))?.t === "joined" && dials(late) === 1, String(dials(late)));
	// A pass waives the dial, never the guess: a wrong claim on a socket
	// that came in on someone's pass is still charged as one.
	const guesser = await upgrade(withPass(code, "m", memberPass), "12.1.0.3");
	check("(through on a pass)", guesser.status === 101);
	await say(obj, state.sockets.at(-1), { t: "join", code, id: "h", secret: "guess" });
	const entry = gates.states.get("ip:12.1.0.3")?.data.get("entry")?.count ?? 0;
	check("a wrong claim on a pass socket is still a guess", last(state.sockets.at(-1))?.reason === "id-taken" && entry === 1, `${JSON.stringify(last(state.sockets.at(-1)))} ${entry}`);

	// Without a key nothing is issued and nothing is honoured: the old way.
	const bare = { ...workerEnv, ROOM_PASS_KEY: undefined };
	const r2 = await worker.fetch(new Request("https://room.test" + withPass(code, "h", hostPass), { headers: { Upgrade: "websocket", "CF-Connecting-IP": "12.1.0.4" } }), bare);
	check("with no key set, a pass is charged like anything else", r2.status === 101 && dials("12.1.0.4") === 1, `${r2.status} ${dials("12.1.0.4")}`);
	const keyless = makeState();
	const kobj = new RoomSignal(keyless, { GATE: gates });
	const kh = await hostIn(kobj, keyless, "800200", "12.1.0.5", "kh", { id: "h", secret: "s" });
	check("and replies carry no pass", last(kh)?.t === "room" && !("pass" in last(kh)), JSON.stringify(last(kh)));
}

console.log("\nIPv6 is counted by /64");
{
	// One customer holds a whole /64; a fresh address per guess must not
	// mean a fresh budget per guess.
	const guess = async (code, ip) => {
		const state = makeState();
		const obj = new RoomSignal(state, env);
		const ws = await connect(obj, state, code, ip, "g6");
		await say(obj, ws, { t: "join", code, id: "x", secret: "y" });
		return ws.received.at(-1)?.reason;
	};
	const answers = [];
	for (let i = 0; i < 11; i++) answers.push(await guess(String(400400 + i), `2001:db8:aa:bb::${(i + 1).toString(16)}`));
	check("eleven addresses in one /64 share one budget", answers.at(-1) === "blocked", answers.join());
	check(
		"spelled out in full, it is the same /64",
		(await guess("400420", "2001:0db8:00aa:00bb:1234:5678:9abc:def0")) === "blocked",
	);
	check("the neighbouring /64 is unaffected", (await guess("400421", "2001:db8:aa:bc::1")) === "no-room");
	check("the gate is named by the prefix", gates.states.has("ip:2001:db8:aa:bb::/64"), [...gates.states.keys()].join());
	await guess("400422", "::ffff:5.4.3.2");
	check("IPv4-mapped IPv6 is the IPv4 address", gates.states.has("ip:5.4.3.2"), [...gates.states.keys()].join());
}

console.log("\nWithout a GATE binding the hub limits per room");
{
	const state = makeState();
	const obj = new RoomSignal(state, {});
	const reasons = [];
	for (let i = 0; i < 11; i++) {
		const ws = await connect(obj, state, "400200", "4.4.4.4", "n");
		await say(obj, ws, { t: "join", code: "400200", id: "x", secret: "y" });
		reasons.push(ws.received.at(-1)?.reason);
	}
	check("the old per-room limit still holds", reasons.at(-1) === "blocked", reasons.join());
}

console.log(failures ? `\n${failures} failing` : "\nall passing");
process.exit(failures ? 1 : 0);
