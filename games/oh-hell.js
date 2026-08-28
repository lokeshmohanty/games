// games/oh-hell.js — Oh Hell, as a mountable module.
//
// A trick-taking game from a **shared deck**, and that is the whole reason it
// exists here: it is the first game in this arcade that cannot deal itself.
//
// ## Why this one needs the sealed channel
//
// Battleship and Liar's Dice both hide something, and neither needs a dealer:
// you lay out your own fleet, you roll your own dice, and you commit to it
// before anyone can react. Twelve cards off a fifty-two card deck are different.
// The hands have to be **disjoint** — the same queen cannot be in two people's
// hands — so somebody has to cut the deck up, and the pieces have to travel.
//
// That is what `secrets.channel()` is for, and this is its first real user.
// The host deals, and each hand goes to exactly one player, sealed end to end.
// It matters because of how this project routes: a pair with no direct link is
// relayed through whichever peer can reach both, and that peer is an opponent.
// Addressed is not private — see the `addressed-is-not-private` memory.
//
// **The honest limit: the dealer knows.** Sealing protects a hand from every
// player except the one who dealt it, and the host deals. A host that wanted to
// cheat could deal itself the aces, and no commitment fixes that, because the
// host also chooses the shuffle it would commit to. The real answer is mental
// poker — a deck encrypted commutatively by every player, which nobody can read
// and everybody can shuffle — and that is not built here. What this game gets
// right is the part that was actually broken: your hand is not readable by the
// people you are playing against.
//
// ## The rules
//
// Five rounds. Round one deals one card each, round five deals five. One card
// is turned up after the deal and its suit is trump. Everyone bids how many
// tricks they will take — **simultaneously**, which is the variant that suits
// this transport, rather than going round the table. Then tricks are played:
// follow the led suit if you can, highest trump takes it, otherwise the highest
// card of the suit led. Take exactly what you bid and you score 10 + your bid;
// take any other number and you score nothing.

(() => {
	const SUITS = ["♠", "♥", "♦", "♣"];
	const RED = new Set([1, 2]); // hearts and diamonds, for colouring only
	const RANKS = { 11: "J", 12: "Q", 13: "K", 14: "A" };
	// Round n deals n+1 cards. Six players at five cards is thirty of fifty-two,
	// leaving room for the trump turn-up.
	const HANDS = [1, 2, 3, 4, 5];

	const cardName = (c) => `${RANKS[c.r] ?? c.r}${SUITS[c.s]}`;
	const sameCard = (a, b) => a && b && a.r === b.r && a.s === b.s;

	function freshDeck() {
		const deck = [];
		for (let s = 0; s < 4; s++) for (let r = 2; r <= 14; r++) deck.push({ r, s });
		return deck;
	}

	/** Fisher–Yates. `rng` is injectable so a test can deal a known hand. */
	function shuffle(deck, rng = Math.random) {
		const out = [...deck];
		for (let i = out.length - 1; i > 0; i--) {
			const j = Math.floor(rng() * (i + 1));
			[out[i], out[j]] = [out[j], out[i]];
		}
		return out;
	}

	/**
	 * Cut a shuffled deck into one hand per player, plus the card turned up for
	 * trump. Returns `{ hands, trump }`; `trump` is null when the deck ran out,
	 * which is a no-trump round.
	 */
	function deal(deck, playerCount, handSize) {
		const hands = [];
		let at = 0;
		for (let p = 0; p < playerCount; p++) {
			hands.push(deck.slice(at, at + handSize));
			at += handSize;
		}
		const turnUp = deck[at] ?? null;
		return { hands, trump: turnUp ? turnUp.s : null, turnUp };
	}

	/**
	 * Which cards may be played from `hand`, given what was led.
	 *
	 * Follow the suit led if you hold it; otherwise anything. This is the rule
	 * the whole game rests on, and a bug here does not look like a bug — it
	 * looks like an opponent who keeps trumping when they should not.
	 */
	function legalPlays(hand, ledSuit) {
		if (ledSuit === null || ledSuit === undefined) return [...hand];
		const following = hand.filter((c) => c.s === ledSuit);
		return following.length ? following : [...hand];
	}

	/**
	 * Index of the winning play in a completed trick.
	 *
	 * `plays` is in play order, starting with the leader. Highest trump wins;
	 * with no trump in the trick, the highest card **of the suit led** wins — a
	 * high card of some other suit wins nothing, which is the point of following
	 * suit at all.
	 */
	function trickWinner(plays, trump) {
		const led = plays[0].s;
		let best = 0;
		for (let i = 1; i < plays.length; i++) {
			const c = plays[i];
			const b = plays[best];
			const cTrump = trump !== null && c.s === trump;
			const bTrump = trump !== null && b.s === trump;
			if (cTrump && !bTrump) best = i;
			else if (cTrump === bTrump && c.s === b.s && c.r > b.r) best = i;
			else if (!cTrump && !bTrump && b.s !== led && c.s === led) best = i;
		}
		return best;
	}

	/** Exactly what you bid, or nothing at all. */
	const scoreFor = (bid, taken) => (bid === taken ? 10 + bid : 0);

	// ---------------------------------------------------------------- the bot

	/**
	 * How likely a card is to take a trick, roughly, on a nought-to-one scale.
	 *
	 * Deliberately crude: an ace is nearly certain, a trump is strong, and
	 * everything else falls away fast. It only has to be good enough to bid with
	 * and to choose between the two or three cards a follow-suit rule leaves.
	 */
	function cardStrength(card, trump) {
		const high = Math.max(0, card.r - 9) / 5; // 10..A → 0.2..1
		if (trump !== null && card.s === trump) return Math.min(1, 0.55 + high * 0.45);
		return high * 0.7;
	}

	/** How many tricks a bot thinks a hand is worth. */
	function botBid(hand, trump, handSize) {
		const expected = hand.reduce((n, c) => n + cardStrength(c, trump), 0);
		return Math.max(0, Math.min(handSize, Math.round(expected)));
	}

	/**
	 * Which card to play.
	 *
	 * Two moods, and the bid is what switches between them: a bot that still
	 * needs tricks tries to win the ones it can, and a bot that has already made
	 * its bid throws its lowest card away — because in this game an *extra*
	 * trick is exactly as bad as a missing one.
	 */
	function botPlay(hand, trick, trump, bid, taken, rng = Math.random) {
		const led = trick.length ? trick[0].card.s : null;
		const options = legalPlays(hand, led);
		if (options.length === 1) return options[0];

		const wants = taken < bid;
		const byStrength = [...options].sort(
			(a, b) => cardStrength(a, trump) - cardStrength(b, trump) || a.r - b.r,
		);

		if (!trick.length) {
			// Leading. Lead high when chasing tricks, low when dodging them.
			return wants ? byStrength[byStrength.length - 1] : byStrength[0];
		}

		// Following. Would this card actually take the trick as it stands?
		const takesIt = (card) => {
			const plays = [...trick.map((t) => t.card), card];
			return trickWinner(plays, trump) === plays.length - 1;
		};
		const winners = options.filter(takesIt);

		if (wants && winners.length) {
			// Win it as cheaply as possible; the aces keep for later.
			return winners.sort((a, b) => cardStrength(a, trump) - cardStrength(b, trump))[0];
		}
		if (!wants) {
			const losers = options.filter((c) => !takesIt(c));
			if (losers.length) return losers.sort((a, b) => b.r - a.r)[0]; // dump the highest safe card
		}
		return byStrength[0];
	}

	NeonArcade.ohHellRules = {
		SUITS, RED, RANKS, HANDS, cardName, sameCard, freshDeck, shuffle, deal,
		legalPlays, trickWinner, scoreFor, cardStrength, botBid, botPlay,
	};
})();

NeonArcade.registerGame({
	id: "oh-hell",
	name: "OH HELL",
	blurb: "Bid exactly what you will take. One too many is as bad as one too few.",
	shape: "free",
	seats: { min: 2, max: 6 },

	mount(ctx) {
		const { room } = ctx;
		const {
			SUITS, RED, RANKS, HANDS, cardName, sameCard, freshDeck, shuffle, deal,
			legalPlays, trickWinner, scoreFor, botBid, botPlay,
		} = NeonArcade.ohHellRules;

		const secrets = NeonArcade.makeSecrets(room, { onError: (e) => setNotice(e.reason) });

		// ------------------------------------------------------------- markup

		const shell = NeonArcade.gameShell(ctx.root, {
			css: `
				.oh-seats { display: flex; flex-wrap: wrap; gap: 4px 10px; justify-content: center;
					font-size: 0.68rem; letter-spacing: 0.05em; }
				.oh-seat { color: var(--muted); white-space: nowrap; }
				.oh-seat.turn { color: var(--accent); text-shadow: 0 0 8px var(--accent-glow); }
				.oh-seat b { font-weight: normal; color: #fff; }
				.oh-trump { font-size: 0.72rem; letter-spacing: 0.1em; color: var(--muted); }
				.oh-trump .suit { font-size: 1.5em; vertical-align: -0.12em; }
				.oh-trick { display: flex; gap: 6px; justify-content: center; flex-wrap: wrap;
					min-height: 74px; align-items: center; }
				.oh-card { background: #f4f4ec; color: #111; border: 2px solid #2a2a4e;
					border-radius: 7px; min-width: 46px; min-height: 66px; padding: 4px 2px;
					display: flex; flex-direction: column; align-items: center; justify-content: center;
					font-size: 1.15rem; line-height: 1.05; cursor: default;
					touch-action: manipulation; }
				.oh-card .suit { font-size: 1.25em; }
				.oh-card.red { color: #c62b2b; }
				.oh-card.playable { cursor: pointer; box-shadow: 0 0 0 2px var(--accent); }
				.oh-card.dim { opacity: 0.4; }
				.oh-card .who { font-size: 0.5rem; color: #555; letter-spacing: 0.06em; }
				.oh-hand { display: flex; gap: 5px; justify-content: center; flex-wrap: wrap; }
				.oh-bids { display: flex; gap: 6px; justify-content: center; flex-wrap: wrap; }
				.oh-bid { min-width: 46px; min-height: 46px; font-size: 1.1rem;
					background: var(--panel); border: 2px solid var(--border); border-radius: 8px;
					color: var(--accent); cursor: pointer; }
				.oh-notice { font-size: 0.68rem; color: #ff9f45; min-height: 1.2em; text-align: center; }
				.oh-scores { font-size: 0.7rem; color: var(--muted); text-align: center; }
			`,
		});

		const fill = document.createElement("div");
		fill.className = "g-fill";
		const notice = document.createElement("div");
		notice.className = "oh-notice";
		const seatsEl = document.createElement("div");
		seatsEl.className = "oh-seats";
		const trumpEl = document.createElement("div");
		trumpEl.className = "oh-trump";
		const trickEl = document.createElement("div");
		trickEl.className = "oh-trick";
		const handEl = document.createElement("div");
		handEl.className = "oh-hand";
		const bidsEl = document.createElement("div");
		bidsEl.className = "oh-bids";
		const scoresEl = document.createElement("div");
		scoresEl.className = "oh-scores";
		fill.append(notice, seatsEl, trumpEl, trickEl, handEl, bidsEl, scoresEl);
		shell.stage.append(fill);

		// -------------------------------------------------------------- state

		let phase = "waiting";
		let seats = []; // { id, bid, taken, score }
		let trump = null;
		let turnUp = null;
		let handSize = 1;
		let trick = []; // { seat, card }
		let leader = null;
		let turn = null;
		let myHand = [];
		let botHands = {}; // botId -> cards; held by the host, which plays them
		let hostHands = {}; // every hand — the dealer knows, see the file header
		let over = null;
		let disposed = false;
		let trickTimer = null;
		let botTimer = null;

		const seatOf = (id) => seats.find((s) => s.id === id) ?? null;
		const isMyTurn = () => phase === "play" && turn === room.selfId;
		const setNotice = (t) => {
			notice.textContent = t ?? "";
		};

		// ------------------------------------------------------------ the wire

		const stateAction = room.makeAction("ohState");
		const playAction = room.makeAction("ohPlay");
		// **This is what `lib/secrets.js` was built for.** A shared deck has to be
		// cut up by somebody and the pieces have to travel, and this project
		// routes a message for an unreachable peer *through another player*. An
		// addressed hand would be read by whoever relayed it.
		const handChannel = secrets.channel("hand");

		handChannel.onMessage = (cards, { from, to }) => {
			if (from !== room.hostId()) return; // only the dealer deals
			if (to === room.selfId) {
				myHand = sortHand(cards);
				render();
			} else if (ctx.isHost && NeonArcade.isBotId(to)) {
				// A bot's hand never left this browser; the channel delivered it
				// locally because the host is what plays that seat.
				botHands[to] = cards;
			}
		};

		const publicState = () => ({
			seats, trump, turnUp, handSize, trick, leader, turn, over,
		});
		function pushState() {
			if (ctx.isHost) stateAction.send(publicState());
			// The host sends that message and never receives it, so it has to
			// redraw itself — the same trap Liar's Dice hit.
			render();
		}

		stateAction.onMessage = (msg, { peerId }) => {
			if (ctx.isHost || peerId !== room.hostId()) return;
			seats = msg.seats;
			trump = msg.trump;
			turnUp = msg.turnUp;
			handSize = msg.handSize;
			trick = msg.trick ?? [];
			leader = msg.leader;
			turn = msg.turn;
			over = msg.over ?? null;
			render();
		};

		playAction.onMessage = (msg, { peerId }) => {
			if (ctx.isHost) hostPlay(peerId, msg.card);
		};

		const sortHand = (cards) =>
			[...cards].sort((a, b) => a.s - b.s || a.r - b.r);

		// ------------------------------------------------------------- rounds

		let rounds = null;

		const buildRounds = () => NeonArcade.makeRounds(ctx, {
			name: "ohRound",
			rounds: HANDS.length,
			phases: [
				{ name: "deal", ms: 1200 },
				// Everyone bids at once rather than round the table. It is a
				// variant, and it is the one this transport wants: nobody waits on
				// a turn order, and the host never arbitrates who bid first.
				{ name: "bid", ms: 45_000, collect: true },
				// Trick play is a turn order, so it cannot end on a clock. The
				// deadline is a backstop; `rounds.next()` ends it when the last
				// trick is taken.
				{ name: "play", ms: 900_000 },
				{ name: "score", ms: 3000 },
			],
			botSubmit: (botId) => botBid(botHands[botId] ?? [], trump, handSize),
			onPhase: (info) => {
				phase = info.phase;
				handSize = HANDS[info.round] ?? 1;
				if (info.phase === "deal") dealRound(info.round);
				else if (info.phase === "play") beginPlay();
				else if (info.phase === "score") scoreRound();
				render();
			},
			onTick: () => renderHud(),
			onCollect: ({ entries }) => {
				// Host side, end of bidding.
				for (const [id, value] of entries) {
					const seat = seatOf(id);
					if (seat) seat.bid = Math.max(0, Math.min(handSize, value | 0));
				}
				pushState();
			},
			onFinish: () => {
				const best = [...seats].sort((a, b) => b.score - a.score)[0];
				over = { winner: best?.id ?? null };
				phase = "over";
				pushState();
			},
		});
		rounds = buildRounds();

		/** Host only. Deal a whole new game, from a fresh scheduler. */
		function newGame() {
			if (!ctx.isHost) return;
			for (const s of seats) {
				s.score = 0;
				s.bid = null;
				s.taken = 0;
			}
			over = null;
			trick = [];
			myHand = [];
			shell.hideOverlay();
			// `dispose()` is one-way, so a new game means a new clock. The action
			// names are the same, and the disposed scheduler already released them.
			rounds.dispose();
			rounds = buildRounds();
			pushState();
			rounds.start();
		}

		// ---------------------------------------------------------------- deal

		function dealRound(round) {
			trick = [];
			for (const s of seats) {
				s.bid = null;
				s.taken = 0;
			}
			myHand = [];
			if (!ctx.isHost) return render();

			const size = HANDS[round] ?? 1;
			handSize = size;
			const order = seats.map((s) => s.id);
			const dealt = deal(shuffle(freshDeck()), order.length, size);
			trump = dealt.trump;
			turnUp = dealt.turnUp;
			botHands = {};
			hostHands = {};

			order.forEach((id, i) => {
				hostHands[id] = dealt.hands[i];
				if (id === room.selfId) {
					myHand = sortHand(dealt.hands[i]);
					return;
				}
				// Sealed, per hand, per player. A bot's goes through the same call
				// and is simply delivered locally.
				handChannel.send(id, dealt.hands[i]);
			});

			// The deal rotates, so the lead does too.
			leader = order[round % order.length];
			turn = leader;
			pushState();
		}

		// ---------------------------------------------------------------- play

		function beginPlay() {
			if (!ctx.isHost) return;
			turn = leader;
			pushState();
			nudgeBot();
		}

		const handOf = (id) => (ctx.isHost ? hostHands[id] ?? [] : id === room.selfId ? myHand : []);

		/** Host side. The only place a card is ever accepted. */
		function hostPlay(fromId, card) {
			if (!ctx.isHost || phase !== "play" || over) return;
			if (fromId !== turn) return;
			const hand = hostHands[fromId] ?? [];
			if (!hand.some((c) => sameCard(c, card))) return;
			const led = trick.length ? trick[0].card.s : null;
			if (!legalPlays(hand, led).some((c) => sameCard(c, card))) return;

			hostHands[fromId] = hand.filter((c) => !sameCard(c, card));
			if (fromId === room.selfId) myHand = myHand.filter((c) => !sameCard(c, card));
			if (botHands[fromId]) botHands[fromId] = botHands[fromId].filter((c) => !sameCard(c, card));
			trick.push({ seat: fromId, card });

			if (trick.length < seats.length) {
				const order = seats.map((s) => s.id);
				turn = order[(order.indexOf(fromId) + 1) % order.length];
				pushState();
				nudgeBot();
				return;
			}

			// Trick complete. Hold it on screen before sweeping it up, or nobody
			// sees what they lost to.
			const winnerSeat = trick[trickWinner(trick.map((p) => p.card), trump)].seat;
			turn = null;
			pushState();
			clearTimeout(trickTimer);
			trickTimer = setTimeout(() => {
				if (disposed || phase !== "play") return;
				const seat = seatOf(winnerSeat);
				if (seat) seat.taken++;
				leader = winnerSeat;
				trick = [];
				const done = seats.every((s) => (hostHands[s.id] ?? []).length === 0);
				if (done) {
					pushState();
					// Last trick taken: the phase is over now, not at its backstop.
					rounds.next();
					return;
				}
				turn = leader;
				pushState();
				nudgeBot();
			}, 1000);
		}

		function nudgeBot() {
			clearTimeout(botTimer);
			if (!ctx.isHost || phase !== "play" || over || !turn) return;
			if (!ctx.isBot(turn)) return;
			botTimer = setTimeout(() => {
				if (disposed || phase !== "play") return;
				const id = turn;
				const seat = seatOf(id);
				const card = botPlay(hostHands[id] ?? [], trick, trump, seat?.bid ?? 0, seat?.taken ?? 0);
				if (card) hostPlay(id, card);
			}, 500);
		}

		function scoreRound() {
			if (!ctx.isHost) return;
			for (const s of seats) s.score += scoreFor(s.bid ?? 0, s.taken);
			pushState();
		}

		// -------------------------------------------------------------- render

		function cardEl(card, { playable, dim, who } = {}) {
			const el = document.createElement(playable ? "button" : "div");
			el.className = "oh-card" + (RED.has(card.s) ? " red" : "")
				+ (playable ? " playable" : "") + (dim ? " dim" : "");
			const rank = document.createElement("span");
			rank.textContent = RANKS[card.r] ?? card.r;
			const suit = document.createElement("span");
			suit.className = "suit";
			suit.textContent = SUITS[card.s];
			el.append(rank, suit);
			if (who) {
				const tag = document.createElement("span");
				tag.className = "who";
				tag.textContent = who;
				el.append(tag);
			}
			el.setAttribute("aria-label", `${RANKS[card.r] ?? card.r} of ${["spades", "hearts", "diamonds", "clubs"][card.s]}`);
			return el;
		}

		function renderSeats() {
			seatsEl.replaceChildren(
				...seats.map((s) => {
					const el = document.createElement("span");
					el.className = "oh-seat" + (s.id === turn ? " turn" : "");
					const bid = s.bid === null || s.bid === undefined ? "–" : s.bid;
					el.append(document.createTextNode(`${ctx.nameOf(s.id)} `));
					const b = document.createElement("b");
					b.textContent = phase === "bid" ? (s.bid === null || s.bid === undefined ? "…" : "✓") : `${s.taken}/${bid}`;
					el.append(b);
					return el;
				}),
			);
			scoresEl.textContent = seats.length
				? seats.map((s) => `${ctx.nameOf(s.id)} ${s.score}`).join("   ")
				: "";
		}

		function renderTrump() {
			if (over || phase === "waiting") {
				trumpEl.textContent = "";
				return;
			}
			trumpEl.replaceChildren();
			if (trump === null) {
				trumpEl.textContent = "NO TRUMP";
				return;
			}
			trumpEl.append(document.createTextNode("TRUMP "));
			const suit = document.createElement("span");
			suit.className = "suit";
			suit.textContent = SUITS[trump];
			suit.style.color = RED.has(trump) ? "#ff6b6b" : "#dfe3ff";
			trumpEl.append(suit);
		}

		function renderTrick() {
			trickEl.replaceChildren(
				...trick.map((p) => cardEl(p.card, { who: ctx.nameOf(p.seat) })),
			);
		}

		function renderHand() {
			handEl.replaceChildren();
			if (!myHand.length) return;
			const led = trick.length ? trick[0].card.s : null;
			const legal = isMyTurn() ? legalPlays(myHand, led) : [];
			for (const card of myHand) {
				const playable = legal.some((c) => sameCard(c, card));
				const el = cardEl(card, { playable, dim: isMyTurn() && !playable });
				if (playable) {
					el.addEventListener("click", () => {
						if (ctx.isHost) hostPlay(room.selfId, card);
						else playAction.send({ card }, { target: room.hostId() });
					});
				}
				handEl.append(el);
			}
		}

		function renderBids() {
			bidsEl.replaceChildren();
			if (phase !== "bid") return;
			const seat = seatOf(room.selfId);
			if (!seat) return;
			const already = rounds.state().submitted.includes(room.selfId);
			for (let n = 0; n <= handSize; n++) {
				const b = document.createElement("button");
				b.type = "button";
				b.className = "oh-bid";
				b.textContent = String(n);
				b.disabled = already;
				b.setAttribute("aria-label", `bid ${n} tricks`);
				b.addEventListener("click", () => {
					rounds.submit(n);
					render();
				});
				bidsEl.append(b);
			}
		}

		function renderHud() {
			const parts = [];
			const state = rounds.state();
			if (over) {
				parts.push({ key: "s", text: over.winner === room.selfId ? "You win" : `${ctx.nameOf(over.winner)} wins` });
			} else if (phase === "deal") {
				parts.push({ key: "s", text: "Dealing…", className: "g-muted" });
			} else if (phase === "bid") {
				const mine = rounds.state().submitted.includes(room.selfId);
				parts.push({ key: "s", text: mine ? "Waiting for the others" : `How many of ${handSize}?`, className: mine ? "g-muted" : "" });
				parts.push({ key: "n", text: `${state.submitted.length}/${seats.length} in`, className: "g-muted" });
			} else if (phase === "play") {
				if (isMyTurn()) parts.push({ key: "s", text: "Your card" });
				else if (turn) parts.push({ key: "s", text: `${ctx.nameOf(turn)}…`, className: "g-muted" });
				else parts.push({ key: "s", text: "Trick taken", className: "g-muted" });
			} else if (phase === "score") {
				parts.push({ key: "s", text: "Scoring", className: "g-muted" });
			} else {
				parts.push({ key: "s", text: "Getting ready…", className: "g-muted" });
			}
			if (!over && phase !== "waiting") {
				parts.push({ key: "r", text: `Round ${Math.min(state.round + 1, HANDS.length)}/${HANDS.length}`, className: "g-muted" });
			}
			shell.setHud(parts);
		}

		function renderOver() {
			if (!over) return shell.hideOverlay();
			const table = [...seats].sort((a, b) => b.score - a.score);
			shell.showOverlay({
				title: over.winner === room.selfId ? "YOU WIN" : `${ctx.nameOf(over.winner)} WINS`,
				lines: table.map((s) => `${ctx.nameOf(s.id)} — ${s.score}`),
				buttons: ctx.isHost
					? [{ label: "NEW GAME", onClick: newGame }]
					: [NeonArcade.hostNewGameButton?.() ?? null].filter(Boolean),
			});
		}

		function render() {
			renderOver();
			renderSeats();
			renderTrump();
			renderTrick();
			renderHand();
			renderBids();
			renderHud();
		}

		// --------------------------------------------------------------- start

		(async () => {
			await secrets.ready();
			if (disposed) return;
			if (secrets.privacy() !== "sealed") {
				// Without encryption a dealt hand would travel in the clear through
				// whichever player happened to relay it. There is no honest game to
				// play here, so say so rather than deal anyway.
				setNotice("This browser cannot seal a dealt hand, so Oh Hell cannot be played here.");
				return;
			}
			seats = ctx.players().map((id) => ({ id, bid: null, taken: 0, score: 0 }));
			render();
			if (ctx.isHost) {
				// Everyone's key has to be on the party record before the first
				// hand goes out, or the deal is sent to somebody we cannot seal to.
				await Promise.all(ctx.players().map((id) => secrets.canReach(id)));
				if (disposed) return;
				pushState();
				rounds.start();
			}
		})();

		return {
			onPeerJoin() {
				if (!ctx.isHost) return;
				// Mid-game arrivals watch this one out; there is no hand to give
				// them from a deck that has already been cut.
				pushState();
				rounds.sync();
			},
			onPeerLeave(peerId) {
				if (!ctx.isHost) return;
				seats = seats.filter((s) => s.id !== peerId);
				delete hostHands[peerId];
				delete botHands[peerId];
				trick = trick.filter((p) => p.seat !== peerId);
				if (turn === peerId) {
					const order = seats.map((s) => s.id);
					turn = order[0] ?? null;
					nudgeBot();
				}
				if (seats.length < 2 && !over) {
					over = { winner: seats[0]?.id ?? null };
					phase = "over";
					rounds.dispose();
				}
				pushState();
			},
			debug: () => ({
				phase,
				handSize,
				trump,
				myHand: myHand.map(cardName),
				myHandSize: myHand.length,
				seats: seats.map((s) => ({ ...s })),
				trick: trick.map((p) => ({ seat: p.seat, card: cardName(p.card) })),
				turn,
				leader,
				over: over ? { ...over } : null,
				sealed: secrets.privacy(),
			}),
			unmount() {
				disposed = true;
				clearTimeout(trickTimer);
				clearTimeout(botTimer);
				rounds.dispose();
				secrets.dispose();
				stateAction.onMessage = null;
				playAction.onMessage = null;
				shell.destroy();
			},
		};
	},
});
