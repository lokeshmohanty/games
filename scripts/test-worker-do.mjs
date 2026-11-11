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
		this[0] = { client: true };
		this[1] = serverSocket(pairLabel);
	}
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
const say = (obj, ws, msg) => obj.webSocketMessage(ws, JSON.stringify(msg));
const last = (ws, pred = () => true) => ws.received.filter(pred).at(-1);

// ------------------------------------------------------------------ tests

console.log("\nA room survives eviction");
{
	const state = makeState();
	let obj = new RoomSignal(state, env);
	const a = await connect(obj, state, "300001", "1.1.1.1", "a");
	await say(obj, a, { t: "host", code: "300001", id: "a", secret: "sa" });
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
	const a = await connect(obj, state, "300002", "1.1.1.1", "a");
	await say(obj, a, { t: "host", code: "300002", id: "a", secret: "sa" });
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
	const h = await connect(obj, state, "300010", "1.1.1.1", "h");
	await say(obj, h, { t: "host", code: "300010", id: "h", secret: "sh" });
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

	// Hosting a live code is a guess too: "taken" says the code exists.
	const live = makeState();
	const lobj = new RoomSignal(live, env);
	const h = await connect(lobj, live, "400100", "8.8.8.8", "h");
	await say(lobj, h, { t: "host", code: "400100", id: "h", secret: "s" });
	const takes = [];
	for (let i = 0; i < 11; i++) {
		const ws = await connect(lobj, live, "400100", "9.9.9.9", "t");
		await say(lobj, ws, { t: "host", code: "400100", id: `t${i}`, secret: "s" });
		takes.push(ws.received.at(-1)?.reason);
	}
	check("probing with host exhausts into blocked", takes.at(-1) === "blocked", takes.join());

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
	const h = await connect(obj, state, "400300", "1.1.1.1", "h");
	await say(obj, h, { t: "host", code: "400300", id: "h", secret: "sh" });
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

	const statuses = [];
	for (let i = 0; i < 20; i++) statuses.push((await upgrade(String(500000 + i), "11.0.0.1")).status);
	check("twenty silent upgrades are let through", statuses.every((s) => s === 101), statuses.join());
	const before = touched;
	const refused = await upgrade("500020", "11.0.0.1");
	check("the twenty-first is refused 429", refused.status === 429, String(refused.status));
	check("before any room object is touched", touched === before);
	check("another address is unaffected", (await upgrade("500021", "11.0.0.2")).status === 101);
	check("/ping is never limited", (await worker.fetch(new Request("https://room.test/ping", { headers: { "CF-Connecting-IP": "11.0.0.1" } }), workerEnv)).status === 204);

	// A member's dials are refunded: host, then rejoin thirty times.
	const res = await upgrade("500100", "11.0.0.3");
	const { state, obj } = rooms.get("code:500100");
	check("(upgraded)", res.status === 101);
	await say(obj, state.sockets.at(-1), { t: "host", code: "500100", id: "h", secret: "sh" });
	check("a successful host gives its dial back", dials("11.0.0.3") === 0, String(dials("11.0.0.3")));
	const answers = [];
	for (let i = 0; i < 30; i++) {
		const r = await upgrade("500100", "11.0.0.3");
		if (r.status !== 101) {
			answers.push(r.status);
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
	check("a second success on one socket refunds nothing more", (gates.states.get("ip:11.0.0.4")?.data.get("dial")?.count ?? 0) === 0);
	await upgrade("500101", "11.0.0.4");
	check("so the next silent dial still counts", dials("11.0.0.4") === 1, String(dials("11.0.0.4")));

	// The window closes; the alarm forgets both counters.
	tick(5 * 60 * 1000 + 1);
	const gate = gates.states.get("ip:11.0.0.1");
	gates.evict();
	await new IpGate(gate).alarm();
	check("the alarm clears an expired dial count", !gate.data.has("dial") && gate.alarm === null);
	check("and the prober may dial again", (await upgrade("500022", "11.0.0.1")).status === 101);

	// A gate that cannot answer lets the upgrade through: a dial cannot
	// prove a claim yet, and failing closed would cut members off.
	const broken = { idFromName: (n) => n, get: () => ({ fetch: async () => { throw new Error("down"); } }) };
	const r3 = await worker.fetch(new Request("https://room.test/room/500200", { headers: { Upgrade: "websocket", "CF-Connecting-IP": "11.0.0.5" } }), { ROOM: ns, GATE: broken });
	check("a gate outage fails open for upgrades", r3.status === 101, String(r3.status));
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
