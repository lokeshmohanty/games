// scripts/test-devkit.mjs — the game dev kit, as an outside author uses it.
//
// The SDK's example game (sdk/v1/example/tic-tac-toe) is served by the
// author-side server (sdk/v1/dev-server.mjs) on one port, the arcade on
// another — two origins, as the live site and an author's machine are — and
// the game is loaded with `party.html?dev=…`, played against a bot to the end,
// at 390x844. A `?dev=` that is not on this machine must be refused.

import { spawn } from "node:child_process";
import { existsSync, globSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gameFrame, readyToClick, serve } from "./serve.mjs";

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TIMEOUT = 30_000;
const DEV_PORT = 5175;

let failures = 0;
const check = (label, ok, detail = "") => {
	console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
	if (!ok) failures++;
};

function chromePath() {
	const found = [
		process.env.CHROME,
		"/run/current-system/sw/bin/google-chrome-stable",
		"/run/current-system/sw/bin/chromium",
		join(homedir(), ".nix-profile", "bin", "google-chrome-stable"),
	]
		.filter(Boolean)
		.find((p) => existsSync(p));
	if (!found) throw new Error("no system Chrome found; set CHROME=/path/to/chrome");
	return found;
}
function loadPlaywright() {
	const found = [
		join(ROOT, "node_modules", "playwright"),
		join(homedir(), ".cache", "game-previews", "node_modules", "playwright"),
		...globSync(join(homedir(), ".npm", "_npx", "*", "node_modules", "playwright")),
	].find((p) => existsSync(p));
	if (!found) throw new Error("playwright not found (run `just test-bots` once to fetch it)");
	return require(found);
}

const site = await serve(8735);
const dev = spawn("node", [join(ROOT, "sdk/v1/dev-server.mjs"), join(ROOT, "sdk/v1/example"), String(DEV_PORT)], {
	env: { ...process.env, NEON_PLATFORM: site.base },
});
const printed = await new Promise((r) => {
	let out = "";
	dev.stdout.on("data", (d) => {
		out += d;
		if (out.includes("party.html?")) setTimeout(() => r(out), 50);
	});
});
process.on("exit", () => dev.kill());

const { chromium } = loadPlaywright();
const browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
page.on("pageerror", (err) => check(`no page error (${err.message})`, false));

console.log("\ndevkit: the author's server");
const link = printed.match(/http\S+party\.html\?\S+/)?.[0];
check("prints a link to the arcade for each game", !!link && link.includes("game=dev%2Ftic-tac-toe"), printed);
const head = await fetch(`http://127.0.0.1:${DEV_PORT}/tic-tac-toe/game.json`);
check("answers with CORS allowed", head.headers.get("access-control-allow-origin") === "*");
check("…and does not let the browser cache it", head.headers.get("cache-control") === "no-store");
const escape = await fetch(`http://127.0.0.1:${DEV_PORT}/../package.json`).catch(() => null);
check("…and serves nothing outside its folder", !escape || escape.status !== 200);

console.log("\ndevkit: the game in the real party");
await page.goto(link);
await page.locator("button", { hasText: "PLAY WITH BOTS" }).first().click({ timeout: TIMEOUT });
await page.locator("button", { hasText: "START GAME" }).first().click({ timeout: TIMEOUT });
const frame = await gameFrame(page, TIMEOUT);
check("the dev game mounts in a sandboxed frame", (await page.locator("iframe.game-frame[sandbox='allow-scripts']").count()) === 1);
check(
	"…which cannot read the arcade's storage",
	(await frame.evaluate(() => {
		try {
			localStorage.length;
			return "readable";
		} catch (e) {
			return e.name;
		}
	})) === "SecurityError",
);
const fits = await frame.evaluate(() => {
	const b = [...document.querySelectorAll("#ttt button")].map((x) => x.getBoundingClientRect());
	return { n: b.length, right: Math.max(...b.map((r) => r.right)), bottom: Math.max(...b.map((r) => r.bottom)), w: innerWidth };
});
check("its board fits the phone", fits.n === 9 && fits.right <= 390 && fits.bottom <= 844, JSON.stringify(fits));

// Play the first free square on each of our turns until the game ends.
await readyToClick(page);
const end = Date.now() + TIMEOUT;
let state = await frame.evaluate(() => window.__game.handle.debug());
while (state.winner === null && Date.now() < end) {
	const me = await frame.evaluate(() => window.__game.ctx.room.selfId);
	const mine = state.x === me ? 1 : 2;
	if (state.turn === mine) {
		const i = state.board.findIndex((m) => m === 0);
		await frame.locator("#ttt button").nth(i).click();
	}
	await page.waitForTimeout(250);
	state = await frame.evaluate(() => window.__game.handle.debug());
}
check("a whole game against the bot reaches an end", state.winner !== null, JSON.stringify(state));
check("the bot made its moves", state.board.filter((m) => m === 2).length >= 2, JSON.stringify(state.board));

console.log("\ndevkit: only this machine");
const away = await ctx.newPage();
await away.goto(`${site.base}/party.html?dev=${encodeURIComponent("https://example.com/game/")}&game=dev%2Fx&fresh=1`);
const warned = await away
	.locator(".neon-toast", { hasText: "must be a server on this machine" })
	.waitFor({ timeout: TIMEOUT })
	.then(() => true, () => false);
check("a ?dev= that is not loopback is refused, and says why", warned);

await browser.close();
dev.kill();
site.stop();
console.log(failures ? `\n${failures} devkit check(s) failed` : "\nall devkit checks passed");
process.exit(failures ? 1 : 0);
