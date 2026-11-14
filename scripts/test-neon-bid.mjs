#!/usr/bin/env node
/**
 * test-neon-bid.mjs — the auction rules, the commit-reveal audit, and the bot.
 *
 *   node scripts/test-neon-bid.mjs
 *
 * Three rules decide every lot and each is easy to get subtly wrong in a way
 * that still looks like a working game: the winner pays the **second**-highest
 * bid, a lone bidder pays the reserve (not nothing, not their own bid), and a
 * tie for highest refunds everyone and loses the gem. All three are pinned
 * here, along with the audit — tested by breaking it, because a commitment
 * nobody can fail is decoration — and the bot against a random bidder.
 */
import { readFileSync } from "node:fs";

globalThis.window = globalThis;
globalThis.location = { href: "file:///x", hash: "", pathname: "/x", search: "" };
globalThis.history = { replaceState() {} };
for (const f of ["../lib/net.js", "../lib/games.js", "../lib/secrets.js", "../games/neon-bid/neon-bid.js"]) {
	new Function(readFileSync(new URL(f, import.meta.url), "utf8"))();
}
const R = globalThis.NeonArcade.neonBidRules;
const {
	COLOURS, LOTS, START_CREDITS, RESERVE, score, marginal, worth, validBid, resolveLot,
	newGame, applyLot, standings, auditBid, shuffledOrder, botBid,
} = R;

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

// ---------------------------------------------------------------------------
console.log("\nthe lots");

{
	const order = shuffledOrder(mulberry32(7));
	check("twelve lots", order.length === 12 && LOTS === 12, `${order.length}`);
	check("four colours, three of each",
		COLOURS.every((_, c) => order.filter((x) => x === c).length === 3), JSON.stringify(order));
	const g = newGame(["a", "b", "c"], mulberry32(7));
	check("the order is fixed at the deal, before any bid", same(g.order, order) && g.lot === 0);
	check("everybody starts with 100 credits and nothing else",
		g.players.every((p) => p.credits === START_CREDITS && p.hand.every((n) => n === 0)));
	// Public: the whole order is in the state every peer receives, and applying
	// lots never reorders it.
	const before = [...g.order];
	applyLot(g, { a: 5 });
	check("settling a lot never changes the order", same(g.order, before));
	const many = new Set(Array.from({ length: 50 }, (_, i) => shuffledOrder(mulberry32(i)).join("")));
	check("and it really is shuffled", many.size > 40, `${many.size} distinct of 50`);
}

// ---------------------------------------------------------------------------
console.log("\npaying");

{
	const r = resolveLot({ a: 30, b: 14, c: 9 });
	check("the highest bid wins", r.kind === "won" && r.winner === "a", JSON.stringify(r));
	check("and pays the second-highest bid", r.price === 14, `${r.price}`);
	check("not its own", r.price !== 30);

	const lone = resolveLot({ a: 40, b: 0, c: 0 });
	check("a lone bidder wins", lone.winner === "a");
	check(`and pays the reserve, ${RESERVE}`, lone.price === RESERVE && RESERVE === 1, `${lone.price}`);
	check("bidding the reserve alone still wins it", resolveLot({ a: 1 }).price === 1);

	const tie = resolveLot({ a: 20, b: 20, c: 5 });
	check("a tie for highest has no winner", tie.kind === "tie" && tie.winner === null, JSON.stringify(tie));
	check("and nobody pays", tie.price === 0);
	check("it names who tied", same([...tie.tied].sort(), ["a", "b"]));
	const lowTie = resolveLot({ a: 30, b: 10, c: 10 });
	check("a tie *below* the top does not matter", lowTie.winner === "a" && lowTie.price === 10, JSON.stringify(lowTie));

	check("0 is a pass", resolveLot({ a: 0, b: 7 }).winner === "b" && resolveLot({ a: 0, b: 7 }).price === 1);
	check("everybody passing sells nothing", resolveLot({ a: 0, b: 0 }).kind === "unsold");
	check("nobody bidding at all sells nothing", resolveLot({}).kind === "unsold");
}

{
	const g = newGame(["a", "b"], mulberry32(1));
	const colour = g.order[0];
	const res = applyLot(g, { a: 30, b: 12 });
	check("the winner is charged the second price",
		g.players[0].credits === 88 && g.players[1].credits === 100, JSON.stringify(g.players.map((p) => p.credits)));
	check("and gets the gem of that lot's colour", g.players[0].hand[colour] === 1 && res.colour === colour);
	check("the auction moves to the next lot", g.lot === 1);

	const tieColour = g.order[1];
	applyLot(g, { a: 10, b: 10 });
	check("a tie refunds — credits untouched",
		g.players[0].credits === 88 && g.players[1].credits === 100);
	check("and the gem is discarded, not handed out",
		g.players.every((p) => p.hand[tieColour] === (tieColour === colour ? (p.id === "a" ? 1 : 0) : 0)));
	check("a discarded gem is recorded as such", g.results[1].kind === "tie");

	// Can't bid over credits: a bid above what you hold is a pass, so it can
	// neither win nor set somebody else's price.
	const g2 = newGame(["a", "b"], mulberry32(2));
	g2.players[0].credits = 10;
	const over = applyLot(g2, { a: 50, b: 20 });
	check("a bid over your credits counts as 0", over.bids.a === 0 && over.winner === "b", JSON.stringify(over));
	check("so it does not set the winner's price either", over.price === RESERVE, `${over.price}`);
	check("bidding exactly what you have is fine", validBid(10, 10) && !validBid(11, 10));
	check("only whole credits", !validBid(2.5, 10) && !validBid(-1, 10) && !validBid("5", 10));
	check("nobody's credits ever go below zero", g2.players.every((p) => p.credits >= 0));
}

// ---------------------------------------------------------------------------
console.log("\nscoring");

{
	check("one gem of a colour is 1", score([1, 0, 0, 0]) === 1);
	check("two is 3", score([2, 0, 0, 0]) === 3);
	check("three is 6", score([3, 0, 0, 0]) === 6);
	check("colours add up", score([3, 2, 0, 0]) === 9);
	check("one of every colour adds the rainbow 4", score([1, 1, 1, 1]) === 4 + 4, `${score([1, 1, 1, 1])}`);
	check("a full table: 6+6+3+1 + rainbow", score([3, 3, 2, 1]) === 16 + 4, `${score([3, 3, 2, 1])}`);
	check("no rainbow without the fourth colour", score([3, 3, 3, 0]) === 18);

	check("marginal: a first gem is +1", marginal([0, 0, 0, 0], 0) === 1);
	check("marginal: a pair is +2", marginal([1, 0, 0, 0], 0) === 2);
	check("marginal: the third is +3", marginal([2, 0, 0, 0], 0) === 3);
	check("marginal: the rainbow is included", marginal([1, 1, 1, 0], 3) === 1 + 4);
	const w = worth([1, 1, 1, 0], 3);
	check("'worth to you' says why", w.points === 5 && w.reasons.some((r) => r.includes("rainbow")), JSON.stringify(w));
	check("'worth to you' for a pair", same(worth([1, 0, 0, 0], 0), { points: 2, reasons: ["makes a pair"] }));
}

{
	const s = standings([
		{ id: "a", credits: 10, hand: [2, 0, 0, 0] },
		{ id: "b", credits: 40, hand: [1, 1, 0, 0] },
		{ id: "c", credits: 5, hand: [3, 0, 0, 0] },
	]);
	check("most points wins", same(s.winners, ["c"]) && s.rows[0].id === "c", JSON.stringify(s.winners));

	const t = standings([
		{ id: "a", credits: 10, hand: [2, 0, 0, 0] },
		{ id: "b", credits: 40, hand: [0, 2, 0, 0] },
	]);
	check("tied on points: more credits left wins", same(t.winners, ["b"]), JSON.stringify(t.winners));

	const u = standings([
		{ id: "a", credits: 12, hand: [2, 0, 0, 0] },
		{ id: "b", credits: 12, hand: [0, 2, 0, 0] },
		{ id: "c", credits: 90, hand: [1, 0, 0, 0] },
	]);
	check("tied on both: a shared win", same([...u.winners].sort(), ["a", "b"]), JSON.stringify(u.winners));
}

// ---------------------------------------------------------------------------
console.log("\nthe audit, broken on purpose");

{
	const room = { getMember: () => null, makeAction: () => ({ send() {} }), selfId: "me", isHost: () => true };
	const secrets = globalThis.NeonArcade.makeSecrets(room);
	await secrets.ready();
	const verify = secrets.verify;

	const c = await secrets.commit(17);
	const honest = await auditBid({ digest: c.digest, opened: { bid: c.value, nonce: c.nonce }, credits: 100 }, verify);
	check("an honest opening counts", honest.bid === 17 && honest.problem === null, JSON.stringify(honest));

	// The cheat this exists for: see the others' bids, then open a different one.
	const swapped = await auditBid({ digest: c.digest, opened: { bid: 18, nonce: c.nonce }, credits: 100 }, verify);
	check("an opening that does not match its commitment counts as 0", swapped.bid === 0 && !!swapped.problem, JSON.stringify(swapped));

	const nonce = await auditBid({ digest: c.digest, opened: { bid: 17, nonce: "0".repeat(32) }, credits: 100 }, verify);
	check("so does the right bid with the wrong nonce", nonce.bid === 0 && !!nonce.problem);

	// Committed honestly to a number it cannot pay: the digest verifies, and
	// that is exactly why the credits are a second, separate check.
	const big = await secrets.commit(60);
	const broke = await auditBid({ digest: big.digest, opened: { bid: big.value, nonce: big.nonce }, credits: 40 }, verify);
	check("an opening over the bidder's credits counts as 0", broke.bid === 0 && /credits/.test(broke.problem ?? ""), JSON.stringify(broke));

	const frac = await secrets.commit(2.5);
	const half = await auditBid({ digest: frac.digest, opened: { bid: frac.value, nonce: frac.nonce }, credits: 40 }, verify);
	check("a fractional bid counts as 0", half.bid === 0 && !!half.problem);

	const silent = await auditBid({ digest: c.digest, opened: undefined, credits: 100 }, verify);
	check("committing and never opening counts as 0", silent.bid === 0 && !!silent.problem);

	const absent = await auditBid({ digest: undefined, opened: undefined, credits: 100 }, verify);
	check("never committing is a pass, not a cheat", absent.bid === 0 && absent.problem === null);

	const late = await auditBid({ digest: undefined, opened: { bid: 50, nonce: c.nonce }, credits: 100 }, verify);
	check("an opening with no commitment behind it counts as 0", late.bid === 0);

	// The audited bids feed straight into the lot: a forfeited bid neither wins
	// nor sets the price.
	const g = newGame(["honest", "cheat"], mulberry32(3));
	applyLot(g, { honest: honest.bid, cheat: swapped.bid });
	check("a forfeited bid cannot win the lot",
		g.results[0].winner === "honest" && g.results[0].price === RESERVE, JSON.stringify(g.results[0]));
}

// ---------------------------------------------------------------------------
console.log("\nthe bot");

/** Spends at random, but not all at once: uniform up to twice its fair share. */
function randomBid(game, id, rng) {
	const me = game.players.find((p) => p.id === id);
	const left = game.order.length - game.lot;
	const cap = Math.min(me.credits, Math.floor((2 * me.credits) / left));
	return Math.floor(rng() * (cap + 1));
}

/**
 * A sterner baseline than random: spends its credits evenly over the lots
 * left, with the same noise as the bot, and ignores what the gem is worth. Beating
 * this is what shows the valuation — not just pacing — is doing the work.
 */
function flatBid(game, id, rng) {
	const me = game.players.find((p) => p.id === id);
	const left = game.order.length - game.lot;
	return Math.min(me.credits, Math.round((me.credits / left) * (0.85 + 0.3 * rng())));
}

const strategies = { bot: botBid, random: randomBid, flat: flatBid };

/** Play one game; returns each seat's share of the win (shared wins split). */
function play(kinds, rng) {
	const ids = kinds.map((k, i) => `${k}${i}`);
	const g = newGame(ids, rng);
	let illegal = 0;
	while (g.lot < g.order.length) {
		const bids = {};
		for (const [i, id] of ids.entries()) {
			const b = strategies[kinds[i]](g, id, rng);
			if (!validBid(b, g.players[i].credits)) illegal++;
			bids[id] = b;
		}
		applyLot(g, bids);
	}
	const { winners } = standings(g.players);
	return { share: ids.map((id) => (winners.includes(id) ? 1 / winners.length : 0)), illegal, game: g };
}

{
	const rng = mulberry32(2026);
	let illegal = 0;
	const tally = (kinds, games) => {
		const wins = kinds.map(() => 0);
		for (let n = 0; n < games; n++) {
			// Rotate the seats so seat order is not what is being measured.
			const shift = n % kinds.length;
			const seated = [...kinds.slice(shift), ...kinds.slice(0, shift)];
			const r = play(seated, rng);
			illegal += r.illegal;
			r.share.forEach((s, i) => (wins[(i + shift) % kinds.length] += s));
		}
		return wins;
	};

	const GAMES = 2000;
	const duel = tally(["bot", "random"], GAMES);
	const duelRate = duel[0] / GAMES;
	console.log(`  ·    1 bot vs 1 random: bot wins ${(duelRate * 100).toFixed(1)}% of ${GAMES}`);
	check("heads up, the bot clearly beats a random bidder", duelRate >= 0.75, `${(duelRate * 100).toFixed(1)}%`);

	const crowd = tally(["bot", "random", "random", "random"], GAMES);
	const crowdRate = crowd[0] / GAMES;
	console.log(`  ·    1 bot vs 3 random: bot wins ${(crowdRate * 100).toFixed(1)}% of ${GAMES} (a fair share is 25%)`);
	check("against three random bidders, far more than its share", crowdRate >= 0.5, `${(crowdRate * 100).toFixed(1)}%`);

	const flat = tally(["bot", "flat"], GAMES);
	const flatRate = flat[0] / GAMES;
	console.log(`  ·    1 bot vs 1 even spender: bot wins ${(flatRate * 100).toFixed(1)}% of ${GAMES}`);
	check("and beats a bidder that just spends evenly", flatRate >= 0.6, `${(flatRate * 100).toFixed(1)}%`);

	const bots = tally(["bot", "bot", "bot", "bot"], 800);
	const spread = Math.max(...bots) - Math.min(...bots);
	console.log(`  ·    four bots: ${bots.map((w) => w.toFixed(0)).join(" / ")} of 800`);
	check("four bots share the wins — seat order does not decide it", spread < 800 * 0.1, `spread ${spread.toFixed(0)}`);
	check("no bot ever bid more than it had, or a non-integer", illegal === 0, `${illegal}`);

	// A bot table should be an auction, not a giveaway or a stalemate: most
	// lots sell, and credits actually get spent.
	let sold = 0;
	let spent = 0;
	for (let n = 0; n < 200; n++) {
		const { game } = play(["bot", "bot", "bot"], rng);
		sold += game.results.filter((r) => r.kind === "won").length;
		spent += game.players.reduce((s, p) => s + (START_CREDITS - p.credits), 0);
	}
	console.log(`  ·    three bots: ${(sold / 200).toFixed(1)} of 12 lots sold, ${(spent / 200 / 3).toFixed(0)} credits spent each`);
	check("most lots sell at a bot table", sold / 200 >= 9, `${(sold / 200).toFixed(1)}`);
	check("and the bots spend their credits", spent / 200 / 3 >= 40, `${(spent / 200 / 3).toFixed(0)}`);

	// Every table size the game seats, not just three. At 7–8 bots the
	// valuation ran past the balance, the bots still holding 100 all bid 100,
	// and the tie threw away every gem from about lot 4 on — in every game.
	const thin = [];
	for (let seats = 2; seats <= 8; seats++) {
		let soldHere = 0;
		let stalled = 0;
		for (let n = 0; n < 100; n++) {
			const { game } = play(Array(seats).fill("bot"), rng);
			soldHere += game.results.filter((r) => r.kind === "won").length;
			let run = 0;
			for (const r of game.results) {
				run = r.kind === "tie" ? run + 1 : 0;
				if (run >= 4) {
					stalled++;
					break;
				}
			}
		}
		if (soldHere / 100 < 9 || stalled) thin.push(`${seats} seats: ${(soldHere / 100).toFixed(1)} sold, ${stalled} stalled`);
	}
	check("at every table size, 2 to 8, most lots sell and no game stalls on ties", !thin.length, thin.join("; "));
}

console.log(failures ? `\n${failures} neon bid check${failures > 1 ? "s" : ""} failed` : "\nall neon bid checks passed");
process.exit(failures ? 1 : 0);
