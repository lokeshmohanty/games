// scripts/vendor-pyodide.mjs — fetch the Python runtime web apps' servers run on.
//
// lib/py-server.js runs a web app's Python server on the host's phone, in
// Pyodide. The platform serves Pyodide itself, from sdk/v1/pyodide/, so no
// phone ever asks a CDN for it (memory: no-third-party-services) and it works
// offline once seen. It is ~15 MB, so it is fetched here — at deploy and
// before the tests — rather than committed, and git-ignored.
//
//   sdk/v1/pyodide/  pyodide.mjs, pyodide.asm.mjs, pyodide.asm.wasm,
//                    python_stdlib.zip, pyodide-lock.json (trimmed to what is
//                    here), and the wheels of PACKAGES and their dependencies
//
// A dependency of a web app's server that is in that lock comes from here;
// anything else scripts/app-build.mjs fetches as a pure-Python wheel into the
// game's own folder, or the server imports it as a stub.
//
//   node scripts/vendor-pyodide.mjs     (does nothing when already in place)

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PYODIDE_VERSION = "314.0.7";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PYODIDE_DIR = join(ROOT, "sdk/v1/pyodide");
// The npm tarball's integrity, so a changed upload is refused.
const TARBALL_SHA512 = "0YvXxEhfEdpLfb/XkM2BFAeMROq0iMUX2bzzH9pOttyMcWkwq+HbE5uyuGD82LN7y2q+SNvi/6V5JEsOlD2R1A==";
const PACKAGES = ["fastapi", "numpy"];
const CORE = ["pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip"];
const CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

export const norm = (n) => n.replace(/[-_.]+/g, "-").toLowerCase();

function main() {
	const stamp = join(PYODIDE_DIR, "VERSION");
	if (existsSync(stamp) && readFileSync(stamp, "utf8").trim() === PYODIDE_VERSION) {
		console.log(`pyodide ${PYODIDE_VERSION}: already in sdk/v1/pyodide/`);
		return;
	}
	const tmp = mkdtempSync(join(tmpdir(), "pyodide-"));
	try {
		const out = join(tmp, "out");
		mkdirSync(out);
		execFileSync("npm", ["pack", `pyodide@${PYODIDE_VERSION}`, "--json", "--silent"], { cwd: tmp, stdio: ["ignore", "pipe", "inherit"] });
		const tgz = join(tmp, `pyodide-${PYODIDE_VERSION}.tgz`);
		const sha = createHash("sha512").update(readFileSync(tgz)).digest("base64");
		if (sha !== TARBALL_SHA512) throw new Error(`pyodide tarball integrity changed: ${sha}`);
		execFileSync("tar", ["-xzf", tgz, "-C", tmp]);
		for (const f of CORE) renameSync(join(tmp, "package", f), join(out, f));

		const lock = JSON.parse(readFileSync(join(tmp, "package", "pyodide-lock.json"), "utf8"));
		const byName = new Map(Object.entries(lock.packages).map(([k, v]) => [norm(k), [k, v]]));
		const keep = new Map();
		const todo = [...PACKAGES];
		while (todo.length) {
			const name = norm(todo.pop());
			if (keep.has(name)) continue;
			const found = byName.get(name);
			if (!found) throw new Error(`${name} is not in Pyodide ${PYODIDE_VERSION}`);
			keep.set(name, found);
			todo.push(...found[1].depends);
		}
		for (const [, [, pkg]] of keep) {
			const file = join(out, pkg.file_name);
			execFileSync("curl", ["-fsSL", "-o", file, CDN + pkg.file_name]);
			const got = createHash("sha256").update(readFileSync(file)).digest("hex");
			if (got !== pkg.sha256) throw new Error(`${pkg.file_name}: sha256 ${got}, the lock says ${pkg.sha256}`);
		}
		lock.packages = Object.fromEntries([...keep.values()]);
		writeFileSync(join(out, "pyodide-lock.json"), JSON.stringify(lock));
		writeFileSync(join(out, "VERSION"), PYODIDE_VERSION + "\n");
		rmSync(PYODIDE_DIR, { recursive: true, force: true });
		mkdirSync(dirname(PYODIDE_DIR), { recursive: true });
		renameSync(out, PYODIDE_DIR);
		console.log(`pyodide ${PYODIDE_VERSION}: core + ${keep.size} packages → sdk/v1/pyodide/ (tarball sha512-${sha})`);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
