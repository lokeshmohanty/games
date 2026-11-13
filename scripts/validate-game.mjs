// scripts/validate-game.mjs — everything the platform checks before it lists a
// game, run on a folder you have. The PR check for registry/ runs exactly this.
//
//   node scripts/validate-game.mjs path/to/game [more/games…]   static + browser
//   node scripts/validate-game.mjs --static path/to/game         no browser
//
// Static: game.json is valid (scripts/manifest.mjs); the entry page exists;
// every <script src> and stylesheet is inside the folder and exists; no script
// loads code at runtime (import, import(), importScripts, new Worker(url)) —
// the shell inlines each script, so it must be complete (docs/sdk.md rule 1);
// nothing reaches for the network (fetch, XMLHttpRequest, WebSocket,
// EventSource, http(s) URLs in src/href) — the frame's CSP would block it
// anyway; the folder is at most 5 MB.
//
// Browser: the game is served with the dev kit and mounted in the real party
// at 390x844 with every other seat a bot (or alone, for a local game); it must
// come up in its sandboxed frame, run 5 s with no page error and no console
// error, and not scroll sideways.

import { spawn } from "node:child_process";
import { existsSync, globSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { validateManifest } from "./manifest.mjs";
import { gameFrame, serve } from "./serve.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT = 30_000;

const args = process.argv.slice(2);
const staticOnly = args.includes("--static");
const dirs = args.filter((a) => !a.startsWith("--")).map((d) => resolve(d));
if (!dirs.length) {
	console.error("usage: validate-game.mjs [--static] <game folder>…");
	process.exit(2);
}

let failures = 0;
const check = (label, ok, detail = "") => {
	console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
	if (!ok) failures++;
	return ok;
};

const walk = (dir) =>
	readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
		d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)],
	);

// Code that loads more code, or talks to the network. Comments are not
// stripped: a mention in a comment is cheap to reword, a missed load is not.
const RUNTIME_LOAD = [
	[/^\s*import\s[\s\S]*?from\s*["']/m, "an import statement"],
	[/^\s*import\s*["']/m, "an import statement"],
	[/\bimport\s*\(/, "a dynamic import()"],
	[/\bimportScripts\s*\(/, "importScripts()"],
	[/\bnew\s+(Shared)?Worker\s*\(\s*["'`]/, "a Worker loaded from a file"],
];
const NETWORK = [
	[/\bfetch\s*\(/, "fetch()"],
	[/\bXMLHttpRequest\b/, "XMLHttpRequest"],
	[/\bnew\s+WebSocket\b/, "a WebSocket"],
	[/\bnew\s+EventSource\b/, "EventSource"],
];

/** Static checks; returns the parsed manifest, or null. */
function checkStatic(dir) {
	const at = (p) => relative(dir, p) || ".";
	const file = join(dir, "game.json");
	if (!check("game.json exists", existsSync(file))) return null;
	let m;
	try {
		m = JSON.parse(readFileSync(file, "utf8"));
	} catch (err) {
		check("game.json is JSON", false, err.message);
		return null;
	}
	const problems = validateManifest(m);
	if (!check("game.json is valid", !problems.length, problems.join("; "))) return null;

	const entry = join(dir, m.entry);
	if (!check(`the entry page (${m.entry}) exists`, existsSync(entry))) return null;
	const html = readFileSync(entry, "utf8");
	const refs = [
		...[...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map((x) => ["script", x[1]]),
		...[...html.matchAll(/<link\b[^>]*rel\s*=\s*["']stylesheet["'][^>]*>/gi)].map((x) => [
			"stylesheet",
			x[0].match(/href\s*=\s*["']([^"']+)["']/i)?.[1] ?? "",
		]),
	];
	const scripts = [];
	for (const [kind, ref] of refs) {
		const path = resolve(dirname(entry), ref);
		const inside = path.startsWith(dir + sep) && !/^[a-z]+:/i.test(ref);
		if (!check(`${kind} ${ref} is inside the game folder`, inside)) continue;
		if (!check(`${kind} ${ref} exists`, existsSync(path))) continue;
		if (kind === "script") scripts.push(path);
	}
	check("the entry page loads at least one script", scripts.length > 0);
	const inline = [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((x) => x[1]);

	const code = [...scripts.map((p) => [at(p), readFileSync(p, "utf8")]), ...inline.map((c, i) => [`inline script ${i + 1}`, c])];
	for (const [name, text] of code) {
		const loads = RUNTIME_LOAD.filter(([re]) => re.test(text)).map(([, what]) => what);
		check(`${name} is one complete bundle`, !loads.length, `found ${[...new Set(loads)].join(", ")} — bundle it into one file`);
		const net = NETWORK.filter(([re]) => re.test(text)).map(([, what]) => what);
		check(`${name} does not use the network`, !net.length, `found ${net.join(", ")} — ship files in the folder and use ctx.assets.url()`);
	}
	const remote = [...html.matchAll(/\b(?:src|href)\s*=\s*["'](https?:)?\/\//gi)];
	check("the entry page names no remote URL", !remote.length);

	const bytes = walk(dir).reduce((n, f) => n + statSync(f).size, 0);
	check(`the folder is at most 5 MB (${(bytes / 1048576).toFixed(2)} MB)`, bytes <= MAX_BYTES);
	if (m.preview) check(`the preview (${m.preview}) exists`, existsSync(join(dir, m.preview)));
	return m;
}

function chromePath() {
	const found = [
		process.env.CHROME,
		"/run/current-system/sw/bin/google-chrome-stable",
		"/run/current-system/sw/bin/chromium",
		"/usr/bin/google-chrome-stable",
		"/usr/bin/google-chrome",
		join(homedir(), ".nix-profile", "bin", "google-chrome-stable"),
	]
		.filter(Boolean)
		.find((p) => existsSync(p));
	if (!found) throw new Error("no system Chrome found; set CHROME=/path/to/chrome");
	return found;
}
function loadPlaywright() {
	const require = createRequire(import.meta.url);
	const found = [
		join(ROOT, "node_modules", "playwright"),
		join(homedir(), ".cache", "game-previews", "node_modules", "playwright"),
		...globSync(join(homedir(), ".npm", "_npx", "*", "node_modules", "playwright")),
	].find((p) => existsSync(p));
	if (!found) throw new Error("playwright not found (run `just test-bots` once to fetch it)");
	return require(found);
}

/** Mount each game in the real party with bots, via the dev kit. */
async function checkBrowser(games) {
	const site = await serve(8736);
	const { chromium } = loadPlaywright();
	const browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox"] });
	let port = 5180;
	for (const { dir, m } of games) {
		console.log(`\n${m.id}: in the party at 390x844`);
		const p = port++;
		const devServer = spawn("node", [join(ROOT, "sdk/v1/dev-server.mjs"), dir, String(p)], { stdio: "ignore" });
		await new Promise((r) => setTimeout(r, 400));
		const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
		const page = await ctx.newPage();
		const errors = [];
		page.on("pageerror", (e) => errors.push(e.message));
		page.on("console", (msg) => {
			// The party's own room-server probe may fail offline in CI; the game's
			// errors are what this checks.
			if (msg.type() === "error" && !/room server|Failed to load resource/i.test(msg.text())) errors.push(msg.text());
		});
		try {
			const q = new URLSearchParams({ dev: `http://127.0.0.1:${p}/`, game: `dev/${m.id}`, fresh: "1", rs: "http://127.0.0.1:1" });
			await page.goto(`${site.base}/party.html?${q}`);
			if (m.kind === "local") {
				await page.locator("#party button", { hasText: "START" }).first().click({ timeout: TIMEOUT });
			} else {
				const solo = page.locator("button", { hasText: /PLAY A BOT|PLAY ALONE/ }).first();
				if (!m.bots || !(await solo.count())) {
					check("needs people: nothing to start alone (skipped the play check)", true);
					continue;
				}
				await solo.click({ timeout: TIMEOUT });
				const add = page.locator("button", { hasText: "ADD BOT" }).first();
				for (let i = 1; i < m.seats.min && (await add.isEnabled().catch(() => false)); i++) await add.click();
				await page.locator("button", { hasText: "START GAME" }).first().click({ timeout: TIMEOUT });
			}
			const frame = await gameFrame(page, TIMEOUT).catch(() => null);
			if (!check("it mounts in its sandboxed frame", !!frame)) continue;
			await page.waitForTimeout(5000);
			const width = await frame.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
			check("it does not scroll sideways", width[0] <= width[1], `${width[0]} > ${width[1]}`);
			check("5 s of play with no page or console error", !errors.length, errors.slice(0, 3).join(" | "));
		} catch (err) {
			check("it starts", false, err.message.split("\n")[0]);
		} finally {
			await ctx.close();
			devServer.kill();
		}
	}
	await browser.close();
	site.stop();
}

const ok = [];
for (const dir of dirs) {
	console.log(`\n${relative(process.cwd(), dir) || "."}: static checks`);
	const m = checkStatic(dir);
	if (m) ok.push({ dir, m });
}
if (!staticOnly && ok.length) await checkBrowser(ok);
console.log(failures ? `\n${failures} check(s) failed` : `\nall ${dirs.length} game(s) pass`);
process.exit(failures ? 1 : 0);
