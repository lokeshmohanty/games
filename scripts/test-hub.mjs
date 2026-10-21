#!/usr/bin/env node
// scripts/test-hub.mjs — the room hub, driven directly with fake sockets.
//
// The hub is pure logic behind an adapter, so every rule in
// docs/room-server.md can be exercised with no Cloudflare and no network —
// the same trick test-plumbing.mjs plays with Room over a fake transport.
// The clock is injected too, because TTLs are exactly what a real clock makes
// untestable.

import assert from "assert";
import { makeHub } from "../worker/hub.js";

let failures = 0;
const check = (label, ok, detail = "") => {
	console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
	if (!ok) failures++;
};

// A fake clock the tests advance by hand, and a fake socket that remembers
// everything the hub sent it.
const clock = { t: 0, now: () => clock.t };
const sleep = (ms) => (clock.t += ms);

const ICE = { servers: [{ urls: "stun:stun.example:3478" }] };

function makeSocket() {
	return {
		received: [],
		closed: false,
	};
}

function make() {
	// The adapter is the whole transport: what the hub says back to a socket.
	const sockets = new Map();
	const hub = makeHub(
		{
			send: (socket, msg) => sockets.get(socket).received.push(msg),
			close: (socket) => (sockets.get(socket).closed = true),
		},
		{ ice: () => Promise.resolve(ICE), now: clock.now },
	);
	return { hub, sockets, socket: () => {
		const s = makeSocket();
		sockets.set(s, s);
		return s;
	} };
}

const first = (socket, pred) => socket.received.find(pred);
const notices = (socket) => socket.received.filter((m) => m.t === "peer");

console.log("\nHosting and joining");
{
	const { hub, socket } = make();
	const host = socket();
	const res = await hub.host(host, "1.1.1.1", { id: "m1", secret: "s1", name: "Alice" });
	check("host gets a 6-digit code", res.t === "room" && /^\d{6}$/.test(res.code), JSON.stringify(res));
	check("host reply carries ttl and ice", res.ttl === 900 && res.ice === ICE);

	const code = res.code;
	const guest = socket();
	const joinRes = await hub.join(guest, "2.2.2.2", { code, id: "m2", secret: "s2", name: "Bob" });
	check("guest joins", joinRes.t === "joined" && joinRes.ice === ICE, JSON.stringify(joinRes));

	// The first member is told about the second, and named as the offerer —
	// the oldest attached member, ties broken by id. The guest is told
	// nothing about itself: its own reply already said "joined".
	const notice = first(host, (m) => m.t === "peer" && m.id === "m2");
	check("host notified of guest", !!notice);
	check("notice names host as offerer", notice?.offering === "m1", JSON.stringify(notice));
	check("notice is connected, not a rejoin", notice?.connected === true && notice?.rejoin === false);
	check("the subject gets no notice about itself", !first(guest, (m) => m.t === "peer" && m.id === "m2"));
}

console.log("\nOffering passes to the oldest attached");
{
	const { hub, socket } = make();
	const a = socket();
	const { code } = await hub.host(a, "1.1.1.1", { id: "a", secret: "1", name: "A" });
	const b = socket();
	await hub.join(b, "1.1.1.1", { code, id: "b", secret: "2", name: "B" });
	const c = socket();
	await hub.join(c, "1.1.1.1", { code, id: "c", secret: "3", name: "C" });
	// The notice about c went to a and b; a is the oldest attached, so both
	// of them are told a will do the offering.
	check("a offers while attached", first(b, (m) => m.id === "c")?.offering === "a");

	// a's socket drops: b is now the oldest attached, and that is who the
	// next arrival is told will offer. Oldest attached — not "the host" — is
	// what keeps recruiting alive through host succession.
	hub.leave(a);
	const d = socket();
	await hub.join(d, "1.1.1.1", { code, id: "d", secret: "4", name: "D" });
	check("b offers once a is gone", first(c, (m) => m.id === "d")?.offering === "b");

	// a left only a dropped socket, not the party: everyone still attached
	// hears connected:false, and nobody hears that a stopped existing.
	const toC = first(c, (m) => m.id === "a" && m.connected === false);
	check("dropped socket reported as disconnected", !!toC);
	check("claim survives the dropped socket", (await hub.join(socket(), "9.9.9.9", { code, id: "a", secret: "1", name: "A" })).t === "joined");
}

console.log("\nRelay");
{
	const { hub, socket } = make();
	const a = socket();
	const { code } = await hub.host(a, "1.1.1.1", { id: "a", secret: "1", name: "A" });
	const b = socket();
	await hub.join(b, "1.1.1.1", { code, id: "b", secret: "2", name: "B" });
	hub.relay(a, { t: "offer", to: "b", sdp: "packed-offer" });
	check(
		"offer relayed intact",
		first(b, (m) => m.t === "offer" && m.from === "a" && m.sdp === "packed-offer"),
	);
	hub.relay(b, { t: "answer", to: "a", sdp: "packed-answer" });
	check(
		"answer relayed intact",
		first(a, (m) => m.t === "answer" && m.from === "b" && m.sdp === "packed-answer"),
	);
	// A string the hub never touches: relaying to a member whose socket
	// dropped is dropped, because the mesh carries them from here.
	hub.leave(b);
	const before = a.received.length;
	hub.relay(b, { t: "offer", to: "a", sdp: "late" });
	check("nothing relayed from a dropped socket", a.received.length === before);
}

console.log("\nRejoin claims");
{
	const { hub, socket } = make();
	const a = socket();
	const { code } = await hub.host(a, "1.1.1.1", { id: "a", secret: "s", name: "A" });
	const b = socket();
	await hub.join(b, "1.1.1.1", { code, id: "b", secret: "2", name: "B" });
	hub.leave(b);

	const back = socket();
	const res = await hub.join(back, "1.1.1.1", { code, id: "b", secret: "2", name: "B" });
	check("same id and secret rejoins", res.t === "joined");
	const notice = first(a, (m) => m.id === "b" && m.rejoin === true);
	check("others see rejoin:true, connected again", notice?.connected === true);

	const thief = socket();
	const stolen = await hub.join(thief, "3.3.3.3", { code, id: "b", secret: "wrong", name: "B" });
	check("wrong secret refused", stolen.reason === "id-taken");
	// And the refusal counts against the guessing IP: 10 of them and the
	// 11th is blocked, whichever reason the earlier ones had.
	for (let i = 0; i < 9; i++) {
		await hub.join(socket(), "3.3.3.3", { code, id: "b", secret: `wrong${i}`, name: "B" });
	}
	const blockedJoin = await hub.join(socket(), "3.3.3.3", { code, id: "new", secret: "x", name: "N" });
	check("repeated wrong secrets block the IP", blockedJoin.reason === "blocked");
}

console.log("\nCapacity");
{
	const { hub, socket } = make();
	const a = socket();
	const { code } = await hub.host(a, "ip", { id: "a", secret: "1", name: "A" });
	// The party cap is 8 claims — not 8 sockets — so a member whose socket
	// dropped still holds one, and a 9th new member is the one refused.
	for (let i = 0; i < 7; i++) {
		await hub.join(socket(), `ip${i}`, { code, id: `m${i}`, secret: `${i}`, name: `n${i}` });
	}
	const ninth = socket();
	const res = await hub.join(ninth, "ip9", { code, id: "m9", secret: "9", name: "n9" });
	check("9th claim refused", res.reason === "full");

	const dropped = socket();
	await hub.join(dropped, "ip8", { code, id: "m0", secret: "0", name: "n0" });
	hub.leave(dropped);
	const back = socket();
	check(
		"a rejoin is not blocked by a full room",
		(await hub.join(back, "ip8", { code, id: "m0", secret: "0", name: "n0" })).t === "joined",
	);
}

console.log("\nGuessing the code");
{
	const { hub, socket } = make();
	const a = socket();
	const { code } = await hub.host(a, "ip", { id: "a", secret: "1", name: "A" });
	check("bad shape refused", (await hub.join(socket(), "guess", { code: "1234", id: "x", secret: "y" })).reason === "bad-code");
	// Wrong codes are the brute-force path, and they count against the IP
	// hub-wide — there is no room to hang a per-room counter on.
	let last;
	for (let i = 0; i < 11; i++) {
		last = await hub.join(socket(), "guesser", { code: "555555", id: "x", secret: "y" });
	}
	check("guessing exhausts into blocked", last.reason === "no-room" || last.reason === "blocked");
	// A blocked IP stays blocked for real codes too, and only for its IP.
	const blocked = await hub.join(socket(), "guesser", { code, id: "innocent", secret: "s" });
	check("blocked IP refused even with the right code", blocked.reason === "blocked");
	const friend = await hub.join(socket(), "friend-ip", { code, id: "friend", secret: "s" });
	check("other IPs unaffected", friend.t === "joined");
	// The window passes; the counter resets.
	sleep(5 * 60 * 1000 + 1);
	const after = await hub.join(socket(), "guesser", { code, id: "m2", secret: "s" });
	check("block expires after 5 minutes", after.t === "joined");
}

console.log("\nTTL and cap");
{
	{
		const { hub, socket } = make();
		const a = socket();
		const { code } = await hub.host(a, "ip", { id: "a", secret: "1", name: "A" });
		hub.leave(a);
		sleep(15 * 60 * 1000 - 1);
		hub.sweep();
		check("room survives just inside the TTL", hub.rooms.has(code));
		sleep(2);
		hub.sweep();
		check("room swept past the TTL with nobody attached", !hub.rooms.has(code));
	}
	{
		// Activity keeps a room alive: the TTL runs from the last touch, and
		// traffic touches. A room left alone with claims but no sockets dies
		// 15 minutes after the last one left, so a code returns to the pool.
		const { hub, socket } = make();
		const a = socket();
		const { code } = await hub.host(a, "ip", { id: "a", secret: "1", name: "A" });
		const b = socket();
		await hub.join(b, "ip", { code, id: "b", secret: "2", name: "B" });
		hub.relay(b, { t: "offer", to: "a", sdp: "x" });
		hub.leave(a);
		hub.leave(b);
		sleep(10 * 60 * 1000);
		hub.sweep();
		check("TTL runs from the last touch", hub.rooms.has(code));
		sleep(6 * 60 * 1000);
		hub.sweep();
		check("swept 15 minutes after the last touch", !hub.rooms.has(code));
	}
	{
		// Attached sockets hold a room open until the 24-hour cap, so a
		// party cannot hold a code hostage forever.
		const { hub, socket } = make();
		const a = socket();
		const { code } = await hub.host(a, "ip", { id: "a", secret: "1", name: "A" });
		sleep(24 * 60 * 60 * 1000 + 1);
		const next = hub.sweep();
		check("24-hour cap sweeps even an attached room", !hub.rooms.has(code));
		check("sweep reports no next alarm once empty", next === null);
	}
	{
		const { hub, socket } = make();
		const a = socket();
		const { code } = await hub.host(a, "ip", { id: "a", secret: "1", name: "A" });
		hub.leave(a);
		sleep(10 * 60 * 1000);
		const next = hub.sweep();
		check("sweep returns the next expiry", next === clock.t + 5 * 60 * 1000);
	}
}

console.log("\nErrors");
{
	const { hub, socket } = make();
	const lonely = socket();
	const res = await hub.join(lonely, "1.1.1.1", { code: "111111", id: "x", secret: "y", name: "X" });
	check("unknown room refused explicitly", res.reason === "no-room");
}

console.log("\nEviction round-trip (snapshot → restore → rebind)");
{
	// The Durable Object can be evicted while its sockets hibernate. What
	// survives: the claims, in the snapshot; the sockets, with attachments.
	// A new hub instance stands the room back up and rebinds, and nobody is
	// told anything — the mesh, not the hub, is the membership authority.
	const { hub, socket, sockets } = make();
	const a = socket();
	const { code } = await hub.host(a, "1.1.1.1", { id: "a", secret: "1", name: "A" });
	const b = socket();
	await hub.join(b, "2.2.2.2", { code, id: "b", secret: "2", name: "B" });

	const snapshot = hub.snapshot(code);
	check("snapshot carries claims, not sockets", snapshot.members.every((m) => !("socket" in m)));

	const woken = makeHub(
		{ send: (s, msg) => sockets.get(s).received.push(msg), close: (s) => (sockets.get(s).closed = true) },
		{ ice: () => Promise.resolve(ICE), now: clock.now },
	);
	woken.restore(snapshot);
	const wokeA = socket();
	const wokeB = socket();
	woken.rebind(wokeA, code, "a");
	woken.rebind(wokeB, code, "b");

	// Rebinding announces nothing: everyone attached already knows everyone.
	check("wake-up tells nobody anything", !wokeA.received.some((m) => m.t === "peer") && !wokeB.received.some((m) => m.t === "peer"));
	// And the rebound room still works: a relay crosses the rebuilt index.
	woken.relay(wokeB, { t: "offer", to: "a", sdp: "after-wake" });
	check("relay crosses the rebuilt index", first(wokeA, (m) => m.sdp === "after-wake"));
	// A rejoiner against the restored claims proves the claims survived.
	const again = socket();
	check(
		"claims survive the round-trip",
		(await woken.join(again, "3.3.3.3", { code, id: "b", secret: "2", name: "B" })).t === "joined",
	);
	// A swept room has nothing to snapshot.
	sleep(24 * 60 * 60 * 1000 + 1);
	woken.sweep();
	check("swept room snapshots to null", woken.snapshot(code) === null);
}

console.log(
	failures ? `\n${failures} failing` : "\nall passing",
);
process.exit(failures ? 1 : 0);
