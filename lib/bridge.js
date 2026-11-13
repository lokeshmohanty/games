// lib/bridge.js — runs a game in a sandboxed frame and speaks for it.
//
// The party shell owns everything a player trusts: the connections, the
// party record, the name, later the sign-in token. A game — ours or anyone's
// — gets none of it directly. It runs in
//
//   <iframe sandbox="allow-scripts" srcdoc="...">
//
// with no `allow-same-origin`, so its origin is opaque: it cannot read this
// page's storage or reach into this page's DOM. It talks to the party only
// through sdk/v1/client.js, over a MessageChannel, and this file answers.
//
// Why srcdoc and not src: a sandboxed frame loaded by URL is not served by
// the service worker, so it would not open offline. The shell fetches the
// game's entry page and every script and stylesheet it names (through the
// worker's cache), and inlines them. Blob URLs made here do not load in an
// opaque frame either, hence inlining, hence the rule that each script is a
// complete bundle (spikes, 2026-11-13, docs/sdk.md).
//
// A framed game registers like any other, so party.js mounts it with the
// same `mount(ctx)` call it always made:
//
//   NeonArcade.registerFramedGame({ id, name, shape, seats, ..., base, entry })
//
// `base` is the game's folder URL, `entry` its page relative to that.

window.NeonArcade = window.NeonArcade || {};

(() => {
	// Inlined into every frame ahead of the game, in this order.
	const RUNTIME = {
		scripts: ["sdk/v1/client.js", "lib/games.js", "lib/ui.js", "lib/secrets.js", "lib/rounds.js"],
		styles: ["lib/styles.css"],
	};
	// The frame may not fetch, connect or load anything from anywhere: what it
	// needs it asks the shell for. Games cannot phone home or pull in a CDN.
	const CSP = [
		"default-src 'none'",
		"script-src 'unsafe-inline'",
		"style-src 'unsafe-inline'",
		"img-src data: blob:",
		"media-src data: blob:",
		"font-src data: blob:",
		"worker-src blob:",
	].join("; ");
	const PREFIX = "g:"; // on the wire, so a game cannot use the party's channels
	const MAX_NAME = 64;
	const MAX_PER_SECOND = 1000; // frame → shell messages
	const MAX_HELD = 500; // messages held for channels the frame has not opened
	const MAX_STORE = 64 * 1024; // bytes of JSON per game

	const text = async (url) => {
		const res = await fetch(url);
		if (!res.ok) throw new Error(`${url.pathname}: ${res.status}`);
		return res.text();
	};
	// Inline script text may not close its own tag.
	const scriptSafe = (code) => code.replace(/<\/(script)/gi, "<\\/$1");

	/**
	 * The frame's whole document, as one string: CSP, runtime, then the game's
	 * page with its scripts and stylesheets pulled in. Anything the page names
	 * outside its own folder is refused rather than inlined.
	 */
	NeonArcade.buildFrameDoc = async ({ base, entry }) => {
		const page = new URL(entry, base);
		const doc = new DOMParser().parseFromString(await text(page), "text/html");
		const inside = (url) => url.origin === page.origin && url.pathname.startsWith(new URL(".", base).pathname);

		for (const s of doc.querySelectorAll("script[src]")) {
			const url = new URL(s.getAttribute("src"), page);
			if (!inside(url)) throw new Error(`script outside the game folder: ${s.getAttribute("src")}`);
			const inline = doc.createElement("script");
			if (s.type) inline.type = s.type;
			inline.textContent = scriptSafe(await text(url));
			s.replaceWith(inline);
		}
		for (const l of doc.querySelectorAll('link[rel="stylesheet"]')) {
			const url = new URL(l.getAttribute("href"), page);
			if (!inside(url)) throw new Error(`stylesheet outside the game folder: ${l.getAttribute("href")}`);
			const style = doc.createElement("style");
			style.textContent = await text(url);
			l.replaceWith(style);
		}

		const head = doc.head;
		const first = head.firstChild;
		const add = (node) => head.insertBefore(node, first);
		const meta = doc.createElement("meta");
		meta.httpEquiv = "Content-Security-Policy";
		meta.content = CSP;
		add(meta);
		const viewport = doc.createElement("meta");
		viewport.name = "viewport";
		viewport.content = "width=device-width, initial-scale=1, viewport-fit=cover";
		add(viewport);
		for (const path of RUNTIME.styles) {
			const style = doc.createElement("style");
			style.textContent = await text(new URL(path, document.baseURI));
			add(style);
		}
		for (const path of RUNTIME.scripts) {
			const script = doc.createElement("script");
			script.textContent = scriptSafe(await text(new URL(path, document.baseURI)));
			add(script);
		}
		return "<!doctype html>" + doc.documentElement.outerHTML;
	};

	const storeKey = (id) => `neon.g.${id}`;
	const readStore = (id) => {
		try {
			return JSON.parse(localStorage.getItem(storeKey(id)) ?? "{}") ?? {};
		} catch {
			return {};
		}
	};

	/**
	 * Mount a framed game into `ctx.root`. Returns the handle party.js keeps:
	 * unmount, onRoster, onPeerJoin, onPeerLeave — the same shape a game's own
	 * `mount` returns.
	 */
	NeonArcade.mountFrame = (ctx, game) => {
		const { room, root } = ctx;
		const frame = document.createElement("iframe");
		frame.className = "game-frame";
		frame.setAttribute("sandbox", "allow-scripts");
		frame.setAttribute("allow", "fullscreen; autoplay");
		frame.title = game.name;
		root.append(frame);

		const channel = new MessageChannel();
		const port = channel.port1;
		const held = new Map(); // channel name -> envelopes
		const open = new Set();
		const store = readStore(game.id);
		let ready = false;
		let closed = false;
		let lastParty = "";
		const replies = new Map(); // request id -> resolve, for shell → frame asks
		let asked = 0;
		let budget = MAX_PER_SECOND;
		const refill = setInterval(() => (budget = MAX_PER_SECOND), 1000);

		const send = (msg, transfer) => !closed && port.postMessage(msg, transfer ?? []);
		const partyState = () => ({ selfId: room.selfId, host: room.hostId(), members: room.getMembers() });
		// `roster` marks a real roster event (party.js onRoster), which the
		// game hears as onRoster(); the poll only refreshes the mirror.
		const pushParty = (roster) => {
			if (!ready) return;
			const now = JSON.stringify(partyState());
			if (!roster && now === lastParty) return;
			lastParty = now;
			send({ t: "party", state: JSON.parse(now), roster: !!roster });
		};
		// Away and reconnecting flags change without a roster event; a game's
		// turn-wait banner polls them, so keep the mirror close behind.
		const poll = setInterval(() => pushParty(false), 250);

		room.onStray = (env) => {
			if (!env.a?.startsWith(PREFIX)) return;
			const name = env.a.slice(PREFIX.length);
			const list = held.get(name) ?? [];
			if (list.length >= MAX_HELD) return;
			list.push(env);
			held.set(name, list);
		};

		const name = (a) => typeof a === "string" && a.length > 0 && a.length <= MAX_NAME;
		const target = (to) => (typeof to === "string" ? { target: to } : undefined);

		port.onmessage = async (e) => {
			const m = e.data;
			if (closed || !m || typeof m.t !== "string") return;
			if (--budget < 0) {
				if (budget === -1) console.warn(`${game.id}: more than ${MAX_PER_SECOND} messages a second; dropping`);
				return;
			}
			switch (m.t) {
				case "reply": {
					const resolve = replies.get(m.id);
					replies.delete(m.id);
					resolve?.(!!m.ok);
					break;
				}
				case "ready":
					ready = true;
					lastParty = JSON.stringify(partyState());
					send({ t: "init", state: { ...JSON.parse(lastParty), canEnd: !!ctx.canEnd, storage: store } });
					break;
				case "listen": {
					if (!name(m.a) || open.has(m.a)) return;
					open.add(m.a);
					const a = m.a;
					room.makeAction(PREFIX + a).onMessage = (d, { peerId }) => send({ t: "msg", a, d, from: peerId });
					for (const env of held.get(a) ?? []) send({ t: "msg", a, d: env.d, from: env.f });
					held.delete(a);
					break;
				}
				case "send":
					if (name(m.a)) room.makeAction(PREFIX + m.a).send(m.d, target(m.to));
					break;
				case "emitAs":
					if (name(m.a) && NeonArcade.isBotId(m.bot)) room.emitAs(m.bot, PREFIX + m.a, m.d, target(m.to));
					break;
				case "meta":
					// net.js drops the reserved keys (id, name, team...) itself.
					if (m.patch && typeof m.patch === "object") room.setMeta(m.patch);
					break;
				case "end":
					ctx.end();
					break;
				case "toast":
					NeonArcade.toast?.(String(m.text).slice(0, 200), m.kind === "warn" ? "warn" : "");
					break;
				case "ask": {
					const opts = { ok: String(m.opts?.ok ?? "OK").slice(0, 30), cancel: String(m.opts?.cancel ?? "CANCEL").slice(0, 30) };
					const ok = await NeonArcade.ask(String(m.text).slice(0, 300), opts);
					send({ t: "answer", id: m.id, ok });
					break;
				}
				case "hostNew":
					if (await NeonArcade.leaveParty?.("Leave the party and host a new game?")) NeonArcade.hostNewGame?.();
					break;
				case "result":
					ctx.reportResult?.(m.r, game);
					break;
				case "store": {
					if (typeof m.key !== "string") return;
					const next = { ...store, [m.key]: m.value };
					const json = JSON.stringify(next);
					if (json.length > MAX_STORE) return console.warn(`${game.id}: storage over ${MAX_STORE} bytes; not saved`);
					store[m.key] = m.value;
					try {
						localStorage.setItem(storeKey(game.id), json);
					} catch {
						// Private mode or full: the game still has it for this session.
					}
					break;
				}
				case "asset":
					try {
						const url = new URL(String(m.path), game.base);
						if (url.origin !== new URL(game.base).origin || !url.pathname.startsWith(new URL(game.base).pathname)) {
							throw new Error("outside the game folder");
						}
						const res = await fetch(url);
						if (!res.ok) throw new Error(`${res.status}`);
						const buf = await res.arrayBuffer();
						send({ t: "asset", id: m.id, buf, type: res.headers.get("content-type") ?? "" }, [buf]);
					} catch (err) {
						send({ t: "asset", id: m.id, error: `${m.path}: ${err.message}` });
					}
					break;
			}
		};

		NeonArcade.buildFrameDoc(game)
			.then((doc) => {
				if (closed) return;
				// Listen only now: the empty frame's own about:blank load must
				// not be the one that gets the port.
				frame.addEventListener(
					"load",
					() => frame.contentWindow?.postMessage({ t: "neon:port" }, "*", [channel.port2]),
					{ once: true },
				);
				frame.srcdoc = doc;
			})
			.catch((err) => {
				console.error(err);
				NeonArcade.toast?.(`${game.name} failed to load: ${err.message}`, "warn");
			});

		return {
			unmount() {
				if (closed) return;
				send({ t: "unmount" });
				closed = true;
				clearInterval(poll);
				clearInterval(refill);
				if (room.onStray) room.onStray = null;
				for (const a of open) room.makeAction(PREFIX + a).onMessage = null;
				port.close();
				frame.remove();
			},
			onRoster: () => pushParty(true),
			/** Async here, unlike an in-page game's: the answer crosses the frame. */
			takeOver() {
				if (!ready || closed) return false;
				pushParty(false);
				return new Promise((resolve) => {
					const id = ++asked;
					replies.set(id, resolve);
					send({ t: "takeOver", id });
					setTimeout(() => replies.delete(id) && resolve(false), 2000);
				});
			},
			onPeerJoin: (id, info) => {
				pushParty(false);
				send({ t: "join", id, info: info ?? {} });
			},
			onPeerLeave: (id, info) => {
				pushParty(false);
				send({ t: "leave", id, info: info ?? {} });
			},
		};
	};

	/** Register a game that lives in its own folder and runs framed. */
	NeonArcade.registerFramedGame = (def) =>
		NeonArcade.registerGame({
			...def,
			framed: true,
			mount: (ctx) => NeonArcade.mountFrame(ctx, def),
		});
})();
