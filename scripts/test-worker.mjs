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
 *   8. a leave owed mid-redial is a `release`: it never takes the seat
 *      from another tab holding it live (it used to join, and 4409 it).
 *   9. a party behind one shared address (a LAN party, a carrier's CGNAT)
 *      whose address has spent every dial on typos still reloads into its
 *      seats — members re-dial on their passes — and that address still
 *      hosts party after party (`/room/new`, capped only at HOST_ROOMS).
 *
 * Wrangler comes from $WRANGLER (a command line), else `wrangler` on PATH,
 * else `nix shell nixpkgs#wrangler` (npx wrangler cannot link workerd on
 * NixOS). If it cannot start, the suite says so and exits 0 — it is not in
 * the default `just test`, for exactly that dependency.
 *
 * Every node-side probe sends its own CF-Connecting-IP, which `wrangler dev`
 * passes through, so probes never share a rate-limit bucket with each other
 * or with the browsers. State is persisted to a fresh temp dir per run, and
 * the member-pass key is a fresh random `--var ROOM_PASS_KEY` per run (a
 * worker/.dev.vars, if there is one, is overridden by it).
 */
import { createRequire } from "node:module";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
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
	const args = [
		"dev",
		"--port", String(port),
		"--ip", "127.0.0.1",
		"--inspector-port", String(inspector),
		"--persist-to", state,
		"--var", `ROOM_PASS_KEY:${randomBytes(32).toString("base64url")}`,
	];
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
 * Host a room from node as `ip`: `/room/new`, then `host`. Resolves the
 * reply (`{t:"room", code, pass, exp}`), or an error, then hangs up — the
 * claim outlives the socket.
 */
function hostCall(ip = freshIp(), id = "h" + Math.random().toString(36).slice(2, 8)) {
	return new Promise((done) => {
		const ws = new WebSocket(`${WS}/room/new`, { headers: { "CF-Connecting-IP": ip } });
		const timer = setTimeout(() => done({ t: "timeout" }), 8000);
		ws.onopen = () => ws.send(JSON.stringify({ t: "host", id, secret: "s" + id }));
		ws.onmessage = (e) => {
			clearTimeout(timer);
			done({ ...JSON.parse(e.data), id });
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
/**
 * What an upgrade to room `code` as `ip` got: 101 when a room took the
 * socket, 429 when the routing Worker refused it past the dial budget.
 * A refusal is a socket too — the Worker accepts it itself, says
 * `{t:"error", reason:"blocked"}` and hangs up 4429 (worker/index.js
 * `refusal`), since a browser never sees an HTTP status. So: open, send
 * a `leave` (a room answers an unbound socket's leave by closing it 1000,
 * charging and binding nothing), and read which came back.
 */
const upgradeStatus = (code, ip, query = "") =>
	new Promise((done) => {
		const ws = new WebSocket(`${WS}/room/${code}${query}`, { headers: { "CF-Connecting-IP": ip } });
		let said = null;
		const timer = setTimeout(() => (ws.close(), done("timeout")), 8000);
		ws.onopen = () => ws.send(JSON.stringify({ t: "leave" }));
		ws.onmessage = (e) => (said ??= JSON.parse(e.data));
		ws.onclose = (e) => {
			clearTimeout(timer);
			if (said?.reason === "blocked" && e.code === 4429) done(429);
			else if (!said && e.code === 1000) done(101);
			else done(`${e.code} ${JSON.stringify(said)}`);
		};
		ws.onerror = () => {};
	});

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
// Each person is its own address to the server (wrangler dev passes
// CF-Connecting-IP through), as people mostly are — except in section 9,
// which puts a whole party behind one (`ip`).
let personIp = 0;
async function person(tag, ip = `10.77.0.${++personIp}`) {
	const context = await browser.newContext({
		viewport: { width: 390, height: 844 },
		extraHTTPHeaders: { "CF-Connecting-IP": ip },
	});
	// The extra header makes the cross-origin GET /ping non-simple, so the
	// browser sends a CORS preflight the worker does not answer; with a
	// route installed, Playwright fulfils preflights itself.
	await context.route("**/ping", (route) => route.continue());
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

/** The next in-page question's text (NeonArcade.ask), answered with `accept`; "(no dialog)" if none. */
const nextDialog = async (page, accept) => {
	const dlg = page.locator("dialog.neon-ask[open]");
	const shown = await dlg
		.waitFor({ timeout: 5000 })
		.then(() => true)
		.catch(() => false);
	if (!shown) return "(no dialog)";
	const text = (await dlg.locator("p").textContent()) ?? "";
	await dlg.locator(`[data-ask="${accept ? "yes" : "no"}"]`).click();
	return text;
};

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
		// Every wrong guess also spent its upgrade's dial, and the two
		// budgets are equal (worker/hub.js DIAL_FAILS), so the eleventh is
		// refused at the upgrade, before any room object is touched.
		const eleventh = await upgradeStatus("710010", guesser);
		check("the eleventh code, a different room again, is refused (429)", eleventh === 429, String(eleventh));
		// Refused means refused for a live code too.
		const live = await hostCall("10.66.0.9");
		check("(a live room to find)", live.t === "room", JSON.stringify(live));
		const found = await upgradeStatus(live.code, guesser);
		check("the guesser cannot reach even the right code", found === 429, String(found));
		const other = await call("710011", { t: "join", id: "x", secret: "y" }, "10.66.0.2");
		check("a second IP is unaffected", other.reason === "no-room", JSON.stringify(other));
		const friend = await call(live.code, { t: "join", id: "f", secret: "f" }, "10.66.0.3");
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
		const ROUNDS = 4;
		let released = 0;
		let racedLost = 0;
		let page;
		for (let round = 0; round < ROUNDS * 2; round++) {
			// A person per half, so each half starts from a clean page.
			if (round % ROUNDS === 0) page = await person("leaver" + round);
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

	// -------------------- 8. a leave owed mid-redial, another tab live
	console.log("\nworker: a leave owed mid-redial never takes another tab's live seat");
	{
		// Found 2026-11-12: the owed leave dialled `join` with the claim
		// and then `leave` — the join hung up a second tab that had taken
		// the seat meanwhile (4409), and the leave gave its seat away. It
		// is a `release` now, which never binds.
		const f = await person("f3-host");
		const tf = await host(f);
		const h1 = await person("h1");
		// Every socket and peer connection h1 makes is tracked, and
		// `__offline` makes the next socket impossible — so h1's redials
		// fail and stay only scheduled.
		await h1.context().addInitScript(() => {
			const W = WebSocket;
			const P = RTCPeerConnection;
			window.__sockets = [];
			window.__pcs = [];
			window.__sent = [];
			window.RTCPeerConnection = class extends P {
				constructor(...args) {
					super(...args);
					window.__pcs.push(this);
				}
			};
			window.WebSocket = class extends W {
				constructor(...args) {
					if (window.__offline) throw new Error("offline");
					super(...args);
					window.__sockets.push(this);
				}
				send(data) {
					window.__sent.push(JSON.parse(data).t);
					return super.send(data);
				}
			};
		});
		check("h joins f's party by code", await joinByCode(h1, tf.code));
		const th = await token(h1);
		// h1's network goes: the signalling socket drops, and so do its
		// links (so the party offers to whoever comes back as this member).
		await h1.evaluate(() => {
			window.__offline = true;
			window.__sockets.at(-1).close();
			for (const pc of window.__pcs) pc.close();
		});
		await sleep(1500); // a redial or two, failed; the next is scheduled
		const h2 = await h1.context().newPage();
		h2.on("pageerror", (err) => {
			console.log(`  FAIL page error on h2: ${err.message}`);
			failures++;
		});
		await h2.goto(PARTY);
		check("a second tab reconnects into the seat", await waitInParty(h2, NO_ANSWER_WAIT));
		check("as the same member", (await h2.evaluate(() => window.__party.room.selfId)) === th.id);
		// h1 leaves while its redial is scheduled: back online for the
		// release only — it is dialled synchronously, before any redial
		// timer could fire.
		const left = await h1.evaluate(async () => {
			window.__sent.length = 0;
			window.__offline = false;
			const started = Date.now();
			window.__party.room.leave();
			await NeonArcade.roomSettled();
			const ms = Date.now() - started;
			await new Promise((r) => setTimeout(r, 500));
			return { ms, sent: [...window.__sent] };
		});
		const releases = left.sent.filter((t) => t === "release").length;
		check("the owed leave never joins", !left.sent.includes("join"), left.sent.join());
		check("it asks to release, busy each time, four times", releases === 4, left.sent.join());
		check("and holds navigation 6 s at most", left.ms <= 6500, String(left.ms));
		const knocked = await h2.locator(".lobby-status", { hasText: /open in another tab/i }).count();
		check("the live tab was never displaced", knocked === 0);
		check("and is still in the party", await inParty(h2));
		check("the claim is still held", (await claimOf(tf.code, th.id)) === "id-taken");
		await h1.context().close();
		await f.context().close();
	}

	// ------------------- 9. a shared address: typos cost newcomers only
	console.log("\nworker: a party behind one address, its dials spent, keeps its seats");
	{
		// Equal budgets (DIAL_FAILS = JOIN_FAILS) used to cost a shared
		// address everything: ten typos and every upgrade from it was 429 —
		// members' re-dials too, so a reload landed on RETRY — and its 11th
		// party fell back to the classic flow. Members now re-dial on their
		// passes and hosting is /room/new, so only newcomers pay.
		const lan = "100.64.42.1";
		const host1 = await person("lan-host", lan);
		const guest1 = await person("lan-guest", lan);
		const th = await host(host1);
		check("a host behind the shared address", /^\d{6}$/.test(th?.code ?? ""), JSON.stringify(th));
		check("its token carries a pass", !!th?.pass && th.exp > Date.now(), JSON.stringify(th));
		check("a guest behind the same address joins by code", await joinByCode(guest1, th.code));
		const tg = await token(guest1);
		check("and holds a pass too", !!tg?.pass, JSON.stringify(tg));
		// Ten typos from somebody else at the party: the address's dials
		// (and guesses) are spent.
		const typos = [];
		for (let i = 0; i < 10; i++) typos.push((await call(String(720000 + i), { t: "join", id: "x", secret: "y" }, lan)).reason);
		check("ten typos from the address: no-room each", typos.every((r) => r === "no-room"), typos.join());
		check("a newcomer from it is now refused (429)", (await upgradeStatus(th.code, lan)) === 429);
		const passQuery = "?" + new URLSearchParams({ id: tg.id, exp: tg.exp, pass: tg.pass });
		check("a member's upgrade on its pass is not", (await upgradeStatus(th.code, lan, passQuery)) === 101);
		const forged = "?" + new URLSearchParams({ id: tg.id, exp: tg.exp, pass: "A".repeat(43) });
		check("a forged pass is refused like anything unproven", (await upgradeStatus(th.code, lan, forged)) === 429);

		// The guest reloads, then the host does: both back in their seats.
		await guest1.reload();
		check("the guest's reload rejoins its seat", await waitInParty(guest1, NO_ANSWER_WAIT));
		check("as the same member", (await guest1.evaluate(() => window.__party.room.selfId)) === tg.id);
		check("no RETRY screen", (await guest1.locator("button", { hasText: /^RETRY$/ }).count()) === 0);
		await host1.reload();
		check("the host's reload rejoins too", await waitInParty(host1, NO_ANSWER_WAIT));
		check("as the same member", (await host1.evaluate(() => window.__party.room.selfId)) === th.id);
		check("both see two members", (await waitForMembers(host1, 2)) && (await waitForMembers(guest1, 2)));
		check("and the newcomer is still refused", (await upgradeStatus(th.code, lan)) === 429);
		// And a newcomer's *browser* is told why. A plain 429 reached it as
		// a dead socket — "Could not reach the room server" — until the
		// Worker began accepting refused upgrades to say `blocked`.
		const newcomer = await person("lan-newcomer", lan);
		await newcomer.goto(`${PARTY}#c=${th.code}`);
		const toldWhy = await newcomer
			.locator(".lobby-status", { hasText: /too many attempts/i })
			.waitFor({ timeout: TIMEOUT })
			.then(() => true, () => false);
		check("a newcomer's browser says too many attempts, not unreachable", toldWhy, await newcomer.locator(".lobby-status").first().textContent().catch(() => "?"));
		await newcomer.context().close();

		// The exhausted address still hosts: a browser, by the room server
		// (not the classic fallback)...
		const host2 = await person("lan-host2", lan);
		const t2 = await host(host2);
		check("a new party from the address gets a room-server code", /^\d{6}$/.test(t2?.code ?? "") && t2.code !== th.code, JSON.stringify(t2));
		// ...and party after party from node, well past ten.
		const hosted = [];
		for (let i = 0; i < 12; i++) hosted.push(await hostCall(lan));
		check("twelve more parties from the address all open", hosted.every((r) => r.t === "room"), hosted.map((r) => r.t + (r.reason ? ":" + r.reason : "")).join());
		const codes = new Set([th.code, t2.code, ...hosted.map((r) => r.code)]);
		check("every code server-drawn and different", codes.size === 14 && [...codes].every((c) => /^\d{6}$/.test(c)));
		await guest1.context().close();
		await host1.context().close();
		await host2.context().close();

		// Hosting has its own cap: HOST_ROOMS (30) per address per window.
		const busy = "100.64.43.1";
		const made = [];
		for (let i = 0; i < 30; i++) made.push((await hostCall(busy)).t);
		check("thirty parties from one address open", made.every((t) => t === "room"), made.join());
		const more = await hostCall(busy);
		check("the thirty-first is refused at the upgrade: blocked", more.t === "error" && more.reason === "blocked", JSON.stringify(more));
		check("and that address still joins", (await call([...codes][0], { t: "join", id: "late", secret: "l" }, busy)).t === "joined");
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
