// scripts/test-rules-screen.mjs — a game's rules (manifest "rules", lib/rules.js),
// in a browser at 390x844.
//
// The first open of a game shows its RULES.md over the running game, once
// per game per device; GOT IT puts it away for good; "?" brings it back any
// time; a game without rules has no "?" and shows nothing; the sheet fits the
// phone in every theme; and with the network gone the rules still come, from
// the service worker's snapshot.
//
// Under automation the first-open sheet is off (so the other suites can
// drive games); localStorage "neon.rules" = "on" turns it back on here.

import { existsSync, globSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gameScope, serve } from "./serve.mjs";

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TIMEOUT = 30_000;
let failures = 0;
const check = (label, ok, detail = "") => {
	console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
	if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pw = require(
	[join(ROOT, "node_modules", "playwright"), join(homedir(), ".cache", "game-previews", "node_modules", "playwright"), ...globSync(join(homedir(), ".npm", "_npx", "*", "node_modules", "playwright"))].find(existsSync),
);
const chrome = [process.env.CHROME, "/run/current-system/sw/bin/google-chrome-stable", "/run/current-system/sw/bin/chromium", "/usr/bin/google-chrome"].filter(Boolean).find(existsSync);
const site = await serve(8746);
const browser = await pw.chromium.launch({ executablePath: chrome, args: ["--no-sandbox"] });

/** A phone that never reaches the real room server, with the first-open sheet on. */
async function phone({ theme = null, scheme = "light", init = null } = {}) {
	const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: scheme });
	await ctx.addInitScript((theme) => {
		try {
			localStorage.setItem("neon.rs", "http://127.0.0.1:9");
			localStorage.setItem("neon.rules", "on");
			if (theme) localStorage.setItem("neon.theme", JSON.stringify(theme));
		} catch {}
	}, theme);
	if (init) await ctx.addInitScript(init);
	const page = await ctx.newPage();
	page.on("pageerror", (e) => check(`no page error (${e.message})`, false));
	return { ctx, page };
}

/** A game with bots, straight from a card's SINGLE PLAYER (?mode=bots). */
async function play(page, id) {
	await page.goto(site.url(`index.html?game=${id}&mode=bots`));
	await page.waitForFunction((id) => window.__game?.id === id || window.__party?.room?.getGame?.() === id, id, { timeout: TIMEOUT });
	await gameScope(page, TIMEOUT);
}

const sheet = (page) => page.locator("dialog.rules-sheet[open]");
const shown = (page, ms = TIMEOUT) =>
	sheet(page)
		.waitFor({ state: "visible", timeout: ms })
		.then(() => true)
		.catch(() => false);
/** The sheet's text has arrived (not the loading line). */
const loaded = (page) => page.waitForFunction(() => document.querySelector("dialog.rules-sheet .rules-body h1"), null, { timeout: TIMEOUT }).then(() => true, () => false);

/** Everything about the sheet and the top buttons that "fits a phone" means. */
function layout(page) {
	return page.evaluate(() => {
		const d = document.querySelector("dialog.rules-sheet[open]");
		const r = (n) => n && n.getBoundingClientRect();
		const body = d?.querySelector(".rules-body");
		const ok = d?.querySelector(".rules-ok");
		const box = r(d);
		const okBox = r(ok);
		const cs = d && getComputedStyle(d);
		const bodyCs = body && getComputedStyle(body);
		return {
			sideways: document.documentElement.scrollWidth > innerWidth,
			inView: !!box && box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight,
			gutter: box ? Math.min(box.left, innerWidth - box.right) : 0,
			okInView: !!okBox && okBox.top >= 0 && okBox.bottom <= innerHeight && okBox.height >= 36,
			bodyScrolls: !!body && (body.scrollHeight <= body.clientHeight + 1 || ["auto", "scroll"].includes(bodyCs.overflowY)),
			bodySideways: !!body && body.scrollWidth > body.clientWidth + 1,
			ink: cs?.color,
			paper: cs?.backgroundColor,
		};
	});
}

/** The party's top buttons: inside the phone, clear of each other and of the site's own links. */
function topBar(page) {
	return page.evaluate(() => {
		const btns = [...document.querySelectorAll(".top-actions > :not([hidden])")].map((b) => b.getBoundingClientRect());
		const over = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
		const others = [...document.querySelectorAll("body > *:not(.top-actions) a, body > *:not(.top-actions) button")]
			.filter((n) => {
				const s = getComputedStyle(n);
				const b = n.getBoundingClientRect();
				return b.width && b.height && b.top < 60 && s.visibility !== "hidden" && n.closest("[hidden]") === null && n.closest("#party-layer, iframe") === null;
			})
			.map((n) => ({ box: n.getBoundingClientRect(), text: n.textContent.trim().slice(0, 20) }));
		return {
			inside: btns.every((b) => b.left >= 0 && b.right <= innerWidth && b.top >= 0),
			apart: btns.every((a, i) => btns.every((b, j) => i === j || !over(a, b))),
			clash: others.filter((o) => btns.some((b) => over(b, o.box))).map((o) => o.text),
		};
	});
}

try {
	console.log("\nrules: the first open of a game");
	{
		const { ctx, page } = await phone();
		await play(page, "connect4");
		check("the first open of Connect 4 shows its rules", await shown(page));
		check("…the RULES.md, rendered (title, an example)", (await loaded(page)) && (await page.evaluate(() => {
			const b = document.querySelector("dialog.rules-sheet .rules-body");
			return /Connect 4/.test(b.querySelector("h1")?.textContent) && [...b.querySelectorAll("h2")].some((h) => /example/i.test(h.textContent));
		})));
		check("…over the game, which mounted underneath", await page.evaluate(() => !!window.__game?.handle && !!document.querySelector("iframe")));
		check("…not yet marked seen while it is open", (await page.evaluate(() => localStorage.getItem("neon.rules.connect4"))) === null);
		const l = await layout(page);
		check("…fits 390x844: inside the screen, a gutter, GOT IT in view, no sideways scroll", l.inView && l.gutter >= 8 && l.okInView && !l.sideways && !l.bodySideways && l.bodyScrolls, l);
		await page.locator("dialog.rules-sheet .rules-ok").click();
		check("GOT IT puts it away", !(await sheet(page).count()));
		// The close event comes a task after close(), so wait for it.
		const remembered = await page.waitForFunction(() => localStorage.getItem("neon.rules.connect4") === "seen", null, { timeout: 5000 }).then(() => true, () => false);
		check("…and remembers it for this game", remembered);
		const rulesBtn = page.locator(".top-actions .top-rules");
		check('the "?" is in the party\'s top buttons', await rulesBtn.isVisible());
		check('…labelled for the game ("How to play Connect 4")', /How to play Connect 4/.test((await rulesBtn.getAttribute("aria-label")) ?? ""));
		const t = await topBar(page);
		check("…the top buttons fit the phone, apart, clear of the site's links", t.inside && t.apart && !t.clash.length, t);

		await play(page, "connect4");
		await sleep(1500);
		check("a second open of the same game shows nothing", !(await sheet(page).count()));
		await rulesBtn.click();
		check('"?" opens the rules any time', (await shown(page, 5000)) && (await loaded(page)));
		check("…while the game keeps running underneath", await page.evaluate(() => !!window.__game?.handle));
		await page.keyboard.press("Escape");
		check("…and Escape closes them", !(await sheet(page).count()));
		await rulesBtn.click();
		await shown(page, 5000);
		await page.locator("dialog.rules-sheet .neon-sheet-x").click();
		check("…as does ✕", !(await sheet(page).count()));

		await play(page, "tic-tac-toe-js");
		check("another game's first open shows its own rules", (await shown(page)) && (await loaded(page)) && /Tic Tac Toe/.test(await page.locator("dialog.rules-sheet h1").textContent()));
		await page.locator("dialog.rules-sheet .rules-ok").click();
		await ctx.close();
	}

	console.log("\nrules: a game without rules");
	{
		// Tic Tac Toe (JS) with its manifest's "rules" taken away as it registers.
		const { ctx, page } = await phone({
			init: () => {
				const NA = (window.NeonArcade = window.NeonArcade || {});
				let reg;
				Object.defineProperty(NA, "registerFramedGame", {
					configurable: true,
					get: () => reg,
					set: (fn) => {
						reg = (def) => fn(def.id === "tic-tac-toe-js" ? { ...def, rules: undefined } : def);
					},
				});
			},
		});
		await play(page, "tic-tac-toe-js");
		await sleep(1500);
		check("no rules sheet", !(await sheet(page).count()));
		check('no "?"', !(await page.locator(".top-actions .top-rules").isVisible()));
		check("…while feedback and favourite are there", await page.locator(".top-actions .top-fav").isVisible());
		await ctx.close();
	}

	console.log("\nrules: fits 390x844 in every theme");
	for (const [name, theme, scheme] of [
		["paper, light", { theme: "paper", mode: "light" }, "light"],
		["paper, dark", { theme: "paper", mode: "dark" }, "dark"],
		["neon", { theme: "neon", mode: "dark" }, "dark"],
	]) {
		const { ctx, page } = await phone({ theme, scheme });
		await play(page, "neon-bid"); // the longest rules
		const ok = (await shown(page)) && (await loaded(page));
		const l = await layout(page);
		check(`${name}: the sheet fits, GOT IT in view, no sideways scroll`, ok && l.inView && l.okInView && !l.sideways && !l.bodySideways && l.bodyScrolls, l);
		check(`${name}: ink is not the paper's colour`, !!l.ink && l.ink !== l.paper, l);
		await page.screenshot({ path: join(process.env.NEON_SHOTS ?? "/tmp", `rules-${name.replace(/\W+/g, "-")}.png`) }).catch(() => {});
		await page.locator("dialog.rules-sheet .rules-ok").click();
		const t = await topBar(page);
		check(`${name}: the top buttons fit, apart, clear of the site's links`, t.inside && t.apart && !t.clash.length, t);
		await page.screenshot({ path: join(process.env.NEON_SHOTS ?? "/tmp", `rules-top-${name.replace(/\W+/g, "-")}.png`) }).catch(() => {});
		await ctx.close();
	}

	console.log("\nrules: offline");
	{
		const { ctx, page } = await phone({ init: () => {
				try {
					localStorage.setItem("neon.sw", "snapshot");
				} catch {} // the game's sandboxed frame has no storage
			},
		});
		await page.goto(site.url("index.html"));
		await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 20_000 }).catch(() => {});
		// Poll from Node (an async predicate does not wait in Playwright 1.62).
		let cached = false;
		for (let i = 0; i < 100 && !cached; i++) {
			cached = await page.evaluate(async () => {
				for (const k of await caches.keys()) if (await (await caches.open(k)).match("./games/undercover/RULES.md")) return true;
				return false;
			});
			if (!cached) await sleep(200);
		}
		check("the rules are in the service worker's snapshot", cached);
		await ctx.route("**/*", (route) => route.abort("internetdisconnected"));
		await play(page, "neon-survival-mp");
		check("with no network, the first open still shows the rules", (await shown(page)) && (await loaded(page)) && /Neon Survival/.test(await page.locator("dialog.rules-sheet h1").textContent()));
		await ctx.close();
	}
} finally {
	await browser.close();
	site.close?.();
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
