// scripts/serve.mjs — the repo over http://127.0.0.1, for the browser tests.
//
// Framed games (lib/bridge.js) are fetched and inlined by the shell, and
// fetch() cannot read file:// — so the suites that mount games serve the repo
// the way `just run` does. Same python3 server test-pwa.mjs uses.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/**
 * What is served: the built site (pnpm build → dist/, docs/spa.md) — the
 * shell is one page bundled by Vite since 2026-11-15, so the repo itself no
 * longer runs as it stands. NEON_SERVE_SRC=1 serves the repo instead.
 */
const DIST = resolve(ROOT, process.env.NEON_DIST || "dist"); // as vite.config.ts
export const SITE_DIR = !process.env.NEON_SERVE_SRC && existsSync(join(DIST, "index.html")) ? DIST : ROOT;

/**
 * Added to every test's fixed ports (NEON_PORT_OFFSET=100 …), so two test
 * runs — two agents, or a test beside `just run` — do not share a server.
 */
export const PORT_OFFSET = Number(process.env.NEON_PORT_OFFSET ?? 0) || 0;

/**
 * Start serving SITE_DIR (or `dir`); returns { base, url(path), stop() } once
 * it answers.
 */
export async function serve(port, dir = SITE_DIR) {
	port += PORT_OFFSET;
	const server = await spawnServer("python3", ["-u", "-m", "http.server", String(port), "--bind", "127.0.0.1"], { cwd: dir }, /Serving HTTP on/);
	const base = `http://127.0.0.1:${port}`;
	return { base, url: (p) => `${base}/${p}`, stop: () => server.kill() };
}

/**
 * Spawn a server and resolve once it says it is listening (`ready`, matched
 * on its stdout): proof that *this* process holds the port. Answering on the
 * port proves nothing: a suite run just before on the same port can still be
 * shutting down, answer the check, then go, while this one failed to bind
 * and exited unseen (suites in a CI shard run back to back, and share ports).
 * A server that exits first (the port still taken) is started again until
 * `ms` pass, then this throws with its last words. Killed when we exit.
 */
export async function spawnServer(cmd, args, opts, ready, ms = 20_000) {
	const end = Date.now() + ms;
	for (;;) {
		const child = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
		const kill = () => {
			try {
				child.kill();
			} catch {}
		};
		process.on("exit", kill);
		let said = "";
		const up = await new Promise((done) => {
			const timer = setTimeout(() => done(false), Math.max(0, end - Date.now()));
			const hear = (d) => {
				said = (said + d).slice(-2000);
				if (ready.test(said)) {
					clearTimeout(timer);
					done(true);
				}
			};
			child.stdout.on("data", hear);
			child.stderr.on("data", (d) => (said = (said + d).slice(-2000)));
			child.on("exit", () => {
				clearTimeout(timer);
				done(false);
			});
		});
		if (up) {
			// Drained from here on, so a chatty server never blocks on a full pipe.
			child.stdout.resume();
			child.stderr.resume();
			return child;
		}
		kill();
		process.off("exit", kill);
		if (Date.now() >= end) throw new Error(`${cmd} ${args.join(" ")} did not come up in ${ms / 1000} s: ${said.trim().split("\n").slice(-2).join(" / ")}`);
		await new Promise((r) => setTimeout(r, 250));
	}
}

/**
 * The frame a framed game runs in, once its runtime is up — for tests that
 * reach into the game (`__game.handle.debug()`), which now lives there.
 */
export async function gameFrame(page, timeout = 30_000) {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		for (const f of page.frames()) {
			if (f === page.mainFrame()) continue;
			try {
				if (await f.evaluate(() => !!window.__game?.handle)) return f;
			} catch {}
		}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error("no game frame came up");
}

/**
 * Where the running game's DOM and `__game.handle` live: its frame when it is
 * framed, the page itself for a game still mounted in-page. Both publish
 * `window.__game.handle`, so a test's expressions run unchanged in either.
 */
export async function gameScope(page, timeout = 30_000) {
	const framed = await page.evaluate(() => !!document.querySelector(".game-frame"));
	return framed ? gameFrame(page, timeout) : page;
}

/**
 * Before clicking into a game frame: bring the page to the front and let it
 * draw twice. A sandboxed frame is its own process, and Chromium routes a click
 * into it from the page's last drawn frame — a background page that has not
 * drawn since the game mounted sends the click to the <iframe> element instead.
 * The frame draws in its own process, so it is waited for too, then the page
 * once more, so that the page's next drawn frame holds the game frame's.
 */
export async function readyToClick(page) {
	const twice = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
	await page.bringToFront();
	await page.evaluate(twice);
	// Only frames on show: a hidden one draws nothing, so would only wait.
	const frames = [];
	for (const f of page.frames()) {
		if (f === page.mainFrame() || f.isDetached()) continue;
		const el = await f.frameElement().catch(() => null);
		if (el && (await el.isVisible().catch(() => false))) frames.push(f);
	}
	// A frame on its way out may never answer: a second, then go on.
	await Promise.all(frames.map((f) => Promise.race([f.evaluate(twice).catch(() => {}), new Promise((r) => setTimeout(r, 1000))])));
	await page.evaluate(twice);
}

/**
 * Read `read()` until `ok(value)`, or `ms` pass: the last value either way, so
 * the check still makes its own verdict and shows what it saw. For state that
 * follows an action a beat later on a slow runner, where a single read (or a
 * fixed sleep, then a read) races it. Never for a negative check: "nothing
 * happens within N ms" is a wait of its own.
 */
export async function settled(read, ok = Boolean, ms = 10_000, every = 100) {
	const end = Date.now() + ms;
	let value = await read();
	while (!ok(value) && Date.now() < end) {
		await new Promise((r) => setTimeout(r, every));
		value = await read();
	}
	return value;
}
