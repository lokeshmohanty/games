#!/usr/bin/env node
/**
 * test-room.mjs — the room-server path: join by code, reconnect, fallback.
 *
 *   node scripts/test-room.mjs
 *
 * Everything under test is real: lib/room-join.js's protocol, lib/net.js's
 * reconnect grace, the party and lobby screens — and the WebRTC handshake
 * itself, two real peer connections in one page. The only thing faked is the
 * room server, replaced by the in-page mock (`?mockroom=1`), the same shape
 * of trick as test-scan.mjs's fake camera: the transport is faked, the
 * client above it is not.
 *
 * A reload is simulated as what a reload actually is: every connection dies
 * (`room.leave()`) and the one thing that survives — the rejoin token — is
 * put back. Nothing else in the page is re-created, because nothing else
 * survives a reload either.
 *
 * The server-side rules (claims, rate limits, TTLs) are not tested here;
 * scripts/test-hub.mjs covers them against the real hub logic.
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
const PAGE = (name, query = "") => `file://${join(ROOT, name)}${query}`;
const TIMEOUT = 40_000;

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

/** Poll a predicate inside the page until it holds, or TIMEOUT. */
async function until(page, evalFn, arg, label) {
	const start = Date.now();
	while (Date.now() - start < TIMEOUT) {
		if (await page.evaluate(evalFn, arg)) return true;
		await new Promise((r) => setTimeout(r, 200));
	}
	console.log(`    (${label} never came true)`);
	return false;
}

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
	// ------------------------------------------------------------- setup
	// A game page, not party.html: the lobby waits for a click before hosting
	// anything, so the only rooms on this page are the ones the test makes.
	// party.html hosts on boot, which would be a second, unaccounted room.
	await page.goto(PAGE("connect4.html", "?mockroom=1"));
	await page.evaluate(() => {
		localStorage.removeItem("neon.room");
		localStorage.removeItem("neon.rs");
	});

	// ------------------------------------------------- 1. join by code
	console.log("\nroom: join by code");
	const code = await page.evaluate(async () => {
		const made = await NeonArcade.hostRoom({
			name: "Host",
			reconnectGraceMs: 400,
			onError: (m) => (window.__errs ??= []).push(m),
		});
		window.__host = made;
		return made.code;
	});
	check("host gets a 6-digit code", /^\d{6}$/.test(code ?? ""), String(code));
	check("host wrote a rejoin token", await page.evaluate(() => !!NeonArcade.rejoinToken()?.secret));

	const guestId = await page.evaluate(async (c) => {
		// A fresh guest: the rejoin token must be cleared first, because the
		// host's token is in this page's localStorage and would be adopted
		// as a rejoin — same id, same seat, one member where two should be.
		localStorage.removeItem("neon.room");
		const made = await NeonArcade.joinRoom(c, {
			name: "Guest",
			reconnectGraceMs: 400,
			onError: (m) => (window.__errs ??= []).push(m),
		});
		window.__guest = made;
		return made.room.selfId;
	}, code);
	check("guest joined", !!guestId);
	check("guest kept its own id", await page.evaluate(() => NeonArcade.rejoinToken()?.id === window.__guest.room.selfId));

	// The offer crossed the mock, the WebRTC handshake completed, and each
	// side's party record now holds them both.
	check(
		"host's mesh reached the guest",
		await until(
			page,
			() => window.__host.room.directPeers().length === 1,
			undefined,
			"direct link",
		),
	);
	check(
		"both party records agree on two members",
		await until(
			page,
			() =>
				window.__host.room.getMembers().length === 2 &&
				window.__guest.room.getMembers().length === 2,
			undefined,
			"records",
		),
	);

	// The room server's socket state is advisory: a live link outranks it.
	await page.evaluate((id) => window.__host.room.serverPeerState(id, false), guestId);
	check(
		"a live link outranks the server's word",
		!(await page.evaluate((id) => !!window.__host.room.getMember(id)?.reconnecting, guestId)),
	);

	// Team assignment survives everything that follows — it is the seat.
	await page.evaluate((id) => window.__host.room.setTeam(id, "B"), guestId);
	check(
		"team assignment replicated",
		await until(
			page,
			(id) => window.__guest.room.getMember(id)?.team === "B",
			guestId,
			"team",
		),
	);

	// ---------------------------------------------- 2. reload and rejoin
	console.log("\nroom: reload, seat held, rejoin");
	await page.evaluate(() => {
		// A reload: every connection dies; the token is what survives.
		const token = NeonArcade.rejoinToken();
		window.__guest.room.leave();
		localStorage.setItem("neon.room", JSON.stringify(token));
	});
	check(
		"the seat is held as RECONNECTING, not dropped",
		await until(
			page,
			(id) => {
				const m = window.__host.room.getMember(id);
				return !!m?.reconnecting && window.__host.room.getMembers().length === 2;
			},
			guestId,
			"held seat",
		),
	);

	const rejoined = await page.evaluate(async (c) => {
		const made = await NeonArcade.joinRoom(c, { name: "Guest", reconnectGraceMs: 400 });
		window.__guest = made;
		return made.room.selfId;
	}, code);
	check("rejoin adopted the old member id", rejoined === guestId, `${rejoined} vs ${guestId}`);
	check(
		"the link came back",
		await until(
			page,
			() => window.__host.room.directPeers().length === 1,
			undefined,
			"relink",
		),
	);
	check(
		"the seat came back: same team, same member",
		await until(
			page,
			(id) => {
				const m = window.__host.room.getMember(id);
				return m?.team === "B" && !m?.reconnecting;
			},
			guestId,
			"seat restored",
		),
	);

	// ------------------------------------------- 3. grace runs out
	console.log("\nroom: grace expiry drops the seat");
	await page.evaluate(() => {
		const token = NeonArcade.rejoinToken();
		window.__guest.room.leave();
		localStorage.setItem("neon.room", JSON.stringify(token));
	});
	check(
		"after the grace, the member is dropped",
		await until(
			page,
			() => window.__host.room.getMembers().length === 1,
			undefined,
			"drop",
		),
	);

	// -------------------------------------------------- 4. the UI
	console.log("\nroom: the screens");
	const ui = await context.newPage();
	// The earlier sections left a rejoin token in localStorage; without this
	// the boot would try to reconnect into a room this page's mock never had.
	await ui.addInitScript(() => localStorage.removeItem("neon.room"));
	await ui.goto(PAGE("party.html", "?mockroom=1"));
	// The boot itself hosts through the room server, which writes the token;
	// let it finish, then clear the token and reload, so the reloaded page is
	// a FRESH host rather than a reconnect into this page's now-orphaned one.
	await ui.locator(".party-member").first().waitFor({ timeout: TIMEOUT });
	await ui.evaluate(() => localStorage.removeItem("neon.room"));
	await ui.reload();
	await ui.locator(".party-code-digits").waitFor({ timeout: TIMEOUT });
	const digits = await ui.locator(".party-code-digits").textContent();
	check("the party screen shows the code big", /^\d{6}$/.test(digits.trim()), digits);
	check(
		"the roster renders one member",
		(await ui.locator(".party-member").allTextContents()).length === 1,
	);

	// A code link into a fresh page joins straight away — and a code no room
	// is meeting answers with an explicit error, never a silent wait.
	const bad = await context.newPage();
	await bad.goto(PAGE("party.html", "?mockroom=1#c=123456"));
	await bad.locator(".lobby-status").first().waitFor({ timeout: TIMEOUT });
	check(
		"a dead code says so explicitly",
		await until(
			bad,
			() => /no longer meeting|not reachable/i.test(
				document.querySelector(".lobby-status")?.textContent ?? "",
			),
			undefined,
			"error status",
		),
	);
	check(
		"a dead code still offers a way out",
		(await bad.locator("button", { hasText: "START A NEW PARTY" }).count()) > 0,
	);

	// ------------------------------------------- 5. the fallback path
	console.log("\nroom: the zero-server fallback");
	const plain = await context.newPage();
	await plain.goto(PAGE("connect4.html"));
	await plain.locator("button", { hasText: "INVITE A FRIEND" }).waitFor({ timeout: TIMEOUT });
	check("the classic invite flow is still offered", true);
	check(
		"JOIN WITH A CODE is hidden without the room server",
		(await plain.locator("button", { hasText: "JOIN WITH A CODE" }).count()) === 0,
	);
	const plainParty = await context.newPage();
	await plainParty.goto(PAGE("party.html"));
	await plainParty.evaluate(() => localStorage.removeItem("neon.room"));
	await plainParty.reload();
	await plainParty.locator(".party-member").first().waitFor({ timeout: TIMEOUT });
	check(
		"the party screen hosts classically without the room server",
		(await plainParty.locator(".party-code-digits").count()) === 0,
	);
} catch (err) {
	console.log(`  FAIL unexpected: ${err.message}`);
	failures++;
}

await browser.close();
console.log(failures ? `\n${failures} failing` : "\nall passing");
process.exit(failures ? 1 : 0);
