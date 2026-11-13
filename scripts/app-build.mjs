// scripts/app-build.mjs — turn a web app, as its author wrote it, into a game folder.
//
// A manifest with `app` (scripts/manifest.mjs) is an existing web app run
// unchanged (docs/sdk.md, "Web apps"). scripts/fetch-community.mjs calls
// this for each one, on the checkout of the pinned commit:
//
//   1. build    `app.build.run` in `app.build.dir`, inside a throwaway
//               container: no environment, no tokens, only a copy of the
//               checkout. Network is on, for the install. Author code runs
//               nowhere else (NEON_NO_DOCKER=1 runs it here instead — for a
//               maintainer on their own machine, never in CI).
//   2. web/     the built site (or `app.web`), with every script's
//               `location` and `history` rewritten to the arcade's
//               (__neon.location / __neon.history, sdk/v1/web-shim.js).
//               esbuild only parses here; it runs nothing.
//   3. server/  the Python server's source, and in server/wheels/ the
//               pure-Python wheels of what it imports that Pyodide lacks
//               (scripts/py-deps.py).
//   4. game.json, in the published form: entry web/<page>, app.web,
//               app.server { kind, target, path, files, deps, wheels, stubs }.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCK = join(ROOT, "sdk/v1/pyodide/pyodide-lock.json");
const ESBUILD = "esbuild@0.28.2";
const NODE_IMAGE = "docker.io/library/node:22-bookworm-slim";
const PYTHON = "3.14"; // Pyodide's (scripts/vendor-pyodide.mjs)
const BUILD_TIMEOUT = 10 * 60_000;
// What the server folder keeps: source and data, no environments or caches.
const SKIP_DIR = new Set(["__pycache__", ".venv", "venv", "node_modules", ".git", ".pytest_cache", ".mypy_cache", "tests"]);
const SKIP_FILE = /\.(pyc|pyo|so|dylib|dll|db|sqlite3?)$|^\./;
const MAX_SERVER_FILE = 512 * 1024;

const walk = (dir, base = dir, skip = () => false) =>
	readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
		if (skip(d)) return [];
		const p = join(dir, d.name);
		return d.isDirectory() ? walk(p, base, skip) : [relative(base, p).split(sep).join("/")];
	});

/** `rel`, resolved inside `repo`, or an error. */
function inside(repo, from, rel) {
	const p = resolve(from, rel);
	if (p !== repo && !p.startsWith(repo + sep)) throw new Error(`${rel} is outside the repository`);
	return p;
}

function build(repo, dir, run) {
	const log = (s) => console.log(`  build: ${s}`);
	if (process.env.NEON_NO_DOCKER === "1") {
		log(`${run} (here, NEON_NO_DOCKER=1)`);
		execFileSync("sh", ["-c", run], {
			cwd: dir,
			stdio: "inherit",
			timeout: BUILD_TIMEOUT,
			env: { PATH: process.env.PATH, HOME: process.env.HOME, CI: "1" },
		});
		return;
	}
	log(`${run} (in ${NODE_IMAGE})`);
	const uid = process.getuid?.() ?? 1000;
	const gid = process.getgid?.() ?? 1000;
	// Rootless Podman (as `docker`) maps this user only with keep-id.
	const podman = /podman/i.test(execFileSync("docker", ["version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
	execFileSync(
		"docker",
		[
			"run", "--rm",
			...(podman ? ["--userns=keep-id"] : []),
			"--user", `${uid}:${gid}`,
			"--cap-drop", "ALL",
			"--security-opt", "no-new-privileges",
			"--memory", "2g",
			"--pids-limit", "512",
			"-e", "HOME=/tmp",
			"-e", "CI=1",
			"-v", `${repo}:/work`,
			"-w", "/work/" + relative(repo, dir).split(sep).join("/"),
			NODE_IMAGE,
			"sh", "-c", run,
		],
		{ stdio: "inherit", timeout: BUILD_TIMEOUT },
	);
}

/** Rewrite the app's `location` / `history` to the arcade's, in place. */
function rewriteGlobals(webDir) {
	const scripts = walk(webDir).filter((f) => /\.(m?js)$/.test(f));
	if (!scripts.length) return;
	const defines = [];
	for (const g of ["location", "history"]) {
		for (const p of ["", "window.", "self.", "globalThis.", "document."]) {
			if (p === "document." && g === "history") continue;
			defines.push(`--define:${p}${g}=__neon.${g}`);
		}
	}
	for (const f of scripts) {
		const file = join(webDir, f);
		execFileSync("npx", ["--yes", ESBUILD, file, "--allow-overwrite", `--outfile=${file}`, "--minify-whitespace", "--log-level=warning", ...defines], {
			stdio: ["ignore", "inherit", "inherit"],
		});
	}
}

/** Names from pyproject.toml's [project].dependencies or requirements.txt. */
function pythonDeps(dir) {
	const names = new Set();
	const add = (spec) => {
		const name = spec.trim().match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/)?.[1];
		if (name) names.add(name);
	};
	const toml = join(dir, "pyproject.toml");
	if (existsSync(toml)) {
		const block = readFileSync(toml, "utf8").match(/^\s*dependencies\s*=\s*\[([\s\S]*?)\]/m)?.[1] ?? "";
		for (const [, spec] of block.matchAll(/["']([^"']+)["']/g)) add(spec);
	}
	const req = join(dir, "requirements.txt");
	if (existsSync(req)) {
		for (const line of readFileSync(req, "utf8").split("\n")) if (!/^\s*(#|-)/.test(line)) add(line);
	}
	return [...names];
}

/**
 * Build `gameDir` (inside the checkout `repo`) into `to`, and return the
 * published manifest. Throws with a reason the PR comment can show.
 */
export function buildApp({ repo, gameDir, manifest, to }) {
	const app = manifest.app;
	rmSync(to, { recursive: true, force: true });
	mkdirSync(to, { recursive: true });

	if (app.build) build(repo, inside(repo, gameDir, app.build.dir), app.build.run);
	const web = inside(repo, gameDir, app.build ? app.build.out : app.web);
	const entry = manifest.entry;
	if (!existsSync(join(web, entry))) throw new Error(`the built site has no ${entry} (looked in ${relative(repo, web) || "."})`);
	cpSync(web, join(to, "web"), { recursive: true });
	rewriteGlobals(join(to, "web"));

	const published = { ...manifest, entry: `web/${entry}`, app: { web: "web/" } };
	if (manifest.preview && existsSync(join(gameDir, manifest.preview))) {
		cpSync(join(gameDir, manifest.preview), join(to, manifest.preview));
	}

	if (app.server) {
		const src = inside(repo, gameDir, app.server.python);
		const files = walk(src, src, (d) => (d.isDirectory() ? SKIP_DIR.has(d.name) || d.name.startsWith(".") : SKIP_FILE.test(d.name))).filter(
			(f) => statSync(join(src, f)).size <= MAX_SERVER_FILE,
		);
		if (!files.some((f) => f.endsWith(".py"))) throw new Error(`${app.server.python} has no Python files`);
		for (const f of files) {
			mkdirSync(dirname(join(to, "server", f)), { recursive: true });
			cpSync(join(src, f), join(to, "server", f));
		}
		if (!existsSync(LOCK)) throw new Error("sdk/v1/pyodide/ is missing — run node scripts/vendor-pyodide.mjs");
		const wanted = pythonDeps(src);
		const got = wanted.length
			? JSON.parse(
					execFileSync("python3", [join(ROOT, "scripts/py-deps.py"), join(to, "server", "wheels"), LOCK, PYTHON, ...wanted], {
						encoding: "utf8",
						stdio: ["ignore", "pipe", "inherit"],
					}),
				)
			: { deps: [], wheels: [], missing: [] };
		if (got.missing.length) console.log(`  server: no browser build of ${got.missing.join(", ")} — imported as stubs`);
		published.app.server = {
			kind: app.server.asgi ? "asgi" : "wsgi",
			target: app.server.asgi ?? app.server.wsgi,
			path: "server/",
			files,
			deps: got.deps,
			wheels: got.wheels,
			stubs: got.missing,
		};
	}
	writeFileSync(join(to, "game.json"), JSON.stringify(published, null, "\t") + "\n");
	return published;
}
