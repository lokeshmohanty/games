// games/connect4.js — Connect 4 as a mountable module.
//
// The host is the referee, not necessarily a player: it owns the board and
// validates moves, while the two seats come from the party's team assignment
// (Team A plays red, Team B plays yellow). On a standalone game page the seat
// rule degrades to the old one — whoever hosts is red, the first other player
// is yellow — because that is what `seatOf` returns there.

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
			if (state.winner === null) return;
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
		}
		resize();
		draw();
		updateHud();

		return {
			onPeerJoin: rosterChanged,
			onPeerLeave: rosterChanged,
			/** Team assignments changed in the party screen mid-game. */
			onRoster: () => rosterChanged(null),
			unmount() {
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
