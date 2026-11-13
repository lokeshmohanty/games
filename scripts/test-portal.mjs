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
	check("a word finds a game by name", (await search("tug")).join() === "Tug of War");
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
} catch (err) {
	check(`unexpected: ${err.message.split("\n")[0]}`, false);
} finally {
	await browser.close();
	site.stop();
}
console.log(failures ? `\n${failures} portal check(s) failed` : "\nall portal checks passed");
process.exit(failures ? 1 : 0);
