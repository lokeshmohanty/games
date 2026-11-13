// Tic Tac Toe — the smallest complete game for the arcade's SDK (v1).
//
// Copy this folder to start a game. Everything the platform asks of a game is
// here, in the order you will need it:
//
//   1. registerGame once, with a mount(ctx) that builds into ctx.root
//   2. host-authoritative state: the host owns the board, everyone renders it
//   3. moves travel on a channel (ctx.room.makeAction) to the host
//   4. a bot, played by the host, sent as the bot with room.emitAs
//   5. ctx.reportResult when the game is decided
//   6. onRoster / onPeerJoin / takeOver / unmount
//
// The platform inlines lib/games.js, lib/ui.js, lib/secrets.js, lib/rounds.js
// and the SDK client ahead of this file; see docs/sdk.md in lokeshmohanty/games.

NeonArcade.registerGame({
	id: "tic-tac-toe",
	name: "TIC TAC TOE",
	shape: "teams", // Team A plays X, Team B plays O
	seats: { min: 2, max: 2 },

	mount(ctx) {
		const { room } = ctx;
		const X = 1;
		const O = 2;
		const LINES = [
			[0, 1, 2], [3, 4, 5], [6, 7, 8],
			[0, 3, 6], [1, 4, 7], [2, 5, 8],
			[0, 4, 8], [2, 4, 6],
		];

		// --------------------------------------------------------------- view

		const shell = NeonArcade.gameShell(ctx.root, {
			css: `
				#ttt { display: grid; grid-template-columns: repeat(3, min(26vw, 120px)); gap: 8px; }
				#ttt button { aspect-ratio: 1; font-size: min(14vw, 64px); background: var(--panel);
					border: 2px solid var(--border); border-radius: 12px; color: var(--accent); }
				#ttt button.o { color: var(--accent2); }
			`,
		});
		const grid = document.createElement("div");
		grid.id = "ttt";
		const cells = Array.from({ length: 9 }, (_, i) => {
			const b = document.createElement("button");
			b.setAttribute("aria-label", `square ${i + 1}`);
			b.onclick = () => play(i);
			grid.append(b);
			return b;
		});
		shell.stage.append(grid);

		// -------------------------------------------------------------- state

		let state = { board: Array(9).fill(0), turn: X, winner: null, x: null, o: null };
		const markOf = (id) => (id === state.x ? X : id === state.o ? O : 0);
		const idOf = (mark) => (mark === X ? state.x : state.o);

		function winnerOf(board) {
			for (const [a, b, c] of LINES) if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
			return board.every(Boolean) ? 0 : null; // 0 = draw, null = still going
		}

		function draw() {
			state.board.forEach((m, i) => {
				cells[i].textContent = m === X ? "X" : m === O ? "O" : "";
				cells[i].className = m === O ? "o" : "";
			});
			const me = markOf(room.selfId);
			if (state.winner === null) {
				shell.setHud([{ key: "turn", text: me ? (state.turn === me ? "YOUR TURN" : `${ctx.nameOf(idOf(state.turn))} TO MOVE`) : "SPECTATING" }]);
				shell.hideOverlay();
			} else {
				const title = state.winner === 0 ? "DRAW" : state.winner === me ? "YOU WIN" : `${ctx.nameOf(idOf(state.winner))} WINS`;
				shell.showOverlay({
					title,
					buttons: room.isHost() ? [{ label: "PLAY AGAIN", onClick: restart }] : [],
				});
			}
		}

		// ----------------------------------------------------- host authority

		const stateAction = room.makeAction("state");
		const moveAction = room.makeAction("move");
		const send = (target) => room.isHost() && stateAction.send(state, target ? { target } : undefined);

		/** Host only: apply a move by `id` at square `i`, if it is legal. */
		function apply(id, i) {
			const mark = markOf(id);
			if (state.winner !== null || !mark || mark !== state.turn || state.board[i]) return;
			state.board[i] = mark;
			state.turn = mark === X ? O : X;
			state.winner = winnerOf(state.board);
			if (state.winner !== null) report();
			send();
			draw();
			botTurn();
		}

		/** Everyone reports what they saw; the platform deduplicates. */
		function report() {
			const ids = [state.x, state.o];
			const ranking = state.winner === 0 ? [ids] : [[idOf(state.winner)], [idOf(state.winner === X ? O : X)]];
			ctx.reportResult?.({ kind: "duel", ranking });
		}

		function play(i) {
			if (room.isHost()) apply(room.selfId, i);
			else moveAction.send({ i }, { target: room.hostId() });
		}

		moveAction.onMessage = (msg, { peerId }) => {
			if (room.isHost() && Number.isInteger(msg?.i)) apply(peerId, msg.i);
		};
		stateAction.onMessage = (next, { peerId }) => {
			if (peerId !== room.hostId()) return; // only the host's word counts
			const decided = state.winner === null && next.winner !== null;
			state = next;
			if (decided) report();
			draw();
		};

		// ---------------------------------------------------------------- bot

		let botTimer = null;
		function botTurn() {
			clearTimeout(botTimer);
			const bot = idOf(state.turn);
			if (!room.isHost() || state.winner !== null || !ctx.isBot(bot)) return;
			botTimer = setTimeout(() => {
				const free = state.board.flatMap((m, i) => (m ? [] : [i]));
				// Win if it can, block if it must, else the centre, else anything.
				const wins = (mark) => free.find((i) => winnerOf(state.board.map((m, j) => (j === i ? mark : m))) === mark);
				const mine = state.turn;
				const pick = wins(mine) ?? wins(mine === X ? O : X) ?? (free.includes(4) ? 4 : free[0]);
				// The bot's move arrives like anyone's: through the move channel.
				room.emitAs(bot, "move", { i: pick }, { target: room.selfId });
			}, 500);
		}

		function seat() {
			state.x = ctx.seats("A")[0] ?? null;
			state.o = ctx.seats("B")[0] ?? null;
		}
		function restart() {
			state = { board: Array(9).fill(0), turn: X, winner: null, x: null, o: null };
			seat();
			send();
			draw();
			botTurn();
		}

		if (room.isHost()) restart();
		else draw();

		// ------------------------------------------------------------ handle

		return {
			debug: () => structuredClone(state), // for tests: read the board
			onRoster() {
				if (room.isHost() && state.winner === null) restart();
			},
			// Someone (re)joined: catch them up.
			onPeerJoin: (id) => send(id),
			// The crown moved to us mid-game; we have the whole state, so carry on.
			takeOver() {
				send();
				botTurn();
				return true;
			},
			unmount() {
				clearTimeout(botTimer);
				shell.destroy();
			},
		};
	},
});
