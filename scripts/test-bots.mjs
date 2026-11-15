#!/usr/bin/env node
/**
 * test-bots.mjs — every game is playable by one person, on one device.
 *
 *   node scripts/test-bots.mjs
 *
 * The arcade used to sort itself into "single player" and "multiplayer", which
 * meant three of the four games were unplayable unless you could produce a
 * second human on demand. Bots removed that split. What has to hold now:
 *
 *   - a game page opens straight into a playable game with nobody else there
 *   - the bot in it actually plays — not a placeholder that forfeits
 *   - a bot is an ordinary member of the roster to every other peer
 *   - and no peer ever tries to open a WebRTC connection to one
 *
 * The last is the one that would rot quietly: a bot has no browser behind it,
 * so an attempt to reach it costs a full ICE timeout and fails every time, and
 * nothing in the UI would say so.
 *
 * NixOS note: as in test-party.mjs, Playwright's bundled chromium cannot run
 * here, so the nix-provided Chrome is driven through executablePath.
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync, globSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { serve, gameScope, readyToClick } from "./serve.mjs";

const require = createRequire(import.meta.url);
const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const PW_CACHE = join(homedir(), ".cache", "game-previews");
const SITE = await serve(8734);
const url = SITE.url;
// The portal's address (LEAVE PARTY goes there): the shell with no query.
// The portal: ./, or ./ with its sub-tab named (src/router.ts portalAddress).
const PORTAL = (u) => u.pathname === "/" && /^(\?page=games&tab=(mine|all))?$/.test(u.search);
const TIMEOUT = 30_000;

function chromePath() {
	const found = [
		process.env.CHROME,
		"/run/current-system/sw/bin/google-chrome-stable",
		"/run/current-system/sw/bin/chromium",
		join(homedir(), ".nix-profile", "bin", "google-chrome-stable"),
	]
		.filter(Boolean)
		.find((p) => existsSync(p));
	if (!found) {
		console.error("error: no system Chrome found; set CHROME=/path/to/chrome");
		process.exit(1);
	}
	return found;
}

function loadPlaywright() {
	const found = [
		join(ROOT, "node_modules", "playwright"),
		join(PW_CACHE, "node_modules", "playwright"),
		...globSync(join(homedir(), ".npm", "_npx", "*", "node_modules", "playwright")),
	].find((p) => existsSync(p));
	if (!found) {
		execFileSync(
			"npm",
			["install", "--prefix", PW_CACHE, "--no-save", "--no-audit", "playwright"],
			{ stdio: "inherit" },
		);
		return require(join(PW_CACHE, "node_modules", "playwright"));
	}
	return require(found);
}

let failures = 0;
const check = (label, ok, detail = "") => {
	console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
	if (!ok) failures++;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Open a game page and start it with bots — no handshake, no second browser. */
async function startSolo(page, file, button) {
	await page.goto(url(file));
	await page.locator("button", { hasText: button }).first().click();
	await page.locator("button", { hasText: "START GAME" }).first().click();
	await page.waitForFunction(() => window.__game?.handle, null, { timeout: TIMEOUT });
	await gameScope(page, TIMEOUT); // a framed game: wait for its own mount too
}

const debug = async (page) => (await gameScope(page, TIMEOUT)).evaluate(() => window.__game.handle.debug());

/**
 * What this device's stats (lib/stats.js) hold for `game`, and whether they
 * match the game's own ending: played once, against bots only, and won
 * exactly when `iWon`. A result travels game → frame → bridge → party.js.
 */
async function resultReached(page, game, how) {
	// how: "won" | "lost" | "drawn" (everyone level), or a boolean for won/lost.
	if (typeof how === "boolean") how = how ? "won" : "lost";
	const rec = await page
		.waitForFunction((id) => JSON.parse(localStorage.getItem("neon.stats") ?? "{}")[id]?.played >= 1, game, { timeout: 5000 })
		.then(() => page.evaluate((id) => JSON.parse(localStorage.getItem("neon.stats"))[id], game))
		.catch(() => null);
	check(`${game}: its result reached this device's stats, once, against bots`, rec?.played === 1 && rec.vsBots === 1, JSON.stringify(rec));
	check(`${game}: …${how}, as the game itself ended`, rec && rec[how] === 1, JSON.stringify(rec));
}
const selfOf = (page) => page.evaluate(() => window.__party.room.selfId);
/** The running game's scope — its frame for a framed game (gameScope). */
let G = null;

const { chromium } = loadPlaywright();
const browser = await chromium.launch({
	executablePath: chromePath(),
	args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
});
/**
 * A context whose pages never reach the deployed room server. Game pages
 * open parties now, and a party probes the room server: left alone, every
 * run would host real parties on production — spending this address's
 * hosting budget — and leave rejoin tokens that the next page's fresh start
 * then has to release. An unreachable loopback server keeps every party
 * here classic, as the game pages always were.
 */
async function newContext() {
	const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
	await ctx.addInitScript(() => {
		try {
			localStorage.setItem("neon.rs", "http://127.0.0.1:9");
		} catch {}
	});
	return ctx;
}
const context = await newContext();
const page = await context.newPage();
page.on("pageerror", (err) => {
	console.log(`  FAIL page error: ${err.message}`);
	failures++;
});

try {
	// ------------------------------------------------------------ connect 4
	//
	// The bot with something to prove: it is the only one here that has to be
	// *right* rather than merely busy.


	// ------------------------------------------------------------- undercover
	//
	// The one game here that needs no second device and no bots at all: it is
	// played by people in the room, on one phone, passed along. So opening it
	// goes straight into the game — no lobby, no START, no invite, no bot
	// controls (2026-11-14: one-device games start at once) — and the game's
	// one real responsibility is that **a word is never on screen for the
	// wrong person**. Both are asserted; the rest happens between people.

	console.log("\nlocal: undercover needs no second device");
	await page.goto(url("?game=undercover&fresh=1"));
	await page.waitForFunction(() => window.__game?.handle, null, { timeout: TIMEOUT });
	check("it opens straight into the game: no lobby button was needed", !(await page.locator("#party:not([hidden]) button", { hasText: "START" }).isVisible().catch(() => false)));
	G = await gameScope(page, TIMEOUT);

	let uc = await debug(page);
	check("it opens on the player list", uc.phase === "setup", uc.phase);
	check("no word is on screen before anyone is dealt", uc.onScreen === null);

	// Six players, so the blank is allowed.
	for (let i = 0; i < 3; i++) await G.locator("button", { hasText: "+ PLAYER" }).click();
	const inputs = G.locator(".uc-name input");
	const table = ["Ana", "Bo", "Cy", "Di", "Ed", "Fi"];
	for (const [i, name] of table.entries()) await inputs.nth(i).fill(name);

	const setup = await G.evaluate(() => {
		const fields = [...document.querySelectorAll(".uc-name input, .uc-toggle, .uc-step button, .uc-actions button")];
		return {
			docWidth: document.documentElement.scrollWidth,
			winWidth: window.innerWidth,
			minTap: Math.min(...fields.map((f) => Math.round(f.getBoundingClientRect().height))),
			bottom: Math.round(Math.max(...fields.map((f) => f.getBoundingClientRect().bottom))),
		};
	});
	check("the setup screen does not scroll sideways", setup.docWidth <= setup.winWidth, `${setup.docWidth} > ${setup.winWidth}`);
	check("every field and button clears 44px", setup.minTap >= 44, `${setup.minTap}px`);
	check("the whole form fits the phone", setup.bottom <= 844, `${setup.bottom}px`);

	// The host picks topics on a screen of their own, so the player list keeps
	// fitting the phone however many topics there are.
	await G.locator("button", { hasText: "WORDS:" }).click();
	check("WORDS opens the topic picker", (await debug(page)).phase === "words");
	await G.locator("button", { hasText: "NONE" }).click();
	check("with no topic picked, DONE is refused",
		await G.locator("button", { hasText: "DONE" }).isDisabled());
	await G.locator(".uc-cats button", { hasText: "Animals" }).click();
	await G.locator("button", { hasText: "HARD" }).click();
	const words = await G.evaluate(() => {
		const fields = [...document.querySelectorAll(".uc-toggle, .uc-actions button")];
		return {
			docWidth: document.documentElement.scrollWidth,
			winWidth: window.innerWidth,
			minTap: Math.min(...fields.map((f) => Math.round(f.getBoundingClientRect().height))),
			bottom: Math.round(Math.max(...fields.map((f) => f.getBoundingClientRect().bottom))),
		};
	});
	check("the topic picker does not scroll sideways", words.docWidth <= words.winWidth, `${words.docWidth} > ${words.winWidth}`);
	check("every topic and button clears 44px", words.minTap >= 44, `${words.minTap}px`);
	check("the whole picker fits the phone", words.bottom <= 844, `${words.bottom}px`);
	uc = await debug(page);
	check("the choice is one topic, hard pairs", uc.categories.join() === "animals" && uc.wordLevel === "hard",
		`${uc.categories}/${uc.wordLevel}`);
	await G.locator("button", { hasText: "DONE" }).click();
	check("DONE goes back to the player list", (await debug(page)).phase === "setup");
	check("which says what will be dealt",
		(await G.locator("button", { hasText: "WORDS: ANIMALS · HARD" }).count()) === 1);

	await G.locator("button", { hasText: "BLANK: OFF" }).click();
	await G.locator("button", { hasText: "DEAL" }).click();
	await G.waitForFunction(() => window.__game.handle.debug().phase === "pass", null, { timeout: TIMEOUT });

	uc = await debug(page);
	check("six players were dealt", uc.players.length === 6, `${uc.players.length}`);
	check("one undercover, one blank, four civilians",
		uc.players.filter((p) => p.role === "spy").length === 1
		&& uc.players.filter((p) => p.role === "blank").length === 1
		&& uc.players.filter((p) => p.role === "civilian").length === 4,
		JSON.stringify(uc.players.map((p) => p.role)));
	check("the two words differ", uc.civilianWord !== uc.spyWord, `${uc.civilianWord}/${uc.spyWord}`);
	check("the pair came from the chosen topic and difficulty", uc.category === "Animals" && uc.level === "hard",
		`${uc.category}/${uc.level}`);
	check("and the phone remembers it was dealt", uc.seen >= 1, `${uc.seen}`);
	// The whole point: the phone has just changed hands, so nothing is showing.
	check("nothing is on screen until somebody taps", uc.onScreen === null);
	check("and no word is in the DOM either",
		!(await G.locator(".uc-word").count()), "a word was rendered before the tap");

	// A reload mid-hand (a locked phone, a tab the OS threw away) carries the
	// hand on from the game's session (SDK v2 session.set) — but never with a
	// word on screen: whoever holds the phone taps again.
	async function reloadGame() {
		await page.reload();
		await page.waitForFunction(() => window.__game?.handle, null, { timeout: TIMEOUT });
		G = await gameScope(page, TIMEOUT);
		await readyToClick(page);
		return debug(page);
	}

	// Walk the deal, checking each person sees their own word and only theirs.
	const seen = [];
	for (let i = 0; i < 6; i++) {
		if (i === 2) {
			const before = await debug(page);
			await G.locator("button", { hasText: "TAP TO SEE" }).click();
			check(`(${table[i]}'s word is on screen as the page reloads)`, (await debug(page)).onScreen === table[i]);
			const after = await reloadGame();
			check("a reload mid-deal keeps the hand: the same roles and words",
				JSON.stringify(after.players) === JSON.stringify(before.players) && after.civilianWord === before.civilianWord);
			check(`…back on ${table[i]}'s turn to look`,
				after.phase === "pass" && (await G.locator(".uc-big", { hasText: `Pass to ${table[i]}` }).count()) === 1, after.phase);
			check("…with no word on screen, or in the DOM", after.onScreen === null && !(await G.locator(".uc-word").count()));
			check("…and nothing dealt again", after.seen === before.seen, `${before.seen} → ${after.seen}`);
		}
		await G.locator("button", { hasText: "TAP TO SEE" }).click();
		const state = await debug(page);
		const shown = await G.locator(".uc-word").textContent();
		seen.push({ who: state.onScreen, shown });
		if (i === 0) check("the reveal names the topic",
			(await G.locator(".uc-hint", { hasText: "Topic: Animals" }).count()) === 1);
		check(`${state.onScreen} is shown exactly one word`,
			(await G.locator(".uc-word").count()) === 1, "more than one word on screen");
		await G.locator("button", { hasText: "HIDE &" }).click();
		const after = await debug(page);
		check(`and it is gone once ${state.onScreen} passes it on`, after.onScreen === null);
	}

	uc = await debug(page);
	check("the phone went round everybody, in order",
		seen.map((x) => x.who).join() === table.join(), seen.map((x) => x.who).join());
	// Each person saw *their own* word, and the civilians all saw the same one.
	const byName = Object.fromEntries(uc.players.map((p) => [p.name, p]));
	check("everybody saw their own word",
		seen.every((x) => x.shown === (byName[x.who].word ?? "—")),
		JSON.stringify(seen));
	check("the civilians all saw the same word",
		new Set(seen.filter((x) => byName[x.who].role === "civilian").map((x) => x.shown)).size === 1);
	check("the undercover saw a different one",
		seen.find((x) => byName[x.who].role === "spy").shown !== uc.civilianWord);
	check("the blank saw no word at all",
		seen.find((x) => byName[x.who].role === "blank").shown === "—");
	check("dealing ends in the describing round", uc.phase === "describe", uc.phase);
	check("the speaking order is everybody, shuffled", uc.order.length === 6 && new Set(uc.order).size === 6);

	// A vote must take two taps: one to pick, one to confirm. A stray thumb on a
	// phone going round a table would otherwise knock somebody out for good.
	while ((await debug(page)).phase === "describe") {
		await G.locator("button", { hasText: /^(NEXT|GO TO VOTE)$/ }).first().click();
	}
	uc = await debug(page);
	check("the round ends at a vote", uc.phase === "vote", uc.phase);
	await G.locator(".uc-row.pick").first().click();
	check("picking somebody does not yet eliminate them",
		(await debug(page)).phase === "vote" && (await debug(page)).alive === 6,
		"one tap was enough to vote somebody out");
	check("a confirmation appears instead",
		(await G.locator("button", { hasText: "VOTE OUT" }).count()) === 1);
	await G.locator("button", { hasText: "VOTE OUT" }).click();
	uc = await debug(page);
	check("confirming eliminates them", uc.alive === 5, `${uc.alive}`);
	check("and says what they were", ["reveal", "guess"].includes(uc.phase), uc.phase);
	const reloaded = await reloadGame();
	check("a reload after the vote comes back to the same screen, the same people out",
		reloaded.phase === uc.phase && reloaded.alive === 5 && reloaded.order.join() === uc.order.join(),
		`${reloaded.phase}/${reloaded.alive}`);

	// ----------------------------------------------------------- liar's dice
	//
	// The other unrefereed game, and the one where the wrong build is the
	// tempting one: have the host roll everybody's dice and mail each player
	// their hand. Nobody deals here — each player rolls their own and commits
	// before a bid is made — so what is checked is that every cup was committed
	// to *before* the bidding, and that lifting them audits clean.

	console.log("\nbots: liar's dice commits every cup before a bid");
	await startSolo(page, "?game=lokeshmohanty%2Fliars-dice&fresh=1", "SINGLE PLAYER");
	G = await gameScope(page, TIMEOUT);
	await readyToClick(page);
	await sleep(1200);

	let ld = await debug(page);
	check("two seats, five dice each", ld.seats.length === 2 && ld.seats.every((s) => s.dice === 5), JSON.stringify(ld.seats));
	check("both cups are committed before any bidding", ld.digests === 2, `${ld.digests}`);
	check("we can see our own five dice", ld.myDice === 5, `${ld.myDice}`);
	check("and nobody else's", ld.revealed === 0, `${ld.revealed}`);
	check("the bidding is open", ld.phase === "bid", ld.phase);
	check("ten dice on the table", ld.totalDice === 10, `${ld.totalDice}`);

	const dice = await G.evaluate(() => {
		const btns = [...document.querySelectorAll(".ld-faces button")];
		const acts = [...document.querySelectorAll(".ld-actions button")];
		const steps = [...document.querySelectorAll(".ld-count button")];
		const all = [...btns, ...acts, ...steps];
		return {
			docWidth: document.documentElement.scrollWidth,
			winWidth: window.innerWidth,
			faces: btns.length,
			minTap: all.length ? Math.min(...all.map((b) => Math.round(b.getBoundingClientRect().height))) : 0,
			bottom: Math.round(Math.max(...[...document.querySelectorAll(".ld-actions, .ld-mine")]
				.map((e) => e.getBoundingClientRect().bottom))),
			ownDiceShown: document.querySelectorAll(".ld-mine span").length,
		};
	});
	check("you can bid on every face but ones", dice.faces === 5, `${dice.faces}`);
	check("liar's dice does not scroll sideways", dice.docWidth <= dice.winWidth, `${dice.docWidth} > ${dice.winWidth}`);
	check("every control clears 44px", dice.minTap >= 44, `${dice.minTap}px`);
	check("nothing runs off the bottom", dice.bottom <= 844, `${dice.bottom}px`);
	check("your own five dice are on screen", dice.ownDiceShown === 5, `${dice.ownDiceShown}`);

	// Bid the minimum, then let the bot answer, until a call settles a round.
	// The chain being tested is commit → bid → call → every cup opened →
	// verified → somebody loses a die.
	//
	// Two of our own bids, then call — deliberately, rather than by any
	// judgement of the odds. Bidding "well" here deadlocks: the minimum legal
	// raise is always plausible, so neither side ever has a reason to call and
	// the round runs until the phase deadline. The test wants the chain, not a
	// good game of dice.
	let myBids = 0;
	for (let i = 0; i < 120; i++) {
		const d = await debug(page);
		if (d.lastCall || d.over) break;
		myBids += await G.evaluate((bidsSoFar) => {
			const btns = [...document.querySelectorAll(".ld-actions button")];
			const bid = btns.find((b) => b.textContent.startsWith("BID"));
			const liar = btns.find((b) => b.textContent.includes("LIAR"));
			if (liar && bidsSoFar >= 2) {
				liar.click();
				return 0;
			}
			if (bid && !bid.disabled) {
				bid.click();
				return 1;
			}
			if (liar) liar.click();
			return 0;
		}, myBids);
		await sleep(300);
	}

	ld = await debug(page);
	check("a call settled a round", !!ld.lastCall, JSON.stringify({ phase: ld.phase, bid: ld.bid }));
	check("every cup was opened", ld.revealed === 2, `${ld.revealed}`);
	check("and every one audited clean", Object.values(ld.verdicts).every((v) => v === null), JSON.stringify(ld.verdicts));
	check("somebody lost a die", ld.seats.some((s) => s.dice === 4), JSON.stringify(ld.seats.map((s) => s.dice)));
	check("the count that settled it was recorded", Number.isInteger(ld.lastCall?.actual), JSON.stringify(ld.lastCall));
	// "At least", not "exactly" — the rule the whole game turns on.
	check("the call was settled by the at-least rule",
		!!ld.lastCall && ld.lastCall.bidderWasRight === (ld.lastCall.actual >= ld.lastCall.bid.count),
		JSON.stringify(ld.lastCall));

	// ------------------------------------------------------------- neon bid
	//
	// A full table — you and seven bots, the most a phone has to hold — played
	// through all twelve lots. What is checked: the lot order is public before
	// the first bid, every bid is sealed before any is opened, every opening
	// audits clean, the second-price arithmetic adds up across the whole game,
	// and at 390x844 the gem row, the bid controls, the reveal and the final
	// table all fit without sideways scroll.

	console.log("\nbots: neon bid plays twelve sealed lots at a full table");
	await page.goto(url("?game=neon-bid&fresh=1"));
	await page.locator("button", { hasText: "SINGLE PLAYER" }).first().click();
	for (let i = 0; i < 6; i++) await page.locator("button", { hasText: "ADD BOT" }).first().click();
	await page.locator("button", { hasText: "START GAME" }).first().click();
	await page.waitForFunction(() => window.__game?.handle, null, { timeout: TIMEOUT });
	G = await gameScope(page, TIMEOUT);
	await G.waitForFunction(() => window.__game.handle.debug().phase === "bid", null, { timeout: TIMEOUT });

	let nb = await debug(page);
	check("eight seats, 100 credits each", nb.players.length === 8 && nb.players.every((p) => p.credits === 100), JSON.stringify(nb.players.map((p) => p.credits)));
	check("all twelve lots are laid out before the first bid", nb.order.length === 12 && nb.lot === 0, `${nb.order.length} lots, at ${nb.lot}`);
	await G.waitForFunction(() => window.__game.handle.debug().submitted.length === 7, null, { timeout: TIMEOUT })
		.catch(() => {});
	nb = await debug(page);
	check("the bots have sealed their bids and are waiting on you", nb.submitted.length === 7 && !nb.committed, JSON.stringify(nb.submitted));

	const nbLayout = () => G.evaluate(() => {
		const r = (sel) => [...document.querySelectorAll(sel)].map((e) => e.getBoundingClientRect());
		const ctrls = r(".nb-step button, .nb-chips button, .nb-go");
		const slots = r(".nb-slot");
		return {
			docWidth: document.documentElement.scrollWidth,
			winWidth: window.innerWidth,
			slots: slots.length,
			rowRight: Math.round(Math.max(...slots.map((b) => b.right))),
			rowLeft: Math.round(Math.min(...slots.map((b) => b.left))),
			controls: ctrls.length,
			minTap: ctrls.length ? Math.round(Math.min(...ctrls.map((b) => b.height))) : 0,
			bottom: Math.round(Math.max(0, ...r(".nb-panel > *, .nb-seats, .nb-lot").map((b) => b.bottom))),
			worth: document.querySelector(".nb-worth")?.textContent ?? "",
			go: document.querySelector(".nb-go")?.textContent ?? "",
			chips: [...document.querySelectorAll(".nb-chips button")].map((b) => b.textContent),
			cards: document.querySelectorAll(".nb-card").length,
			rows: document.querySelectorAll(".nb-table tr").length - 1,
		};
	});

	let lay = await nbLayout();
	check("the gem row shows all twelve lots", lay.slots === 12, `${lay.slots}`);
	check("and fits across the phone", lay.rowLeft >= 0 && lay.rowRight <= 390, `${lay.rowLeft}..${lay.rowRight}`);
	check("neon bid does not scroll sideways", lay.docWidth <= lay.winWidth, `${lay.docWidth} > ${lay.winWidth}`);
	check("stepper, chips 0/5/10/25 and BID are all there", lay.controls === 7 && lay.chips.join() === "0,5,10,25", JSON.stringify(lay.chips));
	check("every control clears 44px", lay.minTap >= 44, `${lay.minTap}px`);
	check("nothing runs off the bottom with eight players", lay.bottom <= 844, `${lay.bottom}px`);
	check("the current gem says what it is worth to you", /^\+\d+ points? to you/.test(lay.worth), lay.worth);

	// Bid the first lot by the stepper so the control is exercised, then lean
	// on the chips. The bid is sealed, so the button must stop being a button.
	await G.locator(".nb-chips button", { hasText: /^5$/ }).click();
	await G.locator(".nb-step button[aria-label='bid one more']").click();
	lay = await nbLayout();
	check("chip then + gives 6", lay.go === "BID 6", lay.go);
	await G.locator(".nb-go").click();
	await G.waitForFunction(() => window.__game.handle.debug().committed || window.__game.handle.debug().phase !== "bid", null, { timeout: TIMEOUT });
	await G.waitForFunction(() => window.__game.handle.debug().phase === "show", null, { timeout: TIMEOUT });
	lay = await nbLayout();
	check("all eight bids flip over together", lay.cards === 8, `${lay.cards}`);
	check("the reveal fits the phone", lay.bottom <= 844 && lay.docWidth <= lay.winWidth, JSON.stringify({ bottom: lay.bottom, w: lay.docWidth }));
	nb = await debug(page);
	check("our bid was opened as sealed", nb.results[0]?.bids?.[nb.players[0].id] === 6, JSON.stringify(nb.results[0]?.bids));

	// The rest of the game, as a person would play it. Watched throughout: the
	// lot being bid on (the round clock, what the screen shows) must be the lot
	// the game settles next. They once drifted a lot apart after the first
	// reveal, settling each lot under bidding as "everybody passed" — and every
	// check below still passed, because those phantom lots add up.
	const chipsCycle = ["10", "0", "5", "25"];
	const placed = { 0: 6 };
	const drift = [];
	const nbSeen = {};
	for (let i = 0; i < 400; i++) {
		const d = await debug(page);
		if (d.over) break;
		if (d.phase === "bid" && (d.lot !== d.round || d.results.length !== d.round)) {
			drift.push(`bidding lot ${d.round} with lot ${d.lot} next and ${d.results.length} settled`);
		}
		// Our sealed bid stays readable through the reveal; the bid phase itself
		// ends the moment we commit, the last of eight.
		if (d.committed) placed[d.round] = d.myBid;
		if (d.phase === "bid") nbSeen[d.round] ??= Date.now();
		// Bid after a person's pause, not at machine speed: a bid placed within
		// ~0.8s of the lot opening is exactly what hid that drift.
		if (d.phase === "bid" && !d.committed && Date.now() - nbSeen[d.round] >= 1_200) {
			const want = chipsCycle[d.lot % chipsCycle.length];
			await G.evaluate((want) => {
				const chip = [...document.querySelectorAll(".nb-chips button")].find((b) => b.textContent === want && !b.disabled)
					?? document.querySelector(".nb-chips button");
				chip?.click();
				document.querySelector(".nb-go:not([disabled])")?.click();
			}, want);
		}
		await sleep(250);
	}
	await sleep(500);
	nb = await debug(page);
	check("the game reaches the final table", !!nb.over, JSON.stringify({ phase: nb.phase, lot: nb.lot }));
	check("all twelve lots were settled", nb.results.length === 12, `${nb.results.length}`);
	check("the lot on screen is always the lot being settled", !drift.length, [...new Set(drift)].slice(0, 3).join("; "));
	const meBid = nb.players[0].id;
	const lostBids = Object.entries(placed).filter(([lot, bid]) => nb.results[lot]?.bids?.[meBid] !== bid);
	check(`every bid we sealed (${Object.keys(placed).length} lots) was the bid settled for that lot`, lostBids.length === 0,
		lostBids.map(([lot, bid]) => `lot ${lot}: sealed ${bid}, settled ${nb.results[lot]?.bids?.[meBid]}`).join("; "));
	check("every opening audited clean", nb.results.every((r) => Object.keys(r.problems ?? {}).length === 0),
		JSON.stringify(nb.results.map((r) => r.problems)));
	// Second price, summed over the whole game: nobody paid more than they bid,
	// the winner never paid more than the runner-up offered, and the credits add up.
	const paid = Object.fromEntries(nb.players.map((p) => [p.id, 0]));
	let priced = true;
	for (const r of nb.results) {
		if (r.kind !== "won") continue;
		paid[r.winner] += r.price;
		const others = Object.entries(r.bids).filter(([id]) => id !== r.winner).map(([, b]) => b);
		const second = Math.max(0, ...others);
		if (r.price !== (second > 0 ? second : 1) || r.price > r.bids[r.winner]) priced = false;
	}
	check("every winner paid the second-highest bid (or the reserve)", priced);
	check("credits add up: 100 less what each paid", nb.players.every((p) => p.credits === 100 - paid[p.id]),
		JSON.stringify(nb.players.map((p) => [p.credits, paid[p.id]])));
	check("gems in hands = lots won", nb.players.reduce((s, p) => s + p.hand.reduce((a, b) => a + b, 0), 0)
		=== nb.results.filter((r) => r.kind === "won").length);
	lay = await nbLayout();
	check("the end table lists all eight", lay.rows === 8, `${lay.rows}`);
	check("and fits the phone", lay.bottom <= 844 && lay.docWidth <= lay.winWidth, JSON.stringify({ bottom: lay.bottom, w: lay.docWidth }));
	check("the winners are the top of the table", nb.over.winners.includes(nb.over.rows[0].id));
	const meNb = await selfOf(page);
	await resultReached(page, "neon-bid", nb.over.winners.length === nb.over.rows.length ? "drawn" : nb.over.winners.includes(meNb) ? "won" : "lost");

	// ------------------------------------------------------------ battleship
	//
	// The game the plumbing exists for. What is checked here is the whole chain
	// end to end — both fleets committed before a shot, both firing in the same
	// round, each player answering for its own board, both fleets opened at the
	// end and every answer re-checked. The last check is the one that matters:
	// a game rigged to answer dishonestly must be *caught*, or the commitment is
	// decoration.

	console.log("\nbots: battleship commits, fires and audits");
	await startSolo(page, "?game=lokeshmohanty%2Fbattleship&fresh=1", "SINGLE PLAYER");
	G = await gameScope(page, TIMEOUT);
	await readyToClick(page);

	let bs = await debug(page);
	check("it opens on placement", bs.phase === "place", bs.phase);
	check("a fleet is already laid out to commit", bs.myFleetCells === 12, `${bs.myFleetCells}`);
	check("nothing is committed yet", !bs.committed && bs.digests === 0);

	// Mobile-first, asserted: placement is one board and it should own the screen.
	const place = await G.evaluate(() => {
		const grids = [...document.querySelectorAll(".bs-grid")].filter((g) => g.offsetParent);
		const box = grids[0]?.getBoundingClientRect();
		const cell = grids[0]?.querySelector(".bs-cell")?.getBoundingClientRect();
		const btns = [...document.querySelectorAll(".bs-ship, .bs-actions .neon-btn")]
			.map((b) => Math.round(b.getBoundingClientRect().height));
		return {
			docWidth: document.documentElement.scrollWidth,
			winWidth: window.innerWidth,
			visibleGrids: grids.length,
			w: Math.round(box?.width ?? 0),
			bottom: Math.round(box?.bottom ?? 0),
			cell: Math.round(cell?.width ?? 0),
			minBtn: btns.length ? Math.min(...btns) : 0,
		};
	});
	check("only your own board is shown while placing", place.visibleGrids === 1, `${place.visibleGrids}`);
	check("placing does not scroll the page sideways", place.docWidth <= place.winWidth, `${place.docWidth} > ${place.winWidth}`);
	check("the placement board fits the phone", place.w > 200 && place.w <= 390, `${place.w}px`);
	check("its squares are big enough to tap", place.cell >= 30, `${place.cell}px`);
	check("every control clears 44px", place.minBtn >= 44, `${place.minBtn}px`);

	await G.locator("button", { hasText: "COMMIT FLEET" }).click();
	await G.waitForFunction(() => window.__game.handle.debug().phase === "fire", null, { timeout: TIMEOUT });
	bs = await debug(page);
	check("both fleets are committed before a shot is fired", bs.digests === 2, `${bs.digests}`);
	check("no shot has been fired yet", bs.shotsAtMe === 0 && bs.shotsAtThem === 0);

	const battle = await G.evaluate(() => ({
		visibleGrids: [...document.querySelectorAll(".bs-grid")].filter((g) => g.offsetParent).length,
		bottom: Math.round(Math.max(...[...document.querySelectorAll(".bs-grid")]
			.filter((g) => g.offsetParent).map((g) => g.getBoundingClientRect().bottom))),
		docWidth: document.documentElement.scrollWidth,
		winWidth: window.innerWidth,
	}));
	check("both boards are on screen once the shooting starts", battle.visibleGrids === 2, `${battle.visibleGrids}`);
	check("both boards fit the phone", battle.bottom <= 844 && battle.docWidth <= battle.winWidth, JSON.stringify(battle));

	// Play it out, using the game's own targeting so a game actually ends.
	for (let i = 0; i < 300; i++) {
		const d = await debug(page);
		if (d.over) break;
		if (d.phase === "fire") {
			await G.evaluate(() => {
				const d = window.__game.handle.debug();
				// SDK v2 (no NeonArcade in the frame): the rules are window.battleshipRules.
				const at = (window.battleshipRules ?? window.NeonArcade.battleshipRules).botTarget(d.theirBoard);
				if (!at) return;
				const cell = document.querySelector(`.bs-grid .bs-cell[data-r="${at[0]}"][data-c="${at[1]}"]`);
				if (cell && !cell.disabled) cell.click();
			});
		}
		await sleep(130);
	}
	await sleep(1500);
	bs = await debug(page);
	check("the game reaches a result", !!bs.over, JSON.stringify({ phase: bs.phase, shots: bs.shotsAtThem }));
	check("both sides fired the same number of volleys", bs.shotsAtMe === bs.shotsAtThem, `${bs.shotsAtMe} vs ${bs.shotsAtThem}`);
	check("the loser's fleet is fully sunk", bs.hitsOnThem === 12 || bs.hitsOnMe === 12, `${bs.hitsOnThem}/${bs.hitsOnMe}`);
	check("both fleets were revealed", bs.fleetsRevealed === 2, `${bs.fleetsRevealed}`);
	check("and both audited clean", Object.values(bs.audits).every((a) => a === null), JSON.stringify(bs.audits));
	check("the phase leaves the firing state", bs.phase === "over", bs.phase);
	if (bs.over?.winner !== undefined) await resultReached(page, "lokeshmohanty/battleship", bs.over.winner === (await selfOf(page)));

	// The claim, tested by breaking it: a fleet that does not match the answers
	// given must fail the audit. This is done against the real helper rather
	// than a mock, because the digest and the answer-replay are two separate
	// checks and only both together make the game honest.
	const caught = await G.evaluate(async () => {
		const R = window.battleshipRules ?? window.NeonArcade.battleshipRules;
		const honestFleet = R.randomFleet();
		const hits = new Set();
		const answers = [];
		for (let r = 0; r < 8; r++) {
			for (let c = 0; c < 8; c++) {
				const a = R.answerShot(honestFleet, hits, r, c);
				if (a.hit) hits.add(R.key(r, c));
				answers.push({ at: [r, c], hit: a.hit, sunk: a.sunk });
			}
		}
		// Deny one real hit — the cheat a player would actually try.
		const lied = answers.map((a) => (a.hit && !a.sunk ? { ...a, hit: false, sunk: null } : a));
		return {
			honest: R.auditAnswers(honestFleet, answers) === null,
			lieCaught: R.auditAnswers(honestFleet, lied) !== null,
		};
	});
	check("an honest board passes the audit in the page", caught.honest);
	check("denying a hit is caught by the audit in the page", caught.lieCaught);

	// -------------------------------------------------------- light cycles
	//
	// The busiest thing here: eight riders, a tick every 100ms, and the host
	// simulating every bot. What is checked is that a round actually *ends* —
	// a space-filling bot that never crashes and never gets cornered would
	// leave a round running forever, and on a phone that is a hot battery
	// rather than a game.

	console.log("\nbots: light cycles runs a whole round on a phone");
	await page.goto(url("?game=lokeshmohanty%2Flight-cycles&fresh=1"));
	await page.locator("button", { hasText: "SINGLE PLAYER" }).first().click();
	for (let i = 0; i < 3; i++) {
		await page.locator("button", { hasText: "ADD BOT" }).first().click();
	}
	await page.locator("button", { hasText: "START GAME" }).first().click();
	await page.waitForFunction(() => window.__game?.handle, null, { timeout: TIMEOUT });
	G = await gameScope(page, TIMEOUT);
	await readyToClick(page);

	let lc = await debug(page);
	check("four riders took the arena", lc.riders.length === 4, `${lc.riders.length}`);
	check("three of them are bots", lc.riders.filter((r) => r.id.startsWith("bot_")).length === 3);
	check("nobody starts on top of anybody", new Set(lc.riders.map((r) => `${r.c},${r.r}`)).size === 4);

	// It opens on a countdown rather than throwing everyone straight into a
	// wall before they have found their thumbs.
	check("a round opens with a countdown, not a race", lc.countdown > 0 && !lc.racing, JSON.stringify({ c: lc.countdown, r: lc.racing }));

	await G.waitForFunction(() => window.__game.handle.debug().racing, null, { timeout: TIMEOUT });
	const wallsAtStart = (await debug(page)).walls;
	await sleep(1500);
	lc = await debug(page);
	check("walls are being laid down", lc.walls > wallsAtStart, `${wallsAtStart} -> ${lc.walls}`);

	const arena = await G.evaluate(() => {
		const box = document.querySelector(".lc-arena").getBoundingClientRect();
		const zones = [...document.querySelectorAll(".lc-zone")].map((z) => Math.round(z.getBoundingClientRect().width));
		return {
			docWidth: document.documentElement.scrollWidth,
			winWidth: window.innerWidth,
			w: Math.round(box.width),
			h: Math.round(box.height),
			bottom: Math.round(box.bottom),
			zones,
		};
	});
	check("the arena does not scroll the page sideways", arena.docWidth <= arena.winWidth, `${arena.docWidth} > ${arena.winWidth}`);
	check("the arena fits the phone", arena.w <= 390 && arena.bottom <= 844, JSON.stringify(arena));
	// Steering is the whole interface, so each half has to be a real target.
	check("both steering halves are wide enough to hit", arena.zones.length === 2 && Math.min(...arena.zones) >= 100, JSON.stringify(arena.zones));

	// The round must reach a result on its own.
	await G.waitForFunction(() => window.__game.handle.debug().racing === false, null, { timeout: 60_000 });
	lc = await debug(page);
	check("the round ends by itself", lc.racing === false);
	check("at most one rider is left standing", lc.riders.filter((r) => r.alive).length <= 1, `${lc.riders.filter((r) => r.alive).length}`);
	check("somebody scored, or everybody crashed",
		lc.winner === null || lc.riders.some((r) => r.wins === 1),
		JSON.stringify({ winner: lc.winner, wins: lc.riders.map((r) => r.wins) }));
	await resultReached(page, "lokeshmohanty/light-cycles", lc.winner === (await selfOf(page)));

	// -------------------------------------------------------- bubble rush
	//
	// The other ticking game, and the one where a tap is an action the host
	// judges: a phone sends where the finger landed and when, never which
	// bubble, and the host hit-tests it against its own field. Checked here
	// as a person plays it — a real click on a bubble scores, a click on
	// empty field does not — and the 60-second round has to end by itself
	// with the bots on every other seat having played.

	console.log("\nbots: bubble rush, a whole round against three bots");
	await page.goto(url("?game=lokeshmohanty%2Fbubble-rush&fresh=1"));
	await page.locator("button", { hasText: "SINGLE PLAYER" }).first().click();
	for (let i = 0; i < 3; i++) await page.locator("button", { hasText: "ADD BOT" }).first().click();
	await page.locator("button", { hasText: "START GAME" }).first().click();
	await page.waitForFunction(() => window.__game?.handle, null, { timeout: TIMEOUT });
	G = await gameScope(page, TIMEOUT);
	await G.waitForFunction(() => window.__game.handle.debug().phase === "setup", null, { timeout: TIMEOUT });
	await readyToClick(page);
	const brSetup = await G.evaluate(() => {
		const btns = [...document.querySelectorAll(".br-setup button")];
		const boxes = btns.map((b) => b.getBoundingClientRect());
		return {
			labels: btns.map((b) => b.textContent),
			teamsOff: !!document.querySelector('.br-setup button[data-mode="teams"]')?.disabled,
			minH: Math.min(...boxes.map((b) => b.height)),
			right: Math.max(...boxes.map((b) => b.right)),
			bottom: Math.max(...boxes.map((b) => b.bottom)),
			top: Math.min(...boxes.map((b) => b.top)),
			doc: document.documentElement.scrollWidth,
		};
	});
	check("the host picks the mode, then START", brSetup.labels.join() === "FREE-FOR-ALL,TEAMS,START", brSetup.labels.join());
	check("…TEAMS waits for players on both sides", brSetup.teamsOff);
	check("…44px taps, on a 390x844 screen, clear of the top band, no sideways scroll",
		brSetup.minH >= 44 && brSetup.right <= 390 && brSetup.bottom <= 844 && brSetup.top >= 52 && brSetup.doc <= 390, JSON.stringify(brSetup));
	await G.locator(".br-setup button", { hasText: "START" }).click();
	await G.waitForFunction(() => window.__game.handle.debug().phase !== "setup", null, { timeout: TIMEOUT });
	let br = await debug(page);
	check("START opens on a countdown, not on bubbles", br.phase === "count" || (br.phase === "play" && br.t < 500), JSON.stringify({ phase: br.phase, t: br.t }));
	await G.waitForFunction(() => window.__game.handle.debug().phase === "play", null, { timeout: TIMEOUT });
	const brFit = await G.evaluate(() => {
		const canvas = document.querySelector(".br-field canvas");
		const c = canvas.getBoundingClientRect();
		const hud = document.querySelector(".br-hud").getBoundingClientRect();
		return { left: c.left, right: c.right, top: c.top, bottom: c.bottom, hudTop: hud.top, doc: document.documentElement.scrollWidth, dpr: canvas.width / canvas.clientWidth };
	});
	check("the field fills the phone below the scores, clear of the top band, no sideways scroll",
		brFit.left >= 0 && brFit.right <= 390 && brFit.bottom <= 844 && brFit.hudTop >= 52 && brFit.bottom - brFit.top > 500 && brFit.doc <= 390, JSON.stringify(brFit));
	check("…drawn at the device's pixel ratio", Math.abs(brFit.dpr - Math.min(3, await G.evaluate(() => devicePixelRatio))) < 0.05, `${brFit.dpr}`);

	// A person's taps, judged by the host. The canvas is in the frame; the
	// mouse is the page's, which reaches into it. A bubble's place is in the
	// canvas's content box: the page box less the canvas's own border.
	const canvasBox = await G.locator(".br-field canvas").boundingBox();
	const inset = await G.evaluate(() => {
		const c = document.querySelector(".br-field canvas");
		return { x: c.clientLeft, y: c.clientTop };
	});
	const tapField = (x, y) => page.mouse.click(canvasBox.x + inset.x + x, canvasBox.y + inset.y + y);
	let popped = false;
	for (let i = 0; i < 60 && !popped; i++) {
		const d = await debug(page);
		const b = d.bubbles.filter((b) => b.k !== "x" && b.py > b.pr && b.py < d.field.h - b.pr).sort((p, q) => p.py - q.py)[0];
		if (b && !d.stunned) {
			const before = d.scores[d.you] ?? 0;
			await tapField(b.px, b.py);
			await sleep(300);
			popped = ((await debug(page)).scores[d.you] ?? 0) > before;
		} else await sleep(150);
	}
	check("a tap on a bubble pops it: the host judged it and scored it", popped);
	// Empty field: a spot near the top no bubble is near, as far as this phone sees.
	let missed = null;
	for (let i = 0; i < 40 && missed === null; i++) {
		const d = await debug(page);
		const spot = [[0.08, 0.04], [0.92, 0.04], [0.5, 0.04]]
			.map(([x, y]) => [d.field.w * x, d.field.h * y])
			.find(([x, y]) => d.bubbles.every((b) => Math.hypot(b.px - x, b.py - y) > b.pr + 40));
		if (spot && !d.stunned) {
			const before = d.scores[d.you] ?? 0;
			await tapField(...spot);
			await sleep(300);
			const after = await debug(page);
			missed = { before, after: after.scores[d.you] ?? 0, streak: after.streak, misses: after.misses - d.misses };
		} else await sleep(150);
	}
	check("a tap on empty field scores nothing, counts one miss on the host, and breaks the streak", missed && missed.after === missed.before && missed.misses === 1 && missed.streak === 0, JSON.stringify(missed));
	// A phone turned sideways (844x390): the 1 : 2 field would be about 130px
	// wide, so the game asks for the phone upright instead; turned back, it plays.
	await page.setViewportSize({ width: 844, height: 390 });
	const sideways = await G.waitForFunction(() => window.__game.handle.debug().turnUpright, null, { timeout: 5000 }).then(() => true, () => false);
	const sidewaysFit = await G.evaluate(() => {
		const hint = document.querySelector(".br-turn").getBoundingClientRect();
		return { hint: [hint.width, hint.height].map(Math.round), text: document.querySelector(".br-turn").textContent, doc: document.documentElement.scrollWidth, win: innerWidth };
	});
	check("sideways at 844x390: TURN YOUR PHONE UPRIGHT over the field, no sideways scroll",
		sideways && /UPRIGHT/.test(sidewaysFit.text) && sidewaysFit.hint[0] > 200 && sidewaysFit.doc <= sidewaysFit.win, JSON.stringify(sidewaysFit));
	await page.setViewportSize({ width: 390, height: 844 });
	const upright = await G.waitForFunction(() => !window.__game.handle.debug().turnUpright && window.__game.handle.debug().field.w >= 300, null, { timeout: 5000 }).then(() => true, () => false);
	check("…and upright again, the field is back, at least 300px wide", upright, JSON.stringify((await debug(page)).field));

	// Each bot pops bubbles of its own (popped, not score: a bomb can take a
	// score to zero). Waited for rather than slept on.
	const brBotsPopped = await G.waitForFunction(() => {
		const d = window.__game.handle.debug();
		const bots = Object.keys(d.scores).filter((id) => id.startsWith("bot_"));
		return bots.length === 3 && bots.every((id) => (d.popped[id] ?? 0) > 0);
	}, null, { timeout: 30_000 }).then(() => true, () => false);
	br = await debug(page);
	check("the three bots play their own taps", brBotsPopped, JSON.stringify(br.popped));

	// The round ends on its own after 60 seconds.
	await G.waitForFunction(() => window.__game.handle.debug().phase === "over", null, { timeout: 75_000 });
	br = await debug(page);
	check("the round ends by itself, at the minute", br.phase === "over" && Math.round(br.t) === 60_000, JSON.stringify({ phase: br.phase, t: br.t }));
	const brCard = await page.locator(".managed-over").first().textContent({ timeout: TIMEOUT }).catch(() => "");
	check("the end card ranks the four of us, with the game's own details", /WIN|DRAW|TIE/.test(brCard) && brCard.includes("DETAILS") && brCard.includes("Bubbles popped") && brCard.includes("Best streak"), brCard.slice(0, 160));
	const brMe = br.scores[br.you] ?? 0;
	const brLevel = Object.values(br.scores).length === 4 && Object.values(br.scores).every((v) => v === brMe);
	await resultReached(page, "lokeshmohanty/bubble-rush", brLevel ? "drawn" : brMe === Math.max(...Object.values(br.scores)));

	console.log("\nbots: connect 4 plays a real opponent");
	// The game page is a party shortcut; its quick start must suit a phone.
	await page.goto(url("?game=connect4&fresh=1"));
	// First the choice, and nothing else: no code, no roster (Lokesh, 2026-11-13).
	await page.locator("button", { hasText: "MULTI-PLAYER" }).first().waitFor({ timeout: TIMEOUT });
	const choice = await page.evaluate(() => ({
		buttons: [...document.querySelectorAll("#party button")].map((b) => b.textContent),
		code: !!document.querySelector(".party-code-digits"),
		roster: !!document.querySelector(".party-member"),
	}));
	check("a game page opens on two choices: SINGLE PLAYER, MULTI-PLAYER", choice.buttons.join() === "SINGLE PLAYER,MULTI-PLAYER", choice.buttons.join());
	check("…with no party code or roster until friends are chosen", !choice.code && !choice.roster, JSON.stringify(choice));
	await page.locator("button", { hasText: "SINGLE PLAYER" }).first().click();
	await page.locator("button", { hasText: "START GAME" }).first().waitFor({ timeout: TIMEOUT });
	check("playing the bots shows no party code either", (await page.locator(".party-code-digits").count()) === 0);
	const quickFit = await page.evaluate(() => {
		const btns = [...document.querySelectorAll(".party-quick button")].map((b) => b.getBoundingClientRect());
		return {
			labels: [...document.querySelectorAll(".party-quick .lobby-row button")].map((b) => b.textContent),
			left: Math.min(...btns.map((b) => b.left)),
			right: Math.max(...btns.map((b) => b.right)),
			bottom: Math.max(...btns.map((b) => b.bottom)),
			minH: Math.min(...btns.map((b) => b.height)),
			doc: document.documentElement.scrollWidth,
		};
	});
	check("with bots: ADD BOT, REMOVE BOT, START GAME", quickFit.labels.join() === "ADD BOT,REMOVE BOT,START GAME", quickFit.labels.join());
	check("…all on the phone's screen, 44px tall, no sideways scroll", quickFit.left >= 0 && quickFit.right <= 390 && quickFit.bottom <= 844 && quickFit.minH >= 44 && quickFit.doc <= 390, JSON.stringify(quickFit));
	await page.locator("button", { hasText: "START GAME" }).first().click();
	await page.waitForFunction(() => window.__game?.handle, null, { timeout: TIMEOUT });
	const c4 = await gameScope(page, TIMEOUT);
	await c4.waitForFunction(() => window.__game.handle.debug().started, null, { timeout: TIMEOUT });
	await page.bringToFront(); // clicks into a sandboxed frame route by the page's last drawn frame

	let state = await debug(page);
	check("a bot took the second seat", state.red !== null && state.yellow !== null);
	check("the bot is the one that is not us", state.yellow?.startsWith("bot_"), state.yellow);
	check("the board starts empty", state.board.every((r) => r.every((v) => v === 0)));

	/** Drop a disc in `col` by clicking the board where a player would. */
	async function drop(col) {
		const box = await c4.locator("#board").boundingBox();
		await page.mouse.click(box.x + (box.width / 7) * (col + 0.5), box.y + box.height / 2);
	}

	/** Wait until it is our turn again, i.e. the bot has answered. */
	async function botReplies(discsBefore) {
		return await c4
			.waitForFunction(
				(n) => {
					const s = window.__game.handle.debug();
					const discs = s.board.flat().filter((v) => v !== 0).length;
					return s.winner !== null || (discs >= n + 2 && s.turn === 1);
				},
				discsBefore,
				{ timeout: TIMEOUT },
			)
			.then(() => true)
			.catch(() => false);
	}

	/** Columns where RED could drop and win outright, right now. */
	const openWins = (s) => {
		const cols = [];
		for (let c = 0; c < 7; c++) {
			let row = -1;
			for (let r = 5; r >= 0; r--) if (s.board[r][c] === 0) { row = r; break; }
			if (row < 0) continue;
			const board = s.board.map((r) => [...r]);
			board[row][c] = 1;
			for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
				let n = 1;
				for (const sign of [1, -1]) {
					for (let d = 1; d < 4; d++) {
						const rr = row + dr * d * sign;
						const cc = c + dc * d * sign;
						if (rr < 0 || rr > 5 || cc < 0 || cc > 6 || board[rr][cc] !== 1) break;
						n++;
					}
				}
				if (n >= 4) { cols.push(c); break; }
			}
		}
		return cols;
	};

	await drop(0);
	check("the bot answers with no network at all", await botReplies(0));

	// Build a threat and see whether it is honoured. The bot is not told what we
	// are doing; it has to find the block itself.
	let neverLeftAWin = true;
	let leftOpen = "";
	for (const col of [1, 2, 3, 4, 5]) {
		state = await debug(page);
		if (state.winner !== null) break;
		const discs = state.board.flat().filter((v) => v !== 0).length;
		await drop(col);
		if (!(await botReplies(discs))) break;
		state = await debug(page);
		if (state.winner !== null) break;
		const open = openWins(state);
		if (open.length) {
			neverLeftAWin = false;
			leftOpen = `column ${open[0]} was a win for us`;
			break;
		}
	}
	check("the bot never leaves an immediate win on the board", neverLeftAWin, leftOpen);

	// And it plays the game out rather than stalling somewhere in the middle.
	const finished = await c4
		.waitForFunction(
			() => {
				const s = window.__game.handle.debug();
				if (s.winner !== null) return true;
				// Keep our side moving so the game can actually reach an end.
				const board = s.board;
				for (let c = 0; c < 7; c++) if (board[0][c] === 0) return false;
				return true;
			},
			null,
			{ timeout: 5000 },
		)
		.then(() => true)
		.catch(() => false);
	state = await debug(page);
	check(
		"the game is still live or decided, never stuck",
		finished || state.winner !== null || state.turn === 1,
		`winner=${state.winner} turn=${state.turn}`,
	);

	// The rest of the game, so it ends: we drop wherever there is room and the
	// bot, searching five plies, finishes it.
	for (let i = 0; i < 42; i++) {
		state = await debug(page);
		if (state.winner !== null || state.board[0].every((v) => v !== 0)) break;
		if (state.turn !== 1) {
			await sleep(150);
			continue;
		}
		const discs = state.board.flat().filter((v) => v !== 0).length;
		await drop(state.board[0].findIndex((v) => v === 0));
		await botReplies(discs);
	}
	state = await debug(page);
	check("the game plays out to an end", state.winner !== null || state.board[0].every((v) => v !== 0), `winner=${state.winner}`);

	// The result reaches this device's stats (lib/stats.js) through the frame,
	// once, and the portal says so (lib/portal.js).
	const c4Id = "connect4";
	const mine = await page
		.waitForFunction((id) => JSON.parse(localStorage.getItem("neon.stats") ?? "{}")[id]?.played === 1, c4Id, { timeout: 5000 })
		.then(() => page.evaluate(() => ({ stats: JSON.parse(localStorage.getItem("neon.stats")), recent: JSON.parse(localStorage.getItem("neon.recent")) })))
		.catch(() => page.evaluate(() => ({ stats: localStorage.getItem("neon.stats"), recent: localStorage.getItem("neon.recent") })));
	check("the finished game is in this device's stats, counted once", mine.stats?.[c4Id]?.played === 1, JSON.stringify(mine.stats?.[c4Id] ?? mine.stats));
	check("…against a bot", mine.stats?.[c4Id]?.vsBots === 1);
	check("…and it is the most recent game", mine.recent?.[0] === c4Id, JSON.stringify(mine.recent));
	// A game played: ./ opens on My Games now, with Recently played; the
	// cards with your record are All Games' (lib/portal.js).
	await page.goto(url("index.html"));
	check("…and under Recently played, on My Games", (await page.locator("[data-recent] .recent-game").first().textContent({ timeout: TIMEOUT }).catch(() => "")) === "Connect 4" && new URL(page.url()).searchParams.get("tab") === "mine", page.url());
	await page.goto(url("index.html?page=games&tab=all"));
	// A game has a card in every home-screen section it is in: the first will do.
	const portalSays = await page.locator(`.game-card[data-game="${c4Id}"] .game-you`).first().textContent({ timeout: TIMEOUT }).catch(() => "");
	check("the portal shows it on the game's card", /won of 1/.test(portalSays), portalSays);

	// ------------------------------------------------------ neon fission
	//
	// A managed ffa game with a same-device mode: before the first move the
	// one person seated may turn bot seats into people beside them, whose
	// turns are played on this phone (games/neon-fission/neon-fission.js).

	/** Open Neon Fission's party with `bots` bots seated, start, and wait for the table. */
	async function openFission(p, bots) {
		await p.goto(url("index.html?game=neon-fission&fresh=1"));
		const solo = p.locator("button", { hasText: "SINGLE PLAYER" }).first();
		await solo.waitFor({ timeout: TIMEOUT });
		const label = await solo.textContent();
		await solo.click();
		for (let i = 1; i < bots; i++) await p.locator("button", { hasText: "ADD BOT" }).first().click();
		await p.locator("button", { hasText: "START GAME" }).first().click();
		await p.waitForFunction(() => window.__game?.handle, null, { timeout: TIMEOUT });
		const F = await gameScope(p, TIMEOUT);
		await F.waitForFunction(() => window.__game.handle.debug().phase === "setup", null, { timeout: TIMEOUT });
		await readyToClick(p);
		return { F, label };
	}
	const fission = (F) => F.evaluate(() => window.__game.handle.debug());
	/** Tap a cell this phone may play, as a person would. */
	async function tapCell(p, F, v, pick) {
		const box = await F.locator("#board").boundingBox();
		await p.mouse.click(box.x + ((pick % v.cols) + 0.5) * v.cell, box.y + (Math.floor(pick / v.cols) + 0.5) * v.cell);
	}
	/** A legal cell for the seat on turn: the first empty corner, else the first of its own or empty. */
	const legalPick = (v) => {
		const ok = (i) => v.owner[i] === -1 || v.owner[i] === v.turn;
		const corners = [0, v.cols - 1, v.cols * (v.rows - 1), v.cols * v.rows - 1].filter((i) => v.owner[i] === -1);
		return corners[0] ?? v.owner.findIndex((_, i) => ok(i));
	};

	console.log("\nbots: neon fission, single player against a bot, to the end");
	{
		const { F, label } = await openFission(page, 1);
		check("the party offers SINGLE PLAYER / SAME DEVICE (a party game)", label.trim() === "SINGLE PLAYER / SAME DEVICE", label);
		const table = await F.evaluate(() => {
			const btns = [...document.querySelectorAll("#setup button")].map((b) => b.getBoundingClientRect());
			return {
				labels: [...document.querySelectorAll("#setup button")].map((b) => b.textContent),
				minH: Math.min(...btns.map((b) => b.height)),
				right: Math.max(...btns.map((b) => b.right)),
				bottom: Math.max(...btns.map((b) => b.bottom)),
				top: Math.min(...btns.map((b) => b.top)),
				doc: document.documentElement.scrollWidth,
			};
		});
		check("the table first: the bot's seat can be a PLAYER, then START", table.labels.join() === "BOT,PLAYER,START", table.labels.join());
		check("…44px taps, all on a 390x844 screen, clear of the top band, no sideways scroll",
			table.minH >= 44 && table.right <= 390 && table.bottom <= 844 && table.top >= 52 && table.doc <= 390, JSON.stringify(table));
		await F.locator("#setup button", { hasText: "START" }).click();
		await F.waitForFunction(() => window.__game.handle.debug().phase === "play", null, { timeout: TIMEOUT });
		const fit = await F.evaluate(() => {
			const b = document.getElementById("board").getBoundingClientRect();
			const t = document.getElementById("turn").getBoundingClientRect();
			const v = window.__game.handle.debug();
			return { left: b.left, right: b.right, bottom: b.bottom, hudTop: t.top, cell: v.cell, cols: v.cols, rows: v.rows, doc: document.documentElement.scrollWidth, dpr: document.getElementById("board").width / b.width };
		});
		check("two players: a 6 × 9 grid with cells of at least 44px, all on screen", fit.cols === 6 && fit.rows === 9 && fit.cell >= 44 && fit.left >= 0 && fit.right <= 390 && fit.bottom <= 844 && fit.doc <= 390, JSON.stringify(fit));
		check("…the turn line clear of the shell's top band; drawn at the device's pixel ratio", fit.hudTop >= 52 && Math.abs(fit.dpr - (await page.evaluate(() => devicePixelRatio))) < 0.05, JSON.stringify(fit));
		let v = await fission(F);
		let botMoved = false;
		let acted = -1;
		for (const end = Date.now() + 120_000; Date.now() < end && v.winner === null; v = await fission(F)) {
			if (v.last && v.last.seat === 1) botMoved = true;
			if (v.canPlay && !v.animating && v.moves !== acted) {
				acted = v.moves;
				await tapCell(page, F, v, legalPick(v));
			}
			await sleep(120);
		}
		check("the bot plays its own turns", botMoved);
		check("the game plays out to a winner", v.winner === 0 || v.winner === 1, `winner=${v.winner} after ${v.moves} moves`);
		const card = await page.locator(".managed-over").first().textContent({ timeout: TIMEOUT }).catch(() => "");
		check("the end card shows, with the bot and us ranked", /YOU|WIN/.test(card) && card.includes("DETAILS"), card);
		await resultReached(page, "neon-fission", v.winner === 0);
	}

	console.log("\nlocal: neon fission on one phone, two people and a bot");
	{
		const ctx2 = await newContext();
		const hot = await ctx2.newPage();
		hot.on("pageerror", (err) => {
			console.log(`  FAIL page error: ${err.message}`);
			failures++;
		});
		const { F } = await openFission(hot, 2);
		await F.locator('#setup .seg button[data-seat="1"]', { hasText: "PLAYER" }).click();
		await F.waitForFunction(() => window.__game.handle.debug().players[1].kind === "local", null, { timeout: TIMEOUT });
		let v = await fission(F);
		check("seat 2 is now a player on this device, named Player 2; seat 3 stays a bot", v.players[1].name === "Player 2" && v.players[2].kind === "bot", JSON.stringify(v.players.map((p) => [p.name, p.kind])));
		await F.locator("#setup button", { hasText: "START" }).click();
		const taps = { 0: 0, 1: 0 };
		const seatMoves = { 0: 0, 1: 0, 2: 0 };
		let lastSeen = 0;
		let passLine = "";
		let acted = -1;
		let neverOurs = true;
		for (const end = Date.now() + 150_000; Date.now() < end; v = await fission(F)) {
			if (v.last && v.last.n !== lastSeen) {
				lastSeen = v.last.n;
				seatMoves[v.last.seat]++;
			}
			if (v.winner !== null) break;
			if (v.turn === 2 && v.canPlay) neverOurs = false; // the bot's turn must not be ours to play
			if (v.canPlay && !v.animating && v.moves !== acted) {
				if (v.turn === 1 && !passLine) passLine = await F.locator("#turn").textContent();
				acted = v.moves;
				taps[v.turn]++;
				await tapCell(hot, F, v, legalPick(v));
			}
			await sleep(100);
		}
		check("on Player 2's turn the phone says so: pass it", /Player 2/.test(passLine) && /pass the phone/.test(passLine), passLine);
		check("Player 2's moves are exactly the taps made for them: no bot played that seat", seatMoves[1] > 0 && seatMoves[1] === taps[1], JSON.stringify({ seatMoves, taps }));
		check("the real bot moved itself, and its turns were never this phone's", seatMoves[2] > 0 && neverOurs, JSON.stringify(seatMoves));
		check("the game ends", v.winner !== null, `after ${v.moves} moves`);
		const card = await hot.locator(".managed-over").first().textContent({ timeout: TIMEOUT }).catch(() => "");
		const botName = v.players[2].name;
		check("the end card names Player 2 and the bot by name", card.includes("Player 2") && card.includes(botName), card);
		check("…and its title names the winner as the game does", card.toUpperCase().includes(`${v.players[v.winner].name.toUpperCase()} WINS`), card);
		await ctx2.close();
	}

	// ------------------------------------------------------ neon survival

	console.log("\nbots: neon survival runs for one player, and for one plus bots");
	await startSolo(page, "?game=neon-survival-mp&fresh=1", "SINGLE PLAYER");
	G = await gameScope(page, TIMEOUT);
	await sleep(600);
	let solo = await G.evaluate(() => ({
		active: window.gameActive,
		ships: Object.keys(window.botShips ?? {}).length,
		peers: Object.keys(window.peers ?? {}).length,
	}));
	check("one player alone is a running game", solo.active);
	check("playing alone adds no bots", solo.ships === 0 && solo.peers === 0);

	// Now the same page with company.
	await page.goto(url("?game=neon-survival-mp&fresh=1"));
	await page.locator("button", { hasText: "SINGLE PLAYER" }).first().click();
	const addBot = page.locator("button", { hasText: "ADD BOT" }).first();
	await addBot.click();
	await addBot.click();
	await page.locator("button", { hasText: "START GAME" }).first().click();
	await page.waitForFunction(() => window.__game?.handle, null, { timeout: TIMEOUT });
	G = await gameScope(page, TIMEOUT);
	await sleep(400);

	const before = await G.evaluate(() =>
		Object.entries(window.botShips).map(([id, s]) => [id, s.x, s.y]),
	);
	check("two bot ships joined the run", before.length === 2, `${before.length} ships`);
	// Flown, not parked: each bot moves within 3 s. One sample at 0.9 s was
	// flaky on a loaded machine — a bot whose steering target is already
	// reached can hold still for a moment at the start of a run.
	let after = before;
	let moved = false;
	for (const end = Date.now() + 3000; !moved && Date.now() < end; ) {
		await sleep(300);
		after = await G.evaluate(() => Object.entries(window.botShips).map(([id, s]) => [id, s.x, s.y]));
		moved = before.every(([id, x, y]) => {
			const now = after.find(([o]) => o === id);
			return now && Math.hypot(now[1] - x, now[2] - y) > 5;
		});
	}
	check("the bot ships are being flown, not parked", moved, JSON.stringify(after));
	const published = await G.evaluate(
		() => Object.keys(window.peers).filter((id) => id.startsWith("bot_")).length,
	);
	check("bot ships are published like any other player", published === 2, `${published}`);

	// ------------------------------------------------------- draw & guess

	console.log("\nbots: draw & guess says it needs people");
	await page.goto(url("?game=lokeshmohanty%2Fdraw-guess&fresh=1"));
	await page.locator("button", { hasText: "MULTI-PLAYER" }).first().waitFor();
	const solos = await page.locator("button", { hasText: /SINGLE PLAYER/ }).count();
	check("no bot option is offered for a game a bot cannot play", solos === 0);

	// ------------------------------------- a game-page reply that failed

	// The game-page lobby's guest side of the manual handshake (lib/lobby.js
	// guestFlow): its reply screen says to carry the reply back right away,
	// and a reply whose link then fails (ICE `failed`, forced — loopback
	// always has a route) says why and offers MAKE A NEW REPLY, laid out for
	// a phone. Same rule as the party screen (scripts/test-party.mjs).
	console.log("\nbots: a game-page reply that failed says so, and offers a new one");
	{
		const pair = await newContext();
		// The replier's *first* reply is also kept from ever reaching the
		// inviter (the invite's candidates are stripped before it is
		// answered), as across the networks this models: on loopback its
		// ICE would connect at once, and a DTLS hello the inviter cached
		// from it could spoil the second reply's link. sessionStorage
		// survives the reload, so the second reply is left alone.
		await pair.addInitScript(() => {
			const P = RTCPeerConnection;
			const strip = !sessionStorage.getItem("__stripped");
			window.__pcs = [];
			window.RTCPeerConnection = class extends P {
				constructor(...args) {
					super(...args);
					window.__pcs.push(this);
				}
				setRemoteDescription(d) {
					if (strip && d?.type === "offer") {
						sessionStorage.setItem("__stripped", "1");
						d = { type: d.type, sdp: d.sdp.replace(/^a=candidate:.*\r\n/gm, "") };
					}
					return super.setRemoteDescription(d);
				}
			};
		});
		const inviter = await pair.newPage();
		const replier = await pair.newPage();
		for (const p of [inviter, replier]) {
			p.on("pageerror", (err) => {
				console.log(`  FAIL page error: ${err.message}`);
				failures++;
			});
		}
		await inviter.goto(url("?game=lokeshmohanty%2Fdraw-guess&fresh=1"));
		await inviter.locator("button", { hasText: "MULTI-PLAYER" }).first().click();
		await inviter.locator("button", { hasText: "INVITE A FRIEND" }).first().click();
		const inviteBox = inviter.locator("textarea.share-code").first();
		await inviteBox.waitFor({ timeout: TIMEOUT });
		await replier.goto(await inviteBox.inputValue());
		const replyBox = replier.locator("textarea.share-code").first();
		await replyBox.waitFor({ timeout: TIMEOUT });
		const firstReply = await replyBox.inputValue();
		const hint = (await replier.locator("#party .share-hint", { hasText: /right away/i }).first().textContent().catch(() => "")) ?? "";
		check("the reply screen says to send it back right away", /right away/i.test(hint) && /15 seconds/.test(hint), hint);
		await replier.evaluate(() => {
			for (const pc of window.__pcs) {
				Object.defineProperty(pc, "connectionState", { get: () => "failed" });
				pc.onconnectionstatechange?.();
			}
		});
		const again = replier.locator("button", { hasText: "MAKE A NEW REPLY" });
		const offered = await again
			.waitFor({ timeout: TIMEOUT })
			.then(() => true)
			.catch(() => false);
		check("a failed reply offers MAKE A NEW REPLY", offered);
		const failed = await replier.evaluate(() => {
			const btn = [...document.querySelectorAll("button")].find((b) => b.textContent === "MAKE A NEW REPLY");
			const row = btn?.parentElement;
			const hint = [...document.querySelectorAll(".share-hint")].find((h) => /new invite/.test(h.textContent));
			return {
				status: document.querySelector(".lobby-status.is-error")?.textContent ?? "",
				hint: hint?.textContent ?? "",
				boxes: [hint, ...(row?.children ?? [])].filter(Boolean).map((n) => n.getBoundingClientRect().toJSON()),
				docWidth: document.documentElement.scrollWidth,
				winWidth: document.documentElement.clientWidth,
				height: window.innerHeight,
			};
		});
		check(
			"it says the reply took too long or the networks cannot connect",
			/not used in time/.test(failed.status) && /cannot connect directly/.test(failed.status) && /new invite/.test(failed.hint),
			JSON.stringify({ status: failed.status, hint: failed.hint }),
		);
		check(
			"the failure screen fits the phone (390x844)",
			failed.boxes.length >= 3 &&
				failed.boxes.every((b) => b.left >= 0 && b.right <= failed.winWidth && b.bottom <= failed.height) &&
				failed.docWidth <= failed.winWidth,
			JSON.stringify(failed),
		);
		await again.click();
		const secondReply = await replier
			.waitForFunction(
				(old) => {
					const v = document.querySelector("textarea.share-code")?.value;
					return v && v !== old ? v : null;
				},
				firstReply,
				{ timeout: TIMEOUT },
			)
			.then((h) => h.jsonValue())
			.catch(() => null);
		check("MAKE A NEW REPLY answers the same invite afresh", !!secondReply);
		await inviter.locator("textarea.share-code").last().fill(secondReply ?? "");
		await inviter.locator("button.neon-btn", { hasText: /^CONNECT$/ }).first().click();
		const linked = await replier
			.locator(".party-member")
			.nth(1)
			.waitFor({ timeout: TIMEOUT })
			.then(() => true)
			.catch(() => false);
		check("…and the new reply connects", linked);

		// One page (docs/spa.md): "← Games" only moves to the portal — the
		// party stays, and BACK TO PARTY returns to it, nobody asked or told.
		const guestName = await replier.evaluate(() => window.__game.room.self().name);
		await replier.locator("a.portal-link").click();
		const kept = await replier
			.waitForFunction(() => document.body.dataset.view === "portal" && !window.__party.room.closed, null, { timeout: TIMEOUT })
			.then(() => true, () => false);
		check("← Games moves to the portal and keeps the party", kept && (await replier.locator("dialog.neon-ask[open]").count()) === 0);
		await replier.locator(".back-to-game").click();
		await replier.waitForFunction(() => document.body.dataset.view === "party", null, { timeout: TIMEOUT });
		// LEAVE PARTY walks out: with somebody else in it, it asks first, and
		// they are told.
		await replier.locator("a[data-leaves]", { hasText: "LEAVE PARTY" }).click();
		const asked = await replier
			.locator("dialog.neon-ask[open]")
			.waitFor({ timeout: 5000 })
			.then(() => true)
			.catch(() => false);
		check("LEAVE PARTY asks before it walks out on the other player", asked);
		await Promise.all([
			replier.waitForURL(PORTAL, { timeout: TIMEOUT }),
			replier.locator('dialog.neon-ask[open] [data-ask="yes"]').click(),
		]);
		const told = await inviter
			.locator(".neon-toast", { hasText: `${guestName} left the party.` })
			.waitFor({ timeout: TIMEOUT })
			.then(() => true)
			.catch(() => false);
		check("…and the one left behind is told", told);
		await pair.close();
	}

	console.log("\nleaving: a game page whose host goes says so");
	// A game page opens a party, so the guest is never stranded: the crown
	// passes to them, and a game the host was running is handed over — here
	// with the host gone for good, so the one still sitting wins it.
	for (const midGame of [true, false]) {
		const pair = await newContext();
		const [hostP, guestP] = [await pair.newPage(), await pair.newPage()];
		for (const p of [hostP, guestP]) {
			p.on("pageerror", (err) => {
				console.log(`  FAIL page error: ${err.message}`);
				failures++;
			});
		}
		await hostP.goto(url("?game=connect4&fresh=1"));
		await hostP.locator("button", { hasText: "MULTI-PLAYER" }).first().click();
		await hostP.locator("button", { hasText: "INVITE A FRIEND" }).first().click();
		const box = hostP.locator("textarea.share-code").first();
		await box.waitFor({ timeout: TIMEOUT });
		await guestP.goto(await box.inputValue());
		const reply = guestP.locator("textarea.share-code").first();
		await reply.waitFor({ timeout: TIMEOUT });
		await hostP.locator("textarea.share-code").last().fill(await reply.inputValue());
		await hostP.locator("button.neon-btn", { hasText: /^CONNECT$/ }).first().click();
		await guestP.locator(".party-member").nth(1).waitFor({ timeout: TIMEOUT });
		if (midGame) {
			await hostP.locator("button", { hasText: "START GAME" }).first().click();
			await guestP.waitForFunction(() => window.__game?.handle, null, { timeout: TIMEOUT });
			await (await gameScope(guestP, TIMEOUT)).waitForFunction(() => window.__game.handle.debug().started, null, { timeout: TIMEOUT });
		}
		await hostP.close();
		const msg = midGame ? "You are the host now — CONNECT 4 goes on." : "You are the host now.";
		const told = await guestP
			.locator(".neon-toast", { hasText: msg })
			.waitFor({ timeout: TIMEOUT })
			.then(() => true)
			.catch(() => false);
		check(`${midGame ? "mid-game" : "before START"}: the guest is told (${msg})`, told);
		let after = await guestP
			.waitForFunction(
				(mid) => {
					const g = window.__game;
					if (!g.room.isHost()) return false;
					if (!mid) return g.game === null && !document.getElementById("party").hidden;
					return g.game === "connect4";
				},
				midGame,
				{ timeout: TIMEOUT },
			)
			.then(() => true, () => false);
		// Connect 4 is framed: its board is read inside the frame.
		if (after && midGame) {
			after = await (await gameScope(guestP, TIMEOUT))
				.waitForFunction(() => {
					const d = window.__game.handle.debug();
					// The party as the game's frame knows it (sdk/v2/runtime.js).
					const { self, host } = window.arcade.party;
					return host === self && d.winner === (d.yellow === self ? 2 : 1);
				}, null, { timeout: TIMEOUT })
				.then(() => true, () => false);
		}
		check(
			midGame ? "…holds the game, and wins it: the other side left for good" : "…and holds the party, back on its screen",
			after,
		);
		await pair.close();
	}

	console.log("\nleaving: one person against the bots is never asked");
	{
		const lone = await context.newPage();
		await startSolo(lone, "?game=connect4&fresh=1", "SINGLE PLAYER");
		// LEAVE PARTY with only bots in it: nobody to walk out on, so no question.
		// Mid-game it is on the party screen, pulled up over the game (PARTY).
		await lone.locator(".party-pill").click({ timeout: TIMEOUT });
		await Promise.all([lone.waitForURL(PORTAL, { timeout: TIMEOUT }), lone.locator("a[data-leaves]", { hasText: "LEAVE PARTY" }).click()]);
		check("LEAVE PARTY from a bots-only game goes straight to the portal", (await lone.locator("dialog.neon-ask").count()) === 0);
		await lone.close();
	}

	// --------------------------------------------------- bots in a party

	console.log("\nbots: a bot is an ordinary member to everyone else");
	const host = await context.newPage();
	const guest = await context.newPage();
	for (const p of [host, guest]) {
		p.on("pageerror", (err) => {
			console.log(`  FAIL page error: ${err.message}`);
			failures++;
		});
	}

	await host.goto(url("?party"));
	await host.locator(".party-member").first().waitFor({ timeout: TIMEOUT });
	await host.locator("button", { hasText: "ADD PLAYER" }).first().click();
	const inviteBox = host.locator("textarea.share-code").first();
	await inviteBox.waitFor({ timeout: TIMEOUT });
	await guest.goto(await inviteBox.inputValue());
	const replyBox = guest.locator("textarea.share-code").first();
	await replyBox.waitFor({ timeout: TIMEOUT });
	await host.locator("textarea.share-code").last().fill(await replyBox.inputValue());
	await host.locator("button.neon-btn", { hasText: /^CONNECT$/ }).first().click();
	await guest.locator(".party-member").nth(1).waitFor({ timeout: TIMEOUT });

	const directBefore = await guest.evaluate(() => window.__party.room.directPeers().length);
	await host.locator("button", { hasText: "ADD BOT" }).first().click();

	const sawBot = await guest
		.waitForFunction(() => document.querySelectorAll(".party-member").length === 3, null, {
			timeout: TIMEOUT,
		})
		.then(() => true)
		.catch(() => false);
	check("a bot the host added reaches the guest's roster", sawBot);
	check(
		"the guest is told which member is a bot",
		(await guest.locator(".party-tag.is-bot").count()) === 1,
	);

	// The point of the whole exercise: an unreachable member must not be
	// treated as one that simply has not connected yet.
	await sleep(2500);
	const directAfter = await guest.evaluate(() => window.__party.room.directPeers().length);
	check(
		"nobody tries to open a connection to a bot",
		directAfter === directBefore,
		`directPeers went ${directBefore} -> ${directAfter}`,
	);
	const errored = await guest.locator(".lobby-status.is-error").count();
	check("and no connection error is reported because of one", errored === 0);

	// A bot can be taken away again.
	await host.locator(".party-member").nth(2).locator("button", { hasText: "REMOVE" }).click();
	const gone = await guest
		.waitForFunction(() => document.querySelectorAll(".party-member").length === 2, null, {
			timeout: TIMEOUT,
		})
		.then(() => true)
		.catch(() => false);
	check("removing a bot reaches the guest too", gone);
} finally {
	await browser.close();
}

console.log(
	failures ? `\n${failures} bot check${failures > 1 ? "s" : ""} failed` : "\nall bot checks passed",
);
process.exit(failures ? 1 : 0);
