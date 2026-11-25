#!/usr/bin/env node
/**
 * test-randomness.mjs — the variety Lokesh picked (2026-11-24), each game's
 * own rules run against a stub page, with no browser.
 *
 *   node scripts/test-randomness.mjs
 *
 * - Connect 4: the bot picks at random among columns within a small margin
 *   of its best, from the match's `seed`; it still takes a win and blocks a
 *   loss, and the same seed plays the same game.
 * - Neon Survival: the run is dealt from `seed` (two runs with one seed are
 *   the same run), and about every 20 s a wave event — a burst from one side,
 *   fast drones, a gem rain or slow-mo — with a banner in the view.
 *
 * Neon Fission's voids and Neon Bid's hot colour are in their own rules
 * tests (scripts/test-neon-fission.mjs, test-neon-bid.mjs); Tic Tac Toe's
 * equal moves in scripts/test-conformance.mjs, every language.
 */
import { readFileSync } from "node:fs";

const read = (f) => readFileSync(new URL(f, import.meta.url), "utf8");
let failures = 0;
const check = (label, ok, detail = "") => {
	console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
	if (!ok) failures++;
};
const clone = (v) => JSON.parse(JSON.stringify(v));

// A stub page: every element and context call is a no-op; `arcade.managed`
// hands back the rules each load registers.
const stub = () => new Proxy(function () {}, { get: (_, k) => (k === Symbol.toPrimitive ? () => "" : stub()), apply: () => stub(), set: () => true });
globalThis.window = globalThis;
globalThis.document = stub();
globalThis.matchMedia = () => ({ matches: true, addEventListener() {} });
globalThis.addEventListener = () => {};
globalThis.requestAnimationFrame = () => 0;
globalThis.innerWidth = 390;
globalThis.innerHeight = 844;
globalThis.devicePixelRatio = 2;
let registered = null;
globalThis.arcade = {
	managed: (r) => (registered = r),
	on() {},
	answer() {},
	init: new Promise(() => {}),
	toast() {},
	act() {},
	idle() {},
	send() {},
	theme: { tokens: { good: "rgba(0, 1, 0, 1)", danger: "rgba(1, 0, 0, 1)", bg: "rgba(0, 0, 0, 1)", glow: "rgba(0, 0, 0, 0)" }, players: Array(8).fill("rgba(1, 1, 1, 1)") },
	party: { self: "pA", host: "pA", members: [] },
};
/** A fresh copy of a game's rules, as one phone's frame holds them. */
function load(path) {
	registered = null;
	new Function(read(path))();
	if (!registered) throw new Error(`${path} registered no rules`);
	return registered;
}

// ---------------------------------------------------------------------------
console.log("\nConnect 4: the bot's equal moves");

const duel = [
	{ id: "pA", name: "Ada", team: "A", bot: true },
	{ id: "pB", name: "Bo", team: "B", bot: true },
];
{
	const rules = load("../games/connect4/connect4.js");
	/** The bot's first `n` moves of a bots-only game from `seed`, as columns. */
	async function opening(seed, n = 8) {
		await rules.init({ seats: clone(duel), opts: {}, seed, match: 0, first: "pA" });
		const cols = [];
		for (let i = 0; i < n; i++) {
			const who = (await rules.turn())[0];
			const move = await rules.bot({ seat: who });
			cols.push(move.col);
			check(`a legal move (seed ${seed}, move ${i + 1})`, (await rules.apply({ action: move, by: who })) == null);
		}
		return cols.join("");
	}
	const games = new Set();
	for (let seed = 1; seed <= 12; seed++) games.add(await opening(seed));
	check("bots-only games open differently across seeds", games.size >= 8, [...games]);
	console.log(`  ·    ${games.size} different 8-move openings in 12 seeds`);
	check("the same seed plays the same game (a run replays)", (await opening(5)) === (await opening(5)));
	check("the view does not carry the bot's generator", !("rng" in (await rules.view({ seat: "pA" }))));

	// Still never throws a game away: a win on the board is taken, a loss blocked.
	let took = 0;
	let blocked = 0;
	for (let seed = 1; seed <= 10; seed++) {
		// Red on columns 0,0,0 (yellow on 6,6): red to move wins on column 0.
		await rules.init({ seats: clone(duel), opts: {}, seed, match: 0, first: "pA" });
		for (const col of [0, 6, 0, 6, 0, 5]) await rules.apply({ action: { col }, by: (await rules.turn())[0] });
		if ((await rules.bot({ seat: "pA" })).col === 0) took++;
		// Yellow on 6,6,6 (red on 0,2,0, no win of its own): red must block column 6.
		await rules.init({ seats: clone(duel), opts: {}, seed, match: 0, first: "pA" });
		for (const col of [0, 6, 2, 6, 0, 6]) await rules.apply({ action: { col }, by: (await rules.turn())[0] });
		if ((await rules.bot({ seat: "pA" })).col === 6) blocked++;
	}
	check("on 10 seeds it always takes a win in one", took === 10, `${took}/10`);
	check("…and always blocks a loss in one", blocked === 10, `${blocked}/10`);
	// A handover carries the generator: the heir's bot plays the host's next move.
	await rules.init({ seats: clone(duel), opts: {}, seed: 9, match: 0, first: "pA" });
	await rules.apply({ action: await rules.bot({ seat: "pA" }), by: "pA" });
	const heir = load("../games/connect4/connect4.js");
	heir.restore({ snapshot: clone(rules.snapshot()) });
	check("the heir's bot makes the host's next move", (await heir.bot({ seat: "pB" })).col === (await rules.bot({ seat: "pB" })).col);
}

// ---------------------------------------------------------------------------
console.log("\nNeon Survival: one seed, one run; wave events");

const SURVIVAL = "../games/neon-survival-mp/neon-survival-mp.js";
const swarm = [
	{ id: "pA", name: "Ada", bot: false },
	{ id: "bot_1", name: "Bot", bot: true },
	{ id: "bot_2", name: "Bot", bot: true },
];
/**
 * A run of `secs` from `seed`: the person points at a fixed spot, the bots
 * steer; `each(view, s)` after every tick. Returns the rules.
 */
function survive(seed, secs, each, rules = load(SURVIVAL)) {
	rules.init({ seats: clone(swarm), opts: {}, seed, match: 0 });
	for (let t = 0; t < secs * 30; t++) {
		const inputs = { pA: { x: 40, y: 40 } };
		for (const id of ["bot_1", "bot_2"]) {
			const b = rules.bot({ seat: id });
			if (b) inputs[id] = b;
		}
		rules.tick({ inputs, dt: 1 / 30 });
		each?.(rules.view({ seat: "pA" }), rules.snapshot());
	}
	return rules;
}
{
	const a = clone(survive(4, 25).snapshot());
	const b = clone(survive(4, 25).snapshot());
	check("two runs from one seed are the same run (25 s)", JSON.stringify(a) === JSON.stringify(b));
	check("…and another seed is another run", JSON.stringify(clone(survive(5, 25).snapshot())) !== JSON.stringify(a));

	// The events: about every 20 s, each with a banner.
	const seen = [];
	survive(4, 65, (v, s) => {
		if (v.ev && seen.at(-1)?.k !== v.ev[0] + s.event?.at) seen.push({ k: v.ev[0] + s.event?.at, kind: v.ev[0], side: v.ev[1], at: s.ms });
	});
	const kinds = ["burst", "fast", "rain", "slow"];
	check("three events in 65 s, one about every 20 s", seen.length === 3 && seen.every((e, i) => Math.abs(e.at - 20000 * (i + 1)) < 100), seen.map((e) => `${e.kind}@${Math.round(e.at)}`));
	check("…each a known kind", seen.every((e) => kinds.includes(e.kind)), seen.map((e) => e.kind));
	check("…never the same twice running", seen.every((e, i) => !i || e.kind !== seen[i - 1].kind), seen.map((e) => e.kind));
	// Each kind, from the first seed whose first event it is.
	const firstOf = {};
	for (let seed = 1; seed <= 60 && Object.keys(firstOf).length < 4; seed++) {
		const rules = load(SURVIVAL);
		let kind = null;
		let before = null;
		survive(seed, 21, (v, s) => {
			if (!kind && s.ms < 20000) before = { enemies: s.enemies.length, gems: s.gems.length };
			if (!kind && v.ev) kind = v.ev[0];
		}, rules);
		if (kind && !firstOf[kind]) firstOf[kind] = { seed, rules, before };
	}
	check("every kind turns up on some seed", kinds.every((k) => firstOf[k]), Object.keys(firstOf));
	if (firstOf.burst) {
		const { rules, before } = firstOf.burst;
		const s = rules.snapshot();
		const side = rules.view({ seat: null }).ev?.[1];
		check("a burst: a wave of at least 6 drones at once", s.enemies.length >= before.enemies + 6, { before: before.enemies, now: s.enemies.length });
		check("…from one side, said in the banner", ["top", "right", "bottom", "left"].includes(side), String(side));
	}
	if (firstOf.rain) {
		const { rules } = firstOf.rain;
		check("a gem rain: gems past the usual three", rules.snapshot().gems.length >= 6, String(rules.snapshot().gems.length));
	}
	if (firstOf.slow) {
		const { rules } = firstOf.slow;
		const s = rules.snapshot();
		const en = s.enemies.find((e) => Math.hypot(e.vx, e.vy) > 0);
		const [x0, y0] = [en.x, en.y];
		rules.tick({ inputs: { pA: { x: 40, y: 40 } }, dt: 1 / 30 }); // two 60 Hz frames
		check("slow-mo: the swarm moves at half speed", Math.abs(en.x - x0 - en.vx) < 0.01 && Math.abs(en.y - y0 - en.vy) < 0.01, { dx: en.x - x0, vx: en.vx });
		const v = rules.view({ seat: null });
		check("…and the view says so, so phones draw it at half speed too", v.e.length >= 4 && Math.abs(v.e[2] - Math.round(s.enemies[0].vx * 50) / 100) < 0.011, { sent: v.e[2], vx: s.enemies[0].vx });
	}
	if (firstOf.fast) {
		const { rules } = firstOf.fast;
		// Fast drones: those launched in the event fly faster than the swarm's pace.
		for (let t = 0; t < 60; t++) rules.tick({ inputs: { pA: { x: 40, y: 40 } }, dt: 1 / 30 });
		const s = rules.snapshot();
		const pace = 1.5 + s.score / 15;
		const fastest = Math.max(...s.enemies.map((e) => Math.hypot(e.vx, e.vy)));
		check("fast drones: some fly at 1.5x the swarm's pace and more", fastest >= pace * 1.5 - 0.01, { fastest, pace });
	}
	// The banner comes and goes: up for the event's first seconds only.
	let up = 0;
	let after = 0;
	survive(4, 30, (v, s) => {
		if (s.ms > 20000 && s.ms < 21000 && v.ev) up++;
		if (s.ms > 26000 && v.ev) after++;
	});
	check("the banner is up as the event starts, and gone a few seconds later", up > 20 && after === 0, { up, after });
	// The heir carries on the same run.
	const host = survive(7, 10);
	const heir = load(SURVIVAL);
	heir.restore({ snapshot: clone(host.snapshot()) });
	for (const r of [host, heir]) for (let t = 0; t < 400; t++) r.tick({ inputs: { pA: { x: 40, y: 40 } }, dt: 1 / 30 });
	check("the heir's run goes on as the host's would (its generator travels)", JSON.stringify(clone(heir.snapshot())) === JSON.stringify(clone(host.snapshot())));
}


// ---------------------------------------------------------------------------
console.log("\nTic Tac Toe: the bot's equal squares (the JavaScript reference and the HTML lane)");
{
	// The other five lanes are held to the reference call for call by
	// scripts/test-conformance.mjs, whose match runs from three seeds.
	const ttt = [
		{ id: "pX", name: "Ada", team: "A", bot: false },
		{ id: "bot_O", name: "Bot", team: "B", bot: true },
	];
	for (const [lane, path] of [["js", "../sdk/v2/examples/tic-tac-toe-js/tic-tac-toe.js"], ["html", "../sdk/v2/examples/tic-tac-toe-html/rules.js"]]) {
		const rules = load(path);
		/** The bot's answer after X takes the centre, from `seed`. */
		const reply = (seed) => {
			rules.init({ seats: clone(ttt), opts: {}, seed, match: 0, first: "pX" });
			rules.apply({ action: { i: 4 }, by: "pX" });
			return rules.bot({ seat: "bot_O" }).i;
		};
		const squares = new Set();
		for (let seed = 1; seed <= 20; seed++) squares.add(reply(seed));
		check(`${lane}: with the centre gone, the bot answers on different squares across seeds`, squares.size >= 4, [...squares]);
		check(`${lane}: …the same seed, the same square`, reply(7) === reply(7));
		check(`${lane}: …never the seed in the view`, !("seed" in rules.view({ seat: null })));
		// Still the bot it was: a win taken, a loss blocked, the centre first.
		let ok = true;
		for (let seed = 1; seed <= 12; seed++) {
			rules.init({ seats: clone(ttt), opts: {}, seed, match: 0, first: "bot_O" });
			if (rules.bot({ seat: "bot_O" }).i !== 4) ok = false;
			for (const [by, i] of [["bot_O", 0], ["pX", 4], ["bot_O", 1], ["pX", 8]]) rules.apply({ action: { i }, by });
			if (rules.bot({ seat: "bot_O" }).i !== 2) ok = false; // O wins on 2 (0, 1, 2)
			rules.init({ seats: clone(ttt), opts: {}, seed, match: 0, first: "pX" });
			for (const [by, i] of [["pX", 0], ["bot_O", 4], ["pX", 1]]) rules.apply({ action: { i }, by });
			if (rules.bot({ seat: "bot_O" }).i !== 2) ok = false; // O blocks on 2
		}
		check(`${lane}: …it still opens in the centre, wins when it can and blocks when it must`, ok);
		// The heir's bot answers as the host's would.
		rules.init({ seats: clone(ttt), opts: {}, seed: 11, match: 0, first: "pX" });
		rules.apply({ action: { i: 4 }, by: "pX" });
		const want = rules.bot({ seat: "bot_O" }).i;
		const heir = load(path);
		heir.restore({ snapshot: clone(rules.snapshot()) });
		check(`${lane}: …and an heir's bot answers as the host's`, heir.bot({ seat: "bot_O" }).i === want);
	}
}

console.log(failures ? `\n${failures} failing\n` : "\nall passing\n");
process.exit(failures ? 1 : 0);
