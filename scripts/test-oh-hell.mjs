#!/usr/bin/env node
/**
 * test-oh-hell.mjs — following suit, taking tricks, and the bot.
 *
 *   node scripts/test-oh-hell.mjs
 *
 * Two rules carry the whole game and both fail quietly. **Follow the suit led
 * if you hold it** — get that wrong and it does not crash, it just produces an
 * opponent who trumps when they should not. And **a high card of the wrong suit
 * wins nothing** — get that wrong and aces become unbeatable, which looks like
 * bad luck rather than a bug.
 *
 * The deal is checked for the property the sealed channel exists to protect:
 * that the hands are disjoint. A deck that hands the same queen to two people
 * is the one failure no amount of encryption would make up for.
 */
import { readFileSync } from "node:fs";

globalThis.window = globalThis;
globalThis.location = { href: "file:///x", hash: "", pathname: "/x", search: "" };
globalThis.history = { replaceState() {} };
for (const f of ["../lib/net.js", "../lib/games.js", "../games/oh-hell.js"]) {
	new Function(readFileSync(new URL(f, import.meta.url), "utf8"))();
}
const R = globalThis.NeonArcade.ohHellRules;
const { HANDS, cardName, freshDeck, shuffle, deal, legalPlays, trickWinner, scoreFor, botBid, botPlay } = R;

let failures = 0;
const check = (label, ok, detail = "") => {
	console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
	if (!ok) failures++;
};

const S = { spade: 0, heart: 1, diamond: 2, club: 3 };
const c = (r, s) => ({ r, s });
const key = (card) => `${card.r}.${card.s}`;

// ---------------------------------------------------------------------------
console.log("\nthe deck and the deal");

{
	const deck = freshDeck();
	check("fifty-two cards", deck.length === 52);
	check("no duplicates", new Set(deck.map(key)).size === 52);
	check("thirteen of each suit", [0, 1, 2, 3].every((s) => deck.filter((x) => x.s === s).length === 13));

	const shuffled = shuffle(deck);
	check("a shuffle keeps every card", new Set(shuffled.map(key)).size === 52);
	check("and changes the order", shuffled.some((x, i) => key(x) !== key(deck[i])));
}

{
	// The property the sealed channel exists to protect. If two players can hold
	// the same card, nothing else about this game matters.
	let overlaps = 0;
	let short = 0;
	for (let i = 0; i < 300; i++) {
		const players = 2 + (i % 5);
		const size = HANDS[i % HANDS.length];
		const { hands, turnUp } = deal(shuffle(freshDeck()), players, size);
		const all = hands.flat().map(key);
		if (new Set(all).size !== all.length) overlaps++;
		if (hands.some((h) => h.length !== size)) short++;
		if (turnUp && all.includes(key(turnUp))) overlaps++;
	}
	check("three hundred deals never give two players the same card", overlaps === 0, `${overlaps}`);
	check("every hand is the size it should be", short === 0, `${short}`);

	const biggest = deal(shuffle(freshDeck()), 6, 5);
	check("six players at five cards still fit in the deck",
		biggest.hands.every((h) => h.length === 5) && !!biggest.turnUp);
}

// ---------------------------------------------------------------------------
console.log("\nfollowing suit");

{
	const hand = [c(5, S.spade), c(9, S.spade), c(14, S.heart), c(3, S.club)];
	check("leading, anything goes", legalPlays(hand, null).length === 4);
	check("holding the suit led, only that suit",
		legalPlays(hand, S.spade).map(key).sort().join() === [c(5, S.spade), c(9, S.spade)].map(key).sort().join());
	check("void in the suit led, anything goes", legalPlays(hand, S.diamond).length === 4);
	check("legalPlays does not hand back the hand itself", legalPlays(hand, null) !== hand);
}

// ---------------------------------------------------------------------------
console.log("\ntaking the trick");

{
	// Highest of the suit led.
	check("the highest card of the led suit wins",
		trickWinner([c(5, S.spade), c(11, S.spade), c(9, S.spade)], S.club) === 1);
	// The trap: a high card of a suit nobody led is worth nothing.
	check("an ace of a suit nobody led wins nothing",
		trickWinner([c(5, S.spade), c(14, S.heart), c(6, S.spade)], S.club) === 2,
		"a discard beat the suit led");
	// Trump beats everything, however small.
	check("the smallest trump beats the biggest plain card",
		trickWinner([c(14, S.spade), c(2, S.club)], S.club) === 1);
	check("the highest trump wins a trump war",
		trickWinner([c(14, S.spade), c(2, S.club), c(7, S.club), c(5, S.club)], S.club) === 2);
	// A no-trump round.
	check("with no trump, only the led suit can win",
		trickWinner([c(4, S.spade), c(14, S.heart), c(14, S.diamond)], null) === 0);
	check("the leader can win their own trick",
		trickWinner([c(14, S.spade), c(3, S.spade)], S.club) === 0);
}

// ---------------------------------------------------------------------------
console.log("\nscoring");

check("exactly what you bid pays", scoreFor(2, 2) === 12);
check("a bid of nothing, taken, pays", scoreFor(0, 0) === 10);
check("one too few pays nothing", scoreFor(2, 1) === 0);
// The rule that makes the endgame interesting: an extra trick is as bad as a
// missing one, so a bot that has made its bid must start losing on purpose.
check("one too many pays nothing either", scoreFor(2, 3) === 0);

// ---------------------------------------------------------------------------
console.log("\nthe bot");

{
	const strong = [c(14, S.club), c(13, S.club), c(12, S.club)];
	const weak = [c(2, S.heart), c(3, S.diamond), c(4, S.spade)];
	check("it bids high on a hand full of trumps", botBid(strong, S.club, 3) >= 2, `${botBid(strong, S.club, 3)}`);
	check("it bids low on a hand of rubbish", botBid(weak, S.club, 3) === 0, `${botBid(weak, S.club, 3)}`);
	check("it never bids more than it holds",
		[...Array(200)].every(() => {
			const { hands, trump } = deal(shuffle(freshDeck()), 4, 5);
			const b = botBid(hands[0], trump, 5);
			return b >= 0 && b <= 5;
		}));
}

{
	// It must follow suit even when that means throwing away a trick.
	const hand = [c(3, S.spade), c(14, S.heart)];
	const trick = [{ card: c(9, S.spade) }];
	const played = botPlay(hand, trick, S.club, 1, 0);
	check("it follows suit when it can", played.s === S.spade, cardName(played));
}

{
	// Chasing a trick it can win: take it, and take it cheaply.
	const hand = [c(4, S.club), c(14, S.club)];
	const trick = [{ card: c(9, S.spade) }];
	const played = botPlay(hand, trick, S.club, 1, 0);
	check("it trumps in when it still needs tricks", played.s === S.club, cardName(played));
	check("and trumps as cheaply as it can", played.r === 4, cardName(played));
}

{
	// Bid already made: an extra trick is a loss, so it must duck.
	const hand = [c(2, S.spade), c(14, S.spade)];
	const trick = [{ card: c(9, S.spade) }];
	const played = botPlay(hand, trick, S.club, 1, 1);
	check("having made its bid, it ducks", played.r === 2, cardName(played));
}

/**
 * Play a whole game with every seat a bot, checking the rules on every play.
 * This is where a follow-suit bug would surface as an actual illegal move
 * rather than as a hunch about the opponent.
 */
function playGame(playerCount, rng = Math.random) {
	const totals = Array(playerCount).fill(0);
	let dealer = 0;
	for (let round = 0; round < HANDS.length; round++) {
		const size = HANDS[round];
		const { hands, trump } = deal(shuffle(freshDeck(), rng), playerCount, size);
		const bids = hands.map((h) => botBid(h, trump, size));
		const taken = Array(playerCount).fill(0);
		let leader = (dealer + 1) % playerCount;

		for (let t = 0; t < size; t++) {
			const trick = [];
			for (let i = 0; i < playerCount; i++) {
				const seat = (leader + i) % playerCount;
				const led = trick.length ? trick[0].card.s : null;
				const legal = legalPlays(hands[seat], led);
				const card = botPlay(hands[seat], trick, trump, bids[seat], taken[seat], rng);
				if (!legal.some((x) => x.r === card.r && x.s === card.s)) return "illegal";
				if (!hands[seat].some((x) => x.r === card.r && x.s === card.s)) return "phantom";
				hands[seat] = hands[seat].filter((x) => !(x.r === card.r && x.s === card.s));
				trick.push({ seat, card });
			}
			const winner = trick[trickWinner(trick.map((p) => p.card), trump)].seat;
			taken[winner]++;
			leader = winner;
		}
		if (hands.some((h) => h.length)) return "cards-left";
		if (taken.reduce((a, b) => a + b, 0) !== size) return "tricks-lost";
		for (let p = 0; p < playerCount; p++) {
			totals[p] += scoreFor(bids[p], taken[p]);
			if (bids[p] === taken[p]) made.hit++;
			made.total++;
		}
		dealer = (dealer + 1) % playerCount;
	}
	return totals;
}

/** Made-bid tally, filled in by playGame. */
const made = { hit: 0, total: 0 };

{
	let broken = 0;
	for (let i = 0; i < 150; i++) {
		const out = playGame(3 + (i % 4));
		if (typeof out === "string") {
			broken++;
			if (broken === 1) console.log(`  ·    first failure: ${out}`);
		}
	}
	check("no bot ever played an illegal or phantom card", broken === 0, `${broken} broken games`);

	// Bidding is the skill in this game. Guessing at random over a five-card
	// round would land somewhere near one in four; if the estimate were doing
	// nothing this would sit there.
	const rate = made.hit / made.total;
	console.log(`  ·    bids made exactly ${(rate * 100).toFixed(0)}% of the time`);
	check("the bots make their bid well above chance", rate > 0.4, `${(rate * 100).toFixed(0)}%`);
}

{
	// Seat fairness, at a **fixed** table. Measuring it across games of three to
	// six players is meaningless: seats 4 and 5 only exist in the bigger ones,
	// so they cannot win the games they were never in.
	const winners = new Map([0, 1, 2, 3].map((s) => [s, 0]));
	for (let i = 0; i < 240; i++) {
		const out = playGame(4);
		if (typeof out === "string") continue;
		const best = out.indexOf(Math.max(...out));
		winners.set(best, winners.get(best) + 1);
	}
	const spread = Math.max(...winners.values()) - Math.min(...winners.values());
	check(`no seat dominates a four-player table (${[...winners.entries()].map(([s, n]) => `${s}:${n}`).join(" ")})`,
		spread <= 34, `spread ${spread} over 240 games`);
}

console.log(failures ? `\n${failures} failing\n` : "\nall passing\n");
process.exit(failures ? 1 : 0);
