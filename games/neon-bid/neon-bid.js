// games/neon-bid.js — Neon Bid, a sealed-bid gem auction, as a mountable module.
//
// Twelve gems — four colours, three of each — are auctioned one at a time, in
// an order everybody can see from the start. Every player has 100 credits for
// the whole game. Each lot, everyone bids in secret at once; the highest bid
// wins and pays the **second-highest** bid (a lone bidder pays the reserve, 1);
// a tie for highest refunds everybody and the gem is lost. Sets score 1/3/6,
// plus 4 for owning every colour. The full design, and why each rule is the
// way it is, is `docs/neon-bid.md`.
//
// ## Nobody sees a bid early — not even the host
//
// The host referees, and the host is a player. If bids were simply mailed to
// the host, the host would bid last with everybody else's numbers in hand. So
// every bid is **committed** (`lib/secrets.js`) during a collecting phase and
// opened only after everyone has committed; the host checks each opening
// against its commitment *and* against the bidder's credits, and a bad opening
// counts as 0. Same shape as Liar's Dice and Battleship — see the
// `unrefereed-honesty` memory in the multiplayer skill.
//
// The lot order is a shuffle the host makes once and publishes before the
// first bid. That is the only random thing in the game, and once it is public
// there is nothing left for anybody to know that the others do not.
//
// ## Rounds
//
// One round per lot, three phases: `bid` collects commitments and ends the
// moment everyone has one in; `open` collects the openings, and the host ends
// it with `rounds.next()` as soon as the lot is settled; `show` is the reveal
// on screen.

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

	function score(hand) {
		let points = 0;
		for (const n of hand) points += SET_POINTS[Math.min(n, SET_POINTS.length - 1)];
		return points + (hasRainbow(hand) ? RAINBOW : 0);
	}

	/** Points one more gem of `colour` would add to `hand`, right now. */
	const marginal = (hand, colour) => score(withGem(hand, colour)) - score(hand);

	/** The "worth to you" line: how many points, and why. */
	function worth(hand, colour) {
		const n = hand[colour];
		const reasons = [n === 0 ? "a new colour" : n === 1 ? "makes a pair" : "completes the set"];
		if (!hasRainbow(hand) && hasRainbow(withGem(hand, colour))) reasons.push(`rainbow +${RAINBOW}`);
		return { points: marginal(hand, colour), reasons };
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

	/** A fresh game: public order, 100 credits each, empty hands. */
	const newGame = (ids, rng = Math.random) => ({
		order: shuffledOrder(rng),
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
	function standings(players) {
		const rows = players
			.map((p) => ({ id: p.id, points: score(p.hand), credits: p.credits, hand: [...p.hand], rainbow: hasRainbow(p.hand) }))
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

	function gemValue(hand, colour) {
		let v = marginal(hand, colour);
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
		const leader = [...others].sort((a, b) => score(b.hand) - score(a.hand) || b.credits - a.credits)[0];
		const deny = leader && score(leader.hand) >= score(me.hand) ? marginal(leader.hand, colour) * DENY : 0;
		const value = gemValue(me.hand, colour) + deny;
		if (value <= 0) return 0;

		const mean = rest.reduce((s, c) => s + gemValue(me.hand, c), 0) / rest.length || 1;
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

	NeonArcade.neonBidRules = {
		COLOURS, PER_COLOUR, LOTS, START_CREDITS, RESERVE, SET_POINTS, RAINBOW,
		shuffledOrder, emptyHand, score, marginal, worth, validBid, resolveLot,
		newGame, applyLot, standings, auditBid, gemValue, botBid,
	};
})();

NeonArcade.registerGame({
	id: "neon-bid",
	name: "NEON BID",
	blurb: "Twelve gems, 100 credits, sealed bids. The winner pays the second-highest bid.",
	shape: "free",
	seats: { min: 2, max: 8 },

	mount(ctx) {
		const { room } = ctx;
		const R = NeonArcade.neonBidRules;
		const { COLOURS, LOTS } = R;

		// Seat colours are the theme's (lib/theme.css --p1…--p8) — and so are the
		// gems' (--p2…--p5), so four seats share a colour with a gem. A seat is
		// therefore marked by a ring in its colour around its initial
		// (`seatMark`), never by a filled dot that could read as a gem.
		const SEAT_HEX = Array.from({ length: 8 }, (_, i) => `var(--p${i + 1})`);
		const CHIPS = [0, 5, 10, 25];

		const secrets = NeonArcade.makeSecrets(room, { onError: (e) => setNotice(e.reason) });

		// ------------------------------------------------------------- markup

		const shell = NeonArcade.gameShell(ctx.root, {
			css: `
				.nb-fill { justify-content: flex-start; gap: 10px; max-width: 480px; }
				.nb-row { display: grid; grid-template-columns: repeat(12, minmax(0, 26px));
					gap: 3px; justify-content: center; width: 100%; padding-top: 8px; }
				.nb-slot { display: flex; flex-direction: column; align-items: center; gap: 3px;
					transition: transform 0.25s, opacity 0.25s; }
				.nb-slot.now { transform: translateY(-6px); }
				.nb-slot.now .nb-glow { animation: nb-pulse 1.1s ease-in-out infinite; }
				.nb-slot.won { opacity: 0.6; }
				.nb-slot.lost { opacity: 0.2; }
				.nb-glow { width: 100%; filter: drop-shadow(0 0 4px var(--gem)); }
				/* clip-path rather than a rotated square: a rotated box is wider than
				   its layout slot, and twelve of them overflowed a 390px phone. */
				.nb-gem { width: 100%; aspect-ratio: 5 / 6; background: linear-gradient(160deg,
					color-mix(in oklch, var(--gem) 25%, white) 0%, var(--gem) 38%, color-mix(in oklch, var(--gem) 55%, black) 100%);
					clip-path: polygon(50% 0, 100% 35%, 50% 100%, 0 35%); }
				/* A seat: a ring in its colour around its initial. Under a gem it says who
				   won it; the empty one holds the row's height. */
				.nb-mark { box-sizing: border-box; display: inline-grid; place-items: center; min-width: 16px;
					height: 16px; padding: 0 2px; border: 2px solid var(--seat); border-radius: 8px;
					background: var(--panel); color: var(--ink); font: 700 9px/1 var(--font-display); }
				.nb-mark.none { visibility: hidden; }
				@keyframes nb-pulse { 50% { filter: drop-shadow(0 0 10px var(--gem)) brightness(1.25); } }

				.nb-seats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px 8px;
					width: 100%; font-size: 0.72rem; }
				.nb-seat { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 2px 6px;
					align-items: center; padding: 4px 6px; border: 1px solid var(--border);
					border-radius: 6px; background: var(--panel); }
				.nb-seat.me { border-color: var(--accent); }
				.nb-seat .who { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
				.nb-seat .ready { color: var(--good); }
				.nb-seat .cr { color: var(--muted); font-variant-numeric: tabular-nums; }
				.nb-seat .gems { grid-column: 2 / 4; display: flex; gap: 8px; color: var(--muted);
					font-variant-numeric: tabular-nums; }
				.nb-seat .gems i { font-style: normal; }
				.nb-tiny { display: inline-block; width: 8px; height: 9px; margin-right: 2px;
					clip-path: polygon(50% 0, 100% 35%, 50% 100%, 0 35%); background: var(--gem); }

				.nb-lot { display: flex; align-items: center; gap: 16px; justify-content: center; }
				.nb-big { width: 64px; flex: none; }
				.nb-big .nb-glow { animation: nb-pulse 1.4s ease-in-out infinite; }
				.nb-lot .txt { display: flex; flex-direction: column; gap: 2px; }
				.nb-lot .lotno { font-size: 0.7rem; letter-spacing: 0.14em; color: var(--muted); }
				.nb-lot .name { font-size: 1.3rem; color: var(--ink); }
				.nb-worth { font-size: 0.95rem; color: var(--accent); text-shadow: 0 0 8px var(--accent-glow); }
				.nb-worth small { display: block; font-size: 0.72rem; color: var(--muted); text-shadow: none; }

				.nb-panel { width: 100%; display: flex; flex-direction: column; align-items: center; gap: 8px; }
				.nb-wallet { font-size: 0.85rem; color: var(--muted); }
				.nb-wallet b { color: var(--ink); font-size: 1.1rem; font-variant-numeric: tabular-nums; }
				.nb-step { display: flex; align-items: center; gap: 10px; }
				.nb-step button, .nb-chips button { min-width: 50px; min-height: 46px; font-size: 1.1rem;
					background: var(--panel); border: 2px solid var(--border); border-radius: 8px;
					color: var(--accent); cursor: pointer; touch-action: manipulation; }
				.nb-step button:disabled, .nb-chips button:disabled { opacity: 0.35; cursor: default; }
				.nb-step output { min-width: 3ch; text-align: center; font-size: 2rem; color: var(--ink);
					font-variant-numeric: tabular-nums; }
				.nb-chips { display: flex; gap: 8px; }
				.nb-chips button.sel { border-color: var(--accent); }
				.nb-go { min-height: 52px; min-width: 220px; font-size: 16px; }

				.nb-banner { font-size: 0.95rem; text-align: center; color: var(--ink); min-height: 1.3em; }
				.nb-banner small { display: block; font-size: 0.72rem; color: var(--muted); }
				.nb-cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; width: 100%;
					perspective: 600px; }
				.nb-card { display: flex; flex-direction: column; align-items: center; gap: 1px; padding: 6px 2px;
					border: 1px solid var(--border); border-radius: 8px; background: var(--panel);
					font-size: 0.68rem; color: var(--muted); animation: nb-flip 0.45s ease-out both; }
				.nb-card .who { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
				.nb-card .amt { font-size: 1.35rem; color: var(--ink); font-variant-numeric: tabular-nums; }
				.nb-card.win { border-color: var(--accent); box-shadow: 0 0 12px var(--accent-glow); }
				.nb-card.win .amt { color: var(--accent); }
				.nb-card.tie { border-color: var(--warn); }
				.nb-card.bad { border-color: var(--danger); }
				.nb-card .pays { color: var(--accent); }
				@keyframes nb-flip { from { transform: rotateY(90deg); opacity: 0; } to { transform: none; opacity: 1; } }

				.nb-table { width: 100%; border-collapse: collapse; font-size: 0.78rem; }
				.nb-table th { font-weight: normal; color: var(--muted); font-size: 0.65rem; letter-spacing: 0.08em;
					text-align: left; padding: 2px 4px; }
				.nb-table td { padding: 5px 4px; border-top: 1px solid var(--border); font-variant-numeric: tabular-nums; }
				.nb-table td.who { max-width: 90px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
				.nb-table tr.win td { color: var(--accent); }
				.nb-table td.pts { font-size: 1rem; color: var(--ink); }
				.nb-table tr.win td.pts { color: var(--accent); }
				.nb-notice { font-size: 0.7rem; color: var(--warn); min-height: 1em; text-align: center; }
			`,
		});

		const el = (tag, className, text) => {
			const node = document.createElement(tag);
			if (className) node.className = className;
			if (text != null) node.textContent = text;
			return node;
		};

		const fill = el("div", "g-fill nb-fill");
		const gemRow = el("div", "nb-row");
		gemRow.setAttribute("aria-label", "The twelve lots, in order");
		const seatsEl = el("div", "nb-seats");
		const lotEl = el("div", "nb-lot");
		const panel = el("div", "nb-panel");
		const notice = el("div", "nb-notice");
		fill.append(gemRow, seatsEl, lotEl, panel, notice);
		shell.stage.append(fill);

		const setNotice = (t) => {
			notice.textContent = t ?? "";
		};

		// -------------------------------------------------------------- state

		let phase = "waiting"; // waiting | bid | open | show | over
		let game = null; // public: { order, lot, players, results } — see newGame
		let digests = {}; // id -> digest for the lot being bid; published once collected
		let opened = {}; // host only: id -> { lot, bid, nonce } for this lot
		let over = null; // { rows, winners, match }
		let matchNo = 0; // host: games started in this run
		let reportedOver = null;

		/** Tell the platform how it ended — places by points, then credits. */
		function reportOver() {
			if (!over || reportedOver === over) return;
			reportedOver = over;
			const places = [];
			for (const r of over.rows) {
				const last = places.at(-1);
				if (last && last.points === r.points && last.credits === r.credits) last.ids.push(r.id);
				else places.push({ points: r.points, credits: r.credits, ids: [r.id] });
			}
			ctx.reportResult?.({
				kind: "ffa",
				match: over.match ?? 1,
				ranking: places.map((p) => p.ids),
				scores: Object.fromEntries(over.rows.map((r) => [r.id, r.points])),
			});
		}
		let myCommit = null; // { lot, bid, commit }
		let committing = false;
		let botCommits = {}; // host only: botId -> { lot, bid, commit }
		let botPrep = { lot: -1, promise: Promise.resolve() };
		let settledLot = -1;
		let settling = false;
		let openTimer = null;
		let draft = 0;
		let disposed = false;

		const seatOf = (id) => game?.players.find((p) => p.id === id) ?? null;
		const mySeat = () => seatOf(room.selfId);
		const amPlaying = () => !!mySeat() && !over;
		const seatHex = (id) => SEAT_HEX[Math.max(0, game?.players.findIndex((p) => p.id === id) ?? 0) % SEAT_HEX.length];
		const nameOf = (id) => (id === room.selfId ? "You" : ctx.nameOf(id));
		const themeNow = () => document.documentElement.dataset.theme || "paper";
		const gemName = (colour) => COLOURS[colour].names?.[themeNow()] ?? COLOURS[colour].name;

		/** One letter per seat, two where two names share a first letter. */
		function initialOf(id) {
			const first = (who) => Array.from(nameOf(who).trim() || "?")[0].toUpperCase();
			const mine = first(id);
			const clash = (game?.players ?? []).some((p) => p.id !== id && first(p.id) === mine);
			return clash ? Array.from(nameOf(id).trim()).slice(0, 2).join("") : mine;
		}
		function seatMark(id) {
			const mark = el("span", "nb-mark", initialOf(id));
			mark.style.setProperty("--seat", seatHex(id));
			return mark;
		}
		// The lot on the table is the round clock's, never `game.lot`: a guest can
		// receive the settled state (lot already advanced) a moment before the
		// phase change, and reading `game.lot` then flashes the *next* gem.
		const curLot = () => (over || !game || phase === "waiting" ? -1 : rounds.state().round);

		// ------------------------------------------------------------ the wire

		const stateAction = room.makeAction("nbState");
		const openAction = room.makeAction("nbOpen");

		/**
		 * Publish the state **and redraw our own screen** — the host sends the
		 * state and never receives it, so without the redraw its own screen
		 * freezes (Liar's Dice learned this the hard way).
		 */
		function pushState() {
			if (ctx.isHost) stateAction.send({ game, digests, over });
			render();
		}

		// ------------------------------------------------------------- rounds

		const rounds = NeonArcade.makeRounds(ctx, {
			name: "nbRound",
			rounds: LOTS,
			phases: [
				// Ends the moment everybody has committed. The deadline only
				// matters for somebody who has walked away; their bid is a pass.
				{ name: "bid", ms: 60_000, collect: true },
				// The host ends this with `rounds.next()` once the lot is settled;
				// the deadline is a backstop for an opening that never arrives.
				{ name: "open", ms: 6_000 },
				{ name: "show", ms: 3_200 },
			],
			// Synchronous, so the commitment has to exist already: bots' bids for
			// the next lot are committed while the previous one is on show.
			botSubmit: (botId, info) => {
				// A bot added after the deal has no seat; it passes, or the phase
				// would wait out its deadline for it every lot.
				if (!seatOf(botId)) return "pass";
				const held = botCommits[botId];
				return held && held.lot === info.round ? held.commit.digest : undefined;
			},
			onPhase: (info) => {
				phase = info.phase;
				// A reload lands here first, on whatever phase is running.
				if (info.phase !== "bid") restoreBid(info);
				if (info.phase === "bid") beginBid(info);
				else if (info.phase === "open") beginOpen(info);
				else if (info.phase === "show" && ctx.isHost && settledLot < info.round) settle();
				render();
			},
			onTick: () => {
				renderHud();
				renderSeats();
				if (phase === "bid") renderPanel();
			},
			onCollect: ({ entries }) => {
				// Host side: the commitments are in, and now they are public.
				// Only seated players' — a late arrival's "pass" is not a bid.
				digests = Object.fromEntries([...entries].filter(([id]) => seatOf(id)));
				pushState();
			},
			onFinish: () => {
				if (!ctx.isHost || !game) return;
				over = { ...R.standings(game.players), match: matchNo };
				phase = "over";
				pushState();
				reportOver();
			},
		});

		const lotNow = () => rounds.state().round;

		// ---------------------------------------------------------------- bid

		function beginBid(info) {
			myCommit = null;
			committing = false;
			opened = {};
			digests = {};
			const me = mySeat();
			if (me) draft = Math.min(draft, me.credits);
			setNotice("");
			restoreBid(info);
			// Somebody who arrived after the deal has no seat but is still in
			// `players()`, so the phase waits for them: answer for them.
			if (!me && ctx.players().includes(room.selfId)) rounds.submit("pass");
			if (!ctx.isHost) return;
			// A backstop for `botSubmit`: if a bot's commitment was not ready when
			// the phase opened, submit it the moment it is.
			prepareBots(info.round).then(() => {
				if (disposed || phase !== "bid" || lotNow() !== info.round) return;
				const already = rounds.state().submitted;
				for (const [id, held] of Object.entries(botCommits)) {
					if (held.lot === info.round && !already.includes(id)) rounds.submitFor(id, held.commit.digest);
				}
			});
		}

		/**
		 * After a reload, take back the bid sealed for this lot before it. Valid
		 * while bidding if the host already counts us in, and after that only if
		 * the published digest is its own. Without it the bid is never opened,
		 * which the audit treats as a pass at best.
		 */
		function restoreBid(info) {
			if (myCommit || ctx.isHost) return;
			const held = secrets.kept("neon-bid");
			if (!held || held.lot !== info.round) return;
			const mine = digests[room.selfId];
			const ok = mine
				? mine === held.commit.digest
				: info.phase === "bid" && info.submitted?.includes(room.selfId);
			if (ok) myCommit = held;
		}

		/** Host side. Decide and commit every bot's bid for `lot`, once. */
		function prepareBots(lot) {
			if (!ctx.isHost || !game) return Promise.resolve();
			if (botPrep.lot === lot) return botPrep.promise;
			// Decided from the state as it stands before the lot opens, all at
			// once, so no bot's bid can depend on another's.
			const bids = game.players
				.filter((p) => ctx.isBot(p.id))
				.map((p) => [p.id, R.botBid(game, p.id)]);
			const promise = (async () => {
				for (const [id, bid] of bids) {
					const commit = await secrets.commit(bid);
					if (disposed) return;
					botCommits[id] = { lot, bid, commit };
				}
			})();
			botPrep = { lot, promise };
			return promise;
		}

		async function placeBid() {
			const me = mySeat();
			if (phase !== "bid" || !me || myCommit || committing) return;
			const bid = Math.max(0, Math.min(draft, me.credits));
			const lot = lotNow();
			committing = true;
			render();
			const commit = await secrets.commit(bid);
			committing = false;
			if (disposed) return;
			if (phase !== "bid" || lotNow() !== lot) {
				render();
				return;
			}
			myCommit = { lot, bid, commit };
			secrets.keep("neon-bid", myCommit);
			rounds.submit(commit.digest);
			render();
		}

		// --------------------------------------------------------------- open

		function beginOpen(info) {
			if (ctx.isHost) {
				// An opening that never comes is that player's loss, not the table's.
				// Armed *before* the openings below: when only the host and bots are
				// bidding they all open right here and settle the lot synchronously,
				// and a timer armed after that fired into the next lot's bidding and
				// settled it as everybody passing (fixed 2026-11-14). It is also tied
				// to this lot, so it can never settle another.
				clearTimeout(openTimer);
				openTimer = setTimeout(() => settle(info.round), 4_000);
			}
			if (myCommit && myCommit.lot === info.round) {
				const payload = { lot: info.round, bid: myCommit.commit.value, nonce: myCommit.commit.nonce };
				if (ctx.isHost) takeOpen(room.selfId, payload);
				else openAction.send(payload, { target: room.hostId() });
			}
			if (!ctx.isHost) return;
			for (const [id, held] of Object.entries(botCommits)) {
				if (held.lot === info.round) takeOpen(id, { lot: info.round, bid: held.commit.value, nonce: held.commit.nonce });
			}
		}

		/** Host side. One player's opened bid. */
		function takeOpen(id, payload) {
			if (!ctx.isHost || phase !== "open" || payload?.lot !== lotNow()) return;
			opened[id] = payload;
			if (Object.keys(digests).every((d) => opened[d])) settle();
		}

		/**
		 * Host side. Audit every opening, then settle the lot. Only ever the lot
		 * the round clock is on, and only once its bids are opening or open: the
		 * clock is what everybody's screen shows, and settling `game.lot` while
		 * the clock is still collecting bids for it throws that lot away.
		 */
		async function settle(expected = lotNow()) {
			if (!ctx.isHost || !game || settling) return;
			const lot = game.lot;
			if (settledLot >= lot || lot >= LOTS) return;
			if (lot !== expected || lot !== lotNow() || (phase !== "open" && phase !== "show")) return;
			settling = true;
			clearTimeout(openTimer);
			// Snapshot everything the audit is judged against before the first
			// await — see `auditBid`.
			const snap = game.players.map((p) => ({
				id: p.id,
				credits: p.credits,
				digest: digests[p.id],
				opened: opened[p.id],
			}));
			const audits = await Promise.all(snap.map((s) => R.auditBid(s, secrets.verify)));
			if (disposed) return;
			const bids = {};
			const problems = {};
			snap.forEach((s, i) => {
				bids[s.id] = audits[i].bid;
				if (audits[i].problem) problems[s.id] = audits[i].problem;
			});
			const result = R.applyLot(game, bids);
			result.problems = problems;
			settledLot = lot;
			settling = false;
			pushState();
			if (game.lot < LOTS) prepareBots(game.lot);
			if (phase === "open") rounds.next();
		}

		// ---------------------------------------------------------- messages

		stateAction.onMessage = (msg, { peerId }) => {
			if (ctx.isHost || peerId !== room.hostId()) return;
			game = msg.game;
			digests = msg.digests ?? {};
			over = msg.over ?? null;
			if (over) {
				phase = "over";
				if (reportedOver?.match !== over.match) reportOver();
			}
			// The digests can land after the phase did (see restoreBid): open now.
			if (!myCommit && phase === "open") {
				restoreBid(rounds.state());
				if (myCommit) beginOpen(rounds.state());
			}
			render();
		};

		openAction.onMessage = (payload, { peerId }) => {
			if (ctx.isHost) takeOpen(peerId, payload);
		};

		// -------------------------------------------------------------- render

		function gem(colour, className = "") {
			const glow = el("div", "nb-glow " + className);
			glow.style.setProperty("--gem", COLOURS[colour].hex);
			glow.append(el("div", "nb-gem"));
			return glow;
		}

		function renderRow() {
			if (!game) {
				gemRow.replaceChildren();
				return;
			}
			const current = curLot();
			gemRow.replaceChildren(
				...game.order.map((colour, i) => {
					const result = game.results[i];
					const slot = el("div", "nb-slot");
					if (i === current) slot.classList.add("now");
					if (result && i !== current) slot.classList.add(result.kind === "won" ? "won" : "lost");
					const mark = result?.kind === "won" ? seatMark(result.winner) : el("span", "nb-mark none");
					mark.setAttribute("aria-hidden", "true");
					slot.append(gem(colour), mark);
					slot.setAttribute("aria-label", `${gemName(colour)}${result ? (result.kind === "won" ? `, won by ${nameOf(result.winner)}` : ", lost") : ""}`);
					return slot;
				}),
			);
		}

		function renderSeats() {
			if (!game) {
				seatsEl.replaceChildren();
				return;
			}
			const ready = phase === "bid" ? rounds.state().submitted : [];
			seatsEl.replaceChildren(
				...game.players.map((p) => {
					const box = el("div", "nb-seat" + (p.id === room.selfId ? " me" : ""));
					const sw = seatMark(p.id);
					const who = el("span", "who", nameOf(p.id));
					if (ready.includes(p.id)) who.append(el("span", "ready", " ✓"));
					const cr = el("span", "cr", `${p.credits} cr`);
					const gems = el("span", "gems");
					p.hand.forEach((n, c) => {
						const g = el("i");
						const t = el("span", "nb-tiny");
						t.style.setProperty("--gem", COLOURS[c].hex);
						g.append(t, document.createTextNode(String(n)));
						gems.append(g);
					});
					gems.append(el("span", null, `${R.score(p.hand)} pts`));
					box.append(sw, who, cr, gems);
					return box;
				}),
			);
		}

		function renderLot() {
			lotEl.replaceChildren();
			if (!game || over) return;
			const i = curLot();
			if (i < 0 || i >= LOTS) return;
			const colour = game.order[i];
			const big = el("div", "nb-big");
			big.append(gem(colour));
			const txt = el("div", "txt");
			txt.append(el("span", "lotno", `LOT ${i + 1} OF ${LOTS}`), el("span", "name", gemName(colour)));
			const me = mySeat();
			if (me && phase === "bid") {
				const w = R.worth(me.hand, colour);
				const line = el("div", "nb-worth", `+${w.points} point${w.points === 1 ? "" : "s"} to you`);
				line.append(el("small", null, w.reasons.join(" · ")));
				txt.append(line);
			}
			lotEl.append(big, txt);
		}

		function stillToBid() {
			const ready = rounds.state().submitted;
			const present = ctx.players();
			return (game?.players ?? []).filter((p) => present.includes(p.id) && !ready.includes(p.id)).length;
		}

		function renderBidPanel() {
			const me = mySeat();
			if (!me) {
				panel.append(el("div", "nb-wallet", "Watching — bids open together when everyone is in."));
				return;
			}
			const lotsLeft = LOTS - game.lot;
			const wallet = el("div", "nb-wallet");
			wallet.append("You have ", el("b", null, String(me.credits)), ` credits · ~${Math.floor(me.credits / Math.max(1, lotsLeft))} per lot left`);

			const locked = !!myCommit || committing;
			const step = el("div", "nb-step");
			const stepBtn = (label, delta, aria) => {
				const b = el("button", null, label);
				b.type = "button";
				b.setAttribute("aria-label", aria);
				b.disabled = locked || draft + delta < 0 || draft + delta > me.credits;
				b.addEventListener("click", () => {
					draft = Math.max(0, Math.min(me.credits, draft + delta));
					render();
				});
				return b;
			};
			const out = el("output", null, String(locked && myCommit ? myCommit.bid : draft));
			out.setAttribute("aria-label", "your bid");
			step.append(stepBtn("−", -1, "bid one less"), out, stepBtn("+", 1, "bid one more"));

			const chips = el("div", "nb-chips");
			for (const v of CHIPS) {
				const b = el("button", draft === v ? "sel" : "", String(v));
				b.type = "button";
				b.setAttribute("aria-label", v === 0 ? "pass" : `bid ${v}`);
				b.disabled = locked || v > me.credits;
				b.addEventListener("click", () => {
					draft = v;
					render();
				});
				chips.append(b);
			}

			const go = el("button", "neon-btn nb-go");
			go.type = "button";
			if (myCommit) {
				const n = stillToBid();
				go.textContent = n ? `WAITING FOR ${n} MORE…` : "OPENING…";
				go.disabled = true;
			} else if (committing) {
				go.textContent = "SEALING…";
				go.disabled = true;
			} else {
				go.textContent = draft === 0 ? "PASS" : `BID ${draft}`;
				go.addEventListener("click", placeBid);
			}
			panel.append(wallet, step, chips, go);
		}

		function renderReveal() {
			const result = game.results[curLot()] ?? null;
			const banner = el("div", "nb-banner");
			if (!result) {
				banner.textContent = "Opening the bids…";
				panel.append(banner);
				return;
			}
			const colour = gemName(result.colour);
			if (result.kind === "won") {
				banner.textContent = `${nameOf(result.winner)} ${result.winner === room.selfId ? "win" : "wins"} the ${colour} gem`;
				banner.append(el("small", null, `pays ${result.price} — the second-highest bid${result.price === R.RESERVE && Object.values(result.bids).filter((b) => b > 0).length === 1 ? " (nobody else bid: the reserve)" : ""}`));
			} else if (result.kind === "tie") {
				banner.textContent = `Tie at ${result.top} — nobody pays`;
				banner.append(el("small", null, `the ${colour} gem is lost`));
			} else {
				banner.textContent = "Everybody passed";
				banner.append(el("small", null, `the ${colour} gem is lost`));
			}
			const cards = el("div", "nb-cards");
			game.players.forEach((p, i) => {
				const amt = result.bids[p.id] ?? 0;
				const card = el("div", "nb-card");
				// Staggered, so the flip reads as everyone at once rather than a list.
				card.style.animationDelay = `${i * 40}ms`;
				if (result.winner === p.id) card.classList.add("win");
				if (result.tied?.includes(p.id)) card.classList.add("tie");
				const problem = result.problems?.[p.id];
				if (problem) card.classList.add("bad");
				card.append(el("span", "who", nameOf(p.id)), el("span", "amt", amt ? String(amt) : "–"));
				if (problem) card.append(el("span", null, "⚠ forfeited"));
				else if (result.winner === p.id) card.append(el("span", "pays", `pays ${result.price}`));
				else card.append(el("span", null, amt ? "bid" : "pass"));
				if (problem) card.title = problem;
				cards.append(card);
			});
			panel.append(banner, cards);
			const bad = Object.entries(result.problems ?? {});
			if (bad.length) setNotice(bad.map(([id, why]) => `${nameOf(id)} ${why} — counted as 0`).join(" · "));
		}

		function renderEnd() {
			const table = el("table", "nb-table");
			const head = el("tr");
			head.append(el("th", null, ""), ...COLOURS.map((c, ci) => {
				const th = el("th");
				const t = el("span", "nb-tiny");
				t.style.setProperty("--gem", c.hex);
				th.append(t);
				th.setAttribute("aria-label", gemName(ci));
				return th;
			}), el("th", null, "🌈"), el("th", null, "CR"), el("th", null, "PTS"));
			table.append(head);
			for (const row of over.rows) {
				const tr = el("tr", over.winners.includes(row.id) ? "win" : "");
				tr.append(el("td", "who", nameOf(row.id)), ...row.hand.map((n) => el("td", null, String(n))),
					el("td", null, row.rainbow ? "✓" : ""), el("td", null, String(row.credits)), el("td", "pts", String(row.points)));
				table.append(tr);
			}
			panel.append(table);
			if (ctx.isHost) {
				const again = el("button", "neon-btn nb-go", "NEW GAME");
				again.type = "button";
				again.addEventListener("click", startGame);
				panel.append(again);
			}
		}

		// The panel holds the buttons, and it is redrawn on every clock tick while
		// bidding. Rebuilding a button between a finger going down and coming up
		// eats the tap, and rebuilding the reveal replays its flip — so it is only
		// rebuilt when something it shows has changed.
		let panelKey = "";
		function renderPanel() {
			const me = mySeat();
			const key = JSON.stringify([phase, curLot(), !!over, draft, me?.credits, !!myCommit, committing,
				phase === "bid" ? stillToBid() : 0, !!game?.results[curLot()], game?.players.length, themeNow()]);
			if (key === panelKey) return;
			panelKey = key;
			panel.replaceChildren();
			if (!game) return;
			if (over) renderEnd();
			else if (phase === "bid") renderBidPanel();
			else if (phase === "open" || phase === "show") renderReveal();
		}

		function renderHud() {
			const parts = [];
			if (over) {
				const w = over.winners;
				const text = w.length > 1
					? `Shared win: ${w.map(nameOf).join(" & ")}`
					: w[0] === room.selfId ? "You win" : `${nameOf(w[0])} wins`;
				parts.push({ key: "s", text });
			} else if (!game) {
				parts.push({ key: "s", text: "Laying out the gems…", className: "g-muted" });
			} else if (phase === "bid") {
				parts.push({ key: "s", text: myCommit ? "Sealed" : "Bid in secret" });
				parts.push({ key: "t", text: `${rounds.state().secondsLeft}s`, className: "g-muted" });
			} else if (phase === "open") {
				parts.push({ key: "s", text: "Bids open", className: "g-muted" });
			} else if (phase === "show") {
				parts.push({ key: "s", text: `Lot ${curLot() + 1} of ${LOTS}`, className: "g-muted" });
			} else {
				parts.push({ key: "s", text: "Getting ready…", className: "g-muted" });
			}
			shell.setHud(parts);
		}

		function render() {
			renderRow();
			renderSeats();
			renderLot();
			renderPanel();
			renderHud();
		}

		// --------------------------------------------------------------- start

		/** Host side. Shuffle the lots once, publish them, then open lot 1. */
		async function startGame() {
			if (!ctx.isHost) return;
			game = R.newGame(ctx.players());
			matchNo++;
			over = null;
			digests = {};
			opened = {};
			botCommits = {};
			botPrep = { lot: -1, promise: Promise.resolve() };
			settledLot = -1;
			settling = false;
			draft = 0;
			setNotice("");
			// The order goes out before anybody bids — it is public on purpose.
			pushState();
			await prepareBots(0);
			if (disposed) return;
			rounds.start();
		}

		// The page tells the frame its theme (sdk client → theme._adopt); a gem's
		// name follows it, so redraw.
		const onTheme = () => render();
		addEventListener("neon:theme", onTheme);

		(async () => {
			await secrets.ready();
			if (disposed) return;
			if (secrets.privacy() !== "sealed") {
				setNotice("This browser cannot make a sealed commitment, so there is no way to keep the bids honest here.");
				return;
			}
			render();
			if (ctx.isHost) startGame();
		})();

		return {
			/**
			 * The crown moved to us mid-auction. Credits, gems and results came
			 * with every broadcast; the sealed bids — the bots', and whatever was
			 * collected for the lot under way — went with the old host. So the
			 * lot that was not yet settled opens for bidding again (Lokesh,
			 * 2026-11-13); everything settled stands.
			 */
			takeOver() {
				if (over || !game) {
					pushState();
					return !!over;
				}
				settledLot = game.lot - 1;
				settling = false;
				botPrep = { lot: -1, promise: Promise.resolve() };
				botCommits = {};
				if (game.lot >= LOTS) return false;
				if (!rounds.adopt({ round: game.lot, index: 0 })) return false;
				pushState();
				return true;
			},
			onPeerJoin() {
				if (!ctx.isHost) return;
				pushState();
				rounds.sync();
			},
			onPeerLeave() {
				// A player who leaves keeps their gems on the table; from now on
				// their bid is simply absent, which is a pass. `makeRounds` stops
				// waiting for them because they are no longer in `players()`.
				if (ctx.isHost) pushState();
			},
			debug: () => ({
				phase,
				lot: game?.lot ?? null,
				// The round clock's lot: the one on screen. Equal to `lot` while
				// bidding; the two drifting apart is how lots got thrown away.
				round: rounds.state().round,
				order: game ? [...game.order] : [],
				players: game ? game.players.map((p) => ({ id: p.id, credits: p.credits, hand: [...p.hand] })) : [],
				results: game ? game.results.map((r) => ({ ...r })) : [],
				digests: Object.keys(digests).length,
				committed: !!myCommit,
				myBid: myCommit?.bid ?? null,
				submitted: rounds.state().submitted,
				over: over ? { ...over } : null,
			}),
			unmount() {
				disposed = true;
				removeEventListener("neon:theme", onTheme);
				clearTimeout(openTimer);
				rounds.dispose();
				secrets.dispose();
				stateAction.onMessage = null;
				openAction.onMessage = null;
				shell.destroy();
			},
		};
	},
});
