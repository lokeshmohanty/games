// Tic Tac Toe — the SDK v2 example in plain JavaScript (docs/sdk-v2.md).
//
// A v2 game talks to the party in messages (sdk/v2/protocol.json), through
// `arcade`, which the platform's runtime puts on window before this file
// runs. Everything a game needs is here, in the order you will need it:
//
//   1. await arcade.init — who is here, the seats, the theme, saved storage
//   2. host-authoritative state: the host owns the board, everyone renders it
//   3. moves travel on a channel to the host (arcade.channel)
//   4. a bot, played by the host, sent as the bot (emitAs)
//   5. arcade.result when the game is decided
//   6. roster / join / takeOver messages
//
// The same game as managed state (the platform runs it; you write only the
// rules) is ../tic-tac-toe-js, and in six more languages beside it.

const X = 1;
const O = 2;
const LINES = [
	[0, 1, 2], [3, 4, 5], [6, 7, 8],
	[0, 3, 6], [1, 4, 7], [2, 5, 8],
	[0, 4, 8], [2, 4, 6],
];
const isBot = (id) => typeof id === "string" && id.startsWith("bot_");
const nameOf = (id) => arcade.party.members.find((m) => m.id === id)?.name ?? "Player";
const seatsOf = (team) => arcade.party.members.filter((m) => m.team === team).map((m) => m.id);

function winnerOf(board) {
	for (const [a, b, c] of LINES) if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
	return board.every(Boolean) ? 0 : null; // 0 = draw, null = still going
}

// ---------------------------------------------------------------- view

const hud = document.getElementById("hud");
const over = document.getElementById("over");
const grid = document.getElementById("ttt");
const cells = Array.from({ length: 9 }, (_, i) => {
	const b = document.createElement("button");
	b.setAttribute("aria-label", `square ${i + 1}`);
	b.onclick = () => play(i);
	grid.append(b);
	return b;
});
over.querySelector("button").onclick = () => restart();

// --------------------------------------------------------------- state

let state = { board: Array(9).fill(0), turn: X, winner: null, x: null, o: null };
const self = () => arcade.party.self;
const markOf = (id) => (id === state.x ? X : id === state.o ? O : 0);
const idOf = (mark) => (mark === X ? state.x : state.o);

function draw() {
	state.board.forEach((m, i) => {
		cells[i].textContent = m === X ? "X" : m === O ? "O" : "";
		cells[i].className = m === O ? "o" : "";
	});
	const me = markOf(self());
	if (state.winner === null) {
		hud.textContent = me ? (state.turn === me ? "YOUR TURN" : `${nameOf(idOf(state.turn))} TO MOVE`) : "SPECTATING";
		over.hidden = true;
	} else {
		over.querySelector("h2").textContent = state.winner === 0 ? "DRAW" : state.winner === me ? "YOU WIN" : `${nameOf(idOf(state.winner))} WINS`;
		over.querySelector("button").hidden = !arcade.isHost();
		over.hidden = false;
	}
}

// ------------------------------------------------------ host authority

// Channels: the host's word on "state", everyone's moves on "move".
const stateCh = arcade.channel("state", (next, from) => {
	if (from !== arcade.party.host) return; // only the host's word counts
	const decided = state.winner === null && next.winner !== null;
	state = next;
	if (decided) report();
	draw();
});
const moveCh = arcade.channel("move", (msg, from) => {
	if (arcade.isHost() && Number.isInteger(msg?.i) && msg.i >= 0 && msg.i < 9) apply(from, msg.i);
});
const publish = (to) => arcade.isHost() && stateCh.send(state, to);

/** Host only: apply a move by `id` at square `i`, if it is legal. */
function apply(id, i) {
	const mark = markOf(id);
	if (state.winner !== null || !mark || mark !== state.turn || state.board[i]) return;
	state.board[i] = mark;
	state.turn = mark === X ? O : X;
	state.winner = winnerOf(state.board);
	if (state.winner !== null) report();
	publish();
	draw();
	botTurn();
}

/** Everyone reports what they saw; the platform counts it once. */
function report() {
	const ids = [state.x, state.o];
	const ranking = state.winner === 0 ? [ids] : [[idOf(state.winner)], [idOf(state.winner === X ? O : X)]];
	arcade.result({ kind: "duel", ranking });
}

function play(i) {
	if (arcade.isHost()) apply(self(), i);
	else moveCh.send({ i }, arcade.party.host);
}

// ----------------------------------------------------------------- bot

let botTimer = null;
function botTurn() {
	clearTimeout(botTimer);
	const bot = idOf(state.turn);
	if (!arcade.isHost() || state.winner !== null || !isBot(bot)) return;
	botTimer = setTimeout(() => {
		const free = state.board.flatMap((m, i) => (m ? [] : [i]));
		// Win if it can, block if it must, else the centre, else anything.
		const wins = (mark) => free.find((i) => winnerOf(state.board.map((m, j) => (j === i ? mark : m))) === mark);
		const mine = state.turn;
		const pick = wins(mine) ?? wins(mine === X ? O : X) ?? (free.includes(4) ? 4 : free[0]);
		// The bot's move arrives like anyone's: through the move channel.
		moveCh.emitAs(bot, { i: pick }, self());
	}, 500);
}

function restart() {
	if (!arcade.isHost()) return;
	state = { board: Array(9).fill(0), turn: X, winner: null, x: seatsOf("A")[0] ?? null, o: seatsOf("B")[0] ?? null };
	publish();
	draw();
	botTurn();
}

// ------------------------------------------------------- the party's news

arcade.on("roster", () => {
	if (arcade.isHost() && state.winner === null && (state.x !== (seatsOf("A")[0] ?? null) || state.o !== (seatsOf("B")[0] ?? null))) restart();
	else draw();
});
// Someone (re)joined: catch them up.
arcade.on("join", (m) => publish(m.who));
// The crown moved to us mid-game; we have the whole state, so carry on.
arcade.answer("takeOver", () => {
	publish();
	botTurn();
	return true;
});
arcade.on("unmount", () => clearTimeout(botTimer));
arcade.debug = () => structuredClone(state); // for tests: read the board

arcade.init.then(() => {
	if (arcade.isHost()) restart();
	else draw();
	arcade.ready();
});
