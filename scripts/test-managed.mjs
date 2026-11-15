// scripts/test-managed.mjs — SDK v2 Layer 2: the platform runs the game.
//
// A managed game writes rules and a draw function; lib/sdk-managed.js does
// host authority, views, bots, the end card, rematches and handover. This
// drives real browsers through what that promises:
//
//   1. Tic Tac Toe (sdk/v2/examples/tic-tac-toe-js), host vs a guest with a
//      third phone watching:
//      - each phone gets its own view;
//      - a move out of turn is refused;
//      - the shell's end card names the winner on every phone;
//      - PLAY AGAIN starts the next match;
//      - when the host's tab closes mid-match, the heir carries the board on
//        from its snapshot, and the shell's turn-wait banner lets it skip
//        the departed player.
//   2. A ticking fixture (scripts/fixtures/tick-game), host + guest + bot:
//      a guest's inputs and the bot's reach the host's tick, views arrive at
//      viewRate, and the result ends it.
//   3. The end card on a phone (390x844): the ranking (places, seat colours,
//      names, scores, you marked) on every phone; DETAILS closed at first,
//      remembered once opened, and holding the series (match, time, wins
//      across PLAY AGAIN), your stats and the game's own `details` (capped
//      at 8 rows); Connect 4's and Neon Survival's details; eight players
//      fit without scrolling, clear of the fixed chrome, in every theme.
//
// Every message across a frame is checked against sdk/v2/protocol.json, and
// every Layer 2 message type must have been seen.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { catalogue, checkTrace } from "./protocol-check.mjs";
import { PORT_OFFSET, gameFrame, readyToClick, serve } from "./serve.mjs";
import { loadPlaywright } from "./playwright.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TIMEOUT = 40_000;
const LAYER2 = ["act", "input", "rules", "view", "rejected"];

let failures = 0;
const check = (label, ok, detail = "") => {
	console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
	if (!ok) failures++;
};

function chromePath() {
	const found = [process.env.CHROME, "/run/current-system/sw/bin/google-chrome-stable", "/run/current-system/sw/bin/chromium", join(homedir(), ".nix-profile", "bin", "google-chrome-stable")]
		.filter(Boolean)
		.find((p) => existsSync(p));
	if (!found) throw new Error("no system Chrome found; set CHROME=/path/to/chrome");
	return found;
}

const site = await serve(8741);
/** The dev kit's server for a folder of games; its base URL for `game`. */
async function devServer(folder, port, game) {
	port += PORT_OFFSET;
	const dev = spawn("node", [join(ROOT, "sdk/dev-server.mjs"), join(ROOT, folder), String(port)], { env: { ...process.env, NEON_PLATFORM: site.base }, stdio: "ignore" });
	process.on("exit", () => dev.kill());
	const base = `http://127.0.0.1:${port}/${game}/`;
	for (let i = 0; i < 50 && !(await fetch(base + "game.json").then((r) => r.ok, () => false)); i++) await new Promise((r) => setTimeout(r, 100));
	return { base, stop: () => dev.kill() };
}

const { chromium } = loadPlaywright();
const browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox"] });
const traced = [];

/** A party of `n` phones on the dev game at `devBase`, formed by invites. */
async function party(devBase, n) {
	const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
	await context.addInitScript(() => {
		window.__sdk = [];
		window.NeonArcade = window.NeonArcade || {};
		NeonArcade.turnWaitMs = 500;
		NeonArcade.sdkTrace = (dir, m) => window.__sdk.push([dir, JSON.parse(JSON.stringify(m, (_k, v) => (v instanceof ArrayBuffer ? { $buffer: v.byteLength } : v)))]);
	});
	const pages = [];
	for (let i = 0; i < n; i++) {
		const page = await context.newPage();
		page.on("pageerror", (err) => check(`no page error on phone ${i + 1}`, false, err.message));
		pages.push(page);
	}
	const withDev = (url) => {
		const u = new URL(url);
		u.searchParams.set("dev", devBase);
		return u.href;
	};
	await pages[0].goto(`${site.base}/?${new URLSearchParams({ dev: devBase, fresh: "1", rs: "http://127.0.0.1:1" })}`);
	await pages[0].locator(".party-member").first().waitFor({ timeout: TIMEOUT });
	for (const joiner of pages.slice(1)) {
		const host = pages[0];
		await host.locator("button", { hasText: "ADD PLAYER" }).first().click();
		const box = host.locator("textarea.share-code").first();
		await box.waitFor({ timeout: TIMEOUT });
		await joiner.goto(withDev(await box.inputValue()));
		const reply = joiner.locator("textarea.share-code").first();
		await reply.waitFor({ timeout: TIMEOUT });
		await host.locator("textarea.share-code").last().fill(await reply.inputValue());
		await host.locator("button.neon-btn", { hasText: /^CONNECT$/ }).first().click();
		await joiner.locator(".party-member").first().waitFor({ timeout: TIMEOUT });
	}
	await pages[0].locator(".party-member").nth(n - 1).waitFor({ timeout: TIMEOUT });
	const collect = async () => {
		for (const p of pages) if (!p.isClosed()) traced.push(...(await p.evaluate(() => window.__sdk.splice(0)).catch(() => [])));
	};
	return { context, pages, collect };
}
const ids = (pages) => Promise.all(pages.map((p) => p.evaluate(() => window.__party.room.selfId)));
const view = (frame) => frame.evaluate(() => window.arcade.view);
/** Poll `frame`'s view until `pred(view)`; the last view either way. */
async function viewUntil(frame, pred, ms = TIMEOUT) {
	const end = Date.now() + ms;
	let v = await view(frame).catch(() => null);
	while (!(v && pred(v)) && Date.now() < end) {
		await new Promise((r) => setTimeout(r, 150));
		v = await view(frame).catch(() => null);
	}
	return v;
}
const cardText = (page) => page.locator(".managed-over h2").textContent({ timeout: TIMEOUT }).catch(() => null);
/** The end card as a phone shows it: ranking rows, DETAILS, geometry. */
const card = (page) =>
	page.evaluate(() => {
		const c = document.querySelector(".managed-over");
		if (!c) return null;
		const r = (e) => {
			const b = e.getBoundingClientRect();
			return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right) };
		};
		const box = r(c.firstElementChild);
		const body = c.querySelector(".managed-body");
		const toggle = c.querySelector(".managed-toggle");
		const extra = c.querySelector(".managed-details");
		// Fixed chrome the card must not sit under: the top band, the pills
		// (a passing toast is not chrome).
		const chrome = [...document.querySelectorAll("body *")]
			.filter((e) => !c.contains(e) && !e.closest("[hidden], .neon-toasts") && getComputedStyle(e).position === "fixed" && getComputedStyle(e).visibility !== "hidden")
			.map((e) => [e.className, r(e)])
			.filter(([, b]) => b.right > b.left && b.bottom > b.top && (b.right - b.left) * (b.bottom - b.top) < innerWidth * innerHeight * 0.5);
		return {
			role: c.getAttribute("role"),
			labelled: !!document.getElementById(c.getAttribute("aria-labelledby") ?? "")?.textContent,
			title: c.querySelector("h2")?.textContent,
			rows: [...c.querySelectorAll(".managed-rank li")].map((li) => ({
				id: li.dataset.id,
				place: li.querySelector(".managed-place").textContent,
				name: li.querySelector(".managed-name").firstChild.textContent,
				score: li.querySelector(".managed-score").textContent,
				you: li.classList.contains("is-you"),
				dot: getComputedStyle(li.querySelector(".managed-dot")).backgroundColor,
			})),
			toggle: toggle && { tag: toggle.tagName, expanded: toggle.getAttribute("aria-expanded"), controls: toggle.getAttribute("aria-controls") === extra?.id },
			open: !!extra && !extra.hidden && extra.getBoundingClientRect().height > 0,
			sections: Object.fromEntries([...c.querySelectorAll(".managed-details table")].map((t) => [t.dataset.section, [...t.querySelectorAll("tr")].map((tr) => [tr.cells[0].textContent, tr.cells[1].textContent])])),
			box,
			scrolls: body.scrollHeight > body.clientHeight + 1,
			wide: document.documentElement.scrollWidth,
			under: chrome.filter(([, b]) => b.left < box.right && b.right > box.left && b.top < box.bottom && b.bottom > box.top).map(([cls]) => String(cls)),
		};
	});
/** On a 390x844 phone: inside the screen, no sideways scroll, nothing over it. */
const fits = (k) => !!k && k.box.top >= 0 && k.box.bottom <= 844 && k.box.left >= 0 && k.box.right <= 390 && k.wide <= 390 && !k.under.length;
const row = (k, section, label) => k?.sections?.[section]?.find(([l]) => l === label)?.[1];

try {
	// ---------------------------------------------------------------- 1
	console.log("\nmanaged: Tic Tac Toe, two players and a spectator");
	const ttt = await devServer("sdk/v2/examples", 5195, "tic-tac-toe-js");
	const A = await party(ttt.base, 3);
	const [host, p2, p3] = A.pages;
	const [hostId, p2Id, p3Id] = await ids(A.pages);
	await host.evaluate(({ hostId, p2Id, p3Id }) => {
		const r = window.__party.room;
		r.setTeam(hostId, "A");
		r.setTeam(p2Id, "B");
		r.setTeam(p3Id, "spectator");
	}, { hostId, p2Id, p3Id });
	await host.locator(".party-game", { hasText: "TIC TAC TOE" }).first().click({ timeout: TIMEOUT });
	const [fh, f2, f3] = await Promise.all(A.pages.map((p) => gameFrame(p, TIMEOUT)));
	const [vh, v2, v3] = await Promise.all([fh, f2, f3].map((f) => viewUntil(f, (v) => Array.isArray(v.board))));
	check("each phone gets its own view: X, O and a spectator", vh?.you === 1 && v2?.you === 2 && v3?.you === 0, { host: vh?.you, p2: v2?.you, p3: v3?.you });
	check("…of the same board, seated by team", vh?.x === hostId && vh?.o === p2Id && JSON.stringify(v2?.board) === JSON.stringify(vh?.board));

	// Out of turn: the host's rules refuse, and the guest is told why.
	await readyToClick(p2);
	await f2.locator("#ttt button").nth(4).click();
	check("a move out of turn is refused on the host, and the guest is told", await p2.locator(".neon-toast", { hasText: "not your turn" }).first().waitFor({ timeout: TIMEOUT }).then(() => true, () => false));

	const play = async (page, frame, i, after) => {
		await readyToClick(page);
		await frame.locator("#ttt button").nth(i).click();
		return viewUntil(f3, (v) => v.board.filter(Boolean).length === after);
	};
	await play(host, fh, 0, 1);
	await play(p2, f2, 3, 2);
	await play(host, fh, 1, 3);
	await play(p2, f2, 4, 4);
	const last = await play(host, fh, 2, 5);
	check("guests' moves travel to the host and every view follows", JSON.stringify(last?.board) === JSON.stringify([1, 1, 1, 2, 2, 0, 0, 0, 0]) && last?.winner === 1, last);
	const hostName = await host.evaluate(() => window.__party.room.self().name);
	const titles = await Promise.all([host, p2, p3].map(cardText));
	check("the shell's end card names the winner on every phone", titles[0] === "YOU WIN" && titles[1] === `${hostName.toUpperCase()} WINS` && titles[2] === titles[1], titles);
	check("…and only the host may start another", (await host.locator(".managed-over button", { hasText: "PLAY AGAIN" }).count()) === 1 && (await p2.locator(".managed-over button", { hasText: "PLAY AGAIN" }).count()) === 0);
	const cards = await Promise.all([host, p2, p3].map(card));
	const order = (k) => k?.rows.map((r) => `${r.place}:${r.id}`).join() ?? "";
	check(
		"the ranking on every phone: winner first, places, the spectator left out",
		cards.every((k) => order(k) === `1:${hostId},2:${p2Id}`) && cards.every((k) => k.rows[0].name === hostName),
		cards.map(order),
	);
	check("…each phone's own row marked, none on the spectator's", cards[0].rows[0].you && !cards[0].rows[1].you && cards[1].rows[1].you && !cards[1].rows[0].you && cards[2].rows.every((r) => !r.you));
	check("…seat colours apart, and no scores when the game gives none", cards[0].rows[0].dot !== cards[0].rows[1].dot && cards.every((k) => k.rows.every((r) => r.score === "")), cards[0].rows);
	check("…a dialog, named by its title, DETAILS a button closed at first", cards.every((k) => k.role === "dialog" && k.labelled && k.toggle?.tag === "BUTTON" && k.toggle.expanded === "false" && k.toggle.controls && !k.open), cards.map((k) => [k.role, k.labelled, k.toggle, k.open]));
	check("…on the phone's screen, clear of the fixed chrome, nothing to scroll", cards.every((k) => fits(k) && !k.scrolls), cards.map((k) => [k.box, k.wide, k.under, k.scrolls]));
	for (const page of [host, p2, p3]) await page.locator(".managed-toggle").click();
	const [dh, d2, d3] = await Promise.all([host, p2, p3].map(card));
	check("DETAILS opens: the series, match 1, and how long it took", d2?.toggle.expanded === "true" && d2.open && row(d2, "series", "Match") === "1" && /^\d+:\d\d$/.test(row(d2, "series", "Time") ?? ""), d2?.sections);
	const wins = d2?.sections.series.filter(([, v]) => / won$/.test(v)) ?? [];
	check("…wins so far: the host 1 (only who has won is listed)", wins.map(([, v]) => v).join() === "1 won" && wins[0][0] === hostName, d2?.sections.series);
	// The three phones share one browser's storage, so only the host (first
	// to hear the result) is sure to read its own record.
	check("…your stats, counted: the host has played 1, won 1, streak 1", row(dh, "stats", "Played") === "1" && row(dh, "stats", "Won") === "1" && row(dh, "stats", "Streak") === "1 (best 1)", dh?.sections.stats);
	check("…and no game rows when the game gives none", !!d3?.sections.stats && !d3.sections.game, d3?.sections);
	check("…open, still on the screen with the buttons in reach", fits(d2) && (await p2.locator(".managed-over .neon-btn", { hasText: "SEE THE BOARD" }).isVisible()), [d2?.box, d2?.under]);
	await p2.locator(".managed-over button", { hasText: "SEE THE BOARD" }).click();
	check("SEE THE BOARD tucks the ranking and DETAILS away", (await p2.locator(".managed-rank").isVisible()) === false && (await p2.locator(".managed-toggle").isVisible()) === false);
	await p2.locator(".managed-over button", { hasText: "SHOW RESULT" }).click();
	await host.locator(".managed-over button", { hasText: "PLAY AGAIN" }).click();
	const fresh = await viewUntil(f2, (v) => v.board.every((m) => m === 0));
	check("PLAY AGAIN: a fresh board on every phone, and the card goes", !!fresh && (await p2.locator(".managed-over").count()) === 0 && (await host.locator(".managed-over").count()) === 0);

	// Mid-match the host's tab closes: p2 (the longest-present) is the heir.
	await play(host, fh, 0, 1);
	await play(p2, f2, 4, 2);
	await viewUntil(f2, (v) => v.board[4] === 2);
	await new Promise((r) => setTimeout(r, 500)); // the heir's copy follows each move
	const kept = p2.locator(".neon-toast", { hasText: "You are the host now" }).first().waitFor({ timeout: TIMEOUT }).then(() => true, () => false);
	await A.collect();
	await host.close();
	check("the host leaves mid-match: the heir takes the crown and the game goes on", await kept);
	const carried = await view(f2);
	check("…from its copy of the board, not a fresh one", JSON.stringify(carried?.board) === JSON.stringify([1, 0, 0, 0, 2, 0, 0, 0, 0]), carried);
	// It is X's turn, and X has gone: the shell's banner, then SKIP TURN.
	const skip = p2.locator(".turn-wait:not([hidden]) button", { hasText: "SKIP TURN" });
	const offered = await skip.waitFor({ timeout: TIMEOUT }).then(() => true, () => false);
	check("the departed player's turn shows the shell's turn-wait banner", offered);
	if (offered) await skip.click();
	// SKIP may be pressed as the crown arrives, before the takeover has run;
	// it waits for it, so the turn passes a moment later.
	await viewUntil(f2, (v) => v.turn === 2, 10_000);
	await play(p2, f2, 8, 3);
	const after = await viewUntil(f3, (v) => v.board[8] === 2, 10_000);
	check("…SKIP passes their turn, and the new host's move reaches the spectator", after?.board[8] === 2, after);
	await A.collect();
	await A.context.close();
	ttt.stop();

	// ---------------------------------------------------------------- 2
	console.log("\nmanaged: a ticking game, host + guest + bot");
	const tick = await devServer("scripts/fixtures", 5196, "tick-game");
	const B = await party(tick.base, 2);
	const [th, tg] = B.pages;
	const [thId, tgId] = await ids(B.pages);
	await th.locator("button", { hasText: "ADD BOT" }).first().click({ timeout: TIMEOUT });
	await th.locator(".party-member").nth(2).waitFor({ timeout: TIMEOUT });
	await th.evaluate(() => {
		const r = window.__party.room;
		for (const m of r.getMembers()) r.setTeam(m.id, "A");
	});
	await th.locator(".party-game", { hasText: "TICK CHECK" }).first().click({ timeout: TIMEOUT });
	const [gh, gg] = await Promise.all(B.pages.map((p) => gameFrame(p, TIMEOUT)));
	await gg.evaluate(() => window.arcade.input(2)); // the guest's input: 2 a tick
	await gh.evaluate(() => window.arcade.input(1)); // the host's: 1
	const mid = await viewUntil(gg, (v) => v.ticks >= 20);
	const botId = mid && Object.keys(mid.score).find((id) => id.startsWith("bot_"));
	check("ticks run on the host at the manifest's rate", mid?.dt === 0.05, mid?.dt);
	check("…with the guest's, the host's and the bot's inputs", mid?.last?.[tgId] === 2 && mid?.last?.[thId] === 1 && mid?.last?.[botId] === 3, mid?.last);
	const seen = await gg.evaluate(() => window.views.slice());
	const steps = seen.slice(1).map((t, i) => t - seen[i]).filter((d) => d > 0);
	const median = steps.sort((a, b) => a - b)[Math.floor(steps.length / 2)];
	check("views come at viewRate, not every tick (20 Hz ticks, 10 Hz views)", median === 2, { steps: steps.slice(0, 12) });
	const end = await th.locator(".managed-over h2").textContent({ timeout: 60_000 }).catch(() => null);
	check("the result ends it: the bot, at 3 a tick, wins", end === `${(await th.evaluate((id) => window.__party.room.getMember(id).name, botId)).toUpperCase()} WINS`, end);
	const t1 = await Promise.all([th, tg].map(card));
	const scored = (k) => k?.rows.map((r) => Number(r.score)) ?? [];
	check(
		"the ranking with scores on every phone, best first",
		t1.every((k) => k?.rows.length === 3 && k.rows[0].id === botId && k.rows.map((r) => r.place).join() === "1,2,3" && scored(k).every((n, i, a) => Number.isFinite(n) && n > 0 && (!i || a[i - 1] >= n))) && order(t1[0]) === order(t1[1]),
		t1.map((k) => k?.rows),
	);
	await th.locator(".managed-toggle").click();
	const t1d = await card(th);
	const own = t1d?.sections.game ?? [];
	check("the game's own details: a table, capped at 8 rows, junk dropped", own.length === 8 && own[0][0] === "Ticks" && Number(own[0][1]) > 0 && own[7].join() === "Row 8,8", own);
	await th.locator(".managed-over button", { hasText: "PLAY AGAIN" }).click();
	await th.locator(".managed-over").waitFor({ state: "detached", timeout: TIMEOUT }).catch(() => {});
	await th.locator(".managed-over h2").waitFor({ timeout: 60_000 }).catch(() => {});
	await tg.locator(".managed-over h2").waitFor({ timeout: TIMEOUT }).catch(() => {});
	const t2 = await Promise.all([th, tg].map(card));
	const botName = await th.evaluate((id) => window.__party.room.getMember(id).name, botId);
	check("after PLAY AGAIN, DETAILS stays open on this device", t2.every((k) => k?.toggle.expanded === "true" && k.open), t2.map((k) => k?.toggle));
	check(
		"…and the series counts on: match 2, the bot 2 won (and nobody else), on every phone",
		t2.every((k) => row(k, "series", "Match") === "2" && row(k, "series", botName) === "2 won" && k.sections.series.filter(([, v]) => / won$/.test(v)).length === 1),
		t2.map((k) => k?.sections.series),
	);
	check("…with the host's time for this match on every phone", t2.every((k) => row(k, "series", "Time") === row(t2[0], "series", "Time") && /^0:0[1-9]$/.test(row(k, "series", "Time") ?? "")), t2.map((k) => row(k, "series", "Time")));
	check("…and your stats: two played", row(t2[0], "stats", "Played") === "2" && row(t2[0], "stats", "Won") === "0", t2[0]?.sections.stats);
	await B.collect();
	await B.context.close();
	tick.stop();

	// ---------------------------------------------------------------- 3
	console.log("\nmanaged: Connect 4's and Neon Survival's end cards, eight players, every theme");
	const fx = await devServer("scripts/fixtures", 5197, "tick-game");
	const C = await party(fx.base, 1);
	const [solo] = C.pages;
	const soloId = (await ids(C.pages))[0];
	const addBots = async (n) => {
		for (let i = 0; i < n; i++) {
			const had = await solo.locator(".party-member").count();
			await solo.locator("button", { hasText: "ADD BOT" }).first().click({ timeout: TIMEOUT });
			await solo.locator(".party-member").nth(had).waitFor({ timeout: TIMEOUT });
		}
	};
	await addBots(1);
	await solo.evaluate((me) => {
		const r = window.__party.room;
		for (const m of r.getMembers()) r.setTeam(m.id, m.id === me ? "A" : "B");
		r.setGame("connect4");
	}, soloId);
	const c4 = await gameFrame(solo, TIMEOUT);
	// Our turn (the bot may open), then three in a row on the bottom: the
	// fourth wins along a known line.
	await c4.waitForFunction(() => window.arcade.view?.started && window.arcade.view.turn === window.arcade.view.you, null, { timeout: TIMEOUT });
	await c4.evaluate(() => {
		const me = s.turn;
		const them = 3 - me;
		s.board = Array.from({ length: 6 }, () => Array(7).fill(0));
		s.board[5] = [me, me, me, 0, 0, 0, 0];
		s.board[4] = [them, them, them, 0, 0, 0, 0];
		s.moves = 6;
		window.arcade.act({ col: 3 });
	});
	await solo.locator(".managed-over h2").waitFor({ timeout: TIMEOUT });
	await solo.locator(".managed-toggle").click();
	const k4 = await card(solo);
	check("Connect 4: YOU WIN, and its details: moves played, the winning line", k4?.title === "YOU WIN" && row(k4, "game", "Moves played") === "7" && row(k4, "game", "Winning line") === "a1 b1 c1 d1", k4?.sections.game);
	await solo.locator(".managed-toggle").click(); // closed again: remembered closed
	await solo.evaluate(() => window.__party.room.setGame(null));
	await solo.locator("button", { hasText: "ADD BOT" }).first().waitFor({ timeout: TIMEOUT });
	await addBots(6);
	await solo.evaluate(() => {
		const r = window.__party.room;
		for (const m of r.getMembers()) r.setTeam(m.id, "A");
		r.setGame("neon-survival-mp");
	});
	const ns = await gameFrame(solo, TIMEOUT);
	await ns.waitForFunction(() => window.arcade.view && Object.keys(window.arcade.view.s ?? {}).length === 8, null, { timeout: TIMEOUT });
	await new Promise((r) => setTimeout(r, 1200));
	// Everyone's ship down at once, ours with three gems, the bots' none:
	// the run ends.
	await ns.evaluate((me) => {
		for (const [id, p] of Object.entries(s.ships)) {
			p.score = id === me ? 3 : 0;
			p.alive = false;
		}
	}, soloId);
	await solo.locator(".managed-over h2").waitFor({ timeout: TIMEOUT });
	const k8 = await card(solo);
	check("eight players: eight ranked rows, ours first with 3, the rest share 2nd", k8?.rows.length === 8 && k8.rows[0].id === soloId && k8.rows[0].score === "3" && k8.rows[0].you && k8.rows.slice(1).every((r) => r.place === "2" && r.score === "0"), k8?.rows);
	check("…eight seat colours", new Set(k8?.rows.map((r) => r.dot)).size === 8, k8?.rows.map((r) => r.dot));
	check("…DETAILS closed as last left, and the card fits without scrolling", k8?.toggle.expanded === "false" && !k8.scrolls && fits(k8), [k8?.box, k8?.scrolls, k8?.under]);
	await solo.locator(".managed-toggle").click();
	const k8d = await card(solo);
	const nsRows = k8d?.sections.game ?? [];
	check(
		"Neon Survival's details: time survived, then each player's gems and time (8 rows)",
		nsRows.length === 8 && nsRows[0][0] === "Time survived" && /^\d+:\d\d$/.test(nsRows[0][1]) && /^3 gems · \d+:\d\d$/.test(nsRows[1][1]) && nsRows.slice(2).every(([, v]) => /^0 gems · /.test(v)),
		nsRows,
	);
	check("…open, the card stays on the screen and clear of the chrome", fits(k8d), [k8d?.box, k8d?.under]);
	for (const [theme, mode] of [["paper", "light"], ["paper", "dark"], ["neon", "dark"]]) {
		await solo.evaluate((t) => window.NeonArcade.theme.set(t), { theme, mode });
		await new Promise((r) => setTimeout(r, 150));
		const look = await solo.evaluate(() => {
			const box = document.querySelector(".managed-over > div");
			const cs = getComputedStyle(box);
			return { bg: cs.backgroundColor, ink: cs.color, you: getComputedStyle(document.querySelector(".managed-rank li.is-you")).borderTopColor };
		});
		check(`${theme} ${mode}: the card takes the theme's colours`, look.bg !== look.ink && look.bg !== "rgba(0, 0, 0, 0)" && look.you !== "rgba(0, 0, 0, 0)", look);
		if (process.env.SHOTS) await solo.screenshot({ path: join(process.env.SHOTS, `game-over-${theme}-${mode}.png`) });
	}
	if (process.env.SHOTS) {
		await solo.locator(".managed-toggle").click();
		await solo.screenshot({ path: join(process.env.SHOTS, "game-over-collapsed.png") });
	}
	await C.collect();
	await C.context.close();
	fx.stop();

	// ---------------------------------------------------------------- 4
	console.log("\nmanaged: PLAY AGAIN alone while the server's run is slow");
	// Signed in and alone, a rematch waits for the server's run (lib/account.js
	// startRun). The finished match must not tick meanwhile: it re-reported its
	// result into the new match and froze it (review, 2026-11-15).
	{
		const solo = await devServer("scripts/fixtures", 5197, "tick-game");
		const S = await party(solo.base, 1);
		const [sp] = S.pages;
		await sp.evaluate(() => {
			const r = window.__party.room;
			for (const m of r.getMembers()) r.setTeam(m.id, "A");
		});
		await sp.locator(".party-game", { hasText: "TICK CHECK" }).first().click({ timeout: TIMEOUT });
		const sf = await gameFrame(sp, TIMEOUT);
		await sf.evaluate(() => window.arcade.input(150)); // over 200 in two ticks
		const ended = await sp.locator(".managed-over button", { hasText: "PLAY AGAIN" }).waitFor({ timeout: TIMEOUT }).then(() => true, () => false);
		check("(a solo run ends)", ended);
		// The server's run answers in 0.8 s from now on.
		await sp.evaluate(() => {
			NeonArcade.account = NeonArcade.account ?? {};
			NeonArcade.account.startRun = () => new Promise((done) => setTimeout(() => done(null), 800));
		});
		await sf.evaluate(() => window.arcade.input(0)); // the new run: no score
		await sp.locator(".managed-over button", { hasText: "PLAY AGAIN" }).click();
		await new Promise((r) => setTimeout(r, 2000));
		const after = await viewUntil(sf, (v) => v.ticks > 3, 8000);
		const cardBack = await sp.locator(".managed-over").count();
		check("the old match does not come back over the new one", cardBack === 0, { cardBack });
		check("…and the new match runs", (after?.ticks ?? 0) > 3 && Object.values(after?.score ?? {}).every((n) => n < 200), after && { ticks: after.ticks, score: after.score });
		await S.collect();
		await S.context.close();
		solo.stop();
	}

	// ---------------------------------------------------------------- schema
	console.log("\nmanaged: every message against sdk/v2/protocol.json");
	const wrong = checkTrace(traced);
	check(`all ${traced.length} messages conform`, !wrong.length, wrong.slice(0, 5).join(" | "));
	const types = new Set(traced.map(([, m]) => m.t));
	const missing = LAYER2.filter((t) => !types.has(t));
	check("every Layer 2 message was exercised", !missing.length, `never seen: ${missing.join(", ")}`);
	check("…and they are all in the catalogue", LAYER2.every((t) => catalogue("toShell").includes(t) || catalogue("toFrame").includes(t)));
} catch (err) {
	check("the run completes", false, err.stack?.split("\n").slice(0, 3).join(" ") ?? String(err));
} finally {
	await browser.close();
	site.stop();
}
console.log(failures ? `\n${failures} managed check(s) failed` : "\nall managed checks passed");
process.exit(failures ? 1 : 0);
