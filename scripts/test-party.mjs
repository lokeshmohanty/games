#!/usr/bin/env node
/**
 * test-party.mjs — drive party.html with three real browser peers.
 *
 *   node scripts/test-party.mjs
 *
 * What it is actually checking is the claim the party rests on: the manual
 * handshake is paid once per person, by whoever is standing next to them, and
 * everything after that — the third player reaching the host, switching games,
 * inheriting the crown — happens over connections that already exist.
 *
 * NixOS note: as in preview.mjs, Playwright's bundled chromium cannot run
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
const PARTY = "file://" + join(ROOT, "party.html");
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

/**
 * Walk one invite: `inviter` mints it, `joiner` opens it and produces a reply,
 * and the inviter takes the reply back. The inviter need not be the host — that
 * is the whole point of the exercise.
 */
async function invite(inviter, joiner, label) {
	await inviter.locator("button", { hasText: "ADD PLAYER" }).first().click();
	const inviteBox = inviter.locator("textarea.share-code").first();
	await inviteBox.waitFor({ timeout: TIMEOUT });
	const link = await inviteBox.inputValue();

	await joiner.goto("about:blank");
	await joiner.goto(link);
	const replyBox = joiner.locator("textarea.share-code").first();
	await replyBox.waitFor({ timeout: TIMEOUT });
	const reply = await replyBox.inputValue();

	await inviter.locator("textarea.share-code").last().fill(reply);
	// Anchored: "CONNECT 4" is a game card on this very screen.
	await inviter.locator("button.neon-btn", { hasText: /^CONNECT$/ }).first().click();
	await joiner.locator(".party-member").first().waitFor({ timeout: TIMEOUT });
	console.log(`  · ${label} joined`);
}

const names = async (page) =>
	await page.locator(".party-member .party-name").allTextContents();

/** Wait until a page's roster reaches `n` members. */
async function waitForMembers(page, n, who) {
	try {
		await page
			.locator(".party-member")
			.nth(n - 1)
			.waitFor({ timeout: TIMEOUT });
		return true;
	} catch {
		console.log(`    (${who} sees ${(await names(page)).length} members, expected ${n})`);
		return false;
	}
}

const { chromium } = loadPlaywright();

const browser = await chromium.launch({
	executablePath: chromePath(),
	args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
});
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });

const host = await context.newPage();
const p2 = await context.newPage();
const p3 = await context.newPage();
for (const [page, tag] of [
	[host, "host"],
	[p2, "p2"],
	[p3, "p3"],
]) {
	page.on("pageerror", (err) => {
		console.log(`  FAIL page error on ${tag}: ${err.message}`);
		failures++;
	});
}

try {
	console.log("\nparty: forming");
	await host.goto(PARTY);
	await host.locator(".party-member").first().waitFor({ timeout: TIMEOUT });
	check("host starts a party alone", (await names(host)).length === 1);

	// The host recruits the second player.
	await invite(host, p2, "p2");

	// Mobile is the target, and the roster rows carry three team buttons plus
	// two host controls — the row that is most likely to push the page sideways.
	const overflow = await host.evaluate(() => ({
		scroll: document.documentElement.scrollWidth,
		client: document.documentElement.clientWidth,
	}));
	check(
		"party screen does not scroll sideways at 390px",
		overflow.scroll <= overflow.client,
		`scrollWidth ${overflow.scroll} > clientWidth ${overflow.client}`,
	);
	const behindPill = await host.evaluate(() => {
		// The fixed "all games" pill must not sit on top of the title.
		const pill = document.querySelector(".portal-link")?.getBoundingClientRect();
		const title = document.querySelector(".lobby-title")?.getBoundingClientRect();
		return pill && title ? pill.bottom > title.top && pill.right > title.left : false;
	});
	check("the fixed portal pill does not overlap the title", !behindPill);
	check("host sees 2 members", await waitForMembers(host, 2, "host"), "roster did not grow");
	check("p2 sees 2 members", await waitForMembers(p2, 2, "p2"));

	// The SECOND player recruits the third — the host is not involved at all.
	// If the relayed signalling works, p3 still ends up in everyone's roster.
	console.log("\nparty: a guest recruits the third player");
	await invite(p2, p3, "p3");
	check("recruiter sees 3 members", await waitForMembers(p2, 3, "p2"));
	check(
		"host learns about a player it never handshook with",
		await waitForMembers(host, 3, "host"),
		"relayed introduction did not reach the host",
	);
	check("newcomer sees the whole party", await waitForMembers(p3, 3, "p3"));

	// Direct mesh links, not just reachability through the recruiter. The
	// relayed negotiation has to gather ICE on both sides first, so give it
	// room rather than sampling the instant p3 appears in the roster.
	const meshed = await host
		.waitForFunction(() => window.__party?.room?.directPeers().length === 2, null, {
			timeout: TIMEOUT,
		})
		.then(() => true)
		.catch(() => false);
	check(
		"host meshes directly with the player it never handshook with",
		meshed,
		`directPeers=${await host.evaluate(() => window.__party?.room?.directPeers().length ?? -1)}`,
	);

	console.log("\nparty: teams and starting a game");
	// Team A for the host, Team B for p2, p3 watches.
	const rows = host.locator(".party-member");
	await rows.nth(0).locator("button", { hasText: "TEAM A" }).click();
	await rows.nth(1).locator("button", { hasText: "TEAM B" }).click();
	await rows.nth(2).locator("button", { hasText: "WATCHING" }).click();

	const c4 = host.locator(".party-game", { hasText: "CONNECT 4" });
	await c4.waitFor({ timeout: TIMEOUT });
	check("Connect 4 is startable with a valid roster", await c4.isEnabled());
	await c4.click();

	for (const [page, tag] of [
		[host, "host"],
		[p2, "p2"],
		[p3, "spectator"],
	]) {
		await page.locator("#board").waitFor({ timeout: TIMEOUT });
		check(`${tag} mounted Connect 4`, await page.locator("#board").isVisible());
	}
	const spectatorHud = await p3.locator("#hud").textContent();
	check("spectator is seated as one", /SPECTATOR/.test(spectatorHud ?? ""), spectatorHud ?? "");

	console.log("\nparty: switching games without reconnecting");
	const idsBefore = await host.evaluate(() => window.__party.room.directPeers().sort().join(","));
	await host.evaluate(() => window.__party.room.setGame(null));
	await host.locator(".party-game", { hasText: "NEON SURVIVAL" }).first().click();
	for (const [page, tag] of [
		[host, "host"],
		[p2, "p2"],
		[p3, "p3"],
	]) {
		await page.locator("#gameCanvas").waitFor({ timeout: TIMEOUT });
		check(`${tag} switched to Neon Survival`, await page.locator("#gameCanvas").isVisible());
	}
	const idsAfter = await host.evaluate(() => window.__party.room.directPeers().sort().join(","));
	check("nobody reconnected across the switch", idsBefore === idsAfter, `${idsBefore} -> ${idsAfter}`);
	check(
		"the old game left nothing behind",
		await host.evaluate(() => document.querySelectorAll("#board").length === 0),
	);

	console.log("\nparty: losing the host");
	await host.evaluate(() => window.__party.room.setGame(null));
	await p2.locator(".party-member").first().waitFor({ timeout: TIMEOUT });
	await host.close();
	// p2 joined before p3, so p2 is the heir and should be offered the crown.
	const takeover = p2.locator("button", { hasText: "TAKE OVER" });
	let offered = true;
	try {
		await takeover.waitFor({ timeout: TIMEOUT });
	} catch {
		offered = false;
	}
	check("the longest-present member is offered the crown", offered);
	// The crown is offered to exactly one member. Asserting p3's transient
	// "waiting for…" screen would be a race — it legitimately never appears if
	// p3 concludes the host is gone only after the heir has already claimed —
	// but "p3 is never offered it" must hold at every instant.
	check(
		"the crown is not offered to anyone but the heir",
		(await p3.locator("button", { hasText: "TAKE OVER" }).count()) === 0,
	);
	if (offered) {
		await takeover.click();
		await p2.locator(".party-tag.is-host").first().waitFor({ timeout: TIMEOUT });
		check("the heir becomes host", (await p2.locator(".party-tag.is-host").count()) === 1);
		const p3SeesHost = await p3
			.locator(".party-tag.is-host")
			.first()
			.waitFor({ timeout: TIMEOUT })
			.then(() => true)
			.catch(() => false);
		check("the rest of the party agrees on the new host", p3SeesHost);
		check("the party survived losing its host", (await names(p2)).length === 2);
	}
} catch (err) {
	console.log(`\n  FAIL unexpected: ${err.message}`);
	failures++;
} finally {
	await browser.close();
}

console.log(failures ? `\n${failures} failure(s)` : "\nall party checks passed");
process.exit(failures ? 1 : 0);
