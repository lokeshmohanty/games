// scripts/test-portal.mjs — the home screen's sub-tabs (My Games · All
// Games), sections, PLAY SOMETHING and search, the bar and tabs on every page,
// the Contributors and Collections pages and the add-your-game guide, at
// 390x844 (and Lokesh's phone, 354x696).

import { existsSync, readFileSync } from "node:fs";
import { serve, settled } from "./serve.mjs";
import { loadPlaywright } from "./playwright.mjs";

const TIMEOUT = 20_000;
let failures = 0;
const check = (label, ok, detail = "") => {
	console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
	if (!ok) failures++;
};
const pw = loadPlaywright();
const chrome = [process.env.CHROME, "/run/current-system/sw/bin/google-chrome-stable", "/run/current-system/sw/bin/chromium", "/usr/bin/google-chrome"].filter(Boolean).find(existsSync);
const site = await serve(8740);
const browser = await pw.chromium.launch({ executablePath: chrome, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const p = await ctx.newPage();
p.on("pageerror", (e) => check(`no page error (${e.message})`, false));
// The search's results: one grid in place of the home screen's sections.
// All Games, by its address: once a game is played, ./ opens on My Games.
const ALL = "index.html?page=games&tab=all";
const shown = () => p.evaluate(() => [...document.querySelectorAll(".games-grid:not([hidden]) .game-card:not([hidden]) h3")].map((h) => h.textContent));

try {
	console.log("\nportal: the home screen");
	// The play counts, played here (the server's /api/stats/summary).
	const HOME_PLAYS = { "lokeshmohanty/sudoku": 50, undercover: 40, connect4: 30 };
	const summary = (route) =>
		route.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ games: Object.fromEntries(Object.entries(HOME_PLAYS).map(([g, played]) => [g, { played }])) }) });
	await p.route("**/api/stats/summary", summary);
	await p.goto(site.url("index.html"));
	await p.waitForSelector(".game-card:visible");
	await p.evaluate(() => NeonArcade.catalogs); // the community games drawn too
	const home = () =>
		p.evaluate(() => ({
			order: [...document.querySelectorAll("[data-section]:not([hidden])")].map((s) => s.dataset.section),
			titles: [...document.querySelectorAll("[data-section]:not([hidden]) .section-title")].map((h) => h.textContent),
			rows: Object.fromEntries([...document.querySelectorAll("[data-section]")].map((s) => [s.dataset.section, [...s.querySelectorAll(".section-row .game-card")].map((c) => c.dataset.game)])),
			catalog: NeonArcade.CATALOG.map((g) => ({ id: g.id, cats: g.categories ?? [], min: g.seats.min })),
		}));
	await p.waitForFunction(() => document.querySelector('[data-section="popular"] .game-card')?.dataset.game === "lokeshmohanty/sudoku", null, { timeout: TIMEOUT }).catch(() => {});
	let h = await home();
	check("a first visit opens on All Games, and the address says so", new URL(p.url()).searchParams.get("page") === "games" && new URL(p.url()).searchParams.get("tab") === "all", p.url());
	check("All Games: Popular and the categories, in order (no favourites there)", h.order.join() === "popular,arcade,party,strategy,solo", h.order);
	check("…titled Popular, Arcade, Party, Strategy, Puzzle / Single player", h.titles.join() === "Popular,Arcade,Party,Strategy,Puzzle / Single player", h.titles);
	const ttt = await p.evaluate(() => ({ listed: NeonArcade.CATALOG.filter((g) => g.path?.startsWith("sdk/v2/examples/")).map((g) => [g.id, g.title, g.categories.join()]), unlisted: (NeonArcade.UNLISTED ?? []).map((g) => g.id), cards: [...document.querySelectorAll(".game-card")].map((c) => c.dataset.game).filter((id) => id.startsWith("tic-tac-toe")) }));
	check("one Tic Tac Toe, under Strategy; the other six examples on no list", ttt.listed.length === 1 && ttt.listed[0].join() === "tic-tac-toe-js,Tic Tac Toe,strategy" && ttt.unlisted.length === 6 && new Set(ttt.cards).size === 1 && ttt.cards[0] === "tic-tac-toe-js" && h.rows.strategy.includes("tic-tac-toe-js"), ttt);
	check("Popular: 3 to 5 games", h.rows.popular.length >= 3 && h.rows.popular.length <= 5, h.rows.popular);
	const nonExamples = h.catalog.map((g) => g.id);
	check("…the most played first, then the catalog's order", h.rows.popular.join() === ["lokeshmohanty/sudoku", "undercover", "connect4", ...nonExamples.filter((id) => !["lokeshmohanty/sudoku", "undercover", "connect4"].includes(id))].slice(0, 5).join(), h.rows.popular);
	const belongs = { arcade: (g) => g.cats.includes("arcade"), party: (g) => g.cats.includes("party"), strategy: (g) => g.cats.includes("strategy"), solo: (g) => g.cats.includes("puzzle") || g.min <= 1 };
	for (const [id, fits] of Object.entries(belongs)) {
		const want = h.catalog.filter(fits).map((g) => g.id);
		check(`${id}: exactly its games, in the catalog's order`, want.length > 0 && h.rows[id].join() === want.join(), { got: h.rows[id], want });
	}
	check("a game sits in every section it belongs to (Neon Bid: party and strategy)", h.rows.party.includes("neon-bid") && h.rows.strategy.includes("neon-bid"));
	const uncategorised = await p.evaluate(() => {
		const c4 = NeonArcade.CATALOG.find((g) => g.id === "connect4");
		NeonArcade.CATALOG.push({ ...c4, id: "no-category", title: "No Category", categories: [] });
		NeonArcade.portal.draw();
		const got = { shown: !document.querySelector('[data-section="other"]').hidden, row: [...document.querySelectorAll('[data-section="other"] .game-card')].map((c) => c.dataset.game) };
		NeonArcade.CATALOG.pop();
		NeonArcade.portal.draw();
		return { ...got, after: document.querySelector('[data-section="other"]').hidden };
	});
	check("a game no category takes is under More games (hidden while there is none)", uncategorised.shown && uncategorised.row.join() === "no-category" && uncategorised.after, uncategorised);
	check("Puzzle / Single player: Sudoku, and what one person can start alone", h.rows.solo.includes("lokeshmohanty/sudoku") && h.rows.solo.includes("neon-survival-mp") && !h.rows.solo.includes("connect4"), h.rows.solo);
	const rows = await p.evaluate(() => ({
		sideways: document.documentElement.scrollWidth > innerWidth,
		widest: [...document.querySelectorAll(".portal-section:not([hidden]) .section-row")].map(({ scrollWidth, clientWidth }) => ({ scrollWidth, clientWidth })).sort((a, b) => b.scrollWidth - a.scrollWidth)[0],
		inside: [...document.querySelectorAll(".portal-section")].every((s) => s.getBoundingClientRect().right <= innerWidth && s.getBoundingClientRect().left >= 0),
		cards: [...document.querySelectorAll(".game-card")].every((c) => c.dataset.tags.trim().length > 0),
	}));
	check("on a phone a section is one row that scrolls sideways inside itself", rows.widest.scrollWidth > rows.widest.clientWidth, rows.widest);
	check("…and the page never does", !rows.sideways && rows.inside, rows);
	// Only what is on screen plays: a card per game per section is dozens.
	// 1.5 s for any off-screen clip to start (it must not), then until the
	// on-screen ones have.
	await p.waitForTimeout(1500);
	const playing = await settled(
		() =>
			p.evaluate(() =>
				[...document.querySelectorAll("video.card-preview")].map((v) => {
					const r = v.getBoundingClientRect();
					const seen = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)) * Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
					return { playing: !v.paused, half: r.width * r.height > 0 && seen / (r.width * r.height) >= 0.45 };
				}),
			),
		(vs) => vs.some((v) => v.playing),
	);
	check("only the cards on screen play their previews", playing.filter((v) => v.playing).length > 0 && playing.every((v) => !v.playing || v.half), { videos: playing.length, playing: playing.filter((v) => v.playing).length });
	check("…the rest wait", playing.filter((v) => !v.playing).length >= 10);
	// Counts kept on this device: with the server gone, Popular paints the same.
	await p.unroute("**/api/stats/summary");
	await p.route("**/api/stats/summary", (route) => route.abort());
	await p.route("**/summary.json", (route) => route.abort());
	await p.reload();
	await p.waitForSelector('[data-section="popular"] .game-card');
	check("the counts are kept: with no server, Popular paints the same", (await home()).rows.popular.join() === h.rows.popular.join(), (await home()).rows.popular);
	// …and a first visit with no counts at all: the catalog's order.
	await p.evaluate(() => localStorage.removeItem("neon.plays"));
	await p.reload();
	await p.waitForSelector('[data-section="popular"] .game-card');
	await p.evaluate(() => NeonArcade.catalogs);
	check("no counts at all (offline, first visit): the catalog's first five", (await home()).rows.popular.join() === nonExamples.slice(0, 5).join(), (await home()).rows.popular);
	await p.unroute("**/api/stats/summary");
	await p.unroute("**/summary.json");
	// Favourites: games starred (lib/stats.js), in the order starred; a starred
	// contributor or collection is a search for its games.
	await p.evaluate(() => localStorage.setItem("neon.favs", JSON.stringify(["lokeshmohanty/sudoku", "connect4", "gone-game", "contributor:lokeshmohanty", "collection:lokeshmohanty/web-games"])));
	await p.goto(site.url("index.html"));
	await p.waitForSelector('[data-section="favs"]:not([hidden]) .game-card');
	h = await home();
	check("with favourites, ./ opens on My Games: ★ Favourites, and no All Games section", h.order.join() === "favs" && new URL(p.url()).searchParams.get("tab") === "mine", { order: h.order, url: p.url() });
	check("…All Games' cards are not drawn behind it", (await p.locator('[data-section]:not([data-section="favs"]) .game-card').count()) === 0 && (await p.locator(".search").isHidden()));
	check("…the games starred, in that order (a game no longer listed left out)", h.rows.favs.join() === "lokeshmohanty/sudoku,connect4", h.rows.favs);
	const more = await p.locator('[data-section="favs"] .fav-more-item').allTextContents();
	check("…and the contributors and collections starred", more.join() === "lokeshmohanty,lokeshmohanty/web-games", more);
	await p.locator('[data-section="favs"] .fav-more-item', { hasText: "lokeshmohanty/web-games" }).click();
	await p.waitForFunction(() => new URLSearchParams(location.search).get("tab") === "all", null, { timeout: TIMEOUT });
	check("…a tap lists that collection's games, as a search on All Games", (await p.locator("[data-search]").inputValue()) === "from:lokeshmohanty/web-games" && (await shown()).length > 0 && (await shown()).every((t) => !t.startsWith("Tic Tac")), await shown());
	await p.goBack();
	await p.waitForSelector('[data-section="favs"]:not([hidden]) .game-card');
	check("…and Back returns to My Games", new URL(p.url()).searchParams.get("tab") === "mine" && (await p.locator(".search").isHidden()), p.url());
	await p.evaluate(() => localStorage.removeItem("neon.favs"));
	check("Recently played stays above the sections", await p.evaluate(() => !!(document.querySelector("[data-recent]").compareDocumentPosition(document.querySelector("[data-sections]")) & Node.DOCUMENT_POSITION_FOLLOWING)));

	console.log("\nportal: search");
	await p.goto(site.url("index.html"));
	await p.waitForSelector(".game-card:visible");
	const all = await p.evaluate(async () => (await NeonArcade.catalogs, NeonArcade.CATALOG.length));
	const search = async (q) => {
		await p.locator("[data-search]").fill(q);
		return shown();
	};
	const sectionsShown = () => p.evaluate(() => !document.querySelector("[data-sections]").hidden && document.querySelector(".games-grid").hidden);
	check("no search: the sections, and no result grid", await sectionsShown());
	check("a word finds a game by name", (await search("swarm")).join() === "Neon Survival", await search("swarm"));
	check("…in one grid, in place of the sections and Recently played", await p.evaluate(() => document.querySelector("[data-sections]").hidden && document.querySelector("[data-recent]").hidden && !document.querySelector(".games-grid").hidden));
	check("…or by its description", (await search("impostor")).includes("Undercover"));
	check("type:duel — the head-to-head games, Tic Tac Toe among them", (await search("type:duel")).includes("Battleship") && (await search("type:duel")).includes("Connect 4") && (await search("type:duel")).includes("Tic Tac Toe") && !(await search("type:duel")).includes("Undercover"));
	check("tag:quick", (await search("tag:quick")).length > 0 && (await search("tag:quick")).length < all);
	check("author:lokeshmohanty — everything here is theirs", (await search("author:lokeshmohanty")).length === all);
	check("players:10 — only what seats ten", (await search("players:10")).join() === "Undercover", await search("players:10"));
	check("from:arcade / from:community split the list", (await search("from:arcade")).length + (await search("from:community")).length === all);
	check("terms combine", (await search("type:duel players:2 battle")).join() === "Battleship");
	check("each game once in the results", new Set(await search("tag:quick")).size === (await search("tag:quick")).length);
	check("an unknown field matches nothing, and says so", (await search("colour:red")).length === 0 && (await p.locator(".filter-empty:not([hidden])").textContent()).includes("colour:red"));
	await search("type:duel");
	check("the search is in the address, to share", new URL(p.url()).searchParams.get("q") === "type:duel");
	await search("");
	check("an empty search brings the sections back", (await sectionsShown()) && !new URL(p.url()).searchParams.has("q") && (await p.locator(".filter-empty").isHidden()));
	await p.goto(site.url("index.html?q=" + encodeURIComponent("tag:strategy")));
	await p.waitForSelector(".game-card:visible");
	check("…and a link with ?q= opens searched", (await p.locator("[data-search]").inputValue()) === "tag:strategy" && (await shown()).length > 0 && (await shown()).length < all);

	console.log("\nportal: one page (src/views/Portal.tsx)");
	await p.goto(site.url("index.html"));
	await p.waitForSelector(".game-card:visible");
	await p.evaluate(() => (window.__samePage = true));
	p.once("dialog", (d) => d.accept("12-34-56"));
	await p.locator(".join-code-btn").click();
	await p.waitForFunction(() => document.body.dataset.view === "party", null, { timeout: TIMEOUT });
	check("JOIN WITH A CODE opens the party in the page, with the code", (await p.evaluate(() => window.__samePage)) && new URL(p.url()).hash === "#c=123456", p.url());
	await p.goto(site.url("index.html"));
	await p.waitForSelector(".game-card:visible");
	await p.evaluate(() => (window.__samePage = true));
	await p.locator(".party-banner a.play-btn").click();
	await p.waitForFunction(() => window.__party?.room, null, { timeout: TIMEOUT });
	check("START A PARTY hosts one, in the page", await p.evaluate(() => window.__samePage && document.body.dataset.view === "party"), p.url());
	await p.evaluate(() => history.back());
	await p.waitForSelector(".view-portal .game-card");
	await p.locator(".back-to-game").waitFor({ timeout: TIMEOUT });
	check("back on the portal, the sections are drawn anew", (await p.locator('.view-portal [data-section="popular"]:not([hidden]) .game-card').count()) >= 3);
	await p.locator("[data-search]").fill("swarm");
	check("…and the search works again", (await shown()).join() === "Neon Survival", await shown());
	await p.locator("[data-search]").fill("");
	const clear = await p.evaluate(() => {
		scrollTo(0, document.documentElement.scrollHeight);
		const last = Math.max(...[...document.querySelectorAll(".game-card")].map((c) => c.getBoundingClientRect().bottom));
		return { last: Math.round(last), pill: Math.round(document.querySelector(".back-to-game").getBoundingClientRect().top) };
	});
	check("…and BACK TO PARTY never sits over the last cards", clear.last <= clear.pill, clear);
	// With that party still mounted behind the portal, a card's PLAY is a NEW
	// party: a fresh page (the review of 2026-11-15 found it either reloaded
	// past the leave question or showed the old party instead).
	await p.evaluate(() => scrollTo(0, 0));
	const oldRoom = await p.evaluate(() => window.__party.room.selfId);
	const c4 = p.locator('.game-card[data-game="connect4"]').first();
	await c4.hover();
	await c4.locator(".card-play", { hasText: "SINGLE PLAYER" }).click();
	// The host of a party is asked first (the party ends): yes.
	const yes = p.locator('dialog.neon-ask[open] [data-ask="yes"]');
	const askedFirst = await yes.waitFor({ timeout: 5000 }).then(() => true, () => false);
	if (askedFirst) await yes.click();
	check("…the leave question comes first", askedFirst);
	await p.waitForSelector(".game-frame", { timeout: TIMEOUT });
	const fresh = await p.evaluate(() => ({ same: !!window.__samePage, game: window.__party?.game, id: window.__party?.room?.selfId }));
	check("a card's PLAY over a mounted party starts a new one (a fresh page), into that game", !fresh.same && fresh.game === "connect4", fresh);
	check("…not the old party shown again", fresh.id !== undefined && fresh.game === "connect4" && oldRoom !== undefined);

	console.log("\nportal: a card's two ways to play");
	await p.goto(site.url(ALL));
	await p.waitForSelector(".game-card:visible");
	const cardInfo = await p.evaluate(() =>
		Object.fromEntries(
			[...document.querySelectorAll(".game-card")].map((c) => [c.dataset.game, [...c.querySelectorAll(".card-play")].map((a) => a.textContent)]),
		),
	);
	check("no PLAY NOW on any card", (await p.locator(".game-card .play-btn").count()) === 0);
	check("a bots game offers SINGLE PLAYER and MULTI-PLAYER", cardInfo.connect4?.join() === "SINGLE PLAYER,MULTI-PLAYER", cardInfo.connect4);
	check("…a people-only game only MULTI-PLAYER", cardInfo["lokeshmohanty/draw-guess"]?.join() === "MULTI-PLAYER", cardInfo["lokeshmohanty/draw-guess"]);
	check("…a one-device (party) game: SINGLE PLAYER / SAME DEVICE", cardInfo.undercover?.join() === "SINGLE PLAYER / SAME DEVICE", cardInfo.undercover);
	const c4card = p.locator('.game-card[data-game="connect4"]').first();
	const visible = () => c4card.locator(".card-actions").evaluate((a) => getComputedStyle(a).opacity === "1");
	check("hidden until wanted", !(await visible()));
	await c4card.hover();
	check("a mouse hovering shows them", await settled(visible, Boolean, 3000)); // an opacity transition
	await p.mouse.move(1, 1);
	await p.keyboard.press("Tab");
	await c4card.focus();
	check("…and so does keyboard focus", await settled(visible, Boolean, 3000));
	await c4card.locator(".card-play", { hasText: "SINGLE PLAYER" }).click();
	await p.waitForSelector(".game-frame", { timeout: TIMEOUT });
	check("SINGLE PLAYER goes straight into the game, bots seated: no second choice, no START", (await p.locator(".party-choice").count()) === 0 && (await p.evaluate(() => window.__party.room.getMembers().some((m) => m.id.startsWith("bot_")))));
	check("…without waiting on the room server: no party code yet", await p.evaluate(() => !document.querySelector(".party-code-digits")));
	check("…and the address forgets the mode, for a reload", !new URL(p.url()).searchParams.has("mode"), p.url());
	await p.goto(site.url(ALL));
	await p.waitForSelector(".game-card:visible");
	await p.locator('.game-card[data-game="connect4"]').first().hover();
	await p.locator('.game-card[data-game="connect4"]').first().locator(".card-play", { hasText: "MULTI-PLAYER" }).click();
	await p.locator("button", { hasText: "INVITE A FRIEND" }).first().waitFor({ timeout: TIMEOUT });
	check("MULTI-PLAYER lands on the friends view (invite, and the code when there is a server)", (await p.locator(".party-choice").count()) === 0);
	// A phone: no hover, so the first tap opens the choices and nothing else.
	const touch = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
	// No counts from the deployed worker or the snapshot: their late arrival
	// reorders Popular (tested on its own, below).
	await touch.route("**/api/stats/summary", (r) => r.abort());
	await touch.route("**/summary.json", (r) => r.abort());
	const tp = await touch.newPage();
	await tp.goto(site.url("index.html"));
	await tp.waitForSelector(".game-card:visible");
	const tcard = tp.locator('.game-card[data-game="connect4"]').first();
	await tcard.locator("h3").tap();
	const isOpen = () => tcard.evaluate((c) => c.classList.contains("is-open"));
	check("on a phone a tap opens a card's choices, without leaving the page", (await settled(isOpen, Boolean, 3000)) && tp.url().endsWith("index.html?page=games&tab=all"), tp.url());
	const fits = await tcard.locator(".card-play").evaluateAll((as) => as.map((a) => a.getBoundingClientRect()).map((r) => ({ h: Math.round(r.height), right: Math.round(r.right) })));
	check("…two buttons, 44px tall, inside the phone", fits.length === 2 && fits.every((f) => f.h >= 44 && f.right <= 390), fits);
	await tp.locator('.game-card[data-game="neon-bid"] h3').first().tap();
	check("…and opening another card closes the first", !(await settled(isOpen, (open) => !open, 3000)));
	await touch.close();
	// A slow phone: the play counts land after a card was tapped open. The
	// row is not replaced under the finger (it closed the card, or slid
	// another game beneath it); it is redrawn once the card closes, where
	// it had been scrolled to.
	{
		const slow = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
		let release;
		const held = new Promise((r) => (release = r));
		await slow.route("**/api/stats/summary", async (route) => {
			await held;
			await summary(route).catch(() => {});
		});
		await slow.route("**/summary.json", (r) => r.abort());
		const sp = await slow.newPage();
		sp.on("pageerror", (e) => check(`no page error (${e.message})`, false));
		await sp.goto(site.url(ALL));
		await sp.locator('[data-section="popular"] .game-card').first().waitFor({ timeout: TIMEOUT });
		const row = sp.locator('[data-section="popular"] .section-row');
		const before = await row.evaluate((r) => {
			r.scrollLeft = r.children[1].offsetLeft - r.children[0].offsetLeft; // a snap point: the second card first
			const c = r.querySelector('.game-card[data-game="neon-bid"]');
			c.__tapped = true;
			return { ids: r.dataset.ids, x: r.scrollLeft };
		});
		const bid = sp.locator('[data-section="popular"] .game-card[data-game="neon-bid"]');
		await bid.locator("h3").tap();
		release();
		await sp.waitForFunction(() => !!localStorage.getItem("neon.plays"), null, { timeout: TIMEOUT });
		await sp.waitForTimeout(400);
		const during = await row.evaluate((r) => ({ ids: r.dataset.ids, x: r.scrollLeft, open: r.querySelector(".game-card.is-open")?.dataset.game ?? null, same: !!r.querySelector('.game-card[data-game="neon-bid"]').__tapped }));
		check("a card tapped open stays open when the play counts land late (same card, same row, same scroll)", before.x > 0 && during.open === "neon-bid" && during.same && during.ids === before.ids && during.x === before.x, { before, during });
		await bid.tap({ position: { x: 6, y: 6 } }); // its corner: not one of its two buttons
		await sp.waitForFunction(() => document.querySelector('[data-section="popular"] .game-card')?.dataset.game === "lokeshmohanty/sudoku", null, { timeout: TIMEOUT }).catch(() => {});
		const after = await row.evaluate((r) => ({ ids: r.dataset.ids, x: r.scrollLeft, pending: r.dataset.pending ?? null }));
		check("…closed, the row takes the new order (most played first), keeping its scroll", after.ids.startsWith("lokeshmohanty/sudoku undercover connect4") && after.x === before.x && !after.pending, { before, after });
		await slow.close();
	}

	console.log("\nportal: the tabs and the menu on every page");
	// One row: Games · Leaderboards · Community, and ☰ (Lokesh, 2026-11-15:
	// the buttons above the tabs crowded a phone). Community has its own tabs.
	// A device with nothing of its own: ./ is All Games.
	await p.evaluate(() => localStorage.removeItem("neon.recent"));
	const SUBS = { Games: "My Games,All Games", Community: "Collections,Contributors" };
	for (const [page, tab, sub] of [
		["index.html", "Games", "All Games"],
		["./?page=games&tab=mine", "Games", "My Games"],
		["./?page=games&tab=all", "Games", "All Games"],
		["./?page=leaderboard", "Leaderboards", null],
		["./?page=contributors", "Community", "Contributors"],
		["./?page=collections", "Community", "Collections"],
		["./?page=contribute", null, null],
		["./?page=profile", null, null],
	]) {
		await p.goto(site.url(page));
		await p.locator(".site-row").waitFor({ timeout: TIMEOUT });
		const read = () =>
			p.evaluate(() => {
				const box = (s) => document.querySelector(s)?.getBoundingClientRect();
				const list = document.querySelector(".site-menu-list");
				return {
					tabs: [...document.querySelectorAll(".site-tab")].map((t) => t.textContent),
					on: document.querySelector(".site-tab.is-on")?.textContent ?? null,
					subs: [...document.querySelectorAll(".site-subtab")].map((t) => t.textContent),
					subOn: document.querySelector(".site-subtab.is-on")?.textContent ?? null,
					subH: Math.min(...[...document.querySelectorAll(".site-subtab")].map((t) => t.getBoundingClientRect().height)),
					oneRow: new Set([...document.querySelectorAll(".site-tab, .site-menu-btn")].map((n) => Math.round(n.getBoundingClientRect().bottom / 10))).size <= 2 && box(".site-menu-btn").top < box(".site-tab").bottom,
					btn: { w: Math.round(box(".site-menu-btn").width), h: Math.round(box(".site-menu-btn").height), right: Math.round(box(".site-menu-btn").right) },
					open: !list.hidden,
					expanded: document.querySelector(".site-menu-btn").getAttribute("aria-expanded"),
					items: [...list.querySelectorAll(".site-menu-item")].map((i) => ({ text: i.textContent.trim(), href: i.getAttribute("href"), h: Math.round(i.getBoundingClientRect().height) })),
					listBox: list.hidden ? null : { left: Math.round(box(".site-menu-list").left), right: Math.round(box(".site-menu-list").right) },
					sideways: document.documentElement.scrollWidth > innerWidth,
				};
			});
		let nav = await read();
		check(`${page}: tabs Games · Leaderboards · Community${tab ? `, on ${tab}` : ""}`, nav.tabs.join() === "Games,Leaderboards,Community" && nav.on === tab, nav);
		check(`${page}: ${sub ? `${tab}'s tabs ${SUBS[tab].replace(",", " · ")}, on ${sub}, 44px tall` : "no sub-tabs"}`, sub ? nav.subs.join() === SUBS[tab] && nav.subOn === sub && nav.subH >= 44 : nav.subs.length === 0, nav);
		check(`${page}: tabs and ☰ in one row, ☰ 44px at the right, closed`, nav.oneRow && nav.btn.w >= 44 && nav.btn.h >= 44 && nav.btn.right > 340 && !nav.open && nav.expanded === "false", nav);
		await p.locator(".site-menu-btn").click();
		nav = await read();
		const texts = nav.items.map((i) => i.text);
		check(`${page}: ☰ lists Add your game, Theme, account and GitHub, 44px each, inside the phone`, nav.open && nav.expanded === "true" && texts[0] === "Add your game" && texts[1] === "Theme" && /^(Sign in|Profile|.+)$/.test(texts[2]) && texts.at(-1) === "Source on GitHub" && nav.items[0].href === "./?page=contribute" && nav.items.at(-1).href === "https://github.com/lokeshmohanty/games" && nav.items.every((i) => i.h >= 44) && nav.listBox.left >= 0 && nav.listBox.right <= 390, nav);
		check(`${page}: fits the phone`, !nav.sideways);
		await p.keyboard.press("Escape");
		check(`${page}: Esc closes it, focus back on ☰`, await p.evaluate(() => document.querySelector(".site-menu-list").hidden && document.activeElement === document.querySelector(".site-menu-btn")));
	}
	await p.goto(site.url("index.html"));
	await p.locator(".site-menu-btn").click();
	await p.mouse.click(200, 600);
	check("a tap outside closes the menu", await p.evaluate(() => document.querySelector(".site-menu-list").hidden));
	await p.locator(".site-tab", { hasText: "Community" }).click();
	await p.locator(".site-subtab.is-on").waitFor({ timeout: TIMEOUT });
	check("Community opens on Collections", (await p.locator(".site-subtab.is-on").textContent()) === "Collections" && new URL(p.url()).searchParams.get("page") === "collections");
	await p.locator(".site-subtab", { hasText: "Contributors" }).click();
	await p.locator(".person").first().waitFor({ timeout: TIMEOUT });
	check("…and its Contributors tab opens Contributors, Community still on", (await p.locator(".site-subtab.is-on").textContent()) === "Contributors" && (await p.locator(".site-tab.is-on").textContent()) === "Community");

console.log("\nportal: My Games · All Games");
// Lokesh, 2026-11-15: "All favourites land under My Games". The Games tab
// has two sub-tabs with addresses; ./ opens on My Games once this device
// has a favourite or a recent game, decided before the first paint.
{
	/** A phone of its own, with this device's storage set before the first load. */
	const phone = async (storage = {}, { width = 390, height = 844, init = null, counts = null } = {}) => {
		const c = await browser.newContext({ viewport: { width, height }, hasTouch: true, isMobile: true });
		if (init) await c.addInitScript(init);
		// No play counts (unless the test plays them): Popular (and PLAY
		// SOMETHING's pool) in the catalog's order.
		await c.route("**/api/stats/summary", counts ?? ((r) => r.abort()));
		await c.route("**/summary.json", (r) => r.abort());
		const pg = await c.newPage();
		pg.on("pageerror", (e) => check(`no page error (${e.message})`, false));
		await pg.goto(site.url("?page=contribute"));
		await pg.evaluate((s) => {
			for (const [k, v] of Object.entries(s)) localStorage.setItem(k, JSON.stringify(v));
		}, storage);
		return { c, pg };
	};
	const tabOf = (pg) => new URL(pg.url()).searchParams.get("tab");
	const subOn = (pg) => pg.locator(".site-subtab.is-on").textContent({ timeout: TIMEOUT });
	const RECENT = ["connect4", "neon-bid", "undercover", "neon-fission", "lokeshmohanty/sudoku"];

	// The default, by what the device holds.
	for (const [what, storage, want] of [
		["nothing of yours", {}, "all"],
		["a starred game", { "neon.favs": ["connect4"] }, "mine"],
		["only a starred collection", { "neon.favs": ["collection:lokeshmohanty/web-games"] }, "mine"],
		["only a game played", { "neon.recent": ["connect4"] }, "mine"],
	]) {
		const { c, pg } = await phone(storage);
		await pg.goto(site.url("index.html"));
		const on = await subOn(pg);
		check(`./ with ${what}: opens on ${want === "mine" ? "My Games" : "All Games"} (address and sub-tab)`, tabOf(pg) === want && on === (want === "mine" ? "My Games" : "All Games"), { url: pg.url(), on });
		await c.close();
	}
	{
		const { c, pg } = await phone({ "neon.favs": ["connect4"] });
		await pg.goto(site.url("?q=" + encodeURIComponent("tag:quick")));
		await subOn(pg);
		check("…but a search link (./?q=) opens on All Games, searched", tabOf(pg) === "all" && (await pg.locator("[data-search]").inputValue()) === "tag:quick" && (await pg.locator(".games-grid:not([hidden]) .game-card:not([hidden])").count()) > 0, pg.url());
		await c.close();
	}

	// The first paint: index.html's static frame, before any of the app's
	// code runs, already lights the sub-tab that will show — and the drawn
	// row lands exactly on it.
	for (const [storage, want] of [
		[{}, "all"],
		[{ "neon.recent": ["connect4"] }, "mine"],
	]) {
		const { c, pg } = await phone(storage);
		await pg.route(/\/app\/[^/]+\.js(\?|$)/, (r) => r.abort());
		await pg.goto(site.url("index.html"));
		const frame = () =>
			pg.evaluate(() => {
				const box = (n) => {
					if (!n) return null;
					const r = n.getBoundingClientRect();
					return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(",");
				};
				const subs = [...document.querySelectorAll(".site-subtab")];
				return {
					boot: !!document.querySelector(".boot"),
					tabs: [...document.querySelectorAll(".site-tab")].map((t) => `${t.textContent}@${box(t)}`).join(" "),
					subs: subs.map((t) => `${t.textContent}@${box(t)}`).join(" "),
					bg: Object.fromEntries(subs.map((t) => [t.dataset.tab, getComputedStyle(t).backgroundColor])),
					on: document.querySelector(".site-subtab.is-on")?.dataset.tab ?? null,
					h1: box(document.querySelector("h1")),
				};
			});
		const first = await frame();
		await pg.unroute(/\/app\/[^/]+\.js(\?|$)/);
		await pg.goto(site.url("index.html"));
		// The app's own row and heading, not the static frame's: that one has
		// a lit sub-tab too, and the app's heading can follow its nav (a
		// runner read no h1 here, CI run 44143511384).
		await pg.waitForFunction(() => !document.querySelector(".boot") && document.querySelector("[data-nav] .site-subtab.is-on") && document.querySelector("main h1"), null, { timeout: TIMEOUT }).catch(() => {});
		const drawn = await frame();
		const other = want === "mine" ? "all" : "mine";
		check(`first paint (${want === "mine" ? "a game played" : "a first visit"}): the static frame lights ${want === "mine" ? "My Games" : "All Games"}, as the app does`, first.boot && first.bg[want] === drawn.bg[want] && first.bg[other] === drawn.bg[other] && first.bg[want] !== first.bg[other] && drawn.on === want, { first, drawn });
		check("…the same tabs and sub-tabs in the same places, and the title does not move", !drawn.boot && first.tabs === drawn.tabs && first.subs === drawn.subs && first.h1 === drawn.h1, { first, drawn });
		await c.close();
	}

	// The sub-tabs are addresses: Back and Forward move between them.
	{
		const { c, pg } = await phone();
		await pg.goto(site.url("index.html"));
		await pg.locator(".site-subtab", { hasText: "My Games" }).click();
		await pg.locator("[data-my-empty]:not([hidden])").waitFor({ timeout: TIMEOUT });
		const empty = await pg.evaluate(() => ({
			text: document.querySelector("[data-my-empty] p").textContent,
			quick: document.querySelector("[data-my-empty] [data-quick]")?.getAttribute("href"),
			sections: document.querySelectorAll("[data-section]:not([hidden])").length,
			search: document.querySelector(".search").hidden,
		}));
		check("My Games is ./?page=games&tab=mine, and with nothing of yours it says how to star (★, from inside a game)", tabOf(pg) === "mine" && (await subOn(pg)) === "My Games" && /★/.test(empty.text) && /inside/.test(empty.text) && !/card/.test(empty.text) && !empty.sections && empty.search, { url: pg.url(), empty });
		check("…with PLAY SOMETHING (a game's single player) and ALL GAMES", /^\.\/\?game=[^&]+&fresh=1/.test(empty.quick ?? "") && (await pg.locator("[data-my-empty] .my-empty-all").textContent()) === "ALL GAMES", empty.quick);
		await pg.goBack();
		await pg.locator('[data-section="popular"]:not([hidden]) .game-card').first().waitFor({ timeout: TIMEOUT });
		check("Back: All Games again (its address, search and sections)", tabOf(pg) === "all" && (await subOn(pg)) === "All Games" && (await pg.locator(".search").isVisible()) && (await pg.locator("[data-my-empty]").isHidden()), pg.url());
		await pg.goForward();
		await pg.locator("[data-my-empty]:not([hidden])").waitFor({ timeout: TIMEOUT });
		check("Forward: My Games", tabOf(pg) === "mine" && (await subOn(pg)) === "My Games");
		await pg.locator("[data-my-empty] .my-empty-all").click();
		await pg.locator('[data-section="popular"]:not([hidden]) .game-card').first().waitFor({ timeout: TIMEOUT });
		check("…and the empty state's ALL GAMES opens All Games", tabOf(pg) === "all", pg.url());

		// Stars come from inside a game (Lokesh, 2026-11-16: "Only inside
		// games"), not from the cards; each lands in My Games at once.
		check("no star on any card: a game is starred only from inside it", (await pg.locator(".game-card button, .game-card [aria-pressed]").count()) === 0 && !(await pg.locator(".game-card").allTextContents()).some((t) => /[☆★]/.test(t)));
		const favs = () => pg.locator('[data-section="favs"] .game-card').evaluateAll((cs) => cs.map((c) => c.dataset.game).join());
		await pg.evaluate(() => NeonArcade.stats.toggleFav("connect4")); // as the game's ★ does
		check("…a star from a game leaves you where you are", tabOf(pg) === "all");
		await pg.locator(".site-subtab", { hasText: "My Games" }).click();
		await pg.locator('[data-section="favs"]:not([hidden]) .game-card').first().waitFor({ timeout: TIMEOUT });
		check("…and the game is in My Games", (await favs()) === "connect4" && (await pg.locator("[data-my-empty]").isHidden()));
		await pg.evaluate(() => NeonArcade.stats.toggleFav("connect4"));
		check("unstarred, it is gone from My Games at once, and the empty state is back", (await pg.locator('[data-section="favs"]').isHidden()) && (await pg.locator("[data-my-empty]").isVisible()));

		// A card left open on My Games, then All Games, a star changed, and
		// back: the row is current (review 2026-11-16: the open card survived
		// the switch, held its row back, and My Games froze).
		await pg.evaluate(() => ["connect4", "neon-bid"].forEach((id) => NeonArcade.stats.toggleFav(id)));
		await pg.locator('[data-section="favs"] .game-card[data-game="connect4"]').waitFor({ timeout: TIMEOUT });
		await pg.locator('[data-section="favs"] .game-card[data-game="connect4"] h3').tap();
		const opened = await settled(() => pg.locator('[data-section="favs"] .game-card.is-open').count(), (n) => n === 1, 3000);
		await pg.locator(".site-subtab", { hasText: "All Games" }).click();
		await pg.locator('[data-section="popular"]:not([hidden]) .game-card').first().waitFor({ timeout: TIMEOUT });
		await pg.evaluate(() => NeonArcade.stats.toggleFav("connect4"));
		await pg.locator(".site-subtab", { hasText: "My Games" }).click();
		await pg.locator('[data-section="favs"]:not([hidden]) .game-card').first().waitFor({ timeout: TIMEOUT });
		const back = await settled(async () => ({ favs: await favs(), open: await pg.locator(".game-card.is-open").count() }), (b) => b.favs === "neon-bid" && b.open === 0, 5000);
		check("a card left open, a sub-tab away, a star changed: My Games is current on return", opened === 1 && back.favs === "neon-bid" && back.open === 0, { opened, back });
		await c.close();
	}

	// PLAY SOMETHING: a popular game one person can play now, at once.
	{
		const { c, pg } = await phone();
		await pg.goto(site.url(ALL));
		await pg.locator('[data-section="popular"] [data-quick]').waitFor({ timeout: TIMEOUT });
		await pg.evaluate(() => NeonArcade.catalogs);
		const pool = await pg.evaluate(() => {
			const P = NeonArcade.portal;
			const C = NeonArcade.CATALOG;
			const base = C.find((g) => g.id === "connect4");
			const shape = (g) => ({ id: g.id, bots: !!g.bots, local: !!g.local, alone: (g.players?.min ?? g.seats.min) <= 1, runtime: g.runtime });
			const real = P.quickPool().map(shape);
			// The most played, were it so: a Python game and a people-only one.
			const fakes = [{ ...base, id: "py-game", runtime: "python" }, { ...base, id: "people-game", bots: false, local: false }, { ...base, id: "crowd-phone", bots: false, local: true, players: { min: 3, max: 12 } }];
			C.unshift(...fakes);
			const withFakes = P.quickPool().map(shape);
			C.splice(0, fakes.length);
			return { real, withFakes };
		});
		check("its pool: the 5 most played with bots (or one-device and playable alone), no Python game", pool.real.length === 5 && pool.real.every((g) => (g.bots || (g.local && g.alone)) && g.runtime !== "python"), pool.real);
		check("…never a Python game, a people-only game or a one-phone game for a crowd, however popular", pool.withFakes.length === 5 && !pool.withFakes.some((g) => ["py-game", "people-game", "crowd-phone"].includes(g.id)), pool.withFakes);
		const ids = pool.real.map((g) => g.id);
		const q = pg.locator('[data-section="popular"] [data-quick]');
		check("…a pick from that pool", ids.includes(await q.getAttribute("data-game")));
		const box = await q.boundingBox();
		const picked = await q.getAttribute("data-game");
		await q.click();
		await pg.waitForSelector(".game-frame", { timeout: TIMEOUT });
		// Single player: you and the game's bots, nobody else (a game one
		// person can play, Neon Survival, may seat no bot at all).
		const game = await pg.evaluate(() => {
			const room = window.__party.room;
			return { game: window.__party?.game, alone: room.getMembers().every((m) => m.id === room.selfId || m.id.startsWith("bot_")), lobby: !!document.querySelector(".party-choice") };
		});
		check("…one tap starts it in single player: that game, you and its bots only, no lobby", game.game === picked && game.alone && !game.lobby && box.height >= 44, { game, picked, h: box.height });
		await c.close();
	}
	// Never the last visit's pick again: Math.random() always 0 would offer
	// the pool's first game every time, but for that rule.
	{
		const { c, pg } = await phone({}, { init: () => (Math.random = () => 0) });
		const picks = [];
		for (let i = 0; i < 6; i++) {
			await pg.goto(site.url(ALL));
			picks.push(await pg.locator('[data-section="popular"] [data-quick]').getAttribute("data-game", { timeout: TIMEOUT }));
		}
		check("PLAY SOMETHING never offers the last visit's game again (Math.random fixed at 0: 6 visits)", picks.every((id) => !!id) && picks.every((id, i) => i === 0 || id !== picks[i - 1]) && new Set(picks).size === 2, picks);
		await c.close();
	}
	// The pick is chosen once per visit: play counts landing late reorder the
	// pool, never the button under a finger; and the game saved as the last
	// one is the game that was shown.
	{
		let release;
		const held = new Promise((r) => (release = r));
		const { c, pg } = await phone({}, {
			init: () => (Math.random = () => 0.999), // the pool's last game: the first to drop out
			counts: async (route) => {
				await held;
				await summary(route).catch(() => {});
			},
		});
		await pg.goto(site.url(ALL));
		const q = pg.locator('[data-section="popular"] [data-quick]');
		const first = await q.getAttribute("data-game", { timeout: TIMEOUT });
		const poolBefore = await pg.evaluate(() => NeonArcade.portal.quickPool().map((g) => g.id));
		release();
		await pg.waitForFunction(() => !!localStorage.getItem("neon.plays"), null, { timeout: TIMEOUT });
		await pg.waitForTimeout(400);
		const after = await pg.evaluate(() => ({ shown: document.querySelector('[data-section="popular"] [data-quick]').dataset.game, saved: localStorage.getItem("neon.quick"), pool: NeonArcade.portal.quickPool().map((g) => g.id) }));
		check("PLAY SOMETHING keeps its pick when late counts reorder the pool (out of it, even)", after.shown === first && !after.pool.includes(first) && after.saved === first, { first, poolBefore, after });
		await c.close();
	}

	// The layout, at 390x844, on Lokesh's phone (354x696, DPR 3.5) and on
	// the narrowest phone we meet (320x640).
	for (const [width, height] of [
		[390, 844],
		[354, 696],
		[320, 640],
	]) {
		const { c, pg } = await phone({ "neon.recent": RECENT, "neon.favs": ["connect4", "lokeshmohanty/sudoku", "neon-bid", "contributor:lokeshmohanty"] }, { width, height });
		for (const t of ["mine", "all"]) {
			await pg.goto(site.url(`index.html?page=games&tab=${t}`));
			await pg.locator(`[data-section="${t === "mine" ? "favs" : "popular"}"]:not([hidden]) .game-card`).first().waitFor({ timeout: TIMEOUT });
			await pg.evaluate(() => NeonArcade.catalogs);
			const L = await pg.evaluate(() => {
				const shown = (n) => n.getClientRects().length > 0 && getComputedStyle(n).visibility !== "hidden";
				const r = (n) => n.getBoundingClientRect();
				const targets = [...document.querySelectorAll(".party-banner .play-btn, .site-tab, .site-subtab, .site-menu-btn, .recent-game, .fav-more-item, [data-quick], .search input, .my-empty-all")]
					.filter(shown)
					.map((n) => ({ what: n.className || n.tagName, text: n.textContent.trim().slice(0, 20), h: Math.round(r(n).height) }));
				// Every line a card says, on the cards the first rows show.
				const cards = [...document.querySelectorAll(".portal-section:not([hidden]) .game-card")].filter(shown);
				const text = cards
					.flatMap((card) => [...card.querySelectorAll("h3, p, .card-play")])
					.filter((n) => shown(n) && n.textContent.trim())
					.map((n) => ({ what: n.className || n.tagName, size: parseFloat(getComputedStyle(n).fontSize) }));
				const row = document.querySelector(".portal-section:not([hidden]) .section-row");
				const inRow = [...row.children].map(r);
				const meta = cards[0].querySelector(".game-meta");
				const list = document.querySelector(".recent:not([hidden]) .recent-list");
				let recent = null;
				if (list) {
					const chips = [...list.children];
					list.scrollLeft = list.scrollWidth;
					const end = Math.round(r(chips.at(-1)).right);
					list.scrollLeft = 0;
					recent = {
						left: Math.round(r(list).left),
						right: Math.round(r(list).right),
						chip: Math.round(r(chips[0]).left),
						heading: Math.round(r(list.previousElementSibling).left),
						scrolls: list.scrollWidth > list.clientWidth,
						end,
						bar: getComputedStyle(list).scrollbarWidth,
						barH: list.offsetHeight - list.clientHeight,
					};
				}
				const search = document.querySelector(".search:not([hidden]) input");
				return {
					vw: innerWidth,
					sideways: document.documentElement.scrollWidth > innerWidth,
					targets,
					text,
					rowWhole: inRow.filter((b) => b.left >= 0 && b.right <= innerWidth).length,
					rowPeeks: inRow.some((b) => b.left < innerWidth && b.right > innerWidth),
					rowEdges: [Math.round(r(row).left), Math.round(r(row).right)],
					card: Math.round(inRow[0].left),
					metaLines: Math.round(r(meta).height / parseFloat(getComputedStyle(meta).fontSize)),
					recent,
					search: search ? Math.round(r(search).left) : null,
					title: Math.round(r(document.querySelector(".portal-section:not([hidden]) .section-title")).left),
					// PLAY SOMETHING where this sub-tab shows it: Popular's heading, or Recently played's.
					quick: [...document.querySelectorAll("[data-quick]")].filter(shown).map((a) => ({ where: a.closest("[data-section], [data-recent]")?.dataset.section ?? "recent", h: Math.round(r(a).height), left: Math.round(r(a).left), right: Math.round(r(a).right), game: a.dataset.game })),
				};
			});
			const at = `${width}x${height} ${t === "mine" ? "My Games" : "All Games"}`;
			check(`${at}: no sideways scroll`, !L.sideways);
			check(`${at}: every tap target 44px tall (START A PARTY, JOIN WITH A CODE, sub-tabs, chips, PLAY SOMETHING…)`, L.targets.length >= 8 && L.targets.every((x) => x.h >= 44), L.targets.filter((x) => x.h < 44));
			check(`${at}: every line on a card 12px or more`, L.text.length > 0 && L.text.every((x) => x.size >= 12), L.text.filter((x) => x.size < 12));
			check(`${at}: …and the meta line still on one line`, L.metaLines <= 1, L.metaLines);
			check(`${at}: a row is two whole cards and the edge of the next, scrolling to the screen's edges`, L.rowWhole === 2 && L.rowPeeks && L.rowEdges[0] === 0 && L.rowEdges[1] === L.vw, L);
			check(`${at}: the cards line up with their heading`, Math.abs(L.card - L.title) <= 1, { card: L.card, title: L.title });
			if (t === "all") check(`${at}: the search lines up with the cards`, Math.abs(L.search - L.card) <= 1, { search: L.search, card: L.card });
			if (t === "mine") {
				const R = L.recent;
				check(`${at}: Recently played lines up with the cards and its heading`, !!R && Math.abs(R.chip - L.card) <= 1 && Math.abs(R.heading - L.card) <= 1, { R, card: L.card });
				check(`${at}: …scrolls to the screen's edges, its last chip all the way in view`, !!R && R.left === 0 && R.right === L.vw && (!R.scrolls || R.end <= L.vw), R);
				check(`${at}: PLAY SOMETHING for a returning player too, in Recently played's heading, 44px and on screen`, L.quick.length === 1 && L.quick[0].where === "recent" && L.quick[0].h >= 44 && L.quick[0].left >= 0 && L.quick[0].right <= L.vw && !!L.quick[0].game, L.quick);
				check(`${at}: …with no scrollbar, like the card rows`, !!R && R.bar === "none" && R.barH === 0, R);
			}
		}
		await c.close();
	}
	// My Games with favourites but nothing played yet: PLAY SOMETHING in ★ Favourites' heading.
	for (const width of [390, 354, 320]) {
		const { c, pg } = await phone({ "neon.favs": ["connect4", "neon-bid"] }, { width, height: 700 });
		await pg.goto(site.url("index.html"));
		await pg.locator('[data-section="favs"]:not([hidden]) .game-card').first().waitFor({ timeout: TIMEOUT });
		const q = await pg.evaluate(() =>
			[...document.querySelectorAll("[data-quick]")]
				.filter((a) => a.getClientRects().length)
				.map((a) => {
					const r = a.getBoundingClientRect();
					return { where: a.closest("[data-section]")?.dataset.section ?? null, h: Math.round(r.height), left: Math.round(r.left), right: Math.round(r.right), sideways: document.documentElement.scrollWidth > innerWidth };
				}),
		);
		check(`${width}px My Games, favourites only: PLAY SOMETHING in ★ Favourites' heading, 44px, on screen`, tabOf(pg) === "mine" && q.length === 1 && q[0].where === "favs" && q[0].h >= 44 && q[0].left >= 0 && q[0].right <= width && !q[0].sideways, q);
		await c.close();
	}
}

	console.log("\nportal: contributors");
	// The play counts, played here (the server's /api/stats/summary): the
	// arcade's own repo is played more than web-games.
	const PLAYS = { connect4: 500, "neon-bid": 1, "lokeshmohanty/battleship": 100 };
	await ctx.route("**/api/stats/summary", (route) =>
		route.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ games: Object.fromEntries(Object.entries(PLAYS).map(([g, played]) => [g, { played }])) }) }),
	);
	const repoGames = await p.evaluate(() => Object.fromEntries(["lokeshmohanty/games", "lokeshmohanty/web-games"].map((r) => [r, NeonArcade.CATALOG.filter((g) => g.repo === `https://github.com/${r}`).length])));
	await p.goto(site.url("?page=contributors"));
	await p.locator(".person").first().waitFor({ timeout: TIMEOUT });
	await p.waitForFunction(() => !document.querySelector(".person-plays")?.textContent.startsWith("…"), null, { timeout: TIMEOUT });
	const readPerson = () =>
		p.evaluate(() => {
			const c = document.querySelector('.person[data-login="lokeshmohanty"]');
			return {
				name: c?.querySelector("h2")?.textContent,
				bio: c?.querySelector(".person-bio")?.textContent,
				facts: c?.querySelector(".person-facts")?.textContent,
				cols: [...(c?.querySelectorAll(".person-collection") ?? [])].map((li) => ({
					repo: li.dataset.repo,
					href: li.querySelector(".person-collection-name")?.getAttribute("href"),
					gh: li.querySelector(".person-collection-gh")?.getAttribute("href"),
					meta: li.querySelector(".person-meta")?.textContent,
					update: !!li.querySelector(".person-update button"),
				})),
				see: c?.querySelector(".person-links a")?.getAttribute("href"),
				star: c?.querySelector(".fav-star")?.getAttribute("aria-pressed"),
			};
		});
	const person = await readPerson();
	const games = repoGames["lokeshmohanty/games"];
	const arcadeGames = repoGames["lokeshmohanty/web-games"];
	check("a card from contributor.json: name and bio", person.name === "Lokesh Mohanty" && !!person.bio, person);
	check("…one person, both collections (games repos), most played first", person.cols.map((c) => c.repo).join() === "lokeshmohanty/games,lokeshmohanty/web-games", person.cols);
	check("…each with its games and plays", person.cols[0]?.meta === `${games} games · 501 plays` && person.cols[1]?.meta === `${arcadeGames} games · 100 plays`, person.cols);
	check("…linking to its games in the portal, and to GitHub", person.cols[1]?.href === "./?q=from%3Alokeshmohanty%2Fweb-games" && person.cols[1]?.gh === "https://github.com/lokeshmohanty/web-games", person.cols[1]);
	check("…CHECK FOR UPDATES on a pinned collection only (the arcade's own has no pin)", !person.cols[0]?.update && person.cols[1]?.update, person.cols);
	check("…and their games' total plays", person.facts === `${games + arcadeGames} games · 601 plays · 2 collections`, person.facts);
	check("…SEE THEIR GAMES opens the portal searched by author", person.see === "./?q=author%3Alokeshmohanty", person.see);
	check("…fits the phone", await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
	await p.locator('.person[data-login="lokeshmohanty"] .fav-star').click();
	check("★ makes a contributor a favourite", (await readPerson()).star === "true" && (await p.evaluate(() => NeonArcade.stats.isFav("contributor:lokeshmohanty"))));
	await p.reload();
	await p.locator(".person").first().waitFor({ timeout: TIMEOUT });
	check("…which a reload keeps", (await readPerson()).star === "true");
	await p.locator('.person[data-login="lokeshmohanty"] .fav-star').click();
	check("…and ★ again forgets", (await readPerson()).star === "false" && !(await p.evaluate(() => NeonArcade.stats.favs().length)));
	// Starred first: two people from the catalogs, the second one starred.
	const firstStarred = await p.evaluate(() => {
		const C = NeonArcade.collections;
		const people = [{ login: "a" }, { login: "b" }];
		return C.favFirst(people, (c) => c.login === "b").map((c) => c.login).join();
	});
	check("…a starred contributor comes first", firstStarred === "b,a", firstStarred);
	await p.locator(".person-links a", { hasText: "SEE THEIR GAMES" }).first().click();
	await p.waitForSelector(".game-card:visible");
	check("…which lists their games", (await p.locator("[data-search]").inputValue()) === "author:lokeshmohanty" && (await shown()).length > 0);
	await p.goto(site.url("?page=contributors"));
	await p.locator('.person-collection[data-repo="lokeshmohanty/web-games"] .person-collection-name').click();
	await p.locator(".game-card:visible").first().waitFor({ timeout: TIMEOUT });
	check("a collection's name lists its games (from:owner/repo)", (await p.locator("[data-search]").inputValue()) === "from:lokeshmohanty/web-games" && new Set(await shown()).size === arcadeGames, await shown());

	console.log("\nportal: collections");
	await p.goto(site.url("./?page=collections"));
	await p.locator(".collection").first().waitFor({ timeout: TIMEOUT });
	await p.waitForFunction(() => !document.querySelector(".collection-plays")?.textContent.startsWith("…"), null, { timeout: TIMEOUT });
	const readCols = () =>
		p.evaluate(() =>
			[...document.querySelectorAll(".collection")].map((c) => ({
				repo: c.dataset.repo,
				name: c.querySelector("h2")?.textContent,
				owner: c.querySelector(".collection-owner")?.textContent,
				meta: c.querySelector(".collection-meta")?.textContent,
				previews: c.querySelectorAll(".collection-preview").length,
				names: c.querySelector(".collection-games")?.textContent ?? "",
				see: c.querySelector(".collection-links a")?.getAttribute("href"),
				star: c.querySelector(".fav-star")?.getAttribute("aria-pressed"),
			})),
		);
	let cols = await readCols();
	check("every collection, most played first (the summary's counts)", cols.map((c) => c.repo).join() === "lokeshmohanty/games,lokeshmohanty/web-games", cols.map((c) => c.repo));
	check("…each: its name, owner, games and plays", cols[1]?.name === "web-games" && cols[1]?.owner === "@lokeshmohanty" && cols[1]?.meta === `${arcadeGames} games · 100 plays` && cols[0]?.meta === `${games} games · 501 plays`, cols);
	check("…a few posters and game names", cols.every((c) => c.previews > 0 && c.previews <= 3) && cols[1]?.names.includes("Battleship"), cols);
	check("…and a link to its games: the portal searched by from:owner/repo", cols[1]?.see === "./?q=from%3Alokeshmohanty%2Fweb-games", cols[1]?.see);
	const sorted = await p.evaluate(() => {
		const g = (id, repo) => ({ id, repo: `https://github.com/${repo}` });
		const catalog = [g("a1", "z/zeta"), g("b1", "y/beta"), g("c1", "x/alpha"), g("c2", "x/alpha")];
		const list = NeonArcade.collections.list(catalog, [{ login: "w", repos: ["https://github.com/w/empty"], pins: {} }], { games: { a1: { played: 5 }, b1: { played: 9 }, c1: { played: 2 }, c2: { played: 3 } } });
		return list.map((c) => `${c.repo}:${c.plays}`).join();
	});
	check("…sorted by plays, ties by name; a repo with no game listed still shows", sorted === "y/beta:9,x/alpha:5,z/zeta:5,w/empty:0", sorted);
	const layout = await p.evaluate(() => ({
		sideways: document.documentElement.scrollWidth > innerWidth,
		star: [...document.querySelectorAll(".collection .fav-star")].map((b) => b.getBoundingClientRect()).every((r) => r.width >= 44 && r.height >= 44 && r.right <= innerWidth),
		top: document.querySelector(".view-collections h1").getBoundingClientRect().top >= document.querySelector(".site-subtabs").getBoundingClientRect().bottom,
	}));
	check("…fits the phone: no sideways scroll, ★ 44px, nothing under the bar", !layout.sideways && layout.star && layout.top, layout);
	await p.locator('.collection[data-repo="lokeshmohanty/web-games"] .fav-star').click();
	cols = await readCols();
	check("★ makes a collection a favourite, and puts it first", cols[0]?.repo === "lokeshmohanty/web-games" && cols[0]?.star === "true" && cols[1]?.star === "false", cols.map((c) => [c.repo, c.star]));
	check("…kept as collection:owner/repo beside the games' plain ids", await p.evaluate(() => JSON.stringify(NeonArcade.stats.favs()) === '["collection:lokeshmohanty/web-games"]'));
	await p.reload();
	await p.locator(".collection").first().waitFor({ timeout: TIMEOUT });
	cols = await readCols();
	check("…which a reload keeps", cols[0]?.repo === "lokeshmohanty/web-games" && cols[0]?.star === "true", cols.map((c) => [c.repo, c.star]));
	await p.locator('.collection[data-repo="lokeshmohanty/web-games"] .fav-star').click();
	cols = await readCols();
	check("…and ★ again puts it back in plays order", cols[0]?.repo === "lokeshmohanty/games" && cols.every((c) => c.star === "false"), cols.map((c) => [c.repo, c.star]));
	await p.locator('.collection[data-repo="lokeshmohanty/web-games"] .collection-links a', { hasText: "SEE ITS GAMES" }).click();
	await p.locator(".game-card:visible").first().waitFor({ timeout: TIMEOUT });
	check("SEE ITS GAMES lists that collection's games, in the page", (await p.locator("[data-search]").inputValue()) === "from:lokeshmohanty/web-games" && new Set(await shown()).size === arcadeGames, await shown());
	await p.locator("[data-search]").fill("from:lokeshmohanty/games");
	check("…and from:lokeshmohanty/games the arcade's own", new Set(await shown()).size === games, await shown());

	console.log("\nportal: add your game");
	await p.goto(site.url("?page=contribute"));
	await p.locator("[data-guide] h1").waitFor({ timeout: TIMEOUT });
	const guide = await p.evaluate(() => ({
		h1: document.querySelector("[data-guide] h1").textContent,
		h2: [...document.querySelectorAll("[data-guide] h2")].map((h) => h.textContent),
		code: document.querySelectorAll("[data-guide] pre code").length,
		sdk: document.querySelector('[data-guide] a[href$="docs/sdk-v2.md"]')?.getAttribute("href"),
		examples: [...document.querySelectorAll('[data-guide] a[href*="sdk/v2/examples/tic-tac-toe-"]')].map((a) => a.getAttribute("href").replace(/.*\/tic-tac-toe-/, "")),
		plays: [...document.querySelectorAll('[data-guide] a[href*="?game=tic-tac-toe-"]')].map((a) => new URL(a.href).searchParams.get("game")),
		local: document.querySelector('[data-guide] a[href="./?page=contributors"]') !== null,
	}));
	check("the guide is CONTRIBUTING.md, rendered", guide.h1 === "Putting your game in the arcade" && guide.h2.length >= 4 && guide.code >= 3, guide);
	check("…repo files link to GitHub, site pages stay here", guide.sdk === "https://github.com/lokeshmohanty/games/blob/main/docs/sdk-v2.md" && guide.local, guide);
	// Read on GitHub, "./?page=…" would resolve to github.com/…/blob/main/?page=…;
	// so the source names site pages by the live address, which the renderer
	// turns back into this site's own view (lib/markdown.js).
	const contributing = readFileSync(new URL("../CONTRIBUTING.md", import.meta.url), "utf8");
	check("…and CONTRIBUTING.md writes site pages as live addresses, so they work on GitHub", !/\]\(\.?\/?\?page=/.test(contributing) && contributing.includes("](https://www.lokeshmohanty.in/games/?page=contributors)"));
	check("…and it lists the seven examples: each one's code on GitHub and a link to play it", guide.examples.join() === "js,html,ts,rust,c,go,python" && guide.plays.join() === "tic-tac-toe-js,tic-tac-toe-html,tic-tac-toe-ts,tic-tac-toe-rust,tic-tac-toe-c,tic-tac-toe-go,tic-tac-toe-python", guide);
	const unsafe = await p.evaluate(() =>
		NeonArcade.markdown.render('<img src=x onerror=alert(1)> [x](javascript:alert(1)) **b** `<b>`\n\n```\n<script>\n```'),
	);
	check("the renderer lets no HTML or javascript: link through", !/<img|<script|javascript:/i.test(unsafe) && /<strong>b<\/strong>/.test(unsafe), unsafe);
	// One page (docs/spa.md): the guide's site link moves in-app, and Back
	// draws the guide again in the same document.
	await p.evaluate(() => (window.__samePage = true));
	await p.locator('[data-guide] a[href="./?page=contributors"]').first().click();
	await p.locator(".person").first().waitFor({ timeout: TIMEOUT });
	await p.goBack();
	await p.locator("[data-guide] h1").waitFor({ timeout: TIMEOUT });
	check("…its link to Contributors and Back again never reload the page", await p.evaluate(() => window.__samePage === true && new URLSearchParams(location.search).get("page") === "contribute"));
	console.log("\nportal: proposing games (GitHub's own page, filled in)");
	// GitHub's API, played here: a new repo with two games, and web-games
	// moved past its pin.
	const NEW = "ada/minis";
	const HEAD = "b".repeat(40);
	await ctx.route("https://api.github.com/**", (route) => {
		const u = new URL(route.request().url());
		const json = (o) => route.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(o) });
		if (u.pathname.endsWith("/commits/HEAD")) return json({ sha: HEAD });
		if (u.pathname.includes("/git/trees/")) return json({ tree: [{ type: "blob", path: "chess/game.json" }, { type: "blob", path: "go/game.json" }, { type: "blob", path: "README.md" }] });
		return route.fulfill({ status: 404, body: "{}" });
	});
	await p.goto(site.url("?page=contribute"));
	await p.locator("[data-guide] h1").waitFor({ timeout: TIMEOUT });
	check("Propose your games sits at the bottom, after the guide", await p.evaluate(() => {
		const guide = document.querySelector("[data-guide]");
		const form = document.querySelector(".propose");
		return !!(guide.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING);
	}));
	await p.locator("[data-repo]").fill(NEW);
	await p.locator("[data-propose] button").click();
	const open = p.locator("[data-propose-out] a", { hasText: "OPEN ON GITHUB" });
	await open.waitFor({ timeout: TIMEOUT });
	const href = new URL(await open.getAttribute("href"));
	const value = href.searchParams.get("value") ?? "";
	check("a new repo opens GitHub's new-file page in the arcade's registry", href.origin + href.pathname === "https://github.com/lokeshmohanty/games/new/main" && href.searchParams.get("filename") === `registry/${NEW}.json`, href.href);
	check("…filled in: the repo, its head commit, every folder with a game.json", value.includes(`"https://github.com/${NEW}"`) && value.includes(HEAD) && value.includes('["chess", "go"]'), value);
	await p.locator("[data-repo]").fill("https://github.com/lokeshmohanty/web-games");
	await p.locator("[data-propose] button").click();
	const pin = p.locator("[data-propose-out] a", { hasText: "COPY THE COMMIT & OPEN THE PIN" });
	await pin.waitFor({ timeout: TIMEOUT });
	check("a pinned repo that moved opens its pin's edit page, with the commit to paste", (await pin.getAttribute("href")) === "https://github.com/lokeshmohanty/games/edit/main/registry/lokeshmohanty/web-games.json" && (await p.locator("[data-propose-out] pre").textContent()) === HEAD);
	await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: site.base });
	const [tab] = await Promise.all([ctx.waitForEvent("page"), pin.click()]);
	await tab.close();
	check("…and one tap copies the new commit as it opens the page", (await p.evaluate(() => navigator.clipboard.readText())) === HEAD);
	check("…with the three steps to paste it", (await p.locator(".propose-steps li").count()) === 3);
	await p.goto(site.url("?page=contributors"));
	await p.locator(".person-update button").first().click();
	const upd = p.locator(".person-update-out a", { hasText: "Copy the commit" });
	check("Contributors: CHECK FOR UPDATES offers the same for a moved repo", await upd.waitFor({ timeout: TIMEOUT }).then(() => true, () => false));
	check("…nobody's pull request is opened for them: every link is GitHub's own page", /github\.com\/lokeshmohanty\/games\/edit\//.test(await upd.getAttribute("href")));

	console.log("\nportal: one fetch per preview clip");
	// A game sits in several sections at once, a card in each: its clip is
	// fetched once and shared (lib/portal.js clip). Measured with the HTTP
	// cache off, as on Lokesh's phone, where each card fetched it again
	// (neon-bid.webm three times, 2026-11-15); the cache did not save it either.
	const cp = await ctx.newPage();
	const cdp = await ctx.newCDPSession(cp);
	await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
	const clipRequests = {};
	cp.on("request", (r) => {
		const url = r.url();
		if (!url.startsWith("blob:") && /\.(webm|mp4)$/.test(new URL(url).pathname)) clipRequests[new URL(url).pathname] = (clipRequests[new URL(url).pathname] ?? 0) + 1;
	});
	await cp.goto(site.url("index.html"));
	await cp.waitForSelector(".game-card:visible");
	await cp.evaluate(() => NeonArcade.catalogs);
	// A clip plays (not paused) from play(), before its fetch and decode
	// have landed: until every playing one has a frame to show.
	const firstScreen = await settled(
		() =>
			cp.evaluate(() =>
				[...document.querySelectorAll("video.card-preview")]
					.filter((v) => !v.paused)
					.map((v) => ({ game: v.closest(".game-card").dataset.game, src: v.currentSrc, poster: !!v.poster, ready: v.readyState })),
			),
		(vs) => vs.length > 0 && vs.every((v) => v.poster && v.src.startsWith("blob:") && v.ready >= 2),
		15_000,
	);
	check("at 390x844 the first screen plays its previews, over their posters", firstScreen.length > 0 && firstScreen.every((v) => v.poster && v.src.startsWith("blob:") && v.ready >= 2), firstScreen);
	await cp.evaluate(async () => {
		for (const c of document.querySelectorAll(".game-card")) {
			c.scrollIntoView();
			await new Promise((r) => setTimeout(r, 80));
		}
	});
	await cp.waitForTimeout(1500);
	const twice = Object.entries(clipRequests).filter(([, n]) => n > 1);
	const shared = await cp.evaluate(() => {
		const by = {};
		for (const v of document.querySelectorAll("video.card-preview[src]")) (by[v.closest(".game-card").dataset.game] ??= new Set()).add(v.getAttribute("src"));
		const cards = (id) => document.querySelectorAll(`.game-card[data-game="${CSS.escape(id)}"] video.card-preview[src]`).length;
		return Object.entries(by).filter(([id]) => cards(id) > 1).map(([id, srcs]) => [id, cards(id), srcs.size]);
	});
	check("every card scrolled past: each clip fetched once, however many sections show its game", Object.keys(clipRequests).length >= 5 && !twice.length, { fetched: Object.keys(clipRequests).length, twice });
	check("…and a game in several sections plays one shared copy in all of them", shared.length > 0 && shared.every(([, , srcs]) => srcs === 1), shared);
	await cp.close();

	console.log("\nportal: previews when no video plays");
	// Every video fails (offline, or a browser that plays neither format):
	// each card shows its ~5 KB poster, still — never the 0.4–1 MB gif.
	const vp = await ctx.newPage();
	const gifs = [];
	await vp.route(/\.(webm|mp4)$/, (route) => route.abort());
	vp.on("request", (r) => r.url().endsWith(".gif") && gifs.push(r.url()));
	await vp.goto(site.url(ALL));
	await vp.waitForSelector(".game-card:visible");
	await vp.evaluate(async () => {
		for (const c of document.querySelectorAll(".game-card")) {
			c.scrollIntoView();
			await new Promise((r) => setTimeout(r, 60));
		}
	});
	const posters = await vp
		.waitForFunction(() => !document.querySelector("video.card-preview") && [...document.querySelectorAll("img.card-preview")].every((i) => /\.webp$|placeholder/.test(i.src)), null, { timeout: TIMEOUT })
		.then(() => true, () => false);
	check("a card whose videos fail shows its poster", posters, await vp.evaluate(() => [...document.querySelectorAll(".card-preview")].map((e) => e.tagName + " " + (e.currentSrc || e.src || "")).slice(0, 4)));
	check("…and no gif is downloaded instead", !gifs.length, gifs.slice(0, 3).join(", "));
	await vp.close();
} catch (err) {
	check(`unexpected: ${err.message.split("\n")[0]}`, false);
} finally {
	await browser.close();
	site.stop();
}
console.log(failures ? `\n${failures} portal check(s) failed` : "\nall portal checks passed");
process.exit(failures ? 1 : 0);
