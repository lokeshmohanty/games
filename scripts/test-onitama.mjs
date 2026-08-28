#!/usr/bin/env node
/**
 * test-onitama.mjs — the rules and the search, with no board to click.
 *
 *   node scripts/test-onitama.mjs
 *
 * Onitama's rules are small and almost entirely about orientation: the same
 * card means two different things depending on which end of the board you sit
 * at, and there is a *second*, purely visual flip on top of that so each player
 * sees their own side at the bottom. Get either one backwards and the game
 * still runs, still looks plausible, and is wrong. So the offsets are checked
 * against the board rather than eyeballed against the card art.
 *
 * The last section measures the bot instead of asserting it is not obviously
 * stupid, which is what `STATUS.md` records as missing for the other three.
 */
import { readFileSync } from "node:fs";

globalThis.window = globalThis;
globalThis.location = { href: "file:///x", hash: "", pathname: "/x", search: "" };
globalThis.history = { replaceState() {} };
for (const f of ["../lib/net.js", "../lib/games.js", "../games/onitama.js"]) {
	new Function(readFileSync(new URL(f, import.meta.url), "utf8"))();
}
const R = globalThis.NeonArcade.onitamaRules;
const { RED, BLUE, CARDS, CARD_IDS, TEMPLE, startBoard, destination, legalMoves, applyMove, applyPass, cloneState, chooseMove } = R;

let failures = 0;
const check = (label, ok, detail = "") => {
	console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
	if (!ok) failures++;
};

const board = (spec) => {
	// spec: { "r,c": "rm" | "rs" | "bm" | "bs" }
	const b = Array.from({ length: 5 }, () => Array(5).fill(null));
	for (const [at, what] of Object.entries(spec)) {
		const [r, c] = at.split(",").map(Number);
		b[r][c] = { side: what[0] === "r" ? RED : BLUE, master: what[1] === "m" };
	}
	return b;
};

// ---------------------------------------------------------------------------
console.log("\ncards");

check("sixteen cards", CARD_IDS.length === 16, `${CARD_IDS.length}`);
{
	let bad = [];
	for (const id of CARD_IDS) {
		const seen = new Set();
		for (const [dx, dy] of CARDS[id].moves) {
			if (Math.abs(dx) > 2 || Math.abs(dy) > 2) bad.push(`${id} out of range`);
			if (dx === 0 && dy === 0) bad.push(`${id} has a null move`);
			if (seen.has(`${dx},${dy}`)) bad.push(`${id} repeats a move`);
			seen.add(`${dx},${dy}`);
		}
		if (!CARDS[id].moves.length) bad.push(`${id} has no moves`);
	}
	check("every card fits on its own 5x5 and repeats nothing", bad.length === 0, bad.join("; "));
	const reds = CARD_IDS.filter((id) => CARDS[id].first === RED).length;
	check("the first-player stamps are evenly split", reds === 8, `${reds} red`);
}

// The orientation claim, stated as a property rather than a table: whatever a
// card does for Red from a square, it does the mirror of for Blue.
{
	let bad = [];
	for (const id of CARD_IDS) {
		for (const mv of CARDS[id].moves) {
			const [rr, rc] = destination(RED, 2, 2, mv);
			const [br, bc] = destination(BLUE, 2, 2, mv);
			if (rr - 2 !== -(br - 2) || rc - 2 !== -(bc - 2)) bad.push(`${id} ${mv}`);
		}
	}
	check("blue reads every card exactly upside down", bad.length === 0, bad.join("; "));
}

// ---------------------------------------------------------------------------
console.log("\nthe opening position");

{
	const b = startBoard();
	const all = b.flat().filter(Boolean);
	check("ten pieces", all.length === 10, `${all.length}`);
	check("one master a side", all.filter((p) => p.master).length === 2);
	check("each master starts on its own temple arch",
		b[TEMPLE[RED][0]][TEMPLE[RED][1]]?.master && b[TEMPLE[BLUE][0]][TEMPLE[BLUE][1]]?.master);

	// Tiger jumps two forward (five legal), crab steps one forward (five legal);
	// crab's two sideways moves are blocked by Red's own back rank.
	const s = { board: b, hands: [["tiger", "crab"], ["dragon", "frog"]], side: "monkey", turn: RED };
	check("ten opening moves with tiger and crab", legalMoves(s, RED).length === 10, `${legalMoves(s, RED).length}`);
	check("no move lands on one of your own pieces",
		legalMoves(s, RED).every((m) => !s.board[m.to[0]][m.to[1]] || s.board[m.to[0]][m.to[1]].side !== RED));
}

// ---------------------------------------------------------------------------
console.log("\nwinning, and the card cycle");

{
	// Red master on (2,2), Blue master directly ahead. Ox steps forward.
	const s = {
		board: board({ "2,2": "rm", "1,2": "bm", "4,0": "rs", "0,0": "bs" }),
		hands: [["ox", "horse"], ["dragon", "frog"]],
		side: "monkey",
		turn: RED,
	};
	const mv = legalMoves(s, RED).find((m) => m.to[0] === 1 && m.to[1] === 2 && m.capture?.master);
	check("capturing the master is generated as a move", !!mv);
	const end = applyMove(s, RED, mv);
	check("the Way of the Stone ends it", end?.winner === RED && end.by === "stone", JSON.stringify(end));

	// The card you used is the card they get.
	check("the used card moved to the side", s.side === "ox", s.side);
	check("the old side card is now in hand", s.hands[RED].includes("monkey"), s.hands[RED].join(","));
	check("no card was duplicated", new Set([...s.hands[0], ...s.hands[1], s.side]).size === 5);
	check("the turn passed", s.turn === BLUE);
}

{
	// Red master one step from Blue's arch at (0,2).
	const s = {
		board: board({ "1,2": "rm", "3,3": "bm", "4,0": "rs" }),
		hands: [["ox", "horse"], ["dragon", "frog"]],
		side: "monkey",
		turn: RED,
	};
	const mv = legalMoves(s, RED).find((m) => m.to[0] === 0 && m.to[1] === 2);
	const end = applyMove(s, RED, mv);
	check("the Way of the Stream ends it", end?.winner === RED && end.by === "stream", JSON.stringify(end));
}

{
	// Blue's mirror of the same thing, because this is exactly where an
	// orientation bug hides: it works for one side and not the other.
	const s = {
		board: board({ "3,2": "bm", "1,1": "rm", "0,0": "bs" }),
		hands: [["dragon", "frog"], ["ox", "horse"]],
		side: "monkey",
		turn: BLUE,
	};
	const mv = legalMoves(s, BLUE).find((m) => m.to[0] === 4 && m.to[1] === 2);
	check("blue can reach red's arch too", !!mv);
	const end = applyMove(s, BLUE, mv);
	check("and it ends the game for blue", end?.winner === BLUE && end.by === "stream", JSON.stringify(end));
}

{
	// A player with no legal move still hands a card over: the position does not
	// change, the cards do. The official rules say so, and this implements it —
	// but note what the branch actually is.
	//
	// Searching for a position that reaches it found none: 375,000 random
	// one-to-three-piece placements against every card pair, plus an exhaustive
	// sweep of every four- and five-piece arrangement in the back two rows and
	// the right-hand 3x3 against all 120 card pairs. Zero stuck positions. That
	// is not proof it cannot happen, and it is a good reason not to *claim* a
	// natural fixture here — so the state below is built by hand, and the pass
	// path in the game is a rule faithfully implemented rather than a case
	// anyone is likely to hit.
	const s = {
		board: board({ "4,2": "rm", "0,2": "bm" }),
		hands: [["crane", "boar"], ["dragon", "frog"]],
		side: "monkey",
		turn: RED,
	};
	const before = JSON.stringify(s.board);
	applyPass(s, RED, "crane");
	check("passing leaves the board alone", JSON.stringify(s.board) === before);
	check("passing still cycles a card", s.side === "crane" && s.hands[RED].includes("monkey"));
	check("passing does not disturb the other card", s.hands[RED].includes("boar"));
	check("passing still ends the turn", s.turn === BLUE);
	check("passing loses no card", new Set([...s.hands[0], ...s.hands[1], s.side]).size === 5);
}

// ---------------------------------------------------------------------------
console.log("\nthe bot");

{
	const s = {
		board: board({ "2,2": "rm", "1,2": "bm", "4,0": "rs", "0,0": "bs" }),
		hands: [["ox", "horse"], ["dragon", "frog"]],
		side: "monkey",
		turn: RED,
	};
	const mv = chooseMove(s, RED, 300);
	check("it takes a master it can take", mv?.to[0] === 1 && mv?.to[1] === 2, JSON.stringify(mv?.to));
}

{
	const s = {
		board: board({ "1,2": "rm", "3,3": "bm", "4,0": "rs", "0,0": "bs" }),
		hands: [["ox", "horse"], ["dragon", "frog"]],
		side: RED,
		turn: RED,
	};
	s.side = "monkey";
	const mv = chooseMove(s, RED, 300);
	check("it walks into the arch when that wins", mv?.to[0] === 0 && mv?.to[1] === 2, JSON.stringify(mv?.to));
}

{
	const t0 = Date.now();
	const s = { board: startBoard(), hands: [["tiger", "crab"], ["dragon", "frog"]], side: "monkey", turn: RED };
	chooseMove(s, RED, 250);
	const took = Date.now() - t0;
	// Iterative deepening must abandon a ply it cannot finish, or a phone locks
	// up mid-game for however long the next depth happens to take.
	check("it respects its time budget", took < 1200, `${took}ms`);
}

/** Play one full game; returns the winner, or null if it hit the move cap. */
function playGame(pickRed, pickBlue) {
	const deck = [...CARD_IDS].sort(() => Math.random() - 0.5).slice(0, 5);
	const s = {
		board: startBoard(),
		hands: [deck.slice(0, 2), deck.slice(2, 4)],
		side: deck[4],
		turn: CARDS[deck[4]].first,
	};
	for (let ply = 0; ply < 200; ply++) {
		const side = s.turn;
		const moves = legalMoves(s, side);
		if (!moves.length) {
			applyPass(s, side, s.hands[side][0]);
			continue;
		}
		const chosen = (side === RED ? pickRed : pickBlue)(s, side, moves);
		// Every move a player produces must be one the rules generated.
		if (!moves.some((m) => m.card === chosen.card && m.from[0] === chosen.from[0] && m.from[1] === chosen.from[1] && m.to[0] === chosen.to[0] && m.to[1] === chosen.to[1])) {
			return "illegal";
		}
		const end = applyMove(s, side, chosen);
		if (end) return end.winner;
		if (new Set([...s.hands[0], ...s.hands[1], s.side]).size !== 5) return "cards-lost";
	}
	return null;
}

const randomly = (s, side, moves) => moves[Math.floor(Math.random() * moves.length)];
const botly = (s, side) => chooseMove(s, side, 60);

{
	const GAMES = 20;
	let botWins = 0;
	let broken = 0;
	let unfinished = 0;
	for (let i = 0; i < GAMES; i++) {
		// Alternate colours, so a first-move advantage is not read as strength.
		const botIsRed = i % 2 === 0;
		const w = playGame(botIsRed ? botly : randomly, botIsRed ? randomly : botly);
		if (w === "illegal" || w === "cards-lost") broken++;
		else if (w === null) unfinished++;
		else if (w === (botIsRed ? RED : BLUE)) botWins++;
	}
	check("no player ever produced an illegal move or lost a card", broken === 0, `${broken}`);
	check("every game reached a result", unfinished === 0, `${unfinished} hit the ply cap`);
	// The point of a strategy game is that the strategy wins. A 60ms search
	// against random play should be close to unbeatable; anything under this is
	// a broken evaluation, not variance.
	check(`the bot beats random play (${botWins}/${GAMES})`, botWins >= 18, `${botWins}/${GAMES}`);
}

console.log(failures ? `\n${failures} failing\n` : "\nall passing\n");
process.exit(failures ? 1 : 0);
