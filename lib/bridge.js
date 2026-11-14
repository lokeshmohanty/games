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
		scripts: ["sdk/v1/client.js", "lib/theme.js", "lib/games.js", "lib/ui.js", "lib/secrets.js", "lib/rounds.js"],
		styles: ["lib/theme.css", "lib/styles.css"],
	};
	// A web app (manifest `app`) brings its own look: it gets only what it
	// needs to be mounted, then sdk/v1/web-shim.js, then its own scripts.
	const APP_RUNTIME = { scripts: ["sdk/v1/client.js", "lib/games.js"], styles: [] };
	// A v2 game (manifest `sdk: 2`, lib/sdk-host.js) gets the protocol's own
	// runtime and the arcade's look, and nothing else: the helpers that were
	// in-frame JavaScript (secrets, rounds, turn waits) are shell services now.
	const RUNTIME_V2 = { scripts: ["sdk/v2/runtime.js"], styles: ["lib/theme.css", "lib/styles.css"] };
	const APP_SHIM = "sdk/v1/web-shim.js";
	// The frame may not fetch, connect or load anything from anywhere: what it
	// needs it asks the shell for. Games cannot phone home or pull in a CDN.
	const CSP = [
		"default-src 'none'",
		// 'wasm-unsafe-eval': WebAssembly may compile (sdk v2, `runtime: "wasm"`);
		// it still cannot fetch anything, so the module comes in `init`.
		"script-src 'unsafe-inline' 'wasm-unsafe-eval'",
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

	// The fonts, as data: URLs — a frame may load nothing (CSP), so theme.css's
	// url(...)s are inlined. Fetched once per page (through the worker's cache).
	const fontCache = new Map();
	async function dataUrl(url) {
		if (!fontCache.has(url.href)) {
			fontCache.set(
				url.href,
				fetch(url)
					.then((r) => (r.ok ? r.blob() : Promise.reject(new Error(r.status))))
					.then(
						(blob) =>
							new Promise((done) => {
								const fr = new FileReader();
								fr.onload = () => done(fr.result);
								fr.readAsDataURL(blob);
							}),
					)
					.catch(() => null),
			);
		}
		return fontCache.get(url.href);
	}
	async function inlineUrls(css, from, pattern = /url\("?([^")]+\.woff2)"?\)/g, resolve = (ref) => new URL(ref, from)) {
		const found = [...css.matchAll(pattern)];
		// All at once: one font after another was four round trips per mount.
		const data = await Promise.all(found.map(([, ref]) => {
			const url = resolve(ref);
			return url ? dataUrl(url) : null;
		}));
		found.forEach(([whole], i) => {
			if (data[i]) css = css.replace(whole, `url("${data[i]}")`);
		});
		return css;
	}
	/** What the frame's <html> carries: the page's theme (lib/theme.js). */
	const themeAttrs = () => ({ theme: document.documentElement.dataset.theme ?? "paper", mode: document.documentElement.dataset.mode ?? "light" });

	// Every file a frame is built from, fetched once per page: the runtime and
	// a game's files do not change under a running page, and a remount (the
	// next game, a rematch, a crown that moved) used to fetch them all again,
	// one after another. A dev-kit game (another origin) is always fetched
	// fresh, so an author's edit shows on the next mount. A failure is not
	// kept, so a retry can succeed.
	const texts = new Map();
	const text = (url) => {
		const key = url.href;
		if (url.origin === location.origin && texts.has(key)) return texts.get(key);
		const got = fetch(url).then((res) => {
			if (!res.ok) throw new Error(`${url.pathname}: ${res.status}`);
			return res.text();
		});
		if (url.origin === location.origin) {
			texts.set(key, got);
			got.catch(() => texts.delete(key));
		}
		return got;
	};
	// Inline script text may not close its own tag.
	const scriptSafe = (code) => code.replace(/<\/(script)/gi, "<\\/$1");

	/**
	 * The frame's whole document, as one string: CSP, runtime, then the game's
	 * page with its scripts and stylesheets pulled in. Anything the page names
	 * outside its own folder is refused rather than inlined.
	 */
	NeonArcade.buildFrameDoc = async ({ id, base, entry, app, sdk, runtime: lang }, { address = "/" } = {}) => {
		const page = new URL(entry, base);
		const runtime = app ? APP_RUNTIME : sdk === 2 ? RUNTIME_V2 : RUNTIME;
		// Everything that does not depend on the game's page starts now, in
		// parallel with it: the runtime's scripts and its styles (fonts and all).
		const runtimeStyles = Promise.all(runtime.styles.map((path) => {
			const url = new URL(path, document.baseURI);
			return text(url).then((css) => inlineUrls(css, url));
		}));
		const runtimeScripts = Promise.all(runtime.scripts.map((path) => text(new URL(path, document.baseURI))));
		const shimText = app ? text(new URL(APP_SHIM, document.baseURI)) : null;
		const doc = new DOMParser().parseFromString(await text(page), "text/html");
		const inside = (url) => url.origin === page.origin && url.pathname.startsWith(new URL(".", base).pathname);
		// A web app was built to be served from a site's root, so its "/x"
		// means its own folder's x (Vite writes /assets/index-....js).
		const web = app ? new URL(app.web, base) : null;
		const resolve = (ref, from = page) => (web && /^\/(?!\/)/.test(ref) ? new URL("." + ref, web) : new URL(ref, from));

		if (app) {
			for (const l of doc.querySelectorAll('link[rel~="icon"], link[rel~="modulepreload"], link[rel~="manifest"], link[rel~="preload"]')) l.remove();
		}
		// The game's own files: checked first, then fetched all at once and
		// put back in document order.
		const scripts = [...doc.querySelectorAll("script[src]")].map((s) => {
			const url = resolve(s.getAttribute("src"));
			if (!inside(url)) throw new Error(`script outside the game folder: ${s.getAttribute("src")}`);
			return { s, got: text(url) };
		});
		const sheets = [...doc.querySelectorAll(app ? 'link[rel~="stylesheet"]' : 'link[rel="stylesheet"]')].map((l) => {
			const url = resolve(l.getAttribute("href"));
			if (!inside(url)) throw new Error(`stylesheet outside the game folder: ${l.getAttribute("href")}`);
			const got = app
				? text(url).then((css) =>
						inlineUrls(css, url, /url\(\s*["']?(?!data:|blob:|#)([^"')]+)["']?\s*\)/g, (ref) => {
							const u = resolve(ref, url);
							return inside(u) ? u : null;
						}),
					)
				: text(url);
			return { l, got };
		});
		const [scriptTexts, sheetTexts] = await Promise.all([Promise.all(scripts.map((x) => x.got)), Promise.all(sheets.map((x) => x.got))]);
		scripts.forEach(({ s }, i) => {
			const inline = doc.createElement("script");
			if (s.type) inline.type = s.type;
			inline.textContent = scriptSafe(scriptTexts[i]);
			s.replaceWith(inline);
		});
		sheets.forEach(({ l }, i) => {
			const style = doc.createElement("style");
			style.textContent = sheetTexts[i];
			l.replaceWith(style);
		});

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
		for (const css of await runtimeStyles) {
			const style = doc.createElement("style");
			style.textContent = css;
			add(style);
		}
		const t = themeAttrs();
		doc.documentElement.dataset.theme = t.theme;
		doc.documentElement.dataset.mode = t.mode;
		if (sdk === 2) doc.documentElement.dataset.runtime = lang ?? "js";
		for (const code of await runtimeScripts) {
			const script = doc.createElement("script");
			script.textContent = scriptSafe(code);
			add(script);
		}
		if (app) {
			const boot = doc.createElement("script");
			boot.textContent = scriptSafe(`NeonArcade.webApp = ${JSON.stringify({ id, address })};`);
			add(boot);
			const shim = doc.createElement("script");
			shim.textContent = scriptSafe(await shimText);
			add(shim);
		}
		return "<!doctype html>" + doc.documentElement.outerHTML;
	};

	// Built documents, per game and theme, for this page's life: the next
	// mount of the same game (a rematch, a remount after the crown moved) is
	// a lookup. Web apps are left out — their address changes per mount.
	const docs = new Map();
	const docKey = (game, opts) => {
		if (game.app || new URL(game.base, location.href).origin !== location.origin) return null;
		const t = themeAttrs();
		return `${game.id}|${game.base}|${game.entry}|${t.theme}|${t.mode}|${opts?.address ?? "/"}`;
	};
	const frameDoc = (game, opts) => {
		const key = docKey(game, opts);
		if (key && docs.has(key)) return docs.get(key);
		const built = NeonArcade.buildFrameDoc(game, opts);
		if (key) {
			docs.set(key, built);
			built.catch(() => docs.delete(key));
		}
		return built;
	};
	/**
	 * Start building a game's frame before anyone asks for it — party.html
	 * calls this as soon as `?game=` names one, so the files are fetched while
	 * the lobby is still drawing and the mount finds them ready.
	 */
	NeonArcade.prefetchFrame = (game) => {
		if (!game?.base || game.app) return;
		frameDoc(game).catch(() => {});
		NeonArcade.prefetchWasm?.(game);
	};

	const storeKey = (id) => `neon.g.${id}`;
	// The frame's session storage (sdk/v1/client.js sessionStore): this tab's,
	// per game, so it survives exactly a reload as sessionStorage does.
	const sessionKey = (id) => `neon.gs.${id}`;
	const readSession = (id) => {
		try {
			return JSON.parse(sessionStorage.getItem(sessionKey(id)) ?? "{}") ?? {};
		} catch {
			return {};
		}
	};
	const readStore = (id) => {
		try {
			return JSON.parse(localStorage.getItem(storeKey(id)) ?? "{}") ?? {};
		} catch {
			return {};
		}
	};

	// What lib/sdk-host.js (v2) shares with the v1 mount below.
	NeonArcade._frames = { frameDoc, readStore, readSession, storeKey, sessionKey, PREFIX, MAX_NAME, MAX_PER_SECOND, MAX_HELD, MAX_STORE };

	/**
	 * Mount a framed game into `ctx.root`. Returns the handle party.js keeps:
	 * unmount, onRoster, onPeerJoin, onPeerLeave — the same shape a game's own
	 * `mount` returns.
	 */
	NeonArcade.mountFrame = (ctx, game, web = null) => {
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
		const session = readSession(game.id);
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
		// The theme changed on the page (picker, or the system went dark).
		const offTheme = NeonArcade.theme?.onChange(() => ready && send({ t: "theme", ...themeAttrs() }));

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
					send({ t: "init", state: { ...JSON.parse(lastParty), canEnd: !!ctx.canEnd, storage: store, session, theme: themeAttrs() } });
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
				case "session": {
					if (typeof m.key !== "string" || m.key.length > 200) return;
					if (m.value == null) delete session[m.key];
					else session[m.key] = String(m.value).slice(0, 32_768);
					try {
						sessionStorage.setItem(sessionKey(game.id), JSON.stringify(session));
					} catch {}
					break;
				}
				case "http":
					if (!web) return;
					send({ t: "http", id: m.id, ...(await web.http(m)) });
					break;
				case "address":
					if (web && typeof m.url === "string" && m.url.startsWith("/") && m.url.length <= 2048) web.address(m.url, !!m.reload);
					break;
				case "asset":
					try {
						const folder = game.app ? new URL(game.app.web, game.base) : new URL(game.base);
						const url = new URL(String(m.path), folder);
						if (url.origin !== folder.origin || !url.pathname.startsWith(folder.pathname)) {
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

		frameDoc(game, { address: web?.at() })
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
				offTheme?.();
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

	const MAX_BODY = 1 << 20; // bytes of a request or response, base64 on the wire
	const HTTP_TIMEOUT = 25_000;
	const toBase64 = (buf) => {
		let s = "";
		const b = new Uint8Array(buf);
		for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
		return btoa(s);
	};
	const plain = (status, message) => ({ status, headers: [["content-type", "text/plain"]], body: btoa(message) });

	/**
	 * A web app (manifest `app`, sdk/v1/web-shim.js): a frame like any game's,
	 * plus the two things a web app expects of the world.
	 *
	 * Its server. The host runs it (lib/py-server.js); every phone's requests
	 * go there — the host's directly, a guest's over `p$http` and back on
	 * `p$httpr`. Like any addressed message these may be relayed through
	 * other phones (memory: addressed-is-not-private), which a shared screen
	 * does not mind.
	 *
	 * Its address. The party has one: a pushState on any phone sends
	 * `p$addr`, and every other phone remounts the app there — so an app that
	 * shares a game by link (`?game=<id>`) shares it across the party
	 * unchanged. A guest arriving late asks the host for it (`p$addrq`).
	 */
	/**
	 * startPyServer (lib/py-server.js), loaded on first use: only a web app
	 * with a server needs it. Same shape — ready, request, stop.
	 */
	const pyServer = (game) => {
		const started = (NeonArcade.startPyServer ? Promise.resolve() : NeonArcade.load("py-server")).then(() => NeonArcade.startPyServer(game));
		// The handle's own contract: a request always resolves, a failure as 503.
		const fail = (message) => ({ status: 503, headers: [["content-type", "text/plain"]], body: new TextEncoder().encode(message).buffer });
		return {
			ready: started.then((s) => s.ready),
			request: (req) => started.then((s) => s.request(req), (err) => fail(`the game's server did not load: ${err.message}`)),
			stop: () => void started.then((s) => s.stop()).catch(() => {}),
		};
	};

	NeonArcade.mountApp = (ctx, game) => {
		const { room } = ctx;
		const serverWanted = !!game.app.server;
		const server = serverWanted && room.isHost() ? pyServer(game) : null;
		if (server) {
			NeonArcade.toast?.(`Starting ${game.name}'s server…`);
			server.ready.catch((err) => NeonArcade.toast?.(`${game.name}'s server did not start: ${err.message}`, "warn"));
		}
		let address = "/";
		let answered = false;
		let inner = null;
		let closed = false;
		let seq = 0;
		const waiting = new Map(); // request id -> resolve, a guest's requests to the host
		const http = room.makeAction("p$http");
		const httpReply = room.makeAction("p$httpr");
		const addr = room.makeAction("p$addr");
		const addrAsk = room.makeAction("p$addrq");

		const answer = async (req) => {
			if (!serverWanted) return plain(404, "this game has no server");
			if (typeof req.body === "string" && req.body.length > (MAX_BODY * 4) / 3 + 4) return plain(413, "request too large");
			const out = await server.request({
				method: String(req.method || "GET").toUpperCase(),
				path: String(req.path || "/"),
				query: String(req.query || ""),
				headers: Array.isArray(req.headers) ? req.headers.filter((h) => Array.isArray(h) && h.length === 2).map(([k, v]) => [String(k), String(v)]) : [],
				body: typeof req.body === "string" ? req.body : "",
			});
			if (out.body.byteLength > MAX_BODY) return plain(502, "response too large");
			if (!answered) {
				answered = true;
				console.info(`[arcade] server answered ${out.status}`); // validate-game waits for this
			}
			return { status: out.status, headers: out.headers, body: toBase64(out.body) };
		};
		const ask = (req) => {
			if (server) return answer(req);
			if (room.isHost()) return Promise.resolve(plain(503, "the game's server left with the old host"));
			return new Promise((resolve) => {
				const id = ++seq;
				waiting.set(id, resolve);
				http.send({ id, req }, { target: room.hostId() });
				setTimeout(() => waiting.delete(id) && resolve(plain(504, "the host did not answer")), HTTP_TIMEOUT);
			});
		};
		http.onMessage = async (d, { peerId }) => {
			if (!server || !d || typeof d !== "object") return;
			httpReply.send({ id: d.id, res: await answer(d.req ?? {}) }, { target: peerId });
		};
		httpReply.onMessage = (d) => {
			const resolve = waiting.get(d?.id);
			waiting.delete(d?.id);
			resolve?.(d.res);
		};

		const mount = () => {
			inner?.unmount();
			inner = NeonArcade.mountFrame(ctx, game, {
				at: () => address,
				http: ask,
				address(url, reload) {
					address = url;
					addr.send({ url });
					if (reload) mount();
				},
			});
		};
		addr.onMessage = (d) => {
			if (typeof d?.url !== "string" || !d.url.startsWith("/") || d.url === address) return;
			address = d.url;
			mount();
		};
		addrAsk.onMessage = (_d, { peerId }) => room.isHost() && addr.send({ url: address }, { target: peerId });
		mount();
		if (!room.isHost()) addrAsk.send({}, { target: room.hostId() });

		return {
			unmount() {
				if (closed) return;
				closed = true;
				inner?.unmount();
				server?.stop();
				for (const a of [http, httpReply, addr, addrAsk]) a.onMessage = null;
				for (const resolve of waiting.values()) resolve(plain(503, "the game ended"));
				waiting.clear();
			},
			onRoster: () => inner?.onRoster(),
			// The server's state lived on the old host's phone.
			takeOver: () => false,
			onPeerJoin: (id, info) => inner?.onPeerJoin(id, info),
			onPeerLeave: (id, info) => inner?.onPeerLeave(id, info),
		};
	};

	/**
	 * The dev kit: `party.html?dev=http://127.0.0.1:PORT/path/` loads the game
	 * whose game.json is at that folder — an author's work in progress — into
	 * the real party, as `dev/<id>`. Loopback only, the `?rs=` rule
	 * (room-join.js): a link may not point this page at someone else's code.
	 * The author's server must allow CORS (sdk/v1/dev-server.mjs does).
	 * A promise of the game's definition, null when there is no `?dev=`;
	 * party.html waits for it before mounting the party.
	 */
	NeonArcade.devGame = (() => {
		const dev = new URLSearchParams(location.search).get("dev");
		if (!dev) return null;
		if (!NeonArcade.onLoopback?.(dev)) {
			NeonArcade.devError = `?dev= must be a server on this machine (localhost / 127.0.0.1), not ${dev}`;
			return Promise.resolve(null);
		}
		const base = new URL(dev.endsWith("/") ? dev : dev + "/").href;
		return fetch(new URL("game.json", base), { cache: "no-store" })
			.then((res) => {
				if (!res.ok) throw new Error(`game.json: HTTP ${res.status}`);
				return res.json();
			})
			.then((m) => {
				if (!m?.id || !m?.name || !m?.entry || !m?.seats) throw new Error("game.json needs id, name, entry and seats");
				const def = {
					id: `dev/${m.id}`,
					name: m.name,
					blurb: m.blurb ?? "",
					shape: m.shape ?? "free",
					seats: m.seats,
					bots: m.bots !== false,
					local: m.kind === "local",
					kind: m.kind,
					entry: m.entry,
					app: m.app,
					sdk: m.sdk,
					runtime: m.runtime,
					wasm: m.wasm,
					state: m.state,
					tick: m.tick,
					viewRate: m.viewRate,
					opts: m.opts,
					base,
					dev: true,
				};
				NeonArcade.registerFramedGame(def);
				return def;
			})
			.catch((err) => {
				NeonArcade.devError = `Could not load the dev game from ${base}: ${err.message}`;
				return null;
			});
	})();

	/** Register a game that lives in its own folder and runs framed. */
	NeonArcade.registerFramedGame = (def) =>
		NeonArcade.registerGame({
			...def,
			framed: true,
			mount: (ctx) => (def.app ? NeonArcade.mountApp(ctx, def) : def.sdk === 2 ? NeonArcade.mountFrameV2(ctx, def) : NeonArcade.mountFrame(ctx, def)),
		});
})();
