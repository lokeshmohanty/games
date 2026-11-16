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

// MATCH_GRACE_MS: a match whose loser left counts after 3 s here (45 s deployed).
const w = await startWrangler({ AUTH_TEST: "1", SESSION_KEY: "social-test-key-0123456789", LB_MIN_GAMES: "1", MATCH_GRACE_MS: "3000" });
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
	const back = page("?page=profile");
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
	await ana.p.goto(page("?party", "&game=connect4"));
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
	await ana.p.goto(page("?party"));
	await ana.p.locator(".party-code-digits").waitFor({ timeout: TIMEOUT });
	const code = (await ana.p.locator(".party-code-digits").textContent()).replace(/\D/g, "");
	await bo.p.goto(page("?party", `#c=${code}`));
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

	console.log("\nsocial: Connect 4 between two signed-in people: played, not ranked");
	// Connect 4 has no online boards since 2026-11-16 ("leaderboard": false).
	// The reload above made a new party; bring Bo into it.
	const code2 = (await ana.p.locator(".party-code-digits").textContent()).replace(/\D/g, "");
	await bo.p.goto(page("?party", `#c=${code2}`));
	await ana.p.waitForFunction(() => document.querySelectorAll(".party-member").length === 2, null, { timeout: TIMEOUT });
	const anaRuns = watchRuns(ana.p);
	const anaStarts = [];
	ana.p.on("request", (r) => r.url().includes("/api/match/start") && anaStarts.push(r.url()));
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
	const c4won = await fa.waitForFunction(() => window.__game.handle.debug().winner === 1, null, { timeout: TIMEOUT }).then(() => true, () => false);
	check("Ana wins four down", c4won);
	await ana.p.locator(".managed-over").waitFor({ timeout: TIMEOUT });
	await ana.p.waitForTimeout(2500);
	check("…nothing is reported, and no match start was sent", anaRuns.reports.length === 0 && anaStarts.length === 0, { reports: anaRuns.reports.map((x) => x.sent), starts: anaStarts });
	check("…the end card has no rating line", await ana.p.locator(".managed-over .managed-rating").isHidden());
	check("…and no toast about it", (await ana.p.locator(".neon-toast", { hasText: /counted|ranked/i }).count()) === 0);
	const local = await ana.p.evaluate(() => JSON.parse(localStorage.getItem("neon.stats")).connect4);
	check("…while this device's own stats still count it", local?.won >= 1 && local.vsPeople >= 1, local);

	console.log("\nsocial: leaving a ranked game is a loss, and the rating on the end card");
	{
		// Neon Fission between Ana and Bo; Bo's page says it is seated (POST
		// /api/match/start), then Bo leaves the party for good.
		const starts = [];
		bo.p.on("request", (r) => r.url().includes("/api/match/start") && starts.push(JSON.parse(r.postData() ?? "{}")));
		await ana.p.evaluate(() => window.__party.room.setGame("neon-fission"));
		const nf = await gameFrame(ana.p, TIMEOUT);
		await gameFrame(bo.p, TIMEOUT);
		await nf.waitForFunction(() => window.__game?.handle?.debug?.()?.phase === "play", null, { timeout: TIMEOUT });
		// Every state the end card's rating line takes, on the node first drawn:
		// the answer lands after the card (the grace), and must fill it in place.
		await ana.p.evaluate(() => {
			window.__rating = { el: null, seen: [], toasts: [] };
			new MutationObserver(() => {
				for (const t of document.querySelectorAll(".neon-toast")) if (!window.__rating.toasts.includes(t.textContent)) window.__rating.toasts.push(t.textContent);
				const el = document.querySelector(".managed-over .managed-rating");
				if (!el) return;
				window.__rating.el ??= el;
				const t = el.hidden ? "(hidden)" : el.textContent;
				if (window.__rating.seen.at(-1) !== t) window.__rating.seen.push(t);
			}).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
		});
		for (const end = Date.now() + TIMEOUT; Date.now() < end && !starts.length; ) await bo.p.waitForTimeout(200);
		check("a guest's page says it is seated as the match begins", starts[0]?.game === "neon-fission" && Number.isInteger(starts[0].match), starts);
		const before = anaRuns.reports.length;
		await bo.p.evaluate(async () => {
			window.__party.room.leave();
			await NeonArcade.roomSettled?.();
		});
		await bo.p.goto(page("?page=profile"));
		const won = await nf.waitForFunction(() => window.__game.handle.debug().winner !== null, null, { timeout: TIMEOUT }).then(() => true, () => false);
		check("Bo leaves: the game is Ana's", won);
		const rep = await (async () => {
			for (const end = Date.now() + TIMEOUT; Date.now() < end; await ana.p.waitForTimeout(250)) {
				const last = anaRuns.reports.at(-1);
				if (anaRuns.reports.length > before && last?.got?.counted) return last;
			}
			return anaRuns.reports.at(-1);
		})();
		check("…Ana's report names Bo as having left, from a match that began with two seats", rep?.sent.left?.length === 1 && rep.sent.seats === 2 && Object.values(rep.sent.roster).includes(boId), rep?.sent);
		check("…it waits out the grace, then counts", anaRuns.reports[before]?.got?.pending === true && rep?.got?.counted === true, anaRuns.reports.slice(before).map((x) => x.got));
		const counted = await ana.p
			.waitForFunction(() => window.__rating.toasts.some((t) => /^Counted: [+−]\d+ → \d+/.test(t)), null, { timeout: TIMEOUT })
			.then(() => true, () => false);
		check("…the toast says by how much", counted, await ana.p.evaluate(() => window.__rating.toasts));
		const line = ana.p.locator(".managed-over .managed-rating");
		const shown = await line.filter({ hasText: /Rating \+\d+ → \d+ · provisional/ }).waitFor({ timeout: TIMEOUT }).then(() => true, () => false);
		check("the end card says the rating change: \"Rating +24 → 1224 · provisional\"", shown, await line.textContent().catch(() => null));
		const inPlace = await ana.p.evaluate(() => ({ same: document.querySelector(".managed-over .managed-rating") === window.__rating.el, seen: window.__rating.seen }));
		check("…filled in place on the card already drawn (it said it was waiting first)", inPlace.same && inPlace.seen.some((t) => /waiting/.test(t)), inPlace);
		const fits = await line.evaluate((el) => {
			const r = el.getBoundingClientRect();
			return r.width > 0 && r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
		});
		check("…inside the phone's screen (390x844), no side scroll", fits && (await noSideScroll(ana.p)));
		const fr = await ana.p.evaluate(() => NeonArcade.account.leaderboard("neon-fission", "friends"));
		const boRow = fr.rows.find((r) => r.id === boId);
		check("…a loss for Bo; Ana first on the friends' board", boRow?.games === 1 && boRow.wins === 0 && fr.rows[0]?.name === "Ana Lima" && fr.rows[0].elo > 1200, fr.rows);
	}

	console.log("\nsocial: the leaderboards page");
	await ana.p.goto(page("?page=leaderboard", "&game=neon-fission&scope=global"));
	await ana.p.locator("[data-board] [data-player]").first().waitFor({ timeout: TIMEOUT });
	check("the global board lists the ranked players", (await ana.p.locator("[data-board] [data-player]").count()) === 2);
	check("…you highlighted", (await ana.p.locator("[data-board] [data-player].me").textContent()).includes("Ana Lima"));
	check("…a Friends tab", (await ana.p.locator(".scope", { hasText: "Friends" }).count()) === 1);
	check("…and it fits the phone", await noSideScroll(ana.p));
	const picks = await ana.p.locator("[data-game]").evaluateAll((els) => els.map((e) => e.dataset.game));
	check("the strip lists no game without a board (Connect 4, Tic Tac Toe, Undercover)", picks.length > 0 && !picks.some((g) => ["connect4", "tic-tac-toe-js", "undercover"].includes(g)), picks);
	await ana.p.goto(page("?page=leaderboard", "&game=connect4"));
	await ana.p.locator('[data-game][aria-pressed="true"]').waitFor({ timeout: TIMEOUT });
	const fell = await ana.p.locator('[data-game][aria-pressed="true"]').getAttribute("data-game");
	check("…an old ?game=connect4 link falls back to a game with a board", !!fell && fell !== "connect4" && !(await ana.p.locator("[data-board]").textContent()).includes("Could not load"), fell);

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
		await cy.p.goto(page("?party", "&game=neon-survival-mp&fresh=1&mode=bots"));
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

	console.log("\nsocial: an abandoned solo run never files a later match as solo");
	{
		// A solo run left over (Light Cycles alone, abandoned), then a match
		// that began with two seats whose other player left: its result holds
		// one id. It must go as a match with a departure, never as solo.
		const sam = await device("Sam");
		const seen = watchRuns(sam.p);
		const sent = await sam.p.evaluate(async () => {
			const A = NeonArcade.account;
			const game = "lokeshmohanty/light-cycles";
			const ticket = await A.startRun(game);
			const members = new Map([
				["sa", { id: "sa", name: "Sam", acct: { id: A.me.id } }],
				["sb", { id: "sb", name: "Other", acct: { id: "someone-else" } }],
			]);
			const room = { selfId: "sa", isHost: () => false, getRun: () => "party-run-sam", getMember: (id) => members.get(id) ?? null, getMembers: () => [...members.values()] };
			A.matchStart(game, { room, seats: ["sa", "sb"], kind: "ffa" });
			members.delete("sb"); // the other rider left the party
			NeonArcade.onResult({ game, run: "party-run-sam", result: { kind: "ffa", match: 1, ranking: [["sa"]], scores: { sa: 9 } }, room });
			return ticket?.run ?? null;
		});
		for (const end = Date.now() + TIMEOUT; Date.now() < end && !seen.reports.length; ) await sam.p.waitForTimeout(200);
		const rep = seen.reports[0]?.sent;
		check("(the abandoned solo run was issued)", typeof sent === "string", sent);
		check("the report names the party's run, not the stale solo one", rep?.run === "party-run-sam" && rep.run !== sent, rep);
		check("…says the match began with two seats, and who left", rep?.seats === 2 && JSON.stringify(rep.left) === '["sb"]', rep);
		check("…and the server does not count it as a run played alone", seen.reports[0]?.got?.counted !== true, seen.reports[0]?.got);
		await sam.ctx.close();
	}

	console.log("\nsocial: a Light Cycles round alone, its time on the solo board");
	{
		// The pinned Light Cycles may predate its solo score (web-games
		// 4cc6e1a): a build from that branch (NEON_PIN_OVERRIDE, docs/accounts.md
		// "Testing") has it.
		const rules = await fetch(`${site.base}/community/lokeshmohanty/web-games/light-cycles/light-cycles-rules.js`).then((r) => (r.ok ? r.text() : ""));
		if (!rules.includes("survived")) {
			// The pinned version: its rounds carry nothing to rank by. The page
			// must not send them, nor warn after every round, nor keep asking
			// for runs (review, 2026-11-15).
			console.log("  (the served Light Cycles predates its solo score: checking the page leaves it alone)");
			const ivy = await device("Ivy");
			const seen = watchRuns(ivy.p);
			const warned = [];
			ivy.p.on("console", (m) => /no score to rank alone/.test(m.text()) && warned.push(m.text()));
			await ivy.p.goto(page("?party", `&game=${encodeURIComponent("lokeshmohanty/light-cycles")}&fresh=1&mode=bots`));
			await gameFrame(ivy.p, TIMEOUT);
			const card = ivy.p.locator(".managed-actions");
			await card.waitFor({ timeout: 60_000 }); // nobody steers: into the far wall
			await ivy.p.waitForTimeout(1500);
			const toasts = () => ivy.p.locator(".neon-toast", { hasText: "Not ranked" }).count();
			check("a round with no score is not reported, and raises no warning", seen.reports.length === 0 && (await toasts()) === 0, seen.reports.map((x) => x.got));
			check("…logged once instead", warned.length === 1, warned);
			await ivy.p.locator(".managed-actions button", { hasText: "PLAY AGAIN" }).click();
			await card.waitFor({ state: "detached", timeout: TIMEOUT });
			await card.waitFor({ timeout: 60_000 });
			await ivy.p.waitForTimeout(1500);
			const solo = seen.starts.filter((x) => !x.sent.vs).length;
			check("…and the next round asks for no run (one run spent this session)", solo === 1 && seen.reports.length === 0 && (await toasts()) === 0 && warned.length === 1, { solo, reports: seen.reports.length });
			await ivy.ctx.close();
		} else {
			const eli = await device("Eli");
			const seen = watchRuns(eli.p);
			await eli.p.goto(page("?party", `&game=${encodeURIComponent("lokeshmohanty/light-cycles")}&fresh=1&mode=bots`));
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
			await eli.p.goto(page("?page=leaderboard", `&game=${encodeURIComponent("lokeshmohanty/light-cycles")}&level=alone`));
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
		const until = async (fn, ms) => {
			for (const end = Date.now() + ms; Date.now() < end && !fn(); ) await dee.p.waitForTimeout(100);
			return fn();
		};
		// Tic Tac Toe has no boards now ("leaderboard": false): played against
		// the bot, no run is asked for and nothing is sent.
		await dee.p.goto(page("?party", "&game=tic-tac-toe-js&fresh=1&mode=bots"));
		await gameFrame(dee.p, TIMEOUT);
		await dee.p.waitForTimeout(2500);
		check("Tic Tac Toe against the bot: no run asked for, nothing sent", seen.starts.length === 0 && seen.reports.length === 0, seen);

		// Neon Fission against a bot: the run is asked for as the match begins;
		// removing the bot hands Dee the match, which is not reported.
		await dee.p.goto(page("?party", "&game=neon-fission&fresh=1&mode=bots"));
		const nfb = await gameFrame(dee.p, TIMEOUT);
		await until(() => seen.starts.some((x) => x.sent.game === "neon-fission" && x.sent.vs === "bots"), TIMEOUT);
		const start = seen.starts.find((x) => x.sent.vs === "bots");
		check("one person and a bot: a run against bots is asked for as the match begins", start?.sent.game === "neon-fission" && typeof start.got?.run === "string", seen.starts);
		await nfb.waitForFunction(() => window.__game?.handle?.debug?.()?.phase, null, { timeout: TIMEOUT }).catch(() => {});
		await dee.p.waitForTimeout(BOTS["neon-fission"].minMs + 500);
		await dee.p.evaluate(() => {
			const r = window.__party.room;
			r.removeMember(r.getMembers().find((m) => NeonArcade.isBotId(m.id)).id);
		});
		await dee.p.locator(".managed-actions").waitFor({ timeout: TIMEOUT }).catch(() => {});
		await dee.p.waitForTimeout(2500);
		check("a win handed over by removing the bot is not reported", seen.reports.length === 0, seen.reports.map((x) => x.sent));

		// A win, through the account layer and the real server: a run against
		// bots, aged past the game's minimum, and a result Dee won alone.
		const sent = await dee.p.evaluate(async ({ rs }) => {
			const A = NeonArcade.account;
			const game = "neon-fission";
			const members = new Map([
				["sd", { id: "sd", name: "Dee", acct: { id: A.me.id } }],
				["bot_x", { id: "bot_x", name: "Bot" }],
			]);
			const room = { selfId: "sd", isHost: () => true, getRun: () => "party-run-dee", getMember: (id) => members.get(id) ?? null, getMembers: () => [...members.values()] };
			A.matchStart(game, { room, seats: ["sd", "bot_x"], kind: "ffa", match: 0 });
			const t = await A.startRun(game, { vs: "bots", bots: ["bot_x"] });
			await fetch(`${rs}/api/admin/age-run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ run: t.run, ms: 5000 }) });
			NeonArcade.onResult({ game, run: "party-run-dee", result: { kind: "ffa", match: 0, ranking: [["sd"], ["bot_x"]] }, room });
			return t.run;
		}, { rs: w.base });
		await until(() => seen.reports.length, TIMEOUT);
		const [rep] = seen.reports;
		check("…a win's report names its run", rep?.sent.run === sent && rep.sent.ranking.flat().some((id) => id.startsWith("bot_")), rep?.sent);
		check("…and counts, on the board against bots", rep?.got?.counted === true && rep.got.board === "bots" && rep.got.wins === 1, rep?.got);
		check("…and says so", await dee.p.locator(".neon-toast", { hasText: "1 win against bots" }).waitFor({ timeout: TIMEOUT }).then(() => true, () => false));
		await dee.p.goto(page("?page=profile"));
		const line = await dee.p.locator(".bot-wins").textContent({ timeout: TIMEOUT }).catch(() => null);
		check("the profile says it, under the ratings and apart from them", line === "Wins against bots: Neon Fission 1", line);
		const ranked = await dee.p.evaluate(() => NeonArcade.account.leaderboard("neon-fission"));
		check("the ranked board does not have it", !ranked.rows.some((r) => r.id === deeId) && ranked.botsBoard === true, ranked);
		const gone = await dee.p.evaluate(() => NeonArcade.account.leaderboard("tic-tac-toe-js", "global", "bots").then(() => 200, (e) => e.status));
		check("Tic Tac Toe's board against bots is gone (404)", gone === 404, gone);

		for (const [name, theme] of [["paper-light", { theme: "paper", mode: "light" }], ["paper-dark", { theme: "paper", mode: "dark" }], ["neon", { theme: "neon", mode: "system" }]]) {
			await dee.p.evaluate((t) => localStorage.setItem("neon.theme", JSON.stringify(t)), theme);
			await dee.p.goto(page("?page=leaderboard", "&game=neon-fission&vs=bots"));
			await dee.p.locator("[data-board] [data-player]").first().waitFor({ timeout: TIMEOUT });
			const pressed = await dee.p.locator('.strip[data-vs] [aria-pressed="true"]').textContent();
			const row = await dee.p.locator("[data-board] [data-player].me").textContent();
			const strip = await dee.p.locator(".strip[data-vs]").boundingBox();
			check(`${name}: Against bots, under the games, with Dee's win`, pressed === "Against bots" && row.includes("Dee") && row.includes("1") && strip && strip.x >= 0 && strip.x + strip.width <= 390, { pressed, row, strip });
			check(`${name}: the note says it is kept apart, and the page fits the phone`, (await dee.p.locator("[data-note]").textContent()).includes("apart from the ranked boards") && (await noSideScroll(dee.p)));
			if (SHOTS) await dee.p.screenshot({ path: join(SHOTS, `against-bots-${name}.png`) });
		}
		const chip = await dee.p.locator('.pick[aria-pressed="true"] small').textContent();
		check("the game's chip says what the board showing ranks by", chip === "Wins vs bots", chip);
		await dee.p.goto(page("?page=leaderboard", "&game=lokeshmohanty/battleship&vs=bots"));
		const empty = dee.p.locator("[data-board] .empty a");
		await empty.waitFor({ timeout: TIMEOUT });
		const href = await empty.getAttribute("href");
		check("an empty board against bots offers SINGLE PLAYER, to the shell's own address", href?.startsWith("./?") && new URLSearchParams(href.slice(3)).get("mode") === "bots" && new URLSearchParams(href.slice(3)).get("game") === "lokeshmohanty/battleship", href);
		await dee.p.goto(page("?page=leaderboard", "&game=neon-survival-mp&vs=bots"));
		await dee.p.waitForFunction(() => new URL(location.href).searchParams.get("vs") === null && !document.querySelector("[data-board] .ghost"), null, { timeout: TIMEOUT });
		check("a ?vs=bots link for a game without that board shows its ranked board", !(await dee.p.locator("[data-board]").textContent()).includes("Could not load") && (await dee.p.locator(".strip[data-vs]").isHidden()));
		await dee.p.goto(page("?page=leaderboard", "&game=neon-fission&vs=bots"));
		await dee.p.locator("[data-board] [data-player]").first().waitFor({ timeout: TIMEOUT });
		await dee.p.locator('.strip[data-vs] [data-against=""]').click();
		await dee.p.locator('.strip[data-vs] [aria-pressed="true"]', { hasText: "Ranked" }).waitFor({ timeout: TIMEOUT });
		await dee.p.waitForFunction(() => !document.querySelector("[data-board] .ghost"), null, { timeout: TIMEOUT });
		check("Ranked: the same game's ranked board, without the win", (await dee.p.locator("[data-board] [data-player].me").count()) === 0 && new URL(dee.p.url()).searchParams.get("vs") === null);
		if (SHOTS) await dee.p.screenshot({ path: join(SHOTS, "ranked-neon.png") });
		await dee.p.evaluate(() => localStorage.removeItem("neon.theme"));
		await dee.ctx.close();
		// Signed out, the bar under this board gives its own advice.
		const anon = await browser.newContext(phone);
		const ap = await anon.newPage();
		await ap.goto(page("?page=leaderboard", "&game=neon-fission&vs=bots"));
		const bar = await ap.locator("[data-you] .sub").textContent({ timeout: TIMEOUT }).catch(() => null);
		check("signed out, the bots board says to sign in and beat the bots, not to play people", /beat the bots/.test(bar ?? "") && !/play people/.test(bar ?? ""), bar);
		await anon.close();
	}

	console.log("\nsocial: groups");
	await ana.p.goto(page("?page=profile"));
	await ana.p.locator('input[aria-label="New group name"]').fill("Lunch table");
	await ana.p.locator("button", { hasText: "CREATE" }).click();
	await ana.p.locator("[data-group]").waitFor({ timeout: TIMEOUT });
	const gcode = await ana.p.locator("[data-group] .code").textContent();
	check("a group gets a join code", /^[A-Z2-9]{8}$/.test(gcode), gcode);
	await bo.p.goto(page(`?page=profile&join=${gcode}`));
	check("a join link joins it", await bo.p.locator(".neon-toast", { hasText: "Joined" }).waitFor({ timeout: TIMEOUT }).then(() => true, () => false));
	const gid = await ana.p.locator("[data-group]").getAttribute("data-group");
	await ana.p.goto(page("?page=leaderboard", `&game=neon-fission&scope=${encodeURIComponent(`group:${gid}`)}`));
	check("the group has its own tab on the leaderboards", (await ana.p.locator('[data-scopes] .scope[aria-pressed="true"]').textContent({ timeout: TIMEOUT })) === "Lunch table");
	await ana.p.locator("[data-board] [data-player]").first().waitFor({ timeout: TIMEOUT }).catch(() => {});
	const groupRows = await ana.p.locator("[data-board] [data-player]").count();
	check("…which counts the game they played together", groupRows === 2, groupRows);

	console.log("\nsocial: feedback");
	await ana.p.goto(page("?party", "&game=connect4"));
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
	await ana.p.goto(page("?page=profile"));
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
