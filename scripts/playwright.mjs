// scripts/playwright.mjs — Playwright, for every script that drives a browser.
//
// It is a pinned dev dependency (package.json), installed with the shell's
// other dependencies by `just install` (pnpm install --frozen-lockfile; CI
// does the same with PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1). Only the driver is
// used: the scripts launch a system Chrome (CHROME=…). One place to look, so
// a missing install is one clear error, not `require(undefined)` — which is
// how three suites failed on their first GitHub runner (2026-11-15): they
// looked only in caches that exist on Lokesh's machine.
//
// scripts/test-pair.mjs keeps its own lookup: it is copied alone to a second
// machine and run there.

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "node_modules", "playwright");

/** The `playwright` module (chromium, firefox, devices …); exits with a clear error when it is not installed. */
export function loadPlaywright() {
	if (!existsSync(DIR)) {
		console.error("playwright is not installed: run `just install` (pnpm install --frozen-lockfile — it is a pinned dev dependency).");
		process.exit(1);
	}
	return createRequire(import.meta.url)(DIR);
}

/**
 * Playwright's own Firefox, for the checks only Firefox fails (a phone's
 * larger text, which Firefox applies as text zoom; a frame's theme), or
 * null when it cannot start here. CI installs no Firefox (it uses the
 * runner's Chrome), so those checks say they were skipped; NEON_FIREFOX=1
 * makes a missing Firefox a failure instead. On NixOS its libraries come
 * from scripts/firefox-libs.sh (docs/development.md "Firefox").
 *
 * `textScale` (a percentage) is the phone's system font size: Firefox
 * scales every font by it and nothing else, as Firefox for Android does.
 */
export async function launchFirefox(pw, { textScale = 100 } = {}) {
	try {
		return await pw.firefox.launch({
			firefoxUserPrefs: textScale === 100 ? {} : { "browser.display.os-zoom-behavior": 2, "ui.textScaleFactor": textScale },
		});
	} catch (err) {
		const why = String(err?.message ?? err).split("\n").find((l) => l.trim()) ?? "";
		if (process.env.NEON_FIREFOX) throw new Error(`Firefox is required (NEON_FIREFOX) and did not start: ${why}`);
		console.log(`  skip Firefox: it did not start here (${why.slice(0, 120)}); NixOS: docs/development.md "Firefox"`);
		return null;
	}
}
