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
globalThis.location = { href: "https://example.test/?party", hash: "", pathname: "/", search: "?party" };
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

/**
 * A fake link pair, not yet registered with either room — hand each end to
 * `_linkOpened` to exercise the real "a connection just opened" path. A closed
 * end stops carrying anything, as a real channel would. What crosses it is
 * what a data channel carries: the real `toWire` strings, read back by the
 * real `fromWire` (an election request once died there, unseen here).
 */
const { toWire, fromWire } = NeonArcade._codec;
let fpSeq = 0;
/**
 * `hello`: the ends start unverified, as a real channel does, and the rooms'
 * own hellos (net.js _linkUp) must prove who is on each end — each end has
 * a DTLS fingerprint of its own, as a real one does. Without it the ends
 * come pre-verified, as if their hellos had already crossed.
 */
function linkPair(a, b, { hello = false } = {}) {
	const fps = [`FA${++fpSeq}`, `FB${fpSeq}`];
	const end = (self, other, peer, [local, remote]) => ({
		peerId: other.selfId,
		owner: hello ? null : other.selfId,
		// As if made from an invite naming the far side (net.js link.named).
		named: true,
		fingerprints: () => ({ local, remote }),
		closed: false,
		chunks: new Map(),
		send(env) {
			// A muted room (its uplink dead) sends nothing.
			if (this.closed || self.__mute) return;
			wire.push({ from: self.selfId, to: other.selfId, env: structuredClone(env) });
			const strings = toWire(env);
			// A frozen room (a tab in the background) hears nothing.
			// A deaf one (its downlink dead) too.
			setTimeout(() => {
				if (other.__frozen || other.__deaf) return;
				const far = peer();
				for (const str of strings) {
					const msg = fromWire(far.chunks, str);
					if (msg) other._inbound(far, msg);
				}
			}, 1);
		},
		close() {
			this.closed = true;
		},
	});
	const linkA = end(a, b, () => linkB, fps);
	const linkB = end(b, a, () => linkA, [fps[1], fps[0]]);
	return [linkA, linkB];
}

const fullMesh = (n) => {
	const t = [];
	for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) t.push([i, j]);
	return t;
};

function connect(a, b) {
	const [linkA, linkB] = linkPair(a, b);
	a.links.set(b.selfId, linkA);
	b.links.set(a.selfId, linkB);
}

/**
 * Build a party of `names.length` members with the host's record as the truth,
 * then let it replicate. `topology` names the pairs that get a direct link;
 * everything else has to be relayed, exactly as on a network where two phones
 * cannot see each other.
 */
async function party(names, topology, opts = {}) {
	const rooms = [];
	const { ids: given, ...rest } = opts;
	opts = rest;
	for (const [i, name] of names.entries()) {
		const identity = given?.[i] ?? (await NeonArcade.identity({ fresh: true }));
		rooms.push(i === 0 ? NeonArcade.createHost({ ...opts, name, identity }) : NeonArcade.createGuest({ ...opts, name, identity }));
	}
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
console.log("\nthe wire: what a data channel carries");
{
	const chunks = new Map();
	const read = (env) => toWire(env).map((str) => fromWire(chunks, str)).filter(Boolean);
	const ask = { __c: "k1", r: 0, f: "aaa", t: null, id: "e1", h: 2, m: ["b", "c"] };
	const got = read(ask);
	check("an election request ({ __c: key, … }) arrives whole, not taken for a part", got.length === 1 && JSON.stringify(got[0]) === JSON.stringify(ask), JSON.stringify(got));
	const big = { a: "x", d: "y".repeat(40_000), f: "aaa", t: null, id: "e2" };
	const parts = toWire(big);
	const back = parts.map((str) => fromWire(chunks, str)).filter(Boolean);
	check("a big message goes as parts and arrives once, whole", parts.length === 4 && back.length === 1 && back[0].d === big.d, `${parts.length} parts, ${back.length} back`);
	check("a part claiming a million parts is dropped, nothing held for it", fromWire(chunks, JSON.stringify({ __c: "z", i: 0, n: 1e6, p: "{" })) === null && !chunks.has("z"));
	check("a part-shaped thing out of bounds is dropped, never passed on as an election request", fromWire(chunks, JSON.stringify({ __c: "y", i: 2, n: 2, p: "x" })) === null && fromWire(chunks, JSON.stringify({ __c: "y", i: 1.5, n: 2, p: "x" })) === null);
	check("a non-string __c is dropped (an election key is always a string)", fromWire(chunks, JSON.stringify({ __c: 5, i: 0, n: 2, p: "x" })) === null && fromWire(chunks, JSON.stringify({ __c: 5, r: 0 })) === null);
	fromWire(chunks, JSON.stringify({ __c: "w", i: 0, n: 2, p: '{"a":' }));
	check("a part disagreeing about the count is dropped", fromWire(chunks, JSON.stringify({ __c: "w", i: 1, n: 3, p: '"x"}' })) === null && chunks.get("w").length === 2);
	check("not JSON, or not an object: nothing", fromWire(chunks, "{oops") === null && fromWire(chunks, "7") === null && fromWire(chunks, "null") === null);
}

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
	check("what the relay carried holds no plaintext", !plaintext.includes('"B2"') && !plaintext.includes('"fleet"'), plaintext.slice(0, 160));

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
	// Not `includes("B2")`: a random base64 digest contains that by chance
	// about one run in a hundred. What must not be in it is the value itself.
	check("a commitment hides the value", !String(c.digest).includes("ships") && !String(c.digest).includes(JSON.stringify(fleet)));
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

	{
		// A phase that ends on a game event rather than a clock — the case Liar's
		// Dice needs, where the bidding is over the moment somebody calls a bluff.
		const walked = [];
		const evented = NeonArcade.makeRounds(ctxFor(host), {
			name: "evented",
			rounds: 2,
			phases: [{ name: "act", ms: 600_000 }, { name: "score", ms: 20 }],
			onPhase: (i) => {
				walked.push(`${i.round}:${i.phase}`);
				if (i.phase === "act") setTimeout(() => evented.next(), 20);
			},
		});
		evented.start();
		await sleep(300);
		check("a phase can be ended by the game rather than the clock",
			walked.join(",") === "0:act,0:score,1:act,1:score", walked.join(","));
		evented.dispose();
	}

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

// ---------------------------------------------------------------------------
console.log("\nmembership and the crown");

const ids = (room) => room.getMembers().map((m) => m.id).sort().join(",");
const bare = async (opts, host = true) => {
	const o = { ...opts, identity: opts.identity ?? (await NeonArcade.identity({ fresh: true })) };
	const r = host ? NeonArcade.createHost(o) : NeonArcade.createGuest(o);
	r._meshUp = () => {};
	r.resume();
	return r;
};

{
	// A suspect's probe timer used to survive leave(): its handle was stored
	// inside an object that clearTimeout silently ignored, so the room went on
	// dropping members and firing callbacks after it had closed.
	const [host, ana] = await party(["Host", "Ana"], [[0, 1]]);
	const late = [];
	for (const k of ["onPeerLeave", "onParty", "onHostVacant", "onPeerJoin"]) {
		host[k] = () => host.closed && late.push(k);
	}
	host._linkClosed(host.links.get(ana.selfId));
	check("a dropped link puts the member under probe", host.suspects.has(ana.selfId));
	host.leave();
	await sleep(2800); // past DEPARTURE_GRACE_MS
	check("no callback fires after leave(), even for a pending probe", late.length === 0, late.join(","));
	ana.leave();
}

{
	// Two crown holders at one term: two parties' founders. Before signed
	// messages the lower id took both — and a member signing a record that
	// names itself could do just that (2026-11-18). Now each party has its
	// own id (`pid`), nothing signed for one counts in the other, and a
	// crown moves only on proof (net.js _proven): each keeps its own.
	const a = await bare({ name: "A" });
	const b = await bare({ name: "B" });
	connect(a, b);
	a._commitParty();
	b._commitParty();
	await sleep(40);
	check("another party's crown at our term is not taken", a.isHost() && b.isHost() && a.refusals.includes("another party") && b.refusals.includes("another party"), `${a.hostId() === a.selfId} ${b.hostId() === b.selfId} ${a.refusals}`);
	a.leave();
	b.leave();
}

{
	// A hand-over (transferHost) is proven by the record that made it: the
	// old holder's, signed, carried inside the new holder's. Fay is frozen
	// through two hand-overs and then hears only the latest record — two
	// terms behind, she checks the chain back to the holder she knew.
	const [c, d, e, f] = await party(["C", "D", "E", "F"], fullMesh(4));
	f.__frozen = true;
	c.transferHost(d.selfId);
	await sleep(60);
	check("a hand-over moves the crown", [c, d, e].every((r) => r.hostId() === d.selfId) && d.isHost() && d.party.term === 1, [c, d, e].map((r) => r.hostId() === d.selfId).join());
	d.transferHost(e.selfId);
	await sleep(60);
	f.__frozen = false;
	e.setGame(null);
	await sleep(60);
	check("a member two hand-overs behind takes the latest crown on its proof", f.hostId() === e.selfId && f.party.term === 2 && [c, d, e].every((r) => r.hostId() === e.selfId), `f sees ${f.hostId() === e.selfId} term ${f.party.term}`);
	for (const r of [c, d, e, f]) r.leave();
}

{
	// A member that wrongly concluded the host was gone computed an heir — but
	// a host that is still speaking at the same term wins it back.
	const [host, ana, bo] = await party(["Host", "Ana", "Bo"], [[0, 1], [0, 2], [1, 2]]);
	bo._applyGone(host.selfId);
	check("a false alarm moves the crown locally", bo.hostId() !== host.selfId);
	host.setGame(null);
	await sleep(30);
	check("the live host's next record heals it", bo.hostId() === host.selfId && !!bo.getMember(host.selfId), bo.hostId());
	for (const r of [host, ana, bo]) r.leave();
}

{
	// The newcomer's side of a fresh link used to introduce its inviter to the
	// host under the name baked into the invite — renaming the host back to
	// whatever it was called when it minted it.
	const host = await bare({ name: "Host" });
	const guest = await bare({ name: "Newbie" }, false);
	host.setName("Renamed");
	const [toGuest, toHost] = linkPair(host, guest);
	toHost.introducedName = "Host"; // what the invite said
	toGuest.introducedName = "Newbie";
	guest._linkOpened(toHost);
	host._linkOpened(toGuest);
	await sleep(40);
	check("the newcomer learns the host's record", guest.hostId() === host.selfId);
	check("an introduction never renames the inviter", host.self().name === "Renamed" && guest.getMember(host.selfId)?.name === "Renamed", host.self().name);
	check("the newcomer is seated under its own name", host.getMember(guest.selfId)?.name === "Newbie");
	host.leave();
	guest.leave();
}

{
	// Leaving on purpose frees the seat at once — even one the room server
	// would otherwise hold for five minutes — and passes the crown on the spot.
	const [host, ana, bo, cy] = await party(["Host", "Ana", "Bo", "Cy"], [
		[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3],
	]);
	host.party.members.find((m) => m.id === ana.selfId).rs = true;
	host._commitParty();
	await sleep(20);
	const reasons = [];
	ana.onLeave = (r) => reasons.push(r);
	ana.leave();
	await sleep(30);
	check("leave() tells the room server why", reasons.join() === "left", reasons.join());
	check("peers drop a leaver's seat at once, room-server seat included",
		!host.getMember(ana.selfId) && !bo.getMember(ana.selfId) && !cy.getMember(ana.selfId));

	const botId = host.addBot("B");
	await sleep(20);
	check("heir() is the longest-present other member", host.heir() === bo.selfId, host.heir());
	host.party.members.find((m) => m.id === bo.selfId).reconnecting = Date.now();
	check("heir() skips a reconnecting seat", host.heir() === cy.selfId, host.heir());
	delete host.party.members.find((m) => m.id === bo.selfId).reconnecting;
	check("heir() never names a bot", host.heir() !== botId);
	check("heir() is null with nobody to take it", (await bare({ name: "Solo" })).heir() === null);

	host.transferHost(botId);
	check("the crown cannot be handed to a bot", host.isHost());

	let got = 0;
	host.makeAction("ping").onMessage = () => got++;
	host.emitAs(botId, "ping", 1, { target: host.selfId });
	await sleep(10);
	check("emitAs to ourselves delivers exactly once", got === 1, `${got}`);

	const heir = host.heir();
	host.leave();
	await sleep(30);
	check("the host leaving crowns its heir at once", bo.hostId() === heir && cy.hostId() === heir, `${bo.hostId()} / ${cy.hostId()}`);
	check("everyone drops the host's seat", !bo.getMember(host.selfId) && !cy.getMember(host.selfId));
	check("the host's bots stay, for the heir to play", bo.bots().length === 1 && cy.bots().length === 1, `${bo.bots().length} / ${cy.bots().length}`);

	const why = [];
	cy.onLeave = (r) => why.push(r);
	bo.removeMember(cy.selfId);
	await sleep(20);
	check("an eviction reaches onLeave as such", why.join() === "evicted", why.join());
	bo.leave();
}

{
	const [host, ana] = await party(["Host", "Ana"], [[0, 1]]);
	const why = [];
	ana.onLeave = (r) => why.push(r);
	host.deleteParty();
	await sleep(300);
	check("a deleted party reaches onLeave as such", why.join() === "closed", why.join());
}

{
	// The room server's "back on the socket" clears a mark it set itself, so a
	// member reached only by relay is not RECONNECTING forever after a blip —
	// but a mark the mesh concluded is still the link's to clear.
	const host = await bare({ name: "Host", reconnectGraceMs: 60_000 });
	host.party.members.push({ id: "relayonly", name: "R", team: null, joined: Date.now(), rs: true });
	host.serverPeerState("relayonly", false);
	check("a socket drop marks a room-server member", !!host.getMember("relayonly").reconnecting);
	host.serverPeerState("relayonly", true);
	check("and their return clears that mark", !host.getMember("relayonly").reconnecting);
	host._confirmGone("relayonly");
	host.serverPeerState("relayonly", true);
	check("a mark the mesh concluded stays until a link opens", !!host.getMember("relayonly").reconnecting);
	host.leave();
}

{
	// A relayed offer to somebody who is not there must not hang around: it
	// used to keep the pair in `negotiating` forever, so after they came back
	// nobody ever offered again and the pair stayed relay-only for good.
	const made = [];
	globalThis.RTCPeerConnection = class {
		constructor() {
			made.push(this);
			this.iceGatheringState = "complete";
			this.connectionState = "new";
		}
		createDataChannel() {
			return { readyState: "connecting", close() {} };
		}
		async createOffer() {
			return { type: "offer", sdp: "v=0\r\n" };
		}
		async setLocalDescription(d) {
			this.localDescription = d;
		}
		addEventListener() {}
		removeEventListener() {}
		close() {
			this.closed = true;
		}
	};
	const room = NeonArcade.createHost({ name: "Host", identity: await NeonArcade.identity({ fresh: true }) });
	room.relayTimeoutMs = 60;
	room.party.members.push({ id: "zzzzzzzzzz", name: "Z", team: null, joined: Date.now() });
	room._meshUp();
	await sleep(10);
	check("an offer to a member we lack a link to goes out", made.length === 1 && room.negotiating.has("zzzzzzzzzz"));
	await sleep(70);
	// Never answered, so perhaps never delivered (a relayed message has no
	// delivery guarantee): made afresh, once (test-room 6e23).
	check("an unanswered offer that expires is made afresh, once", made.length === 2 && made[0].closed === true && room.negotiating.has("zzzzzzzzzz"), `${made.length}`);
	await sleep(100);
	check("an unanswered offer times out and is forgotten",
		!room.negotiating.has("zzzzzzzzzz") && !room.pending.has("r:zzzzzzzzzz") && made.length === 2, `${made.length}`);
	check("and its PeerConnection is closed", made[1].closed === true);
	room._meshUp();
	await sleep(10);
	check("so the next roster change can try again", made.length === 3);

	const warn = console.warn;
	console.warn = () => {};
	made[2].connectionState = "failed";
	made[2].onconnectionstatechange();
	console.warn = warn;
	check("a failed negotiation is forgotten too, though it never opened", !room.negotiating.has("zzzzzzzzzz"));

	room.party.members.find((m) => m.id === "zzzzzzzzzz").reconnecting = Date.now();
	room._meshUp();
	await sleep(10);
	check("nobody offers to a seat held for a reconnect", made.length === 3, `${made.length}`);
	room.leave();
	delete globalThis.RTCPeerConnection;
}

// ---------------------------------------------------------------------------
console.log("\na split party: only the heir's side carries on");

/** Cut a pair's direct link, as a network does: neither end is told why. */
const cut = (a, b) => {
	const la = a.links.get(b.selfId);
	const lb = b.links.get(a.selfId);
	if (la) a._linkClosed(la);
	if (lb) b._linkClosed(lb);
};
/** The host's tab dies: no goodbye, its links just stop. */
const vanish = (host, others) => {
	host.detach();
	for (const r of others) {
		const l = r.links.get(host.selfId);
		if (l) r._linkClosed(l);
	}
};
const hosts = (rooms) => rooms.filter((r) => r.isHost()).map((r) => r.self().name).join(",");
const DEPARTURE = 2800; // past net.js DEPARTURE_GRACE_MS

{
	// Three seats, and the two guests reach each other only through the host
	// (a pair with no route: no TURN, by design). The host's tab dies. Ana is
	// the heir; Bo cannot reach her, so Bo must not crown — and says so.
	const [host, ana, bo] = await party(["Host", "Ana", "Bo"], [[0, 1], [0, 2]], { heirWaitMs: 300 });
	const term = bo.party.term;
	const told = [];
	bo.onLost = (on) => told.push(on);
	ana.onLost = (on) => told.push(`ana:${on}`);
	vanish(host, [ana, bo]);
	await sleep(DEPARTURE + 500);
	check("one host after the split: the heir", hosts([ana, bo]) === "Ana", hosts([ana, bo]));
	check("the side without the heir does not crown", !bo.isHost() && bo.party.term === term, `bo host=${bo.isHost()} term=${bo.party.term}`);
	check("…and is lost, and told so once", bo.lost === true && told.join() === "true", told.join());
	check("the heir's side is not lost", ana.lost === false);

	// Bo regains a path to Ana: it rejoins her party — seat and all — rather
	// than forking it.
	const [toBo, toAna] = linkPair(ana, bo);
	toAna.introducedName = "Ana";
	toBo.introducedName = "Bo";
	bo._linkOpened(toAna);
	ana._linkOpened(toBo);
	await sleep(60);
	check("a lost side that finds the heir again rejoins its party", bo.lost === false && told.join() === "true,false" && bo.hostId() === ana.selfId, `${told.join()} host=${bo.hostId()}`);
	check("…as a member of it, still one host", !!ana.getMember(bo.selfId) && hosts([ana, bo]) === "Ana", `${ids(ana)} / ${hosts([ana, bo])}`);
	for (const r of [ana, bo]) r.leave();
}

for (const first of ["the pair", "the host"]) {
	// A full mesh that splits as the host goes: the guests' own link drops
	// too. Bo concludes both gone. Whichever probe ends first, Bo used to
	// end up crowning itself — two hosts, two parties.
	const [host, ana, bo] = await party(["Host", "Ana", "Bo"], [[0, 1], [0, 2], [1, 2]], { heirWaitMs: 300 });
	if (first === "the pair") {
		cut(ana, bo);
		await sleep(50);
	}
	vanish(host, [ana, bo]);
	if (first === "the host") {
		await sleep(50);
		cut(ana, bo);
	}
	await sleep(DEPARTURE + 600);
	check(`split (${first} first): one host, the heir`, hosts([ana, bo]) === "Ana", hosts([ana, bo]) || "none");
	check(`split (${first} first): the other side is lost, not a second party`, bo.lost === true && !bo.isHost());
	for (const r of [ana, bo]) r.leave();
}

{
	// The heir itself said goodbye: the crown passes on to the next in line,
	// as before — a goodbye is not a split.
	const [host, ana, bo, cy] = await party(["Host", "Ana", "Bo", "Cy"], [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]], { heirWaitMs: 300 });
	host.leave();
	await sleep(30);
	ana.leave();
	await sleep(400);
	check("the heir leaving on purpose passes the crown on", hosts([bo, cy]) === "Bo" && !bo.lost && !cy.lost, `${hosts([bo, cy])} lost=${bo.lost},${cy.lost}`);
	for (const r of [bo, cy]) r.leave();
}

{
	// A drop seen at one end first: the lower id offered while the higher id
	// still held the (dead) link, so the offer was set aside — and its
	// resend, with the same id, would be dropped as seen. When the higher id
	// notices and asks about us, we offer afresh.
	const [host, ana, bo] = await party(["Host", "Ana", "Bo"], [[0, 1], [0, 2], [1, 2]]);
	const [low, high] = ana.selfId < bo.selfId ? [ana, bo] : [bo, ana];
	const dials = [];
	low._openRelayed = (peer) => dials.push(peer);
	const stale = { peerId: high.selfId, answered: false, offerEnv: { __g: "offer" }, close() { this.closed = true; } };
	low.links.delete(high.selfId);
	low.pending.set("r:" + high.selfId, stale);
	low.negotiating.set(high.selfId, stale);
	high._linkClosed(high.links.get(low.selfId)); // the higher id notices: it asks about us
	await sleep(40);
	check("asked about by a peer that lost its link to us, we offer afresh", dials.join() === high.selfId && stale.closed === true && !low.pending.has("r:" + high.selfId), `${dials.join()} closed=${stale.closed}`);
	for (const r of [host, ana, bo]) r.leave();
}

// ---------------------------------------------------------------------------
console.log("\na split party, reviewed: hidden heirs, a quorum, reloads, the old host");

for (const withBo of [true, false]) {
	// The heir reloaded (its seat held by the room server) and is back,
	// linked to Cy before the host's record about it went out — then the host
	// dies. On its fresh page it has heard nobody, which used to read as
	// "the crown is an heir we only computed": it went lost, and so did Cy.
	// With Bo there too, Bo is named (Ana's seat is held on the record) and
	// wins with Cy. With Ana and Cy alone it is the documented total loss:
	// half the humans, the tie-break heir (Ana, the oldest) without a vote.
	const names = withBo ? ["Host", "Ana", "Bo", "Cy"] : ["Host", "Ana", "Cy"];
	const rooms = await party(names, fullMesh(names.length), { heirWaitMs: 300 });
	const [h, a] = rooms;
	const rest = rooms.slice(2);
	const c = rooms.at(-1);
	const a2 = await bare({ name: "Ana", identity: a.identity, heirWaitMs: 300 }, false);
	a.detach();
	for (const r of [h, ...rest]) r.party.members.find((m) => m.id === a.selfId).rs = true;
	for (const r of [h, ...rest]) {
		const l = r.links.get(a.selfId);
		if (l) r._linkClosed(l);
	}
	await sleep(DEPARTURE);
	const [toA, toC] = linkPair(c, a2);
	toA.introducedName = "Ana";
	toC.introducedName = "Cy";
	h.__frozen = true;
	h.detach();
	c._linkOpened(toA);
	a2._linkOpened(toC);
	for (const r of rest) {
		const l = r.links.get(h.selfId);
		if (l) r._linkClosed(l);
	}
	await sleep(DEPARTURE + 1500);
	if (withBo) {
		const bo = rooms[2];
		check("a reloaded heir's party heals: one host, nobody lost", hosts([a2, ...rest]) === "Bo" && a2.hostId() === bo.selfId && !a2.lost && !c.lost, `${hosts([a2, ...rest])} lost=${a2.lost},${c.lost}`);
	} else {
		check("two humans, one fresh from a reload: no crown (the documented total loss), never two", hosts([a2, c]) === "", hosts([a2, c]));
	}
	for (const r of [a2, ...rest]) r.leave();
}

{
	// The heir's phone is in the background (`away` on the record): the next
	// in line takes the crown at once, and the heir agrees.
	const [h, a, b, c] = await party(["Host", "Ana", "Bo", "Cy"], [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]], { heirWaitMs: 300 });
	a.setMeta({ away: true });
	await sleep(40);
	h.leave();
	await sleep(100);
	check("a hidden heir is skipped: the next awake member takes the crown", hosts([a, b, c]) === "Bo" && ![a, b, c].some((r) => r.lost), `${hosts([a, b, c])}`);
	check("…and every member names the same one", [a, b, c].every((r) => r.hostId() === b.selfId));
	for (const r of [a, b, c]) r.leave();
}

{
	// The heir's tab is frozen (no messages either way) as the host leaves.
	// Bo and Cy wait for it, then — holding a quorum, two of the three left —
	// Bo takes the crown rather than both going lost for good.
	const [h, a, b, c] = await party(["Host", "Ana", "Bo", "Cy"], [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]], { heirWaitMs: 300 });
	a.__frozen = true;
	h.leave();
	await sleep(800);
	check("a silent heir is passed over by a side with a quorum", hosts([b, c]) === "Bo" && !b.lost && !c.lost, `${hosts([b, c])} lost=${b.lost},${c.lost}`);
	for (const r of [a, b, c]) r.leave();
}

{
	// Five seats; the host vanishes, and the heir is cut off alone from the
	// other three. A side of one out of four holds no quorum, so the heir
	// does not crown (it would be a second party); the three wait for it,
	// then the next in line takes the crown with three of four.
	const [h, a, b, c, d] = await party(["Host", "Ana", "Bo", "Cy", "Dee"], [[0, 1], [0, 2], [0, 3], [0, 4], [1, 2], [1, 3], [1, 4], [2, 3], [2, 4], [3, 4]], { heirWaitMs: 300 });
	for (const r of [b, c, d]) cut(a, r);
	await sleep(50);
	vanish(h, [a, b, c, d]);
	await sleep(DEPARTURE + 1200);
	check("an heir alone against three does not crown: it is lost", !a.isHost() && a.lost === true, `ana host=${a.isHost()} lost=${a.lost}`);
	check("…and the three, holding a quorum, crown the next in line", hosts([a, b, c, d]) === "Bo" && !b.lost && !c.lost && !d.lost, `${hosts([a, b, c, d])}`);
	for (const r of [a, b, c, d]) r.leave();
}

{
	// Everyone is cut off from everyone as the host vanishes: all lost. Then
	// Bo, Cy and Dee link up again — three of four — and take the crown;
	// they must not stay lost for good.
	const [h, a, b, c, d] = await party(["Host", "Ana", "Bo", "Cy", "Dee"], [[0, 1], [0, 2], [0, 3], [0, 4]], { heirWaitMs: 300 });
	vanish(h, [a, b, c, d]);
	await sleep(DEPARTURE + 1200);
	check("(cut off from each other, all four are lost)", [a, b, c, d].every((r) => r.lost && !r.isHost()), [a, b, c, d].map((r) => r.lost).join());
	for (const [x, y] of [[b, c], [b, d], [c, d]]) {
		const [toY, toX] = linkPair(x, y);
		toY.introducedName = y.self().name;
		toX.introducedName = x.self().name;
		x._linkOpened(toY);
		y._linkOpened(toX);
	}
	await sleep(800);
	check("lost phones that link up into a quorum take the crown", hosts([a, b, c, d]) === "Bo" && !b.lost && !c.lost && !d.lost && a.lost, `${hosts([a, b, c, d])} lost=${[a, b, c, d].map((r) => r.lost).join()}`);
	for (const r of [a, b, c, d]) r.leave();
}

{
	// A 1v1 split as the host's network moves: the host is alive, alone.
	// Bo is lost; the old host then reaches Bo again, at the old term, with
	// a record that no longer seats Ana. Adopting it would put Bo in a second
	// party beside Ana's: Bo stays lost.
	const [h, a, b] = await party(["Host", "Ana", "Bo"], [[0, 1], [0, 2]], { heirWaitMs: 300 });
	cut(h, a);
	cut(h, b);
	await sleep(DEPARTURE + 600);
	h.party.members = h.party.members.filter((m) => m.id !== a.selfId);
	const [toB, toH] = linkPair(h, b);
	toB.introducedName = "Bo";
	toH.introducedName = "Host";
	b._linkOpened(toH);
	h._linkOpened(toB);
	await sleep(100);
	check("the old host's record at the old term does not end a loss", b.lost === true && b.hostId() !== h.selfId, `lost=${b.lost} host=${b.hostId() === h.selfId ? "Host" : b.hostId()}`);
	for (const r of [h, a, b]) r.leave();
}

{
	// The host's seat is held by the room server, so its loss is no
	// `__gone`. Ana reaches it only through Bo; Bo concludes it gone and says
	// the crown is vacant, so Ana — the heir — takes it, rather than Bo going
	// lost while Ana waits out a five-minute grace.
	// Ana asks for herself before concluding (a probe of her own), so the
	// heir's wait here is longer than that, as the real 10 s is.
	const [h, a, b] = await party(["Host", "Ana", "Bo"], [[0, 2], [1, 2]], { heirWaitMs: 4000 });
	for (const r of [h, a, b]) r.party.members.find((m) => m.id === h.selfId).rs = true;
	h.detach();
	const l = b.links.get(h.selfId);
	if (l) b._linkClosed(l);
	await sleep(2 * DEPARTURE + 800);
	check("a held host's seat: the crown's vacancy reaches an heir behind a relay", hosts([a, b]) === "Ana" && !b.lost, `${hosts([a, b])} lost=${b.lost}`);
	for (const r of [a, b]) r.leave();
}

{
	// A lost side asks the room server more than once.
	const isolated = [];
	const [h, a, b] = await party(["Host", "Ana", "Bo"], [[0, 1], [0, 2]], { heirWaitMs: 200, lostRetryMs: [100, 200] });
	b.onIsolated = () => isolated.push(Date.now());
	vanish(h, [a, b]);
	await sleep(DEPARTURE + 700);
	check("a lost side retries the room server, not once", b.lost && isolated.length >= 3, `${isolated.length}`);
	for (const r of [a, b]) r.leave();
}

{
	// An offer abandoned while it gathered is never sent, and an answer to
	// an earlier offer cannot land on the one that replaced it.
	let n = 0;
	const real = globalThis.RTCPeerConnection;
	globalThis.RTCPeerConnection = class extends EventTarget {
		constructor() { super(); this.n = ++n; this.iceGatheringState = "new"; this.connectionState = "new"; this.remote = null; }
		createDataChannel() { return { close() {} }; }
		async createOffer() { return { type: "offer", sdp: "offer-" + this.n }; }
		async setLocalDescription(d) { this.localDescription = d; this.iceGatheringState = "gathering"; setTimeout(() => { this.iceGatheringState = "complete"; this.dispatchEvent(new Event("icegatheringstatechange")); }, 40); }
		async setRemoteDescription(d) { this.remote = d.sdp; }
		close() { this.closed = true; }
	};
	const room = await bare({ name: "Low" }, false);
	room.selfId = "aaaa";
	room.party = { host: "hhhh", term: 0, members: [{ id: "aaaa", joined: 1 }, { id: "zzzz", joined: 2 }, { id: "hhhh", joined: 0 }] };
	const sent = [];
	room._send = (env) => env.__g && sent.push(env);
	room._redial("zzzz"); // the far end noticed: we offer
	await sleep(10);
	room._redial("zzzz"); // its re-probe while ours still gathers: left alone
	await sleep(150);
	check("a re-probe does not abandon an offer still gathering", sent.length === 1, sent.map((e) => e.sdp).join());
	const first = sent[0];
	room._redial("zzzz"); // asked again after ours went out: a fresh one
	await sleep(150);
	const link = room.pending.get("r:zzzz");
	check("…but one already sent is made afresh, with a new nonce", sent.length === 2 && sent[1].n && sent[1].n !== first.n, sent.map((e) => e.n).join());
	await room._onRelayedAnswer("zzzz", "answer-to-the-first", first.n);
	check("an answer to the abandoned offer does not land on the new one", link && link.pc.remote === null, link?.pc.remote);
	await room._onRelayedAnswer("zzzz", "answer-to-the-second", sent[1].n);
	check("…while the answer to the new one does", link?.pc.remote === "answer-to-the-second", link?.pc.remote);
	room.leave();
	globalThis.RTCPeerConnection = real;
}

// ---------------------------------------------------------------------------
console.log("\na split party, re-reviewed: one record, and who said here");

{
	// Ana reloads (her seat held on the host's record) and is back, linked to
	// Cy only, when the host dies and the guests split {Ana, Cy} | {Bo, Dee}.
	// Cy's relink had cleared Ana's held mark on Cy's own copy, so Cy named
	// Ana heir while Bo and Dee named Bo — and each half passed the tie. And
	// Ana's fresh page, with no record of its own, counted a false majority.
	// Every input now comes from the record, and a page without one never
	// crowns by a quorum: one crown, Bo's.
	const o = { heirWaitMs: 300, lostRetryMs: [] };
	const [h, a, b, c, d] = await party(["Host", "Ana", "Bo", "Cy", "Dee"], [[0, 1], [0, 2], [0, 3], [0, 4], [1, 2], [1, 3], [1, 4], [2, 3], [2, 4], [3, 4]], o);
	h.party.members.find((m) => m.id === a.selfId).rs = true;
	h._commitParty();
	await sleep(20);
	a.detach();
	for (const r of [h, b, c, d]) {
		const l = r.links.get(a.selfId);
		if (l) r._linkClosed(l);
	}
	await sleep(DEPARTURE + 200);
	const a2 = await bare({ ...o, name: "Ana", identity: a.identity }, false);
	h.__frozen = true;
	h.detach();
	const [toA, toC] = linkPair(c, a2);
	toA.introducedName = "Ana";
	toC.introducedName = "Cy";
	c._linkOpened(toA);
	a2._linkOpened(toC);
	await sleep(20);
	cut(c, b);
	cut(c, d);
	for (const r of [b, c, d]) {
		const l = r.links.get(h.selfId);
		if (l) r._linkClosed(l);
	}
	await sleep(DEPARTURE + 2500);
	// The tie-break heir is Ana (the oldest): with her vote gone in the
	// reload, neither half wins — no crown, rather than two.
	check("a reload, then a 2–2 split: one crown, not two", hosts([a2, b, c, d]).split(",").filter(Boolean).length <= 1, hosts([a2, b, c, d]));
	check("…a page with no record of its own never crowns by a count", !a2.isHost());
	check("…and the side without the crown is lost", c.lost === true && !c.isHost(), `cy lost=${c.lost}`);
	for (const r of [a2, b, c, d]) r.leave();
}

{
	// A healthy party, the host leaves; the heir links directly to Bo only,
	// everyone else through Bo. Counting direct links, the heir had no
	// quorum and went lost until Bo took the crown 10 s later. Counting who
	// said "here" through the mesh, the heir crowns at once.
	const [h, a, b, c, d, e] = await party(["Host", "Ana", "Bo", "Cy", "Dee", "Eve"], [[0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [1, 2], [2, 3], [2, 4], [2, 5], [3, 4], [3, 5], [4, 5]], { heirWaitMs: 1000, lostRetryMs: [] });
	const lostA = [];
	a.onLost = (x) => lostA.push(x);
	h.leave();
	await sleep(300);
	check("an heir reached through a relay crowns at once, never lost", hosts([a, b, c, d, e]) === "Ana" && !lostA.length, `${hosts([a, b, c, d, e])} lost events ${lostA.join()}`);
	for (const r of [a, b, c, d, e]) r.leave();
}

// ---------------------------------------------------------------------------
console.log("\na split party, by election: one grant per member per vacancy");

const crowns = (rooms) => rooms.filter((r) => r.isHost()).map((r) => r.self().name).join(",");
const E = { heirWaitMs: 300, lostRetryMs: [] };

{
	// The host leaves; the first heir is frozen. Everyone else reached
	// everyone (and said "here") — then the guests split {Bo, Cy} | {Dee, Eve}
	// during the heir's wait. Counting "here", each half counted the other
	// and both crowned. With grants, each member backs one candidate.
	const [h, a, b, c, d, e] = await party(["Host", "Ana", "Bo", "Cy", "Dee", "Eve"], fullMesh(6), E);
	a.__frozen = true;
	h.leave();
	await sleep(60);
	for (const [x, y] of [[b, d], [b, e], [c, d], [c, e]]) cut(x, y);
	await sleep(DEPARTURE + 4000);
	const w = crowns([b, c, d, e]);
	check("a frozen heir, then a 2–2 split: never two crowns", w.split(",").filter(Boolean).length <= 1, w);
	for (const r of [a, b, c, d, e]) r.leave();
}

{
	// The host holds a room-server seat; Ana reaches it only through Xan.
	// Bo, Cy and Xan conclude it gone, then the guests split {Ana, Xan} |
	// {Bo, Cy} before Ana's own probe ends.
	const top = fullMesh(5).filter(([i, j]) => !(i === 0 && j === 1));
	const [h, a, b, c, x] = await party(["Host", "Ana", "Bo", "Cy", "Xan"], top, E);
	h.party.members[0].rs = true;
	h._commitParty();
	await sleep(30);
	h.__frozen = true;
	h.detach();
	for (const r of [b, c, x]) {
		const l = r.links.get(h.selfId);
		if (l) r._linkClosed(l);
	}
	await sleep(2650);
	for (const [p, q] of [[a, b], [a, c], [x, b], [x, c]]) cut(p, q);
	await sleep(6000);
	const w = crowns([a, x, b, c]);
	check("a held host behind a relay, then a 2–2 split: never two crowns", w.split(",").filter(Boolean).length <= 1, w);
	for (const r of [a, b, c, x]) r.leave();
}

{
	// Everyone lost (the heir frozen, the rest apart); then Bo and Cy relink.
	// Stale "here"s made three crowns once. Two of four is no majority, and
	// the first heir is not among them: nobody crowns.
	const [h, a, b, c, d] = await party(["Host", "Ana", "Bo", "Cy", "Dee"], fullMesh(5), E);
	a.__frozen = true;
	h.leave();
	await sleep(60);
	for (const [x, y] of [[b, c], [b, d], [c, d]]) cut(x, y);
	await sleep(4000);
	const before = crowns([b, c, d]);
	connect(b, c);
	b._linkOpened(b.links.get(c.selfId));
	c._linkOpened(c.links.get(b.selfId));
	await sleep(1500);
	const after = crowns([b, c, d]);
	check("lost phones apart, then two relink: no crown without a majority", !before && !after, `before=${before} after=${after}`);
	for (const r of [a, b, c, d]) r.leave();
}

{
	// Reload mid-vote: Vic grants Bo, then reloads; its fresh page has no
	// record, so no vote — it cannot grant Cy as well.
	const [h, a, b, c, v] = await party(["Host", "Ana", "Bo", "Cy", "Vic"], fullMesh(5), { heirWaitMs: 2000, lostRetryMs: [] });
	a.__frozen = true;
	cut(b, c); // Bo and Cy cannot reach each other
	cut(c, v);
	h.leave();
	await sleep(2300); // Ana's wait: Bo stands, Vic grants him
	const grantedBo = [...(v.granted?.values() ?? [])].some((g) => g.n === b.selfId);
	const v2 = await bare({ name: "Vic", identity: v.identity, heirWaitMs: 2000, lostRetryMs: [] }, false);
	v.detach();
	const [toV, toC] = linkPair(c, v2);
	toV.introducedName = "Vic";
	toC.introducedName = "Cy";
	c._linkOpened(toV);
	v2._linkOpened(toC);
	await sleep(2500); // Cy stands in its turn, on its own side
	check("a member that granted, then reloaded, has no second vote", grantedBo && v2.granted?.size === 0 && !(c.candidacy?.grants.has(v.selfId)), `grantedBo=${grantedBo} v2=${v2.granted?.size}`);
	check("…and never two crowns", crowns([b, c, v2]).split(",").filter(Boolean).length <= 1, crowns([b, c, v2]));
	for (const r of [a, b, c, v2]) r.leave();
}

{
	// Still healing: the frozen heir passed over by a majority (above:
	// "a silent heir…"), the reloaded heir's party (above), and an heir
	// reached only through a relay crowning at once (above). Here, the
	// plain case: the host leaves a healthy party, and the heir is elected
	// at once by everyone.
	const [h, a, b, c] = await party(["Host", "Ana", "Bo", "Cy"], fullMesh(4), E);
	h.leave();
	await sleep(100);
	check("a healthy party elects its heir at once", crowns([a, b, c]) === "Ana" && [b, c].every((r) => r.hostId() === a.selfId), crowns([a, b, c]));
	for (const r of [a, b, c]) r.leave();
}

// ---------------------------------------------------------------------------
console.log("\na split party, election re-reviewed: keys, lapsing grants, retries, relays");

{
	// The host's last record (Ana now away) reaches Bo and Dee but not Ana
	// and Cy; then the host is gone and the guests split {Ana, Cy} | {Bo,
	// Dee}. The two keys differed only in the tie-break heir, and each half
	// won with exactly half plus its own. The tie-break is the oldest human
	// now, whatever `away` says: one key, one winner.
	const [h, a, b, c, d] = await party(["Host", "Ana", "Bo", "Cy", "Dee"], fullMesh(5), E);
	h.links.get(a.selfId).closed = true;
	h.links.get(c.selfId).closed = true;
	h.party.members.find((m) => m.id === a.selfId).away = true;
	h._commitParty();
	await sleep(30);
	for (const [x, y] of [[a, b], [a, d], [c, b], [c, d]]) cut(x, y);
	h.__frozen = true;
	h.detach();
	for (const r of [a, b, c, d]) {
		const l = r.links.get(h.selfId);
		if (l) r._linkClosed(l);
	}
	await sleep(DEPARTURE + 2500);
	const w = crowns([a, b, c, d]);
	check("a record seen by one side only (away): never two crowns", w.split(",").filter(Boolean).length <= 1, w);
	for (const r of [a, b, c, d]) r.leave();
}

{
	// Ana, the first heir, asks for grants, then her tab dies before any
	// reaches her: no release ever comes. Every grant bound to her used to
	// mean total loss; grants lapse now, and the next in line is elected.
	const [h, a, b, c, d] = await party(["Host", "Ana", "Bo", "Cy", "Dee"], fullMesh(5), E);
	const send = a._route.bind(a); // where a message really leaves (signing queues _send)
	a._route = (env, from) => {
		send(env, from);
		if (env.__c) a.__frozen = true;
	};
	h.leave();
	await sleep(3000);
	check("a candidate that dies mid-vote: its grants lapse, the next in line is elected", crowns([b, c, d]) === "Bo" && [c, d].every((r) => r.hostId() === b.selfId && !r.lost), crowns([b, c, d]) || "none");
	for (const r of [a, b, c, d]) r.leave();
}

{
	// Cy still held the host's link when Ana asked, so it refused — and never
	// granted. Kept now, and granted the moment that link drops. Bo is frozen,
	// so Ana needs Cy's grant: she is elected well inside her wait.
	const [h, a, b, c] = await party(["Host", "Ana", "Bo", "Cy"], fullMesh(4), { heirWaitMs: 1000, lostRetryMs: [] });
	b.__frozen = true;
	h.__frozen = true;
	h.detach();
	// Ana concludes the host gone (as if her probe heard nobody); Cy's link
	// to it lingers a moment longer.
	const la = a.links.get(h.selfId);
	if (la) a._linkClosed(la);
	a._applyGone(h.selfId);
	await sleep(300);
	const lc = c.links.get(h.selfId);
	if (lc) c._linkClosed(lc);
	await sleep(250);
	check("a request refused while the host's link lingered is granted when it drops", crowns([a, c]) === "Ana", crowns([a, c]) || "none");
	for (const r of [a, b, c]) r.leave();
}

{
	// A grant that arrives after the candidate's window — by either clock —
	// is not counted: the voter may already have given it to someone else.
	const [h, a, b, c, d] = await party(["Host", "Ana", "Bo", "Cy", "Dee"], fullMesh(5), { heirWaitMs: 5000, lostRetryMs: [] });
	for (const r of [b, c, d]) r._asked = () => {}; // nobody answers by itself
	h.leave();
	await sleep(60);
	const cand = a.candidacy;
	const key = cand?.key;
	cand.wall -= 6000; // the wall clock says the window is over (a device asleep)
	a._granted(key, cand.round, b.selfId);
	a._granted(key, cand.round, c.selfId);
	check("a grant outside the candidate's window is not counted (wall clock)", !a.isHost() && cand.grants.size === 1, `${cand.grants.size}`);
	cand.wall += 6000;
	cand.at -= 6000; // and by the monotonic one
	a._granted(key, cand.round, b.selfId);
	a._granted(key, cand.round, d.selfId);
	check("…nor by the monotonic clock", !a.isHost() && cand.grants.size === 1, `${cand.grants.size}`);
	for (const r of [a, b, c, d]) r.leave();
}


// ---------------------------------------------------------------------------
console.log("\na split party, with a commit: acknowledged grants never lapse");

{
	// Ana gets every grant and crowns — but nothing she sends after her
	// request gets out. Her voters' grants lapsed and Bo won too: two crowns.
	// Now she must commit and hear a quorum acknowledge first; her commit
	// never leaves, so she never crowns, and Bo is elected once the grants
	// lapse.
	const [h, a, b, c, d] = await party(["Host", "Ana", "Bo", "Cy", "Dee"], fullMesh(5), E);
	const send = a._route.bind(a); // where a message really leaves (signing queues _send)
	a._route = (env, from) => {
		send(env, from);
		if (env.__c) a.__mute = true;
	};
	h.leave();
	await sleep(4000);
	const w = crowns([a, b, c, d]);
	check("a winner whose record never gets out: never two crowns", w.split(",").filter(Boolean).length <= 1, w);
	check("…and the party is not lost for it: the next in line is elected", w === "Bo" && [c, d].every((r) => r.hostId() === b.selfId), w);
	for (const r of [a, b, c, d]) r.leave();
}

{
	// Ana commits and her voters acknowledge, but she dies before their
	// acknowledgements reach her: they are bound to her for good, so nobody
	// else is elected (the narrow window a commit costs), and never two.
	const [h, a, b, c, d] = await party(["Host", "Ana", "Bo", "Cy", "Dee"], fullMesh(5), E);
	const send = a._route.bind(a); // where a message really leaves (signing queues _send)
	a._route = (env, from) => {
		send(env, from);
		if (env.__ck) {
			a.__mute = true;
			a.__frozen = true;
		}
	};
	h.leave();
	await sleep(3000);
	const w = crowns([a, b, c, d]);
	check("a candidate that dies after its commit: no crown, and its voters stay bound", !w && [b, c, d].every((r) => r.committed.get(r.voteKey) === a.selfId), `${w} ${[b, c, d].map((r) => r.committed.get(r.voteKey) === a.selfId).join()}`);
	for (const r of [a, b, c, d]) r.leave();
}

/** A half-dead link: `from`'s end still sends into it, and nothing arrives. */
const halfDead = (from, to) => {
	from.links.get(to.selfId).send = () => {};
};

{
	// Ana's link to Bo is half dead (nothing she sends him arrives), and Cy is
	// frozen: Ana needs Bo. Her request and commit reach him through Dee.
	const [h, a, b, c, d] = await party(["Host", "Ana", "Bo", "Cy", "Dee"], fullMesh(5), { heirWaitMs: 1000, lostRetryMs: [] });
	c.__frozen = true;
	d._asked = () => {}; // Dee carries messages but grants nobody
	halfDead(a, b);
	h.leave();
	await sleep(600);
	check("a half-dead link from the candidate: its request and commit still arrive (flooded)", crowns([a, b, d]) === "Ana" && b.committed.get(b.voteKey) === a.selfId, crowns([a, b, d]) || "none");
	for (const r of [a, b, c, d]) r.leave();
}

{
	// Bo's link to Ana is half dead: his grant and acknowledgement still
	// reach her through Dee.
	const [h, a, b, c, d] = await party(["Host", "Ana", "Bo", "Cy", "Dee"], fullMesh(5), { heirWaitMs: 1000, lostRetryMs: [] });
	c.__frozen = true;
	d._asked = () => {};
	halfDead(b, a);
	h.leave();
	await sleep(600);
	check("a half-dead link to the candidate: grants and acknowledgements still arrive (flooded)", crowns([a, b, d]) === "Ana", crowns([a, b, d]) || "none");
	for (const r of [a, b, c, d]) r.leave();
}

{
	// Ana stands without a quorum (Cy and Eve frozen, Dee still holding the
	// host's link: two of five) and releases; her link to Bo is half dead.
	// Bo is freed by the release, through Dee, well before his grant would
	// lapse.
	const [h, a, b, c, d, e] = await party(["Host", "Ana", "Bo", "Cy", "Dee", "Eve"], fullMesh(6), { heirWaitMs: 1000, lostRetryMs: [] });
	c.__frozen = true;
	e.__frozen = true;
	halfDead(a, b);
	h.__frozen = true;
	h.detach();
	for (const r of [a, b]) {
		const l = r.links.get(h.selfId);
		if (l) r._linkClosed(l);
	}
	a._applyGone(h.selfId);
	b._applyGone(h.selfId);
	await sleep(300);
	const held = b.granted.get(b.voteKey)?.n === a.selfId;
	await sleep(1100); // Ana's window ends at 1 s: she releases
	check("a half-dead link from the candidate: its release still frees the voter", held && !a.isHost() && b.granted.get(b.voteKey)?.n !== a.selfId, `held=${held} now=${b.granted.get(b.voteKey)?.n === a.selfId} anaHost=${a.isHost()}`);
	for (const r of [a, b, c, d, e]) r.leave();
}

{
	// Ana and Bo are away on the record, so Cy is named. Cy commits and Ana,
	// Bo and Dee acknowledge — but Cy hears nothing back (its downlink dies
	// as it commits) and gives up. Everyone is lost, sworn to Cy. Then Cy
	// hears again and links come back. Ranked by age, Ana (sworn to Cy) was
	// first and could not stand, Cy never ranked first, and nobody ever
	// crowned. Now Cy stands because others are sworn to it, and the sworn
	// are left out of the ranking.
	const [h, a, b, c, d] = await party(["Host", "Ana", "Bo", "Cy", "Dee"], fullMesh(5), E);
	for (const r of [a, b]) h.party.members.find((m) => m.id === r.selfId).away = true;
	h._commitParty();
	await sleep(30);
	const send = c._route.bind(c); // where a message really leaves (signing queues _send)
	let once = false;
	c._route = (env, from) => {
		send(env, from);
		if (env.__ck && !once) {
			once = true;
			c.__deaf = true;
		}
	};
	h.leave();
	await sleep(3000);
	const swornToCy = [a, b, d].every((r) => r.committed.get(r.voteKey) === c.selfId);
	c.__deaf = false;
	for (const [x, y] of [[c, d], [a, b]]) {
		cut(x, y);
		await sleep(20);
		connect(x, y);
		x._linkOpened(x.links.get(y.selfId));
		y._linkOpened(y.links.get(x.selfId));
	}
	await sleep(3000);
	check("sworn to a candidate that gave up: once it hears again, it stands and is crowned", swornToCy && crowns([a, b, c, d]) === "Cy", `sworn=${swornToCy} crowns=${crowns([a, b, c, d]) || "none"}`);
	for (const r of [a, b, c, d]) r.leave();
}

// ---------------------------------------------------------------------------
console.log("\nbot seats and a member's own record");

{
	// Host, Ana, Bo, Cy: Ana is linked to everyone; Bo reaches the host only
	// through Ana; Cy has a direct link to the host. The host seats a bot.
	const [host, ana, bo, cy] = await party(["Host", "Ana", "Bo", "Cy"], [
		[0, 1],
		[1, 2],
		[0, 3],
		[1, 3],
	]);
	const bot = host.addBot("B");
	await sleep(30);
	const rec = (r, id) => r.getMember(id) ?? {};

	// setBotMeta (the quick table's PERSON seat): host only, bots only, never a field the record owns.
	host.setBotMeta(bot, { local: true, team: "spectator", bot: false, name: "X", host: "zz" });
	await sleep(30);
	check("setBotMeta: the host marks its bot local, and the mark replicates", rec(host, bot).local === true && rec(ana, bot).local === true);
	check("…never the fields the record owns (team, bot, name, host)", rec(host, bot).team === "B" && rec(host, bot).bot === true && rec(host, bot).name !== "X" && host.party.host === host.selfId, JSON.stringify(rec(host, bot)));
	host.setBotMeta(ana.selfId, { local: true });
	ana.setBotMeta(bot, { local: false });
	await sleep(30);
	check("…not on a person's record, and not from a guest", rec(host, ana.selfId).local === undefined && rec(host, bot).local === true);

	// A guest's own edits: its name and meta, nothing the record owns.
	ana.setName("Anaïs");
	ana.setMeta({ key: "k1" });
	await sleep(30);
	check("a member still edits its own name and meta", rec(host, ana.selfId).name === "Anaïs" && rec(host, ana.selfId).key === "k1");
	check("…and one heard only through a relay still does (Bo, via Ana)", (bo.setName("Boz"), await sleep(40), rec(host, bo.selfId).name === "Boz"));

	// A modified guest writing its own __i by hand: self, another member, a bot.
	const forge = (patch, f = ana.selfId) => ana._send({ __i: patch, f, t: host.selfId }, null);
	forge({ id: ana.selfId, team: "spectator", bot: true, host: ana.selfId, joined: 0, local: true });
	forge({ id: bot, local: false, team: "A" }, bot);
	forge({ id: host.selfId, name: "Pwned", team: "spectator" }, host.selfId);
	await sleep(40);
	check("__i: a member cannot write the fields its record owns (team, bot, host, joined) or local", rec(host, ana.selfId).team === "B" && !rec(host, ana.selfId).bot && rec(host, ana.selfId).joined > 0 && rec(host, ana.selfId).local === undefined && host.party.host === host.selfId, JSON.stringify(rec(host, ana.selfId)));
	check("__i: nobody edits a bot by message, whatever the sender claims", rec(host, bot).local === true && rec(host, bot).team === "B", JSON.stringify(rec(host, bot)));
	forge({ id: cy.selfId, name: "Cyborg", key: "fake" }, cy.selfId);
	await sleep(40);
	check("__i: a member cannot pose as the host, or as one the host hears directly", rec(host, host.selfId).name === "Host" && rec(host, host.selfId).team === "A" && rec(host, cy.selfId).name === "Cy" && rec(host, cy.selfId).key === undefined, JSON.stringify([rec(host, host.selfId), rec(host, cy.selfId)]));
	cy.setName("Cyd");
	await sleep(40);
	check("…while that member's own edit, over its link, still lands", rec(host, cy.selfId).name === "Cyd");
	// Ana claiming to be Bo, whom the host hears only through Ana: the gap
	// unsigned ids left (a relay renaming, or swapping secrets.js's key),
	// closed by signatures (2026-11-18).
	forge({ id: bo.selfId, name: "Bob?" }, bo.selfId);
	await sleep(40);
	check("a relay cannot rename a member the host has no direct link to", rec(host, bo.selfId).name === "Boz" && rec(host, bo.selfId).team === "A", rec(host, bo.selfId).name);
	bo.setMeta({ pk: "bo-key" });
	await sleep(60);
	forge({ id: bo.selfId, pk: "ana-key" }, bo.selfId);
	await sleep(60);
	check("…nor swap its public key (secrets.js's pk)", rec(host, bo.selfId).pk === "bo-key" && rec(cy, bo.selfId).pk === "bo-key", JSON.stringify(rec(host, bo.selfId).pk));

	// A vouch about the host still lands (test-worker's handover): its link to
	// a member opened again, so the host's held seat is cleared.
	host.party.members.find((m) => m.id === host.selfId).reconnecting = Date.now();
	ana._send({ __i: { id: host.selfId, back: true, name: "Not me", team: "spectator" }, f: ana.selfId, t: host.selfId }, null);
	await sleep(40);
	check("a back vouch about the host still clears its held seat, and carries no edit", rec(host, host.selfId).reconnecting === undefined && rec(host, host.selfId).name === "Host" && rec(host, host.selfId).team === "A", JSON.stringify(rec(host, host.selfId)));
	for (const r of [host, ana, bo, cy]) r.leave();
}


// ---------------------------------------------------------------------------
console.log("\nwho said it: signed party messages");

/** The data channel opened: the room's hello path (net.js _linkUp). */
const opened = (room, end) => room._linkUp(end);
/** A modified client writing whatever it likes straight onto its link. */
let rawSeq = 0;
const raw = (from, to, env) => from.links.get(to.selfId).send({ id: `raw${++rawSeq}`, h: 2, m: null, t: null, ...env });
/** Fresh identities, highest id first: the host can be made to sort last. */
const idsDescending = async (n) => {
	const all = [];
	for (let i = 0; i < n; i++) all.push(await NeonArcade.identity({ fresh: true }));
	return all.sort((x, y) => (x.id < y.id ? 1 : -1));
};

{
	// Forged `f`, on a direct link and through a relay. Host–Ana–Bo, no
	// host–Bo link: Ana is the relay between them.
	const [host, ana, bo] = await party(["Host", "Ana", "Bo"], [[0, 1], [1, 2]]);
	const heard = { host: [], bo: [] };
	host.makeAction("chat").onMessage = (d, { peerId }) => heard.host.push([d, peerId]);
	bo.makeAction("chat").onMessage = (d, { peerId }) => heard.bo.push([d, peerId]);
	raw(ana, host, { a: "chat", d: "as Bo", f: bo.selfId, t: host.selfId });
	await sleep(30);
	check("forged f on a direct link: Ana cannot speak as Bo", !heard.host.some(([d]) => d === "as Bo"), JSON.stringify(heard.host));
	raw(ana, bo, { a: "chat", d: "as Host", f: host.selfId });
	raw(ana, bo, { a: "chat", d: "as Host, signed by Ana", f: host.selfId, ...(ana._sign ? await ana._sign({ a: "chat", d: "x", f: host.selfId, t: null, id: "fake1" }) : {}) });
	await sleep(30);
	check("forged f relayed: Ana cannot pass off her words as the host's", !heard.bo.some(([d]) => String(d).startsWith("as Host")), JSON.stringify(heard.bo));
	host.makeAction("chat").send("hello Bo");
	await sleep(40);
	check("…while the host's own broadcast, relayed by Ana, still reaches Bo as the host's", heard.bo.some(([d, p]) => d === "hello Bo" && p === host.selfId), JSON.stringify(heard.bo));
	ana.makeAction("chat").send("from Ana", { target: host.selfId });
	await sleep(30);
	check("…and Ana's own words reach the host as hers", heard.host.some(([d, p]) => d === "from Ana" && p === ana.selfId));

	// A bot speaks only through the host that plays it.
	const bot = host.addBot("B");
	await sleep(30);
	heard.bo.length = 0;
	raw(ana, bo, { a: "chat", d: "bot by Ana", f: bot });
	raw(ana, bo, { a: "chat", d: "bot by Ana, o", f: bot, o: ana.selfId });
	raw(ana, host, { a: "chat", d: "bot to host", f: bot, t: host.selfId });
	await sleep(30);
	check("f = a bot from a guest is refused", !heard.bo.length && !heard.host.some(([d]) => String(d).startsWith("bot")), JSON.stringify([heard.bo, heard.host]));
	host.emitAs(bot, "chat", "bot by host");
	await sleep(40);
	check("…while the host's own bot move, relayed, reaches Bo as the bot's", heard.bo.some(([d, p]) => d === "bot by host" && p === bot), JSON.stringify(heard.bo));

	// A managed game's action and input (sdk-managed `v:m$act`/`v:m$in`)
	// are an ordinary channel's: f is the seat.
	const acts = [];
	host.makeAction("v:m$act").onMessage = (d, { peerId }) => acts.push(peerId);
	raw(ana, host, { a: "v:m$act", d: { a: { move: 1 } }, f: bo.selfId, t: host.selfId });
	raw(ana, host, { a: "v:m$act", d: { a: { move: 1 } }, f: bot, t: host.selfId });
	await sleep(30);
	check("a managed act as another seat (a person's or a bot's) is refused", !acts.length, acts.join());
	for (const r of [host, ana, bo]) r.leave();
}

{
	// Control messages only the host may send, from a member who signs
	// them honestly as herself.
	const [host, ana, bo] = await party(["Host", "Ana", "Bo"], fullMesh(3));
	ana._send({ __k: bo.selfId, f: ana.selfId, t: null }, null);
	await sleep(40);
	check("__k from a non-host does not evict", !bo.closed && !!host.getMember(bo.selfId) && !!bo.getMember(bo.selfId), `closed=${bo.closed}`);
	ana._send({ __x: 1, f: ana.selfId, t: null }, null);
	await sleep(40);
	check("__x from a non-host does not close the party", !bo.closed && !host.closed);
	host.removeMember(bo.selfId);
	await sleep(40);
	check("…the host's own __k still evicts", bo.closed === true && !ana.getMember(bo.selfId));
	for (const r of [host, ana]) r.leave();
}

{
	// A member crowning itself by record: at a higher term with no proof
	// of the crown, and at the same term (it sorts first).
	const ids = await idsDescending(4);
	const [host, ana, bo, cy] = await party(["Host", "Ana", "Bo", "Cy"], fullMesh(4), { ids });
	const forger = cy; // the lowest id
	forger._send({ __p: { ...structuredClone(forger.party), host: forger.selfId, term: forger.party.term + 5 }, f: forger.selfId, t: null }, null);
	await sleep(40);
	check("a forged __p at a higher term, no proof of the crown: ignored", [host, ana, bo].every((r) => r.hostId() === host.selfId), [host, ana, bo].map((r) => r.hostId() === host.selfId).join());
	forger.party = structuredClone(host.party); // back in line
	forger._send({ __p: { ...structuredClone(forger.party), host: forger.selfId }, f: forger.selfId, t: null }, null);
	await sleep(40);
	check("a forged __p at the same term, from a non-host that sorts first: ignored", [host, ana, bo].every((r) => r.hostId() === host.selfId), [host, ana, bo].map((r) => r.hostId() === host.selfId).join());
	for (const r of [host, ana, bo, cy]) r.leave();
}

{
	// A signed record can be sent again by anybody: an old one of the
	// host's, replayed once its id has left everyone's memory, must not roll
	// the party back.
	const [host, ana, bo] = await party(["Host", "Ana", "Bo"], fullMesh(3));
	const old = structuredClone(wire.filter((w) => w.from === host.selfId && w.env.__p).at(-1).env);
	host.setName("Hosty");
	await sleep(40);
	bo.seen.clear(); // as if SEEN_MAX newer messages had gone by
	raw(ana, bo, { ...old });
	await sleep(40);
	check("a replayed old host record does not roll the party back", bo.getMember(host.selfId)?.name === "Hosty", bo.getMember(host.selfId)?.name);
	for (const r of [host, ana, bo]) r.leave();
}

{
	// Election certificates, built by hand from members' real signatures and
	// the host's real records. Dee checks each crown at term 1 against the
	// records of term 0 she took: the key is rebuilt from the record a
	// certificate carries (`rec`), never taken from it.
	const [h, a, b, c, d] = await party(["Host", "Ana", "Bo", "Cy", "Dee"], fullMesh(5), { heirWaitMs: 60_000, lostRetryMs: [] });
	const { voteKeyOf, signedText } = NeonArcade._codec;
	const recOf = () => {
		const { h: _h, m: _m, ...env } = structuredClone(wire.filter((w) => w.from === h.selfId && w.env.__p).at(-1).env);
		return env;
	};
	const ack = async (voter, key, cand) => voter._sign({ __ka: key, r: 1, n: cand.selfId, f: voter.selfId, t: null, id: `ka${++rawSeq}` });
	const crownBy = async (cand, rec, voters, key = voteKeyOf(rec.__p.members, 0, h.selfId)) => {
		const acks = await Promise.all(voters.map((v) => ack(v, key, cand)));
		const env = { __p: { ...structuredClone(d.party), host: cand.selfId, term: 1, rev: Date.now() + ++rawSeq }, f: cand.selfId, t: null, id: `cp${++rawSeq}`, cp: { v: "vote", key, rec, acks } };
		await cand._sign(env);
		cand.links.get(d.selfId).send(env);
		await sleep(40);
	};
	const rec1 = recOf(); // Host, Ana, Bo, Cy, Dee
	// Made-up voters: a key naming ids nobody in the record holds.
	const strangers = await Promise.all([1, 2, 3].map(() => NeonArcade.identity({ fresh: true })));
	const fake = `${h.selfId}|0|${c.selfId}|${[c.selfId, ...strangers.map((x) => x.id)].sort().join(",")}`;
	const sRooms = strangers.map((identity) => ({ selfId: identity.id, _sign: async (env) => ({ ...env, pa: d.party.pid, k: identity.pub, s: await identity.sign(signedText({ ...env, pa: d.party.pid })) }) }));
	await crownBy(c, rec1, sRooms, fake);
	check("an election certificate whose key is not its record's is refused (made-up voters)", d.hostId() === h.selfId, d.refusals.slice(-2).join());
	// The host drops Bo: a second record of term 0. Two elections, one from
	// each record (a record that reached one side of a split only), each with
	// a real quorum of its own.
	h.removeMember(b.selfId);
	await sleep(60);
	const rec2 = recOf(); // Host, Ana, Cy, Dee
	const [lo, hi] = a.selfId < c.selfId ? [a, c] : [c, a];
	await crownBy(hi, rec2, [d]); // two of {Ana, Cy, Dee}
	const first = d.hostId() === hi.selfId && d.party.term === 1;
	await crownBy(lo, rec1, lo === a ? [b] : [b, d]); // a quorum of {Ana, Bo, Cy, Dee}
	check("a crown at term 1 is taken on its certificate", first, d.hostId());
	check("…and a second certified crown at that term is still checked (against term 0's records): the lower id wins", d.hostId() === lo.selfId, `${d.hostId() === hi.selfId ? "hi" : d.hostId() === lo.selfId ? "lo" : d.hostId()} ${d.refusals.slice(-2).join()}`);
	for (const r of [h, a, b, c, d]) r.leave();
}

{
	// A phone asleep through two changes of host takes the third holder's
	// record: its certificate carries the record it was won from, and that
	// record its own, back to the record the phone holds.
	const [h, a, b, c, d, e] = await party(["Host", "Ana", "Bo", "Cy", "Dee", "Eve"], fullMesh(6), E);
	e.__frozen = true;
	h.leave();
	await sleep(1500);
	const one = crowns([a, b, c, d]);
	const second = [a, b, c, d].find((r) => r.isHost());
	second?.leave();
	await sleep(1500);
	const rest = [a, b, c, d].filter((r) => r !== second);
	const third = rest.find((r) => r.isHost());
	e.__frozen = false;
	third?.setGame(null);
	await sleep(150);
	check("two crowns behind: a phone checks the chain back to its record and follows", !!third && third.party.term === 2 && e.hostId() === third.selfId && e.party.term === 2, `${one} → ${crowns(rest)}; eve sees term ${e.party.term} ${e.refusals.slice(-2).join()}`);
	for (const r of [...rest, e]) r.leave();
}

{
	// A newer record we cannot check is said, not followed in silence.
	const [h, a, b] = await party(["Host", "Ana", "Bo"], fullMesh(3));
	const said = [];
	b.onError = (msg, info) => said.push(info?.reason);
	a._send({ __p: { ...structuredClone(a.party), host: a.selfId, term: 7, rev: Date.now() + 9 }, f: a.selfId, t: null }, null);
	a._send({ __p: { ...structuredClone(a.party), host: a.selfId, term: 8, rev: Date.now() + 10 }, f: a.selfId, t: null }, null);
	await sleep(60);
	check("a newer crown that cannot be checked: not followed, and said once (reload to rejoin)", b.hostId() === h.selfId && said.join() === "behind", said.join());
	for (const r of [h, a, b]) r.leave();
}

{
	// A fresh page trusts its first record — but one its deliverer wrote
	// about itself only from the member its invite named.
	const [h, mal] = await party(["Host", "Mal"], fullMesh(2));
	const g = await bare({ name: "New" }, false);
	const [toG, toMal] = linkPair(mal, g);
	toMal.named = false; // a link the newcomer did not ask for
	mal.links.set(g.selfId, toG);
	g.links.set(mal.selfId, toMal);
	mal._send({ __p: { ...structuredClone(mal.party), host: mal.selfId, term: 99, rev: Date.now() + 11 }, f: mal.selfId, t: g.selfId }, null);
	await sleep(40);
	check("a first record its deliverer wrote about itself, on a link nobody named: refused", g.hostId() === null && g.refusals.includes("a first record its deliverer wrote"), `${g.hostId()} ${g.refusals}`);
	const [toG2, toH] = linkPair(h, g);
	h.links.set(g.selfId, toG2);
	g.links.set(h.selfId, toH);
	h._commitParty();
	await sleep(40);
	check("…while the named member's own is taken", g.hostId() === h.selfId);
	for (const r of [h, mal, g]) r.leave();
}

{
	// Forged election messages, written by Cy as other members.
	const [h, a, b, c, d] = await party(["Host", "Ana", "Bo", "Cy", "Dee"], fullMesh(5), { heirWaitMs: 5000, lostRetryMs: [] });
	const key = d._voteKey("nobodynobodynobo"); // a vacancy nobody holds a link to
	raw(c, d, { __c: key, r: 1, f: b.selfId });
	await sleep(30);
	check("a forged __c (Bo standing, written by Cy) binds no grant", d.granted.get(key)?.n !== b.selfId, JSON.stringify(d.granted.get(key)));
	a._send({ __c: key, r: 1, f: a.selfId, t: null }, null); // Ana really stands
	await sleep(30);
	const toAna = d.granted.get(key)?.n === a.selfId;
	raw(c, d, { __r: key, r: 1, f: a.selfId });
	await sleep(30);
	check("a forged __r (Ana's release, written by Cy) frees no grant", toAna && d.granted.get(key)?.n === a.selfId, `granted=${toAna} now=${d.granted.get(key)?.n}`);
	raw(c, d, { __ck: key, r: 1, f: a.selfId });
	await sleep(30);
	check("a forged __ck (Ana's commit, written by Cy) binds nobody for good", toAna && !d.committed.has(key), `granted=${toAna} committed=${d.committed.get(key)}`);
	for (const r of [h, a, b, c, d]) r.leave();
}

{
	// Cy forges Bo's and Dee's grants and acknowledgements for Ana. Bo and
	// Dee are frozen and Cy grants nobody: Ana alone is no quorum.
	const [h, a, b, c, d] = await party(["Host", "Ana", "Bo", "Cy", "Dee"], fullMesh(5), { heirWaitMs: 1500, lostRetryMs: [] });
	b.__frozen = true;
	d.__frozen = true;
	c._asked = () => {};
	c._commitAsked = () => {};
	h.leave();
	await sleep(100);
	const key = a.candidacy?.key;
	for (const who of [b, d]) raw(c, a, { __gr: key, r: a.candidacy?.round, n: a.selfId, f: who.selfId });
	await sleep(40);
	for (const who of [b, d]) raw(c, a, { __ka: key, r: a.candidacy?.round, n: a.selfId, f: who.selfId });
	await sleep(40);
	check("forged __gr and __ka (Bo's and Dee's, written by Cy) crown nobody", !!key && !a.isHost(), `key=${!!key} anaHost=${a.isHost()}`);
	for (const r of [a, b, c, d]) r.leave();
}

{
	// A relayed offer whose f is the victim: whoever answers it must not
	// end up with Mallory's connection registered as the victim's.
	const [host, vic, mal] = await party(["Host", "Vic", "Mal"], fullMesh(3));
	const target = await bare({ name: "Tess" }, false);
	const [toTarget, toMal] = linkPair(mal, target, { hello: true });
	toMal.peerId = vic.selfId; // what the forged offer's f said
	opened(target, toMal);
	opened(mal, toTarget);
	await sleep(60);
	check("a link whose far end cannot sign as the claimed id is never registered (relayed-offer hijack)", target.links.get(vic.selfId) !== toMal && toMal.closed === true, `registered=${target.links.get(vic.selfId) === toMal} closed=${toMal.closed}`);
	const [toT2, toV2] = linkPair(vic, target, { hello: true });
	opened(target, toV2);
	opened(vic, toT2);
	await sleep(60);
	check("…while the real one proves itself and is", target.links.get(vic.selfId) === toV2, `${target.links.get(vic.selfId) === toV2}`);
	for (const r of [host, vic, mal, target]) r.leave();
}

{
	// An old (unsigned) client: it never says hello, and talks at once.
	const host = await bare({ name: "Host" });
	const errors = [];
	host.onError = (msg, info) => errors.push([msg, info?.reason]);
	const oldGot = [];
	const old = { selfId: "oldclient1", _inbound: (_l, msg) => oldGot.push(msg) };
	const [toOld, fromOld] = linkPair(host, old, { hello: true });
	toOld.introducedName = "Grandpa";
	opened(host, toOld);
	fromOld.send({ __alive: host.selfId, f: "oldclient1", t: null, id: "o1", h: 2 });
	await sleep(60);
	check("an old client is refused: not seated", !host.getMember("oldclient1") && !host.links.has("oldclient1"));
	check("…the new side is told who and why", errors.some(([m, r]) => /Grandpa/.test(m) && /older version/.test(m) && r === "outdated"), JSON.stringify(errors));
	check("…and the old side is told in words it knows (an unsigned __k naming it)", oldGot.some((m) => m.__k === "oldclient1"), JSON.stringify(oldGot));
	host.leave();

	// Invites and replies from old clients fail at once, clearly.
	const sdp = ["v=0", "a=ice-ufrag:abcd", "a=ice-pwd:abcdefghijklmnopqrstuv", "a=fingerprint:sha-256 AA:BB", "a=setup:actpass", "a=candidate:1 1 udp 1 1.2.3.4 5 typ host", ""].join("\r\n");
	const oldCode = await NeonArcade._codec.packSignal({ s: "slot", i: "oldclient1", n: "Grandpa" }, sdp);
	const g = await bare({ name: "G" }, false);
	const why = async (p) => p.then(() => "accepted", (e) => `${e.reason}: ${e.message}`);
	const asInvite = await why(g.answerInvite(oldCode));
	const asReply = await why(g.acceptAnswer(oldCode));
	check("an invite from an old client fails with a clear message", /^outdated: .*older version/.test(asInvite), asInvite);
	check("a reply from an old client fails with a clear message", /^outdated: .*older version/.test(asReply), asReply);
	g.leave();
}


// ---------------------------------------------------------------------------
console.log("\nwho said it, reviewed: certificates, replays, strangers");
// The reviewer's proofs of concept (2026-11-19), each as the check that the
// hole is closed.

{
	// POC1: Cy writes its own certificate — a vote key naming only itself —
	// while the host is alive. Nobody may take it.
	const [h, a, b, c, d] = await party(["Host", "Ana", "Bo", "Cy", "Dee"], fullMesh(5), { heirWaitMs: 60_000, lostRetryMs: [] });
	const key = `${h.selfId}|0|${c.selfId}|${c.selfId}`;
	const rec = structuredClone(wire.filter((w) => w.from === h.selfId && w.env.__p).at(-1).env);
	c._send({ __p: { ...structuredClone(c.party), host: c.selfId, term: 1, rev: Date.now() + 5 }, f: c.selfId, t: null, cp: { v: "vote", key, acks: [] } }, null);
	c._send({ __p: { ...structuredClone(c.party), host: c.selfId, term: 1, rev: Date.now() + 6 }, f: c.selfId, t: null, cp: { v: "vote", key, rec, acks: [] } }, null);
	await sleep(80);
	check("POC1: a member's self-written certificate crowns nobody (host alive)", [h, a, b, d].every((r) => r.hostId() === h.selfId), [h, a, b, d].map((r) => r.hostId() === h.selfId).join());
	for (const r of [h, a, b, c, d]) r.leave();
}

{
	// POC2: the host's old __k, replayed once Bo is back in the party (and
	// the seen window has long rolled over), must not evict Bo again.
	const [host, ana, bo] = await party(["Host", "Ana", "Bo"], fullMesh(3));
	host.removeMember(bo.selfId);
	await sleep(60);
	const kick = structuredClone(wire.filter((w) => w.from === host.selfId && w.env.__k).at(-1).env);
	await sleep(5);
	const bo2 = await bare({ name: "Bo", identity: bo.identity }, false);
	connect(host, bo2);
	connect(ana, bo2);
	host._addMember(bo2.selfId, "Bo");
	host._commitParty();
	await sleep(60);
	for (const r of [host, ana, bo2]) {
		r.seen.clear();
		r.seenQueue.length = 0;
	}
	ana.links.get(bo2.selfId).send(kick);
	await sleep(60);
	check("POC2: an old __k replayed after Bo rejoined does not evict Bo", bo2.closed === false && !!ana.getMember(bo2.selfId), `closed=${bo2.closed}`);
	for (const r of [host, ana, bo2]) r.leave();
}

{
	// The same for a member's own old goodbye, replayed once it is back.
	const [host, ana, bo] = await party(["Host", "Ana", "Bo"], fullMesh(3));
	bo.leave();
	await sleep(40);
	const bye = structuredClone(wire.filter((w) => w.from === bo.selfId && w.env.__gone).at(-1).env);
	await sleep(5);
	const bo3 = await bare({ name: "Bo", identity: bo.identity }, false);
	connect(host, bo3);
	connect(ana, bo3);
	host._addMember(bo3.selfId, "Bo");
	host._commitParty();
	await sleep(60);
	for (const r of [host, ana]) {
		r.seen.clear();
		r.seenQueue.length = 0;
	}
	ana.links.get(host.selfId).send(bye);
	await sleep(60);
	check("POC2: nor does a member's own old goodbye, replayed once it is back", !!host.getMember(bo3.selfId), "dropped");
	for (const r of [host, ana, bo3]) r.leave();
}

{
	// POC3: a host's __x from an earlier party, replayed into a new party the
	// same tab founded, must not close it.
	const hid = await NeonArcade.identity({ fresh: true });
	const [host, ana, bo] = await party(["Host", "Ana", "Bo"], fullMesh(3), { ids: [hid] });
	host._send({ __x: 1, f: host.selfId, t: null }, null);
	await sleep(60);
	const x = structuredClone(wire.filter((w) => w.from === host.selfId && w.env.__x).at(-1).env);
	for (const r of [host, ana, bo]) r.leave();
	await sleep(20);
	const [host2, ana2, cy2] = await party(["Host", "Ana", "Cy"], fullMesh(3), { ids: [hid, ana.identity] });
	ana2.links.get(cy2.selfId).send(x);
	ana2.links.get(host2.selfId).send(x);
	await sleep(60);
	check("POC3: an old party's __x does not close a new party", !cy2.closed && !host2.closed, `cy=${cy2.closed} host=${host2.closed}`);
	for (const r of [host2, ana2, cy2]) r.leave();
}

{
	// POC4: a real election certificate from one party, replayed into
	// another party the same tabs are in, must not crown its holder there.
	const [h, a, b, c] = await party(["Host", "Ana", "Bo", "Cy"], fullMesh(4), { heirWaitMs: 300, lostRetryMs: [] });
	h.leave();
	await sleep(2500);
	const nh = [a, b, c].find((r) => r.isHost());
	const rec = nh && structuredClone(wire.filter((w) => w.from === nh.selfId && w.env.__p && w.env.cp?.v === "vote").at(-1)?.env);
	for (const r of [a, b, c]) r.leave();
	await sleep(20);
	const F = await NeonArcade.identity({ fresh: true });
	const rooms = await party(["F", "Ana", "Bo", "Cy"], fullMesh(4), { ids: [F, a.identity, b.identity, c.identity] });
	const mal = rooms.find((r) => r.selfId !== nh?.selfId && r.selfId !== F.id);
	if (rec) for (const r of rooms) if (r !== mal) mal.links.get(r.selfId).send(structuredClone(rec));
	await sleep(100);
	check("POC4: a certificate from another party crowns nobody here", !!rec && rooms.every((r) => r.hostId() === F.id), `${!!rec} ${rooms.map((r) => r.hostId() === F.id).join()}`);
	for (const r of rooms) r.leave();
}

{
	// POC5: a member sends its own message under the id the host's will
	// carry; the host's must still be heard.
	const [host, ana, bo] = await party(["Host", "Ana", "Bo"], fullMesh(3));
	const got = [];
	bo.makeAction("chat").onMessage = (d, { peerId }) => got.push([d, peerId]);
	ana.links.get(bo.selfId).send({ a: "chat", d: "ana junk", f: ana.selfId, t: null, id: "victimid", h: 2, m: null });
	await sleep(20);
	host.links.get(bo.selfId).send({ a: "chat", d: "host real", f: host.selfId, t: null, id: "victimid", h: 2, m: null });
	await sleep(30);
	check("POC5: a member cannot pre-empt another's message by its id", got.some(([d]) => d === "host real"), JSON.stringify(got));
	for (const r of [host, ana, bo]) r.leave();
}

{
	// POC6: a signed message from an id that is not in the party, carried
	// in by a member, must not reach the game.
	const [host, ana] = await party(["Host", "Ana"], fullMesh(2));
	const st = await NeonArcade.identity({ fresh: true });
	const got = [];
	host.makeAction("chat").onMessage = (d, { peerId }) => got.push(peerId);
	const env = { a: "chat", d: "hi", f: st.id, t: host.selfId, id: "syb1", h: 2, p: host.party.pid };
	env.k = st.pub;
	env.s = await st.sign(NeonArcade._codec.signedText(env));
	ana.links.get(host.selfId).send(env);
	await sleep(40);
	check("POC6: a stranger's signed game message is refused", !got.includes(st.id), got.join());
	for (const r of [host, ana]) r.leave();
}

console.log(failures ? `\n${failures} failing\n` : "\nall passing\n");
process.exit(failures ? 1 : 0);
