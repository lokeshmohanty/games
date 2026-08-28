// games/liars-dice.js — Liar's Dice (Perudo), as a mountable module.
//
// Five dice each, under a cup. A bid names a quantity and a face — "four
// fours" — and claims that many exist across *everyone's* dice. Each player in
// turn raises the bid or calls the last one a lie. When somebody calls, every
// cup lifts: if the bid was good the caller loses a die, otherwise the bidder
// does. Lose all five and you are out. **Ones are wild** and count as any face,
// which is why the numbers run higher than they look.
//
// ## Nobody deals
//
// The obvious build is that the host rolls everybody's dice and mails each
// player their own hand down a sealed channel. Do not do that: the host is a
// player, and a dealer who can read every cup is not a game of bluffing, it is
// a game with one person who cannot lose. `lib/secrets.js` seals a message
// against the *peers relaying it*; it cannot seal anything against the sender.
//
// So each player rolls **their own** dice, locally, and publishes a commitment
// to them before a single bid is made. Nothing about anybody's hand crosses the
// wire until a call is made, and then everything does at once and every
// commitment is checked. Same shape as `games/battleship.js`, same reason —
// see the `unrefereed-honesty` memory in the multiplayer skill.
//
// A consequence worth stating: because the dice are self-rolled, a modified
// client could re-roll until it liked its hand. The commitment stops a player
// changing dice *after* seeing a bid, which is the cheat that decides rounds;
// it does not stop a biased roll, and nothing short of a shared random beacon
// would.
//
// ## Rounds
//
// Rolling is a `collect` phase — everyone commits at once, and it ends the
// moment they all have. Bidding is not, because it goes round the table; it
// runs as a long phase that `rounds.next()` ends the instant somebody calls.

(() => {
	const DICE = 5;
	const FACES = 6;

	/**
	 * How many dice in a hand show `face`, counting ones as wild.
	 *
	 * The wild rule is the whole character of the game — it is why "six fives"
	 * is a sane opening bid with thirty dice on the table — and it is also the
	 * easiest thing to get subtly wrong, because a bid *on* ones must not count
	 * them twice. Bidding face 1 is simply not allowed here (`validBid`), which
	 * keeps the rule to one line instead of Perudo's special aces case.
	 */
	function countFace(dice, face) {
		return dice.filter((d) => d === face || d === 1).length;
	}

	/** Total across every hand at the table. */
	function countAll(hands, face) {
		return hands.reduce((n, hand) => n + countFace(hand, face), 0);
	}

	const validBid = (bid) =>
		!!bid && Number.isInteger(bid.count) && Number.isInteger(bid.face)
		&& bid.count >= 1 && bid.face >= 2 && bid.face <= FACES;

	/**
	 * May `next` follow `prev`? Raise the quantity, or hold it and raise the
	 * face. Nothing else.
	 */
	function bidBeats(next, prev) {
		if (!validBid(next)) return false;
		if (!prev) return true;
		if (next.count > prev.count) return true;
		return next.count === prev.count && next.face > prev.face;
	}

	/** Every bid that legally follows `prev`, cheapest first. */
	function raisesAfter(prev, maxCount) {
		const out = [];
		for (let count = prev ? prev.count : 1; count <= maxCount; count++) {
			for (let face = 2; face <= FACES; face++) {
				const bid = { count, face };
				if (bidBeats(bid, prev)) out.push(bid);
			}
		}
		return out;
	}

	/**
	 * Who loses a die. Returns `{ actual, bidderWasRight }`.
	 *
	 * "At least" is the rule, not "exactly": a bid of four fours stands if there
	 * are five. Getting that backwards makes every close call come out wrong and
	 * still looks like a working game.
	 */
	function resolveCall(hands, bid) {
		const actual = countAll(hands, bid.face);
		return { actual, bidderWasRight: actual >= bid.count };
	}

	const rollDice = (n, rng = Math.random) =>
		Array.from({ length: n }, () => 1 + Math.floor(rng() * FACES));

	// ---------------------------------------------------------------- the bot
	//
	// One number does most of the work: an unknown die shows any given face, or
	// is a wild one, with probability 2/6. So the bot expects its own count plus
	// a third of everything it cannot see, and it bluffs by leaning on that
	// estimate rather than by pretending to have dice it has not got.

	const P_MATCH = 2 / FACES;

	/** What the bot expects the table to hold for a face. */
	const expectedCount = (myDice, unknownDice, face) =>
		countFace(myDice, face) + unknownDice * P_MATCH;

	/**
	 * Raise, or call the last bid a lie.
	 *
	 * `slack` is the bluffing dial: how far past its own estimate the bot will
	 * let a bid stand before calling. Too tight and it calls every round and
	 * bleeds dice; too loose and it never calls and can be bid off the table.
	 */
	function botAction(myDice, bid, unknownDice, rng = Math.random, slack = 1.1) {
		const totalDice = myDice.length + unknownDice;

		if (bid) {
			const expected = expectedCount(myDice, unknownDice, bid.face);
			// A bid nobody could satisfy is an easy call and must always be taken.
			if (bid.count > totalDice) return { type: "liar" };
			if (bid.count > expected + slack) return { type: "liar" };
		}

		// Bid at roughly what we believe the table holds, not at the smallest
		// legal raise.
		//
		// The cheapest-raise version was the first thing written and it looks
		// sensible — never overcommit — but it makes the game unplayable: with
		// twenty dice on the table the ladder climbs one face at a time from
		// "one two", nobody ever reaches a bid worth calling, and a round runs
		// dozens of turns. Bidding near the estimate gets the table to a
		// contestable number in two or three turns, which is where the bluffing
		// actually lives.
		const options = raisesAfter(bid, totalDice);
		let best = null;
		for (const option of options) {
			const expected = expectedCount(myDice, unknownDice, option.face);
			if (option.count > expected + 0.5) continue;
			// Aim at the expectation; a little under most of the time, a little
			// over now and then, which is what a bluff looks like from outside.
			const target = Math.max(1, Math.round(expected - 0.3 + (rng() < 0.25 ? 1 : 0)));
			const score = -Math.abs(option.count - target) * 10
				+ countFace(myDice, option.face) * 2
				+ rng() * 0.5;
			if (!best || score > best.score) best = { option, score };
		}
		if (best) return { type: "bid", ...best.option };
		// Nothing we believe in. Call if there is something to call, otherwise
		// make the smallest legal bid and hope.
		if (bid) return { type: "liar" };
		return { type: "bid", ...(options[0] ?? { count: 1, face: 2 }) };
	}

	NeonArcade.liarsDiceRules = {
		DICE, FACES, countFace, countAll, validBid, bidBeats, raisesAfter,
		resolveCall, rollDice, expectedCount, botAction,
	};
})();

NeonArcade.registerGame({
	id: "liars-dice",
	name: "LIAR'S DICE",
	blurb: "Bid on dice you cannot see. Ones are wild. Call a bluff and someone loses one.",
	shape: "free",
	seats: { min: 2, max: 6 },

	mount(ctx) {
		const { room } = ctx;
		const {
			DICE, FACES, countFace, countAll, validBid, bidBeats, raisesAfter,
			resolveCall, rollDice, botAction,
		} = NeonArcade.liarsDiceRules;

		const PIPS = ["", "⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];

		const secrets = NeonArcade.makeSecrets(room, { onError: (e) => setNotice(e.reason) });

		// ------------------------------------------------------------- markup

		const shell = NeonArcade.gameShell(ctx.root, {
			css: `
				.ld-table { display: flex; flex-wrap: wrap; gap: 6px 12px; justify-content: center;
					font-size: 0.7rem; letter-spacing: 0.06em; }
				.ld-seat { display: flex; align-items: center; gap: 4px; color: var(--muted); }
				.ld-seat.turn { color: var(--accent); text-shadow: 0 0 8px var(--accent-glow); }
				.ld-seat.out { opacity: 0.4; text-decoration: line-through; }
				.ld-cups { letter-spacing: -0.1em; font-size: 0.95rem; color: #7a7aa0; }
				.ld-bid { font-size: clamp(1.4rem, 7vw, 2.1rem); text-align: center;
					color: var(--accent); text-shadow: 0 0 14px var(--accent-glow); min-height: 1.4em; }
				.ld-bid small { display: block; font-size: 0.42em; letter-spacing: 0.14em;
					color: var(--muted); text-shadow: none; }
				.ld-mine { display: flex; gap: 4px; justify-content: center; flex-wrap: wrap;
					font-size: clamp(2rem, 11vw, 3rem); line-height: 1; color: #fff; }
				.ld-mine .wild { color: #ffd24d; }
				.ld-faces { display: flex; gap: 6px; justify-content: center; flex-wrap: wrap; }
				.ld-face { min-width: 46px; min-height: 46px; font-size: 1.5rem; line-height: 1;
					background: var(--panel); border: 2px solid var(--border); border-radius: 8px;
					color: var(--muted); cursor: pointer; }
				.ld-face.sel { border-color: var(--accent); color: var(--accent); }
				.ld-count { display: flex; gap: 8px; align-items: center; justify-content: center; }
				.ld-count button { min-width: 46px; min-height: 46px; font-size: 1.2rem;
					background: var(--panel); border: 2px solid var(--border); border-radius: 8px;
					color: var(--accent); cursor: pointer; }
				.ld-count span { font-size: 1.5rem; min-width: 2ch; text-align: center; color: #fff; }
				.ld-actions { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; }
				.ld-actions .neon-btn { padding: 11px 18px; font-size: 14px; min-height: 44px; }
				.ld-actions .liar { background: #ff4d6d; }
				.ld-reveal { display: flex; flex-direction: column; gap: 3px; align-items: center;
					font-size: 0.78rem; color: var(--muted); }
				.ld-reveal .row { display: flex; gap: 6px; align-items: center; }
				.ld-reveal .dice { font-size: 1.15rem; color: #fff; letter-spacing: -0.05em; }
				.ld-notice { font-size: 0.68rem; color: #ff9f45; min-height: 1.2em; text-align: center; }
			`,
		});

		const fill = document.createElement("div");
		fill.className = "g-fill";
		const notice = document.createElement("div");
		notice.className = "ld-notice";
		const table = document.createElement("div");
		table.className = "ld-table";
		const bidEl = document.createElement("div");
		bidEl.className = "ld-bid";
		const revealEl = document.createElement("div");
		revealEl.className = "ld-reveal";
		const mine = document.createElement("div");
		mine.className = "ld-mine";
		const faces = document.createElement("div");
		faces.className = "ld-faces";
		const count = document.createElement("div");
		count.className = "ld-count";
		const actions = document.createElement("div");
		actions.className = "ld-actions";
		fill.append(notice, table, bidEl, revealEl, mine, faces, count, actions);
		shell.stage.append(fill);

		// -------------------------------------------------------------- state

		let phase = "waiting"; // waiting | roll | bid | reveal | over
		let seats = []; // [{ id, dice, out }]
		let bid = null; // { count, face, by }
		let turn = null;
		let starter = null;
		let digests = {};
		let reveals = {}; // id -> { hand, nonce }
		let verdicts = {}; // id -> null (clean) | string
		let lastCall = null; // { caller, bid, actual, bidderWasRight, loser }
		let over = null;
		let myHand = [];
		let myCommit = null;
		let botHands = {}; // botId -> { hand, commit } — held only by the host
		let draftFace = 2;
		let draftCount = 1;
		let disposed = false;
		let botTimer = null;

		const seatOf = (id) => seats.find((s) => s.id === id) ?? null;
		const alive = () => seats.filter((s) => !s.out);
		const myDiceCount = () => seatOf(room.selfId)?.dice ?? 0;
		const amPlaying = () => !!seatOf(room.selfId) && !seatOf(room.selfId).out;
		const isMyTurn = () => phase === "bid" && turn === room.selfId && amPlaying();
		const totalDice = () => alive().reduce((n, s) => n + s.dice, 0);

		const setNotice = (t) => {
			notice.textContent = t ?? "";
		};

		// ------------------------------------------------------------ the wire

		const stateAction = room.makeAction("ldState");
		const moveAction = room.makeAction("ldMove");
		const revealAction = room.makeAction("ldReveal");

		const publicState = () => ({
			seats, bid, turn, starter, digests, over, lastCall,
			reveals: phase === "reveal" || over ? reveals : {},
		});

		/**
		 * Publish the state **and redraw our own screen**.
		 *
		 * The redraw is the part that is easy to leave out and hard to see: a
		 * guest repaints because `stateAction.onMessage` tells it to, but the host
		 * sends that message and never receives it. Publishing without redrawing
		 * left the host's own UI frozen on the opening position — still offering
		 * the first legal bid several bids later, with no LIAR button — and every
		 * move it then made was silently refused as illegal. The game deadlocked
		 * and looked, from the host's side, like a UI that had stopped responding.
		 */
		function pushState() {
			if (ctx.isHost) stateAction.send(publicState());
			render();
		}

		// ------------------------------------------------------------- rounds

		const rounds = NeonArcade.makeRounds(ctx, {
			name: "ldRound",
			rounds: 400,
			phases: [
				// Everyone rolls and commits at once; the phase ends the moment
				// they all have, which is usually well inside a second.
				{ name: "roll", ms: 12_000, collect: true },
				// Bidding goes round the table, so it cannot end on a clock. The
				// deadline is a backstop; `rounds.next()` ends it when somebody
				// calls a bluff.
				{ name: "bid", ms: 600_000 },
				// Long enough to read four hands and the count, short enough that a
				// game of nine rounds is not ten minutes.
				{ name: "reveal", ms: 3500 },
			],
			onPhase: (info) => {
				phase = info.phase;
				if (info.phase === "roll") beginRoll();
				else if (info.phase === "bid") beginBid();
				else if (info.phase === "reveal") render();
				render();
			},
			onTick: () => renderHud(),
			onCollect: ({ entries }) => {
				// Host side, end of the roll phase.
				digests = Object.fromEntries(entries);
				pushState();
			},
		});

		// --------------------------------------------------------------- roll

		async function beginRoll() {
			bid = null;
			lastCall = null;
			reveals = {};
			verdicts = {};
			myCommit = null;
			myHand = [];
			setNotice("");

			if (amPlaying()) {
				// Rolled here, committed here. Nobody deals — see the note at the
				// top of this file for why a sealed channel would not help.
				myHand = rollDice(myDiceCount());
				myCommit = await secrets.commit(myHand);
				if (disposed) return;
				rounds.submit(myCommit.digest);
				render();
			}

			if (ctx.isHost) {
				botHands = {};
				for (const seat of alive()) {
					if (!ctx.isBot(seat.id)) continue;
					const hand = rollDice(seat.dice);
					const commit = await secrets.commit(hand);
					if (disposed) return;
					botHands[seat.id] = { hand, commit };
					// `submitFor` rather than a cached digest: the number of dice
					// changes every round, so a bot's hand cannot be prepared before
					// the phase opens the way Battleship's fleets can.
					rounds.submitFor(seat.id, commit.digest);
				}
			}
		}

		// ---------------------------------------------------------------- bid

		function beginBid() {
			if (!ctx.isHost) return;
			const living = alive();
			turn = living.some((s) => s.id === starter) ? starter : living[0]?.id ?? null;
			bid = null;
			pushState();
			nudgeBot();
		}

		function nextTurn() {
			const living = alive();
			const i = living.findIndex((s) => s.id === turn);
			turn = living[(i + 1) % living.length]?.id ?? null;
		}

		/** Host side. The only place a bid or a call is ever accepted. */
		function hostMove(fromId, move) {
			if (!ctx.isHost || phase !== "bid" || over) return;
			if (fromId !== turn) return;
			const seat = seatOf(fromId);
			if (!seat || seat.out) return;

			if (move.type === "liar") {
				if (!bid) return; // nothing to call
				callBluff(fromId);
				return;
			}
			const next = { count: move.count, face: move.face };
			if (!bidBeats(next, bid)) return;
			if (next.count > totalDice()) return;
			bid = { ...next, by: fromId };
			nextTurn();
			pushState();
			nudgeBot();
		}

		function nudgeBot() {
			clearTimeout(botTimer);
			if (!ctx.isHost || phase !== "bid" || over || !turn) return;
			if (!ctx.isBot(turn)) return;
			// A pause, so a table of bots is watchable rather than instantaneous.
			botTimer = setTimeout(() => {
				if (disposed || phase !== "bid") return;
				const id = turn;
				const hand = botHands[id]?.hand ?? [];
				const unknown = totalDice() - (seatOf(id)?.dice ?? 0);
				hostMove(id, botAction(hand, bid, unknown));
			}, 750);
		}

		// --------------------------------------------------------- the call

		let pendingCall = null;

		/**
		 * Host side. Somebody called. Everyone opens their cup, every commitment
		 * is checked, and only then is the round settled.
		 */
		function callBluff(callerId) {
			pendingCall = { caller: callerId, bid: { ...bid }, seen: new Set() };
			revealAction.send({ open: true });
			openMyCup();
			// Bots are opened by the host that rolled them.
			for (const [botId, held] of Object.entries(botHands)) {
				takeReveal(botId, { hand: held.hand, nonce: held.commit.nonce });
			}
			// A peer that never answers must not hang the table.
			setTimeout(() => settleCall(), 4000);
		}

		function openMyCup() {
			if (!myCommit) return;
			const payload = { hand: myCommit.value, nonce: myCommit.nonce };
			revealAction.send(payload);
			takeReveal(room.selfId, payload);
		}

		async function takeReveal(playerId, payload) {
			reveals[playerId] = payload;
			const digest = digests[playerId];
			// Snapshot the seat **before** awaiting. `settleCall` takes a die off
			// the loser, and it can run while this verification is still in
			// flight — so reading the count afterwards compares the hand that was
			// rolled against the number of dice the player has *now*, and accuses
			// an honest player of opening the wrong number. A false cheating
			// accusation is the worst thing this game can do, and it showed up as
			// one bot in one round out of a suite that otherwise passed.
			const expected = seatOf(playerId)?.dice ?? 0;
			const ok = digest
				? await secrets.verify({ digest, nonce: payload.nonce, value: payload.hand })
				: false;
			// A hand that does not match what was committed before the bidding is
			// a hand that was changed after seeing the bids.
			verdicts[playerId] = ok ? null : "these are not the dice they committed to";
			if (payload.hand.length !== expected) {
				verdicts[playerId] = "they opened the wrong number of dice";
			}
			render();
			if (ctx.isHost) maybeSettle();
		}

		function maybeSettle() {
			if (!pendingCall) return;
			const need = alive().map((s) => s.id);
			if (need.every((id) => reveals[id])) settleCall();
		}

		function settleCall() {
			if (!ctx.isHost || !pendingCall) return;
			const call = pendingCall;
			pendingCall = null;

			const living = alive();
			const hands = living.map((s) => reveals[s.id]?.hand ?? []);
			const { actual, bidderWasRight } = resolveCall(hands, call.bid);

			// A caught cheat loses the die regardless of the count — there is no
			// honest reading of a round somebody lied in.
			const cheat = living.map((s) => s.id).find((id) => verdicts[id]);
			const loser = cheat ?? (bidderWasRight ? call.caller : call.bid.by);

			const seat = seatOf(loser);
			if (seat) {
				seat.dice = Math.max(0, seat.dice - 1);
				if (seat.dice === 0) seat.out = true;
			}
			lastCall = { caller: call.caller, bid: call.bid, actual, bidderWasRight, loser, cheat: cheat ?? null };
			// Whoever lost a die opens the next round; if they are out, the caller does.
			starter = seat && !seat.out ? loser : call.caller;

			const left = alive();
			if (left.length <= 1) {
				over = { winner: left[0]?.id ?? null };
				phase = "over";
				rounds.dispose();
				pushState();
				return;
			}
			pushState();
			// Ends the bidding phase now rather than at its backstop deadline.
			rounds.next();
		}

		// ---------------------------------------------------------- messages

		stateAction.onMessage = (msg, { peerId }) => {
			if (ctx.isHost || peerId !== room.hostId()) return;
			seats = msg.seats;
			bid = msg.bid;
			turn = msg.turn;
			starter = msg.starter;
			digests = msg.digests ?? {};
			lastCall = msg.lastCall ?? null;
			if (msg.reveals && Object.keys(msg.reveals).length) reveals = msg.reveals;
			over = msg.over ?? null;
			if (over) {
				phase = "over";
				rounds.dispose();
			}
			render();
		};

		moveAction.onMessage = (move, { peerId }) => {
			if (ctx.isHost) hostMove(peerId, move);
		};

		revealAction.onMessage = (payload, { peerId }) => {
			if (payload?.open) {
				// The host is asking everyone to open. Only the host may ask.
				if (peerId === room.hostId()) openMyCup();
				return;
			}
			takeReveal(peerId, payload);
		};

		// -------------------------------------------------------------- input

		function send(move) {
			if (move.type === "bid" && !bidBeats(move, bid)) {
				setNotice("That does not raise the bid.");
				return;
			}
			if (move.type === "liar" && !bid) {
				setNotice("There is nothing to call yet.");
				return;
			}
			setNotice("");
			if (ctx.isHost) hostMove(room.selfId, move);
			else moveAction.send(move, { target: room.hostId() });
		}

		/** The cheapest legal raise, used to seed the bid builder each turn. */
		function minimumRaise() {
			const options = raisesAfter(bid, totalDice());
			return options[0] ?? { count: 1, face: 2 };
		}

		function resetDraft() {
			const min = minimumRaise();
			draftCount = min.count;
			draftFace = min.face;
		}

		// -------------------------------------------------------------- render

		function renderTable() {
			table.replaceChildren(
				...seats.map((s) => {
					const el = document.createElement("div");
					el.className = "ld-seat" + (s.id === turn && phase === "bid" ? " turn" : "") + (s.out ? " out" : "");
					const name = document.createElement("span");
					name.textContent = ctx.nameOf(s.id);
					const cups = document.createElement("span");
					cups.className = "ld-cups";
					cups.textContent = s.out ? "—" : "●".repeat(s.dice);
					cups.setAttribute("aria-label", `${s.dice} dice`);
					el.append(name, cups);
					return el;
				}),
			);
		}

		function renderMine() {
			if (!amPlaying() || !myHand.length || phase === "roll") {
				mine.replaceChildren();
				return;
			}
			mine.replaceChildren(
				...myHand.map((d) => {
					const el = document.createElement("span");
					el.textContent = PIPS[d];
					// Ones are wild, and at a glance that is the only thing about
					// your own hand you need to see instantly.
					if (d === 1) el.className = "wild";
					el.setAttribute("aria-label", d === 1 ? "one, wild" : String(d));
					return el;
				}),
			);
		}

		function renderBid() {
			revealEl.replaceChildren();
			if (phase === "reveal" || over) {
				if (lastCall) {
					const head = document.createElement("div");
					head.textContent = lastCall.cheat
						? `${ctx.nameOf(lastCall.cheat)} was caught cheating`
						: `${ctx.nameOf(lastCall.caller)} called ${lastCall.bid.count}×${PIPS[lastCall.bid.face]} — there were ${lastCall.actual}`;
					revealEl.append(head);
				}
				for (const s of seats) {
					const opened = reveals[s.id];
					if (!opened) continue;
					const row = document.createElement("div");
					row.className = "row";
					const who = document.createElement("span");
					who.textContent = ctx.nameOf(s.id);
					const dice = document.createElement("span");
					dice.className = "dice";
					dice.textContent = opened.hand.map((d) => PIPS[d]).join("");
					row.append(who, dice);
					if (verdicts[s.id]) {
						const flag = document.createElement("span");
						flag.textContent = "⚠";
						row.append(flag);
					}
					revealEl.append(row);
				}
			}

			if (over) {
				bidEl.textContent = "";
				return;
			}
			if (bid) {
				bidEl.replaceChildren();
				const main = document.createTextNode(`${bid.count} × ${PIPS[bid.face]}`);
				const who = document.createElement("small");
				who.textContent = `${ctx.nameOf(bid.by)} bid`;
				bidEl.append(main, who);
			} else if (phase === "bid") {
				bidEl.replaceChildren();
				const main = document.createTextNode("—");
				const who = document.createElement("small");
				who.textContent = "no bid yet";
				bidEl.append(main, who);
			} else {
				bidEl.textContent = "";
			}
		}

		function renderControls() {
			faces.replaceChildren();
			count.replaceChildren();
			actions.replaceChildren();

			if (over) {
				if (ctx.isHost) {
					const b = document.createElement("button");
					b.type = "button";
					b.className = "neon-btn";
					b.textContent = "NEW GAME";
					b.addEventListener("click", newGame);
					actions.append(b);
				}
				return;
			}
			if (!isMyTurn()) return;

			for (let f = 2; f <= FACES; f++) {
				const b = document.createElement("button");
				b.type = "button";
				b.className = "ld-face" + (draftFace === f ? " sel" : "");
				b.textContent = PIPS[f];
				b.setAttribute("aria-label", `bid on ${f}s`);
				b.addEventListener("click", () => {
					draftFace = f;
					// Keep the draft legal: raising the face may allow the same
					// count, lowering it may not.
					if (!bidBeats({ count: draftCount, face: f }, bid)) {
						const fit = raisesAfter(bid, totalDice()).find((o) => o.face === f);
						if (fit) draftCount = fit.count;
					}
					render();
				});
				faces.append(b);
			}

			const step = (label, delta) => {
				const b = document.createElement("button");
				b.type = "button";
				b.textContent = label;
				b.setAttribute("aria-label", delta > 0 ? "more dice" : "fewer dice");
				b.addEventListener("click", () => {
					const next = draftCount + delta;
					if (next < 1 || next > totalDice()) return;
					draftCount = next;
					render();
				});
				return b;
			};
			const value = document.createElement("span");
			value.textContent = String(draftCount);
			count.append(step("−", -1), value, step("+", 1));

			const legal = bidBeats({ count: draftCount, face: draftFace }, bid) && draftCount <= totalDice();
			const bidBtn = document.createElement("button");
			bidBtn.type = "button";
			bidBtn.className = "neon-btn";
			bidBtn.textContent = `BID ${draftCount} × ${PIPS[draftFace]}`;
			bidBtn.disabled = !legal;
			bidBtn.addEventListener("click", () => send({ type: "bid", count: draftCount, face: draftFace }));
			actions.append(bidBtn);

			if (bid) {
				const liar = document.createElement("button");
				liar.type = "button";
				liar.className = "neon-btn liar";
				liar.textContent = "LIAR!";
				liar.addEventListener("click", () => send({ type: "liar" }));
				actions.append(liar);
			}
		}

		function renderHud() {
			const parts = [];
			if (over) {
				parts.push({ key: "s", text: over.winner === room.selfId ? "You win" : `${ctx.nameOf(over.winner)} wins` });
			} else if (phase === "roll") {
				parts.push({ key: "s", text: "Rolling…", className: "g-muted" });
			} else if (phase === "reveal") {
				parts.push({ key: "s", text: "Cups up", className: "g-muted" });
			} else if (phase === "bid") {
				if (!amPlaying()) parts.push({ key: "s", text: "Out — watching", className: "g-muted" });
				else if (isMyTurn()) parts.push({ key: "s", text: bid ? "Raise, or call it" : "Open the bidding" });
				else parts.push({ key: "s", text: `${ctx.nameOf(turn)} is thinking…`, className: "g-muted" });
				parts.push({ key: "n", text: `${totalDice()} dice on the table`, className: "g-muted" });
			} else {
				parts.push({ key: "s", text: "Getting ready…", className: "g-muted" });
			}
			shell.setHud(parts);
		}

		let lastTurnSeen = null;
		function render() {
			// Re-seed the bid builder once per turn, not on every repaint, or it
			// would snap back while somebody was still adjusting it.
			if (isMyTurn() && lastTurnSeen !== `${turn}:${bid?.count}:${bid?.face}`) {
				lastTurnSeen = `${turn}:${bid?.count}:${bid?.face}`;
				resetDraft();
			}
			renderTable();
			renderBid();
			renderMine();
			renderControls();
			renderHud();
		}

		// --------------------------------------------------------------- start

		function newGame() {
			if (!ctx.isHost) return;
			seats = ctx.players().map((id) => ({ id, dice: DICE, out: false }));
			starter = seats[0]?.id ?? null;
			bid = null;
			turn = null;
			over = null;
			lastCall = null;
			reveals = {};
			verdicts = {};
			digests = {};
			pushState();
			rounds.start();
		}

		(async () => {
			await secrets.ready();
			if (disposed) return;
			if (secrets.privacy() !== "sealed") {
				setNotice("This browser cannot make a sealed commitment, so there is no way to keep the dice honest here.");
				return;
			}
			seats = ctx.players().map((id) => ({ id, dice: DICE, out: false }));
			starter = seats[0]?.id ?? null;
			render();
			if (ctx.isHost) {
				pushState();
				rounds.start();
			}
		})();

		return {
			onPeerJoin() {
				if (!ctx.isHost) return;
				pushState();
				rounds.sync();
			},
			onPeerLeave() {
				if (!ctx.isHost) return;
				const gone = seats.filter((s) => !ctx.players().includes(s.id) && !s.out);
				for (const s of gone) {
					s.out = true;
					s.dice = 0;
				}
				if (gone.length && turn && gone.some((s) => s.id === turn)) {
					nextTurn();
					nudgeBot();
				}
				const left = alive();
				if (left.length <= 1 && !over) {
					over = { winner: left[0]?.id ?? null };
					phase = "over";
					rounds.dispose();
				}
				pushState();
				render();
			},
			debug: () => ({
				phase,
				seats: seats.map((s) => ({ ...s })),
				bid: bid ? { ...bid } : null,
				turn,
				myDice: myHand.length,
				committed: !!myCommit,
				digests: Object.keys(digests).length,
				revealed: Object.keys(reveals).length,
				verdicts: { ...verdicts },
				lastCall: lastCall ? { ...lastCall } : null,
				totalDice: totalDice(),
				over: over ? { ...over } : null,
			}),
			unmount() {
				disposed = true;
				clearTimeout(botTimer);
				rounds.dispose();
				secrets.dispose();
				for (const a of [stateAction, moveAction, revealAction]) a.onMessage = null;
				shell.destroy();
			},
		};
	},
});
