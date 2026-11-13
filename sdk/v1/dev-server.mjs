#!/usr/bin/env node
// sdk/v1/dev-server.mjs — serve your game folder(s) to the live arcade.
//
// No dependencies, Node 18+. From your repo:
//
//   node dev-server.mjs            serve the current folder on port 5174
//   node dev-server.mjs games 5200 serve ./games on port 5200
//
// It prints, for every folder below it holding a game.json, a link that opens
// the real arcade with that game loaded from this machine:
//
//   https://www.lokeshmohanty.in/games/party.html?dev=http://127.0.0.1:5174/my-game/&game=dev%2Fmy-game&fresh=1
//
// Edit, reload, play. Bots, invites (open the invite link in a second tab)
// and the party all work as they will once the game is merged. Set
// NEON_PLATFORM to use another copy of the arcade, e.g. your checkout of
// lokeshmohanty/games under `just run`: NEON_PLATFORM=http://127.0.0.1:8000.
//
// The arcade fetches your files from here, so this server answers with CORS
// allowed, and with the header Chrome's private-network checks ask for (it
// may still ask you once to allow the arcade to reach this machine).
// Nothing is cached: a reload always gets your latest files.
//
// A web app (game.json with "app", docs/sdk.md "Web apps") is served the way
// the arcade publishes it: web/ is your built site (run your build first —
// this server builds nothing), server/ your Python server's folder, and
// game.json the published form. Packages Pyodide does not ship are imported
// as stubs here; the arcade's own build fetches their wheels. Your scripts'
// `location` and `history` are rewritten to the arcade's as they are served,
// as the arcade's build does (with esbuild, through npx: the first time
// fetches it).

const ESBUILD = "esbuild@0.28.2";
const DEFINES = ["location", "history"].flatMap((g) =>
	["", "window.", "self.", "globalThis.", ...(g === "location" ? ["document."] : [])].map((p) => `--define:${p}${g}=__neon.${g}`),
);
const rewritten = new Map(); // file -> { mtime, code }
function rewrite(file) {
	const mtime = statSync(file).mtimeMs;
	const hit = rewritten.get(file);
	if (hit?.mtime === mtime) return hit.code;
	const code = execFileSync("npx", ["--yes", ESBUILD, file, "--minify-whitespace", "--log-level=warning", ...DEFINES], { maxBuffer: 64 << 20 });
	rewritten.set(file, { mtime, code });
	return code;
}

import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";

const ROOT = resolve(process.argv[2] ?? ".");
const PORT = Number(process.argv[3] ?? process.env.PORT ?? 5174);
const PLATFORM = (process.env.NEON_PLATFORM ?? "https://www.lokeshmohanty.in/games").replace(/\/+$/, "");

const TYPES = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".mp3": "audio/mpeg",
	".ogg": "audio/ogg",
	".wav": "audio/wav",
	".woff2": "font/woff2",
	".woff": "font/woff",
	".wasm": "application/wasm",
	".py": "text/x-python; charset=utf-8",
	".whl": "application/zip",
	".zip": "application/zip",
	".txt": "text/plain; charset=utf-8",
};

// The published layout of a web app in its author's folder: URL prefix → disk.
const apps = new Map(); // game dir → { manifest, web, server }

const walk = (dir, base = dir) =>
	readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
		if (d.name.startsWith(".") || ["__pycache__", "node_modules", "venv", "tests"].includes(d.name)) return [];
		const p = join(dir, d.name);
		return d.isDirectory() ? walk(p, base) : /\.(pyc|so|db|sqlite3?)$/.test(d.name) ? [] : [relative(base, p).split(sep).join("/")];
	});
function pythonDeps(dir) {
	const names = new Set();
	const add = (spec) => {
		const n = spec.trim().match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/)?.[1];
		if (n && !/^(uvicorn|gunicorn|hypercorn|daphne|waitress|granian)$/i.test(n)) names.add(n);
	};
	if (existsSync(join(dir, "pyproject.toml"))) {
		const block = readFileSync(join(dir, "pyproject.toml"), "utf8").match(/^\s*dependencies\s*=\s*\[([\s\S]*?)\]/m)?.[1] ?? "";
		for (const [, spec] of block.matchAll(/["']([^"']+)["']/g)) add(spec);
	}
	if (existsSync(join(dir, "requirements.txt"))) {
		for (const line of readFileSync(join(dir, "requirements.txt"), "utf8").split("\n")) if (!/^\s*(#|-)/.test(line)) add(line);
	}
	return [...names];
}
/** For a web app as its author wrote it, the published view of it; else null. */
function appView(dir) {
	let m;
	try {
		m = JSON.parse(readFileSync(join(dir, "game.json"), "utf8"));
	} catch {
		return null;
	}
	const a = m.app;
	if (!a || (!a.build && a.web === "web/" && (!a.server || a.server.files))) return null;
	const web = resolve(dir, a.build ? a.build.out : a.web);
	const view = { web, server: null, manifest: { ...m, entry: `web/${m.entry}`, app: { web: "web/" } } };
	if (a.server) {
		const server = resolve(dir, a.server.python);
		view.server = server;
		view.manifest.app.server = {
			kind: a.server.asgi ? "asgi" : "wsgi",
			target: a.server.asgi ?? a.server.wsgi,
			path: "server/",
			files: existsSync(server) ? walk(server) : [],
			deps: existsSync(server) ? pythonDeps(server) : [],
			wheels: [],
		};
	}
	return view;
}

const headers = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Private-Network": "true",
	"Access-Control-Allow-Headers": "*",
	"Cache-Control": "no-store",
};

/** Folders under ROOT (itself included) that hold a game.json. */
function games(dir = ROOT, depth = 0) {
	const found = existsSync(join(dir, "game.json")) ? [dir] : [];
	if (depth >= 3) return found;
	for (const d of readdirSync(dir, { withFileTypes: true })) {
		if (d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules") {
			found.push(...games(join(dir, d.name), depth + 1));
		}
	}
	return found;
}

createServer((req, res) => {
	if (req.method === "OPTIONS") {
		res.writeHead(204, headers);
		return res.end();
	}
	const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
	let file = resolve(ROOT, "." + path);
	for (const [dir, view] of apps) {
		const rel = file.startsWith(dir + sep) ? file.slice(dir.length + 1).split(sep).join("/") : null;
		if (rel === "game.json") {
			const v = appView(dir) ?? view; // re-read: the author may have edited it
			res.writeHead(200, { ...headers, "Content-Type": TYPES[".json"] });
			return res.end(JSON.stringify(v.manifest));
		}
		if (rel?.startsWith("web/")) {
			file = resolve(view.web, rel.slice(4));
			if (/\.m?js$/.test(file) && file.startsWith(ROOT + sep) && existsSync(file)) {
				res.writeHead(200, { ...headers, "Content-Type": TYPES[".js"] });
				return res.end(rewrite(file));
			}
		}
		else if (rel?.startsWith("server/") && view.server) file = resolve(view.server, rel.slice(7));
		else continue;
		if (!file.startsWith(ROOT + sep)) {
			res.writeHead(403, headers);
			return res.end("outside the served folder");
		}
		break;
	}
	if (file !== ROOT && !file.startsWith(ROOT + sep)) {
		res.writeHead(403, headers);
		return res.end("outside the served folder");
	}
	if (!existsSync(file) || !statSync(file).isFile()) {
		res.writeHead(404, headers);
		return res.end("not found");
	}
	res.writeHead(200, { ...headers, "Content-Type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream" });
	res.end(readFileSync(file));
}).listen(PORT, "127.0.0.1", () => {
	const list = games();
	console.log(`serving ${ROOT} on http://127.0.0.1:${PORT}/`);
	if (!list.length) console.log("no game.json found below this folder");
	for (const dir of list) {
		const view = appView(dir);
		if (view) {
			apps.set(dir, view);
			const own = JSON.parse(readFileSync(join(dir, "game.json"), "utf8"));
			if (!existsSync(join(view.web, own.entry))) {
				console.log(`  ${relative(ROOT, dir) || "."}: a web app with no ${own.entry} built yet — run: ${own.app.build?.run ?? "your build"}`);
			}
		}
		let id = "?";
		try {
			id = JSON.parse(readFileSync(join(dir, "game.json"), "utf8")).id;
		} catch (err) {
			console.log(`  ${relative(ROOT, dir) || "."}: game.json is not valid JSON (${err.message})`);
			continue;
		}
		const rel = relative(ROOT, dir).split(sep).join("/");
		const dev = `http://127.0.0.1:${PORT}/${rel ? rel + "/" : ""}`;
		const q = new URLSearchParams({ dev, game: `dev/${id}`, fresh: "1" });
		console.log(`\n  ${id}\n  ${PLATFORM}/party.html?${q}`);
	}
	console.log("");
});
