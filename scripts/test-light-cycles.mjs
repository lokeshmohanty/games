#!/usr/bin/env node
/**
 * test-light-cycles.mjs — the arena simulation, with no arena drawn.
 *
 *   node scripts/test-light-cycles.mjs
 *
 * The one rule worth testing hard is what happens when two riders enter the
 * same cell on the same tick. Resolving riders one at a time gets that wrong in
 * a way that is nearly invisible in play — the rider earlier in the array
 * survives, the other one "hits a wall" that did not exist when it set off —
 * and it decides rounds. So `advance` is a pure function over a grid and a list
 * of riders, and it is exercised here rather than through a canvas.
 *
 * The bot is measured the same way Onitama's is: against the thing it has to
 * beat to be worth playing, which for a space-filling game is a rider that
 * merely avoids dying.
 */
import { readFileSync } from "node:fs";

globalThis.window = globalThis;
globalThis.location = { href: "file:///x", hash: "", pathname: "/x", search: "" };
globalThis.history = { replaceState() {} };
for (const f of ["../lib/net.js", "../lib/games.js", "../lib/ui.js", "../games/light-cycles.js"]) {
	new Function(readFileSync(new URL(f, import.meta.url), "utf8"))();
}
const R = globalThis.NeonArcade.lightCycleRules;
const { COLS, ROWS, ORDER, STEP, SPAWNS, idx, inBounds, openSpace, distancesFrom, territory, botDirection, advance } = R;

let failures = 0;
const check = (label, ok, detail = "") => {
	console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
	if (!ok) failures++;
};

const newGrid = () => new Uint8Array(COLS * ROWS);
const rider = (c, r, dir) => ({ c, r, dir, alive: true });
const place = (grid, riders) => riders.forEach((x, i) => (grid[idx(x.c, x.r)] = i + 1));

// ---------------------------------------------------------------------------
console.log("\nthe arena");

{
	check("eight spawns for eight seats", SPAWNS.length === 8);
	check("every spawn is on the board", SPAWNS.every((s) => inBounds(s.c, s.r)));
	check("no two riders start on the same cell", new Set(SPAWNS.map((s) => `${s.c},${s.r}`)).size === 8);
	// Facing a wall from the off would be a coin-flip death nobody chose.
	const facingWall = SPAWNS.filter((s) => {
		const [dc, dr] = STEP[s.d];
		return !inBounds(s.c + dc, s.r + dr);
	});
	check("nobody starts facing a wall", facingWall.length === 0, JSON.stringify(facingWall));
	// The first two seats are the two-player case. They must approach from
	// opposite sides but NOT down the same row — see the note by SPAWNS.
	check("the two-player spawns come from opposite sides",
		SPAWNS[0].d === "E" && SPAWNS[1].d === "W" && SPAWNS[0].c < SPAWNS[1].c);
	check("and are offset, so going straight is not a mutual suicide",
		Math.abs(SPAWNS[0].r - SPAWNS[1].r) >= 4, `${SPAWNS[0].r} vs ${SPAWNS[1].r}`);
	// No spawn may be another one rotated 180° about the centre. Two riders in
	// mirrored positions see mirrored arenas and die on the same tick — it turns
	// rounds into draws and it is invisible in the numbers. See the note on
	// SPAWNS in the game.
	const mirrors = [];
	for (let i = 0; i < SPAWNS.length; i++) {
		for (let j = i + 1; j < SPAWNS.length; j++) {
			if (SPAWNS[i].c + SPAWNS[j].c === COLS - 1 && SPAWNS[i].r + SPAWNS[j].r === ROWS - 1) {
				mirrors.push(`${i}/${j}`);
			}
		}
	}
	check("no spawn is another one rotated 180°", mirrors.length === 0, mirrors.join(", "));
}

// ---------------------------------------------------------------------------
console.log("\nmoving and crashing");

{
	const grid = newGrid();
	const riders = [rider(10, 10, "E")];
	place(grid, riders);
	advance(grid, riders);
	check("a rider moves one cell", riders[0].c === 11 && riders[0].r === 10, JSON.stringify(riders[0]));
	check("and leaves a wall where it was", grid[idx(10, 10)] === 1);
	check("and one where it now is", grid[idx(11, 10)] === 1);
}

{
	const grid = newGrid();
	const riders = [rider(COLS - 1, 10, "E")];
	place(grid, riders);
	advance(grid, riders);
	check("riding off the edge kills you", riders[0].alive === false);
	check("a dead rider does not move", riders[0].c === COLS - 1);
}

{
	const grid = newGrid();
	const riders = [rider(10, 10, "E")];
	place(grid, riders);
	grid[idx(11, 10)] = 9; // somebody else's wall
	advance(grid, riders);
	check("riding into a wall kills you", riders[0].alive === false);
}

{
	// The head-on. Two riders one cell apart, closing.
	const grid = newGrid();
	const riders = [rider(10, 10, "E"), rider(12, 10, "W")];
	place(grid, riders);
	advance(grid, riders);
	check("a head-on kills both, not whichever came second",
		riders[0].alive === false && riders[1].alive === false,
		JSON.stringify(riders.map((x) => x.alive)));
	check("neither claimed the contested cell", grid[idx(11, 10)] === 0, `${grid[idx(11, 10)]}`);
}

{
	// The near-miss that must NOT be treated as a head-on: they swap columns
	// but on different rows.
	const grid = newGrid();
	const riders = [rider(10, 10, "E"), rider(12, 11, "W")];
	place(grid, riders);
	advance(grid, riders);
	check("riders passing on different rows both live", riders.every((x) => x.alive));
}

{
	// Order must not decide anything. The same collision with the riders listed
	// the other way round has to end the same way.
	const a = { grid: newGrid(), riders: [rider(10, 10, "E"), rider(12, 10, "W")] };
	const b = { grid: newGrid(), riders: [rider(12, 10, "W"), rider(10, 10, "E")] };
	for (const s of [a, b]) {
		place(s.grid, s.riders);
		advance(s.grid, s.riders);
	}
	check("array order does not decide a collision",
		a.riders.every((x) => !x.alive) && b.riders.every((x) => !x.alive));
}

{
	const grid = newGrid();
	const riders = [rider(10, 10, "E"), rider(20, 20, "N")];
	riders[1].alive = false;
	place(grid, riders);
	const before = { ...riders[1] };
	advance(grid, riders);
	check("a crashed rider stays put and stays dead",
		!riders[1].alive && riders[1].c === before.c && riders[1].r === before.r);
}

// ---------------------------------------------------------------------------
console.log("\nopen space");

{
	const grid = newGrid();
	// The whole board minus nothing: an empty arena must not saturate a cap, or
	// every option ties and the bot stops choosing. See the note on openSpace.
	check("an empty arena reports the whole arena", openSpace(grid, 20, 20) === COLS * ROWS, `${openSpace(grid, 20, 20)}`);
	check("a wall cell has no room at all", (grid[idx(20, 20)] = 1, openSpace(grid, 20, 20) === 0));

	// Box a cell in and the answer must collapse to what is actually enclosed.
	const boxed = newGrid();
	for (let c = 8; c <= 12; c++) {
		boxed[idx(c, 8)] = 1;
		boxed[idx(c, 12)] = 1;
	}
	for (let r = 8; r <= 12; r++) {
		boxed[idx(8, r)] = 1;
		boxed[idx(12, r)] = 1;
	}
	check("a sealed box reports only the cells inside it", openSpace(boxed, 10, 10) === 9, `${openSpace(boxed, 10, 10)}`);
}

// ---------------------------------------------------------------------------
console.log("\nthe bot");

{
	const grid = newGrid();
	const r = rider(COLS - 1, 20, "E");
	place(grid, [r]);
	const dir = botDirection(grid, r);
	check("it does not ride into the wall it is facing", dir !== "E", dir);

	// A corridor with one way out: it must find it rather than pick by habit.
	const trap = newGrid();
	for (let c = 0; c < COLS; c++) {
		trap[idx(c, 9)] = 1;
		trap[idx(c, 11)] = 1;
	}
	trap[idx(21, 10)] = 1; // straight ahead is blocked, and the corridor walls the rest
	const boxedIn = rider(20, 10, "E");
	check("a rider with no legal turn still returns a direction", !!botDirection(trap, boxedIn));
}

/**
 * Play a whole round. `pick` decides each rider's direction; the simulation is
 * the real one.
 */
function playRound(pickers, maxTicks = 4000) {
	const grid = newGrid();
	const riders = pickers.map((_, i) => ({ ...SPAWNS[i], dir: SPAWNS[i].d, alive: true }));
	place(grid, riders);
	for (let t = 0; t < maxTicks; t++) {
		for (let i = 0; i < riders.length; i++) {
			if (riders[i].alive) riders[i].dir = pickers[i](grid, riders[i], riders.filter((o, j) => j !== i && o.alive));
		}
		advance(grid, riders);
		const alive = riders.filter((x) => x.alive);
		if (alive.length <= 1) return { winner: riders.indexOf(alive[0]), ticks: t + 1, riders, grid };
	}
	return { winner: -2, ticks: maxTicks, riders, grid };
}

/** Turns only to stay alive, and otherwise ploughs on. The baseline. */
const survivor = (grid, r) => {
	const i = ORDER.indexOf(r.dir);
	for (const d of [ORDER[i], ORDER[(i + 1) % 4], ORDER[(i + 3) % 4]]) {
		const [dc, dr] = STEP[d];
		if (inBounds(r.c + dc, r.r + dr) && !grid[idx(r.c + dc, r.r + dr)]) return d;
	}
	return r.dir;
};

{
	const ROUNDS = 30;
	let botWins = 0;
	let botLosses = 0;
	let draws = 0;
	let unfinished = 0;
	let totalTicks = 0;
	for (let i = 0; i < ROUNDS; i++) {
		// Swap seats each round: seat 0 rides east from the left, and a spawn
		// advantage would otherwise read as bot strength.
		const botSeat = i % 2;
		const pickers = [0, 1].map((seat) => (seat === botSeat ? botDirection : survivor));
		const out = playRound(pickers);
		totalTicks += out.ticks;
		if (out.winner === -2) unfinished++;
		else if (out.winner < 0) draws++;
		else if (out.winner === botSeat) botWins++;
		else botLosses++;
	}
	check("every round ended", unfinished === 0, `${unfinished} hit the tick cap`);
	check("rounds are short enough to be casual", totalTicks / ROUNDS < 600, `${Math.round(totalTicks / ROUNDS)} ticks average`);
	// The whole point of the flood fill. A bot that merely avoids walls would
	// land near half.
	// Draws are counted separately rather than folded into the loss column: a
	// mutual crash is a legitimate result of two riders meeting, not the bot
	// being outplayed. What has to be rare is *losing*.
	check(`the bot beats a rider that only avoids crashing (${botWins}W ${botLosses}L ${draws}D of ${ROUNDS})`,
		botWins >= 27 && botLosses <= 2, `${botWins}W ${botLosses}L ${draws}D`);
}

{
	// Eight bots at once is the busiest the arena gets, and it is also the worst
	// case for the search: the host runs every one of them, on a phone, ten
	// times a second. Territory scoring is four breadth-first sweeps per rider
	// per tick, so this is worth a number rather than a shrug.
	const grid = newGrid();
	const riders = SPAWNS.map((sp) => ({ ...sp, dir: sp.d, alive: true }));
	place(grid, riders);
	for (let t = 0; t < 40; t++) {
		for (const r of riders) if (r.alive) r.dir = botDirection(grid, r, riders.filter((o) => o !== r && o.alive));
		advance(grid, riders);
	}
	const t0 = Date.now();
	for (const r of riders) if (r.alive) botDirection(grid, r, riders.filter((o) => o !== r && o.alive));
	const perTick = Date.now() - t0;
	// One tick is 100ms of wall clock at the starting speed, and the host has to
	// draw a frame in it too.
	check("a full eight-bot tick fits inside its own tick", perTick < 25, `${perTick}ms`);
}

{
	// Eight bots at once is the busiest the arena gets, and it is the case where
	// a collision-resolution bug would leave two riders alive on one cell.
	const out = playRound(Array.from({ length: 8 }, () => botDirection));
	check("an eight-bot round resolves to one rider or none", out.winner >= -1, `${out.winner}`);
	const alive = out.riders.filter((x) => x.alive);
	check("no two survivors share a cell",
		new Set(alive.map((x) => `${x.c},${x.r}`)).size === alive.length);
	check("every wall belongs to exactly one rider", out.grid.every((v) => v >= 0 && v <= 8));
}

console.log(failures ? `\n${failures} failing\n` : "\nall passing\n");
process.exit(failures ? 1 : 0);
