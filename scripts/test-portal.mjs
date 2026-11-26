// scripts/test-portal.mjs — the home screen's tabs (My Games · All
// Games), sections, PLAY SOMETHING and search, the bar and tabs on every page,
// the Contributors and Collections pages and the add-your-game guide, at
// 390x844 (and Lokesh's phone, 354x696).

import { existsSync, readFileSync } from "node:fs";
import { PHONE_SIZES, communityHas, phoneFloors, serve, settled } from "./serve.mjs";
import { launchFirefox, loadPlaywright } from "./playwright.mjs";

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
	// JOIN WITH A CODE (src/JoinCode.tsx): an in-page dialog, never
	// prompt() (Lokesh's phone, 2026-11-15: no number keypad, a wrong code
	// popped another native dialog). The room server is the page's own mock
	// (?mockroom=1): a code nobody holds is refused as the real one would.
	for (const [w, h] of [
		[390, 844],
		[354, 696],
	]) {
		const jc = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: true, isMobile: true });
		await jc.route("**/api/stats/summary", (r) => r.abort());
		const jp = await jc.newPage();
		let native = 0;
		jp.on("dialog", (d) => (native++, d.dismiss().catch(() => {})));
		jp.on("pageerror", (e) => check(`no page error (${e.message})`, false));
		await jp.goto(site.url("index.html?mockroom=1"));
		await jp.locator(".join-code-btn").waitFor({ timeout: TIMEOUT });
		await jp.evaluate(() => (window.__samePage = true));
		const dlg = jp.locator("dialog.join-code[open]");
		const field = jp.locator("#join-code-field");
		const view = () => jp.evaluate(() => document.body.dataset.view);
		await jp.locator(".join-code-btn").tap();
		await dlg.waitFor({ timeout: TIMEOUT });
		const look = await jp.evaluate(() => {
			const d = document.querySelector("dialog.join-code");
			const f = document.querySelector("#join-code-field");
			const r = d.getBoundingClientRect();
			return { modal: d.matches(":modal"), focus: document.activeElement === f, inputmode: f.inputMode, auto: f.autocomplete, inside: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight, label: f.labels?.[0]?.textContent ?? "" };
		});
		const at = `${w}x${h}`;
		check(`${at}: JOIN WITH A CODE opens an in-page dialog (modal, on screen), the field focused, a number keypad (inputmode numeric, one-time-code)`, look.modal && look.focus && look.inputmode === "numeric" && look.auto === "one-time-code" && look.inside && /six-digit/.test(look.label), look);
		const floors = await phoneFloors(jp, "dialog.join-code");
		check(`${at}: …every button 44px, every line 12px`, floors.measured.taps >= 4 && !floors.taps.length && !floors.text.length, floors);
		// A press begun in the field and let go past the dialog's edge is not
		// a tap outside (review, 2026-11-19: it closed the dialog).
		const fb = await field.boundingBox();
		await jp.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2);
		await jp.mouse.down();
		await jp.mouse.move(4, 4, { steps: 4 });
		await jp.mouse.up();
		check(`${at}: …a press in the field let go outside it leaves it open`, (await dlg.count()) === 1);
		await jp.keyboard.press("Escape");
		const esc = await settled(() => jp.evaluate(() => ({ open: !!document.querySelector("dialog.join-code"), back: document.activeElement === document.querySelector(".join-code-btn") })), (x) => !x.open, 3000);
		check(`${at}: Escape closes it, focus back on JOIN WITH A CODE`, !esc.open && esc.back && (await view()) === "portal", esc);
		if (w !== 390) {
			check(`${at}: no native dialog at all`, native === 0, native);
			await jc.close();
			continue;
		}
		await jp.locator(".join-code-btn").tap();
		await jp.locator("dialog.join-code button", { hasText: "CANCEL" }).tap();
		check("CANCEL closes it", await settled(() => jp.locator("dialog.join-code").count(), (n) => n === 0, 3000).then((n) => n === 0));
		await jp.locator(".join-code-btn").tap();
		await field.pressSequentially("12");
		await jp.keyboard.press("Enter");
		const short = await jp.evaluate(() => ({ open: !!document.querySelector("dialog.join-code[open]"), error: document.querySelector(".join-code-error").textContent, invalid: document.querySelector("#join-code-field").getAttribute("aria-invalid") }));
		check("too few digits: said under the field, the dialog stays, nothing navigates", short.open && /six digits/.test(short.error) && short.invalid === "true" && (await view()) === "portal", short);
		await field.fill("");
		await jp.keyboard.insertText("Code: 12-34-56 7");
		check("a pasted code keeps its six digits (\"Code: 12-34-56 7\" → 123456)", (await field.inputValue()) === "123456", await field.inputValue());
		await jp.keyboard.press("Enter");
		const refused = await settled(
			() => jp.evaluate(() => ({ open: !!document.querySelector("dialog.join-code[open]"), error: document.querySelector(".join-code-error")?.textContent ?? "", focus: document.activeElement?.id, view: document.body.dataset.view })),
			(x) => !!x.error,
			TIMEOUT,
		);
		check("a code nobody holds (expired): the reason under the field, the dialog still open, the field ready for another", refused.open && /no longer meeting|expired/.test(refused.error) && refused.focus === "join-code-field", refused);
		// A party that is meeting, hosted on the page's own mock server: its
		// code is tried in place (the party's joinCode), with no page load.
		const code = await jp.evaluate(async () => {
			const made = await NeonArcade.hostRoom({ name: "Host" });
			window.__host = made;
			localStorage.removeItem("neon.room"); // the host's seat is not ours
			return made.code;
		});
		await field.fill(code);
		await jp.keyboard.press("Enter");
		const joined = await settled(
			() => jp.evaluate(() => ({ open: !!document.querySelector("dialog.join-code"), members: window.__party?.room?.getMembers?.().length ?? 0, view: document.body.dataset.view, same: !!window.__samePage })),
			(x) => !x.open && x.members === 2,
			TIMEOUT,
		);
		check("…then a live code: joined, the dialog gone, the party on screen, in the same page", !joined.open && joined.members === 2 && joined.view === "party" && joined.same && !new URL(jp.url()).hash, { ...joined, url: jp.url() });
		await jc.close();
		// CANCEL after a refused code leaves the party screen for the portal.
		const kc = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: true, isMobile: true });
		await kc.route("**/api/stats/summary", (r) => r.abort());
		const kp = await kc.newPage();
		kp.on("dialog", (d) => (native++, d.dismiss().catch(() => {})));
		await kp.goto(site.url("index.html?mockroom=1"));
		await kp.locator(".join-code-btn").tap();
		await kp.locator("#join-code-field").fill("654321");
		await kp.keyboard.press("Enter");
		await kp.waitForFunction(() => !!document.querySelector(".join-code-error")?.textContent, null, { timeout: TIMEOUT });
		await kp.locator("dialog.join-code button", { hasText: "CANCEL" }).tap();
		const home = await settled(() => kp.evaluate(() => document.body.dataset.view), (v) => v === "portal", 5000);
		check("CANCEL after a refused code goes back to the portal", home === "portal", { home, url: kp.url() });
		// …and the dialog opened again from there, with a live code: joined,
		// the party on screen (not joined out of sight behind the portal).
		const live = await kp.evaluate(async () => {
			window.__samePage = true;
			const made = await NeonArcade.hostRoom({ name: "Host" });
			localStorage.removeItem("neon.room");
			return made.code;
		});
		await kp.locator(".join-code-btn").tap();
		await kp.locator("#join-code-field").fill(live);
		await kp.keyboard.press("Enter");
		const again = await settled(
			() => kp.evaluate(() => ({ open: !!document.querySelector("dialog.join-code"), members: window.__party?.room?.getMembers?.().length ?? 0, view: document.body.dataset.view, same: !!window.__samePage })),
			(x) => !x.open && x.members === 2 && x.view === "party",
			TIMEOUT,
		);
		check("…opened again there, a live code joins with the party on screen, in the same page", !again.open && again.members === 2 && again.view === "party" && again.same, again);
		check("no native dialog at all (prompt, alert)", native === 0, native);
		await kc.close();

		/** A page on the mock room server whose joins take `ms` longer, as on a slow phone. */
		const slowPhone = async (ms) => {
			const sc = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: true, isMobile: true });
			await sc.route("**/api/stats/summary", (r) => r.abort());
			const sp = await sc.newPage();
			sp.on("pageerror", (e) => check(`no page error (${e.message})`, false));
			await sp.goto(site.url("index.html?mockroom=1"));
			await sp.locator(".join-code-btn").waitFor({ timeout: TIMEOUT });
			await sp.evaluate((ms) => {
				window.__samePage = true;
				const real = NeonArcade.joinRoom;
				NeonArcade.joinRoom = (...a) => new Promise((r) => setTimeout(r, ms)).then(() => real(...a));
			}, ms);
			return { sc, sp };
		};
		const hostHere = (pg) =>
			pg.evaluate(async () => {
				const made = await NeonArcade.hostRoom({ name: "Host" });
				localStorage.removeItem("neon.room"); // the host's seat is not ours
				return made.code;
			});
		const state = (pg) => pg.evaluate(() => ({ dialog: !!document.querySelector("dialog.join-code"), members: window.__party?.room?.getMembers?.().length ?? 0, view: document.body.dataset.view, same: !!window.__samePage, search: location.search }));

		// A refused code, then a live one, then CANCEL while it is still
		// JOINING… (review, 2026-11-19): the refusal before must not send
		// us back to the portal, with the join finishing out of sight.
		{
			const { sc, sp } = await slowPhone(2500);
			await sp.locator(".join-code-btn").tap();
			await sp.locator("#join-code-field").fill("654321");
			await sp.keyboard.press("Enter");
			await sp.waitForFunction(() => !!document.querySelector(".join-code-error")?.textContent, null, { timeout: TIMEOUT });
			const live = await hostHere(sp);
			await sp.locator("#join-code-field").fill(live);
			await sp.keyboard.press("Enter");
			await sp.locator("dialog.join-code button", { hasText: "JOINING" }).waitFor({ timeout: TIMEOUT });
			await sp.locator("dialog.join-code button", { hasText: "CANCEL" }).tap();
			await sp.waitForTimeout(300);
			const during = await state(sp);
			const after = await settled(() => state(sp), (x) => x.members === 2, TIMEOUT);
			check("a refused code, a live one, CANCEL while JOINING…: the party screen stays and shows the join", !during.dialog && during.view === "party" && after.view === "party" && after.members === 2 && after.same && !after.search.includes("page="), { during, after });
			await sc.close();
		}
		// Back to the portal while a code join is still meeting the party:
		// joined, the portal's address stays the portal's (clearHash only
		// on the party's own address).
		{
			const { sc, sp } = await slowPhone(2500);
			const live = await hostHere(sp);
			await sp.evaluate((c) => NeonArcade.navigate(`./?party#c=${c}`), live);
			await sp.waitForFunction(() => document.body.dataset.view === "party", null, { timeout: TIMEOUT });
			await sp.evaluate(() => history.back());
			await sp.waitForFunction(() => document.body.dataset.view === "portal", null, { timeout: TIMEOUT });
			const after = await settled(() => state(sp), (x) => x.members === 2, TIMEOUT);
			await sp.waitForTimeout(200);
			const url = new URL(sp.url());
			check("Back during a code join: joined, and the portal's address is not rewritten into a party's", after.members === 2 && !url.searchParams.has("party") && url.searchParams.get("tab") === "all", { after, url: url.href });
			await sc.close();
		}
		// The party will not take the code in place: one history entry, the
		// code's own (review, 2026-11-19: ./?party was pushed first, so Back
		// from the new page landed on a party, not the portal).
		{
			const { sc, sp } = await slowPhone(0);
			await sp.locator(".join-code-btn").tap();
			await sp.locator("#join-code-field").fill("654321");
			await sp.keyboard.press("Enter");
			await sp.waitForFunction(() => !!document.querySelector(".join-code-error")?.textContent, null, { timeout: TIMEOUT });
			await sp.locator("dialog.join-code button", { hasText: "CANCEL" }).tap();
			await sp.waitForFunction(() => document.body.dataset.view === "portal", null, { timeout: TIMEOUT });
			await sp.evaluate(() => {
				window.__party.canJoinCode = () => false;
				window.__party.joinCode = () => false;
			});
			await sp.locator(".join-code-btn").tap();
			await sp.locator("#join-code-field").fill("111111");
			await Promise.all([sp.waitForEvent("load", { timeout: TIMEOUT }), sp.keyboard.press("Enter")]);
			await sp.waitForFunction(() => document.body.dataset.view === "party", null, { timeout: TIMEOUT });
			await sp.goBack({ waitUntil: "load" }).catch(() => {});
			const back = await settled(() => sp.evaluate(() => document.body?.dataset.view), (v) => !!v, TIMEOUT);
			check("…a code the party will not take in place: one entry, so Back is the portal", back === "portal", { back, url: sp.url() });
			await sc.close();
		}
		// The code of a party that has ended for you (removed by its host),
		// typed with that party still mounted (re-review, 2026-11-19: the
		// guard took it for the party you are in, no join ran, and the
		// dialog waited on JOINING… for ever). A dead room server for the
		// fresh page the join loads, not the deployed one.
		{
			const sc = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: true, isMobile: true });
			await sc.addInitScript(() => localStorage.setItem("neon.rs", "http://127.0.0.1:9"));
			await sc.route("**/api/stats/summary", (r) => r.abort());
			const sp = await sc.newPage();
			await sp.goto(site.url("index.html?mockroom=1"));
			await sp.locator(".join-code-btn").waitFor({ timeout: TIMEOUT });
			const x = await sp.evaluate(async () => {
				const made = await NeonArcade.hostRoom({ name: "Host" });
				window.__hostMade = made;
				localStorage.removeItem("neon.room");
				return made.code;
			});
			await sp.locator(".join-code-btn").tap();
			await sp.locator("#join-code-field").fill(x);
			await sp.keyboard.press("Enter");
			const joined = await settled(() => state(sp), (s) => s.members === 2 && !s.dialog, TIMEOUT);
			await sp.evaluate(() => window.__hostMade.room.removeMember(window.__party.room.selfId));
			const removed = await sp
				.waitForFunction(() => /You were removed from the party/.test(document.querySelector("#party .lobby-sub")?.textContent ?? ""), null, { timeout: TIMEOUT })
				.then(() => true, () => false);
			await sp.locator("a.portal-link").click();
			await sp.waitForFunction(() => document.body.dataset.view === "portal", null, { timeout: TIMEOUT });
			await sp.locator(".join-code-btn").tap();
			await sp.locator("#join-code-field").fill(x);
			await sp.keyboard.press("Enter");
			const stuck = () => sp.evaluate(() => !!document.querySelector("dialog.join-code button[type=submit]:disabled")).catch(() => false);
			await sp.waitForTimeout(6000);
			const after = { stuck: await stuck(), url: sp.url(), view: await sp.evaluate(() => document.body.dataset.view).catch(() => null), asked: await sp.locator("dialog.neon-ask[open]").count().catch(() => 0) };
			check("an ended party's code (you were removed), typed again: a join runs, and the dialog is never left on JOINING…", joined.members === 2 && removed && !after.stuck && !after.asked && after.view === "party", { joined, removed, ...after });
			await sc.close();
		}
		// The code of the party you are in (review, 2026-11-19: it asked
		// "Leave this party for another?"): shown, never asked.
		{
			const sc = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: true, isMobile: true });
			await sc.route("**/api/stats/summary", (r) => r.abort());
			const sp = await sc.newPage();
			await sp.goto(site.url("?party&mockroom=1"));
			const digits = await sp.locator(".party-code-digits").textContent({ timeout: TIMEOUT });
			const mine = digits.replace(/\D/g, "");
			const me = await sp.evaluate(() => ((window.__samePage = true), window.__party.room.selfId));
			await sp.locator("a.portal-link").click();
			await sp.waitForFunction(() => document.body.dataset.view === "portal", null, { timeout: TIMEOUT });
			await sp.locator(".join-code-btn").tap();
			await sp.locator("#join-code-field").fill(mine);
			await sp.keyboard.press("Enter");
			await sp.waitForTimeout(800);
			const after = await sp.evaluate(() => ({ asked: !!document.querySelector("dialog.neon-ask[open]"), view: document.body.dataset.view, same: !!window.__samePage, id: window.__party?.room?.selfId }));
			check("the code of the party you are in: back to it, not asked to leave it", /^\d{6}$/.test(mine) && !after.asked && after.view === "party" && after.same && after.id === me, { mine, ...after, me });
			await sc.close();
		}
	}
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
	await c4card.locator(".card-open").focus({ timeout: 5000 }).catch(() => {});
	check("…and so does keyboard focus", await settled(visible, Boolean, 3000));
	await c4card.locator(".card-play", { hasText: "SINGLE PLAYER" }).click();
	await p.waitForSelector(".game-frame", { timeout: TIMEOUT });
	check("SINGLE PLAYER goes straight into the game, bots seated: no second choice, no START", (await p.locator(".party-choice").count()) === 0 && (await p.evaluate(() => window.__party.room.getMembers().some((m) => m.id.startsWith("bot_")))));
	check("…without waiting on the room server: no party code yet", await p.evaluate(() => !document.querySelector(".party-code-digits")));
	check("…and the address keeps mode=bots while it plays alone, so a reload is a fresh bots game", new URL(p.url()).searchParams.get("mode") === "bots", p.url());
	await p.goto(site.url(ALL));
	await p.waitForSelector(".game-card:visible");
	await p.locator('.game-card[data-game="connect4"]').first().hover();
	await p.locator('.game-card[data-game="connect4"]').first().locator(".card-play", { hasText: "MULTI-PLAYER" }).click();
	await p.locator("button", { hasText: "INVITE A FRIEND" }).first().waitFor({ timeout: TIMEOUT });
	check("MULTI-PLAYER lands on the friends view (invite, and the code when there is a server)", (await p.locator(".party-choice").count()) === 0);
	// One tap (or click) on a card starts the game against bots (Lokesh,
	// 2026-11-21; on 2026-11-18 it became one tap: on a phone the first tap
	// only showed the buttons). The buttons stay a mouse's on hover; a phone
	// long-presses.
	/** A long press on a touch screen: the browser's contextmenu. */
	const longPress = (loc) => loc.dispatchEvent("contextmenu");
	// The game is running, against bots, and while it plays alone the
	// address stays the tap's (party.js syncAddress: a reload is a fresh
	// bots game).
	const quickStart = async (pg, id) => {
		await pg.waitForFunction((id) => window.__party?.game === id, id, { timeout: TIMEOUT }).catch(() => {});
		const q = new URL(pg.url()).searchParams;
		return q.get("game") === id && q.get("mode") === "bots" && q.get("start") === "1" && (await pg.evaluate((id) => window.__party?.game === id && window.__party.room.getMembers().some((m) => m.id.startsWith("bot_")), id));
	};
	for (const [w, h] of [
		[390, 844],
		[354, 696],
	]) {
		const at = `${w}x${h}`;
		const touch = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: true, isMobile: true });
		// No counts from the deployed worker or the snapshot: their late arrival
		// reorders Popular (tested on its own, below).
		await touch.route("**/api/stats/summary", (r) => r.abort());
		await touch.route("**/summary.json", (r) => r.abort());
		const tp = await touch.newPage();
		await tp.goto(site.url(ALL));
		await tp.waitForSelector(".game-card:visible");
		await tp.evaluate(() => (window.__samePage = true));
		const tcard = tp.locator('[data-section="popular"] .game-card[data-game="connect4"]');
		await tcard.locator("h3").tap();
		await tp.waitForFunction(() => document.body.dataset.view === "party", null, { timeout: TIMEOUT }).catch(() => {});
		const went = { url: tp.url(), same: await tp.evaluate(() => !!window.__samePage) };
		check(`${at}: one tap on a card runs that game against bots (./?game=connect4&fresh=1&mode=bots&start=1), in the page`, (await quickStart(tp, "connect4")) && went.same, went);
		check(`${at}: …no quick start screen first`, await tp.evaluate(() => !document.querySelector(".party-choice, .quick-table") && !!document.querySelector(".game-frame")));
		await tp.goto(site.url(ALL));
		await tp.waitForSelector(".game-card:visible");
		const isOpen = () => tcard.evaluate((c) => c.classList.contains("is-open"));
		await longPress(tcard);
		const fits = await settled(
			() => tcard.locator(".card-play").evaluateAll((as) => as.map((a) => getComputedStyle(a.parentElement).opacity === "1" && a.getBoundingClientRect()).map((r) => r && { h: Math.round(r.height), right: Math.round(r.right) })),
			(f) => f.every(Boolean),
			3000,
		); // a 0.15 s fade
		check(`${at}: a long press shows a card's two buttons, 44px tall, inside the phone, without leaving the page`, (await isOpen()) && fits.length === 2 && fits.every((f) => f && f.h >= 44 && f.right <= w) && new URL(tp.url()).searchParams.get("tab") === "all", { fits, url: tp.url() });
		await tcard.locator(".card-play", { hasText: "SINGLE PLAYER" }).tap();
		await tp.waitForFunction(() => !!window.__party?.game, null, { timeout: TIMEOUT }).catch(() => {});
		check(`${at}: …and its SINGLE PLAYER still plays against the bots`, await tp.evaluate(() => window.__party?.game === "connect4" && window.__party.room.getMembers().some((m) => m.id.startsWith("bot_"))), tp.url());
		await tp.goto(site.url(ALL));
		await tp.waitForSelector(".game-card:visible");
		await longPress(tcard);
		await longPress(tp.locator('[data-section="popular"] .game-card[data-game="neon-bid"]'));
		check(`${at}: …a long press on another card closes the first`, !(await isOpen()));
		const bid = tp.locator('[data-section="popular"] .game-card[data-game="neon-bid"]');
		await bid.tap({ position: { x: 6, y: 6 } }); // its corner: not one of its buttons
		check(`${at}: …a tap off the buttons of an open card closes it, and stays`, !(await bid.evaluate((c) => c.classList.contains("is-open"))) && new URL(tp.url()).searchParams.get("tab") === "all", tp.url());
		// A sideways swipe along a row, starting on a card: the row scrolls,
		// and no game opens. Real touch events (CDP), as a finger sends them.
		const row = tp.locator('[data-section="popular"] .section-row');
		await row.evaluate((r) => (r.scrollLeft = 0));
		const box = await tcard.boundingBox();
		const cdp = await touch.newCDPSession(tp);
		const y = box.y + box.height / 2;
		let x = Math.min(box.x + box.width - 10, w - 20);
		await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
		for (let i = 0; i < 10; i++) {
			x -= 18;
			await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
			await tp.waitForTimeout(16);
		}
		await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
		await tp.waitForTimeout(600);
		const swiped = { x: await row.evaluate((r) => r.scrollLeft), url: tp.url(), view: await tp.evaluate(() => document.body.dataset.view) };
		check(`${at}: a sideways swipe that starts on a card scrolls its row and opens nothing`, swiped.x > 0 && swiped.view === "portal" && new URL(swiped.url).searchParams.get("tab") === "all", swiped);
		// The same for a click that ends a drag: the row moved under the
		// pointer between its down and its click (a slow swipe a browser
		// still reports as a click).
		const dragged = await tp.evaluate(() => {
			const c = document.querySelector('[data-section="popular"] .game-card[data-game="connect4"]');
			const r = c.parentElement;
			const at = c.getBoundingClientRect();
			const opt = { bubbles: true, clientX: at.left + 20, clientY: at.top + 20, pointerType: "touch" };
			c.dispatchEvent(new PointerEvent("pointerdown", opt));
			const from = r.scrollLeft;
			r.scrollLeft = from + r.children[1].offsetLeft - r.children[0].offsetLeft; // a snap point: the row really moves
			const moved = r.scrollLeft - from;
			c.dispatchEvent(new MouseEvent("click", { ...opt, detail: 1, clientX: at.left + 22 }) /* a tap's click: detail 1 */);
			c.dispatchEvent(new PointerEvent("pointerup", opt));
			return { moved, view: document.body.dataset.view };
		});
		await tp.waitForTimeout(300);
		check(`${at}: …and a click that ends a scroll of its row opens nothing`, dragged.moved > 0 && dragged.view === "portal" && (await tp.evaluate(() => document.body.dataset.view)) === "portal", { dragged, url: tp.url() });
		await touch.close();
	}
	// A mouse: a click on the card (off its buttons) does the same, and a
	// drag across it does not.
	await p.goto(site.url(ALL));
	await p.waitForSelector(".game-card:visible");
	const mcard = p.locator('[data-section="popular"] .game-card[data-game="connect4"]');
	const mb = await mcard.boundingBox();
	await p.mouse.move(mb.x + mb.width - 8, mb.y + 8);
	await p.mouse.down();
	await p.mouse.move(mb.x + 8, mb.y + 40, { steps: 6 });
	await p.mouse.up();
	await p.waitForTimeout(300);
	check("a mouse drag across a card opens nothing", (await p.evaluate(() => document.body.dataset.view)) === "portal", p.url());
	await mcard.click({ position: { x: 6, y: 6 } });
	await p.waitForFunction(() => document.body.dataset.view === "party", null, { timeout: TIMEOUT }).catch(() => {});
	check("a mouse click on a card, off its buttons, starts the game against bots", await quickStart(p, "connect4"), p.url());
	await p.goto(site.url(ALL));
	await p.waitForSelector(".game-card:visible");
	// The card's title is its button, named by the game (review,
	// 2026-11-19: the card was a div with a tabindex and no role or name,
	// and Space did nothing).
	const named = p.locator('[data-section="popular"] .game-card[data-game="connect4"]').getByRole("button", { name: "Connect 4", exact: true });
	check("a card's title is a button named by its game", (await named.count()) === 1);
	await named.focus({ timeout: 5000 }).catch(() => {});
	await p.keyboard.press("Enter");
	await p.waitForFunction(() => document.body.dataset.view === "party", null, { timeout: TIMEOUT }).catch(() => {});
	check("…Enter on it starts the game against bots", await quickStart(p, "connect4"), p.url());
	await p.goto(site.url(ALL));
	await p.waitForSelector(".game-card:visible");
	await named.focus({ timeout: 5000 }).catch(() => {});
	await p.keyboard.press(" ");
	await p.waitForFunction(() => document.body.dataset.view === "party", null, { timeout: TIMEOUT }).catch(() => {});
	check("…and so does Space", await quickStart(p, "connect4"), p.url());
	// A click with no pointer behind it (element.click(), assistive tech)
	// always counts, whatever a pointer did before; a pointercancel (a
	// scroll took the gesture) forgets the press.
	for (const [what, mode] of [
		["element.click() after a stray press elsewhere on the card", "click"],
		["a click after a press a scroll cancelled", "cancelled"],
	]) {
		await p.goto(site.url(ALL));
		await p.waitForSelector(".game-card:visible");
		await p.evaluate((mode) => {
			const c = document.querySelector('[data-section="popular"] .game-card[data-game="connect4"]');
			c.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 300, clientY: 300 }));
			if (mode === "click") return c.click();
			c.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true }));
			c.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1, clientX: 12, clientY: 12 }));
		}, mode);
		await p.waitForFunction(() => document.body.dataset.view === "party", null, { timeout: 5000 }).catch(() => {});
		check(`…${what} opens the game`, await quickStart(p, "connect4"), p.url());
	}
	// A press held on a row is let go wherever it ends: a mouse released
	// outside the row (the flag stuck, and the row never redrew again).
	await p.goto(site.url(ALL));
	await p.waitForSelector(".game-card:visible");
	const prow = p.locator('[data-section="popular"] .section-row');
	const pb = await prow.boundingBox();
	await p.mouse.move(pb.x + 30, pb.y + 30);
	await p.mouse.down();
	await p.mouse.move(pb.x + 30, Math.max(2, pb.y - 120), { steps: 4 });
	await p.mouse.up();
	check("a press on a row released outside it lets the row go", (await prow.evaluate((r) => r.dataset.pressed ?? null)) === null);
	// A slow phone: the play counts land after a card was long-pressed open. The
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
		await bid.dispatchEvent("contextmenu"); // a long press
		release();
		await sp.waitForFunction(() => !!localStorage.getItem("neon.plays"), null, { timeout: TIMEOUT });
		await sp.waitForTimeout(400);
		const during = await row.evaluate((r) => ({ ids: r.dataset.ids, x: r.scrollLeft, open: r.querySelector(".game-card.is-open")?.dataset.game ?? null, same: !!r.querySelector('.game-card[data-game="neon-bid"]').__tapped }));
		check("a card long-pressed open stays open when the play counts land late (same card, same row, same scroll)", before.x > 0 && during.open === "neon-bid" && during.same && during.ids === before.ids && during.x === before.x, { before, during });
		await bid.tap({ position: { x: 6, y: 6 } }); // its corner: not one of its two buttons
		await sp.waitForFunction(() => document.querySelector('[data-section="popular"] .game-card')?.dataset.game === "lokeshmohanty/sudoku", null, { timeout: TIMEOUT }).catch(() => {});
		const after = await row.evaluate((r) => ({ ids: r.dataset.ids, x: r.scrollLeft, pending: r.dataset.pending ?? null }));
		check("…closed, the row takes the new order (most played first), keeping its scroll", after.ids.startsWith("lokeshmohanty/sudoku undercover connect4") && after.x === before.x && !after.pending, { before, after });
		await slow.close();
	}

	console.log("\nportal: the tabs and the menu on every page");
	// One row: My Games · All Games · Community, and ☰ (Lokesh, 2026-11-15:
	// the buttons above the tabs crowded a phone; 2026-11-26: My Games and
	// All Games "separate tabs"). Only Community has sub-tabs.
	// A device with nothing of its own: ./ is All Games.
	await p.evaluate(() => localStorage.removeItem("neon.recent"));
	const SUBS = { Community: "Collections,Contributors" };
	for (const [page, tab, sub] of [
		["index.html", "All Games", null],
		["./?page=games&tab=mine", "My Games", null],
		["./?page=games&tab=all", "All Games", null],
		["./?page=contributors", "Community", "Contributors"],
		["./?page=collections", "Community", "Collections"],
		["./?page=contribute", null, null],
		["./?page=profile", null, null],
	]) {
		await p.goto(site.url(page));
		await p.locator("[data-nav] .site-menu-list").waitFor({ state: "attached", timeout: TIMEOUT }); // nav.js's row, not the static first frame's
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
					// Links stay links: each inside a listitem, none a listitem itself.
					roles: [...document.querySelectorAll("[data-nav] .site-tab, [data-nav] .site-subtab")].every((a) => !a.hasAttribute("role") && a.parentElement.getAttribute("role") === "listitem" && a.parentElement.parentElement.getAttribute("role") === "list"),
				};
			});
		let nav = await read();
		check(`${page}: tabs My Games · All Games · Community, no Leaderboards${tab ? `, on ${tab}` : ""}`, nav.tabs.join() === "My Games,All Games,Community" && nav.on === tab, nav);
		check(`${page}: ${sub ? `${tab}'s tabs ${SUBS[tab].replace(",", " · ")}, on ${sub}, 44px tall` : "no sub-tabs"}`, sub ? nav.subs.join() === SUBS[tab] && nav.subOn === sub && nav.subH >= 44 : nav.subs.length === 0, nav);
		check(`${page}: every tab a link inside a listitem`, nav.roles, nav);
		check(`${page}: tabs and ☰ in one row, ☰ 44px at the right, closed`, nav.oneRow && nav.btn.w >= 44 && nav.btn.h >= 44 && nav.btn.right > 340 && !nav.open && nav.expanded === "false", nav);
		await p.locator(".site-menu-btn").click();
		nav = await read();
		const texts = nav.items.map((i) => i.text);
		check(`${page}: ☰ lists Add your game, Theme, account and GitHub, 44px each, inside the phone`, nav.open && nav.expanded === "true" && texts[0] === "Add your game" && texts[1] === "Theme" && /^(Sign in|Profile|.+)$/.test(texts[2]) && texts.at(-1) === "Source on GitHub" && nav.items[0].href === "./?page=contribute" && nav.items.at(-1).href === "https://github.com/lokeshmohanty/games" && nav.items.every((i) => i.h >= 44) && nav.listBox.left >= 0 && nav.listBox.right <= 390, nav);
		check(`${page}: fits the phone`, !nav.sideways);
		await p.keyboard.press("Escape");
		check(`${page}: Esc closes it, focus back on ☰`, await p.evaluate(() => document.querySelector(".site-menu-list").hidden && document.activeElement === document.querySelector(".site-menu-btn")));
	}
	await p.goto(site.url(ALL));
	await p.locator("[data-nav] .site-menu-list").waitFor({ state: "attached", timeout: TIMEOUT }); // not the static first frame's ☰
	await p.locator("[data-nav] .site-menu-btn").click();
	await p.mouse.click(200, 600);
	check("a tap outside closes the menu", await p.evaluate(() => document.querySelector(".site-menu-list")?.hidden === true));
	await p.waitForTimeout(300);
	check("…and does nothing else: the game card under it stays shut", (await p.evaluate(() => document.body.dataset.view)) === "portal", p.url());
	await p.locator("[data-nav] .site-menu-btn").click();
	await p.locator("[data-nav] .site-tab", { hasText: "Community" }).click();
	await p.waitForTimeout(300);
	check("…nor a link it lands on (Community)", (await p.evaluate(() => document.body.dataset.view)) === "portal" && new URL(p.url()).searchParams.get("page") !== "collections", p.url());

	console.log("\nportal: the old leaderboard addresses land on the profile (no boards since 2026-11-25)");
	for (const from of ["./?page=leaderboard", "./?page=leaderboard&game=neon-fission&scope=friends&vs=bots", "leaderboard.html", "leaderboard.html?game=connect4&scope=global"]) {
		await p.goto(site.url(from));
		const landed = await p.waitForFunction(() => document.body.dataset.view === "profile", null, { timeout: TIMEOUT }).then(() => true, () => false);
		const u = new URL(p.url());
		check(`${from} → ./?page=profile, nothing of the board kept, no 404`, landed && u.pathname.endsWith("/") && u.searchParams.get("page") === "profile" && [...u.searchParams.keys()].join() === "page", p.url());
	}
	await p.goto(site.url("index.html"));
	await p.locator("[data-nav] .site-menu-list").waitFor({ state: "attached", timeout: TIMEOUT });
	await p.evaluate(() => {
		history.pushState(null, "", "./?page=leaderboard&game=x");
		dispatchEvent(new PopStateEvent("popstate"));
	});
	await p.waitForFunction(() => document.body.dataset.view === "profile", null, { timeout: TIMEOUT }).catch(() => {});
	check("…and so does Back or Forward to one (popstate)", new URL(p.url()).searchParams.get("page") === "profile" && !new URL(p.url()).searchParams.has("game"), p.url());
	for (const [w, h] of [[390, 844], [354, 696]]) {
		const pc = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: true, isMobile: true });
		const pp = await pc.newPage();
		await pp.goto(site.url("leaderboard.html"));
		await pp.waitForFunction(() => document.body.dataset.view === "profile" && document.querySelector("[data-profile] section"), null, { timeout: TIMEOUT });
		const floors = await phoneFloors(pp, "[data-profile]");
		const sideways = await pp.evaluate(() => document.documentElement.scrollWidth > innerWidth);
		check(`${w}x${h}: where leaderboard.html lands (the profile, signed out) has 44px taps, 12px text, no sideways scroll`, floors.measured.taps > 0 && !floors.taps.length && !floors.text.length && !sideways, { floors, sideways });
		await pc.close();
	}
	await p.goto(site.url(ALL));
	await p.locator("[data-nav] .site-menu-list").waitFor({ state: "attached", timeout: TIMEOUT });
	await p.waitForSelector(".game-card:visible");
	await p.locator("[data-nav] .site-menu-btn").click();
	// A press outside that turned into a scroll (pointercancel): no click
	// comes, so the next real tap is not eaten.
	await p.evaluate(() => {
		const c = document.querySelector('[data-section="popular"] .game-card[data-game="connect4"]');
		c.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 50, clientY: 600 }));
		c.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true }));
	});
	await p.locator('[data-section="popular"] .game-card[data-game="connect4"]').click({ position: { x: 6, y: 6 } });
	await p.waitForFunction(() => document.body.dataset.view === "party", null, { timeout: 5000 }).catch(() => {});
	check("…and a press outside that became a scroll leaves the next tap alone (it opens the game)", await quickStart(p, "connect4"), p.url());
	// A right-click outside sends no click: it closes the menu and the
	// next real click is not eaten (re-review, 2026-11-19).
	await p.goto(site.url(ALL));
	await p.locator("[data-nav] .site-menu-list").waitFor({ state: "attached", timeout: TIMEOUT });
	await p.waitForSelector(".game-card:visible");
	await p.locator("[data-nav] .site-menu-btn").click();
	await p.mouse.click(30, 700, { button: "right" });
	await p.locator('[data-section="popular"] .game-card[data-game="connect4"]').click({ position: { x: 6, y: 6 } });
	await p.waitForFunction(() => document.body.dataset.view === "party", null, { timeout: 5000 }).catch(() => {});
	check("…a right-click outside closes it and leaves the next click alone (it opens the game)", (await p.evaluate(() => document.querySelector(".site-menu-list")?.hidden !== false)) && await quickStart(p, "connect4"), p.url());
	await p.goto(site.url("index.html"));
	await p.locator("[data-nav] .site-menu-list").waitFor({ state: "attached", timeout: TIMEOUT });
	await p.locator(".site-tab", { hasText: "Community" }).click();
	await p.locator(".site-subtab.is-on").waitFor({ timeout: TIMEOUT });
	check("Community opens on Collections", (await p.locator(".site-subtab.is-on").textContent()) === "Collections" && new URL(p.url()).searchParams.get("page") === "collections");
	await p.locator(".site-subtab", { hasText: "Contributors" }).click();
	await p.locator(".person").first().waitFor({ timeout: TIMEOUT });
	check("…and its Contributors tab opens Contributors, Community still on", (await p.locator(".site-subtab.is-on").textContent()) === "Contributors" && (await p.locator(".site-tab.is-on").textContent()) === "Community");

	console.log("\nportal: the bar with the phone's text larger (Firefox)");
	// Firefox for Android applies the system font size as text zoom: at 130%
	// the tabs ran under ☰ and the page scrolled sideways (Lokesh's phone,
	// 2026-11-15). The tabs scroll inside their own column now, the lit one
	// in view; the sub-tabs wrap; nothing on the bar overlaps.
	// Its own try: a Firefox that fails (NEON_FIREFOX=1 and none here) is
	// one loud failure, never every portal check after it skipped.
	try {
	for (const scale of [130, 200]) {
		const ff = await launchFirefox(pw, { textScale: scale });
		if (!ff) break;
		for (const [w, h] of [
			[390, 844],
			[354, 696],
		]) {
			const fc = await ff.newContext({ viewport: { width: w, height: h }, hasTouch: true });
			await fc.route("**/api/stats/summary", (r) => r.abort());
			const fp = await fc.newPage();
			for (const [page, lit] of [
				["index.html?page=games&tab=all", "All Games"],
				["index.html?page=games&tab=mine", "My Games"],
				["./?page=collections", "Community"],
				["./?page=contributors", "Community"],
			]) {
				await fp.goto(site.url(page));
				await fp.locator("[data-nav] .site-row").waitFor({ timeout: TIMEOUT });
				await fp.evaluate(() => document.fonts.ready);
				await fp.waitForTimeout(150); // lib/nav.js re-fits the strip on the webfont's resize
				const bar = await fp.evaluate(() => {
					const r = (n) => n.getBoundingClientRect();
					const tabs = document.querySelector("[data-nav] .site-tabs");
					const menu = document.querySelector("[data-nav] .site-menu-btn");
					const subs = [...document.querySelectorAll("[data-nav] .site-subtab")].map(r);
					const lit = document.querySelector("[data-nav] .site-tab.is-on");
					const s = r(tabs);
					const each = [...tabs.querySelectorAll(".site-tab")].map(r);
					const fade = { start: tabs.classList.contains("fade-start"), end: tabs.classList.contains("fade-end") };
					const FADE = 28; // lib/styles.css .site-tabs.fade-*
					return {
						// Every tab whole, or the side that clips one fades (the scrollbar is hidden).
						whole: each.every((b) => b.left >= s.left - 0.5 && b.right <= s.right + 0.5),
						hinted: each.every((b) => (b.left >= s.left - 0.5 || fade.start) && (b.right <= s.right + 0.5 || fade.end)),
						fade,
						// The lit tab out from under a fade.
						litClear: !!lit && (!fade.start || r(lit).left >= s.left + FADE - 1) && (!fade.end || r(lit).right <= s.right - FADE + 1),
						clear: r(tabs).right <= r(menu).left && r(menu).right <= innerWidth,
						lit: lit?.textContent,
						litInView: !!lit && r(lit).left >= r(tabs).left - 1 && r(lit).right <= r(tabs).right + 1,
						tabsH: Math.round(r(tabs).height),
						subsApart: subs.every((a, i) => subs.every((b, j) => i >= j || a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top)),
						subsInside: subs.every((b) => b.left >= 0 && b.right <= innerWidth && b.height >= 44),
						sideways: document.documentElement.scrollWidth > innerWidth,
					};
				});
				check(`Firefox, text at ${scale}%, ${w}x${h}, ${page}: tabs clear of ☰ (the lit ${lit} in view), sub-tabs apart and 44px, no sideways scroll`, bar.clear && bar.lit === lit && bar.litInView && bar.tabsH >= 43 && bar.subsApart && bar.subsInside && !(page.startsWith("index") && bar.sideways), bar);
				// 130%: all three whole (they tighten: lib/styles.css); 200%: they
				// cannot fit, so a fade shows, never over the lit tab.
				if (scale === 130) check(`Firefox, text at 130%, ${w}x${h}, ${page}: every tab whole`, bar.whole, bar);
				else check(`Firefox, text at ${scale}%, ${w}x${h}, ${page}: the strip fades where it hides a tab, the lit one clear of the fade`, (bar.fade.start || bar.fade.end) && bar.hinted && bar.litClear, bar);
			}
			if (scale === 200) {
				// ☰ open with the text at 200%: the list stays on screen (its
				// 13rem floor gives way to the viewport).
				await fp.goto(site.url("index.html?page=games&tab=all"));
				await fp.locator(".site-menu-btn").first().tap();
				const list = await fp.locator(".site-menu-list:not([hidden])").first().boundingBox();
				check(`Firefox, text at 200%, ${w}x${h}: the ☰ list stays on screen`, !!list && list.x >= 0 && list.x + list.width <= w, list);
			}
			if (scale === 200 && w === 354) {
				// JOIN WITH A CODE in Firefox, its text at 200%: still 44px and
				// 12px, and a refused code said in the dialog.
				await fp.goto(site.url("index.html?mockroom=1"));
				await fp.locator(".join-code-btn").tap();
				await fp.locator("dialog.join-code[open]").waitFor({ timeout: TIMEOUT });
				const floors = await phoneFloors(fp, "dialog.join-code");
				await fp.keyboard.insertText("12 34 56");
				await fp.keyboard.press("Enter");
				const said = await fp
					.waitForFunction(() => document.querySelector(".join-code-error")?.textContent, null, { timeout: TIMEOUT })
					.then((h) => h.jsonValue(), () => "");
				check("Firefox, text at 200%, 354x696: JOIN WITH A CODE's buttons 44px, its lines 12px, a refused code said in place", floors.measured.taps >= 4 && !floors.taps.length && !floors.text.length && /no longer meeting/.test(said) && (await fp.locator("dialog.join-code[open]").count()) === 1, { floors, said });
			}
			await fc.close();
		}
		await ff.close();
	}
	} catch (err) {
		check(`the Firefox lane: ${err.message.split("\n")[0]}`, false);
	}

console.log("\nportal: My Games · All Games");
// Lokesh, 2026-11-15: "All favourites land under My Games". Two tabs with
// addresses (Games' sub-tabs until 2026-11-26); ./ opens on My Games once
// this device has a favourite or a recent game, decided before the first paint.
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
	const subOn = (pg) => pg.locator("[data-nav] .site-tab.is-on").textContent({ timeout: TIMEOUT });
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
		check(`./ with ${what}: opens on ${want === "mine" ? "My Games" : "All Games"} (address and tab)`, tabOf(pg) === want && on === (want === "mine" ? "My Games" : "All Games"), { url: pg.url(), on });
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
	// code runs, already lights the tab that will show — and the drawn row
	// lands exactly on it, with no sub-tab row on either.
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
				const tabs = [...document.querySelectorAll(".site-tab")];
				return {
					boot: !!document.querySelector(".boot"),
					tabs: tabs.map((t) => `${t.textContent}@${box(t)}`).join(" "),
					subs: document.querySelectorAll(".site-subtab, .site-subtabs").length,
					bg: Object.fromEntries(tabs.map((t) => [t.dataset.tab, `${getComputedStyle(t).color} ${getComputedStyle(t).borderBottomColor}`])),
					on: document.querySelector(".site-tab.is-on")?.dataset.tab ?? null,
					current: document.querySelector('.site-tab[aria-current="page"]')?.dataset.tab ?? null,
					h1: box(document.querySelector("h1")),
				};
			});
		const first = await frame();
		await pg.unroute(/\/app\/[^/]+\.js(\?|$)/);
		await pg.goto(site.url("index.html"));
		// The app's own row and heading, not the static frame's: that one has
		// a lit tab too, and the app's heading can follow its nav (a
		// runner read no h1 here, CI run 44143511384).
		await pg.waitForFunction(() => !document.querySelector(".boot") && document.querySelector("[data-nav] .site-tab.is-on") && document.querySelector("main h1"), null, { timeout: TIMEOUT }).catch(() => {});
		const drawn = await frame();
		const other = want === "mine" ? "all" : "mine";
		check(`first paint (${want === "mine" ? "a game played" : "a first visit"}): the static frame lights ${want === "mine" ? "My Games" : "All Games"}, as the app does`, first.boot && first.bg[want] === drawn.bg[want] && first.bg[other] === drawn.bg[other] && first.bg[want] !== first.bg[other] && drawn.on === want && first.current === want && drawn.current === want, { first, drawn });
		check("…the same tabs in the same places, no sub-tab row, and the title does not move", !drawn.boot && first.tabs === drawn.tabs && first.subs === 0 && drawn.subs === 0 && first.h1 === drawn.h1, { first, drawn });
		await c.close();
	}

	// The tabs are addresses: Back and Forward move between them.
	{
		const { c, pg } = await phone();
		await pg.goto(site.url("index.html"));
		await pg.locator("[data-nav] .site-tab", { hasText: "My Games" }).click();
		await pg.locator("[data-my-empty]:not([hidden])").waitFor({ timeout: TIMEOUT });
		const empty = await pg.evaluate(() => ({
			text: document.querySelector("[data-my-empty] p").textContent,
			quick: document.querySelector("[data-my-empty] [data-quick]")?.getAttribute("href"),
			sections: document.querySelectorAll("[data-section]:not([hidden])").length,
			search: document.querySelector(".search").hidden,
		}));
		check("My Games is ./?page=games&tab=mine, and with nothing of yours it says how to star (★, from inside a game)", tabOf(pg) === "mine" && (await subOn(pg)) === "My Games" && /★/.test(empty.text) && /inside/.test(empty.text) && !/card/.test(empty.text) && !empty.sections && empty.search, { url: pg.url(), empty });
		check("…with PLAY SOMETHING (a game's single player, starting at once, bots only: start=pick) and ALL GAMES", /^\.\/\?game=[^&]+&fresh=1.*&start=pick$/.test(empty.quick ?? "") && (await pg.locator("[data-my-empty] .my-empty-all").textContent()) === "ALL GAMES", empty.quick);
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
		check("no star on any card: a game is starred only from inside it", (await pg.locator(".game-card button:not(.card-open), .game-card [aria-pressed]").count()) === 0 && !(await pg.locator(".game-card").allTextContents()).some((t) => /[☆★]/.test(t)));
		const favs = () => pg.locator('[data-section="favs"] .game-card').evaluateAll((cs) => cs.map((c) => c.dataset.game).join());
		await pg.evaluate(() => NeonArcade.stats.toggleFav("connect4")); // as the game's ★ does
		check("…a star from a game leaves you where you are", tabOf(pg) === "all");
		await pg.locator("[data-nav] .site-tab", { hasText: "My Games" }).click();
		await pg.locator('[data-section="favs"]:not([hidden]) .game-card').first().waitFor({ timeout: TIMEOUT });
		check("…and the game is in My Games", (await favs()) === "connect4" && (await pg.locator("[data-my-empty]").isHidden()));
		await pg.evaluate(() => NeonArcade.stats.toggleFav("connect4"));
		check("unstarred, it is gone from My Games at once, and the empty state is back", (await pg.locator('[data-section="favs"]').isHidden()) && (await pg.locator("[data-my-empty]").isVisible()));

		// A card left open on My Games, then All Games, a star changed, and
		// back: the row is current (review 2026-11-16: the open card survived
		// the switch, held its row back, and My Games froze).
		await pg.evaluate(() => ["connect4", "neon-bid"].forEach((id) => NeonArcade.stats.toggleFav(id)));
		await pg.locator('[data-section="favs"] .game-card[data-game="connect4"]').waitFor({ timeout: TIMEOUT });
		await pg.locator('[data-section="favs"] .game-card[data-game="connect4"]').dispatchEvent("contextmenu"); // a long press
		const opened = await settled(() => pg.locator('[data-section="favs"] .game-card.is-open').count(), (n) => n === 1, 3000);
		await pg.locator("[data-nav] .site-tab", { hasText: "All Games" }).click();
		await pg.locator('[data-section="popular"]:not([hidden]) .game-card').first().waitFor({ timeout: TIMEOUT });
		await pg.evaluate(() => NeonArcade.stats.toggleFav("connect4"));
		await pg.locator("[data-nav] .site-tab", { hasText: "My Games" }).click();
		await pg.locator('[data-section="favs"]:not([hidden]) .game-card').first().waitFor({ timeout: TIMEOUT });
		const back = await settled(async () => ({ favs: await favs(), open: await pg.locator(".game-card.is-open").count() }), (b) => b.favs === "neon-bid" && b.open === 0, 5000);
		check("a card left open, a tab away, a star changed: My Games is current on return", opened === 1 && back.favs === "neon-bid" && back.open === 0, { opened, back });
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
			return { game: window.__party?.game, alone: room.getMembers().every((m) => m.id === room.selfId || m.id.startsWith("bot_")), lobby: !!document.querySelector(".party-choice"), table: !!document.querySelector(".quick-table") };
		});
		check("…one tap starts it in single player: that game, you and its bots only, no lobby, no quick table", game.game === picked && game.alone && !game.lobby && !game.table && box.height >= 44, { game, picked, h: box.height });
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
				const strip = document.querySelector("[data-nav] .site-tabs");
				const tabs = [...strip.querySelectorAll(".site-tab")].map(r);
				const menu = r(document.querySelector("[data-nav] .site-menu-btn"));
				return {
					vw: innerWidth,
					// The three tabs and ☰ in one row: no tab scrolled out of
					// sight, none over another or under ☰, the open one lit.
					bar: {
						tabs: [...strip.querySelectorAll(".site-tab")].map((a) => a.textContent).join(),
						fade: strip.classList.contains("fade-start") || strip.classList.contains("fade-end"),
						whole: strip.scrollWidth <= strip.clientWidth && tabs.every((b) => b.left >= 0 && b.right <= menu.left),
						apart: tabs.every((b, i) => i === 0 || tabs[i - 1].right <= b.left + 0.5),
						row: tabs.every((b) => Math.abs(b.top - tabs[0].top) < 1) && menu.top < tabs[0].bottom && menu.bottom > tabs[0].top,
						lit: document.querySelector("[data-nav] .site-tab.is-on")?.dataset.tab ?? null,
						current: document.querySelector('[data-nav] .site-tab[aria-current="page"]')?.dataset.tab ?? null,
						subs: document.querySelectorAll("[data-nav] .site-subtabs").length,
					},
					sideways: document.documentElement.scrollWidth > innerWidth,
					targets,
					text,
					rowWhole: inRow.filter((b) => b.left >= 0 && b.right <= innerWidth).length,
					rowPeeks: inRow.some((b) => b.left < innerWidth && b.right > innerWidth),
					rowEdges: [Math.round(r(row).left), Math.round(r(row).right)],
					rowCount: inRow.length,
					cols: new Set(inRow.map((b) => Math.round(b.left))).size,
					card: Math.round(inRow[0].left),
					metaLines: Math.round(r(meta).height / parseFloat(getComputedStyle(meta).fontSize)),
					recent,
					search: search ? Math.round(r(search).left) : null,
					title: Math.round(r(document.querySelector(".portal-section:not([hidden]) .section-title")).left),
					// PLAY SOMETHING where this tab shows it: Popular's heading, or Recently played's.
					quick: [...document.querySelectorAll("[data-quick]")].filter(shown).map((a) => ({ where: a.closest("[data-section], [data-recent]")?.dataset.section ?? "recent", h: Math.round(r(a).height), left: Math.round(r(a).left), right: Math.round(r(a).right), game: a.dataset.game })),
				};
			});
			const at = `${width}x${height} ${t === "mine" ? "My Games" : "All Games"}`;
			check(`${at}: no sideways scroll`, !L.sideways);
			check(`${at}: My Games · All Games · Community and ☰ in one row, every tab whole (no fade), ${t} lit, no sub-tab row`, L.bar.tabs === "My Games,All Games,Community" && L.bar.whole && !L.bar.fade && L.bar.apart && L.bar.row && L.bar.lit === t && L.bar.current === t && L.bar.subs === 0, L.bar);
			check(`${at}: every tap target 44px tall (START A PARTY, JOIN WITH A CODE, tabs, chips, PLAY SOMETHING…)`, L.targets.length >= 8 && L.targets.every((x) => x.h >= 44), L.targets.filter((x) => x.h < 44));
			check(`${at}: every line on a card 12px or more`, L.text.length > 0 && L.text.every((x) => x.size >= 12), L.text.filter((x) => x.size < 12));
			check(`${at}: …and the meta line still on one line`, L.metaLines <= 1, L.metaLines);
			if (t === "all") check(`${at}: a row is two whole cards and the edge of the next, scrolling to the screen's edges`, L.rowWhole === 2 && L.rowPeeks && L.rowEdges[0] === 0 && L.rowEdges[1] === L.vw, L);
			// My Games is a grid going down (Lokesh, 2026-11-21): two columns, every card whole.
			else check(`${at}: ★ Favourites is a grid of two columns, every card whole, none past the edge`, L.cols === 2 && L.rowWhole === L.rowCount && !L.rowPeeks, L);
			check(`${at}: the cards line up with their heading`, Math.abs(L.card - L.title) <= 1, { card: L.card, title: L.title });
			if (t === "all") check(`${at}: the search lines up with the cards`, Math.abs(L.search - L.card) <= 1, { search: L.search, card: L.card });
			if (t === "mine") {
				const R = L.recent;
				check(`${at}: Recently played lines up with the cards and its heading`, !!R && Math.abs(R.chip - L.card) <= 1 && Math.abs(R.heading - L.card) <= 1, { R, card: L.card });
				check(`${at}: …wraps instead of scrolling sideways, its last chip all the way in view`, !!R && !R.scrolls && R.end <= L.vw && R.right <= L.vw, R);
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
	const repoGames = await p.evaluate(() => Object.fromEntries(["lokeshmohanty/games", "lokeshmohanty/web-games", "lokeshmohanty/card-games"].map((r) => [r, NeonArcade.CATALOG.filter((g) => g.repo === `https://github.com/${r}`).length])));
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
	// lokeshmohanty/card-games once the registry pins it (or a build with
	// NEON_PIN_OVERRIDE): a third collection, unplayed here, so last.
	const cards = communityHas("lokeshmohanty/glowdown") ? repoGames["lokeshmohanty/card-games"] : 0;
	const theirRepos = `lokeshmohanty/games,lokeshmohanty/web-games${cards ? ",lokeshmohanty/card-games" : ""}`;
	check("a card from contributor.json: name and bio", person.name === "Lokesh Mohanty" && !!person.bio, person);
	check("…one person, every collection of theirs (games repos), most played first", person.cols.map((c) => c.repo).join() === theirRepos, person.cols);
	check("…each with its games and plays", person.cols[0]?.meta === `${games} games · 501 plays` && person.cols[1]?.meta === `${arcadeGames} games · 100 plays`, person.cols);
	check("…linking to its games in the portal, and to GitHub", person.cols[1]?.href === "./?q=from%3Alokeshmohanty%2Fweb-games" && person.cols[1]?.gh === "https://github.com/lokeshmohanty/web-games", person.cols[1]);
	check("…CHECK FOR UPDATES on a pinned collection only (the arcade's own has no pin)", !person.cols[0]?.update && person.cols[1]?.update, person.cols);
	check("…and their games' total plays", person.facts === `${games + arcadeGames + cards} games · 601 plays · ${cards ? 3 : 2} collections`, person.facts);
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
	check("every collection, most played first (the summary's counts)", cols.map((c) => c.repo).join() === theirRepos, cols.map((c) => c.repo));
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
	await cp.goto(site.url(ALL));
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

	// ------------------------------------------------- one tap, against bots
	//
	// Lokesh, 2026-11-21: "when a user clicks on a game, directly take to the
	// single-player game page (it has a button at bottom to rather play with
	// friends)". A tap is the remembered table at once (?mode=bots&start=1),
	// with no room server. PLAY WITH FRIENDS ends that game and opens the
	// party lobby for it: between rounds at the bottom of the end card
	// (test-bots), during play in PARTY's screen over the game (2026-11-22:
	// "Bottom, between rounds"; no bar, so the game keeps the whole screen).
	console.log("\nportal: one tap on a game starts it against bots");
	for (const [w, h] of PHONE_SIZES) {
		const at = `${w}x${h}`;
		const oc = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: true, isMobile: true });
		// PLAY WITH FRIENDS asks the room server for a code: an unreachable
		// loopback one, never production (test-bots newContext).
		await oc.addInitScript(() => {
			try {
				localStorage.setItem("neon.rs", "http://127.0.0.1:9");
			} catch {} // a game's sandboxed frame has no storage
		});
		await oc.route("**/api/stats/summary", (r) => r.abort());
		await oc.route("**/summary.json", (r) => r.abort());
		const op = await oc.newPage();
		op.on("pageerror", (e) => check(`${at}: no page error (${e.message})`, false));
		// No room server answers: a bots game must not wait on one.
		const pings = [];
		op.on("request", (r) => /\/ping(?:$|\?)/.test(r.url()) && pings.push(r.url()));
		await op.goto(site.url(ALL));
		await op.waitForSelector(".game-card:visible");
		await op.evaluate(() => NeonArcade.catalogs);
		await op.evaluate(() => (window.__samePage = true));
		const fcard = op.locator('[data-section="party"] .game-card[data-game="neon-fission"]');
		const tapped = Date.now();
		await fcard.locator("h3").tap();
		const running = await op.waitForFunction(() => window.__party?.game === "neon-fission" && document.querySelector(".game-frame"), null, { timeout: TIMEOUT }).then(() => Date.now() - tapped, () => null);
		const ran = await op.evaluate(() => ({
			same: !!window.__samePage,
			bots: window.__party.room.getMembers().filter((m) => m.id.startsWith("bot_")).length,
			table: !!document.querySelector(".quick-table, .party-choice"),
			code: !!document.querySelector(".party-code-digits"),
			search: location.search,
		}));
		check(`${at}: one tap on a card runs that game against bots, in the page (${running} ms), with no table or choice drawn first`, running !== null && ran.same && ran.bots >= 1 && !ran.table, { running, ...ran });
		check(`${at}: …no party wait: the room server not asked, no party code`, !pings.length && !ran.code, { pings, code: ran.code });
		// A reload mid-game is a fresh bots game, as the tap was (Lokesh,
		// 2026-11-22: "A fresh bots game"): the address keeps the tap's flags
		// while this page plays alone.
		const tapQ = new URLSearchParams(ran.search);
		check(`${at}: …and while it plays alone the address is the tap's (game, fresh, mode=bots, start), for a reload`, tapQ.get("game") === "neon-fission" && tapQ.get("fresh") === "1" && tapQ.get("mode") === "bots" && tapQ.get("start") === "1", ran.search);
		await op.reload();
		const reran = await op
			.waitForFunction(() => window.__party?.game === "neon-fission" && document.querySelector(".game-frame"), null, { timeout: TIMEOUT })
			.then(() => op.evaluate(() => ({ bots: window.__party.room.getMembers().filter((m) => m.id.startsWith("bot_")).length, screen: !!document.querySelector(".party-quick, .party-choice") && !document.getElementById("party").hidden })), () => null);
		check(`${at}: a reload mid-game starts a new game against bots at once, not the party screen`, !!reran && reran.bots >= 1 && !reran.screen, reran);
		// No bar over or under the game (Lokesh, 2026-11-22: "Bottom, between
		// rounds"): the frame keeps the whole screen. During play PLAY WITH
		// FRIENDS is in the party screen pulled up over the game (PARTY).
		const full = await op.evaluate(() => ({ frame: Math.round(document.querySelector(".game-frame").getBoundingClientRect().bottom), fixed: [...document.body.children].filter((n) => n.getClientRects().length && getComputedStyle(n).position === "fixed" && n.getBoundingClientRect().bottom >= innerHeight - 1 && n.textContent.includes("FRIENDS")).length }));
		check(`${at}: …the game has the whole screen: no PLAY WITH FRIENDS bar at the bottom`, full.frame === h && full.fixed === 0, full);
		await op.locator(".party-pill").tap();
		await op.locator(".party-peek").waitFor({ timeout: TIMEOUT });
		const peekBtn = op.locator(".party-peek button", { hasText: "PLAY WITH FRIENDS" });
		const pb = await peekBtn.boundingBox().catch(() => null);
		const peekFloors = await phoneFloors(op, ".party-peek");
		check(`${at}: PARTY over the game offers PLAY WITH FRIENDS, 44px, inside the screen, beside BACK TO GAME and CHANGE PLAYERS`, !!pb && pb.height >= 44 && pb.x >= 0 && pb.x + pb.width <= w && (await op.locator(".party-peek button", { hasText: "CHANGE PLAYERS" }).count()) === 1 && !peekFloors.taps.length && !peekFloors.text.length, { pb, peekFloors });
		// It ends the game, so it asks first, as END GAME does (review,
		// 2026-11-22): KEEP PLAYING keeps it; yes opens the lobby.
		await peekBtn.tap();
		const asked = op.locator('dialog.neon-ask[open]');
		const askedText = await asked.textContent({ timeout: 5000 }).catch(() => null);
		await op.locator('dialog.neon-ask[open] [data-ask="no"]').tap().catch(() => {});
		await op.waitForTimeout(300);
		check(`${at}: …it asks before ending the game, and KEEP PLAYING keeps it`, /End Neon Fission/i.test(askedText ?? "") && (await op.evaluate(() => window.__party.game)) === "neon-fission", askedText);
		await op.locator(".party-peek button", { hasText: "CHANGE PLAYERS" }).tap();
		const askedSeats = await asked.textContent({ timeout: 5000 }).catch(() => null);
		await op.locator('dialog.neon-ask[open] [data-ask="no"]').tap().catch(() => {});
		await op.waitForTimeout(300);
		check(`${at}: …so does CHANGE PLAYERS beside it`, /End Neon Fission/i.test(askedSeats ?? "") && (await op.evaluate(() => window.__party.game)) === "neon-fission", askedSeats);
		await peekBtn.tap();
		await op.locator('dialog.neon-ask[open] [data-ask="yes"]').tap();
		await op.waitForFunction(() => !window.__party.game && document.querySelector(".party-quick"), null, { timeout: TIMEOUT }).catch(() => {});
		const lobby = await op.evaluate(() => ({
			game: window.__party.game,
			title: document.querySelector(".lobby-title")?.textContent,
			invite: [...document.querySelectorAll("#party button")].some((b) => b.textContent === "INVITE A FRIEND" && b.getClientRects().length),
			start: [...document.querySelectorAll(".party-quick button")].some((b) => b.textContent === "START GAME"),
			addBot: [...document.querySelectorAll(".party-quick button")].some((b) => b.textContent === "ADD BOT"),
			says: document.querySelector(".party-quick .party-bots-count")?.textContent,
			members: window.__party.room.getMembers().length,
			peek: !!document.querySelector(".party-peek"),
		}));
		check(`${at}: PLAY WITH FRIENDS ends the bots game and opens the lobby for it (its name, INVITE A FRIEND, START GAME)`, lobby.game === null && lobby.title === "NEON FISSION" && lobby.invite && lobby.start, lobby);
		check(`${at}: …the party screen is the lobby now, not pulled up over a game`, !lobby.peek, lobby);
		const lobbyQ = await op.evaluate(() => location.search);
		check(`${at}: …and the address drops the tap's flags, so a reload rejoins rather than starting a bots game`, !/fresh=|mode=|start=/.test(lobbyQ), lobbyQ);
		check(`${at}: …the lobby keeps the table that was playing (its bots), and says who is at it`, lobby.addBot && lobby.members >= 2 && lobby.says === `${lobby.members} players: You and ${lobby.members - 1} bot${lobby.members === 2 ? "" : "s"}`, lobby);
		// The seats from the lobby: ADD BOT seats one more, and the table is remembered for the game.
		await op.locator(".party-quick button", { hasText: "ADD BOT" }).tap();
		const more = await settled(() => op.evaluate(() => ({ members: window.__party.room.getMembers().length, says: document.querySelector(".party-quick .party-bots-count")?.textContent, saved: JSON.parse(localStorage.getItem("neon.table") ?? "{}")["neon-fission"]?.n })), (x) => x.members === lobby.members + 1);
		check(`${at}: the lobby's ADD BOT seats one more, and the table is remembered for Neon Fission`, more.members === lobby.members + 1 && more.says?.startsWith(`${more.members} players`) && more.saved === more.members, more);
		const lobbyFloors = await phoneFloors(op, "#party .party-quick");
		check(`${at}: …the lobby's seats: taps 44px, text 12px, no sideways scroll`, !lobbyFloors.taps.length && !lobbyFloors.text.length && (await op.evaluate(() => document.documentElement.scrollWidth)) <= w, lobbyFloors);
		// The next tap on the card starts that remembered table.
		await op.goto(site.url(ALL));
		await op.waitForSelector(".game-card:visible");
		await op.locator('[data-section="party"] .game-card[data-game="neon-fission"] h3').tap();
		await op.waitForFunction(() => window.__party?.game === "neon-fission", null, { timeout: TIMEOUT }).catch(() => {});
		const again = await op.evaluate(() => window.__party?.room?.getMembers().length ?? 0);
		check(`${at}: …and the next tap on the card plays that table at once (${more.members} players)`, again === more.members, again);
		// A people-only game has no bots: its lobby with friends, straight away.
		await op.goto(site.url(ALL));
		await op.waitForSelector(".game-card:visible");
		await op.locator('.game-card[data-game="lokeshmohanty/draw-guess"] h3').first().tap();
		await op.locator("button", { hasText: "INVITE A FRIEND" }).first().waitFor({ timeout: TIMEOUT }).catch(() => {});
		const dg = await op.evaluate(() => ({ game: window.__party?.game, choice: !!document.querySelector(".party-choice"), invite: [...document.querySelectorAll("#party button")].some((b) => b.textContent === "INVITE A FRIEND") }));
		check(`${at}: a people-only game (Draw & Guess) opens straight on its lobby with friends, no choice first`, dg.game === null && !dg.choice && dg.invite, dg);
		// A one-device game starts at once, with no PLAY WITH FRIENDS (one phone, passed round).
		await op.goto(site.url(ALL));
		await op.waitForSelector(".game-card:visible");
		await op.locator('.game-card[data-game="undercover"] h3').first().tap();
		await op.waitForFunction(() => window.__party?.game === "undercover", null, { timeout: TIMEOUT }).catch(() => {});
		const uc = { game: await op.evaluate(() => window.__party?.game) };
		await op.locator(".party-pill").tap().catch(() => {});
		await op.locator(".party-peek").waitFor({ timeout: TIMEOUT }).catch(() => {});
		uc.friends = await op.locator(".party-peek button", { hasText: "PLAY WITH FRIENDS" }).count();
		check(`${at}: a one-device game (Undercover) starts at once, and offers no PLAY WITH FRIENDS`, uc.game === "undercover" && uc.friends === 0, uc);
		await oc.close();
	}
	{
		// A tap with a seat this browser still has saved (review, 2026-11-22):
		// with no room server (offline, or none answering) the token is
		// kept, since nothing released it; with a seat another tab holds, the
		// bots game starts anyway, with a note, and that tab keeps its token
		// (Lokesh, 2026-11-23: "Start the bots game anyway").
		const tc = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
		await tc.addInitScript(() => {
			try {
				localStorage.setItem("neon.rs", "http://127.0.0.1:9");
			} catch {}
		});
		const t1 = await tc.newPage();
		await t1.goto(site.url(ALL));
		await t1.waitForSelector(".game-card:visible");
		const seat = { code: "123456", id: "seatheldbyothertab", secret: "s3cret" };
		await t1.evaluate((t) => localStorage.setItem("neon.room", JSON.stringify(t)), seat);
		await t1.locator('[data-section="popular"] .game-card[data-game="connect4"] h3').tap();
		await t1.waitForFunction(() => window.__party?.game === "connect4", null, { timeout: TIMEOUT }).catch(() => {});
		await t1.waitForTimeout(3000); // the background probe's time to fail
		const kept = await t1.evaluate(() => ({ game: window.__party?.game, token: JSON.parse(localStorage.getItem("neon.room") ?? "null")?.code ?? null }));
		check("a tap with a saved seat and no room server: the game runs, and the token is kept (nothing released it)", kept.game === "connect4" && kept.token === seat.code, kept);
		const t2 = await tc.newPage();
		await t2.goto(site.url("?page=contribute"));
		await t2.evaluate((id) => void navigator.locks.request(`neon.seat.${id}`, () => new Promise(() => {})), seat.id);
		await t1.goto(site.url(ALL));
		await t1.waitForSelector(".game-card:visible");
		await t1.locator('[data-section="popular"] .game-card[data-game="connect4"] h3').tap();
		await t1.waitForFunction(() => window.__party?.game === "connect4", null, { timeout: TIMEOUT }).catch(() => {});
		const busy = await t1.evaluate(() => ({
			game: window.__party?.game ?? null,
			note: [...document.querySelectorAll(".neon-toast")].map((t) => t.textContent).join(" | "),
			screen: /open in another tab/i.test(document.querySelector(".lobby-status")?.textContent ?? ""),
			token: JSON.parse(localStorage.getItem("neon.room") ?? "null")?.code ?? null,
		}));
		check("…a seat another tab holds: the tap starts the bots game anyway, notes \"Your party is still open in another tab\", and leaves that tab its token", busy.game === "connect4" && /Your party is still open in another tab/.test(busy.note) && !busy.screen && busy.token === seat.code, busy);
		await tc.close();
	}
	{
		// Recently played and the card's SINGLE PLAYER take the same one tap.
		await p.goto(site.url(ALL));
		await p.waitForSelector(".game-card:visible");
		const links = await p.evaluate(() => {
			const g = NeonArcade.CATALOG.find((x) => x.id === "connect4");
			return { tap: NeonArcade.portal.tapLink(g), solo: document.querySelector('.game-card[data-game="connect4"] .card-play.is-bots')?.getAttribute("href") };
		});
		const q = new URLSearchParams(links.tap.slice(2));
		check("a card's SINGLE PLAYER is the same one-tap address (mode=bots, start=1)", q.get("mode") === "bots" && q.get("start") === "1" && links.solo === links.tap, links);
		await p.goto(site.url("index.html?page=games&tab=mine"));
		const chip = await p.locator("[data-recent] .recent-game").first().getAttribute("href", { timeout: TIMEOUT }).catch(() => null);
		check("…and so is a Recently played chip", !!chip && new URLSearchParams(chip.slice(2)).get("start") === "1" && new URLSearchParams(chip.slice(2)).get("mode") === "bots", chip);
		await p.goto(site.url(ALL));
		await p.waitForSelector(".game-card:visible");
	}

	// ------------------------------------------------------ the grids
	//
	// Lokesh, 2026-11-21: My Games "vertical scrollable with multiple
	// columns", and a genre's own page the same, from All Games.
	console.log("\nportal: My Games and a genre's page are grids");
	for (const [w, h] of PHONE_SIZES) {
		const at = `${w}x${h}`;
		const gc = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: true, isMobile: true });
		await gc.addInitScript(() => {
			try {
				localStorage.setItem("neon.favs", JSON.stringify(["connect4", "neon-bid", "neon-fission", "undercover", "lokeshmohanty/sudoku"]));
			} catch {}
		});
		const gp = await gc.newPage();
		const grid = (sel) =>
			gp.evaluate(
				([sel, w]) => {
					const row = document.querySelector(sel);
					const cards = [...row.querySelectorAll(".game-card")].filter((c) => !c.hidden);
					const rects = cards.map((c) => c.getBoundingClientRect());
					return {
						isGrid: row.classList.contains("is-grid"),
						cols: new Set(rects.map((r) => Math.round(r.left))).size,
						rows: new Set(rects.map((r) => Math.round(r.top))).size,
						sideways: row.scrollWidth > row.clientWidth + 1 || document.documentElement.scrollWidth > w,
						whole: rects.every((r) => r.left >= 0 && r.right <= w + 0.5 && r.width >= 44 && r.height >= 44),
						n: cards.length,
					};
				},
				[sel, w],
			);
		await gp.goto(site.url("index.html?page=games&tab=mine"));
		await gp.waitForSelector('[data-section="favs"]:not([hidden]) .game-card');
		const mine = await grid('[data-section="favs"] .section-row');
		check(`${at}: My Games' favourites are a grid: two columns, rows going down, no sideways scroll, every card whole and at least 44px`, mine.isGrid && mine.cols === 2 && mine.rows === Math.ceil(mine.n / 2) && !mine.sideways && mine.whole, mine);
		const mineFloors = await phoneFloors(gp, '[data-section="favs"] .section-row');
		check(`${at}: …its text at least 12px`, !mineFloors.text.length, mineFloors.text);
		// All Games: the rows stay rows; each genre has SEE ALL, its own page.
		await gp.goto(site.url(ALL));
		await gp.waitForSelector('[data-section="party"]:not([hidden]) .game-card');
		const partyRow = await grid('[data-section="party"] .section-row');
		check(`${at}: All Games' sections stay one row each`, !partyRow.isGrid && partyRow.rows === 1, partyRow);
		const seeAll = gp.locator('[data-section="party"] [data-see-all]');
		const sab = await seeAll.boundingBox();
		check(`${at}: …each genre's heading has SEE ALL, 44px tall (Popular has PLAY SOMETHING instead)`, sab && sab.height >= 44 && sab.x + sab.width <= w && (await gp.locator('[data-section="popular"] [data-see-all]').count()) === 0, sab);
		await seeAll.tap();
		await gp.waitForFunction(() => new URLSearchParams(location.search).get("genre") === "party", null, { timeout: TIMEOUT }).catch(() => {});
		const page = await gp.evaluate(() => ({
			url: location.search,
			shown: [...document.querySelectorAll("[data-section]:not([hidden])")].map((s) => s.dataset.section),
			title: document.querySelector('[data-section="party"] .section-title')?.textContent,
			back: !document.querySelector("[data-genre-back]").hidden,
			search: document.querySelector(".search").hidden,
			seeAll: document.querySelector('[data-section="party"] [data-see-all]').hidden,
		}));
		check(`${at}: SEE ALL opens the genre's page at its own address: its title, only its games, a way back, no search`, /genre=party/.test(page.url) && page.shown.join() === "party" && page.title === "Party" && page.back && page.search && page.seeAll, page);
		const genre = await grid('[data-section="party"] .section-row');
		const want = await gp.evaluate(() => NeonArcade.CATALOG.filter((g) => (g.categories ?? []).includes("party")).length);
		check(`${at}: …a grid: two columns, every party game, no sideways scroll, every card whole and at least 44px`, genre.isGrid && genre.cols === 2 && genre.n === want && !genre.sideways && genre.whole, { genre, want });
		const back = await gp.locator("[data-genre-back]").boundingBox();
		check(`${at}: …its way back is 44px tall`, back && back.height >= 44, back);
		await gp.reload();
		await gp.waitForSelector('[data-section="party"]:not([hidden]) .game-card');
		const reloaded = await gp.evaluate(() => [...document.querySelectorAll("[data-section]:not([hidden])")].map((s) => s.dataset.section).join());
		check(`${at}: …a reload opens the same page (a real address)`, reloaded === "party", reloaded);
		const allShown = () => gp.evaluate(() => ({ url: location.search, len: history.length, shown: [...document.querySelectorAll("[data-section]:not([hidden])")].map((s) => s.dataset.section), back: !document.querySelector("[data-genre-back]").hidden }));
		const okAll = (a) => a.shown.includes("popular") && a.shown.includes("party") && a.shown.includes("strategy") && !a.back && /tab=all/.test(a.url) && !/genre=/.test(a.url);
		// "← All Games" after SEE ALL is Back, not a new entry (review, 2026-11-22).
		const lenBefore = await gp.evaluate(() => history.length);
		await gp.locator("[data-genre-back]").tap();
		await gp.waitForFunction(() => !new URLSearchParams(location.search).has("genre"), null, { timeout: TIMEOUT }).catch(() => {});
		const after = await allShown();
		check(`${at}: …"← All Games" returns to All Games, every section, as Back: no new history entry`, okAll(after) && after.len === lenBefore, { after, lenBefore });
		await gp.goForward();
		await gp.waitForFunction(() => new URLSearchParams(location.search).get("genre") === "party", null, { timeout: TIMEOUT }).catch(() => {});
		await gp.goBack();
		await gp.waitForFunction(() => !new URLSearchParams(location.search).has("genre"), null, { timeout: TIMEOUT }).catch(() => {});
		check(`${at}: …and the browser's Back does the same`, okAll(await allShown()), await allShown());
		// A genre with no game (More games, while every game has a category)
		// or an unknown one: All Games, and the address fixed (review, 2026-11-22).
		for (const id of ["other", "nope"]) {
			await gp.goto(site.url(`index.html?page=games&tab=all&genre=${id}`));
			await gp.waitForSelector('[data-section="party"]:not([hidden]) .game-card');
			const fell = await settled(allShown, okAll, 5000);
			check(`${at}: genre=${id} (${id === "other" ? "no games" : "unknown"}) is All Games, not a blank page, and the address drops it`, okAll(fell), fell);
		}
		await gc.close();
	}
	{
		const ph = await p.evaluate(() => document.querySelector("[data-search]").placeholder);
		check('the search box says "Search games", and advertises no filters', ph === "Search games", ph);
	}

	// ------------------------------------------------------ first visit's name
	//
	// Lokesh, 2026-11-21: "first time a user enters, pop up asking for his
	// name (default: random two word title case name), with a button to
	// generate a new random name". Away under automation (lib/rules.js's
	// rule); localStorage neon.namePrompt = "on" brings it back here.
	console.log("\nportal: a first visit asks for a name");
	const TWO_WORDS = /^[A-Z][a-z-]+ [A-Z][a-z-]+$/;
	for (const [w, h] of PHONE_SIZES) {
		const at = `${w}x${h}`;
		const nc = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: true, isMobile: true });
		await nc.addInitScript(() => {
			try {
				localStorage.setItem("neon.namePrompt", "on");
				localStorage.setItem("neon.rs", "http://127.0.0.1:9");
			} catch {} // a game's sandboxed frame has no storage
		});
		const np = await nc.newPage();
		const native = [];
		np.on("dialog", (d) => (native.push(d.type()), d.dismiss()));
		if (w === 390) await np.goto(site.url("index.html"));
		else {
			// At 354: a game running first (one tap's address), then ← Games:
			// the dialog over the portal, with the party live behind it.
			await np.goto(site.url("?game=connect4&fresh=1&mode=bots&start=1"));
			await np.waitForFunction(() => window.__party?.game === "connect4", null, { timeout: TIMEOUT });
			await np.locator(".top-band .portal-link").tap();
		}
		const dlg = np.locator("dialog.name-prompt[open]");
		const opened = await dlg.waitFor({ timeout: TIMEOUT }).then(() => true, () => false);
		const first = await np.evaluate(() => ({ value: document.getElementById("name-prompt-field")?.value, focus: document.activeElement?.id, def: NeonArcade.defaultName() }));
		check(`${at}: a first visit opens the name dialog over the portal, in the page (no native prompt)`, opened && !native.length, { opened, native });
		check(`${at}: …the field holds a random two-word Title Case name (this device's default), focused`, TWO_WORDS.test(first.value ?? "") && first.value.length <= 16 && first.value === first.def && first.focus === "name-prompt-field", first);
		const box = await dlg.boundingBox();
		const nf = await phoneFloors(np, "dialog.name-prompt");
		check(`${at}: …it fits: inside the screen, taps 44px, text 12px`, box && box.x >= 0 && box.x + box.width <= w && box.y >= 0 && box.y + box.height <= h && !nf.taps.length && !nf.text.length && nf.measured.taps >= 3, { box, nf });
		const rolled = [];
		for (let i = 0; i < 3; i++) {
			await np.locator(".name-prompt-roll").tap();
			rolled.push(await np.locator("#name-prompt-field").inputValue());
		}
		check(`${at}: NEW NAME gives another two-word name each time`, rolled.every((n) => TWO_WORDS.test(n) && n.length <= 16) && new Set([first.value, ...rolled]).size === 4, rolled);
		if (w === 390) {
			// THAT'S ME keeps what the field says — typed, here.
			await np.locator("#name-prompt-field").fill("Ada");
			await np.locator(".name-prompt-ok").tap();
		} else {
			// Escape keeps the suggested name (the last rolled), not a half-typed edit.
			await np.locator("#name-prompt-field").fill("Half typ");
			await np.keyboard.press("Escape");
		}
		const want = w === 390 ? "Ada" : rolled.at(-1);
		const saved = await settled(() => np.evaluate(() => ({ open: !!document.querySelector("dialog.name-prompt"), name: localStorage.getItem("neon.name") })), (x) => !x.open);
		check(`${at}: ${w === 390 ? "THAT'S ME saves the name typed" : "Escape closes it and keeps the suggested name"} where the party reads it`, !saved.open && saved.name === want, { saved, want });
		if (w !== 390) {
			// The party live behind the portal takes the name at once (review, 2026-11-22).
			const live = await np.evaluate(() => window.__party?.room?.self()?.name);
			check(`${at}: …and the party running behind the portal takes it at once`, live === want, { live, want });
		}
		await np.reload();
		await np.waitForSelector(".view-portal [data-nav] .site-tab", { timeout: TIMEOUT }); // My Games may hold no card
		await np.waitForTimeout(300);
		check(`${at}: …and it is never asked again`, (await np.locator("dialog.name-prompt").count()) === 0);
		if (w === 390) {
			await np.goto(site.url("?game=connect4&fresh=1&mode=bots"));
			await np.waitForFunction(() => window.__party?.room, null, { timeout: TIMEOUT });
			check(`${at}: …the party uses it`, (await np.evaluate(() => window.__party.room.self()?.name)) === "Ada");
		}
		await nc.close();
	}
	{
		// A signed-in account with a display name: used, never asked.
		const sc = await browser.newContext({ viewport: { width: 390, height: 844 } });
		await sc.addInitScript(() => {
			try {
				localStorage.setItem("neon.namePrompt", "on");
				localStorage.setItem("neon.token", "test-token");
			} catch {}
		});
		await sc.route("**/api/me", (r) => r.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ id: "u1", name: "Grace Hopper", identities: [] }) }));
		await sc.route("**/api/**", (r) => (r.request().url().endsWith("/api/me") ? r.fallback() : r.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: "{}" })));
		const sp = await sc.newPage();
		await sp.goto(site.url("index.html"));
		await sp.waitForSelector(".game-card:visible");
		const used = await settled(() => sp.evaluate(() => localStorage.getItem("neon.name")), (n) => n === "Grace Hopper", 5000);
		await sp.waitForTimeout(300);
		check("signed in with a display name: not asked, and that name is the player's", used === "Grace Hopper" && (await sp.locator("dialog.name-prompt").count()) === 0, used);
		await sc.close();
		// Never asked: no dialog under automation without the switch, and the
		// default is a friendly random name, the same on every visit — not "Linux".
		const dc = await browser.newContext({ viewport: { width: 390, height: 844 } });
		const dp = await dc.newPage();
		await dp.goto(site.url("index.html"));
		await dp.waitForSelector(".game-card:visible");
		await dp.waitForTimeout(300);
		const d1 = await dp.evaluate(() => NeonArcade.defaultName());
		await dp.reload();
		await dp.waitForSelector(".game-card:visible");
		const d2 = await dp.evaluate(() => NeonArcade.defaultName());
		check("under automation the dialog stays away (the suites are not stopped by it)", (await dp.locator("dialog.name-prompt").count()) === 0);
		check("a name nobody chose is a random two-word name, kept for the device (not the device's name)", TWO_WORDS.test(d1) && d1 === d2 && !/^(Linux|Android|iPhone|Mac|Windows)$/.test(d1), { d1, d2 });
		const pool = await dp.evaluate(() => ({ a: NeonArcade.names.adjectives.length, n: NeonArcade.names.nouns.length, fit: NeonArcade.names.adjectives.flatMap((a) => NeonArcade.names.nouns.map((n) => `${a} ${n}`)).filter((s) => s.length <= 16).length }));
		check("…from big lists: at least 200 adjectives and 250 nouns, over 50,000 names that fit the 16-character field", pool.a >= 200 && pool.n >= 250 && pool.fit > 50_000, pool);
		await dc.close();
	}

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
