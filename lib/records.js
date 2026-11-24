// lib/records.js — personal records and achievements on this device, synced
// to the account when signed in, and the panels that show them.
//
// Lokesh, 2026-11-21: "a personal record table and achievements so that
// single player games are also fun and feel rewarding." Every game you can
// play alone (puzzles, and every game against bots) declares its own in
// game.json, as conditions on its end-of-game result; the platform checks
// them here, keeps them, and shows unlocks. The rules are lib/achievements.js
// (shared with the manifest check and the Worker); docs/platform.md
// "Achievements and records" is the author's guide.
//
// The device's word is taken (memory casual-not-competitive: UX >
// performance >>> anti-cheat): nothing here is checked by anyone else, and
// there is no ranking — friends see your trophies and best times on your
// profile and in the party (docs/accounts.md "Records and achievements").
//
//   NeonArcade.records.count(game, r, …)   lib/stats.js, for each result it counted
//   NeonArcade.records.read()              { [game]: state }; "*" is the platform's
//   NeonArcade.records.sheet(game)         "Your records" over the game (🏆 in the top band)
//   NeonArcade.records.trophies(data, …)   the profile's section, for you or a friend
//   NeonArcade.records.friendSheet(id, n)  a friend's trophies (their profile's data)
//
// Storage: localStorage "neon.records" = { games: { [game]: state }, dirty:
// [game], v: { [game]: version }, owner: account id | null }. `dirty`:
// changed here since the account last took them; `v` counts each game's
// changes, so a change made while its PUT was in flight stays dirty.
// `owner`: the account this device's records (and lib/stats.js's) belong to.
// A device played on signed out has none, and the first account to sign in
// takes it; another account signing in never gets them — they are set aside
// ("neon.records.aside", one per account) and come back with their owner.

import { PLATFORM, PLATFORM_ID, RECORD_BYTES, clean, contextOf, fit, merge, step, stepPlatform } from "./achievements.js";

window.NeonArcade = window.NeonArcade || {};

const KEY = "neon.records";
const PUSH_MS = 1500;
const ASIDE = "neon.records.aside";
const PUT_MAX = 16; // games per PUT: a body of at most 64 KB keeps the Worker's CPU in its budget

const loadAll = () => {
	try {
		const v = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? "null");
		if (!v || typeof v !== "object" || !v.games || typeof v.games !== "object") return { games: {}, dirty: [], v: {}, owner: null };
		return { games: v.games, dirty: Array.isArray(v.dirty) ? v.dirty : [], v: v.v && typeof v.v === "object" ? v.v : {}, owner: typeof v.owner === "string" ? v.owner : null };
	} catch {
		return { games: {}, dirty: [], v: {}, owner: null };
	}
};
const saveAll = (all) => {
	try {
		globalThis.localStorage?.setItem(KEY, JSON.stringify(all));
	} catch {
		// Private mode or full: this page still has it in memory until it closes.
	}
};
const readAside = () => {
	try {
		const v = JSON.parse(globalThis.localStorage?.getItem(ASIDE) ?? "null");
		return v && typeof v === "object" ? v : {};
	} catch {
		return {};
	}
};
const writeAside = (v) => {
	try {
		globalThis.localStorage?.setItem(ASIDE, JSON.stringify(v));
	} catch {}
};

const catalog = () => [...(NeonArcade.CATALOG ?? []), ...(NeonArcade.UNLISTED ?? [])];
const metaOf = (id) => catalog().find((g) => g.id === id) ?? NeonArcade.getGame?.(id) ?? null;
const titleOf = (id) => metaOf(id)?.title ?? metaOf(id)?.name ?? id;
/** A game's declared rules: `{ achievements, records }` from its manifest. */
const rulesOf = (id) => {
	const m = metaOf(id);
	return { achievements: Array.isArray(m?.achievements) ? m.achievements : [], records: Array.isArray(m?.records) ? m.records : [] };
};
/**
 * The games Explorer asks for: every listed game you can play alone (bots,
 * or one seat), whatever its section — Tic Tac Toe (JS) is listed as a game.
 * The other language lanes of the SDK's example are unlisted, so not asked for.
 */
const soloGames = () =>
	(NeonArcade.CATALOG ?? []).filter((g) => g.kind !== "shared" && !g.local && !g.app && (g.bots !== false || g.seats?.min === 1)).map((g) => g.id);

const listeners = new Set();
const changed = () => {
	for (const fn of listeners) {
		try {
			fn();
		} catch (err) {
			console.error(err);
		}
	}
};

// ------------------------------------------------------------ counting

/**
 * A result lib/stats.js counted for `me`: achievements and records for its
 * game, and the platform's own. `how` is stats' outcome, `rec` the game's
 * stats after it (its win streak), `ms` how long it took if known.
 */
function count(game, r, { me, isBot, how, ms = null, rec = null } = {}) {
	if (!game || String(game).startsWith("dev/")) return null;
	const ctx = contextOf(r, { me, outcome: how, isBot, ms, streak: rec?.streak ?? 0 });
	if (!ctx) return null;
	const all = loadAll();
	const now = Date.now();
	const mine = step(all.games[game], rulesOf(game), ctx, now);
	const plat = stepPlatform(all.games[PLATFORM_ID], game, ctx.ms, soloGames(), now);
	all.games[game] = mine.state;
	all.games[PLATFORM_ID] = plat.state;
	all.dirty = [...new Set([...all.dirty, game, PLATFORM_ID])];
	for (const g of [game, PLATFORM_ID]) all.v[g] = (all.v[g] ?? 0) + 1;
	saveAll(all);
	announce([...mine.unlocked, ...plat.unlocked], mine.improved);
	changed();
	schedulePush();
	return { unlocked: [...mine.unlocked, ...plat.unlocked], improved: mine.improved };
}

/** Never blocking: a notice over whatever is on screen (the end card included). */
function announce(unlocked, improved) {
	if (unlocked.length) {
		const names = unlocked.map((a) => `${a.glyph ? `${a.glyph} ` : ""}${a.title}`).join(" · ");
		NeonArcade.toast?.(`🏆 Unlocked: ${names}`, "good");
	}
	for (const { record, group, value } of improved.slice(0, 1)) {
		NeonArcade.toast?.(`New best — ${record.title}${group ? ` (${groupLabel(group, record.by)})` : ""}: ${shown(record, value)}`, "good");
	}
}

// ------------------------------------------------------------ the account

let pushing = null;
let syncing = null;
const A = () => NeonArcade.account;
const signedInNow = () => !!A()?.me;

function schedulePush() {
	if (!signedInNow()) return;
	clearTimeout(pushing);
	pushing = setTimeout(() => push().catch(() => {}), PUSH_MS);
}

/** The account's form of a game: its state, with lib/stats.js's record beside it (`s`). */
function outgoing(all, game) {
	const st = NeonArcade.stats?.read?.()[game];
	const out = clean({ ...(all.games[game] ?? {}), ...(st && game !== PLATFORM_ID ? { s: st } : {}) }, game);
	return game === PLATFORM_ID ? out : fit(out, RECORD_BYTES); // the Worker refuses a larger one
}

/** Take the account's copy of some games: the best of both, here. */
function take(games) {
	const all = loadAll();
	for (const [game, theirs] of Object.entries(games ?? {})) {
		if (typeof game !== "string") continue;
		const { s, ...kept } = merge(all.games[game], theirs, game);
		all.games[game] = kept;
		if (s && game !== PLATFORM_ID) NeonArcade.stats?.mergeIn?.(game, s);
	}
	saveAll(all);
	return all;
}

/**
 * Send what changed here; the server merges and answers its copy, which we
 * take. A game is unmarked only if it did not change while its PUT was in
 * flight (its version is the one sent), or the server refused it (per game,
 * `rejected`, or the whole request with a 4xx): a refused game would be
 * refused again, and must not hold up the rest.
 */
async function push() {
	if (!signedInNow() || loadAll().owner !== A().me.id) return;
	const dirty = loadAll().dirty.filter((g) => loadAll().games[g]);
	for (let i = 0; i < dirty.length; i += PUT_MAX) await send(dirty.slice(i, i + PUT_MAX));
	changed();
}

/**
 * One PUT of `part`. A 413 (the request too large) halves it and sends each
 * half; a single game still refused so is dropped, like any refused game.
 */
async function send(part) {
	let all = loadAll();
	const games = Object.fromEntries(part.map((g) => [g, outgoing(all, g)]));
	const sent = Object.fromEntries(part.map((g) => [g, all.v[g] ?? 0]));
	let res;
	try {
		res = await A().api("/api/me/records", { method: "PUT", body: { games } });
	} catch (err) {
		if (err?.status === 413 && part.length > 1) {
			const half = Math.ceil(part.length / 2);
			await send(part.slice(0, half));
			return send(part.slice(half));
		}
		if (!(err?.status >= 400 && err.status < 500) || err.status === 401 || err.status === 429) throw err;
		console.warn("records: refused", part.join(", "), err.message);
		res = { games: {}, rejected: Object.fromEntries(part.map((g) => [g, err.message])) };
	}
	all = take(res.games);
	const refused = res.rejected && typeof res.rejected === "object" ? res.rejected : {};
	for (const g of Object.keys(refused)) console.warn(`records: ${g} refused (${refused[g]})`);
	// "busy" (it lost every race on the server) is not a refusal: it goes again.
	const dropped = (g) => g in refused && !/^busy/.test(String(refused[g]));
	all.dirty = all.dirty.filter((g) => !part.includes(g) || (!dropped(g) && ((all.v[g] ?? 0) !== sent[g] || g in refused)));
	saveAll(all);
}

/**
 * This device's records and stats are another account's (or nobody's):
 * make them `id`'s. Nobody's become `id`'s (played signed out, then signed
 * in). Another account's are set aside, under that account, and `id`'s own
 * set-aside copy (if it played here before) comes back — so one account's
 * play never reaches another's account, however the device is shared.
 */
function own(id) {
	const all = loadAll();
	if (all.owner === id) return;
	if (all.owner === null) {
		all.owner = id;
		return saveAll(all);
	}
	const aside = readAside();
	aside[all.owner] = { games: all.games, dirty: all.dirty, v: all.v, stats: NeonArcade.stats?.read?.() ?? {} };
	const back = aside[id];
	delete aside[id];
	writeAside(aside);
	saveAll({ games: back?.games ?? {}, dirty: back?.dirty ?? [], v: back?.v ?? {}, owner: id });
	NeonArcade.stats?.replaceAll?.(back?.stats ?? {});
	changed();
}

/**
 * Signed in (now, or on this page's load): the account's records and this
 * device's become one — each side gets the best of both. A server from
 * before records answers 404: everything stays on the device.
 */
function sync() {
	if (!signedInNow()) return Promise.resolve();
	syncing ??= (async () => {
		try {
			own(A().me.id);
			const res = await A().api("/api/me/records");
			const all = take(res.games);
			// Whatever the account lacks or has worse goes up.
			const theirs = res.games ?? {};
			for (const g of Object.keys(all.games)) {
				if (JSON.stringify(outgoing(all, g)) !== JSON.stringify(clean(theirs[g], g))) all.dirty.push(g);
			}
			all.dirty = [...new Set(all.dirty)];
			saveAll(all);
			await push();
		} catch (err) {
			if (err?.status !== 404) console.warn("records:", err?.message ?? err);
		} finally {
			syncing = null;
		}
	})();
	return syncing;
}

// ------------------------------------------------------------ showing

const el = (tag, cls, text) => {
	const n = document.createElement(tag);
	if (cls) n.className = cls;
	if (text != null) n.textContent = text;
	return n;
};
const clock = (ms) => {
	const t = Math.max(0, Math.round(ms / 1000));
	const h = Math.floor(t / 3600);
	const m = Math.floor(t / 60) % 60;
	const s = String(t % 60).padStart(2, "0");
	return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
};
/** A record's group as people read it: "Easy", "4 players", "3 bots". */
const groupLabel = (g, by = null) =>
	by === "seats" ? `${g} players`
	: by === "bots" ? `${g} ${g === "1" ? "bot" : "bots"}`
	: by === "people" ? `${g} ${g === "1" ? "person" : "people"}`
	: g === "true" ? "yes"
	: g === "false" ? "no"
	: `${g[0].toUpperCase()}${g.slice(1)}`;
/** A record's value as people read it: a time, or a number with its unit. */
function shown(record, value) {
	if (value && typeof value === "object") return `${value.cur} now · best ${value.best} ${value.best === 1 ? "day" : "days"}`;
	if (typeof value !== "number") return "—";
	if (record.format === "time") return clock(value);
	const n = Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, { maximumFractionDigits: 1 });
	return record.unit ? `${n} ${record.unit}` : n;
}
const date = (t) => new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });

/** One achievement as a row: a shape and a word for its state, never a colour alone. */
function trophyRow(a, state, extra = null) {
	const at = state?.a?.[a.id];
	const li = el("li", `trophy${at ? " is-unlocked" : " is-locked"}`);
	li.dataset.trophy = a.id;
	const mark = el("span", "trophy-mark", at ? "✓" : "🔒");
	mark.setAttribute("aria-hidden", "true");
	const glyph = el("span", "trophy-glyph", a.glyph ?? "🏆");
	glyph.setAttribute("aria-hidden", "true");
	const text = el("span", "trophy-text");
	text.append(el("span", "trophy-title", a.title));
	if (a.description) text.append(el("span", "trophy-desc", a.description));
	const status = el("span", "trophy-status", at ? `UNLOCKED · ${date(at)}` : `LOCKED${extra ? ` · ${extra}` : ""}`);
	text.append(status);
	li.append(mark, glyph, text);
	return li;
}
/** How far a locked achievement has got, as "37 / 100", or null. */
function progressOf(a, state) {
	const p = state?.p?.[a.id];
	if (a.count) return `${Math.min(p ?? 0, a.count)} / ${a.count}`;
	if (a.streak) return `${p ?? 0} / ${a.streak} in a row`;
	if (a.days) return `${p?.cur ?? 0} / ${a.days} days`;
	if (a.distinct) return `${p?.d?.length ?? 0} / ${a.distinct.count}`;
	if (a.total) return `${Math.floor(p ?? 0).toLocaleString()} / ${a.total.atLeast.toLocaleString()}`;
	return null;
}

function table(rows, cls) {
	const t = el("table", `records-table ${cls ?? ""}`.trim());
	const tb = el("tbody");
	for (const [k, v] of rows) {
		const tr = el("tr");
		tr.append(el("th", null, k), el("td", null, v));
		tb.append(tr);
	}
	t.append(tb);
	return t;
}

/** The platform's rows for a game, from lib/stats.js's record: played, won, streak, per bot count, time. */
function statRows(s) {
	if (!s?.played) return [];
	const rate = (w, p) => (p ? `${Math.round((100 * w) / p)}%` : "—");
	const rows = [
		["Played", String(s.played)],
		["Won", `${s.won ?? 0} (${rate(s.won ?? 0, s.played)})`],
		["Best win streak", String(s.best ?? 0)],
	];
	for (const [n, [p, w]] of Object.entries(s.byBots ?? {}).sort(([a], [b]) => a - b)) {
		rows.push([`Against ${n} ${n === "1" ? "bot" : "bots"}`, `${w} of ${p} won (${rate(w, p)})`]);
	}
	if (s.ms) rows.push(["Time played", clock(s.ms)]);
	return rows;
}

/**
 * A game's records and achievements, for you (`data` absent: this device) or
 * a friend (`data`: their synced `{ [game]: state }`, stats in `s`).
 */
function panel(game, data = null) {
	const box = el("div", "records-panel");
	box.dataset.records = game;
	const state = data ? data[game] : loadAll().games[game];
	const stats = data ? data[game]?.s : NeonArcade.stats?.read?.()[game];
	const { achievements, records } = rulesOf(game);
	const got = achievements.filter((a) => state?.a?.[a.id]).length;

	const recRows = [];
	for (const r of records) {
		const vals = state?.r?.[r.id]?.v ?? {};
		const groups = Object.keys(vals);
		if (!groups.length) recRows.push([r.title, "—"]);
		for (const g of groups.sort()) recRows.push([g ? `${r.title} · ${groupLabel(g, r.by)}` : r.title, shown(r, vals[g])]);
	}
	const rows = [...recRows, ...statRows(stats)];
	box.append(el("h3", null, "Records"));
	box.append(rows.length ? table(rows) : el("p", "records-empty", data ? "Nothing yet." : "Play a game to set your first record."));

	if (achievements.length) {
		const h = el("h3", null, "Achievements");
		h.append(el("span", "records-count", ` ${got} of ${achievements.length}`));
		box.append(h);
		const list = el("ul", "trophies");
		// Unlocked first, then the rest as the game lists them.
		for (const a of [...achievements].sort((x, y) => !!state?.a?.[y.id] - !!state?.a?.[x.id])) list.append(trophyRow(a, state, data ? null : progressOf(a, state)));
		box.append(list);
	}
	return box;
}

/** The platform's achievements, for you or a friend. */
function platformList(data = null) {
	const t = data ? data[PLATFORM_ID] : loadAll().games[PLATFORM_ID];
	const all = { n: 0, g: [], d: null, ...(t ?? {}) };
	const targets = soloGames();
	const list = el("ul", "trophies");
	for (const a of PLATFORM) {
		const [n, of] = a.of(all, targets);
		list.append(trophyRow(a, t, data ? null : `${Math.min(n, of)} / ${of}`));
	}
	return list;
}

/** A sheet over the page: the account layer's when it is loaded, else its own. */
function openSheet(title) {
	const s = NeonArcade.accountUi?.sheet?.(title);
	if (s) {
		s.dialog.classList.add("records-sheet");
		return s;
	}
	document.querySelector("dialog.neon-sheet")?.remove();
	const d = el("dialog", "neon-sheet records-sheet");
	const head = el("div", "neon-sheet-head");
	const x = el("button", "neon-sheet-x", "✕");
	x.type = "button";
	x.setAttribute("aria-label", "Close");
	x.onclick = () => d.close();
	head.append(el("h2", null, title), x);
	const body = el("div", "neon-sheet-body");
	d.append(head, body);
	d.addEventListener("close", () => d.remove());
	d.addEventListener("click", (e) => e.target === d && d.close());
	document.body.append(d);
	d.showModal();
	return { dialog: d, body };
}

/** "Your records" for a game, over whatever is on screen (the game keeps running). */
function sheet(game) {
	const { dialog, body } = openSheet(`${titleOf(game)} — your records`);
	dialog.dataset.game = game;
	const paint = () => body.replaceChildren(panel(game));
	paint();
	const off = onChange(paint);
	dialog.addEventListener("close", off);
	return dialog;
}

/**
 * The profile's section: the platform's achievements, then each game with
 * something in it, its trophies counted; a game opens its panel.
 * `data`: a friend's `{ [game]: state }`, else this device's.
 */
function trophies(data = null, { name = null } = {}) {
	const wrap = el("div", "records-trophies");
	const games = data ?? loadAll().games;
	const stats = data ? null : NeonArcade.stats?.read?.() ?? {};
	const ids = [...new Set([...Object.keys(games), ...Object.keys(stats ?? {})])].filter((g) => g !== PLATFORM_ID && metaOf(g));
	const total = ids.reduce((n, g) => n + Object.keys(games[g]?.a ?? {}).length, 0) + Object.keys(games[PLATFORM_ID]?.a ?? {}).length;
	wrap.append(el("p", "records-total", `${total} ${total === 1 ? "trophy" : "trophies"}${name ? "" : " unlocked"}`));
	wrap.append(platformList(data));
	if (!ids.length) {
		wrap.append(el("p", "records-empty", data ? "No games played yet." : "Play a game to start your records."));
		return wrap;
	}
	const list = el("div", "records-games");
	const played = (g) => (data ? data[g]?.s?.played : stats[g]?.played) ?? 0;
	for (const g of ids.sort((a, b) => played(b) - played(a))) {
		const { achievements } = rulesOf(g);
		const got = achievements.filter((a) => games[g]?.a?.[a.id]).length;
		const b = el("button", "records-game");
		b.type = "button";
		b.dataset.game = g;
		b.append(el("span", "records-game-title", titleOf(g)), el("span", "records-game-count", achievements.length ? `🏆 ${got} / ${achievements.length}` : `${played(g)} played`));
		b.setAttribute("aria-label", `${titleOf(g)}: ${achievements.length ? `${got} of ${achievements.length} trophies` : `${played(g)} played`}. Open records`);
		b.onclick = () => {
			const { dialog, body } = openSheet(name ? `${name} — ${titleOf(g)}` : `${titleOf(g)} — your records`);
			dialog.dataset.game = g;
			body.append(panel(g, data));
		};
		list.append(b);
	}
	wrap.append(list);
	return wrap;
}

/** A friend's trophies, from their profile (worker/api/people.js: friends only). */
async function friendSheet(who, name) {
	const { dialog, body } = openSheet(`${name ?? "Friend"} — trophies`);
	dialog.dataset.friend = who;
	body.append(el("p", "records-empty", "Loading…"));
	try {
		const p = await A().api(`/api/u/${encodeURIComponent(who)}`);
		if (!dialog.isConnected) return;
		body.replaceChildren(p.records ? trophies(p.records, { name: p.name ?? name }) : el("p", "records-empty", "Only friends see each other's trophies."));
	} catch (err) {
		if (dialog.isConnected) body.replaceChildren(el("p", "records-empty", `Could not load them (${err.message}).`));
	}
}

function onChange(fn) {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

NeonArcade.records = {
	count,
	read: () => loadAll().games,
	rulesOf,
	soloGames,
	sync,
	push,
	panel,
	sheet,
	trophies,
	friendSheet,
	shown,
	has: (game) => !!metaOf(game) && metaOf(game).kind !== "shared" && !metaOf(game).app,
	onChange,
};

// Signed in now or later: one copy. Another tab's change: repaint.
A()?.onChange?.((me) => me && sync());
if (A()?.me) sync();
globalThis.addEventListener?.("storage", (e) => e.key === KEY && changed());
