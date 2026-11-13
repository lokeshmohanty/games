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
};

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
	const file = resolve(ROOT, "." + path);
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
