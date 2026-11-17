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
