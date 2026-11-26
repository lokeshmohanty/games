// scripts/test-submission.mjs — the rules a contributor's pull request is
// judged by (scripts/check-submission.mjs `judge`), and the manifest rule
// every game must meet ("sdk": 2, scripts/manifest.mjs), with no network or git.

import { readFileSync } from "node:fs";
import { judge } from "./check-submission.mjs";
import { contributorEntry } from "./catalog-lib.mjs";
import { validateEntry } from "./fetch-community.mjs";
import { validateManifest } from "./manifest.mjs";

let failures = 0;
const check = (label, ok, detail = "") => {
	console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
	if (!ok) failures++;
};

const A = "a".repeat(40);
const B = "b".repeat(40);
const entry = (owner, repo, commit, games = ["chess"]) => ({ repo: `https://github.com/${owner}/${repo}`, commit, games });
/** A world: files before/after, and how GitHub compares commits (`on`: a branch against the pin). */
const world = ({ changed, author = "ada", association = "NONE", before = {}, after = {}, rel = "ahead", on = "ahead" }) =>
	judge({
		changed,
		author,
		association,
		before: (p) => before[p] ?? null,
		after: (p) => (p in after ? after[p] : null),
		compare: async (repo, from, to) => (to === "arcade" ? on : rel),
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

console.log("\nsubmission: a pin that follows a branch");
const onBranch = (commit) => ({ ...entry("ada", "minis", commit, ["."]), branch: "arcade" });
v = await world({ changed: [P], after: { [P]: onBranch(A) } });
check("a new repo whose games live on a branch, its commit on it", v.ok && v.kind === "new", v);
v = await world({ changed: [P], after: { [P]: onBranch(A) }, on: "identical" });
check("…the commit at the branch's head", v.ok, v.problems);
v = await world({ changed: [P], before: { [P]: entry("ada", "minis", A) }, after: { [P]: onBranch(B) } });
check("an update that moves a pin from the default branch to another, forward", v.ok && v.kind === "update", v.problems);
for (const on of ["behind", "diverged"]) {
	v = await world({ changed: [P], after: { [P]: onBranch(A) }, on });
	check(`a commit off the branch (compare: ${on}) is refused`, !v.ok && v.problems.some((p) => p.includes("not on branch arcade")), v.problems);
}
v = await world({ changed: [P], after: { [P]: onBranch(A) }, on: "missing" });
check("a branch GitHub does not have", !v.ok && v.problems.some((p) => p.includes("no branch arcade")), v.problems);
for (const b of ["-x", "a..b", "a//b", "/a", "a/", "a.", "a b", "", 7]) {
	check(`"branch": ${JSON.stringify(b)} is refused`, validateEntry({ ...entry("ada", "minis", A), branch: b }, "ada", "minis").some((p) => p.includes('"branch"')));
}
for (const b of ["arcade-v2", "feature/arcade", "v1.2"]) {
	check(`"branch": ${JSON.stringify(b)} is accepted`, validateEntry({ ...entry("ada", "minis", A), branch: b }, "ada", "minis").length === 0);
}

console.log("\nsubmission: every registered repo names its contributor");
const card = (data) => {
	try {
		return contributorEntry("ada", "https://github.com/ada/minis", data, A);
	} catch (err) {
		return err.message;
	}
};
check("a contributor.json with a name makes the card", card({ name: "Ada" }).name === "Ada", card({ name: "Ada" }));
check("no contributor.json: refused, saying so", String(card(null)).includes("no contributor.json"), card(null));
check("…nor one without a name", String(card({ bio: "hi" })).includes('"name" is required'), card({ bio: "hi" }));
check("…nor a blank name", String(card({ name: "  " })).includes('"name" is required'), card({ name: "  " }));
check("the arcade's own card (no pin) may still go without one", contributorEntry("ada", "https://github.com/ada/minis", null).name === null);

console.log("\nsubmission: kinds, for the labels");
v = await world({ changed: [P], before: { [P]: entry("ada", "minis", A) }, after: {} });
check("a removal is its own kind", v.kind === "removal" && v.ok, v);
v = await world({
	changed: [P, "registry/ada/more.json"],
	before: { [P]: entry("ada", "minis", A) },
	after: { [P]: entry("ada", "minis", B), "registry/ada/more.json": entry("ada", "more", A) },
});
check("a new repo and an update together are 'mixed'", v.kind === "mixed" && v.ok, v);

console.log("\nmanifest: every game says \"sdk\": 2");
// The web-app fixture is a well-formed manifest (scripts/fixtures/webapp/).
const good = JSON.parse(readFileSync(new URL("./fixtures/webapp/game.json", import.meta.url), "utf8"));
check("a web app with \"sdk\": 2 is accepted", validateManifest(good).length === 0, validateManifest(good));
for (const [what, m] of [
	["a game with \"sdk\": 1", { ...good, kind: "duel", app: undefined, seats: { min: 2, max: 2 }, sdk: 1 }],
	["a web app with \"sdk\": 1 (no longer upgraded)", { ...good, sdk: 1 }],
	["a manifest with no \"sdk\"", { ...good, sdk: undefined }],
]) {
	const problems = validateManifest(m);
	check(`${what} is refused, saying to set "sdk": 2`, problems.some((p) => p.includes('set "sdk": 2')), problems);
}

console.log("\nmanifest: \"leaderboard\" (retired 2026-11-25: no boards; still accepted)");
check('"leaderboard": false is accepted', validateManifest({ ...good, leaderboard: false }).length === 0, validateManifest({ ...good, leaderboard: false }));
check('…so is true', validateManifest({ ...good, leaderboard: true }).length === 0);
check("…anything else is refused", validateManifest({ ...good, leaderboard: "no" }).some((p) => p.includes('"leaderboard" must be true or false')));
{
	// Nothing reads it any more: the catalog leaves it out (catalog-lib.mjs).
	globalThis.window = globalThis;
	globalThis.NeonArcade = {};
	globalThis.document = { baseURI: "http://x/" };
	await import("../lib/catalog.js");
	const all = [...(NeonArcade.CATALOG ?? []), ...(NeonArcade.UNLISTED ?? [])];
	check("the catalog carries it for no game", all.length > 0 && all.every((g) => !("leaderboard" in g)), all.filter((g) => "leaderboard" in g).map((g) => g.id));
}

console.log("\nmanifest: \"sameDevice\" (PERSON seats at the quick table, 2026-11-17)");
{
	const managed = { ...good, app: undefined, kind: "ffa", state: "managed", seats: { min: 2, max: 8 }, bots: true };
	check('"sameDevice": true on a managed game with bots is accepted', validateManifest({ ...managed, sameDevice: true }).length === 0, validateManifest({ ...managed, sameDevice: true }));
	for (const [what, m] of [
		["a Layer 1 game (no managed state: nothing passes `local` or keeps it off the vs-bots board)", { ...managed, state: undefined, sameDevice: true }],
		['a "local" game', { ...managed, kind: "local", sameDevice: true }],
		['a "shared" web app', { ...good, sameDevice: true }],
		["a game without bots", { ...managed, bots: false, sameDevice: true }],
	]) check(`…refused for ${what}`, validateManifest(m).some((p) => p.includes('"sameDevice" needs')), validateManifest(m));
	check("…and it must be a boolean", validateManifest({ ...managed, sameDevice: "yes" }).some((p) => p.includes('"sameDevice" must be true or false')));
	const fission = (NeonArcade.CATALOG ?? []).find((g) => g.id === "neon-fission");
	check("the catalog carries it for Neon Fission, and for no other game", fission?.sameDevice === true && (NeonArcade.CATALOG ?? []).filter((g) => g.sameDevice).length === 1);
}

console.log("\nmanifest: \"achievements\" and \"records\" (lib/achievements.js; every operator is in test-records)");
{
	const managed = { ...good, app: undefined, kind: "ffa", state: "managed", seats: { min: 1, max: 8 }, bots: true };
	const achievements = [{ id: "first-win", title: "First Win", when: { won: true } }];
	const records = [{ id: "time", title: "Best time", of: "ms", best: "min", format: "time" }];
	check("a game's achievements and records are accepted", validateManifest({ ...managed, achievements, records }).length === 0, validateManifest({ ...managed, achievements, records }));
	check("…a malformed condition is refused, naming it", validateManifest({ ...managed, achievements: [{ ...achievements[0], when: { won: { "<": true } } }] }).some((p) => p.includes('achievement "first-win": when."won"."<" must be a number')));
	check("…and a web app may not declare them", validateManifest({ ...good, achievements }).some((p) => p.includes("need a game that reports results")));
	const carried = (NeonArcade.CATALOG ?? []).filter((g) => g.achievements?.length).map((g) => g.id).sort();
	check("the catalog carries them: Connect 4, Neon Bid, Neon Fission, Neon Survival, Tic Tac Toe (JS)", carried.join() === "connect4,neon-bid,neon-fission,neon-survival-mp,tic-tac-toe-js", carried);
	check("…and their records", ["connect4", "neon-bid", "neon-fission", "neon-survival-mp", "tic-tac-toe-js"].every((id) => NeonArcade.CATALOG.find((g) => g.id === id)?.records?.length));
	check("…and a game without them carries neither key", (NeonArcade.CATALOG ?? []).filter((g) => !g.achievements).every((g) => !("records" in g) && !("achievements" in g)));
}

console.log(failures ? `\n${failures} submission check(s) failed` : "\nall submission checks passed");
process.exit(failures ? 1 : 0);
