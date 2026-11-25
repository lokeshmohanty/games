// scripts/test-social.mjs — the account layer in real browsers, at 390x844,
// against the real Worker (wrangler dev, local D1) and the real site:
// signing in, the profile, favourites on two devices, ADD FRIEND in a party,
// a pushed invite, a Connect 4 game between two signed-in people and the
// head-to-head it makes (on the end card and both profiles, at 390x844 and
// 354x696), nothing sent alone or against bots (no boards since 2026-11-25),
// groups, the feedback sheet, and deleting the account.
//
// Needs wrangler (scripts/wrangler.mjs); skips with a message without it.

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { gameFrame, passTable, phoneFloors, PHONE_SIZES, readyToClick, serve } from "./serve.mjs";
import { startWrangler } from "./wrangler.mjs";
import { loadPlaywright } from "./playwright.mjs";

const TIMEOUT = 30_000;
let failures = 0;
const check = (label, ok, detail = "") => {
	console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
	if (!ok) failures++;
};

// MATCH_GRACE_MS: a match whose loser left counts after 3 s here (45 s deployed).
// MATCH_STALE_MS: a departure needs the leaver's page silent this long (3 min deployed).
const w = await startWrangler({ AUTH_TEST: "1", SESSION_KEY: "social-test-key-0123456789", MATCH_GRACE_MS: "3000", MATCH_STALE_MS: "4000" });
if (!w) process.exit(0);
const site = await serve(8737);
const RS = encodeURIComponent(w.base);
const page = (p, extra = "") => `${site.base}/${p}${p.includes("?") ? "&" : "?"}rs=${RS}${extra}`;

function chrome() {
	return [process.env.CHROME, "/run/current-system/sw/bin/google-chrome-stable", "/run/current-system/sw/bin/chromium", "/usr/bin/google-chrome"].filter(Boolean).find(existsSync);
}
const pw = loadPlaywright();
const browser = await pw.chromium.launch({ executablePath: chrome(), args: ["--no-sandbox"] });
const phone = { viewport: { width: 390, height: 844 } };

/** A browser "device" signed in as `name` (the loopback-only test sign-in). */
async function device(name, uid = name) {
	const ctx = await browser.newContext(phone);
	// Who opens rotates and a run's first match draws at random (lib/sdk-managed.js
	// nextFirst): these checks expect the first seat to open (tests only).
	await ctx.addInitScript(() => {
		window.NeonArcade = window.NeonArcade || {};
		window.NeonArcade.firstDraw = () => 0;
	});
	const p = await ctx.newPage();
	p.on("pageerror", (e) => check(`no page error on ${name}'s device (${e.message})`, false));
	const back = page("?page=profile");
	await p.goto(`${w.base}/auth/test?name=${encodeURIComponent(name)}&uid=${encodeURIComponent(uid)}&back=${encodeURIComponent(back)}`);
	await p.locator(".who .name").waitFor({ timeout: TIMEOUT });
	return { ctx, p };
}
const noSideScroll = (p) => p.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
// Screenshots (NEON_SHOTS=dir), for a person to look at too.
const SHOTS = process.env.NEON_SHOTS ?? null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
/** Every match report a page sends, with the server's answers. */
function watchRuns(p) {
	const seen = { reports: [] };
	p.on("response", async (r) => {
		const sent = () => JSON.parse(r.request().postData() ?? "{}");
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
	// inside games", 2026-11-14 and 2026-11-16). A card's only button is its
	// title (.card-open, which opens the game), so any other control would be
	// a star or feedback one; nor a ☆ or ★ in its text.
	const cardControls = await ana.p.evaluate(() => ({
		cards: document.querySelectorAll(".game-card").length,
		controls: document.querySelectorAll(".game-card :is(button:not(.card-open), [aria-pressed], .fav, .fb, .card-fav, .top-fav)").length,
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

	// Records and achievements are for friends only (docs/accounts.md "Records
	// and achievements"): Ana's, synced from her device, behind 🏆 TROPHIES
	// beside her in Bo's party and on her profile — and not for a stranger.
	await ana.p.evaluate(() =>
		NeonArcade.account.api("/api/me/records", { method: "PUT", body: { games: { "neon-fission": { a: { "first-win": Date.now() }, r: { chain: { b: "max", v: { "": 12 } } }, s: { played: 3, won: 2, last: 1 } }, "*": { a: { regular: Date.now() }, n: 10, g: ["neon-fission"] } } } }),
	);
	const trophiesBtn = bo.p.locator(`.party-member [data-trophies="${anaId}"]`);
	check("a friend in the party has 🏆 TROPHIES beside FRIENDS ✓, 44px", await trophiesBtn.waitFor({ timeout: TIMEOUT }).then(async () => (await trophiesBtn.boundingBox()).height >= 44, () => false));
	await trophiesBtn.click();
	const fsheet = bo.p.locator(`dialog.records-sheet[data-friend="${anaId}"]`);
	await fsheet.locator(".records-game", { hasText: "Neon Fission" }).waitFor({ timeout: TIMEOUT }).catch(() => {});
	const fsays = await fsheet.textContent().catch(() => "");
	check("…which shows her trophies: two, Regular among them, and her games", /2 trophies/.test(fsays) && fsays.includes("Regular") && fsays.includes("🏆 1 / 7"), fsays.slice(0, 300));
	await fsheet.locator(".records-game", { hasText: "Neon Fission" }).click();
	const fpanel = bo.p.locator('dialog.records-sheet [data-records="neon-fission"]');
	const fp = await fpanel.textContent({ timeout: TIMEOUT }).catch(() => "");
	check("…and a game's best: her biggest chain, First Win unlocked, her played and won", fp.includes("Biggest chain") && fp.includes("12 bursts") && /First Win.*UNLOCKED/.test(fp) && fp.includes("Played3"), fp.slice(0, 300));
	await bo.p.keyboard.press("Escape");
	const asFriend = await bo.ctx.newPage();
	await asFriend.goto(page(`?page=profile&u=${anaId}`));
	check("her profile shows a friend her trophies and records", await asFriend.locator('[data-section="trophies"] .records-game[data-game="neon-fission"]').waitFor({ timeout: TIMEOUT }).then(() => true, () => false));
	await asFriend.close();
	{
		const cy = await device("Cy");
		await cy.p.goto(page(`?page=profile&u=${anaId}`));
		await cy.p.locator('[data-section="vs"]').waitFor({ timeout: TIMEOUT }).catch(() => {});
		check("…and a stranger, signed in, none of it — only their head-to-head (not played yet)", (await cy.p.locator('[data-section="trophies"]').count()) === 0 && /not played/.test((await cy.p.locator('[data-section="vs"]').textContent().catch(() => "")) ?? ""));
		await cy.ctx.close();
	}

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
	// Its DELETE is sent without waiting (keepalive): asked until it has landed.
	let invites = null;
	for (const end = Date.now() + 10_000; Date.now() < end; await boPortal.waitForTimeout(200)) {
		invites = (await boPortal.evaluate(() => NeonArcade.account.api("/api/invites"))).invites;
		if (!invites.length) break;
	}
	check("NOT NOW forgets the invite on the server too", invites?.length === 0, invites);
	await boPortal.close();

	console.log("\nsocial: Connect 4 between two signed-in people: their head-to-head");
	// Connect 4 once had no boards ("leaderboard": false, 2026-11-16); with no
	// boards at all (2026-11-25) it counts towards head-to-head like any game.
	// The reload above made a new party; bring Bo into it.
	const code2 = (await ana.p.locator(".party-code-digits").textContent()).replace(/\D/g, "");
	await bo.p.goto(page("?party", `#c=${code2}`));
	await ana.p.waitForFunction(() => document.querySelectorAll(".party-member").length === 2, null, { timeout: TIMEOUT });
	const anaRuns = watchRuns(ana.p);
	const anaStarts = [];
	ana.p.on("request", (r) => r.url().includes("/api/match/start") && anaStarts.push(r.url()));
	await ana.p.evaluate(() => {
		// Who opens rotates and the first match draws at random (lib/sdk-managed.js
		// nextFirst, 2026-11-22): pin the draw so Ana, the first seat, opens.
		window.NeonArcade.firstDraw = () => 0;
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
			// Bo's own frame must have Ana's move and see its turn: a tap
			// before that is no move (connect4.js myTurn).
			await fb.waitForFunction((n) => { const d = window.__game.handle.debug(); return d.board.flat().filter(Boolean).length >= n && d.winner === null && d.turn === d.you; }, 2 * i + 1, { timeout: TIMEOUT });
			await drop(bo.p, fb, 1);
			await fa.waitForFunction((n) => window.__game.handle.debug().board.flat().filter(Boolean).length >= n, 2 * i + 2, { timeout: TIMEOUT });
		}
	}
	const c4won = await fa.waitForFunction(() => window.__game.handle.debug().winner === 1, null, { timeout: TIMEOUT }).then(() => true, () => false);
	check("Ana wins four down", c4won);
	await ana.p.locator(".managed-over").waitFor({ timeout: TIMEOUT });
	const c4line = ana.p.locator(".managed-over .managed-rating");
	const c4said = await c4line.filter({ hasText: "You 1–0 Bo" }).waitFor({ timeout: TIMEOUT }).then(() => true, () => false);
	check("…both report it, a match start was sent, and the end card says \"You 1–0 Bo\"", c4said && anaRuns.reports.length >= 1 && anaStarts.length >= 1, { line: await c4line.textContent().catch(() => null), reports: anaRuns.reports.map((x) => x.got) });
	check("…never a rating", !/rating|→|elo/i.test((await c4line.textContent()) ?? ""));
	const local = await ana.p.evaluate(() => JSON.parse(localStorage.getItem("neon.stats")).connect4);
	check("…while this device's own stats still count it", local?.won >= 1 && local.vsPeople >= 1, local);

	console.log("\nsocial: leaving a game is a loss, and the head-to-head on the end card");
	{
		// Neon Fission between Ana and Bo; Bo's page says it is seated (POST
		// /api/match/start), then Bo leaves the party for good.
		const starts = [];
		bo.p.on("request", (r) => r.url().includes("/api/match/start") && starts.push(JSON.parse(r.postData() ?? "{}")));
		await ana.p.evaluate(() => window.__party.room.setGame("neon-fission"));
		const nf = await gameFrame(ana.p, TIMEOUT);
		await gameFrame(bo.p, TIMEOUT);
		await nf.waitForFunction(() => window.__game?.handle?.debug?.()?.match != null, null, { timeout: TIMEOUT });
		// Every state the end card's head-to-head line takes, on the node first drawn:
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
			.waitForFunction(() => window.__rating.toasts.some((t) => /^You 1–0 Bo$/.test(t)), null, { timeout: TIMEOUT })
			.then(() => true, () => false);
		check("…the toast says the head-to-head in this game", counted, await ana.p.evaluate(() => window.__rating.toasts));
		const line = ana.p.locator(".managed-over .managed-rating");
		const shown = await line.filter({ hasText: "You 1–0 Bo" }).waitFor({ timeout: TIMEOUT }).then(() => true, () => false);
		check("the end card says it too: \"You 1–0 Bo\" (Neon Fission's own record, not Connect 4's)", shown, await line.textContent().catch(() => null));
		const inPlace = await ana.p.evaluate(() => ({ same: document.querySelector(".managed-over .managed-rating") === window.__rating.el, seen: window.__rating.seen }));
		check("…filled in place on the card already drawn (it said it was waiting first)", inPlace.same && inPlace.seen.some((t) => /waiting/i.test(t)), inPlace);
		const fits = await line.evaluate((el) => {
			const r = el.getBoundingClientRect();
			return r.width > 0 && r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
		});
		check("…inside the phone's screen (390x844), no side scroll", fits && (await noSideScroll(ana.p)));
		// The longest name an account may have (24 characters), with no space,
		// on this same card at 354x696: it wraps inside the screen.
		await ana.p.setViewportSize({ width: 354, height: 696 });
		const long = await line.evaluate((el) => {
			const was = el.textContent;
			el.textContent = `You 12–10 ${"W".repeat(24)}`;
			const r = el.getBoundingClientRect();
			const out = { left: Math.round(r.left), right: Math.round(r.right), lines: Math.round(r.height / parseFloat(getComputedStyle(el).lineHeight || "16")), wrap: getComputedStyle(el).overflowWrap, sideways: document.documentElement.scrollWidth > innerWidth };
			el.textContent = was;
			return out;
		});
		check("…a 24-character name with no space wraps inside the 354x696 screen", long.left >= 0 && long.right <= 354 && long.wrap === "anywhere" && !long.sideways, long);
		await ana.p.setViewportSize(phone.viewport);
		const boSide = await bo.p.evaluate((id) => NeonArcade.account.api(`/api/u/${id}`), anaId);
		check("…a loss for Bo, in his head-to-head against Ana", boSide.vs?.games["neon-fission"]?.losses === 1 && boSide.vs.games["neon-fission"].wins === 0, boSide.vs);
	}

	console.log("\nsocial: head-to-head on the profile");
	{
		// Ana beat Bo at Connect 4 and at Neon Fission (he left): 2–0.
		await ana.p.goto(page(`?page=profile&u=${boId}`));
		const vs = ana.p.locator('[data-section="vs"]');
		await vs.locator(".vs-score").waitFor({ timeout: TIMEOUT });
		check("Bo's profile says Ana's record against him: You 2–0 Bo", (await vs.locator(".vs-total").textContent()) === "You 2–0 Bo", await vs.locator(".vs-total").textContent());
		const rows = await vs.locator("tr[data-game]").evaluateAll((trs) => trs.map((tr) => `${tr.dataset.game}:${[...tr.querySelectorAll("td.n")].map((td) => td.textContent).join("-")}`).sort());
		check("…by game: Connect 4 1–0–0, Neon Fission 1–0–0", rows.join() === "connect4:1-0-0,neon-fission:1-0-0", rows);
		check("…no ratings anywhere on it", !/rating|elo|prov\./i.test(await ana.p.locator("[data-profile]").textContent()));
		await ana.p.goto(page("?page=profile"));
		const rival = ana.p.locator(`[data-section="rivals"] a[data-rival="${boId}"]`);
		await rival.waitFor({ timeout: TIMEOUT });
		check("her own profile lists Bo among the people she played, 2–0, a link to his profile", (await rival.textContent()).includes("2–0") && ((await rival.getAttribute("href")) ?? "").includes(`u=${encodeURIComponent(boId)}`), await rival.textContent());
		for (const [pg, root] of [[`?page=profile&u=${boId}`, '[data-section="vs"]'], ["?page=profile", '[data-section="rivals"]']]) {
			for (const [vw, vh] of PHONE_SIZES) {
				await ana.p.setViewportSize({ width: vw, height: vh });
				await ana.p.goto(page(pg));
				await ana.p.locator(`${root} ${root.includes("rivals") ? "a[data-rival]" : ".vs-score"}`).waitFor({ timeout: TIMEOUT });
				const f = await phoneFloors(ana.p, root);
				check(`${vw}x${vh}, ${pg}: head-to-head with 12px text${root.includes("rivals") ? ", 44px rows" : ""}, no sideways scroll`, !f.text.length && !f.taps.length && (!root.includes("rivals") || f.measured.taps > 0) && (await noSideScroll(ana.p)), f);
				if (SHOTS) await ana.p.screenshot({ path: join(SHOTS, `h2h-${root.includes("rivals") ? "mine" : "theirs"}-${vw}x${vh}.png`), fullPage: true });
			}
		}
		await ana.p.setViewportSize(phone.viewport);
	}

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

		// A Connect 4 between Ana and Kit, who are not friends (the end card's
		// "players you just played" comes from the party).
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
				await fk.waitForFunction((n) => { const d = window.__game.handle.debug(); return d.board.flat().filter(Boolean).length >= n && d.winner === null && d.turn === d.you; }, 2 * i + 1, { timeout: TIMEOUT });
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
		// A Battleship both report, through the API: one more recent match
		// (the profile's "recent players").
		const bs = { game: "lokeshmohanty/battleship", run: "kit-ana-1", match: 1, kind: "duel", ranking: [["pa"], ["pk"]], roster: { pa: anaId, pk: kitId }, seats: 2 };
		await ana.p.evaluate((b) => NeonArcade.account.api("/api/match/report", { method: "POST", body: b }), bs);
		const kitCounted = await kit.p.evaluate((b) => NeonArcade.account.api("/api/match/report", { method: "POST", body: b }), bs);
		check("(Ana and Kit's Battleship counts)", kitCounted.counted === true, kitCounted);

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

	console.log("\nsocial: alone or against bots, nothing goes to the server");
	{
		const dee = await device("Dee");
		const seen = watchRuns(dee.p);
		check("the account layer has no server-issued runs any more", await dee.p.evaluate(() => NeonArcade.account.startRun === undefined && NeonArcade.account.leaderboard === undefined));
		// Tic Tac Toe against the bot: played to its end by the bot's moves and ours.
		await dee.p.goto(page("?party", "&game=tic-tac-toe-js&fresh=1&mode=bots"));
		await gameFrame(dee.p, TIMEOUT);
		await dee.p.waitForTimeout(2500);
		check("Tic Tac Toe against the bot: nothing sent", seen.reports.length === 0, seen);
		// Neon Fission against a bot; removing the bot hands Dee the match.
		await dee.p.goto(page("?party", "&game=neon-fission&fresh=1&mode=bots"));
		await passTable(dee.p, TIMEOUT); // its quick table, at Players 2: START GAME
		const nfb = await gameFrame(dee.p, TIMEOUT);
		await nfb.waitForFunction(() => window.__game?.handle?.debug?.()?.match, null, { timeout: TIMEOUT }).catch(() => {});
		await dee.p.evaluate(() => {
			const r = window.__party.room;
			r.removeMember(r.getMembers().find((m) => NeonArcade.isBotId(m.id)).id);
		});
		await dee.p.locator(".managed-actions").waitFor({ timeout: TIMEOUT }).catch(() => {});
		await dee.p.waitForTimeout(2500);
		check("Neon Fission against a bot, won: nothing reported", seen.reports.length === 0, seen);
		check("…and the end card has no head-to-head line", await dee.p.locator(".managed-over .managed-rating").isHidden().catch(() => true));
		await dee.ctx.close();
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
	// The group's own page: members (no boards since 2026-11-25); the owner removes someone.
	await ana.p.goto(page(`?page=profile&group=${encodeURIComponent(gid)}`));
	await ana.p.locator(`[data-section="members"] [data-member="${boId}"]`).waitFor({ timeout: TIMEOUT });
	check("a group page lists its members, the owner first", (await ana.p.locator("[data-member]").count()) === 2 && (await ana.p.locator("[data-member]").first().textContent()).includes("owner"));
	check("…and no boards", (await ana.p.locator('[data-section="boards"]').count()) === 0 && !(await ana.p.locator("[data-profile]").textContent()).includes("BOARDS"));
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
	// The sheet fills in after it opens (it asks whether GitHub is connected):
	// wait for its answer rather than count at once (a CI race, 2026-11-21).
	const connect = await ana.p.locator("dialog.neon-sheet button", { hasText: "CONNECT GITHUB" }).waitFor({ timeout: TIMEOUT }).then(() => true, () => false);
	check("…which, without GitHub connected, offers CONNECT GITHUB instead of a box", connect && (await ana.p.locator("dialog.neon-sheet button", { hasText: "CONNECT GITHUB" }).count()) === 1 && (await ana.p.locator("dialog.neon-sheet textarea").count()) === 0);
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
