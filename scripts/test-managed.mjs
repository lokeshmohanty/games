// scripts/test-managed.mjs — SDK v2 Layer 2: the platform runs the game.
//
// A managed game writes rules and a draw function; lib/sdk-managed.js does
// host authority, views, bots, the end card, rematches and handover. This
// drives real browsers through what that promises:
//
//   1. Tic Tac Toe (sdk/v2/examples/tic-tac-toe-js), host vs a guest with a
//      third phone watching:
//      - each phone gets its own view;
//      - a move out of turn is refused;
//      - the shell's end card names the winner on every phone;
//      - PLAY AGAIN starts the next match;
//      - when the host's tab closes mid-match, the heir carries the board on
//        from its snapshot, and the shell's turn-wait banner lets it skip
//        the departed player.
//   2. A ticking fixture (scripts/fixtures/tick-game), host + guest + bot:
//      a guest's inputs and the bot's reach the host's tick, views arrive at
//      viewRate, and the result ends it.
//
// Every message across a frame is checked against sdk/v2/protocol.json, and
// every Layer 2 message type must have been seen.

import { spawn } from "node:child_process";
import { existsSync, globSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { catalogue, checkTrace } from "./protocol-check.mjs";
import { gameFrame, readyToClick, serve } from "./serve.mjs";

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TIMEOUT = 40_000;
const LAYER2 = ["act", "input", "rules", "view", "rejected"];

let failures = 0;
const check = (label, ok, detail = "") => {
	console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
	if (!ok) failures++;
};

function chromePath() {
	const found = [process.env.CHROME, "/run/current-system/sw/bin/google-chrome-stable", "/run/current-system/sw/bin/chromium", join(homedir(), ".nix-profile", "bin", "google-chrome-stable")]
		.filter(Boolean)
		.find((p) => existsSync(p));
	if (!found) throw new Error("no system Chrome found; set CHROME=/path/to/chrome");
	return found;
}
function loadPlaywright() {
	const found = [join(ROOT, "node_modules", "playwright"), join(homedir(), ".cache", "game-previews", "node_modules", "playwright"), ...globSync(join(homedir(), ".npm", "_npx", "*", "node_modules", "playwright"))].find((p) => existsSync(p));
	if (!found) throw new Error("playwright not found (run `just test-bots` once to fetch it)");
	return require(found);
}

const site = await serve(8741);
/** The dev kit's server for a folder of games; its base URL for `game`. */
async function devServer(folder, port, game) {
	const dev = spawn("node", [join(ROOT, "sdk/v1/dev-server.mjs"), join(ROOT, folder), String(port)], { env: { ...process.env, NEON_PLATFORM: site.base }, stdio: "ignore" });
	process.on("exit", () => dev.kill());
	const base = `http://127.0.0.1:${port}/${game}/`;
	for (let i = 0; i < 50 && !(await fetch(base + "game.json").then((r) => r.ok, () => false)); i++) await new Promise((r) => setTimeout(r, 100));
	return { base, stop: () => dev.kill() };
}

const { chromium } = loadPlaywright();
const browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox"] });
const traced = [];

/** A party of `n` phones on the dev game at `devBase`, formed by invites. */
async function party(devBase, n) {
	const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
	await context.addInitScript(() => {
		window.__sdk = [];
		window.NeonArcade = window.NeonArcade || {};
		NeonArcade.turnWaitMs = 500;
		NeonArcade.sdkTrace = (dir, m) => window.__sdk.push([dir, JSON.parse(JSON.stringify(m, (_k, v) => (v instanceof ArrayBuffer ? { $buffer: v.byteLength } : v)))]);
	});
	const pages = [];
	for (let i = 0; i < n; i++) {
		const page = await context.newPage();
		page.on("pageerror", (err) => check(`no page error on phone ${i + 1}`, false, err.message));
		pages.push(page);
	}
	const withDev = (url) => {
		const u = new URL(url);
		u.searchParams.set("dev", devBase);
		return u.href;
	};
	await pages[0].goto(`${site.base}/party.html?${new URLSearchParams({ dev: devBase, fresh: "1", rs: "http://127.0.0.1:1" })}`);
	await pages[0].locator(".party-member").first().waitFor({ timeout: TIMEOUT });
	for (const joiner of pages.slice(1)) {
		const host = pages[0];
		await host.locator("button", { hasText: "ADD PLAYER" }).first().click();
		const box = host.locator("textarea.share-code").first();
		await box.waitFor({ timeout: TIMEOUT });
		await joiner.goto(withDev(await box.inputValue()));
		const reply = joiner.locator("textarea.share-code").first();
		await reply.waitFor({ timeout: TIMEOUT });
		await host.locator("textarea.share-code").last().fill(await reply.inputValue());
		await host.locator("button.neon-btn", { hasText: /^CONNECT$/ }).first().click();
		await joiner.locator(".party-member").first().waitFor({ timeout: TIMEOUT });
	}
	await pages[0].locator(".party-member").nth(n - 1).waitFor({ timeout: TIMEOUT });
	const collect = async () => {
		for (const p of pages) if (!p.isClosed()) traced.push(...(await p.evaluate(() => window.__sdk.splice(0)).catch(() => [])));
	};
	return { context, pages, collect };
}
const ids = (pages) => Promise.all(pages.map((p) => p.evaluate(() => window.__party.room.selfId)));
const view = (frame) => frame.evaluate(() => window.arcade.view);
/** Poll `frame`'s view until `pred(view)`; the last view either way. */
async function viewUntil(frame, pred, ms = TIMEOUT) {
	const end = Date.now() + ms;
	let v = await view(frame).catch(() => null);
	while (!(v && pred(v)) && Date.now() < end) {
		await new Promise((r) => setTimeout(r, 150));
		v = await view(frame).catch(() => null);
	}
	return v;
}
const cardText = (page) => page.locator(".managed-over h2").textContent({ timeout: TIMEOUT }).catch(() => null);

try {
	// ---------------------------------------------------------------- 1
	console.log("\nmanaged: Tic Tac Toe, two players and a spectator");
	const ttt = await devServer("sdk/v2/examples", 5195, "tic-tac-toe-js");
	const A = await party(ttt.base, 3);
	const [host, p2, p3] = A.pages;
	const [hostId, p2Id, p3Id] = await ids(A.pages);
	await host.evaluate(({ hostId, p2Id, p3Id }) => {
		const r = window.__party.room;
		r.setTeam(hostId, "A");
		r.setTeam(p2Id, "B");
		r.setTeam(p3Id, "spectator");
	}, { hostId, p2Id, p3Id });
	await host.locator(".party-game", { hasText: "TIC TAC TOE (JS)" }).first().click({ timeout: TIMEOUT });
	const [fh, f2, f3] = await Promise.all(A.pages.map((p) => gameFrame(p, TIMEOUT)));
	const [vh, v2, v3] = await Promise.all([fh, f2, f3].map((f) => viewUntil(f, (v) => Array.isArray(v.board))));
	check("each phone gets its own view: X, O and a spectator", vh?.you === 1 && v2?.you === 2 && v3?.you === 0, { host: vh?.you, p2: v2?.you, p3: v3?.you });
	check("…of the same board, seated by team", vh?.x === hostId && vh?.o === p2Id && JSON.stringify(v2?.board) === JSON.stringify(vh?.board));

	// Out of turn: the host's rules refuse, and the guest is told why.
	await readyToClick(p2);
	await f2.locator("#ttt button").nth(4).click();
	check("a move out of turn is refused on the host, and the guest is told", await p2.locator(".neon-toast", { hasText: "not your turn" }).first().waitFor({ timeout: TIMEOUT }).then(() => true, () => false));

	const play = async (page, frame, i, after) => {
		await readyToClick(page);
		await frame.locator("#ttt button").nth(i).click();
		return viewUntil(f3, (v) => v.board.filter(Boolean).length === after);
	};
	await play(host, fh, 0, 1);
	await play(p2, f2, 3, 2);
	await play(host, fh, 1, 3);
	await play(p2, f2, 4, 4);
	const last = await play(host, fh, 2, 5);
	check("guests' moves travel to the host and every view follows", JSON.stringify(last?.board) === JSON.stringify([1, 1, 1, 2, 2, 0, 0, 0, 0]) && last?.winner === 1, last);
	const hostName = await host.evaluate(() => window.__party.room.self().name);
	const titles = await Promise.all([host, p2, p3].map(cardText));
	check("the shell's end card names the winner on every phone", titles[0] === "YOU WIN" && titles[1] === `${hostName.toUpperCase()} WINS` && titles[2] === titles[1], titles);
	check("…and only the host may start another", (await host.locator(".managed-over button", { hasText: "PLAY AGAIN" }).count()) === 1 && (await p2.locator(".managed-over button", { hasText: "PLAY AGAIN" }).count()) === 0);
	await host.locator(".managed-over button", { hasText: "PLAY AGAIN" }).click();
	const fresh = await viewUntil(f2, (v) => v.board.every((m) => m === 0));
	check("PLAY AGAIN: a fresh board on every phone, and the card goes", !!fresh && (await p2.locator(".managed-over").count()) === 0 && (await host.locator(".managed-over").count()) === 0);

	// Mid-match the host's tab closes: p2 (the longest-present) is the heir.
	await play(host, fh, 0, 1);
	await play(p2, f2, 4, 2);
	await viewUntil(f2, (v) => v.board[4] === 2);
	await new Promise((r) => setTimeout(r, 500)); // the heir's copy follows each move
	const kept = p2.locator(".neon-toast", { hasText: "You are the host now" }).first().waitFor({ timeout: TIMEOUT }).then(() => true, () => false);
	await A.collect();
	await host.close();
	check("the host leaves mid-match: the heir takes the crown and the game goes on", await kept);
	const carried = await view(f2);
	check("…from its copy of the board, not a fresh one", JSON.stringify(carried?.board) === JSON.stringify([1, 0, 0, 0, 2, 0, 0, 0, 0]), carried);
	// It is X's turn, and X has gone: the shell's banner, then SKIP TURN.
	const skip = p2.locator(".turn-wait:not([hidden]) button", { hasText: "SKIP TURN" });
	const offered = await skip.waitFor({ timeout: TIMEOUT }).then(() => true, () => false);
	check("the departed player's turn shows the shell's turn-wait banner", offered);
	if (offered) await skip.click();
	await play(p2, f2, 8, 3);
	const after = await viewUntil(f3, (v) => v.board[8] === 2, 10_000);
	check("…SKIP passes their turn, and the new host's move reaches the spectator", after?.board[8] === 2, after);
	await A.collect();
	await A.context.close();
	ttt.stop();

	// ---------------------------------------------------------------- 2
	console.log("\nmanaged: a ticking game, host + guest + bot");
	const tick = await devServer("scripts/fixtures", 5196, "tick-game");
	const B = await party(tick.base, 2);
	const [th, tg] = B.pages;
	const [thId, tgId] = await ids(B.pages);
	await th.locator("button", { hasText: "ADD BOT" }).first().click({ timeout: TIMEOUT });
	await th.locator(".party-member").nth(2).waitFor({ timeout: TIMEOUT });
	await th.evaluate(() => {
		const r = window.__party.room;
		for (const m of r.getMembers()) r.setTeam(m.id, "A");
	});
	await th.locator(".party-game", { hasText: "TICK CHECK" }).first().click({ timeout: TIMEOUT });
	const [gh, gg] = await Promise.all(B.pages.map((p) => gameFrame(p, TIMEOUT)));
	await gg.evaluate(() => window.arcade.input(2)); // the guest's input: 2 a tick
	await gh.evaluate(() => window.arcade.input(1)); // the host's: 1
	const mid = await viewUntil(gg, (v) => v.ticks >= 20);
	const botId = mid && Object.keys(mid.score).find((id) => id.startsWith("bot_"));
	check("ticks run on the host at the manifest's rate", mid?.dt === 0.05, mid?.dt);
	check("…with the guest's, the host's and the bot's inputs", mid?.last?.[tgId] === 2 && mid?.last?.[thId] === 1 && mid?.last?.[botId] === 3, mid?.last);
	const seen = await gg.evaluate(() => window.views.slice());
	const steps = seen.slice(1).map((t, i) => t - seen[i]).filter((d) => d > 0);
	const median = steps.sort((a, b) => a - b)[Math.floor(steps.length / 2)];
	check("views come at viewRate, not every tick (20 Hz ticks, 10 Hz views)", median === 2, { steps: steps.slice(0, 12) });
	const end = await th.locator(".managed-over h2").textContent({ timeout: 60_000 }).catch(() => null);
	check("the result ends it: the bot, at 3 a tick, wins", end === `${(await th.evaluate((id) => window.__party.room.getMember(id).name, botId)).toUpperCase()} WINS`, end);
	await B.collect();
	await B.context.close();
	tick.stop();

	// ---------------------------------------------------------------- schema
	console.log("\nmanaged: every message against sdk/v2/protocol.json");
	const wrong = checkTrace(traced);
	check(`all ${traced.length} messages conform`, !wrong.length, wrong.slice(0, 5).join(" | "));
	const types = new Set(traced.map(([, m]) => m.t));
	const missing = LAYER2.filter((t) => !types.has(t));
	check("every Layer 2 message was exercised", !missing.length, `never seen: ${missing.join(", ")}`);
	check("…and they are all in the catalogue", LAYER2.every((t) => catalogue("toShell").includes(t) || catalogue("toFrame").includes(t)));
} catch (err) {
	check("the run completes", false, err.stack?.split("\n").slice(0, 3).join(" ") ?? String(err));
} finally {
	await browser.close();
	site.stop();
}
console.log(failures ? `\n${failures} managed check(s) failed` : "\nall managed checks passed");
process.exit(failures ? 1 : 0);
