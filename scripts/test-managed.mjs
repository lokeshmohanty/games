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
//   2b. A turn of two moves (scripts/fixtures/double-turn): two bots play it
//      to the end, each move after its pause, the second of a turn too; a
//      bot that answers null is asked once, not in a loop.
//   3. The end card on a phone (390x844): the ranking (places, seat colours,
//      names, scores, you marked) on every phone; DETAILS closed at first,
//      remembered once opened, and holding the series (match, time, wins
//      across PLAY AGAIN), your stats and the game's own `details` (capped
//      at 8 rows); Connect 4's and Neon Survival's details; eight players
//      fit without scrolling, clear of the fixed chrome, in every theme.
//   4. PLAY AGAIN alone while the server's run is slow.
//   5. The end card waits for the last move's replay (Neon Fission, whose
//      frame says `idle`): held while the winning chain plays, at once on a
//      tap, at most HOLD_MS when the frame goes quiet, at once under reduced
//      motion; the result is reported before the card shows.
//
// Every message across a frame is checked against sdk/v2/protocol.json, and
// every Layer 2 message type must have been seen.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { catalogue, checkTrace } from "./protocol-check.mjs";
import { PORT_OFFSET, gameFrame, phoneFloors, readyToClick, serve, spawnServer } from "./serve.mjs";
import { loadPlaywright } from "./playwright.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TIMEOUT = 40_000;
const LAYER2 = ["act", "input", "idle", "rules", "view", "rejected"];
// lib/sdk-managed.js HOLD_MS: the longest an end card waits for `idle`.
const HOLD_MS = 6000;

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
	// Its own bind, seen: section 4 reuses section 3's port right after it.
	const dev = await spawnServer("node", [join(ROOT, "sdk/dev-server.mjs"), join(ROOT, folder), String(port)], { env: { ...process.env, NEON_PLATFORM: site.base } }, /^serving /m);
	const base = `http://127.0.0.1:${port}/${game}/`;
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
		// What the page said, for a failure's details (CI has no other window).
		page.__log = [];
		page.on("console", (m) => {
			page.__log.push(`${((performance.now() / 1000) | 0)}s ${m.type()}: ${m.text().slice(0, 240)}`);
			if (page.__log.length > 60) page.__log.shift();
		});
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
	await pages[0]
		.locator(".party-member")
		.nth(n - 1)
		.waitFor({ timeout: TIMEOUT })
		.catch(async (err) => {
			for (const [i, page] of pages.entries()) {
				const state = await page
					.evaluate(() => {
						const r = window.__party?.room;
						return { status: document.querySelector(".lobby-status")?.textContent ?? null, room: r && { self: r.selfId, host: r.hostId(), links: r.directPeers(), pending: [...r.pending.keys()], refusals: r.refusals, members: r.getMembers().map((m) => m.id) } };
					})
					.catch((e) => String(e));
				console.log(`    [phone ${i + 1}] ${JSON.stringify(state)}`);
				for (const line of page.__log.slice(-25)) console.log(`    [phone ${i + 1}] ${line}`);
			}
			throw err;
		});
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

	// Out of turn: the host's rules refuse, and the guest is told why. A toast
	// lives 4.5 s and a newer one can push it out, so the guest's phone records
	// every toast from before the move; the refusal itself is read from the
	// shell's own record of what it sent the frame (the trace), not the DOM.
	const traceFrom = await p2.evaluate(() => {
		window.__toasts = [];
		new MutationObserver((ms) => {
			for (const m of ms) for (const n of m.addedNodes) if (n.classList?.contains("neon-toast")) window.__toasts.push(n.textContent);
		}).observe(document.body, { childList: true, subtree: true });
		return window.__sdk.length;
	});
	const refusal = () =>
		p2.evaluate((from) => {
			const msgs = window.__sdk.slice(from);
			return {
				acted: msgs.some(([dir, m]) => dir === "toShell" && m.t === "act"),
				rejected: msgs.filter(([dir, m]) => dir === "toFrame" && m.t === "rejected").map(([, m]) => m.reason),
				toasts: window.__toasts.slice(),
			};
		}, traceFrom);
	const told = (r) => r.rejected.includes("not your turn") && r.toasts.some((t) => t.includes("not your turn"));
	// The click must reach the game: the frame's `act` in the trace. On CI run
	// 44134264485 no `rejected` reached any frame in 40 s, so the move was
	// never refused at all, likely because this, the guest's first click into
	// its frame, went to the <iframe> element (serve.mjs readyToClick). A click
	// the frame did not hear is clicked again: the refusal is what is checked,
	// not the tap.
	const deadline = Date.now() + TIMEOUT;
	let clicks = 0;
	let clickedAt = 0;
	let refused = null;
	do {
		if (!refused?.acted && Date.now() - clickedAt > 5000) {
			await readyToClick(p2);
			await f2.locator("#ttt button").nth(4).click();
			clicks++;
			clickedAt = Date.now();
		}
		await new Promise((r) => setTimeout(r, 150));
		refused = await refusal();
	} while (!told(refused) && Date.now() < deadline);
	check("a move out of turn is refused on the host, and the guest is told", told(refused), { ...refused, clicks, view: await view(f2).catch(() => null) });
	if (clicks > 1) console.log(`  note: the out-of-turn click was clicked ${clicks} times before the frame heard it`);

	const play = async (page, frame, i, after) => {
		await readyToClick(page);
		await frame.locator("#ttt button").nth(i).click();
		return viewUntil(f3, (v) => v.board.filter(Boolean).length === after);
	};
	/** The squares ringed as the last move on `frame`'s board (tic-tac-toe.js). */
	const ringed = (frame) => frame.evaluate(() => [...document.querySelectorAll("#ttt button")].flatMap((b, i) => (b.classList.contains("last") ? [i] : [])));
	/** Every phone's ringed squares, once each shows exactly `want` (or after a wait). */
	const ringsOn = async (frames, want) => {
		const out = [];
		for (const f of frames) {
			await f.waitForFunction((w) => JSON.stringify([...document.querySelectorAll("#ttt button")].flatMap((b, i) => (b.classList.contains("last") ? [i] : []))) === JSON.stringify(w), want, { timeout: 5000 }).catch(() => {});
			out.push(await ringed(f));
		}
		return out;
	};
	const ringsAre = (seen, want) => seen.every((r) => JSON.stringify(r) === JSON.stringify(want));
	await play(host, fh, 0, 1);
	let rings = await ringsOn([fh, f2, f3], [0]);
	check("the first mark is ringed as the last move on every phone, the spectator's too", ringsAre(rings, [0]), rings);
	await play(p2, f2, 3, 2);
	rings = await ringsOn([fh, f2, f3], [3]);
	check("…the next mark takes the ring: only ever one", ringsAre(rings, [3]), rings);
	await play(host, fh, 1, 3);
	await play(p2, f2, 4, 4);
	const last = await play(host, fh, 2, 5);
	rings = await ringsOn([fh, f2, f3], [2]);
	check("…and the winning mark is the one ringed at the end", ringsAre(rings, [2]), rings);
	// The page's own rule (tic-tac-toe.js lastMark), for what a live game
	// rarely shows: views missed. Two new marks, even after a skip, ring
	// neither; one new mark is the last; the same board keeps its ring; a
	// board that lost marks is a new match.
	const rule = await f3.evaluate(() => ({
		missedAfterSkip: lastMark([1, 0, 0, 0, 2, 0, 0, 0, 0], 4, [1, 0, 2, 0, 2, 0, 0, 0, 1]),
		missedTwo: lastMark([1, 0, 0, 0, 0, 0, 0, 0, 0], 0, [1, 2, 1, 0, 0, 0, 0, 0, 0]),
		one: lastMark([1, 0, 0, 0, 0, 0, 0, 0, 0], 0, [1, 0, 0, 0, 2, 0, 0, 0, 0]),
		same: lastMark([1, 0, 0, 0, 2, 0, 0, 0, 0], 4, [1, 0, 0, 0, 2, 0, 0, 0, 0]),
		firstSight: lastMark(null, -1, [1, 0, 0, 0, 2, 0, 0, 0, 0]),
		rematch: lastMark([1, 1, 1, 2, 2, 0, 0, 0, 0], 2, [0, 0, 0, 0, 0, 0, 0, 0, 0]),
		rematchOne: lastMark([1, 1, 1, 2, 2, 0, 0, 0, 0], 2, [0, 0, 0, 0, 0, 0, 0, 0, 1]),
	}));
	check("the ring rule: several new marks (views missed, a skip among them) ring none; one new mark is the last; the same board keeps it; a new match starts clear",
		rule.missedAfterSkip === -1 && rule.missedTwo === -1 && rule.one === 4 && rule.same === 4 && rule.firstSight === -1 && rule.rematch === -1 && rule.rematchOne === 8, rule);
	// Tic Tac Toe never says `idle`: nothing holds its card back.
	const tttCard = await host.locator(".managed-over").waitFor({ timeout: 1000 }).then(() => true, () => false);
	check("a game that never says idle gets its end card at once", tttCard);
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
	await Promise.all([fh, f3].map((f) => viewUntil(f, (v) => v.board.every((m) => m === 0))));
	rings = await ringsOn([fh, f2, f3], []);
	check("…with no ring left over from the last game", ringsAre(rings, []), rings);

	// Mid-match the host's tab closes: p2 (the longest-present) is the heir.
	// The heir's copy follows each move, a rules call after the views, so p2
	// notes each copy it is sent (lib/sdk-managed.js snapCh, on "v:m$snap").
	await p2.evaluate(() => {
		const snap = window.__party.room.makeAction("v:m$snap");
		const on = snap.onMessage;
		snap.onMessage = (d, meta) => ((window.__heirCopy = d), on?.(d, meta));
	});
	await play(host, fh, 0, 1);
	await play(p2, f2, 4, 2);
	await viewUntil(f2, (v) => v.board[4] === 2);
	const copied = await p2.waitForFunction(() => window.__heirCopy?.s?.board?.[4] === 2, null, { timeout: TIMEOUT }).then(() => true, () => false);
	check("mid-match, the heir holds a copy of the board with the last move", copied, await p2.evaluate(() => window.__heirCopy ?? null));
	const kept = p2.locator(".neon-toast", { hasText: "You are the host now" }).first().waitFor({ timeout: TIMEOUT }).then(() => true, () => false);
	await A.collect();
	await host.close();
	check("the host leaves mid-match: the heir takes the crown and the game goes on", await kept);
	const carried = await view(f2);
	check("…from its copy of the board, not a fresh one", JSON.stringify(carried?.board) === JSON.stringify([1, 0, 0, 0, 2, 0, 0, 0, 0]), carried);
	rings = await ringsOn([f2, f3], [4]);
	check("…the last mark before the host left still ringed, on the new host's phone and the spectator's", ringsAre(rings, [4]), rings);
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
	rings = await ringsOn([f2, f3], [8]);
	check("…and takes the ring there too", ringsAre(rings, [8]), rings);
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

	// ---------------------------------------------------------------- 2b
	console.log("\nmanaged: a bot that keeps the turn after its own move (scripts/fixtures/double-turn)");
	// Every turn is two moves (Ludo's extra roll on a 6). Before 2026-11-23 a
	// bot's pending move was cleared only after the refresh its own move set
	// off had already tried to schedule the next one, so a bot on turn twice
	// running was never asked again and the game stalled.
	{
		const fx2 = await devServer("scripts/fixtures", 5200, "double-turn");
		const T = await party(fx2.base, 1);
		const [tp] = T.pages;
		for (const n of [1, 2]) {
			await tp.locator("button", { hasText: "ADD BOT" }).first().click({ timeout: TIMEOUT });
			await tp.locator(".party-member").nth(n).waitFor({ timeout: TIMEOUT });
		}
		// Only the bots play; this phone (the host) watches.
		await tp.evaluate(() => {
			const r = window.__party.room;
			for (const m of r.getMembers()) r.setTeam(m.id, NeonArcade.isBotId(m.id) ? "A" : "spectator");
		});
		await tp.locator(".party-game", { hasText: "DOUBLE TURN CHECK" }).first().click({ timeout: TIMEOUT });
		const tf = await gameFrame(tp, TIMEOUT);
		const ended = await tp.locator(".managed-over h2").textContent({ timeout: 30_000 }).catch(() => null);
		const live = await tf.evaluate(() => window.rules()).catch(() => null);
		const [b1, b2] = live?.order ?? [];
		const by = (live?.moves ?? []).map((m) => m.by).join(",");
		check("two bots, two moves a turn each, play to the end", !!ended && by === [b1, b1, b2, b2, b1, b1].join(","), { ended, moves: live?.moves?.map((m) => m.by), score: live?.score });
		const gaps = (live?.moves ?? []).slice(1).map((m, i) => m.at - live.moves[i].at);
		// lib/sdk-managed.js BOT_MS: 600–1100 ms, before the second of a turn's moves too.
		check("…each move after a human-feeling pause, the second of a turn's too", gaps.length === 5 && gaps.every((g) => g >= 550), gaps);
		check("…and each bot asked once a move", live?.asked?.[b1] === 4 && live?.asked?.[b2] === 2, live?.asked);
		await T.collect();
		await T.context.close();

		// A game that keeps naming a bot that has no move (bot() → null) is
		// not asked in a loop: a null ends the bot's run of moves.
		const N = await party(fx2.base, 1);
		const [np] = N.pages;
		await np.locator("button", { hasText: "ADD BOT" }).first().click({ timeout: TIMEOUT });
		await np.locator(".party-member").nth(1).waitFor({ timeout: TIMEOUT });
		await np.evaluate(() => {
			const r = window.__party.room;
			for (const m of r.getMembers()) r.setTeam(m.id, "A");
		});
		await np.locator(".party-game", { hasText: "DOUBLE TURN CHECK" }).first().click({ timeout: TIMEOUT });
		const nf = await gameFrame(np, TIMEOUT);
		const me = await np.evaluate(() => window.__party.room.selfId);
		// The person's turn (first, or after the bot's two moves), then `stall`.
		const mine = await viewUntil(nf, (v) => v.at === me);
		await nf.evaluate(() => window.arcade.act({ t: "stall" }));
		await viewUntil(nf, (v) => v.at !== me, 5000);
		await np.waitForTimeout(4000);
		const stalled = await nf.evaluate(() => window.rules()).catch(() => null);
		const bot = stalled?.order.find((id) => id !== me);
		const moved = (stalled?.moves ?? []).filter((m) => m.by === bot).length;
		check("a bot that answers null is asked once, not in a loop", !!mine && stalled?.stalled === true && stalled.asked[bot] - moved === 1, { asked: stalled?.asked, moved });
		await N.collect();
		await N.context.close();
		fx2.stop();
	}

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
	// The phone's floors on the end card and the band over it (Lokesh's
	// phone, 2026-11-15: DETAILS was 32px, "you" and the captions 11.5px),
	// at 390x844 and his 354x696, DETAILS open (every line on show).
	for (const [w, h] of [
		[390, 844],
		[354, 696],
	]) {
		await solo.setViewportSize({ width: w, height: h });
		const floors = await phoneFloors(solo, ".managed-over, .top-band");
		check(`${w}x${h}: on the end card every button is 44px and every line 12px (DETAILS, PLAY AGAIN, "you", the captions)`, floors.measured.taps >= 3 && floors.measured.text >= 20 && !floors.taps.length && !floors.text.length, floors);
	}
	await solo.setViewportSize({ width: 390, height: 844 });
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

	// ---------------------------------------------------------------- 4b
	console.log("\nmanaged: a PERSON seat is told only to a game that takes it");
	// The roster's PERSON (lib/party.js, for "sameDevice" games) marks a bot
	// `local`; lib/sdk-managed.js passes that on only to a game whose
	// manifest says "sameDevice". The fixture does not.
	{
		const fx4 = await devServer("scripts/fixtures", 5199, "tick-game");
		const P = await party(fx4.base, 1);
		const [pp] = P.pages;
		await pp.locator("button", { hasText: "ADD BOT" }).first().click({ timeout: TIMEOUT });
		await pp.locator(".party-member").nth(1).waitFor({ timeout: TIMEOUT });
		await pp.locator(".party-member").nth(1).locator(".party-person").click({ timeout: TIMEOUT });
		await pp.waitForFunction(() => window.__party.room.getMembers()[1].local === true, null, { timeout: TIMEOUT });
		await pp.evaluate(() => {
			const r = window.__party.room;
			for (const m of r.getMembers()) r.setTeam(m.id, "A");
		});
		await pp.locator(".party-game", { hasText: "TICK CHECK" }).first().click({ timeout: TIMEOUT });
		const pf = await gameFrame(pp, TIMEOUT);
		const v = await viewUntil(pf, (v) => v.ticks >= 1);
		check("the bot is marked local in the party, but the game without sameDevice is not told", Array.isArray(v?.local) && v.local.length === 0 && Object.keys(v.score).length === 2, v && { local: v.local, seats: Object.keys(v.score) });
		await P.collect();
		await P.context.close();
		fx4.stop();
	}

	// ---------------------------------------------------------------- 5
	console.log("\nmanaged: the end card waits for the last move's replay (Neon Fission)");
	// Lokesh, 2026-11-15: a winning chain flipped half his cells in one turn,
	// and the end card covered it at once. A frame that says `idle` keeps the
	// card back until it has shown the move that ended the match; the result
	// is still reported at once. The board is set from a known game
	// (rules.js, two seats): its last move, ours, bursts in 9 waves and takes
	// the bot's last 8 cells.
	{
		const GAME = [53, 28, 48, 44, 0, 15, 5, 31, 11, 22, 24, 52, 23, 50, 23, 33, 23, 1, 18, 42, 30, 37, 3, 31, 6, 25, 0, 44, 0, 45, 29, 46, 29, 37, 41, 51, 12, 33, 30, 10, 30, 44, 31, 27, 48, 39, 48, 46, 36, 20, 24, 51, 22, 20, 22, 29, 23, 24, 18, 23, 17, 27, 23, 43, 27, 15, 22, 4, 21, 45, 5, 44, 24];
		const fx5 = await devServer("scripts/fixtures", 5198, "tick-game");
		const E = await party(fx5.base, 1);
		const [nf] = E.pages;
		const nfId = (await ids(E.pages))[0];
		await nf.locator("button", { hasText: "ADD BOT" }).first().click({ timeout: TIMEOUT });
		await nf.locator(".party-member").nth(1).waitFor({ timeout: TIMEOUT });
		await nf.evaluate((me) => {
			const r = window.__party.room;
			for (const m of r.getMembers()) r.setTeam(m.id, m.id === me ? "A" : "B");
			r.setGame("neon-fission");
		}, nfId);
		const F = await gameFrame(nf, TIMEOUT);
		const dbg = () => F.evaluate(() => window.__game.handle.debug());
		/**
		 * Match `m`: play the game up to its last move on the
		 * host's rules, then make the last move. Its board is set as Connect
		 * 4's is above (the frame's own state).
		 */
		const lastMove = async (m) => {
			// No table to set first (the platform's quick table sets it, 2026-11-17): match m opens on our move.
			await F.waitForFunction((m) => window.arcade.view?.match === m && window.arcade.view.turn === window.arcade.view.you, m, { timeout: TIMEOUT });
			await F.evaluate((game) => {
				for (const c of game.slice(0, -1)) R.play(s.g, c);
				window.arcade.act({ cell: game.at(-1), n: s.g.moves });
			}, GAME);
			return Date.now();
		};
		/** What the phone shows, every ~60 ms until `ms` after `t0`: the card (shell) first, then the frame. */
		const watch = async (t0, ms, stopWhenCard = true) => {
			const out = [];
			while (Date.now() - t0 < ms) {
				const page = await nf.evaluate(() => ({ card: !!document.querySelector(".managed-over"), played: JSON.parse(localStorage.getItem("neon.stats") ?? "{}")["neon-fission"]?.played ?? 0 }));
				const v = await F.evaluate(() => ({ ...window.__game.handle.debug(), line: document.getElementById("turn").textContent }));
				out.push({ at: Date.now() - t0, ...page, animating: v.animating, over: v.winner !== null, replayMs: v.replayMs, line: v.line });
				if (stopWhenCard && page.card) break;
				await new Promise((r) => setTimeout(r, 60));
			}
			return out;
		};
		const playedBefore = await nf.evaluate(() => JSON.parse(localStorage.getItem("neon.stats") ?? "{}")["neon-fission"]?.played ?? 0);

		// Match 1: the winning chain plays out, then the card.
		let t0 = await lastMove(1);
		let seen = await watch(t0, 12_000);
		const replay = seen.filter((x) => x.over && x.animating);
		const endAt = seen.find((x, i) => i > 0 && seen[i - 1].animating && !x.animating)?.at;
		const cardAt = seen.find((x) => x.card)?.at;
		const longest = Math.max(0, ...replay.map((x) => x.replayMs));
		check("the winning chain is replayed, longer than an ordinary move's 1.5 s", replay.length > 3 && longest > 1500, { samples: replay.length, longest });
		check("…and the end card stays back while it plays", !seen.some((x) => x.card && x.animating), seen.filter((x) => x.card).slice(0, 2));
		const lineAfter = await F.evaluate(() => document.getElementById("turn").textContent);
		check("…nor does the turn line announce the winner over it, until it ends", replay.length > 0 && !replay.some((x) => /win/i.test(x.line)) && /You win/.test(lineAfter), { during: [...new Set(replay.map((x) => x.line))], after: lineAfter });
		check("…then shows as it ends", endAt !== undefined && cardAt !== undefined && cardAt - endAt <= 500, { endAt, cardAt });
		check("the result is reported at once: in this device's stats while the card is held", seen.some((x) => x.animating && !x.card && x.played > playedBefore), seen.slice(0, 3));
		const fin = await F.evaluate(() => {
			const v = window.__game.handle.debug();
			return { drawn: JSON.stringify(v.painted) === JSON.stringify(v.owner), bot: v.players[1].cells, me: v.players[0].cells, winner: v.winner, shown: getComputedStyle(document.getElementById("board")).visibility };
		});
		check("the final board is drawn behind the card: every cell ours, the bot's gone", fin.drawn && fin.winner === 0 && fin.bot === 0 && fin.me === 42 && fin.shown === "visible", fin);
		await nf.locator(".managed-over button", { hasText: "SEE THE BOARD" }).click();
		const peek = await nf.evaluate(() => {
			const c = document.querySelector(".managed-over");
			return { peek: c?.classList.contains("is-peek"), box: c?.firstElementChild.getBoundingClientRect().height ?? -1, hidden: getComputedStyle(c.firstElementChild).visibility === "hidden" || getComputedStyle(c.firstElementChild).display === "none" || getComputedStyle(c).display === "none" };
		});
		const still = await F.evaluate(() => {
			const v = window.__game.handle.debug();
			return JSON.stringify(v.painted) === JSON.stringify(v.owner) && !v.animating;
		});
		check("SEE THE BOARD tucks the card away over the final position", peek.peek && still, { ...peek, still });
		await nf.locator(".managed-over button", { hasText: "SHOW RESULT" }).click();

		// Match 2: a tap during the replay skips it, and the card comes with it.
		await nf.locator(".managed-over button", { hasText: "PLAY AGAIN" }).click();
		t0 = await lastMove(2);
		await F.waitForFunction(() => window.__game.handle.debug().animating && window.__game.handle.debug().winner !== null, null, { timeout: 5000 }).catch(() => {});
		await new Promise((r) => setTimeout(r, 400));
		const beforeTap = await nf.locator(".managed-over").count();
		await readyToClick(nf);
		const box = await F.locator("#board").boundingBox();
		const tapAt = Date.now();
		await nf.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
		const tapped = await nf.locator(".managed-over").waitFor({ timeout: 2000 }).then(() => Date.now() - tapAt, () => null);
		const afterTap = await dbg();
		check("a tap during the replay brings the card straight away", beforeTap === 0 && tapped !== null && tapped < 600 && !afterTap.animating && afterTap.moves === GAME.length, { beforeTap, tapped, animating: afterTap.animating, moves: afterTap.moves });

		// Match 3: a frame that goes quiet (here: says `idle` no more) still
		// gets its card, after HOLD_MS at most.
		await nf.locator(".managed-over button", { hasText: "PLAY AGAIN" }).click();
		await F.waitForFunction(() => window.arcade.view?.match === 3, null, { timeout: TIMEOUT });
		await F.evaluate(() => {
			window.__idle = window.arcade.idle;
			window.arcade.idle = () => {};
		});
		t0 = await lastMove(3);
		seen = await watch(t0, HOLD_MS + 3000);
		const quietEnd = seen.find((x, i) => i > 0 && seen[i - 1].animating && !x.animating)?.at;
		const quietCard = seen.find((x) => x.card)?.at;
		check(`a frame that never says idle still gets its card within ${HOLD_MS / 1000} s`, quietCard !== undefined && quietCard >= HOLD_MS - 300 && quietCard <= HOLD_MS + 1500, { quietEnd, quietCard });
		check("…held past its replay's end, so it waited on the frame, not the replay", quietEnd !== undefined && quietCard - quietEnd > 1000, { quietEnd, quietCard });
		await F.evaluate(() => {
			window.arcade.idle = window.__idle;
		});

		// Match 4: reduced motion: no replay, and the card at once.
		await nf.emulateMedia({ reducedMotion: "reduce" });
		const reducedOn = await F.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
		await nf.locator(".managed-over button", { hasText: "PLAY AGAIN" }).click();
		t0 = await lastMove(4);
		seen = await watch(t0, 3000);
		const rmCard = seen.find((x) => x.card)?.at;
		check("reduced motion: no replay, and the card at once", reducedOn && !seen.some((x) => x.animating) && rmCard !== undefined && rmCard < 800, { reducedOn, rmCard, animated: seen.some((x) => x.animating) });
		await nf.emulateMedia({ reducedMotion: null });
		await E.collect();
		await E.context.close();
		fx5.stop();
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
