// games/neon-bid/neon-bid.js — Neon Bid, a sealed-bid gem auction, on SDK v2.
//
// The rules (what a lot costs, what a hand scores, the bot) are rules.js; this
// file is the screen and the wire. docs/neon-bid.md has the design.
//
// ## Why this is not a managed game
//
// Managed state (docs/sdk-v2.md, Layer 2) runs every rule on the host, so the
// host would hold every bid as it is placed — and the host is a player. So
// this game speaks the protocol itself (Layer 1): the host referees, but never
// sees a bid before everybody's is locked in.
//
// Every bid is **committed** (the shell's `commit`, lib/secrets.js) during a
// collecting phase: only its digest reaches the host. The bid and its nonce
// stay on the bidder's phone until the phase has closed, then go to the host
// as an opening, which the host checks (`verify`) against the commitment and
// against the bidder's credits; a bad opening counts as 0. Same shape as
// Liar's Dice and Battleship — see the `unrefereed-honesty` memory in the
// multiplayer skill.
//
// The lot order is a shuffle the host makes once and publishes before the
// first bid. That is the only random thing in the game, and once it is public
// there is nothing left for anybody to know that the others do not.
//
// ## Rounds
//
// One round per lot on the shell's clock (`timer.*`, lib/rounds.js), three
// phases: `bid` collects commitments and ends the moment everyone has one in;
// `open` collects the openings, and the host ends it with `next` as soon as
// the lot is settled; `show` is the reveal on screen.

(() => {
	const R = globalThis.neonBidRules;
	const { COLOURS, LOTS } = R;

	// Seat colours are the theme's (lib/theme.css --p1…--p8) — and so are the
	// gems' (--p2…--p5), so four seats share a colour with a gem. A seat is
	// therefore marked by a ring in its colour around its initial
	// (`seatMark`), never by a filled dot that could read as a gem.
	const SEAT_HEX = Array.from({ length: 8 }, (_, i) => `var(--p${i + 1})`);
	const CHIPS = [0, 5, 10, 25];
	const CLOCK = "nbRound";

	// ------------------------------------------------------------- the party

	const self = () => arcade.party?.self ?? null;
	const hostId = () => arcade.party?.host ?? null;
	const isHost = () => arcade.isHost();
	const members = () => arcade.party?.members ?? [];
	/** Everyone seated (on a team, not spectating), in join order. */
	const players = () => members().filter((m) => m.team && m.team !== "spectator").map((m) => m.id);
	// A bot is a member the host plays; its id says so (lib/net.js BOT_PREFIX).
	const isBot = (id) => typeof id === "string" && id.startsWith("bot_");

	// ------------------------------------------------------- the shell's help

	/** A commitment to `value`: publish the digest now, open value + nonce later. */
	const commit = (value) => arcade.request("commit", { value }).then((r) => ({ digest: r.digest, nonce: r.nonce, value }));
	const verify = ({ digest, nonce, value }) => arcade.request("verify", { digest, nonce, value }).then((r) => r.valid === true);
	const clock = (op, fields = {}) => arcade.send("timer.do", { name: CLOCK, op, ...fields });

	// A reload keeps the seat but not the page, and a commitment that lived
	// only here is gone with it: the bid can no longer be opened, and the audit
	// reads that as a cheat. So the sealed bid is kept in this tab's session
	// (it survives exactly a reload), by member id. A kept value proves nothing
	// by itself: `restoreBid` checks it against the digest first.
	let session = {};
	const keptKey = () => `kept.${self()}`;
	const keep = (data) => {
		const value = JSON.stringify(data);
		session[keptKey()] = value;
		arcade.send("session.set", { key: keptKey(), value });
	};
	const kept = () => {
		try {
			return JSON.parse(session[keptKey()] ?? "null");
		} catch {
			return null;
		}
	};

	// ------------------------------------------------------------- markup

	const $ = (sel) => document.querySelector(sel);
	const hud = $("#hud");
	const gemRow = $(".nb-row");
	const seatsEl = $(".nb-seats");
	const lotEl = $(".nb-lot");
	const panel = $(".nb-panel");
	const notice = $(".nb-notice");

	const el = (tag, className, text) => {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (text != null) node.textContent = text;
		return node;
	};

	const setNotice = (t) => {
		notice.textContent = t ?? "";
	};

	// The status line, `[{ key, text, className }]`: a key already on screen
	// has its text updated in place, so a screen reader is not re-read it all.
	const hudCells = new Map();
	function setHud(parts) {
		const seen = new Set();
		for (const part of parts) {
			seen.add(part.key);
			let node = hudCells.get(part.key);
			if (!node) {
				node = el("span");
				hudCells.set(part.key, node);
				hud.append(node);
			}
			if (node.textContent !== String(part.text)) node.textContent = String(part.text);
			const cls = part.className ?? "";
			if (node.className !== cls) node.className = cls;
		}
		for (const [key, node] of hudCells) {
			if (seen.has(key)) continue;
			node.remove();
			hudCells.delete(key);
		}
	}

	// -------------------------------------------------------------- state

	let phase = "waiting"; // waiting | bid | open | show | over
	let game = null; // public: { order, lot, players, results } — see newGame
	let digests = {}; // id -> digest for the lot being bid; published once collected
	let opened = {}; // host only: id -> { lot, bid, nonce } for this lot
	let over = null; // { rows, winners, match }
	let matchNo = 0; // host: games started in this run
	let reportedOver = null;
	// The shell's clock, as its last `timer` event told it: { round, phase,
	// submitted, secondsLeft, finished }. `phase` is null until the host's
	// clock has said anything.
	let tick = { round: 0, phase: null, submitted: [], secondsLeft: 0, finished: false };
	let starting = null; // host: the interval that repeats `start` until the clock answers

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
		arcade.result({
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
	let botsIn = new Set(); // host only: bots whose commitment went in for this lot
	let settledLot = -1;
	let settling = false;
	let openTimer = null;
	let draft = 0;
	let disposed = false;

	const seatOf = (id) => game?.players.find((p) => p.id === id) ?? null;
	const mySeat = () => seatOf(self());
	const seatHex = (id) => SEAT_HEX[Math.max(0, game?.players.findIndex((p) => p.id === id) ?? 0) % SEAT_HEX.length];
	const nameOf = (id) => (id === self() ? "You" : (members().find((m) => m.id === id)?.name ?? "Player"));
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
	const lotNow = () => tick.round;
	const curLot = () => (over || !game || phase === "waiting" ? -1 : lotNow());

	// ------------------------------------------------------------ the wire

	const stateCh = arcade.channel("nbState", onState);
	const openCh = arcade.channel("nbOpen", (payload, from) => {
		if (isHost()) takeOpen(from, payload);
	});

	/**
	 * Publish the state **and redraw our own screen** — the host sends the
	 * state and never receives it, so without the redraw its own screen
	 * freezes (Liar's Dice learned this the hard way).
	 */
	function pushState() {
		if (isHost()) stateCh.send({ game, digests, over });
		render();
	}

	// ------------------------------------------------------------- rounds

	arcade.on("timer", (m) => {
		if (m.name !== CLOCK || disposed) return;
		const info = m.info ?? {};
		if (m.ev !== "collect" && m.ev !== "bot") tick = info;
		if (m.ev === "phase") onPhase(info);
		else if (m.ev === "tick") {
			renderHud();
			renderSeats();
			if (phase === "bid") renderPanel();
		} else if (m.ev === "bot") onBot(m.bot, info);
		else if (m.ev === "collect") {
			// Host side: the commitments are in, and now they are public.
			// Only seated players' — a late arrival's "pass" is not a bid.
			digests = Object.fromEntries(Object.entries(m.entries ?? {}).filter(([id]) => seatOf(id)));
			pushState();
		} else if (m.ev === "finish") onFinish();
	});
	arcade.send("timer.open", {
		name: CLOCK,
		rounds: LOTS,
		phases: [
			// Ends the moment everybody has committed. The deadline only
			// matters for somebody who has walked away; their bid is a pass.
			{ name: "bid", ms: 60_000, collect: true },
			// The host ends this with `next` once the lot is settled; the
			// deadline is a backstop for an opening that never arrives.
			{ name: "open", ms: 6_000 },
			{ name: "show", ms: 3_200 },
		],
		bots: true,
	});

	function onPhase(info) {
		if (starting) {
			clearInterval(starting);
			starting = null;
		}
		phase = info.phase;
		// A reload lands here first, on whatever phase is running.
		if (info.phase !== "bid") restoreBid(info);
		if (info.phase === "bid") beginBid(info);
		else if (info.phase === "open") beginOpen(info);
		else if (info.phase === "show" && isHost() && settledLot < info.round) settle();
		render();
	}

	function onFinish() {
		if (!isHost() || !game) return;
		over = { ...R.standings(game.players), match: matchNo };
		phase = "over";
		pushState();
		reportOver();
	}

	/**
	 * Host side: a collecting phase opened and a bot owes its commitment. It
	 * must exist already — bots' bids for the next lot are committed while
	 * the previous one is on show; if it does not yet, `beginBid` sends it
	 * the moment it does.
	 */
	function onBot(botId, info) {
		if (!isHost()) return;
		// A bot added after the deal has no seat; it passes, or the phase
		// would wait out its deadline for it every lot.
		if (!seatOf(botId)) return clock("submitFor", { bot: botId, value: "pass" });
		const held = botCommits[botId];
		if (held && held.lot === info.round && !botsIn.has(botId)) {
			botsIn.add(botId);
			clock("submitFor", { bot: botId, value: held.commit.digest });
		}
	}

	/**
	 * Host only. Start lot 1. `timer.open` loads the clock in the shell, and a
	 * `timer.do` that arrives before it has loaded is dropped, so `start` is
	 * said again until the first phase comes back (it does nothing to a
	 * running clock).
	 */
	function startClock() {
		clearInterval(starting);
		clock("start");
		starting = setInterval(() => (disposed || !isHost() ? clearInterval(starting) : clock("start")), 500);
	}

	// ---------------------------------------------------------------- bid

	function beginBid(info) {
		myCommit = null;
		committing = false;
		opened = {};
		digests = {};
		botsIn = new Set();
		const me = mySeat();
		if (me) draft = Math.min(draft, me.credits);
		setNotice("");
		restoreBid(info);
		// Somebody who arrived after the deal has no seat but is still seated
		// in the party, so the phase waits for them: answer for them.
		if (!me && players().includes(self())) clock("submit", { value: "pass" });
		if (!isHost()) return;
		// A backstop for `onBot`: if a bot's commitment was not ready when the
		// phase opened, submit it the moment it is.
		prepareBots(info.round).then(() => {
			if (disposed || phase !== "bid" || lotNow() !== info.round) return;
			for (const [id, held] of Object.entries(botCommits)) {
				if (held.lot !== info.round || botsIn.has(id)) continue;
				botsIn.add(id);
				clock("submitFor", { bot: id, value: held.commit.digest });
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
		if (myCommit || isHost()) return;
		const held = kept();
		if (!held || held.lot !== info.round) return;
		const mine = digests[self()];
		const ok = mine
			? mine === held.commit.digest
			: info.phase === "bid" && info.submitted?.includes(self());
		if (ok) myCommit = held;
	}

	/** Host side. Decide and commit every bot's bid for `lot`, once. */
	function prepareBots(lot) {
		if (!isHost() || !game) return Promise.resolve();
		if (botPrep.lot === lot) return botPrep.promise;
		// Decided from the state as it stands before the lot opens, all at
		// once, so no bot's bid can depend on another's.
		const bids = game.players
			.filter((p) => isBot(p.id))
			.map((p) => [p.id, R.botBid(game, p.id)]);
		const promise = (async () => {
			for (const [id, bid] of bids) {
				const c = await commit(bid);
				if (disposed) return;
				botCommits[id] = { lot, bid, commit: c };
			}
		})().catch((err) => setNotice(err.message));
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
		const c = await commit(bid).catch((err) => (setNotice(err.message), null));
		committing = false;
		if (disposed) return;
		if (!c || phase !== "bid" || lotNow() !== lot) {
			render();
			return;
		}
		myCommit = { lot, bid, commit: c };
		keep(myCommit);
		clock("submit", { value: c.digest });
		render();
	}

	// --------------------------------------------------------------- open

	function beginOpen(info) {
		if (isHost()) {
			// An opening that never comes is that player's loss, not the table's.
			// Armed *before* the openings below: when only the host and bots are
			// bidding they all open right here and settle the lot, and a timer
			// armed after that fired into the next lot's bidding and settled it
			// as everybody passing (fixed 2026-11-14). It is also tied to this
			// lot, so it can never settle another.
			clearTimeout(openTimer);
			openTimer = setTimeout(() => settle(info.round), 4_000);
		}
		if (myCommit && myCommit.lot === info.round) {
			const payload = { lot: info.round, bid: myCommit.commit.value, nonce: myCommit.commit.nonce };
			if (isHost()) takeOpen(self(), payload);
			else openCh.send(payload, hostId());
		}
		if (!isHost()) return;
		for (const [id, held] of Object.entries(botCommits)) {
			if (held.lot === info.round) takeOpen(id, { lot: info.round, bid: held.commit.value, nonce: held.commit.nonce });
		}
	}

	/** Host side. One player's opened bid. */
	function takeOpen(id, payload) {
		if (!isHost() || phase !== "open" || payload?.lot !== lotNow()) return;
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
		if (!isHost() || !game || settling) return;
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
		const audits = await Promise.all(snap.map((s) => R.auditBid(s, verify)));
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
		if (phase === "open") clock("next");
	}

	// ---------------------------------------------------------- messages

	function onState(msg, from) {
		if (isHost() || from !== hostId()) return;
		game = msg.game;
		digests = msg.digests ?? {};
		over = msg.over ?? null;
		if (over) {
			phase = "over";
			if (reportedOver?.match !== over.match) reportOver();
		}
		// The digests can land after the phase did (see restoreBid): open now.
		if (!myCommit && phase === "open") {
			restoreBid(tick);
			if (myCommit) beginOpen(tick);
		}
		render();
	}

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
		const ready = phase === "bid" ? (tick.submitted ?? []) : [];
		seatsEl.replaceChildren(
			...game.players.map((p) => {
				const box = el("div", "nb-seat" + (p.id === self() ? " me" : ""));
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
		const ready = tick.submitted ?? [];
		const present = players();
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
			banner.textContent = `${nameOf(result.winner)} ${result.winner === self() ? "win" : "wins"} the ${colour} gem`;
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
		if (isHost()) {
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
			phase === "bid" ? stillToBid() : 0, !!game?.results[curLot()], game?.players.length, themeNow(), isHost()]);
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
				: w[0] === self() ? "You win" : `${nameOf(w[0])} wins`;
			parts.push({ key: "s", text });
		} else if (!game) {
			parts.push({ key: "s", text: "Laying out the gems…", className: "g-muted" });
		} else if (phase === "bid") {
			parts.push({ key: "s", text: myCommit ? "Sealed" : "Bid in secret" });
			parts.push({ key: "t", text: `${tick.secondsLeft ?? 0}s`, className: "g-muted" });
		} else if (phase === "open") {
			parts.push({ key: "s", text: "Bids open", className: "g-muted" });
		} else if (phase === "show") {
			parts.push({ key: "s", text: `Lot ${curLot() + 1} of ${LOTS}`, className: "g-muted" });
		} else {
			parts.push({ key: "s", text: "Getting ready…", className: "g-muted" });
		}
		setHud(parts);
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
		if (!isHost()) return;
		game = R.newGame(players());
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
		startClock();
	}

	// A gem's name follows the theme (the runtime has already set <html>'s
	// data-theme), so redraw.
	arcade.on("theme.set", () => render());

	/**
	 * The crown moved to us mid-auction. Credits, gems and results came with
	 * every broadcast; the sealed bids — the bots', and whatever was collected
	 * for the lot under way — went with the old host. So the lot that was not
	 * yet settled opens for bidding again (Lokesh, 2026-11-13); everything
	 * settled stands.
	 */
	arcade.answer("takeOver", () => {
		if (over || !game) {
			pushState();
			return !!over;
		}
		settledLot = game.lot - 1;
		settling = false;
		botPrep = { lot: -1, promise: Promise.resolve() };
		botCommits = {};
		if (game.lot >= LOTS) return false;
		// The clock adopts only what it has run: never started, or finished,
		// there is nothing to carry on.
		if (tick.phase == null || tick.finished) return false;
		clock("adopt", { round: game.lot, index: 0 });
		pushState();
		return true;
	});
	arcade.on("join", () => {
		if (!isHost()) return;
		pushState();
		clock("sync");
	});
	// A player who leaves keeps their gems on the table; from now on their bid
	// is simply absent, which is a pass. The clock stops waiting for them
	// because they are no longer seated in the party.
	arcade.on("leave", () => isHost() && pushState());
	arcade.on("unmount", () => {
		disposed = true;
		clearTimeout(openTimer);
		clearInterval(starting);
	});

	arcade.debug = () => ({
		phase,
		lot: game?.lot ?? null,
		// The round clock's lot: the one on screen. Equal to `lot` while
		// bidding; the two drifting apart is how lots got thrown away.
		round: lotNow(),
		order: game ? [...game.order] : [],
		players: game ? game.players.map((p) => ({ id: p.id, credits: p.credits, hand: [...p.hand] })) : [],
		results: game ? game.results.map((r) => ({ ...r })) : [],
		digests: Object.keys(digests).length,
		committed: !!myCommit,
		myBid: myCommit?.bid ?? null,
		submitted: [...(tick.submitted ?? [])],
		over: over ? { ...over } : null,
	});

	arcade.init.then(async (init) => {
		session = { ...(init.session ?? {}) };
		render();
		arcade.ready();
		// A browser without WebCrypto cannot commit, and then nothing keeps the
		// bids honest: say so rather than play an auction anybody can rig.
		const can = await commit(0).then(() => true, () => false);
		if (disposed) return;
		if (!can) {
			setNotice("This browser cannot make a sealed commitment, so there is no way to keep the bids honest here.");
			return;
		}
		if (isHost()) startGame();
	});
})();
