// scripts/test-portal.mjs — the portal's search, the bar and tabs on every
// page, the Contributors page and the add-your-game guide, at 390x844.

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
const shown = () => p.evaluate(() => [...document.querySelectorAll(".game-card:not([hidden]) h3")].map((h) => h.textContent));

try {
	console.log("\nportal: search");
	await p.goto(site.url("index.html"));
	await p.waitForSelector(".game-card");
	const all = (await shown()).length;
	const search = async (q) => {
		await p.locator("[data-search]").fill(q);
		return shown();
	};
	check("a word finds a game by name", (await search("swarm")).join() === "Neon Survival", await search("swarm"));
	check("…or by its description", (await search("impostor")).includes("Undercover"));
	check("type:duel — the head-to-head games", JSON.stringify((await search("type:duel")).sort()) === JSON.stringify(["Battleship", "Connect 4"]));
	check("tag:quick", (await search("tag:quick")).length > 0 && (await search("tag:quick")).length < all);
	check("author:lokeshmohanty — everything here is theirs", (await search("author:lokeshmohanty")).length === all);
	check("players:10 — only what seats ten", (await search("players:10")).join() === "Undercover", await search("players:10"));
	check("from:arcade / from:community split the list", (await search("from:arcade")).length + (await search("from:community")).length === all);
	check("terms combine", (await search("type:duel players:2 battle")).join() === "Battleship");
	check("an unknown field matches nothing, and says so", (await search("colour:red")).length === 0 && (await p.locator(".filter-empty:not([hidden])").textContent()).includes("colour:red"));
	await search("type:duel");
	check("the search is in the address, to share", new URL(p.url()).searchParams.get("q") === "type:duel");
	await p.goto(site.url("index.html?q=" + encodeURIComponent("tag:strategy")));
	await p.waitForSelector(".game-card");
	check("…and a link with ?q= opens searched", (await p.locator("[data-search]").inputValue()) === "tag:strategy" && (await shown()).length < all);
	check("a chip and a search narrow together", await (async () => {
		await p.locator('.filter[data-filter="duel"]').click();
		return (await shown()).every((t) => ["Battleship", "Connect 4"].includes(t));
	})());

	console.log("\nportal: a card's two ways to play");
	await p.goto(site.url("index.html"));
	await p.waitForSelector(".game-card");
	const cardInfo = await p.evaluate(() =>
		Object.fromEntries(
			[...document.querySelectorAll(".game-card")].map((c) => [c.dataset.game, [...c.querySelectorAll(".card-play")].map((a) => a.textContent)]),
		),
	);
	check("no PLAY NOW on any card", (await p.locator(".game-card .play-btn").count()) === 0);
	check("a bots game offers PLAY WITH BOTS and PLAY WITH FRIENDS", cardInfo.connect4?.join() === "PLAY WITH BOTS,PLAY WITH FRIENDS", cardInfo.connect4);
	check("…a people-only game only PLAY WITH FRIENDS", cardInfo["lokeshmohanty/draw-guess"]?.join() === "PLAY WITH FRIENDS", cardInfo["lokeshmohanty/draw-guess"]);
	check("…a one-device game just PLAY", cardInfo.undercover?.join() === "PLAY", cardInfo.undercover);
	const c4card = p.locator('.game-card[data-game="connect4"]');
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
	await c4card.locator(".card-play", { hasText: "PLAY WITH BOTS" }).click();
	await p.locator("button", { hasText: "START GAME" }).first().waitFor({ timeout: TIMEOUT });
	check("PLAY WITH BOTS lands with the bots seated: no second choice", (await p.locator(".party-choice").count()) === 0 && (await p.evaluate(() => window.__party.room.getMembers().some((m) => m.id.startsWith("bot_")))));
	check("…and the address forgets the mode, for a reload", !new URL(p.url()).searchParams.has("mode"), p.url());
	await p.goto(site.url("index.html"));
	await p.waitForSelector(".game-card");
	await p.locator('.game-card[data-game="connect4"]').hover();
	await p.locator('.game-card[data-game="connect4"] .card-play', { hasText: "PLAY WITH FRIENDS" }).click();
	await p.locator("button", { hasText: "INVITE A FRIEND" }).first().waitFor({ timeout: TIMEOUT });
	check("PLAY WITH FRIENDS lands on the friends view (invite, and the code when there is a server)", (await p.locator(".party-choice").count()) === 0);
	// A phone: no hover, so the first tap opens the choices and nothing else.
	const touch = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
	const tp = await touch.newPage();
	await tp.goto(site.url("index.html"));
	await tp.waitForSelector(".game-card");
	const tcard = tp.locator('.game-card[data-game="connect4"]');
	await tcard.locator("h3").tap();
	await tp.waitForTimeout(250);
	check("on a phone a tap opens a card's choices, without leaving the page", (await tcard.evaluate((c) => c.classList.contains("is-open"))) && tp.url().endsWith("index.html"));
	const fits = await tcard.locator(".card-play").evaluateAll((as) => as.map((a) => a.getBoundingClientRect()).map((r) => ({ h: Math.round(r.height), right: Math.round(r.right) })));
	check("…two buttons, 44px tall, inside the phone", fits.length === 2 && fits.every((f) => f.h >= 44 && f.right <= 390), fits);
	await tp.locator('.game-card[data-game="neon-bid"] h3').tap();
	check("…and opening another card closes the first", !(await tcard.evaluate((c) => c.classList.contains("is-open"))));
	await touch.close();

	console.log("\nportal: the bar and tabs on every page");
	for (const [page, tab] of [
		["index.html", "Games"],
		["leaderboard.html", "Leaderboards"],
		["contributors.html", "Contributors"],
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
		check(`${page}: tabs Games · Leaderboards · Contributors${tab ? `, on ${tab}` : ""}`, nav.tabs.join() === "Games,Leaderboards,Contributors" && nav.on === tab, nav);
		check(`${page}: fits the phone`, !nav.sideways);
	}

	console.log("\nportal: contributors");
	await p.goto(site.url("contributors.html"));
	await p.locator(".person").first().waitFor({ timeout: TIMEOUT });
	const person = await p.evaluate(() => {
		const c = document.querySelector('.person[data-login="lokeshmohanty"]');
		return {
			name: c?.querySelector("h2")?.textContent,
			bio: c?.querySelector(".person-bio")?.textContent,
			games: c?.querySelector(".person-meta:last-of-type")?.textContent,
			repos: [...(c?.querySelectorAll('.person-links a[href^="https://github.com/"]') ?? [])].map((a) => a.getAttribute("href")),
			see: c?.querySelector(".person-links a")?.getAttribute("href"),
		};
	});
	check("a card from contributor.json: name and bio", person.name === "Lokesh Mohanty" && !!person.bio, person);
	check("…both games repos, merged into one person", person.repos.includes("https://github.com/lokeshmohanty/games") && person.repos.includes("https://github.com/lokeshmohanty/arcade-games"), person.repos);
	check("…SEE THEIR GAMES opens the portal searched by author", person.see === "index.html?q=author%3Alokeshmohanty", person.see);
	await p.locator(".person-links a", { hasText: "SEE THEIR GAMES" }).first().click();
	await p.waitForSelector(".game-card");
	check("…which lists their games", (await p.locator("[data-search]").inputValue()) === "author:lokeshmohanty" && (await shown()).length > 0);

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
	console.log("\nportal: proposing games (GitHub's own page, filled in)");
	// GitHub's API, played here: a new repo with two games, and arcade-games
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
	await p.locator("[data-repo]").fill("https://github.com/lokeshmohanty/arcade-games");
	await p.locator("[data-propose] button").click();
	const pin = p.locator("[data-propose-out] a", { hasText: "COPY THE COMMIT & OPEN THE PIN" });
	await pin.waitFor({ timeout: TIMEOUT });
	check("a pinned repo that moved opens its pin's edit page, with the commit to paste", (await pin.getAttribute("href")) === "https://github.com/lokeshmohanty/games/edit/main/registry/lokeshmohanty/arcade-games.json" && (await p.locator("[data-propose-out] pre").textContent()) === HEAD);
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
} catch (err) {
	check(`unexpected: ${err.message.split("\n")[0]}`, false);
} finally {
	await browser.close();
	site.stop();
}
console.log(failures ? `\n${failures} portal check(s) failed` : "\nall portal checks passed");
process.exit(failures ? 1 : 0);
