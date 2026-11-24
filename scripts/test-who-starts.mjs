#!/usr/bin/env node
/**
 * test-who-starts.mjs — turn-based games take turns to start (docs/sdk-v2.md
 * "Who starts"), checked against each game's own rules with no browser.
 *
 *   node scripts/test-who-starts.mjs
 *
 * Lokesh, 2026-11-21: "in turn based games or similar games, alternate the
 * starting player". The platform passes `first` in a managed game's `init`
 * (lib/sdk-managed.js nextFirst: a random seat for a run's first match, then
 * the next seat on each rematch). Here each game's page is loaded against a
 * stub page, as the platform's host would run it, and played through four
 * matches — three rematches — with the platform's own nextFirst choosing who
 * starts. Mid-series the host leaves: a second copy of the rules (the heir's)
 * restores the host's snapshot mid-match and runs the next rematch. After
 * every init the seat on turn must be the one the platform named. The
 * browser half (the rotation surviving a real handover, the heir's copy
 * carrying who opened) is scripts/test-managed.mjs 1b; every language's Tic
 * Tac Toe is held to the same answers by scripts/test-conformance.mjs.
 */
import { readFileSync } from "node:fs";

const read = (f) => readFileSync(new URL(f, import.meta.url), "utf8");
let failures = 0;
const check = (label, ok, detail = "") => {
	console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
	if (!ok) failures++;
};
const clone = (v) => JSON.parse(JSON.stringify(v));

// The platform's rule, from the platform's file.
globalThis.window = globalThis;
new Function(read("../lib/sdk-managed.js"))();
const { nextFirst } = globalThis.NeonArcade;

// A stub page: every element and context call is a no-op; `arcade.managed`
// hands back the rules each load registers.
const stub = () => new Proxy(function () {}, { get: (_, k) => (k === Symbol.toPrimitive ? () => "" : stub()), apply: () => stub(), set: () => true });
globalThis.document = stub();
globalThis.matchMedia = () => ({ matches: true, addEventListener() {} });
globalThis.addEventListener = () => {};
globalThis.requestAnimationFrame = () => 0;
let registered = null;
globalThis.arcade = { managed: (r) => (registered = r), on() {}, answer() {}, init: new Promise(() => {}), toast() {}, act() {}, idle() {}, theme: null, party: null };
/** A fresh copy of a game's rules, as one phone's frame holds them. */
function load(path) {
	registered = null;
	new Function(read(path))();
	if (!registered) throw new Error(`${path} registered no rules`);
	return registered;
}

/**
 * Four matches of `path` with `seats`: the host runs matches 1 and 2, leaves
 * after one move of match 2 (`move`: a legal one; the bot's by default), and
 * the heir restores its copy and runs 3 and 4.
 */
async function series(name, path, seats, move = (rules, who) => rules.bot({ seat: who })) {
	console.log(`\n${name}`);
	const host = load(path);
	const heir = load(path);
	const ids = seats.map((p) => p.id);
	let opener = null;
	const openers = [];
	const onTurn = [];
	for (let m = 0; m < 4; m++) {
		const rules = m < 2 ? host : heir;
		if (m === 2) {
			// The host left mid-match 2: the heir carries on from the copy and
			// the copy's opener (the platform sends both), then PLAY AGAIN.
			heir.restore({ snapshot: clone(host.snapshot()) });
			check("the heir carries match 2 on from the host's copy", JSON.stringify(heir.view({ seat: null })) === JSON.stringify(host.view({ seat: null })));
		}
		opener = nextFirst(opener, ids, () => 0.6); // the draw is used for the first match only
		openers.push(opener.id);
		await rules.init({ seats: clone(seats), opts: {}, seed: 11 + m, match: m, first: opener.id });
		const who = (await rules.turn())[0];
		onTurn.push(who);
		if (m === 1) {
			// One move by whoever is on turn, so the copy is mid-match.
			const refused = await rules.apply({ action: await move(rules, who), by: who });
			check("a move in match 2 before the host leaves", refused == null && (await rules.turn())[0] !== who, String(refused));
		}
	}
	const want = [0, 1, 2, 3].map((k) => ids[(Math.floor(0.6 * ids.length) + k) % ids.length]);
	check(`the platform names who starts: drawn for match 1, then the next seat each rematch (${openers.join(", ")})`, JSON.stringify(openers) === JSON.stringify(want), { openers, want });
	check("…and in every match that seat is on turn first, the heir's two included", JSON.stringify(onTurn) === JSON.stringify(openers), { onTurn, openers });
	// An older shell sends no `first`: the game still starts, on its old seat.
	await host.init({ seats: clone(seats), opts: {}, seed: 1, match: 0 });
	check("with no `first` (an older shell) the game still starts, with a seat on turn", ids.includes((await host.turn())[0]));
}

const duel = [
	{ id: "pA", name: "Ada", team: "A", bot: false },
	{ id: "pB", name: "Bo", team: "B", bot: false },
];
await series("Connect 4", "../games/connect4/connect4.js", duel);
new Function(read("../games/neon-fission/rules.js"))(); // neon-fission.js reads it from globalThis
await series("Neon Fission, three seats", "../games/neon-fission/neon-fission.js", [...duel, { id: "pC", name: "Cy", team: "A", bot: false }], () => ({ cell: 0 })); // its bot plays only bot seats
await series("Tic Tac Toe (JavaScript, the conformance reference)", "../sdk/v2/examples/tic-tac-toe-js/tic-tac-toe.js", duel);
await series("Tic Tac Toe (HTML/CSS)", "../sdk/v2/examples/tic-tac-toe-html/rules.js", duel);

console.log("\nConnect 4: a watcher reads whose turn it is");
{
	// Who opens changes between matches, so "Opponent's turn" is not enough
	// for a watcher: the turn line names the colour, and the player. The
	// page is loaded against a page whose HUD records what it is given.
	const shown = {};
	const element = (id) =>
		new Proxy(function () {}, {
			get: (_, k) => (k === "replaceChildren" ? (...nodes) => (shown[id] = nodes.map((n) => n.textContent).join("")) : k === Symbol.toPrimitive ? () => "" : stub()),
			set: () => true,
		});
	const page = new Proxy(function () {}, {
		get: (_, k) => (k === "getElementById" ? (id) => element(id) : k === "createElement" ? () => ({ textContent: "", style: {} }) : k === "createTextNode" ? (text) => ({ textContent: text }) : stub()),
	});
	const handlers = {};
	const was = { document: globalThis.document, arcade: globalThis.arcade };
	globalThis.document = page;
	globalThis.arcade = { ...was.arcade, on: (t, fn) => (handlers[t] = fn), party: { members: [{ id: "pA", name: "Ada" }, { id: "pB", name: "Bo" }] } };
	load("../games/connect4/connect4.js");
	const board = Array.from({ length: 6 }, () => Array(7).fill(0));
	const view = (turn, you) => ({ board, turn, winner: null, started: true, red: "pA", yellow: "pB", match: 1, moves: 0, last: null, you });
	handlers.view({ state: view(2, 0) });
	check("a watcher, yellow to open: the line says Bo (Yellow) to move", /Bo \(Yellow\) to move/.test(shown.hud ?? ""), shown.hud);
	handlers.view({ state: view(1, 0) });
	check("…and then Ada (Red)", /Ada \(Red\) to move/.test(shown.hud ?? ""), shown.hud);
	handlers.view({ state: view(1, 1) });
	check("a player still reads YOUR TURN", /YOUR TURN/.test(shown.hud ?? ""), shown.hud);
	// Each side in its player's own colour (docs/sdk-v2.md "Seat colours"), named.
	globalThis.arcade.seatColors = () => [2, 4];
	const c = "rgba(1, 2, 3, 1)";
	globalThis.arcade.theme = { tokens: { glow: "rgba(0, 0, 0, 0)", surface2: c, accent: c, bg: c }, players: Array(8).fill(c), playerNames: ["Red", "Yellow", "Blue", "Magenta", "Green", "Orange", "Purple", "Teal"] };
	handlers.view({ state: view(1, 0) });
	check("with picked colours, a watcher reads Ada (Blue) to move", /Ada \(Blue\) to move/.test(shown.hud ?? ""), shown.hud);
	handlers.view({ state: view(2, 2) });
	check("…and the player on yellow's side is told GREEN", /^GREEN/.test(shown.hud ?? ""), shown.hud);
	Object.assign(globalThis, was);
}

console.log(failures ? `\n${failures} failing\n` : "\nall passing\n");
process.exit(failures ? 1 : 0);
