// scripts/build-catalog.mjs — this repo's framed games, as one script.
//
// The party shell has to know a game's name, seats and shape before it loads
// the game (to list it, check the roster, offer bots), and a static site cannot
// list a folder at runtime. So games/<id>/game.json are gathered here into
// lib/catalog.js, committed, which party.html loads like any other lib file.
// Outside repos' games get their own generated catalog at deploy:
// scripts/fetch-community.mjs → community/catalog.js.
//
//   node scripts/build-catalog.mjs          write lib/catalog.js
//   node scripts/build-catalog.mjs --check  fail if it is out of date

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { catalogEntries, catalogScript, contributorEntry } from "./catalog-lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "lib", "catalog.js");

// The arcade's games, then the SDK's managed Tic Tac Toe in every language
// (sdk/v2/examples/tic-tac-toe-<lane>), copied into the site by assemble.mjs.
// Only the JavaScript one is listed, as Tic Tac Toe under Strategy; the
// others are playable by their address (the "Add your game" guide links each)
// but on no list (Lokesh, 2026-11-15: "only one should be").
const EXAMPLES = "sdk/v2/examples";
const LISTED_EXAMPLE = "tic-tac-toe-js";
const files = [
	...readdirSync(join(ROOT, "games"))
		.sort()
		.map((id) => ({ file: join(ROOT, "games", id, "game.json"), owner: null })),
	...readdirSync(join(ROOT, EXAMPLES))
		.filter((d) => d.startsWith("tic-tac-toe-"))
		.sort()
		.map((d) => ({ file: join(ROOT, EXAMPLES, d, "game.json"), owner: null })),
].filter(({ file }) => existsSync(file));

let games;
try {
	games = catalogEntries(files, ROOT).map((g) => (g.path.startsWith(EXAMPLES) && g.id !== LISTED_EXAMPLE ? { ...g, listed: false } : g));
} catch (err) {
	console.error(err.message);
	process.exit(1);
}
// This repo's own author: its contributor.json, like any games repo's.
let contributors = [];
try {
	const own = join(ROOT, "contributor.json");
	const login = games[0]?.author;
	if (login) contributors = [contributorEntry(login, games[0].repo, existsSync(own) ? JSON.parse(readFileSync(own, "utf8")) : null)];
} catch (err) {
	console.error(err.message);
	process.exit(1);
}
const body = catalogScript(games, { file: "lib/catalog.js", source: "scripts/build-catalog.mjs", contributors });

if (process.argv.includes("--check")) {
	const now = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
	if (now !== body) {
		console.error("lib/catalog.js is out of date: run `just catalog`");
		process.exit(1);
	}
	console.log(`catalog: ${games.length} games, up to date`);
} else {
	writeFileSync(OUT, body);
	console.log(`catalog: ${games.length} games → lib/catalog.js`);
}
