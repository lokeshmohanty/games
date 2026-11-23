// scripts/fixtures/turns-game — who starts each match, for
// scripts/test-managed.mjs (docs/sdk-v2.md "Who starts"). The view says which
// match this is, its seats and the `first` init was given; `{ end: true }`
// from anyone ends the match, won by whoever started it. Nobody is on turn,
// so a bot never moves.

let s = null;
arcade.managed({
	init({ seats, match, first }) {
		s = { match, first: first ?? null, seats: seats.map((p) => p.id), over: false };
	},
	apply({ action }) {
		if (!action?.end) return "no such move";
		if (s.over) return "the game is over";
		s.over = true;
	},
	view: () => s,
	turn: () => [],
	bot: () => null,
	result: () => (s.over ? { kind: "ffa", ranking: [[s.first ?? s.seats[0]], s.seats.filter((id) => id !== (s.first ?? s.seats[0]))] } : null),
	snapshot: () => s,
	restore({ snapshot }) {
		s = snapshot;
	},
});
arcade.on("view", ({ state }) => {
	document.getElementById("out").textContent = JSON.stringify(state, null, 1);
});
arcade.debug = () => arcade.view;
