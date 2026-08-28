#!/usr/bin/env node
/**
 * test-battleship.mjs — the rules, the audit, and the bot, with no board drawn.
 *
 *   node scripts/test-battleship.mjs
 *
 * The claim this game rests on is not "the shots land in the right squares".
 * It is that **an unrefereed game can still be honest**: nobody holds anybody
 * else's fleet, each player answers for their own board, and a player who lies
 * about it is caught at the reveal. So the audit is tested against deliberate
 * cheats — a fleet that was moved, an answer that was flipped, a sinking that
 * never happened — because a commitment nobody can fail is not a commitment.
 */
import { readFileSync } from "node:fs";

globalThis.window = globalThis;
globalThis.location = { href: "file:///x", hash: "", pathname: "/x", search: "" };
globalThis.history = { replaceState() {} };
for (const f of ["../lib/net.js", "../lib/games.js", "../lib/secrets.js", "../games/battleship.js"]) {
	new Function(readFileSync(new URL(f, import.meta.url), "utf8"))();
}
const R = globalThis.NeonArcade.battleshipRules;
const { SIZE, FLEET, FLEET_CELLS, key, cellsOf, validateFleet, randomFleet, shipAt, answerShot, fleetSunk, auditAnswers, botTarget } = R;

let failures = 0;
const check = (label, ok, detail = "") => {
	console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
	if (!ok) failures++;
};

// A fleet written out, so the expectations below are readable.
const FIXED = [
	{ id: "carrier", r: 0, c: 0, dir: "h" }, // (0,0)..(0,3)
	{ id: "cruiser", r: 2, c: 2, dir: "v" }, // (2,2)..(4,2)
	{ id: "sub", r: 6, c: 4, dir: "h" }, //     (6,4)..(6,6)
	{ id: "patrol", r: 3, c: 7, dir: "v" }, //  (3,7)..(4,7)
];

// ---------------------------------------------------------------------------
console.log("\nfleets");

check("the fixed fleet is legal", validateFleet(FIXED) === null, validateFleet(FIXED) ?? "");
check("a ship covers its own length", cellsOf(FIXED[0]).length === 4);
check("horizontal runs along a row", cellsOf(FIXED[0]).every(([r]) => r === 0));
check("vertical runs down a column", cellsOf(FIXED[1]).every(([, c]) => c === 2));
check("the whole fleet is the expected size", FIXED.flatMap(cellsOf).length === FLEET_CELLS);

check("a ship hanging off the edge is refused",
	!!validateFleet(FIXED.map((s) => (s.id === "carrier" ? { ...s, c: 6 } : s))));
check("overlapping ships are refused",
	!!validateFleet(FIXED.map((s) => (s.id === "patrol" ? { ...s, r: 0, c: 0, dir: "h" } : s))));
check("a fleet missing a ship is refused", !!validateFleet(FIXED.slice(0, 3)));
check("a duplicated ship is refused", !!validateFleet([FIXED[0], FIXED[0], FIXED[2], FIXED[3]]));
check("a diagonal ship is refused",
	!!validateFleet(FIXED.map((s) => (s.id === "sub" ? { ...s, dir: "d" } : s))));

{
	let bad = 0;
	for (let i = 0; i < 400; i++) if (validateFleet(randomFleet())) bad++;
	check("four hundred random fleets are all legal", bad === 0, `${bad} bad`);
}

// ---------------------------------------------------------------------------
console.log("\nanswering a shot");

{
	check("open water is a miss", answerShot(FIXED, new Set(), 7, 0).hit === false);
	check("a ship is a hit", answerShot(FIXED, new Set(), 0, 1).hit === true);
	check("a hit that is not the last is not a sinking", answerShot(FIXED, new Set(), 0, 1).sunk === null);

	// Sink the patrol boat: two cells, so one prior hit and one more.
	const hits = new Set([key(3, 7)]);
	const last = answerShot(FIXED, hits, 4, 7);
	check("the last hit on a ship sinks it", last.hit && last.sunk === "patrol", JSON.stringify(last));
	check("answerShot does not mutate the hits it was given", hits.size === 1);

	// Sinking one ship must not sink a different one.
	const nearlyAll = new Set(FIXED.filter((s) => s.id !== "sub").flatMap(cellsOf).map(([r, c]) => key(r, c)));
	check("a full board minus one ship has not sunk that ship",
		answerShot(FIXED, nearlyAll, 6, 4).sunk === null);
	check("the fleet is not sunk while a ship survives", !fleetSunk(nearlyAll));
	const all = new Set(FIXED.flatMap(cellsOf).map(([r, c]) => key(r, c)));
	check("a fully hit fleet is sunk", fleetSunk(all));
}

// ---------------------------------------------------------------------------
console.log("\nthe audit — the whole point");

/** Answer a list of shots honestly. */
function honestAnswers(ships, targets) {
	const hits = new Set();
	return targets.map(([r, c]) => {
		const a = answerShot(ships, hits, r, c);
		if (a.hit) hits.add(key(r, c));
		return { at: [r, c], hit: a.hit, sunk: a.sunk };
	});
}

{
	const targets = [[0, 0], [0, 1], [7, 7], [2, 2], [3, 7], [4, 7], [5, 5]];
	const honest = honestAnswers(FIXED, targets);
	check("an honest game passes the audit", auditAnswers(FIXED, honest) === null, auditAnswers(FIXED, honest) ?? "");

	// Claiming a miss where a ship was — the classic dodge.
	const dodged = honest.map((a) => (a.at[0] === 0 && a.at[1] === 1 ? { ...a, hit: false, sunk: null } : a));
	check("calling a hit a miss is caught", !!auditAnswers(FIXED, dodged), "not caught");

	// Claiming a hit where there was nothing — conceding a square to look honest.
	const invented = honest.map((a) => (a.at[0] === 7 && a.at[1] === 7 ? { ...a, hit: true } : a));
	check("calling a miss a hit is caught", !!auditAnswers(FIXED, invented), "not caught");

	// Announcing a sinking that did not happen, to call the fleet off a ship.
	const faked = honest.map((a) => (a.at[0] === 2 && a.at[1] === 2 ? { ...a, sunk: "cruiser" } : a));
	check("a sinking that never happened is caught", !!auditAnswers(FIXED, faked), "not caught");

	// Suppressing a real sinking, to keep them shooting at a dead ship.
	const hidden = honest.map((a) => (a.sunk ? { ...a, sunk: null } : a));
	check("hiding a real sinking is caught", !!auditAnswers(FIXED, hidden), "not caught");

	// Revealing a *different* fleet than the one played. The digest catches this
	// too, but the audit must not need the digest's help.
	const moved = FIXED.map((s) => (s.id === "carrier" ? { ...s, r: 5 } : s));
	check("a fleet moved after the fact is caught", !!auditAnswers(moved, honest), "not caught");

	// An illegal fleet revealed at the end is its own cheat, and the digest
	// would happily verify it.
	const illegal = FIXED.map((s) => (s.id === "patrol" ? { ...s, r: 0, c: 0, dir: "h" } : s));
	check("an illegal revealed fleet is refused", !!auditAnswers(illegal, []), "not caught");
}

// ---------------------------------------------------------------------------
console.log("\ncommit and reveal, over the real helper");

{
	const room = { getMember: () => null, makeAction: () => ({ send() {} }), selfId: "me", isHost: () => true };
	const secrets = globalThis.NeonArcade.makeSecrets(room);
	await secrets.ready();

	const fleet = randomFleet();
	const c = await secrets.commit(fleet);
	check("a fleet commitment hides the placements",
		!JSON.stringify(c.digest).includes(String(fleet[0].r)) || c.digest.length === 44);
	check("an honest reveal verifies", await secrets.verify(c));
	// A fleet that has been through the network comes back as plain objects in
	// whatever key order the sender used, which is exactly the case the
	// canonical serialisation exists for.
	const roundTripped = JSON.parse(JSON.stringify(fleet)).map((s) => ({ dir: s.dir, c: s.c, r: s.r, id: s.id }));
	check("a fleet that went through JSON still verifies", await secrets.verify({ ...c, value: roundTripped }));
	const moved = fleet.map((s, i) => (i === 0 ? { ...s, r: (s.r + 1) % 4 } : s));
	check("a fleet moved after committing does not verify", !(await secrets.verify({ ...c, value: moved })));
	secrets.dispose();
}

// ---------------------------------------------------------------------------
console.log("\nthe bot");

{
	check("it opens on the parity lattice", (() => {
		const t = botTarget([]);
		return (t[0] + t[1]) % 2 === 0;
	})());

	// One hit outstanding: it must probe around it, not wander off.
	const around = botTarget([{ at: [4, 4], hit: true, sunk: null }]);
	check("after a hit it probes next door",
		Math.abs(around[0] - 4) + Math.abs(around[1] - 4) === 1, JSON.stringify(around));

	// Two hits in a row: it must extend the line, not probe the sides.
	const line = botTarget([
		{ at: [4, 4], hit: true, sunk: null },
		{ at: [4, 5], hit: true, sunk: null },
	]);
	check("two hits in a row make it follow the line",
		line[0] === 4 && (line[1] === 3 || line[1] === 6), JSON.stringify(line));

	const down = botTarget([
		{ at: [2, 6], hit: true, sunk: null },
		{ at: [3, 6], hit: true, sunk: null },
	]);
	check("and down a column too", down[1] === 6 && (down[0] === 1 || down[0] === 4), JSON.stringify(down));

	// A sinking accounts for its ship, so the bot must go back to hunting
	// rather than keep worrying at a wreck.
	const afterSink = botTarget([
		{ at: [3, 7], hit: true, sunk: null },
		{ at: [4, 7], hit: true, sunk: "patrol" },
	]);
	check("once a ship is sunk it stops probing it",
		!(Math.abs(afterSink[0] - 4) + Math.abs(afterSink[1] - 7) === 1 && afterSink[1] === 7),
		JSON.stringify(afterSink));

	check("it returns nothing when the board is exhausted", (() => {
		const every = [];
		for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) every.push({ at: [r, c], hit: false, sunk: null });
		return botTarget(every) === null;
	})());
}

/** Fire until the fleet is down. Returns how many shots it took. */
function shotsToClear(pick) {
	const ships = randomFleet();
	const shots = [];
	const hits = new Set();
	for (let i = 0; i < SIZE * SIZE; i++) {
		const at = pick(shots);
		if (!at) break;
		const a = answerShot(ships, hits, at[0], at[1]);
		if (a.hit) hits.add(key(at[0], at[1]));
		shots.push({ at, hit: a.hit, sunk: a.sunk });
		if (fleetSunk(hits)) return shots.length;
	}
	return SIZE * SIZE;
}

{
	const GAMES = 200;
	const randomly = (shots) => {
		const fired = new Set(shots.map((s) => key(s.at[0], s.at[1])));
		const free = [];
		for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) if (!fired.has(key(r, c))) free.push([r, c]);
		return free.length ? free[Math.floor(Math.random() * free.length)] : null;
	};
	let bot = 0;
	let blind = 0;
	for (let i = 0; i < GAMES; i++) {
		bot += shotsToClear(botTarget);
		blind += shotsToClear(randomly);
	}
	const botAvg = bot / GAMES;
	const blindAvg = blind / GAMES;
	console.log(`  ·    bot ${botAvg.toFixed(1)} shots, blind ${blindAvg.toFixed(1)} of ${SIZE * SIZE}`);
	// Hunt-and-target on an 8x8 with twelve ship cells should land in the
	// low-to-mid thirties; blind firing takes about sixty. If these converge,
	// the targeting has stopped working and only the board is doing the work.
	check("the bot clears a board in well under half the squares", botAvg < 40, `${botAvg.toFixed(1)}`);
	check("and comfortably faster than firing blind", botAvg < blindAvg - 12, `${botAvg.toFixed(1)} vs ${blindAvg.toFixed(1)}`);
}

{
	// A whole game, both sides played by the bot, audited at the end — the
	// closest this file gets to the real thing.
	let clean = 0;
	for (let i = 0; i < 50; i++) {
		const ships = randomFleet();
		const shots = [];
		const hits = new Set();
		while (!fleetSunk(hits)) {
			const at = botTarget(shots);
			if (!at) break;
			const a = answerShot(ships, hits, at[0], at[1]);
			if (a.hit) hits.add(key(at[0], at[1]));
			shots.push({ at, hit: a.hit, sunk: a.sunk });
		}
		if (auditAnswers(ships, shots) === null && fleetSunk(hits)) clean++;
	}
	check("fifty played-out games all finish and all audit clean", clean === 50, `${clean}/50`);
}

console.log(failures ? `\n${failures} failing\n` : "\nall passing\n");
process.exit(failures ? 1 : 0);
