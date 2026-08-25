// games/connect4.js — Connect 4 as a mountable module.
//
// The host is the referee, not necessarily a player: it owns the board and
// validates moves, while the two seats come from the party's team assignment
// (Team A plays red, Team B plays yellow). On a standalone game page the seat
// rule degrades to the old one — whoever hosts is red, the first other player
// is yellow — because that is what `seatOf` returns there.
//
// Either seat can be a bot. Because the host already validates every move, a
// bot needs no channel of its own: the host searches the position and applies
// the result through the same `applyMove` a person's tap goes through, and the
// broadcast that follows is indistinguishable from any other.

NeonArcade.registerGame({
	id: "connect4",
	name: "CONNECT 4",
	blurb: "Drop discs, get four in a row. One against one.",
	shape: "teams",
	seats: { min: 2, max: 2 },

	mount(ctx) {
		const { room, root } = ctx;

		const COLS = 7;
		const ROWS = 6;
		const RED = 1;
		const YELLOW = 2;

		// ---------------------------------------------------------- markup

		const style = document.createElement("style");
		style.textContent = `
			#game { position: absolute; inset: 0; display: flex; flex-direction: column;
				align-items: center; justify-content: center; gap: 12px; padding: 12px; }
			#hud { font-size: clamp(0.9rem, 3vw, 1.2rem); color: var(--accent);
				text-shadow: 0 0 8px var(--accent-glow); text-align: center; min-height: 1.5em; }
			#hud .you-red { color: #ff4d4d; text-shadow: 0 0 8px rgba(255, 77, 77, 0.5); }
			#hud .you-yellow { color: #ffd24d; text-shadow: 0 0 8px rgba(255, 210, 77, 0.5); }
			#hud .you-spec { color: var(--muted); }
			#board { border: 3px solid #2a2a4e; border-radius: 12px;
				box-shadow: 0 0 30px rgba(0, 100, 255, 0.2); max-width: 95vw; max-height: 70vh; }
			#overlay p { color: var(--muted); margin: 0; }
		`;
		const gameEl = document.createElement("div");
		gameEl.id = "game";
		const hudEl = document.createElement("div");
		hudEl.id = "hud";
		const canvas = document.createElement("canvas");
		canvas.id = "board";
		gameEl.append(hudEl, canvas);
		const overlayEl = document.createElement("div");
		overlayEl.id = "overlay";
		overlayEl.className = "overlay";
		overlayEl.hidden = true;
		root.append(style, gameEl, overlayEl);
		const c2d = canvas.getContext("2d");

		// ----------------------------------------------------------- state

		const emptyBoard = () => Array.from({ length: ROWS }, () => Array(COLS).fill(0));

		let state = {
			board: emptyBoard(),
			turn: RED,
			winner: null,
			started: false,
			red: null,
			yellow: null,
		};
		let hoverCol = -1;

		const myColor = () =>
			room.selfId === state.red ? RED : room.selfId === state.yellow ? YELLOW : 0;

		/** Seat the two teams. Host-side only; everyone else reads it off state. */
		function seatPlayers() {
			state.red = ctx.seats("A")[0] ?? null;
			state.yellow = ctx.seats("B")[0] ?? null;
		}

		// ---------------------------------------------------------- drawing

		function resize() {
			const maxW = Math.min(window.innerWidth - 24, 560);
			const maxH = window.innerHeight - 140;
			const cell = Math.max(20, Math.floor(Math.min(maxW / COLS, maxH / ROWS)));
			canvas.width = cell * COLS;
			canvas.height = cell * ROWS;
			draw();
		}

		function draw() {
			const cell = canvas.width / COLS;
			c2d.fillStyle = "#1a1a2e";
			c2d.fillRect(0, 0, canvas.width, canvas.height);
			if (hoverCol >= 0 && hoverCol < COLS && state.winner === null && canPlay()) {
				c2d.fillStyle = "rgba(0, 255, 255, 0.08)";
				c2d.fillRect(hoverCol * cell, 0, cell, canvas.height);
			}
			for (let r = 0; r < ROWS; r++) {
				for (let c = 0; c < COLS; c++) {
					const x = c * cell + cell / 2;
					const y = r * cell + cell / 2;
					const val = state.board[r][c];
					c2d.beginPath();
					c2d.arc(x, y, cell * 0.4, 0, Math.PI * 2);
					if (val === 0) {
						c2d.fillStyle = "#0a0a0a";
						c2d.fill();
					} else {
						const color = val === RED ? "#ff4d4d" : "#ffd24d";
						c2d.shadowBlur = 15;
						c2d.shadowColor = color;
						c2d.fillStyle = color;
						c2d.fill();
						c2d.shadowBlur = 0;
					}
				}
			}
		}

		// ------------------------------------------------------------ rules

		function canPlay() {
			return (
				state.started &&
				state.winner === null &&
				myColor() !== 0 &&
				state.red !== null &&
				state.yellow !== null
			);
		}

		function dropRow(col) {
			for (let r = ROWS - 1; r >= 0; r--) if (state.board[r][col] === 0) return r;
			return -1;
		}

		function checkWin(board, row, col, player) {
			const dirs = [
				[0, 1],
				[1, 0],
				[1, 1],
				[1, -1],
			];
			for (const [dr, dc] of dirs) {
				let count = 1;
				for (let d = 1; d < 4; d++) {
					const r = row + dr * d,
						c = col + dc * d;
					if (r < 0 || r >= ROWS || c < 0 || c >= COLS || board[r][c] !== player) break;
					count++;
				}
				for (let d = 1; d < 4; d++) {
					const r = row - dr * d,
						c = col - dc * d;
					if (r < 0 || r >= ROWS || c < 0 || c >= COLS || board[r][c] !== player) break;
					count++;
				}
				if (count >= 4) return true;
			}
			return false;
		}

		const isDraw = (board) => board[0].every((v) => v !== 0);

		function applyMove(col, player) {
			const row = dropRow(col);
			if (row < 0) return false;
			state.board[row][col] = player;
			if (checkWin(state.board, row, col, player)) state.winner = player;
			else if (isDraw(state.board)) state.winner = 0;
			else state.turn = player === RED ? YELLOW : RED;
			return true;
		}

		// ------------------------------------------------------------- bot
		//
		// Plain minimax with alpha-beta over a 7x6 board — small enough that a
		// full-width search to this depth finishes well inside a frame, so there
		// is no need for iterative deepening or a clock.

		// Plies searched. Five sees a double threat being built two moves out,
		// which is where Connect 4 is actually won, while stopping short of the
		// deadening perfection of a solved game.
		const BOT_DEPTH = 5;
		// A move that lands the instant you release your finger reads as a bug.
		const BOT_THINK_MS = 550;

		// Every 4-in-a-row line on the board, computed once. The evaluation walks
		// these rather than rediscovering the geometry at each of the thousands of
		// leaves a search visits.
		const WINDOWS = (() => {
			const out = [];
			for (let r = 0; r < ROWS; r++) {
				for (let c = 0; c < COLS; c++) {
					if (c + 3 < COLS) out.push([[r, c], [r, c + 1], [r, c + 2], [r, c + 3]]);
					if (r + 3 < ROWS) out.push([[r, c], [r + 1, c], [r + 2, c], [r + 3, c]]);
					if (r + 3 < ROWS && c + 3 < COLS)
						out.push([[r, c], [r + 1, c + 1], [r + 2, c + 2], [r + 3, c + 3]]);
					if (r + 3 < ROWS && c - 3 >= 0)
						out.push([[r, c], [r + 1, c - 1], [r + 2, c - 2], [r + 3, c - 3]]);
				}
			}
			return out;
		})();

		// Centre-out. Alpha-beta prunes far more when the likely-best move is
		// tried first, and in Connect 4 that is almost always the middle.
		const BOT_ORDER = [3, 2, 4, 1, 5, 0, 6];

		const boardCopy = (b) => b.map((row) => [...row]);

		function dropRowIn(board, col) {
			for (let r = ROWS - 1; r >= 0; r--) if (board[r][col] === 0) return r;
			return -1;
		}

		/** Static evaluation of a quiet position, from `me`'s point of view. */
		function evaluate(board, me) {
			const foe = me === RED ? YELLOW : RED;
			let score = 0;
			// The centre column takes part in more lines than any other, so
			// occupying it is worth something on its own.
			for (let r = 0; r < ROWS; r++) if (board[r][3] === me) score += 6;
			for (const w of WINDOWS) {
				let mine = 0;
				let theirs = 0;
				for (const [r, c] of w) {
					const v = board[r][c];
					if (v === me) mine++;
					else if (v === foe) theirs++;
				}
				// A line both colours sit in can never be completed by either.
				if (mine && theirs) continue;
				if (mine === 3) score += 50;
				else if (mine === 2) score += 8;
				else if (theirs === 3) score -= 60;
				else if (theirs === 2) score -= 8;
			}
			return score;
		}

		/**
		 * Minimax with alpha-beta. Scores are always from `me`'s point of view,
		 * so the caller never has to negate anything.
		 *
		 * `board` is mutated and restored in place: a 42-cell copy per node would
		 * dominate the cost of the search itself.
		 */
		function search(board, depth, alpha, beta, turn, me) {
			const cols = BOT_ORDER.filter((c) => board[0][c] === 0);
			if (!cols.length) return 0; // full board: a draw
			const maximising = turn === me;
			let best = maximising ? -Infinity : Infinity;

			for (const c of cols) {
				const r = dropRowIn(board, c);
				board[r][c] = turn;
				let value;
				if (checkWin(board, r, c, turn)) {
					// Depth is added so a win that arrives sooner outranks the same
					// win three moves later — and so a loss is postponed as long as
					// possible rather than walked into early.
					value = maximising ? 10000 + depth : -10000 - depth;
				} else if (depth === 0) {
					value = evaluate(board, me);
				} else {
					value = search(board, depth - 1, alpha, beta, turn === RED ? YELLOW : RED, me);
				}
				board[r][c] = 0;

				if (maximising) {
					if (value > best) best = value;
					if (best > alpha) alpha = best;
				} else {
					if (value < best) best = value;
					if (best < beta) beta = best;
				}
				if (alpha >= beta) break;
			}
			return best;
		}

		/** The column this bot plays. Never returns a full column. */
		function chooseColumn(me) {
			const board = boardCopy(state.board);
			const cols = BOT_ORDER.filter((c) => board[0][c] === 0);
			let bestCol = cols[0];
			let bestValue = -Infinity;
			for (const c of cols) {
				const r = dropRowIn(board, c);
				board[r][c] = me;
				const value = checkWin(board, r, c, me)
					? Infinity
					: search(board, BOT_DEPTH - 1, -Infinity, Infinity, me === RED ? YELLOW : RED, me);
				board[r][c] = 0;
				if (value > bestValue) {
					bestValue = value;
					bestCol = c;
				}
			}
			return bestCol;
		}

		let botTimer = null;

		/**
		 * Host only. If the side to move is a bot, let it think and then move.
		 *
		 * Called after every state change rather than on a loop, so two bots
		 * facing each other simply take turns and the sequence ends by itself
		 * when somebody wins.
		 */
		function runBot() {
			if (!room.isHost()) return;
			clearTimeout(botTimer);
			botTimer = null;
			const toMove = () => (state.turn === RED ? state.red : state.yellow);
			const ready = () =>
				state.started &&
				state.winner === null &&
				state.red !== null &&
				state.yellow !== null &&
				ctx.isBot(toMove());
			if (!ready()) return;

			botTimer = setTimeout(() => {
				botTimer = null;
				// The roster can change while it thinks — a person can take the seat,
				// or the game can end — so the conditions are checked again here.
				if (!ready()) return;
				if (applyMove(chooseColumn(state.turn), state.turn)) {
					broadcastState();
					afterMove();
				}
			}, BOT_THINK_MS);
		}

		// --------------------------------------------------------------- ui

		function updateHud() {
			hudEl.replaceChildren();
			const mine = myColor();
			const colorSpan = document.createElement("span");
			colorSpan.className =
				mine === RED ? "you-red" : mine === YELLOW ? "you-yellow" : "you-spec";
			colorSpan.textContent =
				mine === RED ? "RED" : mine === YELLOW ? "YELLOW" : "SPECTATOR";

			if (!state.started) return hudEl.append(colorSpan);
			if (state.winner !== null) {
				const msg =
					state.winner === 0 ? " — DRAW" : state.winner === mine ? " — YOU WIN!" : " — YOU LOSE";
				return hudEl.append(colorSpan, document.createTextNode(msg));
			}
			if (state.red === null || state.yellow === null) {
				return hudEl.append(colorSpan, document.createTextNode(" — Waiting for opponent…"));
			}
			const turnMsg = state.turn === mine ? " — YOUR TURN" : " — Opponent's turn";
			hudEl.append(colorSpan, document.createTextNode(turnMsg));
		}

		function showOverlay(msg, btnText, btnCb) {
			overlayEl.replaceChildren();
			const h1 = document.createElement("h1");
			h1.textContent = msg;
			overlayEl.append(h1);
			if (btnText) {
				const btn = document.createElement("button");
				btn.className = "neon-btn";
				btn.textContent = btnText;
				btn.onclick = btnCb;
				overlayEl.append(btn);
			}
			overlayEl.hidden = false;
		}

		const hideOverlay = () => (overlayEl.hidden = true);

		function afterMove() {
			draw();
			updateHud();
			if (state.winner === null) return runBot();
			const mine = myColor();
			const msg =
				state.winner === 0 ? "DRAW" : state.winner === mine ? "YOU WIN!" : "YOU LOSE";
			if (room.isHost()) {
				showOverlay(msg, "REMATCH", rematch);
			} else {
				showOverlay(msg, null, null);
				const p = document.createElement("p");
				p.textContent = "Waiting for host to rematch…";
				overlayEl.append(p, NeonArcade.hostNewGameButton());
			}
		}

		function rematch() {
			state = {
				board: emptyBoard(),
				turn: RED,
				winner: null,
				started: true,
				red: state.red,
				yellow: state.yellow,
			};
			hideOverlay();
			draw();
			updateHud();
			broadcastState();
			runBot();
		}

		const stateAction = room.makeAction("c4state");
		const moveAction = room.makeAction("c4move");

		function broadcastState(target) {
			if (room.isHost()) stateAction.send(state, target ? { target } : undefined);
		}

		// ------------------------------------------------------------ input

		function handleClick(clientX) {
			if (!canPlay() || state.turn !== myColor()) return;
			const rect = canvas.getBoundingClientRect();
			const col = Math.floor((clientX - rect.left) / (rect.width / COLS));
			if (col < 0 || col >= COLS) return;
			if (room.isHost()) {
				if (applyMove(col, myColor())) {
					broadcastState();
					afterMove();
				}
			} else {
				moveAction.send({ col }, { target: room.hostId() });
			}
		}

		const onClick = (e) => handleClick(e.clientX);
		const onMove = (e) => {
			const rect = canvas.getBoundingClientRect();
			const col = Math.floor((e.clientX - rect.left) / (rect.width / COLS));
			if (col !== hoverCol) {
				hoverCol = col;
				draw();
			}
		};
		const onLeave = () => {
			hoverCol = -1;
			draw();
		};
		const onTouch = (e) => {
			handleClick(e.touches[0].clientX);
			e.preventDefault();
		};

		canvas.addEventListener("click", onClick);
		canvas.addEventListener("mousemove", onMove);
		canvas.addEventListener("mouseleave", onLeave);
		canvas.addEventListener("touchstart", onTouch, { passive: false });
		window.addEventListener("resize", resize);

		// ------------------------------------------------------- networking

		stateAction.onMessage = (data) => {
			state = data;
			draw();
			updateHud();
			if (state.winner !== null) afterMove();
			else hideOverlay();
		};

		moveAction.onMessage = (data, { peerId }) => {
			if (!room.isHost()) return;
			const expected = state.turn === RED ? state.red : state.yellow;
			if (peerId !== expected) return;
			if (applyMove(data.col, state.turn)) {
				broadcastState();
				afterMove();
			}
		};

		/** Re-seat and re-publish whenever the roster changes under us. */
		function rosterChanged(peerId) {
			if (!room.isHost()) return;
			const hadBoth = state.red !== null && state.yellow !== null;
			seatPlayers();
			if (hadBoth && (state.red === null || state.yellow === null) && state.started) {
				// A seated player left mid-game; the one still sitting takes it.
				if (state.winner === null) state.winner = state.red === null ? YELLOW : RED;
			}
			// Both seats are filled now — clear the "waiting" screen. Without
			// this the host keeps staring at it after an opponent arrives, which
			// is the normal case the moment ADD BOT exists.
			if (state.red !== null && state.yellow !== null && state.winner === null) {
				hideOverlay();
			}
			broadcastState();
			if (peerId) broadcastState(peerId);
			afterMove();
			updateHud();
		}

		if (room.isHost()) {
			seatPlayers();
			state.started = true;
			broadcastState();
			if (state.red === null || state.yellow === null) {
				showOverlay("Waiting for opponent to join…", null, null);
			}
			runBot();
		}
		resize();
		draw();
		updateHud();

		return {
			onPeerJoin: rosterChanged,
			onPeerLeave: rosterChanged,
			/** A copy of the authoritative board, for scripts/test-bots.mjs. */
			debug: () => ({ ...state, board: state.board.map((r) => [...r]) }),
			/** Team assignments changed in the party screen mid-game. */
			onRoster: () => rosterChanged(null),
			unmount() {
				clearTimeout(botTimer);
				botTimer = null;
				canvas.removeEventListener("click", onClick);
				canvas.removeEventListener("mousemove", onMove);
				canvas.removeEventListener("mouseleave", onLeave);
				canvas.removeEventListener("touchstart", onTouch);
				window.removeEventListener("resize", resize);
				stateAction.onMessage = null;
				moveAction.onMessage = null;
				root.replaceChildren();
			},
		};
	},
});
