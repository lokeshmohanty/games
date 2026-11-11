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
		{ now: clock.now },
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
	const res = await hub.host(host, "1.1.1.1", { code: "100001", id: "m1", secret: "s1" });
	check("host opens the code it drew", res.t === "room" && res.code === "100001", JSON.stringify(res));
	check("no ICE in the reply: STUN is the client's own", !("ice" in res));
	const clash = await hub.host(socket(), "9.9.9.9", { code: "100001", id: "z", secret: "z" });
	check("a live code answers taken", clash.reason === "taken");

	const code = res.code;
	const guest = socket();
	const joinRes = await hub.join(guest, "2.2.2.2", { code, id: "m2", secret: "s2" });
	check("guest joins", joinRes.t === "joined", JSON.stringify(joinRes));

	// The first member is told about the second, and named as the offerer —
	// the oldest attached member, ties broken by id. The guest is told
	// nothing about itself: its own reply already said "joined".
	const notice = first(host, (m) => m.t === "peer" && m.id === "m2");
	check("host notified of guest", !!notice);
	check("notice names host as offerer", notice?.offering === "m1", JSON.stringify(notice));
	check("notice says connected", notice?.connected === true);
	check("the subject gets no notice about itself", !first(guest, (m) => m.t === "peer" && m.id === "m2"));
}

console.log("\nOffering passes to the oldest attached");
{
	const { hub, socket } = make();
	const a = socket();
	const { code } = await hub.host(a, "1.1.1.1", { code: "100002", id: "a", secret: "1" });
	const b = socket();
	await hub.join(b, "1.1.1.1", { code, id: "b", secret: "2" });
	const c = socket();
	await hub.join(c, "1.1.1.1", { code, id: "c", secret: "3" });
	// The notice about c went to a and b; a is the oldest attached, so both
	// of them are told a will do the offering.
	check("a offers while attached", first(b, (m) => m.id === "c")?.offering === "a");

	// a's socket drops: b is now the oldest attached, and that is who the
	// next arrival is told will offer. Oldest attached — not "the host" — is
	// what keeps recruiting alive through host succession.
	hub.leave(a);
	const d = socket();
	await hub.join(d, "1.1.1.1", { code, id: "d", secret: "4" });
	check("b offers once a is gone", first(c, (m) => m.id === "d")?.offering === "b");

	// a left only a dropped socket, not the party: everyone still attached
	// hears connected:false, and nobody hears that a stopped existing.
	const toC = first(c, (m) => m.id === "a" && m.connected === false);
	check("dropped socket reported as disconnected", !!toC);
	check("claim survives the dropped socket", (await hub.join(socket(), "9.9.9.9", { code, id: "a", secret: "1" })).t === "joined");
}

console.log("\nRelay");
{
	const { hub, socket } = make();
	const a = socket();
	const { code } = await hub.host(a, "1.1.1.1", { code: "100003", id: "a", secret: "1" });
	const b = socket();
	await hub.join(b, "1.1.1.1", { code, id: "b", secret: "2" });
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
	const { code } = await hub.host(a, "1.1.1.1", { code: "100004", id: "a", secret: "s" });
	const b = socket();
	await hub.join(b, "1.1.1.1", { code, id: "b", secret: "2" });
	hub.leave(b);

	const back = socket();
	const res = await hub.join(back, "1.1.1.1", { code, id: "b", secret: "2" });
	check("same id and secret rejoins", res.t === "joined");
	const notice = a.received.filter((m) => m.id === "b").at(-1);
	check("others see the rejoiner connected again", notice?.connected === true);

	const thief = socket();
	const stolen = await hub.join(thief, "3.3.3.3", { code, id: "b", secret: "wrong" });
	check("wrong secret refused", stolen.reason === "id-taken");
	// And the refusal counts against the guessing IP: 10 of them and the
	// 11th is blocked, whichever reason the earlier ones had.
	for (let i = 0; i < 9; i++) {
		await hub.join(socket(), "3.3.3.3", { code, id: "b", secret: `wrong${i}` });
	}
	const blockedJoin = await hub.join(socket(), "3.3.3.3", { code, id: "new", secret: "x" });
	check("repeated wrong secrets block the IP", blockedJoin.reason === "blocked");
}

console.log("\nCapacity");
{
	const { hub, socket } = make();
	const a = socket();
	const { code } = await hub.host(a, "ip", { code: "100005", id: "a", secret: "1" });
	// The party cap is 8 claims — not 8 sockets — so a member whose socket
	// dropped still holds one, and a 9th new member is the one refused.
	for (let i = 0; i < 7; i++) {
		await hub.join(socket(), `ip${i}`, { code, id: `m${i}`, secret: `${i}` });
	}
	const ninth = socket();
	const res = await hub.join(ninth, "ip9", { code, id: "m9", secret: "9" });
	check("9th claim refused", res.reason === "full");

	const dropped = socket();
	await hub.join(dropped, "ip8", { code, id: "m0", secret: "0" });
	hub.leave(dropped);
	const back = socket();
	check(
		"a rejoin is not blocked by a full room",
		(await hub.join(back, "ip8", { code, id: "m0", secret: "0" })).t === "joined",
	);
}

console.log("\nGuessing the code");
{
	const { hub, socket } = make();
	const a = socket();
	const { code } = await hub.host(a, "ip", { code: "100006", id: "a", secret: "1" });
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
		const { code } = await hub.host(a, "ip", { code: "100007", id: "a", secret: "1" });
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
		const { code } = await hub.host(a, "ip", { code: "100008", id: "a", secret: "1" });
		const b = socket();
		await hub.join(b, "ip", { code, id: "b", secret: "2" });
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
		const { code } = await hub.host(a, "ip", { code: "100009", id: "a", secret: "1" });
		sleep(24 * 60 * 60 * 1000 + 1);
		const next = hub.sweep();
		check("24-hour cap sweeps even an attached room", !hub.rooms.has(code));
		check("sweep reports no next alarm once empty", next === null);
	}
	{
		const { hub, socket } = make();
		const a = socket();
		const { code } = await hub.host(a, "ip", { code: "100010", id: "a", secret: "1" });
		hub.leave(a);
		sleep(10 * 60 * 1000);
		const next = hub.sweep();
		check("sweep returns the next expiry", next === clock.t + 5 * 60 * 1000);
	}
}

console.log("\nThe returning member is never their own offerer");
{
	// The host is usually the oldest member, so when they reload and come
	// back, ranking them among the offerers named them as their own — and
	// nobody offered. The subject of a notice is never its offerer.
	const { hub, socket } = make();
	const h = socket();
	const { code } = await hub.host(h, "1.1.1.1", { code: "200001", id: "h", secret: "hs" });
	const g = socket();
	await hub.join(g, "2.2.2.2", { code, id: "g", secret: "gs" });
	hub.leave(h);
	const back = socket();
	await hub.join(back, "1.1.1.1", { code, id: "h", secret: "hs" });
	const notice = g.received.filter((m) => m.t === "peer" && m.id === "h").at(-1);
	check("a rejoining host is offered to by another member", notice?.connected === true && notice?.offering === "g", JSON.stringify(notice));

	// The same rule, the other way round: a newcomer who joined while
	// nobody was attached heard nothing and told nobody. When an older
	// member reattaches, the newcomer is the one told to offer.
	const { hub: hub2, socket: socket2 } = make();
	const a = socket2();
	await hub2.host(a, "1.1.1.1", { code: "200002", id: "a", secret: "as" });
	hub2.leave(a);
	const n = socket2();
	await hub2.join(n, "3.3.3.3", { code: "200002", id: "n", secret: "ns" });
	check("a newcomer alone hears nothing", !notices(n).length);
	await hub2.join(socket2(), "1.1.1.1", { code: "200002", id: "a", secret: "as" });
	const toN = notices(n).at(-1);
	check("a returning older member is offered to by the newcomer", toN?.id === "a" && toN?.offering === "n", JSON.stringify(toN));
}

console.log("\nReleasing a seat");
{
	const { hub, socket } = make();
	const a = socket();
	const { code } = await hub.host(a, "1.1.1.1", { code: "200003", id: "a", secret: "as" });
	const b = socket();
	await hub.join(b, "2.2.2.2", { code, id: "b", secret: "bs" });

	await hub.release(b, { id: "b", secret: "wrong" });
	check("a release with the wrong secret is ignored", hub.rooms.get(code).members.has("b"));
	await hub.release(b, { id: "b", secret: "bs" });
	check("leave releases the claim", !hub.rooms.get(code).members.has("b"));
	check("the others hear the departure", notices(a).at(-1)?.id === "b" && notices(a).at(-1)?.connected === false);
	const reuse = await hub.join(socket(), "4.4.4.4", { code, id: "b", secret: "other" });
	check("a released id is free again, not id-taken", reuse.t === "joined", JSON.stringify(reuse));

	// The last claim out takes the room with it: the code goes back to
	// the pool now, not 15 minutes from now.
	const { hub: hub2, socket: socket2 } = make();
	const solo = socket2();
	await hub2.host(solo, "1.1.1.1", { code: "200004", id: "s", secret: "ss" });
	await hub2.release(solo, { id: "s", secret: "ss" });
	check("the last release closes the room", !hub2.rooms.has("200004"));
}

console.log("\nStale claims do not fill a room");
{
	// A long party: people come, close their tabs, and never return. Each
	// left a claim; once the mesh has dropped their seat (5 minutes), the
	// claim is nobody's, and must not answer "full" to the next guest.
	const { hub, socket } = make();
	const a = socket();
	const { code } = await hub.host(a, "1.1.1.1", { code: "200005", id: "a", secret: "1" });
	for (let i = 0; i < 7; i++) {
		const s = socket();
		await hub.join(s, `10.0.0.${i}`, { code, id: `m${i}`, secret: `${i}` });
		hub.leave(s);
	}
	const early = await hub.join(socket(), "5.5.5.5", { code, id: "late", secret: "x" });
	check("inside the seat grace the claims still hold", early.reason === "full");
	sleep(5 * 60 * 1000);
	const later = await hub.join(socket(), "5.5.5.5", { code, id: "late", secret: "x" });
	check("after the seat grace a new guest gets in", later.t === "joined", JSON.stringify(later));
	// And voluntary leavers free their seat at once.
	const { hub: hub2, socket: socket2 } = make();
	await hub2.host(socket2(), "1.1.1.1", { code: "200006", id: "a", secret: "1" });
	for (let i = 0; i < 7; i++) {
		const s = socket2();
		await hub2.join(s, `10.0.0.${i}`, { code: "200006", id: `m${i}`, secret: `${i}` });
		await hub2.release(s, { id: `m${i}`, secret: `${i}` });
	}
	const next = await hub2.join(socket2(), "5.5.5.5", { code: "200006", id: "late", secret: "x" });
	check("released seats never fill the room", next.t === "joined");
}

console.log("\nRate limits are per IP");
{
	// One stranger's wrong secrets must not lock the party's friends out.
	const { hub, socket } = make();
	const a = socket();
	const { code } = await hub.host(a, "1.1.1.1", { code: "200007", id: "a", secret: "1" });
	for (let i = 0; i < 12; i++) {
		await hub.join(socket(), "6.6.6.6", { code, id: "a", secret: `wrong${i}` });
	}
	check("the guesser is blocked", (await hub.join(socket(), "6.6.6.6", { code, id: "q", secret: "q" })).reason === "blocked");
	check("a friend on another IP still joins", (await hub.join(socket(), "7.7.7.7", { code, id: "f", secret: "f" })).t === "joined");
	check("a blocked IP cannot open a room either", (await hub.host(socket(), "6.6.6.6", { code: "200008", id: "q", secret: "q" })).reason === "blocked");
	check("and a refused host leaves no room squatting the code", !hub.rooms.has("200008"));
}

console.log("\nErrors");
{
	const { hub, socket } = make();
	const lonely = socket();
	const res = await hub.join(lonely, "1.1.1.1", { code: "111111", id: "x", secret: "y" });
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
	const { code } = await hub.host(a, "1.1.1.1", { code: "100011", id: "a", secret: "1" });
	const b = socket();
	await hub.join(b, "2.2.2.2", { code, id: "b", secret: "2" });

	const snapshot = hub.snapshot(code);
	check("snapshot carries claims, not sockets", snapshot.members.every((m) => !("socket" in m)));

	const woken = makeHub(
		{ send: (s, msg) => sockets.get(s).received.push(msg), close: (s) => (sockets.get(s).closed = true) },
		{ now: clock.now },
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
		(await woken.join(again, "3.3.3.3", { code, id: "b", secret: "2" })).t === "joined",
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
