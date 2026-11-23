// scripts/fixtures/double-turn — a managed turn-based game for
// scripts/test-managed.mjs in which a seat keeps the turn after its own
// move: every turn is two `step`s (as Ludo's extra roll on a 6, or any
// multi-step turn), and the first seat to GOAL steps wins. A bot steps.
//
// `stall`, on a person's turn, hands the turn to the next seat for good and
// makes every bot answer null from then on: a game that keeps naming a bot
// with no move, which the platform must not ask in a loop.

const GOAL = 4;
let s = null;
const winner = () => s.order.find((id) => s.score[id] >= GOAL) ?? null;
arcade.managed({
	init({ seats }) {
		s = { order: seats.map((p) => p.id), at: 0, left: 2, score: Object.fromEntries(seats.map((p) => [p.id, 0])), stalled: false, moves: [], asked: {} };
	},
	apply({ action, by }) {
		if (winner()) return "the game is over";
		if (by !== s.order[s.at]) return "not your turn";
		if (action?.t === "stall") {
			s.stalled = true;
			s.at = (s.at + 1) % s.order.length;
			s.left = 2;
			return;
		}
		if (action?.t !== "step") return "unknown move";
		s.score[by] += 1;
		s.moves.push({ by, at: Date.now() }); // the host's clock: the bots' pauses
		s.left -= 1;
		if (!s.left) {
			s.at = (s.at + 1) % s.order.length;
			s.left = 2;
		}
	},
	view: ({ seat }) => ({ score: s.score, at: s.order[s.at], left: s.left, moves: s.moves.length, you: seat }),
	turn: () => (winner() ? [] : [s.order[s.at]]),
	bot({ seat }) {
		s.asked[seat] = (s.asked[seat] ?? 0) + 1;
		return s.stalled ? null : { t: "step" };
	},
	result() {
		const w = winner();
		if (!w) return null;
		return { kind: "ffa", ranking: [[w], ...s.order.filter((id) => id !== w).map((id) => [id])], scores: s.score };
	},
	snapshot: () => s,
	restore({ snapshot }) {
		s = snapshot;
	},
});
arcade.on("view", ({ state }) => {
	document.getElementById("out").textContent = JSON.stringify(state, null, 1);
});
// The live rules, on the host: the test reads the moves' times and the bots' asks.
window.rules = () => s;
