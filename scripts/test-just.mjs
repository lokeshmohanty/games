// scripts/test-just.mjs — the Justfile itself, with no browser.
//
// 1. The variadic-recipe trap: `just a b c` hands b and c to a when a takes
//    `*args`, so b and c never run and the exit is 0. Every recipe with a
//    `*`/`+` parameter must depend on `_not-recipes` first (before anything
//    else runs), and `just <it> … test-webapp` must fail.
// 2. CI's parallel shards (.github/workflows/test.yml) drop no suite: the
//    cheap gate (test-static) plus the `_shard-<n>` recipes hold exactly the
//    suites of `just test` and of `test-wrangler`, each once; and the CI
//    matrix lists exactly those shards.
//
// Reads the Justfile through `just --dump --dump-format json` (JUST names the
// binary; the recipe passes just_executable()).

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
// Whose variadic arguments may be anything, recipe names included.
const EXEMPT = { propose: "its game folders may be called anything" };
// The variables the guard is handed, from the dump's expression tree.
const vars = (x) => (Array.isArray(x) ? (x[0] === "variable" ? [x[1]] : x.flatMap(vars)) : []);
const guarded = (r) => vars(recipes[r.name].dependencies.find((d) => d.recipe === "_not-recipes")?.arguments ?? []);
for (const r of variadic) {
	const first = deps(r.name)[0];
	check(`${r.name}: _not-recipes is its first dependency`, first === "_not-recipes", `first is ${first ?? "nothing"}`);
	const star = r.parameters.find((p) => p.kind === "star" || p.kind === "plus").name;
	if (EXEMPT[r.name]) check(`${r.name}: its ${star} are not checked (${EXEMPT[r.name]}), the rest are`, !guarded(r).includes(star) && guarded(r).length > 0, guarded(r).join(","));
	else check(`${r.name}: the guard is handed its ${star}`, guarded(r).includes(star), guarded(r).join(","));
}
// Only now is it safe to call them for real: the guard fails before any
// other dependency or the body runs. The recipe's name goes where the trap
// puts it, last; for an exempt recipe, into its first checked parameter.
if (!failures) {
	for (const r of variadic) {
		const singles = r.parameters.filter((p) => p.kind === "singular" && p.default === null);
		const args = EXEMPT[r.name] ? singles.map((p, i) => (i === 0 ? "test-webapp" : "x")) : [...singles.map(() => "x"), "test-webapp"];
		const res = just(r.name, ...args);
		const said = `${res.stdout}${res.stderr}`;
		check(`just ${r.name} ${args.join(" ")} fails, naming the recipe`, res.status !== 0 && /'test-webapp' is a recipe/.test(said), `exit ${res.status}: ${said.trim().split("\n")[0]}`);
	}
}
const typo = spawnSync(process.execPath, [join(ROOT, "scripts/build-catalog.mjs"), "--chek"], { cwd: ROOT, encoding: "utf8", timeout: 30_000 });
check("build-catalog refuses an argument that is not --check (it used to rewrite the catalog)", typo.status === 2 && /unknown argument '--chek'/.test(typo.stderr), `exit ${typo.status}: ${typo.stderr.trim()}`);
const lane = spawnSync(process.execPath, [join(ROOT, "scripts/test-conformance.mjs"), "rsut"], { cwd: ROOT, encoding: "utf8", timeout: 30_000 });
check("test-conformance refuses a lane that does not exist", lane.status === 2 && /unknown lane 'rsut'/.test(lane.stderr), `exit ${lane.status}: ${lane.stderr.trim()}`);

console.log("\njust: the CI shards hold every suite, once");
// What `just test` does that is not a suite: fetch and build (the CI build job).
const SETUP = new Set(["pyodide", "community", "build"]);
// The groups a list may name instead of their suites.
const GROUPS = new Set(["test-static", "test-wrangler"]);
const expand = (name) => (GROUPS.has(name) ? deps(name).flatMap(expand) : [name]);
const suites = [...deps("test"), "test-wrangler"].flatMap(expand).filter((s) => !SETUP.has(s));
const shards = Object.keys(recipes)
	.map((n) => /^_shard-(\d+)$/.exec(n)?.[1])
	.filter(Boolean)
	.map(Number)
	.sort((a, b) => a - b);
const placed = ["test-static", ...shards.flatMap((n) => deps(`_shard-${n}`))].flatMap(expand);
const twice = placed.filter((s, i) => placed.indexOf(s) !== i);
check(`${shards.length} shards, numbered 1 to ${shards.length}`, shards.length >= 2 && shards.every((n, i) => n === i + 1), shards.join(","));
check("test-wrangler's suites are not in `just test` (they need wrangler)", !deps("test-wrangler").some((s) => deps("test").includes(s)));
check("no suite is in two shards (or in a shard and the gate)", !twice.length, twice.join(", "));
const dropped = suites.filter((s) => !placed.includes(s));
const extra = placed.filter((s) => !suites.includes(s));
check(`every suite of \`just test\` and test-wrangler is in the gate or a shard (${suites.length})`, !dropped.length, `dropped: ${dropped.join(", ")}`);
check("…and the shards run nothing else", !extra.length, `extra: ${extra.join(", ")}`);
const workflow = readFileSync(join(ROOT, ".github/workflows/test.yml"), "utf8");
const matrix = /^\s*shard:\s*\[([^\]]*)\]/m.exec(workflow)?.[1].split(",").map((s) => Number(s.trim()));
check("the CI matrix runs exactly these shards", matrix?.join() === shards.join(), `matrix: ${matrix?.join() ?? "none"}`);
check("CI's first job is `just test-static`", /run:\s*just test-static\b/.test(workflow));

console.log(failures ? `\n${failures} justfile check(s) failed` : "\nall justfile checks passed");
process.exit(failures ? 1 : 0);
