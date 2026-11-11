#!/usr/bin/env node
/**
 * test-worker.mjs — the real room server, under `wrangler dev`, with real
 * browsers.
 *
 *   node scripts/test-worker.mjs        (or: just test-worker)
 *
 * test-room.mjs drives the client against an in-page mock, which is one
 * page's private server: two pages can never meet through it. This suite
 * starts worker/ under `wrangler dev` itself and points separate browser
 * contexts at it, so everything that needs two browsers *and* a server —
 * a code link into a live party, a rejoin nobody answers, a leave racing
 * the navigation that follows it — runs end to end:
 *
 *   1. guessing different codes from one IP is blocked (IpGate), and a
 *      second IP is not;
 *   2. NEW PARTY and ALL GAMES really release the seat before navigating;
 *   3. the reconnect screen after a rejoin nobody answered: RETRY and
 *      START A NEW PARTY both work;
 *   4. a `#c=` link opened in a tab with a live party asks first;
 *   5. a classic-invite join drops an old party's rejoin token;
 *   6. a reconnect with the room server unreachable keeps the token and
 *      offers RETRY, which works once the server is back;
 *   7. a second tab with the same rejoin token takes the seat once — the
 *      first stands down and says so, rather than the two trading it.
 *
 * Wrangler comes from $WRANGLER (a command line), else `wrangler` on PATH,
 * else `nix shell nixpkgs#wrangler` (npx wrangler cannot link workerd on
 * NixOS). If it cannot start, the suite says so and exits 0 — it is not in
 * the default `just test`, for exactly that dependency.
 *
 * Every node-side probe sends its own CF-Connecting-IP, which `wrangler dev`
 * passes through, so probes never share a rate-limit bucket with each other
 * or with the browsers. State is persisted to a fresh temp dir per run.
 */
import { createRequire } from "node:module";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, globSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const PW_CACHE = join(homedir(), ".cache", "game-previews");
const PARTY = `file://${join(ROOT, "party.html")}`;
const TIMEOUT = 40_000;
// room-join's JOIN_ANSWER_MS (30s) plus the reconnect's own dial and margin.
const NO_ANSWER_WAIT = 50_000;

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
		execFileSync("npm", ["install", "--prefix", PW_CACHE, "--no-save", "--no-audit", "playwright"], {
			stdio: "inherit",
		});
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

// ------------------------------------------------------------ the server

/** A port nothing is listening on, so a second run never collides. */
const freePort = () =>
	new Promise((done, fail) => {
		const srv = createServer();
		srv.on("error", fail);
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address();
			srv.close(() => done(port));
		});
	});

function onPath(bin) {
	return (process.env.PATH ?? "").split(":").some((d) => d && existsSync(join(d, bin)));
}

/** Start `wrangler dev`; resolves { base, stop } or null when it cannot. */
async function startWrangler() {
	const port = await freePort();
	const inspector = await freePort();
	const state = mkdtempSync(join(tmpdir(), "neon-room-"));
	const args = ["dev", "--port", String(port), "--ip", "127.0.0.1", "--inspector-port", String(inspector), "--persist-to", state];
	const [cmd, ...pre] = process.env.WRANGLER
		? process.env.WRANGLER.split(/\s+/)
		: onPath("wrangler")
			? ["wrangler"]
			: ["nix", "shell", "nixpkgs#wrangler", "-c", "wrangler"];
	let log = "";
	let exited = false;
	const child = spawn(cmd, [...pre, ...args], {
		cwd: join(ROOT, "worker"),
		detached: true, // its own process group: nix → wrangler → workerd all go together
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
	});
	child.stdout.on("data", (d) => (log += d));
	child.stderr.on("data", (d) => (log += d));
	child.on("error", (err) => ((exited = true), (log += String(err))));
	child.on("exit", () => (exited = true));
	const stop = () => {
		try {
			process.kill(-child.pid, "SIGTERM");
		} catch {}
		rmSync(state, { recursive: true, force: true });
	};
	const base = `http://127.0.0.1:${port}`;
	// nix may have to fetch wrangler the first time; after that it is seconds.
	const deadline = Date.now() + 180_000;
	while (Date.now() < deadline && !exited) {
		try {
			if ((await fetch(base + "/not-a-room")).status === 404) return { base, stop };
		} catch {}
		await sleep(500);
	}
	stop();
	console.log(`skip: wrangler dev did not start (${cmd} ${pre.join(" ")}).`);
	console.log(log.split("\n").slice(-15).join("\n"));
	return null;
}

const server = await startWrangler();
if (!server) process.exit(0);
const WS = server.base.replace(/^http/, "ws");
console.log(`room server: ${server.base}`);

/**
 * One exchange with the server from node, as `ip`: send `msg` to room
 * `code`, resolve the first reply (or "closed"/"error"), then hang up.
 */
let probeIp = 0;
const freshIp = () => `10.9.${Math.floor(++probeIp / 250)}.${probeIp % 250}`;
function call(code, msg, ip = freshIp()) {
	return new Promise((done) => {
		const ws = new WebSocket(`${WS}/room/${code}`, { headers: { "CF-Connecting-IP": ip } });
		const timer = setTimeout(() => done({ t: "timeout" }), 8000);
		ws.onopen = () => ws.send(JSON.stringify({ code, ...msg }));
		ws.onmessage = (e) => {
			clearTimeout(timer);
			done(JSON.parse(e.data));
			ws.close();
		};
		ws.onerror = () => {
			clearTimeout(timer);
			done({ t: "error", reason: "socket" });
		};
	});
}
/**
 * Does `code` still hold a claim for `id`? A join as `id` with a secret
 * nobody has answers id-taken if the claim is held, "joined" if the seat
 * is free, no-room if the room is gone with it.
 */
const claimOf = async (code, id) => (await call(code, { t: "join", id, secret: "probe-" + Math.random() })).reason ?? "free";

// ------------------------------------------------------------ the browsers

const { chromium } = loadPlaywright();
const browser = await chromium.launch({
	executablePath: chromePath(),
	args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
});

/**
 * A fresh browser context — its own localStorage, so its own rejoin token
 * — with every page in it pointed at the local server. Set by init script
 * rather than `?rs=`, because NEW PARTY navigates to `party.html?fresh=1`
 * and would drop the query, and land on the deployed server.
 */
async function person(tag) {
	const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
	await context.addInitScript((rs) => {
		try {
			localStorage.setItem("neon.rs", rs);
		} catch {}
	}, server.base);
	const page = await context.newPage();
	page.on("pageerror", (err) => {
		console.log(`  FAIL page error on ${tag}: ${err.message}`);
		failures++;
	});
	return page;
}

const token = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("neon.room") || "null"));
const members = (page) => page.locator(".party-member").count();

/** Wait until `page`'s roster shows `n` members. */
async function waitForMembers(page, n) {
	try {
		await page
			.locator(".party-member")
			.nth(n - 1)
			.waitFor({ timeout: TIMEOUT });
		return true;
	} catch {
		return false;
	}
}

/**
 * Host a party through the room server; resolves its token. `?fresh=1`,
 * as NEW PARTY uses, so a token left by an earlier step is not reconnected.
 */
async function host(page) {
	await page.goto(PARTY + "?fresh=1");
	await page.locator(".party-code-digits").waitFor({ timeout: TIMEOUT });
	return token(page);
}

/** Join `code` by link, as a newcomer would. */
async function joinByCode(page, code) {
	await page.goto("about:blank");
	await page.goto(`${PARTY}#c=${code}`);
	return waitForMembers(page, 2);
}

/** The next confirm()'s message, answered with `accept`; "(no dialog)" if none. */
const nextDialog = (page, accept) =>
	new Promise((done) => {
		const timer = setTimeout(() => done("(no dialog)"), 5000);
		page.once("dialog", async (d) => {
			clearTimeout(timer);
			done(d.message());
			await (accept ? d.accept() : d.dismiss());
		});
	});

/**
 * Make `page` deaf to the room server's "offer to them" duty: its offers
 * are dropped on the way out. A party that is alive and well but answers
 * nobody — the one way to get a rejoin's no-answer while the party still
 * exists to RETRY into.
 */
const muteOffers = (page, muted) =>
	page.evaluate((m) => {
		if (!window.__muteInstalled) {
			window.__muteInstalled = true;
			const send = WebSocket.prototype.send;
			WebSocket.prototype.send = function (data) {
				if (window.__muted && typeof data === "string" && /"t":"(offer|answer)"/.test(data)) return;
				return send.call(this, data);
			};
		}
		window.__muted = m;
	}, muted);

/** Is `page` in a party with a host and a link? */
const inParty = (page) =>
	page.evaluate(() => {
		const r = window.__party?.room;
		return !!r && !r.closed && r.hostId() !== null && r.directPeers().length > 0;
	});
async function waitInParty(page, ms = TIMEOUT) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await inParty(page)) return true;
		await sleep(250);
	}
	return false;
}

try {
	// ------------------------------------------------- 1. the guess limit
	console.log("\nworker: guessing different codes is limited per IP");
	{
		const guesser = "10.66.0.1";
		const answers = [];
		for (let i = 0; i < 10; i++) answers.push((await call(String(710000 + i), { t: "join", id: "x", secret: "y" }, guesser)).reason);
		check("ten different codes: no-room each", answers.every((r) => r === "no-room"), answers.join());
		const eleventh = await call("710010", { t: "join", id: "x", secret: "y" }, guesser);
		check("the eleventh code, a different room again, is blocked", eleventh.reason === "blocked", JSON.stringify(eleventh));
		// Blocked means blocked for a live code too.
		const live = await call("710100", { t: "host", id: "h", secret: "s" }, "10.66.0.9");
		check("(a live room to find)", live.t === "room", JSON.stringify(live));
		const found = await call("710100", { t: "join", id: "g", secret: "g" }, guesser);
		check("the guesser cannot join even the right code", found.reason === "blocked", JSON.stringify(found));
		const other = await call("710011", { t: "join", id: "x", secret: "y" }, "10.66.0.2");
		check("a second IP is unaffected", other.reason === "no-room", JSON.stringify(other));
		const friend = await call("710100", { t: "join", id: "f", secret: "f" }, "10.66.0.3");
		check("and joins the live room", friend.t === "joined", JSON.stringify(friend));
		// The probe is plain HTTP, answered by the routing Worker: no room
		// object, no gate, so it can never be limited.
		const probe = await fetch(`${WS.replace(/^ws/, "http")}/ping`, { headers: { "CF-Connecting-IP": guesser } });
		check("the reachability probe is never limited", probe.status === 204, String(probe.status));
		check("and is readable cross-origin", probe.headers.get("access-control-allow-origin") === "*");
	}

	// ----------------------------------- 2. a leave lands before navigating
	console.log("\nworker: NEW PARTY and ALL GAMES release the seat before navigating");
	{
		// Over loopback the unwaited leave has not been seen to get lost
		// (the second half measures it); over a real network an unload can
		// still beat the frame out, and nothing local can emulate that —
		// DevTools latency delays the handshake, not frames. So the
		// assertion is the guarantee: the page does not go until the
		// server's close has acknowledged the leave.
		const page = await person("leaver");
		const ROUNDS = 4;
		let released = 0;
		let racedLost = 0;
		for (let round = 0; round < ROUNDS * 2; round++) {
			const portal = round % 2 === 1;
			const raced = round >= ROUNDS; // second half: without the wait
			const t = await host(page);
			if (raced) {
				// What the code did before roomSettled existed: close the
				// socket right after the leave and navigate at once. Measured,
				// not asserted — it shows what the wait is for.
				await page.evaluate(() => {
					NeonArcade.roomSettled = async () => {};
					const send = WebSocket.prototype.send;
					WebSocket.prototype.send = function (data) {
						send.call(this, data);
						if (String(data).includes('"t":"leave"')) this.close();
					};
				});
			}
			const dialog = nextDialog(page, true);
			await page.locator(portal ? "a.neon-btn" : "button.neon-btn", { hasText: portal ? /^ALL GAMES$/ : /^NEW PARTY$/ }).first().click();
			await dialog;
			// NEW PARTY lands on the very URL it left (party.html?fresh=1), so
			// its arrival is the new party's code, not the URL.
			if (portal) await page.waitForURL(/index\.html/, { timeout: TIMEOUT });
			else await page.waitForFunction((old) => {
				const digits = document.querySelector(".party-code-digits")?.textContent?.trim();
				return digits && digits !== old;
			}, t.code, { timeout: TIMEOUT });
			// The claim of a one-member room: released means the room is gone.
			const verdict = await claimOf(t.code, t.id);
			if (!raced && verdict === "no-room") released++;
			if (raced && verdict !== "no-room") racedLost++;
			if (!raced && verdict !== "no-room") console.log(`    (round ${round}: ${portal ? "ALL GAMES" : "NEW PARTY"} left the room ${verdict})`);
		}
		check(`every leave reached the server before the page went (${released}/${ROUNDS})`, released === ROUNDS);
		console.log(`  ·    without the wait, ${racedLost}/${ROUNDS} leaves were lost`);
	}

	// ------------------------------- 3. the reconnect screen, both buttons
	console.log("\nworker: a rejoin nobody answers — RETRY and START A NEW PARTY");
	const a = await person("a");
	const b = await person("b");
	const ta = await host(a);
	check("b joins a's party by code", await joinByCode(b, ta.code));
	const tb = await token(b);
	{
		await muteOffers(a, true);
		await b.reload();
		const retry = b.locator("button", { hasText: /^RETRY$/ });
		let shown = true;
		try {
			await retry.waitFor({ timeout: NO_ANSWER_WAIT });
		} catch {
			shown = false;
		}
		check("the reconnect screen offers RETRY", shown);
		check("and START A NEW PARTY", (await b.locator("button", { hasText: "START A NEW PARTY" }).count()) === 1);
		check("and says the party may have ended", /may have ended/.test(await b.locator(".lobby-sub").textContent()));
		check("the token is kept for RETRY", (await token(b))?.id === tb.id);
		check("so is the claim on the server", (await claimOf(ta.code, tb.id)) === "id-taken");

		await muteOffers(a, false);
		await retry.click();
		check("RETRY reconnects once the party answers", await waitInParty(b, NO_ANSWER_WAIT));
		check("into the same seat", (await b.evaluate(() => window.__party.room.selfId)) === tb.id);
		check("both see two members", (await waitForMembers(a, 2)) && (await waitForMembers(b, 2)));

		// Again, and this time give up on the party.
		await muteOffers(a, true);
		await b.reload();
		const fresh = b.locator("button", { hasText: "START A NEW PARTY" });
		await b.locator("button", { hasText: /^RETRY$/ }).waitFor({ timeout: NO_ANSWER_WAIT });
		await fresh.click();
		await b.locator(".party-code-digits").waitFor({ timeout: TIMEOUT });
		const tb2 = await token(b);
		check("START A NEW PARTY hosts a new party", !!tb2 && tb2.code !== ta.code, JSON.stringify(tb2));
		check("and gave the old seat back", (await claimOf(ta.code, tb.id)) === "free");
		await muteOffers(a, false);
	}

	// ------------------------------------- 4. a code link into a live party
	console.log("\nworker: a #c= link into a tab with a live party asks first");
	const c = await person("c");
	const tc = await host(c);
	{
		const before = await a.evaluate(() => window.__party.room.selfId);
		let dialog = nextDialog(a, false);
		await a.evaluate((code) => (location.hash = "#c=" + code), tc.code);
		const asked = await dialog;
		check("it asks before switching", /join the other one/.test(asked), asked);
		await sleep(500);
		check("declined: still in the old party", await a.evaluate(() => !window.__party.room.closed));
		check("and the link is cleared", await a.evaluate(() => !location.hash.includes("c=")));
		check("the token still names the old party", (await token(a))?.code === ta.code);

		dialog = nextDialog(a, true);
		await a.evaluate((code) => (location.hash = "#c=" + code), tc.code);
		await dialog;
		await a.waitForEvent("load", { timeout: TIMEOUT }).catch(() => {});
		check("accepted: joined the other party", await waitInParty(a, NO_ANSWER_WAIT));
		check("as a new member", (await a.evaluate(() => window.__party.room.selfId)) !== before);
		check("its token names the new party", (await token(a))?.code === tc.code);
		check("the old party's seat was given back", (await claimOf(ta.code, ta.id)) !== "id-taken");
		check("the other host sees two members", await waitForMembers(c, 2));
	}

	// --------------------------- 5. a classic invite drops an old token
	console.log("\nworker: a classic-invite join clears an old party's rejoin token");
	{
		const d = await person("d");
		check("d joins c's party by code", await joinByCode(d, tc.code));
		check("d holds a token for it", (await token(d))?.code === tc.code);
		// A classic invite from a party with no room server behind it.
		const e = await person("e");
		await e.goto(`${PARTY}?rs=http://127.0.0.1:1`);
		await e.locator(".party-member").first().waitFor({ timeout: TIMEOUT });
		await e.locator("button", { hasText: "ADD PLAYER" }).first().click();
		const inviteBox = e.locator("textarea.share-code").first();
		await inviteBox.waitFor({ timeout: TIMEOUT });
		const link = await inviteBox.inputValue();
		await d.goto("about:blank");
		await d.goto(link);
		const replyBox = d.locator("textarea.share-code").first();
		await replyBox.waitFor({ timeout: TIMEOUT });
		check("before the link opens, the old token is still there", (await token(d))?.code === tc.code);
		await e.locator("textarea.share-code").last().fill(await replyBox.inputValue());
		await e.locator("button.neon-btn", { hasText: /^CONNECT$/ }).first().click();
		check("d is in e's party", await waitForMembers(d, 2));
		check("and the old party's token is gone", (await token(d)) === null);
		await e.context().close();
		await d.context().close();
	}

	// --------------------------- 6. a reconnect with the server unreachable
	console.log("\nworker: a reconnect with the room server unreachable");
	{
		const f = await person("f");
		check("f joins c's party by code", await joinByCode(f, tc.code));
		const tf = await token(f);
		let blocked = true;
		await f.routeWebSocket(/\/room\//, (ws) => {
			if (blocked) ws.close();
			else ws.connectToServer();
		});
		await f.reload();
		const retry = f.locator("button", { hasText: /^RETRY$/ });
		let shown = true;
		try {
			await retry.waitFor({ timeout: TIMEOUT });
		} catch {
			shown = false;
		}
		check("it offers RETRY (not a silent new party)", shown);
		check("says the server could not be reached", /reach the room server/i.test(await f.locator(".lobby-status").textContent()));
		check("the token is kept", (await token(f))?.id === tf.id);
		check("no new party was hosted", (await f.locator(".party-code-digits").count()) === 0);
		blocked = false;
		await retry.click();
		check("RETRY reconnects once the server is back", await waitInParty(f, NO_ANSWER_WAIT));
		check("into the same seat", (await f.evaluate(() => window.__party.room.selfId)) === tf.id);
	}

	// ------------------------------ 7. two tabs holding the same token
	console.log("\nworker: a second tab with the same rejoin token");
	{
		// Same context, so the same localStorage and the same token — a
		// second tab, or the installed app beside a tab. Each bind used to
		// hang up the other's socket (4409), which redialled at once: the
		// tabs traded the seat every second, forever.
		const f = await person("f2-host");
		const tf = await host(f);
		const g1 = await person("g1");
		check("g joins f's party by code", await joinByCode(g1, tf.code));
		const tg = await token(g1);
		await g1.evaluate(() => {
			const W = WebSocket;
			window.__dials = 0;
			window.WebSocket = class extends W {
				constructor(...args) {
					super(...args);
					window.__dials++;
				}
			};
		});
		const g2 = await g1.context().newPage();
		g2.on("pageerror", (err) => {
			console.log(`  FAIL page error on g2: ${err.message}`);
			failures++;
		});
		await g2.goto(PARTY);
		check("the second tab reconnects into the seat", await waitInParty(g2, NO_ANSWER_WAIT));
		check("as the same member", (await g2.evaluate(() => window.__party.room.selfId)) === tg.id);
		const told = await g1
			.locator(".lobby-status", { hasText: /open in another tab/i })
			.waitFor({ timeout: TIMEOUT })
			.then(() => true)
			.catch(() => false);
		check("the first tab says the party is open in another tab", told);
		check("and offers USE THIS TAB INSTEAD", (await g1.locator("button", { hasText: "USE THIS TAB INSTEAD" }).count()) === 1);
		check("its room is closed", await g1.evaluate(() => window.__party.room.closed));
		await sleep(6000);
		check("the first tab never re-dials", (await g1.evaluate(() => window.__dials)) === 0);
		check("the second is still in the party", await inParty(g2));
		check("the host counts two members, not three", (await members(f)) === 2);
		check("the claim is still held", (await claimOf(tf.code, tg.id)) === "id-taken");
		// A stale tab giving the shared token's claim back must not take
		// the seat from the tab that holds it live (it used to: the release
		// joined with the claim, which hung the live tab up with 4409).
		const busy = await g1.evaluate(() => NeonArcade.releaseRejoin());
		check("releasing the token from the stale tab answers busy", busy === "busy", String(busy));
		await sleep(1500);
		check("the live tab is still in the party", await inParty(g2));
		check("and still holds the token", (await token(g2))?.id === tg.id);

		// And back: the button reconnects this tab, and the other stands down.
		await g1.locator("button", { hasText: "USE THIS TAB INSTEAD" }).click();
		check("USE THIS TAB INSTEAD reconnects the first tab", await waitInParty(g1, NO_ANSWER_WAIT));
		const swapped = await g2
			.locator(".lobby-status", { hasText: /open in another tab/i })
			.waitFor({ timeout: TIMEOUT })
			.then(() => true)
			.catch(() => false);
		check("and the second tab now stands down", swapped);
		check("the host still counts two", (await members(f)) === 2);
		await g1.context().close();
		await f.context().close();
	}
} catch (err) {
	console.log(`  FAIL ${err.stack ?? err}`);
	failures++;
} finally {
	await browser.close().catch(() => {});
	server.stop();
}

console.log(failures ? `\n${failures} failing` : "\nall passing");
process.exit(failures ? 1 : 0);
