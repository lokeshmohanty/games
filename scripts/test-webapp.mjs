#!/usr/bin/env node
/**
 * test-webapp.mjs — an ordinary web app and its Python server, run unchanged
 * by two real browser peers (docs/sdk.md, "Web apps").
 *
 *   node scripts/test-webapp.mjs     (needs sdk/v1/pyodide/: just pyodide)
 *
 * The app (scripts/fixtures/webapp/) is served by the dev kit, as an author's
 * would be. It fetch()es "http://localhost:8000", shares a room by putting it
 * in its URL, polls, shows an <img src="/dot.svg"> and opens /rules.html —
 * none of which a sandboxed frame allows. Checked: its FastAPI server runs on
 * the host's phone and answers both phones; a new room on one phone moves the
 * other there; a click on the guest shows on the host; images and the rules
 * page load; neither frame can reach the network, from JS or from Python; and
 * when the host leaves, the game ends rather than half-running.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, globSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PORT_OFFSET, serve } from "./serve.mjs";

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TIMEOUT = 40_000;
const DEV_PORT = 5191 + PORT_OFFSET;

let failures = 0;
const check = (label, ok, detail = "") => {
	console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
	if (!ok) failures++;
	return ok;
};

if (!existsSync(join(ROOT, "sdk/v1/pyodide/VERSION"))) {
	console.error("sdk/v1/pyodide/ is missing: run `just pyodide` (node scripts/vendor-pyodide.mjs)");
	process.exit(1);
}
const chrome = [process.env.CHROME, "/run/current-system/sw/bin/google-chrome-stable", "/run/current-system/sw/bin/chromium", "/usr/bin/google-chrome"]
	.filter(Boolean)
	.find((p) => existsSync(p));
const pw = [join(ROOT, "node_modules", "playwright"), join(homedir(), ".cache", "game-previews", "node_modules", "playwright"), ...globSync(join(homedir(), ".npm", "_npx", "*", "node_modules", "playwright"))].find(
	(p) => existsSync(p),
);
if (!chrome || !pw) {
	console.error("needs Chrome (CHROME=) and playwright (run `just test-bots` once)");
	process.exit(1);
}
const { chromium } = require(pw);

const site = await serve(8737);
const dev = spawn("node", [join(ROOT, "sdk/v1/dev-server.mjs"), join(ROOT, "scripts/fixtures"), String(DEV_PORT)], { stdio: "ignore" });
process.on("exit", () => dev.kill());
await new Promise((r) => setTimeout(r, 500));
const PARTY = `${site.base}/party.html?${new URLSearchParams({ dev: `http://127.0.0.1:${DEV_PORT}/webapp/`, game: "dev/webapp-fixture", fresh: "1", rs: "http://127.0.0.1:1" })}`;

const browser = await chromium.launch({ executablePath: chrome, args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const host = await context.newPage();
const guest = await context.newPage();
const errors = [];
const stubs = [];
host.on("console", (m) => /imported as stubs/.test(m.text()) && stubs.push(m.text()));
for (const [page, tag] of [
	[host, "host"],
	[guest, "guest"],
]) {
	page.on("pageerror", (e) => errors.push(`${tag}: ${e.message}`));
	page.on("console", (m) => m.type() === "error" && !/room server|Failed to load resource/i.test(m.text()) && errors.push(`${tag}: ${m.text()}`));
}

/**
 * The app's frame on `page` (the one with the SDK in it, not the server's),
 * once `ready` holds in it — a frame is replaced when the address changes.
 */
async function appFrame(page, ready = "true") {
	const end = Date.now() + TIMEOUT;
	while (Date.now() < end) {
		for (const f of page.frames()) {
			if (f === page.mainFrame() || f.isDetached()) continue;
			if (await f.evaluate(`!!window.__game && !!document.getElementById("hello") && (${ready})`).catch(() => false)) return f;
		}
		await page.waitForTimeout(200);
	}
	return null;
}
const text = (frame, id, want) =>
	frame
		.waitForFunction(([i, w]) => document.getElementById(i)?.textContent.includes(w), [id, want], { timeout: TIMEOUT, polling: 250 })
		.then(() => true)
		.catch(() => false);

try {
	console.log("\nweb app: forming a party of two");
	await host.goto(PARTY);
	await host.locator("button", { hasText: "PLAY WITH FRIENDS" }).first().click({ timeout: TIMEOUT, polling: 250 });
	await host.locator("button", { hasText: "INVITE A FRIEND" }).first().click();
	const link = await host.locator("textarea.share-code").first().inputValue();
	await guest.goto(link);
	const reply = await guest.locator("textarea.share-code").first().inputValue();
	await host.locator("textarea.share-code").last().fill(reply);
	await host.locator("button.neon-btn", { hasText: /^CONNECT$/ }).first().click();
	await host.locator(".party-member").nth(1).waitFor({ timeout: TIMEOUT, polling: 250 });
	await host.locator("button", { hasText: "START GAME" }).first().click({ timeout: TIMEOUT, polling: 250 });

	console.log("\nweb app: running");
	let hf = await appFrame(host);
	let gf = await appFrame(guest);
	check("the app's frames are sandboxed (opaque origin)", (await hf.evaluate(() => self.origin)) === "null" && (await gf.evaluate(() => self.origin)) === "null");
	check("the server frame runs only on the host", (await host.locator("iframe[title$=' server']").count()) === 1 && (await guest.locator("iframe[title$=' server']").count()) === 0);
	check("the host's app reaches the Python server", await text(hf, "hello", "hello from python"));
	check("the guest's app reaches it too, over the party", await text(gf, "hello", "hello from python"));
	const dot = await hf.waitForFunction(() => document.getElementById("dot").naturalWidth > 0, null, { timeout: TIMEOUT, polling: 250 }).then(() => true).catch(() => false);
	check('an <img src="/dot.svg"> loads from the app\'s folder', dot);

	await host.bringToFront(); // a click into a background page's frame misses (docs/sdk.md)
	await hf.locator("#new").click();
	const inRoom = `/room \\w+/.test(document.getElementById("room").textContent)`;
	hf = await appFrame(host, inRoom);
	const hostRoom = hf && (await hf.evaluate(() => document.getElementById("room").textContent));
	check("a new room moves the host's app to its address", !!hostRoom, "still no room");
	gf = await appFrame(guest, inRoom);
	const guestRoom = gf && (await gf.evaluate(() => document.getElementById("room").textContent));
	check("…and the guest's app follows it there", !!hostRoom && guestRoom === hostRoom, `${guestRoom} vs ${hostRoom}`);
	if (!hf || !gf) throw new Error("no room to play in");
	await guest.bringToFront();
	await gf.locator("#click").click();
	await gf.locator("#click").click();
	check("the guest's clicks show on the host (polling the host's server)", await text(hf, "count", "2"));

	await host.bringToFront();
	await hf.locator("#rules").click();
	const overlay = await hf.waitForFunction(() => [...document.querySelectorAll("iframe")].some((f) => f.srcdoc.includes("The rules")), null, { timeout: TIMEOUT, polling: 250 }).then(() => true).catch(() => false);
	check("window.open('/rules.html') opens the page over the app", overlay);

	const leak = await hf.evaluate(() => window.leak());
	check("Python cannot reach the network", leak.status !== 200, JSON.stringify(leak));
	const jsLeak = await hf.evaluate(() => new Promise((r) => {
		const img = new Image();
		img.onload = () => r("loaded");
		img.onerror = () => r("blocked");
		HTMLImageElement.prototype.__lookupSetter__("src").call(img, "https://example.com/favicon.ico");
	}));
	check("the app cannot reach the network", jsLeak === "blocked");
	check("a package with no browser build imports as a stub", stubs.some((s) => /psycopg2/.test(s)), stubs.join(" | ") || "no stub notice");
	check("no page or console errors", !errors.filter((e) => !/Content Security Policy|example\.com|net::ERR/.test(e)).length, errors.slice(0, 3).join(" | "));

	console.log("\nweb app: the host leaves");
	await host.close();
	const ended = await guest
		.waitForFunction(() => !window.__party?.game, null, { timeout: 60_000, polling: 250 })
		.then(() => true)
		.catch(() => false);
	check("the game ends on the guest (its server left with the host)", ended);
} catch (err) {
	check("the run completed", false, err.message.split("\n")[0]);
} finally {
	await browser.close();
	site.stop();
	dev.kill();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall web app checks pass");
process.exit(failures ? 1 : 0);
