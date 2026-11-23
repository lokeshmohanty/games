#!/usr/bin/env node
/**
 * test-taps.mjs — inside the community games, every tap target clears 44px
 * and every text 12px, on two phones, in every phase a player sees.
 *
 *   node scripts/test-taps.mjs [floors|game…] (NEON_TAPS_VERBOSE=1: counts on passing lines too;
 *                                          NEON_TAPS_SHOTS=dir: a screenshot of every step)
 *
 * A real-device pass on Lokesh's Android phone (2026-11-18: 354x696 CSS px at
 * DPR 3.5) found tap targets under 44px and text under 12px inside games —
 * which no suite caught, because each checked the few controls it knew of.
 * This plays each of lokeshmohanty/web-games' games (registry pin, or
 * NEON_PIN_OVERRIDE) through its setup, play and end, and at each step holds
 * the whole game frame to scripts/serve.mjs `phoneSizes` — at 390x844 and at
 * that phone's 354x696 — with `phoneFloors`' `hit: true`: every visible,
 * enabled, uncovered target, its box and its hit area, and every text; plus
 * text drawn on a canvas (`canvasText` here) and, where a screen could run
 * off the phone, its parts on screen. No sideways scroll, and no target under
 * the shell's top band (52px).
 *
 * Exemptions are listed per game with the reason, and printed: a Sudoku cell
 * is a ninth of a 330px board on that phone, and the reason it is still
 * usable (select, then a larger number pad) is the exemption's text.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { communityHas, registryLists, gameScope, phoneFloors, phoneSizes, readyToClick, serve, settled } from "./serve.mjs";
import { loadPlaywright } from "./playwright.mjs";

const TIMEOUT = 30_000;
const VERBOSE = !!process.env.NEON_TAPS_VERBOSE;
const SHOTS = process.env.NEON_TAPS_SHOTS;
const BAND = 52; // the shell's top band over a game frame (portal link, game buttons)

let failures = 0;
const check = (label, ok, detail = "") => {
	console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail !== "" && (!ok || VERBOSE) ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
	if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * What a game may hold below the floors, on how narrow a window (`upTo`),
 * and why. Matched by selector inside the game's frame; one that let an
 * element through is printed once per run.
 */
const EXEMPT = {
	sudoku: [
		{
			sel: ".su-cell",
			tap: 35,
			upTo: 374,
			why: "a 9 x 9 board: 9 cells of 44px need 396px, so on a 354px phone a cell is 36px (35px for the last row). A tap only selects it — highlighting its row, column, box and digit, so a miss shows and costs a second tap — and the digit goes in from the pad, keys 48px tall",
		},
		{ sel: ".su-cell", tap: 39, upTo: 399, why: "the same board on a 390px phone: 40px cells (39px for the last row); from a 400px window they are 40px and more" },
		{ sel: ".su-notes", text: 11, upTo: 374, why: "pencil notes are a 3 x 3 grid inside one cell: a third of a 36px cell holds an 11px digit (12px from 390); the digits placed are 21px" },
	],
	battleship: [
		{
			sel: ".bs-grid",
			tap: 39,
			upTo: 389,
			why: "8 squares of 44px need 374px of board: under 390px wide a square is 39.6px (354x696) or 40.4px (360x640); 44px from 390. The 2px between squares is the board, not a neighbour, so a tap a little wide does nothing rather than firing at the next square",
		},
	],
	"liars-dice": [],
	"light-cycles": [],
	"bubble-rush": [],
	"draw-guess": [],
	ludo: [],
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

/** A touch phone (DPR 3.5, as the one of the pass) that never reaches the deployed room server; phoneSizes sizes it. */
async function phone() {
	const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3.5 });
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
/** The elements matching `sel`, on show: how many, and whether all are on screen below the band. */
function onScreen(G, sel) {
	return G.evaluate(([sel, band]) => {
		const boxes = [...document.querySelectorAll(sel)].filter((n) => n.getClientRects().length).map((n) => n.getBoundingClientRect());
		const top = Math.min(...boxes.map((b) => b.top));
		const bottom = Math.max(...boxes.map((b) => b.bottom));
		return { n: boxes.length, top: Math.round(top), bottom: Math.round(bottom), h: innerHeight, ok: boxes.length > 0 && top >= band && bottom <= innerHeight };
	}, [sel, BAND]);
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

/**
 * Hold the frame to the floors at both phone sizes (serve.mjs phoneSizes).
 * `min`: the fewest live targets for this to be the step meant (0 only where
 * the frame has none: a canvas field, the shell's end card). `under`: what
 * this step covers on purpose (an end overlay over the board); any other
 * covered target fails. `canvas`: canvas text too. `fit: [sel, n]`: the n
 * elements matching sel all on screen, below the band. `extra(w, h)`:
 * anything else, as phoneSizes'.
 */
async function audit(page, F, game, step, { canvas = false, min, under = null, fit = null, extra = null } = {}) {
	if (min == null) throw new Error(`${game} · ${step}: say how many targets it has (min)`);
	const allowed = await phoneSizes(page, F, `${game} · ${step}`, check, {
		timeout: TIMEOUT,
		hit: true,
		exempt: EXEMPT[game] ?? [],
		band: BAND,
		under,
		min,
		extra: async (w, h) => {
			if (SHOTS) await page.screenshot({ path: join(SHOTS, `${game}-${w}x${h}-${step.replace(/\W+/g, "-")}.png`) });
			const out = {};
			const drawn = canvas ? (await canvasText(F)).filter(([, px]) => px < 12) : [];
			if (drawn.length) out.canvas = drawn;
			if (fit) {
				const on = await onScreen(F, fit[0]);
				if (!on.ok || on.n !== fit[1]) out.fit = { sel: fit[0], want: fit[1], ...on };
			}
			const more = extra ? await extra(w, h) : null;
			if (more) out.more = more;
			return Object.keys(out).length ? out : null;
		},
	});
	for (const [sel, why] of allowed) exemptions.add(`${game} ${sel}: ${why}`);
}
const exemptions = new Set();

/**
 * Ludo, a crafted turn (reviews, 2026-11-23): on `board`, every player on
 * the star 8 squares (6 on the 6-player board) on from this phone's start —
 * this phone and the next seat with stacks of two, the others one each —
 * and this phone's two other tokens just behind it, its roll a 2. Every
 * token on the star at least 7px across; no token drawn over another
 * anywhere on the board (a crowded square's ring spilling onto the next
 * square, or a yard, counts), and no stack's count over another token; the
 * rings, pushed apart, see-through, the stack's ring showing its count; then
 * the floors at both sizes.
 */
async function ludoSharedStar(page, G, board, fit, who = "four players") {
	await G.evaluate((board) => {
		const R = window.ludoRules;
		const s = rules.snapshot();
		const geo = R.geometry(board);
		const n = s.seats.length;
		const me = window.__game.handle.debug().you;
		Object.assign(s, { board, mode: "ffa", arms: [...R.ARMS[board][n]] });
		const star = geo.stars[s.arms[me]];
		const at = (j) => (star - s.arms[j] * geo.STEP + 2 * geo.T) % geo.T;
		s.tokens = s.seats.map(() => [-1, -1, -1, -1]);
		s.tokens[me] = [at(me), at(me), at(me) - 2, at(me) - 1];
		s.seats.forEach((_, j) => {
			if (j === me) return;
			s.tokens[j][0] = at(j);
			if (j === (me + 1) % n) s.tokens[j][1] = at(j);
		});
		let seed = 1;
		while (R.rng(seed).int(1, 6) !== 2) seed++;
		Object.assign(s, { dice: seed, turn: me, stage: "roll", roll: 0, sixes: 0, done: [], over: false });
		rules.restore({ snapshot: s });
		arcade.act({ roll: true });
	}, board);
	await until(G, (b) => {
		const d = window.__game.handle.debug();
		return d.board === b && d.stage === "move" && d.targets.length === 3 && !d.busy;
	}, board);
	/** The tokens on the star, as drawn now: what falls short, or null. */
	const shared = () =>
		G.evaluate(() => {
			const d = window.__game.handle.debug();
			const bySquare = new Map();
			for (const t of d.drawn) bySquare.set(t.square, [...(bySquare.get(t.square) ?? []), t]);
			const star = [...bySquare.values()].find((g) => g.length === d.seats.length);
			if (!star) return { star: "no square with every seat on it", drawn: d.drawn };
			const bad = [];
			for (const a of star) {
				if (a.r < 7) bad.push(`seat ${a.seat} drawn ${a.r.toFixed(1)}px across the radius`);
				if (a.count > 1 && a.marks.length !== a.count) bad.push(`seat ${a.seat}: ${a.marks.length} notches for ${a.count}`);
			}
			// Every token drawn, yards included, against every other: across squares too.
			const name = (t) => `seat ${t.seat}${t.square ? ` (${t.square === star[0].square ? "the star" : t.square})` : ""}`;
			d.drawn.forEach((a, i) => {
				d.drawn.forEach((b, j) => {
					if (i === j) return;
					const gap = Math.hypot(a.x - b.x, a.y - b.y) - a.r - b.r;
					if (i < j && gap < -0.05) bad.push(`${name(a)} and ${name(b)} overlap by ${(-gap).toFixed(1)}px`);
					for (const [mx, my] of a.marks) if (Math.hypot(mx - b.x, my - b.y) < b.r + 1) bad.push(`${name(a)}'s count is over ${name(b)}`);
				});
			});
			const rings = [...document.querySelectorAll(".lu-pick")];
			// What a ring holds (its count, a token's mark when pushed far off) covers no token.
			const box = document.querySelector(".lu-board").getBoundingClientRect();
			for (const el of document.querySelectorAll(".lu-pick b, .lu-pick svg")) {
				const b = el.getBoundingClientRect();
				const [x, y, rad] = [b.left + b.width / 2 - box.left, b.top + b.height / 2 - box.top, Math.max(b.width, b.height) / 2];
				for (const tk of d.drawn) if (Math.hypot(x - tk.x, y - tk.y) < tk.r + rad - 1) bad.push(`a ring's ${el.tagName === "B" ? "count" : "mark"} covers ${name(tk)}`);
			}
			const stack = rings.find((r) => r.dataset.stack === "2");
			if (!stack || stack.querySelector("b")?.textContent !== "2") bad.push("the stack's ring does not show 2");
			for (const r of rings.filter((r) => r.classList.contains("away"))) {
				const a = Number(/rgba?\([^)]*?,\s*([\d.]+)\)$/.exec(getComputedStyle(r).backgroundColor)?.[1] ?? 1);
				if (getComputedStyle(r).backgroundColor !== "rgba(0, 0, 0, 0)" && a > 0.35) bad.push(`a pushed-apart ring is not see-through (${getComputedStyle(r).backgroundColor})`);
			}
			if (!rings.some((r) => r.classList.contains("away"))) bad.push("no ring was pushed apart (the crafted rings should crowd)");
			return bad.length ? { bad, star } : null;
		});
	await audit(page, G, "ludo", `${who} sharing a star, ${board}-player board`, { min: 3, canvas: true, fit, extra: shared });
}

// ------------------------------------------------------------------ games

const GAMES = {
	/** Pick a puzzle, the grid and pad (with notes, racing a bot), solved. */
	async sudoku(page) {
		const G = await solo(page, "sudoku", 2);
		await until(G, () => window.__game.handle.debug().phase === "pick");
		await audit(page, G, "sudoku", "pick a puzzle", { min: 6 });
		await G.locator("button", { hasText: "NEW PUZZLE" }).click();
		await until(G, () => {
			const d = window.__game.handle.debug();
			return d.phase === "play" && d.selected >= 0;
		});
		await audit(page, G, "sudoku", "the race", { min: 81 });
		// Pencil notes in the selected cell.
		await G.locator(".su-pad button", { hasText: "NOTES" }).click();
		for (const d of ["1", "5", "9"]) await G.locator(".su-pad button", { hasText: new RegExp(`^${d}$`) }).click();
		await until(G, () => !!document.querySelector(".su-notes"));
		await audit(page, G, "sudoku", "pencil notes", { min: 81 });
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
		// The end: the frame's overlay over the board (the shell's end card has PLAY AGAIN).
		await audit(page, G, "sudoku", "solved", { min: 0, under: ".su-grid, .su-pad" });
	},

	/** Placing the fleet, firing, the reveal. */
	async battleship(page) {
		const G = await solo(page, "battleship", 2);
		await until(G, () => window.__game.handle.debug().phase === "place");
		await audit(page, G, "battleship", "placing the fleet", { min: 71, fit: [".bs-grid, .bs-ships, .bs-actions", 3] });
		// A shorter phone, 360x640: the ship rack and the buttons one row each,
		// so the squares keep the 40.4px they had (two rows took them to 34px).
		await page.setViewportSize({ width: 360, height: 640 });
		await G.waitForFunction(() => innerWidth === 360 && innerHeight === 640, null, { timeout: TIMEOUT });
		await G.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
		const short = await G.evaluate(() => ({
			square: Math.round(document.querySelector('[data-board="mine"] .bs-cell').getBoundingClientRect().width * 10) / 10,
			rows: ["bs-ships", "bs-actions"].map((c) => new Set([...document.querySelectorAll(`.${c} > button`)].map((b) => Math.round(b.getBoundingClientRect().top))).size),
		}));
		const shortFit = await onScreen(G, ".bs-grid, .bs-ships, .bs-actions");
		check("battleship · placing the fleet at 360x640: squares at least 40.4px, the rack and the buttons one row each, all on screen", short.square >= 40.4 && short.rows.join() === "1,1" && shortFit.ok && shortFit.n === 3, { ...short, ...shortFit });
		await page.setViewportSize({ width: 390, height: 844 });
		await G.locator("button", { hasText: "DOWN" }).or(G.locator("button", { hasText: "ACROSS" })).first().click();
		await G.locator("button", { hasText: "COMMIT FLEET" }).click();
		await until(G, () => window.__game.handle.debug().phase === "fire");
		await audit(page, G, "battleship", "firing", { min: 64, fit: [".bs-grid", 2] });
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
		await audit(page, G, "battleship", "the fleets revealed", { min: 1, fit: [".bs-grid, .bs-actions, .bs-verdict", 4] });
	},

	/** Bidding, a call (every cup opened), and the end. */
	async "liars-dice"(page) {
		const G = await solo(page, "liars-dice", 2);
		await until(G, () => {
			const b = [...document.querySelectorAll(".ld-actions button")].find((b) => b.textContent.startsWith("BID"));
			return b && !b.disabled;
		});
		await audit(page, G, "liars-dice", "bidding", { min: 8 }); // five faces, − and +, BID
		let seenCall = false;
		const end = Date.now() + 240_000;
		for (let bids = 0; Date.now() < end; await sleep(200)) {
			const d = await debug(G);
			if (d.over) break;
			if (d.lastCall && !seenCall) {
				seenCall = true;
				await audit(page, G, "liars-dice", "a call: every cup opened", { min: 0 }); // nothing to press while the cups are up
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
		await audit(page, G, "liars-dice", "the end", { min: 1 });
	},

	/** The countdown, the race (steering halves, canvas), the round's end. */
	async "light-cycles"(page) {
		const G = await solo(page, "light-cycles", 2);
		await until(G, () => window.__game.handle.debug().riders.length === 2);
		// No controls in the frame: each half of the arena is a steering zone, 150px+ wide.
		await audit(page, G, "light-cycles", "the countdown", { min: 0, canvas: true });
		await until(G, () => window.__game.handle.debug().racing);
		await audit(page, G, "light-cycles", "racing", { min: 0, canvas: true });
		await until(G, () => window.__game.handle.debug().racing === false, null, 90_000);
		await audit(page, G, "light-cycles", "the round over", { min: 0, canvas: true });
	},

	/** The mode pick, the round (canvas), the end. */
	async "bubble-rush"(page) {
		const G = await solo(page, "bubble-rush", 2);
		await until(G, () => window.__game.handle.debug().phase === "setup");
		await audit(page, G, "bubble-rush", "picking a mode", { min: 2 });
		await G.locator('.br-setup button[data-mode="ffa"]').click();
		await until(G, () => window.__game.handle.debug().mode === "ffa");
		await audit(page, G, "bubble-rush", "a mode picked", { min: 3 });
		await G.locator(".br-setup .br-start").click();
		await until(G, () => window.__game.handle.debug().phase !== "setup");
		if ((await debug(G)).phase === "count") await audit(page, G, "bubble-rush", "the countdown", { min: 0, canvas: true });
		await until(G, () => window.__game.handle.debug().phase === "play");
		await audit(page, G, "bubble-rush", "popping", { min: 0, canvas: true }); // the field is the target: a canvas
		await until(G, () => window.__game.handle.debug().phase === "over", null, 90_000);
		await audit(page, G, "bubble-rush", "the round over", { min: 0, canvas: true });
	},

	/**
	 * A card's tap goes straight into play on the 4-player board: your roll,
	 * a move playing, a choice of tokens (its rings), played to the end. Then
	 * CHANGE PLAYERS to four, which brings the setup (both boards), and on the
	 * 6-player board your roll and players sharing a star — stacks among them
	 * and pushed-apart rings — then the same on the 4-player board.
	 */
	async ludo(page) {
		let G = await solo(page, "ludo", 2);
		const fit = [".lu-status, .lu-players, .lu-board, .lu-bar", 4];
		/** Roll and pick (the first ring) as a thumb would, until `done(debug)`. */
		const drive = async (done, ms) => {
			const end = Date.now() + ms;
			for (let d = await debug(G); !done(d) && Date.now() < end; d = await debug(G)) {
				if (d.myTurn && d.stage === "roll" && !d.tumbling && !d.busy) await G.evaluate(() => document.querySelector(".lu-die:not(:disabled)")?.click());
				else if (d.targets.length && !d.picking) await G.evaluate(() => document.querySelector(".lu-pick")?.click());
				await sleep(150);
			}
			return debug(G);
		};
		const choice = (d) => d.myTurn && d.stage === "move" && !d.busy && d.targets.length >= 2;
		await until(G, () => window.__game.handle.debug().phase);
		let d = await debug(G);
		check("ludo · a card's tap on a fresh phone: straight into play, the 4-player board, no setup", d.phase === "play" && d.board === 4 && d.mode === "ffa", { phase: d.phase, board: d.board });
		await drive((d) => d.myTurn && d.stage === "roll" && !d.busy, 60_000);
		await audit(page, G, "ludo", "your roll, 4-player board", { min: 1, canvas: true, fit });
		await G.evaluate(() => document.querySelector(".lu-die").click());
		await until(G, () => window.__game.handle.debug().busy);
		await audit(page, G, "ludo", "a move playing", { min: 0, canvas: true, fit });
		d = await drive(choice, 180_000);
		check("ludo · a choice of tokens came up on the 4-player board", choice(d), { targets: d.targets, tokens: d.tokens });
		if (choice(d)) await audit(page, G, "ludo", "a choice of tokens, 4-player board", { min: 2, canvas: true, fit });
		// The rest of the game without the animations (bots wait for none).
		await page.emulateMedia({ reducedMotion: "reduce" });
		d = await drive((d) => d.over, 300_000);
		check("ludo reached its end", d.over, { done: d.done, tokens: d.tokens });
		await until(G, () => !window.__game.handle.debug().busy);
		await audit(page, G, "ludo", "the end", { min: 0, canvas: true, fit });
		// SEE THE BOARD: the game's end screen, "Next game: … · CHANGE" (Lokesh, 2026-11-23).
		await page.locator(".managed-over button", { hasText: "SEE THE BOARD" }).first().click({ timeout: TIMEOUT });
		await until(G, () => !!document.querySelector(".lu-next:not([hidden]) .lu-next-change"));
		const line = () => G.evaluate(() => document.querySelector(".lu-next").textContent);
		check("ludo · the end: the next game is this one (4-player board, free-for-all), with CHANGE", (await line()).startsWith("Next game: 4-player board, free-for-all"), await line());
		await audit(page, G, "ludo", "the end, the next game line", { min: 1, canvas: true });
		await G.locator(".lu-next-change").click();
		await until(G, () => !!document.querySelector(".lu-next button[data-board]"));
		// Two players: both boards, free-for-all only (teams need every seat), and DONE —
		// all above the shell's end card, tucked to the bottom (a thumb reaches them).
		const aboveCard = async () => {
			const card = await page.locator(".managed-over > div").first().boundingBox();
			const frame = await page.locator("iframe.game-frame, iframe").first().boundingBox();
			const bottom = await G.evaluate(() => Math.max(...[...document.querySelectorAll(".lu-next button")].map((b) => b.getBoundingClientRect().bottom)));
			return card && frame && frame.y + bottom <= card.y ? null : { cardTop: card?.y, controlsBottom: frame && frame.y + bottom };
		};
		await audit(page, G, "ludo", "choosing the next game", { min: 4, extra: aboveCard });
		check("ludo · the next game's teams are not on offer to two", await G.locator('.lu-next button[data-mode="pairs"]').isDisabled());
		await G.locator('.lu-next button[data-board="6"]').click();
		await G.locator(".lu-next-change").click();
		await until(G, () => !document.querySelector(".lu-next button[data-board]"));
		check("ludo · CHANGE, the 6-player board, DONE: the line says so", (await line()).startsWith("Next game: 6-player board, free-for-all"), await line());
		// CHANGE PLAYERS: four at the table, a different table, so the setup.
		await page.locator(".managed-over .managed-seats").first().click({ timeout: TIMEOUT });
		await page.locator(".quick-table .quick-go button").waitFor({ timeout: TIMEOUT });
		for (let k = 0; k < 10 && Number(await page.locator(".quick-table .quick-n").textContent()) !== 4; k++) {
			await page.locator('.quick-table [data-qt="plus"]').click();
			await sleep(150);
		}
		await page.locator(".quick-table .quick-go button").click();
		await page.waitForFunction(() => window.__game?.handle, null, { timeout: TIMEOUT });
		G = await gameScope(page, TIMEOUT);
		await until(G, () => window.__game.handle.debug().seats?.length === 4);
		await readyToClick(page);
		await page.emulateMedia({ reducedMotion: null });
		d = await debug(G);
		check("ludo · CHANGE PLAYERS to four: the setup, the board picked for next game still picked", d.phase === "setup" && d.board === 6, { phase: d.phase, board: d.board });
		// Four players on the 4-player board: both boards, free-for-all and 2 v 2, START.
		await G.locator('.lu-setup button[data-board="4"]').click();
		await until(G, () => window.__game.handle.debug().board === 4);
		await audit(page, G, "ludo", "setting up", { min: 5 });
		await G.locator('.lu-setup button[data-board="6"]').click();
		await until(G, () => window.__game.handle.debug().board === 6);
		await audit(page, G, "ludo", "setting up, 6-player board", { min: 4 });
		await G.locator(".lu-start").click();
		await until(G, () => window.__game.handle.debug().phase === "play");
		await drive((d) => d.myTurn && d.stage === "roll" && !d.busy, 60_000);
		await audit(page, G, "ludo", "your roll, 6-player board", { min: 1, canvas: true, fit });
		await page.emulateMedia({ reducedMotion: "reduce" });
		for (const board of [6, 4]) await ludoSharedStar(page, G, board, fit);
		// Six on one star: a fresh phone, six at the table, straight in on the 6-player board.
		const six = await phone();
		const P6 = watch(await six.newPage());
		try {
			const G6 = await solo(P6, "ludo", 6);
			await until(G6, () => window.__game.handle.debug().phase === "play" && window.__game.handle.debug().seats.length === 6);
			await P6.emulateMedia({ reducedMotion: "reduce" });
			await ludoSharedStar(P6, G6, 6, fit, "six players");
		} finally {
			await six.close();
		}
	},

	/** Two people (no bots): drawing and guessing, the reveal, game over — both phones. */
	async "draw-guess"(host) {
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
		for (const [pg, F, who] of both) {
			await readyToClick(pg);
			const drawer = (who === "host") === drawerIsHost;
			// The drawer's board, tools and chat all on screen, the board a real size.
			const boardH = () => F.evaluate(() => Math.round(document.getElementById("board").getBoundingClientRect().height));
			await audit(pg, F, "draw-guess", `${drawer ? "drawing" : "guessing"} (${who})`, {
				min: drawer ? 10 : 12, // six pens, three brushes, CLEAR; the guesser's field and SEND too
				fit: ["#board, #tools, #chat-area", 3],
				extra: async () => ((await boardH()) >= 180 ? null : { boardH: await boardH() }),
			});
		}
		// Every round, the guesser guesses right; the reveal once, then on to the end.
		let revealed = false;
		const end = Date.now() + 120_000;
		while (Date.now() < end) {
			const d = await debug(H);
			if (d.phase === "gameover") break;
			if (d.phase === "reveal" && !revealed) {
				revealed = true;
				for (const [pg, F, who] of both) await audit(pg, F, "draw-guess", `the reveal (${who})`, { min: 10 });
			}
			if (d.phase === "drawing") {
				const self = await H.evaluate(() => window.arcade.party.self);
				const [pg, F] = d.drawerId === self ? [guest, U] : [host, H];
				await pg.bringToFront();
				// The round may end between the look and the tap (the right guess
				// just went in): then the field is disabled, and the next look sees it.
				const input = F.locator("#chat-input");
				if (await input.isEnabled()) {
					await input.fill(d.word, { timeout: 2000 }).catch(() => {});
					await F.locator("#chat-send").click({ timeout: 2000 }).catch(() => {});
				}
			}
			await sleep(300);
		}
		await settled(() => debug(U), (d) => d.phase === "gameover");
		for (const [pg, F, who] of both) {
			await readyToClick(pg);
			// The scores' overlay over the board; the guest's HOST A NEW GAME on it.
			await audit(pg, F, "draw-guess", `game over (${who})`, { min: who === "guest" ? 1 : 0, under: "#tools, #chat-area" });
		}
		await guest.close();
	},
};

/**
 * phoneFloors itself, on pages made to trip it: each case is a way the
 * measure once let something through (review of 2026-11-20).
 */
async function floorsItself() {
	console.log("\ntaps: phoneFloors measures what a thumb meets");
	const ctx = await browser.newContext({ viewport: { width: 354, height: 696 } });
	const pg = await ctx.newPage();
	const at = async (html, opts, w = 354) => {
		await pg.setViewportSize({ width: w, height: 696 });
		await pg.setContent(`<!doctype html><body style="margin:0;padding-top:80px">${html}<p>words</p></body>`);
		return phoneFloors(pg, "body", { hit: true, band: 52, ...opts });
	};
	const names = (f) => f.taps.map((t) => `${t[0]}:${t[6]}`).join(" | ");
	let f = await at(`<div style="cursor:pointer;padding:20px"><button style="width:20px;height:20px">x</button></div>`);
	check("a small button inside a cursor:pointer block is still measured (not folded into it)", /^BUTTON:under 44px$/.test(names(f)), f);
	f = await at(`<button disabled style="cursor:pointer;padding:10px"><a href="#" style="display:inline-block;width:10px;height:10px">a</a></button>`);
	check("an enabled link inside a disabled pointer button is measured", /^A:under 44px$/.test(names(f)), f);
	f = await at(`<div style="cursor:pointer;width:60px;height:60px"><span style="cursor:pointer;display:block;width:10px;height:10px"></span></div>`);
	check("…but a pointer-only element inside another is that one's tap", !f.taps.length && f.measured.taps === 1, f);
	const overlay = `<div class="board"><button style="width:60px;height:60px">x</button></div><div style="position:fixed;inset:0"></div>`;
	f = await at(overlay);
	check("a target under an overlay falls short (covered)", /^BUTTON:covered by DIV$/.test(names(f)), f);
	f = await at(overlay, { under: ".board" });
	check("…unless the step covers it on purpose (under), and then it is counted", !f.taps.length && f.covered === 1, f);
	f = await at(`<p style="font-size:11.96px">tiny</p>`);
	const g = await phoneFloors(pg, "body");
	check("11.96px text is under 12px, in both modes", f.text.length === 1 && g.text.length === 1, { hit: f.text, plain: g.text });
	const ex = [{ sel: ".grid", tap: 28, upTo: 374, why: "narrow only" }];
	f = await at(`<div class="grid"><button style="width:30px;height:30px">x</button></div>`, { exempt: ex });
	check("an exemption holds on a window up to its width, and says so", !f.taps.length && f.allowed.length === 1, f);
	f = await at(`<div class="grid"><button style="width:30px;height:30px">x</button></div>`, { exempt: ex }, 390);
	check("…and not on a wider one", f.taps.length === 1 && !f.allowed.length, f);
	f = await at(`<div class="grid"><button style="width:50px;height:50px">x</button></div>`, { exempt: ex });
	check("…and is not listed when the element met the floor anyway", !f.taps.length && !f.allowed.length, f);
	await ctx.close();
}

// Games a web-games branch adds before the registry's pin has them: with the
// pin's build they are not in community/catalog.js, and their blocks skip
// (said, not silent) so main stays green until the pin moves.
const AWAITING_PIN = new Set(["ludo"]);

const only = process.argv.slice(2);
try {
	if (!only.length || only.includes("floors")) await floorsItself();
	for (const [id, run] of Object.entries(GAMES)) {
		if (only.length && !only.includes(id)) continue;
		console.log(`\ntaps: ${id}`);
		if (AWAITING_PIN.has(id) && !communityHas(`lokeshmohanty/${id}`)) {
			if (registryLists(`lokeshmohanty/${id}`)) {
				check(`lokeshmohanty/${id} is listed in the registry but missing from community/catalog.js`, false);
				continue;
			}
			console.log(`  skip lokeshmohanty/${id} is not in community/catalog.js (the registry's pin has not moved to it yet)`);
			continue;
		}
		const ctx = await phone();
		const page = watch(await ctx.newPage());
		try {
			await run(page);
		} catch (err) {
			check(`${id} played through`, false, err.message.split("\n")[0]);
		}
		await ctx.close();
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
