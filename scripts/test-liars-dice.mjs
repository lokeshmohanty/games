#!/usr/bin/env node
/**
 * test-liars-dice.mjs — the counting, the bid ladder, and the bot.
 *
 *   node scripts/test-liars-dice.mjs
 *
 * Two rules decide every round and both are easy to get subtly wrong in a way
 * that still looks like a working game: **ones are wild**, and a call is
 * settled by "at least", not "exactly". Both are pinned here.
 */
import { readFileSync } from "node:fs";

globalThis.window = globalThis;
globalThis.location = { href: "file:///x", hash: "", pathname: "/x", search: "" };
globalThis.history = { replaceState() {} };
for (const f of ["../lib/net.js", "../lib/games.js", "../lib/secrets.js", "../games/liars-dice.js"]) {
	new Function(readFileSync(new URL(f, import.meta.url), "utf8"))();
}
const R = globalThis.NeonArcade.liarsDiceRules;
const { DICE, FACES, countFace, countAll, validBid, bidBeats, raisesAfter, resolveCall, rollDice, botAction } = R;

let failures = 0;
const check = (label, ok, detail = "") => {
	console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
	if (!ok) failures++;
};

// ---------------------------------------------------------------------------
console.log("\ncounting, with ones wild");

check("a plain match counts", countFace([3, 3, 5, 6, 2], 3) === 2);
check("ones count as any face", countFace([1, 3, 1, 6, 2], 3) === 3, `${countFace([1, 3, 1, 6, 2], 3)}`);
check("a hand of all ones matches everything", countFace([1, 1, 1, 1, 1], 5) === 5);
check("nothing matches when nothing does", countFace([2, 3, 4, 5, 6], 6) === 1);
check("the table is the sum of the hands",
	countAll([[1, 4, 4], [4, 2, 2], [6, 6, 1]], 4) === 3 + 1 + 1,
	`${countAll([[1, 4, 4], [4, 2, 2], [6, 6, 1]], 4)}`);

// ---------------------------------------------------------------------------
console.log("\nthe bid ladder");

check("an opening bid is legal", bidBeats({ count: 2, face: 3 }, null));
check("more dice beats fewer", bidBeats({ count: 3, face: 2 }, { count: 2, face: 6 }));
check("the same count with a higher face raises", bidBeats({ count: 2, face: 5 }, { count: 2, face: 3 }));
check("the same count with a lower face does not", !bidBeats({ count: 2, face: 2 }, { count: 2, face: 3 }));
check("repeating a bid is not a raise", !bidBeats({ count: 2, face: 3 }, { count: 2, face: 3 }));
check("going down is not a raise", !bidBeats({ count: 1, face: 6 }, { count: 2, face: 3 }));
// Bidding on ones is out — they are wild, and a bid on them would count them
// twice. Perudo has a special rule for it; this game does not have the rule, so
// it must not have the bid either.
check("you cannot bid on ones", !bidBeats({ count: 3, face: 1 }, null));
check("a nonsense bid is refused", !validBid({ count: 0, face: 3 }) && !validBid({ count: 2, face: 9 }));

{
	const after = raisesAfter({ count: 2, face: 4 }, 10);
	check("every generated raise really is one", after.every((b) => bidBeats(b, { count: 2, face: 4 })));
	check("the cheapest raise comes first", after[0].count === 2 && after[0].face === 5, JSON.stringify(after[0]));
	check("nothing exceeds the dice on the table", after.every((b) => b.count <= 10));
	check("an opening ladder starts at one", raisesAfter(null, 5)[0].count === 1);
}

// ---------------------------------------------------------------------------
console.log("\nsettling a call");

{
	const hands = [[3, 3, 1], [3, 2, 2], [5, 6, 1]];
	// threes: 2+1 wild, 1, 0+1 wild = 5
	check("the table is counted with wilds", resolveCall(hands, { count: 5, face: 3 }).actual === 5,
		`${resolveCall(hands, { count: 5, face: 3 }).actual}`);
	check("an exact bid stands", resolveCall(hands, { count: 5, face: 3 }).bidderWasRight);
	// "At least", not "exactly" — the bid claims there are *that many*, and more
	// than that many does not make it a lie.
	check("an under-bid stands too", resolveCall(hands, { count: 4, face: 3 }).bidderWasRight);
	check("an over-bid falls", !resolveCall(hands, { count: 6, face: 3 }).bidderWasRight);
}

// ---------------------------------------------------------------------------
console.log("\nrolling");

{
	const rolls = rollDice(5000);
	check("dice land on real faces", rolls.every((d) => d >= 1 && d <= FACES));
	const counts = Array.from({ length: FACES }, (_, i) => rolls.filter((d) => d === i + 1).length);
	const spread = Math.max(...counts) - Math.min(...counts);
	check("and roughly evenly", spread < 5000 * 0.06, `spread ${spread} over 5000`);
	check("you get the number you asked for", rollDice(3).length === 3);
}

// ---------------------------------------------------------------------------
console.log("\nthe bot");

{
	// Ten dice on the table, the bot holding none of the face: "nine fives" is
	// not survivable and must be called.
	check("it calls a bid the table cannot hold",
		botAction([2, 2, 3, 3, 4], { count: 9, face: 5 }, 5).type === "liar");
	check("it calls a bid of more dice than exist",
		botAction([2, 2, 3, 3, 4], { count: 11, face: 5 }, 5).type === "liar");

	// Holding four fives itself, "three fives" is comfortably true — calling it
	// would be throwing a die away.
	const easy = botAction([5, 5, 5, 5, 1], { count: 3, face: 5 }, 5);
	check("it does not call a bid it can see is true", easy.type === "bid", JSON.stringify(easy));
	check("and its answer is a legal raise", bidBeats(easy, { count: 3, face: 5 }), JSON.stringify(easy));

	const opening = botAction([4, 4, 2, 6, 1], null, 10);
	check("it can open", opening.type === "bid" && validBid(opening), JSON.stringify(opening));
}

const STATS = { bids: 0, rounds: 0 };

/** Play a whole table out. Returns the winning seat. */
function playGame(seatCount, rng = Math.random) {
	const dice = Array.from({ length: seatCount }, () => DICE);
	let starter = 0;
	for (let round = 0; round < 400; round++) {
		const alive = dice.map((n, i) => (n > 0 ? i : -1)).filter((i) => i >= 0);
		if (alive.length <= 1) return alive[0] ?? -1;
		STATS.rounds++;
		const hands = dice.map((n) => rollDice(n, rng));
		let bid = null;
		let bidder = null;
		let turn = alive.includes(starter) ? starter : alive[0];
		for (let step = 0; step < 200; step++) {
			const unknown = alive.reduce((n, i) => n + (i === turn ? 0 : dice[i]), 0);
			const action = botAction(hands[turn], bid, unknown, rng);
			if (action.type === "liar" && bid) {
				const { bidderWasRight } = resolveCall(alive.map((i) => hands[i]), bid);
				const loser = bidderWasRight ? turn : bidder;
				dice[loser]--;
				starter = dice[loser] > 0 ? loser : turn;
				break;
			}
			if (action.type !== "bid" || !bidBeats(action, bid)) return "illegal";
			bid = { count: action.count, face: action.face };
			bidder = turn;
			STATS.bids++;
			turn = alive[(alive.indexOf(turn) + 1) % alive.length];
		}
	}
	return "stuck";
}

{
	let broken = 0;
	let stuck = 0;
	const winners = new Map();
	for (let i = 0; i < 120; i++) {
		const w = playGame(4);
		if (w === "illegal") broken++;
		else if (w === "stuck") stuck++;
		else winners.set(w, (winners.get(w) ?? 0) + 1);
	}
	check("no bot ever produced an illegal bid", broken === 0, `${broken}`);
	check("every table played to a winner", stuck === 0, `${stuck} stuck`);
	// Four identical bots should share the wins. A seat taking most of them
	// would mean turn order, not play, is deciding the game.
	const spread = Math.max(...winners.values()) - Math.min(...winners.values());
	check(`no seat dominates (${[...winners.entries()].sort().map(([s, n]) => `${s}:${n}`).join(" ")})`,
		spread <= 26, `spread ${spread} over 120 games`);

	// A round is one deal and ends the moment somebody calls. If the bots only
	// ever make the cheapest legal raise the ladder crawls, nobody reaches a bid
	// worth calling, and a round runs dozens of turns — a game that technically
	// works and nobody would sit through.
	const perRound = STATS.bids / STATS.rounds;
	console.log(`  ·    ${perRound.toFixed(1)} bids per round over ${STATS.rounds} rounds`);
	check("a round is settled in a handful of bids", perRound < 6, `${perRound.toFixed(1)} bids per round`);
}

// ---------------------------------------------------------------------------
console.log("\nthe reveal, under a race");

{
	// The bug this pins: verifying a commitment is asynchronous, and the round
	// settles by taking a die off the loser. If the seat is read *after* the
	// await rather than before it, an honest player who just lost a die is
	// accused of opening the wrong number of dice. It surfaced once, in one bot,
	// in a suite that otherwise passed.
	const room = { getMember: () => null, makeAction: () => ({ send() {} }), selfId: "me", isHost: () => true };
	const secrets = globalThis.NeonArcade.makeSecrets(room);
	await secrets.ready();

	const hand = rollDice(5);
	const c = await secrets.commit(hand);

	let dice = 5; // the seat, which settling is about to decrement
	const verdicts = {};
	const takeReveal = async (payload) => {
		const expected = dice; // read before the await — the fix
		const ok = await secrets.verify({ digest: c.digest, nonce: payload.nonce, value: payload.hand });
		verdicts.snapshot = ok && payload.hand.length === expected ? null : "accused";
	};
	const takeRevealBuggy = async (payload) => {
		const ok = await secrets.verify({ digest: c.digest, nonce: payload.nonce, value: payload.hand });
		verdicts.afterAwait = ok && payload.hand.length === dice ? null : "accused";
	};

	const payload = { hand: c.value, nonce: c.nonce };
	const inFlight = [takeReveal(payload), takeRevealBuggy(payload)];
	dice = 4; // the round settles while the verifications are still running
	await Promise.all(inFlight);

	check("reading the seat before the await clears an honest player", verdicts.snapshot === null, `${verdicts.snapshot}`);
	// Not a requirement — a demonstration that the ordering is what mattered,
	// so a future refactor that moves the read back gets caught by the line above.
	check("reading it after the await is what accused them", verdicts.afterAwait === "accused", `${verdicts.afterAwait}`);
	secrets.dispose();
}

console.log(failures ? `\n${failures} failing\n` : "\nall passing\n");
process.exit(failures ? 1 : 0);
