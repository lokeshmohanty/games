// glue.js — between the party and the game in src/lib.rs, which is one
// function: dispatch(JSON in) -> JSON out. This file knows no rules: it
// hands dispatch every message from the shell and every tap, posts what
// dispatch says to post, draws what it says to draw, and keeps its timer.
//
//   in:  a protocol message (sdk/v2/protocol.json), or {t:"click",i},
//        {t:"again"}, {t:"wake"}, {t:"debug"}
//   out: { out: [messages], view: {cells, hud, over}, wake?: ms|null, answer? }

(async () => {
	const hud = document.getElementById("hud");
	const over = document.getElementById("over");
	const grid = document.getElementById("ttt");
	const again = over.querySelector("button");
	let timer = null;

	const call = (ev) => JSON.parse(wasm_bindgen.dispatch(JSON.stringify(ev)));
	function run(ev) {
		const r = call(ev);
		for (const m of r.out) arcade.send(m.t, m);
		if (r.view) draw(r.view);
		if ("wake" in r) {
			clearTimeout(timer);
			if (r.wake != null) timer = setTimeout(() => run({ t: "wake" }), r.wake);
		}
		return r;
	}

	const cells = Array.from({ length: 9 }, (_, i) => {
		const b = document.createElement("button");
		b.setAttribute("aria-label", `square ${i + 1}`);
		b.onclick = () => run({ t: "click", i });
		grid.append(b);
		return b;
	});
	again.onclick = () => run({ t: "again" });

	function draw(view) {
		view.cells.forEach((c, i) => {
			cells[i].textContent = c;
			cells[i].className = c === "O" ? "o" : "";
		});
		hud.textContent = view.hud;
		over.hidden = !view.over;
		if (view.over) {
			over.querySelector("h2").textContent = view.over.title;
			again.hidden = !view.over.again;
		}
	}

	// The module's bytes come in `init` (game.json "wasm"): the frame can fetch nothing.
	const { wasm, ...init } = await arcade.init;
	wasm_bindgen.initSync({ module: wasm });
	for (const t of ["roster", "msg", "join", "leave", "theme.set", "unmount"]) arcade.on(t, run);
	arcade.answer("takeOver", (m) => run(m).answer === true);
	arcade.debug = () => call({ t: "debug" }).debug; // for tests: read the board
	run(init);
	arcade.ready();
})();
