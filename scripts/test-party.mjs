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

/**
 * The message of the next confirm() on `page`, answered with `accept`; or
 * "(no dialog)" if none comes — a missing confirmation is a failure to
 * report, not a reason to hang.
 */
const nextDialog = (page, accept) =>
	new Promise((done) => {
		const timer = setTimeout(() => done("(no dialog)"), 5000);
		page.once("dialog", async (d) => {
			clearTimeout(timer);
			done(d.message());
			await (accept ? d.accept() : d.dismiss());
		});
	});

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
