// arcade-python.js — the Python adapter's boot (sdk/v2/adapters/python).
//
// A managed game written in Python (arcade.py) runs in Pyodide, CPython in
// WebAssembly, inside the game's own sandboxed frame. The frame can fetch
// nothing, and Pyodide is a platform runtime outside the game's folder, so
// every file it reads is a request to the shell:
//
//   Pyodide's parts   arcade.request("runtime.file", { path })  → { bytes }
//   the game's Python arcade.request("asset", { path, as: "text" }) → { text }
//
// Pyodide ships as two ES modules. The frame can import nothing, so each is
// injected as an inline module script (the CSP's 'unsafe-inline') with its
// export turned into a call back here, as lib/py-server.js does. Only the
// core boots: no package is loaded, so nothing else is asked for.
//
// Then arcade.py and the game's modules are written to Pyodide's disk, the
// main one runs (it calls `arcade.run(YourGame)`), and the adapter's
// `dispatch` goes to `arcade.managedJson`, which says `ready`.
//
// The game's modules: <meta name="arcade-python" content="game.py more.py">
// in index.html, the first being the one to run; without it, game.py.
// `arcade.python` is { pyodide, ms } once up, for debugging.

(() => {
	const ORIGIN = "https://pyodide.invalid/"; // Pyodide's indexURL: never fetched, only parsed
	const HOME = "/home/pyodide/game/";
	const started = performance.now();

	// Pyodide's parts, asked for once each; the big ones before it needs them.
	const asked = new Map();
	const part = (name) => {
		if (!asked.has(name)) asked.set(name, arcade.request("runtime.file", { path: name }).then((r) => r.bytes));
		return asked.get(name);
	};
	for (const name of ["pyodide.asm.mjs", "pyodide.mjs", "pyodide.asm.wasm", "python_stdlib.zip"]) part(name);

	const meta = document.querySelector('meta[name="arcade-python"]');
	const modules = (meta?.content.trim() || "game.py").split(/\s+/);
	const sources = Promise.all(["arcade.py", ...modules].map(async (path) => [path, (await arcade.request("asset", { path, as: "text" })).text]));

	// Pyodide's loader fetches by URL. While it boots, those fetches are
	// answered from `part`; afterwards the frame's own fetch is put back.
	const pyFetch = async (input) => {
		const url = String(input instanceof Request ? input.url : input);
		if (!url.startsWith(ORIGIN)) return new Response("", { status: 404 });
		const name = url.slice(ORIGIN.length);
		try {
			const bytes = await part(name);
			asked.delete(name); // a Response consumes it; nothing asks twice
			return new Response(bytes, { headers: { "content-type": name.endsWith(".wasm") ? "application/wasm" : "application/octet-stream" } });
		} catch {
			return new Response("", { status: 404 });
		}
	};

	// One ES module, run inline; resolves with what it exported.
	const runModule = async (name, exported) => {
		const code = new TextDecoder().decode(await part(name));
		asked.delete(name);
		const key = `__arcadePy${Math.random().toString(36).slice(2)}`;
		const out = code.replace(exported, `globalThis.${key}($1);`);
		if (out === code) throw new Error(`${name}: an unexpected Pyodide build (its export was not found)`);
		return new Promise((resolve) => {
			globalThis[key] = (value) => {
				delete globalThis[key];
				resolve(value);
			};
			const script = document.createElement("script");
			script.type = "module";
			script.textContent = out;
			document.head.append(script);
		});
	};

	async function boot() {
		const [createPyodideModule, loadPyodide] = await Promise.all([
			runModule("pyodide.asm.mjs", /export default (_createPyodideModule);?\s*$/),
			runModule("pyodide.mjs", /export\s*\{\s*(\w+) as loadPyodide\s*,[^}]*\}\s*;?/),
		]);
		const ownFetch = globalThis.fetch;
		globalThis.fetch = pyFetch;
		let pyodide;
		try {
			pyodide = await loadPyodide({
				indexURL: ORIGIN,
				createPyodideModule,
				stdout: (s) => console.log("[python]", s),
				stderr: (s) => console.warn("[python]", s),
			});
		} finally {
			globalThis.fetch = ownFetch;
		}
		pyodide.FS.mkdirTree(HOME);
		for (const [path, text] of await sources) {
			pyodide.FS.mkdirTree(HOME + path.slice(0, path.lastIndexOf("/") + 1));
			pyodide.FS.writeFile(HOME + path, text);
		}
		pyodide.runPython(`import runpy, sys\nsys.path.insert(0, ${JSON.stringify(HOME)})\nrunpy.run_path(${JSON.stringify(HOME + modules[0])}, run_name="__main__")`);
		const adapter = pyodide.pyimport("arcade");
		if (adapter._game_class == null) throw new Error(`${modules[0]} never called arcade.run(YourGame)`);
		const dispatch = adapter.dispatch;
		arcade.python = { pyodide, ms: Math.round(performance.now() - started) };
		arcade.managedJson((json) => dispatch(json));
	}

	boot().catch((err) => {
		console.error("arcade: the game's Python did not start —", err?.message ?? err);
		arcade.toast(`The game did not start: ${String(err?.message ?? err).split("\n").filter(Boolean).at(-1)}`, "warn");
	});
})();
