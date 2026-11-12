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

/**
 * A fake link pair, not yet registered with either room — hand each end to
 * `_linkOpened` to exercise the real "a connection just opened" path. A closed
 * end stops carrying anything, as a real channel would.
 */
function linkPair(a, b) {
	const end = (self, other, peer) => ({
		peerId: other.selfId,
		closed: false,
		send(env) {
			if (this.closed) return;
			const copy = structuredClone(env);
			wire.push({ from: self.selfId, to: other.selfId, env: copy });
			setTimeout(() => other._inbound(peer(), copy), 1);
		},
		close() {
			this.closed = true;
		},
	});
	const linkA = end(a, b, () => linkB);
	const linkB = end(b, a, () => linkA);
	return [linkA, linkB];
}

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
	const rooms = names.map((name, i) =>
		i === 0 ? NeonArcade.createHost({ ...opts, name }) : NeonArcade.createGuest({ ...opts, name }),
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
const bare = (opts, host = true) => {
	const r = host ? NeonArcade.createHost(opts) : NeonArcade.createGuest(opts);
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
	// Two hosts at the same term — a partition that crowned on both sides —
	// settle on the lower id, and the one stepping down is not lost from it.
	const a = bare({ name: "A" });
	const b = bare({ name: "B" });
	connect(a, b);
	a._commitParty();
	b._commitParty();
	await sleep(40);
	const [low, high] = a.selfId < b.selfId ? [a, b] : [b, a];
	check("two hosts at one term agree on one crown", a.hostId() === b.hostId());
	check("the lower id keeps it", low.isHost() && !high.isHost(), `host=${a.hostId()}`);
	check("the host that stepped down keeps its seat", ids(a) === ids(b) && a.getMembers().length === 2, `${ids(a)} / ${ids(b)}`);
	a.leave();
	b.leave();
}

{
	// A higher term wins whatever the ids, and the host that loses carries the
	// members only it can reach into the winning record.
	const c = bare({ name: "C" });
	const d = bare({ name: "D" });
	const e = bare({ name: "E" }, false);
	connect(c, e);
	c._addMember(e.selfId, "E");
	c._commitParty();
	await sleep(20);
	connect(c, d);
	d.party.term = 3;
	d._commitParty();
	c._commitParty();
	await sleep(60);
	check("the higher term takes the crown", c.hostId() === d.selfId && d.isHost(), `c sees ${c.hostId()}`);
	check("the old host stepped down", !c.isHost());
	check("its members followed it into the winning record", ids(d) === [c.selfId, d.selfId, e.selfId].sort().join(","), ids(d));
	check("and they hear the new host", e.hostId() === d.selfId, `e sees ${e.hostId()}`);
	for (const r of [c, d, e]) r.leave();
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
	const host = bare({ name: "Host" });
	const guest = bare({ name: "Newbie" }, false);
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
	check("heir() is null with nobody to take it", bare({ name: "Solo" }).heir() === null);

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
	check("the host's bots go with it", bo.bots().length === 0 && cy.bots().length === 0);

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
	const host = bare({ name: "Host", reconnectGraceMs: 60_000 });
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
	const room = NeonArcade.createHost({ name: "Host", selfId: "0000000000" });
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

console.log(failures ? `\n${failures} failing\n` : "\nall passing\n");
process.exit(failures ? 1 : 0);
