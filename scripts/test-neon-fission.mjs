#!/usr/bin/env node
/**
 * test-neon-fission.mjs — Neon Fission's rules, its bot, and its managed layer.
 *
 *   node scripts/test-neon-fission.mjs
 *
 * The rules are pure (games/neon-fission/rules.js), so they are checked here
 * without a browser: capacities, a chain of several waves, conversion,
 * knock-outs only after a first turn, the chain stopping once one player
 * owns every orb, the bot (legal, fast, finishing a win), and many whole
 * bot-only games, which must all end. The managed layer (neon-fission.js) is
 * loaded against a stub page to check the same-device rules: a "player on
 * this device" seat is reported as the person's turn and played by them.
 */
import { readFileSync } from "node:fs";

const read = (f) => readFileSync(new URL(f, import.meta.url), "utf8");
new Function(read("../games/neon-fission/rules.js"))();
const R = globalThis.neonFissionRules;

let failures = 0;
const check = (label, ok, detail = "") => {
	console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
	if (!ok) failures++;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** A small seeded generator, so a failing run can be replayed. */
function mulberry32(seed) {
	return () => {
		seed |= 0;
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
const at = (g, col, row) => row * g.cols + col; // A1 = (0, 0)
const orbsOnBoard = (g) => g.count.reduce((a, b) => a + b, 0);

// ---------------------------------------------------------------------------
console.log("\nthe grid");
{
	check("2 to 4 players: 6 across, 9 down", [2, 3, 4].every((n) => same(R.dims(n), { cols: 6, rows: 9 })));
	check("5 to 8 players: 8 × 12", [5, 6, 7, 8].every((n) => same(R.dims(n), { cols: 8, rows: 12 })));
	for (const [cols, rows] of [[6, 9], [8, 12]]) {
		const caps = [...Array(cols * rows).keys()].map((i) => R.capacity(cols, rows, i));
		const tally = (k) => caps.filter((c) => c === k).length;
		check(`${cols} × ${rows}: corners burst at 2, edges at 3, the rest at 4`,
			R.capacity(cols, rows, 0) === 2 && R.capacity(cols, rows, cols - 1) === 2 && R.capacity(cols, rows, cols * rows - 1) === 2 &&
			R.capacity(cols, rows, 1) === 3 && R.capacity(cols, rows, cols) === 3 && R.capacity(cols, rows, cols + 1) === 4 &&
			tally(2) === 4 && tally(3) === 2 * (cols - 2) + 2 * (rows - 2) && tally(4) === (cols - 2) * (rows - 2),
			`${tally(2)}/${tally(3)}/${tally(4)}`);
	}
	const sh = R.shape(6, 9);
	check("neighbours are orthogonal only", same([...sh.nbr[7]].sort((a, b) => a - b), [1, 6, 8, 13]));
}

// ---------------------------------------------------------------------------
console.log("\na turn");
{
	const g = R.newGame(2);
	check("the board starts empty, seat 0 to move", g.owner.every((o) => o === -1) && g.count.every((c) => c === 0) && g.turn === 0);
	const r = R.play(g, at(g, 2, 3));
	check("an orb goes into an empty cell, which becomes yours", typeof r === "object" && g.owner[at(g, 2, 3)] === 0 && g.count[at(g, 2, 3)] === 1 && g.turn === 1);
	check("another player's cell is refused", typeof R.play(g, at(g, 2, 3)) === "string" && g.turn === 1);
	check("so is a cell off the grid, or not a cell", typeof R.play(g, -1) === "string" && typeof R.play(g, 54) === "string" && typeof R.play(g, "3") === "string" && typeof R.play(g, 1.5) === "string");
	R.play(g, at(g, 4, 4));
	check("your own cell takes another orb", typeof R.play(g, at(g, 2, 3)) === "object" && g.count[at(g, 2, 3)] === 2);
	check("no one is out before everybody has had a turn", g.out.every((o) => o === null) && g.winner === null);
}

// ---------------------------------------------------------------------------
console.log("\nthe chain (RULES.md's example)");
{
	const RED = 0;
	const BLUE = 1;
	/** RULES.md's board; `far`: blue's lone orb in F9, which keeps blue in. */
	const board = (far) => {
		const g = R.newGame(2);
		const put = (col, row, seat, n) => {
			g.owner[at(g, col, row)] = seat;
			g.count[at(g, col, row)] = n;
		};
		put(0, 0, RED, 1); // A1
		put(1, 0, RED, 2); // B1
		put(0, 1, BLUE, 2); // A2
		put(2, 0, BLUE, 1); // C1
		put(1, 1, BLUE, 1); // B2
		if (far) put(5, 8, BLUE, 1); // F9
		g.played = [true, true];
		g.moves = 6;
		return g;
	};
	const g = board(true);
	const cell = (col, row) => [g.owner[at(g, col, row)], g.count[at(g, col, row)]];
	const orbs = orbsOnBoard(g);
	const r = R.play(g, at(g, 0, 0));
	const waves = r.waves.map((w) => [...w].sort((a, b) => a - b));
	check("three waves: A1; then B1 and A2; then A1 again", same(waves, [[0], [1, 6], [0]]), JSON.stringify(waves));
	check("four bursts", r.bursts === 4, r.bursts);
	check("A1 ends empty; B1 and A2 hold one each", same(cell(0, 0), [-1, 0]) && same(cell(1, 0), [RED, 1]) && same(cell(0, 1), [RED, 1]));
	check("captured cells keep their orbs: C1 2, B2 3, A3 1, all red",
		same(cell(2, 0), [RED, 2]) && same(cell(1, 1), [RED, 3]) && same(cell(0, 2), [RED, 1]), JSON.stringify([cell(2, 0), cell(1, 1), cell(0, 2)]));
	check("no orb is lost or made in a chain", orbsOnBoard(g) === orbs + 1);
	check("blue keeps F9 and stays in", g.out[BLUE] === null && g.winner === null && same(cell(5, 8), [BLUE, 1]) && g.turn === BLUE);
	check("the biggest chain is remembered", same(g.biggest, { bursts: 4, waves: 3 }));

	// Without F9, wave 2 takes blue's last cell: the chain stops there.
	const h = board(false);
	const r2 = R.play(h, at(h, 0, 0));
	check("without F9 the chain stops after wave 2, red owning every orb", r2.waves.length === 2 && h.count[0] === 2 && h.owner[0] === RED, JSON.stringify(r2.waves));
	check("…blue, who has had a turn and holds nothing, is out; red wins", h.out[BLUE] === h.moves && h.winner === RED && same(R.standings(h), [[RED], [BLUE]]));
}

// ---------------------------------------------------------------------------
console.log("\nconversion and knock-outs");
{
	// A burst into a cell another player owns takes it, orbs and all.
	const g = R.newGame(3);
	g.played = [true, true, false];
	g.moves = 2;
	g.owner[0] = 0; g.count[0] = 1; // seat 0's corner, one short
	g.owner[1] = 1; g.count[1] = 1; // seat 1's only cell, beside it
	g.owner[30] = 0; g.count[30] = 1;
	const r = R.play(g, 0);
	check("the corner bursts into its two neighbours", r.waves.length === 1 && g.owner[1] === 0 && g.count[1] === 2 && g.owner[6] === 0 && g.count[6] === 1);
	check("seat 1, who has played and holds nothing, is out", g.out[1] !== null);
	check("seat 2 holds nothing too, but has not had a turn: still in", g.out[2] === null && g.winner === null);
	check("the turn skips the player who is out", g.turn === 2);
	R.play(g, 50);
	check("seat 2 plays its first turn", g.owner[50] === 2 && g.turn === 0);
	// Two knocked out by one move share a place.
	const t = R.newGame(3);
	t.played = [true, true, true];
	t.moves = 9;
	t.owner[0] = 0; t.count[0] = 1;
	t.owner[1] = 1; t.count[1] = 1;
	t.owner[6] = 2; t.count[6] = 1;
	R.play(t, 0);
	check("knocked out by the same move: the last two share second place", t.winner === 0 && same(R.standings(t), [[0], [1, 2]]), JSON.stringify(R.standings(t)));
	// The order players go out is the ranking, last out first.
	const u = R.newGame(3);
	u.out = [null, 4, 9];
	u.played = [true, true, true];
	u.owner[0] = 0; u.count[0] = 1;
	u.winner = 0;
	check("the winner, then the last knocked out, then the first", same(R.standings(u), [[0], [2], [1]]));
	u.gone[2] = true;
	check("a player who left is not ranked", same(R.standings(u), [[0], [1]]));
}

// ---------------------------------------------------------------------------
console.log("\nthe chain stops once one player owns every orb");
{
	// Every cell red and one short of bursting, but for a single blue orb:
	// left to run, this board would burst for ever.
	const g = R.newGame(2);
	const sh = R.shape(g.cols, g.rows);
	for (let i = 0; i < sh.n; i++) {
		g.owner[i] = 0;
		g.count[i] = sh.cap[i] - 1;
	}
	g.owner[sh.n - 1] = 1; // the far corner, blue
	g.count[sh.n - 1] = 1;
	g.played = [true, true];
	g.moves = 120;
	const t0 = performance.now();
	const r = R.play(g, 0);
	const ms = performance.now() - t0;
	check("it ends, and quickly", typeof r === "object" && ms < 100, `${ms.toFixed(1)} ms`);
	check("…on the wave that took blue's last cell, far short of the safety cap", r.waves.length < 40 && r.waves.length < R.MAX_WAVES, `${r.waves.length} waves`);
	check("…with red the winner", g.winner === 0 && g.out[1] !== null);
	check("red owns every orb on the board", g.owner.every((o, i) => o === 0 || g.count[i] === 0));
}

// ---------------------------------------------------------------------------
console.log("\nskipping and leaving");
{
	const g = R.newGame(3);
	R.play(g, 0);
	R.skip(g);
	check("a skipped turn counts as had: holding nothing, seat 1 is out", g.out[1] !== null && g.turn === 2);
	R.play(g, 20);
	R.leave(g, 2);
	check("when the last rival leaves, the one left wins", g.winner === 0 && same(R.standings(g), [[0], [1]]));
	const h = R.newGame(3);
	R.play(h, 0);
	R.leave(h, 1);
	check("a seat that leaves on its turn passes it on", h.turn === 2 && h.winner === null);
}

// ---------------------------------------------------------------------------
console.log("\nthe bot");
{
	// Finishes a win when one is there: blue's last cell is beside a red
	// corner one orb short.
	const g = R.newGame(2);
	g.played = [true, true];
	g.moves = 10;
	g.owner[0] = 0; g.count[0] = 1;
	g.owner[1] = 1; g.count[1] = 2;
	g.owner[40] = 0; g.count[40] = 1;
	check("it takes a win when one is on the board", R.botMove(g, mulberry32(1)) === 0);

	// Doesn't hand a loaded neighbour a cell: with a blue cell one short of
	// bursting beside an empty cell, it does not drop a lone orb there.
	const d = R.newGame(2);
	d.played = [true, true];
	d.moves = 8;
	d.owner[0] = 1; d.count[0] = 1; // blue corner, one short
	d.owner[53] = 0; d.count[53] = 1;
	const pick = R.botMove(d, mulberry32(2));
	check("it does not put an orb where a loaded enemy cell would take it", pick !== 1 && pick !== 6, pick);

	// Legal and fast at the biggest board, all through real games.
	let worst = 0;
	let illegal = 0;
	for (let seed = 1; seed <= 6; seed++) {
		const rng = mulberry32(seed);
		const b = R.newGame(8);
		while (b.winner === null && b.moves < 3000) {
			const t0 = performance.now();
			const c = R.botMove(b, rng);
			worst = Math.max(worst, performance.now() - t0);
			if (!R.legal(b, c)) illegal++;
			R.play(b, c);
		}
	}
	check("every move it picks is legal", illegal === 0, `${illegal} illegal`);
	check("each move under 50 ms at 8 × 12 (a phone is ~5× slower; this is far under)", worst < 50 / 5, `${worst.toFixed(1)} ms worst`);

	// Against a player who picks any legal cell at random.
	const randomOf = (b, rng) => {
		const cells = R.legalCells(b);
		return cells[Math.floor(rng() * cells.length)];
	};
	let won = 0;
	const N = 40;
	for (let seed = 1; seed <= N; seed++) {
		const rng = mulberry32(1000 + seed);
		const b = R.newGame(2);
		const botSeat = seed % 2;
		while (b.winner === null && b.moves < 3000) R.play(b, b.turn === botSeat ? R.botMove(b, rng) : randomOf(b, rng));
		if (b.winner === botSeat) won++;
	}
	check("it beats a random player at least 95% of the time", won / N >= 0.95, `${won}/${N}`);

	// Against a greedy player: whatever cell gains the most orbs right now.
	const greedyOf = (b) => {
		let best = -1;
		let bestGain = -Infinity;
		const sh = R.shape(b.cols, b.rows);
		for (const c of R.legalCells(b)) {
			const o = Int8Array.from(b.owner);
			const n = Uint8Array.from(b.count);
			R.react(o, n, sh, c, b.turn);
			let gain = 0;
			for (let i = 0; i < o.length; i++) if (o[i] === b.turn) gain += n[i];
			if (gain > bestGain) {
				bestGain = gain;
				best = c;
			}
		}
		return best;
	};
	won = 0;
	for (let seed = 1; seed <= N; seed++) {
		const rng = mulberry32(2000 + seed);
		const b = R.newGame(2);
		const botSeat = seed % 2;
		while (b.winner === null && b.moves < 3000) R.play(b, b.turn === botSeat ? R.botMove(b, rng) : greedyOf(b));
		if (b.winner === botSeat) won++;
	}
	check("it beats a greedy player most of the time", won / N >= 0.75, `${won}/${N}`);
}

// ---------------------------------------------------------------------------
console.log("\nwhole games, bots only");
{
	let stuck = 0;
	let unranked = 0;
	let leaked = 0;
	let games = 0;
	let longest = 0;
	for (let players = 2; players <= 8; players++) {
		for (let seed = 1; seed <= 30; seed++) {
			const rng = mulberry32(players * 1000 + seed);
			const g = R.newGame(players);
			while (g.winner === null && g.moves < 5000) {
				R.play(g, R.botMove(g, rng));
				// Orbs are only ever moved, never lost, until the final chain stops.
				if (g.winner === null && orbsOnBoard(g) !== g.moves) leaked++;
			}
			games++;
			longest = Math.max(longest, g.moves);
			if (g.winner === null) stuck++;
			const ranked = R.standings(g).flat();
			if (ranked[0] !== g.winner || ranked.length !== players || new Set(ranked).size !== players) unranked++;
		}
	}
	check(`all ${games} games (2 to 8 bots, 30 seeds each) end with a winner`, stuck === 0, `${stuck} stuck`);
	check("…every seat ranked once, the winner first", unranked === 0, `${unranked} bad rankings`);
	check("…and no orb vanished mid-game", leaked === 0, `${leaked} moves`);
	console.log(`  (the longest took ${longest} moves)`);
}

// ---------------------------------------------------------------------------
console.log("\nthe managed layer: one phone, several people");
{
	// A stub page: every element and context call is a no-op.
	const stub = () => new Proxy(function () {}, { get: (_, k) => (k === Symbol.toPrimitive ? () => "" : stub()), apply: () => stub(), set: () => true });
	let rules = null;
	globalThis.document = stub();
	globalThis.matchMedia = () => ({ matches: true });
	globalThis.addEventListener = () => {};
	globalThis.arcade = { managed: (r) => (rules = r), on() {}, init: new Promise(() => {}), toast() {}, act() {}, theme: null };
	new Function(read("../games/neon-fission/neon-fission.js"))();
	const seats = [
		{ id: "host", name: "Lokesh", team: "A", bot: false },
		{ id: "bot_a", name: "Bot Ada", team: "A", bot: true },
		{ id: "bot_b", name: "Bot Bo", team: "A", bot: true },
	];
	rules.init({ seats, seed: 5, match: 0 });
	check("one person and bots: the table is set first, by them", rules.view({ seat: "host" }).phase === "setup" && same(rules.turn(), ["host"]));
	check("no bot moves while the table is set", rules.bot({ seat: "bot_a" }) === null);
	check("only a bot seat can be handed to a person", typeof rules.apply({ action: { seat: 0, local: true }, by: "host" }) === "string");
	check("only the person setting the table can change it", typeof rules.apply({ action: { seat: 1, local: true }, by: "bot_a" }) === "string");
	check("seat 2 becomes a player on this device", rules.apply({ action: { seat: 1, local: true }, by: "host" }) === undefined);
	let v = rules.view({ seat: "host" });
	check("…named Player 2, not the bot's name", v.players[1].name === "Player 2" && v.players[1].kind === "local" && v.players[2].kind === "bot");
	rules.apply({ action: { start: true }, by: "host" });
	check("START begins play, the person first", rules.view({ seat: "host" }).phase === "play" && same(rules.turn(), ["host"]));
	rules.apply({ action: { cell: 0 }, by: "host" });
	check("Player 2's turn is reported as the person's: no bot, no waiting banner", same(rules.turn(), ["host"]));
	check("…the platform's bot is not asked to play it", rules.bot({ seat: "bot_a" }) === null);
	check("…and the bot id itself cannot move there", typeof rules.apply({ action: { cell: 10 }, by: "bot_a" }) === "string");
	check("the person's tap is played for Player 2", rules.apply({ action: { cell: 53 }, by: "host" }) === undefined && rules.view({ seat: "host" }).owner[53] === 1);
	check("then the real bot is on turn and plays itself", same(rules.turn(), ["bot_b"]) && Number.isInteger(rules.bot({ seat: "bot_b" })?.cell));
	v = rules.view({ seat: "host" });
	check("the view carries the last move and its waves, and the board before it", v.last?.cell === 53 && v.last.seat === 1 && Array.isArray(v.last.waves) && v.last.before.owner[53] === -1);
	check("the person's view says they play the local seats", v.setter === true && v.you === 0);
	// Play it out with the person playing both their seats as the bot would.
	for (let k = 0; k < 2000 && !rules.result(); k++) {
		const [who] = rules.turn();
		const snap = rules.snapshot();
		const cell = R.botMove(snap.g, mulberry32(k));
		rules.apply({ action: { cell }, by: who === "host" ? "host" : who });
	}
	const res = rules.result();
	check("the game ends with an ffa ranking of every seat", res?.kind === "ffa" && res.ranking.flat().length === 3, JSON.stringify(res?.ranking));
	check("the end card names Player 2 (result names), and only them", same(res?.names, { bot_a: "Player 2" }), JSON.stringify(res?.names));
	check("a title naming the winner as the game does", /wins$/.test(res?.title ?? ""), res?.title);
	check("details: turns played, biggest chain, cells held",
		["Turns played", "Biggest chain", "Cells held at the end"].every((l) => res?.details?.some((d) => d.label === l)), JSON.stringify(res?.details));
	// PLAY AGAIN keeps the table as it was.
	rules.init({ seats, seed: 6, match: 1 });
	check("PLAY AGAIN keeps Player 2 at the table", rules.view({ seat: "host" }).players[1].kind === "local");
	// The person leaving: bots take the local seats over.
	rules.apply({ action: { start: true }, by: "host" });
	rules.leave({ seat: "host" });
	v = rules.view({ seat: null });
	check("if the person leaves, their local seats go back to the bots", v.players[1].kind === "bot" && v.players[1].name === "Bot Ada");

	// Different devices: two people and a bot need no setting up.
	rules.init({ seats: [seats[0], { id: "sam", name: "Sam", team: "A", bot: false }, seats[1]], seed: 7, match: 0 });
	check("two people on their own phones: play starts at once", rules.view({ seat: "sam" }).phase === "play" && same(rules.turn(), ["host"]));
	rules.apply({ action: { cell: 0 }, by: "host" });
	check("…each plays their own seat only", typeof rules.apply({ action: { cell: 1 }, by: "host" }) === "string" && rules.apply({ action: { cell: 5 }, by: "sam" }) === undefined);
	check("…and no names are given for the end card", (() => {
		const s = rules.snapshot();
		s.g.winner = 0;
		return rules.result().names === undefined;
	})());
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
