// scripts/test-just.mjs — the Justfile itself, with no browser.
//
// The variadic-recipe trap: `just a b c` hands b and c to a when a takes
// `*args`, so b and c never run and the exit is 0. Every recipe with a
// `*`/`+` parameter must depend on `_not-recipes` first (before anything
// else runs), and `just <it> … test-webapp` must fail.
//
// Reads the Justfile through `just --dump --dump-format json` (JUST names the
// binary; the recipe passes just_executable()).

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const JUST = process.env.JUST || "just";

let failures = 0;
const check = (label, ok, detail = "") => {
	console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
	if (!ok) failures++;
};
const just = (...args) => spawnSync(JUST, ["--justfile", join(ROOT, "Justfile"), ...args], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });

const dump = just("--dump", "--dump-format", "json");
if (dump.status !== 0) {
	console.error(`could not read the Justfile: ${dump.stderr || dump.error}`);
	process.exit(1);
}
const recipes = JSON.parse(dump.stdout).recipes;
const deps = (name) => (recipes[name]?.dependencies ?? []).map((d) => d.recipe);

console.log("\njust: no variadic recipe swallows the next recipe's name");
const variadic = Object.values(recipes).filter((r) => r.parameters.some((p) => p.kind === "star" || p.kind === "plus"));
check(`the variadic recipes are found (${variadic.map((r) => r.name).join(", ")})`, variadic.length >= 8 && variadic.some((r) => r.name === "test-conformance"));
for (const r of variadic) {
	const first = deps(r.name)[0];
	check(`${r.name}: _not-recipes is its first dependency`, first === "_not-recipes", `first is ${first ?? "nothing"}`);
}
// Only now is it safe to call them for real: the guard fails before any
// other dependency or the body runs (a `+` parameter is given one value).
if (!failures) {
	for (const r of variadic) {
		const fill = r.parameters.filter((p) => p.kind === "singular" && p.default === null).map(() => "x");
		const res = just(r.name, ...fill, "test-webapp");
		const said = `${res.stdout}${res.stderr}`;
		check(`just ${r.name} ${[...fill, "test-webapp"].join(" ")} fails, naming the recipe`, res.status !== 0 && /'test-webapp' is a recipe|does not match pattern/.test(said), `exit ${res.status}: ${said.trim().split("\n")[0]}`);
	}
}
const lane = spawnSync(process.execPath, [join(ROOT, "scripts/test-conformance.mjs"), "rsut"], { cwd: ROOT, encoding: "utf8", timeout: 30_000 });
check("test-conformance refuses a lane that does not exist", lane.status === 2 && /unknown lane 'rsut'/.test(lane.stderr), `exit ${lane.status}: ${lane.stderr.trim()}`);

console.log(failures ? `\n${failures} justfile check(s) failed` : "\nall justfile checks passed");
process.exit(failures ? 1 : 0);
