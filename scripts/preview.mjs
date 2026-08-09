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
 * joins them to the same room over Trystero — verified working headless
 * (2026-08-09): the relays connect in a few seconds and host election happens
 * normally. Only the first page records; it is the one that appears in the gif.
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

/** Join the shared lobby with a room code. */
async function joinRoom(page, code) {
	await page.locator(".lobby-input").fill(code);
	await page.locator("button.neon-btn", { hasText: "JOIN" }).first().click();
}

/** Wait until this peer sees at least one other peer in the room. */
async function waitForPeer(page, timeoutMs = 45_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const s = (await page.locator(".lobby-status").textContent().catch(() => "")) ?? "";
		if (/[1-9]\d* peer/.test(s)) return true;
		await sleep(500);
	}
	throw new Error("peers never connected — Trystero needs network access to its relays");
}

/** The host is whichever page shows an enabled START GAME button. */
async function startGame(pages) {
	for (const page of pages) {
		const btn = page.locator("button", { hasText: "START GAME" });
		if ((await btn.count()) && (await btn.first().isEnabled())) {
			await btn.first().click();
			return;
		}
	}
	throw new Error("no peer offered START GAME");
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
	while (Date.now() < end) {
		const aim = await page
			.evaluate((sel) => {
				const c = document.querySelector(sel);
				if (!c || typeof player === "undefined") return null;
				if (player.alive === false) return "dead";
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
		// screen, and the recording ends right after this returns.
		if (aim === "dead") return;
		if (aim != null) await page.mouse.move(box.x + aim * box.width, box.y + box.height * 0.85);
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
			// Let the round-start reveal finish: strokes drawn during it are cleared.
			await sleep(1200);
			const canGuess = await a.locator("#chat-input").isEnabled().catch(() => false);
			const guesser = canGuess ? a : b;
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

	"neon-survival": {
		file: "neon-survival.html",
		peers: 1,
		seconds: 12,
		async play([a], seconds) {
			const start = a.locator("button", { hasText: /START|PLAY/i });
			if (await start.count()) await start.first().click().catch(() => {});
			await dodgeLoop(a, seconds, "canvas");
		},
	},
};

// -------------------------------------------------------------------- main

const args = process.argv.slice(2);
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
	const code = "PREV" + Math.floor(Math.random() * 9000 + 1000);
	for (const p of pages) await joinRoom(p, code);
	await waitForPeer(pages[0]);
	await sleep(800);
	await startGame(pages);
	await pages[0].locator("#game").waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});
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
