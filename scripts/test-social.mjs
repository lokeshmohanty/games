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
	const anaCode = await ana.p.evaluate(() => NeonArcade.account.me.friendCode);
	check("…and a short friend code, its link and a QR are shown", /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(await ana.p.locator(".friend-code").textContent()) && (await ana.p.locator("p.code.link").textContent()).includes(`?page=profile&u=${anaCode}`) && !(await ana.p.locator("p.code.link").textContent()).includes(anaId));
	const qr = await ana.p.evaluate(() => {
		const q = document.querySelector("[data-profile] .qr");
		const r = q?.getBoundingClientRect();
		return { tag: q?.tagName.toLowerCase(), crisp: q?.getAttribute("shape-rendering"), css: r?.width, canvases: document.querySelectorAll("[data-profile] canvas").length };
	});
	check("the QR is drawn as SVG with crisp edges, sharp at any density (no stretched canvas)", qr.tag === "svg" && qr.crisp === "crispEdges" && qr.css >= 132 && qr.canvases === 0, qr);

	console.log("\nsocial: the portal and favourites on two devices");
	await ana.p.goto(page("index.html"));
	check("the portal names you", (await ana.p.locator(".site-menu .acct-me").textContent({ timeout: TIMEOUT })).includes("Ana Lima"));
	check("…and still fits the phone", await noSideScroll(ana.p));
	// Starred and given feedback only from inside a game (Lokesh: "Only
	// inside games", 2026-11-14 and 2026-11-16). A card has no button at all,
	// so any star or feedback control would be one; nor a ☆ or ★ in its text.
	const cardControls = await ana.p.evaluate(() => ({
		cards: document.querySelectorAll(".game-card").length,
		controls: document.querySelectorAll(".game-card :is(button, [aria-pressed], .fav, .fb, .card-fav, .top-fav)").length,
		stars: [...document.querySelectorAll(".game-card")].filter((c) => /[☆★]/.test(c.textContent)).length,
	}));
	check("…with no star or feedback on the cards", cardControls.cards > 0 && cardControls.controls === 0 && cardControls.stars === 0, cardControls);
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
	await tablet.p.goto(page("index.html?page=games&tab=mine"));
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
	const notice = bo.p.locator(".neon-request", { hasText: "wants to be friends" });
	const told = await notice.waitFor({ timeout: TIMEOUT }).then(() => true, () => false);
	check("the other player is told at once (live socket), with ACCEPT and DECLINE right there", told && (await notice.locator("button").allTextContents()).join() === "ACCEPT,DECLINE");
	await notice.locator("button", { hasText: "ACCEPT" }).click();
	check("accepting from the notice: the party's button says so", await bo.p.locator(".party-member button", { hasText: "FRIENDS ✓" }).waitFor({ timeout: TIMEOUT }).then(() => true, () => false));

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
	check("…which says Invited, whether or not a page of theirs is open (nothing leaked)", await ana.p.locator(".neon-toast", { hasText: "Invited Bo." }).waitFor({ timeout: TIMEOUT }).then(() => true, () => false));
	const banner = boPortal.locator(".neon-invite", { hasText: "invited you to a party" });
	check("the invite reaches the friend's other page", await banner.waitFor({ timeout: TIMEOUT }).then(() => true, () => false));
	check("…with a JOIN for this party's code", ((await banner.locator("a", { hasText: "JOIN" }).getAttribute("href")) ?? "").endsWith(`#c=${(await ana.p.locator(".party-code-digits").textContent()).replace(/\D/g, "")}`));
	// Unanswered, it would wait on the server for Bo's next page; NOT NOW forgets it.
	await banner.locator("button", { hasText: "NOT NOW" }).click();
	await boPortal.waitForTimeout(500);
	check("NOT NOW forgets the invite on the server too", (await boPortal.evaluate(() => NeonArcade.account.api("/api/invites"))).invites.length === 0);
	await boPortal.close();

	console.log("\nsocial: a ranked game between two signed-in people");
	// The reload above made a new party; bring Bo into it.
	const code2 = (await ana.p.locator(".party-code-digits").textContent()).replace(/\D/g, "");
	await bo.p.goto(page("?party", `#c=${code2}`));
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
	await ana.p.goto(page("?page=leaderboard", "&game=connect4&scope=global"));
	await ana.p.locator("[data-board] [data-player]").first().waitFor({ timeout: TIMEOUT });
	check("the global board lists the ranked players", (await ana.p.locator("[data-board] [data-player]").count()) === 2);
	check("…you highlighted", (await ana.p.locator("[data-board] [data-player].me").textContent()).includes("Ana Lima"));
	check("…a Friends tab", (await ana.p.locator(".scope", { hasText: "Friends" }).count()) === 1);
	check("…and it fits the phone", await noSideScroll(ana.p));

	console.log("\nsocial: any member invites, the end card, requests up front");
	{
		const OUT = process.env.NEON_SHOTS ?? SHOTS;
		// Kit comes in by a classic invite (ADD PLAYER: no party code on Kit's
		// side), and is Bo's friend.
		const kit = await device("Kit");
		const kitId = await kit.p.evaluate(() => NeonArcade.account.me.id);
		await kit.p.evaluate((rs) => localStorage.setItem("neon.rs", rs), w.base);
		await kit.p.evaluate((id) => NeonArcade.account.api(`/api/friends/${id}`, { method: "POST" }), boId);
		await bo.p.evaluate((id) => NeonArcade.account.api(`/api/friends/${id}`, { method: "POST" }), kitId);
		await ana.p.evaluate(() => localStorage.removeItem("neon.room"));
		await ana.p.goto(page("?party"));
		await ana.p.locator(".party-code-digits").waitFor({ timeout: TIMEOUT });
		const partyCode = (await ana.p.locator(".party-code-digits").textContent()).replace(/\D/g, "");
		await ana.p.locator("button", { hasText: "ADD PLAYER" }).first().click();
		const inviteBox = ana.p.locator("textarea.share-code").first();
		await inviteBox.waitFor({ timeout: TIMEOUT });
		const link = await inviteBox.inputValue();
		await kit.p.goto(link);
		const replyBox = kit.p.locator("textarea.share-code").first();
		await replyBox.waitFor({ timeout: TIMEOUT });
		await ana.p.locator("textarea.share-code").last().fill(await replyBox.inputValue());
		await ana.p.locator("button.neon-btn", { hasText: /^CONNECT$/ }).first().click();
		await kit.p.locator(".party-member").first().waitFor({ timeout: TIMEOUT });
		check("(Kit joined by a classic invite: no party code on Kit's screen)", (await kit.p.locator(".party-code-digits").count()) === 0);
		const boPortal = await bo.ctx.newPage();
		await boPortal.goto(page("index.html"));
		await boPortal.locator(".site-menu .acct-me").waitFor({ state: "attached", timeout: TIMEOUT });
		await kit.p.evaluate(() => NeonArcade.accountUi.loadFriends(true));
		const kitInvite = kit.p.locator(`.party-friend[data-friend="${boId}"] button`);
		await kitInvite.waitFor({ timeout: TIMEOUT });
		check("a member who is not the host, and never saw the code, can INVITE", !(await kitInvite.isDisabled()));
		await kitInvite.click();
		const kitBanner = boPortal.locator(".neon-invite", { hasText: "Kit invited you to a party" });
		check("…and the friend gets JOIN for the host's party code", (await kitBanner.waitFor({ timeout: TIMEOUT }).then(() => true, () => false)) && ((await kitBanner.locator("a").getAttribute("href")) ?? "").endsWith(`#c=${partyCode}`));
		// Two friend requests arrive as well (names too long for the line).
		await boPortal.evaluate(() => {
			NeonArcade.accountUi.requestNotice({ id: "fake-req-1", name: "Wolfeschlegelsteinhausen" });
			NeonArcade.accountUi.requestNotice({ id: "fake-req-2", name: "Bartholomew Longname Jr" });
		});
		const stack = await boPortal.evaluate(() => {
			const boxes = [...document.querySelectorAll(".neon-notices > .neon-invite")].map((b) => b.getBoundingClientRect());
			const name = document.querySelector('.neon-request[data-request="fake-req-1"] .neon-invite-name');
			const cs = name ? getComputedStyle(name) : {};
			return {
				n: boxes.length,
				apart: boxes.every((b, i) => i === 0 || b.top >= boxes[i - 1].bottom - 0.5),
				inside: boxes.every((b) => b.left >= 0 && b.right <= innerWidth && b.top >= 0 && b.bottom <= innerHeight),
				oneLine: cs.whiteSpace === "nowrap" && cs.textOverflow === "ellipsis",
			};
		});
		check("an invite and two friend requests stack, none on top of another, all on the screen", stack.n === 3 && stack.apart && stack.inside, stack);
		check("…a long name ends in an ellipsis, never broken mid-word", stack.oneLine, stack);
		if (OUT) await boPortal.screenshot({ path: join(OUT, "notices-stacked-390x844.png") });
		await boPortal.close();

		// The friends list is fetched once, not on every redraw (audit D15).
		const fetches = [];
		const onReq = (r) => r.url().endsWith("/api/friends") && fetches.push(r.url());
		ana.p.on("request", onReq);
		for (let i = 0; i < 4; i++) await ana.p.evaluate((n) => window.__party.room.setMeta({ tick: n }), i);
		await ana.p.waitForTimeout(800);
		ana.p.off("request", onReq);
		check("roster changes redraw the party screen without fetching the friends list again", fetches.length === 0, fetches.length);

		// A ranked Connect 4 between Ana and Kit, who are not friends.
		await ana.p.evaluate((kid) => {
			const r = window.__party.room;
			const k = r.getMembers().find((m) => m.acct?.id === kid);
			r.setTeam(r.selfId, "A");
			r.setTeam(k.id, "B");
			r.setGame("connect4");
		}, kitId);
		const [fa, fk] = [await gameFrame(ana.p, TIMEOUT), await gameFrame(kit.p, TIMEOUT)];
		await fa.waitForFunction(() => window.__game.handle.debug().started, null, { timeout: TIMEOUT });
		for (let i = 0; i < 4; i++) {
			await drop(ana.p, fa, 0);
			await fa.waitForFunction((n) => window.__game.handle.debug().board.flat().filter(Boolean).length >= n, 2 * i + 1, { timeout: TIMEOUT });
			if (i < 3) {
				await kit.p.waitForTimeout(150);
				await drop(kit.p, fk, 1);
				await fa.waitForFunction((n) => window.__game.handle.debug().board.flat().filter(Boolean).length >= n, 2 * i + 2, { timeout: TIMEOUT });
			}
		}
		const kitCard = kit.p.locator(".managed-over .just-played");
		check("the end card offers the players you just played", await kitCard.waitFor({ timeout: TIMEOUT }).then(() => true, () => false));
		const addAna = kitCard.locator(`[data-add-friend="${anaId}"]`);
		check("…with ADD FRIEND on someone who is not a friend", (await addAna.textContent()) === "ADD FRIEND");
		check("…and leaves you out", (await kitCard.locator("[data-add-friend]").count()) === 1);
		await addAna.click();
		await kitCard.locator(`[data-add-friend="${anaId}"]`, { hasText: "ASKED" }).waitFor({ timeout: TIMEOUT });
		check("…which asks", true);
		check("the asked one sees the request at once, even mid-game", await ana.p.locator(".neon-request", { hasText: "Kit wants to be friends" }).waitFor({ timeout: TIMEOUT }).then(() => true, () => false));
		await ana.p.locator(".neon-toast", { hasText: "Counted on the leaderboard" }).waitFor({ timeout: TIMEOUT }).catch(() => {});

		// The badge: on ☰ and on your entry in it.
		await ana.p.evaluate(() => localStorage.removeItem("neon.room"));
		await ana.p.goto(page("index.html"));
		const badge = ana.p.locator(".site-menu-btn .site-badge");
		check("a waiting request shows as a count on ☰", (await badge.textContent({ timeout: TIMEOUT }).catch(() => null)) === "1");
		await ana.p.locator(".site-menu-btn").click();
		check("…and on your entry in the menu", (await ana.p.locator(".site-menu-item.acct-me .site-badge").textContent({ timeout: TIMEOUT }).catch(() => null)) === "1");

		// The profile: requests and friends at the top, at both phone sizes, in every theme.
		const themes = [["paper-light", { theme: "paper", mode: "light" }], ["paper-dark", { theme: "paper", mode: "dark" }], ["neon", { theme: "neon", mode: "system" }]];
		for (const [vw, vh] of [[390, 844], [354, 696]]) {
			await ana.p.setViewportSize({ width: vw, height: vh });
			for (const [name, theme] of themes) {
				await ana.p.evaluate((t) => localStorage.setItem("neon.theme", JSON.stringify(t)), theme);
				await ana.p.goto(page("?page=profile"));
				const req = ana.p.locator(`[data-section="friends"] [data-incoming="${kitId}"]`);
				await req.waitFor({ timeout: TIMEOUT });
				await ana.p.locator(`[data-section="recent"] [data-recent="${kitId}"]`).waitFor({ timeout: TIMEOUT }).catch(() => {});
				const where = await ana.p.evaluate(() => {
					const s = document.querySelector('[data-section="friends"]').getBoundingClientRect();
					const r = document.querySelector("[data-incoming]").getBoundingClientRect();
					const btns = [...document.querySelectorAll("[data-incoming] button")].map((b) => b.getBoundingClientRect());
					const nmEl = document.querySelector("[data-incoming] .nm");
					const nm = nmEl ? getComputedStyle(nmEl) : {};
					return { friendsTop: s.top, requestBottom: r.bottom, inside: btns.every((b) => b.left >= 0 && b.right <= innerWidth), h: innerHeight, sideScroll: document.documentElement.scrollWidth > innerWidth, ellipsis: nm.textOverflow === "ellipsis" && nm.whiteSpace === "nowrap" };
				});
				check(`${vw}x${vh} ${name}: the friend request, with its buttons, is on the first screen and the page fits`, where.requestBottom <= where.h && where.inside && !where.sideScroll && where.ellipsis, where);
				if (OUT) await ana.p.screenshot({ path: join(OUT, `profile-${vw}x${vh}-${name}.png`) });
			}
		}
		await ana.p.evaluate(() => localStorage.removeItem("neon.theme"));
		await ana.p.setViewportSize(phone.viewport);
		await ana.p.goto(page("?page=profile"));
		check("players you just played are on the profile too", await ana.p.locator(`[data-section="recent"] [data-recent="${kitId}"]`).waitFor({ timeout: TIMEOUT }).then(() => true, () => false));
		await ana.p.locator(`[data-incoming="${kitId}"] button`, { hasText: "ACCEPT" }).click();
		await ana.p.locator(`[data-section="friends"] [data-friend="${kitId}"]`).waitFor({ timeout: TIMEOUT });
		check("ACCEPT on the profile: a friend, and the count is gone", (await ana.p.locator(".site-menu-btn .site-badge").count()) === 0);

		const ell = await ana.p.evaluate(() => {
			const cs = getComputedStyle(document.querySelector("[data-friend] .grow, [data-section=friends] .item .grow.line") ?? document.body);
			return cs.textOverflow === "ellipsis" && cs.whiteSpace === "nowrap";
		});
		check("friend rows cut a long name with an ellipsis", ell);

		// The party screen lists every friend, online first: Kit is not on,
		// and Bo appears offline — the two must look the same.
		await kit.ctx.close();
		await bo.p.evaluate(() => NeonArcade.account.api("/api/me", { method: "PATCH", body: { appearOffline: true } }));
		await ana.p.evaluate(() => localStorage.removeItem("neon.room"));
		await ana.p.goto(page("?party"));
		await ana.p.locator(".party-code-digits").waitFor({ timeout: TIMEOUT });
		const code3 = (await ana.p.locator(".party-code-digits").textContent()).replace(/\D/g, "");
		await ana.p.evaluate(() => NeonArcade.accountUi.loadFriends(true));
		const kitRow = ana.p.locator(`.party-friend[data-friend="${kitId}"]`);
		await kitRow.waitFor({ timeout: TIMEOUT });
		const rows = await ana.p.evaluate(([k, b]) => {
			const look = (id) => {
				const r = document.querySelector(`.party-friend[data-friend="${id}"]`);
				const name = r?.querySelector(".party-friend-name")?.textContent;
				return r && { cls: r.className, text: r.textContent.replace(name, "NAME"), button: r.querySelector("button")?.textContent, disabled: r.querySelector("button")?.disabled };
			};
			return { kit: look(k), bo: look(b), label: document.querySelector(".party-friends .share-label")?.textContent };
		}, [kitId, boId]);
		check("a friend not on the site is listed, softly, with INVITE", rows.kit?.cls.includes("is-away") && /not on now/.test(rows.kit.text) && rows.kit.button === "INVITE" && rows.kit.disabled === false && rows.label === "Friends", rows);
		check("…and a friend who appears offline looks exactly the same", JSON.stringify(rows.bo) === JSON.stringify(rows.kit), rows);
		await bo.p.evaluate(() => NeonArcade.account.api("/api/me", { method: "PATCH", body: { appearOffline: false } }));
		if (OUT) await ana.p.screenshot({ path: join(OUT, "party-friends-390x844.png") });
		// INVITE to Kit, who is not on: it waits for their next visit.
		await kitRow.locator("button", { hasText: "INVITE" }).click();
		check("…which says Invited", await ana.p.locator(".neon-toast", { hasText: "Invited Kit." }).waitFor({ timeout: TIMEOUT }).then(() => true, () => false));
		const kitAgain = await browser.newContext(phone);
		const kp = await kitAgain.newPage();
		await kp.goto(`${w.base}/auth/test?name=Kit&uid=Kit&back=${encodeURIComponent(page("index.html"))}`);
		const waiting = kp.locator(".neon-invite", { hasText: "Ana Lima invited you to a party" });
		check("an invite waits for a friend who was away, shown when they open the arcade", await waiting.waitFor({ timeout: TIMEOUT }).then(() => true, () => false));
		check("…with JOIN for that code", ((await waiting.locator("a").getAttribute("href")) ?? "").endsWith(`#c=${code3}`));
		if (OUT) await kp.screenshot({ path: join(OUT, "waiting-invite-390x844.png") });
		await waiting.locator("button", { hasText: "NOT NOW" }).click();
		await kp.reload();
		await kp.locator(".site-menu .acct-me").waitFor({ state: "attached", timeout: TIMEOUT });
		await kp.waitForTimeout(1500);
		check("…and NOT NOW forgets it, on every page", (await kp.locator(".neon-invite").count()) === 0);
		await kitAgain.close();
	}

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
		await dee.p.goto(page("?party", "&game=tic-tac-toe-js&fresh=1&mode=bots"));
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
		await dee.p.goto(page("?page=profile"));
		const line = await dee.p.locator(".bot-wins").textContent({ timeout: TIMEOUT }).catch(() => null);
		check("the profile says it, under the ratings and apart from them", line === "Wins against bots: Tic Tac Toe 1", line);
		const ranked = await dee.p.evaluate(() => NeonArcade.account.leaderboard("tic-tac-toe-js"));
		check("the ranked board does not have it", !ranked.rows.some((r) => r.id === deeId) && ranked.botsBoard === true, ranked);

		// A bot removed mid-match hands most games to whoever is left: that is
		// not a win against bots, and the page does not report it.
		await dee.p.goto(page("?party", "&game=connect4&fresh=1&mode=bots"));
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
			await dee.p.goto(page("?page=leaderboard", "&game=tic-tac-toe-js&vs=bots"));
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
		await dee.p.goto(page("?page=leaderboard", "&game=connect4&vs=bots"));
		const empty = dee.p.locator("[data-board] .empty a");
		await empty.waitFor({ timeout: TIMEOUT });
		const href = await empty.getAttribute("href");
		check("an empty board against bots offers SINGLE PLAYER, to the shell's own address", href?.startsWith("./?") && new URLSearchParams(href.slice(3)).get("mode") === "bots" && new URLSearchParams(href.slice(3)).get("game") === "connect4", href);
		await dee.p.goto(page("?page=leaderboard", "&game=neon-survival-mp&vs=bots"));
		await dee.p.waitForFunction(() => new URL(location.href).searchParams.get("vs") === null && !document.querySelector("[data-board] .ghost"), null, { timeout: TIMEOUT });
		check("a ?vs=bots link for a game without that board shows its ranked board", !(await dee.p.locator("[data-board]").textContent()).includes("Could not load") && (await dee.p.locator(".strip[data-vs]").isHidden()));
		await dee.p.goto(page("?page=leaderboard", "&game=tic-tac-toe-js&vs=bots"));
		await dee.p.locator("[data-board] [data-player]").first().waitFor({ timeout: TIMEOUT });
		await dee.p.locator('.strip[data-vs] [data-against=""]').click();
		await dee.p.locator('.strip[data-vs] [aria-pressed="true"]', { hasText: "Ranked" }).waitFor({ timeout: TIMEOUT });
		await dee.p.waitForFunction(() => !document.querySelector("[data-board] .ghost"), null, { timeout: TIMEOUT });
		check("Ranked: the same game's ranked board, without the win", (await dee.p.locator("[data-board] [data-player]").count()) === 0 && new URL(dee.p.url()).searchParams.get("vs") === null);
		if (SHOTS) await dee.p.screenshot({ path: join(SHOTS, "ranked-neon.png") });
		await dee.p.evaluate(() => localStorage.removeItem("neon.theme"));
		await dee.ctx.close();
		// Signed out, the bar under this board gives its own advice.
		const anon = await browser.newContext(phone);
		const ap = await anon.newPage();
		await ap.goto(page("?page=leaderboard", "&game=tic-tac-toe-js&vs=bots"));
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
	await ana.p.goto(page("?page=leaderboard", `&game=connect4&scope=${encodeURIComponent(`group:${gid}`)}`));
	check("the group has its own tab on the leaderboards", (await ana.p.locator('[data-scopes] .scope[aria-pressed="true"]').textContent({ timeout: TIMEOUT })) === "Lunch table");
	await ana.p.locator("[data-board] [data-player]").first().waitFor({ timeout: TIMEOUT }).catch(() => {});
	const groupRows = await ana.p.locator("[data-board] [data-player]").count();
	check("…which counts the game they played together", groupRows === 2, groupRows);
	// The group's own page: members, its boards; the owner removes someone.
	await ana.p.goto(page(`?page=profile&group=${encodeURIComponent(gid)}`));
	await ana.p.locator(`[data-section="members"] [data-member="${boId}"]`).waitFor({ timeout: TIMEOUT });
	check("a group page lists its members, the owner first", (await ana.p.locator("[data-member]").count()) === 2 && (await ana.p.locator("[data-member]").first().textContent()).includes("owner"));
	check("…links to the group's boards", ((await ana.p.locator('[data-section="boards"] a').first().getAttribute("href")) ?? "").includes(`scope=${encodeURIComponent(`group:${gid}`)}`));
	check("…and fits the phone", await noSideScroll(ana.p));
	check("…a member's long name ends in an ellipsis", await ana.p.evaluate(() => {
		const nm = document.querySelector("[data-member] .nm");
		const cs = nm ? getComputedStyle(nm) : {};
		return cs.textOverflow === "ellipsis" && cs.whiteSpace === "nowrap";
	}));
	if (SHOTS) await ana.p.screenshot({ path: join(SHOTS, "group-page.png"), fullPage: true });
	await ana.p.locator(`[data-member="${boId}"] button`, { hasText: "REMOVE" }).click();
	await ana.p.locator("dialog.neon-sheet button", { hasText: "REMOVE" }).click();
	await ana.p.locator(".neon-toast", { hasText: "the code changed" }).waitFor({ timeout: TIMEOUT });
	const newCode = await ana.p.locator('[data-section="group"] .code').textContent();
	check("removing someone changes the join code", newCode !== gcode && (await ana.p.locator("[data-member]").count()) === 1, { newCode, gcode });
	const refused = await bo.p.evaluate((c) => NeonArcade.account.api("/api/groups/join", { method: "POST", body: { code: c } }).then(() => 200, (e) => e.status), newCode);
	check("…and they cannot come back in with the new one", refused === 403, refused);

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
