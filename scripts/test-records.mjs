// scripts/test-records.mjs — achievements and records with no browser:
// lib/achievements.js (every operator, malformed conditions refused, each
// kind of achievement and record, the platform's own, cleaning and merging)
// and lib/records.js on top of lib/stats.js (a result counted once unlocks
// once, records update, a sync takes the best of both).

import { readFileSync } from "node:fs";
import {
	AGGREGATES,
	FIELDS,
	OPS,
	PLATFORM_ID,
	clean,
	cleanFacts,
	contextOf,
	dayOf,
	merge,
	read,
	step,
	stepPlatform,
	test,
	validateAchievement,
	validateCondition,
	validateRecord,
	validateRules,
} from "../lib/achievements.js";
import { validateManifest } from "./manifest.mjs";

let failures = 0;
const check = (label, ok, detail = "") => {
	console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
	if (!ok) failures++;
};

const ctx = contextOf(
	{ kind: "ffa", match: 2, ranking: [["me"], ["bot_1", "bot_2"]], scores: { me: 42 }, facts: { level: "easy", daily: true, mistakes: 3 }, seatFacts: { me: { mistakes: 0 }, bot_1: { mistakes: 9 } } },
	{ me: "me", outcome: "won", ms: 150_000, streak: 4 },
);

console.log("\nachievements: what a condition reads");
check("won, place, seats, bots, people", ctx.won === true && ctx.place === 1 && ctx.seats === 3 && ctx.bots === 2 && ctx.people === 0);
check("alone and vsBots", ctx.alone === false && ctx.vsBots === true);
check("score, ms, match, streak", ctx.score === 42 && ctx.ms === 150_000 && ctx.match === 2 && ctx.streak === 4);
check("a seat's own facts win over the match's", read(ctx, "facts.mistakes") === 0 && read(ctx, "facts.level") === "easy");
check("another seat's facts are not mine", contextOf({ kind: "duel", ranking: [["a"], ["b"]], seatFacts: { b: { x: 1 } } }, { me: "a", outcome: "won" }).facts.x === undefined);
check("a person on this phone (named in `names`) is not a bot", (() => {
	const c = contextOf({ kind: "ffa", ranking: [["me"], ["bot_1"], ["bot_2"]], names: { bot_2: "Player 2" } }, { me: "me", outcome: "won" });
	return c.bots === 1 && c.people === 1 && c.vsBots === false;
})());
check("alone: one seat", contextOf({ kind: "coop", ranking: [["me"]] }, { me: "me", outcome: "played" }).alone === true);
check("a spectator (no outcome) has no context", contextOf({ kind: "duel", ranking: [["a"], ["b"]] }, { me: "me", outcome: null }) === null);
check("a missing field reads undefined, a prototype key too", read(ctx, "facts.nope") === undefined && read(ctx, "facts.constructor") === undefined && read(ctx, "__proto__") === undefined);
check("facts are cleaned: bad keys, long text, objects and NaN dropped", JSON.stringify(cleanFacts({ ok: 1, "bad key": 1, Upper: 2, long: "x".repeat(41), obj: { a: 1 }, nan: NaN, t: "hi", b: false, n: null })) === '{"ok":1,"t":"hi","b":false,"n":null}');
check("…at most 16 facts", Object.keys(cleanFacts(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i])))).length === 16);

console.log("\nachievements: every operator");
const T = (when) => test(when, ctx);
check("a bare value is equality", T({ won: true }) && !T({ won: false }) && T({ "facts.level": "easy" }) && !T({ "facts.level": "hard" }));
check("null matches a missing fact", T({ "facts.nope": null }) && !T({ "facts.level": null }));
check('"="', T({ score: { "=": 42 } }) && !T({ score: { "=": 41 } }));
check('"!="', T({ score: { "!=": 41 } }) && !T({ score: { "!=": 42 } }));
check('"<"', T({ ms: { "<": 180_000 } }) && !T({ ms: { "<": 150_000 } }));
check('"<="', T({ ms: { "<=": 150_000 } }) && !T({ ms: { "<=": 149_999 } }));
check('">"', T({ bots: { ">": 1 } }) && !T({ bots: { ">": 2 } }));
check('">="', T({ bots: { ">=": 2 } }) && !T({ bots: { ">=": 3 } }));
check('"in"', T({ "facts.level": { in: ["easy", "medium"] } }) && !T({ "facts.level": { in: ["hard"] } }));
check('"exists"', T({ "facts.level": { exists: true } }) && T({ "facts.nope": { exists: false } }) && !T({ "facts.nope": { exists: true } }));
check("several operators on one field all hold (a range)", T({ ms: { ">": 60_000, "<": 180_000 } }) && !T({ ms: { ">": 60_000, "<": 100_000 } }));
check("several fields all hold", T({ won: true, "facts.mistakes": 0, "facts.level": "easy" }) && !T({ won: true, "facts.mistakes": 1 }));
check("a comparison with a missing or non-number value is false", !T({ "facts.nope": { "<": 5 } }) && !T({ "facts.level": { ">": 0 } }));
check("no `when`: every counted result", test(undefined, ctx) && test(null, ctx) && T({}));
check("a malformed `when` matches nothing", !test("won", ctx) && !test([], ctx) && !T({ "not.a.path": 1 }) && !T({ score: { "~": 1 } }));
check("every operator is covered", OPS.every((op) => ["=", "!=", "<", "<=", ">", ">=", "in", "exists"].includes(op)) && OPS.length === 8);

console.log("\nachievements: malformed conditions are refused");
const refuses = (label, when, needle) => {
	const p = validateCondition(when);
	check(label, p.length > 0 && (!needle || p.some((x) => x.includes(needle))), p);
};
check("a good condition passes", validateCondition({ won: true, "facts.mistakes": 0, ms: { "<": 180000, ">=": 0 }, "facts.level": { in: ["easy", "hard"] }, "facts.x": { exists: true } }).length === 0, validateCondition({ won: true }));
refuses("not an object", "won", "must be an object");
refuses("a list", [{ won: true }], "must be an object");
refuses("an unknown field", { wins: 1 }, "is not a field");
refuses("a nested facts path", { "facts.a.b": 1 }, "is not a field");
refuses("a fact name with a space", { "facts.my fact": 1 }, "is not a field");
refuses("an unknown operator", { score: { "~=": 1 } }, "unknown operator");
refuses("code instead of data (a function's text is just an unknown operator)", { score: { $where: "this.score > 1" } }, "unknown operator");
refuses("a comparison with text", { ms: { "<": "180000" } }, "must be a number");
refuses("a comparison with Infinity", { ms: { "<": Infinity } }, "must be a number");
refuses('"in" not a list', { "facts.level": { in: "easy" } }, "must be a list");
refuses('"in" an empty list', { "facts.level": { in: [] } }, "must be a list");
refuses('"in" with an object', { "facts.level": { in: [{}] } }, "must be a list");
refuses('"exists" not a boolean', { "facts.level": { exists: 1 } }, "true or false");
refuses("an empty operator object", { score: {} }, "no operator");
refuses("a value that is an array", { score: [1] }, "must be text");
refuses("text over 40 characters", { "facts.level": "x".repeat(41) }, "must be text");
refuses("more than 8 conditions", Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`facts.k${i}`, 1])), "more than 8");
refuses("a prototype key", JSON.parse('{"__proto__": 1}'), "is not a field");

console.log("\nachievements: declarations");
const good = { id: "clean-sheet", title: "Clean Sheet", description: "No mistakes.", glyph: "✨", when: { won: true } };
check("a good achievement passes", validateAchievement(good).length === 0, validateAchievement(good));
for (const k of AGGREGATES) {
	const a = { ...good, [k]: k === "distinct" ? { of: "facts.level", count: 4 } : k === "total" ? { of: "score", atLeast: 100 } : 5 };
	check(`…with "${k}"`, validateAchievement(a).length === 0, validateAchievement(a));
}
for (const [label, a, needle] of [
	["a bad id", { ...good, id: "Clean Sheet" }, '"id"'],
	["no title", { ...good, title: "" }, '"title"'],
	["a long title", { ...good, title: "x".repeat(33) }, '"title"'],
	["a long description", { ...good, description: "x".repeat(101) }, '"description"'],
	["a long glyph", { ...good, glyph: "123456789" }, '"glyph"'],
	["two aggregates", { ...good, count: 3, streak: 3 }, "at most one"],
	["count 1", { ...good, count: 1 }, '"count"'],
	["count not whole", { ...good, count: 2.5 }, '"count"'],
	["days 0", { ...good, days: 0 }, '"days"'],
	["distinct without a field", { ...good, distinct: { count: 3 } }, '"distinct"'],
	["total below zero", { ...good, total: { of: "score", atLeast: -1 } }, '"total"'],
	["an unknown key (code smuggled in)", { ...good, eval: "alert(1)" }, 'unknown field "eval"'],
	["a bad condition", { ...good, when: { nope: 1 } }, "is not a field"],
]) {
	const p = validateAchievement(a);
	check(`refused: ${label}`, p.some((x) => x.includes(needle)), p);
}
const rec = { id: "time", title: "Best time", of: "facts.ms", best: "min", by: "facts.level", when: { won: true }, format: "time" };
check("a good record passes", validateRecord(rec).length === 0, validateRecord(rec));
check("count and days records need no `of`", validateRecord({ id: "n", title: "Solved", best: "count" }).length === 0 && validateRecord({ id: "d", title: "Daily", best: "days" }).length === 0);
for (const [label, r, needle] of [
	["an unknown best", { ...rec, best: "avg" }, '"best"'],
	["min without of", { ...rec, of: undefined }, '"of"'],
	["count with of", { id: "n", title: "N", best: "count", of: "score" }, '"of" goes with'],
	["a bad by", { ...rec, by: "level" }, '"by"'],
	["an unknown format", { ...rec, format: "clock" }, '"format"'],
	["a long unit", { ...rec, unit: "seconds!!" }, '"unit"'],
	["an unknown key", { ...rec, fn: "x" }, 'unknown field "fn"'],
]) {
	const p = validateRecord(r);
	check(`refused: ${label}`, p.some((x) => x.includes(needle)), p);
}
check("a manifest's lists: ids used twice refused", validateRules({ achievements: [good, good] }).some((p) => p.includes("used twice")));
check("…more than 24 refused", validateRules({ achievements: Array.from({ length: 25 }, (_, i) => ({ ...good, id: `a${i}` })) }).some((p) => p.includes("at most 24")));
check("…records not a list refused", validateRules({ records: {} }).some((p) => p.includes('"records" must be a list')));
check("…absent is fine", validateRules({}).length === 0);
{
	// scripts/manifest.mjs runs it: the catalog build, validate-game and the PR check.
	const base = JSON.parse(readFileSync(new URL("../games/connect4/game.json", import.meta.url), "utf8"));
	check("validateManifest accepts a game's declarations", validateManifest({ ...base, achievements: [good], records: [rec] }).length === 0, validateManifest({ ...base, achievements: [good], records: [rec] }));
	check("…and refuses a malformed one", validateManifest({ ...base, achievements: [{ ...good, when: { score: { ">": "1" } } }] }).some((p) => p.includes("must be a number")));
	const web = JSON.parse(readFileSync(new URL("./fixtures/webapp/game.json", import.meta.url), "utf8"));
	check("…and refuses them on a web app (no results)", validateManifest({ ...web, achievements: [good] }).some((p) => p.includes("need a game that reports results")));
}

console.log("\nachievements: unlocking");
const day0 = new Date(2026, 10, 20, 12).getTime();
const D = 86_400_000;
const C = (over = {}, facts = {}) => ({ ...ctx, ...over, facts: { ...ctx.facts, ...facts } });
{
	const rules = { achievements: [{ id: "first", title: "First Win", when: { won: true } }] };
	let r = step({}, rules, C({ won: false, outcome: "lost" }), day0);
	check("a single-result achievement waits for its result", !r.unlocked.length && !r.state.a.first);
	r = step(r.state, rules, C(), day0 + 1);
	check("…and unlocks on it, once, with the time", r.unlocked.length === 1 && r.state.a.first === day0 + 1);
	r = step(r.state, rules, C(), day0 + 2);
	check("…never twice", !r.unlocked.length && r.state.a.first === day0 + 1);
}
{
	const rules = { achievements: [{ id: "five", title: "Five", when: { won: true }, count: 3 }] };
	let s = {};
	const hits = [];
	for (const won of [true, false, true, true]) {
		const r = step(s, rules, C({ won }), day0);
		s = r.state;
		hits.push(r.unlocked.length);
	}
	check("count: the third matching result unlocks (misses do not count, nor reset)", hits.join() === "0,0,0,1" && !s.p.five, hits);
}
{
	const rules = { achievements: [{ id: "row", title: "In a row", when: { won: true }, streak: 3 }] };
	let s = {};
	const hits = [];
	for (const won of [true, true, false, true, true, true]) {
		const r = step(s, rules, C({ won }), day0);
		s = r.state;
		hits.push(r.unlocked.length);
	}
	check("streak: a miss resets it; three in a row unlocks", hits.join() === "0,0,0,0,0,1", hits);
}
{
	const rules = { achievements: [{ id: "week", title: "7-Day", when: { "facts.daily": true }, days: 3 }] };
	let s = step({}, rules, C(), day0).state;
	s = step(s, rules, C(), day0 + 1000).state; // the same day: still one
	check("days: two results on one day are one day", s.p.week.cur === 1);
	s = step(s, rules, C(), day0 + D).state;
	s = step(s, rules, C(), day0 + 3 * D).state; // a day missed
	check("…a day missed starts again", s.p.week.cur === 1 && s.p.week.best === 2);
	s = step(s, rules, C(), day0 + 4 * D).state;
	const r = step(s, rules, C(), day0 + 5 * D);
	check("…three days in a row unlocks", r.unlocked.length === 1);
	check("dayOf is the local calendar day", dayOf(new Date(2026, 10, 20, 0, 1).getTime()) === dayOf(new Date(2026, 10, 20, 23, 59).getTime()) && dayOf(day0 + D) === dayOf(day0) + 1);
}
{
	const rules = { achievements: [{ id: "every", title: "Every Level", when: { won: true }, distinct: { of: "facts.level", count: 3 } }] };
	let s = {};
	const hits = [];
	for (const level of ["easy", "easy", "hard", "medium"]) {
		const r = step(s, rules, C({}, { level }), day0);
		s = r.state;
		hits.push(r.unlocked.length);
	}
	check("distinct: three different levels unlock", hits.join() === "0,0,0,1", hits);
}
{
	const rules = { achievements: [{ id: "gems", title: "Gems", total: { of: "score", atLeast: 100 } }] };
	let s = step({}, rules, C({ score: 60 }), day0).state;
	check("total: adds up", s.p.gems === 60);
	const r = step(s, rules, C({ score: 45 }), day0);
	check("…and unlocks at its sum", r.unlocked.length === 1);
}

console.log("\nrecords: updating");
{
	const rules = {
		records: [
			{ id: "time", title: "Best time", of: "ms", best: "min", by: "facts.level", when: { won: true }, format: "time" },
			{ id: "score", title: "Best score", of: "score", best: "max" },
			{ id: "solved", title: "Solved", best: "count", when: { won: true } },
			{ id: "gems", title: "Gems", of: "score", best: "sum" },
			{ id: "daily", title: "Daily streak", best: "days", when: { "facts.daily": true } },
		],
	};
	let r = step({}, rules, C({ ms: 200_000, score: 10 }), day0);
	check("the first values are set, nothing reported as beaten", r.state.r.time.v.easy === 200_000 && r.state.r.score.v[""] === 10 && !r.improved.length);
	r = step(r.state, rules, C({ ms: 150_000, score: 8 }), day0 + D);
	check("a faster time beats a min record (and is reported), a lower score does not touch a max", r.state.r.time.v.easy === 150_000 && r.state.r.score.v[""] === 10 && r.improved.length === 1 && r.improved[0].prev === 200_000);
	r = step(r.state, rules, C({ ms: 90_000 }, { level: "hard" }), day0 + 2 * D);
	check("grouped by level: hard has its own", r.state.r.time.v.hard === 90_000 && r.state.r.time.v.easy === 150_000);
	r = step(r.state, rules, C({ won: false, ms: 1 }), day0 + 2 * D);
	check("a record's `when` filters (a loss sets no time)", r.state.r.time.v.easy === 150_000);
	check("count counts its matching results", r.state.r.solved.v[""] === 3);
	check("sum adds", r.state.r.gems.v[""] === 10 + 8 + 42 + 42);
	check("days keeps the current and the best run", r.state.r.daily.v[""].cur === 3 && r.state.r.daily.v[""].best === 3);
	const by = step({}, { records: [{ id: "t", title: "T", of: "ms", best: "min", by: "facts.nope" }] }, C(), day0);
	check("a result without the `by` value sets nothing", !by.state.r.t);
}

console.log("\nplatform: across games");
{
	let s = {};
	let got = [];
	for (let i = 0; i < 10; i++) {
		const r = stepPlatform(s, i % 2 ? "a" : "b", 60_000, ["a", "b", "c"], day0 + i * D);
		s = r.state;
		got.push(...r.unlocked.map((a) => a.id));
	}
	check("Regular at 10 games, Seven Days at 7 days in a row", got.join() === "week,regular", got);
	check("time and games kept", s.n === 10 && s.ms === 600_000 && s.g.join() === "b,a");
	const r = stepPlatform(s, "c", null, ["a", "b", "c"], day0 + 10 * D);
	check("Explorer once every game playable alone is played", r.unlocked.some((a) => a.id === "explorer"));
	check("…never with fewer than two to play", !stepPlatform({}, "a", 0, ["a"], day0).unlocked.some((a) => a.id === "explorer"));
}

console.log("\nmerge: the best of both");
{
	const dev = { a: { first: 500, five: 900 }, p: { many: 7, days: { last: 10, cur: 2, best: 4 }, lv: { d: ["easy"] } }, r: { time: { b: "min", v: { easy: 100, hard: 400 } }, score: { b: "max", v: { "": 9 } }, d: { b: "days", v: { "": { last: 10, cur: 2, best: 2 } } } }, s: { played: 5, won: 3, streak: 1, last: 50, byBots: { 1: [4, 3] } } };
	const acc = { a: { first: 300, clean: 700 }, p: { many: 9, days: { last: 12, cur: 1, best: 3 }, lv: { d: ["hard"] }, five: 2 }, r: { time: { b: "min", v: { easy: 90, medium: 200 } }, score: { b: "max", v: { "": 12 } }, d: { b: "days", v: { "": { last: 8, cur: 5, best: 5 } } } }, s: { played: 8, won: 2, streak: 4, last: 40, byBots: { 1: [2, 2], 3: [1, 0] } } };
	const m = merge(dev, acc);
	check("unlocked in either, at the earlier time", m.a.first === 300 && m.a.five === 900 && m.a.clean === 700);
	check("progress of an unlocked achievement is dropped", !("five" in m.p));
	check("counts take the larger, days the later run with the better best, distinct the union", m.p.many === 9 && m.p.days.last === 12 && m.p.days.best === 4 && m.p.lv.d.sort().join() === "easy,hard");
	check("records: min takes the lower, max the higher, groups from both", m.r.time.v.easy === 90 && m.r.time.v.hard === 400 && m.r.time.v.medium === 200 && m.r.score.v[""] === 12);
	check("a days record: the later run, the longer best", m.r.d.v[""].last === 10 && m.r.d.v[""].best === 5);
	check("stats: the larger counts, the newer device's streak, wins per bot count each the larger", m.s.played === 8 && m.s.won === 3 && m.s.streak === 1 && m.s.byBots[1].join() === "4,3" && m.s.byBots[3].join() === "1,0");
	check("merge is symmetric in what it keeps", JSON.stringify(merge(acc, dev).a) === JSON.stringify({ first: 300, clean: 700, five: 900 }));
	check("merging with nothing is cleaning", JSON.stringify(merge(dev, undefined)) === JSON.stringify(clean(dev)));
	const pa = merge({ a: { regular: 5 }, n: 12, ms: 100, g: ["x"], d: { last: 3, cur: 3, best: 3 } }, { a: { regular: 9, week: 4 }, n: 20, ms: 50, g: ["y"], d: { last: 2, cur: 1, best: 6 } }, PLATFORM_ID);
	check("the platform's: earliest unlocks, larger totals, every game, the later run", pa.a.regular === 5 && pa.a.week === 4 && pa.n === 20 && pa.ms === 100 && pa.g.join() === "x,y" && pa.d.cur === 3 && pa.d.best === 6);
}
{
	const junk = { a: { ok: 1, "BAD ID": 2, neg: -5, str: "1" }, p: { x: "nope", y: { d: ["a", 5, "b".repeat(41)] } }, r: { r1: { b: "avg", v: {} }, r2: { b: "max", v: { g: "x", h: 3 } } }, s: { played: "9", won: 2, byBots: { 99: [1, 1], 2: [1] } }, extra: { evil: true } };
	const c = clean(junk);
	check("clean drops malformed entries and unknown keys", JSON.stringify(c) === JSON.stringify({ a: { ok: 1 }, p: { y: { d: ["a"] } }, r: { r2: { b: "max", v: { h: 3 } } }, s: { won: 2, byBots: {} } }), c);
	check("clean bounds its lists", Object.keys(clean({ a: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`a${i}`, i])) }).a).length === 64);
	check("clean never throws on garbage", [null, 1, "x", [], { a: null, p: [], r: 5 }].every((g) => typeof clean(g) === "object"));
	check("FIELDS lists what a condition reads", Object.keys(FIELDS).length === 13);
}

// ---------------------------------------------------------------- lib/records.js on lib/stats.js

console.log("\nrecords.js: a result counted on this device");
const store = new Map();
globalThis.window = globalThis;
globalThis.localStorage = {
	getItem: (k) => (store.has(k) ? store.get(k) : null),
	setItem: (k, v) => store.set(k, String(v)),
	removeItem: (k) => store.delete(k),
};
const toasts = [];
globalThis.NeonArcade = {
	toast: (t) => toasts.push(t),
	CATALOG: [
		{ id: "puzzle", title: "Puzzle", kind: "ffa", bots: true, seats: { min: 1, max: 4 }, categories: ["puzzle"], achievements: [{ id: "first", title: "First Solve", glyph: "⭐", when: { "facts.solved": true } }, { id: "beat-3", title: "Beat 3 Bots", when: { won: true, bots: { ">=": 3 } } }], records: [{ id: "time", title: "Best time", of: "ms", best: "min", format: "time" }] },
		{ id: "other", title: "Other", kind: "duel", bots: true, seats: { min: 2, max: 2 }, categories: ["strategy"] },
	],
};
new Function(readFileSync(new URL("../lib/stats.js", import.meta.url), "utf8"))();
await import("../lib/records.js");
const S = NeonArcade.stats;
const R = NeonArcade.records;
const r1 = { kind: "ffa", match: 0, ms: 125_000, ranking: [["me"], ["bot_1", "bot_2", "bot_3"]], seatFacts: { me: { solved: true } } };
S.record("puzzle", r1, { me: "me", key: "run|0" });
let mine = R.read();
check("stats.record counts it: two achievements unlock", !!mine.puzzle?.a?.first && !!mine.puzzle?.a?.["beat-3"]);
check("…one notice names them all, never blocking", toasts.length === 1 && toasts[0].includes("First Solve") && toasts[0].includes("Beat 3 Bots"), toasts);
check("…the record is set from the result's ms", mine.puzzle.r.time.v[""] === 125_000);
check("…the platform counted the game", mine["*"].n === 1 && mine["*"].g.join() === "puzzle");
S.record("puzzle", r1, { me: "me", key: "run|0" });
check("the same result reported again counts once", R.read()["*"].n === 1 && toasts.length === 1);
S.record("puzzle", { ...r1, match: 1, ms: 99_000 }, { me: "me", key: "run|1" });
check("a faster rematch beats the record, and says so", R.read().puzzle.r.time.v[""] === 99_000 && toasts.at(-1).startsWith("New best — Best time: 1:39"), toasts.at(-1));
check("stats keeps wins per bot count", S.read().puzzle.byBots[3].join() === "2,2");
check("…and time played", S.read().puzzle.ms === 224_000);
S.record("puzzle", { kind: "duel", ranking: [["a"], ["b"]] }, { me: "me", key: "x" });
check("a spectator's result counts nothing", R.read()["*"].n === 2);
check("Explorer's games: listed, playable alone", R.soloGames().join() === "puzzle,other");
check("records are marked for the account", JSON.parse(store.get("neon.records")).dirty.sort().join() === "*,puzzle");

console.log("\nrecords.js: sync with the account (the best of both)");
{
	let server = { puzzle: { a: { first: 1 }, r: { time: { b: "min", v: { "": 80_000 } } }, s: { played: 10, won: 9, best: 7, last: 1 } }, other: { a: {}, s: { played: 4, won: 1, last: 1 } } };
	const puts = [];
	NeonArcade.account = {
		me: { id: "acct" },
		async api(path, { method = "GET", body } = {}) {
			if (path !== "/api/me/records") throw Object.assign(new Error("no"), { status: 404 });
			if (method === "PUT") {
				puts.push(body);
				for (const [g, v] of Object.entries(body.games)) server[g] = merge(server[g], v, g);
				return { games: Object.fromEntries(Object.keys(body.games).map((g) => [g, server[g]])) };
			}
			return { games: server };
		},
	};
	await R.sync();
	mine = R.read();
	check("the device takes the account's better record and earlier unlock", mine.puzzle.r.time.v[""] === 80_000 && mine.puzzle.a.first === 1);
	check("…and its larger counts into lib/stats.js", S.read().puzzle.played === 10 && S.read().puzzle.best === 7 && S.read().other.played === 4);
	check("the account takes what the device had more of", !!server.puzzle.a["beat-3"] && server["*"]?.n === 2, server);
	check("…in one PUT, and nothing is left marked", puts.length === 1 && JSON.parse(store.get("neon.records")).dirty.length === 0, puts.length);
	await R.sync();
	check("a second sync with nothing new sends nothing", puts.length === 1, puts.length);
}

console.log(failures ? `\n${failures} records check(s) failed` : "\nall records checks passed");
process.exit(failures ? 1 : 0);
