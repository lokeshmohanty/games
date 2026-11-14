// scripts/fetch-community.mjs — pull every registered outside repo at its
// pinned commit into community/, and write the scripts that list it.
//
// A registry entry is one file per repository (a repo may hold several games):
//
//   registry/<owner>/<repo>.json
//   { "repo": "https://github.com/<owner>/<repo>", "commit": "<40-hex sha>",
//     "games": ["path/to/game-a", "path/to/game-b"] }
//
// For each, the tarball of exactly that commit is unpacked, and only the
// listed game folders are copied to community/<owner>/<repo>/<path>/ (tests
// left behind). A game folder is static files, copied as they are — unless
// its manifest has `app`, an existing web app, which scripts/app-build.mjs
// builds in a throwaway container and lays out (docs/sdk.md, "Web apps").
// Then:
//
//   community/catalog.js   registers the games (party.html loads it)
//   community/precache.js  their files, for the service worker's offline copy
//
// community/ is generated and git-ignored.
//
//   node scripts/fetch-community.mjs
//   NEON_LOCAL_REPOS=owner/repo=path/to/clone node scripts/fetch-community.mjs
//     (a local clone instead of GitHub. A clone at ../<repo> that has the
//      pinned commit is used without asking. Either way the commit is
//      exported with `git archive`, never the working tree.)
//   NEON_APP_CACHE=dir node scripts/fetch-community.mjs
//     (keep each web app's build in dir, and reuse it while the pin and the
//      build tooling are unchanged — CI restores dir with actions/cache.
//      Entries no pin uses any more are removed.)

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app-build.mjs";
import { catalogEntries, catalogScript, contributorEntry } from "./catalog-lib.mjs";
import { COLOUR } from "./manifest.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "community");
const MAX_GAME_BYTES = 5 * 1024 * 1024;
const MAX_WHEEL_BYTES = 5 * 1024 * 1024; // a web app's server/wheels/, counted apart
const SHA = /^[0-9a-f]{40}$/;
const NAME = /^[A-Za-z0-9_.-]+$/;
const GAME_PATH = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/;

const APP_CACHE = process.env.NEON_APP_CACHE ? resolve(process.env.NEON_APP_CACHE) : null;
// What a build's output depends on besides the pinned commit: change any of
// these and every web app is built again.
const BUILD_TOOLS = ["scripts/app-build.mjs", "scripts/py-deps.py", "sdk/v1/pyodide/pyodide-lock.json"];

const local = new Map(
	(process.env.NEON_LOCAL_REPOS ?? "")
		.split(",")
		.filter(Boolean)
		.map((pair) => pair.split("=")),
);

/** Every file under `dir`, relative to it. */
function walk(dir, base = dir) {
	return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
		d.isDirectory() ? walk(join(dir, d.name), base) : [relative(base, join(dir, d.name))],
	);
}

/**
 * A game that names its own colours rather than the theme's (allowed: Lokesh,
 * 2026-11-14, "allow his own hard-coded colours") is marked `ownColours` in
 * its published manifest, so the portal can say it keeps its own look.
 */
function markColours(dir) {
	const own = walk(dir)
		.filter((f) => /\.(css|html|m?js)$/.test(f) && !f.startsWith("server/"))
		.some((f) => readFileSync(join(dir, f), "utf8").split("\n").some((l) => COLOUR.test(l.replace(/&#\d+;/g, "")) && !l.includes("theme-exempt")));
	if (!own) return;
	const file = join(dir, "game.json");
	writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), ownColours: true }, null, "\t") + "\n");
}

/** The build tooling's fingerprint, part of every cache key. */
function toolsHash() {
	const h = createHash("sha256");
	for (const f of BUILD_TOOLS) h.update(f + "\0" + (existsSync(join(ROOT, f)) ? readFileSync(join(ROOT, f)) : "") + "\0");
	return h.digest("hex");
}

/** Problems with a registry entry, as sentences. */
export function validateEntry(entry, owner, repo) {
	const p = [];
	if (entry.repo !== `https://github.com/${owner}/${repo}`) p.push(`"repo" must be https://github.com/${owner}/${repo}`);
	if (!SHA.test(entry.commit ?? "")) p.push('"commit" must be a full 40-character commit sha');
	if (!Array.isArray(entry.games) || !entry.games.length) p.push('"games" must list at least one game folder');
	for (const g of entry.games ?? []) {
		if (typeof g !== "string" || !GAME_PATH.test(g) || g.split("/").includes("..")) p.push(`bad game path: ${g}`);
	}
	return p;
}

/** Unpack `owner/repo` at `commit` into a fresh temp dir; returns its path. */
function checkout(owner, repo, commit) {
	const dir = mkdtempSync(join(tmpdir(), "neon-community-"));
	// A clone beside this repo (../<repo>) that has the commit is used as is:
	// the same bytes GitHub would serve, and it works before a push.
	const sibling = join(ROOT, "..", repo);
	const hasCommit = (dir) => {
		try {
			execFileSync("git", ["-C", dir, "cat-file", "-e", `${commit}^{commit}`], { stdio: "ignore" });
			return true;
		} catch {
			return false;
		}
	};
	const clone = local.get(`${owner}/${repo}`) ?? (existsSync(join(sibling, ".git")) && hasCommit(sibling) ? sibling : null);
	if (clone) {
		const tar = execFileSync("git", ["-C", resolve(ROOT, clone), "archive", "--format=tar", commit], {
			maxBuffer: 1 << 30,
		});
		execFileSync("tar", ["-x", "-C", dir], { input: tar });
		return dir;
	}
	// GitHub's tarball of exactly that commit; it unpacks into one top folder.
	const url = `https://codeload.github.com/${owner}/${repo}/tar.gz/${commit}`;
	execFileSync("sh", ["-c", `curl -fsSL "$0" | tar -xz -C "$1" --strip-components=1`, url, dir]);
	return dir;
}

function main() {
	rmSync(OUT, { recursive: true, force: true });
	mkdirSync(OUT, { recursive: true });
	const registry = join(ROOT, "registry");
	const manifests = [];
	const errors = [];
	const contributors = [];
	const tools = APP_CACHE && toolsHash();
	const usedCache = new Set();
	let [cacheHits, cacheBuilds] = [0, 0];

	for (const owner of existsSync(registry) ? readdirSync(registry).sort() : []) {
		// Owners are folders; registry/trusted.txt and the like are not.
		if (!NAME.test(owner) || !statSync(join(registry, owner)).isDirectory()) continue;
		for (const file of readdirSync(join(registry, owner)).sort()) {
			if (!file.endsWith(".json")) continue;
			const repo = file.slice(0, -".json".length);
			const where = `registry/${owner}/${file}`;
			let entry;
			try {
				entry = JSON.parse(readFileSync(join(registry, owner, file), "utf8"));
			} catch (err) {
				errors.push(`${where}: ${err.message}`);
				continue;
			}
			const bad = validateEntry(entry, owner, repo);
			if (bad.length) {
				errors.push(`${where}: ${bad.join("; ")}`);
				continue;
			}
			const src = checkout(owner, repo, entry.commit);
			try {
				for (const path of entry.games) {
					const from = join(src, path);
					if (!existsSync(join(from, "game.json"))) {
						errors.push(`${where}: ${path}/game.json not found at ${entry.commit.slice(0, 8)}`);
						continue;
					}
					const to = join(OUT, owner, repo, path);
					let manifest;
					try {
						manifest = JSON.parse(readFileSync(join(from, "game.json"), "utf8"));
					} catch (err) {
						errors.push(`${where}: ${path}/game.json: ${err.message}`);
						continue;
					}
					if (manifest?.app) {
						// A pinned commit's build is the same every time: the
						// sources are fixed, and so is the tooling (in the key).
						const key = tools && createHash("sha256").update([owner, repo, entry.commit, path, tools].join("\0")).digest("hex");
						const cached = key && join(APP_CACHE, key);
						if (cached) usedCache.add(key);
						if (cached && existsSync(join(cached, "game.json"))) {
							rmSync(to, { recursive: true, force: true });
							cpSync(cached, to, { recursive: true });
							console.log(`  ${owner}/${repo}/${path}: built at ${entry.commit.slice(0, 8)} before — reused`);
							cacheHits++;
						} else {
							try {
								buildApp({ repo: src, gameDir: from, manifest, to });
							} catch (err) {
								errors.push(`${where}: ${path}: ${err.message.split("\n")[0]}`);
								continue;
							}
							if (cached) {
								// Whole or not at all: a half-copied entry would pass for a build.
								rmSync(cached, { recursive: true, force: true });
								cpSync(to, cached + ".part", { recursive: true });
								renameSync(cached + ".part", cached);
								cacheBuilds++;
							}
						}
						const wheels = (f) => f.startsWith("server/wheels/");
						const built = walk(to);
						const size = (list) => list.reduce((n, f) => n + statSync(join(to, f)).size, 0);
						const [bytes, wheelBytes] = [size(built.filter((f) => !wheels(f))), size(built.filter(wheels))];
						if (bytes > MAX_GAME_BYTES || wheelBytes > MAX_WHEEL_BYTES) {
							errors.push(
								`${where}: ${path} built to ${(bytes / 1048576).toFixed(1)} MB + ${(wheelBytes / 1048576).toFixed(1)} MB of Python wheels (limits ${MAX_GAME_BYTES / 1048576} MB each)`,
							);
							continue;
						}
					} else {
						const files = walk(from).filter((f) => !/(^|\/)test-[^/]*\.m?js$/.test(f));
						const bytes = files.reduce((n, f) => n + statSync(join(from, f)).size, 0);
						if (bytes > MAX_GAME_BYTES) {
							errors.push(`${where}: ${path} is ${(bytes / 1048576).toFixed(1)} MB (limit ${MAX_GAME_BYTES / 1048576} MB)`);
							continue;
						}
						for (const f of files) {
							mkdirSync(dirname(join(to, f)), { recursive: true });
							cpSync(join(from, f), join(to, f));
						}
					}
					markColours(to);
					manifests.push({ file: join(to, "game.json"), owner });
				}
				writeFileSync(join(OUT, owner, repo, "pin.json"), JSON.stringify(entry, null, 2) + "\n");
				// The owner's card for the Contributors page, from the same commit.
				try {
					const card = join(src, "contributor.json");
					contributors.push(contributorEntry(owner, entry.repo, existsSync(card) ? JSON.parse(readFileSync(card, "utf8")) : null, entry.commit));
				} catch (err) {
					errors.push(`${where}: ${err.message}`);
				}
			} finally {
				rmSync(src, { recursive: true, force: true });
			}
		}
	}

	let games = [];
	try {
		games = catalogEntries(manifests, ROOT);
	} catch (err) {
		errors.push(err.message);
	}
	if (errors.length) {
		console.error(errors.join("\n"));
		process.exit(1);
	}
	if (APP_CACHE && existsSync(APP_CACHE)) {
		const stale = readdirSync(APP_CACHE).filter((k) => !usedCache.has(k));
		for (const k of stale) rmSync(join(APP_CACHE, k), { recursive: true, force: true });
		console.log(`app cache: ${cacheHits} reused, ${cacheBuilds} built, ${stale.length} dropped`);
	}
	writeFileSync(
		join(OUT, "catalog.js"),
		catalogScript(games, { file: "community/catalog.js", source: "scripts/fetch-community.mjs", contributors }),
	);
	// Preview gifs stay out, as the first-party ones do (sw.js): large, and
	// cached on first sight anyway.
	const precache = walk(OUT)
		.filter((f) => f !== "precache.js" && !/\.gif$/i.test(f))
		.map((f) => "./community/" + f.split("\\").join("/"));
	writeFileSync(
		join(OUT, "precache.js"),
		`// community/precache.js — GENERATED by scripts/fetch-community.mjs; do not edit.\nself.COMMUNITY_SHELL = ${JSON.stringify(precache, null, "\t")};\n`,
	);
	console.log(`community: ${games.length} games from ${new Set(games.map((g) => g.path.split("/").slice(1, 3).join("/"))).size} repos → community/`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
