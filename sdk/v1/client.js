// sdk/v1/client.js — the game's side of the platform bridge.
//
// A game runs in a sandboxed frame (`sandbox="allow-scripts"`, no same-origin)
// so it can never read the party's storage, the player's sign-in token or
// another game's data. Everything it needs from the party arrives through
// this file, over a MessageChannel the shell hands it once the frame loads.
//
// The shell inlines this file ahead of `lib/games.js`, `lib/ui.js`,
// `lib/secrets.js` and `lib/rounds.js`, then the game's own scripts. A game is
// written exactly as one in this repo always was:
//
//   NeonArcade.registerGame({ id, name, shape, seats, mount(ctx) { ... } });
//
// and `ctx.room` here is a stand-in for net.js's Room with the part of it a
// game may use: selfId, isHost(), hostId(), getMembers(), getMember(id),
// self(), makeAction(name), emitAs(botId, name, data, opts), setMeta(patch).
// The party record is mirrored in, so the reads are synchronous as before.
//
// On top of the old contract a game gets:
//   ctx.reportResult(r)    the outcome, for stats and leaderboards
//   ctx.storage            get(key) / set(key, value), per game, per device
//   ctx.assets.url(path)   a blob: URL for a file shipped with the game
//
// Protocol (shell → frame): init, party, msg, join, leave, answer, asset,
// http, takeOver, theme, unmount. (frame → shell): ready, listen, send, emitAs, meta, end, toast,
// ask, hostNew, result, store, session, asset, reply, and for a web app http, address. Action names travel prefixed by the
// shell, so a game can never speak on the party's own channels.

window.NeonArcade = window.NeonArcade || {};
// Read by lib/theme.js, inlined next: in a frame the page picks the theme.
NeonArcade.inFrame = true;

(() => {
	let port = null;
	let state = null; // { selfId, host, members, canEnd, storage }
	let handle = null;
	let ctx = null;
	const outbox = [];
	const actions = new Map();
	const waiting = new Map(); // request id -> resolve
	let seq = 0;

	const post = (msg, transfer) => (port ? port.postMessage(msg, transfer ?? []) : outbox.push(msg));
	const request = (msg) =>
		new Promise((resolve) => {
			const id = ++seq;
			waiting.set(id, resolve);
			post({ ...msg, id });
		});

	// For sdk/v1/web-shim.js, which speaks for a web app that knows nothing
	// of the arcade: its requests and its address go through these.
	NeonArcade._post = post;
	NeonArcade._request = request;

	NeonArcade.isBotId = (id) => typeof id === "string" && id.startsWith("bot_");

	const room = {
		get selfId() {
			return state.selfId;
		},
		isHost: () => state.host === state.selfId,
		hostId: () => state.host,
		getMembers: () => state.members.map((m) => ({ ...m })),
		getMember(id) {
			const m = state.members.find((x) => x.id === id);
			return m ? { ...m } : null;
		},
		self() {
			return room.getMember(state.selfId);
		},
		makeAction(name) {
			let action = actions.get(name);
			if (action) return action;
			action = {
				onMessage: null,
				send: (d, opts) => post({ t: "send", a: name, d, to: opts?.target ?? null }),
			};
			actions.set(name, action);
			post({ t: "listen", a: name });
			return action;
		},
		emitAs: (bot, name, d, opts) => post({ t: "emitAs", bot, a: name, d, to: opts?.target ?? null }),
		setMeta: (patch) => post({ t: "meta", patch }),
	};

	// The party screen's own helpers, answered by the shell.
	NeonArcade.toast = (text, kind = "") => post({ t: "toast", text: String(text), kind });
	NeonArcade.ask = (text, opts = {}) => request({ t: "ask", text: String(text), opts }).then((m) => !!m.ok);
	NeonArcade.hostNewGameButton = (label = "HOST A NEW GAME") => {
		const btn = document.createElement("button");
		btn.className = "neon-btn";
		btn.textContent = label;
		btn.onclick = () => post({ t: "hostNew" });
		return btn;
	};

	// This tab's session storage, kept by the party page (the frame has none:
	// it is sandboxed). What lib/secrets.js keeps across a reload lives here.
	// Read from the copy sent in init; writes go back to the shell.
	let session = {};
	NeonArcade.sessionStore = {
		getItem: (k) => (Object.hasOwn(session, k) ? session[k] : null),
		setItem(k, v) {
			session[k] = String(v);
			post({ t: "session", key: String(k), value: String(v) });
		},
		removeItem(k) {
			delete session[k];
			post({ t: "session", key: String(k), value: null });
		},
	};

	function mount() {
		const game = NeonArcade.listGames?.()[0];
		if (!game) throw new Error("no game registered — call NeonArcade.registerGame");
		const root = document.createElement("div");
		root.id = "stage";
		document.body.append(root);
		ctx = NeonArcade.gameContext({
			root,
			room,
			teamOf: (id) => room.getMember(id)?.team ?? null,
			onEnd: state.canEnd ? () => post({ t: "end" }) : null,
		});
		const store = { ...(state.storage ?? {}) };
		ctx.reportResult = (r) => post({ t: "result", r });
		ctx.storage = {
			get: (key) => store[key],
			set(key, value) {
				store[key] = value;
				post({ t: "store", key, value });
			},
		};
		ctx.assets = {
			url: (path) =>
				request({ t: "asset", path }).then((m) => {
					if (m.error) throw new Error(m.error);
					return URL.createObjectURL(new Blob([m.buf], { type: m.type }));
				}),
		};
		handle = game.mount(ctx);
	}

	function onShell(e) {
		const m = e.data;
		switch (m?.t) {
			case "init":
				state = m.state;
				session = { ...(m.state.session ?? {}) };
				// The page's theme as it is now, before the game draws anything.
				if (m.state.theme) NeonArcade.theme?._adopt(m.state.theme);
				mount();
				break;
			case "party":
				// The mirror is kept fresh on a poll (away, reconnecting); only a
				// real roster event is the game's business, as it was in-page.
				state = { ...state, ...m.state };
				if (m.roster) handle?.onRoster?.();
				break;
			case "msg":
				actions.get(m.a)?.onMessage?.(m.d, { peerId: m.from });
				break;
			case "theme":
				// The page's theme changed: retint, and let canvases repaint.
				NeonArcade.theme?._adopt(m);
				break;
			case "join":
				handle?.onPeerJoin?.(m.id, m.info);
				break;
			case "leave":
				handle?.onPeerLeave?.(m.id, m.info);
				break;
			case "answer":
			case "asset":
			case "http": {
				const resolve = waiting.get(m.id);
				waiting.delete(m.id);
				resolve?.(m);
				break;
			}
			case "takeOver": {
				// The crown moved to us mid-game (party.js takeOverGame): the
				// game carries on from what it was sent, or says it cannot.
				let kept = false;
				ctx.isHost = true;
				try {
					kept = !!handle?.takeOver?.();
				} catch (err) {
					console.error("takeOver failed", err);
				}
				if (!kept) ctx.isHost = false;
				post({ t: "reply", id: m.id, ok: kept });
				break;
			}
			case "unmount":
				handle?.unmount?.();
				handle = null;
				break;
		}
	}

	// For the tests, which drive the real game from inside its frame.
	window.__game = {
		get handle() {
			return handle;
		},
		get ctx() {
			return ctx;
		},
	};

	// The shell sends the port once, as the frame's first message. Anything
	// else posted to the window (another frame, an extension) is ignored.
	addEventListener("message", function take(e) {
		if (e.source !== parent || e.data?.t !== "neon:port" || !e.ports[0]) return;
		removeEventListener("message", take);
		port = e.ports[0];
		port.onmessage = onShell;
		for (const msg of outbox.splice(0)) port.postMessage(msg);
		port.postMessage({ t: "ready", sdk: 1 });
	});
})();
