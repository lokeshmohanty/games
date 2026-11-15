// scripts/test-social.mjs — the account layer in real browsers, at 390x844,
// against the real Worker (wrangler dev, local D1) and the real site:
// signing in, the profile, favourites on two devices, ADD FRIEND in a party,
// a pushed invite, a ranked Connect 4 game between two signed-in people, the
// leaderboards, a Neon Survival run and a Light Cycles round played alone, a
// Tic Tac Toe win against a bot on its own board (shown in all three themes),
// groups, the feedback sheet, and deleting the account.
//
// Needs wrangler (scripts/wrangler.mjs); skips with a message without it.

import { existsSync, globSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { BOTS } from "../worker/api/bots.js";
import { gameFrame, readyToClick, serve } from "./serve.mjs";
import { startWrangler } from "./wrangler.mjs";

const require = createRequire(import.meta.url);
const TIMEOUT = 30_000;
let failures = 0;
const check = (label, ok, detail = "") => {
	console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
	if (!ok) failures++;
};

const w = await startWrangler({ AUTH_TEST: "1", SESSION_KEY: "social-test-key-0123456789", LB_MIN_GAMES: "1" });
if (!w) process.exit(0);
const site = await serve(8737);
const RS = encodeURIComponent(w.base);
const page = (p, extra = "") => `${site.base}/${p}${p.includes("?") ? "&" : "?"}rs=${RS}${extra}`;

function chrome() {
	return [process.env.CHROME, "/run/current-system/sw/bin/google-chrome-stable", "/run/current-system/sw/bin/chromium", "/usr/bin/google-chrome"].filter(Boolean).find(existsSync);
}
const pw = require(
	[join(homedir(), ".cache", "game-previews", "node_modules", "playwright"), ...globSync(join(homedir(), ".npm", "_npx", "*", "node_modules", "playwright"))].find(existsSync),
);
const browser = await pw.chromium.launch({ executablePath: chrome(), args: ["--no-sandbox"] });
const phone = { viewport: { width: 390, height: 844 } };

/** A browser "device" signed in as `name` (the loopback-only test sign-in). */
async function device(name, uid = name) {
	const ctx = await browser.newContext(phone);
	const p = await ctx.newPage();
	p.on("pageerror", (e) => check(`no page error on ${name}'s device (${e.message})`, false));
	const back = page("profile.html");
	await p.goto(`${w.base}/auth/test?name=${encodeURIComponent(name)}&uid=${encodeURIComponent(uid)}&back=${encodeURIComponent(back)}`);
	await p.locator(".who .name").waitFor({ timeout: TIMEOUT });
	return { ctx, p };
}
const noSideScroll = (p) => p.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
// Screenshots of the boards (NEON_SHOTS=dir), for a person to look at too.
const SHOTS = process.env.NEON_SHOTS ?? null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
/** Every run-start and match report a page sends, with the server's answers. */
function watchRuns(p) {
	const seen = { starts: [], reports: [] };
	p.on("response", async (r) => {
		const sent = () => JSON.parse(r.request().postData() ?? "{}");
		if (r.url().includes("/api/run/start") && r.ok()) seen.starts.push({ sent: sent(), got: await r.json().catch(() => null) });
		if (r.url().includes("/api/match/report")) seen.reports.push({ sent: sent(), got: await r.json().catch(() => null), at: Date.now() });
	});
	return seen;
}

try {
	console.log("\nsocial: signing in, the profile");
	const ana = await device("Ana");
	check("after sign-in the profile shows who you are", (await ana.p.locator(".who .name").textContent()) === "Ana");
	check("the token left the address bar", !ana.p.url().includes("token="), ana.p.url());
	check("the profile fits the phone", await noSideScroll(ana.p));
	await ana.p.locator("input[data-name]").fill("Ana Lima");
	await ana.p.locator("button", { hasText: "SAVE NAME" }).click();
	await ana.p.locator(".neon-toast", { hasText: "Saved." }).waitFor({ timeout: TIMEOUT });
	const anaId = await ana.p.evaluate(() => NeonArcade.account.me.id);
	check("the name is saved on the server", (await ana.p.evaluate(() => NeonArcade.account.api("/api/me"))).name === "Ana Lima");
	const methods = await ana.p.evaluate(() => [...document.querySelectorAll("[data-method]")].map((r) => `${r.dataset.method}:${r.querySelector("button")?.textContent}`));
	check("the profile lists its sign-in methods, each to connect", methods.join() === "github:CONNECT,google:CONNECT", methods);
	check("…and a friend code with a QR is shown", (await ana.p.locator("canvas.qr").count()) === 1 && (await ana.p.locator(".code").first().textContent()).includes(`?page=profile&u=${anaId}`));

	console.log("\nsocial: the portal and favourites on two devices");
	await ana.p.goto(page("index.html"));
	check("the portal names you", (await ana.p.locator(".site-menu .acct-me").textContent({ timeout: TIMEOUT })).includes("Ana Lima"));
	check("…and still fits the phone", await noSideScroll(ana.p));
	check("…with no star or feedback on the cards any more", (await ana.p.locator(".game-card .fav, .game-card .fb").count()) === 0);
	// Starred from inside the game now (party.js, top right).
	await ana.p.goto(page("party.html", "&game=connect4"));
	await ana.p.locator(".top-fav").click({ timeout: TIMEOUT });
	check("☆ at the top of a game stars it", (await ana.p.locator('.top-fav[aria-pressed="true"]').count()) === 1);
	// A collection's ★ (lib/collections.js) rides in the same list.
	await ana.p.evaluate(() => NeonArcade.stats.toggleFav("collection:lokeshmohanty/web-games"));
	await ana.p.waitForTimeout(1200); // the push is debounced
	// That game hosted a party of its own; forget it, so the party below is new.
	await ana.p.evaluate(() => localStorage.removeItem("neon.room"));
	const tablet = await device("Ana", "Ana"); // the same account elsewhere
	await tablet.p.goto(page("index.html"));
	const starred = await tablet.p
		.locator('[data-section="favs"] .game-card[data-game="connect4"]')
		.waitFor({ state: "attached", timeout: TIMEOUT })
		.then(() => true, () => false);
	check("a star on one device is a favourite on the other", starred);
	check("…a collection's too", await tablet.p.evaluate(() => NeonArcade.stats.isFav("collection:lokeshmohanty/web-games")));
	await tablet.ctx.close();

	console.log("\nsocial: friends in a party");
	const bo = await device("Bo");
	const boId = await bo.p.evaluate(() => NeonArcade.account.me.id);
	await ana.p.goto(page("party.html"));
	await ana.p.locator(".party-code-digits").waitFor({ timeout: TIMEOUT });
	const code = (await ana.p.locator(".party-code-digits").textContent()).replace(/\D/g, "");
	await bo.p.goto(page("party.html", `#c=${code}`));
	await ana.p.waitForFunction(() => document.querySelectorAll(".party-member").length === 2, null, { timeout: TIMEOUT });
	const addFriend = ana.p.locator(".party-member button", { hasText: "ADD FRIEND" });
	check("a signed-in member gets ADD FRIEND", await addFriend.waitFor({ timeout: TIMEOUT }).then(() => true, () => false));
	await addFriend.click();
	await ana.p.locator(".party-member button", { hasText: "ASKED" }).waitFor({ timeout: TIMEOUT });
	check("…which asks", true);
	const told = await bo.p.locator(".neon-toast", { hasText: "wants to be friends" }).waitFor({ timeout: TIMEOUT }).then(() => true, () => false);
	check("the other player is told at once (live socket)", told);
	await bo.p.waitForFunction(() => document.querySelector(".party-member button")?.textContent.includes("ACCEPT FRIEND") || [...document.querySelectorAll(".party-member button")].some((b) => b.textContent === "ACCEPT FRIEND"), null, { timeout: TIMEOUT });
	await bo.p.locator(".party-member button", { hasText: "ACCEPT FRIEND" }).click();
	check("accepting from the party", await bo.p.locator(".party-member button", { hasText: "FRIENDS ✓" }).waitFor({ timeout: TIMEOUT }).then(() => true, () => false));

	// Bo opens another page (the portal); Ana invites from the party screen.
	const boPortal = await bo.ctx.newPage();
	await boPortal.goto(page("index.html"));
	await boPortal.locator(".site-menu .acct-me").waitFor({ state: "attached", timeout: TIMEOUT });
	await ana.p.evaluate(() => window.__party && document.dispatchEvent(new Event("visibilitychange")));
	await ana.p.reload();
	await ana.p.locator(".party-code-digits").waitFor({ timeout: TIMEOUT });
	const invite = ana.p.locator(".party-friend button", { hasText: "INVITE" }).first();
	check("friends online are listed with INVITE", await invite.waitFor({ timeout: TIMEOUT }).then(() => true, () => false));
	await invite.click();
	const banner = boPortal.locator(".neon-invite", { hasText: "invites you" });
	check("the invite reaches the friend's other page", await banner.waitFor({ timeout: TIMEOUT }).then(() => true, () => false));
	check("…with a JOIN for this party's code", ((await banner.locator("a", { hasText: "JOIN" }).getAttribute("href")) ?? "").endsWith(`#c=${(await ana.p.locator(".party-code-digits").textContent()).replace(/\D/g, "")}`));
	await boPortal.close();

	console.log("\nsocial: a ranked game between two signed-in people");
	// The reload above made a new party; bring Bo into it.
	const code2 = (await ana.p.locator(".party-code-digits").textContent()).replace(/\D/g, "");
	await bo.p.goto(page("party.html", `#c=${code2}`));
	await ana.p.waitForFunction(() => document.querySelectorAll(".party-member").length === 2, null, { timeout: TIMEOUT });
	await ana.p.evaluate(() => {
		const r = window.__party.room;
		const [a, b] = r.getMembers();
		r.setTeam(a.id, "A");
		r.setTeam(b.id, "B");
		r.setGame("connect4");
	});
	const [fa, fb] = [await gameFrame(ana.p, TIMEOUT), await gameFrame(bo.p, TIMEOUT)];
	await fa.waitForFunction(() => window.__game.handle.debug().started, null, { timeout: TIMEOUT });
	// Ana is red (Team A) and moves first: four down column 0, Bo stacks column 1.
	const drop = async (who, f, col) => {
		await readyToClick(who);
		const box = await f.locator("#board").boundingBox();
		await who.mouse.click(box.x + (box.width / 7) * (col + 0.5), box.y + box.height / 2);
	};
	for (let i = 0; i < 4; i++) {
		await drop(ana.p, fa, 0);
		await fa.waitForFunction((n) => window.__game.handle.debug().board.flat().filter(Boolean).length >= n, 2 * i + 1, { timeout: TIMEOUT });
		if (i < 3) {
			await bo.p.waitForTimeout(150);
			await drop(bo.p, fb, 1);
			await fa.waitForFunction((n) => window.__game.handle.debug().board.flat().filter(Boolean).length >= n, 2 * i + 2, { timeout: TIMEOUT });
		}
	}
	const won = await fa.waitForFunction(() => window.__game.handle.debug().winner === 1, null, { timeout: TIMEOUT }).then(() => true, () => false);
	check("Ana wins four down", won);
	const counted = await ana.p.locator(".neon-toast", { hasText: "Counted on the leaderboard" }).waitFor({ timeout: TIMEOUT }).then(() => true, () => false);
	check("both reported, the server agreed: counted", counted);
	const lb = await ana.p.evaluate(() => NeonArcade.account.leaderboard("connect4", "friends"));
	check("the friends' board has both, Ana first", lb.rows.length === 2 && lb.rows[0].id === (/* Ana */ lb.rows.find((r) => r.name === "Ana Lima")?.id) && lb.rows[0].elo > 1200, lb.rows);
	const local = await ana.p.evaluate(() => JSON.parse(localStorage.getItem("neon.stats")).connect4);
	check("…and it is in this device's own stats too", local?.won >= 1 && local.vsPeople >= 1, local);

	console.log("\nsocial: the leaderboards page");
	await ana.p.goto(page("leaderboard.html", "&game=connect4&scope=global"));
	await ana.p.locator("[data-board] [data-player]").first().waitFor({ timeout: TIMEOUT });
	check("the global board lists the ranked players", (await ana.p.locator("[data-board] [data-player]").count()) === 2);
	check("…you highlighted", (await ana.p.locator("[data-board] [data-player].me").textContent()).includes("Ana Lima"));
	check("…a Friends tab", (await ana.p.locator(".scope", { hasText: "Friends" }).count()) === 1);
	check("…and it fits the phone", await noSideScroll(ana.p));

	console.log("\nsocial: a run played alone, issued by the server");
	{
		// SINGLE PLAYER on a one-seat game is alone: no bots, so it ranks on
		// its own report — under the run the server issued as it began.
		const cy = await device("Cy");
		let issued = null;
		const reports = [];
		cy.p.on("response", async (r) => {
			if (r.url().includes("/api/run/start") && r.ok()) issued = await r.json().catch(() => null);
			if (r.url().includes("/api/match/report")) reports.push({ sent: JSON.parse(r.request().postData() ?? "{}"), got: await r.json().catch(() => null), at: Date.now() });
		});
		await cy.p.goto(page("party.html", "&game=neon-survival-mp&fresh=1&mode=bots"));
		await gameFrame(cy.p, TIMEOUT);
		const until = async (fn, ms) => {
			for (const end = Date.now() + ms; Date.now() < end && !fn(); ) await cy.p.waitForTimeout(200);
			return fn();
		};
		check("alone and signed in, the server issues a run as the game begins", await until(() => typeof issued?.run === "string" && Number.isInteger(issued.seed), TIMEOUT), issued);
		// Nobody steers: the swarm ends the run soon enough.
		await until(() => reports.length, 120_000);
		const [rep] = reports;
		check("…the report names that run, not the party's", rep?.sent.run === issued?.run, rep?.sent);
		check("…and the server counts it", rep?.got?.counted === true, { got: rep?.got, secs: rep && issued ? (rep.at - issued.at) / 1000 : null });
		const lb = await cy.p.evaluate(() => NeonArcade.account.leaderboard("neon-survival-mp"));
		check("…a run with a best score on the board", lb.me?.games === 1 && lb.me.wins === 0 && Number.isFinite(lb.me.best), lb.me);
		await cy.ctx.close();
	}

	console.log("\nsocial: a Light Cycles round alone, its time on the solo board");
	{
		// The pinned Light Cycles may predate its solo score (web-games
		// 4cc6e1a): a build from that branch (NEON_PIN_OVERRIDE, docs/accounts.md
		// "Testing") has it.
		const rules = await fetch(`${site.base}/community/lokeshmohanty/web-games/light-cycles/light-cycles-rules.js`).then((r) => (r.ok ? r.text() : ""));
		if (!rules.includes("survived")) console.log("  skip the served Light Cycles has no solo score yet (the pin predates web-games 4cc6e1a)");
		else {
			const eli = await device("Eli");
			const seen = watchRuns(eli.p);
			await eli.p.goto(page("party.html", `&game=${encodeURIComponent("lokeshmohanty/light-cycles")}&fresh=1&mode=bots`));
			await gameFrame(eli.p, TIMEOUT);
			const until = async (fn, ms) => {
				for (const end = Date.now() + ms; Date.now() < end && !fn(); ) await eli.p.waitForTimeout(200);
				return fn();
			};
			// Nobody steers: the rider runs into the far wall a few seconds after GO.
			await until(() => seen.reports.length, 60_000);
			const [rep] = seen.reports;
			const issued = seen.starts.find((x) => !x.sent.vs)?.got;
			check("alone, a round's report names the server's run and carries its time", rep?.sent.run === issued?.run && typeof rep?.sent.scores?.[rep.sent.ranking[0][0]] === "number", rep?.sent);
			check("…which counts", rep?.got?.counted === true, rep?.got);
			check("…and asks for no run against bots (nobody else is in it)", !seen.starts.some((x) => x.sent.vs), seen.starts.map((x) => x.sent));
			await eli.p.goto(page("leaderboard.html", `&game=${encodeURIComponent("lokeshmohanty/light-cycles")}&level=alone`));
			await eli.p.locator("[data-board] [data-player].me").waitFor({ timeout: TIMEOUT });
			const score = await eli.p.locator("[data-board] [data-player].me .score").textContent();
			check("the leaderboard's Alone board shows the round, in seconds", /^\d+(\.\d)? s$/.test(score), score);
			check("…beside Races, under Ranked · Against bots", (await eli.p.locator("[data-levels] .scope").allTextContents()).join() === "Races,Alone" && !(await eli.p.locator(".strip[data-vs]").isHidden()));
			if (SHOTS) await eli.p.screenshot({ path: join(SHOTS, "light-cycles-alone.png") });
			await eli.ctx.close();
		}
	}

	console.log("\nsocial: a win against a bot, on its own board");
	{
		const dee = await device("Dee");
		const deeId = await dee.p.evaluate(() => NeonArcade.account.me.id);
		const seen = watchRuns(dee.p);
		await dee.p.goto(page("party.html", "&game=tic-tac-toe-js&fresh=1&mode=bots"));
		const f = await gameFrame(dee.p, TIMEOUT);
		// The bot wins if it can, blocks if it must, else takes the centre, else
		// the first free square: 0, 7, 6, 8 forks it, as X or as O (searched).
		const marks = () => f.locator("#ttt button").allTextContents();
		for (const square of [0, 7, 6, 8]) {
			await f.locator("#hud", { hasText: "YOUR TURN" }).waitFor({ timeout: TIMEOUT });
			const before = (await marks()).filter(Boolean).length;
			await f.locator("#ttt button").nth(square).click();
			await f.waitForFunction((n) => [...document.querySelectorAll("#ttt button")].filter((b) => b.textContent).length > n, before, { timeout: TIMEOUT });
		}
		const until = async (fn, ms) => {
			for (const end = Date.now() + ms; Date.now() < end && !fn(); ) await dee.p.waitForTimeout(100);
			return fn();
		};
		await until(() => seen.reports.length, TIMEOUT);
		const start = seen.starts.find((x) => x.sent.vs === "bots");
		const [rep] = seen.reports;
		check("one person and a bot: a run against bots is asked for as the match begins", start?.sent.game === "tic-tac-toe-js" && typeof start.got?.run === "string", seen.starts);
		check("…the win's report names it", rep?.sent.run === start?.got?.run && rep.sent.ranking.flat().some((id) => id.startsWith("bot_")), rep?.sent);
		check("…and counts, on the board against bots", rep?.got?.counted === true && rep.got.board === "bots" && rep.got.wins === 1, rep?.got);
		console.log(`  info: that win took ${((rep?.at - start?.got?.at) / 1000).toFixed(1)} s from the run (Tic Tac Toe's minimum: ${BOTS["tic-tac-toe-js"].minMs / 1000} s)`);
		check("…and says so", await dee.p.locator(".neon-toast", { hasText: "1 win against bots" }).waitFor({ timeout: TIMEOUT }).then(() => true, () => false));
		// PLAY AGAIN: a new run; the old one is spent, and nothing is sent twice.
		await dee.p.locator(".managed-actions button", { hasText: "PLAY AGAIN" }).click();
		await until(() => seen.starts.filter((x) => x.sent.vs === "bots").length === 2, TIMEOUT);
		check("PLAY AGAIN asks for a new run; the first win was reported once", seen.starts.filter((x) => x.sent.vs === "bots").length === 2 && seen.reports.length === 1, { starts: seen.starts.length, reports: seen.reports.length });
		await dee.p.goto(page("profile.html"));
		const line = await dee.p.locator(".bot-wins").textContent({ timeout: TIMEOUT }).catch(() => null);
		check("the profile says it, under the ratings and apart from them", line === "Wins against bots: Tic Tac Toe 1", line);
		const ranked = await dee.p.evaluate(() => NeonArcade.account.leaderboard("tic-tac-toe-js"));
		check("the ranked board does not have it", !ranked.rows.some((r) => r.id === deeId) && ranked.botsBoard === true, ranked);

		// A bot removed mid-match hands most games to whoever is left: that is
		// not a win against bots, and the page does not report it.
		await dee.p.goto(page("party.html", "&game=connect4&fresh=1&mode=bots"));
		const c4 = await gameFrame(dee.p, TIMEOUT);
		await c4.waitForFunction(() => window.__game?.handle?.debug?.().started, null, { timeout: TIMEOUT }).catch(() => {});
		await until(() => seen.starts.filter((x) => x.sent.game === "connect4" && x.sent.vs === "bots").length === 1, TIMEOUT);
		await dee.p.waitForTimeout(BOTS.connect4.minMs + 500);
		const before = seen.reports.length;
		await dee.p.evaluate(() => {
			const r = window.__party.room;
			r.removeMember(r.getMembers().find((m) => NeonArcade.isBotId(m.id)).id);
		});
		await dee.p.locator(".managed-actions").waitFor({ timeout: TIMEOUT });
		await dee.p.waitForTimeout(2500);
		check("a win handed over by removing the bot is not reported", seen.reports.length === before, seen.reports.slice(before).map((x) => x.sent));

		for (const [name, theme] of [["paper-light", { theme: "paper", mode: "light" }], ["paper-dark", { theme: "paper", mode: "dark" }], ["neon", { theme: "neon", mode: "system" }]]) {
			await dee.p.evaluate((t) => localStorage.setItem("neon.theme", JSON.stringify(t)), theme);
			await dee.p.goto(page("leaderboard.html", "&game=tic-tac-toe-js&vs=bots"));
			await dee.p.locator("[data-board] [data-player]").first().waitFor({ timeout: TIMEOUT });
			const pressed = await dee.p.locator('.strip[data-vs] [aria-pressed="true"]').textContent();
			const row = await dee.p.locator("[data-board] [data-player].me").textContent();
			const strip = await dee.p.locator(".strip[data-vs]").boundingBox();
			check(`${name}: Against bots, under the games, with Dee's win`, pressed === "Against bots" && row.includes("Dee") && row.includes("1") && strip && strip.x >= 0 && strip.x + strip.width <= 390, { pressed, row, strip });
			check(`${name}: the note says it is kept apart, and the page fits the phone`, (await dee.p.locator("[data-note]").textContent()).includes("apart from the ranked boards") && (await noSideScroll(dee.p)));
			if (SHOTS) await dee.p.screenshot({ path: join(SHOTS, `against-bots-${name}.png`) });
		}
		await dee.p.locator('.strip[data-vs] [data-against=""]').click();
		await dee.p.locator('.strip[data-vs] [aria-pressed="true"]', { hasText: "Ranked" }).waitFor({ timeout: TIMEOUT });
		await dee.p.waitForFunction(() => !document.querySelector("[data-board] .ghost"), null, { timeout: TIMEOUT });
		check("Ranked: the same game's ranked board, without the win", (await dee.p.locator("[data-board] [data-player]").count()) === 0 && new URL(dee.p.url()).searchParams.get("vs") === null);
		if (SHOTS) await dee.p.screenshot({ path: join(SHOTS, "ranked-neon.png") });
		await dee.p.evaluate(() => localStorage.removeItem("neon.theme"));
		await dee.ctx.close();
	}

	console.log("\nsocial: groups");
	await ana.p.goto(page("profile.html"));
	await ana.p.locator('input[aria-label="New group name"]').fill("Lunch table");
	await ana.p.locator("button", { hasText: "CREATE" }).click();
	await ana.p.locator("[data-group]").waitFor({ timeout: TIMEOUT });
	const gcode = await ana.p.locator("[data-group] .code").textContent();
	check("a group gets a join code", /^[A-Z2-9]{8}$/.test(gcode), gcode);
	await bo.p.goto(page(`profile.html?join=${gcode}`));
	check("a join link joins it", await bo.p.locator(".neon-toast", { hasText: "Joined" }).waitFor({ timeout: TIMEOUT }).then(() => true, () => false));
	const gid = await ana.p.locator("[data-group]").getAttribute("data-group");
	await ana.p.goto(page("leaderboard.html", `&game=connect4&scope=${encodeURIComponent(`group:${gid}`)}`));
	check("the group has its own tab on the leaderboards", (await ana.p.locator('.scope[aria-pressed="true"]').textContent({ timeout: TIMEOUT })) === "Lunch table");
	await ana.p.locator("[data-board] [data-player]").first().waitFor({ timeout: TIMEOUT }).catch(() => {});
	const groupRows = await ana.p.locator("[data-board] [data-player]").count();
	check("…which counts the game they played together", groupRows === 2, groupRows);

	console.log("\nsocial: feedback");
	await ana.p.goto(page("party.html", "&game=connect4"));
	await ana.p.locator(".top-feedback").click({ timeout: TIMEOUT });
	const fbOpen = await ana.p.locator("dialog.neon-sheet", { hasText: "Feedback: Connect 4" }).waitFor({ timeout: TIMEOUT }).then(() => true, () => false);
	check("💬 opens the game's feedback sheet", fbOpen);
	check("…which, without GitHub connected, offers CONNECT GITHUB instead of a box", (await ana.p.locator("dialog.neon-sheet button", { hasText: "CONNECT GITHUB" }).count()) === 1 && (await ana.p.locator("dialog.neon-sheet textarea").count()) === 0);
	const sheetFits = await ana.p.evaluate(() => {
		const r = document.querySelector("dialog.neon-sheet").getBoundingClientRect();
		return r.left >= 16 && r.right <= innerWidth - 16;
	});
	check("…inside a 16px gutter on the phone", sheetFits);
	await ana.p.keyboard.press("Escape");

	console.log("\nsocial: deleting the account");
	await ana.p.goto(page("profile.html"));
	await ana.p.locator("button", { hasText: "DELETE MY ACCOUNT" }).click();
	await ana.p.locator("dialog.neon-sheet button", { hasText: "DELETE" }).click();
	check("after deleting, the page is signed out", await ana.p.locator("button", { hasText: "SIGN IN WITH GITHUB" }).waitFor({ timeout: TIMEOUT }).then(() => true, () => false));
	check("…the token is gone from the device", (await ana.p.evaluate(() => localStorage.getItem("neon.token"))) === null);
	const gone = await bo.p.evaluate((id) => NeonArcade.account.api(`/api/u/${id}`, { auth: false }).then(() => false, (e) => e.status === 404), anaId);
	check("…and the public profile answers 404", gone);
	const boFriends = await bo.p.evaluate(() => NeonArcade.account.api("/api/friends"));
	check("…and Bo's friends list no longer has Ana", !boFriends.friends.some((f) => f.id === anaId), boFriends);
	check("(Bo is still Bo)", (await bo.p.evaluate(() => NeonArcade.account.me?.id)) === boId);
} catch (err) {
	check(`unexpected: ${err.message.split("\n")[0]}`, false);
	console.log(err.stack);
} finally {
	await browser.close();
	site.stop();
	w.stop();
}
console.log(failures ? `\n${failures} social check(s) failed` : "\nall social checks passed");
process.exit(failures ? 1 : 0);
