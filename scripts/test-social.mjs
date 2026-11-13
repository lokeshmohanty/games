// scripts/test-social.mjs — the account layer in real browsers, at 390x844,
// against the real Worker (wrangler dev, local D1) and the real site:
// signing in, the profile, favourites on two devices, ADD FRIEND in a party,
// a pushed invite, a ranked Connect 4 game between two signed-in people, the
// leaderboards, groups, the feedback sheet, and deleting the account.
//
// Needs wrangler (scripts/wrangler.mjs); skips with a message without it.

import { existsSync, globSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
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
	check("…and a friend code with a QR is shown", (await ana.p.locator("canvas.qr").count()) === 1 && (await ana.p.locator(".code").first().textContent()).includes(`?u=${anaId}`));

	console.log("\nsocial: the portal and favourites on two devices");
	await ana.p.goto(page("index.html"));
	check("the portal names you", (await ana.p.locator(".acct-bar .acct-me").textContent({ timeout: TIMEOUT })).includes("Ana Lima"));
	check("…and still fits the phone", await noSideScroll(ana.p));
	await ana.p.locator('.game-card[data-game="connect4"] .fav').click();
	await ana.p.waitForTimeout(1200); // the push is debounced
	const tablet = await device("Ana", "Ana"); // the same account elsewhere
	await tablet.p.goto(page("index.html"));
	const starred = await tablet.p
		.locator('.game-card[data-game="connect4"] .fav[aria-pressed="true"]')
		.waitFor({ timeout: TIMEOUT })
		.then(() => true, () => false);
	check("a star on one device is a favourite on the other", starred);
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
	await boPortal.locator(".acct-bar .acct-me").waitFor({ timeout: TIMEOUT });
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
	await ana.p.locator("tbody tr").first().waitFor({ timeout: TIMEOUT });
	check("the global board lists the ranked players", (await ana.p.locator("tbody tr").count()) === 2);
	check("…you highlighted", (await ana.p.locator("tr.me").textContent()).includes("Ana Lima"));
	check("…a Friends tab", (await ana.p.locator(".scope", { hasText: "Friends" }).count()) === 1);
	check("…and it fits the phone", await noSideScroll(ana.p));

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
	await ana.p.locator("tbody tr").first().waitFor({ timeout: TIMEOUT }).catch(() => {});
	const groupRows = await ana.p.locator("tbody tr").count();
	check("…which counts the game they played together", groupRows === 2, groupRows);

	console.log("\nsocial: feedback");
	await ana.p.goto(page("index.html"));
	await ana.p.locator('.game-card[data-game="connect4"] .fb').click();
	const fbOpen = await ana.p.locator("dialog.neon-sheet", { hasText: "Feedback: Connect 4" }).waitFor({ timeout: TIMEOUT }).then(() => true, () => false);
	check("💬 opens the game's feedback sheet", fbOpen);
	check("…with a box to post, since you are signed in", (await ana.p.locator("dialog.neon-sheet textarea").count()) === 1);
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
