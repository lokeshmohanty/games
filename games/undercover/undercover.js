// games/undercover.js — Undercover, as a mountable module.
//
// The first game here that is **played on one device**, and that is the point
// rather than a limitation.
//
// Everything else in this arcade is organised around a cost: two browsers
// cannot find each other without a signalling server, so the players carry the
// handshake themselves, once per person. That is a good trade when people are
// apart. It is a silly one for six people round a table who could simply pass a
// phone — five handshakes to play a game that needs no second screen. So this
// game does not use the network at all. `local: true` in the registration is
// the whole of what the shell needs to know: see `lib/games.js`.
//
// ## The game
//
// Everyone gets a secret word. Most people get the same one; one or two get a
// word that is *close but not the same*, and — if you turn it on — one person
// gets nothing at all and has to bluff from cold. Going round the table, each
// player says one word describing theirs, out loud, off the phone. Then you
// vote somebody out and the phone says what they were.
//
// The host picks which topics to deal from (food, animals, tech…) and how
// close the two words should be; the words themselves are in `words.js`, and
// the phone remembers which pairs it has dealt so a regular table does not
// keep meeting the same ones. Points carry over from hand to hand.
//
// Civilians win by voting out every undercover. The undercovers win by
// surviving until they match the civilians in number. The blank wins outright
// if, on being voted out, they can name the civilians' word.
//
// ## What the code is actually responsible for
//
// Almost none of the game. The describing and the arguing happen in the room,
// between people; the phone deals the words, remembers who is out, and — the
// only part that really matters — **never shows a word to the wrong person**.
// Two deliberate taps to reveal, one to hide, and nothing lingering on screen
// between hands.

(() => {
	// The word pairs live in words.js, by category and by how close the two
	// halves are. Parsed once here into `{ words, level, category }`.
	const parse = (text) => text.split(",").map((s) => s.trim()).filter(Boolean)
		.map((s) => s.split("/").map((w) => w.trim()));
	const CATEGORIES = NeonArcade.undercoverWords.map((c) => ({
		id: c.id,
		label: c.label,
		simple: !!c.simple,
		pairs: ["easy", "hard"].flatMap((level) =>
			parse(c[level]).map((words) => ({ words, level, category: c.id }))),
	}));
	const ALL_PAIRS = CATEGORIES.flatMap((c) => c.pairs);
	const PAIRS = ALL_PAIRS.map((p) => p.words);
	const LEVELS = ["easy", "mixed", "hard"];
	// What a phone starts with: the everyday topics, easy pairs.
	const SIMPLE = CATEGORIES.filter((c) => c.simple).map((c) => c.id);
	const labelOf = (id) => CATEGORIES.find((c) => c.id === id)?.label ?? id;

	/** Every pair the host's choice of categories and difficulty deals from. */
	const pairPool = (categoryIds, level = "mixed") => ALL_PAIRS.filter((p) =>
		categoryIds.includes(p.category) && (level === "mixed" || p.level === level));

	const pairKey = (pair) => pair.words.join("/").toLowerCase();

	/** The saved WORDS choice, or the starting one; a topic since removed is dropped. */
	function wordChoice(saved) {
		const ids = CATEGORIES.map((c) => c.id);
		let categories = Array.isArray(saved?.categories) ? saved.categories.filter((id) => ids.includes(id)) : [];
		if (!categories.length) categories = [...SIMPLE];
		return { categories, level: LEVELS.includes(saved?.level) ? saved.level : "easy" };
	}

	/** Who played last time and how, or a blank table of three. */
	function playerChoice(saved) {
		const names = (Array.isArray(saved?.names) ? saved.names : [])
			.filter((n) => typeof n === "string").slice(0, MAX_PLAYERS).map((n) => n.slice(0, 14));
		while (names.length < MIN_PLAYERS) names.push("");
		return {
			names,
			spies: Number.isInteger(saved?.spies) && saved.spies >= 1 ? saved.spies : 1,
			withBlank: saved?.withBlank === true,
		};
	}

	/**
	 * Draw a pair this phone has not dealt yet.
	 *
	 * `seen` is the keys of pairs already dealt, oldest first, kept across
	 * evenings in the game's storage. Only once every pair in the pool has come
	 * up does the pool start over — and even then not with the pair just played.
	 * Returns the pair and the new `seen`, capped so it stays well inside the
	 * storage budget.
	 */
	function drawPair(pool, seen = [], rng = Math.random) {
		const dealt = new Set(seen);
		let fresh = pool.filter((p) => !dealt.has(pairKey(p)));
		let kept = seen;
		if (!fresh.length) {
			const inPool = new Set(pool.map(pairKey));
			kept = seen.filter((k) => !inPool.has(k));
			const last = seen[seen.length - 1];
			fresh = pool.length > 1 ? pool.filter((p) => pairKey(p) !== last) : pool;
		}
		const pair = fresh[Math.floor(rng() * fresh.length)];
		return { pair, seen: [...kept, pairKey(pair)].slice(-ALL_PAIRS.length) };
	}

	/**
	 * Points for one hand, by name. Winning as an undercover is harder than
	 * winning as one of many civilians, and the blank's word guess is the
	 * longest shot of all, so they pay accordingly. Everybody on the winning
	 * side scores, voted out or not.
	 */
	const POINTS = { civilian: 1, spy: 3, blank: 4 };
	const WINNING_ROLE = { civilians: "civilian", spies: "spy", blank: "blank" };
	function handPoints(players, done) {
		const role = WINNING_ROLE[done];
		return Object.fromEntries(players.filter((p) => p.role === role).map((p) => [p.name, POINTS[role]]));
	}

	const MIN_PLAYERS = 3;
	const MAX_PLAYERS = 12;

	/**
	 * How many undercovers a table of this size should have.
	 *
	 * The constraint that matters is the win condition: undercovers win when
	 * they equal the civilians, so a table that starts anywhere near parity is
	 * over before anybody has spoken twice. Roughly a quarter keeps the first
	 * vote meaningful.
	 */
	const defaultSpies = (n, withBlank = false) =>
		Math.min(n <= 5 ? 1 : n <= 9 ? 2 : 3, maxSpies(n, withBlank));

	/**
	 * The most non-civilians a table can carry and still be worth playing.
	 *
	 * The undercovers win at parity, so the real constraint is that the table
	 * must survive **one wrong vote**: after a civilian is lost there should
	 * still be more civilians than everybody else. That is `n >= 2*others + 2`.
	 *
	 * Getting this wrong does not look like a bug. It looks like a game that
	 * keeps ending on the first vote — which is exactly what five players with
	 * one undercover *and* a blank did: three civilians against two, over the
	 * moment the table guessed wrong, before anybody had spoken twice.
	 */
	const maxOthers = (n) => Math.max(1, Math.floor((n - 2) / 2));

	/** How many undercovers are allowed, given whether a blank is taking a slot. */
	const maxSpies = (n, withBlank = false) =>
		Math.max(1, maxOthers(n) - (withBlank ? 1 : 0));

	/** A blank needs a table with room for two non-civilians. */
	const blankAllowed = (n) => maxOthers(n) >= 2;

	const shuffle = (list, rng = Math.random) => {
		const out = [...list];
		for (let i = out.length - 1; i > 0; i--) {
			const j = Math.floor(rng() * (i + 1));
			[out[i], out[j]] = [out[j], out[i]];
		}
		return out;
	};

	/**
	 * Deal roles and words.
	 *
	 * Returns one entry per player: `{ name, role, word }` where role is
	 * "civilian" | "spy" | "blank". The blank's word is null, which is the
	 * whole of its difficulty. `pair` is one from `drawPair`; left out, any
	 * pair from any category will do.
	 */
	function dealRoles(names, spyCount, withBlank, rng = Math.random, pair = drawPair(ALL_PAIRS, [], rng).pair) {
		// Which half of the pair the civilians get is itself random, so a player
		// who has seen the word list cannot infer their role from it.
		const flip = rng() < 0.5;
		const civilianWord = flip ? pair.words[0] : pair.words[1];
		const spyWord = flip ? pair.words[1] : pair.words[0];

		const roles = [];
		for (let i = 0; i < spyCount; i++) roles.push("spy");
		if (withBlank) roles.push("blank");
		while (roles.length < names.length) roles.push("civilian");

		const assigned = shuffle(roles, rng);
		return {
			civilianWord,
			spyWord,
			category: labelOf(pair.category),
			level: pair.level,
			players: names.map((name, i) => ({
				name,
				role: assigned[i],
				word: assigned[i] === "civilian" ? civilianWord : assigned[i] === "spy" ? spyWord : null,
				out: false,
			})),
		};
	}

	/**
	 * Who has won, if anybody has. `null` means play on.
	 *
	 * The blank counts as a non-civilian for the parity test — it is one more
	 * person the civilians have to find — but it does not win with the spies;
	 * its only win is the word guess when it is voted out.
	 */
	function winner(players) {
		const alive = players.filter((p) => !p.out);
		const civilians = alive.filter((p) => p.role === "civilian").length;
		const others = alive.length - civilians;
		if (others === 0) return "civilians";
		if (others >= civilians) return "spies";
		return null;
	}

	NeonArcade.undercoverRules = {
		PAIRS, CATEGORIES, SIMPLE, LEVELS, MIN_PLAYERS, MAX_PLAYERS, POINTS, defaultSpies, maxOthers, maxSpies, blankAllowed,
		shuffle, pairPool, pairKey, drawPair, dealRoles, winner, handPoints, wordChoice, playerChoice,
	};
})();

NeonArcade.registerGame({
	id: "undercover",
	name: "UNDERCOVER",
	blurb: "One word, one impostor, one phone passed round the table.",
	shape: "free",
	// Played on this device by people in the room. The party record has nothing
	// to do with who is playing, so the seat range is only there to stop the
	// lobby refusing it — `checkRoster` skips it for a local game.
	local: true,
	bots: false,
	seats: { min: 1, max: 8 },

	mount(ctx) {
		const {
			CATEGORIES, SIMPLE, LEVELS, MIN_PLAYERS, MAX_PLAYERS, maxSpies, blankAllowed, shuffle, pairPool, pairKey, drawPair,
			dealRoles, winner, handPoints, wordChoice, playerChoice,
		} = NeonArcade.undercoverRules;

		const shell = NeonArcade.gameShell(ctx.root, {
			css: `
				.uc { display: flex; flex-direction: column; gap: 12px; align-items: center;
					width: 100%; max-width: 420px; }
				.uc-names { display: flex; flex-direction: column; gap: 6px; width: 100%; }
				.uc-name { display: flex; gap: 6px; align-items: center; }
				.uc-name input { flex: 1; min-width: 0; min-height: 46px; padding: 8px 12px;
					background: var(--panel); border: 2px solid var(--border); border-radius: 8px;
					color: var(--ink); font-size: 16px; font-family: inherit; }
				.uc-name input:focus { outline: none; border-color: var(--accent); }
				.uc-name button { min-width: 46px; min-height: 46px; background: var(--panel);
					border: 2px solid var(--border); border-radius: 8px; color: var(--danger);
					font-size: 1.1rem; cursor: pointer; }
				.uc-opts { display: flex; flex-wrap: wrap; gap: 10px; justify-content: center;
					align-items: center; font-size: 0.74rem; color: var(--muted); }
				.uc-step { display: flex; gap: 6px; align-items: center; }
				.uc-step button { min-width: 44px; min-height: 44px; background: var(--panel);
					border: 2px solid var(--border); border-radius: 8px; color: var(--accent);
					font-size: 1.1rem; cursor: pointer; }
				.uc-step b { min-width: 1.5ch; text-align: center; color: var(--ink); font-weight: normal;
					font-size: 1.1rem; }
				.uc-toggle { min-height: 44px; padding: 8px 14px; background: var(--panel);
					border: 2px solid var(--border); border-radius: 8px; color: var(--muted);
					font-size: 0.74rem; letter-spacing: 0.08em; cursor: pointer; }
				.uc-toggle.on { border-color: var(--accent); color: var(--accent); }
				.uc-big { font-size: clamp(1.6rem, 8vw, 2.4rem); text-align: center; color: var(--ink);
					line-height: 1.15; }
				.uc-word { font-size: clamp(2.2rem, 12vw, 3.4rem); color: var(--accent);
					text-shadow: 0 0 18px var(--accent-glow); text-align: center; line-height: 1.1;
					word-break: break-word; }
				.uc-hint { font-size: 0.76rem; color: var(--muted); text-align: center;
					max-width: 30ch; line-height: 1.45; }
				.uc-tap { min-height: 140px; width: 100%; border-radius: 14px;
					background: var(--panel); border: 2px dashed var(--border); color: var(--muted);
					font-size: 0.9rem; letter-spacing: 0.12em; cursor: pointer; }
				.uc-list { display: flex; flex-direction: column; gap: 6px; width: 100%; }
				.uc-row { display: flex; justify-content: space-between; align-items: center;
					gap: 8px; padding: 10px 12px; min-height: 46px; border-radius: 8px;
					background: var(--panel); border: 2px solid var(--border); color: var(--ink);
					font-size: 0.9rem; text-align: left; cursor: default; }
				.uc-row.pick { cursor: pointer; }
				.uc-row.now { border-color: var(--accent); color: var(--accent); }
				.uc-row.gone { opacity: 0.4; text-decoration: line-through; }
				.uc-row small { color: var(--muted); font-size: 0.7rem; letter-spacing: 0.08em; }
				.uc-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
				.uc-actions .neon-btn { min-height: 46px; }
				.uc-cats { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; }
				.uc-row .uc-pts { color: var(--accent); font-size: 0.9rem; min-width: 3ch; text-align: right; }
				.uc-guess { width: 100%; min-height: 46px; padding: 8px 12px; background: var(--panel);
					border: 2px solid var(--border); border-radius: 8px; color: var(--ink);
					font-size: 16px; font-family: inherit; }
			`,
		});

		const wrap = document.createElement("div");
		wrap.className = "uc";
		const fill = document.createElement("div");
		fill.className = "g-fill";
		fill.append(wrap);
		shell.stage.append(fill);

		// -------------------------------------------------------------- state

		let phase = "setup";
		// Who is playing, how many undercovers, the blank: kept on the device, so
		// the same table next time does not set itself up again.
		let { names, spies, withBlank } = playerChoice(ctx.storage?.get("players"));
		let deal = null; // { civilianWord, spyWord, players }
		let handIndex = 0; // whose turn to look at the phone
		let revealed = false; // is the word on screen right now
		let order = []; // speaking order for this round
		let speaker = 0;
		let round = 1;
		let lastOut = null; // the player just voted out
		let done = null; // "civilians" | "spies" | "blank"
		let deals = 0; // games finished in this mount
		let picked = null; // who the table has tapped, before it is confirmed

		// What to deal from, and which pairs this phone has dealt already. Both
		// are kept on the device, so a group that plays every week keeps getting
		// pairs it has not had (drawPair).
		const allIds = CATEGORIES.map((c) => c.id);
		let { categories, level } = wordChoice(ctx.storage?.get("words"));
		let seen = Array.isArray(ctx.storage?.get("seen")) ? ctx.storage.get("seen") : [];
		// Points by name, kept on the device until RESET SCORES, so a reload or a
		// closed tab mid-evening does not wipe the table's tally. By name, so
		// CHANGE PLAYERS (adding a late arrival) keeps everyone else's.
		const savedScores = ctx.storage?.get("scores");
		let scores = savedScores && typeof savedScores === "object" ? { ...savedScores } : {};
		let gained = {}; // this hand's points, shown beside the totals

		const alive = () => (deal ? deal.players.filter((p) => !p.out) : []);
		const cleanNames = () => names.map((n) => n.trim()).filter(Boolean);

		const el = (tag, className, text) => {
			const node = document.createElement(tag);
			if (className) node.className = className;
			if (text != null) node.textContent = text;
			return node;
		};

		const button = (label, onClick, { accent = false, className = "neon-btn" } = {}) => {
			const b = el("button", className + (accent ? " neon-btn--accent" : ""), label);
			b.type = "button";
			b.addEventListener("click", onClick);
			return b;
		};

		// -------------------------------------------------------------- setup

		function savePlayers() {
			ctx.storage?.set("players", { names, spies, withBlank });
		}

		function renderSetup() {
			clampSpies();
			savePlayers();
			wrap.replaceChildren();
			wrap.append(el("div", "uc-hint",
				"Everyone plays on this one phone. Type in who is here, then pass it round."));

			const list = el("div", "uc-names");
			names.forEach((value, i) => {
				const row = el("div", "uc-name");
				const input = document.createElement("input");
				input.value = value;
				input.placeholder = `Player ${i + 1}`;
				input.maxLength = 14;
				input.setAttribute("aria-label", `name of player ${i + 1}`);
				// Written straight into the array on every keystroke: re-rendering
				// the list on each one would steal the caret mid-word.
				input.addEventListener("input", () => {
					names[i] = input.value;
					savePlayers();
					updateSetupActions();
				});
				row.append(input);
				if (names.length > MIN_PLAYERS) {
					row.append(button("−", () => {
						names.splice(i, 1);
						clampSpies();
						renderSetup();
					}, { className: "" }));
				}
				list.append(row);
			});
			wrap.append(list);

			const opts = el("div", "uc-opts");
			if (names.length < MAX_PLAYERS) {
				opts.append(button("+ PLAYER", () => {
					names.push("");
					clampSpies();
					renderSetup();
				}, { className: "uc-toggle" }));
			}

			const step = el("div", "uc-step");
			step.append(el("span", null, "UNDERCOVERS"));
			step.append(button("−", () => {
				spies = Math.max(1, spies - 1);
				renderSetup();
			}, { className: "" }));
			step.append(el("b", null, String(spies)));
			step.append(button("+", () => {
				spies = Math.min(maxSpies(cleanNames().length || names.length, withBlank), spies + 1);
				renderSetup();
			}, { className: "" }));
			opts.append(step);

			const canBlank = blankAllowed(cleanNames().length || names.length);
			const blank = button(withBlank ? "BLANK: ON" : "BLANK: OFF", () => {
				withBlank = !withBlank;
				clampSpies();
				renderSetup();
			}, { className: "uc-toggle" + (withBlank ? " on" : "") });
			blank.title = "One player gets no word at all";
			blank.disabled = !canBlank;
			opts.append(blank);

			const which = categories.length === CATEGORIES.length ? "ALL"
				: categories.length === SIMPLE.length && SIMPLE.every((id) => categories.includes(id)) ? "EVERYDAY"
				: categories.length === 1 ? CATEGORIES.find((c) => c.id === categories[0]).label.toUpperCase()
				: `${categories.length} TOPICS`;
			opts.append(button(`WORDS: ${which} · ${level.toUpperCase()}`, () => {
				phase = "words";
				render();
			}, { className: "uc-toggle" }));
			wrap.append(opts);

			if (withBlank && canBlank) {
				wrap.append(el("div", "uc-hint",
					"The blank gets no word. If they are voted out they may guess the civilians' word — and win outright if they get it."));
			} else if (!canBlank) {
				wrap.append(el("div", "uc-hint", "A blank needs six players, or five with no undercover to spare."));
			}

			const actions = el("div", "uc-actions");
			const go = button("DEAL", () => startHand(), { accent: true });
			go.id = "uc-deal";
			actions.append(go);
			wrap.append(actions);
			updateSetupActions();
		}

		/** Enable or disable DEAL in place, so typing does not rebuild the list. */
		function updateSetupActions() {
			const go = wrap.querySelector("#uc-deal");
			if (!go) return;
			const ready = cleanNames().length >= MIN_PLAYERS
				&& new Set(cleanNames().map((n) => n.toLowerCase())).size === cleanNames().length;
			go.disabled = !ready;
			const hint = wrap.querySelector("#uc-warn");
			hint?.remove();
			if (!ready) {
				const why = cleanNames().length < MIN_PLAYERS
					? `Name at least ${MIN_PLAYERS} players.`
					: "Two players have the same name.";
				const warn = el("div", "uc-hint", why);
				warn.id = "uc-warn";
				go.parentElement.before(warn);
			}
		}

		function clampSpies() {
			const n = cleanNames().length || names.length;
			if (withBlank && !blankAllowed(n)) withBlank = false;
			spies = Math.min(Math.max(1, spies), maxSpies(n, withBlank));
		}

		// -------------------------------------------------------------- words

		function saveWords() {
			ctx.storage?.set("words", { categories, level });
		}

		function renderWords() {
			wrap.replaceChildren();
			wrap.append(el("div", "uc-big", "Words"));
			wrap.append(el("div", "uc-hint", "Deal from any of these. Everyone is told the topic, never the word."));

			const cats = el("div", "uc-cats");
			for (const c of CATEGORIES) {
				const on = categories.includes(c.id);
				const chip = button(c.label, () => {
					categories = on ? categories.filter((id) => id !== c.id) : allIds.filter((id) => id === c.id || categories.includes(id));
					saveWords();
					render();
				}, { className: "uc-toggle" + (on ? " on" : "") });
				chip.setAttribute("aria-pressed", String(on));
				cats.append(chip);
			}
			wrap.append(cats);

			const bulk = el("div", "uc-opts");
			bulk.append(button("EVERYDAY", () => {
				categories = [...SIMPLE];
				saveWords();
				render();
			}, { className: "uc-toggle" }));
			bulk.append(button("ALL", () => {
				categories = [...allIds];
				saveWords();
				render();
			}, { className: "uc-toggle" }));
			bulk.append(button("NONE", () => {
				categories = [];
				render();
			}, { className: "uc-toggle" }));
			wrap.append(bulk);

			// How close the two words are: easy pairs pull apart within a round,
			// hard ones (Butterfly / Moth) can take several.
			const levels = el("div", "uc-opts");
			for (const l of LEVELS) {
				const b = button(l.toUpperCase(), () => {
					level = l;
					saveWords();
					render();
				}, { className: "uc-toggle" + (l === level ? " on" : "") });
				b.setAttribute("aria-pressed", String(l === level));
				levels.append(b);
			}
			wrap.append(levels);

			const pool = pairPool(categories, level);
			const dealt = new Set(seen);
			const fresh = pool.filter((p) => !dealt.has(pairKey(p))).length;
			wrap.append(el("div", "uc-hint", pool.length
				? `${pool.length} pairs · ${fresh} not dealt on this phone yet`
				: "Pick at least one topic."));

			const actions = el("div", "uc-actions");
			const done = button("DONE", () => {
				phase = "setup";
				render();
			}, { accent: true });
			done.disabled = !pool.length;
			actions.append(done);
			wrap.append(actions);
		}

		// --------------------------------------------------------------- deal

		function startHand() {
			const list = cleanNames();
			// Re-checked here as well as in the UI: the toggle can be left on from
			// a bigger game and then players removed.
			const blank = withBlank && blankAllowed(list.length);
			// The words screen will not close on an empty pool, but a saved choice
			// from an older list could still name nothing; fall back to everything.
			let pool = pairPool(categories, level);
			if (!pool.length) pool = pairPool(CATEGORIES.map((c) => c.id), "mixed");
			const draw = drawPair(pool, seen);
			seen = draw.seen;
			ctx.storage?.set("seen", seen);
			deal = dealRoles(list, Math.min(spies, maxSpies(list.length, blank)), blank, Math.random, draw.pair);
			handIndex = 0;
			revealed = false;
			round = 1;
			lastOut = null;
			done = null;
			phase = "pass";
			render();
		}

		function renderPass() {
			const player = deal.players[handIndex];
			wrap.replaceChildren();
			wrap.append(el("div", "uc-big", `Pass to ${player.name}`));
			wrap.append(el("div", "uc-hint", "Everyone else: look away."));
			// A deliberate tap, not an automatic reveal. The screen has just been
			// in somebody else's hand, and the whole game is one careless glance
			// away from being over.
			wrap.append(button("TAP TO SEE YOUR WORD", () => {
				revealed = true;
				render();
			}, { className: "uc-tap" }));
		}

		function renderReveal() {
			const player = deal.players[handIndex];
			wrap.replaceChildren();
			wrap.append(el("div", "uc-hint", player.name));
			wrap.append(el("div", "uc-hint", `Topic: ${deal.category}`));
			if (player.word) {
				wrap.append(el("div", "uc-word", player.word));
			} else {
				wrap.append(el("div", "uc-word", "—"));
				wrap.append(el("div", "uc-hint", "You are the blank. You have no word. Bluff."));
			}
			const actions = el("div", "uc-actions");
			const last = handIndex === deal.players.length - 1;
			actions.append(button(last ? "HIDE & START" : "HIDE & PASS ON", () => {
				revealed = false;
				if (last) {
					// A fresh speaking order each hand, so the same person is not
					// always first to give something away.
					order = shuffle(deal.players.filter((p) => !p.out).map((p) => p.name));
					speaker = 0;
					phase = "describe";
				} else {
					handIndex++;
				}
				render();
			}, { accent: true }));
			wrap.append(actions);
		}

		// ----------------------------------------------------------- describe

		function renderDescribe() {
			wrap.replaceChildren();
			wrap.append(el("div", "uc-hint",
				`Round ${round} · ${deal.category}. One word each, out loud. Do not say your word itself.`));
			const list = el("div", "uc-list");
			order.forEach((name, i) => {
				const row = el("div", "uc-row" + (i === speaker ? " now" : ""));
				row.append(el("span", null, name));
				if (i === speaker) row.append(el("small", null, "SPEAKING"));
				else if (i < speaker) row.append(el("small", null, "DONE"));
				list.append(row);
			});
			wrap.append(list);
			const actions = el("div", "uc-actions");
			const last = speaker >= order.length - 1;
			actions.append(button(last ? "GO TO VOTE" : "NEXT", () => {
				if (last) phase = "vote";
				else speaker++;
				render();
			}, { accent: true }));
			wrap.append(actions);
		}

		// --------------------------------------------------------------- vote

		function renderVote() {
			wrap.replaceChildren();
			wrap.append(el("div", "uc-big", "Who is out?"));
			wrap.append(el("div", "uc-hint", "Argue it out, then tap whoever the table picked."));
			const list = el("div", "uc-list");
			for (const player of deal.players) {
				if (player.out) continue;
				const row = el("button", "uc-row pick" + (picked === player ? " now" : ""));
				row.type = "button";
				row.append(el("span", null, player.name));
				row.addEventListener("click", () => {
					picked = picked === player ? null : player;
					render();
				});
				list.append(row);
			}
			wrap.append(list);

			// Two taps, not one. A stray thumb on a phone going round a table
			// would otherwise knock somebody out of the game, and the reveal that
			// follows cannot be un-seen.
			const actions = el("div", "uc-actions");
			if (picked) {
				actions.append(button(`VOTE OUT ${picked.name}`, () => {
					const target = picked;
					picked = null;
					voteOut(target);
				}, { accent: true }));
			}
			wrap.append(actions);
		}

		function voteOut(player) {
			player.out = true;
			lastOut = player;
			// The blank's one shot: name the civilians' word on the way out.
			phase = player.role === "blank" ? "guess" : "reveal";
			if (phase === "reveal") done = winner(deal.players);
			render();
		}

		function renderGuess() {
			wrap.replaceChildren();
			wrap.append(el("div", "uc-big", `${lastOut.name} was the blank`));
			wrap.append(el("div", "uc-hint", "One guess at the civilians' word. Get it and you win outright."));
			const input = document.createElement("input");
			input.className = "uc-guess";
			input.placeholder = "The word…";
			input.setAttribute("aria-label", "the blank's guess");
			wrap.append(input);
			const actions = el("div", "uc-actions");
			actions.append(button("GUESS", () => {
				const said = input.value.trim().toLowerCase();
				if (said && said === deal.civilianWord.toLowerCase()) done = "blank";
				else done = winner(deal.players);
				phase = "reveal";
				render();
			}, { accent: true }));
			actions.append(button("PASS", () => {
				done = winner(deal.players);
				phase = "reveal";
				render();
			}));
			wrap.append(actions);
			input.focus();
		}

		function renderRevealVote() {
			wrap.replaceChildren();
			const role = lastOut.role === "spy" ? "UNDERCOVER" : lastOut.role === "blank" ? "THE BLANK" : "a civilian";
			wrap.append(el("div", "uc-big", `${lastOut.name} was ${role}`));
			if (lastOut.word) wrap.append(el("div", "uc-hint", `Their word: ${lastOut.word}`));

			const actions = el("div", "uc-actions");
			if (done) {
				actions.append(button("SEE THE RESULT", () => {
					phase = "over";
					// One phone, typed-in names: it counts as a game played here,
					// never as anyone's win (lib/stats.js "local").
					deals++;
					ctx.reportResult?.({ kind: "local", match: deals, ranking: [[ctx.room.selfId]] });
					gained = handPoints(deal.players, done);
					for (const [name, pts] of Object.entries(gained)) scores[name] = (scores[name] ?? 0) + pts;
					ctx.storage?.set("scores", scores);
					render();
				}, { accent: true }));
			} else {
				actions.append(button("NEXT ROUND", () => {
					round++;
					order = shuffle(alive().map((p) => p.name));
					speaker = 0;
					phase = "describe";
					render();
				}, { accent: true }));
			}
			wrap.append(actions);
		}

		function renderOver() {
			wrap.replaceChildren();
			const title = done === "civilians" ? "CIVILIANS WIN"
				: done === "spies" ? "UNDERCOVER WINS"
				: "THE BLANK WINS";
			wrap.append(el("div", "uc-big", title));
			wrap.append(el("div", "uc-hint",
				`${deal.category}: civilians had "${deal.civilianWord}". The undercover had "${deal.spyWord}".`));
			// Everyone at this table, best total first: this hand's role and
			// points on the left, the running total on the right.
			const list = el("div", "uc-list");
			const ranked = [...deal.players].sort((a, b) => (scores[b.name] ?? 0) - (scores[a.name] ?? 0));
			for (const player of ranked) {
				const row = el("div", "uc-row" + (player.out ? " gone" : ""));
				const who = el("span", null, player.name + " ");
				const role = player.role === "spy" ? "UNDERCOVER" : player.role === "blank" ? "BLANK" : "CIVILIAN";
				who.append(el("small", null, gained[player.name] ? `${role} +${gained[player.name]}` : role));
				row.append(who);
				row.append(el("span", "uc-pts", String(scores[player.name] ?? 0)));
				list.append(row);
			}
			wrap.append(list);
			const actions = el("div", "uc-actions");
			actions.append(button("PLAY AGAIN", () => startHand(), { accent: true }));
			actions.append(button("CHANGE PLAYERS", () => {
				phase = "setup";
				render();
			}));
			actions.append(button("RESET SCORES", () => {
				scores = {};
				gained = {};
				ctx.storage?.set("scores", scores);
				render();
			}));
			wrap.append(actions);
		}

		// -------------------------------------------------------------- shell

		function renderHud() {
			const parts = [];
			if (phase === "setup") parts.push({ key: "s", text: "Who is playing?", className: "g-muted" });
			else if (phase === "words") parts.push({ key: "s", text: "Words", className: "g-muted" });
			else if (phase === "pass") parts.push({ key: "s", text: "Dealing", className: "g-muted" });
			else if (phase === "describe") parts.push({ key: "s", text: `Round ${round}` });
			else if (phase === "vote") parts.push({ key: "s", text: "Vote" });
			else if (phase === "over") parts.push({ key: "s", text: "Result" });
			if (deal && phase !== "setup" && phase !== "over") {
				parts.push({ key: "n", text: `${alive().length} still in`, className: "g-muted" });
			}
			shell.setHud(parts);
		}

		function render() {
			if (phase === "setup") renderSetup();
			else if (phase === "words") renderWords();
			else if (phase === "pass") (revealed ? renderReveal : renderPass)();
			else if (phase === "describe") renderDescribe();
			else if (phase === "vote") renderVote();
			else if (phase === "guess") renderGuess();
			else if (phase === "reveal") renderRevealVote();
			else if (phase === "over") renderOver();
			renderHud();
		}

		// If somebody did connect a second device, say what is going on rather
		// than leaving them with an empty screen. Nothing here is networked.
		if (!ctx.isHost) {
			wrap.replaceChildren();
			wrap.append(el("div", "uc-big", "Gather round"));
			wrap.append(el("div", "uc-hint",
				"Undercover is played on one phone, passed from hand to hand. Everything happens on the host's screen."));
			shell.setHud([{ key: "s", text: "One device", className: "g-muted" }]);
		} else {
			render();
		}

		return {
			debug: () => ({
				phase,
				revealed,
				round,
				players: deal ? deal.players.map((p) => ({ ...p })) : [],
				civilianWord: deal?.civilianWord ?? null,
				spyWord: deal?.spyWord ?? null,
				category: deal?.category ?? null,
				level: deal?.level ?? null,
				categories: [...categories],
				wordLevel: level,
				seen: seen.length,
				scores: { ...scores },
				order: [...order],
				speaker,
				alive: alive().length,
				done,
				// Whether a word is on screen right now, and whose. The one thing
				// worth asserting about a game whose whole job is not showing it.
				onScreen: revealed && deal ? deal.players[handIndex].name : null,
			}),
			unmount() {
				shell.destroy();
			},
		};
	},
});
