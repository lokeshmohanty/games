// scripts/test-submission.mjs — the rules a contributor's pull request is
// judged by (scripts/check-submission.mjs `judge`), with no network or git.

import { judge } from "./check-submission.mjs";

let failures = 0;
const check = (label, ok, detail = "") => {
	console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
	if (!ok) failures++;
};

const A = "a".repeat(40);
const B = "b".repeat(40);
const entry = (owner, repo, commit, games = ["chess"]) => ({ repo: `https://github.com/${owner}/${repo}`, commit, games });
/** A world: files before/after, and how GitHub compares commits. */
const world = ({ changed, author = "ada", association = "NONE", before = {}, after = {}, rel = "ahead" }) =>
	judge({
		changed,
		author,
		association,
		before: (p) => before[p] ?? null,
		after: (p) => (p in after ? after[p] : null),
		compare: async () => rel,
	});
const P = "registry/ada/minis.json";

console.log("\nsubmission: a good one");
let v = await world({ changed: [P], after: { [P]: entry("ada", "minis", A) } });
check("a new repo of the author's own, well formed, commit present", v.ok && v.kind === "new", v);
v = await world({ changed: [P], before: { [P]: entry("ada", "minis", A) }, after: { [P]: entry("ada", "minis", B) } });
check("an update that moves the pin forward", v.ok && v.kind === "update" && v.entries[0].from === A, v);

console.log("\nsubmission: what is refused");
v = await world({ changed: [P, "lib/net.js"], after: { [P]: entry("ada", "minis", A) } });
check("a submission that also edits the arcade", !v.ok && v.problems.some((p) => p.includes("lib/net.js")), v.problems);
v = await world({ changed: ["registry/bob/games.json"], after: { "registry/bob/games.json": entry("bob", "games", A) } });
check("someone else's repo", !v.ok && v.problems.some((p) => p.includes("bob's")), v.problems);
v = await world({ changed: ["registry/bob/games.json"], association: "OWNER", after: { "registry/bob/games.json": entry("bob", "games", A) } });
check("…unless the author maintains the arcade", v.ok && v.maintainer, v.problems);
v = await world({ changed: [P], after: { [P]: { repo: "https://github.com/ada/other", commit: A, games: ["x"] } } });
check("an entry naming another repo than its file", !v.ok && v.problems.some((p) => p.includes('"repo" must be')), v.problems);
v = await world({ changed: [P], after: { [P]: entry("ada", "minis", "abc123") } });
check("a short sha", !v.ok && v.problems.some((p) => p.includes("40-character")), v.problems);
v = await world({ changed: [P], after: { [P]: entry("ada", "minis", A, ["../x"]) } });
check("a game path that climbs out", !v.ok && v.problems.some((p) => p.includes("bad game path")), v.problems);
v = await world({ changed: [P], after: { [P]: entry("ada", "minis", A) }, rel: "missing" });
check("a commit GitHub does not have (private repo, unpushed)", !v.ok && v.problems.some((p) => p.includes("not in https://github.com/ada/minis")), v.problems);
for (const rel of ["behind", "diverged"]) {
	v = await world({ changed: [P], before: { [P]: entry("ada", "minis", A) }, after: { [P]: entry("ada", "minis", B) }, rel });
	check(`an update to a commit ${rel} of the pin`, !v.ok && v.problems.some((p) => p.includes(rel)), v.problems);
}
v = await world({ changed: [P], before: { [P]: entry("ada", "minis", A) }, after: { [P]: entry("ada", "minis", A) }, rel: "identical" });
check("an 'update' that changes nothing", !v.ok && v.problems.some((p) => p.includes("unchanged")), v.problems);
v = await world({ changed: ["README.md"] });
check("a PR with no registry file at all", !v.ok && v.problems.some((p) => p.includes("no registry")), v.problems);

console.log("\nsubmission: kinds, for the labels");
v = await world({ changed: [P], before: { [P]: entry("ada", "minis", A) }, after: {} });
check("a removal is its own kind", v.kind === "removal" && v.ok, v);
v = await world({
	changed: [P, "registry/ada/more.json"],
	before: { [P]: entry("ada", "minis", A) },
	after: { [P]: entry("ada", "minis", B), "registry/ada/more.json": entry("ada", "more", A) },
});
check("a new repo and an update together are 'mixed'", v.kind === "mixed" && v.ok, v);

console.log(failures ? `\n${failures} submission check(s) failed` : "\nall submission checks passed");
process.exit(failures ? 1 : 0);
