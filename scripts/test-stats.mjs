// scripts/test-stats.mjs — lib/stats.js with no browser: how a result reads
// for each kind of game, that a repeated report counts once and a rematch
// counts again, streaks, bots vs people, favourites and recently played.

import { readFileSync } from "node:fs";

const store = new Map();
globalThis.window = globalThis;
globalThis.localStorage = {
	getItem: (k) => (store.has(k) ? store.get(k) : null),
	setItem: (k, v) => store.set(k, String(v)),
	removeItem: (k) => store.delete(k),
};
new Function(readFileSync(new URL("../lib/stats.js", import.meta.url), "utf8"))();
const S = globalThis.NeonArcade.stats;

let failures = 0;
const check = (label, ok, detail = "") => {
	console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
	if (!ok) failures++;
};

console.log("\nstats: what a result means for me");
check("a duel I won", S.outcome({ kind: "duel", ranking: [["me"], ["bot_1"]] }, "me") === "won");
check("a duel I lost", S.outcome({ kind: "duel", ranking: [["x"], ["me"]] }, "me") === "lost");
check("a draw: everyone in one slot", S.outcome({ kind: "duel", ranking: [["me", "x"]] }, "me") === "drawn");
check("a duel whose other side left: I won alone", S.outcome({ kind: "duel", ranking: [["me"]] }, "me") === "won");
check("a shared first place in a free-for-all is a win", S.outcome({ kind: "ffa", ranking: [["a", "me"], ["c"]] }, "me") === "won");
check("my team lost", S.outcome({ kind: "teams", ranking: [["a", "b"], ["me", "c"]] }, "me") === "lost");
check("co-op is played, not won", S.outcome({ kind: "coop", ranking: [["me", "x"]] }, "me") === "played");
check("a one-phone game is played", S.outcome({ kind: "local", ranking: [["me"]] }, "me") === "played");
check("a spectator gets nothing", S.outcome({ kind: "duel", ranking: [["a"], ["b"]] }, "me") === null);

console.log("\nstats: validation");
check("a malformed result is refused", !S.valid({ kind: "duel", ranking: "me" }) && !S.valid({ kind: "chess", ranking: [["a"]] }));
check("…and a well-formed one is not", S.valid({ kind: "ffa", ranking: [["a"], ["b", "c"]] }));
check("record() ignores what is not valid", S.record("g", { kind: "duel" }, { me: "me" }) === null);

console.log("\nstats: counting");
const isBot = (id) => id.startsWith("bot_");
check("a win is counted", S.record("connect4", { kind: "duel", ranking: [["me"], ["bot_1"]] }, { me: "me", key: "r1|1|a" }) === "won");
check("the same report again is not", S.record("connect4", { kind: "duel", ranking: [["me"], ["bot_1"]] }, { me: "me", key: "r1|1|a" }) === null);
check("a rematch with the same ending is", S.record("connect4", { kind: "duel", ranking: [["me"], ["bot_1"]] }, { me: "me", key: "r1|2|a" }) === "won");
S.record("connect4", { kind: "duel", ranking: [["p2"], ["me"]] }, { me: "me", key: "r1|3|b", isBot });
let c4 = S.read().connect4;
check("played / won / lost", c4.played === 3 && c4.won === 2 && c4.lost === 1, JSON.stringify(c4));
check("against bots / against people", c4.vsBots === 2 && c4.vsPeople === 1, JSON.stringify(c4));
check("a loss ends the streak, the best is kept", c4.streak === 0 && c4.best === 2, JSON.stringify(c4));
S.record("neon-survival-mp", { kind: "coop", ranking: [["me"]], scores: { me: 40 } }, { me: "me", key: "s|1" });
S.record("neon-survival-mp", { kind: "coop", ranking: [["me"]], scores: { me: 25 } }, { me: "me", key: "s|2" });
const ns = S.read()["neon-survival-mp"];
check("co-op keeps the best score", ns.played === 2 && ns.bestScore === 40 && ns.won === 0, JSON.stringify(ns));
check("a spectator's report counts nothing", S.record("connect4", { kind: "duel", ranking: [["a"], ["b"]] }, { me: "me", key: "x" }) === null);

console.log("\nstats: favourites and recently played");
check("a star toggles on", S.toggleFav("connect4") === true && S.isFav("connect4"));
check("…and off", S.toggleFav("connect4") === false && !S.isFav("connect4"));
for (const g of ["a", "b", "c", "a"]) S.played(g);
check("recent: newest first, no repeats", S.recent().join() === "a,c,b", S.recent().join());
for (let i = 0; i < 15; i++) S.played(`g${i}`);
check("recent keeps ten", S.recent().length === 10);
check("favourites merge without duplicates", S.mergeFavs(["a", "b"], ["b", "c"]).join() === "a,b,c");
let heard = 0;
const off = S.onChange(() => heard++);
S.toggleFav("x");
off();
S.toggleFav("x");
check("listeners hear a change, and can stop", heard === 1);

console.log(failures ? `\n${failures} stats check(s) failed` : "\nall stats checks passed");
process.exit(failures ? 1 : 0);
