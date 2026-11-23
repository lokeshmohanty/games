// scripts/test-devkit.mjs — the game dev kit, as an outside author uses it.
//
// The SDK's example games (sdk/v2/examples/) are each served by the
// author-side server (sdk/dev-server.mjs) on one port, the arcade on
// another — two origins, as the live site and an author's machine are — and
// the game is loaded with `./?dev=…`, played against a bot to the end, at
// 390x844. A `?dev=` that is not on this machine must be refused. The dev
// kit's old public address (sdk/v1/dev-server.mjs, a copy the build makes
// until 2027-02-15) must serve the same file. validate-game must start a
// game that allows bots against them and play it, and skip only a game for
// people alone (scripts/fixtures/turns-game, three ways).

import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PORT_OFFSET, gameFrame, readyToClick, serve } from "./serve.mjs";
import { loadPlaywright } from "./playwright.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TIMEOUT = 30_000;
const DEV_PORT = 5175 + PORT_OFFSET;

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

const site = await serve(8735);
const { chromium } = loadPlaywright();
const browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });

/** Serve an examples folder as an author would, and play `game` from it against a bot. */
async function playExample(label, folder, game, port) {
	const dev = spawn("node", [join(ROOT, "sdk/dev-server.mjs"), join(ROOT, folder), String(port)], {
		env: { ...process.env, NEON_PLATFORM: site.base },
	});
	process.on("exit", () => dev.kill());
	const printed = await new Promise((r) => {
		let out = "";
		dev.stdout.on("data", (d) => {
			out += d;
			if (out.includes(`game=dev%2F${game}`)) setTimeout(() => r(out), 50);
		});
	});
	const page = await ctx.newPage();
	page.on("pageerror", (err) => check(`no page error (${err.message})`, false));

	console.log(`\ndevkit (${label}): the author's server`);
	const link = printed.match(new RegExp(`http\\S+/\\?\\S+game=dev%2F${game}(?=&|\\s|$)\\S*`))?.[0];
	check("prints a link to the arcade for each game", !!link, printed);
	const head = await fetch(`http://127.0.0.1:${port}/${game}/game.json`);
	check("answers with CORS allowed", head.headers.get("access-control-allow-origin") === "*");
	check("…and does not let the browser cache it", head.headers.get("cache-control") === "no-store");
	const escape = await fetch(`http://127.0.0.1:${port}/../package.json`).catch(() => null);
	check("…and serves nothing outside its folder", !escape || escape.status !== 200);

	console.log(`\ndevkit (${label}): the game in the real party`);
	await page.goto(link);
	await page.locator("button", { hasText: "SINGLE PLAYER" }).first().click({ timeout: TIMEOUT });
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
	if (label.startsWith("sdk v2")) {
		const shell = await frame.evaluate(() => typeof window.NeonArcade);
		check("…with none of the shell's globals in it, only the protocol", shell === "undefined", shell);
	}
	const fits = await frame.evaluate(() => {
		const b = [...document.querySelectorAll("#ttt button")].map((x) => x.getBoundingClientRect());
		return { n: b.length, right: Math.max(...b.map((r) => r.right)), bottom: Math.max(...b.map((r) => r.bottom)), w: innerWidth };
	});
	check("its board fits the phone", fits.n === 9 && fits.right <= 390 && fits.bottom <= 844, JSON.stringify(fits));

	// Play the first free square on each of our turns until the game ends.
	await readyToClick(page);
	const end = Date.now() + TIMEOUT;
	const me = await frame.evaluate(() => window.arcade.party.self);
	let state = await frame.evaluate(() => window.__game.handle.debug());
	while (state.winner === null && Date.now() < end) {
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
	await page.close();
	dev.kill();
}

await playExample("sdk v2, JavaScript", "sdk/v2/examples", "tic-tac-toe", DEV_PORT + 1);
await playExample("sdk v2 managed, Rust", "sdk/v2/examples", "tic-tac-toe-rust", DEV_PORT + 2);
await playExample("sdk v2 managed, JavaScript", "sdk/v2/examples", "tic-tac-toe-js", DEV_PORT + 3);
await playExample("sdk v2 managed, HTML/CSS", "sdk/v2/examples", "tic-tac-toe-html", DEV_PORT + 4);
await playExample("sdk v2 managed, TypeScript", "sdk/v2/examples", "tic-tac-toe-ts", DEV_PORT + 5);
await playExample("sdk v2 managed, Go", "sdk/v2/examples", "tic-tac-toe-go", DEV_PORT + 6);
await playExample("sdk v2 managed, C", "sdk/v2/examples", "tic-tac-toe-c", DEV_PORT + 7);

console.log("\ndevkit: the old public address");
{
	// Transition copy for authors who fetched the dev kit from sdk/v1/ (made
	// by scripts/assemble.mjs; remove on 2027-02-15, docs/platform.md).
	const old = await fetch(`${site.base}/sdk/v1/dev-server.mjs`);
	const now = await fetch(`${site.base}/sdk/dev-server.mjs`);
	const source = readFileSync(join(ROOT, "sdk/dev-server.mjs"), "utf8");
	check("sdk/v1/dev-server.mjs is still served, identical to sdk/dev-server.mjs", old.ok && now.ok && (await old.text()) === source && (await now.text()) === source, `${old.status} ${now.status}`);
}

console.log("\ndevkit: only this machine");
const away = await ctx.newPage();
// Watched for from before the page loads: the notice comes around the load
// event and lives 4.5 s.
const warned = away
	.locator(".neon-toast", { hasText: "must be a server on this machine" })
	.waitFor({ timeout: TIMEOUT })
	.then(() => true, () => false);
await away.goto(`${site.base}/?dev=${encodeURIComponent("https://example.com/game/")}&game=dev%2Fx&fresh=1`);
check("a ?dev= that is not loopback is refused, and says why", await warned);

await browser.close();
site.stop();

console.log("\ndevkit: validate-game plays a game that allows bots");
{
	// The quick-start merge (2026-11-22) left validate-game looking for a
	// SINGLE PLAYER button it no longer found, so every game that allows
	// bots — the registry's PR check too — was "needs people" and never
	// played. The fixture three ways: bots, no "bots" (the default: allowed),
	// and "bots": false (people only: the one honest skip).
	const tmp = mkdtempSync(join(tmpdir(), "neon-validate-"));
	const variant = (name, edit) => {
		const dir = join(tmp, name, "turns-game");
		cpSync(join(ROOT, "scripts/fixtures/turns-game"), dir, { recursive: true });
		const m = JSON.parse(readFileSync(join(dir, "game.json"), "utf8"));
		edit(m);
		writeFileSync(join(dir, "game.json"), JSON.stringify(m, null, 2));
		return dir;
	};
	const games = [
		["bots", variant("bots", () => {}), true],
		['no "bots" (allowed by default)', variant("default", (m) => delete m.bots), true],
		['"bots": false', variant("people", (m) => (m.bots = false)), false],
	];
	try {
		for (const [label, dir, plays] of games) {
			// Ports of its own, clear of this suite's.
			const run = spawnSync("node", [join(ROOT, "scripts/validate-game.mjs"), dir], { env: { ...process.env, NEON_PORT_OFFSET: String(PORT_OFFSET + 60) }, encoding: "utf8", timeout: 120_000 });
			const out = `${run.stdout}${run.stderr}`;
			const played = /ok {3}it mounts in its sandboxed frame/.test(out) && /ok {3}5 s of play with no page or console error/.test(out);
			const skipped = /skipped the play check/.test(out);
			const said = out.split("\n").filter((l) => /FAIL|skipped|mounts|5 s of play/.test(l)).join(" | ") || out.slice(-400);
			if (plays) check(`validate-game, ${label}: started against bots and play-checked, not skipped`, run.status === 0 && played && !skipped, said);
			else check(`validate-game, ${label}: needs people, so the play check is skipped`, run.status === 0 && skipped && !played, said);
		}
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

console.log(failures ? `\n${failures} devkit check(s) failed` : "\nall devkit checks passed");
process.exit(failures ? 1 : 0);
