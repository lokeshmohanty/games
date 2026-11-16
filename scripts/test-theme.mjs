// scripts/test-theme.mjs — themes, in a browser at 390x844.
//
// The default is paper following the system; the picker switches theme and
// mode and remembers it; a running game's sandboxed frame follows the page
// (attributes, fonts, its canvas colours); and nothing scrolls sideways.

import { existsSync, globSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { gameFrame, serve } from "./serve.mjs";

const require = createRequire(import.meta.url);
const TIMEOUT = 30_000;
let failures = 0;
const check = (label, ok, detail = "") => {
	console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
	if (!ok) failures++;
};
const pw = require(
	[join(homedir(), ".cache", "game-previews", "node_modules", "playwright"), ...globSync(join(homedir(), ".npm", "_npx", "*", "node_modules", "playwright"))].find(existsSync),
);
const chrome = [process.env.CHROME, "/run/current-system/sw/bin/google-chrome-stable", "/run/current-system/sw/bin/chromium", "/usr/bin/google-chrome"].filter(Boolean).find(existsSync);
const site = await serve(8739);
const browser = await pw.chromium.launch({ executablePath: chrome, args: ["--no-sandbox"] });
const attrs = (p) => p.evaluate(() => ({ ...document.documentElement.dataset }));

try {
	console.log("\ntheme: the default");
	for (const scheme of ["light", "dark"]) {
		const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: scheme });
		const p = await ctx.newPage();
		await p.goto(site.url("index.html"));
		const a = await attrs(p);
		check(`a ${scheme} system gets paper, ${scheme}`, a.theme === "paper" && a.mode === scheme, a);
		await ctx.close();
	}

	console.log("\ntheme: the picker");
	const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "light" });
	const p = await ctx.newPage();
	p.on("pageerror", (e) => check(`no page error (${e.message})`, false));
	await p.goto(site.url("index.html"));
	await p.locator(".site-menu-btn").click();
	await p.locator(".site-menu .acct-theme").click();
	await p.locator('.theme-choice[data-theme="neon"]').click();
	let a = await attrs(p);
	check("Neon from the portal's Theme sheet", a.theme === "neon" && a.mode === "dark", a);
	check("…repaints the page", (await p.evaluate(() => getComputedStyle(document.body).backgroundColor)) === "rgb(10, 10, 10)");
	check("…has no light/dark choice of its own", (await p.locator(".theme-choice[data-mode]").count()) === 0);
	await p.locator('.theme-choice[data-theme="paper"]').click();
	await p.locator('.theme-choice[data-mode="dark"]').click();
	a = await attrs(p);
	check("Paper, dark, by choice on a light system", a.theme === "paper" && a.mode === "dark", a);
	check("the sheet fits the phone", await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
	await p.reload();
	a = await attrs(p);
	check("the choice survives a reload", a.theme === "paper" && a.mode === "dark", a);
	const fonts = await p.evaluate(async () => {
		await document.fonts.ready;
		return {
			h1: getComputedStyle(document.querySelector("h1")).fontFamily,
			meta: getComputedStyle(document.querySelector(".game-meta")).fontFamily,
			loaded: [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family),
		};
	});
	check("titles in Space Grotesk, values in Cascadia Code, both loaded", /Space Grotesk/.test(fonts.h1) && /Cascadia/.test(fonts.meta) && fonts.loaded.some((f) => /Space Grotesk/.test(f)), fonts);

	console.log("\ntheme: a game's frame follows the page");
	await p.goto(site.url("?game=connect4&fresh=1"));
	await p.locator("button", { hasText: "SINGLE PLAYER" }).first().click();
	await p.locator("button", { hasText: "START GAME" }).first().click();
	const f = await gameFrame(p, TIMEOUT);
	a = await f.evaluate(() => ({ ...document.documentElement.dataset }));
	check("the frame starts in the page's theme", a.theme === "paper" && a.mode === "dark", { frame: a, page: await attrs(p), saved: await p.evaluate(() => localStorage.getItem("neon.theme")), url: p.url() });
	const boardColour = () =>
		f.evaluate(() => {
			const c = document.querySelector("#board");
			const [r, g, b] = c.getContext("2d").getImageData(2, 2, 1, 1).data;
			return `${r},${g},${b}`;
		});
	const before = await boardColour();
	await p.evaluate(() => NeonArcade.theme.set({ theme: "neon" }));
	await f.waitForFunction(() => document.documentElement.dataset.theme === "neon", null, { timeout: 5000 }).catch(() => {});
	a = await f.evaluate(() => ({ ...document.documentElement.dataset }));
	check("switching on the page switches the frame", a.theme === "neon", a);
	await p.waitForTimeout(200);
	const after = await boardColour();
	check("…and the game repaints its canvas in the new colours", before !== after, `${before} → ${after}`);
	// A v2 frame has the theme as values (sdk/v2/runtime.js arcade.theme).
	const same = await Promise.all([p.evaluate(() => NeonArcade.palette().bg), f.evaluate(() => window.arcade?.theme?.tokens.bg ?? NeonArcade.palette().bg)]);
	check("the frame's palette is the page's", same[0] === same[1], same);
	const ff = await f.evaluate(async () => {
		await document.fonts.ready;
		return [...document.fonts].filter((x) => x.status === "loaded").map((x) => x.family);
	});
	check("the frame has the fonts too (inlined: it may load nothing)", ff.some((x) => /Space Grotesk|Nunito|Cascadia/.test(x)), ff);
	await ctx.close();

	console.log("\ntheme: a first cold visit does not wait for the frame's fonts");
	// The fonts not yet on the phone (no worker cache, still downloading)
	// follow the frame (lib/bridge.js finishParts, `neon:fonts` in
	// sdk/v2/runtime.js); a later visit has them in the document, no swap.
	const faces = (fr) =>
		fr.evaluate(() => ({
			rules: [...document.styleSheets].flatMap((s) => [...s.cssRules]).filter((r) => r instanceof CSSFontFaceRule).length,
			loaded: [...document.fonts].filter((x) => x.status === "loaded").map((x) => x.family),
			late: [...document.querySelectorAll("style")].some((s) => /^\s*@font-face/.test(s.textContent)),
		}));
	const cold = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
	await cold.addInitScript(() => {
		try {
			localStorage.setItem("neon.rs", "http://127.0.0.1:9");
		} catch {}
	});
	const slowFonts = (route) => setTimeout(() => route.continue().catch(() => {}), 2500);
	await cold.route("**/assets/fonts/*.woff2", slowFonts);
	const cp = await cold.newPage();
	const refused = [];
	cp.on("console", (m) => /Content Security Policy|Refused to/.test(m.text()) && refused.push(m.text()));
	const t0 = Date.now();
	await cp.goto(site.url("?game=neon-fission&fresh=1&mode=bots"), { waitUntil: "commit" });
	const cf = await gameFrame(cp, TIMEOUT);
	const mounted = Date.now() - t0;
	const early = await faces(cf);
	check("the frame comes up before the fonts have downloaded, without their faces", mounted < 2500 && early.rules === 0, { mounted, ...early });
	await cf.evaluate(() => {
		window.__themeSets = 0;
		window.arcade.on("theme.set", () => window.__themeSets++);
	});
	await cf.waitForFunction(() => [...document.fonts].filter((x) => x.status === "loaded").length >= 4, null, { timeout: 15_000 }).catch(() => {});
	const lateFaces = await faces(cf);
	check("…then all four faces arrive as data and load", lateFaces.rules === 4 && lateFaces.late && ["Space Grotesk Variable", "Nunito Variable", "Cascadia Code Variable"].every((x) => lateFaces.loaded.includes(x)), lateFaces);
	check("…and the theme is announced again, so a canvas redraws in them", (await cf.evaluate(() => window.__themeSets)) >= 1);
	check("…with nothing the frame's CSP refuses", !refused.length, refused.slice(0, 2).join(" | "));
	await cold.close();
	const warmCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
	await warmCtx.addInitScript(() => {
		try {
			localStorage.setItem("neon.rs", "http://127.0.0.1:9");
			localStorage.setItem("neon.sw", "snapshot");
		} catch {}
	});
	const wp = await warmCtx.newPage();
	await wp.goto(site.url("?game=neon-fission&fresh=1&mode=bots"));
	await gameFrame(wp, TIMEOUT);
	await wp.evaluate(() => navigator.serviceWorker?.ready);
	await wp.waitForFunction(() => !!navigator.serviceWorker?.controller, null, { timeout: 15_000 }).catch(() => {});
	await wp.goto(site.url("?game=neon-fission&fresh=1&mode=bots"));
	const warmFaces = await faces(await gameFrame(wp, TIMEOUT));
	check("a later visit has every face in the document: no swap", warmFaces.rules === 4 && !warmFaces.late, warmFaces);
	await warmCtx.close();
} catch (err) {
	check(`unexpected: ${err.message.split("\n")[0]}`, false);
} finally {
	await browser.close();
	site.stop();
}
console.log(failures ? `\n${failures} theme check(s) failed` : "\nall theme checks passed");
process.exit(failures ? 1 : 0);
