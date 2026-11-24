// lib/achievements.js — personal records and achievements: the rules, and
// nothing else. Pure (no DOM, no storage, no clock of its own), so one copy
// serves all three places that need it:
//
//   lib/records.js           the device: counts each result, keeps the state
//                            in localStorage, shows unlocks
//   scripts/manifest.mjs     a game.json's `achievements` and `records`
//                            (catalog build, validate-game, the PR check)
//   worker/api/records.js    the account's copy: cleaned and merged
//
// docs/platform.md "Achievements and records" is the author's guide; this is
// the contract.
//
// A game declares, in game.json, conditions over the end-of-game result as
// the platform reads it for one player (`contextOf`):
//
//   "achievements": [
//     { "id": "clean-sheet", "title": "Clean Sheet", "description": "Solve a puzzle with no mistakes.",
//       "glyph": "✨", "when": { "facts.solved": true, "facts.mistakes": 0 } },
//     { "id": "hundred", "title": "100 Solved", "when": { "facts.solved": true }, "count": 100 }
//   ],
//   "records": [
//     { "id": "time", "title": "Best time", "of": "facts.ms", "best": "min", "by": "facts.level",
//       "when": { "facts.solved": true }, "format": "time" }
//   ]
//
// The condition language is data only: a path, and a value it must equal or
// an object of operators (all must hold). Every path is one of FIELDS or
// `facts.<name>`, which the game reports in its result (`facts`, the match's;
// `seatFacts[id]`, each player's own, which win over the match's).

/** What a condition may read, and its type. `facts.<name>` besides. */
export const FIELDS = Object.freeze({
	outcome: "string", // "won" | "lost" | "drawn" | "played" (co-op, one phone)
	won: "boolean",
	place: "number", // 1 = first; null for a one-phone game
	kind: "string", // the result's kind
	seats: "number", // everyone in the ranking, me included
	bots: "number", // bot opponents (people on this phone, named in `names`, are not bots)
	people: "number", // other people
	alone: "boolean", // nobody else in the ranking
	vsBots: "boolean", // at least one bot and no other person
	score: "number", // scores[me]
	ms: "number", // how long the match took (the host's clock, or this device's)
	match: "number", // which match of the run, from 0
	streak: "number", // this game's current win streak, after this result
});
export const OPS = Object.freeze(["=", "!=", "<", "<=", ">", ">=", "in", "exists"]);
export const AGGREGATES = Object.freeze(["count", "streak", "days", "distinct", "total"]);
export const BESTS = Object.freeze(["min", "max", "sum", "count", "days"]);
export const FORMATS = Object.freeze(["number", "time"]);
export const LIMITS = Object.freeze({
	achievements: 24,
	records: 8,
	conditions: 8, // keys in one `when`
	inList: 16,
	title: 32,
	description: 100,
	glyph: 8,
	unit: 8,
	text: 40, // a string value, a fact's or a condition's
	facts: 16, // keys in `facts` and in each `seatFacts[id]`
	groups: 16, // values of a record's `by`
	distinct: 100,
	count: 100000,
});

/**
 * The most one game's entry may take, as JSON (the Worker refuses more, per
 * game): a game's at its largest is well under; the platform's ("*", which
 * lists every game played) has a larger allowance of its own.
 */
export const RECORD_BYTES = 8 * 1024;
export const PLATFORM_BYTES = 20 * 1024;

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const FACT = /^[a-z][A-Za-z0-9_]{0,31}$/;
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const own = (o, k) => isObj(o) && Object.prototype.hasOwnProperty.call(o, k);
const finite = (v) => typeof v === "number" && Number.isFinite(v);
/** A value a fact or a condition may hold: short text, a finite number, true/false, null. */
const scalar = (v) => v === null || typeof v === "boolean" || finite(v) || (typeof v === "string" && v.length <= LIMITS.text);

/** Is `p` a path a condition may read? */
export const isPath = (p) => typeof p === "string" && (own(FIELDS, p) || (p.startsWith("facts.") && FACT.test(p.slice(6))));

// ------------------------------------------------------------ validation

/** Problems with one `when`, as sentences; `where` names it. */
export function validateCondition(when, where = "when") {
	if (!isObj(when)) return [`${where} must be an object of conditions`];
	const p = [];
	const keys = Object.keys(when);
	if (keys.length > LIMITS.conditions) p.push(`${where} has more than ${LIMITS.conditions} conditions`);
	for (const k of keys) {
		if (!isPath(k)) {
			p.push(`${where}: "${k}" is not a field (${Object.keys(FIELDS).join(", ")}, or facts.<name>)`);
			continue;
		}
		const c = when[k];
		if (!isObj(c)) {
			if (!scalar(c)) p.push(`${where}."${k}" must be text of at most ${LIMITS.text} characters, a number, true, false or null`);
			continue;
		}
		const ops = Object.keys(c);
		if (!ops.length) p.push(`${where}."${k}" has no operator`);
		for (const op of ops) {
			const v = c[op];
			if (!OPS.includes(op)) p.push(`${where}."${k}": unknown operator "${op}" (${OPS.join(" ")})`);
			else if (["<", "<=", ">", ">="].includes(op) && !finite(v)) p.push(`${where}."${k}"."${op}" must be a number`);
			else if ((op === "=" || op === "!=") && !scalar(v)) p.push(`${where}."${k}"."${op}" must be text, a number, true, false or null`);
			else if (op === "in" && !(Array.isArray(v) && v.length >= 1 && v.length <= LIMITS.inList && v.every(scalar))) {
				p.push(`${where}."${k}".in must be a list of 1–${LIMITS.inList} values`);
			} else if (op === "exists" && typeof v !== "boolean") p.push(`${where}."${k}".exists must be true or false`);
		}
	}
	return p;
}

const text = (v, max) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const count = (v, min = 1) => Number.isInteger(v) && v >= min && v <= LIMITS.count;

/** Problems with one achievement. */
export function validateAchievement(a, i = 0) {
	const at = `achievements[${i}]`;
	if (!isObj(a)) return [`${at} must be an object`];
	const p = [];
	const name = typeof a.id === "string" ? `achievement "${a.id}"` : at;
	if (!ID.test(a.id ?? "")) p.push(`${at}: "id" must be 1–32 of a-z, 0-9, -`);
	if (!text(a.title, LIMITS.title)) p.push(`${name}: "title" must be 1–${LIMITS.title} characters`);
	if (a.description != null && !text(a.description, LIMITS.description)) p.push(`${name}: "description" must be 1–${LIMITS.description} characters`);
	if (a.glyph != null && !text(a.glyph, LIMITS.glyph)) p.push(`${name}: "glyph" must be 1–${LIMITS.glyph} characters (an emoji or a symbol)`);
	if (a.when != null) p.push(...validateCondition(a.when, `${name}: when`));
	const aggs = AGGREGATES.filter((k) => a[k] != null);
	if (aggs.length > 1) p.push(`${name}: at most one of ${AGGREGATES.join(", ")} (it has ${aggs.join(" and ")})`);
	for (const k of ["count", "streak", "days"]) if (a[k] != null && !count(a[k], 2)) p.push(`${name}: "${k}" must be a whole number from 2 to ${LIMITS.count}`);
	if (a.distinct != null) {
		const d = a.distinct;
		if (!isObj(d) || !isPath(d.of) || !Number.isInteger(d.count) || d.count < 2 || d.count > LIMITS.distinct) {
			p.push(`${name}: "distinct" must be { "of": <field>, "count": 2–${LIMITS.distinct} }`);
		}
	}
	if (a.total != null) {
		const t = a.total;
		if (!isObj(t) || !isPath(t.of) || !finite(t.atLeast) || t.atLeast <= 0) p.push(`${name}: "total" must be { "of": <field>, "atLeast": a number above 0 }`);
	}
	const known = new Set(["id", "title", "description", "glyph", "when", ...AGGREGATES]);
	for (const k of Object.keys(a)) if (!known.has(k)) p.push(`${name}: unknown field "${k}"`);
	return p;
}

/** Problems with one record. */
export function validateRecord(r, i = 0) {
	const at = `records[${i}]`;
	if (!isObj(r)) return [`${at} must be an object`];
	const p = [];
	const name = typeof r.id === "string" ? `record "${r.id}"` : at;
	if (!ID.test(r.id ?? "")) p.push(`${at}: "id" must be 1–32 of a-z, 0-9, -`);
	if (!text(r.title, LIMITS.title)) p.push(`${name}: "title" must be 1–${LIMITS.title} characters`);
	if (!BESTS.includes(r.best)) p.push(`${name}: "best" must be one of ${BESTS.join(", ")}`);
	const needsOf = ["min", "max", "sum"].includes(r.best);
	if (needsOf && !isPath(r.of)) p.push(`${name}: "of" must be a field (${Object.keys(FIELDS).join(", ")}, or facts.<name>)`);
	if (!needsOf && r.of != null) p.push(`${name}: "of" goes with "best" min, max or sum`);
	if (r.by != null && !isPath(r.by)) p.push(`${name}: "by" must be a field`);
	if (r.when != null) p.push(...validateCondition(r.when, `${name}: when`));
	if (r.format != null && !FORMATS.includes(r.format)) p.push(`${name}: "format" must be one of ${FORMATS.join(", ")}`);
	if (r.unit != null && !text(r.unit, LIMITS.unit)) p.push(`${name}: "unit" must be 1–${LIMITS.unit} characters`);
	const known = new Set(["id", "title", "of", "best", "by", "when", "format", "unit"]);
	for (const k of Object.keys(r)) if (!known.has(k)) p.push(`${name}: unknown field "${k}"`);
	return p;
}

/** Problems with a manifest's `achievements` and `records` (both optional). */
export function validateRules(m) {
	const p = [];
	for (const [key, max, one] of [
		["achievements", LIMITS.achievements, validateAchievement],
		["records", LIMITS.records, validateRecord],
	]) {
		const list = m?.[key];
		if (list == null) continue;
		if (!Array.isArray(list) || list.length > max) {
			p.push(`"${key}" must be a list of at most ${max}`);
			continue;
		}
		list.forEach((x, i) => p.push(...one(x, i)));
		const ids = list.map((x) => x?.id).filter((id) => typeof id === "string");
		const twice = ids.filter((id, i) => ids.indexOf(id) !== i);
		if (twice.length) p.push(`"${key}": the id "${twice[0]}" is used twice`);
	}
	return p;
}

// ------------------------------------------------------------ evaluation

/** A result's `facts` (or one seat's), with anything malformed dropped. */
export function cleanFacts(f) {
	if (!isObj(f)) return {};
	const out = {};
	for (const k of Object.keys(f).slice(0, LIMITS.facts * 2)) {
		if (Object.keys(out).length >= LIMITS.facts) break;
		if (FACT.test(k) && scalar(f[k])) out[k] = f[k];
	}
	return out;
}

/**
 * The result as one player reads it: the values a condition tests. `outcome`
 * is lib/stats.js's ("won" | "lost" | "drawn" | "played"); null when `me`
 * was not in it. `ms`: how long it took, when known. `streak`: this game's
 * win streak after it.
 */
export function contextOf(r, { me, outcome, isBot = (id) => String(id).startsWith("bot_"), ms = null, streak = 0 } = {}) {
	if (!outcome || !isObj(r) || !Array.isArray(r.ranking)) return null;
	const ids = r.ranking.flat().filter((id) => typeof id === "string");
	const others = ids.filter((id) => id !== me);
	// Bot seats that are people on this phone (Neon Fission's PERSON) are named
	// in the result's `names`: they are people here, as for the boards.
	const bots = others.filter((id) => isBot(id) && !own(r.names, id)).length;
	const people = others.length - bots;
	const at = r.ranking.findIndex((slot) => Array.isArray(slot) && slot.includes(me));
	return {
		outcome,
		won: outcome === "won",
		place: r.kind === "local" || at < 0 ? null : at + 1,
		kind: r.kind,
		seats: ids.includes(me) ? ids.length : ids.length + 1,
		bots,
		people,
		alone: others.length === 0,
		vsBots: bots > 0 && people === 0,
		score: finite(r.scores?.[me]) ? r.scores[me] : null,
		ms: finite(ms) && ms >= 0 ? ms : null,
		match: Number.isInteger(r.match) ? r.match : 0,
		streak: Number.isInteger(streak) ? streak : 0,
		facts: { ...cleanFacts(r.facts), ...cleanFacts(own(r.seatFacts, me) ? r.seatFacts[me] : null) },
	};
}

/** The value at `path` in a context; undefined when it has none. */
export function read(ctx, path) {
	if (!isObj(ctx) || typeof path !== "string") return undefined;
	if (path.startsWith("facts.")) return own(ctx.facts, path.slice(6)) ? ctx.facts[path.slice(6)] : undefined;
	return own(FIELDS, path) ? ctx[path] : undefined;
}

const same = (v, c) => (v ?? null) === c;
function holds(v, c) {
	if (!isObj(c)) return same(v, c);
	for (const [op, x] of Object.entries(c)) {
		const ok =
			op === "=" ? same(v, x)
			: op === "!=" ? !same(v, x)
			: op === "<" ? finite(v) && v < x
			: op === "<=" ? finite(v) && v <= x
			: op === ">" ? finite(v) && v > x
			: op === ">=" ? finite(v) && v >= x
			: op === "in" ? Array.isArray(x) && x.some((y) => same(v, y))
			: op === "exists" ? (v != null) === x
			: false; // an unknown operator never holds (validation refuses it first)
		if (!ok) return false;
	}
	return true;
}

/** Does `ctx` meet `when`? An absent `when` matches every counted result; a malformed one none. */
export function test(when, ctx) {
	if (when == null) return true;
	if (!isObj(when) || !isObj(ctx)) return false;
	return Object.entries(when).every(([k, c]) => isPath(k) && holds(read(ctx, k), c));
}

/** A local calendar day as a number, for "days in a row". */
export const dayOf = (t) => {
	const d = new Date(t);
	return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);
};
/** A run of days: { last, cur, best } after a matching result on `day`. */
function nextDays(prev, day) {
	const p = isObj(prev) ? prev : { last: null, cur: 0, best: 0 };
	if (p.last === day) return p;
	const cur = p.last === day - 1 ? p.cur + 1 : 1;
	return { last: day, cur, best: Math.max(p.best ?? 0, cur) };
}

/**
 * One game's state with a result applied: `{ state, unlocked, improved }`.
 * `rules`: the manifest's `{ achievements, records }`. State:
 *
 *   { a: { [achievement]: when unlocked },
 *     p: { [achievement]: progress — a count, { d: [values] }, { last, cur, best } },
 *     r: { [record]: { b: best, v: { [group]: value | { last, cur, best } } } } }
 *
 * `improved` lists the min/max records beaten (not set for the first time).
 */
export function step(state, rules, ctx, now = Date.now()) {
	const s = { a: { ...(state?.a ?? {}) }, p: { ...(state?.p ?? {}) }, r: { ...(state?.r ?? {}) } };
	const unlocked = [];
	const improved = [];
	if (!ctx) return { state: s, unlocked, improved };
	const day = dayOf(now);
	for (const a of rules?.achievements ?? []) {
		if (!a?.id || own(s.a, a.id)) continue;
		const hit = test(a.when, ctx);
		let done = false;
		if (a.count) {
			if (hit) s.p[a.id] = (finite(s.p[a.id]) ? s.p[a.id] : 0) + 1;
			done = s.p[a.id] >= a.count;
		} else if (a.streak) {
			s.p[a.id] = hit ? (finite(s.p[a.id]) ? s.p[a.id] : 0) + 1 : 0;
			done = s.p[a.id] >= a.streak;
		} else if (a.days) {
			if (hit) s.p[a.id] = nextDays(s.p[a.id], day);
			done = (s.p[a.id]?.cur ?? 0) >= a.days;
		} else if (a.distinct) {
			const v = read(ctx, a.distinct.of);
			if (hit && scalar(v) && v != null) {
				const seen = new Set(Array.isArray(s.p[a.id]?.d) ? s.p[a.id].d : []);
				seen.add(String(v));
				s.p[a.id] = { d: [...seen].slice(0, LIMITS.distinct) };
			}
			done = (s.p[a.id]?.d?.length ?? 0) >= a.distinct.count;
		} else if (a.total) {
			const v = read(ctx, a.total.of);
			if (hit && finite(v)) s.p[a.id] = (finite(s.p[a.id]) ? s.p[a.id] : 0) + v;
			done = (s.p[a.id] ?? 0) >= a.total.atLeast;
		} else done = hit;
		if (done) {
			s.a[a.id] = now;
			delete s.p[a.id];
			unlocked.push(a);
		}
	}
	for (const rec of rules?.records ?? []) {
		if (!rec?.id || !BESTS.includes(rec.best) || !test(rec.when, ctx)) continue;
		let group = "";
		if (rec.by) {
			const g = read(ctx, rec.by);
			if (g == null || !scalar(g)) continue;
			group = String(g).slice(0, LIMITS.text);
			if (!okGroup(group)) continue; // "__proto__" would set the object's prototype
		}
		const held = isObj(s.r[rec.id]) && s.r[rec.id].b === rec.best ? s.r[rec.id] : { b: rec.best, v: {} };
		const v = { ...held.v };
		if (!own(v, group) && Object.keys(v).length >= LIMITS.groups) continue;
		const prev = own(v, group) ? v[group] : undefined;
		if (rec.best === "count") v[group] = (finite(prev) ? prev : 0) + 1;
		else if (rec.best === "days") v[group] = nextDays(prev, day);
		else {
			const x = read(ctx, rec.of);
			if (!finite(x)) continue;
			if (rec.best === "sum") v[group] = (finite(prev) ? prev : 0) + x;
			else if (!finite(prev) || (rec.best === "min" ? x < prev : x > prev)) {
				v[group] = x;
				if (finite(prev)) improved.push({ record: rec, group, value: x, prev });
			}
		}
		s.r[rec.id] = { b: rec.best, v };
	}
	return { state: s, unlocked, improved };
}

// ------------------------------------------------------------ the platform's own

/**
 * Achievements every player can earn across games, computed by the platform
 * (no game declares them). Kept under the game id "*", with
 * `{ n: games counted, ms: time played, g: [game ids], d: { last, cur, best } }`.
 */
export const PLATFORM = Object.freeze([
	{ id: "regular", title: "Regular", description: "Play 10 games.", glyph: "🎮", need: (t) => t.n >= 10, of: (t) => [t.n, 10] },
	{ id: "veteran", title: "Veteran", description: "Play 100 games.", glyph: "🎖️", need: (t) => t.n >= 100, of: (t) => [t.n, 100] },
	{ id: "week", title: "Seven Days", description: "Play on 7 days in a row.", glyph: "📅", need: (t) => (t.d?.cur ?? 0) >= 7, of: (t) => [t.d?.cur ?? 0, 7] },
	{
		id: "explorer",
		title: "Explorer",
		description: "Play every game you can play alone.",
		glyph: "🧭",
		need: (t, targets) => targets.length >= 2 && targets.every((id) => t.g.includes(id)),
		of: (t, targets) => [targets.filter((id) => t.g.includes(id)).length, targets.length],
	},
]);
export const PLATFORM_ID = "*";
const GAMES_KEPT = 200;

/**
 * The platform's state after a counted result of `game`: `{ state, unlocked }`.
 * `targets`: the games Explorer asks for (the catalog's games playable alone).
 */
export function stepPlatform(state, game, ms, targets = [], now = Date.now()) {
	const t = {
		a: { ...(state?.a ?? {}) },
		n: (finite(state?.n) ? state.n : 0) + 1,
		ms: (finite(state?.ms) ? state.ms : 0) + (finite(ms) && ms > 0 ? ms : 0),
		g: Array.isArray(state?.g) ? [...state.g] : [],
		d: nextDays(state?.d, dayOf(now)),
	};
	if (!t.g.includes(game) && t.g.length < GAMES_KEPT) t.g.push(game);
	const unlocked = [];
	for (const a of PLATFORM) {
		if (own(t.a, a.id) || !a.need(t, targets)) continue;
		t.a[a.id] = now;
		unlocked.push(a);
	}
	return { state: t, unlocked };
}

// ------------------------------------------------------------ cleaning and merging

const MAX = { a: 64, p: 64, r: 16 };
const okKey = (k) => ID.test(k);
// A group or a distinct value: short text, never "__proto__" (assigning it
// would set the object's prototype, not a key).
const okGroup = (k) => typeof k === "string" && k.length <= LIMITS.text && k !== "__proto__";
const okTime = (v) => finite(v) && v >= 0;
const okDays = (v) => isObj(v) && Number.isInteger(v.last) && Number.isInteger(v.cur) && Number.isInteger(v.best) && v.cur >= 0 && v.best >= v.cur;
const days = (v) => ({ last: v.last, cur: v.cur, best: v.best });
const entries = (o, max) => (isObj(o) ? Object.entries(o).slice(0, max) : []);

/** The stats a game's entry carries (lib/stats.js's record): numbers, and wins per bot count. */
function cleanStats(s) {
	if (!isObj(s)) return undefined;
	const out = {};
	for (const k of ["played", "won", "lost", "drawn", "vsBots", "vsPeople", "streak", "best", "last", "ms"]) if (okTime(s[k])) out[k] = s[k];
	if (finite(s.bestScore)) out.bestScore = s.bestScore;
	if (isObj(s.byBots)) {
		out.byBots = {};
		for (const [k, v] of entries(s.byBots, 16)) if (/^(?:[1-9]|1[0-5])$/.test(k) && Array.isArray(v) && v.length === 2 && v.every(okTime)) out.byBots[k] = [v[0], v[1]];
	}
	return out;
}

/**
 * One game's state with anything malformed dropped and every list bounded:
 * what the account stores (worker/api/records.js) and what a device takes
 * back from it. Never throws.
 */
export function clean(state, game = "") {
	if (!isObj(state)) state = {};
	if (game === PLATFORM_ID) {
		const out = { a: {} };
		for (const [k, v] of entries(state.a, MAX.a)) if (okKey(k) && okTime(v)) out.a[k] = v;
		if (okTime(state.n)) out.n = state.n;
		if (okTime(state.ms)) out.ms = state.ms;
		if (Array.isArray(state.g)) out.g = state.g.filter((id) => typeof id === "string" && id.length <= 72).slice(0, GAMES_KEPT);
		if (okDays(state.d)) out.d = days(state.d);
		return out;
	}
	const out = { a: {}, p: {}, r: {} };
	for (const [k, v] of entries(state.a, MAX.a)) if (okKey(k) && okTime(v)) out.a[k] = v;
	for (const [k, v] of entries(state.p, MAX.p)) {
		if (!okKey(k) || own(out.a, k)) continue;
		if (finite(v)) out.p[k] = v;
		else if (okDays(v)) out.p[k] = days(v);
		else if (isObj(v) && Array.isArray(v.d)) out.p[k] = { d: v.d.filter(okGroup).slice(0, LIMITS.distinct) };
	}
	for (const [k, rec] of entries(state.r, MAX.r)) {
		if (!okKey(k) || !isObj(rec) || !BESTS.includes(rec.b) || !isObj(rec.v)) continue;
		const v = {};
		for (const [g, x] of entries(rec.v, LIMITS.groups)) {
			if (!okGroup(g)) continue;
			if (rec.b === "days" ? okDays(x) : finite(x)) v[g] = rec.b === "days" ? days(x) : x;
		}
		out.r[k] = { b: rec.b, v };
	}
	const st = cleanStats(state.s);
	if (st) out.s = st;
	return fit(out, RECORD_BYTES);
}

/**
 * Within `limit` bytes of JSON, whatever was sent: progress goes first (the
 * largest entry each time), then record groups (the largest record's last
 * group). Unlocks and stats are always kept; at their bounds they fit.
 */
function fit(out, limit) {
	let size = JSON.stringify(out).length;
	while (size > limit) {
		const byP = Object.entries(out.p).sort(([, x], [, y]) => JSON.stringify(y).length - JSON.stringify(x).length)[0];
		if (byP) delete out.p[byP[0]];
		else {
			const byR = Object.entries(out.r).sort(([, x], [, y]) => Object.keys(y.v).length - Object.keys(x.v).length)[0];
			const groups = byR ? Object.keys(byR[1].v) : [];
			if (!groups.length) break;
			delete byR[1].v[groups.at(-1)];
		}
		size = JSON.stringify(out).length;
	}
	return out;
}

const later = (x, y) => (x.last !== y.last ? (x.last > y.last ? x : y) : x.cur >= y.cur ? x : y);
const mergeDays = (x, y) => (x && y ? { ...later(x, y), best: Math.max(x.best, y.best) } : (x ?? y));
const earliest = (x = {}, y = {}) => {
	const out = { ...x };
	for (const [k, v] of Object.entries(y)) out[k] = own(out, k) ? Math.min(out[k], v) : v;
	return out;
};

/**
 * Two copies of one game's state (a device's and the account's, or two
 * devices') as one, taking the best of each: an achievement unlocked in
 * either (at the earlier time), the larger count, the longer run of days,
 * the better record. Counts from two devices are not added: each device's
 * own count is a lower bound, and adding would count a synced game twice.
 */
export function merge(x, y, game = "", { prefer = "x" } = {}) {
	const a = clean(x, game);
	const b = clean(y, game);
	if (game === PLATFORM_ID) {
		const out = { a: earliest(a.a, b.a) };
		const n = Math.max(a.n ?? 0, b.n ?? 0);
		if (n) out.n = n;
		const ms = Math.max(a.ms ?? 0, b.ms ?? 0);
		if (ms) out.ms = ms;
		const g = [...new Set([...(a.g ?? []), ...(b.g ?? [])])].slice(0, GAMES_KEPT);
		if (g.length) out.g = g;
		const d = mergeDays(a.d, b.d);
		if (d) out.d = d;
		return clean(out, game);
	}
	const out = { a: earliest(a.a, b.a), p: {}, r: {} };
	for (const k of new Set([...Object.keys(a.p), ...Object.keys(b.p)])) {
		if (own(out.a, k)) continue;
		const u = a.p[k];
		const v = b.p[k];
		if (u == null || v == null) out.p[k] = u ?? v;
		else if (finite(u) && finite(v)) out.p[k] = Math.max(u, v);
		else if (okDays(u) && okDays(v)) out.p[k] = mergeDays(u, v);
		else if (Array.isArray(u.d) && Array.isArray(v.d)) out.p[k] = { d: [...new Set([...u.d, ...v.d])].slice(0, LIMITS.distinct) };
		else out.p[k] = u;
	}
	for (const k of new Set([...Object.keys(a.r), ...Object.keys(b.r)])) {
		const u = a.r[k];
		const v = b.r[k];
		if (!u || !v || u.b !== v.b) {
			// A record whose kind changed (an author's edit): `prefer` names the
			// side that knows the manifest — the device, which is `y` on the Worker.
			out.r[k] = !u ? v : !v ? u : prefer === "y" ? v : u;
			continue;
		}
		const vals = { ...u.v };
		for (const [g, y] of Object.entries(v.v)) {
			const w = vals[g];
			if (!own(vals, g)) {
				if (Object.keys(vals).length < LIMITS.groups) vals[g] = y;
			} else if (u.b === "days") vals[g] = mergeDays(w, y);
			else vals[g] = u.b === "min" ? Math.min(w, y) : Math.max(w, y);
		}
		out.r[k] = { b: u.b, v: vals };
	}
	if (a.s || b.s) {
		const s = { ...(a.s ?? {}) };
		for (const [k, v] of Object.entries(b.s ?? {})) {
			if (k === "byBots") {
				const by = { ...(s.byBots ?? {}) };
				for (const [n, pair] of Object.entries(v)) by[n] = by[n] ? [Math.max(by[n][0], pair[0]), Math.max(by[n][1], pair[1])] : pair;
				s.byBots = by;
			} else if (k !== "streak") s[k] = own(s, k) ? Math.max(s[k], v) : v;
		}
		// The streak is the one played last (a tie keeps this side's).
		const streak = (b.s?.last ?? -1) > (a.s?.last ?? -1) ? b.s.streak : (a.s?.streak ?? b.s?.streak);
		if (streak != null) s.streak = streak;
		out.s = s;
	}
	return clean(out, game); // the union, bounded and within RECORD_BYTES again
}

/** How many achievements a whole state (`{ [game]: state }`) has unlocked. */
export const unlockedCount = (all) => (isObj(all) ? Object.values(all).reduce((n, g) => n + (isObj(g?.a) ? Object.keys(g.a).length : 0), 0) : 0);
