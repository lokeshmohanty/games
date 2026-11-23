// scripts/serve.mjs — the repo over http://127.0.0.1, for the browser tests.
//
// Framed games (lib/bridge.js) are fetched and inlined by the shell, and
// fetch() cannot read file:// — so the suites that mount games serve the repo
// the way `just run` does. Same python3 server test-pwa.mjs uses.

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
 * Whether the site served lists community game `id` ("owner/game") in
 * community/catalog.js. A suite's block for a game that only an unmerged
 * branch has (built with NEON_PIN_OVERRIDE) skips, saying so, when the
 * registry's pin does not have it yet — so main stays green between the
 * games repo's merge and the pin's.
 */
export function communityHas(id) {
	const file = join(SITE_DIR, "community", "catalog.js");
	return existsSync(file) && readFileSync(file, "utf8").includes(`"id": ${JSON.stringify(id)}`);
}

/**
 * Does the registry list `owner/game` (registry/<owner>/*.json)? A test may
 * skip a community game only while it is not listed yet; once it is, a game
 * missing from the catalog is a failure, never a quiet skip.
 */
export function registryLists(id) {
	const [owner, game] = id.split("/");
	const dir = join(ROOT, "registry", owner);
	if (!existsSync(dir)) return false;
	for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
		try {
			if ((JSON.parse(readFileSync(join(dir, f), "utf8")).games ?? []).includes(game)) return true;
		} catch {}
	}
	return false;
}

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

/**
 * A phone's two floors (docs/index.md "Real-device findings"): every tap
 * target at least 44x44 CSS px and every line of text at least 12px, read
 * from the computed sizes of what is on screen under the `roots` selectors
 * (never from the stylesheet). Returns what falls short — `{ taps, text }`,
 * each entry `[class, text, …sizes]` — and how many of each were measured.
 * A hidden or see-through (opacity 0) element is not on screen.
 *
 * Options, for a whole game frame (scripts/test-taps.mjs):
 *
 *   - `hit: true` — the targets as a thumb meets them. Every enabled real
 *     control (a button, a link, a field…, also one inside another), plus
 *     the outermost element that only says `cursor: pointer` (a
 *     `<div onclick>` swatch), unless it sits inside a control or another
 *     such element, whose tap it is. Disabled or inert ones are left out
 *     first. Each is measured twice: its box, and its **hit area** — how far
 *     a tap from its centre still lands on it (elementFromPoint, a pixel at
 *     a time, to 40px past the box), which counts padding or a ::before that
 *     widens it and anything on top that narrows it. A tap entry is then
 *     `[class, text, w, h, hitW, hitH, why]`: under the floor, off the
 *     screen, starting under `band` (the shell's top band, 52px), or
 *     **covered** (what is under its centre is something else) — unless it
 *     is inside `under`, a selector for what a step covers on purpose (a
 *     game's end overlay over its board); those are counted in `covered`.
 *   - `exempt: [{ sel, tap?, text?, upTo?, why }]` — inside `sel`, on a
 *     window at most `upTo` px wide (any, without it), that floor instead.
 *     One that let an element through which the usual floor would not is
 *     listed in `allowed` (`[sel, why]`), so an exemption is a reason
 *     someone can read, not a hole.
 */
export function phoneFloors(page, roots, { hit = false, exempt = [], band = 0, under = null } = {}) {
	return page.evaluate(
		([roots, hit, exempt, band, under]) => {
			const shown = (n) => {
				if (!n.getClientRects().length) return false;
				for (let e = n; e; e = e.parentElement) {
					const s = getComputedStyle(e);
					if (s.visibility === "hidden" || s.opacity === "0") return false;
				}
				return true;
			};
			const allowed = new Map();
			/** The floor `n` is held to; `short(floor)` says whether it falls under one. */
			const floor = (n, kind, base, short) => {
				const e = exempt.find((x) => x[kind] != null && innerWidth <= (x.upTo ?? Infinity) && n.closest(x.sel));
				if (!e || !short(base)) return base;
				if (!short(e[kind])) allowed.set(e.why, e.sel); // by reason: one selector may have a floor per width
				return e[kind];
			};
			const all = [...document.querySelectorAll(roots)].flatMap((r) => [r, ...r.querySelectorAll("*")]).filter(shown);
			const what = (n) => [String(n.className || n.tagName).slice(0, 40), n.textContent.trim().slice(0, 24)];
			const texts = all.filter((n) => [...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim()));
			const SEL = "a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button]";
			const text = () =>
				texts
					.map((n) => {
						const px = parseFloat(getComputedStyle(n).fontSize);
						return [...what(n), px, floor(n, "text", 12, (f) => px < f)];
					})
					.filter((x) => x[2] < x[3])
					.map((x) => x.slice(0, 3));
			const controls = all.filter((n) => n.matches(SEL));
			if (!hit) {
				return {
					measured: { taps: controls.length, text: texts.length },
					text: text(),
					taps: controls
						.map((n) => {
							const r = n.getBoundingClientRect();
							const [w, h] = [Math.round(r.width), Math.round(r.height)];
							return [...what(n), w, h, floor(n, "tap", 44, (f) => w < f || h < f)];
						})
						.filter((x) => x[2] < x[4] || x[3] < x[4])
						.map((x) => x.slice(0, 4)),
					allowed: [...allowed].map(([why, sel]) => [sel, why]),
				};
			}
			const live = (n) => !n.matches(":disabled") && n.getAttribute("aria-disabled") !== "true" && !n.closest("[inert]");
			// `cursor` is inherited: only the outermost element that says pointer.
			const pointer = all.filter((n) => !n.matches(SEL) && getComputedStyle(n).cursor === "pointer" && !(n.parentElement && getComputedStyle(n.parentElement).cursor === "pointer"));
			// A pointer-only element inside a control (live or not) or another one is that one's tap.
			const own = pointer.filter((n) => !controls.some((c) => c.contains(n)) && !pointer.some((o) => o !== n && o.contains(n)));
			const taps = [...controls, ...own].filter(live);
			const vw = innerWidth;
			const vh = innerHeight;
			const short = [];
			let measured = 0;
			let covered = 0;
			for (const n of taps) {
				const r = n.getBoundingClientRect();
				const cx = r.left + r.width / 2;
				const cy = r.top + r.height / 2;
				const on = (x, y) => {
					if (x < 0 || y < 0 || x >= vw || y >= vh) return false;
					const at = document.elementFromPoint(x, y);
					return !!at && (at === n || n.contains(at));
				};
				const off = r.left < -0.5 || r.top < -0.5 || r.right > vw + 0.5 || r.bottom > vh + 0.5;
				if (!off && !on(cx, cy)) {
					if (under && n.closest(under)) {
						covered++; // under an overlay, on purpose: not a target now
						continue;
					}
					const top = document.elementFromPoint(cx, cy);
					short.push([...what(n), Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10, 0, 0, `covered by ${top ? String(top.className || top.tagName).slice(0, 40) : "nothing"}`]);
					continue;
				}
				measured++;
				const run = (dx, dy, max) => {
					let k = 0;
					while (k < max && on(cx + dx * (k + 1), cy + dy * (k + 1))) k++;
					return k;
				};
				const hitW = run(-1, 0, r.width / 2 + 40) + run(1, 0, r.width / 2 + 40) + 1;
				const hitH = run(0, -1, r.height / 2 + 40) + run(0, 1, r.height / 2 + 40) + 1;
				const min = floor(n, "tap", 44, (f) => Math.min(r.width, r.height) < f - 0.5 || Math.min(hitW, hitH) < f - 0.5);
				const why = [
					Math.min(r.width, r.height) < min - 0.5 || Math.min(hitW, hitH) < min - 0.5 ? `under ${min}px` : null,
					off ? "off the screen" : null,
					r.top < band - 0.5 ? "under the top band" : null,
				].filter(Boolean);
				if (why.length) short.push([...what(n), Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10, hitW, hitH, why.join(", ")]);
			}
			return {
				measured: { taps: measured, text: texts.length },
				covered,
				text: text(),
				taps: short,
				allowed: [...allowed].map(([why, sel]) => [sel, why]),
			};
		},
		[roots, hit, exempt, band, under],
	);
}

/** The two phones every game is held to: 390x844, and Lokesh's OnePlus at 354x696 (2026-11-15). */
export const PHONE_SIZES = [
	[390, 844],
	[354, 696],
];

/**
 * The game on screen in frame `F` of page `p` at 390x844 and at 354x696
 * (Lokesh's OnePlus): no text under 12px, no tap under 44px (phoneFloors,
 * from computed sizes), no sideways scroll, each size a `check(label, ok,
 * detail)` of the caller's. The page is left at 390x844.
 *
 * Options: phoneFloors' (`hit`, `exempt`, `band`); `min`, the fewest targets
 * for the screen to count as the one meant; `extra(w, h)`, more to hold at
 * each size — what falls short, or null. Returns the exemptions used, as
 * phoneFloors' `allowed`.
 */
export async function phoneSizes(p, F, label, check, { timeout = 30_000, min = 0, extra = null, ...floors } = {}) {
	const allowed = new Map();
	for (const [w, h] of PHONE_SIZES) {
		await p.setViewportSize({ width: w, height: h });
		await F.waitForFunction((w) => innerWidth <= w, w, { timeout });
		await F.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))); // after the game's own resize
		const f = await phoneFloors(F, "body", floors);
		const doc = await F.evaluate(() => document.documentElement.scrollWidth);
		const more = extra ? await extra(w, h) : null;
		const ok = !f.text.length && !f.taps.length && f.measured.text > 0 && f.measured.taps >= min && doc <= w && !more;
		check(`${label} at ${w}x${h}: text at least 12px, taps at least 44px${floors.hit ? " (box and hit area)" : ""}, no sideways scroll`, ok, JSON.stringify({ ...f, doc, ...(more ? { more } : {}) }));
		for (const [sel, why] of f.allowed ?? []) allowed.set(why, sel);
	}
	await p.setViewportSize({ width: 390, height: 844 });
	return [...allowed].map(([why, sel]) => [sel, why]);
}
