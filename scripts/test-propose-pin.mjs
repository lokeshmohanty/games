// scripts/test-propose-pin.mjs — the contributor's propose workflow
// (sdk/propose-pin.yml): its shell step run as Actions would, in a throwaway
// git repo, against a `gh` that plays GitHub's API. No network.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
const check = (label, ok, detail = "") => {
	console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
	if (!ok) failures++;
};

// The `run: |` block of the one step that has one, de-indented.
const yml = readFileSync(new URL("../sdk/propose-pin.yml", import.meta.url), "utf8").split("\n");
const at = yml.findIndex((l) => /^\s+run: \|$/.test(l));
const indent = yml[at + 1].match(/^\s*/)[0].length;
const lines = [];
for (const l of yml.slice(at + 1)) {
	if (l.trim() && l.match(/^\s*/)[0].length < indent) break;
	lines.push(l.slice(indent));
}
const script = lines.join("\n");

// A fake `gh api`: answers from $FAKE_STATE, logs every call to $FAKE_LOG.
// A shell function runs it, so the real gh is never reached (an executable
// on PATH is skipped where temp dirs are noexec, and the next gh would answer).
const FAKE = `const fs = require("fs");
const { execFileSync } = require("child_process");
const state = JSON.parse(fs.readFileSync(process.env.FAKE_STATE, "utf8"));
const a = process.argv.slice(2);
if (a.shift() !== "api") process.exit(2);
let method = "GET", path = null, jq = null; const f = {};
while (a.length) {
	const x = a.shift();
	if (x === "-X") method = a.shift();
	else if (x === "-H") a.shift();
	else if (x === "-f" || x === "-F") { const [k, ...v] = a.shift().split("="); f[k] = v.join("="); }
	else if (x === "--jq") jq = a.shift();
	else path = x;
}
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ method, path, f }) + "\\n");
const P = "repos/lokeshmohanty/games", F = "repos/ada/games-1", FILE = "contents/registry/ada/minis.json", CARD = "contents/registry/ada/main.json";
const nf = () => { process.stdout.write('{"message":"Not Found","status":"404"}'); process.exit(1); };
let out;
if (path === "user") out = { login: "ada" };
else if (path === P + "/" + FILE) { if (!state.registered) nf(); process.stdout.write(JSON.stringify(state.registered)); process.exit(0); }
else if (path === P + "/" + CARD) { if (!state.card) nf(); out = state.card; }
else if (path === "users/ada") out = { login: "ada", name: "Ada Lovelace", bio: "Small games.", location: "", blog: "ada.dev" };
else if (method === "PUT" && path === F + "/" + CARD) out = {};
else if (method === "POST" && path === P + "/forks") out = { full_name: "ada/games-1" };
else if (path === F) out = {};
else if (path === P + "/git/ref/heads/main") out = { object: { sha: "m".repeat(40) } };
else if (path === F + "/git/ref/heads/arcade-pin/minis") { if (!state.pinBranch) nf(); out = {}; }
else if (method !== "GET" && path.startsWith(F + "/git/refs")) out = {};
else if (method === "GET" && path === F + "/" + FILE + "?ref=arcade-pin/minis") { if (!state.pinBranch) nf(); out = { sha: "f".repeat(40) }; }
else if (method === "PUT" && path === F + "/" + FILE) out = {};
else if (path.startsWith(P + "/pulls?")) out = state.openPr ? [{ html_url: state.openPr }] : [];
else if (method === "POST" && path === P + "/pulls") out = { html_url: "https://github.com/lokeshmohanty/games/pull/99" };
else { process.stderr.write("fake gh: no answer for " + method + " " + path + "\\n"); process.exit(3); }
const s = JSON.stringify(out);
process.stdout.write(jq ? execFileSync("jq", ["-r", jq], { input: s }) : s);
`;

const HEAD = "c".repeat(40);
function run({ registered = null, pinBranch = false, openPr = null, token = "t", branch = "arcade-v2", games = ["game.json"], card = { name: "Ada" }, repoName = "minis" } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "propose-pin-"));
	try {
		const repo = join(dir, "repo");
		mkdirSync(repo);
		writeFileSync(join(dir, "gh.cjs"), FAKE);
		writeFileSync(join(dir, "state.json"), JSON.stringify({ registered, pinBranch, openPr, card }));
		writeFileSync(join(dir, "log"), "");
		execFileSync("git", ["init", "-q"], { cwd: repo });
		for (const g of games) {
			mkdirSync(join(repo, g, ".."), { recursive: true });
			writeFileSync(join(repo, g), "{}");
		}
		writeFileSync(join(repo, "mygame.json"), "{}"); // not a game.json
		execFileSync("git", ["add", "-A"], { cwd: repo });
		const r = spawnSync("bash", ["-c", `gh() { node "$FAKE_GH" "$@"; }\n${script}`], {
			cwd: repo,
			encoding: "utf8",
			env: {
				...process.env, // HOME too: without it a login profile may rebuild PATH
				FAKE_GH: join(dir, "gh.cjs"),
				FAKE_STATE: join(dir, "state.json"),
				FAKE_LOG: join(dir, "log"),
				GH_TOKEN: token,
				ARCADE: "lokeshmohanty/games",
				REPO: `ada/${repoName}`,
				SHA: HEAD,
				BRANCH: branch,
				DEFAULT_BRANCH: "main",
			},
		});
		const calls = readFileSync(join(dir, "log"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
		const decode = (c) => (c ? JSON.parse(Buffer.from(c.f.content, "base64").toString("utf8")) : null);
		const put = calls.find((c) => c.method === "PUT" && c.path.endsWith("/minis.json"));
		const cardPut = calls.find((c) => c.method === "PUT" && c.path.endsWith("/main.json"));
		return { status: r.status, out: r.stdout + r.stderr, calls, put, file: decode(put), card: decode(cardPut), cardPut, pr: calls.find((c) => c.method === "POST" && c.path.endsWith("/pulls")) };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

console.log("\npropose workflow: a repo not registered yet");
let r = run();
check("it succeeds", r.status === 0, r.out);
check("the registry file names the repo, the branch it was pushed to, the commit, and the game at the top as \".\"", JSON.stringify(r.file) === JSON.stringify({ repo: "https://github.com/ada/minis", branch: "arcade-v2", commit: HEAD, games: ["."] }), r.file);
check("…written on a branch of the contributor's fork made from the arcade's main", r.put?.f.branch === "arcade-pin/minis" && r.calls.some((c) => c.method === "POST" && c.path === "repos/ada/games-1/git/refs" && c.f.sha === "m".repeat(40)), r.calls);
check("…and the pull request is opened from it, as an Add", r.pr?.f.head === "ada:arcade-pin/minis" && r.pr.f.base === "main" && r.pr.f.title.startsWith("Add ada/minis"), r.pr);
r = run({ branch: "main", games: ["chess/game.json", "go/game.json"] });
check("pushed to the default branch: no \"branch\", and every folder with a game.json", JSON.stringify(r.file) === JSON.stringify({ repo: "https://github.com/ada/minis", commit: HEAD, games: ["chess", "go"] }), r.file);

console.log("\npropose workflow: a registered repo");
const pinned = { repo: "https://github.com/ada/minis", branch: "arcade-v2", commit: "a".repeat(40), games: ["."] };
r = run({ registered: { ...pinned, games: ["kept"] }, pinBranch: true });
check("an update keeps the pin's games and moves its commit, as an Update", r.status === 0 && r.file?.commit === HEAD && JSON.stringify(r.file.games) === '["kept"]' && r.pr?.f.title.startsWith("Update"), { file: r.file, pr: r.pr, out: r.out });
check("…resetting its fork branch onto the arcade's main, and replacing the file there", r.calls.some((c) => c.method === "PATCH" && c.f.force === "true") && r.put?.f.sha === "f".repeat(40), r.calls);
r = run({ registered: pinned, pinBranch: true, openPr: "https://github.com/lokeshmohanty/games/pull/7" });
check("with its pull request open, a push moves that one along — no second", r.status === 0 && !r.pr && r.put && r.out.includes("pull/7"), r.out);
r = run({ registered: { ...pinned, commit: HEAD } });
check("already pinned at the commit pushed: nothing is done", r.status === 0 && !r.calls.some((c) => c.method !== "GET"), r.calls);

console.log("\npropose workflow: what stops it");
r = run({ token: "" });
check("no ARCADE_TOKEN secret: fails, saying to add it, and asks GitHub nothing", r.status !== 0 && r.out.includes("ARCADE_TOKEN") && !r.calls.length, r.out);
r = run({ games: ["README.md"] });
check("no game.json in the commit: fails before forking", r.status !== 0 && r.out.includes("No game.json") && !r.calls.some((c) => c.path.endsWith("/forks")), r.out);

r = run({ repoName: "main" });
check("a repo called main (the card's name): fails, saying why, and asks GitHub nothing", r.status !== 0 && r.out.includes("cannot be registered") && !r.calls.length, r.out);

console.log("\npropose workflow: the contributor's card (registry/<owner>/main.json)");
r = run({ card: null });
check("an owner with no card gets one from their GitHub profile, in the same pull request", r.status === 0 && JSON.stringify(r.card) === JSON.stringify({ name: "Ada Lovelace", bio: "Small games.", links: [{ label: "Website", url: "https://ada.dev" }] }) && r.cardPut.f.branch === "arcade-pin/minis" && !!r.pr, { card: r.card, out: r.out });
r = run();
check("an owner who has one keeps it: no card is written", r.status === 0 && !r.cardPut && !!r.put, r.calls);

console.log(failures ? `\n${failures} propose workflow check(s) failed` : "\nall propose workflow checks passed");
process.exit(failures ? 1 : 0);
