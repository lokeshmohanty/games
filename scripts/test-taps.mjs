#!/usr/bin/env node
/**
 * test-taps.mjs — inside the community games, every tap target clears 44px
 * and every text 12px, on two phones, in every phase a player sees.
 *
 *   node scripts/test-taps.mjs [game…]    (NEON_TAPS_VERBOSE=1: counts on passing lines too;
 *                                          NEON_TAPS_SHOTS=dir: a screenshot of every step)
 *
 * A real-device pass on Lokesh's Android phone (2026-11-18: 354x696 CSS px at
 * DPR 3.5) found tap targets under 44px and text under 12px inside games —
 * which no suite caught, because each checked the few controls it knew of.
 * This plays each of lokeshmohanty/web-games' six games (registry pin, or
 * NEON_PIN_OVERRIDE) through its setup, play and end, at 390x844 and at that
 * phone's 354x696, and at each step measures the whole game frame with
 * scripts/serve.mjs `phoneFloors` (`hit: true`): every visible, enabled,
 * uncovered target — its box and its hit area — and every text, plus text
 * drawn on a canvas (`canvasText` here). Also: no sideways scroll, and no
 * target under the shell's top band (52px).
 *
 * Exemptions are listed per game with the reason, and printed: a Sudoku cell
 * is a ninth of a 330px board on that phone, and the reason it is still
 * usable (select, then a larger number pad) is the exemption's text.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { gameScope, phoneFloors, readyToClick, serve, settled } from "./serve.mjs";
import { loadPlaywright } from "./playwright.mjs";

const TIMEOUT = 30_000;
const VERBOSE = !!process.env.NEON_TAPS_VERBOSE;
const SHOTS = process.env.NEON_TAPS_SHOTS;
const BAND = 52; // the shell's top band over a game frame (portal link, game buttons)
const PHONES = [
	{ w: 390, h: 844, dpr: 3 },
	{ w: 354, h: 696, dpr: 3.5 }, // the Android phone of the 2026-11-18 pass
];

let failures = 0;
const check = (label, ok, detail = "") => {
	console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail !== "" && (!ok || VERBOSE) ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
	if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * What a game may hold below the floors, and why. Matched by selector inside
 * the game's frame; every one is printed once per run.
 */
const EXEMPT = {
	sudoku: [
		{
			sel: ".su-cell",
			tap: 35,
			why: "a 9 x 9 board on a 354px phone: 9 cells of 44px need 396px, so a cell is 36px there (35px for the last row, 40px at 390). A tap only selects it — highlighting its row, column, box and digit, so a miss shows and costs a second tap — and the digit goes in from the pad, keys 48px tall",
		},
		{ sel: ".su-notes", text: 11, why: "pencil notes are a 3 x 3 grid inside one cell: a third of a 36px cell holds an 11px digit (12px at 390); the digits placed are 21px" },
	],
	battleship: [
		{
			sel: ".bs-grid",
			tap: 39,
			why: "8 squares of 44px need 374px with the board's gaps: on a 354px phone a square is 39.6px (44px at 390). The 2px between squares is the board, not a neighbour, so a tap a little wide does nothing rather than firing at the next square",
		},
	],
	"liars-dice": [],
	"light-cycles": [],
	"bubble-rush": [],
	"draw-guess": [],
};

const chrome = [process.env.CHROME, "/run/current-system/sw/bin/google-chrome-stable", "/run/current-system/sw/bin/chromium", join(homedir(), ".nix-profile", "bin", "google-chrome-stable"), "/usr/bin/google-chrome"]
	.filter(Boolean)
	.find(existsSync);
if (!chrome) {
	console.error("error: no system Chrome found; set CHROME=/path/to/chrome");
	process.exit(1);
}
const { chromium } = loadPlaywright();
const site = await serve(8749);
const browser = await chromium.launch({ executablePath: chrome, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });

/** A touch phone of that size that never reaches the deployed room server. */
async function phone({ w, h, dpr }) {
	const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true, deviceScaleFactor: dpr });
	await ctx.addInitScript(() => {
		try {
			localStorage.setItem("neon.rs", "http://127.0.0.1:9");
		} catch {}
	});
	return ctx;
}
function watch(page) {
	page.on("pageerror", (err) => check(`no page error (${err.message})`, false));
	return page;
}

/** The game with bots, from its SINGLE PLAYER address, `players` seated at the quick table. */
async function solo(page, id, players) {
	await page.goto(site.url(`?game=lokeshmohanty%2F${id}&fresh=1&mode=bots`));
	const which = await (
		await page.waitForFunction(() => {
			const go = document.querySelector(".quick-table .quick-go button");
			return go && go.getClientRects().length ? "table" : window.__party?.game ? "game" : null;
		}, null, { timeout: TIMEOUT })
	).jsonValue();
	if (which === "table") {
		const count = () => page.locator(".quick-table .quick-n").textContent().then(Number);
		for (let k = 0; k < 10 && (await count()) !== players; k++) {
			const now = await count();
			await page.locator(`.quick-table [data-qt="${now < players ? "plus" : "minus"}"]`).click();
			await page.waitForFunction((was) => Number(document.querySelector(".quick-table .quick-n")?.textContent) !== was, now, { timeout: TIMEOUT });
		}
		await page.locator(".quick-table .quick-go button").click();
	}
	await page.waitForFunction(() => window.__game?.handle, null, { timeout: TIMEOUT });
	const G = await gameScope(page, TIMEOUT);
	await readyToClick(page);
	return G;
}

const debug = (G) => G.evaluate(() => window.__game.handle.debug());
/** Every element matching `sel` is on screen and below the band: [top, bottom] of the lot, and whether. */
async function onScreen(G, sel) {
	const r = await G.evaluate(([sel, band]) => {
		const boxes = [...document.querySelectorAll(sel)].filter((n) => n.getClientRects().length).map((n) => n.getBoundingClientRect());
		const top = Math.min(...boxes.map((b) => b.top));
		const bottom = Math.max(...boxes.map((b) => b.bottom));
		return { n: boxes.length, top: Math.round(top), bottom: Math.round(bottom), h: innerHeight, ok: boxes.length > 0 && top >= band && bottom <= innerHeight };
	}, [sel, BAND]);
	return r;
}
const until = (G, fn, arg, timeout = TIMEOUT) => G.waitForFunction(fn, arg, { timeout });

/**
 * Text drawn on canvases in the next `ms`, at its size on screen in CSS px:
 * the font's px x the context's scale x the canvas's CSS size / its pixel
 * size. A canvas game repaints every frame, so a short window sees what shows.
 */
function canvasText(F, ms = 600) {
	return F.evaluate(async (ms) => {
		const P = CanvasRenderingContext2D.prototype;
		const seen = new Map();
		const wrap = (orig) =>
			function (str, ...rest) {
				const px = parseFloat(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? "10");
				const m = this.getTransform();
				const c = this.canvas;
				const size = Math.round(px * Math.hypot(m.b, m.d) * (c.clientHeight && c.height ? c.clientHeight / c.height : 1) * 10) / 10;
				if (String(str).trim()) seen.set(`${str}@${size}`, [String(str).slice(0, 24), size]);
				return orig.call(this, str, ...rest);
			};
		const [fill, stroke] = [P.fillText, P.strokeText];
		P.fillText = wrap(fill);
		P.strokeText = wrap(stroke);
		await new Promise((r) => setTimeout(r, ms));
		[P.fillText, P.strokeText] = [fill, stroke];
		return [...seen.values()];
	}, ms);
}

/** Measure the frame now and check it: the line names the game, the step and the phone. */
async function audit(F, game, step, phone, { canvas = false, min = 1 } = {}) {
	await F.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
	const f = await phoneFloors(F, "body", { hit: true, exempt: EXEMPT[game] ?? [], band: BAND });
	const drawn = canvas ? (await canvasText(F)).filter(([, px]) => px < 12) : [];
	const doc = await F.evaluate(() => document.documentElement.scrollWidth);
	const bad = { taps: f.taps, text: f.text, ...(drawn.length ? { canvas: drawn } : {}), ...(doc > phone.w ? { doc } : {}) };
	if (f.measured.taps < min) bad.missed = `${f.measured.taps} targets, expected at least ${min}`;
	const ok = !f.taps.length && !f.text.length && !drawn.length && doc <= phone.w && f.measured.taps >= min;
	check(`${game} · ${step} · ${phone.w}x${phone.h}: taps 44px (box and hit), text 12px, no sideways scroll, clear of the band`, ok, ok ? `${f.measured.taps} targets, ${f.measured.text} texts` : bad);
	for (const [sel, why] of f.allowed) exemptions.add(`${game} ${sel}: ${why}`);
	if (SHOTS) await F.page().screenshot({ path: join(SHOTS, `${game}-${phone.w}x${phone.h}-${step.replace(/\W+/g, "-")}.png`) });
	return f;
}
const exemptions = new Set();

// ------------------------------------------------------------------ games

const GAMES = {
	/** Pick a puzzle, the grid and pad (with notes, racing a bot), solved. */
	async sudoku(page, p) {
		const G = await solo(page, "sudoku", 2);
		await until(G, () => window.__game.handle.debug().phase === "pick");
		await audit(G, "sudoku", "pick a puzzle", p, { min: 6 });
		await G.locator("button", { hasText: "NEW PUZZLE" }).click();
		await until(G, () => {
			const d = window.__game.handle.debug();
			return d.phase === "play" && d.selected >= 0;
		});
		await audit(G, "sudoku", "the race", p, { min: 81 });
		// Pencil notes in the selected cell.
		await G.locator(".su-pad button", { hasText: "NOTES" }).click();
		for (const d of ["1", "5", "9"]) await G.locator(".su-pad button", { hasText: new RegExp(`^${d}$`) }).click();
		await until(G, () => !!document.querySelector(".su-notes"));
		await audit(G, "sudoku", "pencil notes", p, { min: 81 });
		await G.locator(".su-pad button", { hasText: "NOTES" }).click();
		// Solve it, cell by cell, as a thumb would: the cell, then its digit.
		await G.evaluate(() => {
			const d = window.__game.handle.debug();
			const cells = document.querySelectorAll(".su-cell");
			const pad = [...document.querySelectorAll(".su-pad button")];
			for (let i = 0; i < 81; i++) {
				if (d.puzzle[i] !== "0" && d.puzzle[i] !== ".") continue;
				cells[i].dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
				pad[Number(d.solution[i]) - 1].click();
			}
		});
		await until(G, () => window.__game.handle.debug().phase === "over");
		await audit(G, "sudoku", "solved", p, { min: 0 });
	},

	/** Placing the fleet, firing, the reveal. */
	async battleship(page, p) {
		const G = await solo(page, "battleship", 2);
		await until(G, () => window.__game.handle.debug().phase === "place");
		await audit(G, "battleship", "placing the fleet", p, { min: 64 });
		const fitPlace = await onScreen(G, ".bs-grid, .bs-ships, .bs-actions");
		check(`battleship · placing the fleet · ${p.w}x${p.h}: the board, the ships and the buttons on screen`, fitPlace.ok && fitPlace.n === 3, fitPlace);
		await G.locator("button", { hasText: "DOWN" }).or(G.locator("button", { hasText: "ACROSS" })).first().click();
		await G.locator("button", { hasText: "COMMIT FLEET" }).click();
		await until(G, () => window.__game.handle.debug().phase === "fire");
		await audit(G, "battleship", "firing", p, { min: 64 });
		let fit = await onScreen(G, ".bs-grid");
		check(`battleship · firing · ${p.w}x${p.h}: both boards on screen, below the band`, fit.ok && fit.n === 2, fit);
		for (let last = { n: -1, at: Date.now() }; ; await sleep(130)) {
			const d = await debug(G);
			if (d.over) break;
			const n = Math.max(d.shotsAtMe, d.shotsAtThem);
			if (n !== last.n) last = { n, at: Date.now() };
			else if (Date.now() - last.at > 20_000) break;
			if (d.phase === "fire")
				await G.evaluate(() => {
					const at = window.battleshipRules.botTarget(window.__game.handle.debug().theirBoard);
					const cell = at && document.querySelector(`[data-board="theirs"] .bs-cell[data-r="${at[0]}"][data-c="${at[1]}"]`);
					if (cell && !cell.disabled) cell.click();
				});
		}
		await until(G, () => {
			const d = window.__game.handle.debug();
			return d.over && Object.keys(d.audits).length === 2;
		});
		await audit(G, "battleship", "the fleets revealed", p, { min: 1 });
		fit = await onScreen(G, ".bs-grid, .bs-actions, .bs-verdict");
		check(`battleship · the fleets revealed · ${p.w}x${p.h}: both boards, the verdict and NEW GAME on screen`, fit.ok && fit.n === 4, fit);
	},

	/** Bidding, a call (every cup opened), and the end. */
	async "liars-dice"(page, p) {
		const G = await solo(page, "liars-dice", 2);
		await until(G, () => {
			const b = [...document.querySelectorAll(".ld-actions button")].find((b) => b.textContent.startsWith("BID"));
			return b && !b.disabled;
		});
		await audit(G, "liars-dice", "bidding", p, { min: 8 });
		let seenCall = false;
		const end = Date.now() + 240_000;
		for (let bids = 0; Date.now() < end; await sleep(200)) {
			const d = await debug(G);
			if (d.over) break;
			if (d.lastCall && !seenCall) {
				seenCall = true;
				await audit(G, "liars-dice", "a call: every cup opened", p, { min: 0 });
			}
			if (d.phase === "bid" && !d.lastCall) seenCall = false;
			// Two bids, then LIAR: a call every round, so a game ends.
			bids += await G.evaluate((bids) => {
				const btns = [...document.querySelectorAll(".ld-actions button")];
				const bid = btns.find((b) => b.textContent.startsWith("BID") && !b.disabled);
				const liar = btns.find((b) => b.textContent.includes("LIAR") && !b.disabled);
				if (liar && bids % 3 === 2) return liar.click(), 1;
				if (bid) return bid.click(), 1;
				if (liar) return liar.click(), 1;
				return 0;
			}, bids);
		}
		check("liar's dice reached its end", !!(await debug(G)).over);
		await audit(G, "liars-dice", "the end", p, { min: 1 });
	},

	/** The countdown, the race (steering halves, canvas), the round's end. */
	async "light-cycles"(page, p) {
		const G = await solo(page, "light-cycles", 2);
		await until(G, () => window.__game.handle.debug().riders.length === 2);
		await audit(G, "light-cycles", "the countdown", p, { min: 0, canvas: true });
		await until(G, () => window.__game.handle.debug().racing);
		await audit(G, "light-cycles", "racing", p, { min: 0, canvas: true });
		await until(G, () => window.__game.handle.debug().racing === false, null, 90_000);
		await audit(G, "light-cycles", "the round over", p, { min: 0, canvas: true });
	},

	/** The mode pick, the round (canvas), the end. */
	async "bubble-rush"(page, p) {
		const G = await solo(page, "bubble-rush", 2);
		await until(G, () => window.__game.handle.debug().phase === "setup");
		await audit(G, "bubble-rush", "picking a mode", p, { min: 2 });
		await G.locator('.br-setup button[data-mode="ffa"]').click();
		await until(G, () => window.__game.handle.debug().mode === "ffa");
		await audit(G, "bubble-rush", "a mode picked", p, { min: 3 });
		await G.locator(".br-setup .br-start").click();
		await until(G, () => window.__game.handle.debug().phase !== "setup");
		if ((await debug(G)).phase === "count") await audit(G, "bubble-rush", "the countdown", p, { min: 0, canvas: true });
		await until(G, () => window.__game.handle.debug().phase === "play");
		await audit(G, "bubble-rush", "popping", p, { min: 0, canvas: true }); // the field is the target: a canvas
		await until(G, () => window.__game.handle.debug().phase === "over", null, 90_000);
		await audit(G, "bubble-rush", "the round over", p, { min: 0, canvas: true });
	},

	/** Two people (no bots): drawing and guessing, the reveal, game over — both phones. */
	async "draw-guess"(host, p) {
		const guest = watch(await host.context().newPage());
		await host.goto(site.url("?game=lokeshmohanty%2Fdraw-guess&fresh=1"));
		await host.locator("button", { hasText: "MULTI-PLAYER" }).first().click();
		await host.locator("button", { hasText: "INVITE A FRIEND" }).first().click();
		const invite = host.locator("textarea.share-code").first();
		await invite.waitFor({ timeout: TIMEOUT });
		await guest.goto(await invite.inputValue());
		const reply = guest.locator("textarea.share-code").first();
		await reply.waitFor({ timeout: TIMEOUT });
		await host.locator("textarea.share-code").last().fill(await reply.inputValue());
		await host.locator("button.neon-btn", { hasText: /^CONNECT$/ }).first().click();
		await guest.locator(".party-member").nth(1).waitFor({ timeout: TIMEOUT });
		await host.bringToFront();
		await host.locator("button", { hasText: "START GAME" }).first().click();
		await host.waitForFunction(() => window.__game?.handle, null, { timeout: TIMEOUT });
		await guest.waitForFunction(() => window.__game?.handle, null, { timeout: TIMEOUT });
		const H = await gameScope(host, TIMEOUT);
		const U = await gameScope(guest, TIMEOUT);
		const both = [
			[host, H, "host"],
			[guest, U, "guest"],
		];
		await until(H, () => window.__game.handle.debug().phase === "drawing");
		await until(U, () => window.__game.handle.debug().phase === "drawing");
		const drawerIsHost = (await debug(H)).drawerId === (await H.evaluate(() => window.arcade.party.self));
		const board = await onScreen(drawerIsHost ? H : U, "#board, #tools, #chat-area");
		const boardH = await (drawerIsHost ? H : U).evaluate(() => Math.round(document.getElementById("board").getBoundingClientRect().height));
		check(`draw-guess · drawing · ${p.w}x${p.h}: the board (${boardH}px tall), the tools and the chat on screen`, board.ok && board.n === 3 && boardH >= 180, { ...board, boardH });
		for (const [pg, F, who] of both) {
			await readyToClick(pg);
			await audit(F, "draw-guess", `${(who === "host") === drawerIsHost ? "drawing" : "guessing"} (${who})`, p, { min: (who === "host") === drawerIsHost ? 10 : 1 });
		}
		// Every round, the guesser guesses right; the reveal once, then on to the end.
		let revealed = false;
		const end = Date.now() + 120_000;
		while (Date.now() < end) {
			const d = await debug(H);
			if (d.phase === "gameover") break;
			if (d.phase === "reveal" && !revealed) {
				revealed = true;
				for (const [, F, who] of both) await audit(F, "draw-guess", `the reveal (${who})`, p, { min: 0 });
			}
			if (d.phase === "drawing") {
				const self = await H.evaluate(() => window.arcade.party.self);
				const [pg, F] = d.drawerId === self ? [guest, U] : [host, H];
				await pg.bringToFront();
				const input = F.locator("#chat-input");
				if (await input.isEnabled()) {
					await input.fill(d.word);
					await F.locator("#chat-send").click();
				}
			}
			await sleep(300);
		}
		await settled(() => debug(U), (d) => d.phase === "gameover");
		for (const [pg, F, who] of both) {
			await readyToClick(pg);
			await audit(F, "draw-guess", `game over (${who})`, p, { min: who === "guest" ? 1 : 0 });
		}
		await guest.close();
	},
};

const only = process.argv.slice(2);
try {
	for (const p of PHONES) {
		for (const [id, run] of Object.entries(GAMES)) {
			if (only.length && !only.includes(id)) continue;
			console.log(`\ntaps: ${id} at ${p.w}x${p.h}`);
			const ctx = await phone(p);
			const page = watch(await ctx.newPage());
			try {
				await run(page, p);
			} catch (err) {
				check(`${id} at ${p.w}x${p.h} played through`, false, err.message.split("\n")[0]);
			}
			await ctx.close();
		}
	}
	if (exemptions.size) {
		console.log("\ntaps: allowed below the floors, and why");
		for (const e of exemptions) console.log(`  - ${e}`);
	}
} finally {
	await browser.close();
	site.stop();
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall tap-target checks passed");
process.exit(failures ? 1 : 0);
