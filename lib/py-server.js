// lib/py-server.js — a web app's Python server, on the host's phone.
//
// A web app (docs/sdk.md, "Web apps") may come with the server it was
// written against — FastAPI, Flask. There is no server here, so the host
// runs it: Pyodide (CPython in WebAssembly, vendored under sdk/v1/pyodide/ by
// scripts/vendor-pyodide.mjs) in a frame of its own,
//
//   <iframe sandbox="allow-scripts" srcdoc="...">   hidden, host only
//
// opaque-origin like a game's frame, with a CSP that allows WebAssembly and
// nothing else: the author's Python cannot reach the network, the party's
// storage or the page. It asks this file for every file it reads (the
// runtime, its packages, the app's code), which come from this origin and
// therefore through the service worker's cache — so it starts offline once
// it has started online.
//
// lib/bridge.js routes every phone's requests here: the host's own frame
// directly, the guests' over the party (`p$http`).
//
//   const server = NeonArcade.startPyServer(game);
//   const { status, headers, body } = await server.request({ method, path, query, headers, body });
//   server.stop();

window.NeonArcade = window.NeonArcade || {};

(() => {
	const RUNTIME = "sdk/v1/pyodide/";
	const GLUE = "sdk/v1/arcade_server.py";
	const ORIGIN = "https://py.invalid/";
	const CSP = ["default-src 'none'", "script-src 'unsafe-inline' 'wasm-unsafe-eval'"].join("; ");
	const TIMEOUT = 20_000;

	const here = (path) => new URL(path, document.baseURI);
	const text = async (url) => {
		const res = await fetch(url);
		if (!res.ok) throw new Error(`${url.pathname}: ${res.status}`);
		return res.text();
	};
	const bytes = async (url) => {
		const res = await fetch(url);
		if (!res.ok) throw new Error(`${url.pathname}: ${res.status}`);
		return res.arrayBuffer();
	};
	const scriptSafe = (code) => code.replace(/<\/(script)/gi, "<\\/$1");

	// Runs in the server frame. Pyodide's loader fetches its parts by URL;
	// here every fetch is a question to the shell.
	const BOOT = `
(() => {
	let port = null;
	let seq = 0;
	const waiting = new Map();
	const get = (name) => new Promise((resolve) => {
		const id = ++seq;
		waiting.set(id, resolve);
		port.postMessage({ t: "get", id, name });
	});
	window.fetch = async (input) => {
		const url = String(input instanceof Request ? input.url : input);
		if (!url.startsWith("${ORIGIN}")) return new Response("", { status: 403 });
		const name = url.slice(${ORIGIN.length});
		const m = await get(name);
		if (!m.buf) return new Response("", { status: 404 });
		return new Response(m.buf, { status: 200, headers: { "content-type": name.endsWith(".wasm") ? "application/wasm" : "application/octet-stream" } });
	};
	const norm = (n) => n.replace(/[-_.]+/g, "-").toLowerCase();
	let call = null;
	async function boot(m) {
		const py = await globalThis.__neonLoadPyodide({
			indexURL: "${ORIGIN}",
			packageBaseUrl: "${ORIGIN}",
			createPyodideModule: globalThis.__neonCreatePyodide,
			lockFileContents: m.lock,
			stdout: (s) => console.log("[python]", s),
			stderr: (s) => console.warn("[python]", s),
		});
		const lock = new Set(Object.keys(JSON.parse(m.lock).packages).map(norm));
		const wheelNames = new Set(m.wheels.map((w) => norm(w.split("-")[0])));
		const fromLock = m.deps.filter((d) => lock.has(norm(d)));
		const stubs = m.stubs ?? m.deps.filter((d) => !lock.has(norm(d)) && !wheelNames.has(norm(d)));
		if (fromLock.length) await py.loadPackage(fromLock, { messageCallback: () => {} });
		if (m.wheels.length) await py.loadPackage(m.wheels.map((w) => "${ORIGIN}game/" + w), { messageCallback: () => {} });
		const root = "/home/pyodide/app/";
		for (const [path, buf] of m.files) {
			const at = root + path;
			py.FS.mkdirTree(at.slice(0, at.lastIndexOf("/")));
			py.FS.writeFile(at, new Uint8Array(buf));
		}
		py.runPython(m.glue, { filename: "arcade_server.py" });
		const late = py.globals.get("install")(py.toPy(stubs), root, m.kind, m.target).toJs();
		call = py.globals.get("call");
		return [...stubs, ...late];
	}
	async function answer(m) {
		try {
			const body = Uint8Array.from(atob(m.body || ""), (c) => c.charCodeAt(0));
			const out = await call(m.method, m.path, m.query, m.headers, body);
			const [status, headers, data] = out.toJs();
			out.destroy?.();
			const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
			port.postMessage({ t: "http", id: m.id, status, headers, body: buf }, [buf]);
		} catch (err) {
			console.error(err);
			const buf = new TextEncoder().encode(String(err && err.message || err)).buffer;
			port.postMessage({ t: "http", id: m.id, status: 500, headers: [["content-type", "text/plain"]], body: buf }, [buf]);
		}
	}
	addEventListener("message", function take(e) {
		if (e.source !== parent || e.data?.t !== "neon:py" || !e.ports[0]) return;
		removeEventListener("message", take);
		port = e.ports[0];
		port.onmessage = (ev) => {
			const m = ev.data;
			if (m.t === "file") { waiting.get(m.id)?.(m); waiting.delete(m.id); }
			if (m.t === "boot") boot(m).then((stubs) => port.postMessage({ t: "ready", stubs }), (err) => port.postMessage({ t: "failed", error: String(err && err.message || err) }));
			if (m.t === "http") answer(m);
		};
		port.postMessage({ t: "hello" });
	});
})();
`;

	// Pyodide ships as ES modules; an opaque frame can import nothing, so both
	// are inlined with their export turned into a global.
	let runtimeDoc = null;
	const frameDoc = () =>
		(runtimeDoc ??= Promise.all([text(here(RUNTIME + "pyodide.mjs")), text(here(RUNTIME + "pyodide.asm.mjs"))]).then(
			([loader, asm]) => {
				const loaderOut = loader.replace(/export\s*\{\s*(\w+) as loadPyodide\s*,[^}]*\}\s*;?/, "globalThis.__neonLoadPyodide=$1;");
				const asmOut = asm.replace(/export default (_createPyodideModule);?\s*$/, "globalThis.__neonCreatePyodide=$1;");
				if (loaderOut === loader || asmOut === asm) throw new Error("unexpected Pyodide build (exports not found)");
				return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${CSP}">
<script>${scriptSafe(BOOT)}<\/script>
<script type="module">${scriptSafe(asmOut)}<\/script>
<script type="module">${scriptSafe(loaderOut)}<\/script>
</head><body></body></html>`;
			},
		)).catch((err) => {
			runtimeDoc = null;
			throw err;
		});

	/** Start `game.app.server` in a hidden frame. Requests made before it is up wait. */
	NeonArcade.startPyServer = (game) => {
		const server = game.app.server;
		const base = new URL(game.base);
		const frame = document.createElement("iframe");
		frame.setAttribute("sandbox", "allow-scripts");
		frame.hidden = true;
		frame.title = `${game.name} server`;
		document.body.append(frame);
		const channel = new MessageChannel();
		const port = channel.port1;
		const pending = new Map(); // id -> resolve
		let seq = 0;
		let stopped = false;
		let markReady;
		let markFailed;
		const ready = new Promise((resolve, reject) => {
			markReady = resolve;
			markFailed = reject;
		});
		ready.catch(() => {});

		const file = async (name) => {
			if (name.startsWith("game/")) {
				const url = new URL(server.path + "wheels/" + name.slice(5), base);
				if (!url.href.startsWith(base.href)) throw new Error("outside the game folder");
				return bytes(url);
			}
			if (name.includes("..") || name.startsWith("/")) throw new Error(name);
			return bytes(here(RUNTIME + name));
		};
		port.onmessage = async (e) => {
			const m = e.data;
			switch (m?.t) {
				case "hello": {
					try {
						const [lock, glue, files] = await Promise.all([
							text(here(RUNTIME + "pyodide-lock.json")),
							text(here(GLUE)),
							Promise.all(server.files.map(async (p) => [p, await bytes(new URL(server.path + p, base))])),
						]);
						port.postMessage(
							{ t: "boot", lock, glue, files, deps: server.deps ?? [], wheels: server.wheels ?? [], stubs: server.stubs, kind: server.kind, target: server.target },
							files.map(([, b]) => b),
						);
					} catch (err) {
						markFailed(err);
					}
					break;
				}
				case "get":
					try {
						const buf = await file(String(m.name));
						port.postMessage({ t: "file", id: m.id, buf }, [buf]);
					} catch {
						port.postMessage({ t: "file", id: m.id, buf: null });
					}
					break;
				case "ready":
					if (m.stubs?.length) console.warn(`${game.id}: not available here, imported as stubs: ${m.stubs.join(", ")}`);
					markReady();
					break;
				case "failed":
					markFailed(new Error(m.error));
					break;
				case "http":
					pending.get(m.id)?.({ status: m.status, headers: m.headers, body: m.body });
					pending.delete(m.id);
					break;
			}
		};

		frameDoc()
			.then((doc) => {
				if (stopped) return;
				frame.addEventListener("load", () => frame.contentWindow?.postMessage({ t: "neon:py" }, "*", [channel.port2]), { once: true });
				frame.srcdoc = doc;
			})
			.catch(markFailed);

		const fail = (status, message) => ({ status, headers: [["content-type", "text/plain"]], body: new TextEncoder().encode(message).buffer });
		return {
			ready,
			/** body: base64 in, ArrayBuffer out. */
			async request(req) {
				try {
					await ready;
				} catch (err) {
					return fail(503, `the game's server did not start: ${err.message}`);
				}
				if (stopped) return fail(503, "the game's server stopped");
				return new Promise((resolve) => {
					const id = ++seq;
					pending.set(id, resolve);
					port.postMessage({ t: "http", id, ...req });
					setTimeout(() => pending.delete(id) && resolve(fail(504, "the game's server took too long")), TIMEOUT);
				});
			},
			stop() {
				stopped = true;
				for (const resolve of pending.values()) resolve(fail(503, "the game's server stopped"));
				pending.clear();
				port.close();
				frame.remove();
			},
		};
	};
})();
