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

	// Draw & Guess is the game `lib/rounds.js` was generalised *from*, and it
	// has now been moved onto it. What is checked is the part the hand-rolled
	// version and the shared one could differ on: that the phases actually walk,
	// that every peer sees the same one, and that a correct guess ends the
	// drawing phase early instead of waiting out its sixty seconds.
	console.log("\nparty: draw & guess on the shared round clock");
	await host.evaluate(() => window.__party.room.setGame(null));
	{
		const rows = host.locator(".party-member");
		await rows.nth(2).locator("button", { hasText: "TEAM A" }).click();
		const dg = host.locator(".party-game", { hasText: "DRAW" });
		await dg.waitFor({ timeout: TIMEOUT });
		await dg.click();

		for (const page of [host, p2, p3]) {
			await page.locator("#dg-canvas, #draw-canvas, canvas").first().waitFor({ timeout: TIMEOUT });
		}

		// The drawer's chat box is disabled; that is how the roles are told
		// apart, and it only settles once the drawing phase is really open.
		const guesser = await Promise.race(
			[host, p2, p3].map(async (page) => {
				await page.waitForFunction(
					() => document.querySelector("#chat-input")?.disabled === false,
					null,
					{ timeout: TIMEOUT },
				);
				return page;
			}),
		);
		check("the drawing phase opened", true);

		const phaseOf = (page) => page.evaluate(() => document.querySelector("#hud .timer")?.textContent ?? "");
		const clocks = await Promise.all([host, p2, p3].map(phaseOf));
		// Every peer counts down for itself off the duration the host sent, so
		// they should agree to within a second rather than drift.
		const seconds = clocks.map((t) => parseInt(t, 10)).filter((n) => !Number.isNaN(n));
		check("every peer is showing the same clock", seconds.length === 3 && Math.max(...seconds) - Math.min(...seconds) <= 2, clocks.join(" / "));

		// Guess it right on every guessing peer. When they have all got it the
		// drawing phase must end immediately — the `rounds.next()` path.
		//
		// The word has to be read off the *drawer's* page: everyone else is shown
		// the masked hint, and the host is not necessarily drawing.
		const pages = [host, p2, p3];
		const disabled = await Promise.all(
			pages.map((page) => page.evaluate(() => document.querySelector("#chat-input")?.disabled === true)),
		);
		const drawer = pages[disabled.indexOf(true)] ?? host;
		const word = await drawer.evaluate(() => {
			const el = document.querySelector("#word-display");
			return el ? el.textContent.trim() : "";
		});
		const secret = word.replace(/[^a-z]/gi, "");
		if (secret && !secret.includes("_")) {
			const before = Date.now();
			for (const page of [host, p2, p3]) {
				const enabled = await page.evaluate(() => document.querySelector("#chat-input")?.disabled === false);
				if (!enabled) continue;
				await page.fill("#chat-input", secret);
				await page.click("#chat-send");
			}
			// Sixty seconds is the drawing deadline; anything near it means the
			// early exit did not fire.
			await guesser.waitForFunction(
				() => /GAME OVER|^\s*$/.test(document.querySelector("#word-display")?.textContent ?? "")
					|| document.querySelector("#chat-input")?.disabled === true,
				null,
				{ timeout: 20_000 },
			).catch(() => {});
			check("everyone guessing right ends the phase early, not at the deadline",
				Date.now() - before < 15_000, `${Math.round((Date.now() - before) / 1000)}s`);
		} else {
			check("the word was readable to the drawer", false, `word display was "${word}"`);
		}

		await host.evaluate(() => window.__party.room.setGame(null));
		await host.locator(".party-game").first().waitFor({ timeout: TIMEOUT });
		check("Draw & Guess tore itself down",
			(await host.locator("#chat-input").count()) === 0);
	}

	// Tug of War is the only game with more than one player per side, so this
	// is the one place a team is read as a group rather than as seats[0].
	console.log("\nparty: a game with multi-player teams");
	await host.evaluate(() => window.__party.room.setGame(null));
	{
		const rows2 = host.locator(".party-member");
		await rows2.nth(2).locator("button", { hasText: "TEAM A" }).click(); // p3 joins A
		const tug = host.locator(".party-game", { hasText: "TUG OF WAR" });
		await tug.waitFor({ timeout: TIMEOUT });
		check("Tug of War accepts a 2v1 roster", await tug.isEnabled());
		await tug.click();

		for (const [page, tag] of [
			[host, "host"],
			[p2, "p2"],
			[p3, "p3"],
		]) {
			await page.locator("#tug-canvas").waitFor({ timeout: TIMEOUT });
			check(`${tag} mounted Tug of War`, await page.locator("#tug-canvas").isVisible());
		}

		const rosterA = await p2.locator("#tug-roster-a").textContent();
		check(
			"a team renders every member, not just the first",
			(rosterA ?? "").split(",").length === 2,
			`Team A roster = "${rosterA}"`,
		);
		// p2 is alone on Team B and the only one pulling, so it should win — which
		// only happens if its taps reached the host and the host's result came back.
		const label = await p2.locator("#tug-tap").textContent();
		check("a player is told which side they pull for", /TEAM B/.test(label ?? ""), label ?? "");
		check(
			"a spectator-free roster leaves nobody idle",
			(await host.locator("#tug-tap").textContent())?.includes("TEAM A"),
		);

		await p2.evaluate(async () => {
			const btn = document.querySelector("#tug-tap");
			for (let i = 0; i < 140; i++) {
				btn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
				await new Promise((r) => setTimeout(r, 70));
			}
		});
		const won = await p2
			.waitForFunction(
				() => document.querySelector("#tug-overlay")?.hidden === false,
				null,
				{ timeout: TIMEOUT },
			)
			.then(() => true)
			.catch(() => false);
		check("pulling reaches the host and a winner comes back", won);
		// The same outcome, told from each player's own side: the winner is on
		// Team B, the two on Team A both lost.
		const verdicts = {
			p2: await p2.locator("#tug-overlay h1").textContent(),
			host: await host.locator("#tug-overlay h1").textContent(),
			p3: await p3.locator("#tug-overlay h1").textContent(),
		};
		check(
			"every player is told the result from their own side",
			/WINS/.test(verdicts.p2 ?? "") &&
				/LOSES/.test(verdicts.host ?? "") &&
				/LOSES/.test(verdicts.p3 ?? ""),
			JSON.stringify(verdicts),
		);

		// Back to the party, and the new game must leave nothing running either.
		await host.evaluate(() => window.__party.room.setGame(null));
		await host.locator(".party-member").first().waitFor({ timeout: TIMEOUT });
		check(
			"Tug of War tore itself down",
			await host.evaluate(() => document.querySelectorAll("#tug-canvas").length === 0),
		);
	}

	console.log("\nparty: losing the host");
	await host.evaluate(() => window.__party.room.setGame(null));
	await p2.locator(".party-member").first().waitFor({ timeout: TIMEOUT });
	await host.close();
	// p2 joined before p3, so p2 is the heir. The crown passes automatically —
	// no offer, no button, just the succession the moment the host is gone.
	await p2.locator(".party-tag.is-host").first().waitFor({ timeout: TIMEOUT });
	check(
		"the longest-present member takes the crown automatically",
		(await p2.locator(".party-tag.is-host").count()) === 1,
	);
	const p3SeesHost = await p3
		.locator(".party-tag.is-host")
		.first()
		.waitFor({ timeout: TIMEOUT })
		.then(() => true)
		.catch(() => false);
	check("the rest of the party agrees on the new host", p3SeesHost);
	// Wait for the host's seat to be dropped after the reconnect grace; the
	// crown passes immediately, but the roster shrinks only once the grace
	// runs out — so give it room before asserting the party survived.
	await p2.waitForFunction(
		() => document.querySelectorAll(".party-member").length === 2,
		undefined,
		{ timeout: TIMEOUT },
	);
	check("the party survived losing its host", (await names(p2)).length === 2);
} catch (err) {
	console.log(`\n  FAIL unexpected: ${err.message}`);
	failures++;
} finally {
	await browser.close();
}

console.log(failures ? `\n${failures} failure(s)` : "\nall party checks passed");
process.exit(failures ? 1 : 0);
