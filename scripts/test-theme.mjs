// scripts/test-theme.mjs — themes, in a browser at 390x844.
//
// The default is paper following the system; the picker switches theme and
// mode and remembers it; a running game's sandboxed frame follows the page
// (attributes, fonts, its canvas colours) in every theme, at 390x844 and
// 354x696, in Chrome and (when it starts here: scripts/playwright.mjs
// launchFirefox) Firefox; and nothing scrolls sideways.

import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { gameFrame, serve, settled } from "./serve.mjs";
import { launchFirefox, loadPlaywright } from "./playwright.mjs";

const TIMEOUT = 30_000;
let failures = 0;
const check = (label, ok, detail = "") => {
	console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
	if (!ok) failures++;
};
const pw = loadPlaywright();
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
	const after = await settled(boardColour, (c) => c !== before, 5000);
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

	// Every theme, in Chrome and Firefox, at 390x844 and Lokesh's 354x696.
	// Paper following a dark system (the default) gave the frame Paper
	// light under a dark page: sdk/v2/runtime.js wrote the choice, "system",
	// into data-mode, which no theme block matches (his phone, 2026-11-15).
	const firefox = await launchFirefox(pw);
	for (const [name, b] of [["Chrome", browser], ["Firefox", firefox]]) {
		if (!b) continue;
		console.log(`\ntheme: a game's frame wears the page's theme, every theme (${name})`);
		for (const [w, h] of [
			[390, 844],
			[354, 696],
		]) {
			for (const [system, choice, want] of [
				["dark", { theme: "paper", mode: "system" }, "paper dark"],
				["light", { theme: "paper", mode: "system" }, "paper light"],
				["light", { theme: "paper", mode: "dark" }, "paper dark"],
				["dark", { theme: "paper", mode: "light" }, "paper light"],
				["light", { theme: "neon", mode: "system" }, "neon dark"],
			]) {
				const c = await b.newContext({ viewport: { width: w, height: h }, colorScheme: system });
				await c.addInitScript((t) => localStorage.setItem("neon.theme", JSON.stringify(t)), choice);
				const tp = await c.newPage();
				await tp.goto(site.url("?game=connect4&fresh=1&mode=bots&start=1"));
				const tf = await gameFrame(tp, TIMEOUT);
				// The colour the frame's own CSS paints, against the page's.
				const look = (pg) => pg.evaluate(() => ({ is: `${document.documentElement.dataset.theme} ${document.documentElement.dataset.mode}`, bg: getComputedStyle(document.body).backgroundColor, ink: getComputedStyle(document.body).color }));
				const [pageLook, frameLook] = [await look(tp), await look(tf)];
				check(`${w}x${h}, a ${system} system, ${choice.theme} ${choice.mode}: page and frame both ${want}, the same paint`, pageLook.is === want && frameLook.is === want && frameLook.bg === pageLook.bg && frameLook.ink === pageLook.ink, { page: pageLook, frame: frameLook });
				if (choice.mode === "system" && choice.theme === "paper" && w === 390) {
					// The system turning while the game runs: the frame turns too.
					await tp.emulateMedia({ colorScheme: system === "dark" ? "light" : "dark" });
					const turned = system === "dark" ? "paper light" : "paper dark";
					const after = await settled(() => look(tf), (l) => l.is === turned, 5000);
					check(`…the system turning ${system === "dark" ? "light" : "dark"} mid-game turns the frame`, after.is === turned && after.bg === (await look(tp)).bg, after);
				}
				await c.close();
			}
		}
	}
	await firefox?.close();

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
	// The fonts are held until the test lets them go, not for a fixed 2.5 s
	// that a slow runner's boot could outlast: a frame that waited for them
	// would never come up.
	let gate = null;
	const holdFonts = () => {
		let open;
		gate = new Promise((r) => (open = r));
		return open;
	};
	await cold.route("**/assets/fonts/*.woff2", (route) => gate.then(() => route.continue().catch(() => {})));
	const fontsGo = holdFonts();
	const cp = await cold.newPage();
	const refused = [];
	cp.on("console", (m) => /Content Security Policy|Refused to/.test(m.text()) && refused.push(m.text()));
	const t0 = Date.now();
	// start=1 (PLAY SOMETHING's address): no quick table in the way, so this times the frame.
	await cp.goto(site.url("?game=neon-fission&fresh=1&mode=bots&start=1"), { waitUntil: "commit" });
	const cf = await gameFrame(cp, TIMEOUT);
	const mounted = Date.now() - t0;
	const early = await faces(cf);
	// The fonts are held, so a frame that waited for them would not come up at
	// all; the bound (generous for a slow runner) still catches a slow boot.
	check("the frame comes up before the fonts have downloaded, without their faces", mounted < 5000 && early.rules === 0, { mounted, ...early });
	await cf.evaluate(() => {
		window.__themeSets = 0;
		window.arcade.on("theme.set", () => window.__themeSets++);
	});
	fontsGo();
	await cf.waitForFunction(() => [...document.fonts].filter((x) => x.status === "loaded").length >= 4, null, { timeout: 15_000 }).catch(() => {});
	const lateFaces = await faces(cf);
	check("…then all four faces arrive as data and load", lateFaces.rules === 4 && lateFaces.late && ["Space Grotesk Variable", "Nunito Variable", "Cascadia Code Variable"].every((x) => lateFaces.loaded.includes(x)), lateFaces);
	check("…and the theme is announced again, so a canvas redraws in them", (await cf.evaluate(() => window.__themeSets)) >= 1);
	check("…with nothing the frame's CSP refuses", !refused.length, refused.slice(0, 2).join(" | "));
	// A game that measured its layout in the fallback font measures again
	// (the runtime dispatches `resize` once the fonts are in): Light Cycles
	// sizes its board from the heights of its text.
	const lightFontsGo = holdFonts();
	const lp = await cold.newPage();
	await lp.goto(site.url("?game=lokeshmohanty/light-cycles&fresh=1&mode=bots&start=1"), { waitUntil: "commit" });
	const lf = await gameFrame(lp, TIMEOUT);
	const board = () => lf.evaluate(() => arena.style.height);
	const atMount = await board();
	await lf.evaluate(() => {
		window.__seen = [];
		addEventListener("resize", () => window.__seen.push(["resize", performance.now()]));
		document.fonts.addEventListener("loadingdone", () => window.__seen.push(["fonts", performance.now()]));
	});
	lightFontsGo();
	await lf.waitForFunction(() => [...document.fonts].filter((x) => x.status === "loaded").length >= 4, null, { timeout: 15_000 }).catch(() => {});
	await lp.waitForTimeout(300);
	const afterFonts = await board();
	const fresh = await lf.evaluate(() => {
		dispatchEvent(new Event("resize"));
		return arena.style.height;
	});
	// The runtime's own resize, apart from the ones the shell's layout causes
	// as its fonts arrive too: fonts posted again, nothing else changing.
	await lf.evaluate(() => (window.__seen = []));
	await lp.evaluate(() => document.querySelector(".game-frame").contentWindow.postMessage({ t: "neon:fonts", css: "" }, "*"));
	await lp.waitForTimeout(300);
	const resized = await lf.evaluate(() => window.__seen.filter(([e]) => e === "resize").length);
	check("Light Cycles' board is laid out again once the fonts arrive (a resize), in the real fonts", resized >= 1 && afterFonts === fresh, { atMount, afterFonts, fresh, resized });
	await cold.close();
	const warmCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
	await warmCtx.addInitScript(() => {
		try {
			localStorage.setItem("neon.rs", "http://127.0.0.1:9");
			localStorage.setItem("neon.sw", "snapshot");
		} catch {}
	});
	const wp = await warmCtx.newPage();
	await wp.goto(site.url("?game=neon-fission&fresh=1&mode=bots&start=1"));
	await gameFrame(wp, TIMEOUT);
	await wp.evaluate(() => navigator.serviceWorker?.ready);
	await wp.waitForFunction(() => !!navigator.serviceWorker?.controller, null, { timeout: 15_000 }).catch(() => {});
	await wp.goto(site.url("?game=neon-fission&fresh=1&mode=bots&start=1"));
	const warmFaces = await faces(await gameFrame(wp, TIMEOUT));
	check("a later visit has every face in the document: no swap", warmFaces.rules === 4 && !warmFaces.late, warmFaces);

	console.log("\ntheme: a game cannot make the shell fetch a font of its choosing");
	// The shell inlines fonts only in the runtime's own stylesheet, and only
	// from assets/fonts/ on this origin. A mark written in a game's own code
	// (another origin, or a same-origin path outside assets/fonts/) is
	// neither fetched nor replaced (review, 2026-11-16).
	const asked = [];
	const elsewhere = createServer((req, res) => {
		asked.push(req.url);
		res.writeHead(200, { "access-control-allow-origin": "*" }).end("REMOTE");
	});
	await new Promise((ok) => elsewhere.listen(0, "127.0.0.1", ok));
	const away = `http://127.0.0.1:${elsewhere.address().port}/beacon.woff2`;
	const sp = await warmCtx.newPage();
	const sameOrigin = [];
	sp.on("request", (r) => /beacon|not-a-font/.test(r.url()) && sameOrigin.push(r.url()));
	await sp.goto(site.url("index.html"));
	await sp.waitForFunction(() => window.NeonArcade?.finishFrameDoc);
	const marks = [`url("neon-font:${away}")`, 'url("neon-font:games/connect4/not-a-font.woff2")', 'url("neon-font:assets/fonts/nunito.woff2?x=1")'];
	const tpl = `<!doctype html><!--neon-frame x--><html><head><style>.a{background:${marks[1]}}</style></head><body><script>const s = '${marks[0]}', t = '${marks[2]}';</script></body></html>`;
	const doc = await sp.evaluate((t) => NeonArcade.finishFrameDoc(t, {}), tpl);
	await sp.waitForTimeout(500);
	check("…no request for a mark in the game's own code", !asked.length && !sameOrigin.length, { asked, sameOrigin });
	check("…and every such mark is left as written", marks.every((m) => doc.includes(m)), doc.slice(0, 300));
	elsewhere.close();
	await warmCtx.close();
} catch (err) {
	check(`unexpected: ${err.message.split("\n")[0]}`, false);
} finally {
	await browser.close();
	site.stop();
}
console.log(failures ? `\n${failures} theme check(s) failed` : "\nall theme checks passed");
process.exit(failures ? 1 : 0);
