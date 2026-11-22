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
// through sdk/v2/runtime.js (the protocol, docs/sdk-v2.md), over a MessageChannel;
// lib/sdk-host.js answers. This file builds the frame.
//
// Why srcdoc and not src: a sandboxed frame loaded by URL is not served by
// the service worker, so it would not open offline. The shell fetches the
// game's entry page and every script and stylesheet it names (through the
// worker's cache), and inlines them. Blob URLs made here do not load in an
// opaque frame either, hence inlining, hence the rule that each script is a
// complete bundle (spikes, 2026-11-13, docs/platform.md).
//
// Most of that work is the same for every player, so the deploy does it
// once: buildFrameTemplate below runs in headless Chrome at build time
// (scripts/prebuild-frames.mjs) and writes frames/<id>.html, and the shell
// only fetches that file and finishes it (finishFrameDoc: the runtime's
// files, the fonts, the theme). A dev-kit game is still built at tap time.
// On a first cold visit the fonts not yet downloaded follow the frame
// instead of holding it back (finishParts, docs/sdk-v2.md "Fonts after mount").
//
// A framed game registers like any other, so party.js mounts it with the
// same `mount(ctx)` call it always made:
//
//   NeonArcade.registerFramedGame({ id, name, shape, seats, ..., base, entry })
//
// `base` is the game's folder URL, `entry` its page relative to that.

window.NeonArcade = window.NeonArcade || {};

(() => {
	// A web app (manifest `app`) brings its own look: it gets only what it
	// needs to be mounted, then sdk/v2/web-shim.js (which speaks the v2
	// protocol for it), then its own scripts.
	const APP_RUNTIME = { scripts: ["sdk/v2/runtime.js"], styles: [] };
	// A v2 game (manifest `sdk: 2`, lib/sdk-host.js) gets the protocol's own
	// runtime and the arcade's look, and nothing else: the helpers that were
	// in-frame JavaScript (secrets, rounds, turn waits) are shell services now.
	const RUNTIME_V2 = { scripts: ["sdk/v2/runtime.js"], styles: ["lib/theme.css", "lib/styles.css"] };
	const APP_SHIM = "sdk/v2/web-shim.js";
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
	const fontHeld = new Set(); // the fonts whose data: URL this page has
	/** A font's data: URL from its response, kept for the page's life. */
	const keepFont = (url, response) => {
		const got = response
			.then((r) => (r.ok ? r.blob() : Promise.reject(new Error(r.status))))
			.then(
				(blob) =>
					new Promise((done) => {
						const fr = new FileReader();
						fr.onload = () => {
							fontHeld.add(url.href);
							done(fr.result);
						};
						fr.readAsDataURL(blob);
					}),
			)
			.catch(() => null);
		fontCache.set(url.href, got);
		return got;
	};
	async function dataUrl(url) {
		return fontCache.get(url.href) ?? keepFont(url, fetch(url));
	}
	async function inlineUrls(css, pattern, resolve) {
		const found = [...css.matchAll(pattern)];
		// All at once: one font after another was four round trips per mount.
		const data = await Promise.all(found.map(([, ref]) => {
			const url = resolve(ref);
			return url ? dataUrl(url) : null;
		}));
		found.forEach(([whole], i) => {
			if (data[i]) css = css.replace(whole, () => `url("${data[i]}")`);
		});
		return css;
	}
	// The site's root (index.html's folder): where the runtime, the fonts and
	// the prebuilt frames live, wherever the site is served from.
	const siteRoot = () => new URL(".", document.baseURI);
	// The only fonts the shell will ever fetch for a frame: the arcade's own,
	// in assets/fonts/, on this origin, with no query. Never a URL taken from
	// a game's own files (a game could name any address and have the shell
	// fetch it on every mount: review, 2026-11-16).
	const fontUrl = (ref, from) => {
		let url;
		try {
			url = new URL(ref, from);
		} catch {
			return null;
		}
		return url.href.startsWith(new URL("assets/fonts/", siteRoot()).href) && !url.search && !url.hash && /\.woff2$/.test(url.pathname) ? url : null;
	};
	// A font in the runtime's stylesheet once it is in a frame:
	// `url("neon-font:assets/fonts/x.woff2")`, its path from the site's root.
	// Only ever made, and swapped for a data: URL, inside the runtime's own
	// style slots (finishParts) — never over the game's part of the document.
	const FONT = "neon-font:";
	const FONT_URL = /url\("?([^")]+\.woff2)"?\)/g;
	const FONT_MARK = /url\("neon-font:([^"]+\.woff2)"\)/g;
	const markFonts = (css, from) =>
		css.replace(FONT_URL, (whole, ref) => {
			const url = fontUrl(ref, from);
			return url ? `url("${FONT}${url.href.slice(siteRoot().href.length)}")` : whole;
		});
	/** The marks in `css` as data: URLs (the allowlisted fonts only). */
	const inlineFonts = (css) => inlineUrls(css, FONT_MARK, (ref) => fontUrl(ref, siteRoot()));
	// The runtime's files, as slots in a template (buildFrameTemplate).
	const RUNTIME_FILES = new Set([...RUNTIME_V2.scripts, ...RUNTIME_V2.styles, ...APP_RUNTIME.scripts, ...APP_RUNTIME.styles, APP_SHIM]);
	const RUNTIME_SLOT = /<(style|script) data-neon-runtime="([^"]+)"><\/\1>/g;
	// A web app's address, per mount: a placeholder in its template.
	const ADDRESS = '"__neon_app_address__"';
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
	 * What identifies a game's template: the first line of it, so a prebuilt
	 * file (frames/<id>.html) is known to be this game's — not a server's
	 * fallback page, not another folder's game under the same id.
	 */
	const signature = ({ base, entry }) => {
		const page = new URL(entry, base);
		const root = siteRoot();
		const where = page.origin === root.origin && page.href.startsWith(root.href) ? page.href.slice(root.href.length) : page.href;
		return `<!doctype html><!--neon-frame ${encodeURI(where)}-->`;
	};

	/**
	 * A game's frame document, short of what is per-session: CSP, runtime,
	 * then the game's page with its scripts and stylesheets pulled in. Anything
	 * the page names outside its own folder is refused rather than inlined.
	 * Its fonts are marks (FONT), the theme is not set, a web app's address is
	 * a placeholder: finishFrameDoc fills them in. The same for every player,
	 * so scripts/prebuild-frames.mjs runs this at deploy for every listed game
	 * (frames/<id>.html), and the shell only builds one at tap time when
	 * there is none — a dev-kit game, a checkout served from source.
	 */
	NeonArcade.buildFrameTemplate = async ({ id, base, entry, app, runtime: lang }) => {
		const page = new URL(entry, base);
		const runtime = app ? APP_RUNTIME : RUNTIME_V2;
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
						inlineUrls(css, /url\(\s*["']?(?!data:|blob:|#)([^"')]+)["']?\s*\)/g, (ref) => {
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
		// The runtime's own files are the same in every frame: a slot each,
		// filled by finishFrameDoc from the copy this page holds, so seventeen
		// prebuilt frames do not carry seventeen copies of them.
		const slot = (tag, path) => {
			const el = doc.createElement(tag);
			el.dataset.neonRuntime = path;
			add(el);
		};
		for (const path of runtime.styles) slot("style", path);
		doc.documentElement.dataset.runtime = lang ?? "js";
		for (const path of runtime.scripts) slot("script", path);
		if (app) {
			const boot = doc.createElement("script");
			boot.textContent = scriptSafe(`window.arcadeWebApp = ${JSON.stringify({ id }).slice(0, -1)}, "address": ${ADDRESS}};`);
			add(boot);
			slot("script", APP_SHIM);
		}
		return signature({ base, entry }) + doc.documentElement.outerHTML;
	};

	const attr = (v) => String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
	/**
	 * Is this font on the phone already? In this page, or in the service
	 * worker's cache (every visit after the first): then it is a few
	 * milliseconds away and the frame waits for it, so it opens in its own
	 * fonts exactly as before. Not yet (a first, cold visit): the frame opens
	 * without it and gets it when it arrives (finishParts). With no Cache API
	 * (no secure context, so no worker either) the frame waits, as it always did.
	 */
	const fontLocal = async (url) => {
		if (fontHeld.has(url.href) || !self.caches) return true;
		try {
			const hit = await caches.match(url.href);
			if (!hit) return false;
			// A fetch already under way in a page the worker controls is
			// answered from that same cache: wait for it. Otherwise read the
			// cached copy rather than a network fetch still under way (the
			// worker's first install can cache it before this page's own
			// request has finished).
			if (!(fontCache.has(url.href) && navigator.serviceWorker?.controller)) keepFont(url, Promise.resolve(hit));
			return true;
		} catch {
			return true;
		}
	};
	const FACE = /@font-face\s*\{[^{}]*\}/g;

	/**
	 * A template made whole for this mount: the runtime's files, the fonts as
	 * data: URLs, the page's theme on <html>, a web app's address. String work
	 * only — no parsing — so a prebuilt frame mounts as soon as it has arrived.
	 *
	 * `{ doc, fonts }`: `fonts` is null when every face is in `doc`. On a
	 * first cold visit the faces not yet on the phone are left out of `doc`
	 * (the frame opens in the fallback fonts: a 150 KB wait on a slow link,
	 * docs/perf.md 2026-11-16), and `fonts` resolves to their @font-face
	 * rules, data: URLs inlined, which lib/sdk-host.js posts to the frame
	 * (`neon:fonts`, sdk/v2/runtime.js). `all` waits for every face instead.
	 */
	const finishParts = async (template, { address = "/" } = {}, all = false) => {
		const root = siteRoot();
		// The runtime's slots (only its own files: a slot a game wrote itself
		// names something else and stays empty). All fetched at once.
		const slots = [...template.matchAll(RUNTIME_SLOT)].filter(([, , path]) => RUNTIME_FILES.has(path));
		// Fonts are handled in the runtime's stylesheets alone, before they go
		// into the document: the game's part of it is never scanned for them.
		const late = [];
		const filled = await Promise.all(
			slots.map(async ([, tag, path]) => {
				const url = new URL(path, root);
				const code = await text(url);
				if (tag !== "style") return scriptSafe(code);
				let css = markFonts(code, url);
				// The faces still on their way: out of the stylesheet (a mark left
				// in would be a font the CSP refuses), sent once they are here.
				if (!all) {
					const faces = [...css.matchAll(FACE)].map(([face]) => [face, [...face.matchAll(FONT_MARK)].map(([, ref]) => fontUrl(ref, root)).filter(Boolean)]).filter(([, urls]) => urls.length);
					const local = await Promise.all(faces.map(([, urls]) => Promise.all(urls.map(fontLocal))));
					faces.forEach(([face], i) => {
						if (local[i].every(Boolean)) return;
						late.push(face);
						css = css.replace(face, "");
					});
				}
				return inlineFonts(css);
			}),
		);
		let doc = template;
		slots.forEach(([whole, tag], i) => {
			doc = doc.replace(whole, () => `<${tag}>${filled[i]}</${tag}>`);
		});
		const t = themeAttrs();
		// First of its kind wins in HTML, so these outrank the game's own.
		doc = doc.replace(/<html\b/i, (tag) => `${tag} data-theme="${attr(t.theme)}" data-mode="${attr(t.mode)}"`);
		doc = doc.replace(ADDRESS, () => scriptSafe(JSON.stringify(String(address))));
		const fonts = late.length ? Promise.all(late.map(inlineFonts)).then((faces) => faces.filter((f) => !f.includes(`url("${FONT}`)).join("\n")) : null;
		return { doc, fonts };
	};

	/** A template made whole, every face in it (finishParts). */
	NeonArcade.finishFrameDoc = async (template, opts) => (await finishParts(template, opts, true)).doc;

	/** The frame's whole document, built here and now (the tests, the dev kit). */
	NeonArcade.buildFrameDoc = async (game, opts) => NeonArcade.finishFrameDoc(await NeonArcade.buildFrameTemplate(game), opts);

	// Where the deploy put a game's prebuilt template (scripts/prebuild-frames.mjs):
	// frames/<id>.html, for a game served from this site, checked by its
	// signature, so a server's fallback page or a stale name is never used.
	const SAFE_ID = /^[A-Za-z0-9-]+(\/[a-z0-9-]+)?$/;
	NeonArcade.prebuiltFrame = (game) => {
		if (game.dev || !SAFE_ID.test(game.id ?? "")) return null;
		const root = siteRoot();
		if (!new URL(game.base, location.href).href.startsWith(root.href)) return null;
		return new URL(`frames/${game.id}.html`, root);
	};

	// Templates, per game, for this page's life: the prebuilt one when the
	// deploy made it, else built here. A dev-kit game (another origin) is
	// built afresh every time, so an author's edit shows on the next mount.
	const templates = new Map();
	const template = (game) => {
		const local = new URL(game.base, location.href).origin === location.origin;
		const key = `${game.id}|${game.base}|${game.entry}`;
		if (local && templates.has(key)) return templates.get(key);
		const prebuilt = NeonArcade.prebuiltFrame(game);
		const sig = signature(game);
		const got = (prebuilt ? text(prebuilt).then((t) => (t.startsWith(sig) ? t : Promise.reject(new Error("not this game's frame")))) : Promise.reject(new Error("none")))
			.catch(() => NeonArcade.buildFrameTemplate(game));
		if (local) {
			templates.set(key, got);
			got.catch(() => templates.delete(key));
		}
		return got;
	};
	// Finished documents, per game and theme, for this page's life: the next
	// mount of the same game (a rematch, a remount after the crown moved) is
	// a lookup. Web apps are left out — their address changes per mount.
	const docs = new Map();
	const docKey = (game, opts) => {
		if (game.app || new URL(game.base, location.href).origin !== location.origin) return null;
		const t = themeAttrs();
		return `${game.id}|${game.base}|${game.entry}|${t.theme}|${t.mode}|${opts?.address ?? "/"}`;
	};
	// What finishFrameDoc will want, asked for beside the template rather
	// than after it: the runtime's files and the fonts they name.
	const warm = (game) => {
		const root = siteRoot();
		const runtime = game.app ? [...APP_RUNTIME.scripts, ...APP_RUNTIME.styles, APP_SHIM] : [...RUNTIME_V2.scripts, ...RUNTIME_V2.styles];
		for (const path of runtime) {
			const url = new URL(path, root);
			text(url)
				.then((code) => /\.css$/.test(path) && [...code.matchAll(FONT_URL)].forEach(([, ref]) => fontUrl(ref, url) && dataUrl(fontUrl(ref, url))))
				.catch(() => {});
		}
	};
	const frameDoc = (game, opts) => {
		const key = docKey(game, opts);
		if (key && docs.has(key)) return docs.get(key);
		warm(game);
		const built = template(game).then((t) => finishParts(t, opts));
		if (key) {
			docs.set(key, built);
			// A document missing faces is not kept: the next mount has them.
			built.then((r) => r.fonts && docs.get(key) === built && docs.delete(key), () => docs.delete(key));
		}
		return built;
	};
	/**
	 * Start building a game's frame before anyone asks for it — the party
	 * calls this as soon as `?game=` names one, so the files are fetched while
	 * the lobby is still drawing and the mount finds them ready.
	 */
	NeonArcade.prefetchFrame = (game) => {
		if (!game?.base) return;
		if (game.app) {
			warm(game);
			template(game).catch(() => {});
		} else frameDoc(game).catch(() => {});
		NeonArcade.prefetchWasm?.(game);
	};

	const storeKey = (id) => `neon.g.${id}`;
	// The frame's session storage (session.set, lib/sdk-host.js): this tab's,
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

	// What lib/sdk-host.js (the frame's mount) uses from here.
	NeonArcade._frames = { frameDoc, readStore, readSession, storeKey, sessionKey, PREFIX, MAX_NAME, MAX_PER_SECOND, MAX_HELD, MAX_STORE };

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
	 * A web app (manifest `app`, sdk/v2/web-shim.js): a frame like any game's,
	 * plus the two things a web app expects of the world.
	 *
	 * Its server. The host runs it (lib/py-server.js); every phone's requests
	 * go there — the host's directly, a guest's over `p$http` and back on
	 * `p$httpr`. Like any addressed message these may be relayed through
	 * other phones (memory: addressed-is-not-private), which a shared screen
	 * does not mind.
	 *
	 * Its address. The party has one, the host's: a pushState on the host's
	 * phone sends `p$addr`, and every other phone remounts the app there — so
	 * an app that shares a game by link (`?game=<id>`) shares it across the
	 * party unchanged. A guest's own navigation moves only its own screen
	 * (Lokesh, 2026-11-20: "host-only" — no member remounts everyone's frame).
	 * A guest arriving late asks the host for it (`p$addrq`).
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
		let hosting = room.isHost(); // whether we were the host at the last roster (onRoster)
		let answered = false;
		let inner = null;
		let closed = false;
		let seq = 0;
		const waiting = new Map(); // request id -> { resolve, to }, a guest's requests to the host
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
				const to = room.hostId();
				waiting.set(id, { resolve, to });
				http.send({ id, req }, { target: to });
				setTimeout(() => waiting.delete(id) && resolve(plain(504, "the host did not answer")), HTTP_TIMEOUT);
			});
		};
		http.onMessage = async (d, { peerId }) => {
			if (!server || !d || typeof d !== "object") return;
			httpReply.send({ id: d.id, res: await answer(d.req ?? {}) }, { target: peerId });
		};
		// Only the member asked answers: the sender is proven since signed
		// party messages (net.js, 2026-11-18), so a reply from anyone else —
		// another guest guessing the request id — is dropped.
		httpReply.onMessage = (d, { peerId }) => {
			const asked = waiting.get(d?.id);
			if (!asked || asked.to !== peerId) return;
			waiting.delete(d.id);
			asked.resolve(d.res);
		};

		const mount = () => {
			inner?.unmount();
			inner = NeonArcade.mountFrameV2(ctx, game, {
				at: () => address,
				http: ask,
				address(url, reload) {
					address = url;
					if (room.isHost()) addr.send({ url });
					if (reload) mount();
				},
			});
		};
		addr.onMessage = (d, { peerId }) => {
			if (peerId !== room.hostId()) return; // the host's address only (proven sender, net.js)
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
				for (const { resolve } of waiting.values()) resolve(plain(503, "the game ended"));
				waiting.clear();
			},
			onRoster: () => {
				// The crown came to us: the party's address is ours now, so say
				// it — or the party keeps the last host's while late joiners get
				// ours, and an address we browsed to as a guest stays ours alone.
				const now = room.isHost();
				if (now && !hosting) addr.send({ url: address });
				hosting = now;
				inner?.onRoster();
			},
			// The server's state lived on the old host's phone.
			takeOver: () => false,
			onPeerJoin: (id, info) => inner?.onPeerJoin(id, info),
			onPeerLeave: (id, info) => inner?.onPeerLeave(id, info),
		};
	};

	/**
	 * The dev kit: `./?dev=http://127.0.0.1:PORT/path/` loads the game
	 * whose game.json is at that folder — an author's work in progress — into
	 * the real party, as `dev/<id>`. Loopback only, the `?rs=` rule
	 * (room-join.js): a link may not point this page at someone else's code.
	 * The author's server must allow CORS (sdk/dev-server.mjs does).
	 * A promise of the game's definition, null when there is no `?dev=`;
	 * the party waits for it before mounting.
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
					// As the catalog does (scripts/catalog-lib.mjs): PERSON seats at the quick table.
					...(m.sameDevice === true && m.bots !== false && m.state === "managed" ? { sameDevice: true } : {}),
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
					rules: m.rules, // lib/rules.js: from the dev server, like the game's files
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
			mount: (ctx) => (def.app ? NeonArcade.mountApp(ctx, def) : NeonArcade.mountFrameV2(ctx, def)),
		});
})();
