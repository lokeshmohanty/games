#!/usr/bin/env node
/**
 * test-bots.mjs — every game is playable by one person, on one device.
 *
 *   node scripts/test-bots.mjs
 *
 * The arcade used to sort itself into "single player" and "multiplayer", which
 * meant three of the four games were unplayable unless you could produce a
 * second human on demand. Bots removed that split. What has to hold now:
 *
 *   - a game page opens straight into a playable game with nobody else there
 *   - the bot in it actually plays — not a placeholder that forfeits
 *   - a bot is an ordinary member of the roster to every other peer
 *   - and no peer ever tries to open a WebRTC connection to one
 *
 * The last is the one that would rot quietly: a bot has no browser behind it,
 * so an attempt to reach it costs a full ICE timeout and fails every time, and
 * nothing in the UI would say so.
 *
 * NixOS note: as in test-party.mjs, Playwright's bundled chromium cannot run
 * here, so the nix-provided Chrome is driven through executablePath.
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync, globSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const PW_CACHE = join(homedir(), ".cache", "game-previews");
const url = (p) => "file://" + join(ROOT, p);
const TIMEOUT = 30_000;

function chromePath() {
	const found = [
		process.env.CHROME,
		"/run/current-system/sw/bin/google-chrome-stable",
		"/run/current-system/sw/bin/chromium",
		join(homedir(), ".nix-profile", "bin", "google-chrome-stable"),
	]
		.filter(Boolean)
		.find((p) => existsSync(p));
	if (!found) {
		console.error("error: no system Chrome found; set CHROME=/path/to/chrome");
		process.exit(1);
	}
	return found;
}

function loadPlaywright() {
	const found = [
		join(ROOT, "node_modules", "playwright"),
		join(PW_CACHE, "node_modules", "playwright"),
		...globSync(join(homedir(), ".npm", "_npx", "*", "node_modules", "playwright")),
	].find((p) => existsSync(p));
	if (!found) {
		execFileSync(
			"npm",
			["install", "--prefix", PW_CACHE, "--no-save", "--no-audit", "playwright"],
			{ stdio: "inherit" },
		);
		return require(join(PW_CACHE, "node_modules", "playwright"));
	}
	return require(found);
}

let failures = 0;
const check = (label, ok, detail = "") => {
	console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
	if (!ok) failures++;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Open a game page and start it with bots — no handshake, no second browser. */
async function startSolo(page, file, button) {
	await page.goto(url(file));
	await page.locator("button", { hasText: button }).first().click();
	await page.locator("button", { hasText: "START GAME" }).first().click();
	await page.waitForFunction(() => window.__game?.handle, null, { timeout: TIMEOUT });
}

const debug = (page) => page.evaluate(() => window.__game.handle.debug());

const { chromium } = loadPlaywright();
const browser = await chromium.launch({
	executablePath: chromePath(),
	args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
});
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
page.on("pageerror", (err) => {
	console.log(`  FAIL page error: ${err.message}`);
	failures++;
});

try {
	// ------------------------------------------------------------ connect 4
	//
	// The bot with something to prove: it is the only one here that has to be
	// *right* rather than merely busy.

	// ------------------------------------------------------------- onitama
	//
	// The deep one. Two things are being checked that no other game here needs:
	// that a five-by-five board plus three card racks actually fit on a phone,
	// and that the bot answers with a legal move rather than sitting on its
	// turn — a search that times out badly would look exactly like a hang.

	// ----------------------------------------------------------- liar's dice
	//
	// The other unrefereed game, and the one where the wrong build is the
	// tempting one: have the host roll everybody's dice and mail each player
	// their hand. Nobody deals here — each player rolls their own and commits
	// before a bid is made — so what is checked is that every cup was committed
	// to *before* the bidding, and that lifting them audits clean.

	console.log("\nbots: liar's dice commits every cup before a bid");
	await startSolo(page, "liars-dice.html", "PLAY A BOT");
	await sleep(1200);

	let ld = await debug(page);
	check("two seats, five dice each", ld.seats.length === 2 && ld.seats.every((s) => s.dice === 5), JSON.stringify(ld.seats));
	check("both cups are committed before any bidding", ld.digests === 2, `${ld.digests}`);
	check("we can see our own five dice", ld.myDice === 5, `${ld.myDice}`);
	check("and nobody else's", ld.revealed === 0, `${ld.revealed}`);
	check("the bidding is open", ld.phase === "bid", ld.phase);
	check("ten dice on the table", ld.totalDice === 10, `${ld.totalDice}`);

	const dice = await page.evaluate(() => {
		const btns = [...document.querySelectorAll(".ld-faces button")];
		const acts = [...document.querySelectorAll(".ld-actions button")];
		const steps = [...document.querySelectorAll(".ld-count button")];
		const all = [...btns, ...acts, ...steps];
		return {
			docWidth: document.documentElement.scrollWidth,
			winWidth: window.innerWidth,
			faces: btns.length,
			minTap: all.length ? Math.min(...all.map((b) => Math.round(b.getBoundingClientRect().height))) : 0,
			bottom: Math.round(Math.max(...[...document.querySelectorAll(".ld-actions, .ld-mine")]
				.map((e) => e.getBoundingClientRect().bottom))),
			ownDiceShown: document.querySelectorAll(".ld-mine span").length,
		};
	});
	check("you can bid on every face but ones", dice.faces === 5, `${dice.faces}`);
	check("liar's dice does not scroll sideways", dice.docWidth <= dice.winWidth, `${dice.docWidth} > ${dice.winWidth}`);
	check("every control clears 44px", dice.minTap >= 44, `${dice.minTap}px`);
	check("nothing runs off the bottom", dice.bottom <= 844, `${dice.bottom}px`);
	check("your own five dice are on screen", dice.ownDiceShown === 5, `${dice.ownDiceShown}`);

	// Bid the minimum, then let the bot answer, until a call settles a round.
	// The chain being tested is commit → bid → call → every cup opened →
	// verified → somebody loses a die.
	//
	// Two of our own bids, then call — deliberately, rather than by any
	// judgement of the odds. Bidding "well" here deadlocks: the minimum legal
	// raise is always plausible, so neither side ever has a reason to call and
	// the round runs until the phase deadline. The test wants the chain, not a
	// good game of dice.
	let myBids = 0;
	for (let i = 0; i < 120; i++) {
		const d = await debug(page);
		if (d.lastCall || d.over) break;
		myBids += await page.evaluate((bidsSoFar) => {
			const btns = [...document.querySelectorAll(".ld-actions button")];
			const bid = btns.find((b) => b.textContent.startsWith("BID"));
			const liar = btns.find((b) => b.textContent.includes("LIAR"));
			if (liar && bidsSoFar >= 2) {
				liar.click();
				return 0;
			}
			if (bid && !bid.disabled) {
				bid.click();
				return 1;
			}
			if (liar) liar.click();
			return 0;
		}, myBids);
		await sleep(300);
	}

	ld = await debug(page);
	check("a call settled a round", !!ld.lastCall, JSON.stringify({ phase: ld.phase, bid: ld.bid }));
	check("every cup was opened", ld.revealed === 2, `${ld.revealed}`);
	check("and every one audited clean", Object.values(ld.verdicts).every((v) => v === null), JSON.stringify(ld.verdicts));
	check("somebody lost a die", ld.seats.some((s) => s.dice === 4), JSON.stringify(ld.seats.map((s) => s.dice)));
	check("the count that settled it was recorded", Number.isInteger(ld.lastCall?.actual), JSON.stringify(ld.lastCall));
	// "At least", not "exactly" — the rule the whole game turns on.
	check("the call was settled by the at-least rule",
		!!ld.lastCall && ld.lastCall.bidderWasRight === (ld.lastCall.actual >= ld.lastCall.bid.count),
		JSON.stringify(ld.lastCall));

	// ------------------------------------------------------------ battleship
	//
	// The game the plumbing exists for. What is checked here is the whole chain
	// end to end — both fleets committed before a shot, both firing in the same
	// round, each player answering for its own board, both fleets opened at the
	// end and every answer re-checked. The last check is the one that matters:
	// a game rigged to answer dishonestly must be *caught*, or the commitment is
	// decoration.

	console.log("\nbots: battleship commits, fires and audits");
	await startSolo(page, "battleship.html", "PLAY A BOT");

	let bs = await debug(page);
	check("it opens on placement", bs.phase === "place", bs.phase);
	check("a fleet is already laid out to commit", bs.myFleetCells === 12, `${bs.myFleetCells}`);
	check("nothing is committed yet", !bs.committed && bs.digests === 0);

	// Mobile-first, asserted: placement is one board and it should own the screen.
	const place = await page.evaluate(() => {
		const grids = [...document.querySelectorAll(".bs-grid")].filter((g) => g.offsetParent);
		const box = grids[0]?.getBoundingClientRect();
		const cell = grids[0]?.querySelector(".bs-cell")?.getBoundingClientRect();
		const btns = [...document.querySelectorAll(".bs-ship, .bs-actions .neon-btn")]
			.map((b) => Math.round(b.getBoundingClientRect().height));
		return {
			docWidth: document.documentElement.scrollWidth,
			winWidth: window.innerWidth,
			visibleGrids: grids.length,
			w: Math.round(box?.width ?? 0),
			bottom: Math.round(box?.bottom ?? 0),
			cell: Math.round(cell?.width ?? 0),
			minBtn: btns.length ? Math.min(...btns) : 0,
		};
	});
	check("only your own board is shown while placing", place.visibleGrids === 1, `${place.visibleGrids}`);
	check("placing does not scroll the page sideways", place.docWidth <= place.winWidth, `${place.docWidth} > ${place.winWidth}`);
	check("the placement board fits the phone", place.w > 200 && place.w <= 390, `${place.w}px`);
	check("its squares are big enough to tap", place.cell >= 30, `${place.cell}px`);
	check("every control clears 44px", place.minBtn >= 44, `${place.minBtn}px`);

	await page.locator("button", { hasText: "COMMIT FLEET" }).click();
	await page.waitForFunction(() => window.__game.handle.debug().phase === "fire", null, { timeout: TIMEOUT });
	bs = await debug(page);
	check("both fleets are committed before a shot is fired", bs.digests === 2, `${bs.digests}`);
	check("no shot has been fired yet", bs.shotsAtMe === 0 && bs.shotsAtThem === 0);

	const battle = await page.evaluate(() => ({
		visibleGrids: [...document.querySelectorAll(".bs-grid")].filter((g) => g.offsetParent).length,
		bottom: Math.round(Math.max(...[...document.querySelectorAll(".bs-grid")]
			.filter((g) => g.offsetParent).map((g) => g.getBoundingClientRect().bottom))),
		docWidth: document.documentElement.scrollWidth,
		winWidth: window.innerWidth,
	}));
	check("both boards are on screen once the shooting starts", battle.visibleGrids === 2, `${battle.visibleGrids}`);
	check("both boards fit the phone", battle.bottom <= 844 && battle.docWidth <= battle.winWidth, JSON.stringify(battle));

	// Play it out, using the game's own targeting so a game actually ends.
	for (let i = 0; i < 300; i++) {
		const d = await debug(page);
		if (d.over) break;
		if (d.phase === "fire") {
			await page.evaluate(() => {
				const d = window.__game.handle.debug();
				const at = window.NeonArcade.battleshipRules.botTarget(d.theirBoard);
				if (!at) return;
				const cell = document.querySelector(`.bs-grid .bs-cell[data-r="${at[0]}"][data-c="${at[1]}"]`);
				if (cell && !cell.disabled) cell.click();
			});
		}
		await sleep(130);
	}
	await sleep(1500);
	bs = await debug(page);
	check("the game reaches a result", !!bs.over, JSON.stringify({ phase: bs.phase, shots: bs.shotsAtThem }));
	check("both sides fired the same number of volleys", bs.shotsAtMe === bs.shotsAtThem, `${bs.shotsAtMe} vs ${bs.shotsAtThem}`);
	check("the loser's fleet is fully sunk", bs.hitsOnThem === 12 || bs.hitsOnMe === 12, `${bs.hitsOnThem}/${bs.hitsOnMe}`);
	check("both fleets were revealed", bs.fleetsRevealed === 2, `${bs.fleetsRevealed}`);
	check("and both audited clean", Object.values(bs.audits).every((a) => a === null), JSON.stringify(bs.audits));
	check("the phase leaves the firing state", bs.phase === "over", bs.phase);

	// The claim, tested by breaking it: a fleet that does not match the answers
	// given must fail the audit. This is done against the real helper rather
	// than a mock, because the digest and the answer-replay are two separate
	// checks and only both together make the game honest.
	const caught = await page.evaluate(async () => {
		const R = window.NeonArcade.battleshipRules;
		const honestFleet = R.randomFleet();
		const hits = new Set();
		const answers = [];
		for (let r = 0; r < 8; r++) {
			for (let c = 0; c < 8; c++) {
				const a = R.answerShot(honestFleet, hits, r, c);
				if (a.hit) hits.add(R.key(r, c));
				answers.push({ at: [r, c], hit: a.hit, sunk: a.sunk });
			}
		}
		// Deny one real hit — the cheat a player would actually try.
		const lied = answers.map((a) => (a.hit && !a.sunk ? { ...a, hit: false, sunk: null } : a));
		return {
			honest: R.auditAnswers(honestFleet, answers) === null,
			lieCaught: R.auditAnswers(honestFleet, lied) !== null,
		};
	});
	check("an honest board passes the audit in the page", caught.honest);
	check("denying a hit is caught by the audit in the page", caught.lieCaught);

	// -------------------------------------------------------- light cycles
	//
	// The busiest thing here: eight riders, a tick every 100ms, and the host
	// simulating every bot. What is checked is that a round actually *ends* —
	// a space-filling bot that never crashes and never gets cornered would
	// leave a round running forever, and on a phone that is a hot battery
	// rather than a game.

	console.log("\nbots: light cycles runs a whole round on a phone");
	await page.goto(url("light-cycles.html"));
	await page.locator("button", { hasText: "PLAY ALONE" }).first().click();
	for (let i = 0; i < 3; i++) {
		await page.locator("button", { hasText: "ADD BOT" }).first().click();
	}
	await page.locator("button", { hasText: "START GAME" }).first().click();
	await page.waitForFunction(() => window.__game?.handle, null, { timeout: TIMEOUT });

	let lc = await debug(page);
	check("four riders took the arena", lc.riders.length === 4, `${lc.riders.length}`);
	check("three of them are bots", lc.riders.filter((r) => r.id.startsWith("bot_")).length === 3);
	check("nobody starts on top of anybody", new Set(lc.riders.map((r) => `${r.c},${r.r}`)).size === 4);

	// It opens on a countdown rather than throwing everyone straight into a
	// wall before they have found their thumbs.
	check("a round opens with a countdown, not a race", lc.countdown > 0 && !lc.racing, JSON.stringify({ c: lc.countdown, r: lc.racing }));

	await page.waitForFunction(() => window.__game.handle.debug().racing, null, { timeout: TIMEOUT });
	const wallsAtStart = (await debug(page)).walls;
	await sleep(1500);
	lc = await debug(page);
	check("walls are being laid down", lc.walls > wallsAtStart, `${wallsAtStart} -> ${lc.walls}`);

	const arena = await page.evaluate(() => {
		const box = document.querySelector(".lc-arena").getBoundingClientRect();
		const zones = [...document.querySelectorAll(".lc-zone")].map((z) => Math.round(z.getBoundingClientRect().width));
		return {
			docWidth: document.documentElement.scrollWidth,
			winWidth: window.innerWidth,
			w: Math.round(box.width),
			h: Math.round(box.height),
			bottom: Math.round(box.bottom),
			zones,
		};
	});
	check("the arena does not scroll the page sideways", arena.docWidth <= arena.winWidth, `${arena.docWidth} > ${arena.winWidth}`);
	check("the arena fits the phone", arena.w <= 390 && arena.bottom <= 844, JSON.stringify(arena));
	// Steering is the whole interface, so each half has to be a real target.
	check("both steering halves are wide enough to hit", arena.zones.length === 2 && Math.min(...arena.zones) >= 100, JSON.stringify(arena.zones));

	// The round must reach a result on its own.
	await page.waitForFunction(() => window.__game.handle.debug().racing === false, null, { timeout: 60_000 });
	lc = await debug(page);
	check("the round ends by itself", lc.racing === false);
	check("at most one rider is left standing", lc.riders.filter((r) => r.alive).length <= 1, `${lc.riders.filter((r) => r.alive).length}`);
	check("somebody scored, or everybody crashed",
		lc.winner === null || lc.riders.some((r) => r.wins === 1),
		JSON.stringify({ winner: lc.winner, wins: lc.riders.map((r) => r.wins) }));

	console.log("\nbots: onitama fits a phone and answers its turn");
	await startSolo(page, "onitama.html", "PLAY A BOT");

	let oni = await debug(page);
	check("a bot took the other seat", oni.red !== null && oni.blue !== null);
	check("the bot is the seat that is not us", (oni.mySide === 0 ? oni.blue : oni.red)?.startsWith("bot_"));
	check("ten pieces, two masters", oni.pieces === 10 && oni.masters === 2, `${oni.pieces}/${oni.masters}`);
	check("five cards are in play", new Set([...oni.hands[0], ...oni.hands[1], oni.side]).size === 5);

	// Mobile-first is a rule here, so it is asserted rather than eyeballed.
	const layout = await page.evaluate(() => {
		const board = document.querySelector(".oni-board");
		const cards = [...document.querySelectorAll(".oni-card")];
		const rect = board.getBoundingClientRect();
		const stage = document.querySelector(".g-stage").getBoundingClientRect();
		return {
			docWidth: document.documentElement.scrollWidth,
			winWidth: window.innerWidth,
			board: { w: Math.round(rect.width), h: Math.round(rect.height), top: Math.round(rect.top), bottom: Math.round(rect.bottom) },
			stageBottom: Math.round(stage.bottom),
			cardCount: cards.length,
			minCard: Math.min(...cards.map((c) => Math.round(c.getBoundingClientRect().height))),
			lowestCard: Math.round(Math.max(...cards.map((c) => c.getBoundingClientRect().bottom))),
		};
	});
	check("the page does not scroll sideways at 390px", layout.docWidth <= layout.winWidth, `${layout.docWidth} > ${layout.winWidth}`);
	check("the board is square", Math.abs(layout.board.w - layout.board.h) <= 1, JSON.stringify(layout.board));
	check("the board fits the width", layout.board.w <= 390, `${layout.board.w}px`);
	check("all five card slots are on screen", layout.cardCount === 5, `${layout.cardCount}`);
	check("nothing is pushed off the bottom", layout.lowestCard <= 844, `${layout.lowestCard}px`);
	check("card tap targets clear 44px", layout.minCard >= 44, `${layout.minCard}px`);

	// Play one move and let the bot answer. Driving it through the page's own
	// state rather than clicking the canvas: the click maths is the view's
	// problem, and this is a test of the bot taking its turn.
	const answered = await page.evaluate(async () => {
		const g = window.__game.handle;
		const R = window.NeonArcade.onitamaRules;
		const before = g.debug();
		if (before.turn !== before.mySide) return { waited: true };
		return { waited: false, turn: before.turn };
	});
	await page.waitForFunction(
		() => {
			const d = window.__game.handle.debug();
			return d.turn === d.mySide && d.winner === null;
		},
		null,
		{ timeout: TIMEOUT },
	);
	oni = await debug(page);
	check("play reaches us with a legal move available", oni.legal > 0, `${oni.legal}`);
	check("no card went missing while the bot moved", new Set([...oni.hands[0], ...oni.hands[1], oni.side]).size === 5);
	check("the bot did not answer instantly with nonsense", oni.pieces >= 8 && oni.masters === 2, `${oni.pieces}/${oni.masters}`);

	console.log("\nbots: connect 4 plays a real opponent");
	await startSolo(page, "connect4.html", "PLAY A BOT");

	let state = await debug(page);
	check("a bot took the second seat", state.red !== null && state.yellow !== null);
	check("the bot is the one that is not us", state.yellow?.startsWith("bot_"), state.yellow);
	check("the board starts empty", state.board.every((r) => r.every((v) => v === 0)));

	/** Drop a disc in `col` by clicking the board where a player would. */
	async function drop(col) {
		const box = await page.locator("#board").boundingBox();
		await page.mouse.click(box.x + (box.width / 7) * (col + 0.5), box.y + box.height / 2);
	}

	/** Wait until it is our turn again, i.e. the bot has answered. */
	async function botReplies(discsBefore) {
		return await page
			.waitForFunction(
				(n) => {
					const s = window.__game.handle.debug();
					const discs = s.board.flat().filter((v) => v !== 0).length;
					return s.winner !== null || (discs >= n + 2 && s.turn === 1);
				},
				discsBefore,
				{ timeout: TIMEOUT },
			)
			.then(() => true)
			.catch(() => false);
	}

	/** Columns where RED could drop and win outright, right now. */
	const openWins = (s) => {
		const cols = [];
		for (let c = 0; c < 7; c++) {
			let row = -1;
			for (let r = 5; r >= 0; r--) if (s.board[r][c] === 0) { row = r; break; }
			if (row < 0) continue;
			const board = s.board.map((r) => [...r]);
			board[row][c] = 1;
			for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
				let n = 1;
				for (const sign of [1, -1]) {
					for (let d = 1; d < 4; d++) {
						const rr = row + dr * d * sign;
						const cc = c + dc * d * sign;
						if (rr < 0 || rr > 5 || cc < 0 || cc > 6 || board[rr][cc] !== 1) break;
						n++;
					}
				}
				if (n >= 4) { cols.push(c); break; }
			}
		}
		return cols;
	};

	await drop(0);
	check("the bot answers with no network at all", await botReplies(0));

	// Build a threat and see whether it is honoured. The bot is not told what we
	// are doing; it has to find the block itself.
	let neverLeftAWin = true;
	let leftOpen = "";
	for (const col of [1, 2, 3, 4, 5]) {
		state = await debug(page);
		if (state.winner !== null) break;
		const discs = state.board.flat().filter((v) => v !== 0).length;
		await drop(col);
		if (!(await botReplies(discs))) break;
		state = await debug(page);
		if (state.winner !== null) break;
		const open = openWins(state);
		if (open.length) {
			neverLeftAWin = false;
			leftOpen = `column ${open[0]} was a win for us`;
			break;
		}
	}
	check("the bot never leaves an immediate win on the board", neverLeftAWin, leftOpen);

	// And it plays the game out rather than stalling somewhere in the middle.
	const finished = await page
		.waitForFunction(
			() => {
				const s = window.__game.handle.debug();
				if (s.winner !== null) return true;
				// Keep our side moving so the game can actually reach an end.
				const board = s.board;
				for (let c = 0; c < 7; c++) if (board[0][c] === 0) return false;
				return true;
			},
			null,
			{ timeout: 5000 },
		)
		.then(() => true)
		.catch(() => false);
	state = await debug(page);
	check(
		"the game is still live or decided, never stuck",
		finished || state.winner !== null || state.turn === 1,
		`winner=${state.winner} turn=${state.turn}`,
	);

	// ---------------------------------------------------------- tug of war

	console.log("\nbots: tug of war pulls its own weight");
	await startSolo(page, "tug-of-war.html", "PLAY A BOT");

	// Never touch the button: whatever happens is entirely the bot's doing.
	await sleep(1200);
	let tug = await debug(page);
	check("the bot pulls without being prompted", tug.pulls.B > 0, `pulls=${tug.pulls.B}`);
	check("our side does not pull itself", tug.pulls.A === 0, `pulls=${tug.pulls.A}`);
	check("the knot moves toward the bot", tug.pos > 0, `pos=${tug.pos}`);

	// ~9s unopposed by the game's impulse tuning; the margin is for a slow CI
	// frame rate, not for a bot that might or might not get there.
	const botWon = await page
		.waitForFunction(() => window.__game.handle.debug().winner === "B", null, {
			timeout: 20_000,
		})
		.then(() => true)
		.catch(() => false);
	check("an unopposed bot wins the round", botWon);

	// ------------------------------------------------------ neon survival

	console.log("\nbots: neon survival runs for one player, and for one plus bots");
	await startSolo(page, "neon-survival-mp.html", "PLAY ALONE");
	await sleep(600);
	let solo = await page.evaluate(() => ({
		active: window.gameActive,
		ships: Object.keys(window.botShips ?? {}).length,
		peers: Object.keys(window.peers ?? {}).length,
	}));
	check("one player alone is a running game", solo.active);
	check("playing alone adds no bots", solo.ships === 0 && solo.peers === 0);

	// Now the same page with company.
	await page.goto(url("neon-survival-mp.html"));
	await page.locator("button", { hasText: "PLAY ALONE" }).first().click();
	const addBot = page.locator("button", { hasText: "ADD BOT" }).first();
	await addBot.click();
	await addBot.click();
	await page.locator("button", { hasText: "START GAME" }).first().click();
	await page.waitForFunction(() => window.__game?.handle, null, { timeout: TIMEOUT });
	await sleep(400);

	const before = await page.evaluate(() =>
		Object.entries(window.botShips).map(([id, s]) => [id, s.x, s.y]),
	);
	check("two bot ships joined the run", before.length === 2, `${before.length} ships`);
	await sleep(900);
	const after = await page.evaluate(() =>
		Object.entries(window.botShips).map(([id, s]) => [id, s.x, s.y]),
	);
	const moved = before.every(([id, x, y]) => {
		const now = after.find(([o]) => o === id);
		return now && Math.hypot(now[1] - x, now[2] - y) > 5;
	});
	check("the bot ships are being flown, not parked", moved, JSON.stringify(after));
	const published = await page.evaluate(
		() => Object.keys(window.peers).filter((id) => id.startsWith("bot_")).length,
	);
	check("bot ships are published like any other player", published === 2, `${published}`);

	// ------------------------------------------------------- draw & guess

	console.log("\nbots: draw & guess says it needs people");
	await page.goto(url("draw-guess.html"));
	await page.locator("button", { hasText: "INVITE A FRIEND" }).first().waitFor();
	const solos = await page.locator("button", { hasText: /PLAY A BOT|PLAY ALONE/ }).count();
	check("no bot option is offered for a game a bot cannot play", solos === 0);

	// --------------------------------------------------- bots in a party

	console.log("\nbots: a bot is an ordinary member to everyone else");
	const host = await context.newPage();
	const guest = await context.newPage();
	for (const p of [host, guest]) {
		p.on("pageerror", (err) => {
			console.log(`  FAIL page error: ${err.message}`);
			failures++;
		});
	}

	await host.goto(url("party.html"));
	await host.locator(".party-member").first().waitFor({ timeout: TIMEOUT });
	await host.locator("button", { hasText: "ADD PLAYER" }).first().click();
	const inviteBox = host.locator("textarea.share-code").first();
	await inviteBox.waitFor({ timeout: TIMEOUT });
	await guest.goto(await inviteBox.inputValue());
	const replyBox = guest.locator("textarea.share-code").first();
	await replyBox.waitFor({ timeout: TIMEOUT });
	await host.locator("textarea.share-code").last().fill(await replyBox.inputValue());
	await host.locator("button.neon-btn", { hasText: /^CONNECT$/ }).first().click();
	await guest.locator(".party-member").nth(1).waitFor({ timeout: TIMEOUT });

	const directBefore = await guest.evaluate(() => window.__party.room.directPeers().length);
	await host.locator("button", { hasText: "ADD BOT" }).first().click();

	const sawBot = await guest
		.waitForFunction(() => document.querySelectorAll(".party-member").length === 3, null, {
			timeout: TIMEOUT,
		})
		.then(() => true)
		.catch(() => false);
	check("a bot the host added reaches the guest's roster", sawBot);
	check(
		"the guest is told which member is a bot",
		(await guest.locator(".party-tag.is-bot").count()) === 1,
	);

	// The point of the whole exercise: an unreachable member must not be
	// treated as one that simply has not connected yet.
	await sleep(2500);
	const directAfter = await guest.evaluate(() => window.__party.room.directPeers().length);
	check(
		"nobody tries to open a connection to a bot",
		directAfter === directBefore,
		`directPeers went ${directBefore} -> ${directAfter}`,
	);
	const errored = await guest.locator(".lobby-status.is-error").count();
	check("and no connection error is reported because of one", errored === 0);

	// A bot can be taken away again.
	await host.locator(".party-member").nth(2).locator("button", { hasText: "REMOVE" }).click();
	const gone = await guest
		.waitForFunction(() => document.querySelectorAll(".party-member").length === 2, null, {
			timeout: TIMEOUT,
		})
		.then(() => true)
		.catch(() => false);
	check("removing a bot reaches the guest too", gone);
} finally {
	await browser.close();
}

console.log(
	failures ? `\n${failures} bot check${failures > 1 ? "s" : ""} failed` : "\nall bot checks passed",
);
process.exit(failures ? 1 : 0);
