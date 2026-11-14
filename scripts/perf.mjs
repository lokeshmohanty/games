// scripts/perf.mjs — how fast the arcade feels on a phone, measured.
//
// The baseline for the speed refactor (docs/perf.md). A 390x844 phone with 4x
// CPU throttle and a Slow-4G-ish link, three scenarios, each cold (a fresh
// browser profile) and warm (the service worker in control after a visit):
//
//   portal       index.html: FCP, LCP, DOMContentLoaded, load, bytes
//   bots game    PLAY WITH BOTS on Connect 4: time to the START GAME button,
//                then the tap, then time to the game's frame being mounted
//   leaderboard  leaderboard.html: FCP, LCP, load, bytes
//
// The link is a throttling proxy in front of the static server, not CDP's
// network emulation: CDP throttles only the page, so a service worker's own
// fetches (network-first code) would run at loopback speed and the warm runs
// would flatter it. The proxy charges every request the same latency and
// shares one bandwidth budget between them, whoever asks.
//
// The room server and the worker API are real (lokeshmohanty.workers.dev) and
// are NOT throttled: the bots path probes them before it seats anyone, and
// that wait is part of what is measured — on a real phone it is slower still.
// Medians of --runs N (default 3).
//
//   node scripts/perf.mjs [--runs N] [--label name] [--out results.json]
//                         [--only portal,bots,leaderboard]
//
// Caveat: CPU throttling reaches the page's process only. A game runs in a
// sandboxed frame, which is its own process, so its own start-up inside
// "to frame" runs unthrottled. That part is small; the waits before it are not.

import { existsSync, globSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { gameFrame, serve } from "./serve.mjs";

const require = createRequire(import.meta.url);
const arg = (name, dflt) => {
	const i = process.argv.indexOf(`--${name}`);
	return i > 0 ? process.argv[i + 1] : dflt;
};
const RUNS = Number(arg("runs", 3));
const LABEL = arg("label", "current");
const OUT = arg("out", null);
const LOAD_CAP = 60_000;
const ONLY = arg("only", null)?.split(","); // e.g. --only portal,leaderboard

const pw = require(
	[join(homedir(), ".cache", "game-previews", "node_modules", "playwright"), ...globSync(join(homedir(), ".npm", "_npx", "*", "node_modules", "playwright"))].find(existsSync),
);
const chrome = [process.env.CHROME, "/run/current-system/sw/bin/google-chrome-stable", "/run/current-system/sw/bin/chromium", "/usr/bin/google-chrome"].filter(Boolean).find(existsSync);

const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const NETWORK = { latency: 150, downloadThroughput: 200_000 };

/**
 * A Slow-4G-ish link in front of `target`: each request waits `latency`, and
 * response bytes leave through one shared bucket of `downloadThroughput` B/s.
 */
function throttledProxy(target, port) {
	let free = 0; // when the shared link is next idle (ms epoch)
	const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
	const server = createServer(async (req, res) => {
		await sleep(NETWORK.latency);
		const up = request(target + req.url, { method: req.method, headers: { ...req.headers, host: new URL(target).host } }, async (r) => {
			res.writeHead(r.statusCode, r.headers);
			for await (const chunk of r) {
				for (let i = 0; i < chunk.length; i += 16_384) {
					const part = chunk.subarray(i, i + 16_384);
					const now = Date.now();
					free = Math.max(free, now) + (part.length / NETWORK.downloadThroughput) * 1000;
					await sleep(free - now);
					res.write(part);
				}
			}
			res.end();
		});
		up.on("error", () => res.destroy());
		req.pipe(up);
	});
	return new Promise((ok) => server.listen(port, "127.0.0.1", () => ok({ url: (p) => `http://127.0.0.1:${port}/${p}`, stop: () => server.close() })));
}

// Collected in the page from the first byte: paint and LCP entries are only
// buffered for observers, so the observer goes in before any script runs.
const VITALS = () => {
	window.__perf = { lcp: 0 };
	new PerformanceObserver((l) => {
		for (const e of l.getEntries()) window.__perf.lcp = e.startTime;
	}).observe({ type: "largest-contentful-paint", buffered: true });
};

const readVitals = (page) =>
	page.evaluate(() => {
		const nav = performance.getEntriesByType("navigation")[0];
		const res = performance.getEntriesByType("resource");
		const fcp = performance.getEntriesByName("first-contentful-paint")[0];
		const sum = (list) => list.reduce((n, r) => n + (r.transferSize || 0), 0);
		const js = res.filter((r) => new URL(r.name).pathname.endsWith(".js"));
		return {
			fcp: fcp ? fcp.startTime : null,
			lcp: window.__perf?.lcp || null,
			dcl: nav ? nav.domContentLoadedEventEnd : null,
			load: nav && nav.loadEventEnd > 0 ? nav.loadEventEnd : null,
			bytes: sum(res) + (nav?.transferSize || 0),
			jsBytes: sum(js),
			jsDecoded: js.reduce((n, r) => n + (r.decodedBodySize || 0), 0),
		};
	});

async function throttle(page) {
	const cdp = await page.context().newCDPSession(page);
	await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
	return cdp;
}

/** A context, warmed (visited once, service worker in control) when asked. */
async function context(browser, warm, url) {
	const ctx = await browser.newContext(PHONE);
	await ctx.addInitScript(VITALS);
	// The deployed site's service worker strategy, not loopback's development
	// network-first (sw.js, lib/pwa.js).
	await ctx.addInitScript(() => localStorage.setItem("neon.sw", "snapshot"));
	if (warm) {
		// The warm-up visit pays the same link, so a gif-heavy portal can take
		// a minute to load; the service worker's install is what is waited for.
		const p = await ctx.newPage();
		await p.goto(url, { waitUntil: "domcontentloaded", timeout: 120_000 });
		await p.waitForLoadState("load", { timeout: 120_000 }).catch(() => {});
		await p.evaluate(() => navigator.serviceWorker?.ready);
		await p.reload({ waitUntil: "domcontentloaded", timeout: 120_000 });
		await p.waitForLoadState("load", { timeout: 120_000 }).catch(() => {});
		await p.waitForFunction(() => !!navigator.serviceWorker?.controller, null, { timeout: 15_000 }).catch(() => {});
		await p.close();
	}
	return ctx;
}

async function settle(page) {
	// LCP is final once the page stops painting; give it a beat past load.
	await page.waitForTimeout(1500);
}

const scenarios = {
	async portal(site, warm) {
		const ctx = await context(this.browser, warm, site.url("index.html"));
		const page = await ctx.newPage();
		await throttle(page);
		// A cold portal can take minutes to reach `load` (every preview gif
		// in view); past LOAD_CAP it is reported as "> cap" rather than waited for.
		await page.goto(site.url("index.html"), { waitUntil: "domcontentloaded", timeout: 120_000 });
		await page.waitForSelector(".game-card");
		await page.waitForLoadState("load", { timeout: LOAD_CAP }).catch(() => {});
		await settle(page);
		const v = await readVitals(page);
		await ctx.close();
		return v;
	},

	async bots(site, warm) {
		const url = site.url("party.html?game=connect4&fresh=1&mode=bots");
		const ctx = await context(this.browser, warm, site.url("index.html"));
		const page = await ctx.newPage();
		await throttle(page);
		const t0 = Date.now();
		await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120_000 });
		const start = page.locator("button", { hasText: "START GAME" }).first();
		let tapNeeded = false;
		let toStart = null;
		const mounted = gameFrame(page, 120_000).then(() => Date.now() - t0);
		const shown = start.waitFor({ timeout: 120_000 }).then(() => Date.now() - t0);
		const first = await Promise.race([mounted.then((t) => ({ mounted: t })), shown.then((t) => ({ start: t }))]);
		if (first.start != null) {
			tapNeeded = true;
			toStart = first.start;
			await start.click();
		}
		const toFrame = await mounted;
		const v = await readVitals(page);
		await ctx.close();
		return { fcp: v.fcp, jsBytes: v.jsBytes, jsDecoded: v.jsDecoded, bytes: v.bytes, toStart, tapNeeded, toFrame };
	},

	async leaderboard(site, warm) {
		const ctx = await context(this.browser, warm, site.url("leaderboard.html"));
		const page = await ctx.newPage();
		await throttle(page);
		await page.goto(site.url("leaderboard.html"), { waitUntil: "domcontentloaded", timeout: 120_000 });
		await page.waitForLoadState("load", { timeout: LOAD_CAP }).catch(() => {});
		await settle(page);
		const v = await readVitals(page);
		await ctx.close();
		return v;
	},
};

const median = (xs) => {
	const s = xs.filter((x) => x != null).sort((a, b) => a - b);
	if (!s.length) return null;
	return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

const origin = await serve(8790);
const site = await throttledProxy(origin.base, 8791);
const browser = await pw.chromium.launch({ executablePath: chrome, args: ["--no-sandbox"] });
const results = { label: LABEL, date: new Date().toISOString(), runs: RUNS, network: NETWORK, cpu: 4, scenarios: {} };

try {
	for (const name of Object.keys(scenarios).filter((n) => !ONLY || ONLY.includes(n))) {
		for (const warm of [false, true]) {
			const key = `${name} (${warm ? "warm" : "cold"})`;
			const samples = [];
			for (let i = 0; i < RUNS; i++) {
				const s = await scenarios[name].call({ browser }, site, warm);
				console.log(`  ${key} run ${i + 1}: ${JSON.stringify(s)}`);
				samples.push(s);
			}
			const fields = Object.keys(samples[0]);
			results.scenarios[key] = Object.fromEntries(
				fields.map((f) => [f, typeof samples[0][f] === "boolean" ? samples.some((s) => s[f]) : median(samples.map((s) => s[f]))]),
			);
		}
	}
} finally {
	await browser.close();
	site.stop();
	origin.stop();
}

const ms = (x) => (x == null ? "–" : `${Math.round(x)} ms`);
const kb = (x) => (x == null ? "–" : `${(x / 1024).toFixed(0)} KB`);
console.log(`\n### ${LABEL} — median of ${RUNS}, 390x844, 4x CPU, 150 ms + 1.6 Mbps shared (proxy)\n`);
console.log("| Scenario | FCP | LCP | DCL | load | to START | tap? | to frame | transferred | JS (wire / decoded) |");
console.log("|---|---|---|---|---|---|---|---|---|---|");
for (const [k, r] of Object.entries(results.scenarios)) {
	console.log(
		`| ${k} | ${ms(r.fcp)} | ${ms(r.lcp)} | ${ms(r.dcl)} | ${r.load == null && r.fcp != null && "dcl" in r ? `> ${LOAD_CAP / 1000} s` : ms(r.load)} | ${ms(r.toStart)} | ${r.tapNeeded == null ? "–" : r.tapNeeded ? "yes" : "no"} | ${ms(r.toFrame)} | ${kb(r.bytes)} | ${kb(r.jsBytes)} / ${kb(r.jsDecoded)} |`,
	);
}
if (OUT) writeFileSync(OUT, JSON.stringify(results, null, 2) + "\n");
