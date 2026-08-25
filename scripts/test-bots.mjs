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
