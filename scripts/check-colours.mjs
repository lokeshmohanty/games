// scripts/check-colours.mjs — no colour is named outside lib/theme.css.
//
// Every page, the shared styles, the SDK's helpers and every game read the
// theme's tokens (CSS var(--…)) or NeonArcade.palette() (canvas), so a theme
// change reaches all of it and the arcade looks like one thing (Lokesh,
// 2026-11-13: "make them uniform"). A literal — #hex, rgb(), hsl(), oklch() —
// anywhere else fails this check, unless its line says `theme-exempt` and why
// (a QR code stays black on white for the camera).
//
//   node scripts/check-colours.mjs [extra dirs…]   e.g. ../arcade-games

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const COLOUR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\(\s*\d/;
const SKIP = new Set(["lib/theme.css", "lib/catalog.js"]);

function* files(dir) {
	for (const name of readdirSync(dir)) {
		if (name.startsWith(".") || name === "node_modules" || name === "community" || name === "worker" || name === "scripts" || name === "assets") continue;
		const p = join(dir, name);
		if (statSync(p).isDirectory()) yield* files(p);
		else if (/\.(css|html|js)$/.test(name) && !/^test-/.test(name)) yield p;
	}
}

const roots = [ROOT, ...process.argv.slice(2).map((d) => resolve(d))];
const found = [];
for (const root of roots) {
	for (const f of files(root)) {
		const rel = relative(root, f);
		if (root === ROOT && SKIP.has(rel)) continue;
		readFileSync(f, "utf8")
			.split("\n")
			.forEach((line, i) => {
				if (line.includes("theme-exempt")) return;
				// The browser-chrome colour before the theme script runs.
				if (/<meta name="theme-color"/.test(line)) return;
				// HTML entities (&#8592;) are characters, not colours.
				const text = line.replace(/&#\d+;/g, "");
				if (COLOUR.test(text)) found.push(`${relative(ROOT, f)}:${i + 1}: ${line.trim().slice(0, 100)}`);
			});
	}
}
if (found.length) {
	console.error(`colours named outside lib/theme.css (use a token, or mark the line theme-exempt):\n  ${found.join("\n  ")}`);
	process.exit(1);
}
console.log(`no stray colours in ${roots.length} tree(s)`);
