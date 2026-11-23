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
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { serve, gameScope, readyToClick, phoneFloors, phoneSizes as onPhones, communityHas, registryLists } from "./serve.mjs";
import { loadPlaywright } from "./playwright.mjs";

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

/** The quick table's Players count (lib/party.js tableBlock). */
const tableCount = (p) => p.locator(".quick-table .quick-n").textContent({ timeout: TIMEOUT }).then(Number);
/** Set the quick table to `n` players with its − and +, as a thumb would. */
async function setPlayers(p, n) {
	await p.locator(".quick-table").waitFor({ timeout: TIMEOUT });
	for (let k = 0; k < 20; k++) {
		const now = await tableCount(p);
		if (now === n) return;
		await p.locator(`.quick-table [data-qt="${now < n ? "plus" : "minus"}"]`).click();
		await p.waitForFunction((was) => Number(document.querySelector(".quick-table .quick-n")?.textContent) !== was, now, { timeout: TIMEOUT });
	}
	throw new Error(`the quick table would not seat ${n}`);
}

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
/** serve.mjs phoneSizes (390x844 and 354x696), through this suite's check. */
const phoneSizes = (p, F, label) => onPhones(p, F, label, check, { timeout: TIMEOUT });
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
 *
 * A managed game's first match opens on a seat drawn at random, and each
 * PLAY AGAIN on the next (docs/sdk-v2.md "Who starts"). These suites play
 * from the first seat's side (red, X, seat 0), so the draw lands there
 * (lib/sdk-managed.js `firstDraw`, tests only); a rematch is the next seat's.
 */
const firstSeatOpens = () => {
	window.NeonArcade = window.NeonArcade || {};
	window.NeonArcade.firstDraw = () => 0;
};
async function newContext() {
	const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
	await ctx.addInitScript(() => {
		try {
			localStorage.setItem("neon.rs", "http://127.0.0.1:9");
		} catch {}
	});
	await ctx.addInitScript(firstSeatOpens);
	return ctx;
}
const context = await newContext();
const page = await context.newPage();
page.on("pageerror", (err) => {
	console.log(`  FAIL page error: ${err.message}`);
	failures++;
});

try {
	// ------------------------------------------------------- prebuilt frames
	//
	// Every game below is mounted from its prebuilt frame (frames/<id>.html,
	// scripts/prebuild-frames.mjs). It must be exactly what the shell builds
	// at tap time, which is what the dev kit and validate-game check.

	console.log("\nframes: every game's prebuilt frame is the one the shell would build");
	await page.goto(url("index.html"));
	await page.waitForFunction(() => window.NeonArcade?.catalogs, null, { timeout: TIMEOUT });
	const frames = await page.evaluate(async () => {
		await NeonArcade.catalogs;
		const out = [];
		for (const def of [...NeonArcade.CATALOG, ...(NeonArcade.UNLISTED ?? [])]) {
			const g = NeonArcade.getGame(def.id);
			const at = g && NeonArcade.prebuiltFrame(g);
			if (!at) continue;
			const res = await fetch(at);
			const prebuilt = res.ok ? await res.text() : null;
			out.push({ id: g.id, prebuilt: !!prebuilt, same: prebuilt === (await NeonArcade.buildFrameTemplate(g)) });
		}
		return out;
	});
	if (process.env.NEON_SERVE_SRC) console.log("  skip (serving the repo: nothing is prebuilt)");
	else {
		check(`every listed and unlisted game has one (${frames.length})`, frames.length >= 10 && frames.every((f) => f.prebuilt), JSON.stringify(frames.filter((f) => !f.prebuilt)));
		check("…identical to the template built at tap time", frames.every((f) => f.same), JSON.stringify(frames.filter((f) => !f.same).map((f) => f.id)));
	}

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
	await phoneSizes(page, G, "undercover's player list");

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
	await phoneSizes(page, G, "undercover's topic picker");
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
	// Rolled, both cups committed and collected, the clock on to "bid": a few
	// round trips through the shell, not a fixed time. The clock collects
	// before it moves on (lib/rounds.js), so digests read at "bid" still prove
	// every cup was committed first. Who opens is drawn for the first game
	// (docs/sdk-v2.md "Who starts"): when the bot opens, its bid comes first,
	// so this waits for our turn.
	await G.waitForFunction(() => {
		const d = window.__game.handle.debug();
		return (d.phase === "bid" && d.turn === window.arcade.party.self) || !!d.over;
	}, null, { timeout: TIMEOUT }).catch(() => {});

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
	// Bounded by a deadline (two bot answers and a settle take seconds), and
	// read where the call is first seen: a new roll clears lastCall.
	let myBids = 0;
	ld = await debug(page);
	for (const end = Date.now() + 60_000; !(ld.lastCall || ld.over) && Date.now() < end; ld = await debug(page)) {
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
	await setPlayers(page, 8);
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
	await phoneSizes(page, G, "neon bid's bidding");
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
	await phoneSizes(page, G, "neon bid's reveal");
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
	// Bounded by progress, as Battleship's volleys are: a lot takes a 3.2 s
	// show and the test's own 1.2 s pause, more on a slow runner, so a count
	// of polls ran short there. The fault would be a lot that never settles,
	// so progress is a lot settled or a new one opened (not a phase change: a
	// bug that cycled phases without settling would never stall). The stall
	// outlasts a whole lot at its phases' own deadlines (neon-bid.js: bid
	// 60 s, open 6 s, show 3.2 s), and a hard cap bounds the run whatever.
	const NB_STALL = 90_000;
	const NB_CAP = Date.now() + 15 * 60_000;
	let nbLast = { at: Date.now(), key: "" };
	for (;;) {
		const d = await debug(page);
		if (d.over) break;
		const key = `${d.round}/${d.results.length}`;
		if (key !== nbLast.key) nbLast = { at: Date.now(), key };
		else if (Date.now() - nbLast.at > NB_STALL) break;
		if (Date.now() > NB_CAP) break;
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
	nb = await debug(page);
	check("the game reaches the final table", !!nb.over, JSON.stringify({ phase: nb.phase, lot: nb.lot, round: nb.round, settled: nb.results.length, stalledFor: Date.now() - nbLast.at }));
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
	// The game says ready before its first round is dealt: wait for the round,
	// not one look (a loaded runner caught it still "waiting").
	await G.waitForFunction(() => window.__game?.handle?.debug?.()?.phase !== "waiting", null, { timeout: 10_000 }).catch(() => {});

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

	// The last shot on each board is marked: two volleys by hand, each square
	// we fire at checked against the mark on their board, and the bot's
	// latest shot against the mark on ours. One mark a board, never two.
	/** The squares marked as the last shot: { theirs: [[r, c]…], mine: […] }. */
	const lastMarks = () => G.evaluate(() => Object.fromEntries(["theirs", "mine"].map((b) => [b, [...document.querySelectorAll(`[data-board="${b}"] .bs-cell.last`)].map((c) => [+c.dataset.r, +c.dataset.c])])));
	let marksOk = true;
	let marksSeen = "";
	for (let v = 1; v <= 2; v++) {
		await G.waitForFunction(() => window.__game.handle.debug().phase === "fire", null, { timeout: TIMEOUT });
		const at = await G.evaluate(() => {
			const at = window.battleshipRules.botTarget(window.__game.handle.debug().theirBoard);
			document.querySelector(`[data-board="theirs"] .bs-cell[data-r="${at[0]}"][data-c="${at[1]}"]`).click();
			return at;
		});
		await G.waitForFunction((v) => {
			const d = window.__game.handle.debug();
			return d.shotsAtThem === v && d.shotsAtMe === v;
		}, v, { timeout: TIMEOUT });
		const d = await debug(page);
		const marks = await lastMarks();
		marksSeen += ` volley ${v}: fired ${at}, marks ${JSON.stringify(marks)}, at us ${JSON.stringify(d.myBoard.map((s) => s.at))};`;
		marksOk &&= JSON.stringify(marks.theirs) === JSON.stringify([at]) && JSON.stringify(marks.mine) === JSON.stringify([d.myBoard.at(-1).at]);
	}
	check("the last shot is marked on each board: ours where we fired, theirs where the bot did", marksOk, marksSeen);

	// Play it out, using the game's own targeting so a game actually ends.
	//
	// Bounded by progress, not by a count of polls. A volley takes the game's
	// 900ms resolve phase however fast we click, and a game runs from ~15
	// volleys to all 64 squares: 33 typically, 43 or more about one game in
	// eighty. A budget of 300 polls was ~44 volleys, so that tail failed with
	// both fleets one square from sunk (CI run 43898412610: 43 volleys, 11/11).
	// The real fault would be a volley that never comes, and that is what the
	// stall bounds: the bot answers at once, and we click on every poll.
	const STALL = 20_000;
	const fireStart = Date.now();
	let last = { volleys: -1, at: Date.now() };
	for (;;) {
		const d = await debug(page);
		if (d.over) break;
		const volleys = Math.max(d.shotsAtMe, d.shotsAtThem);
		if (volleys !== last.volleys) last = { volleys, at: Date.now() };
		else if (Date.now() - last.at > STALL) break;
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
	// Then both fleets are opened and each digest verified (a round trip to
	// the shell), so wait for the audits rather than for a fixed time.
	await G.waitForFunction(() => {
		const d = window.__game.handle.debug();
		return d.over && d.fleetsRevealed === 2 && Object.keys(d.audits).length === 2;
	}, null, { timeout: 10_000 }).catch(() => {});
	bs = await debug(page);
	// Everything a failure here needs to tell a slow game from a stuck one.
	const fought = JSON.stringify({
		phase: bs.phase, over: bs.over, volleys: `${bs.shotsAtThem} by us, ${bs.shotsAtMe} at us`,
		hits: `${bs.hitsOnThem} on them, ${bs.hitsOnMe} on us (of 12)`,
		seconds: Math.round((Date.now() - fireStart) / 1000), sinceLastVolley: Math.round((Date.now() - last.at) / 1000),
		revealed: bs.fleetsRevealed, audits: bs.audits,
	});
	check("the game reaches a result", !!bs.over, fought);
	check("both sides fired the same number of volleys", bs.shotsAtMe === bs.shotsAtThem, fought);
	check("the loser's fleet is fully sunk", bs.hitsOnThem === 12 || bs.hitsOnMe === 12, fought);
	check("both fleets were revealed", bs.fleetsRevealed === 2, fought);
	check("and both audited clean", Object.keys(bs.audits).length === 2 && Object.values(bs.audits).every((a) => a === null), fought);
	check("the phase leaves the firing state", bs.phase === "over", fought);
	if (bs.over?.winner !== undefined) await resultReached(page, "lokeshmohanty/battleship", bs.over.winner === (await selfOf(page)));
	const endMarks = await lastMarks();
	check("…the final volley still marked, one a board", endMarks.theirs.length === 1 && endMarks.mine.length === 1, endMarks);
	// NEW GAME: fresh boards and no mark left over from the last one.
	await G.evaluate(() => [...document.querySelectorAll(".bs-actions button")].find((b) => b.textContent === "NEW GAME").click());
	await G.waitForFunction(() => window.__game.handle.debug().phase === "place", null, { timeout: TIMEOUT });
	const newMarks = await lastMarks();
	check("…and NEW GAME clears them", !newMarks.theirs.length && !newMarks.mine.length, newMarks);

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
	await setPlayers(page, 4);
	await page.locator("button", { hasText: "START GAME" }).first().click();
	await page.waitForFunction(() => window.__game?.handle, null, { timeout: TIMEOUT });
	G = await gameScope(page, TIMEOUT);
	await readyToClick(page);
	// The frame is up before the host's first view reaches it (riders: none).
	await G.waitForFunction(() => window.__game.handle.debug().riders.length === 4, null, { timeout: TIMEOUT }).catch(() => {});

	let lc = await debug(page);
	check("four riders took the arena", lc.riders.length === 4, `${lc.riders.length}`);
	check("three of them are bots", lc.riders.filter((r) => r.id.startsWith("bot_")).length === 3);
	check("nobody starts on top of anybody", new Set(lc.riders.map((r) => `${r.c},${r.r}`)).size === 4);

	// It opens on a countdown rather than throwing everyone straight into a
	// wall before they have found their thumbs.
	check("a round opens with a countdown, not a race", lc.countdown > 0 && !lc.racing, JSON.stringify({ c: lc.countdown, r: lc.racing }));

	await G.waitForFunction(() => window.__game.handle.debug().racing, null, { timeout: TIMEOUT });
	const wallsAtStart = (await debug(page)).walls;
	await G.waitForFunction((w) => window.__game.handle.debug().walls > w, wallsAtStart, { timeout: 10_000 }).catch(() => {});
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
	// The other ticking game, and the one where a tap is judged on the phone
	// that made it (Lokesh, 2026-11-21): the phone pops the bubble and scores
	// it at once, then tells the host which bubble and when, and the host
	// scores it the same way. Checked here as a person plays it — a real
	// click on a bubble scores, a click on empty field does not — and the
	// 60-second round has to end by itself with the bots on every other seat
	// having played.

	console.log("\nbots: bubble rush, a whole round against three bots");
	await page.goto(url("?game=lokeshmohanty%2Fbubble-rush&fresh=1"));
	await page.locator("button", { hasText: "SINGLE PLAYER" }).first().click();
	await setPlayers(page, 4);
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
			startOff: !!document.querySelector(".br-setup .br-start")?.disabled,
			picked: btns.filter((b) => b.getAttribute("aria-pressed") === "true").length,
			minH: Math.min(...boxes.map((b) => b.height)),
			right: Math.max(...boxes.map((b) => b.right)),
			bottom: Math.max(...boxes.map((b) => b.bottom)),
			top: Math.min(...boxes.map((b) => b.top)),
			doc: document.documentElement.scrollWidth,
		};
	});
	check("the host picks the mode, then START", brSetup.labels.join() === "FREE-FOR-ALL,TEAMS,START", brSetup.labels.join());
	// Lokesh (2026-11-18): the game asks every round — no mode picked for them.
	check("…nothing is picked for the host, and START waits for the pick", brSetup.picked === 0 && brSetup.startOff, JSON.stringify(brSetup));
	// One person and bots in a free game are dealt out as a team game is
	// (lib/party.js quickTeams, 2026-11-17): TEAMS can be played alone —
	// you and one bot against two. Until then everyone sat on Team A.
	const brSides = await page.evaluate(() => {
		const r = window.__party.room;
		return r.getMembers().map((m) => [m.id === r.selfId ? "you" : "bot", m.team]);
	});
	check("…TEAMS is open alone: you and a bot on Team A, two bots on Team B", !brSetup.teamsOff && brSides.filter(([, t]) => t === "A").length === 2 && brSides.filter(([, t]) => t === "B").length === 2 && brSides[0].join() === "you,A", JSON.stringify({ teamsOff: brSetup.teamsOff, brSides }));
	// The rest plays free-for-all, picked: every seat scores for itself. Picked
	// with the keyboard (Enter on the focused button): the frame's Space/Enter
	// START shortcut once swallowed it, so a keyboard host could never pick.
	await G.locator('.br-setup button[data-mode="ffa"]').press("Enter");
	await G.waitForFunction(() => window.__game.handle.debug().mode === "ffa", null, { timeout: TIMEOUT });
	check("…once picked, START is open", await G.locator(".br-setup .br-start").isEnabled());
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

	// A person's taps, judged on this phone and taken by the host. The canvas
	// is in the frame; the mouse is the page's, which reaches into it. A
	// bubble's place is in the canvas's content box: the page box less the
	// canvas's own border.
	const canvasBox = await G.locator(".br-field canvas").boundingBox();
	const inset = await G.evaluate(() => {
		const c = document.querySelector(".br-field canvas");
		return { x: c.clientLeft, y: c.clientTop };
	});
	// One finger's pace: the frame takes a tap within TAP_MIN_MS (80 ms) of the
	// last as a bounce, and a judged tap can come back sooner than that.
	let lastTapAt = 0;
	const tapField = async (x, y) => {
		await sleep(Math.max(0, lastTapAt + 150 - Date.now()));
		lastTapAt = Date.now();
		await page.mouse.click(canvasBox.x + inset.x + x, canvasBox.y + inset.y + y);
	};
	// The host's score holds a tap once a view says it took it (`ack`, the
	// last of this phone's taps taken): read after that, not after a fixed pause.
	const judged = (taps) =>
		G.waitForFunction((t) => {
			const d = window.__game.handle.debug();
			return d.taps > t && d.ack >= d.taps;
		}, taps, { timeout: 5000 }).catch(() => {});
	let popped = false;
	for (const end = Date.now() + 20_000; !popped && Date.now() < end; ) {
		const d = await debug(page);
		const b = d.bubbles.filter((b) => b.k !== "x" && b.py > b.pr && b.py < d.field.h - b.pr).sort((p, q) => p.py - q.py)[0];
		if (b && !d.stunned) {
			const before = d.scores[d.you] ?? 0;
			await tapField(b.px, b.py);
			await judged(d.taps);
			popped = ((await debug(page)).scores[d.you] ?? 0) > before;
		} else await sleep(150);
	}
	check("a tap on a bubble pops it, and the host scores it as this phone did", popped);
	// Empty field: a spot near the top no bubble is near, as far as this phone sees.
	let missed = null;
	for (const end = Date.now() + 20_000; missed === null && Date.now() < end; ) {
		const d = await debug(page);
		const spot = [[0.08, 0.04], [0.92, 0.04], [0.5, 0.04]]
			.map(([x, y]) => [d.field.w * x, d.field.h * y])
			.find(([x, y]) => d.bubbles.every((b) => Math.hypot(b.px - x, b.py - y) > b.pr + 40));
		if (spot && !d.stunned) {
			const before = d.scores[d.you] ?? 0;
			await tapField(...spot);
			await judged(d.taps);
			const after = await debug(page);
			// A tap the frame did not take (the round paused, say) is tapped again.
			if (after.taps > d.taps) missed = { before, after: after.scores[d.you] ?? 0, streak: after.streak, misses: after.misses - d.misses, taps: after.taps, ack: after.ack };
		} else await sleep(150);
	}
	check("a tap on empty field scores nothing, counts one miss on the host, and breaks the streak", missed && missed.after === missed.before && missed.misses === 1 && missed.streak === 0, JSON.stringify(missed));
	// A phone turned sideways (844x390): the 1 : 2 field would be about 130px
	// wide, so the game asks for the phone upright instead; turned back, it plays.
	// The hint is for touch screens only (a short desktop window never gets
	// it), and this context has a mouse: report a touch screen to the frame.
	await G.evaluate(() => {
		const mm = window.matchMedia.bind(window);
		window.matchMedia = (q) => (q === "(pointer: coarse)" ? { matches: true, media: q } : mm(q));
	});
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
	// A desktop window that is short and wide (a mouse, not a touch screen)
	// plays on, with no hint.
	await G.evaluate(() => {
		const mm = window.matchMedia.bind(window);
		window.matchMedia = (q) => (q === "(pointer: coarse)" ? { matches: false, media: q } : mm(q));
	});
	await page.setViewportSize({ width: 1280, height: 480 });
	await sleep(600);
	check("a short desktop window (1280x480, a mouse) gets no TURN YOUR PHONE UPRIGHT", !(await debug(page)).turnUpright, JSON.stringify((await debug(page)).field));
	await page.setViewportSize({ width: 390, height: 844 });
	await G.evaluate(() => window.dispatchEvent(new Event("resize")));

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

	// ------------------------------------------------- bubble rush: honest taps
	//
	// Lokesh, 2026-11-17, on his phone: "most of my taps were missing even
	// though I tapped on the bubble, to get the bubble, I had to tap where it
	// would be in the future". A tap claimed the round time as its handler ran,
	// not the frame on the screen when the finger landed; on a busy phone that
	// is 100-300 ms later and the bubble has risen past the finger. So: a
	// 390x844 touch phone at 4x CPU, the frame on screen held 100-300 ms (a
	// slow frame plus the touch's trip through the browser), and a touch
	// exactly where that frame drew a bubble must pop it — for the host and for
	// a guest. The frame and what it drew come from the page's own draw()
	// (top-level bindings of a classic script, as the game-previews recorder
	// reads Neon Survival's). Before the fix (web-games 3b08824) these were 16
	// of 30 (host) and 20 of 30 (guest); after it, 30 of 30 each.
	//
	// Lokesh, 2026-11-21: "the tap is registered after a delay costing
	// experience of the game, register whether the tap succeeded on the
	// player's device itself". The pop is the phone's to decide: the guest
	// here sends its taps through a 400 ms delay (the network, one way; the
	// host's word is at least two of those away), and every pop must show on
	// that phone — the score up, the bubble gone, the ring — before the host
	// has even heard of it, within a few milliseconds of the touch, and the
	// host must then come to the same score (nothing taken back).

	/** A 390x844 touch phone, its page and (later) its game frame throttled to `rate` x CPU. */
	async function phone() {
		const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
		await ctx.addInitScript(() => {
			try {
				localStorage.setItem("neon.rs", "http://127.0.0.1:9");
			} catch {}
		});
		await ctx.addInitScript(firstSeatOpens);
		const p = await ctx.newPage();
		p.on("pageerror", (err) => {
			console.log(`  FAIL page error: ${err.message}`);
			failures++;
		});
		// What the page said, for a failed join's details (CI has no other window).
		p.__log = [];
		p.on("console", (m) => {
			p.__log.push(`${((performance.now() / 1000) | 0)}s ${m.type()}: ${m.text().slice(0, 240)}`);
			if (p.__log.length > 60) p.__log.shift();
		});
		return { ctx, p };
	}
	/** Each page's room and recent console, when a join fails. */
	async function dumpPhones(pages) {
		for (const [i, p] of pages.entries()) {
			const state = await p
				.evaluate(() => {
					const r = window.__party?.room;
					return { status: document.querySelector(".lobby-status")?.textContent ?? null, room: r && { self: r.selfId, host: r.hostId(), links: r.directPeers(), pending: [...r.pending.keys()], refusals: r.refusals, members: r.getMembers().map((m) => m.id) } };
				})
				.catch((e) => String(e));
			console.log(`    [phone ${i + 1}] ${JSON.stringify(state)}`);
			for (const line of p.__log.slice(-25)) console.log(`    [phone ${i + 1}] ${line}`);
		}
	}
	/** Slow the page and the game's frame (its own process, when it is one) to `rate` x CPU. */
	async function throttle(ctx, p, F, rate) {
		for (const target of [p, F]) {
			try {
				await (await ctx.newCDPSession(target)).send("Emulation.setCPUThrottlingRate", { rate });
			} catch {} // the frame shares the page's process: the page's throttle covers it
		}
	}
	/**
	 * `n` honest taps on phone `p` (game frame `F`): hold the frame on screen,
	 * wait `holdMs` [min, max], touch the centre of a bubble as that frame drew
	 * it. What the host said, from this phone's own counts: { pops, misses,
	 * first }; and what this phone showed before the host had the tap:
	 * `instant` (taps whose pop showed at once: the score up, the bubble gone,
	 * a ring), `early` (of those, shown while the host had not yet taken the
	 * tap), `showMs` (the slowest, touch to score on screen), `settled` (taps
	 * after which the host's score was the one this phone showed). With
	 * `delayMs`, every move this phone sends leaves that much later.
	 */
	async function honestTaps(p, F, { n, holdMs, delayMs = 0 }) {
		await F.evaluate((delayMs) => {
			if (delayMs) {
				const send = arcade.act;
				arcade.act = (a) => setTimeout(() => send(a), delayMs);
			}
			// Touch to score on screen: the touch reaching the canvas, then the
			// HUD's score changing (bubble-rush.js renderHud, in the handler).
			window.__downAt = 0;
			window.__showMs = [];
			canvas.addEventListener("pointerdown", () => (window.__downAt = performance.now()), { capture: true });
			new MutationObserver(() => window.__downAt && window.__showMs.push(performance.now() - window.__downAt)).observe(document.querySelector(".br-me"), { childList: true, characterData: true, subtree: true });
		}, delayMs);
		await F.evaluate(() => {
			const orig = draw;
			window.__shown = null;
			draw = function () {
				orig();
				window.__shown = clockT; // the round time this frame drew
			};
			window.__hold = () => {
				const real = window.requestAnimationFrame;
				const queued = [];
				window.requestAnimationFrame = (cb) => (queued.push(cb), 0);
				// Callbacks run in the order asked for: this one runs after a
				// frame already on its way has drawn.
				window.__held = new Promise((r) => real(() => r()));
				return () => {
					window.requestAnimationFrame = real;
					for (const cb of queued.splice(0)) real(cb);
					real(() => {});
				};
			};
		});
		const box = await F.locator(".br-field canvas").boundingBox();
		const inset = await F.evaluate(() => document.querySelector(".br-field canvas").clientLeft);
		const out = { pops: 0, misses: 0, first: 0, instant: 0, early: 0, showMs: 0, settled: 0 };
		const counts = () => F.evaluate(() => ({ popped: view.mine?.popped ?? 0, misses: view.mine?.misses ?? 0, score: __game.handle.debug().score, hidden: hidden.size, effects: effects.length }));
		for (let i = 0, tries = 0; out.pops + out.misses < n && tries < n * 3; tries++) {
			await F.evaluate(() => (window.__release = window.__hold()));
			await F.evaluate(() => window.__held); // a frame already on its way finishes
			const b = await F.evaluate(() => {
				const t = window.__shown;
				if (t === null || view?.phase !== "play") return null;
				const R = bubbleRushRules;
				const w = canvas.clientWidth;
				const h = canvas.clientHeight;
				const drawn = bubbles
					.filter((b) => !isHidden(b.id) && b.k !== "x" && R.alive(b, t) && R.surfaced(b, t))
					.map((b) => ({ id: b.id, ...R.position(b, t), r: b.r }))
					.map((q) => ({ id: q.id, px: q.x * w, py: q.y * h, pr: q.r * w }))
					.filter((q) => q.py > q.pr && q.py < h - q.pr);
				return drawn[Math.floor(Math.random() * drawn.length)] ?? null;
			});
			if (!b) {
				await F.evaluate(() => window.__release());
				await sleep(150);
				continue;
			}
			const before = await counts();
			await sleep(holdMs[0] + Math.random() * (holdMs[1] - holdMs[0]));
			await F.evaluate(() => (window.__showMs.length = 0));
			await p.touchscreen.tap(box.x + inset + b.px, box.y + inset + b.py);
			// What this phone shows right after the touch, before anything is let go.
			// `hid`: the bubble touched is off this phone's field — hidden by this
			// tap, or already dropped by a view that came since (the host's word
			// on this pop, or a bot's pop of it that both keep).
			const shown = await F.evaluate((id) => ({ score: __game.handle.debug().score, hid: [...hidden.values()].includes(tapN) || !bubbles.some((x) => x.id === id), effects: effects.length, ack: view?.ack ?? 0, taps: tapN, ms: window.__showMs[0] ?? null }), b.id);
			await F.evaluate(() => window.__release());
			if (shown.score > before.score && shown.hid && shown.effects > before.effects) {
				out.instant++;
				if (shown.ack < shown.taps) out.early++;
				if (shown.ms !== null) out.showMs = Math.max(out.showMs, Math.round(shown.ms));
			}
			// Until the host has judged this tap (its view's `ack` reaches this
			// phone's tap number): a late answer must not land in the next tap's
			// count, and a slow one is not "someone popped it first".
			const tapped = await F.evaluate(() => tapN);
			await F.waitForFunction((n) => (view?.ack ?? 0) >= n, tapped, { timeout: 5000 }).catch(() => {});
			const after = await counts();
			if (after.popped > before.popped) out.pops++;
			else if (after.misses > before.misses) out.misses++;
			else out.first++; // the host could not place it: neither
			if (await F.evaluate(() => { const d = __game.handle.debug(); return d.pending === 0 && d.score === (d.scores[d.you] ?? 0); })) out.settled++;
			await sleep(120);
		}
		return out;
	}

	console.log("\nbots: bubble rush, an honest tap lands on a busy phone (host)");
	{
		const { ctx, p } = await phone();
		await p.goto(url("?game=lokeshmohanty%2Fbubble-rush&fresh=1"));
		await p.locator("button", { hasText: "SINGLE PLAYER" }).first().click();
		await setPlayers(p, 4); // the quick table: you and three bots
		await p.locator("button", { hasText: "START GAME" }).first().click();
		await p.waitForFunction(() => window.__game?.handle, null, { timeout: TIMEOUT });
		const F = await gameScope(p, TIMEOUT);
		await F.waitForFunction(() => window.__game.handle.debug().phase === "setup", null, { timeout: TIMEOUT });
		await readyToClick(p);
		// Alone with bots, the sides are dealt and the host is asked for a mode: this measures free-for-all.
		await F.locator('.br-setup button[data-mode="ffa"]').tap();
		await F.waitForFunction(() => window.__game.handle.debug().mode === "ffa", null, { timeout: TIMEOUT });
		await throttle(ctx, p, F, 4);
		await F.locator(".br-setup button", { hasText: "START" }).tap();
		await F.waitForFunction(() => window.__game.handle.debug().phase === "play", null, { timeout: TIMEOUT });
		const r = await honestTaps(p, F, { n: 30, holdMs: [100, 300] });
		const rate = r.pops / Math.max(1, r.pops + r.misses);
		check(`touching a bubble where the screen shows it pops it, the frame 100-300 ms old (${r.pops} of ${r.pops + r.misses})`, r.pops + r.misses >= 20 && rate >= 0.95, JSON.stringify(r));
		check(`…each pop shows at once on this phone (${r.instant} of ${r.pops}, the slowest ${r.showMs} ms from touch to score), and the host's score is the one shown (${r.settled})`, r.instant >= r.pops && r.showMs < 100 && r.settled === r.pops + r.misses + r.first, JSON.stringify(r));
		await ctx.close();
	}

	console.log("\nbots: bubble rush, an honest tap lands on a busy phone (guest)");
	{
		// A host (4x CPU, so its ticks may fall behind real time) and a guest
		// phone (4x), joined by invite; the guest taps.
		const host = await phone();
		const guest = await phone();
		await host.p.goto(url("?game=lokeshmohanty%2Fbubble-rush&fresh=1"));
		await host.p.locator("button", { hasText: "MULTI-PLAYER" }).first().click();
		await host.p.locator("button", { hasText: "INVITE A FRIEND" }).first().click();
		const invite = host.p.locator("textarea.share-code").first();
		await invite.waitFor({ timeout: TIMEOUT });
		await guest.p.goto(await invite.inputValue());
		const reply = guest.p.locator("textarea.share-code").first();
		await reply.waitFor({ timeout: TIMEOUT });
		await host.p.locator("textarea.share-code").last().fill(await reply.inputValue());
		await host.p.locator("button", { hasText: "CONNECT" }).first().click();
		await host.p.locator(".party-member").nth(1).waitFor({ timeout: TIMEOUT });
		for (let i = 0; i < 2; i++) await host.p.locator("button", { hasText: "ADD BOT" }).first().click();
		await host.p.locator("button", { hasText: "START GAME" }).first().click();
		const HF = await gameScope(host.p, TIMEOUT);
		const GF = await gameScope(guest.p, TIMEOUT);
		await HF.waitForFunction(() => window.__game?.handle?.debug().phase === "setup", null, { timeout: TIMEOUT });
		await GF.waitForFunction(() => window.__game?.handle?.debug().phase === "setup", null, { timeout: TIMEOUT });
		await throttle(host.ctx, host.p, HF, 4);
		await throttle(guest.ctx, guest.p, GF, 4);
		await readyToClick(host.p);
		await HF.locator('.br-setup button[data-mode="ffa"]').tap();
		await HF.waitForFunction(() => window.__game.handle.debug().mode === "ffa", null, { timeout: TIMEOUT });
		await HF.locator(".br-setup button", { hasText: "START" }).tap();
		await GF.waitForFunction(() => window.__game.handle.debug().phase === "play", null, { timeout: TIMEOUT });
		const r = await honestTaps(guest.p, GF, { n: 30, holdMs: [100, 300], delayMs: 400 });
		const rate = r.pops / Math.max(1, r.pops + r.misses);
		check(`a guest's touch where its screen shows a bubble pops it on the host, the frame 100-300 ms old, its moves 400 ms on the way (${r.pops} of ${r.pops + r.misses})`, r.pops + r.misses >= 20 && rate >= 0.95, JSON.stringify(r));
		check(`…and each pop shows on the guest's phone at once, before the host has the tap: no round trip (${r.early} of ${r.pops}, the slowest ${r.showMs} ms from touch to score, at 4x CPU)`, r.early >= r.pops && r.instant >= r.pops && r.showMs < 100, JSON.stringify(r));
		check(`…then the host's score is the one the guest showed: nothing taken back (${r.settled} of ${r.pops + r.misses + r.first})`, r.settled === r.pops + r.misses + r.first, JSON.stringify(r));
		await host.ctx.close();
		await guest.ctx.close();
	}

	console.log("\nbots: PLAY WITH FRIENDS from a full table: a friend takes a bot's seat");
	{
		// Neon Fission at eight (you and seven bots), one tap, PARTY, PLAY
		// WITH FRIENDS: the party is full, and an invite used to be refused
		// ("This party is full (8 players)"; review, 2026-11-22). The host now
		// gives up its newest bot's seat for the newcomer (net.js yieldBot).
		const host = await phone();
		const guest = await phone();
		await host.p.goto(url("index.html?page=contribute"));
		await host.p.evaluate(() => localStorage.setItem("neon.table", JSON.stringify({ "neon-fission": { n: 8, people: [] } })));
		await host.p.goto(url("?game=neon-fission&fresh=1&mode=bots&start=1"));
		await host.p.waitForFunction(() => window.__party?.game === "neon-fission", null, { timeout: TIMEOUT });
		const eight = await host.p.evaluate(() => window.__party.room.getMembers().length);
		await host.p.locator(".party-pill").click();
		await host.p.locator(".party-peek button", { hasText: "PLAY WITH FRIENDS" }).click();
		await host.p.locator('dialog.neon-ask[open] [data-ask="yes"]').click();
		await host.p.locator(".party-quick button", { hasText: "INVITE A FRIEND" }).first().click();
		const invite = host.p.locator("textarea.share-code").first();
		const minted = await invite.waitFor({ timeout: TIMEOUT }).then(() => true, () => false);
		const refused = await host.p.evaluate(() => /full/i.test(document.getElementById("party")?.textContent ?? ""));
		check("from a full eight-seat table, INVITE A FRIEND mints an invite (not \"This party is full\")", eight === 8 && minted && !refused, JSON.stringify({ eight, minted, refused }));
		// The bot goes when the friend is admitted, not when the invite is
		// made: an invite that lapses, or a join that fails, costs no bot.
		const invited = await host.p.evaluate(() => ({ members: window.__party.room.getMembers().length, bots: window.__party.room.getMembers().filter((m) => NeonArcade.isBotId(m.id)).length }));
		check("…the invite alone costs no bot: still eight, seven of them bots", invited.members === 8 && invited.bots === 7, JSON.stringify(invited));
		if (minted) {
			await guest.p.goto(await invite.inputValue());
			const reply = guest.p.locator("textarea.share-code").first();
			await reply.waitFor({ timeout: TIMEOUT });
			await host.p.locator("textarea.share-code").last().fill(await reply.inputValue());
			await host.p.locator("button", { hasText: "CONNECT" }).first().click();
			const joined = await host.p
				.waitForFunction(() => window.__party.room.getMembers().filter((m) => !NeonArcade.isBotId(m.id)).length === 2, null, { timeout: TIMEOUT })
				.then(() => true, () => false);
			await sleep(500);
			const after = await host.p.evaluate(() => ({ members: window.__party.room.getMembers().length, bots: window.__party.room.getMembers().filter((m) => NeonArcade.isBotId(m.id)).length }));
			check("…the friend joins, in place of a bot: eight members, six of them bots", joined && after.members === 8 && after.bots === 6, JSON.stringify({ joined, ...after }));
		}
		await host.ctx.close();
		await guest.ctx.close();
	}

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
	/** The move line under the board, and whether it is a polite live region. */
	const movedLine = () => c4.evaluate(() => {
		const e = document.getElementById("moved");
		return { text: e.textContent, live: e.getAttribute("role") === "status" && e.getAttribute("aria-live") === "polite" };
	});
	let said = await movedLine();
	check("the move line is a polite live region, silent on the first view", said.live && said.text === "", JSON.stringify(said));

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

	// Sharp on a phone (a DPR-3.5 OnePlus drew it blurry, 2026-11-15): the
	// backing store follows devicePixelRatio, capped at 3, and taps are still
	// read in CSS px. The frame is its own process, which Playwright's device
	// scale does not reach, so the frame is told its ratio and resized.
	const sharp = await c4.evaluate(() => {
		Object.defineProperty(window, "devicePixelRatio", { configurable: true, get: () => 3.5 });
		dispatchEvent(new Event("resize"));
		const b = document.getElementById("board");
		return { ...window.__game.handle.debug().px, cssW: b.clientWidth, cssH: b.clientHeight };
	});
	check("connect 4's board is drawn at the device's pixel ratio, capped at 3 (3.5 here)",
		sharp.dpr === 3 && sharp.w === sharp.cssW * 3 && sharp.h === sharp.cssH * 3 && sharp.cssW === sharp.cell * 7, JSON.stringify(sharp));
	// Its shape at any window: 7 : 6, the backing store 3x what shows. A CSS
	// max-height on the board once squeezed only its height on windows
	// 587-685px tall (553x455 at 1280x650; review 2026-11-19).
	for (const [w, h] of [[1280, 650], [1366, 768], [390, 844], [354, 696]]) {
		await page.setViewportSize({ width: w, height: h });
		await c4.waitForFunction(([w, h]) => innerWidth === w && innerHeight === h, [w, h], { timeout: TIMEOUT });
		const box = await c4.evaluate(async () => {
			// The window's resize event runs before the next frame's callbacks.
			await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
			const b = document.getElementById("board");
			return { cssW: b.clientWidth, cssH: b.clientHeight, w: b.width, h: b.height, bottom: Math.round(b.getBoundingClientRect().bottom) };
		});
		check(`${w}x${h}: connect 4's board keeps its 7 : 6 shape, its backing store 3x what shows, on screen`,
			box.cssW * 6 === box.cssH * 7 && box.w === box.cssW * 3 && box.h === box.cssH * 3 && box.bottom <= h, JSON.stringify(box));
	}
	await page.setViewportSize({ width: 390, height: 844 });
	await c4.waitForFunction(() => innerWidth === 390, null, { timeout: TIMEOUT });
	await readyToClick(page);
	// A tap 1px inside column 7's left edge plays column 7: taps are read in
	// CSS px inside the 3px border. Read across the border box, as before
	// (a319c7f), the same tap played column 6.
	{
		const box = await c4.locator("#board").boundingBox();
		const { cell, inset } = await c4.evaluate(() => ({ cell: window.__game.handle.debug().px.cell, inset: document.getElementById("board").clientLeft }));
		const x = inset + 6 * cell + 1; // from the board's outer left edge
		const before = Math.floor(x / (box.width / 7));
		check("(the tap point is one the old reading put in column 6)", before === 5, JSON.stringify({ x, cell, inset, width: box.width, before }));
		await page.mouse.click(box.x + x, box.y + box.height / 2);
	}
	check("the bot answers with no network at all", await botReplies(0));
	const landed = (await debug(page)).board[5];
	check("…and a tap just inside column 7's edge dropped our disc in column 7 (hit-testing in CSS px, inside the border)", landed[6] === 1, JSON.stringify(landed));

	// The last move is ringed (connect4.js draw): the bot's disc, once it has
	// fallen. Our own is checked after PLAY AGAIN, under reduced motion.
	const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
	state = await debug(page);
	const botDisc = state.board.flatMap((row, r) => row.flatMap((v, c) => (v === 2 ? [[r, c]] : [])));
	await c4.waitForFunction((at) => JSON.stringify(window.__game.handle.debug().marked) === JSON.stringify(at), botDisc[0] ?? null, { timeout: 3000 }).catch(() => {});
	state = await debug(page);
	check("the bot's disc is ringed as the last move, after it falls into place", botDisc.length === 1 && same(state.last, botDisc[0]) && same(state.marked, botDisc[0]) && state.drops >= 1, JSON.stringify({ botDisc, last: state.last, marked: state.marked, drops: state.drops }));
	said = await movedLine();
	check("…and said in words: Yellow dropped in its column", said.text === `Yellow dropped in column ${(botDisc[0]?.[1] ?? -2) + 1}`, JSON.stringify(said));

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

	// PLAY AGAIN: a fresh board, and no ring left over from the game before.
	await page.locator(".managed-over button", { hasText: "PLAY AGAIN" }).click({ timeout: TIMEOUT });
	await c4.waitForFunction(() => {
		const d = window.__game.handle.debug();
		return d.match === 2 && d.board.every((r) => r.every((v) => v === 0));
	}, null, { timeout: TIMEOUT }).catch(() => {});
	state = await debug(page);
	check("PLAY AGAIN: an empty board with no last move ringed", state.match === 2 && state.last === null && state.marked === null, JSON.stringify({ match: state.match, last: state.last, marked: state.marked }));
	said = await movedLine();
	check("…and no move said", said.text === "", JSON.stringify(said));
	// The rematch opens on the bot (the next seat: docs/sdk-v2.md "Who starts").
	await c4.waitForFunction(() => window.__game.handle.debug().turn === window.__game.handle.debug().you, null, { timeout: TIMEOUT });
	state = await debug(page);
	check("…and the rematch opened on the bot's move: who starts takes turns", state.board.flat().filter(Boolean).length === 1 && state.board.flat().includes(2), JSON.stringify(state.board.flat().filter(Boolean)));
	// Reduced motion: no fall, and the ring is on our disc in the same paint.
	await page.emulateMedia({ reducedMotion: "reduce" });
	const dropsBefore = state.drops;
	const col = state.board[5][3] === 0 ? 3 : state.board[5].findIndex((v) => v === 0);
	await drop(col);
	state = await c4.waitForFunction((c) => {
		const d = window.__game.handle.debug();
		return d.board[5][c] !== 0 && d;
	}, col, { timeout: TIMEOUT }).then((h) => h.jsonValue(), () => debug(page));
	check("…our disc is ringed at once under reduced motion, with no fall", same(state.marked, [5, col]) && same(state.last, [5, col]) && state.drops === dropsBefore, JSON.stringify({ marked: state.marked, last: state.last, drops: [dropsBefore, state.drops] }));
	said = await movedLine();
	check(`…and said: Red dropped in column ${col + 1}`, said.text === `Red dropped in column ${col + 1}`, JSON.stringify(said));
	await page.emulateMedia({ reducedMotion: null });
	// A game played: ./ opens on My Games now, with Recently played; the
	// cards with your record are All Games' (lib/portal.js).
	await page.goto(url("index.html"));
	check("…and under Recently played, on My Games", (await page.locator("[data-recent] .recent-game").first().textContent({ timeout: TIMEOUT }).catch(() => "")) === "Connect 4" && new URL(page.url()).searchParams.get("tab") === "mine", page.url());
	await page.goto(url("index.html?page=games&tab=all"));
	// A game has a card in every home-screen section it is in: the first will do.
	const portalSays = await page.locator(`.game-card[data-game="${c4Id}"] .game-you`).first().textContent({ timeout: TIMEOUT }).catch(() => "");
	check("the portal shows it on the game's card", /won of 1/.test(portalSays), portalSays);

	// On a phone (Lokesh's OnePlus, 2026-11-15), the bot's five-ply search held
	// the frame 63-174 ms a move; at 4x CPU here, 90-135 ms (6 of 10 moves over
	// 50 ms). It runs in slices now (connect4.js `sliced`): no long task while
	// the bot thinks, and it still answers. Then the board on a 390x844 and a
	// 354x696 phone: columns at least 44px, text at least 12px.
	console.log("\nbots: connect 4 on a busy phone: the bot never holds the frame");
	{
		const { ctx, p } = await phone();
		await p.goto(url("?game=connect4&fresh=1&mode=bots"));
		await p.waitForFunction(() => window.__game?.handle, null, { timeout: TIMEOUT });
		const F = await gameScope(p, TIMEOUT);
		await F.waitForFunction(() => window.__game.handle.debug().started && window.__game.handle.debug().yellow, null, { timeout: TIMEOUT });
		await throttle(ctx, p, F, 4);
		await F.evaluate(() => {
			window.__long = [];
			new PerformanceObserver((l) => window.__long.push(...l.getEntries().map((e) => Math.round(e.duration)))).observe({ type: "longtask" });
		});
		const longest = [];
		let answered = 0;
		for (const col of [3, 3, 2, 4, 1, 5]) {
			const s0 = await F.evaluate(() => window.__game.handle.debug());
			if (s0.winner !== null) break;
			const discs = s0.board.flat().filter(Boolean).length;
			await F.evaluate(() => (window.__long.length = 0));
			await F.evaluate((c) => arcade.act({ col: c }), s0.board[0][col] === 0 ? col : s0.board[0].indexOf(0));
			const ok = await F.waitForFunction((n) => {
				const s = window.__game.handle.debug();
				return s.winner !== null || (s.board.flat().filter(Boolean).length >= n + 2 && s.turn === 1);
			}, discs, { timeout: TIMEOUT }).then(() => true, () => false);
			if (ok) answered++;
			longest.push(Math.max(0, ...(await F.evaluate(() => window.__long))));
		}
		check(`the bot answers every move at 4x CPU (${answered} of ${longest.length})`, answered === longest.length && answered >= 4, JSON.stringify(longest));
		check("…with no long task (over 50 ms) in the frame while it searches", longest.every((ms) => ms <= 50), `longest per move: ${JSON.stringify(longest)} ms`);
		for (const [w, h] of [[390, 844], [354, 696]]) {
			await p.setViewportSize({ width: w, height: h });
			await F.waitForFunction((w) => innerWidth === w, w, { timeout: TIMEOUT });
			const fit = await F.evaluate(async () => {
				// The window's resize event runs before the next frame's callbacks.
				await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
				const b = document.getElementById("board").getBoundingClientRect();
				return { cell: window.__game.handle.debug().px.cell, left: b.left, right: b.right, bottom: b.bottom, doc: document.documentElement.scrollWidth };
			});
			check(`${w}x${h}: connect 4's columns at least 44px wide, the board on screen`, fit.cell >= 44 && fit.left >= 0 && fit.right <= w && fit.bottom <= h && fit.doc <= w, JSON.stringify(fit));
			const floors = await phoneFloors(F, "body");
			check(`${w}x${h}: connect 4's text at least 12px, its taps 44px`, !floors.text.length && !floors.taps.length && floors.measured.text > 0, JSON.stringify(floors));
		}
		// A bot call the game does not answer in 5 s (lib/sdk-managed.js
		// CALL_TIMEOUT_MS) is asked again, once (review 2026-11-19: nothing
		// asked again, and the game stalled on the bot's turn). Here the first
		// search runs 6.5 s; its late answer must not become a second move.
		await p.goto(url("?game=connect4&fresh=1&mode=bots"));
		await p.waitForFunction(() => window.__game?.handle, null, { timeout: TIMEOUT });
		const F2 = await gameScope(p, TIMEOUT);
		await F2.waitForFunction(() => window.__game.handle.debug().started && window.__game.handle.debug().yellow && window.__game.handle.debug().match === 1, null, { timeout: TIMEOUT });
		await F2.evaluate(() => {
			const real = columnFor;
			let slow = true;
			columnFor = function* (board, me) {
				if (slow) {
					slow = false;
					for (const until = performance.now() + 6500; performance.now() < until; ) yield;
				}
				return yield* real(board, me);
			};
		});
		await F2.evaluate(() => arcade.act({ col: 3 }));
		const retried = await F2.waitForFunction(() => {
			const s = window.__game.handle.debug();
			return s.board.flat().filter(Boolean).length === 2 && s.turn === 1;
		}, null, { timeout: 15_000 }).then(() => true, () => false);
		await sleep(2500); // past the slow search's own answer
		const discs = await F2.evaluate(() => window.__game.handle.debug().board.flat().filter(Boolean).length);
		check("a bot call that timed out is asked again, and the bot moves", retried, `discs ${discs}`);
		check("…once: the late answer is dropped, not played as a second move", discs === 2, `discs ${discs}`);
		await ctx.close();
	}

	// ------------------------------------------------------ neon fission
	//
	// A managed ffa game with a same-device mode: SINGLE PLAYER opens on the
	// shell's quick table (lib/party.js tableBlock), where the one person
	// seated may make bot seats people beside them, whose turns are played on
	// this phone (games/neon-fission/neon-fission.js, "sameDevice").

	/**
	 * Open Neon Fission's SINGLE PLAYER, seat `players` at its quick table —
	 * the seats in `people` played by people on this phone, every other one a
	 * bot (a table remembered from an earlier run is set back) — START GAME,
	 * and wait for the first view.
	 */
	async function openFission(p, players, people = []) {
		await p.goto(url("index.html?game=neon-fission&fresh=1"));
		const solo = p.locator("button", { hasText: "SINGLE PLAYER" }).first();
		await solo.waitFor({ timeout: TIMEOUT });
		const label = await solo.textContent();
		await solo.click();
		await setPlayers(p, players);
		for (let i = 1; i < players; i++) {
			const want = p.locator(`.quick-table [data-qt="seat${i}-${people.includes(i) ? "person" : "bot"}"]`);
			if ((await want.getAttribute("aria-pressed")) !== "true") await want.click();
			await p.waitForFunction((q) => document.querySelector(q)?.getAttribute("aria-pressed") === "true", `.quick-table [data-qt="seat${i}-${people.includes(i) ? "person" : "bot"}"]`, { timeout: TIMEOUT });
		}
		const table = await p.evaluate(() => [...document.querySelectorAll(".quick-seat")].map((li) => li.querySelector(".quick-who").textContent));
		await p.locator(".quick-table button", { hasText: "START GAME" }).click();
		await p.waitForFunction(() => window.__game?.handle, null, { timeout: TIMEOUT });
		const F = await gameScope(p, TIMEOUT);
		await F.waitForFunction(() => window.__game.handle.debug().match != null, null, { timeout: TIMEOUT });
		await readyToClick(p);
		return { F, label, table };
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
		const { F, label } = await openFission(page, 2);
		check("the party offers SINGLE PLAYER / SAME DEVICE (its seats can be people here)", label.trim() === "SINGLE PLAYER / SAME DEVICE", label);
		let v = await fission(F);
		check("the game opens on play, not a table of its own: our move, the board empty", (await F.locator("#setup").count()) === 0 && v.turn === 0 && v.moves === 0 && v.canPlay && v.players.map((p) => p.kind).join() === "human,bot", JSON.stringify({ turn: v.turn, moves: v.moves, kinds: v.players.map((p) => p.kind) }));
		const fit = await F.evaluate(() => {
			const b = document.getElementById("board").getBoundingClientRect();
			const t = document.getElementById("turn").getBoundingClientRect();
			const v = window.__game.handle.debug();
			return { left: b.left, right: b.right, bottom: b.bottom, hudTop: t.top, cell: v.cell, cols: v.cols, rows: v.rows, doc: document.documentElement.scrollWidth, dpr: document.getElementById("board").width / b.width };
		});
		check("two players: a 6 × 9 grid with cells of at least 44px, all on screen", fit.cols === 6 && fit.rows === 9 && fit.cell >= 44 && fit.left >= 0 && fit.right <= 390 && fit.bottom <= 844 && fit.doc <= 390, JSON.stringify(fit));
		check("…the turn line clear of the shell's top band; drawn at the device's pixel ratio", fit.hudTop >= 52 && Math.abs(fit.dpr - (await page.evaluate(() => devicePixelRatio))) < 0.05, JSON.stringify(fit));
		let botMoved = false;
		let acted = -1;
		let warned = null; // the "taken" warnings on screen after three taps on the bot's cell
		for (const end = Date.now() + 120_000; Date.now() < end && v.winner === null; v = await fission(F)) {
			if (v.last && v.last.seat === 1) botMoved = true;
			// On a phone, tapping a taken cell again and again stacked its
			// warning over the board (2026-11-15): the same notice replaces
			// itself (lib/lobby.js NeonArcade.toast), one on screen at a time.
			const theirs = v.owner.indexOf(1);
			if (warned === null && theirs >= 0 && v.canPlay && !v.animating) {
				for (let i = 0; i < 3; i++) {
					await tapCell(page, F, v, theirs);
					await sleep(150);
				}
				warned = await page.evaluate(() => [...document.querySelectorAll(".neon-toast")].filter((t) => /cell is taken/.test(t.textContent)).length);
			}
			if (v.canPlay && !v.animating && v.moves !== acted) {
				acted = v.moves;
				await tapCell(page, F, v, legalPick(v));
			}
			await sleep(120);
		}
		check("the bot plays its own turns", botMoved);
		check("three taps on the bot's cell show its warning once, not three times", warned === 1, `${warned} on screen`);
		check("the game plays out to a winner", v.winner === 0 || v.winner === 1, `winner=${v.winner} after ${v.moves} moves`);
		const card = await page.locator(".managed-over").first().textContent({ timeout: TIMEOUT }).catch(() => "");
		check("the end card shows, with the bot and us ranked", /YOU|WIN/.test(card) && card.includes("DETAILS"), card);
		await resultReached(page, "neon-fission", v.winner === 0);

		// CHANGE PLAYERS and PLAY WITH FRIENDS on the end card (Lokesh,
		// 2026-11-21 and 2026-11-22, "Bottom, between rounds"): the quick
		// table is no longer passed through before a game, so the next
		// round's seats are changed here, and friends are one tap away. PLAY
		// WITH FRIENDS is the card's last button, at both phone sizes.
		for (const [w, h] of [
			[390, 844],
			[354, 696],
		]) {
			await page.setViewportSize({ width: w, height: h });
			await page.waitForTimeout(150);
			const end = await page.evaluate(() => {
				const btns = [...document.querySelectorAll(".managed-over .managed-actions button")];
				const at = (t) => btns.find((b) => b.textContent === t)?.getBoundingClientRect();
				return { labels: btns.map((b) => b.textContent), seats: at("CHANGE PLAYERS")?.height ?? 0, friends: at("PLAY WITH FRIENDS")?.toJSON() ?? null, frame: Math.round(document.querySelector(".game-frame").getBoundingClientRect().bottom) };
			});
			const floors = await phoneFloors(page, ".managed-over", { hit: true });
			check(`${w}x${h}: the end card offers PLAY AGAIN, CHANGE PLAYERS and, at its bottom, PLAY WITH FRIENDS, each 44px, on screen; the game keeps the whole screen`, end.labels.join() === "PLAY AGAIN,CHANGE PLAYERS,SEE THE BOARD,PLAY WITH FRIENDS" && end.seats >= 44 && end.friends?.height >= 44 && end.friends.bottom <= h && end.friends.right <= w && end.frame === h, JSON.stringify(end));
			check(`${w}x${h}: …every control on the end card 44px (box and hit area), none covered`, !floors.taps.length && !floors.text.length, JSON.stringify(floors));
		}
		await page.setViewportSize({ width: 390, height: 844 });
		await page.locator(".managed-over button", { hasText: "CHANGE PLAYERS" }).click();
		await page.locator(".quick-table").waitFor({ timeout: TIMEOUT }).catch(() => {});
		const t = await page.evaluate(() => ({ game: window.__party.game, n: Number(document.querySelector(".quick-table .quick-n")?.textContent), friends: !!document.querySelector(".quick-table .party-switch") }));
		check("CHANGE PLAYERS ends the game and shows its table (Players 2), with Play with friends at its bottom", t.game === null && t.n === 2 && t.friends, JSON.stringify(t));
		await setPlayers(page, 3);
		await page.locator(".quick-table button", { hasText: "START GAME" }).click();
		await page.waitForFunction(() => window.__party.game === "neon-fission", null, { timeout: TIMEOUT }).catch(() => {});
		const next = await page.evaluate(() => ({ members: window.__party.room.getMembers().length, saved: JSON.parse(localStorage.getItem("neon.table") ?? "{}")["neon-fission"]?.n }));
		check("…START GAME plays the next round at the new table (3 players), remembered for the game", next.members === 3 && next.saved === 3, JSON.stringify(next));
		// Back to two for the suites below, which assume a fresh table.
		await page.evaluate(() => localStorage.removeItem("neon.table"));
	}

	console.log("\nlocal: neon fission on one phone, two people and a bot, set at the quick table");
	{
		const ctx2 = await newContext();
		const hot = await ctx2.newPage();
		hot.on("pageerror", (err) => {
			console.log(`  FAIL page error: ${err.message}`);
			failures++;
		});
		const { F, table } = await openFission(hot, 3, [1]);
		check("the table names seat 2 Player 2 once it is a PERSON, as the game does; seat 3 keeps its bot's name", table[1] === "Player 2" && table[2] !== "Player 3", JSON.stringify(table));
		const marked = await hot.evaluate(() => window.__party.room.getMembers().map((m) => [m.id.startsWith("bot_"), m.local === true]));
		check("…a person here is a bot seat to the party, marked local", JSON.stringify(marked) === JSON.stringify([[false, false], [true, true], [true, false]]), JSON.stringify(marked));
		let v = await fission(F);
		check("the game has seat 2 as a player on this device, named Player 2; seat 3 a bot", v.players[1].name === "Player 2" && v.players[1].kind === "local" && v.players[2].kind === "bot", JSON.stringify(v.players.map((p) => [p.name, p.kind])));
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
		// No winner in 150 s (seen on a loaded machine, 2026-11-16): say where
		// it stood, and skip the end card's checks rather than crash on it.
		const ended = v.winner !== null;
		check("the game ends", ended, `after ${v.moves} moves in 150 s: turn ${v.turn}, canPlay ${v.canPlay}, animating ${v.animating}`);
		if (ended) {
			const card = await hot.locator(".managed-over").first().textContent({ timeout: TIMEOUT }).catch(() => "");
			const botName = v.players[2].name;
			check("the end card names Player 2 and the bot by name", card.includes("Player 2") && card.includes(botName), card);
			check("…and its title names the winner as the game does", card.toUpperCase().includes(`${v.players[v.winner].name.toUpperCase()} WINS`), card);
		} else check("the end card names Player 2 and the bot by name (and its winner)", false, "skipped: the game did not end");
		await ctx2.close();
	}

	// ------------------------------------------------------- quick table
	//
	// Lokesh, 2026-11-17: "I don't see option to add more players/bots in
	// single player mode in neon fission." SINGLE PLAYER of a game whose
	// seats leave a choice opens on a quick table — Players − n +, the seats
	// named and coloured, START GAME — remembered per game; fixed seats and
	// PLAY SOMETHING start at once (lib/party.js tableBlock).

	console.log("\nquick table: SINGLE PLAYER chooses how many play");
	{
		const qctx = await newContext();
		// Whether a table was ever drawn on this page, even for a frame.
		await qctx.addInitScript(() => {
			window.__sawTable = false;
			new MutationObserver(() => {
				if (document.querySelector(".quick-table")) window.__sawTable = true;
			}).observe(document, { subtree: true, childList: true });
		});
		const q = await qctx.newPage();
		q.on("pageerror", (err) => {
			console.log(`  FAIL page error: ${err.message}`);
			failures++;
		});
		const tableNow = () =>
			q.evaluate(() => {
				const r = window.__party.room;
				const root = getComputedStyle(document.documentElement);
				return {
					mounted: window.__party.game,
					n: Number(document.querySelector(".quick-n")?.textContent),
					minus: document.querySelector('[data-qt="minus"]')?.disabled,
					plus: document.querySelector('[data-qt="plus"]')?.disabled,
					labels: [...document.querySelectorAll(".quick-step")].map((b) => b.getAttribute("aria-label")),
					group: document.querySelector(".quick-stepper")?.getAttribute("aria-label"),
					live: document.querySelector('.visually-hidden[role="status"]')?.textContent ?? null,
					focus: document.activeElement?.dataset?.qt ?? null,
					says: document.querySelector(".quick-table .party-bots-count")?.textContent,
					seats: [...document.querySelectorAll(".quick-seat")].map((li, i) => ({
						who: li.querySelector(".quick-who").textContent,
						tag: li.querySelector(".party-tag")?.textContent ?? null,
						seg: [...li.querySelectorAll(".quick-seg-btn")].map((b) => b.textContent).join(),
						colour: getComputedStyle(li.querySelector(".quick-dot")).backgroundColor,
						want: (() => {
							const probe = document.createElement("span");
							probe.style.color = root.getPropertyValue(`--p${i + 1}`);
							document.body.append(probe);
							const c = getComputedStyle(probe).color;
							probe.remove();
							return c;
						})(),
					})),
					members: r.getMembers().map((m) => ({ bot: m.id.startsWith("bot_"), name: m.name, local: m.local === true })),
					saved: JSON.parse(localStorage.getItem("neon.table") ?? "{}"),
				};
			});

		// From the card's address (SINGLE PLAYER, ?mode=bots): the table, not the game.
		await q.goto(url("?game=neon-fission&fresh=1&mode=bots"));
		await q.locator(".quick-table").waitFor({ timeout: TIMEOUT });
		let t = await tableNow();
		check("Neon Fission's SINGLE PLAYER opens on the quick table, not the game", !t.mounted && t.n === 2, JSON.stringify({ mounted: t.mounted, n: t.n }));
		check("…Players − 2 +: from its minimum, − off there, + on", t.group === "Players" && t.minus === true && t.plus === false && t.labels.join() === "One player fewer,One player more", JSON.stringify(t));
		check("…you, then the bot by name, each in their seat's colour", t.seats.length === 2 && t.seats[0].tag === "YOU" && t.seats[1].who === t.members[1].name && t.seats.every((s) => s.colour === s.want), JSON.stringify(t.seats));
		check("…a bot seat can be a PERSON here (a same-device game)", t.seats[1].seg === "BOT,PERSON", t.seats[1].seg);

		// The keyboard: arrows on the stepper; the live region says what changed; the focus stays.
		await q.locator('[data-qt="plus"]').focus();
		await q.keyboard.press("ArrowUp");
		await q.waitForFunction(() => document.querySelector(".quick-n")?.textContent === "3", null, { timeout: TIMEOUT });
		t = await tableNow();
		check("ArrowUp adds a player: 3, a second bot by name", t.n === 3 && t.members.filter((m) => m.bot).length === 2 && t.seats[2].who === t.members[2].name, JSON.stringify({ n: t.n, seats: t.seats.map((s) => s.who) }));
		check("…announced in the live region, the focus kept on the stepper", t.live === "3 players. You and 2 bots." && t.focus === "plus", JSON.stringify({ live: t.live, focus: t.focus }));
		await q.keyboard.press("Home");
		await q.waitForFunction(() => document.querySelector(".quick-n")?.textContent === "2", null, { timeout: TIMEOUT });
		t = await tableNow();
		check("Home goes back to the minimum; + kept the focus (− went off)", t.n === 2 && t.focus === "plus", JSON.stringify({ n: t.n, focus: t.focus }));

		// 4 players by tapping +: START GAME starts with 3 bots.
		await setPlayers(q, 4);
		t = await tableNow();
		check("tapping + to 4: you and 3 bots at the table", t.n === 4 && t.says === "You and 3 bots" && t.members.filter((m) => m.bot).length === 3, JSON.stringify({ n: t.n, says: t.says }));
		await q.locator(".quick-table button", { hasText: "START GAME" }).click();
		let F = await gameScope(q, TIMEOUT);
		await F.waitForFunction(() => window.__game.handle.debug().match != null, null, { timeout: TIMEOUT });
		let v = await fission(F);
		check("choosing 4 players starts Neon Fission with 3 bots", v.players.length === 4 && v.players.map((p) => p.kind).join() === "human,bot,bot,bot", JSON.stringify(v.players.map((p) => p.kind)));
		check("…and the table is remembered for this game", JSON.stringify((await q.evaluate(() => JSON.parse(localStorage.getItem("neon.table"))))["neon-fission"]) === JSON.stringify({ n: 4, people: [] }));

		// Again: the table as it was, so a repeat play is SINGLE PLAYER, START GAME.
		await q.goto(url("?game=neon-fission&fresh=1&mode=bots"));
		await q.locator(".quick-table").waitFor({ timeout: TIMEOUT });
		t = await tableNow();
		check("the next SINGLE PLAYER opens on the remembered table: 4 players, 3 bots", t.n === 4 && t.members.filter((m) => m.bot).length === 3, JSON.stringify({ n: t.n }));
		await q.locator(".quick-table button", { hasText: "START GAME" }).click();
		F = await gameScope(q, TIMEOUT);
		await F.waitForFunction(() => window.__game.handle.debug().match != null, null, { timeout: TIMEOUT });
		check("…one tap, START GAME, plays it", (await fission(F)).players.length === 4);

		// PLAY SOMETHING's address (?start=pick): that table's size at once, never drawn.
		await q.goto(url("?game=neon-fission&fresh=1&mode=bots&start=pick"));
		await q.waitForFunction(() => window.__party?.game === "neon-fission", null, { timeout: TIMEOUT });
		const quickStart = await q.evaluate(() => ({ saw: window.__sawTable, bots: window.__party.room.getMembers().filter((m) => m.id.startsWith("bot_")).length, search: location.search }));
		check("PLAY SOMETHING (start=pick) skips the table: the remembered 4 players, at once", !quickStart.saw && quickStart.bots === 3, JSON.stringify(quickStart));
		// While it plays alone the address stays the tap's: a reload is a
		// fresh bots game (Lokesh, 2026-11-22: "A fresh bots game").
		check("…and the address keeps fresh, mode=bots and start while it plays alone, so a reload starts it again", /fresh=1/.test(quickStart.search) && /mode=bots/.test(quickStart.search) && /start=pick/.test(quickStart.search), quickStart.search);

		// The portal's PLAY SOMETHING links say start=pick, and one tap plays without a table.
		await q.goto(url("index.html?page=games&tab=all"));
		const quick = q.locator('[data-section="popular"] [data-quick]');
		const href = await quick.getAttribute("href", { timeout: TIMEOUT });
		const pick = await quick.getAttribute("data-game");
		check("PLAY SOMETHING's link is the card's SINGLE PLAYER plus start=pick (bots only)", new URLSearchParams(href.slice(2)).get("start") === "pick" && new URLSearchParams(href.slice(2)).get("game") === pick, href);
		await quick.click();
		await q.waitForFunction((id) => window.__party?.game === id, pick, { timeout: TIMEOUT });
		check("…one tap into it, no table on the way", !(await q.evaluate(() => window.__sawTable)), pick);

		// Fixed seats (Connect 4: 2 and 2) have nothing to choose: straight in, as before.
		await q.goto(url("?game=connect4&fresh=1&mode=bots"));
		await q.waitForFunction(() => window.__party?.game === "connect4", null, { timeout: TIMEOUT });
		check("Connect 4 skips the table: SINGLE PLAYER starts at once, against one bot", !(await q.evaluate(() => window.__sawTable)) && (await q.evaluate(() => window.__party.room.getMembers().length)) === 2);

		// A one-seat game alone: Players 1, no bots.
		await q.goto(url("?game=lokeshmohanty%2Flight-cycles&fresh=1&mode=bots"));
		await q.locator(".quick-table").waitFor({ timeout: TIMEOUT });
		t = await tableNow();
		check("Light Cycles: Players 1 is just you (playing alone stays possible), − off", t.n === 1 && t.minus === true && t.says === "Just you" && t.members.length === 1, JSON.stringify({ n: t.n, says: t.says }));
		check("…its bot seats are bots only: no PERSON (not a same-device game)", (await (async () => {
			await setPlayers(q, 2);
			const s = (await tableNow()).seats[1];
			return s.tag === "BOT" && s.seg === "";
		})()));
		await q.close();
		await qctx.close();
	}

	console.log("\nquick table: a PERSON seat never counts as a bot");
	{
		const rctx = await newContext();
		const r = await rctx.newPage();
		r.on("pageerror", (err) => {
			console.log(`  FAIL page error: ${err.message}`);
			failures++;
		});
		/** Fission's table at 3, seat 2 a PERSON or a BOT; record the runs asked for (lib/account.js startRun); START. */
		const startWithPerson = async (personHere) => {
			await r.goto(url("?game=neon-fission&fresh=1&mode=bots"));
			await setPlayers(r, 3);
			const want = `[data-qt="seat1-${personHere ? "person" : "bot"}"]`;
			const seg = r.locator(`.quick-table ${want}`);
			if ((await seg.getAttribute("aria-pressed")) !== "true") await seg.click();
			await r.waitForFunction((q) => document.querySelector(q)?.getAttribute("aria-pressed") === "true", want, { timeout: TIMEOUT });
			await r.evaluate(() => {
				window.__runs = [];
				const A = NeonArcade.account;
				if (A) A.startRun = (game, o) => (window.__runs.push({ game, vs: o?.vs ?? "solo" }), Promise.resolve(null));
			});
			await r.locator(".quick-table button", { hasText: "START GAME" }).click();
			const F = await gameScope(r, TIMEOUT);
			await F.waitForFunction(() => window.__game.handle.debug().match != null, null, { timeout: TIMEOUT });
			await sleep(300);
			return { kinds: (await fission(F)).players.map((p) => p.kind).join(), runs: await r.evaluate(() => window.__runs), local: await r.evaluate(() => window.__party.room.getMembers()[1].local === true) };
		};
		let got = await startWithPerson(true);
		check("with a PERSON at the table, the game seats them (local) and no run against bots is asked for", got.kinds === "human,local,bot" && !got.runs.some((x) => x.vs === "bots"), JSON.stringify(got));
		got = await startWithPerson(false);
		check("…the same table with that seat a BOT: the run against bots is asked for", !got.local && got.kinds === "human,bot,bot" && got.runs.some((x) => x.vs === "bots" && x.game === "neon-fission"), JSON.stringify(got));
		// A tap (start=1) plays the table last played, PERSON seats included
		// (Lokesh, 2026-11-22: "Yes, reuse the table"): a group passing one
		// phone just taps and plays.
		await startWithPerson(true);
		await r.goto(url("?game=neon-fission&fresh=1&mode=bots&start=1"));
		await r.waitForFunction(() => window.__party?.game === "neon-fission", null, { timeout: TIMEOUT });
		const PF = await gameScope(r, TIMEOUT);
		await PF.waitForFunction(() => window.__game.handle.debug().match != null, null, { timeout: TIMEOUT });
		const ps = { local: await r.evaluate(() => window.__party.room.getMembers().map((m) => m.local === true)), kinds: (await fission(PF)).players.map((p) => p.kind).join(), saw: await r.evaluate(() => !!document.querySelector(".quick-table")) };
		check("a tap plays the table last played, its PERSON seat included, with no table drawn", ps.local.join() === "false,true,false" && ps.kinds === "human,local,bot", JSON.stringify(ps));
		// PLAY SOMETHING, the random pick (start=pick), seats bots only, at
		// the remembered size (Lokesh, 2026-11-23: "Bots only for random
		// picks"), and leaves the PERSON seat saved for the next card tap.
		await r.goto(url("?game=neon-fission&fresh=1&mode=bots&start=pick"));
		await r.waitForFunction(() => window.__party?.game === "neon-fission", null, { timeout: TIMEOUT });
		const RF = await gameScope(r, TIMEOUT);
		await RF.waitForFunction(() => window.__game.handle.debug().match != null, null, { timeout: TIMEOUT });
		const rp = { local: await r.evaluate(() => window.__party.room.getMembers().map((m) => m.local === true)), kinds: (await fission(RF)).players.map((p) => p.kind).join(), saved: await r.evaluate(() => JSON.parse(localStorage.getItem("neon.table"))["neon-fission"]) };
		check("PLAY SOMETHING seats bots only, at the remembered size (3), keeping the saved PERSON seat", rp.local.join() === "false,false,false" && rp.kinds === "human,bot,bot" && rp.saved.n === 3 && rp.saved.people.join() === "1", JSON.stringify(rp));
		await r.goto(url("?game=neon-fission&fresh=1&mode=bots&start=1"));
		await r.waitForFunction(() => window.__party?.game === "neon-fission", null, { timeout: TIMEOUT });
		const back = await r.evaluate(() => window.__party.room.getMembers().map((m) => m.local === true));
		check("…and the next card tap seats that PERSON again", back.join() === "false,true,false", JSON.stringify(back));
		await rctx.close();
	}

	console.log("\nquick table: PERSON seats after the table — on the roster, and gone when someone joins");
	{
		const sctx = await newContext();
		const h = await sctx.newPage();
		const g = await sctx.newPage();
		for (const p of [h, g]) {
			p.on("pageerror", (err) => {
				console.log(`  FAIL page error: ${err.message}`);
				failures++;
			});
		}
		await openFission(h, 3, [1]);
		// END GAME, back to the party screen.
		await h.locator(".party-pill").click();
		await h.locator("button", { hasText: "END GAME" }).first().click();
		await h.locator('dialog.neon-ask[open] [data-ask="yes"]').click();
		await h.waitForFunction(() => !window.__party.game, null, { timeout: TIMEOUT });
		await h.locator(".party-member").nth(2).waitFor({ timeout: TIMEOUT });
		const roster = () =>
			h.evaluate(() =>
				[...document.querySelectorAll(".party-member")].map((row) => ({
					tag: row.querySelector(".party-tag.is-bot")?.textContent ?? null,
					person: row.querySelector(".party-person")?.getAttribute("aria-pressed") ?? null,
					h: row.querySelector(".party-person")?.getBoundingClientRect().height ?? null,
				})),
			);
		let ro = await roster();
		const hint = await h.locator(".party-person-hint").textContent().catch(() => "");
		check("back on the party screen the seat says PERSON, not BOT, with its toggle on", ro[1].tag === "PERSON" && ro[1].person === "true" && ro[2].tag === "BOT" && ro[2].person === "false" && ro[0].person === null, JSON.stringify(ro));
		check("…a 44px toggle, and a line saying where a PERSON plays (Neon Fission)", ro[1].h >= 44 && /Neon Fission/.test(hint), JSON.stringify({ h: ro[1].h, hint }));
		await h.locator(".party-member").nth(1).locator(".party-person").click();
		await h.waitForFunction(() => window.__party.room.getMembers()[1].local !== true, null, { timeout: TIMEOUT });
		ro = await roster();
		check("the roster's toggle turns it back into a BOT", ro[1].tag === "BOT" && ro[1].person === "false", JSON.stringify(ro));
		await h.locator(".party-member").nth(2).locator(".party-person").click();
		await h.waitForFunction(() => window.__party.room.getMembers()[2].local === true, null, { timeout: TIMEOUT });
		// Neon Fission from the party screen: the roster's PERSON plays.
		await h.locator(".party-game", { hasText: "NEON FISSION" }).click();
		const F = await gameScope(h, TIMEOUT);
		await F.waitForFunction(() => window.__game.handle.debug().match != null, null, { timeout: TIMEOUT });
		check("…and the roster's PERSON plays in the game started from the party screen", (await fission(F)).players.map((p) => p.kind).join() === "human,bot,local");
		await h.locator(".party-pill").click();
		await h.locator("button", { hasText: "END GAME" }).first().click();
		await h.locator('dialog.neon-ask[open] [data-ask="yes"]').click();
		await h.waitForFunction(() => !window.__party.game, null, { timeout: TIMEOUT });

		// A friend joins: nobody is passing this phone round any more.
		await h.locator("button", { hasText: "ADD PLAYER" }).first().click();
		const box = h.locator("textarea.share-code").first();
		await box.waitFor({ timeout: TIMEOUT });
		await g.goto(await box.inputValue());
		const reply = g.locator("textarea.share-code").first();
		await reply.waitFor({ timeout: TIMEOUT });
		await h.locator("textarea.share-code").last().fill(await reply.inputValue());
		await h.locator("button.neon-btn", { hasText: /^CONNECT$/ }).first().click();
		await g.locator(".party-member").nth(3).waitFor({ timeout: TIMEOUT });
		await h.waitForFunction(() => !window.__party.room.getMembers().some((m) => m.local === true), null, { timeout: TIMEOUT }).catch(() => {});
		const after = await h.evaluate(() => ({ local: window.__party.room.getMembers().filter((m) => m.local === true).length, toggles: document.querySelectorAll(".party-person").length, tags: [...document.querySelectorAll(".party-tag.is-bot")].map((t) => t.textContent) }));
		const onGuest = await g.evaluate(() => window.__party.room.getMembers().filter((m) => m.local === true).length);
		check("a second person in the party turns every PERSON seat back into a bot, on every phone", after.local === 0 && onGuest === 0 && after.tags.every((t) => t === "BOT"), JSON.stringify({ after, onGuest }));
		check("…and the roster offers no PERSON toggle while they are here", after.toggles === 0, JSON.stringify(after));
		await sctx.close();
	}

	console.log("\nquick table: fits 390x844 and 354x696, in every theme");
	for (const [w, h] of [[390, 844], [354, 696]]) {
		for (const [name, theme, scheme] of [
			["paper, light", { theme: "paper", mode: "light" }, "light"],
			["paper, dark", { theme: "paper", mode: "dark" }, "dark"],
			["neon", { theme: "neon", mode: "dark" }, "dark"],
		]) {
			const lctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme });
			await lctx.addInitScript((th) => {
				try {
					localStorage.setItem("neon.rs", "http://127.0.0.1:9");
					localStorage.setItem("neon.theme", JSON.stringify(th));
				} catch {}
			}, theme);
			const lp = await lctx.newPage();
			await lp.goto(url("?game=neon-fission&fresh=1&mode=bots"));
			await setPlayers(lp, 8);
			await lp.locator('.quick-table [data-qt="seat1-person"]').click();
			await lp.waitForFunction(() => document.querySelector('[data-qt="seat1-person"]')?.getAttribute("aria-pressed") === "true", null, { timeout: TIMEOUT });
			const l = await lp.evaluate(() => {
				const r = (q) => document.querySelector(q).getBoundingClientRect();
				const taps = [...document.querySelectorAll(".quick-table button")].map((b) => b.getBoundingClientRect());
				const rows = [...document.querySelectorAll(".quick-seat")].map((li) => li.getBoundingClientRect());
				const ink = getComputedStyle(document.querySelector(".quick-who")).color;
				const card = getComputedStyle(document.querySelector(".quick-seat")).backgroundColor;
				const n = getComputedStyle(document.querySelector(".quick-n")).color;
				return {
					doc: document.documentElement.scrollWidth,
					minTap: Math.min(...taps.map((b) => Math.min(b.height, b.width))),
					stepper: r(".quick-stepper"),
					start: r(".quick-go .neon-btn"),
					rowsRight: Math.max(...rows.map((b) => b.right)),
					rowsLeft: Math.min(...rows.map((b) => b.left)),
					seats: rows.length,
					overflow: [...document.querySelectorAll(".quick-who")].some((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).textOverflow !== "ellipsis"),
					ink,
					card,
					n,
				};
			});
			const where = `${w}x${h}, ${name}`;
			check(`${where}: no sideways scroll; every control at least 44px`, l.doc <= w && l.minTap >= 44, JSON.stringify(l));
			check(`${where}: Players and START GAME on screen with 8 seats, START at once below the stepper`, l.stepper.top >= 52 && l.start.bottom <= h && l.start.top > l.stepper.bottom, JSON.stringify({ stepper: l.stepper, start: l.start }));
			check(`${where}: the 8 seats inside the screen's width, names never spilling`, l.seats === 8 && l.rowsLeft >= 0 && l.rowsRight <= w && !l.overflow, JSON.stringify(l));
			check(`${where}: names and the count are not the card's colour`, l.ink !== l.card && l.n !== l.card, JSON.stringify({ ink: l.ink, card: l.card, n: l.n }));
			if (process.env.NEON_SHOTS) await lp.screenshot({ path: join(process.env.NEON_SHOTS, `quick-table-${w}x${h}-${name.replace(/\W+/g, "-")}.png`) }).catch(() => {});
			if (theme.theme === "neon") {
				// The 8 × 12 grid of eight players, on screen (it ran 20px off
				// the bottom at 354x696 until it followed its box's size). At
				// 390x844 its cells are 44px; at 354x696 the screen leaves 40:
				// 8 columns of 44 do not fit in 354 with any margin, nor 12 rows
				// of 44 under the turn line and two rows of chips in 696
				// (docs/perf.md "Phone pass").
				await lp.locator(".quick-table button", { hasText: "START GAME" }).click();
				await lp.waitForFunction(() => window.__game?.handle, null, { timeout: TIMEOUT });
				const LF = await gameScope(lp, TIMEOUT);
				await LF.waitForFunction(() => window.__game.handle.debug().match != null, null, { timeout: TIMEOUT });
				const g = await LF.evaluate(() => {
					const b = document.getElementById("board").getBoundingClientRect();
					const v = window.__game.handle.debug();
					return { cols: v.cols, rows: v.rows, cell: v.cell, left: b.left, right: b.right, bottom: b.bottom, doc: document.documentElement.scrollWidth };
				});
				const least = w < 380 ? 40 : 44;
				check(`${where}: eight players' 8 × 12 grid on screen, cells at least ${least}px`, g.cols === 8 && g.rows === 12 && g.cell >= least && g.left >= 0 && g.right <= w && g.bottom <= h && g.doc <= w, JSON.stringify(g));
				const floors = await phoneFloors(LF, "body");
				check(`${where}: neon fission's text at least 12px with eight players`, !floors.text.length && !floors.taps.length, JSON.stringify(floors));
				// Mid-game the grid holds its size (review 2026-11-19: it followed
				// #wrap, and a chip row wrapping shrank it under a finger). A count
				// going 9 → 10 leaves every chip as wide; and a row more of chips
				// (one added by hand here) does not resize the grid.
				const steady = await LF.evaluate(async () => {
					const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
					const counts = [...document.querySelectorAll("#seats .chip .n")];
					const widths = (t) => counts.map((n) => ((n.textContent = t), n.closest(".chip").getBoundingClientRect().width));
					const one = widths("9");
					const ten = widths("10");
					const cell = window.__game.handle.debug().cell;
					const seats = document.getElementById("seats");
					const extra = seats.firstElementChild.cloneNode(true);
					seats.append(extra, extra.cloneNode(true), extra.cloneNode(true));
					await frame();
					const after = window.__game.handle.debug().cell;
					return { one, ten, cell, after };
				});
				check(`${where}: a chip is as wide at 10 as at 9, and the grid keeps its size when the chips reflow`,
					JSON.stringify(steady.one) === JSON.stringify(steady.ten) && steady.after === steady.cell, JSON.stringify(steady));
			}
			await lctx.close();
		}
	}

	// ------------------------------------------------------ neon survival

	console.log("\nbots: neon survival runs for one player, and for one plus bots");
	await startSolo(page, "?game=neon-survival-mp&fresh=1", "SINGLE PLAYER");
	G = await gameScope(page, TIMEOUT);
	// The frame is up before the platform has run the game's init: until then
	// nothing flies, and "no bots" would hold of an empty world.
	await G.waitForFunction(() => window.gameActive, null, { timeout: TIMEOUT }).catch(() => {});
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
	await setPlayers(page, 3);
	await page.locator("button", { hasText: "START GAME" }).first().click();
	await page.waitForFunction(() => window.__game?.handle, null, { timeout: TIMEOUT });
	G = await gameScope(page, TIMEOUT);
	await G.waitForFunction(() => Object.keys(window.botShips ?? {}).length === 2, null, { timeout: TIMEOUT }).catch(() => {});

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

	// Touch drags, anywhere (Lokesh, 2026-11-18): on his phone the ship sat
	// under the thumb that pointed at it. Now the ship moves by as much as the
	// finger does, from wherever the finger is; one finger steers, a second
	// does nothing, and when the first lifts the second carries on without a
	// jump; the ship stays inside the arena. A guest's phone works the motion
	// out and sends the host a point, which the host takes.
	/** A touch through the browser (CDP): `points` [[x, y, id]] down now; none to lift. */
	const touch = (cdp, type, points = []) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y, id]) => ({ x, y, id })) });
	/** Drag one finger from (x, y) by (dx, dy) in `steps`, through the browser. */
	async function dragBy(cdp, [x, y], [dx, dy], steps = 8) {
		await touch(cdp, "touchStart", [[x, y, 1]]);
		for (let i = 1; i <= steps; i++) {
			await touch(cdp, "touchMove", [[x + (dx * i) / steps, y + (dy * i) / steps, 1]]);
			await sleep(16);
		}
		await touch(cdp, "touchEnd");
	}
	/** No swarm: nothing shoots the ship down while it is measured (the host's simulation). */
	const calm = (F) => F.evaluate(() => {
		s.enemies.length = 0;
		spawnEnemy = () => {};
	});
	const near = (a, b) => Math.abs(a.x - b.x) <= 0.6 && Math.abs(a.y - b.y) <= 0.6;

	console.log("\nbots: neon survival, a finger drags the ship from anywhere (354x696)");
	{
		const { ctx, p } = await phone();
		await p.setViewportSize({ width: 354, height: 696 });
		await p.goto(url("?game=neon-survival-mp&fresh=1&mode=bots"));
		await p.locator(".quick-table button", { hasText: "START GAME" }).click({ timeout: TIMEOUT });
		await p.waitForFunction(() => window.__game?.handle, null, { timeout: TIMEOUT });
		const F = await gameScope(p, TIMEOUT);
		await F.waitForFunction(() => window.gameActive, null, { timeout: TIMEOUT });
		await calm(F);
		await readyToClick(p);
		const cdp = await ctx.newCDPSession(p);
		const ship = () => F.evaluate(() => ({ x: player.x, y: player.y }));
		const k = await F.evaluate(() => W / document.getElementById("gameCanvas").getBoundingClientRect().width);
		const box = await F.locator("#gameCanvas").boundingBox();
		const s0 = await ship();
		// Down at the bottom-left corner of the screen, far from the ship.
		await dragBy(cdp, [30, 680], [60, -40]);
		await sleep(300);
		const s1 = await ship();
		const want = { x: s0.x + 60 * k, y: s0.y - 40 * k };
		check("a drag from a corner moves the ship by as much as the finger, not to the finger", near(s1, want), JSON.stringify({ s0, s1, want, k }));
		const under = { x: (90 - box.x) * k, y: (640 - box.y) * k };
		check("…so it is not under the thumb", Math.hypot(s1.x - under.x, s1.y - under.y) > 50, JSON.stringify({ s1, under }));
		// Far past the right edge: held inside the arena, and back at once.
		await dragBy(cdp, [100, 400], [600, 0], 12);
		await sleep(300);
		const edge = await ship();
		const W = await F.evaluate(() => W);
		check("dragged past the edge, the ship stays wholly inside the arena", Math.abs(edge.x - (W - 7.5)) <= 0.6 && Math.abs(edge.y - s1.y) <= 0.6, JSON.stringify({ edge, W }));
		await dragBy(cdp, [300, 400], [-30, 0]);
		await sleep(300);
		const back = await ship();
		check("…and comes back as soon as the finger does", near(back, { x: edge.x - 30 * k, y: edge.y }), JSON.stringify({ edge, back }));
		// Two fingers, as touch events in the frame: the browser's own
		// multi-touch emulation drops a remaining finger's moves.
		const fire = (type, changed, all) => F.evaluate(([type, changed, all]) => {
			const T = ([id, x, y]) => new Touch({ identifier: id, target: document.body, clientX: x, clientY: y });
			document.body.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, changedTouches: changed.map(T), touches: all.map(T) }));
		}, [type, changed, all]);
		const s2 = await ship();
		await fire("touchstart", [[1, 40, 600]], [[1, 40, 600]]);
		await fire("touchstart", [[2, 300, 150]], [[1, 40, 600], [2, 300, 150]]);
		await fire("touchmove", [[2, 200, 300]], [[1, 40, 600], [2, 200, 300]]);
		await sleep(300);
		check("a second finger moving does not move the ship", near(await ship(), s2), JSON.stringify({ s2, now: await ship() }));
		await fire("touchend", [[1, 40, 600]], [[2, 200, 300]]);
		await sleep(200);
		const s3 = await ship();
		check("…nor does the first finger lifting", near(s3, s2), JSON.stringify({ s2, s3 }));
		await fire("touchmove", [[2, 180, 320]], [[2, 180, 320]]);
		await sleep(300);
		check("…then the finger still down steers on from where the ship is", near(await ship(), { x: s3.x - 20 * k, y: s3.y + 20 * k }), JSON.stringify({ s3, now: await ship() }));
		await fire("touchend", [[2, 180, 320]], []);
		// Steering never locks (review 2026-11-19). A finger already down when
		// the run started (its touchstart came while no ship flew) steers on
		// its first move...
		const s4 = await ship();
		await fire("touchmove", [[5, 100, 300]], [[5, 100, 300]]);
		await fire("touchmove", [[5, 125, 300]], [[5, 125, 300]]);
		await sleep(300);
		check("a finger already down when the run began steers from its next move", near(await ship(), { x: s4.x + 25 * k, y: s4.y }), JSON.stringify({ s4, now: await ship() }));
		await fire("touchend", [[5, 125, 300]], []);
		// ...and a steering finger whose touchend was lost does not hold the ship.
		const s5 = await ship();
		await fire("touchstart", [[7, 100, 300]], [[7, 100, 300]]);
		await fire("touchstart", [[8, 150, 350]], [[8, 150, 350]]); // 7 is gone, its touchend never came
		await fire("touchmove", [[8, 130, 350]], [[8, 130, 350]]);
		await sleep(300);
		check("…and after a lost touchend the next finger down steers", near(await ship(), { x: s5.x - 20 * k, y: s5.y }), JSON.stringify({ s5, now: await ship() }));
		await fire("touchend", [[8, 130, 350]], []);
		const floors = await phoneFloors(F, "body");
		check("354x696: neon survival's text at least 12px", !floors.text.length && !floors.taps.length && floors.measured.text > 0, JSON.stringify(floors));
		await ctx.close();
	}

	console.log("\nbots: neon survival, a guest's drag moves its ship on the host");
	{
		const host = await phone();
		const guest = await phone();
		await host.p.goto(url("?game=neon-survival-mp&fresh=1"));
		await host.p.locator("button", { hasText: "MULTI-PLAYER" }).first().click();
		await host.p.locator("button", { hasText: "INVITE A FRIEND" }).first().click();
		const invite = host.p.locator("textarea.share-code").first();
		await invite.waitFor({ timeout: TIMEOUT });
		await guest.p.goto(await invite.inputValue());
		const reply = guest.p.locator("textarea.share-code").first();
		await reply.waitFor({ timeout: TIMEOUT });
		await host.p.locator("textarea.share-code").last().fill(await reply.inputValue());
		await host.p.locator("button", { hasText: "CONNECT" }).first().click();
		await host.p
			.locator(".party-member")
			.nth(1)
			.waitFor({ timeout: TIMEOUT })
			.catch(async (err) => {
				await dumpPhones([host.p, guest.p]);
				throw err;
			});
		await host.p.locator("button", { hasText: "START GAME" }).first().click();
		const HF = await gameScope(host.p, TIMEOUT);
		const GF = await gameScope(guest.p, TIMEOUT);
		await HF.waitForFunction(() => window.gameActive, null, { timeout: TIMEOUT });
		await GF.waitForFunction(() => window.gameActive && window.__game.handle.debug().you, null, { timeout: TIMEOUT });
		await calm(HF);
		await readyToClick(guest.p);
		const gid = await guest.p.evaluate(() => window.__party.room.selfId);
		const onHost = () => HF.evaluate((id) => ({ x: s.ships[id].x, y: s.ships[id].y }), gid);
		const k = await GF.evaluate(() => W / document.getElementById("gameCanvas").getBoundingClientRect().width);
		const before = await onHost();
		await dragBy(await guest.ctx.newCDPSession(guest.p), [30, 800], [50, -70]);
		const want = { x: before.x + 50 * k, y: before.y - 70 * k };
		const got = await HF.waitForFunction(([id, want]) => {
			const p = s.ships[id];
			return Math.abs(p.x - want.x) <= 0.6 && Math.abs(p.y - want.y) <= 0.6 && { x: p.x, y: p.y };
		}, [gid, want], { timeout: 5000 }).then((h) => h.jsonValue(), () => onHost());
		check("the host moves the guest's ship by as much as the guest's finger moved", near(got, want), JSON.stringify({ before, got, want, k }));
		await host.ctx.close();
		await guest.ctx.close();
	}

	// --------------------------------------------------------------- ludo
	//
	// Bots on both boards: each bot's move is its whole turn (a 6 rolls again
	// inside it). The setup only the first time (Lokesh, 2026-11-23): a fresh
	// phone's card tap goes straight in, PLAY AGAIN too; a different table
	// brings the setup; the same table again goes straight in on its board
	// and teams. Until the registry's pin has Ludo these skip, saying so.

	/** A block for a game the registry's pin may not have yet (it skips, saying so, until the pin moves). */
	const pinned = (id) => {
		if (communityHas(`lokeshmohanty/${id}`)) return true;
		// Listed in the registry but not built: a failure, never a quiet skip.
		if (registryLists(`lokeshmohanty/${id}`)) return check(`lokeshmohanty/${id} is listed in the registry but missing from community/catalog.js`, false), false;
		console.log(`  skip lokeshmohanty/${id} is not in community/catalog.js (the registry's pin has not moved to it yet)`);
		return false;
	};
	/** Ludo with bots, `n` at the quick table, through to its first view. */
	async function openLudo(p, n) {
		await p.goto(url("?game=lokeshmohanty%2Fludo&fresh=1&mode=bots"));
		const which = await (
			await p.waitForFunction(() => {
				const go = document.querySelector(".quick-table .quick-go button");
				return go && go.getClientRects().length ? "table" : window.__party?.game ? "game" : null;
			}, null, { timeout: TIMEOUT })
		).jsonValue();
		if (which === "table") {
			await setPlayers(p, n);
			await p.locator(".quick-table .quick-go button").click();
		}
		await p.waitForFunction(() => window.__game?.handle, null, { timeout: TIMEOUT });
		const F = await gameScope(p, TIMEOUT);
		await F.waitForFunction((n) => window.__game.handle.debug().seats?.length === n, n, { timeout: TIMEOUT });
		await readyToClick(p);
		return F;
	}
	/** Roll and pick (the first ring) as a thumb would, until `done(view)`; every event seen, in order. */
	async function ludoDrive(F, done, ms) {
		const seen = new Map();
		const end = Date.now() + ms;
		let v = await F.evaluate(() => window.__game.handle.debug());
		for (; !done(v, seen) && Date.now() < end; v = await F.evaluate(() => window.__game.handle.debug())) {
			for (const e of v.log ?? []) seen.set(e.n, e);
			if (v.myTurn && v.stage === "roll" && !v.tumbling && !v.busy) await F.evaluate(() => document.querySelector(".lu-die:not(:disabled)")?.click());
			else if (v.targets?.length && !v.picking) await F.evaluate(() => document.querySelector(".lu-pick")?.click());
			await sleep(150);
		}
		for (const e of v.log ?? []) seen.set(e.n, e);
		return { v, seen: [...seen.values()].sort((a, b) => a.n - b.n) };
	}

	console.log("\nbots: ludo, one person and one bot: straight in, to the end, PLAY AGAIN straight in");
	if (pinned("ludo")) {
		G = await openLudo(page, 2);
		let v = await debug(page);
		check("a fresh phone's tap: straight into play (no setup), the 4-player board, free-for-all, the two opposite", v.phase === "play" && v.board === 4 && v.mode === "ffa" && v.arms.join() === "0,2", JSON.stringify({ phase: v.phase, board: v.board, arms: v.arms }));
		const opener = v.opener;
		// The game, without its animations: the bot waits for none.
		await page.emulateMedia({ reducedMotion: "reduce" });
		({ v } = await ludoDrive(G, (v) => v.over, 300_000));
		check("the game ends: the winner has all four tokens home", v.over && v.winner != null && v.tokens[v.winner].every((p) => p === v.home), JSON.stringify({ winner: v.winner, tokens: v.tokens }));
		await resultReached(page, "lokeshmohanty/ludo", v.winner === v.you);
		await page.emulateMedia({ reducedMotion: null });
		// "Next game: … · CHANGE" (Lokesh, 2026-11-23), on the game's end screen behind SEE THE BOARD.
		await page.locator(".managed-over button", { hasText: "SEE THE BOARD" }).first().click({ timeout: TIMEOUT });
		await G.waitForFunction(() => !!document.querySelector(".lu-next:not([hidden]) .lu-next-change"), null, { timeout: TIMEOUT });
		await G.locator(".lu-next-change").click();
		await G.locator('.lu-next button[data-board="6"]').click({ timeout: TIMEOUT });
		await G.locator(".lu-next-change").click();
		const said = await G.evaluate(() => document.querySelector(".lu-next").textContent);
		check("CHANGE at the end: the next game on the 6-player board", said.startsWith("Next game: 6-player board, free-for-all"), said);
		await page.locator(".managed-over button", { hasText: "PLAY AGAIN" }).first().click({ timeout: TIMEOUT });
		await G.waitForFunction(() => window.__game.handle.debug().match === 2, null, { timeout: TIMEOUT });
		v = await debug(page);
		check("PLAY AGAIN: straight into play on the board picked for it, the next seat to open (who starts goes round)", v.phase === "play" && v.board === 6 && v.arms.join() === "0,3" && v.opener === (opener + 1) % 2 && v.turn === v.opener, JSON.stringify({ phase: v.phase, board: v.board, opener, now: v.opener }));
	}

	console.log("\nbots: ludo, one person and three bots: a different table brings the setup; 2 v 2; bots' whole turns");
	if (pinned("ludo")) {
		G = await openLudo(page, 4);
		let v = await debug(page);
		const self = await selfOf(page);
		check("four at the table (last time two): the setup, the last board (6) still picked, free-for-all", v.seats[v.you] === self && v.seats.filter((id) => id.startsWith("bot_")).length === 3 && v.phase === "setup" && v.board === 6 && v.mode === "ffa", JSON.stringify({ seats: v.seats, phase: v.phase, board: v.board }));
		await G.locator('.lu-setup button[data-board="4"]').click();
		await G.waitForFunction(() => window.__game.handle.debug().board === 4, null, { timeout: TIMEOUT });
		// Each seat's chip carries its token's own mark, not only a colour.
		const glyphs = await G.evaluate(() => [...document.querySelectorAll(".lu-player svg")].map((s) => s.dataset.glyph));
		check(`each seat's chip shows its token's own mark (${glyphs.join(", ")})`, glyphs.length === 4 && new Set(glyphs).size === 4 && glyphs.every(Boolean), JSON.stringify(glyphs));
		await G.locator('.lu-setup button[data-mode="pairs"]').click();
		await G.waitForFunction(() => window.__game.handle.debug().mode === "pairs", null, { timeout: TIMEOUT });
		v = await debug(page);
		check("2 v 2: partners sit opposite (arms two apart, the same team)", [0, 1].every((i) => v.teams[i] === v.teams[i + 2] && Math.abs(v.arms[i] - v.arms[i + 2]) === 2) && v.teams[0] !== v.teams[1], JSON.stringify({ arms: v.arms, teams: v.teams }));
		await phoneSizes(page, G, "ludo, setting up 2 v 2");
		await G.locator(".lu-start").click();
		await G.waitForFunction(() => window.__game.handle.debug().phase === "play", null, { timeout: TIMEOUT });
		v = await debug(page);
		check("START: every token in its yard, the opener on turn", v.tokens.every((t) => t.every((p) => p === -1)) && v.turn === v.opener);
		await phoneSizes(page, G, "ludo, 2 v 2 on the 4-player board");
		// Bot seats roll for themselves; a bot's 6 rolls again within its one move.
		const bots = new Set(v.seats.map((id, i) => (id.startsWith("bot_") ? i : -1)).filter((i) => i >= 0));
		const twice = (seen) => seen.some((e, k) => k && bots.has(e.seat) && seen[k - 1].seat === e.seat && seen[k - 1].roll === 6 && !e.picked);
		const run = await ludoDrive(G, (v, seen) => [...bots].every((b) => [...seen.values()].some((e) => e.seat === b)) && twice([...seen.values()].sort((a, b) => a.n - b.n)), 150_000);
		check("every bot rolls its own turns", [...bots].every((b) => run.seen.some((e) => e.seat === b)), JSON.stringify([...new Set(run.seen.map((e) => e.seat))]));
		check("a bot's 6 rolls again, inside its turn (the game never waits on a bot still on turn)", twice(run.seen), `${run.seen.length} events`);
		check("no event lost: every one from the first, in order", run.seen.every((e, k) => e.n === k + 1), run.seen.map((e) => e.n).join());
	}

	console.log("\nbots: ludo on the 6-player board, two teams of three; the same table again goes straight in");
	if (pinned("ludo")) {
		G = await openLudo(page, 6);
		let v = await debug(page);
		const four = await G.locator('.lu-setup button[data-board="4"]').isDisabled();
		check("six at the table: the setup, the 6-player board, the 4-player board not on offer", v.phase === "setup" && v.board === 6 && four);
		await G.locator('.lu-setup button[data-mode="trios"]').click();
		await G.waitForFunction(() => window.__game.handle.debug().mode === "trios", null, { timeout: TIMEOUT });
		v = await debug(page);
		check("two teams of three, on every other arm", v.teams.join() === "0,1,0,1,0,1" && v.arms.join() === "0,1,2,3,4,5", JSON.stringify({ teams: v.teams, arms: v.arms }));
		await G.locator(".lu-start").click();
		await G.waitForFunction(() => window.__game.handle.debug().phase === "play", null, { timeout: TIMEOUT });
		await phoneSizes(page, G, "ludo, the 6-player board");
		const run = await ludoDrive(G, (v, seen) => seen.size >= 40, 150_000);
		const movers = new Set(run.seen.map((e) => e.seat));
		check(`all six seats take their turns (${movers.size} seen in ${run.seen.length} events)`, movers.size === 6);
		check("tokens have come out onto the board", run.v.tokens.flat().some((p) => p >= 0), JSON.stringify(run.v.tokens));
		// The card again, the same six: no setup, two teams of three as before.
		G = await openLudo(page, 6);
		await G.waitForFunction(() => window.__game.handle.debug().phase, null, { timeout: TIMEOUT });
		v = await debug(page);
		check("the same table again (a card's tap): straight into play, 6-player board, two teams of three", v.phase === "play" && v.board === 6 && v.mode === "trios" && v.teams.join() === "0,1,0,1,0,1", JSON.stringify({ phase: v.phase, board: v.board, mode: v.mode }));
	}

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
		// Watched for from before the yes: the notice lives 4.5 s, and the
		// replier's page load can take longer than that on a slow runner.
		const told = inviter
			.locator(".neon-toast", { hasText: `${guestName} left the party.` })
			.waitFor({ timeout: TIMEOUT })
			.then(() => true)
			.catch(() => false);
		await Promise.all([
			replier.waitForURL(PORTAL, { timeout: TIMEOUT }),
			replier.locator('dialog.neon-ask[open] [data-ask="yes"]').click(),
		]);
		check("…and the one left behind is told", await told);
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
			// Red drops a disc before the host goes: the new host's view still rings it.
			for (const p of [hostP, guestP]) {
				const F = await gameScope(p, TIMEOUT);
				await F.evaluate(() => window.__game.handle.debug().red === window.arcade.party.self && window.arcade.act({ col: 2 }));
			}
			await (await gameScope(guestP, TIMEOUT)).waitForFunction(() => window.__game.handle.debug().board[5][2] !== 0, null, { timeout: TIMEOUT });
			await sleep(500); // the heir's copy follows each move
		}
		// Watched for from before the host goes: the notice lives 4.5 s.
		const msg = midGame ? "You are the host now — CONNECT 4 goes on." : "You are the host now.";
		const told = guestP
			.locator(".neon-toast", { hasText: msg })
			.waitFor({ timeout: TIMEOUT })
			.then(() => true)
			.catch(() => false);
		await hostP.close();
		check(`${midGame ? "mid-game" : "before START"}: the guest is told (${msg})`, await told);
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
		if (midGame) {
			const held = await debug(guestP);
			check("…and the disc dropped before the host left is still the one ringed", JSON.stringify(held.marked) === "[5,2]" && JSON.stringify(held.last) === "[5,2]", JSON.stringify({ marked: held.marked, last: held.last }));
		}
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
