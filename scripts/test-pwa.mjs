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
import { createHash } from "node:crypto";
import { cpSync, existsSync, globSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { PORT_OFFSET, SITE_DIR, gameFrame } from "./serve.mjs";

const require = createRequire(import.meta.url);
const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const PW_CACHE = join(homedir(), ".cache", "game-previews");
// NEON_PORT_OFFSET moves it, as every suite's (scripts/serve.mjs), so two runs
// on one machine do not share a server.
const PORT = 8732 + PORT_OFFSET;
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

// A copy of the site, served, so a test can stage a new deploy by changing
// real files in it — exactly what a deploy does — without touching the repo.
// (Faking responses through Playwright's routing did not reach the install of
// a worker that update() brings in.)
const SITE = mkdtempSync(join(tmpdir(), "pwa-site-"));
// The built site (dist/, docs/spa.md) — what is deployed.
cpSync(SITE_DIR, SITE, { recursive: true, filter: (src) => !/[\\/](\.git|node_modules|\.wrangler)$/.test(src) });
const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], {
	cwd: SITE,
	stdio: "ignore",
});
const cleanup = () => {
	try {
		server.kill();
		rmSync(SITE, { recursive: true, force: true });
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
// The deployed site's strategy (sw.js "Why a snapshot"), not loopback's
// network-first development mode.
// (try: init scripts run in the sandboxed game frames too, which have no storage.)
await ctx.addInitScript(() => {
	try {
		localStorage.setItem("neon.sw", "snapshot");
	} catch {}
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

// The favicon is loaded as a standalone SVG, which means strict XML: one "--"
// in its header comment and the browser refuses the file. make-icons.mjs pastes
// it into HTML, which forgives that, so the PNGs looked fine for three months
// while every tab showed no icon at all.
{
	const href = await page.getAttribute('link[rel="icon"]', "href");
	const error = await page.evaluate(
		(u) =>
			fetch(u)
				.then((r) => r.text())
				.then((s) => {
					const doc = new DOMParser().parseFromString(s, "image/svg+xml");
					return doc.querySelector("parsererror")?.textContent.slice(0, 160) ?? null;
				})
				.catch((e) => String(e)),
		new URL(href, `${BASE}/index.html`).href,
	);
	check("the favicon parses as XML, so a browser will draw it", !error, error ?? "");
}

// Every page, not just the portal — an installed app can be opened at any of
// them, and a page without the manifest link drops out of the installed app
// into a browser tab.
console.log("\npwa: every page is part of the app");
for (const p of [
	"./?party",
	"./?page=profile",
	"./?page=leaderboard",
	"./?page=contributors",
	"./?page=contribute",
	"./?game=connect4&fresh=1",
	"./?game=lokeshmohanty%2Flight-cycles&fresh=1",
	"./?game=lokeshmohanty%2Fdraw-guess&fresh=1",
	"./?game=neon-survival-mp&fresh=1",
]) {
	// One page (docs/spa.md): every view is the shell, so what is checked is
	// the view once the shell's code (pwa.js among it, bundled) has run.
	await page.goto(`${BASE}/${p}`);
	await page.waitForFunction(() => !!window.NeonArcade?.isInstalled, null, { timeout: 15_000 }).catch(() => {});
	const has = await page.evaluate(() => ({
		manifest: !!document.querySelector('link[rel="manifest"]'),
		theme: !!document.querySelector('meta[name="theme-color"]'),
		icon: !!document.querySelector('link[rel="icon"]'),
		pwa: typeof window.NeonArcade?.isInstalled === "function",
	}));
	check(`${p} carries the manifest, theme colour, icon and pwa.js`,
		has.manifest && has.theme && has.icon && has.pwa,
		JSON.stringify(has));
}

// ------------------------------------------------------------- the portal
//
// The portal is `start_url`, so it is the first thing an installed app shows.
// It is also the page that carries the install slot, and the one most often
// rebuilt — since 2026-11-15 the home screen is sections (favourites, popular,
// the categories; lib/portal.js) — so its layout is asserted rather than
// eyeballed. What is in each section is test-portal.mjs's.

console.log("\npwa: the portal at 390x844");
await page.goto(`${BASE}/index.html`);
await page.waitForSelector(".portal-section .game-card");
await page.evaluate(() => window.NeonArcade.catalogs); // the community games drawn too

const portal = await page.evaluate(() => {
	const doc = document.documentElement;
	const cards = [...document.querySelectorAll(".portal-section .game-card")];
	const slot = document.querySelector("[data-install-slot]");
	const banner = document.querySelector(".party-banner");
	return {
		scroll: doc.scrollWidth,
		client: doc.clientWidth,
		games: [...new Set(cards.map((c) => c.dataset.game))],
		links: cards.flatMap((c) => [...c.querySelectorAll("a.card-play")].map((a) => a.getAttribute("href"))),
		title: document.querySelector("h1")?.textContent.trim(),
		// The slot must reserve its own room: it is filled after layout, and a
		// bar that appears from nowhere would shove the first row of cards down.
		slotInFlow: !!slot && getComputedStyle(slot).position === "static",
		bannerAboveGrid:
			!!banner &&
			banner.getBoundingClientRect().bottom <=
				document.querySelector("[data-sections]").getBoundingClientRect().top + 1,
	};
});
check(
	"the portal does not scroll sideways at 390px",
	portal.scroll <= portal.client,
	`scrollWidth ${portal.scroll} > clientWidth ${portal.client}`,
);
check("it is called Arcade Games", /arcade games/i.test(portal.title ?? ""), portal.title);

// Counted against the registry rather than against a number written here.
// A game added to `games/` and to the catalog but never given a portal card is
// a game nobody outside the party screen can find, and a hard-coded 4 turns
// that into a test that has to be edited every time rather than one that
// catches it.
// (Kept whole for "every game offline in single player", below.)
const catalog = await (async () => {
	const probe = await ctx.newPage();
	await probe.goto(`${BASE}/?party`);
	await probe.waitForFunction(() => window.NeonArcade?.listGames, null, { timeout: 20_000 });
	// The listed games, then the unlisted ones (the SDK's other examples):
	// playable by their address, on no list.
	const games = await probe.evaluate(() =>
		[...window.NeonArcade.listGames(), ...(window.NeonArcade.UNLISTED ?? []).map((u) => window.NeonArcade.getGame(u.id))].map((g) => ({ id: g.id, name: g.name, bots: !!g.bots, local: !!g.local, runtime: g.runtime ?? null, listed: g.listed !== false })),
	);
	await probe.close();
	return games;
})();
const registered = catalog.filter((g) => g.listed).map((g) => g.id);

// --------------------------------------------------------- the portal, small
//
// Nine games do not fit a phone, and until 2026-08-27 the portal did not try:
// a 300px minimum column at 80% width is one column on a 390px screen, and a
// 200px image plus a heading plus a paragraph plus a button is taller than the
// viewport. You arrived at one card. Now each section is a row of two cards
// and the edge of a third, scrolling sideways inside itself.

const grid = await page.evaluate(() => {
	// How many cards a screenful actually holds, from the top of the page —
	// header, banner, search and all. Scrolling to the cards first would
	// flatter the answer.
	window.scrollTo(0, 0);
	const cards = [...document.querySelectorAll(".portal-section:not([hidden]) .game-card")];
	const vh = window.innerHeight;
	const vw = window.innerWidth;
	const whole = cards.filter((c) => {
		const r = c.getBoundingClientRect();
		return r.top >= 0 && r.bottom <= vh && r.left >= 0 && r.right <= vw;
	});
	const row = document.querySelector(".portal-section:not([hidden]) .section-row");
	const inRow = [...row.children].map((c) => c.getBoundingClientRect());
	return {
		visible: whole.length,
		rowWhole: inRow.filter((r) => r.left >= 0 && r.right <= vw).length,
		rowPeeks: inRow.some((r) => r.left < vw && r.right > vw),
		gridTop: Math.round(row.getBoundingClientRect().top),
		tagged: cards.every((c) => (c.dataset.tags || "").trim().length > 0),
		blurbHidden: getComputedStyle(document.querySelector(".game-card p:not(.game-meta)")).display === "none",
		metaSize: parseFloat(getComputedStyle(document.querySelector(".game-card .game-meta")).fontSize),
		metaLines: (() => {
			const m = document.querySelector(".game-card .game-meta");
			return Math.round(m.getBoundingClientRect().height / parseFloat(getComputedStyle(m).fontSize));
		})(),
	};
});
check("a section on a phone: two whole cards, the next peeking in", grid.rowWhole === 2 && grid.rowPeeks, JSON.stringify(grid));
check("four cards fit on screen without scrolling", grid.visible >= 4, `${grid.visible} visible, the first row starts at ${grid.gridTop}px`);
check("the header does not eat the screen", grid.gridTop < 400, `${grid.gridTop}px above the first game`);
check("the blurb is dropped at this width", grid.blurbHidden, "the long description is still rendering");
// `.game-card p` outranks a bare `.game-meta`, so every rule written for the
// meta line was silently ignored until it was scoped. The tell was the line
// wrapping in two.
check("the meta line is styled by its own rule, not the paragraph's",
	grid.metaSize < 12, `${grid.metaSize}px — .game-card p is winning again`);
check("and fits on one line", grid.metaLines <= 1, `${grid.metaLines} lines`);
check("every card carries its tags", grid.tagged);

// A search: one grid of results, two columns, in place of the sections.
const searched = await page.evaluate(() => {
	const box = document.querySelector("[data-search]");
	const type = (q) => {
		box.value = q;
		box.dispatchEvent(new Event("input"));
	};
	type("strategy");
	const g = document.querySelector(".games-grid");
	const out = {
		columns: getComputedStyle(g).gridTemplateColumns.split(" ").length,
		names: [...g.querySelectorAll(".game-card:not([hidden]) h3")].map((h) => h.textContent.trim()),
		sectionsHidden: document.querySelector("[data-sections]").hidden,
		sideways: document.documentElement.scrollWidth > innerWidth,
	};
	type("");
	out.back = !document.querySelector("[data-sections]").hidden && g.hidden;
	return out;
});
check("a search shows one grid, two columns, in place of the sections",
	searched.columns === 2 && searched.sectionsHidden && !searched.sideways, JSON.stringify(searched));
check("…narrowed to what matches", searched.names.length > 0 && searched.names.length < registered.length, searched.names.join(", "));
check("…and an empty search brings the sections back", searched.back);

check(
	"the home screen has a card for every registered game",
	registered.every((id) => portal.games.includes(id)),
	`missing: ${registered.filter((id) => !portal.games.includes(id)).join(", ")}`,
);
check(
	"every card's play link is the shell's own address (./?game=…), no old page",
	portal.links.length > 0 && portal.links.every((l) => l.startsWith("./?") && !/\.html/.test(l)),
	portal.links.join(" "),
);
check("the install slot sits in the flow, not over the cards", portal.slotInFlow);
check("the party banner sits above the games", portal.bannerAboveGrid);

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

// Wait for the install-time precache to hold every shell file before pulling
// the plug — a fixed pause was too short on a cold first run, once the shell
// grew past 40 files (framed games, the SDK).
{
	const sw = readFileSync(join(SITE, "sw.js"), "utf8"); // as built (scripts/assemble.mjs)
	const version = sw.match(/const VERSION = "([^"]+)"/)[1];
	const shell = [...sw.match(/const SHELL = \[([\s\S]*?)\];/)[1].matchAll(/"(\.\/[^"]*)"/g)].length;
	// Polled from here: page.waitForFunction resolves at once on an async
	// predicate (its Promise is truthy — Playwright 1.62), so this check had
	// been passing without waiting.
	let full = false;
	for (const end = Date.now() + 30_000; Date.now() < end && !full; ) {
		full = await page.evaluate(async ([v, n]) => (await (await caches.open(v)).keys()).length >= n, [version, shell]);
		if (!full) await new Promise((r) => setTimeout(r, 250));
	}
	check(`the precache holds all ${shell} shell files before going offline`, full);
}
// Aborting every request is a truer "no network" than setOffline, which does
// not reach the fetches the service worker itself makes — and those are the
// ones being tested here.
// Every URL refused is kept: the single-player runs below must never ask the
// room server (lib/party.js skips it for SINGLE PLAYER).
const refused = [];
const disconnect = (route) => {
	refused.push(route.request().url());
	return route.abort("internetdisconnected");
};
await ctx.route("**/*", disconnect);
await ctx.setOffline(true);

// The marker is the screen the page is supposed to build for itself, not just
// the empty container it builds into — `.lobby` is absolutely positioned, so
// `#lobby` has no height whether this works or not.
for (const [p, marker, expect, what] of [
	["index.html", "h1", /arcade games/i, "the portal"],
	["./", "h1", /arcade games/i, "the portal at ./ (start_url)"],
	["./?party", ".lobby", /party/i, "the party screen"],
	["./?game=neon-survival-mp&fresh=1", ".lobby", /neon survival/i, "Neon Survival"],
	["./?game=connect4&fresh=1", ".lobby", /connect 4/i, "Connect 4"],
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

// A framed game is fetched and inlined by the shell (lib/bridge.js), through
// the worker: offline it must still come up and play, not just list itself.
{
	let detail = "";
	const played = await (async () => {
		await page.goto(`${BASE}/?game=connect4&fresh=1`, { waitUntil: "domcontentloaded" });
		await page.locator("button", { hasText: "SINGLE PLAYER" }).first().click({ timeout: 8000 });
		await page.locator("button", { hasText: "START GAME" }).first().click({ timeout: 8000 });
		const frame = await gameFrame(page, 10_000);
		return frame.waitForFunction(() => window.__game.handle.debug().started, null, { timeout: 8000 }).then(() => true);
	})().catch((err) => {
		detail = err.message.split("\n")[0];
		return false;
	});
	check("a framed game (Connect 4) starts offline", played, detail);
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

// --------------------------------------- every game offline in single player
//
// Lokesh, 2026-11-15: "Games, when played singleplayer/with bots should work
// offline." So for every game in the catalog — first-party, community and the
// SDK's examples — after that one online visit: open it from the portal with
// SINGLE PLAYER, with no network at all, and it mounts and plays. Played,
// not just drawn: a move and the bot's answer, ticks of a real-time game, a
// one-phone game started. Each game's own driver is below (PLAY); a game
// with none fails here, so a new game gets one.
//
// A Python game (`runtime: "python"`) is the one exception, by design:
// Pyodide is ~13 MB, so it is not in the install precache (sw.js isAsset) —
// it downloads the first time a Python game is opened online, and stays on
// the device from then on, across deploys. Offline before that, the shell
// says so plainly. Both halves are checked.

console.log("\npwa: every game offline in single player");
{
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const debug = (G) => G.evaluate(() => window.__game.handle.debug()).catch(() => null);
	/** Poll the game's debug view until `pred` (which may act) says done; the last view, or null. */
	const until = async (G, pred, ms = 20_000) => {
		for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) {
			const d = await debug(G);
			if (d && (await pred(d))) return d;
		}
		return null;
	};
	/** Click the first button in the game whose text matches. */
	const press = (G, re) => G.evaluate((src) => [...document.querySelectorAll("button")].find((b) => new RegExp(src).test(b.textContent) && !b.disabled)?.click(), re.source);
	/** A turn game: move when it is ours, until both we and the bot have marks down. */
	const turns = async (G, { cells, move }) => {
		let actedAt = -1;
		return until(G, async (v) => {
			const all = cells(v);
			if (!all || !v.you) return false;
			if (all.includes(v.you) && all.some((m) => m && m !== v.you)) return true;
			const marks = all.filter(Boolean).length;
			if (v.winner == null && v.turn === v.you && marks !== actedAt) {
				actedAt = marks;
				await G.evaluate((a) => window.arcade.act(a), move(v));
			}
			return false;
		});
	};
	const ticTacToe = (G) => turns(G, { cells: (v) => v.board, move: (v) => ({ i: v.board.indexOf(0) }) });
	const PLAY = {
		connect4: (G) => turns(G, { cells: (v) => v.started && v.board.flat(), move: (v) => ({ col: v.board[0].findIndex((m) => !m) }) }),
		"neon-bid": async (G) => {
			if (!(await until(G, (d) => d.phase === "bid" && d.submitted.length > 0))) return null; // the bot sealed its bid
			await G.evaluate(() => document.querySelector(".nb-go")?.click());
			return until(G, (d) => d.results.length > 0); // and the lot was opened
		},
		"neon-fission": async (G) => {
			// START at the table (no seat handed to a person), then a move and the bot's answer.
			const started = await until(G, async (d) => {
				if (d.phase === "setup") await press(G, /^START$/);
				return d.phase === "play";
			});
			if (!started) return null;
			let acted = -1;
			return until(G, async (v) => {
				if (v.moves >= 2 && v.last && v.last.seat !== v.you) return true; // the bot answered
				if (v.canPlay && v.moves !== acted) {
					acted = v.moves;
					await G.evaluate((cell) => window.arcade.act({ cell }), v.owner.indexOf(-1));
				}
				return false;
			});
		},
		"neon-survival-mp": async (G) => {
			const first = await until(G, (d) => d.active && d.simMs != null);
			return first && until(G, (d) => d.simMs > first.simMs + 500); // the run ticks
		},
		undercover: (G) => until(G, (d) => !!d.phase), // one phone: it starts
		"lokeshmohanty/battleship": async (G) => {
			if (!(await until(G, (d) => d.phase === "place"))) return null;
			await press(G, /COMMIT FLEET/);
			return until(G, async (d) => {
				if (d.shotsAtMe > 0) return true; // the bot fired back
				if (d.phase === "fire")
					await G.evaluate(() => {
						const at = window.battleshipRules.botTarget(window.__game.handle.debug().theirBoard);
						if (at) document.querySelector(`.bs-grid .bs-cell[data-r="${at[0]}"][data-c="${at[1]}"]`)?.click();
					});
				return false;
			});
		},
		"lokeshmohanty/liars-dice": (G) =>
			until(G, async (d) => {
				if (d.phase !== "bid" || d.digests < 2) return false; // both cups committed
				if (d.lastCall || d.bid?.by?.startsWith("bot_")) return true; // the bot bid or called
				await G.evaluate(() => [...document.querySelectorAll(".ld-actions button")].find((b) => b.textContent.startsWith("BID") && !b.disabled)?.click());
				return false;
			}),
		"lokeshmohanty/light-cycles": async (G) => {
			const start = await until(G, (d) => d.racing);
			return start && until(G, (d) => d.walls > start.walls + 4); // riders lay walls
		},
		"lokeshmohanty/bubble-rush": async (G) => {
			// START, then the round ticks and a tap on a bubble scores (the host
			// judges where it landed). Alone from the portal: no bots to watch.
			const on = await until(G, async (d) => {
				if (d.phase === "setup") await press(G, /^START$/);
				return d.phase === "play";
			});
			return (
				on &&
				until(G, async (d) => {
					if ((d.scores[d.you] ?? 0) > 0) return true;
					const b = d.bubbles.find((b) => b.k !== "x" && b.y > 0.1 && b.y < 0.9);
					if (b && !d.stunned) await G.evaluate((tap) => window.arcade.act({ tap }), { x: b.x, y: b.y, t: Math.round(d.t) });
					return false;
				})
			);
		},
		"lokeshmohanty/sudoku": async (G) => {
			const d = await until(G, async (d) => {
				if (d.phase === "pick") await press(G, /NEW PUZZLE/);
				return d.phase === "play" && d.selected >= 0;
			});
			if (!d) return null;
			await G.evaluate((key) => dispatchEvent(new KeyboardEvent("keydown", { key })), String(d.solution[d.selected]));
			return until(G, (d) => Object.values(d.progress).some((right) => right > 0)); // the host counted it
		},
	};
	const driver = (id) => PLAY[id] ?? (id.startsWith("tic-tac-toe-") ? ticTacToe : null);

	// What a game asked for and did not get: a same-origin miss (a file the
	// precache lacks), not preview media (never handled offline; the poster
	// stands in) and not other hosts (the accounts API, which is optional).
	let missed = [];
	const SAME = new URL(BASE).origin;
	const media = (u) => /\.(?:gif|webm|mp4)(?:$|\?)/i.test(u);
	page.on("response", (r) => {
		if (r.status() >= 400 && r.url().startsWith(SAME) && !media(r.url())) missed.push(`${r.status()} ${r.url().slice(SAME.length)}`);
	});
	page.on("requestfailed", (r) => {
		if (r.url().startsWith(SAME) && !media(r.url())) missed.push(`failed ${r.url().slice(SAME.length)}`);
	});
	let errors = [];
	page.on("pageerror", (err) => errors.push(err.message));

	/** From the portal, offline: the card's SINGLE PLAYER. Null when the card has none. */
	const openSolo = async (id) => {
		// An unlisted game has no card: its SINGLE PLAYER address, as the
		// "Add your game" guide links it.
		if (catalog.find((g) => g.id === id)?.listed === false) {
			await page.goto(`${BASE}/?game=${id}&fresh=1&mode=bots`, { waitUntil: "domcontentloaded" });
			await page.waitForSelector(".game-frame", { timeout: 15_000 });
			return gameFrame(page, 20_000);
		}
		await page.goto(`${BASE}/index.html`, { waitUntil: "domcontentloaded" });
		const card = page.locator(`.game-card[data-game="${id}"]`).first();
		await card.waitFor({ timeout: 10_000 });
		const solo = card.locator(".card-play.is-bots");
		if (!(await solo.count())) return null;
		await card.hover();
		await solo.click();
		await page.waitForSelector(".game-frame", { timeout: 15_000 });
		return gameFrame(page, 20_000);
	};

	const portalCards = await (async () => {
		await page.goto(`${BASE}/index.html`, { waitUntil: "domcontentloaded" });
		await page.waitForSelector(".game-card", { timeout: 10_000 }).catch(() => {});
		return page.evaluate(() => [...new Set([...document.querySelectorAll(".game-card")].map((c) => c.dataset.game))]);
	})();
	const listed = catalog.filter((g) => g.listed);
	check(`offline, the portal lists all ${listed.length} listed games (community too), and no unlisted example`, portalCards.length === listed.length && listed.every((g) => portalCards.includes(g.id)), `${portalCards.length}: ${listed.map((g) => g.id).filter((id) => !portalCards.includes(id)).join(", ")} missing`);

	const vendored = existsSync(join(SITE, "sdk", "pyodide", "pyodide.asm.wasm"));
	const python = [];
	for (const g of catalog) {
		missed = [];
		errors = [];
		const roomBefore = refused.filter((u) => /\/ping(?:$|\?)/.test(u)).length;
		const started = Date.now();
		let detail = "";
		let G = null;
		try {
			G = await openSolo(g.id);
		} catch (err) {
			detail = err.message.split("\n")[0];
		}
		if (!G && !detail) {
			// No SINGLE PLAYER on the card: only a people-only game may lack one.
			check(`${g.name}: no single player to test (people only)`, !g.bots && !g.local, "a game with bots or one device has no SINGLE PLAYER button");
			continue;
		}
		const mountMs = Date.now() - started;
		if (g.runtime === "python") {
			python.push(g);
			if (!vendored) {
				check(`${g.name}: skipped — Pyodide is not vendored in this build (just pyodide)`, true);
				continue;
			}
			// Never opened online: the runtime is not on this device. Said plainly.
			const ask = page.locator("dialog.neon-ask[open]");
			const said = await ask.waitFor({ timeout: 15_000 }).then(() => ask.textContent(), () => "");
			check(`${g.name}: offline before its first online play, the shell says Python needs one`, /python/i.test(said) && /online/i.test(said), said || "no message");
			await page.locator('dialog.neon-ask[open] [data-ask="yes"]').click().catch(() => {});
			continue;
		}
		const play = driver(g.id);
		let played = null;
		if (G && !play) detail = "no driver in test-pwa.mjs PLAY: add one";
		else if (G) played = await play(G).catch((err) => ((detail = err.message.split("\n")[0]), null));
		if (G && !played && !detail) detail = `stuck at ${JSON.stringify(await debug(G)).slice(0, 160)}`;
		check(`${g.name}: opens from the portal offline in SINGLE PLAYER and plays (mounted in ${(mountMs / 1000).toFixed(1)} s)`, !!played, detail);
		check(`${g.name}: …with every file it asked for on the device`, missed.length === 0, [...new Set(missed)].join(", "));
		check(`${g.name}: …without asking the room server`, refused.filter((u) => /\/ping(?:$|\?)/.test(u)).length === roomBefore);
		if (errors.length) check(`${g.name}: …with no page errors`, false, errors.join(" | ").slice(0, 200));
	}

	// The Python half: one online play brings Pyodide; offline it plays after.
	for (const g of vendored ? python : []) {
		await ctx.unroute("**/*", disconnect);
		await ctx.setOffline(false);
		let G = await openSolo(g.id).catch(() => null);
		const online = G && (await until(G, (v) => Array.isArray(v.board), 90_000));
		check(`${g.name}: played once online (Pyodide downloads on first use)`, !!online);
		await ctx.route("**/*", disconnect);
		await ctx.setOffline(true);
		missed = [];
		G = await openSolo(g.id).catch(() => null);
		const played = G && (await ticTacToe(G));
		check(`${g.name}: …then plays offline`, !!played, G ? JSON.stringify(await debug(G)) : "did not mount");
		check(`${g.name}: …with every file it asked for on the device`, missed.length === 0, [...new Set(missed)].join(", "));
	}
	// Leave the page as the update checks below expect it: on the portal.
	await page.goto(`${BASE}/index.html`, { waitUntil: "domcontentloaded" });
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
	const swFile = join(SITE, "sw.js");
	const swText = readFileSync(swFile, "utf8");
	const oldVersion = swText.match(/const VERSION = "([^"]+)"/)[1];
	const text = (path) => page.evaluate(async (p) => (await (await fetch(p)).text()).trim(), path);
	const keys = () => page.evaluate(() => caches.keys());
	const settle = async (ok, ms = 30_000) => {
		for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 300))) if (await ok()) return true;
		return false;
	};
	const update = () => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.update().catch(() => {}));
	const before = await text("lib/games.js");

	// A deploy that cannot be fetched whole (a file gone mid-deploy) must not
	// replace the snapshot this player has.
	const broken = oldVersion + "-broken";
	// A built chunk of a view the page has not opened yet (one the deploy
	// really ships: lib/ copies of bundled code are leftovers nothing loads).
	const chunk = globSync("app/Contribute-*.js", { cwd: SITE })[0];
	if (!chunk) throw new Error("no app/Contribute-*.js in the built site");
	const markdown = join(SITE, chunk);
	const markdownText = readFileSync(markdown, "utf8");
	rmSync(markdown);
	writeFileSync(swFile, swText.replace(oldVersion, broken));
	await update();
	await settle(async () => !(await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.installing)), 15_000);
	const afterBroken = await keys();
	check("a deploy that cannot be fetched whole does not install", !afterBroken.includes(broken) && afterBroken.includes(oldVersion), afterBroken.join());
	// Withdraw the broken deploy before mending it. Chrome retries a failed
	// update on its own a second or so later (a fetch event's soft update):
	// with the file back and the broken sw.js still served, that retry
	// installed it, and swallowed the deploy below (2026-11-15, 2 runs in 4).
	writeFileSync(swFile, swText);
	await new Promise((r) => setTimeout(r, 2000));
	await settle(async () => !(await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.installing)), 15_000);
	writeFileSync(markdown, markdownText);

	writeFileSync(join(SITE, "lib", "games.js"), "// redeployed\n");
	check("one file changed alone is not mixed into the deploy the page runs (the snapshot holds)", (await text("lib/games.js")) === before);

	// Pyodide's cache from before it moved (sdk/v1/pyodide/ → sdk/pyodide/,
	// 2026-11-15): assemble.mjs hashes the path into RUNTIME's name, so the
	// old cache is not this worker's, and the next prune drops it.
	const runtimeName = swText.match(/const RUNTIME = "([^"]+)"/)[1];
	const pyDir = join(SITE, "sdk", "pyodide");
	if (existsSync(join(pyDir, "pyodide.asm.wasm"))) {
		const oldHash = createHash("sha256");
		for (const f of readdirSync(pyDir).sort()) oldHash.update(`\0${f}\0`).update(readFileSync(join(pyDir, f)));
		const oldRuntime = `arcade-pyodide-${oldHash.digest("hex").slice(0, 12)}`;
		check("the Python runtime's cache is renamed by the move (its path is in the hash)", runtimeName !== oldRuntime && /^arcade-pyodide-[0-9a-f]{12}$/.test(runtimeName), `${runtimeName} vs ${oldRuntime}`);
		await page.evaluate(async (n) => (await caches.open(n)).put("sdk/v1/pyodide/pyodide.asm.wasm", new Response("old")), oldRuntime);
	}
	const staleRuntime = (await keys()).find((k) => k.startsWith("arcade-pyodide-") && k !== runtimeName);

	// A real deploy changes sw.js too (scripts/assemble.mjs rehashes VERSION).
	const newVersion = oldVersion + "-next";
	writeFileSync(swFile, swText.replace(oldVersion, newVersion));
	await update();
	let st = null;
	const installed = await settle(async () => {
		st = await page.evaluate(async () => {
			const reg = await navigator.serviceWorker.getRegistration();
			return { installing: !!reg?.installing, waiting: !!reg?.waiting, active: reg?.active?.scriptURL, keys: await caches.keys() };
		});
		return !st.installing && !st.waiting && st.keys.includes(newVersion);
	});
	check("a new deploy installs as a whole new snapshot", installed, JSON.stringify(st));
	check("…while the open page keeps the deploy it was loaded from", (await text("lib/games.js")) === before && (await keys()).includes(oldVersion));
	await page.reload({ waitUntil: "domcontentloaded" });
	check("…and the next page load is the new deploy", (await text("lib/games.js")) === "// redeployed");
	// Pruned on a navigation once no open page uses it and its pins are past
	// their grace (sw.js PIN_GRACE_MS, 10 s).
	await new Promise((r) => setTimeout(r, 11_000));
	await page.reload({ waitUntil: "domcontentloaded" });
	const dropped = await settle(async () => !(await keys()).includes(oldVersion), 10_000);
	check("…after which the old snapshot is dropped", dropped, (await keys()).join());
	// Pyodide, cached by the Python game played above, is in a cache of its
	// own (sw.js RUNTIME) that a deploy leaving it alone does not prune.
	if (existsSync(join(SITE, "sdk", "pyodide", "pyodide.asm.wasm")))
		check("…while the Python runtime played once stays on the device", await page.evaluate(async () => !!(await caches.match("sdk/pyodide/pyodide.asm.wasm"))), (await keys()).join());
	if (staleRuntime) check("…and the cache from Pyodide's old address (sdk/v1/pyodide/) is dropped", !(await keys()).includes(staleRuntime), (await keys()).join());
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
