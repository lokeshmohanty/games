#!/usr/bin/env node
/**
 * test-scan.mjs — can SCAN REPLY actually read a real reply code off a screen?
 *
 *   node scripts/test-scan.mjs
 *
 * The camera path was previously only exercised against codes that filled the
 * frame, which is not how it is used: someone holds a phone up to a laptop
 * webcam, and the code occupies a fraction of the picture. A reply code is a
 * ~73x73 module grid, so that fraction decides whether anything decodes at all.
 *
 * This builds a synthetic camera frame with the code at a known size, feeds it
 * to Chrome as a fake capture device, and asserts the scanner reads it back.
 *
 * The cases below the static ones exist because a code sitting in frame from
 * the first instant is the one situation the scanner never actually meets. In
 * real use the camera opens onto a room, its owner aims, and only then does the
 * code arrive — and those empty seconds used to be enough to break the scan for
 * good. Anything claiming to test scanning has to include them.
 *
 * Camera access needs a secure context, so the repo is served over
 * http://localhost rather than opened from file://.
 */
import { createRequire } from "node:module";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, globSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const PW_CACHE = join(homedir(), ".cache", "game-previews");
const PORT = 8731;

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

const { chromium } = loadPlaywright();
const work = mkdtempSync(join(tmpdir(), "scan-test-"));

// A reply code the size the real handshake produces on a laptop with more than
// one interface: mDNS host candidates plus IPv4 and IPv6 reflexive ones.
const PAYLOAD = "A".repeat(0) +
	Buffer.from(
		Array.from({ length: 330 }, (_, i) => 48 + ((i * 7) % 75)),
	).toString("latin1");

// Serve the repo so the harness runs in a secure context.
const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], {
	cwd: ROOT,
	stdio: "ignore",
});
const cleanup = () => {
	try {
		server.kill();
	} catch {}
};
process.on("exit", cleanup);
await new Promise((r) => setTimeout(r, 900));

/** Render the code as a PNG exactly `pxWide` across, as it appears on a screen. */
async function makeCodePng(pxWide) {
	const browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox"] });
	const page = await browser.newPage();
	await page.goto(`http://127.0.0.1:${PORT}/scripts/scan-harness.html`);
	const { png, modules } = await page.evaluate(
		([text, w]) => window.renderQr(text, w),
		[PAYLOAD, pxWide],
	);
	await browser.close();
	const file = join(work, `code-${pxWide}.png`);
	writeFileSync(file, Buffer.from(png.split(",")[1], "base64"));
	return { file, modules };
}

/**
 * Composite the code into a camera-sized frame and hand it to Chrome as a fake
 * capture device. `codeWidth` is how wide the code lands in that frame, which
 * is the number that actually decides whether this works.
 */
async function scanFrom({ frameW, frameH, codeWidth, label }) {
	const { file, modules } = await makeCodePng(codeWidth);
	const y4m = join(work, `feed-${frameW}-${codeWidth}.y4m`);
	// A neutral surround, the code centred: a phone screen in front of a webcam.
	execFileSync("ffmpeg", [
		"-y", "-loglevel", "error",
		"-f", "lavfi", "-i", `color=c=#20242c:s=${frameW}x${frameH}:d=2`,
		"-i", file,
		"-filter_complex", "[0][1]overlay=(W-w)/2:(H-h)/2",
		"-pix_fmt", "yuv420p", "-r", "10", y4m,
	]);

	const browser = await chromium.launch({
		executablePath: chromePath(),
		args: [
			"--no-sandbox",
			"--use-fake-ui-for-media-stream",
			"--use-fake-device-for-media-stream",
			`--use-file-for-fake-video-capture=${y4m}`,
		],
	});
	const ctx = await browser.newContext({ permissions: ["camera"] });
	const page = await ctx.newPage();
	await page.goto(`http://127.0.0.1:${PORT}/scripts/scan-harness.html`);
	await page.evaluate(() => window.startScan());

	const got = await page
		.waitForFunction(() => window.scanResult || window.scanError, null, { timeout: 20_000 })
		.then(() => page.evaluate(() => ({
			result: window.scanResult,
			error: window.scanError,
			capture: window.captureSize,
		})))
		.catch(() => ({ result: null, error: "timed out", capture: null }));

	await browser.close();
	const perModule = (codeWidth / modules).toFixed(1);
	check(
		`${label} (${modules}x${modules} code at ${codeWidth}px in a ${frameW}x${frameH} frame, ${perModule}px/module)`,
		got.result === PAYLOAD,
		got.error || (got.result ? "decoded the wrong text" : "no decode"),
	);
	return got;
}

console.log(`\nreply code: ${PAYLOAD.length} chars\n`);

// A decent laptop webcam, phone held up close — the case that must work.
const close = await scanFrom({
	frameW: 1280, frameH: 720, codeWidth: 360,
	label: "720p webcam, phone held close",
});
if (close.capture) {
	check(
		"the scanner asked for more than the default 640x480",
		(close.capture.width ?? 0) >= 1280,
		`camera gave ${close.capture.width}x${close.capture.height}`,
	);
}

// Held further back: the code is a smaller part of the picture.
await scanFrom({
	frameW: 1280, frameH: 720, codeWidth: 240,
	label: "720p webcam, phone at arm's length",
});

// A cheap 640x480 webcam. Recorded honestly rather than asserted: if this
// cannot be made to work, the UI should keep steering people to PASTE.
const cheap = await scanFrom({
	frameW: 640, frameH: 480, codeWidth: 300,
	label: "480p webcam, phone filling half the frame",
});

// ---------------------------------------------------------------- aiming
//
// The real sequence, and the one that was broken: the camera opens on an empty
// room, somebody lines the phone up, and the code appears a few seconds later.
// Empty frames are the *expensive* ones — there is nothing to find, so every
// binarisation pass runs to the end — and the scanner used to read that cost as
// "this device is too slow" and permanently drop its working resolution. By the
// time the code arrived there were no longer enough pixels per module to read
// it, so the camera stayed live and nothing ever scanned.

/** A code rendered the way the lobby renders it, on a phone screen. */
async function makeLobbyCodePng() {
	const browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox"] });
	const page = await browser.newPage();
	await page.goto(`http://127.0.0.1:${PORT}/scripts/scan-harness.html`);
	const { png, modules } = await page.evaluate(
		(text) => window.renderQrAsLobbyDoes(text),
		PAYLOAD,
	);
	await browser.close();
	const file = join(work, "code-lobby.png");
	writeFileSync(file, Buffer.from(png.split(",")[1], "base64"));
	return { file, modules };
}

const lobbyCode = await makeLobbyCodePng();

/**
 * Scan a feed that shows nothing for `blankSecs`, then the code. `throttle` is
 * a CPU slowdown factor: 1 is this machine, 4-6 approximates a mid-range phone,
 * which is the device most likely to be doing the scanning.
 */
async function scanAfterAiming({ blankSecs = 3, throttle = 1, codeWidth = 500, label }) {
	const y4m = join(work, `aim-${throttle}.y4m`);
	execFileSync("ffmpeg", [
		"-y", "-loglevel", "error",
		"-f", "lavfi", "-i", "color=c=#20242c:s=1920x1080:d=15",
		"-i", lobbyCode.file,
		"-filter_complex",
		`[1]scale=${codeWidth}:${codeWidth}[c];[0][c]overlay=(W-w)/2:(H-h)/2:enable='gte(t,${blankSecs})'`,
		"-pix_fmt", "yuv420p", "-r", "10", y4m,
	]);

	const browser = await chromium.launch({
		executablePath: chromePath(),
		args: [
			"--no-sandbox",
			"--use-fake-ui-for-media-stream",
			"--use-fake-device-for-media-stream",
			`--use-file-for-fake-video-capture=${y4m}`,
		],
	});
	const ctx = await browser.newContext({ permissions: ["camera"] });
	const page = await ctx.newPage();
	await page.goto(`http://127.0.0.1:${PORT}/scripts/scan-harness.html`);
	if (throttle > 1) {
		const cdp = await ctx.newCDPSession(page);
		await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
	}
	await page.evaluate(() => window.startScan());
	const got = await page
		.waitForFunction(() => window.scanResult || window.scanError, null, { timeout: 30_000 })
		.then(() => page.evaluate(() => ({ result: window.scanResult, error: window.scanError })))
		.catch(() => ({ result: null, error: "timed out" }));
	await browser.close();
	check(
		`${label} (${lobbyCode.modules}x${lobbyCode.modules} code, ${blankSecs}s of empty frames first)`,
		got.result === PAYLOAD,
		got.error || (got.result ? "decoded the wrong text" : "no decode"),
	);
}

console.log("");
await scanAfterAiming({ label: "aim, then show — desktop CPU" });
await scanAfterAiming({ throttle: 4, label: "aim, then show — phone-class CPU" });
await scanAfterAiming({ throttle: 6, label: "aim, then show — slow phone" });

// ------------------------------------------------- the platform decoder
//
// Chrome exposes BarcodeDetector on platforms where the service behind it is
// absent — on Android the barcode module arrives through Play Services and may
// never have been downloaded. detect() then rejects on every single frame. The
// rejection must not take this file's own decoder down with it.

/** Scan a static feed with `stub` installed over window.BarcodeDetector. */
async function scanWithDetector({ label, stub }) {
	const { file } = await makeCodePng(360);
	const y4m = join(work, "detector.y4m");
	execFileSync("ffmpeg", [
		"-y", "-loglevel", "error",
		"-f", "lavfi", "-i", "color=c=#20242c:s=1280x720:d=5",
		"-i", file,
		"-filter_complex", "[0][1]overlay=(W-w)/2:(H-h)/2",
		"-pix_fmt", "yuv420p", "-r", "10", y4m,
	]);
	const browser = await chromium.launch({
		executablePath: chromePath(),
		args: [
			"--no-sandbox",
			"--use-fake-ui-for-media-stream",
			"--use-fake-device-for-media-stream",
			`--use-file-for-fake-video-capture=${y4m}`,
		],
	});
	const ctx = await browser.newContext({ permissions: ["camera"] });
	await ctx.addInitScript(stub);
	const page = await ctx.newPage();
	await page.goto(`http://127.0.0.1:${PORT}/scripts/scan-harness.html`);
	await page.evaluate(() => window.startScan());
	const got = await page
		.waitForFunction(() => window.scanResult || window.scanError, null, { timeout: 20_000 })
		.then(() => page.evaluate(() => ({ result: window.scanResult, error: window.scanError })))
		.catch(() => ({ result: null, error: "timed out" }));
	await browser.close();
	check(label, got.result === PAYLOAD, got.error || (got.result ? "decoded the wrong text" : "no decode"));
}

console.log("");
await scanWithDetector({
	label: "a platform detector that rejects every frame falls back to our decoder",
	stub: () => {
		window.BarcodeDetector = class {
			static getSupportedFormats() {
				return Promise.resolve(["qr_code"]);
			}
			detect() {
				return Promise.reject(
					new DOMException("Barcode detection service unavailable.", "NotSupportedError"),
				);
			}
		};
	},
});
await scanWithDetector({
	label: "a platform detector that never finds anything falls back too",
	stub: () => {
		window.BarcodeDetector = class {
			static getSupportedFormats() {
				return Promise.resolve([]);
			}
			detect() {
				return Promise.resolve([]);
			}
		};
	},
});

// ----------------------------------------------------- reporting failures
//
// A caller writes `scanner = scanQr({ onError })` and cleans up through
// `scanner`. If onError fires before that assignment lands there is nothing to
// clean up, and the button is left showing CANCEL SCAN over a dead scanner.

{
	const browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox"] });
	const ctx = await browser.newContext();
	// No camera at all: the error path that used to run synchronously.
	await ctx.addInitScript(() => {
		Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
	});
	const page = await ctx.newPage();
	await page.goto(`http://127.0.0.1:${PORT}/scripts/scan-harness.html`);
	await page.evaluate(() => window.startScan());
	const got = await page
		.waitForFunction(() => window.scanError, null, { timeout: 5000 })
		.then(() => page.evaluate(() => ({
			error: window.scanError,
			held: window.handleHeldAtCallback,
		})))
		.catch(() => ({ error: null, held: null }));
	await browser.close();
	check("a camera that cannot open is reported", !!got.error, "no error surfaced");
	check(
		"the caller holds the scanner handle before the failure is reported",
		got.held === true,
		`handleHeldAtCallback was ${got.held}`,
	);
}

cleanup();
console.log(
	failures
		? `\n${failures} failure(s)`
		: "\nall scan checks passed",
);
process.exit(failures ? 1 : 0);
