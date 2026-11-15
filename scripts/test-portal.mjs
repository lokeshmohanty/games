// scripts/test-portal.mjs — the home screen's sections and search, the bar
// and tabs on every page, the Contributors and Collections pages and the
// add-your-game guide, at 390x844.

import { existsSync, globSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { serve } from "./serve.mjs";

const require = createRequire(import.meta.url);
const TIMEOUT = 20_000;
let failures = 0;
const check = (label, ok, detail = "") => {
	console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
	if (!ok) failures++;
};
const pw = require(
	[join(homedir(), ".cache", "game-previews", "node_modules", "playwright"), ...globSync(join(homedir(), ".npm", "_npx", "*", "node_modules", "playwright"))].find(existsSync),
);
const chrome = [process.env.CHROME, "/run/current-system/sw/bin/google-chrome-stable", "/run/current-system/sw/bin/chromium", "/usr/bin/google-chrome"].filter(Boolean).find(existsSync);
const site = await serve(8740);
const browser = await pw.chromium.launch({ executablePath: chrome, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const p = await ctx.newPage();
p.on("pageerror", (e) => check(`no page error (${e.message})`, false));
// The search's results: one grid in place of the home screen's sections.
const shown = () => p.evaluate(() => [...document.querySelectorAll(".games-grid:not([hidden]) .game-card:not([hidden]) h3")].map((h) => h.textContent));

try {
	console.log("\nportal: the home screen");
	// The play counts, played here (the server's /api/stats/summary). An
	// example played most of all is still no contender for Popular.
	const HOME_PLAYS = { "lokeshmohanty/sudoku": 50, undercover: 40, connect4: 30, "tic-tac-toe-js": 999 };
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
	check("no favourites: the section is hidden; then Popular and the categories, in order", h.order.join() === "popular,arcade,party,strategy,solo,examples", h.order);
	check("…titled Popular, Arcade, Party, Strategy, Puzzle / Single player, Examples", h.titles.join() === "Popular,Arcade,Party,Strategy,Puzzle / Single player,Examples", h.titles);
	check("Popular: 3 to 5 games", h.rows.popular.length >= 3 && h.rows.popular.length <= 5, h.rows.popular);
	const nonExamples = h.catalog.filter((g) => !g.cats.every((c) => c === "examples")).map((g) => g.id);
	check("…the most played first, then the catalog's order; no examples", h.rows.popular.join() === ["lokeshmohanty/sudoku", "undercover", "connect4", ...nonExamples.filter((id) => !["lokeshmohanty/sudoku", "undercover", "connect4"].includes(id))].slice(0, 5).join(), h.rows.popular);
	const belongs = { arcade: (g) => g.cats.includes("arcade"), party: (g) => g.cats.includes("party"), strategy: (g) => g.cats.includes("strategy"), solo: (g) => g.cats.includes("puzzle") || g.min <= 1, examples: (g) => g.cats.includes("examples") };
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
		examples: (({ scrollWidth, clientWidth }) => ({ scrollWidth, clientWidth }))(document.querySelector('[data-section="examples"] .section-row')),
		inside: [...document.querySelectorAll(".portal-section")].every((s) => s.getBoundingClientRect().right <= innerWidth && s.getBoundingClientRect().left >= 0),
		cards: [...document.querySelectorAll(".game-card")].every((c) => c.dataset.tags.trim().length > 0),
	}));
	check("on a phone a section is one row that scrolls sideways inside itself", rows.examples.scrollWidth > rows.examples.clientWidth, rows.examples);
	check("…and the page never does", !rows.sideways && rows.inside, rows);
	// Only what is on screen plays: a card per game per section is dozens.
	await p.waitForTimeout(1500);
	const playing = await p.evaluate(() =>
		[...document.querySelectorAll("video.card-preview")].map((v) => {
			const r = v.getBoundingClientRect();
			const seen = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)) * Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
			return { playing: !v.paused, half: r.width * r.height > 0 && seen / (r.width * r.height) >= 0.45 };
		}),
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
	check("no counts at all (offline, first visit): the catalog's first five, examples aside", (await home()).rows.popular.join() === nonExamples.slice(0, 5).join(), (await home()).rows.popular);
	await p.unroute("**/api/stats/summary");
	await p.unroute("**/summary.json");
	// Favourites: games starred (lib/stats.js), in the order starred; a starred
	// contributor or collection is a search for its games.
	await p.evaluate(() => localStorage.setItem("neon.favs", JSON.stringify(["lokeshmohanty/sudoku", "connect4", "gone-game", "contributor:lokeshmohanty", "collection:lokeshmohanty/web-games"])));
	await p.reload();
	await p.waitForSelector('[data-section="favs"]:not([hidden]) .game-card');
	h = await home();
	check("favourites first, above Popular", h.order.join() === "favs,popular,arcade,party,strategy,solo,examples", h.order);
	check("…the games starred, in that order (a game no longer listed left out)", h.rows.favs.join() === "lokeshmohanty/sudoku,connect4", h.rows.favs);
	const more = await p.locator('[data-section="favs"] .fav-more-item').allTextContents();
	check("…and the contributors and collections starred", more.join() === "lokeshmohanty,lokeshmohanty/web-games", more);
	await p.locator('[data-section="favs"] .fav-more-item', { hasText: "lokeshmohanty/web-games" }).click();
	check("…a tap lists that collection's games, as a search", (await p.locator("[data-search]").inputValue()) === "from:lokeshmohanty/web-games" && (await shown()).length > 0 && (await shown()).every((t) => !t.startsWith("Tic Tac")), await shown());
	await p.locator("[data-search]").fill("");
	await p.evaluate(() => localStorage.removeItem("neon.favs"));
	await p.reload();
	await p.waitForSelector(".game-card:visible");
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
	check("type:duel — the head-to-head games, examples among them", (await search("type:duel")).includes("Battleship") && (await search("type:duel")).includes("Connect 4") && !(await search("type:duel")).includes("Undercover"));
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
	await p.goto(site.url("index.html"));
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
	await p.waitForTimeout(250);
	check("a mouse hovering shows them", await visible());
	await p.mouse.move(1, 1);
	await p.keyboard.press("Tab");
	await c4card.focus();
	await p.waitForTimeout(250);
	check("…and so does keyboard focus", await visible());
	await c4card.locator(".card-play", { hasText: "SINGLE PLAYER" }).click();
	await p.waitForSelector(".game-frame", { timeout: TIMEOUT });
	check("SINGLE PLAYER goes straight into the game, bots seated: no second choice, no START", (await p.locator(".party-choice").count()) === 0 && (await p.evaluate(() => window.__party.room.getMembers().some((m) => m.id.startsWith("bot_")))));
	check("…without waiting on the room server: no party code yet", await p.evaluate(() => !document.querySelector(".party-code-digits")));
	check("…and the address forgets the mode, for a reload", !new URL(p.url()).searchParams.has("mode"), p.url());
	await p.goto(site.url("index.html"));
	await p.waitForSelector(".game-card:visible");
	await p.locator('.game-card[data-game="connect4"]').first().hover();
	await p.locator('.game-card[data-game="connect4"]').first().locator(".card-play", { hasText: "MULTI-PLAYER" }).click();
	await p.locator("button", { hasText: "INVITE A FRIEND" }).first().waitFor({ timeout: TIMEOUT });
	check("MULTI-PLAYER lands on the friends view (invite, and the code when there is a server)", (await p.locator(".party-choice").count()) === 0);
	// A phone: no hover, so the first tap opens the choices and nothing else.
	const touch = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
	const tp = await touch.newPage();
	await tp.goto(site.url("index.html"));
	await tp.waitForSelector(".game-card:visible");
	const tcard = tp.locator('.game-card[data-game="connect4"]').first();
	await tcard.locator("h3").tap();
	await tp.waitForTimeout(250);
	check("on a phone a tap opens a card's choices, without leaving the page", (await tcard.evaluate((c) => c.classList.contains("is-open"))) && tp.url().endsWith("index.html"));
	const fits = await tcard.locator(".card-play").evaluateAll((as) => as.map((a) => a.getBoundingClientRect()).map((r) => ({ h: Math.round(r.height), right: Math.round(r.right) })));
	check("…two buttons, 44px tall, inside the phone", fits.length === 2 && fits.every((f) => f.h >= 44 && f.right <= 390), fits);
	await tp.locator('.game-card[data-game="neon-bid"] h3').first().tap();
	check("…and opening another card closes the first", !(await tcard.evaluate((c) => c.classList.contains("is-open"))));
	await touch.close();

	console.log("\nportal: the bar and tabs on every page");
	for (const [page, tab] of [
		["index.html", "Games"],
		["leaderboard.html", "Leaderboards"],
		["contributors.html", "Contributors"],
		["./?page=collections", "Collections"],
		["contribute.html", null],
		["profile.html", null],
	]) {
		await p.goto(site.url(page));
		await p.locator(".site-bar").waitFor({ timeout: TIMEOUT });
		const nav = await p.evaluate(() => ({
			gh: document.querySelector('.site-left a[href="https://github.com/lokeshmohanty/games"]') !== null,
			add: document.querySelector('.site-left a[href="contribute.html"]')?.textContent,
			on: document.querySelector(".site-tab.is-on")?.textContent ?? null,
			tabs: [...document.querySelectorAll(".site-tab")].map((t) => t.textContent),
			sideways: document.documentElement.scrollWidth > innerWidth,
			leftX: document.querySelector(".site-left").getBoundingClientRect().left,
		}));
		check(`${page}: GitHub and "Add your game" at the top left`, nav.gh && nav.add === "Add your game" && nav.leftX < 40, nav);
		check(`${page}: tabs Games · Leaderboards · Contributors · Collections${tab ? `, on ${tab}` : ""}`, nav.tabs.join() === "Games,Leaderboards,Contributors,Collections" && nav.on === tab, nav);
		check(`${page}: fits the phone`, !nav.sideways);
	}

	console.log("\nportal: contributors");
	// The play counts, played here (the server's /api/stats/summary): the
	// arcade's own repo is played more than web-games.
	const PLAYS = { connect4: 500, "neon-bid": 1, "lokeshmohanty/battleship": 100 };
	await ctx.route("**/api/stats/summary", (route) =>
		route.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ games: Object.fromEntries(Object.entries(PLAYS).map(([g, played]) => [g, { played }])) }) }),
	);
	const repoGames = await p.evaluate(() => Object.fromEntries(["lokeshmohanty/games", "lokeshmohanty/web-games"].map((r) => [r, NeonArcade.CATALOG.filter((g) => g.repo === `https://github.com/${r}`).length])));
	await p.goto(site.url("contributors.html"));
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
	check("…SEE THEIR GAMES opens the portal searched by author", person.see === "index.html?q=author%3Alokeshmohanty", person.see);
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
	await p.goto(site.url("contributors.html"));
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
		top: document.querySelector(".view-collections h1").getBoundingClientRect().top >= document.querySelector(".site-tabs").getBoundingClientRect().bottom,
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
	await p.goto(site.url("contribute.html"));
	await p.locator("[data-guide] h1").waitFor({ timeout: TIMEOUT });
	const guide = await p.evaluate(() => ({
		h1: document.querySelector("[data-guide] h1").textContent,
		h2: [...document.querySelectorAll("[data-guide] h2")].map((h) => h.textContent),
		code: document.querySelectorAll("[data-guide] pre code").length,
		sdk: document.querySelector('[data-guide] a[href$="docs/sdk.md"]')?.getAttribute("href"),
		local: document.querySelector('[data-guide] a[href="contributors.html"]') !== null,
	}));
	check("the guide is CONTRIBUTING.md, rendered", guide.h1 === "Putting your game in the arcade" && guide.h2.length >= 4 && guide.code >= 3, guide);
	check("…repo files link to GitHub, site pages stay here", guide.sdk === "https://github.com/lokeshmohanty/games/blob/main/docs/sdk.md" && guide.local, guide);
	const unsafe = await p.evaluate(() =>
		NeonArcade.markdown.render('<img src=x onerror=alert(1)> [x](javascript:alert(1)) **b** `<b>`\n\n```\n<script>\n```'),
	);
	check("the renderer lets no HTML or javascript: link through", !/<img|<script|javascript:/i.test(unsafe) && /<strong>b<\/strong>/.test(unsafe), unsafe);
	// One page (docs/spa.md): the guide's site link moves in-app, and Back
	// draws the guide again in the same document.
	await p.evaluate(() => (window.__samePage = true));
	await p.locator('[data-guide] a[href="contributors.html"]').first().click();
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
	await p.goto(site.url("contribute.html"));
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
	await p.goto(site.url("contributors.html"));
	await p.locator(".person-update button").first().click();
	const upd = p.locator(".person-update-out a", { hasText: "Copy the commit" });
	check("Contributors: CHECK FOR UPDATES offers the same for a moved repo", await upd.waitFor({ timeout: TIMEOUT }).then(() => true, () => false));
	check("…nobody's pull request is opened for them: every link is GitHub's own page", /github\.com\/lokeshmohanty\/games\/edit\//.test(await upd.getAttribute("href")));

	console.log("\nportal: previews when no video plays");
	// Every video fails (offline, or a browser that plays neither format):
	// each card shows its ~5 KB poster, still — never the 0.4–1 MB gif.
	const vp = await ctx.newPage();
	const gifs = [];
	await vp.route(/\.(webm|mp4)$/, (route) => route.abort());
	vp.on("request", (r) => r.url().endsWith(".gif") && gifs.push(r.url()));
	await vp.goto(site.url("index.html"));
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
