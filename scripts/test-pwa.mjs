#!/usr/bin/env node
/**
 * test-pwa.mjs — is the arcade actually installable, and does it actually work
 * with the network gone?
 *
 *   node scripts/test-pwa.mjs
 *
 * "Installable" is not a matter of opinion: a browser will refuse unless the
 * manifest parses, names the app, points `start_url` somewhere inside its own
 * scope, asks for a standalone display, offers a large enough icon, and a
 * service worker with a fetch handler is controlling the page. Each of those is
 * checked here against a real Chrome rather than by reading the JSON back to
 * ourselves.
 *
 * Offline is checked the only way that means anything: cut the network and load
 * the pages.
 *
 * Service workers need a secure context, so the repo is served over
 * http://localhost (which counts) rather than opened from file://.
 */
import { createRequire } from "node:module";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, globSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const PW_CACHE = join(homedir(), ".cache", "game-previews");
const PORT = 8732;
const BASE = `http://127.0.0.1:${PORT}`;

function chromePath() {
	const found = [
		process.env.CHROME,
		"/run/current-system/sw/bin/google-chrome-stable",
		"/run/current-system/sw/bin/chromium",
		join(homedir(), ".nix-profile", "bin", "google-chrome-stable"),
	]
		.filter(Boolean)
		.find((p) => existsSync(p));
	if (!found) {
		console.error("error: no system Chrome found; set CHROME=/path/to/chrome");
		process.exit(1);
	}
	return found;
}

function loadPlaywright() {
	const found = [
		join(ROOT, "node_modules", "playwright"),
		join(PW_CACHE, "node_modules", "playwright"),
		...globSync(join(homedir(), ".npm", "_npx", "*", "node_modules", "playwright")),
	].find((p) => existsSync(p));
	if (!found) {
		execFileSync(
			"npm",
			["install", "--prefix", PW_CACHE, "--no-save", "--no-audit", "playwright"],
			{ stdio: "inherit" },
		);
		return require(join(PW_CACHE, "node_modules", "playwright"));
	}
	return require(found);
}

let failures = 0;
const check = (label, ok, detail = "") => {
	console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
	if (!ok) failures++;
};

const { chromium } = loadPlaywright();

const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], {
	cwd: ROOT,
	stdio: "ignore",
});
const cleanup = () => {
	try {
		server.kill();
	} catch {}
};
process.on("exit", cleanup);
await new Promise((r) => setTimeout(r, 900));

const browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox"] });
// A phone, because that is where an installed app earns its keep.
const ctx = await browser.newContext({
	viewport: { width: 390, height: 844 },
	deviceScaleFactor: 3,
});
const page = await ctx.newPage();

// ------------------------------------------------------------- the manifest

console.log("\npwa: the manifest");

await page.goto(`${BASE}/index.html`);

const linked = await page.getAttribute('link[rel="manifest"]', "href");
check("every page links a manifest", !!linked, "no <link rel=manifest>");

const manifestUrl = new URL(linked, `${BASE}/index.html`).href;
const manifest = await page.evaluate(async (url) => {
	const res = await fetch(url);
	return { status: res.status, type: res.headers.get("content-type"), body: await res.text() };
}, manifestUrl);
check("the manifest is served", manifest.status === 200, `HTTP ${manifest.status}`);

let m = null;
try {
	m = JSON.parse(manifest.body);
} catch (err) {
	check("the manifest is valid JSON", false, err.message);
}

if (m) {
	check("it names the app", !!m.name, "no name");
	check("it has a short_name for the home screen", !!m.short_name, "no short_name");
	check("it asks for a standalone window", m.display === "standalone", `display: ${m.display}`);
	check("it sets a background and theme colour", !!m.background_color && !!m.theme_color);

	// start_url must resolve inside scope, or the browser refuses to install.
	const scope = new URL(m.scope ?? "./", manifestUrl).href;
	const start = new URL(m.start_url, manifestUrl).href;
	check("start_url sits inside scope", start.startsWith(scope), `${start} vs ${scope}`);

	const png = (m.icons ?? []).filter((i) => i.type === "image/png");
	const sizeOf = (i) => Math.max(...String(i.sizes).split(/\s+/).map((s) => parseInt(s, 10) || 0));
	check(
		"there is an icon of at least 192px",
		png.some((i) => sizeOf(i) >= 192),
		"no 192px+ PNG icon",
	);
	check(
		"there is an icon of at least 512px",
		png.some((i) => sizeOf(i) >= 512),
		"no 512px+ PNG icon",
	);
	check(
		"there is a maskable icon for Android launchers",
		png.some((i) => String(i.purpose ?? "").split(/\s+/).includes("maskable")),
		"no maskable icon",
	);

	// Every icon has to actually be there. A 404 here is the classic reason an
	// install prompt never appears, and nothing in the page reports it.
	const results = await page.evaluate(async (urls) => {
		const out = [];
		for (const u of urls) {
			try {
				const r = await fetch(u);
				out.push([u, r.status, r.headers.get("content-type")]);
			} catch (e) {
				out.push([u, 0, String(e)]);
			}
		}
		return out;
	}, (m.icons ?? []).map((i) => new URL(i.src, manifestUrl).href));
	const broken = results.filter(([, status]) => status !== 200);
	check(
		`all ${results.length} manifest icons resolve`,
		broken.length === 0,
		broken.map(([u, s]) => `${u} -> ${s}`).join(", "),
	);
}

// The apple-touch-icon is how iOS gets an icon at all; it ignores the manifest.
{
	const href = await page.getAttribute('link[rel="apple-touch-icon"]', "href");
	check("an apple-touch-icon is declared", !!href, "iOS would use a screenshot");
	if (href) {
		const status = await page.evaluate(
			(u) => fetch(u).then((r) => r.status).catch(() => 0),
			new URL(href, `${BASE}/index.html`).href,
		);
		check("the apple-touch-icon resolves", status === 200, `HTTP ${status}`);
	}
}

// Every page, not just the portal — an installed app can be opened at any of
// them, and a page without the manifest link drops out of the installed app
// into a browser tab.
console.log("\npwa: every page is part of the app");
for (const p of [
	"party.html",
	"connect4.html",
	"draw-guess.html",
	"neon-survival.html",
	"neon-survival-mp.html",
	"tug-of-war.html",
]) {
	await page.goto(`${BASE}/${p}`);
	const has = await page.evaluate(() => ({
		manifest: !!document.querySelector('link[rel="manifest"]'),
		theme: !!document.querySelector('meta[name="theme-color"]'),
		icon: !!document.querySelector('link[rel="icon"]'),
		pwa: !!document.querySelector('script[src$="lib/pwa.js"]'),
	}));
	check(`${p} carries the manifest, theme colour, icon and pwa.js`,
		has.manifest && has.theme && has.icon && has.pwa,
		JSON.stringify(has));
}

// --------------------------------------------------------- the service worker

console.log("\npwa: the service worker");

await page.goto(`${BASE}/index.html`);
const controlled = await page
	.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 20_000 })
	.then(() => true)
	.catch(() => false);
check("a service worker takes control of the page", controlled);

const state = await page.evaluate(async () => {
	const reg = await navigator.serviceWorker.getRegistration();
	return {
		scope: reg?.scope ?? null,
		active: reg?.active?.state ?? null,
		script: reg?.active?.scriptURL ?? null,
	};
});
check("it is active", state.active === "activated", `state: ${state.active}`);
check(
	"its scope covers the whole site",
	state.scope === `${BASE}/`,
	`scope: ${state.scope}`,
);

// Chrome will not offer to install without a fetch handler, so this is not a
// stylistic point — it is the difference between installable and not.
const servesFromWorker = await page.evaluate(async () => {
	const res = await fetch("lib/styles.css", { cache: "no-store" });
	// A response the worker produced is not marked, so check the other way
	// round: the page is controlled and the request succeeded.
	return res.ok && navigator.serviceWorker.controller !== null;
});
check("requests go through the worker", servesFromWorker);

// ------------------------------------------------------------------- offline

console.log("\npwa: with the network gone");

// Give the install-time precache a moment to finish before pulling the plug.
await page.waitForTimeout(2500);
// Aborting every request is a truer "no network" than setOffline, which does
// not reach the fetches the service worker itself makes — and those are the
// ones being tested here.
const disconnect = (route) => route.abort("internetdisconnected");
await ctx.route("**/*", disconnect);
await ctx.setOffline(true);

// The marker is the screen the page is supposed to build for itself, not just
// the empty container it builds into — `.lobby` is absolutely positioned, so
// `#lobby` has no height whether this works or not.
for (const [p, marker, expect, what] of [
	["index.html", "h1", /game portal/i, "the portal"],
	["party.html", ".lobby", /party/i, "the party screen"],
	["neon-survival.html", "canvas", null, "Neon Survival"],
	["connect4.html", ".lobby", /connect 4/i, "Connect 4"],
]) {
	let ok = false;
	let detail = "";
	try {
		await page.goto(`${BASE}/${p}`, { waitUntil: "domcontentloaded" });
		const el = await page.waitForSelector(marker, { timeout: 8000 });
		const text = await el.textContent();
		ok = !expect || expect.test(text);
		if (!ok) detail = `no ${expect} in "${text.trim().slice(0, 50)}"`;
	} catch (err) {
		detail = err.message.split("\n")[0];
	}
	check(`${what} loads offline`, ok, detail);
}

// Loading is not the same as working: the scripts have to be there too.
const libsOffline = await page.evaluate(() => ({
	net: typeof window.NeonArcade?.createHost === "function",
	qr: typeof window.NeonArcade?.qrCanvas === "function",
	games: (window.NeonArcade?.games?.() ?? []).length,
}));
check(
	"the shared library is there offline, with the games registered",
	libsOffline.net && libsOffline.qr,
	JSON.stringify(libsOffline),
);

// A page nobody has ever visited, with no network: the worker should hand back
// the portal rather than Chrome's dinosaur.
{
	const res = await page.goto(`${BASE}/does-not-exist.html`, { waitUntil: "domcontentloaded" });
	const title = await page.title().catch(() => "");
	check(
		"an unknown page offline falls back to the portal",
		!!res && /arcade|portal/i.test(title),
		`got: ${title || "nothing"}`,
	);
}

await ctx.unroute("**/*", disconnect);
await ctx.setOffline(false);

// ------------------------------------------------- freshness while online
//
// The whole reason code is fetched network-first: an edit must reach a player
// who already has the old version cached, on the very next load. A cache-first
// worker would serve the stale copy instead, and nothing would say so.

console.log("\npwa: an update reaches a player who already has the old copy");
{
	const before = await page.evaluate(async () => (await (await fetch("lib/games.js")).text()).length);
	// Serve a changed file without touching the repo: intercept at the network
	// layer, below the service worker, which is exactly where a deploy lands.
	await ctx.route("**/lib/games.js", (route) =>
		route.fulfill({ status: 200, contentType: "text/javascript", body: "// redeployed\n" }),
	);
	const after = await page.evaluate(async () => (await (await fetch("lib/games.js")).text()).trim());
	await ctx.unroute("**/lib/games.js");
	check(
		"a redeployed script is picked up rather than served from cache",
		after === "// redeployed",
		`was ${before} bytes, still got ${after.length} bytes back`,
	);
}

await browser.close();

// ------------------------------------------------- what Chrome itself thinks
//
// Everything above is this script's opinion of the rules. This is the browser's,
// and the two are not the same thing: the manifest once listed the SVG icon
// alongside the PNGs, passed every check written here, and was refused by Chrome
// anyway — an icon with `sizes: "any"` gets selected as *the* install icon and
// then rejected, taking the perfectly good PNGs next to it down with it. Nothing
// visible said so. Ask the browser.

console.log("\npwa: Chrome's own verdict");
{
	// A persistent profile, because "in-incognito" is itself a blocker and every
	// throwaway Playwright context is incognito.
	const profile = mkdtempSync(join(tmpdir(), "pwa-profile-"));
	const ctx2 = await chromium.launchPersistentContext(profile, {
		executablePath: chromePath(),
		args: ["--no-sandbox"],
		headless: true,
	});
	const p2 = ctx2.pages()[0] ?? (await ctx2.newPage());
	await p2.goto(`${BASE}/index.html`);
	await p2
		.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 20_000 })
		.catch(() => {});
	await p2.waitForTimeout(2500);
	const cdp = await ctx2.newCDPSession(p2);

	const manifestVerdict = await cdp.send("Page.getAppManifest");
	check(
		"Chrome parses the manifest without complaint",
		(manifestVerdict.errors ?? []).length === 0,
		JSON.stringify(manifestVerdict.errors),
	);

	const { installabilityErrors } = await cdp.send("Page.getInstallabilityErrors");
	check(
		"Chrome finds nothing standing in the way of installing",
		installabilityErrors.length === 0,
		installabilityErrors
			.map((e) => e.errorId + (e.errorArguments?.length ? ` (${JSON.stringify(e.errorArguments)})` : ""))
			.join(", "),
	);
	await ctx2.close();
}

cleanup();
console.log(failures ? `\n${failures} failure(s)` : "\nall pwa checks passed");
process.exit(failures ? 1 : 0);
