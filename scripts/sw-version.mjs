// scripts/sw-version.mjs — sw.js's VERSION, as a hash of what it precaches.
//
// The service worker serves code from one precached snapshot per VERSION
// (sw.js, "Why a snapshot"), so VERSION must change whenever any file in
// that snapshot does — and only then. It used to be bumped by hand. This
// hashes every file SHELL names (sw.js itself included, minus its VERSION
// line) and writes `arcade-<12 hex>` into sw.js.
//
//   node scripts/sw-version.mjs                    rewrite VERSION (first-party files)
//   node scripts/sw-version.mjs --check            exit 1 if VERSION is stale
//   node scripts/sw-version.mjs --with-community   also hash community/precache.js's
//                                                  files — the deploy job, after
//                                                  fetch-community has run
//
// The committed VERSION covers first-party files only: community games are
// fetched at deploy (fetch-community.mjs), so a checkout cannot know them, and
// the deploy rewrites VERSION over both before it uploads.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SW = join(ROOT, "sw.js");
const VERSION_LINE = /^const VERSION = "[^"]*";$/m;

/** The paths SHELL lists ("./x" → "x"; "./" is index.html, listed anyway). */
function shellPaths(sw) {
	const block = sw.match(/const SHELL = \[([\s\S]*?)\];/);
	if (!block) throw new Error("sw.js: no SHELL list");
	return [...block[1].matchAll(/"\.\/([^"]*)"/g)].map((m) => m[1]).filter(Boolean);
}

function communityPaths() {
	const file = join(ROOT, "community", "precache.js");
	if (!existsSync(file)) return [];
	const list = readFileSync(file, "utf8").match(/COMMUNITY_SHELL = (\[[\s\S]*\]);/);
	return list ? JSON.parse(list[1]).map((p) => p.replace(/^\.\//, "")) : [];
}

export function computeVersion({ withCommunity = false } = {}) {
	const sw = readFileSync(SW, "utf8");
	const paths = [...new Set([...shellPaths(sw), ...(withCommunity ? communityPaths() : [])])].sort();
	const hash = createHash("sha256");
	hash.update(sw.replace(VERSION_LINE, 'const VERSION = "";'));
	const missing = [];
	for (const p of paths) {
		const file = join(ROOT, p);
		if (!existsSync(file)) {
			missing.push(p);
			continue;
		}
		hash.update(`\0${p}\0`);
		hash.update(readFileSync(file));
	}
	return { version: `arcade-${hash.digest("hex").slice(0, 12)}`, missing, files: paths.length };
}

function main() {
	const args = process.argv.slice(2);
	const { version, missing, files } = computeVersion({ withCommunity: args.includes("--with-community") });
	if (missing.length) {
		console.error(`sw.js precaches files that do not exist:\n  ${missing.join("\n  ")}`);
		process.exit(1);
	}
	const sw = readFileSync(SW, "utf8");
	const current = sw.match(VERSION_LINE)?.[0];
	const wanted = `const VERSION = "${version}";`;
	if (args.includes("--check")) {
		if (current !== wanted) {
			console.error(`sw.js VERSION is stale (${current ?? "missing"}); run: node scripts/sw-version.mjs`);
			process.exit(1);
		}
		console.log(`sw.js VERSION ${version} matches its ${files} precached files`);
		return;
	}
	if (current === wanted) return console.log(`sw.js VERSION ${version} (unchanged)`);
	writeFileSync(SW, sw.replace(VERSION_LINE, wanted));
	console.log(`sw.js VERSION → ${version}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
