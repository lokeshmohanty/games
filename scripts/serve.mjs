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
	const server = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1"], {
		cwd: dir,
		stdio: "ignore",
	});
	const stop = () => {
		try {
			server.kill();
		} catch {}
	};
	process.on("exit", stop);
	const base = `http://127.0.0.1:${port}`;
	for (let i = 0; i < 50; i++) {
		try {
			if ((await fetch(base + "/index.html")).ok) break;
		} catch {}
		await new Promise((r) => setTimeout(r, 100));
	}
	return { base, url: (p) => `${base}/${p}`, stop };
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
 */
export async function readyToClick(page) {
	await page.bringToFront();
	await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

/**
 * SINGLE PLAYER of a game whose seats leave a choice opens on the quick
 * table (lib/party.js tableBlock, 2026-11-17): tap its START GAME, as a
 * person would. Waits for the table or the game, whichever comes; true when
 * there was a table.
 */
export async function passTable(page, timeout = 30_000) {
	const shown = () => {
		const go = document.querySelector(".quick-table .quick-go button");
		return go && go.getClientRects().length ? "table" : window.__party?.game ? "game" : null;
	};
	const which = await (await page.waitForFunction(shown, null, { timeout })).jsonValue();
	if (which === "table") await page.locator(".quick-table .quick-go button").click({ timeout });
	return which === "table";
}
