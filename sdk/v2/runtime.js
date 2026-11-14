// sdk/v2/runtime.js — the frame's end of the SDK v2 protocol.
//
// A v2 game runs in the same sandboxed frame as a v1 game (lib/bridge.js: no
// same-origin, no network), but what it may say to the party is a list of
// messages, sdk/v2/protocol.json, not a JavaScript object. Anything that can
// post a message can be a game: this file is the JavaScript end, and the
// adapters for Rust, C, Go and Python sit on top of it. docs/sdk-v2.md
// explains each message.
//
// The shell inlines this file ahead of the game's own scripts and then posts
// `{ t: "neon:port" }` to the window with a MessagePort. From then on:
//
//   arcade.on("msg", (m) => …)            every message of a type → off()
//   arcade.on("*", (m) => …)              every message (a dispatch-style game)
//   arcade.send("send", { ch, d, to })    fire and forget
//   await arcade.request("ask", { text }) a request; its reply, or throws err
//   arcade.answer("takeOver", (m) => ok)  answer the shell's own requests
//   arcade.wasm                           a WASM game's module bytes (also init.wasm)
//   await arcade.init                     the `init` message
//   arcade.party                          { self, host, members }, kept current
//
// and a few one-liners over the same wire, for the commonest needs:
//
//   arcade.channel(ch, (d, from) => …)    listen + filter `msg` → { send(d, to?) }
//   arcade.isHost()  arcade.ready()  arcade.result(r)  arcade.toast(text)
//
// Layer 2, managed state: `arcade.managed(rules)`, `arcade.act(a)`,
// `arcade.input(i)`, `arcade.on("view", …)`, and data-arcade-* bindings for a
// game written as markup (lib/sdk-managed.js runs the rest).
//
// Messages the game posts before the port arrives wait in an outbox. A
// handler added after `init` arrived still gets `init` (on("init") replays it).
// The theme is applied to <html> here, so a DOM game's CSS variables follow
// the page; canvases and other languages read `init.theme` / `theme.set`.

(() => {
	const V = 2;
	let port = null;
	let seq = 0;
	let initMsg = null;
	const outbox = [];
	const handlers = new Map(); // t -> Set(fn)
	const answers = new Map(); // t -> fn, for the shell's requests
	const waiting = new Map(); // id -> { ok, fail }
	let resolveInit;

	const post = (msg, transfer) => {
		const m = { v: V, ...msg };
		if (port) port.postMessage(m, transfer ?? []);
		else outbox.push([m, transfer]);
	};

	const applyTheme = (theme) => {
		if (!theme) return;
		document.documentElement.dataset.theme = theme.name;
		document.documentElement.dataset.mode = theme.mode;
	};

	const emit = (m) => {
		for (const fn of [...(handlers.get(m.t) ?? []), ...(handlers.get("*") ?? [])]) {
			try {
				fn(m);
			} catch (err) {
				console.error(`arcade: a "${m.t}" handler threw`, err);
			}
		}
	};

	async function onShell(e) {
		const m = e.data;
		if (!m || m.v !== V || typeof m.t !== "string") return;
		switch (m.t) {
			case "reply": {
				const w = waiting.get(m.re);
				waiting.delete(m.re);
				if (w) m.ok ? w.ok(m) : w.fail(new Error(m.err ?? "refused"));
				return;
			}
			case "init":
				initMsg = m;
				arcade.party = m.party;
				arcade.wasm = m.wasm ?? null;
				applyTheme(m.theme);
				resolveInit(m);
				break;
			case "roster":
				arcade.party = m.party;
				break;
			case "theme.set":
				applyTheme(m.theme);
				break;
		}
		if (typeof m.id === "number" && m.t !== "reply") {
			// The shell's request (takeOver): answered by the game, or refused.
			// A game that hears everything ("*") and has no answer registered
			// sends its own `reply` (re: m.id); the shell times out without one.
			// An answer is a boolean (ok), or an object of reply fields.
			const fn = answers.get(m.t);
			if (!fn && handlers.get("*")?.size) return emit(m);
			let out = false;
			try {
				out = fn ? await fn(m) : false;
			} catch (err) {
				console.error(`arcade: answering "${m.t}" threw`, err);
			}
			post(out && typeof out === "object" ? { ok: true, ...out, t: "reply", re: m.id } : { t: "reply", re: m.id, ok: !!out });
		}
		emit(m);
	}

	const arcade = {
		version: V,
		party: null,
		wasm: null,
		init: new Promise((r) => (resolveInit = r)),
		on(t, fn) {
			if (!handlers.has(t)) handlers.set(t, new Set());
			handlers.get(t).add(fn);
			if (t === "init" && initMsg) queueMicrotask(() => fn(initMsg));
			return () => handlers.get(t)?.delete(fn);
		},
		send(t, fields = {}, transfer) {
			post({ ...fields, t }, transfer);
		},
		request(t, fields = {}, transfer) {
			return new Promise((ok, fail) => {
				const id = ++seq;
				waiting.set(id, { ok, fail });
				post({ ...fields, t, id }, transfer);
			});
		},
		answer(t, fn) {
			answers.set(t, fn);
		},

		// -- one-liners over the wire ------------------------------------------
		isHost: () => !!arcade.party && arcade.party.host === arcade.party.self,
		ready: () => post({ t: "ready" }),
		result: (r) => post({ t: "result", r }),
		toast: (text, kind = "") => post({ t: "toast", text: String(text).slice(0, 200), kind }),
		channel(ch, onMessage) {
			post({ t: "listen", ch });
			const off = arcade.on("msg", (m) => m.ch === ch && onMessage?.(m.d, m.from));
			return {
				send: (d, to) => post(to ? { t: "send", ch, d, to } : { t: "send", ch, d }),
				emitAs: (bot, d, to) => post(to ? { t: "emitAs", bot, ch, d, to } : { t: "emitAs", bot, ch, d }),
				off,
			};
		},
		/** For tests: a game may set `arcade.debug = () => ({ … })`. */
		debug: null,

		// -- Layer 2: managed state (lib/sdk-managed.js) -----------------------
		/**
		 * Hand the platform your rules: { init, apply, view, turn, bot, result,
		 * snapshot, restore, tick?, skip? } (docs/sdk-v2.md "Managed state").
		 * The platform calls them on the host and sends each phone its view;
		 * render it in `arcade.on("view", (m) => draw(m.state))`. Says `ready`.
		 */
		managed(rules) {
			arcade.answer("rules", async (m) => {
				const out = [];
				for (const c of Array.isArray(m.calls) ? m.calls : []) {
					const fn = rules[c?.fn];
					try {
						if (typeof fn !== "function") out.push(c?.fn === "skip" ? { v: false } : { err: `no rule "${c?.fn}"` });
						else out.push({ v: (await fn.call(rules, c)) ?? null });
					} catch (err) {
						out.push({ err: String(err?.message ?? err) });
					}
				}
				return { out };
			});
			arcade.init.then(() => post({ t: "ready" }));
		},
		/** This player's move: applied on the host by `apply({ action, by })`. */
		act: (a) => post({ t: "act", a }),
		/** A ticking game: this player's latest input (latest wins). */
		input: (i) => post({ t: "input", i }),
		/** The last view this phone was sent (null before the first). */
		view: null,
	};
	window.arcade = arcade;

	// The HTML/CSS lane: a managed game's markup binds to its view without
	// code. `data-arcade-act='{"i":4}'` on a button sends that action;
	// `data-arcade-text="board.3"` shows that path of the view;
	// `data-arcade-show="mine"` shows the element while that path is truthy;
	// `data-arcade-class="cls:path"` toggles a class.
	const at = (v, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), v);
	const bind = (v) => {
		for (const el of document.querySelectorAll("[data-arcade-text]")) {
			const x = at(v, el.dataset.arcadeText);
			el.textContent = x == null ? "" : String(x);
		}
		for (const el of document.querySelectorAll("[data-arcade-show]")) el.hidden = !at(v, el.dataset.arcadeShow);
		for (const el of document.querySelectorAll("[data-arcade-class]")) {
			for (const pair of el.dataset.arcadeClass.split(/\s+/)) {
				const [cls, path] = pair.split(":");
				if (cls && path) el.classList.toggle(cls, !!at(v, path));
			}
		}
	};
	arcade.on("view", (m) => {
		arcade.view = m.state;
		bind(m.state);
	});
	addEventListener("click", (e) => {
		const el = e.target.closest?.("[data-arcade-act]");
		if (!el || el.disabled) return;
		try {
			arcade.act(JSON.parse(el.dataset.arcadeAct));
		} catch (err) {
			console.error("arcade: data-arcade-act is not JSON", err);
		}
	});

	// The tests reach a running game through `window.__game.handle.debug()`
	// (scripts/serve.mjs gameFrame), the same as a v1 game. It appears once
	// the game has its `init`.
	arcade.init.then(() => {
		window.__game = { handle: { debug: () => arcade.debug?.() ?? null } };
	});

	// The shell sends the port once, as the frame's first message. Anything
	// else posted to the window (another frame, an extension) is ignored.
	addEventListener("message", function take(e) {
		if (e.source !== parent || e.data?.t !== "neon:port" || !e.ports[0]) return;
		removeEventListener("message", take);
		port = e.ports[0];
		port.onmessage = onShell;
		port.postMessage({ v: V, t: "hello", sdk: V, runtime: document.documentElement.dataset.runtime || "js", features: [] });
		for (const [m, transfer] of outbox.splice(0)) port.postMessage(m, transfer ?? []);
	});
})();
