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
import { serve, gameFrame, readyToClick } from "./serve.mjs";

const require = createRequire(import.meta.url);
const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const PW_CACHE = join(homedir(), ".cache", "game-previews");
const SITE = await serve(8733);
const PARTY = SITE.url("party.html");
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

/**
 * The text of the next in-page question (NeonArcade.ask) on `page`,
 * answered with `accept`; or
 * "(no dialog)" if none comes — a missing confirmation is a failure to
 * report, not a reason to hang.
 */
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

/** Whether a notice (NeonArcade.toast) with `text` shows up on `page`. */
const toastOn = (page, text) =>
	page
		.locator(".neon-toast", { hasText: text })
		.first()
		.waitFor({ timeout: TIMEOUT })
		.then(() => true)
		.catch(() => false);

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
		// Connect 4 runs framed (lib/bridge.js): its DOM is in the frame.
		const g = await gameFrame(page, TIMEOUT);
		await g.locator("#board").waitFor({ timeout: TIMEOUT });
		check(`${tag} mounted Connect 4`, await g.locator("#board").isVisible());
	}
	const spectatorHud = await (await gameFrame(p3, TIMEOUT)).locator("#hud").textContent();
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
		const g = await gameFrame(page, TIMEOUT);
		await g.locator("#gameCanvas").waitFor({ timeout: TIMEOUT });
		check(`${tag} switched to Neon Survival`, await g.locator("#gameCanvas").isVisible());
	}
	const idsAfter = await host.evaluate(() => window.__party.room.directPeers().sort().join(","));
	check("nobody reconnected across the switch", idsBefore === idsAfter, `${idsBefore} -> ${idsAfter}`);
	check(
		"the old game left nothing behind",
		// Neon Survival's own frame is the only one: Connect 4's went with it.
		await host.evaluate(() => document.querySelectorAll("#board").length === 0 && document.querySelectorAll(".game-frame").length === 1),
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

		// Draw & Guess runs framed (lokeshmohanty/arcade-games): its DOM is
		// read in each page's game frame.
		const F = new Map();
		for (const page of [host, p2, p3]) {
			F.set(page, await gameFrame(page, TIMEOUT));
			await F.get(page).locator("#dg-canvas, #draw-canvas, canvas").first().waitFor({ timeout: TIMEOUT });
		}

		// The drawer's chat box is disabled; that is how the roles are told
		// apart, and it only settles once the drawing phase is really open.
		const guesser = await Promise.race(
			[host, p2, p3].map(async (page) => {
				await F.get(page).waitForFunction(
					() => document.querySelector("#chat-input")?.disabled === false,
					null,
					{ timeout: TIMEOUT },
				);
				return page;
			}),
		);
		check("the drawing phase opened", true);

		const phaseOf = (page) => F.get(page).evaluate(() => document.querySelector("#hud .timer")?.textContent ?? "");
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
			pages.map((page) => F.get(page).evaluate(() => document.querySelector("#chat-input")?.disabled === true)),
		);
		const drawer = pages[disabled.indexOf(true)] ?? host;
		const word = await F.get(drawer).evaluate(() => {
			const el = document.querySelector("#word-display");
			return el ? el.textContent.trim() : "";
		});
		const secret = word.replace(/[^a-z]/gi, "");
		if (secret && !secret.includes("_")) {
			const before = Date.now();
			for (const page of [host, p2, p3]) {
				const enabled = await F.get(page).evaluate(() => document.querySelector("#chat-input")?.disabled === false);
				if (!enabled) continue;
				await readyToClick(page);
				await F.get(page).fill("#chat-input", secret);
				await F.get(page).click("#chat-send");
			}
			// Sixty seconds is the drawing deadline; anything near it means the
			// early exit did not fire.
			await F.get(guesser).waitForFunction(
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
			(await host.locator(".game-frame").count()) === 0);
	}

	// The roster is checked against each game's shape before START: a 2-v-1
	// party cannot start a one-against-one game. (Tug of War, the one game
	// with several players per side, was retired on 2026-11-14;
	// docs/index.md says what that leaves untested.)
	console.log("\nparty: a roster the game cannot seat");
	await host.evaluate(() => window.__party.room.setGame(null));
	{
		const rows2 = host.locator(".party-member");
		await rows2.nth(2).locator("button", { hasText: "TEAM A" }).click(); // p3 joins A
		const c4card = host.locator(".party-game", { hasText: "CONNECT 4" });
		await c4card.waitFor({ timeout: TIMEOUT });
		await host.waitForFunction(() => window.__party.room.getMembers().filter((m) => m.team === "A").length === 2, null, { timeout: TIMEOUT });
		check("Connect 4, one against one, refuses a 2v1 roster", !(await c4card.isEnabled()));
		const why = (await c4card.locator(".party-game-warn").textContent().catch(() => "")) ?? "";
		check("…and says why", /at most 2 players|one against one/.test(why), why);
	}

	console.log("\nparty: the host's way out");
	// Asking is not leaving: the host is told who inherits, says no, and is
	// still the host of a party of three afterwards.
	const heirName = await p2.evaluate(() => window.__party.room.self().name);
	const asked = nextDialog(host, false);
	await host.locator("a.neon-btn", { hasText: "ALL GAMES" }).click();
	const question = await asked;
	check(
		"the host's leave confirmation names the heir",
		question.includes(`crown will pass to ${heirName}`),
		question,
	);
	check(
		"declining the confirmation leaves the host where they were",
		host.url().startsWith(PARTY) &&
			(await host.evaluate(() => !window.__party.room.closed && window.__party.room.isHost())),
	);

	console.log("\nparty: back to the party from a running game");
	// Nothing used to lead from a running game back to the party screen.
	await host.evaluate(() => window.__party.room.setGame("connect4"));
	for (const page of [host, p2, p3]) await (await gameFrame(page, TIMEOUT)).locator("#board").waitFor({ timeout: TIMEOUT });
	const pill = await p2.evaluate(() => {
		// PARTY and, beside it, FEEDBACK and FAVOURITE: the whole group.
		const p = document.querySelector(".party-pill");
		const r = p && !p.hidden ? document.querySelector(".top-actions").getBoundingClientRect() : null;
		const l = document.querySelector(".portal-link").getBoundingClientRect();
		return { r: r && { left: r.left, right: r.right, bottom: r.bottom }, portalRight: l.right, vw: innerWidth };
	});
	check(
		"a running game shows PARTY (with FEEDBACK and FAVOURITE), clear of ← All games, on the phone",
		!!pill.r && pill.r.right <= pill.vw && pill.r.left > pill.portalRight && pill.r.bottom <= 52,
		JSON.stringify(pill),
	);
	await p2.locator(".party-pill").click();
	const peek = await p2.evaluate(() => ({
		shown: !document.getElementById("party").hidden,
		game: window.__party.game,
		buttons: [...document.querySelectorAll("#party button")].map((b) => b.textContent),
	}));
	check("PARTY pulls the party screen up over the game", peek.shown && peek.game === "connect4", JSON.stringify(peek));
	check("…with BACK TO GAME, and no END GAME for a guest", peek.buttons.includes("BACK TO GAME") && !peek.buttons.includes("END GAME"));
	await p2.locator("button", { hasText: "BACK TO GAME" }).click();
	check(
		"BACK TO GAME puts it away, the game still running",
		await p2.evaluate(() => document.getElementById("party").hidden && window.__party.game === "connect4"),
	);

	await host.locator(".party-pill").click();
	let endQ = nextDialog(host, false);
	await host.locator("button", { hasText: "END GAME" }).click();
	endQ = await endQ;
	check("END GAME asks first", /End Connect 4 for everyone/i.test(endQ), endQ);
	check("…and KEEP PLAYING keeps it", await host.evaluate(() => window.__party.game === "connect4"));
	endQ = nextDialog(host, true);
	await host.locator("button", { hasText: "END GAME" }).click();
	await endQ;
	const backAll = await Promise.all(
		[host, p2, p3].map((page) =>
			page
				.waitForFunction(() => window.__party.game === null && !document.getElementById("party").hidden, null, { timeout: TIMEOUT })
				.then(() => true)
				.catch(() => false),
		),
	);
	check("END GAME brings everyone back to the party screen", backAll.every(Boolean), JSON.stringify(backAll));
	check("…and PARTY is gone with the game", (await p2.locator(".party-pill:not([hidden])").count()) === 0);

	console.log("\nparty: a player who leaves the app");
	// Another app or a locked phone, faked the way a page sees it: `hidden`
	// and the event. The host's simulation pauses for everyone and says why;
	// anyone away shows AWAY; a turn game waiting on them says so.
	// The page and every frame in it, as a real tab switch hides them all: a
	// framed game watches its own document's visibility.
	const setHidden = (page, hidden) =>
		Promise.all(
			page.frames().map((f) =>
				f.evaluate((h) => {
					Object.defineProperty(document, "hidden", { value: h, configurable: true });
					Object.defineProperty(document, "visibilityState", { value: h ? "hidden" : "visible", configurable: true });
					document.dispatchEvent(new Event("visibilitychange"));
				}, hidden),
			),
		);
	const shown = (page, sel, re, ms = 8000) =>
		page.locator(`${sel}:not([hidden])`, { hasText: re }).first().waitFor({ timeout: ms }).then(() => true, () => false);
	await host.evaluate(() => window.__party.room.setGame("neon-survival-mp"));
	for (const page of [host, p2, p3]) await (await gameFrame(page, TIMEOUT)).locator("#gameCanvas").waitFor({ timeout: TIMEOUT });
	const wake = await host
		.waitForFunction(() => !navigator.wakeLock || window.NeonArcade.awake(), null, { timeout: 3000 })
		.then(() => host.evaluate(() => ({ api: !!navigator.wakeLock, awake: window.NeonArcade.awake() })), () => ({ api: true, awake: false }));
	check("the screen is kept on while a game runs", !wake.api || wake.awake, JSON.stringify(wake));
	// The swarm moves on animation frames, which a background tab barely gets:
	// the host's page in front, and a swarm on the field, before it "leaves".
	await host.bringToFront();
	await (await gameFrame(host, TIMEOUT)).waitForFunction(() => (window.enemies ?? []).length > 0, null, { timeout: TIMEOUT });
	await setHidden(host, true);
	const [hostT2, p2T2] = [await gameFrame(host, TIMEOUT), await gameFrame(p2, TIMEOUT)];
	check("the host leaves the app: the others see the game paused, and why", await shown(p2T2, ".host-pause", /Paused — .+ left the app/));
	// The roster under a game is not redrawn; PARTY pulls it up, current.
	await p2.locator(".party-pill").click();
	check("…and AWAY by the host's name on the roster", await p2.locator(".party-tag.is-away").first().waitFor({ timeout: 5000 }).then(() => true, () => false));
	await p2.locator("button", { hasText: "BACK TO GAME" }).click();
	// The swarm is the host's simulation: frozen while it is away, moving
	// again after the count. (Its ships' positions are guests' own input, so
	// the swarm is what shows whether the host is running anything.)
	const swarm = () => hostT2.evaluate(() => JSON.stringify((window.enemies ?? []).map((e) => [Math.round(e.x), Math.round(e.y)])));
	const before = await swarm();
	await host.waitForTimeout(600);
	const during = await swarm();
	check("…and the host's simulation stands still meanwhile", before === during && before !== "[]", `${before.slice(0, 80)} → ${during.slice(0, 80)}`);
	await setHidden(host, false);
	check("back: everyone counts down together", (await shown(p2T2, ".host-pause", /Resuming in [1-3]/)) && (await shown(hostT2, ".host-pause", /Resuming in [1-3]/)));
	const resumed = await p2T2.locator(".host-pause").waitFor({ state: "hidden", timeout: 6000 }).then(() => true, () => false);
	check("…and play resumes", resumed);
	await host.waitForTimeout(600);
	const after = await swarm();
	check("…with the simulation running again", after !== during, after.slice(0, 80));
	await p2.locator(".party-pill").click();
	check("…and AWAY gone", await p2.locator(".party-tag.is-away").first().waitFor({ state: "detached", timeout: 5000 }).then(() => true, () => false));
	await p2.locator("button", { hasText: "BACK TO GAME" }).click();

	await host.evaluate(() => window.__party.room.setGame("connect4"));
	for (const page of [host, p2, p3]) await page.waitForFunction(() => window.__party.game === "connect4" && window.__party.handle, null, { timeout: TIMEOUT });
	const hostC4 = await gameFrame(host, TIMEOUT);
	// A framed game mounts after the frame loads, not inside setGame.
	await hostC4.waitForFunction(() => window.__game.handle.debug().started, null, { timeout: TIMEOUT });
	const away4 = await hostC4.evaluate(() => {
		const d = window.__game.handle.debug();
		return { toMove: d.turn === 1 ? d.red : d.yellow, host: window.__game.ctx.room.selfId };
	});
	if (away4.toMove === away4.host) {
		await readyToClick(host);
		await hostC4.locator("#board").click();
		await hostC4.waitForFunction((h) => {
			const d = window.__game.handle.debug();
			return (d.turn === 1 ? d.red : d.yellow) !== h;
		}, away4.host, { timeout: TIMEOUT });
	}
	const moverId = await hostC4.evaluate(() => {
		const d = window.__game.handle.debug();
		return d.turn === 1 ? d.red : d.yellow;
	});
	let mover = null;
	for (const page of [p2, p3]) if ((await page.evaluate(() => window.__party.room.selfId)) === moverId) mover = page;
	check("(a guest is to move in Connect 4)", !!mover);
	if (mover) {
		await setHidden(mover, true);
		check("a turn game waiting on a player who left the app says so", await shown(hostC4, ".turn-wait", /Waiting for .+ switched away \(0:\d\d\)/));
		await setHidden(mover, false);
		check("…and the banner goes when they are back", await hostC4.locator(".turn-wait").first().waitFor({ state: "hidden", timeout: 6000 }).then(() => true, () => false));
	}
	await host.evaluate(() => window.__party.room.setGame(null));

	console.log("\nparty: the party screen does not churn");
	// Behind a running game nobody sees the party screen, so a roster event
	// must not rebuild it; and a name being typed survives a rebuild.
	await host.evaluate(() => window.__party.room.setGame("connect4"));
	await (await gameFrame(p2, TIMEOUT)).locator("#board").waitFor({ timeout: TIMEOUT });
	await p2.evaluate(() => (window.__row = document.querySelector("#party .party-member")));
	await p3.evaluate(() => window.__party.room.setMeta({ mood: "busy" }));
	await p2.waitForFunction(() => window.__party.room.getMembers().some((m) => m.mood === "busy"), null, { timeout: TIMEOUT });
	check("behind a game, a roster change does not rebuild the party screen", await p2.evaluate(() => window.__row.isConnected));
	await p2.locator(".party-pill").click();
	check("…and it is drawn fresh when pulled up", await p2.evaluate(() => !window.__row.isConnected && !!document.querySelector("#party .party-member")));
	await p2.locator("button", { hasText: "BACK TO GAME" }).click();
	await host.evaluate(() => window.__party.room.setGame(null));
	await p2.waitForFunction(() => window.__party.game === null, null, { timeout: TIMEOUT });
	const nameBox = p2.locator("input.lobby-input").first();
	const before2 = await nameBox.inputValue();
	await nameBox.click();
	await nameBox.press("End");
	await nameBox.type("zz");
	await p3.evaluate(() => window.__party.room.setMeta({ mood: "idle" }));
	await p2.waitForFunction(() => window.__party.room.getMembers().some((m) => m.mood === "idle"), null, { timeout: TIMEOUT });
	const kept = await p2.evaluate(() => ({ value: document.activeElement?.value, focused: document.activeElement?.dataset?.partyName !== undefined }));
	check("a name being typed survives a roster change", kept.focused && kept.value === before2 + "zz", JSON.stringify(kept));
	await nameBox.press("Escape");
	await nameBox.fill(before2);
	await p2.locator("h1, .lobby-status").first().click().catch(() => {});

	// ADD PLAYER makes an invite and its PeerConnection; CANCEL closes it.
	const pendingNow = () => host.evaluate(() => window.__party.room.pending.size);
	const pending0 = await pendingNow();
	await host.locator("button", { hasText: "ADD PLAYER" }).click();
	await host.locator("button", { hasText: "CANCEL" }).waitFor({ timeout: TIMEOUT });
	const pending1 = await pendingNow();
	await host.locator("button", { hasText: "CANCEL" }).click();
	const pending2 = await pendingNow();
	check("CANCEL withdraws the invite and closes its connection", pending1 === pending0 + 1 && pending2 === pending0, `${pending0} → ${pending1} → ${pending2}`);

	console.log("\nparty: a link that cannot keep up is closed, not queued forever");
	// A channel stuck full: everything after it waits in our own queue. Past
	// 8 MB the link is dropped; the pair then go through the third member.
	const p3Id = await p3.evaluate(() => window.__party.room.selfId);
	const stuck = await p2.evaluate(async (peer) => {
		const room = window.__party.room;
		const link = room.links.get(peer);
		if (!link) return { error: "no link" };
		Object.defineProperty(link.dc, "bufferedAmount", { get: () => 1 << 30, configurable: true });
		const big = "x".repeat(1 << 20);
		for (let i = 0; i < 10; i++) link.post(big);
		await new Promise((r) => setTimeout(r, 50));
		return { dropped: room.links.get(peer) !== link, queued: link.queued };
	}, p3Id);
	check("an overflowing link is dropped and its queue freed", stuck.dropped && stuck.queued === 0, JSON.stringify(stuck));
	// As for any dropped direct link, the pair carry on through the third
	// member (net.js: relay-only is a legitimate steady state).
	await p3.evaluate(() => {
		window.__heard = 0;
		window.__party.room.makeAction("t$q").onMessage = () => window.__heard++;
	});
	await p2.evaluate((peer) => window.__party.room.makeAction("t$q").send({}, { target: peer }), p3Id);
	const heard = await p3.waitForFunction(() => window.__heard > 0, null, { timeout: 8000 }).then(() => true, () => false);
	check("…and messages still reach them, through the third member", heard);

	console.log("\nparty: every way out asks, and everyone is told");
	// A fourth player, so the three above stay for the succession below.
	const p4 = await context.newPage();
	p4.on("pageerror", (err) => {
		console.log(`  FAIL page error on p4: ${err.message}`);
		failures++;
	});
	await invite(p2, p4, "p4");
	const p4Name = await p4.evaluate(() => window.__party.room.self().name);
	check("the host is told who joined", await toastOn(host, `${p4Name} joined the party.`));
	const stillIn = (page) => page.evaluate(() => !!window.__party.room && !window.__party.room.closed);

	// "← All games", the fixed link on every page — it used to just navigate.
	let q = nextDialog(p4, false);
	await p4.locator("a.portal-link").click();
	q = await q;
	check("← All games asks before leaving", /Leave the party/.test(q), q);
	check("…says the others will be told", /others will be told/.test(q), q);
	check("…and STAY keeps the player in the party", p4.url().startsWith(PARTY) && (await stillIn(p4)));

	// The question fits the phone, safe answer first.
	await p4.locator("a.portal-link").click();
	const askBox = await p4.evaluate(() => {
		const r = document.querySelector("dialog.neon-ask[open] .neon-ask-box")?.getBoundingClientRect();
		const focused = document.activeElement?.dataset?.ask ?? null;
		return { r: r && { left: r.left, right: r.right }, vw: innerWidth, focused };
	});
	check(
		"the question fits a 390px phone",
		!!askBox.r && askBox.r.left >= 16 && askBox.r.right <= askBox.vw - 16,
		JSON.stringify(askBox),
	);
	check("STAY has the focus, not LEAVE", askBox.focused === "no", String(askBox.focused));
	await p4.keyboard.press("Escape");
	check("Escape means stay", (await p4.locator("dialog.neon-ask[open]").count()) === 0 && (await stillIn(p4)));

	// The back button / swipe-back lands on the guard entry and asks there.
	q = nextDialog(p4, false);
	await p4.goBack();
	q = await q;
	check("going back asks before leaving", /Go back and leave/.test(q), q);
	check("…and STAY keeps them in", await stillIn(p4));
	q = nextDialog(p4, false);
	await p4.goBack();
	q = await q;
	check("…and asks again on the next back", /Go back and leave/.test(q), q);

	// A tab close or reload: the browser's own prompt is all a page can have.
	const unload = new Promise((done) => {
		const timer = setTimeout(() => done(null), 5000);
		p4.once("dialog", async (d) => {
			clearTimeout(timer);
			done(d.type());
			await d.dismiss();
		});
	});
	await p4.close({ runBeforeUnload: true });
	check("closing the tab mid-party raises the browser's prompt", (await unload) === "beforeunload");
	check("…and dismissing it keeps the tab", !p4.isClosed() && (await stillIn(p4)));

	// Now really leave: the others are told, and how.
	q = nextDialog(p4, true);
	await Promise.all([p4.waitForURL(/index\.html/, { timeout: TIMEOUT }), p4.locator("a.portal-link").click()]);
	await q;
	check("LEAVE leaves for the portal", /index\.html/.test(p4.url()));
	check("the host is told who left", await toastOn(host, `${p4Name} left the party.`));
	check("so is everyone else", await toastOn(p3, `${p4Name} left the party.`));
	const toastBox = await host.evaluate(() => {
		const r = document.querySelector(".neon-toast")?.getBoundingClientRect();
		const layer = document.querySelector(".neon-toasts");
		return {
			r: r && { left: r.left, right: r.right, top: r.top },
			vw: innerWidth,
			taps: layer && getComputedStyle(layer).pointerEvents,
		};
	});
	check(
		"the notice fits the phone and takes no taps",
		!!toastBox.r && toastBox.r.left >= 0 && toastBox.r.right <= toastBox.vw && toastBox.taps === "none",
		JSON.stringify(toastBox),
	);
	await p4.close();

	console.log("\nparty: losing the host");
	// Mid-game: the heir takes the game over from what everyone was sent, and
	// says so. With a bot, which must stay for the next host to play.
	const keptBot = await host.evaluate(() => window.__party.room.addBot("B"));
	await host.evaluate(() => window.__party.room.setGame("neon-survival-mp"));
	for (const page of [host, p2, p3]) await (await gameFrame(page, TIMEOUT)).locator("#gameCanvas").waitFor({ timeout: TIMEOUT });
	const hostName = await host.evaluate(() => window.__party.room.self().name);
	const p2Name = await p2.evaluate(() => window.__party.room.self().name);
	const told = Promise.all([
		toastOn(p2, "You are the host now."),
		toastOn(p3, `${p2Name} is the host now.`),
		toastOn(p3, `${hostName} lost connection and left the party.`),
		toastOn(p2, "You are the host now — NEON SURVIVAL goes on."),
		toastOn(p3, `${p2Name} carries NEON SURVIVAL on.`),
	]);
	await host.close();
	const [heirTold, restTold, dropTold, keptTold, restKept] = await told;
	check("a game the host was running goes on under the heir, who is told", keptTold);
	check("…and so is everyone else", restKept);
	// The heir's frame is the same one: a kept game is not remounted.
	const p2H = await gameFrame(p2, TIMEOUT);
	// The heir now runs the swarm: it moves on the heir's own simulation
	// (in front, so its animation frames run).
	await p2.bringToFront();
	const swarmNow = () => p2H.evaluate(() => JSON.stringify((window.enemies ?? []).map((e) => [Math.round(e.x), Math.round(e.y)])));
	const s0 = await swarmNow();
	const ran = await p2H
		.waitForFunction((was) => JSON.stringify((window.enemies ?? []).map((e) => [Math.round(e.x), Math.round(e.y)])) !== was, s0, { timeout: 8000 })
		.then(() => true, () => false);
	check("…and the new host runs it: the swarm moves on", ran && (await p3.evaluate(() => window.__party.game)) === "neon-survival-mp");
	await p2.evaluate(() => window.__party.room.setGame(null));
	await p3.waitForFunction(() => window.__party.game === null && !document.getElementById("party").hidden, null, { timeout: TIMEOUT });
	check("the heir is told the crown is theirs", heirTold);
	check("the rest are told who holds it now", restTold);
	check("…and that the host's connection went, not that they chose to leave", dropTold);
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
		() => document.querySelectorAll(".party-member").length === 3,
		undefined,
		{ timeout: TIMEOUT },
	);
	check("the party survived losing its host", (await names(p2)).length === 3);
	check("…and kept the host's bot", await p2.evaluate((id) => !!window.__party.room.getMember(id), keptBot));
	// The new host plays it: a Connect 4 move gets the bot's answer.
	await p2.evaluate((id) => {
		const r = window.__party.room;
		r.setTeam(r.selfId, "A");
		r.setTeam(id, "B");
		for (const m of r.getMembers()) if (m.id !== r.selfId && m.id !== id) r.setTeam(m.id, "spectator");
		r.setGame("connect4");
	}, keptBot);
	const p2C4 = await gameFrame(p2, TIMEOUT);
	await p2C4.waitForFunction(() => window.__game.handle?.debug?.().started, null, { timeout: TIMEOUT });
	await readyToClick(p2); // clicks into a game frame: see serve.mjs
	await p2C4.locator("#board").click();
	const botAnswered = await p2C4
		.waitForFunction(() => window.__game.handle.debug().board.flat().filter(Boolean).length === 2, null, { timeout: TIMEOUT })
		.then(() => true, () => false);
	check("…which the new host plays", botAnswered);
	await p2.evaluate((id) => {
		window.__party.room.setGame(null);
		window.__party.room.removeMember(id);
	}, keptBot);
	await p2.waitForFunction(() => document.querySelectorAll(".party-member").length === 2, undefined, { timeout: TIMEOUT });

	console.log("\nparty: a carried reply that failed");
	// Between some networks a reply only works if it is carried back within
	// ~15 s: the replier's own ICE gives up, and with no signalling channel
	// nothing can rebuild the link (docs/network-testing.md, "Final code").
	// The reply screen says to hurry; a failed one says why and offers a new
	// reply for the same invite. The failure is the real path — ICE reporting
	// `failed` on the replier's connection (net.js _watch) — forced here
	// because loopback always has a route.
	{
		const pair = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
		// The replier's *first* reply is also kept from ever reaching the
		// inviter (the invite's candidates are stripped before it is
		// answered), as across the networks this models: on loopback its
		// ICE would connect at once, and a DTLS hello the inviter cached
		// from it could spoil the second reply's link. sessionStorage
		// survives the reload, so the second reply is left alone.
		await pair.addInitScript(() => {
			const P = RTCPeerConnection;
			const strip = !sessionStorage.getItem("__stripped");
			window.__pcs = [];
			window.RTCPeerConnection = class extends P {
				constructor(...args) {
					super(...args);
					window.__pcs.push(this);
				}
				setRemoteDescription(d) {
					if (strip && d?.type === "offer") {
						sessionStorage.setItem("__stripped", "1");
						d = { type: d.type, sdp: d.sdp.replace(/^a=candidate:.*\r\n/gm, "") };
					}
					return super.setRemoteDescription(d);
				}
			};
		});
		const inviter = await pair.newPage();
		const replier = await pair.newPage();
		for (const [page, tag] of [[inviter, "inviter"], [replier, "replier"]]) {
			page.on("pageerror", (err) => {
				console.log(`  FAIL page error on ${tag}: ${err.message}`);
				failures++;
			});
		}
		await inviter.goto(PARTY);
		await inviter.locator(".party-member").first().waitFor({ timeout: TIMEOUT });
		await inviter.locator("button", { hasText: "ADD PLAYER" }).first().click();
		const inviteBox = inviter.locator("textarea.share-code").first();
		await inviteBox.waitFor({ timeout: TIMEOUT });
		await replier.goto(await inviteBox.inputValue());
		const replyBox = replier.locator("textarea.share-code").first();
		await replyBox.waitFor({ timeout: TIMEOUT });
		const firstReply = await replyBox.inputValue();
		const hint = await replier.locator(".share-hint").first().textContent();
		check("the reply screen says to carry it back right away", /right away/i.test(hint) && /15 seconds/.test(hint), hint);
		const replyLayout = await replier.evaluate(() => ({
			hint: document.querySelector(".share-hint").getBoundingClientRect().toJSON(),
			scroll: document.documentElement.scrollWidth,
			client: document.documentElement.clientWidth,
		}));
		check("…and still fits the phone sideways", replyLayout.scroll <= replyLayout.client && replyLayout.hint.right <= replyLayout.client, JSON.stringify(replyLayout));
		await replier.evaluate(() => {
			for (const pc of window.__pcs) {
				Object.defineProperty(pc, "connectionState", { get: () => "failed" });
				pc.onconnectionstatechange?.();
			}
		});
		const again = replier.locator("button", { hasText: "MAKE A NEW REPLY" });
		const offered = await again
			.waitFor({ timeout: TIMEOUT })
			.then(() => true)
			.catch(() => false);
		check("a failed reply offers MAKE A NEW REPLY", offered);
		const failed = await replier.evaluate(() => {
			const row = [...document.querySelectorAll(".lobby-row")].find((r) => /MAKE A NEW REPLY/.test(r.textContent));
			const hint = [...document.querySelectorAll(".share-hint")].find((h) => /new invite/.test(h.textContent));
			return {
				status: document.querySelector(".lobby-status.is-error")?.textContent ?? "",
				hint: hint?.textContent ?? "",
				hintBox: hint ? hint.getBoundingClientRect().toJSON() : null,
				buttons: [...(row?.children ?? [])].map((b) => b.getBoundingClientRect().toJSON()),
				labels: [...(row?.children ?? [])].map((b) => b.textContent),
				scroll: document.documentElement.scrollWidth,
				client: document.documentElement.clientWidth,
				height: window.innerHeight,
			};
		});
		check(
			"it says the reply took too long or the networks cannot connect",
			/not used in time/.test(failed.status) && /cannot connect directly/.test(failed.status),
			failed.status,
		);
		check("and what to do about it, never a wait", /straight away/.test(failed.hint) && /new invite/.test(failed.hint), failed.hint);
		check("a fresh party is still offered beside it", failed.labels.includes("START A NEW PARTY"), JSON.stringify(failed.labels));
		check(
			"the failure screen fits the phone (390x844)",
			failed.buttons.length >= 2 &&
				failed.buttons.every((b) => b.left >= 0 && b.right <= failed.client && b.bottom <= failed.height) &&
				failed.hintBox && failed.hintBox.right <= failed.client && failed.hintBox.bottom <= failed.height &&
				failed.scroll <= failed.client,
			JSON.stringify(failed),
		);
		await again.click();
		const secondReply = await replier
			.waitForFunction(
				(old) => {
					const v = document.querySelector("textarea.share-code")?.value;
					return v && v !== old ? v : null;
				},
				firstReply,
				{ timeout: TIMEOUT },
			)
			.then((h) => h.jsonValue())
			.catch(() => null);
		check("MAKE A NEW REPLY answers the same invite afresh", !!secondReply && secondReply !== firstReply);
		await inviter.locator("textarea.share-code").last().fill(secondReply);
		await inviter.locator("button.neon-btn", { hasText: /^CONNECT$/ }).first().click();
		check("…and the new reply connects", await waitForMembers(replier, 2, "replier"));
		await pair.close();
	}

	console.log("\nparty: leaving through ALL GAMES");
	// Its own context, so the rejoin token under test is nobody else's.
	// `?mockroom=1` gives the page a room server, so it hosts with a code and
	// a token — the state the portal banner used to silently rejoin.
	const solo = await browser.newContext({
		viewport: { width: 390, height: 844 },
		isMobile: true,
		hasTouch: true,
	});
	const leaver = await solo.newPage();
	leaver.on("pageerror", (err) => {
		console.log(`  FAIL page error on leaver: ${err.message}`);
		failures++;
	});
	await leaver.goto(PARTY + "?mockroom=1");
	await leaver.locator(".party-code-digits").waitFor({ timeout: TIMEOUT });
	const firstCode = await leaver.locator(".party-code-digits").textContent();
	check(
		"a room-server party holds a rejoin token",
		await leaver.evaluate(() => !!localStorage.getItem("neon.room")),
	);

	// The party code's QR, unfolded, at phone size.
	await leaver.locator("button", { hasText: "SHOW QR" }).click();
	const qr = await leaver.evaluate(() => {
		const r = document.querySelector(".party-code-qr")?.getBoundingClientRect();
		return {
			rect: r && { left: r.left, right: r.right, width: r.width },
			scroll: document.documentElement.scrollWidth,
			client: document.documentElement.clientWidth,
		};
	});
	check(
		"the party code's QR fits the phone",
		!!qr.rect && qr.rect.left >= 0 && qr.rect.right <= qr.client && qr.rect.width >= 150,
		JSON.stringify(qr.rect),
	);
	check(
		"the QR does not make the party screen scroll sideways",
		qr.scroll <= qr.client,
		`scrollWidth ${qr.scroll} > clientWidth ${qr.client}`,
	);
	// Read back with the arcade's own decoder, the one SCAN REPLY uses.
	const qrLink = await leaver.evaluate(() => {
		const c = document.querySelector(".party-code-qr");
		const img = c.getContext("2d").getImageData(0, 0, c.width, c.height);
		return NeonArcade.qrDecode(img)?.text ?? null;
	});
	check(
		"the QR carries the party's #c= link",
		typeof qrLink === "string" && qrLink.endsWith(`#c=${firstCode}`),
		String(qrLink),
	);

	const alone = nextDialog(leaver, true);
	await Promise.all([
		leaver.waitForURL(/index\.html/, { timeout: TIMEOUT }),
		leaver.locator("a.neon-btn", { hasText: "ALL GAMES" }).click(),
	]);
	check(
		"a host alone is told the party ends",
		/nobody else is here/.test(await alone),
		await alone,
	);
	check(
		"leaving through ALL GAMES drops the rejoin token",
		await leaver.evaluate(() => localStorage.getItem("neon.room") === null),
	);
	// What the portal's party banner does, with the mock still attached so a
	// surviving token would have somewhere to reconnect to.
	await leaver.goto(PARTY + "?mockroom=1");
	await leaver.locator(".party-code-digits").waitFor({ timeout: TIMEOUT });
	const banner = await leaver.evaluate(() => ({
		sub: document.querySelector(".lobby-sub")?.textContent ?? "",
		host: window.__party.room?.isHost() ?? false,
	}));
	check(
		"the party banner after leaving hosts a new party instead of rejoining",
		banner.host && !/Reconnecting/.test(banner.sub),
		JSON.stringify(banner),
	);

	console.log("\nparty: a code join the network refuses");
	// `?rs=` at a port nothing listens on: the dial fails as "unreachable",
	// which is the network's fault, not the party's — so the screen must say
	// so and offer RETRY, not just a fresh party.
	await leaver.goto(PARTY + "?rs=http://127.0.0.1:1#c=123456");
	const retry = leaver.locator("button", { hasText: /^RETRY$/ });
	const offered = await retry
		.waitFor({ timeout: TIMEOUT })
		.then(() => true)
		.catch(() => false);
	check("an unreachable room server offers RETRY", offered);
	const failed = await leaver.evaluate(() => {
		const row = [...document.querySelectorAll(".lobby-row")].find((r) =>
			/RETRY/.test(r.textContent),
		);
		const box = (n) => n && n.getBoundingClientRect();
		return {
			status: document.querySelector(".lobby-status.is-error")?.textContent ?? "",
			fresh: /START A NEW PARTY/.test(row?.textContent ?? ""),
			buttons: [...(row?.children ?? [])].map((b) => {
				const r = box(b);
				return { left: r.left, right: r.right };
			}),
			scroll: document.documentElement.scrollWidth,
			client: document.documentElement.clientWidth,
		};
	});
	check(
		"the failure is spelled out, not left as a wait",
		/room server/i.test(failed.status),
		failed.status,
	);
	check("a fresh party is still offered next to RETRY", failed.fresh);
	check(
		"the RETRY row fits the phone",
		failed.buttons.length >= 3 &&
			failed.buttons.every((b) => b.left >= 0 && b.right <= failed.client) &&
			failed.scroll <= failed.client,
		JSON.stringify(failed),
	);
	await solo.close();
} catch (err) {
	console.log(`\n  FAIL unexpected: ${err.message}`);
	failures++;
} finally {
	await browser.close();
}

console.log(failures ? `\n${failures} failure(s)` : "\nall party checks passed");
process.exit(failures ? 1 : 0);
