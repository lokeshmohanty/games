#!/usr/bin/env node
/**
 * make-icons.mjs — render assets/icon.svg into the PNGs the manifest needs.
 *
 *   node scripts/make-icons.mjs
 *
 * The project takes no dependencies and has no build step, so there is no image
 * toolchain to lean on — but there is already a Chrome here for the preview
 * recorder and the scan tests, and Chrome is a perfectly good SVG rasteriser.
 * Running this is only necessary when assets/icon.svg changes; the PNGs it
 * produces are committed, so a clone needs nothing.
 *
 * Two shapes come out of the one drawing:
 *   - `any`: the mark edge to edge, its own rounded corners intact. This is
 *     what desktop and iOS show.
 *   - `maskable`: the same mark shrunk to the middle 60% on a full-bleed
 *     background. Android crops icons to whatever shape the launcher uses, so
 *     an `any` icon put through that treatment loses its corners and part of
 *     the glyph; a maskable one has the room to spare.
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync, globSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const PW_CACHE = join(homedir(), ".cache", "game-previews");

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

const svg = readFileSync(join(ROOT, "assets", "icon.svg"), "utf8");

// What to produce. `inset` is the fraction of the canvas left empty around the
// mark; Android's maskable safe zone is the middle 80%, and 0.2 keeps the glyph
// inside it with room for the glow.
const TARGETS = [
	{ file: "icon-192.png", size: 192, inset: 0 },
	{ file: "icon-512.png", size: 512, inset: 0 },
	{ file: "icon-maskable-512.png", size: 512, inset: 0.2, frameless: true },
	// iOS ignores the manifest and reads this one; it also composites the icon
	// onto its own rounded rect, so a little inset keeps the corners clean.
	{ file: "apple-touch-icon.png", size: 180, inset: 0.06 },
];

const { chromium } = loadPlaywright();
const browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox"] });

for (const { file, size, inset, frameless } of TARGETS) {
	const pad = Math.round(size * inset);
	const inner = size - pad * 2;
	const page = await browser.newPage({ viewport: { width: size, height: size } });
	await page.setContent(
		`<!doctype html><meta charset="utf-8">
		 <style>
		   html,body{margin:0;padding:0;width:${size}px;height:${size}px;overflow:hidden}
		   /* Full-bleed backing so a launcher crop never exposes the page behind. */
		   body{background:#0a0a0a;display:grid;place-items:center}
		   svg{width:${inner}px;height:${inner}px;display:block}
		   ${frameless ? ".tile{display:none}" : ""}
		 </style>
		 ${svg}`,
		{ waitUntil: "load" },
	);
	const png = await page.screenshot({ omitBackground: false });
	writeFileSync(join(ROOT, "assets", file), png);
	await page.close();
	console.log(`  wrote assets/${file} (${size}x${size}${inset ? `, ${Math.round(inset * 100)}% inset` : ""})`);
}

await browser.close();
console.log("\nicons rebuilt from assets/icon.svg");
