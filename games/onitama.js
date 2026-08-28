// games/onitama.js — Onitama, as a mountable module.
//
// The arcade's first game with a real mid-game. Connect 4 is decided by a
// tactic; this one is decided by what you are *holding*, because the card you
// move with is the card you hand your opponent. Every move is a gift, and that
// single rule is where the depth comes from.
//
// ## The rules, since the code assumes them
//
// A 5x5 board, five pieces a side on your home row, your Master on the middle
// square (your temple arch). Five cards are dealt from sixteen: two to each
// player, one set aside. On your turn you pick one of your two cards, move one
// piece by one of the offsets printed on it, and then **your card goes to the
// side and the side card becomes yours**. You win by capturing the enemy Master
// (the Way of the Stone) or by walking your own Master onto their temple arch
// (the Way of the Stream). With no legal move you must still pass a card along.
//
// ## Orientation, which is the whole bug surface
//
// Cards are written once, from the point of view of the player at the bottom:
// `dx` is right, `dy` is *forward*. Blue reads the same card upside down, so
// its offsets are negated. Separately — and this is the part that is easy to
// conflate — every player is shown their own side at the bottom, so there is a
// second, purely visual flip in `toScreen`/`fromScreen`. Board state is always
// absolute: row 0 is Blue's home, row 4 is Red's.
//
// Host-authoritative like every game here: the host owns the position and
// validates moves, so a bot needs no channel of its own — the host searches and
// applies the result through the same `applyMove` a tap goes through.

// The rules and the search live outside `mount` on purpose: they are pure
// functions of a position, they are the part most likely to be wrong, and a
// board that has to exist in the DOM before they can be exercised is a board
// that will not be exercised. `scripts/test-onitama.mjs` loads this file with
// no document at all and plays whole games through them.
(() => {
	const N = 5;
	const RED = 0; // bottom, row 4
	const BLUE = 1; // top, row 0

	// ------------------------------------------------------------- cards
	//
	// Offsets are (dx, dy) with dy pointing *forward* for the player using
	// the card. The sixteen of the base game.
	//
	// VERIFY: in the physical game each card also carries a colour, and the
	// set-aside card's colour decides who moves first. The move sets below
	// are the published ones; the `first` flags are ours — an even 8/8 split
	// that keeps the mechanic without claiming to reproduce the deck. If
	// somebody checks a real box, correct these rather than the mechanic.
	const CARDS = {
		tiger: { name: "TIGER", first: BLUE, moves: [[0, 2], [0, -1]] },
		dragon: { name: "DRAGON", first: RED, moves: [[-2, 1], [2, 1], [-1, -1], [1, -1]] },
		frog: { name: "FROG", first: RED, moves: [[-2, 0], [-1, 1], [1, -1]] },
		rabbit: { name: "RABBIT", first: BLUE, moves: [[2, 0], [1, 1], [-1, -1]] },
		crab: { name: "CRAB", first: BLUE, moves: [[-2, 0], [2, 0], [0, 1]] },
		elephant: { name: "ELEPHANT", first: RED, moves: [[-1, 0], [1, 0], [-1, 1], [1, 1]] },
		goose: { name: "GOOSE", first: BLUE, moves: [[-1, 0], [-1, 1], [1, 0], [1, -1]] },
		rooster: { name: "ROOSTER", first: RED, moves: [[-1, 0], [-1, -1], [1, 0], [1, 1]] },
		monkey: { name: "MONKEY", first: BLUE, moves: [[-1, 1], [1, 1], [-1, -1], [1, -1]] },
		mantis: { name: "MANTIS", first: RED, moves: [[-1, 1], [1, 1], [0, -1]] },
		horse: { name: "HORSE", first: RED, moves: [[0, 1], [-1, 0], [0, -1]] },
		ox: { name: "OX", first: BLUE, moves: [[0, 1], [1, 0], [0, -1]] },
		crane: { name: "CRANE", first: BLUE, moves: [[0, 1], [-1, -1], [1, -1]] },
		boar: { name: "BOAR", first: RED, moves: [[0, 1], [-1, 0], [1, 0]] },
		eel: { name: "EEL", first: BLUE, moves: [[-1, 1], [-1, -1], [1, 0]] },
		cobra: { name: "COBRA", first: RED, moves: [[1, 1], [1, -1], [-1, 0]] },
	};
	const CARD_IDS = Object.keys(CARDS);

	// -------------------------------------------------------------- rules

	const TEMPLE = { [RED]: [4, 2], [BLUE]: [0, 2] }; // [row, col] of each home arch

	const emptyBoard = () => Array.from({ length: N }, () => Array(N).fill(null));

	function startBoard() {
		const b = emptyBoard();
		for (let c = 0; c < N; c++) {
			b[4][c] = { side: RED, master: c === 2 };
			b[0][c] = { side: BLUE, master: c === 2 };
		}
		return b;
	}

	/** Where a card's offset lands, in absolute board coordinates. */
	function destination(side, row, col, [dx, dy]) {
		// Red plays up the board and reads the card as printed; Blue plays
		// down the board and reads it upside down.
		return side === RED ? [row - dy, col + dx] : [row + dy, col - dx];
	}

	const onBoard = (r, c) => r >= 0 && r < N && c >= 0 && c < N;

	/** Every legal move for `side` in `s`, as {card, from, to, capture}. */
	function legalMoves(s, side) {
		const out = [];
		for (const card of s.hands[side]) {
			for (const move of CARDS[card].moves) {
				for (let r = 0; r < N; r++) {
					for (let c = 0; c < N; c++) {
						const piece = s.board[r][c];
						if (!piece || piece.side !== side) continue;
						const [tr, tc] = destination(side, r, c, move);
						if (!onBoard(tr, tc)) continue;
						const target = s.board[tr][tc];
						if (target && target.side === side) continue;
						out.push({ card, from: [r, c], to: [tr, tc], capture: target ?? null });
					}
				}
			}
		}
		return out;
	}

	/**
	 * Apply a move in place and return the winner, if the move ended it.
	 *
	 * Both victory conditions are checked here rather than in a separate
	 * sweep, because both are properties of the move just made: you cannot
	 * capture a Master or reach an arch by accident on somebody else's turn.
	 */
	function applyMove(s, side, mv) {
		const [fr, fc] = mv.from;
		const [tr, tc] = mv.to;
		const piece = s.board[fr][fc];
		const captured = s.board[tr][tc];
		s.board[tr][tc] = piece;
		s.board[fr][fc] = null;

		// Card cycling: the card you used is the card they get next.
		const hand = s.hands[side];
		hand[hand.indexOf(mv.card)] = s.side;
		s.side = mv.card;
		s.last = { from: mv.from, to: mv.to, card: mv.card, side };
		s.turn = 1 - side;

		if (captured?.master) return { winner: side, by: "stone" };
		const [ar, ac] = TEMPLE[1 - side];
		if (piece.master && tr === ar && tc === ac) return { winner: side, by: "stream" };
		return null;
	}

	/** Pass: no legal move exists, so a card is handed over and nothing else. */
	function applyPass(s, side, card) {
		const hand = s.hands[side];
		hand[hand.indexOf(card)] = s.side;
		s.side = card;
		s.last = { pass: true, card, side };
		s.turn = 1 - side;
	}

	const cloneState = (s) => ({
		board: s.board.map((row) => row.map((p) => (p ? { ...p } : null))),
		hands: [[...s.hands[0]], [...s.hands[1]]],
		side: s.side,
		turn: s.turn,
		last: s.last,
	});

	// ---------------------------------------------------------------- bot
	//
	// Alpha-beta over the same `legalMoves`/`applyMove` a person drives, so
	// the bot cannot play a move the rules would refuse. Iterative deepening
	// under a wall-clock budget rather than a fixed depth: the branching
	// factor here swings between about 8 and 40 depending on how many pieces
	// are left, and a depth that is instant in the endgame locks a phone up
	// in the opening.

	const MATE = 1e6;
	const STUDENT = 100;
	// Being able to move at all is worth something in a game you can lose by
	// having to hand over your last useful card.
	const MOBILITY = 3;

	function evaluate(s, side) {
		let score = 0;
		let myMaster = null;
		let theirMaster = null;
		for (let r = 0; r < N; r++) {
			for (let c = 0; c < N; c++) {
				const p = s.board[r][c];
				if (!p) continue;
				const mine = p.side === side;
				if (p.master) {
					if (mine) myMaster = [r, c];
					else theirMaster = [r, c];
					continue;
				}
				score += mine ? STUDENT : -STUDENT;
				// Centre files matter: a student on the edge covers half as
				// much of the board whatever card turns up.
				score += (mine ? 1 : -1) * (2 - Math.abs(c - 2)) * 4;
			}
		}
		if (!theirMaster) return MATE;
		if (!myMaster) return -MATE;

		// The Way of the Stream is a real threat, not a curiosity: a Master
		// two steps from the arch forces answers.
		const dist = ([r, c], [ar, ac]) => Math.max(Math.abs(r - ar), Math.abs(c - ac));
		score += (4 - dist(myMaster, TEMPLE[1 - side])) * 12;
		score -= (4 - dist(theirMaster, TEMPLE[side])) * 12;

		score += (legalMoves(s, side).length - legalMoves(s, 1 - side).length) * MOBILITY;
		return score;
	}

	function search(s, side, depth, alpha, beta, deadline) {
		if (Date.now() > deadline) return { score: evaluate(s, side), timeout: true };
		const moves = legalMoves(s, s.turn);
		if (depth === 0) return { score: evaluate(s, side) };
		if (!moves.length) {
			// Forced pass. Playing it out matters — a passed card changes what
			// the opponent holds, which is often the point of the position.
			const next = cloneState(s);
			applyPass(next, s.turn, s.hands[s.turn][0]);
			const r = search(next, side, depth - 1, alpha, beta, deadline);
			return { score: r.score, timeout: r.timeout };
		}

		const maximising = s.turn === side;
		let best = maximising ? -Infinity : Infinity;
		let bestMove = null;
		let timeout = false;

		// Captures first: the cheapest ordering there is, and with a branching
		// factor this size it is most of what alpha-beta needs to cut.
		moves.sort((a, b) => (b.capture ? 1 : 0) - (a.capture ? 1 : 0));

		for (const mv of moves) {
			const next = cloneState(s);
			const end = applyMove(next, s.turn, mv);
			let score;
			if (end) {
				// Prefer a win that arrives sooner and a loss that arrives
				// later, or the bot will dawdle in a won position.
				score = end.winner === side ? MATE + depth : -MATE - depth;
			} else {
				const r = search(next, side, depth - 1, alpha, beta, deadline);
				score = r.score;
				if (r.timeout) timeout = true;
			}
			if (maximising) {
				if (score > best) (best = score), (bestMove = mv);
				alpha = Math.max(alpha, best);
			} else {
				if (score < best) (best = score), (bestMove = mv);
				beta = Math.min(beta, best);
			}
			if (beta <= alpha) break;
			if (timeout) break;
		}
		return { score: best, move: bestMove, timeout };
	}

	function chooseMove(s, side, budgetMs = 500) {
		const deadline = Date.now() + budgetMs;
		const moves = legalMoves(s, side);
		if (!moves.length) return null;
		let best = moves[0];
		for (let depth = 2; depth <= 8; depth++) {
			const r = search(cloneState(s), side, depth, -Infinity, Infinity, deadline);
			// A timed-out ply is a partial search, and its best move can be
			// worse than the one the last complete ply found. Discard it.
			if (r.timeout) break;
			if (r.move) best = r.move;
			if (Math.abs(r.score) >= MATE) break;
			if (Date.now() > deadline) break;
		}
		return best;
	}


	NeonArcade.onitamaRules = {
		N, RED, BLUE, CARDS, CARD_IDS, TEMPLE,
		emptyBoard, startBoard, destination, onBoard,
		legalMoves, applyMove, applyPass, cloneState, chooseMove, evaluate,
	};
})();

NeonArcade.registerGame({
	id: "onitama",
	name: "ONITAMA",
	blurb: "Move with a card, then hand it to your opponent.",
	shape: "teams",
	seats: { min: 2, max: 2 },

	mount(ctx) {
		const { room } = ctx;
		// Rules, cards and the search: see NeonArcade.onitamaRules below.
		const {
			N, RED, BLUE, CARDS, CARD_IDS, TEMPLE,
			emptyBoard, startBoard, onBoard,
			legalMoves, applyMove, applyPass, chooseMove,
		} = NeonArcade.onitamaRules;

		// ------------------------------------------------------------- markup

		const shell = NeonArcade.gameShell(ctx.root, {
			css: `
				/* Sizing comes from .g-fill in lib/ui.js — see the note there about
				   why this must not set its own full height. */
				.oni-board { border: 3px solid #2a2a4e; border-radius: 10px;
					box-shadow: 0 0 30px rgba(0, 100, 255, 0.2); touch-action: manipulation; }
				.oni-rack { display: flex; gap: 8px; align-items: center; justify-content: center;
					flex-wrap: nowrap; }
				.oni-card { background: var(--panel); border: 2px solid var(--border);
					border-radius: 8px; padding: 4px 5px 5px; display: flex; flex-direction: column;
					align-items: center; gap: 3px; cursor: pointer; color: var(--muted);
					font-size: 0.6rem; letter-spacing: 0.08em; min-width: 0;
					/* Comfortably past the 44px tap minimum even at the small size
					   the two racks plus a board have to share on a 390px screen. */
					min-height: 48px; touch-action: manipulation; }
				.oni-card[disabled] { opacity: 0.45; cursor: default; }
				.oni-card.sel { border-color: var(--accent); color: var(--accent);
					box-shadow: 0 0 12px var(--accent-glow); }
				.oni-card.theirs { opacity: 0.7; cursor: default; }
				.oni-card.side { border-style: dashed; }
				.oni-label { font-size: 0.62rem; color: var(--muted); letter-spacing: 0.14em; }
			`,
		});

		const wrap = document.createElement("div");
		wrap.className = "g-fill";
		const theirRack = document.createElement("div");
		theirRack.className = "oni-rack";
		const canvas = document.createElement("canvas");
		canvas.className = "oni-board";
		const midRack = document.createElement("div");
		midRack.className = "oni-rack";
		const myRack = document.createElement("div");
		myRack.className = "oni-rack";
		wrap.append(theirRack, canvas, midRack, myRack);
		shell.stage.append(wrap);
		const c2d = canvas.getContext("2d");

		// -------------------------------------------------------------- state

		let state = {
			board: emptyBoard(),
			hands: [[], []],
			side: null,
			turn: RED,
			winner: null,
			by: null,
			started: false,
			seats: [null, null], // memberId per side
			last: null,
		};
		let selectedCard = null;
		let selectedPiece = null; // [row, col] in board coordinates
		let targets = []; // legal destinations for the current selection
		let botTimer = null;
		let disposed = false;

		const mySide = () =>
			room.selfId === state.seats[RED] ? RED : room.selfId === state.seats[BLUE] ? BLUE : null;

		const isSpectator = () => mySide() === null;

		// The board is drawn with *your* side at the bottom, always. Purely
		// presentational — nothing below this line reaches the rules.
		const flipped = () => mySide() === BLUE;
		const toScreen = (r, c) => (flipped() ? [N - 1 - r, N - 1 - c] : [r, c]);
		const fromScreen = (r, c) => (flipped() ? [N - 1 - r, N - 1 - c] : [r, c]);

		// -------------------------------------------------------------- setup

		function seatPlayers() {
			state.seats[RED] = ctx.seats("A")[0] ?? null;
			state.seats[BLUE] = ctx.seats("B")[0] ?? null;
		}

		function deal() {
			const deck = [...CARD_IDS];
			for (let i = deck.length - 1; i > 0; i--) {
				const j = Math.floor(Math.random() * (i + 1));
				[deck[i], deck[j]] = [deck[j], deck[i]];
			}
			const five = deck.slice(0, 5);
			state.board = startBoard();
			state.hands = [five.slice(0, 2), five.slice(2, 4)];
			state.side = five[4];
			state.turn = CARDS[five[4]].first;
			state.winner = null;
			state.by = null;
			state.last = null;
			state.started = true;
		}

		// ------------------------------------------------------------ drawing

		function cellSize() {
			// The board competes with two card racks and a spare card for a phone's
			// height, so it is sized from whichever runs out first. The racks are
			// measured rather than assumed: their height depends on the font the
			// device actually used.
			const chromeH = theirRack.offsetHeight + midRack.offsetHeight + myRack.offsetHeight;
			const availH = shell.stage.clientHeight - shell.hud.offsetHeight - chromeH - 46;
			const availW = shell.stage.clientWidth;
			return Math.max(38, Math.floor(Math.min(availW * 0.95, availH) / N));
		}

		function layout() {
			const size = cellSize();
			const dpr = Math.min(window.devicePixelRatio || 1, 2);
			canvas.style.width = size * N + "px";
			canvas.style.height = size * N + "px";
			canvas.width = size * N * dpr;
			canvas.height = size * N * dpr;
			c2d.setTransform(dpr, 0, 0, dpr, 0, 0);
			draw();
		}

		function draw() {
			const size = canvas.clientWidth / N;
			c2d.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);

			for (let sr = 0; sr < N; sr++) {
				for (let sc = 0; sc < N; sc++) {
					const [r, c] = fromScreen(sr, sc);
					const x = sc * size;
					const y = sr * size;
					c2d.fillStyle = (sr + sc) % 2 === 0 ? "#12122a" : "#0d0d1f";
					c2d.fillRect(x, y, size, size);

					// The temple arches, in their owner's colour.
					for (const side of [RED, BLUE]) {
						const [ar, ac] = TEMPLE[side];
						if (r !== ar || c !== ac) continue;
						c2d.strokeStyle = side === RED ? "rgba(255,77,77,0.55)" : "rgba(77,166,255,0.55)";
						c2d.lineWidth = 2;
						c2d.strokeRect(x + 5, y + 5, size - 10, size - 10);
					}

					if (state.last && !state.last.pass) {
						const hit = [state.last.from, state.last.to].some(([lr, lc]) => lr === r && lc === c);
						if (hit) {
							c2d.fillStyle = "rgba(255,255,255,0.07)";
							c2d.fillRect(x, y, size, size);
						}
					}
				}
			}

			// Legal destinations for whatever is selected.
			for (const [tr, tc] of targets) {
				const [sr, sc] = toScreen(tr, tc);
				const x = sc * size;
				const y = sr * size;
				const occupied = state.board[tr][tc];
				c2d.fillStyle = occupied ? "rgba(255,77,77,0.28)" : "rgba(0,255,200,0.22)";
				c2d.beginPath();
				c2d.arc(x + size / 2, y + size / 2, size * (occupied ? 0.42 : 0.16), 0, Math.PI * 2);
				c2d.fill();
			}

			for (let r = 0; r < N; r++) {
				for (let c = 0; c < N; c++) {
					const piece = state.board[r][c];
					if (!piece) continue;
					const [sr, sc] = toScreen(r, c);
					drawPiece(sc * size, sr * size, size, piece,
						selectedPiece && selectedPiece[0] === r && selectedPiece[1] === c);
				}
			}
		}

		function drawPiece(x, y, size, piece, selected) {
			const cx = x + size / 2;
			const cy = y + size / 2;
			const rad = size * 0.34;
			const red = piece.side === RED;
			c2d.beginPath();
			c2d.arc(cx, cy, rad, 0, Math.PI * 2);
			c2d.fillStyle = red ? "#c62b2b" : "#2b6bc6";
			c2d.fill();
			c2d.lineWidth = selected ? 3 : 2;
			c2d.strokeStyle = selected ? "#00ffc8" : red ? "#ff7b7b" : "#7bb7ff";
			c2d.stroke();
			if (piece.master) {
				// A ring, not a glyph: at 38px a letter is unreadable and a shape
				// is not.
				c2d.beginPath();
				c2d.arc(cx, cy, rad * 0.5, 0, Math.PI * 2);
				c2d.lineWidth = 2.5;
				c2d.strokeStyle = "#ffe9a8";
				c2d.stroke();
			}
		}

		/** A card is drawn as the 5x5 it is: centre square plus its offsets. */
		function cardCanvas(cardId, side, px) {
			const el = document.createElement("canvas");
			const dpr = Math.min(window.devicePixelRatio || 1, 2);
			el.style.width = px + "px";
			el.style.height = px + "px";
			el.width = px * dpr;
			el.height = px * dpr;
			const g = el.getContext("2d");
			g.setTransform(dpr, 0, 0, dpr, 0, 0);
			const s = px / 5;
			for (let r = 0; r < 5; r++) {
				for (let c = 0; c < 5; c++) {
					g.fillStyle = "#0d0d1f";
					g.fillRect(c * s + 0.5, r * s + 0.5, s - 1, s - 1);
				}
			}
			g.fillStyle = "#6a6a8a";
			g.fillRect(2 * s + 0.5, 2 * s + 0.5, s - 1, s - 1);
			// Shown the way the holder will read it: negated for Blue, so the
			// card on screen matches the move it will make on the board.
			for (const [dx, dy] of CARDS[cardId].moves) {
				const c = side === RED ? 2 + dx : 2 - dx;
				const r = side === RED ? 2 - dy : 2 + dy;
				if (r < 0 || r > 4 || c < 0 || c > 4) continue;
				g.fillStyle = side === BLUE ? "#4da6ff" : "#ff6b6b";
				g.fillRect(c * s + 0.5, r * s + 0.5, s - 1, s - 1);
			}
			return el;
		}

		function cardButton(cardId, side, { px, selectable, selected, className }) {
			const btn = document.createElement("button");
			btn.className = "oni-card" + (className ? " " + className : "") + (selected ? " sel" : "");
			btn.type = "button";
			btn.append(cardCanvas(cardId, side, px));
			const label = document.createElement("span");
			label.textContent = CARDS[cardId].name;
			btn.append(label);
			btn.setAttribute("aria-label", `${CARDS[cardId].name} card`);
			if (!selectable) btn.disabled = true;
			return btn;
		}

		// ---------------------------------------------------------------- HUD

		function renderRacks() {
			const me = mySide();
			const view = me ?? RED; // a spectator watches from Red's side
			const them = 1 - view;
			const myTurn = state.started && !state.winner && me !== null && state.turn === me;
			const stuck = myTurn && legalMoves(state, me).length === 0;
			const small = Math.min(52, Math.max(38, Math.floor(shell.stage.clientWidth / 8)));
			const big = Math.min(64, Math.max(44, Math.floor(shell.stage.clientWidth / 6.5)));

			theirRack.replaceChildren(
				...state.hands[them].map((id) =>
					cardButton(id, them, { px: small, selectable: false, className: "theirs" }),
				),
			);

			midRack.replaceChildren();
			if (state.side) {
				const label = document.createElement("span");
				label.className = "oni-label";
				label.textContent = "NEXT →";
				midRack.append(label, cardButton(state.side, view, { px: small, selectable: false, className: "side" }));
			}

			myRack.replaceChildren(
				...state.hands[view].map((id) => {
					const btn = cardButton(id, view, {
						px: big,
						selectable: myTurn,
						selected: selectedCard === id,
					});
					btn.addEventListener("click", () => {
						if (stuck) return void sendPass(id);
						selectCard(id);
					});
					return btn;
				}),
			);
		}

		function renderHud() {
			const me = mySide();
			const parts = [];
			if (!state.started) {
				parts.push({ key: "s", text: "Dealing…", className: "g-muted" });
			} else if (state.winner !== null) {
				const who = state.winner === me ? "You win" : `${ctx.nameOf(state.seats[state.winner]) ?? "They"} win`;
				const how = state.by === "stone" ? "the Way of the Stone" : "the Way of the Stream";
				parts.push({ key: "s", text: `${who} — ${how}.` });
			} else if (me === null) {
				parts.push({ key: "s", text: "Spectating", className: "g-muted" });
				parts.push({ key: "t", text: `${state.turn === RED ? "Red" : "Blue"} to move` });
			} else if (state.turn === me) {
				const stuck = legalMoves(state, me).length === 0;
				parts.push({
					key: "s",
					text: stuck ? "No legal move — tap a card to pass it over" : selectedCard ? "Pick a piece" : "Pick a card",
					className: stuck ? "g-warn" : "",
				});
			} else {
				const them = ctx.nameOf(state.seats[1 - me]);
				parts.push({ key: "s", text: `${them} is thinking…`, className: "g-muted" });
			}
			parts.push({
				key: "you",
				text: me === RED ? "You are Red" : me === BLUE ? "You are Blue" : "",
				className: "g-muted",
			});
			shell.setHud(parts.filter((p) => p.text));
		}

		function render() {
			renderRacks();
			renderHud();
			layout();
		}

		// ------------------------------------------------------------- input

		function selectCard(cardId) {
			selectedCard = selectedCard === cardId ? null : cardId;
			selectedPiece = null;
			targets = [];
			render();
		}

		function selectPiece(r, c) {
			const me = mySide();
			const piece = state.board[r][c];
			if (!piece || piece.side !== me || !selectedCard) return false;
			selectedPiece = [r, c];
			targets = legalMoves(state, me)
				.filter((m) => m.card === selectedCard && m.from[0] === r && m.from[1] === c)
				.map((m) => m.to);
			render();
			return true;
		}

		canvas.addEventListener("click", (ev) => {
			const me = mySide();
			if (state.winner !== null || !state.started || me === null || state.turn !== me) return;
			const rect = canvas.getBoundingClientRect();
			const size = rect.width / N;
			const sc = Math.floor((ev.clientX - rect.left) / size);
			const sr = Math.floor((ev.clientY - rect.top) / size);
			if (!onBoard(sr, sc)) return;
			const [r, c] = fromScreen(sr, sc);

			// A tap on a legal destination is a move; anything else re-selects.
			if (selectedPiece && targets.some(([tr, tc]) => tr === r && tc === c)) {
				sendMove({ card: selectedCard, from: selectedPiece, to: [r, c] });
				return;
			}
			if (selectPiece(r, c)) return;
			selectedPiece = null;
			targets = [];
			render();
		});

		// ------------------------------------------------------- host / wire

		const moveAction = room.makeAction("oniMove");
		const stateAction = room.makeAction("oniState");

		const broadcast = () => stateAction.send(publicState());

		const publicState = () => ({
			board: state.board,
			hands: state.hands,
			side: state.side,
			turn: state.turn,
			winner: state.winner,
			by: state.by,
			started: state.started,
			seats: state.seats,
			last: state.last,
		});

		function sendMove(mv) {
			selectedCard = null;
			selectedPiece = null;
			targets = [];
			if (ctx.isHost) hostApply(room.selfId, mv);
			else moveAction.send({ ...mv, pass: false }, { target: room.hostId() });
			render();
		}

		function sendPass(cardId) {
			if (ctx.isHost) hostApply(room.selfId, { card: cardId, pass: true });
			else moveAction.send({ card: cardId, pass: true }, { target: room.hostId() });
		}

		/**
		 * The only place a move is ever accepted. Everything — a tap here, a tap
		 * on the far phone, a bot's search result — arrives through this, so the
		 * validation is written once and there is no path around it.
		 */
		function hostApply(fromId, mv) {
			if (!ctx.isHost || state.winner !== null || !state.started) return;
			const side = state.seats.indexOf(fromId);
			if (side < 0 || side !== state.turn) return;
			if (!state.hands[side].includes(mv.card)) return;

			const available = legalMoves(state, side);
			if (mv.pass) {
				if (available.length) return; // passing is only legal when stuck
				applyPass(state, side, mv.card);
			} else {
				const match = available.find(
					(m) =>
						m.card === mv.card &&
						m.from[0] === mv.from[0] &&
						m.from[1] === mv.from[1] &&
						m.to[0] === mv.to[0] &&
						m.to[1] === mv.to[1],
				);
				if (!match) return;
				const end = applyMove(state, side, match);
				if (end) {
					state.winner = end.winner;
					state.by = end.by;
				}
			}
			broadcast();
			render();
			maybeBot();
		}

		moveAction.onMessage = (mv, { peerId }) => {
			if (ctx.isHost) hostApply(peerId, mv);
		};

		stateAction.onMessage = (next, { peerId }) => {
			if (ctx.isHost || peerId !== room.hostId()) return;
			state = { ...state, ...next };
			selectedCard = null;
			selectedPiece = null;
			targets = [];
			render();
		};

		/**
		 * If the side to move is a bot, play for it. Host-side only, and through
		 * `hostApply` like everybody else — the search is only allowed to produce
		 * a candidate, never to write the board.
		 */
		function maybeBot() {
			clearTimeout(botTimer);
			if (!ctx.isHost || state.winner !== null || !state.started) return;
			const seat = state.seats[state.turn];
			if (!seat || !ctx.isBot(seat)) return;
			// A pause before it answers: an instant reply reads as a glitch, and
			// there is nothing to watch while a 5x5 board does not move.
			botTimer = setTimeout(() => {
				if (disposed || state.winner !== null) return;
				const side = state.turn;
				const mv = chooseMove(state, side, 500);
				if (mv) hostApply(seat, mv);
				else hostApply(seat, { card: state.hands[side][0], pass: true });
			}, 420);
		}

		// ------------------------------------------------------------- start

		function begin() {
			if (!ctx.isHost) return;
			seatPlayers();
			deal();
			broadcast();
			render();
			maybeBot();
		}

		const onResize = () => layout();
		window.addEventListener("resize", onResize);
		window.addEventListener("orientationchange", onResize);

		render();
		begin();

		return {
			onPeerJoin() {
				if (!ctx.isHost) return;
				// A late arrival gets the position, not a fresh deal.
				seatPlayers();
				broadcast();
				render();
			},
			onPeerLeave() {
				if (!ctx.isHost) return;
				seatPlayers();
				broadcast();
				render();
			},
			/**
			 * The live position, for `scripts/test-bots.mjs`. Everything a test
			 * needs is otherwise a closure variable, and driving the game by
			 * reading pixels off a canvas is not a test of the rules.
			 */
			debug: () => ({
				started: state.started,
				turn: state.turn,
				winner: state.winner,
				by: state.by,
				red: state.seats[RED],
				blue: state.seats[BLUE],
				hands: state.hands.map((h) => [...h]),
				side: state.side,
				mySide: mySide(),
				board: state.board.map((row) => row.map((p) => (p ? { ...p } : null))),
				pieces: state.board.flat().filter(Boolean).length,
				masters: state.board.flat().filter((p) => p?.master).length,
				legal: mySide() === null ? 0 : legalMoves(state, state.turn).length,
			}),
			unmount() {
				disposed = true;
				clearTimeout(botTimer);
				window.removeEventListener("resize", onResize);
				window.removeEventListener("orientationchange", onResize);
				moveAction.onMessage = null;
				stateAction.onMessage = null;
				shell.destroy();
			},
		};
	},
});
