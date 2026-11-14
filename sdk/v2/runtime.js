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
			const fn = answers.get(m.t);
			if (!fn && handlers.get("*")?.size) return emit(m);
			let ok = false;
			try {
				ok = fn ? !!(await fn(m)) : false;
			} catch (err) {
				console.error(`arcade: answering "${m.t}" threw`, err);
			}
			post({ t: "reply", re: m.id, ok });
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
	};
	window.arcade = arcade;

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
