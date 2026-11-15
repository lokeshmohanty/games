// scripts/prebuild-frames.mjs — every listed game's frame, built at deploy.
//
// A game runs in a sandboxed srcdoc frame whose document the shell puts
// together from the runtime, the arcade's styles and the game's own page,
// scripts and stylesheets (lib/bridge.js). On a phone that was the slow part
// of opening a game: the page, then its scripts, fetched and parsed at tap
// time (docs/perf.md). This does it once, at deploy: for every game the
// catalogs register (lib/catalog.js, community/catalog.js; listed or not) it
// runs lib/bridge.js's own `buildFrameTemplate` in a headless Chrome over the
// built site and writes the result to frames/<id>.html. The shell fetches
// that one precached file and only finishes it (fonts, theme, a web app's
// address: lib/bridge.js finishFrameDoc).
//
// The same function builds a template here and at tap time, so a prebuilt
// frame is the frame the dev kit and validate-game check — byte for byte
// (test-bots compares them). A game this cannot build is skipped with a
// warning: the shell builds its frame at tap time, and shows the same error.
//
// The fonts are not in the templates (they would add ~200 KB to each), only
// marks that the shell swaps for the fonts it already holds.
//
// Needs Playwright (a dev dependency) and a Chrome (CHROME=, or a system
// one). Without a browser it skips, unless CI is set: a deploy must not
// silently lose its prebuilt frames.

import { existsSync, globSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// lib/bridge.js NeonArcade.prebuiltFrame: the names it looks for.
const SAFE_ID = /^[A-Za-z0-9-]+(\/[a-z0-9-]+)?$/;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".md": "text/markdown", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".wasm": "application/wasm", ".woff2": "font/woff2" };

function chromePath() {
	return [
		process.env.CHROME,
		"/run/current-system/sw/bin/google-chrome-stable",
		"/run/current-system/sw/bin/chromium",
		"/usr/bin/google-chrome-stable",
		"/usr/bin/google-chrome",
		"/usr/bin/chromium",
		join(homedir(), ".nix-profile", "bin", "google-chrome-stable"),
	]
		.filter(Boolean)
		.find((p) => existsSync(p));
}
function playwright() {
	const found = [join(ROOT, "node_modules", "playwright"), join(homedir(), ".cache", "game-previews", "node_modules", "playwright"), ...globSync(join(homedir(), ".npm", "_npx", "*", "node_modules", "playwright"))].find(existsSync);
	return found ? createRequire(import.meta.url)(found) : null;
}

/** `dir` over http on a free loopback port. */
function serveDir(dir) {
	const server = createServer((req, res) => {
		const path = normalize(join(dir, decodeURIComponent(new URL(req.url, "http://x").pathname)));
		if (!path.startsWith(dir + sep) || !existsSync(path)) {
			res.writeHead(404).end();
			return;
		}
		try {
			res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" }).end(readFileSync(path));
		} catch {
			res.writeHead(404).end(); // a folder
		}
	});
	return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ base: `http://127.0.0.1:${server.address().port}`, stop: () => server.close() })));
}

/**
 * Write frames/<id>.html into `dist` for every game the catalogs register.
 * Returns the paths written (relative to dist) and the games skipped.
 */
export async function prebuildFrames(dist) {
	const chrome = chromePath();
	const pw = playwright();
	if (!chrome || !pw) {
		const why = `prebuild-frames: no ${chrome ? "Playwright" : "Chrome (set CHROME=)"} — the shell will build every frame at tap time`;
		if (process.env.CI) throw new Error(why);
		console.warn(why);
		return { written: [], skipped: [] };
	}
	const site = await serveDir(resolve(dist));
	const browser = await pw.chromium.launch({ executablePath: chrome, args: ["--no-sandbox"] });
	const written = [];
	const skipped = [];
	try {
		const page = await browser.newPage();
		// A blank page on the site's origin with only what builds a frame:
		// bridge.js, and the catalogs registering their games with it.
		await page.route(`${site.base}/__prebuild.html`, (route) =>
			route.fulfill({
				contentType: "text/html",
				body: `<!doctype html><script>window.NeonArcade = { registerGame: (g) => (window.__games ??= []).push(g) };</script>
<script src="lib/bridge.js"></script><script src="lib/catalog.js"></script><script src="community/catalog.js"></script>`,
			}),
		);
		await page.goto(`${site.base}/__prebuild.html`);
		const games = await page.evaluate(() => (window.__games ?? []).map((g) => ({ id: g.id, framed: !!NeonArcade.prebuiltFrame(g) })));
		for (const { id, framed } of games) {
			if (!SAFE_ID.test(id) || !framed) {
				skipped.push({ id, why: "not a name frames/ can hold" });
				continue;
			}
			try {
				const doc = await page.evaluate((id) => NeonArcade.buildFrameTemplate(window.__games.find((g) => g.id === id)), id);
				const rel = `frames/${id}.html`;
				mkdirSync(dirname(join(dist, rel)), { recursive: true });
				writeFileSync(join(dist, rel), doc);
				written.push(rel);
			} catch (err) {
				skipped.push({ id, why: err.message.split("\n")[0] });
			}
		}
	} finally {
		await browser.close();
		site.stop();
	}
	for (const { id, why } of skipped) console.warn(`prebuild-frames: ${id} not prebuilt (${why}); the shell builds it at tap time`);
	return { written, skipped };
}
