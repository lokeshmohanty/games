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
	await p.locator(".site-bar .acct-theme").click();
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
	await p.goto(site.url("connect4.html"));
	await p.locator("button", { hasText: "PLAY WITH BOTS" }).first().click();
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
	const same = await Promise.all([p.evaluate(() => NeonArcade.palette().bg), f.evaluate(() => NeonArcade.palette().bg)]);
	check("the frame's palette is the page's", same[0] === same[1], same);
	const ff = await f.evaluate(async () => {
		await document.fonts.ready;
		return [...document.fonts].filter((x) => x.status === "loaded").map((x) => x.family);
	});
	check("the frame has the fonts too (inlined: it may load nothing)", ff.some((x) => /Space Grotesk|Nunito|Cascadia/.test(x)), ff);
	await ctx.close();
} catch (err) {
	check(`unexpected: ${err.message.split("\n")[0]}`, false);
} finally {
	await browser.close();
	site.stop();
}
console.log(failures ? `\n${failures} theme check(s) failed` : "\nall theme checks passed");
process.exit(failures ? 1 : 0);
