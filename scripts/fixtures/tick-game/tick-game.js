// scripts/fixtures/tick-game — a managed game that ticks, for
// scripts/test-managed.mjs. Each tick adds every seat's latest input to its
// score; the first to 200 wins. A bot's input is always 3; a person's is
// whatever the test makes them send (arcade.input).

let s = null;
arcade.managed({
	init({ seats }) {
		// `local`: the seats it was told a person on the host's phone plays —
		// never, as this game has no "sameDevice" (test-managed checks).
		s = { ticks: 0, dt: 0, score: Object.fromEntries(seats.map((p) => [p.id, 0])), last: {}, local: seats.filter((p) => p.local).map((p) => p.id) };
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
		// details: the end card's rows; the last two are dropped (too many, not a string).
		const details = [{ label: "Ticks", value: s.ticks }, ...Array.from({ length: 7 }, (_, i) => ({ label: `Row ${i + 2}`, value: i + 2 })), { label: "Row 10", value: 10 }, { label: "Bad", value: {} }];
		return { kind: "ffa", ranking: order.map((id) => [id]), scores: s.score, details };
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
