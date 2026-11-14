// Tic Tac Toe (Go) — the drawing. The rules are Go (main.go), compiled to
// tic-tac-toe.wasm and started by arcade-go.js; this file only draws the view
// the platform sends every phone, and sends taps as moves. It is the
// reference's own draw code (../tic-tac-toe-js/tic-tac-toe.js).

// -- the view, on every phone ------------------------------------------------

const hud = document.getElementById("hud");
const grid = document.getElementById("ttt");
const cells = Array.from({ length: 9 }, (_, i) => {
	const b = document.createElement("button");
	b.setAttribute("aria-label", `square ${i + 1}`);
	b.onclick = () => arcade.act({ i });
	grid.append(b);
	return b;
});
const nameOf = (id) => arcade.party.members.find((m) => m.id === id)?.name ?? "Player";

arcade.on("view", ({ state: v }) => {
	v.board.forEach((m, i) => {
		cells[i].textContent = m === 1 ? "X" : m === 2 ? "O" : "";
		cells[i].className = m === 2 ? "o" : "";
	});
	const mover = v.turn === 1 ? v.x : v.o;
	hud.textContent = v.winner !== null ? "" : !v.you ? "SPECTATING" : v.turn === v.you ? "YOUR TURN" : `${nameOf(mover)} TO MOVE`;
});
arcade.on("rejected", (m) => arcade.toast(m.reason, "warn"));
arcade.debug = () => arcade.view; // for tests: { board, turn, winner, x, o, you }
