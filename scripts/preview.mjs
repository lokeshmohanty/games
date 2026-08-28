#!/usr/bin/env node
/**
 * preview.mjs — drive a game in a real browser and record it, so the portal's
 * preview gifs can be regenerated without a human playing each game by hand.
 *
 *   node scripts/preview.mjs connect4
 *   node scripts/preview.mjs draw-guess --seconds 14
 *
 * Prints `key=value` lines for scripts/make-preview.sh to consume:
 *   video=<path to .webm>   start=<seconds of lobby to trim>   duration=<seconds>
 *
 * The P2P games need two peers, so this opens two pages in one browser and
 * performs the invite/answer handshake between them (see connectPeers). Only
 * the first page records; it is the one that appears in the gif, and it is also
 * the host, since only the host can start the game.
 *
 * NixOS note: Playwright's bundled chromium cannot run here (exit 127 — the
 * downloaded binaries are not patched for the nix dynamic linker). We always
 * drive the nix-provided Chrome via executablePath.
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync, globSync, mkdtempSync, readdirSync, renameSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const PW_CACHE = join(homedir(), ".cache", "game-previews");

/** Where the browser lives. Bundled browsers do not run on NixOS. */
function chromePath() {
	const candidates = [
		process.env.CHROME,
		"/run/current-system/sw/bin/google-chrome-stable",
		"/run/current-system/sw/bin/chromium",
		join(homedir(), ".nix-profile", "bin", "google-chrome-stable"),
	].filter(Boolean);
	const found = candidates.find((p) => existsSync(p));
	if (!found) {
		console.error("error: no system Chrome found; set CHROME=/path/to/chrome");
		process.exit(1);
	}
	return found;
}

/**
 * Playwright is a dev-only dependency of this otherwise build-free repo, so it
 * is never vendored into it: we reuse whatever copy exists, and only install
 * into ~/.cache as a last resort.
 */
function loadPlaywright() {
	const candidates = [
		join(ROOT, "node_modules", "playwright"),
		join(PW_CACHE, "node_modules", "playwright"),
		...globSync(join(homedir(), ".npm", "_npx", "*", "node_modules", "playwright")),
	];
	let found = candidates.find((p) => existsSync(p));
	if (!found) {
		console.error("installing playwright into " + PW_CACHE + " (one time)…");
		execFileSync("npm", ["install", "--prefix", PW_CACHE, "--no-save", "--no-audit", "playwright"], {
			stdio: "inherit",
		});
		found = join(PW_CACHE, "node_modules", "playwright");
	}
	return require(found);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ helpers

/**
 * Walk the manual handshake the lobby asks players to perform: the first page
 * hosts and mints an invite link, each other page opens that link and produces
 * an answer code, and the host pastes it back. There is no signaling server to
 * wait on, so this is deterministic rather than a poll-until-discovered loop.
 */
async function connectPeers(pages, timeoutMs = 30_000) {
	const [host, ...guests] = pages;
	for (const [i, guest] of guests.entries()) {
		// The first invite comes from INVITE A FRIEND on the host-choice screen;
		// later ones from INVITE ANOTHER once the host flow is already open.
		const opener = host.locator("button", {
			hasText: i === 0 ? "INVITE A FRIEND" : "INVITE ANOTHER",
		});
		await opener.first().click();

		const inviteBox = host.locator("textarea.share-code").first();
		await inviteBox.waitFor({ timeout: timeoutMs });
		const link = await inviteBox.inputValue();

		// The guest is already sitting on this file, so navigating straight to the
		// invite would be a fragment-only change and would not re-run the page.
		await guest.goto("about:blank");
		await guest.goto(link);
		const answerBox = guest.locator("textarea.share-code").first();
		await answerBox.waitFor({ timeout: timeoutMs });
		const answer = await answerBox.inputValue();

		await host.locator("textarea.share-code").last().fill(answer);
		await host.locator("button", { hasText: "CONNECT" }).first().click();
		await host
			.locator(".peer", { hasText: "other player" })
			.waitFor({ timeout: timeoutMs });
	}
}

/** Only the host can start, and it is always the first page. */
async function startGame(pages) {
	await pages[0].locator("button", { hasText: "START GAME" }).first().click();
}

/** Click column `col` of a 7-wide board, in canvas-relative coordinates. */
async function dropPiece(page, col, cols = 7) {
	const box = await page.locator("#board").boundingBox();
	if (!box) return;
	await page.mouse.click(box.x + ((col + 0.5) * box.width) / cols, box.y + box.height / 2);
}

/**
 * Play Neon Survival properly: read the live game state and steer toward the
 * safest column, with a mild pull toward gems. A blind sine sweep walks into
 * hazards and the clip ends up showing "You're down! Spectating…", which is a
 * poor portal card. Both games declare `player`/`enemies`/`gems` as top-level
 * bindings in a classic script, so page.evaluate can read them directly.
 */
async function dodgeLoop(page, seconds, canvasSel = "#gameCanvas") {
	const box = await page.locator(canvasSel).boundingBox();
	if (!box) return;
	const end = Date.now() + seconds * 1000;
	// `gameActive` is also false *before* the game starts, so only treat it as
	// death once we have seen it true — otherwise the loop exits immediately.
	let started = false;
	while (Date.now() < end) {
		const aim = await page
			.evaluate((sel) => {
				const c = document.querySelector(sel);
				if (!c || typeof player === "undefined") return null;
				const live =
					(typeof gameActive === "undefined" || gameActive === true) && player.alive !== false;
				if (!live) return "idle";
				const W = c.width;
				const threats = (typeof enemies !== "undefined" ? enemies : []).filter(
					(e) => e.y < player.y && player.y - e.y < c.height * 0.7,
				);
				const prizes = typeof gems !== "undefined" ? gems : [];
				let best = null;
				for (let i = 0; i <= 24; i++) {
					const x = (i / 24) * W;
					let score = 0;
					for (const e of threats) score += Math.min(Math.abs(e.x - x), 180);
					for (const g of prizes) score += Math.max(0, 140 - Math.abs(g.x - x)) * 1.2;
					score -= Math.abs(x - player.x) * 0.2; // avoid twitchy teleporting
					if (!best || score > best.score) best = { x, score };
				}
				return best ? best.x / W : null;
			}, canvasSel)
			.catch(() => null);
		// Stop the moment we die: a preview card should show play, not a GAME OVER
		// screen, and the recording ends right after this returns. Before the game
		// has started, "idle" just means we are still waiting for it.
		if (aim === "idle") {
			if (started) return;
			await sleep(60);
			continue;
		}
		if (aim != null) {
			started = true;
			await page.mouse.move(box.x + aim * box.width, box.y + box.height * 0.85);
		}
		await sleep(60);
	}
}

/** Sweep the pointer along a sine path — both Neon Survival games follow the mouse. */
async function sweepMouse(page, seconds, phase = 0) {
	const box = await page.locator("canvas").first().boundingBox();
	if (!box) return;
	const steps = seconds * 20;
	for (let i = 0; i < steps; i++) {
		const t = i / 20;
		const x = box.x + box.width * (0.5 + 0.42 * Math.sin(t * 1.6 + phase));
		await page.mouse.move(x, box.y + box.height * 0.8);
		await sleep(50);
	}
}

// ---------------------------------------------------------------- scenarios

const GAMES = {
	"oh-hell": {
		file: "oh-hell.html",
		peers: 2,
		seconds: 16,
		async beforeStart([host]) {
			// Four hands makes the trick worth looking at.
			for (let i = 0; i < 2; i++) {
				await host.locator("button", { hasText: "ADD BOT" }).first().click().catch(() => {});
				await sleep(150);
			}
		},
		async play([a, b], seconds) {
			// Bid, then play any legal card. The interesting picture is the trick
			// filling up and the hand emptying, which needs no cleverness.
			const act = (page) =>
				page.evaluate(() => {
					const bid = document.querySelector(".oh-bids button:not(:disabled)");
					if (bid) return void bid.click();
					const card = document.querySelector(".oh-hand .oh-card.playable");
					if (card) card.click();
				}).catch(() => {});

			// The first round deals one card each and is over in seconds; wait for
			// a later one, where a hand and a trick are both worth seeing.
			const deadline = Date.now() + seconds * 1000;
			while (Date.now() < deadline) {
				await act(a);
				await act(b);
				await sleep(260);
				const done = await a.evaluate(() => !!window.__game.handle.debug().over).catch(() => false);
				if (done) break;
			}
			await sleep(1200);
		},
	},

	"liars-dice": {
		file: "liars-dice.html",
		peers: 2,
		seconds: 16,
		async beforeStart([host]) {
			// Four at the table: bluffing reads as bluffing with a crowd, and with
			// two players every call is a coin flip between the same two people.
			for (let i = 0; i < 2; i++) {
				await host.locator("button", { hasText: "ADD BOT" }).first().click().catch(() => {});
				await sleep(150);
			}
		},
		async play([a, b], seconds) {
			// Both people raise while the raise is believable and call once it is
			// not — the game's own bot logic, driven through the buttons a person
			// would press.
			const act = (page) =>
				page.evaluate(() => {
					const btns = [...document.querySelectorAll(".ld-actions button")];
					if (!btns.length) return;
					const d = window.__game.handle.debug();
					const R = window.NeonArcade.liarsDiceRules;
					const liar = btns.find((x) => x.textContent.includes("LIAR"));
					const bid = btns.find((x) => x.textContent.startsWith("BID"));
					const expected = d.totalDice * (2 / 6);
					if (liar && d.bid && d.bid.count > expected + 1) return void liar.click();
					if (bid && !bid.disabled) return void bid.click();
					if (liar) liar.click();
				}).catch(() => {});

			const deadline = Date.now() + seconds * 1000;
			while (Date.now() < deadline) {
				await act(a);
				await act(b);
				await sleep(420);
				const done = await a.evaluate(() => !!window.__game.handle.debug().over).catch(() => false);
				if (done) break;
			}
			await sleep(1400);
		},
	},

	battleship: {
		file: "battleship.html",
		peers: 2,
		seconds: 14,
		async play([a, b], seconds) {
			// Commit both fleets, then fire. Targets come from the game's own
			// hunt-and-target so the clip shows ships being found and sunk rather
			// than a grid slowly filling with misses.
			for (const page of [a, b]) {
				await page.locator("button", { hasText: "COMMIT FLEET" }).click().catch(() => {});
				await sleep(200);
			}
			await a.waitForFunction(() => window.__game.handle.debug().phase === "fire", null, { timeout: 20_000 }).catch(() => {});

			const deadline = Date.now() + seconds * 1000;
			while (Date.now() < deadline) {
				for (const page of [a, b]) {
					await page.evaluate(() => {
						const g = window.__game.handle.debug();
						if (g.phase !== "fire" || g.over) return;
						const at = window.NeonArcade.battleshipRules.botTarget(g.theirBoard);
						if (!at) return;
						const cell = document.querySelector(`.bs-grid .bs-cell[data-r="${at[0]}"][data-c="${at[1]}"]`);
						if (cell && !cell.disabled) cell.click();
					}).catch(() => {});
				}
				await sleep(320);
				const over = await a.evaluate(() => !!window.__game.handle.debug().over).catch(() => false);
				if (over) break;
			}
			await sleep(1600);
		},
	},

	"light-cycles": {
		file: "light-cycles.html",
		peers: 2,
		seconds: 12,
		async beforeStart([host]) {
			// Two riders drawing two lines does not show what the game is; four
			// fills the arena and shows the bots cutting each other off.
			for (let i = 0; i < 2; i++) {
				await host.locator("button", { hasText: "ADD BOT" }).first().click().catch(() => {});
				await sleep(150);
			}
		},
		async play([a, b], seconds) {
			// Steering is a tap on one half of the arena, which is exactly what a
			// player does — no special hook. The bots were seated in beforeStart.
			const turn = async (page, side) => {
				const box = await page.locator(".lc-arena").boundingBox();
				if (!box) return;
				await page.mouse.click(box.x + box.width * (side === "left" ? 0.25 : 0.75), box.y + box.height * 0.5);
			};
			const alive = (page) =>
				page.evaluate(() => {
					const d = window.__game.handle.debug();
					const mine = d.riders.find((r) => r.id === d.mine);
					return { racing: d.racing, mine: !!mine?.alive };
				});

			// `racing` is false during the opening countdown as well as after the
			// round, so a loop that stops on `!racing` stops instantly and records
			// two seconds of nothing. Latch on having seen it true — the same trap
			// `gameActive` sets in Neon Survival.
			await a.waitForFunction(() => window.__game.handle.debug().racing, null, { timeout: 20_000 }).catch(() => {});

			const deadline = Date.now() + seconds * 1000;
			while (Date.now() < deadline) {
				for (const page of [a, b]) {
					const s = await alive(page).catch(() => null);
					if (!s?.racing || !s.mine) continue;
					// Turn often enough to draw a shape rather than a straight line,
					// and alternate, so the rider boxes itself in slowly instead of
					// spiralling into an immediate crash.
					await turn(page, Math.random() < 0.5 ? "left" : "right");
				}
				await sleep(420);
				const over = await a.evaluate(() => window.__game.handle.debug().racing === false).catch(() => false);
				if (over) break;
			}
			await sleep(1200);
		},
	},

	onitama: {
		file: "onitama.html",
		peers: 2,
		seconds: 14,
		async play([a, b], seconds) {
			// The move is *chosen* in the page, because the rules already live
			// there and re-deriving "which card, which piece, which square" in the
			// recorder would be a second implementation to keep in step. What the
			// recorder does is the part a person does: tap the card, tap the piece,
			// tap the square.
			const pickAndPoint = (page) =>
				page.evaluate(() => {
					const g = window.__game.handle.debug();
					if (!g.started || g.winner !== null || g.turn !== g.mySide) return null;
					const R = window.NeonArcade.onitamaRules;
					const moves = R.legalMoves({ board: g.board, hands: g.hands, side: g.side, turn: g.turn }, g.mySide);
					if (!moves.length) return null;
					// Take a capture when there is one, so the clip has something
					// happening in it rather than five students shuffling forward.
					const mv = moves.find((m) => g.board[m.to[0]][m.to[1]]) ?? moves[Math.floor(Math.random() * moves.length)];
					const canvas = document.querySelector(".oni-board");
					const rect = canvas.getBoundingClientRect();
					const cell = rect.width / 5;
					const flip = g.mySide === 1;
					const at = ([r, c]) => {
						const sr = flip ? 4 - r : r;
						const sc = flip ? 4 - c : c;
						return { x: rect.left + (sc + 0.5) * cell, y: rect.top + (sr + 0.5) * cell };
					};
					return { card: R.CARDS[mv.card].name, from: at(mv.from), to: at(mv.to) };
				});

			// Eight exchanges is enough to show the card cycling twice over, which
			// is the mechanic worth seeing. More than that and the gif is over the
			// portal's ~1MB budget for no extra idea.
			const per = Math.max(700, (seconds * 1000) / 16);
			for (let turn = 0; turn < 8; turn++) {
				let acted = false;
				for (const page of [a, b]) {
					const plan = await pickAndPoint(page);
					if (!plan) continue;
					acted = true;
					// The rack nearest the player is the last one on the page.
					await page.locator(".oni-rack").last().locator("button", { hasText: plan.card }).first().click();
					await sleep(200);
					await page.mouse.click(plan.from.x, plan.from.y);
					await sleep(260);
					await page.mouse.click(plan.to.x, plan.to.y);
					await sleep(per / 2);
				}
				if (!acted) await sleep(400);
				const over = await a.evaluate(() => window.__game.handle.debug().winner !== null);
				if (over) break;
			}
			await sleep(900);
		},
	},

	connect4: {
		file: "connect4.html",
		peers: 2,
		seconds: 12,
		async play([a, b], seconds) {
			// Turn order is enforced by the game, so offering the same column to
			// both peers is safe: only the one to move acts on it.
			const cols = [3, 3, 4, 2, 4, 5, 2, 1, 5, 0, 6, 3];
			const per = Math.max(500, (seconds * 1000) / cols.length);
			const won = () => a.locator("#overlay").isVisible().catch(() => false);
			for (const col of cols) {
				await dropPiece(a, col);
				await sleep(per / 2);
				await dropPiece(b, col);
				await sleep(per / 2);
				// A win ends the interesting part; hold the overlay briefly, then stop
				// rather than filling the rest of the gif with it.
				if (await won()) break;
			}
			await sleep(1400);
		},
	},

	"draw-guess": {
		file: "draw-guess.html",
		peers: 2,
		seconds: 16,
		async play([a, b], seconds) {
			// The game disables the chat box for whoever is drawing, so that — not
			// the word display, which shows prompt text to both — is what tells the
			// two roles apart.
			//
			// It only tells them apart once the round is actually under way: the
			// "choosing" phase disables the box on BOTH pages for a couple of
			// seconds, and sampling during it picks a side by coin-flip and then
			// tries to type into the drawer's disabled box. Wait for a page to
			// really be able to guess rather than guessing ourselves.
			const guesser = await Promise.race(
				[a, b].map(async (page) => {
					await page.waitForFunction(
						() => document.querySelector("#chat-input")?.disabled === false,
						null,
						{ timeout: 30_000 },
					);
					return page;
				}),
			);
			const drawer = guesser === a ? b : a;

			const box = await drawer.locator("#board").boundingBox();
			if (box) {
				// A few strokes: a big loop, then two short slashes.
				const strokes = [
					Array.from({ length: 24 }, (_, i) => {
						const t = (i / 24) * Math.PI * 2;
						return [0.5 + 0.22 * Math.cos(t), 0.5 + 0.26 * Math.sin(t)];
					}),
					[[0.3, 0.72], [0.45, 0.86]],
					[[0.7, 0.72], [0.55, 0.86]],
				];
				for (const stroke of strokes) {
					const [sx, sy] = stroke[0];
					await drawer.mouse.move(box.x + sx * box.width, box.y + sy * box.height);
					await drawer.mouse.down();
					for (const [px, py] of stroke.slice(1)) {
						await drawer.mouse.move(box.x + px * box.width, box.y + py * box.height);
						await sleep(35);
					}
					await drawer.mouse.up();
					await sleep(200);
				}
			}
			// The guesser types — the chat is the point of this game's preview.
			for (const guess of ["is it a face?", "a balloon?"]) {
				await guesser.locator("#chat-input").fill(guess);
				await guesser.locator("#chat-send").click();
				await sleep(900);
			}
			await sleep(Math.max(0, seconds * 1000 - 8000));
		},
	},

	"tug-of-war": {
		file: "tug-of-war.html",
		peers: 2,
		seconds: 10,
		async play([a, b], seconds) {
			// Both sides tap, so the knot fights over the middle instead of
			// sliding straight off one end — a stalemate broken late reads far
			// better on a portal card than an instant win.
			const tap = (page, ms) =>
				page.evaluate(async (until) => {
					const btn = document.querySelector("#tug-tap");
					while (performance.now() < until) {
						btn.dispatchEvent(
							new PointerEvent("pointerdown", { bubbles: true, cancelable: true }),
						);
						// The loser taps slightly slower, which is what decides it.
						await new Promise((r) => setTimeout(r, 70));
					}
				}, ms);
			const now = await a.evaluate(() => performance.now());
			await Promise.all([
				tap(a, now + seconds * 1000),
				// b gives up early: matched tap rates are a genuine stalemate, and a
				// knot quivering on the centre line makes a poor portal card. Leave
				// a unopposed for long enough to actually haul it over the line.
				tap(b, now + seconds * 1000 * 0.4),
			]);
			await sleep(1500);
		},
	},

	"neon-survival-mp": {
		file: "neon-survival-mp.html",
		peers: 2,
		seconds: 10,
		async play([a, b], seconds) {
			// Both peers play at once so the gif shows two live players; the second
			// one only has to stay alive, so a sweep is enough for it.
			// Peer B keeps moving in the background so the gif shows two live
			// players; we only await peer A, so the clip ends when A dies.
			const bMoving = sweepMouse(b, seconds, Math.PI).catch(() => {});
			await Promise.race([dodgeLoop(a, seconds), sleep(seconds * 1000)]);
			void bMoving;
		},
	},
};

// -------------------------------------------------------------------- main

const args = process.argv.slice(2);

// The shell wrapper asks for the list rather than keeping its own copy, so a
// new game is registered in exactly one place.
if (args[0] === "--list") {
	console.log(Object.keys(GAMES).join(" "));
	process.exit(0);
}

const game = args[0];
const flag = (name, dflt) => {
	const i = args.indexOf(`--${name}`);
	return i > 0 && args[i + 1] ? args[i + 1] : dflt;
};

if (!game || !GAMES[game]) {
	console.error(`usage: preview.mjs <${Object.keys(GAMES).join("|")}> [--seconds N] [--out FILE]`);
	process.exit(2);
}

const spec = GAMES[game];
const seconds = Number(flag("seconds", spec.seconds));
const width = Number(flag("width", 900));
const height = Number(flag("height", 620));
const outDir = mkdtempSync(join(tmpdir(), "game-preview-"));

const { chromium } = loadPlaywright();
const browser = await chromium.launch({ headless: true, executablePath: chromePath() });

const viewport = { width, height };
const contexts = [];
const pages = [];
for (let i = 0; i < spec.peers; i++) {
	// Only the first peer's context records — that page becomes the gif.
	const ctx = await browser.newContext(
		i === 0 ? { viewport, recordVideo: { dir: outDir, size: viewport } } : { viewport },
	);
	contexts.push(ctx);
	const page = await ctx.newPage();
	page.on("pageerror", (e) => console.error(`[peer${i}] ${String(e).slice(0, 140)}`));
	pages.push(page);
}

const t0 = Date.now();
const url = "file://" + join(ROOT, spec.file);
await Promise.all(pages.map((p) => p.goto(url)));

if (spec.peers > 1) {
	await connectPeers(pages);
	await sleep(800);
	// A game that wants more than the two connected peers — bots, mostly — seats
	// them here, while the lobby is still on screen.
	if (spec.beforeStart) await spec.beforeStart(pages);
	await startGame(pages);
	// Games built on lib/ui.js have no `#game`; they have a `.g-stage`. Waiting
	// for only the old selector meant a silent 20-second stall per recording.
	await pages[0]
		.locator("#game, .g-stage")
		.first()
		.waitFor({ state: "visible", timeout: 20_000 })
		.catch(() => {});
}
await sleep(600);

// Everything before this point is lobby/connection noise the gif should skip.
const startOffset = (Date.now() - t0) / 1000;
await spec.play(pages, seconds);
const playedFor = (Date.now() - t0) / 1000 - startOffset;

for (const ctx of contexts) await ctx.close(); // flushes the video file
await browser.close();

const file = readdirSync(outDir).find((f) => f.endsWith(".webm"));
if (!file) {
	console.error("error: no video was produced");
	process.exit(1);
}
let video = join(outDir, file);
const out = flag("out", null);
if (out) {
	renameSync(video, resolvePath(out));
	video = resolvePath(out);
}

console.log(`video=${video}`);
console.log(`start=${startOffset.toFixed(1)}`);
console.log(`duration=${playedFor.toFixed(1)}`);
