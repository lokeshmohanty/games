#!/usr/bin/env node
/**
 * test-undercover.mjs — the deal, the win conditions, and the table sizes.
 *
 *   node scripts/test-undercover.mjs
 *
 * Undercover has almost no code in it, because almost none of the game is the
 * phone's job — the describing and the arguing happen between people. What the
 * phone owns is the deal and the arithmetic of who has won, and the arithmetic
 * is where the trouble was.
 *
 * The undercovers win at parity, so a table has to survive **one wrong vote**
 * or it is not a game. Five players with one undercover and a blank does not:
 * three civilians against two, over the moment the table guesses wrong, before
 * anybody has spoken twice. That is not a crash and not a visible bug — it just
 * feels like a game that keeps ending — so the sizes are checked here as a
 * property rather than eyeballed.
 */
import { readFileSync } from "node:fs";

globalThis.window = globalThis;
globalThis.location = { href: "file:///x", hash: "", pathname: "/x", search: "" };
globalThis.history = { replaceState() {} };
for (const f of ["../lib/net.js", "../lib/games.js", "../games/undercover.js"]) {
	new Function(readFileSync(new URL(f, import.meta.url), "utf8"))();
}
const R = globalThis.NeonArcade.undercoverRules;
const { PAIRS, MIN_PLAYERS, MAX_PLAYERS, defaultSpies, maxOthers, maxSpies, blankAllowed, dealRoles, winner } = R;

let failures = 0;
const check = (label, ok, detail = "") => {
	console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
	if (!ok) failures++;
};

const names = (n) => Array.from({ length: n }, (_, i) => `P${i + 1}`);

// ---------------------------------------------------------------------------
console.log("\nthe word list");

{
	check("there are plenty of pairs", PAIRS.length >= 40, `${PAIRS.length}`);
	check("every pair has two words", PAIRS.every((p) => p.length === 2 && p[0] && p[1]));
	check("no pair is the same word twice", PAIRS.every((p) => p[0].toLowerCase() !== p[1].toLowerCase()));
	const flat = PAIRS.flat().map((w) => w.toLowerCase());
	// A word appearing in two pairs would let a player who has seen it before
	// rule out the other half.
	const dupes = flat.filter((w, i) => flat.indexOf(w) !== i);
	check("no word appears in two pairs", dupes.length === 0, [...new Set(dupes)].join(", "));
}

// ---------------------------------------------------------------------------
console.log("\nthe deal");

{
	const { players, civilianWord, spyWord } = dealRoles(names(6), 2, true);
	check("everybody gets a role", players.length === 6);
	check("the right number of undercovers", players.filter((p) => p.role === "spy").length === 2);
	check("exactly one blank when asked for", players.filter((p) => p.role === "blank").length === 1);
	check("the rest are civilians", players.filter((p) => p.role === "civilian").length === 3);
	check("civilians all share one word",
		players.filter((p) => p.role === "civilian").every((p) => p.word === civilianWord));
	check("undercovers share the other one",
		players.filter((p) => p.role === "spy").every((p) => p.word === spyWord));
	check("the two words are different", civilianWord !== spyWord);
	check("the blank gets nothing at all",
		players.find((p) => p.role === "blank").word === null);
	check("names survive the deal", players.map((p) => p.name).join() === names(6).join());
	check("nobody starts eliminated", players.every((p) => p.out === false));
}

{
	const { players } = dealRoles(names(5), 1, false);
	check("no blank unless asked for", players.every((p) => p.role !== "blank"));
	check("one undercover, four civilians",
		players.filter((p) => p.role === "spy").length === 1
		&& players.filter((p) => p.role === "civilian").length === 4);
}

{
	// Which half of the pair the civilians get must be random. If the civilians
	// always got `pair[0]`, anybody who had seen the word list twice could work
	// out their own role from the word alone.
	const seen = new Set();
	for (let i = 0; i < 400; i++) {
		const d = dealRoles(names(4), 1, false);
		const pair = PAIRS.find((p) => p.includes(d.civilianWord));
		seen.add(pair.indexOf(d.civilianWord));
	}
	check("the civilians' word is not always the same half of the pair", seen.size === 2, [...seen].join(","));
}

{
	// Roles must move around, or the first player is always safe.
	const firstRoles = new Set();
	for (let i = 0; i < 300; i++) firstRoles.add(dealRoles(names(5), 1, false).players[0].role);
	check("the first-named player is not always a civilian", firstRoles.size === 2, [...firstRoles].join(","));
}

// ---------------------------------------------------------------------------
console.log("\nwho has won");

const table = (civ, spy, blank = 0) => [
	...Array(civ).fill({ role: "civilian" }),
	...Array(spy).fill({ role: "spy" }),
	...Array(blank).fill({ role: "blank" }),
].map((p) => ({ ...p, out: false }));

{
	check("a fresh table is undecided", winner(table(4, 1)) === null);
	check("civilians win once every undercover is out", (() => {
		const t = table(3, 1);
		t.find((p) => p.role === "spy").out = true;
		return winner(t) === "civilians";
	})());
	check("undercovers win at parity", (() => {
		const t = table(2, 2);
		return winner(t) === "spies";
	})());
	check("and when they outnumber", winner(table(1, 2)) === "spies");
	// The blank is one more person the civilians must find, so it counts toward
	// parity — but it does not win with the undercovers.
	check("a blank counts against the civilians", winner(table(2, 1, 1)) === "spies");
	check("a table with a blank is undecided while civilians lead", winner(table(4, 1, 1)) === null);
	check("civilians must clear the blank too", (() => {
		const t = table(3, 1, 1);
		t.find((p) => p.role === "spy").out = true;
		return winner(t) === null; // the blank is still in
	})());
	check("eliminated players stop counting", (() => {
		const t = table(3, 2);
		t.filter((p) => p.role === "spy").forEach((p) => (p.out = true));
		return winner(t) === "civilians";
	})());
}

// ---------------------------------------------------------------------------
console.log("\ntable sizes");

{
	// The property: after one wrong vote there must still be more civilians than
	// everybody else, or the first mistake ends the game.
	const bad = [];
	for (let n = 4; n <= MAX_PLAYERS; n++) {
		for (const blank of [false, true]) {
			if (blank && !blankAllowed(n)) continue;
			const others = maxSpies(n, blank) + (blank ? 1 : 0);
			const civilians = n - others;
			if (civilians - 1 <= others) bad.push(`${n}${blank ? "+blank" : ""}: ${civilians}v${others}`);
		}
	}
	check("every table from four up survives a wrong vote", bad.length === 0, bad.join(", "));

	check("three players is the floor", MIN_PLAYERS === 3);
	check("a blank needs six", !blankAllowed(5) && blankAllowed(6));
	check("there is always at least one undercover",
		[...Array(MAX_PLAYERS + 1).keys()].slice(MIN_PLAYERS).every((n) => maxSpies(n, false) >= 1));
	check("the default never exceeds the ceiling",
		[...Array(MAX_PLAYERS + 1).keys()].slice(MIN_PLAYERS).every(
			(n) => defaultSpies(n, false) <= maxSpies(n, false) && defaultSpies(n, true) <= maxSpies(n, true),
		));
	check("bigger tables carry more undercovers", maxOthers(12) > maxOthers(6) && maxOthers(6) > maxOthers(4));
}

// ---------------------------------------------------------------------------
console.log("\na game played out");

/**
 * Play a whole hand where the table votes at random — the worst case, and the
 * one that shows whether a game can run forever or end in a state nobody wins.
 */
function playRandom(n, spyCount, blank, rng = Math.random) {
	const { players } = dealRoles(names(n), spyCount, blank, rng);
	for (let round = 0; round < 40; round++) {
		const done = winner(players);
		if (done) return { done, rounds: round };
		const alive = players.filter((p) => !p.out);
		if (!alive.length) return { done: "nobody", rounds: round };
		alive[Math.floor(rng() * alive.length)].out = true;
	}
	return { done: "stuck", rounds: 40 };
}

{
	const outcomes = new Map();
	let stuck = 0;
	for (let i = 0; i < 600; i++) {
		const n = 4 + (i % 9);
		const blank = blankAllowed(n) && i % 3 === 0;
		const { done } = playRandom(n, maxSpies(n, blank), blank);
		if (done === "stuck" || done === "nobody") stuck++;
		outcomes.set(done, (outcomes.get(done) ?? 0) + 1);
	}
	check("every hand reaches a result", stuck === 0, `${stuck} did not`);
	check("both sides can win",
		(outcomes.get("civilians") ?? 0) > 0 && (outcomes.get("spies") ?? 0) > 0,
		[...outcomes.entries()].map(([k, v]) => `${k}:${v}`).join(" "));
	// Voting at random should mostly lose: if civilians won by luck as often as
	// not, the deduction would be doing nothing.
	const civWins = (outcomes.get("civilians") ?? 0) / 600;
	console.log(`  ·    voting at random, civilians win ${(civWins * 100).toFixed(0)}% of hands`);
	check("random voting is not a winning strategy", civWins < 0.4, `${(civWins * 100).toFixed(0)}%`);
}

console.log(failures ? `\n${failures} failing\n` : "\nall passing\n");
process.exit(failures ? 1 : 0);
