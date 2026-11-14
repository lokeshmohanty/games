// scripts/fixtures/tick-game — a managed game that ticks, for
// scripts/test-managed.mjs. Each tick adds every seat's latest input to its
// score; the first to 200 wins. A bot's input is always 3; a person's is
// whatever the test makes them send (arcade.input).

let s = null;
arcade.managed({
	init({ seats }) {
		s = { ticks: 0, dt: 0, score: Object.fromEntries(seats.map((p) => [p.id, 0])), last: {} };
	},
	tick({ inputs, dt }) {
		s.ticks += 1;
		s.dt = dt;
		for (const [id, n] of Object.entries(inputs)) if (id in s.score && Number.isFinite(n)) s.score[id] += n;
		s.last = inputs;
	},
	apply: () => "this game takes inputs, not moves",
	view: ({ seat }) => ({ ...s, you: seat }),
	turn: () => [],
	bot: () => 3,
	result() {
		const ids = Object.keys(s.score).filter((id) => s.score[id] >= 200);
		if (!ids.length) return null;
		const order = Object.keys(s.score).sort((a, b) => s.score[b] - s.score[a]);
		return { kind: "ffa", ranking: order.map((id) => [id]), scores: s.score };
	},
	snapshot: () => s,
	restore({ snapshot }) {
		s = snapshot;
	},
});
const views = [];
arcade.on("view", ({ state }) => {
	views.push(state.ticks);
	document.getElementById("out").textContent = JSON.stringify(state, null, 1);
});
window.views = views;
arcade.debug = () => arcade.view;
