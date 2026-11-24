// games/neon-bid/rules.js — Neon Bid's rules: pure functions, no DOM, no wire.
//
// Twelve gems — four colours, three of each — are auctioned one at a time, in
// an order everybody can see from the start. Every player has 100 credits for
// the whole game. Each lot, everyone bids in secret at once; the highest bid
// wins and pays the **second-highest** bid (a lone bidder pays the reserve, 1);
// a tie for highest refunds everybody and the gem is lost. Sets score 1/3/6,
// plus 4 for owning every colour. The full design, and why each rule is the
// way it is, is `docs/neon-bid.md`.
//
// Its own file so scripts/test-neon-bid.mjs can load the rules alone; the
// game's frame inlines it ahead of neon-bid.js (index.html), which reads
// `globalThis.neonBidRules`.

(() => {
	// `--p3` is true cyan only under Neon; Paper draws it blue, and a gem called
	// Cyan that is plainly blue reads as a mistake. `names` is per theme.
	const COLOURS = [
		{ key: "cyan", name: "Cyan", names: { paper: "Blue" }, hex: "var(--p3)" },
		{ key: "magenta", name: "Magenta", hex: "var(--p4)" },
		{ key: "lime", name: "Lime", hex: "var(--p5)" },
		{ key: "amber", name: "Amber", hex: "var(--p2)" },
	];
	const PER_COLOUR = 3;
	const LOTS = COLOURS.length * PER_COLOUR;
	const START_CREDITS = 100;
	const RESERVE = 1;
	// Points for holding 0, 1, 2 or 3 gems of one colour. Escalating, so a third
	// gem is worth more than a first — which is what makes a gem worth different
	// amounts to different players.
	const SET_POINTS = [0, 1, 3, 6];
	const RAINBOW = 4;
	// The "Hot colour" option (Lokesh, 2026-11-24): one colour, drawn at the
	// deal and shown from the start, whose set scores this much more (1/3/6
	// becomes 2/4/7). `hot` below is that colour's index, or null without the
	// option; every function taking it defaults to none, as before.
	const HOT_BONUS = 1;

	/** The twelve lots, shuffled. Made once by the host and then public. */
	function shuffledOrder(rng = Math.random) {
		const order = [];
		for (let c = 0; c < COLOURS.length; c++) {
			for (let k = 0; k < PER_COLOUR; k++) order.push(c);
		}
		for (let i = order.length - 1; i > 0; i--) {
			const j = Math.floor(rng() * (i + 1));
			[order[i], order[j]] = [order[j], order[i]];
		}
		return order;
	}

	const emptyHand = () => COLOURS.map(() => 0);
	const withGem = (hand, colour) => hand.map((n, i) => (i === colour ? n + 1 : n));
	const hasRainbow = (hand) => hand.every((n) => n > 0);

	function score(hand, hot = null) {
		let points = 0;
		for (const n of hand) points += SET_POINTS[Math.min(n, SET_POINTS.length - 1)];
		if (hot != null && hand[hot] > 0) points += HOT_BONUS;
		return points + (hasRainbow(hand) ? RAINBOW : 0);
	}

	/** Points one more gem of `colour` would add to `hand`, right now. */
	const marginal = (hand, colour, hot = null) => score(withGem(hand, colour), hot) - score(hand, hot);

	/** The "worth to you" line: how many points, and why. */
	function worth(hand, colour, hot = null) {
		const n = hand[colour];
		const reasons = [n === 0 ? "a new colour" : n === 1 ? "makes a pair" : "completes the set"];
		if (colour === hot && n === 0) reasons.push(`hot +${HOT_BONUS}`);
		if (!hasRainbow(hand) && hasRainbow(withGem(hand, colour))) reasons.push(`rainbow +${RAINBOW}`);
		return { points: marginal(hand, colour, hot), reasons };
	}

	/** A bid is a whole number of credits you actually have. 0 is a pass. */
	const validBid = (bid, credits) => Number.isInteger(bid) && bid >= 0 && bid <= credits;

	/**
	 * Settle one lot from everybody's bid (already audited).
	 *
	 * The highest bid wins and pays the second-highest; a lone bidder pays the
	 * reserve. A tie *for highest* is not broken by anything — no seat order,
	 * no coin — because every tiebreak a host could apply is one a host could
	 * bend: nobody wins, nobody pays, and the gem is lost to everyone.
	 *
	 * @param {Object<string, number>} bids  id -> amount; a missing id or 0 passes
	 * @returns {{ kind: "won"|"tie"|"unsold", winner: string|null, price: number, top: number, tied?: string[] }}
	 */
	function resolveLot(bids) {
		const live = Object.entries(bids)
			.filter(([, b]) => b > 0)
			.sort((a, b) => b[1] - a[1]);
		if (!live.length) return { kind: "unsold", winner: null, price: 0, top: 0 };
		const top = live[0][1];
		const atTop = live.filter(([, b]) => b === top);
		if (atTop.length > 1) {
			return { kind: "tie", winner: null, price: 0, top, tied: atTop.map(([id]) => id) };
		}
		const price = live.length > 1 ? live[1][1] : RESERVE;
		return { kind: "won", winner: live[0][0], price, top };
	}

	/** A fresh game: public order, 100 credits each, empty hands; with `opts.hot`, a hot colour drawn after the order. */
	const newGame = (ids, rng = Math.random, opts = {}) => ({
		order: shuffledOrder(rng),
		hot: opts?.hot ? Math.floor(rng() * COLOURS.length) : null,
		lot: 0,
		players: ids.map((id) => ({ id, credits: START_CREDITS, hand: emptyHand() })),
		results: [],
	});

	/**
	 * Apply one lot's bids to `game`, in place, and return what happened.
	 *
	 * Every bid is checked again here against the bidder's credits, so a caller
	 * that forgot the audit still cannot overdraw anybody: an impossible bid is a
	 * pass. Ids that are not seated are ignored.
	 */
	function applyLot(game, bids) {
		if (game.lot >= game.order.length) throw new Error("applyLot: the auction is over");
		const colour = game.order[game.lot];
		const clean = {};
		for (const p of game.players) {
			const b = bids[p.id];
			clean[p.id] = validBid(b, p.credits) ? b : 0;
		}
		const outcome = resolveLot(clean);
		if (outcome.kind === "won") {
			const p = game.players.find((x) => x.id === outcome.winner);
			p.credits -= outcome.price;
			p.hand[colour]++;
		}
		const result = { lot: game.lot, colour, ...outcome, bids: clean };
		game.results.push(result);
		game.lot++;
		return result;
	}

	/**
	 * Final table, best first. Ties on points break by credits left; still tied
	 * is a shared win — every row in `winners`.
	 */
	function standings(players, hot = null) {
		const rows = players
			.map((p) => ({ id: p.id, points: score(p.hand, hot), credits: p.credits, hand: [...p.hand], rainbow: hasRainbow(p.hand) }))
			.sort((a, b) => b.points - a.points || b.credits - a.credits);
		const best = rows[0];
		const winners = best ? rows.filter((r) => r.points === best.points && r.credits === best.credits).map((r) => r.id) : [];
		return { rows, winners };
	}

	/**
	 * The host's check on one opened bid. Returns the bid that counts, and why
	 * not when it is 0 for cause.
	 *
	 * `credits` must be a snapshot taken **before** this is awaited: the lot is
	 * settled — and the winner's credits taken — while other verifications may
	 * still be in flight, and judging a bid against the credits left *after*
	 * paying is how Liar's Dice once accused an honest player.
	 */
	async function auditBid({ digest, opened, credits }, verify) {
		// No commitment means the player never bid — a pass, not a cheat.
		if (!digest) return { bid: 0, problem: null };
		if (!opened) return { bid: 0, problem: "never opened their bid" };
		const ok = await Promise.resolve(verify({ digest, nonce: opened.nonce, value: opened.bid })).catch(() => false);
		if (!ok) return { bid: 0, problem: "opened a different bid from the one they committed to" };
		if (!validBid(opened.bid, credits)) return { bid: 0, problem: "bid more credits than they have" };
		return { bid: opened.bid, problem: null };
	}

	// ---------------------------------------------------------------- the bot
	//
	// Second price makes the honest strategy simple — bid what the gem is worth
	// to you — so the bot's whole job is a valuation, in two parts:
	//
	//   - **points**: what this gem adds to its own hand, plus a share of the
	//     rainbow bonus for a colour it does not have yet (the bonus is real
	//     long before the fourth colour lands, and a bot that only counts it on
	//     completion never starts collecting);
	//   - **denial**: half of what the gem would add to whoever is leading.
	//
	// Points become credits by comparing this lot with the average lot still to
	// come and scaling by the credits it can spend per lot it can expect to win.
	// Unspent credits score nothing but a tiebreak, so the scale is aggressive.

	const DENY = 0.5;

	function gemValue(hand, colour, hot = null) {
		let v = marginal(hand, colour, hot);
		const missing = hand.filter((n) => n === 0).length;
		if (hand[colour] === 0 && missing > 1) v += RAINBOW / missing;
		return v;
	}

	function botBid(game, botId, rng = Math.random) {
		const me = game.players.find((p) => p.id === botId);
		if (!me || me.credits <= 0 || game.lot >= game.order.length) return 0;
		const colour = game.order[game.lot];
		const rest = game.order.slice(game.lot);

		const others = game.players.filter((p) => p.id !== botId);
		const hot = game.hot ?? null;
		const leader = [...others].sort((a, b) => score(b.hand, hot) - score(a.hand, hot) || b.credits - a.credits)[0];
		const deny = leader && score(leader.hand, hot) >= score(me.hand, hot) ? marginal(leader.hand, colour, hot) * DENY : 0;
		const value = gemValue(me.hand, colour, hot) + deny;
		if (value <= 0) return 0;

		const mean = rest.reduce((s, c) => s + gemValue(me.hand, c, hot), 0) / rest.length || 1;
		const bidders = Math.max(1, game.players.filter((p) => p.credits > 0).length);
		const lotsToWin = Math.max(1, rest.length / bidders);
		const perLot = me.credits / lotsToWin;
		const noise = 0.85 + 0.3 * rng();
		// Never simply all-in. At a big table the valuation runs past the balance,
		// and bots with equal balances all bidding everything tie for highest —
		// which throws the gem away, every lot, for the rest of the game (at 7–8
		// seats that was most lots in every game, 2026-11-14). A ceiling a random
		// step below the balance puts them on different numbers.
		const ceiling = Math.floor(me.credits * (0.7 + 0.3 * rng()));
		return Math.max(0, Math.min(ceiling, Math.round((value / mean) * perLot * noise)));
	}

	globalThis.neonBidRules = {
		COLOURS, PER_COLOUR, LOTS, START_CREDITS, RESERVE, SET_POINTS, RAINBOW, HOT_BONUS,
		shuffledOrder, emptyHand, score, marginal, worth, validBid, resolveLot,
		newGame, applyLot, standings, auditBid, gemValue, botBid,
	};
})();
