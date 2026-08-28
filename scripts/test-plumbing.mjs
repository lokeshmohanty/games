#!/usr/bin/env node
/**
 * test-plumbing.mjs — the private-state and round-clock layers, over the real
 * routing code, with a fake transport.
 *
 *   node scripts/test-plumbing.mjs
 *
 * The interesting claims here are not "does AES work". They are:
 *
 *   · a private message reaches exactly one member, and
 *   · **the peer that relays it cannot read it** — which is the case this
 *     project actually hits, because with no TURN server a pair that cannot
 *     connect directly is routed through whichever player can reach both. That
 *     player is an opponent. If the seal is only addressing, hidden-information
 *     games are a lie on any network where relaying happens.
 *
 * So the rooms are real `Room` instances running real `_send` / `_inbound`, and
 * only the WebRTC link underneath is faked — a fake link is also the only way
 * to *read the wire*, which is how the relay's view is asserted rather than
 * assumed. `_meshUp` is stubbed because it is the one part that would reach for
 * an RTCPeerConnection.
 */
import { readFileSync } from "node:fs";

globalThis.window = globalThis;
globalThis.location = { href: "https://example.test/party.html", hash: "", pathname: "/party.html", search: "" };
globalThis.history = { replaceState() {} };

for (const file of ["../lib/net.js", "../lib/secrets.js", "../lib/rounds.js"]) {
	new Function(readFileSync(new URL(file, import.meta.url), "utf8"))();
}
const { NeonArcade } = globalThis;

let failures = 0;
const check = (label, ok, detail = "") => {
	console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
	if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -- fake transport ---------------------------------------------------------

/** Every envelope that crossed a link, so a relay's view can be inspected. */
const wire = [];

function connect(a, b) {
	const linkA = {
		peerId: b.selfId,
		send(env) {
			const copy = structuredClone(env);
			wire.push({ from: a.selfId, to: b.selfId, env: copy });
			setTimeout(() => b._inbound(linkB, copy), 1);
		},
		close() {},
	};
	const linkB = {
		peerId: a.selfId,
		send(env) {
			const copy = structuredClone(env);
			wire.push({ from: b.selfId, to: a.selfId, env: copy });
			setTimeout(() => a._inbound(linkA, copy), 1);
		},
		close() {},
	};
	a.links.set(b.selfId, linkA);
	b.links.set(a.selfId, linkB);
}

/**
 * Build a party of `names.length` members with the host's record as the truth,
 * then let it replicate. `topology` names the pairs that get a direct link;
 * everything else has to be relayed, exactly as on a network where two phones
 * cannot see each other.
 */
async function party(names, topology) {
	const rooms = names.map((name, i) =>
		i === 0 ? NeonArcade.createHost({ name }) : NeonArcade.createGuest({ name }),
	);
	for (const r of rooms) {
		r._meshUp = () => {};
		r.resume();
	}
	const [host] = rooms;
	host.party.members = rooms.map((r, i) => ({
		id: r.selfId,
		name: names[i],
		team: i % 2 === 0 ? "A" : "B",
		joined: Date.now() + i,
	}));
	for (const [i, j] of topology) connect(rooms[i], rooms[j]);
	host._commitParty();
	await sleep(30);
	return rooms;
}

// ---------------------------------------------------------------------------
console.log("\nprivate channels");

{
	// Host, Ana, Bo. Bo has no direct link to the host, so anything the host
	// sends Bo goes through Ana — the player Bo is hiding from.
	const [host, ana, bo] = await party(["Host", "Ana", "Bo"], [
		[0, 1],
		[1, 2],
	]);
	check("relay topology: host has no direct link to Bo", !host.links.has(bo.selfId));

	const errors = [];
	const S = (r) => NeonArcade.makeSecrets(r, { onError: (e) => errors.push(e) });
	const [sh, sa, sb] = [S(host), S(ana), S(bo)];
	await Promise.all([sh.ready(), sa.ready(), sb.ready()]);
	await sleep(60); // let the public keys replicate on the party record

	check("public key published on the party record", !!host.getMember(bo.selfId)?.pk);
	check("privacy reported as sealed", sh.privacy() === "sealed");

	const got = { ana: [], bo: [] };
	sa.channel("hand").onMessage = (d, meta) => got.ana.push({ d, meta });
	sb.channel("hand").onMessage = (d, meta) => got.bo.push({ d, meta });
	sh.channel("hand");

	const secret = { fleet: ["B2", "C7"], salt: 41 };
	wire.length = 0;
	const sent = await sh.channel("hand").send(bo.selfId, secret);
	await sleep(60);

	check("send reported success", sent === true, JSON.stringify(errors));
	check("the addressee got it", JSON.stringify(got.bo[0]?.d) === JSON.stringify(secret));
	check("nobody else got it", got.ana.length === 0, `Ana saw ${got.ana.length}`);
	check("receiver sees the sender", got.bo[0]?.meta.from === host.selfId);

	// The whole point: Ana forwarded it, so read what Ana actually forwarded.
	const relayed = wire.filter((w) => w.from === ana.selfId && w.env.a === "s$hand");
	check("Ana did relay it", relayed.length > 0);
	const plaintext = JSON.stringify(relayed.map((w) => w.env));
	check("what the relay carried holds no plaintext", !plaintext.includes("B2") && !plaintext.includes("fleet"), plaintext.slice(0, 160));

	// And she cannot open it either: her own key derives to a different secret.
	const eaves = [];
	sa.channel("hand").onMessage = (d) => eaves.push(d);
	for (const w of relayed) sa.channel("hand"), ana._deliver(w.env);
	await sleep(40);
	check("the relay cannot decrypt it", eaves.length === 0, JSON.stringify(eaves));

	// A message rewritten in flight must not open — that is what the AEAD tag
	// and the channel/sender/recipient binding are for.
	const tampered = structuredClone(relayed[0].env);
	tampered.d.c = tampered.d.c.slice(0, -4) + "AAAA";
	errors.length = 0;
	bo._deliver(tampered);
	await sleep(40);
	check("a tampered message is refused, loudly", errors.some((e) => /did not open/.test(e.reason)), JSON.stringify(errors));

	// A private send to a bot never leaves the host that plays it.
	const botId = host.addBot("B");
	const botMail = [];
	sh.channel("hand").onMessage = (d, meta) => botMail.push({ d, meta });
	wire.length = 0;
	await sh.channel("hand").send(botId, { fleet: ["A1"] });
	await sleep(20);
	check("a bot's secret is delivered to the host that plays it", botMail[0]?.meta.to === botId);
	check("a bot's secret never touches the wire", wire.filter((w) => w.env.a === "s$hand").length === 0);

	for (const s of [sh, sa, sb]) s.dispose();
	for (const r of [host, ana, bo]) r.leave();
}

// ---------------------------------------------------------------------------
console.log("\ncommit and reveal");

{
	const [host] = await party(["Host", "Ana"], [[0, 1]]);
	const s = NeonArcade.makeSecrets(host);
	await s.ready();

	const fleet = { ships: [{ at: "B2", dir: "h" }], name: "red" };
	const c = await s.commit(fleet);
	check("a commitment hides the value", !JSON.stringify(c.digest).includes("B2"));
	check("an honest reveal verifies", await s.verify(c));

	const lied = { ...c, value: { ships: [{ at: "C3", dir: "h" }], name: "red" } };
	check("a changed value does not verify", !(await s.verify(lied)));
	check("a changed nonce does not verify", !(await s.verify({ ...c, nonce: "AAAA" })));

	// The trap this is really guarding: a value that has been through JSON
	// comes back with its keys in whatever order the sender used. Hashing the
	// raw serialisation would fail here with no bug behind it.
	const reordered = { name: "red", ships: [{ dir: "h", at: "B2" }] };
	check("key order does not change the digest", await s.verify({ ...c, value: reordered }));

	// Two commitments to the same value must not look alike, or the digest is
	// just a lookup key for a small set of possible board states.
	const again = await s.commit(fleet);
	check("the same value commits to a different digest", again.digest !== c.digest);

	s.dispose();
	host.leave();
}

// ---------------------------------------------------------------------------
console.log("\nround clock");

{
	const [host, ana] = await party(["Host", "Ana"], [[0, 1]]);
	const botId = host.addBot("B");
	await sleep(20);

	const ctxFor = (room) => ({
		room,
		players: () => room.getMembers().map((m) => m.id),
		botSeats: () => room.getMembers().filter((m) => NeonArcade.isBotId(m.id)).map((m) => m.id),
	});

	const seen = { host: [], ana: [] };
	const collected = [];
	let finished = 0;

	// Both rounds are played, not just the first: a scheduler that advances
	// correctly once and then stalls looks identical to a correct one if the
	// test only ever submits at the start.
	const PHASES = [
		{ name: "lock", ms: 4000, collect: true },
		{ name: "resolve", ms: 30 },
	];

	const hostRounds = NeonArcade.makeRounds(ctxFor(host), {
		rounds: 2,
		phases: PHASES,
		botSubmit: () => ({ pick: "bot" }),
		onPhase: (i) => {
			seen.host.push(`${i.round}:${i.phase}`);
			if (i.phase === "lock") setTimeout(() => hostRounds.submit({ pick: "host" }), 80);
		},
		onCollect: (i) => collected.push(i.entries),
		onFinish: () => finished++,
	});
	const anaRounds = NeonArcade.makeRounds(ctxFor(ana), {
		rounds: 2,
		phases: PHASES,
		onPhase: (i) => {
			seen.ana.push(`${i.round}:${i.phase}`);
			if (i.phase === "lock") setTimeout(() => anaRounds.submit({ pick: "ana" }), 80);
		},
	});

	const t0 = Date.now();
	hostRounds.start();
	await sleep(30);
	check("host opens on round 0 lock", hostRounds.state().phase === "lock");
	check("the peer mirrors the phase", anaRounds.state().phase === "lock", anaRounds.state().phase);
	check("the peer is told about the opening phase, not just later ones", seen.ana[0] === "0:lock", seen.ana.join(","));
	check("the bot submitted on its own", hostRounds.state().submitted.includes(botId), hostRounds.state().submitted.join(","));

	await sleep(500);
	const elapsed = Date.now() - t0;
	// Two collecting phases with a 4s deadline each: finishing inside a second
	// means both ended on the last submission rather than on the clock, which
	// is the entire simultaneous-turn claim.
	check("collecting phases end when everyone is in, not at their deadline", elapsed < 2000 && finished === 1, `${elapsed}ms, finished=${finished}`);
	check("the host collected every seat", collected[0]?.size === 3, `got ${collected[0]?.size}`);
	check("submissions arrive intact", collected[0]?.get(ana.selfId)?.pick === "ana");
	check("the bot's answer is collected like anyone's", collected[0]?.get(botId)?.pick === "bot");
	check("both rounds were collected", collected.length === 2, `${collected.length}`);
	check("the peer saw all four phases", seen.ana.join(",") === "0:lock,0:resolve,1:lock,1:resolve", seen.ana.join(","));

	// A deadline with nobody submitting must still move the game on.
	const timed = [];
	const solo = NeonArcade.makeRounds(ctxFor(host), {
		name: "solo",
		rounds: 1,
		phases: [{ name: "wait", ms: 60, collect: true }, { name: "after", ms: 20 }],
		onPhase: (i) => timed.push(i.phase),
	});
	solo.start();
	await sleep(200);
	check("a collecting phase still ends at its deadline", timed.join(",") === "wait,after", timed.join(","));

	// Timers must not outlive the game; the shell mounts the next one into the
	// same room and a stray deadline would fire into it.
	const strays = [];
	const leaky = NeonArcade.makeRounds(ctxFor(host), {
		name: "leaky",
		rounds: 3,
		phases: [{ name: "a", ms: 40 }],
		onPhase: (i) => strays.push(i.phase),
	});
	leaky.start();
	await sleep(10);
	leaky.dispose();
	const after = strays.length;
	await sleep(200);
	check("dispose stops the clock", strays.length === after, `${after} -> ${strays.length}`);

	hostRounds.dispose();
	anaRounds.dispose();
	solo.dispose();
	host.leave();
	ana.leave();
}

console.log(failures ? `\n${failures} failing\n` : "\nall passing\n");
process.exit(failures ? 1 : 0);
