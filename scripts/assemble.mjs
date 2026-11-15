// scripts/assemble.mjs — the deployable site, from `vite build`'s output.
//
// Vite builds the one-page shell into dist/ (index.html, app/*: src/main.tsx
// and its views). Everything else is served as it is in the repo, so it is
// copied beside the build here:
//
//   lib/        the game frames inline lib/theme.css, styles.css, games.js…
//               (lib/bridge.js), and lib/load.js loads qr-decode.js,
//               py-server.js, secrets.js, rounds.js on first use
//   sdk/        the frames' runtimes (v1 client, v2 runtime, web shim) and,
//               when vendored, Pyodide — not the examples, adapters, bindings
//   games/  assets/  registry/  community/ (if fetched)
//   the old pages (redirect stubs into the shell), manifest, contributor.json
//
// Then dist/sw.js is written from sw.js: its precache list is every file the
// shell needs offline — the template's own entries (icons, fonts, a few
// extras) plus, derived, every built chunk, every lib/ script and stylesheet,
// every game's files and the frame runtimes — and its VERSION is a hash of
// exactly those bytes (with community/precache.js's, when present). This
// replaces the hand-kept list and scripts/sw-version.mjs: a file can no
// longer be forgotten, and a deploy is a new VERSION exactly when the
// offline copy changed.
//
//   node scripts/assemble.mjs        (pnpm build runs it after vite build)

import { createHash } from "node:crypto";
import { cpSync, existsSync, globSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = process.env.NEON_DIST ? resolve(ROOT, process.env.NEON_DIST) : join(ROOT, "dist");
if (!existsSync(join(DIST, "index.html"))) {
	console.error("assemble: dist/index.html missing — run vite build first (pnpm build)");
	process.exit(1);
}

// ---- copy what is served as-is ------------------------------------------------

// The examples ship (they are listed games); their build trees do not.
const SKIP = [/^sdk\/v2\/(adapters|bindings)(\/|$)/, /^sdk\/v2\/examples\/tic-tac-toe(\/|$)/, /(^|\/)(node_modules|target|__pycache__)(\/|$)/, /(^|\/)\.[^/]+$/];
const keep = (rel) => !SKIP.some((re) => re.test(rel));
for (const dir of ["lib", "sdk", "games", "assets", "registry", "community"]) {
	const from = join(ROOT, dir);
	if (!existsSync(from)) continue;
	cpSync(from, join(DIST, dir), { recursive: true, filter: (src) => keep(relative(ROOT, src).split("\\").join("/")) });
}
const pages = readdirSync(ROOT).filter((f) => f.endsWith(".html") && f !== "index.html");
// …and any other root file sw.js names (CONTRIBUTING.md: the contribute view renders it).
const rootListed = [...readFileSync(join(ROOT, "sw.js"), "utf8").matchAll(/"\.\/([^"/]+\.[a-z]+)"/g)].map((m) => m[1]).filter((f) => f !== "index.html");
for (const f of new Set([...pages, "manifest.webmanifest", "contributor.json", ...rootListed])) if (existsSync(join(ROOT, f))) cpSync(join(ROOT, f), join(DIST, f));

// ---- the service worker -------------------------------------------------------

const template = readFileSync(join(ROOT, "sw.js"), "utf8");
const block = template.match(/const SHELL = \[([\s\S]*?)\];/);
if (!block) throw new Error("sw.js: no SHELL list");
const listed = [...block[1].matchAll(/"\.\/([^"]*)"/g)].map((m) => m[1]);
const files = (pattern) => globSync(pattern, { cwd: DIST }).map((p) => p.split("\\").join("/"));
const derived = [
	...files("app/*.{js,css}"),
	...files("*.html"),
	...files("lib/*.{js,css}"),
	...files("games/**/*.{html,js,css,json}").filter((p) => !basename(p).startsWith("test-")),
	...files("sdk/v1/*.{js,py}"),
	...files("sdk/v2/*.js"),
	// The listed examples: their pages, scripts, styles, modules and Python
	// (not sources or build files).
	...files("sdk/v2/examples/tic-tac-toe-*/**/*.{html,js,css,json,wasm,py}").filter((p) => !/(^|\/)(src|node_modules|target)\/|package(-lock)?\.json$|tsconfig|vite\.config|Cargo/.test(p)),
];
const shell = [...new Set(["", ...listed, ...derived])].sort();
const missing = shell.filter((p) => p && !existsSync(join(DIST, p)));
if (missing.length) {
	console.error(`assemble: sw.js would precache files that are not in dist/:\n  ${missing.join("\n  ")}`);
	process.exit(1);
}
const community = join(DIST, "community", "precache.js");
const communityFiles = existsSync(community)
	? JSON.parse(readFileSync(community, "utf8").match(/COMMUNITY_SHELL = (\[[\s\S]*\]);/)?.[1] ?? "[]").map((p) => p.replace(/^\.\//, ""))
	: [];
const hash = createHash("sha256");
for (const p of [...shell, ...communityFiles].filter(Boolean).sort()) {
	const file = join(DIST, p);
	if (!existsSync(file) || !statSync(file).isFile()) continue;
	hash.update(`\0${p}\0`);
	hash.update(readFileSync(file));
}
hash.update(template.replace(/^const VERSION = "[^"]*";.*$/m, ""));
const version = `arcade-${hash.digest("hex").slice(0, 12)}`;
const list = shell.map((p) => `\t"./${p}",`).join("\n");
const sw = template
	.replace(/^const VERSION = "[^"]*";.*$/m, `const VERSION = "${version}";`)
	.replace(/const SHELL = \[[\s\S]*?\];/, `const SHELL = [\n\t// Written by scripts/assemble.mjs from what was built and copied.\n${list}\n];`);
writeFileSync(join(DIST, "sw.js"), sw);
console.log(`assemble: dist/ ready — ${shell.length} files precached, ${communityFiles.length} community, VERSION ${version}`);
