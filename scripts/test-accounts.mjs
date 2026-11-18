// scripts/test-accounts.mjs — the account API (worker/api/) end to end, under
// `wrangler dev` with a throwaway local D1, against a fake GitHub and Google
// (one node server playing OAuth, the GitHub App, GraphQL and the Git Data
// API). Every rule in docs/accounts.md that can be checked from outside is.
//
// Needs wrangler (see scripts/wrangler.mjs); skips with a message without it.

import { generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { BOTS } from "../worker/api/bots.js";
import { GROUP_MATCHES_SQL, GROUP_REPLAY, GROUP_SCAN } from "../worker/api/lb.js";
import { ELO_K, ELO_K_PROVISIONAL, PROVISIONAL_GAMES, ratingDeltas, sideDeltas, toAccounts } from "../worker/api/match.js";
import * as SU from "../worker/api/sudoku.js";
import { freePort, startWrangler } from "./wrangler.mjs";

let failures = 0;
const check = (label, ok, detail = "") => {
	console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
	if (!ok) failures++;
};

// ------------------------------------------------------- the rating, pure

console.log("\naccounts: the rating (worker/api/match.js ratingDeltas), no server");
{
	const est = (elo) => ({ elo, rated: PROVISIONAL_GAMES }); // established: K 32
	const near = (x, y) => Math.abs(x - y) < 1e-9;
	let d = ratingDeltas("duel", [["a"], ["b"]], new Map([["a", est(1200)], ["b", est(1200)]]));
	check("a duel between equals, established: plain Elo, ±K/2", near(d.get("a"), ELO_K / 2) && near(d.get("b"), -ELO_K / 2), [...d]);
	d = ratingDeltas("duel", [["a"], ["b"]], new Map());
	check(`new players are provisional: K ${ELO_K_PROVISIONAL} for their first ${PROVISIONAL_GAMES} rated games`, near(d.get("a"), ELO_K_PROVISIONAL / 2), [...d]);
	const strong = ratingDeltas("ffa", [["a"], ["s"], ["w"]], new Map([["a", est(1200)], ["s", est(1500)], ["w", est(1200)]]));
	const weak = ratingDeltas("ffa", [["a"], ["s"], ["w"]], new Map([["a", est(1200)], ["s", est(1200)], ["w", est(1200)]]));
	check("free-for-all: beating a stronger player counts more", strong.get("a") > weak.get("a"), { strong: strong.get("a"), weak: weak.get("a") });
	check("…first gains, last loses, and the middle of equals stays put", weak.get("a") > 0 && weak.get("w") < 0 && near(weak.get("s"), 0), [...weak]);
	const g = ratingDeltas("ffa", [[], ["a"], ["b"]], new Map([["a", est(1200)], ["b", est(1200)]]));
	check("…a guest's place (empty) rates nobody: second behind a guest still beat third", near(g.get("a"), ELO_K / 2) && near(g.get("b"), -ELO_K / 2), [...g]);
	const t = ratingDeltas("teams", [["a", "b"], ["c", "d"]], new Map(["a", "b", "c", "d"].map((x) => [x, est(1200)])));
	check("teams: each side moves as one, at its mean", near(t.get("a"), ELO_K / 2) && near(t.get("b"), ELO_K / 2) && near(t.get("c"), -ELO_K / 2), [...t]);
	const tie = ratingDeltas("ffa", [["a", "b"]], new Map([["a", est(1200)], ["b", est(1200)]]));
	check("a draw between equals moves nobody", near(tie.get("a"), 0) && near(tie.get("b"), 0), [...tie]);
	const r = toAccounts({ kind: "ffa", ranking: [["g"], ["pa"], ["pb"]], roster: { pa: "A", pb: "B" } });
	check("guests drop out, their place kept: [[], [A], [B]]", JSON.stringify(r.places) === JSON.stringify([[], ["A"], ["B"]]), r.places);
	const l = toAccounts({ kind: "duel", ranking: [["pa"], ["pb"]], roster: { pa: "A", pb: "B" }, left: ["pb"] });
	check("a player who left goes to a last place of their own", JSON.stringify(l.places) === JSON.stringify([["A"], ["B"]]) && l.departed.join() === "B", l);
	const l2 = toAccounts({ kind: "ffa", ranking: [["pb"], ["pa"]], roster: { pa: "A", pb: "B" }, left: ["pb"] });
	check("…even when the game had them ahead: leaving forfeits", JSON.stringify(l2.places) === JSON.stringify([["A"], ["B"]]), l2.places);
	const l3 = toAccounts({ kind: "ffa", ranking: [["g"], ["pb"], ["pa"]], roster: { pa: "A", pb: "B" }, left: ["pb"] });
	check("…while a guest's place stays", JSON.stringify(l3.places) === JSON.stringify([[], ["A"], ["B"]]), l3.places);
	// An emptied side keeps an empty slot (the devices' stats read it): with
	// the leaver rule it goes, so the one who stayed wins the forfeit.
	const ro = { host: "H", a2: "A2", b1: "B1", b2: "B2" };
	const tm = { host: "A", a2: "A", b1: "B", b2: "B" };
	const one = toAccounts({ kind: "duel", ranking: [[], ["host"]], roster: ro, left: ["b1"] });
	check("1v1, the leaver's side was ahead and is now an empty slot: [[H], [B1]]", JSON.stringify(one.places) === JSON.stringify([["H"], ["B1"]]), one.places);
	const oneT = toAccounts({ kind: "teams", ranking: [[], ["host"]], roster: ro, left: ["b1"], teams: tm });
	const dOne = sideDeltas(oneT.sides, oneT.forfeits, new Map());
	check("…the same as teams of one: a forfeit win for the one who stayed", JSON.stringify(oneT.places) === JSON.stringify([["H"], ["B1"]]) && dOne.get("H") > 0 && dOne.get("B1") < 0, { places: oneT.places, d: [...dOne] });
	// 2v2, B2 leaves (the game drops them), team A ahead: B2 is booked with
	// their own side, B1 is not rated against their teammate.
	const ahead = toAccounts({ kind: "teams", ranking: [["host", "a2"], ["b1"]], roster: ro, left: ["b2"], teams: tm });
	const dA = sideDeltas(ahead.sides, ahead.forfeits, new Map());
	check("2v2, one leaver, A ahead: [[A2, H], [B1, B2]] — no third side", JSON.stringify(ahead.places) === JSON.stringify([["A2", "H"], ["B1", "B2"]]), ahead.places);
	check("…B1 loses to team A only, sized as the two it began with: −K/2, not the whole side's −1.5 × that", Math.abs(dA.get("B1") + ELO_K_PROVISIONAL / 2) < 1e-9 && dA.get("B2") < 0 && dA.get("H") > 0, [...dA]);
	check("…and the four changes sum to zero", Math.abs(dA.get("B1") + dA.get("B2") + dA.get("H") + dA.get("A2")) < 1e-9, [...dA]);
	const uneven = ratingDeltas("teams", [["a", "b", "c"], ["d"]], new Map(["a", "b", "c", "d"].map((x) => [x, est(1200)])));
	check("teams of 3 against 1: zero-sum, each of the three a third of the one's loss", Math.abs([...uneven.values()].reduce((x, y) => x + y, 0)) < 1e-9 && Math.abs(uneven.get("a") * 3 + uneven.get("d")) < 1e-9 && uneven.get("d") < 0, [...uneven]);
	const lone = ratingDeltas("teams", [["a"], ["b", "c", "d", "e", "f", "g", "h"]], new Map());
	check("1 against 7: the one's swing is capped at 2 × their share (never past K)", Math.abs(lone.get("a")) <= ELO_K_PROVISIONAL + 1e-9 && lone.get("a") > 0, [...lone]);
	// The same in a draw: the others' draw stays a draw; only the leaver loses.
	const drawn = toAccounts({ kind: "teams", ranking: [["host", "a2", "b1", "b2"]], roster: ro, left: ["b2"], teams: tm });
	const dT = sideDeltas(drawn.sides, drawn.forfeits, new Map());
	check("2v2 drawn, one leaver: still one place (a draw, no wins)", drawn.places.length === 1, drawn.places);
	check("…nobody still there moves, the leaver alone loses", Math.abs(dT.get("H")) < 1e-9 && Math.abs(dT.get("A2")) < 1e-9 && Math.abs(dT.get("B1")) < 1e-9 && dT.get("B2") < 0, [...dT]);
	const won = toAccounts({ kind: "teams", ranking: [["b1"], ["host", "a2"]], roster: ro, left: ["b2"], teams: tm });
	check("2v2, the leaver's side won: the leaver alone goes last, the side still wins", JSON.stringify(won.places) === JSON.stringify([["B1"], ["A2", "H"], ["B2"]]), won.places);
}

// ------------------------------------------------------------- fake GitHub

const fake = { treePosts: [], discussions: new Map(), comments: [], authors: [], commits: [], refs: new Map(), trees: new Map(), graphql: 0, refreshed: 0, ghUser: { id: 42, login: "octo", name: "Octo Cat" } };
const fakePort = await freePort();
const FAKE = `http://127.0.0.1:${fakePort}`;
const server = createServer(async (req, res) => {
	const url = new URL(req.url, FAKE);
	let raw = "";
	for await (const chunk of req) raw += chunk;
	const send = (status, obj, headers = {}) => {
		res.writeHead(status, { "Content-Type": "application/json", ...headers });
		res.end(obj === undefined ? "" : JSON.stringify(obj));
	};
	const p = url.pathname;
	// OAuth: the consent page says yes at once.
	if (p === "/login/oauth/authorize" || p === "/g/auth") {
		const back = new URL(url.searchParams.get("redirect_uri"));
		back.searchParams.set("state", url.searchParams.get("state"));
		if (url.searchParams.get("client_id") !== "decline") back.searchParams.set("code", p === "/g/auth" ? "g-code" : "gh-code");
		return send(302, undefined, { Location: back.href });
	}
	if (p === "/login/oauth/access_token" || p === "/g/token") {
		const form = new URLSearchParams(raw);
		// A GitHub App's user tokens expire and come with a refresh token.
		if (form.get("grant_type") === "refresh_token") {
			fake.refreshed++;
			const who = (form.get("refresh_token") ?? "").replace(/^rt-/, "");
			return form.get("client_id") === "app-client" ? send(200, { access_token: `ut-${who}`, expires_in: 28800, refresh_token: `rt-${who}` }) : send(400, { error: "bad_client" });
		}
		const ok = form.get("code") === (p === "/g/token" ? "g-code" : "gh-code") && form.get("client_secret");
		if (!ok) return send(400, { error: "bad_verification_code" });
		if (p === "/g/token") return send(200, { access_token: "g-tok" });
		return send(200, { access_token: `ut-${fake.ghUser.login}`, expires_in: 28800, refresh_token: `rt-${fake.ghUser.login}` });
	}
	if (p === "/user") {
		return req.headers.authorization === `Bearer ut-${fake.ghUser.login}`
			? send(200, { ...fake.ghUser, avatar_url: `https://avatars.example/${fake.ghUser.id}` })
			: send(401, {});
	}
	if (p === "/g/userinfo") return req.headers.authorization === "Bearer g-tok" ? send(200, { sub: "g-1", name: "Goo Gle", picture: "https://pics.example/g1" }) : send(401, {});
	// The GitHub App.
	if (p === "/repos/lokeshmohanty/games/installation") {
		const jwt = (req.headers.authorization ?? "").split(" ")[1] ?? "";
		fake.jwtParts = jwt.split(".").length;
		return send(200, { id: 7 });
	}
	if (p === "/app/installations/7/access_tokens") return send(201, { token: "inst-token", expires_at: new Date(Date.now() + 3600e3).toISOString() });
	if (p === "/graphql") {
		fake.graphql++;
		const auth = req.headers.authorization ?? "";
		// The App (inst-token) opens threads and reads; a player's user token
		// (ut-<login>) comments — as that player.
		const asUser = auth.startsWith("Bearer ut-") ? auth.slice("Bearer ut-".length) : null;
		if (auth !== "Bearer inst-token" && !asUser) return send(401, { message: "bad token" });
		const { query, variables } = JSON.parse(raw);
		if (asUser && !query.includes("addDiscussionComment")) return send(403, { message: "a user token only comments here" });
		if (query.includes("discussionCategories")) return send(200, { data: { repository: { id: "R1", discussionCategories: { nodes: [{ id: "C1", name: "Game feedback" }] } } } });
		if (query.includes("createDiscussion")) {
			const id = `D${fake.discussions.size + 1}`;
			fake.discussions.set(id, { ...variables, comments: [] });
			return send(200, { data: { createDiscussion: { discussion: { id, url: `https://github.com/lokeshmohanty/games/discussions/${id}` } } } });
		}
		if (query.includes("addDiscussionComment")) {
			if (!asUser) return send(403, { message: "comments come from players, not the App" });
			fake.discussions.get(variables.id).comments.push({ body: variables.body, createdAt: new Date().toISOString(), author: { login: asUser } });
			fake.comments.push(variables.body);
			fake.authors.push(asUser);
			return send(200, { data: { addDiscussionComment: { comment: { url: "https://github.com/c/1" } } } });
		}
		if (query.includes("node(id")) {
			const d = fake.discussions.get(variables.id);
			return send(200, { data: { node: { url: `https://github.com/d/${variables.id}`, comments: { nodes: d?.comments ?? [] } } } });
		}
		return send(400, { errors: [{ message: "unknown query" }] });
	}
	// The Git Data API, for the snapshot.
	const git = p.match(/^\/repos\/lokeshmohanty\/games\/git\/(.+)$/)?.[1];
	if (git) {
		if (req.method === "GET" && git.startsWith("ref/heads/")) {
			const sha = fake.refs.get(git.slice(4));
			return sha ? send(200, { object: { sha } }) : send(404, { message: "Not Found" });
		}
		if (req.method === "GET" && git.startsWith("commits/")) {
			const c = fake.commits.find((x) => x.sha === git.slice(8));
			return c ? send(200, { sha: c.sha, tree: { sha: c.tree } }) : send(404, { message: "Not Found" });
		}
		const b = raw ? JSON.parse(raw) : {};
		if (git === "trees") {
			// base_tree: the files not sent stay; `sha: null` deletes one.
			const sha = `t${fake.trees.size + 1}`;
			const files = new Map((b.base_tree ? fake.trees.get(b.base_tree) ?? [] : []).map((x) => [x.path, x]));
			for (const x of b.tree) x.sha === null ? files.delete(x.path) : files.set(x.path, x);
			fake.trees.set(sha, [...files.values()]);
			fake.treePosts.push(b);
			return send(201, { sha });
		}
		if (git === "commits") {
			const sha = `c${fake.commits.length + 1}`;
			fake.commits.push({ sha, ...b });
			return send(201, { sha });
		}
		if (git === "refs") {
			fake.refs.set(b.ref.replace("refs/", ""), b.sha);
			return send(201, {});
		}
		if (git.startsWith("refs/heads/")) {
			fake.refs.set(git.slice(5), b.sha);
			return send(200, {});
		}
	}
	send(404, { message: "Not Found" });
});
await new Promise((r) => server.listen(fakePort, "127.0.0.1", r));

// ------------------------------------------------------------- the Worker

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const w = await startWrangler({
	AUTH_TEST: "1",
	SESSION_KEY: "test-session-key-0123456789",
	LB_MIN_GAMES: "1",
	// A match waits this long for everyone named in it (45 s deployed).
	MATCH_GRACE_MS: "3000",
	// A seated page beats every 2 min deployed; a departure needs 3 min without (here 2 s).
	MATCH_STALE_MS: "2000",
	// A beat writes its row at most every 30 s deployed (here 0.5 s, under the 2 s above).
	MATCH_BEAT_WRITE_MS: "500",
	SOLO_PER_DAY: "8",
	BOTS_PER_DAY: "3",
	// Small caps and a short invite life, so the tests can reach them.
	FRIENDS_MAX: "3",
	GROUPS_MAX: "2",
	INVITE_TTL_MS: "4000",
	GH_APP_CLIENT_ID: "app-client",
	GH_APP_CLIENT_SECRET: "app-secret",
	GITHUB_OAUTH_URL: FAKE,
	GITHUB_API: FAKE,
	GOOGLE_CLIENT_ID: "g-client",
	GOOGLE_CLIENT_SECRET: "g-secret",
	GOOGLE_AUTH_URL: `${FAKE}/g/auth`,
	GOOGLE_TOKEN_URL: `${FAKE}/g/token`,
	GOOGLE_USERINFO_URL: `${FAKE}/g/userinfo`,
	GH_APP_ID: "123",
	GH_APP_KEY: privateKey.replace(/\n/g, "\\n"),
});
if (!w) {
	server.close();
	process.exit(0);
}
const B = w.base;
const SITE = "http://127.0.0.1:8000";
let ipN = 0;
const freshIp = () => `10.20.${Math.floor(++ipN / 250)}.${ipN % 250}`;

/** One API call: { status, body, headers }. */
async function call(method, path, { token, body, origin = SITE, ip = freshIp(), headers = {} } = {}) {
	const res = await fetch(B + path, {
		method,
		redirect: "manual",
		headers: {
			Origin: origin,
			"CF-Connecting-IP": ip,
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			...(body ? { "Content-Type": "application/json" } : {}),
			...headers,
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	const text = await res.text();
	let parsed = text;
	try {
		parsed = JSON.parse(text);
	} catch {}
	return { status: res.status, body: parsed, headers: res.headers };
}

/** Follow redirects by hand, through the fake provider, back to the site. */
async function walk(url) {
	for (let i = 0; i < 6; i++) {
		if (url.startsWith(SITE)) return url;
		const res = await fetch(url, { redirect: "manual" });
		const next = res.headers.get("location");
		if (!next) return `${res.status} ${await res.text()}`;
		url = new URL(next, url).href;
	}
	return url;
}
const tokenOf = (url) => new URL(url).hash.match(/token=([^&]+)/)?.[1] ?? null;
const testLogin = async (name, extra = "") => tokenOf(await walk(`${B}/auth/test?name=${encodeURIComponent(name)}${extra}&back=${encodeURIComponent(SITE + "/?page=profile")}`));

try {
	console.log("\naccounts: CORS");
	{
		const pre = await fetch(B + "/api/me", { method: "OPTIONS", headers: { Origin: SITE, "Access-Control-Request-Headers": "authorization" } });
		check("a preflight from the arcade is answered with its origin", pre.status === 204 && pre.headers.get("access-control-allow-origin") === SITE);
		check("…and allows the Authorization header", /authorization/i.test(pre.headers.get("access-control-allow-headers") ?? ""));
		const pub = await call("GET", "/api/stats/summary", { origin: "https://anyone.example" });
		check("public reads are open to every origin", pub.headers.get("access-control-allow-origin") === "*" || pub.headers.get("access-control-allow-origin") === "https://anyone.example");
	}

	console.log("\naccounts: signing in with GitHub and Google");
	{
		const back = encodeURIComponent(`${SITE}/?page=profile&x=1`);
		const ghUrl = await walk(`${B}/auth/github/start?back=${back}`);
		const gh = tokenOf(ghUrl);
		check("GitHub: consent → callback → back to the page with a token", !!gh && ghUrl.startsWith(`${SITE}/?page=profile&x=1#token=`), ghUrl);
		const me = await call("GET", "/api/me", { token: gh });
		check("…as the GitHub profile's name and avatar", me.body.name === "Octo Cat" && me.body.avatar === "https://avatars.example/42" && me.body.provider === "github", me.body);
		const again = tokenOf(await walk(`${B}/auth/github/start?back=${back}`));
		check("signing in again is the same account", (await call("GET", "/api/me", { token: again })).body.id === me.body.id);
		const g = tokenOf(await walk(`${B}/auth/google/start?back=${back}`));
		const gme = await call("GET", "/api/me", { token: g });
		check("Google: the same flow, a different account", gme.body.name === "Goo Gle" && gme.body.provider === "google" && gme.body.id !== me.body.id, gme.body);
		// One account, both sign-ins: connect GitHub to the Google account.
		const linkTo = async (token, provider) => walk((await call("POST", `/api/me/link/${provider}`, { token, body: { back: `${SITE}/?page=profile` } })).body.url);
		let landed = await linkTo(g, "github");
		check("connecting a GitHub account another arcade account has is refused, and says so", landed.endsWith("#signin=taken&provider=github"), landed);
		fake.ghUser = { id: 77, login: "goo-gh", name: "Goo on GitHub" };
		landed = await linkTo(g, "github");
		check("connecting a new GitHub account to the Google one", landed.endsWith("#connected=github"), landed);
		const both = await call("GET", "/api/me", { token: g });
		check("…the account now has both sign-ins, GitHub's login with it", JSON.stringify(both.body.identities.map((i) => [i.provider, i.login])) === JSON.stringify([["google", null], ["github", "goo-gh"]]), both.body.identities);
		const viaGh = tokenOf(await walk(`${B}/auth/github/start?back=${back}`));
		check("…and signing in with that GitHub is the same account", (await call("GET", "/api/me", { token: viaGh })).body.id === gme.body.id);
		check("a connect link without a sign-in is refused", (await call("POST", "/api/me/link/github", { body: { back: SITE } })).status === 401);
		fake.ghUser = { id: 42, login: "octo", name: "Octo Cat" };
		const open = await fetch(`${B}/auth/github/start?back=${encodeURIComponent("https://evil.example/")}`, { redirect: "manual" });
		check("a back page off the arcade is refused (no open redirect)", open.status === 400);
		const forged = await fetch(`${B}/auth/github/callback?code=gh-code&state=${encodeURIComponent(btoa(JSON.stringify({ back: SITE, provider: "github", exp: Date.now() + 1e6 })) + ".nope")}`, { redirect: "manual" });
		check("a callback with a state the server did not sign is refused", forged.status === 400);
		const remote = await fetch(`${B.replace("127.0.0.1", "localhost")}/auth/test?name=x&back=${encodeURIComponent(SITE)}`, { redirect: "manual" });
		check("the test sign-in answers on loopback only (here: localhost too)", remote.status === 302);
		check("no token: 401", (await call("GET", "/api/me")).status === 401);
		check("a forged token: 401", (await call("GET", "/api/me", { token: "abc.def" })).status === 401);
		await call("POST", "/api/me/signout", { token: again });
		check("signing out ends that session", (await call("GET", "/api/me", { token: again })).status === 401);
		check("…and only that one", (await call("GET", "/api/me", { token: gh })).status === 200);
	}

	const ana = await testLogin("Ana");
	const bo = await testLogin("Bo");
	const cy = await testLogin("Cy");
	const id = async (t) => (await call("GET", "/api/me", { token: t })).body.id;
	const [A, Bo, C] = [await id(ana), await id(bo), await id(cy)];

	console.log("\naccounts: profile and favourites");
	{
		const evil = await call("GET", "/api/me", { token: ana, origin: "https://evil.example" });
		check("another site cannot read a signed-in answer", evil.headers.get("access-control-allow-origin") === "null", evil.headers.get("access-control-allow-origin"));
		const r = await call("PATCH", "/api/me", { token: ana, body: { name: "  Ana P  " } });
		check("a name is trimmed and saved", r.body.name === "Ana P", r.body);
		check("an empty name is refused", (await call("PATCH", "/api/me", { token: ana, body: { name: "  " } })).status === 400);
		check("a 25-character name is refused", (await call("PATCH", "/api/me", { token: ana, body: { name: "x".repeat(25) } })).status === 400);
		const f = await call("PUT", "/api/me/favs", { token: ana, body: { favs: ["connect4", "lokeshmohanty/battleship", "connect4"] } });
		check("favourites are kept, without duplicates", JSON.stringify(f.body.favs) === JSON.stringify(["connect4", "lokeshmohanty/battleship"]), f.body);
		check("a favourite that is not a game id is refused", (await call("PUT", "/api/me/favs", { token: ana, body: { favs: ["../etc"] } })).status === 400);
		check("a dev-kit game is not a game id here", (await call("PUT", "/api/me/favs", { token: ana, body: { favs: ["dev/x"] } })).status === 400);
		const cf = await call("PUT", "/api/me/favs", { token: ana, body: { favs: ["connect4", "lokeshmohanty/battleship", "contributor:ada", "collection:ada/minis.v2"] } });
		check("a contributor and a collection are favourites too", cf.status === 200 && cf.body.favs.includes("contributor:ada") && cf.body.favs.includes("collection:ada/minis.v2"), cf.body);
		check("…but not a malformed one", (await call("PUT", "/api/me/favs", { token: ana, body: { favs: ["collection:ada/.."] } })).status === 400 && (await call("PUT", "/api/me/favs", { token: ana, body: { favs: ["contributor:a/b"] } })).status === 400);
		await call("PUT", "/api/me/favs", { token: ana, body: { favs: ["connect4", "lokeshmohanty/battleship"] } });
	}

	console.log("\naccounts: play counts");
	{
		for (let i = 0; i < 3; i++) await call("POST", "/api/stats/played", { body: { game: "connect4", bots: i === 0 } });
		const s = await call("GET", "/api/stats/summary");
		check("the host's count lands, no sign-in needed", s.body.games.connect4?.played === 3, s.body);
		check("…and the summary may be cached for five minutes", /max-age=300/.test(s.headers.get("cache-control") ?? ""));
	}

	console.log("\naccounts: confirmed matches");
	const duel = (run, winner, loser, extra = {}) => ({
		game: "lokeshmohanty/battleship",
		run,
		match: 1,
		kind: "duel",
		ranking: [[winner], [loser]],
		roster: { pa: A, pb: Bo, pc: C },
		...extra,
	});
	{
		let r = await call("POST", "/api/match/report", { token: ana, body: duel("run1", "pa", "pb") });
		check("one report waits for a second", r.body.pending === true && !r.body.counted, r.body);
		r = await call("POST", "/api/match/report", { token: bo, body: duel("run1", "pa", "pb") });
		check("the other player's matching report counts it", r.body.counted === true, r.body);
		r = await call("POST", "/api/match/report", { token: ana, body: duel("run1", "pa", "pb") });
		check("…once", r.body.already === true, r.body);
		const mine = await call("GET", "/api/me/matches", { token: ana });
		const rating = mine.body.ratings.find((x) => x.game === "lokeshmohanty/battleship");
		check("the winner's Elo goes up from 1200, games and wins counted", rating?.elo > 1200 && rating.games === 1 && rating.wins === 1, rating);
		check("…and the match is in the history, with names", mine.body.matches[0]?.won === true && mine.body.matches[0].ranking[1][0].name === "Bo", mine.body.matches[0]);
		const boR = (await call("GET", "/api/me/matches", { token: bo })).body.ratings.find((x) => x.game === "lokeshmohanty/battleship");
		check("the loser's goes down by as much", Math.abs(boR.elo - 1200 + (rating.elo - 1200)) < 1e-6 && boR.wins === 0, boR);

		await call("POST", "/api/match/report", { token: ana, body: duel("run2", "pa", "pb") });
		r = await call("POST", "/api/match/report", { token: bo, body: duel("run2", "pb", "pa") });
		check("two players who disagree void the match", r.body.counted === false && /disagree/.test(r.body.why), r.body);
		r = await call("POST", "/api/match/report", { token: ana, body: duel("run2", "pa", "pb") });
		check("…for good", r.body.counted === false, r.body);
		r = await call("POST", "/api/match/report", { token: ana, body: { ...duel("run3", "pa", "bot_x"), roster: { pa: A } } });
		check("a match with a bot is never ranked", r.body.counted === false && /bots/.test(r.body.why), r.body);
		r = await call("POST", "/api/match/report", { token: ana, body: { ...duel("run4", "pa", "anon"), roster: { pa: A } } });
		check("nor one with a single signed-in player", r.body.counted === false && /two signed-in/.test(r.body.why), r.body);
		r = await call("POST", "/api/match/report", { token: cy, body: duel("run5", "pa", "pb") });
		check("you cannot report a match you did not play", r.status === 400, r.body);
		r = await call("POST", "/api/match/report", { token: ana, body: { ...duel("run6", "pa", "pb"), roster: { pa: A, pb: A } } });
		check("one account cannot play both seats", r.status === 400, r.body);
		r = await call("POST", "/api/match/report", { token: ana, body: { ...duel("run7", "pa", "pb"), kind: "local" } });
		check("one-phone games are not ranked", r.body.counted === false, r.body);
		r = await call("POST", "/api/match/report", { token: ana, body: { ...duel("run8", "pa", "pb"), game: "dev/mine" } });
		check("a dev-kit game is not ranked", r.status === 400, r.body);

		// A rematch in the same run is a new match.
		await call("POST", "/api/match/report", { token: ana, body: duel("run1", "pb", "pa", { match: 2 }) });
		r = await call("POST", "/api/match/report", { token: bo, body: duel("run1", "pb", "pa", { match: 2 }) });
		check("a rematch in the same run counts on its own", r.body.counted === true, r.body);

		// Free-for-all and co-op.
		const ffa = { game: "neon-bid", run: "f1", match: 1, kind: "ffa", ranking: [["pa", "pc"], ["pb"]], roster: { pa: A, pb: Bo, pc: C } };
		await call("POST", "/api/match/report", { token: cy, body: ffa });
		r = await call("POST", "/api/match/report", { token: bo, body: ffa });
		check("two of three agreeing wait for the third, who is named in it", r.body.pending === true && !r.body.counted, r.body);
		r = await call("POST", "/api/match/report", { token: ana, body: ffa });
		check("…and count at once when every named player agreed; a shared first place is a win for both", r.body.counted === true, r.body);
		check("…the answer carries the reporter's new rating and its change", r.body.rating?.delta > 0 && r.body.rating.elo === 1200 + r.body.rating.delta && r.body.rating.provisional === true && r.body.rating.rated === 1, r.body.rating);
		const coop = { game: "neon-survival-mp", run: "s1", match: 1, kind: "coop", ranking: [["pa", "pb"]], roster: { pa: A, pb: Bo }, scores: { pa: 33, pb: 33 } };
		await call("POST", "/api/match/report", { token: ana, body: coop });
		await call("POST", "/api/match/report", { token: bo, body: coop });
		const surv = (await call("GET", "/api/me/matches", { token: ana })).body.ratings.find((x) => x.game === "neon-survival-mp");
		check("co-op keeps the best score, and is never a win", surv?.best === 33 && surv.wins === 0, surv);
	}

	console.log("\naccounts: leaderboards");
	{
		let lb = await call("GET", "/api/lb/lokeshmohanty/battleship");
		check("global: ranked by Elo", lb.body.kind === "duel" && lb.body.rows.length === 2 && lb.body.rows[0].elo >= lb.body.rows[1].elo, lb.body);
		check("…public, cacheable for a minute", lb.headers.get("access-control-allow-origin") && /max-age=60/.test(lb.headers.get("cache-control") ?? ""));
		const nb = await call("GET", "/api/lb/neon-bid");
		check("free-for-all: by rating, wins still shown", nb.body.kind === "ffa" && nb.body.rows.filter((r) => r.wins === 1).length === 2 && nb.body.rows.at(-1).wins === 0 && nb.body.rows[0].elo > 1200 && nb.body.rows.at(-1).elo < 1200, nb.body.rows);
		check("…each row provisional, with its rated games", nb.body.rows.every((r) => r.provisional === true && r.rated === 1 && r.best === null), nb.body.rows);
		const mine = await call("GET", "/api/lb/lokeshmohanty/battleship?me=1", { token: ana });
		const listed = mine.body.rows.find((r) => r.id === A);
		check("?me=1: where you stand, the same as your row", mine.body.me?.id === A && mine.body.me.rank === listed?.rank, mine.body.me);
		check("…and not publicly cached", !/public/.test(mine.headers.get("cache-control") ?? ""), mine.headers.get("cache-control"));
		check("…needs a sign-in", (await call("GET", "/api/lb/lokeshmohanty/battleship?me=1")).status === 401);
		check("…null when you have no ranked game of it", (await call("GET", "/api/lb/lokeshmohanty/battleship?me=1", { token: cy })).body.me === null);
		await call("PATCH", "/api/me", { token: bo, body: { hidePublic: true } });
		const hidden = await call("GET", "/api/lb/lokeshmohanty/battleship?me=1", { token: bo });
		check("…hidden from public boards: no rank, and says why", hidden.body.me?.rank === null && hidden.body.me.hidden === true, hidden.body.me);
		lb = await call("GET", "/api/lb/lokeshmohanty/battleship");
		check("hide me from public leaderboards: gone from the global board", !lb.body.rows.some((r) => r.id === Bo), lb.body.rows);
		const minimal = await call("GET", `/api/u/${Bo}`);
		check("…and the public profile is down to a name to befriend: no ratings, no matches", minimal.status === 200 && minimal.body.hidden === true && minimal.body.id === Bo && minimal.body.ratings === undefined && minimal.body.matches === undefined, minimal.body);
		await call("PATCH", "/api/me", { token: bo, body: { hidePublic: false } });
		const prof = await call("GET", `/api/u/${A}`);
		check("a public profile: name, ratings, recent matches", prof.body.name === "Ana P" && prof.body.ratings.length >= 2 && prof.body.matches.length >= 2, prof.body);
		check("friends' board needs a sign-in", (await call("GET", "/api/lb/lokeshmohanty/battleship?scope=friends")).status === 401);
		const fr = await call("GET", "/api/lb/lokeshmohanty/battleship?scope=friends", { token: cy });
		check("…and holds only you and your friends", fr.body.rows.length === 0, fr.body.rows);
	}

	const grace = () => new Promise((r) => setTimeout(r, 3300)); // MATCH_GRACE_MS is 3000 here
	const report = (token, body) => call("POST", "/api/match/report", { token, body });
	const matchesOfTok = async (token) => (await call("GET", "/api/me/matches", { token })).body;
	const ratingIn = async (token, game) => (await matchesOfTok(token)).ratings.find((x) => x.game === game);

	console.log("\naccounts: a match counts only for the accounts that reported it");
	{
		// The audit's repro (2026-11-15): two colluding accounts report a match
		// naming a third, whose id is public, who never played it.
		const mal = await testLogin("Mal");
		const mae = await testLogin("Mae");
		const vic = await testLogin("Vic");
		const [M1, M2, V] = [await id(mal), await id(mae), await id(vic)];
		const fake = { game: "neon-bid", run: "col1", match: 1, kind: "ffa", ranking: [["p1"], ["p2"], ["p3"]], roster: { p1: M1, p2: M2, p3: V }, seats: 3 };
		await report(mal, fake);
		let r = await report(mae, fake);
		check("two colluders agreeing about a third account: it waits for the third", r.body.pending === true && !r.body.counted, r.body);
		await grace();
		r = await report(mal, fake);
		check("…after the grace it counts — for the two who reported", r.body.counted === true, r.body);
		check("…the victim has no rating, no game and no match from it", !(await ratingIn(vic, "neon-bid")) && (await matchesOfTok(vic)).matches.length === 0, await matchesOfTok(vic));
		const prof = await call("GET", `/api/u/${M1}`);
		check("…and is not named in the match the colluders keep", prof.body.matches[0] && !prof.body.matches[0].ranking.flat().some((p) => p.id === V), prof.body.matches[0]?.ranking);
		r = await report(vic, fake);
		check("…a late report of theirs is told the match counted without it", r.body.counted === false && /without your report/.test(r.body.why), r.body);

		// A party member publishes someone else's account id as theirs (the
		// `acct` meta is self-published, lib/account.js attach) and then
		// "leaves": the leaver rule needs the victim's own start.
		const spoof = { game: "lokeshmohanty/battleship", run: "spoof1", match: 1, kind: "duel", ranking: [["p1"], ["p3"]], roster: { p1: M1, p3: V }, seats: 2, left: ["p3"] };
		await call("POST", "/api/match/start", { token: mal, body: { game: "lokeshmohanty/battleship", run: "spoof1", match: 1 } });
		r = await report(mal, spoof);
		check("a member claiming another's account and leaving: the report waits", r.body.pending === true, r.body);
		await grace();
		r = await report(mal, spoof);
		check("…and never counts: the victim never said they sat down", r.body.counted !== true && !(await ratingIn(vic, "lokeshmohanty/battleship")), r.body);
	}

	console.log("\naccounts: a game is the server's to know, and its kind");
	{
		const duelAsFfa = { game: "lokeshmohanty/battleship", run: "kind1", match: 1, kind: "ffa", ranking: [["pa"], ["pb"]], roster: { pa: A, pb: Bo }, seats: 2 };
		let r = await report(ana, duelAsFfa);
		check("a result of another kind than the game's is refused (Battleship is a duel)", r.status === 400 && /duel game/.test(r.body.error), r.body);
		check("…and the board keeps its kind", (await call("GET", "/api/lb/lokeshmohanty/battleship")).body.kind === "duel");
		r = await report(ana, { ...duelAsFfa, game: "nobody/not-a-real-game", kind: "duel" });
		check("a result for a game the arcade does not list is refused", r.status === 400 && /unknown game/.test(r.body.error), r.body);
		check("…so is its play count", (await call("POST", "/api/stats/played", { body: { game: "nobody/not-a-real-game" } })).status === 400);
		check("…and its board", (await call("GET", "/api/lb/nobody/not-a-real-game")).status === 400);
		check("…and a level that is not one", (await call("GET", "/api/lb/lokeshmohanty/battleship@alone")).status === 400);
		check("…while a solo level's board still answers", (await call("GET", "/api/lb/lokeshmohanty/light-cycles@alone")).body.kind === "coop");
		// Names on Object.prototype are not games (the tables have none).
		for (const g of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
			const codes = [
				(await call("POST", "/api/stats/played", { body: { game: g } })).status,
				(await report(ana, { game: g, run: "proto1", match: 1, kind: "ffa", ranking: [["pa"], ["pb"]], roster: { pa: A, pb: Bo }, seats: 2 })).status,
				(await call("POST", "/api/run/start", { token: ana, body: { game: g } })).status,
				(await call("POST", "/api/run/start", { token: ana, body: { game: g, vs: "bots" } })).status,
				(await call("GET", `/api/lb/${g}`)).status,
				(await call("GET", `/api/lb/${g}?vs=bots`)).status,
				(await call("POST", "/api/match/start", { token: ana, body: { game: g, run: "proto1", match: 1 } })).status,
			];
			check(`"${g}" is no game: played, report, runs, boards and match start all 400`, codes.every((c) => c === 400), codes);
		}
		check("…and the summary lists none of them", !Object.keys((await call("GET", "/api/stats/summary")).body.games).some((g) => ["constructor", "__proto__", "toString"].includes(g)));
		check("a match start for a game with no winner is refused", (await call("POST", "/api/match/start", { token: ana, body: { game: "neon-survival-mp", run: "x", match: 1 } })).status === 400);
		check("…and one without its match number", (await call("POST", "/api/match/start", { token: ana, body: { game: "lokeshmohanty/battleship", run: "x" } })).status === 400);
	}

	console.log("\naccounts: games without online boards (\"leaderboard\": false)");
	{
		// Lokesh, 2026-11-16: Tic Tac Toe (all seven), Connect 4, Undercover — and
		// Draw & Guess once its web-games pin moves (still ranked until then).
		const c4 = { game: "connect4", run: "nb1", match: 1, kind: "duel", ranking: [["pa"], ["pb"]], roster: { pa: A, pb: Bo }, seats: 2 };
		let r = await report(ana, c4);
		check("a result for Connect 4 is refused, and says why", r.body.counted === false && /no leaderboard/.test(r.body.why) && r.body.code === "no-board", r.body);
		r = await report(bo, c4);
		check("…even when both players report it", r.body.counted === false && !(await ratingIn(ana, "connect4")), r.body);
		check("no board for it: 404", (await call("GET", "/api/lb/connect4")).status === 404);
		check("…nor against bots (Tic Tac Toe's is gone too)", (await call("GET", "/api/lb/connect4?vs=bots")).status === 404 && (await call("GET", "/api/lb/tic-tac-toe-js?vs=bots")).status === 404);
		check("…nor for a level of it", (await call("GET", "/api/lb/tic-tac-toe-js@alone")).status === 404);
		const bots = await call("POST", "/api/run/start", { token: ana, body: { game: "tic-tac-toe-js", vs: "bots" } });
		check("no run against bots for it", bots.status === 400 && bots.body.code === "no-board", bots.body);
		check("no match start for it", (await call("POST", "/api/match/start", { token: ana, body: { game: "connect4", run: "nb1", match: 1 } })).status === 400);
		const ttt = { game: "tic-tac-toe-js", run: "nb2", match: 1, kind: "duel", ranking: [["pa"], ["bot_1"]], roster: { pa: A } };
		r = await report(ana, ttt);
		check("no win against bots for it either", r.body.counted === false && r.body.code === "no-board", r.body);
		// The live D1 has old rows for these games: they stay, and are not served.
		await w.sql(`INSERT INTO ratings (account, game, elo, games, wins, best) VALUES ('${A}', 'connect4', 1250, 7, 4, NULL); INSERT INTO bot_wins (account, game, wins, first, at) VALUES ('${A}', 'tic-tac-toe-js', 2, 1, 1);`);
		const mm = await matchesOfTok(ana);
		check("an old Connect 4 rating and Tic Tac Toe wins against bots are not served", !mm.ratings.some((x) => x.game === "connect4") && !mm.botWins.some((x) => x.game === "tic-tac-toe-js"), { ratings: mm.ratings, botWins: mm.botWins });
		const pub = (await call("GET", `/api/u/${A}`)).body;
		check("…nor on the public profile", !pub.ratings.some((x) => x.game === "connect4") && !pub.botWins.some((x) => x.game === "tic-tac-toe-js"), pub);
		check("its play count still lands (counts are not a board)", (await call("POST", "/api/stats/played", { body: { game: "undercover" } })).body.counted === true);
	}

	console.log("\naccounts: a game with more than one kind of result (Bubble Rush)");
	{
		const ps = await Promise.all(["Bra", "Brb", "Brc", "Brd"].map(async (n) => { const t = await testLogin(n); return { t, id: await id(t) }; }));
		const G = "lokeshmohanty/bubble-rush";
		const teams = { game: G, run: "br1", match: 1, kind: "teams", ranking: [["pa", "pb"], ["pc", "pd"]], roster: { pa: ps[0].id, pb: ps[1].id, pc: ps[2].id, pd: ps[3].id }, seats: 4 };
		let r;
		for (const p of ps) r = await report(p.t, teams);
		check("a Bubble Rush teams result counts (its manifest is ffa; the table lists teams too)", r.status === 200 && r.body.counted === true, r.body);
		const lb = await call("GET", `/api/lb/${G}`);
		check("…on its one board, of its manifest's kind, by rating", lb.body.kind === "ffa" && lb.body.rows.length === 4 && lb.body.rows[0].elo > 1200, lb.body);
		r = await report(ps[0].t, { ...teams, run: "br2", kind: "duel", ranking: [["pa"], ["pb"]] });
		check("…while a duel result for it is still refused", r.status === 400 && /ffa game/.test(r.body.error), r.body);
	}

	console.log("\naccounts: guests in a free-for-all");
	{
		const gus1 = await testLogin("Gia");
		const gus2 = await testLogin("Gil");
		const [G1, G2] = [await id(gus1), await id(gus2)];
		const ffa = { game: "neon-fission", run: "guest1", match: 1, kind: "ffa", ranking: [["guest"], ["p1"], ["p2"]], roster: { p1: G1, p2: G2 }, seats: 3 };
		await report(gus1, ffa);
		const r = await report(gus2, ffa);
		check("second behind a guest counts", r.body.counted === true, r.body);
		const [r1, r2] = [await ratingIn(gus1, "neon-fission"), await ratingIn(gus2, "neon-fission")];
		check("…but is not a win", r1?.wins === 0 && r2?.wins === 0, { r1, r2 });
		check("…while beating the other signed-in player still raises the rating", r1.elo > 1200 && r2.elo < 1200, { r1, r2 });
		check("…and the history says second, not first", (await matchesOfTok(gus1)).matches[0]?.place === 1 && (await matchesOfTok(gus1)).matches[0].won === false);
	}

	console.log("\naccounts: leaving a ranked match is a loss");
	{
		const lea = await testLogin("Lea");
		const lou = await testLogin("Lou");
		const lia = await testLogin("Lia");
		const [L1, L2, L3] = [await id(lea), await id(lou), await id(lia)];
		const begin = (token, run, game = "lokeshmohanty/battleship", match = 1) => call("POST", "/api/match/start", { token, body: { game, run, match } });
		const duel = (run, extra = {}) => ({ game: "lokeshmohanty/battleship", run, match: 1, kind: "duel", ranking: [["p1"], ["p2"]], roster: { p1: L1, p2: L2 }, seats: 2, left: ["p2"], ...extra });

		await begin(lea, "lv1");
		await begin(lou, "lv1");
		let r = await report(lea, duel("lv1"));
		check("a duel whose loser left: the winner's report waits out the grace", r.body.pending === true && !r.body.counted, r.body);
		await grace();
		r = await report(lea, duel("lv1"));
		check("…then counts on the winner's word, the leaver's start being its evidence", r.body.counted === true && r.body.rating?.delta > 0, r.body);
		const lost = await ratingIn(lou, "lokeshmohanty/battleship");
		check("…as a loss for the one who left", lost?.games === 1 && lost.wins === 0 && lost.elo < 1200, lost);
		check("…in their history too", (await matchesOfTok(lou)).matches[0]?.won === false);

		// No start of the leaver's: nothing to go on.
		await begin(lea, "lv2");
		await report(lea, duel("lv2"));
		await grace();
		r = await report(lea, duel("lv2"));
		check("not when the one named as leaving never said they were seated", r.body.counted !== true && (await ratingIn(lou, "lokeshmohanty/battleship")).games === 1, r.body);

		// The review's repro (2026-11-16): Lou is still playing, with a second
		// page open on the home screen (its socket says "no game"); Lea alone
		// reports that Lou left and waits out the grace. Lou's seated page
		// keeps beating (re-posting its start), so it is never booked.
		await begin(lea, "lv3");
		await begin(lou, "lv3");
		const home = new WebSocket(`${B.replace("http", "ws")}/live`, ["neon", lou]);
		await new Promise((ok, bad) => ((home.onopen = ok), (home.onerror = bad), setTimeout(bad, 8000))).catch(() => {});
		home.send(JSON.stringify({ t: "status", game: null }));
		await new Promise((res) => setTimeout(res, 400));
		await report(lea, duel("lv3"));
		await grace();
		await begin(lou, "lv3"); // the seated page's beat (every 2 min deployed; MATCH_STALE_MS is 2 s here)
		r = await report(lea, duel("lv3"));
		check("not while their seated page still beats — even with a second page on the home screen", r.body.counted !== true && (await ratingIn(lou, "lokeshmohanty/battleship")).games === 1, r.body);
		home.close();
		await new Promise((res) => setTimeout(res, 400));
		// Beats are free of the per-address write limit (120 per window); new
		// starts are not.
		const gateIp = "10.98.0.1";
		const beats = [];
		const beatWrites = [];
		const beatT0 = Date.now();
		for (let i = 0; i < 130; i++) {
			const x = await call("POST", "/api/match/start", { token: lou, ip: gateIp, body: { game: "lokeshmohanty/battleship", run: "lv3", match: 1 } });
			beats.push(x.status);
			beatWrites.push(x.body.wrote === true);
		}
		const beatMs = Date.now() - beatT0;
		check("130 beats from one address in a window: none refused", beats.every((x) => x === 200), beats.filter((x) => x !== 200).length);
		const spent = await call("POST", "/api/stats/played", { ip: gateIp, body: { game: "neon-bid" } });
		check("…and the address's write limit is unspent by them", spent.status === 200, spent.status);
		check("…and they wrote at most once per beat interval (0.5 s here, 30 s deployed), not 130 times", beatWrites.filter(Boolean).length <= 1 + Math.ceil(beatMs / 500), { wrote: beatWrites.filter(Boolean).length, ms: beatMs });
		// An account keeps its newest three starts: a fourth evicts the oldest.
		const starts = (n) => call("POST", "/api/match/start", { token: lia, body: { game: "lokeshmohanty/battleship", run: `cap${n}`, match: 1 } });
		for (let n = 0; n < 4; n++) await starts(n);
		const live = (await w.sql(`SELECT COUNT(*) AS n FROM reports WHERE account = '${L3}' AND digest = 'start'`))[0][0].n;
		const first = await starts(0);
		check("an account keeps at most three live starts: a fourth evicts the oldest", live === 3 && first.body.wrote === true && first.body.beat !== true, { live, first: first.body });
		let fresh = 0;
		const gat = await testLogin("Gat"); // not Lou: three live starts each, and Lou's lv3 must stay
		for (let i = 0; i < 125; i++) fresh = (await call("POST", "/api/match/start", { token: gat, ip: gateIp, body: { game: "lokeshmohanty/battleship", run: `gate${i}`, match: 1 } })).status;
		check("…while new starts are charged like any write (the 125th is told to wait)", fresh === 429, fresh);
		// The beat stops (they really left): then it counts — and a late
		// report of theirs is told it counted against them.
		await new Promise((res) => setTimeout(res, 2200)); // MATCH_STALE_MS is 2000 here
		r = await report(lea, duel("lv3"));
		check("…once the beat has stopped for MATCH_STALE_MS, the departure counts", r.body.counted === true && (await ratingIn(lou, "lokeshmohanty/battleship")).games === 2, r.body);
		const late = await report(lou, { ...duel("lv3"), left: [] });
		check("…and their own late report is told the match counted against them, not \"Counted\"", late.body.counted === false && late.body.left === true && /against you/.test(late.body.why) && late.body.rating?.delta < 0, late.body);

		// They did not leave, and say so: a different result voids it.
		await begin(lea, "lv4");
		await begin(lou, "lv4");
		await report(lea, duel("lv4"));
		r = await report(lou, duel("lv4", { ranking: [["p2"], ["p1"]], left: [] }));
		check("not when they report the match themselves: the disagreement voids it", r.body.counted === false && /disagree/.test(r.body.why), r.body);

		// A match they finished and reported uses their start up: a later
		// "match 2" of that run, made up, cannot name them as leaving.
		await begin(lea, "lv5");
		await begin(lou, "lv5");
		const real = { ...duel("lv5"), left: [] };
		await report(lea, real);
		r = await report(lou, real);
		check("(a real match, both reporting, counts)", r.body.counted === true, r.body);
		const before = (await ratingIn(lou, "lokeshmohanty/battleship")).games;
		await report(lea, duel("lv5", { match: 2 }));
		await grace();
		r = await report(lea, duel("lv5", { match: 2 }));
		check("not with a start their own report already used up", r.body.counted !== true && (await ratingIn(lou, "lokeshmohanty/battleship")).games === before, r.body);

		// A real match number is needed: a start names its match.
		await begin(lea, "lv8");
		await begin(lou, "lv8");
		await report(lea, duel("lv8", { match: 7 }));
		await grace();
		r = await report(lea, duel("lv8", { match: 7 }));
		check("not for a match number they never started (a made-up 'match 7' of a real run)", r.body.counted !== true && (await ratingIn(lou, "lokeshmohanty/battleship")).games === before, r.body);

		// The match ended without a result while they were still in the party
		// (END GAME, the host left): their page withdraws the start.
		await begin(lea, "lv9");
		await begin(lou, "lv9");
		const wd = await call("DELETE", "/api/match/start", { token: lou, body: { game: "lokeshmohanty/battleship", run: "lv9", match: 1 } });
		await report(lea, duel("lv9"));
		await grace();
		r = await report(lea, duel("lv9"));
		check("not when they withdrew their start (the match ended with no result)", wd.body.withdrawn === true && r.body.counted !== true && (await ratingIn(lou, "lokeshmohanty/battleship")).games === before, r.body);

		// Any report of theirs of that match uses the start up, even one refused.
		await begin(lea, "lv10");
		await begin(lou, "lv10");
		const refused = await report(lou, { ...duel("lv10"), roster: { p2: L2 }, left: [] });
		await report(lea, duel("lv10"));
		await grace();
		r = await report(lea, duel("lv10"));
		check("not when they reported that match themselves, even a report that was refused", refused.body.counted === false && r.body.counted !== true && (await ratingIn(lou, "lokeshmohanty/battleship")).games === before, { refused: refused.body, r: r.body });

		// The same, with nothing to stop it: counted (so the refusals above are the rules', not presence's).
		await begin(lea, "lv11");
		await begin(lou, "lv11");
		await report(lea, duel("lv11"));
		await grace();
		r = await report(lea, duel("lv11"));
		check("(and with a start of theirs, nothing withdrawn or reported, it counts again)", r.body.counted === true && (await ratingIn(lou, "lokeshmohanty/battleship")).games === before + 1, r.body);

		// A game that keeps the emptied side's empty slot, the leaver's side ahead.
		await begin(lea, "lv12");
		await begin(lou, "lv12");
		const emptied = duel("lv12", { ranking: [[], ["p1"]] });
		await report(lea, emptied);
		await grace();
		r = await report(lea, emptied);
		const lw = await ratingIn(lea, "lokeshmohanty/battleship");
		check("an emptied side's empty slot does not beat the one who stayed: a win by forfeit", r.body.counted === true && r.body.rating?.delta > 0 && (await matchesOfTok(lea)).matches[0]?.won === true, { r: r.body, lw });

		// Free-for-all: confirmed by two reporters, or not at all.
		const ffa = (run) => ({ game: "neon-bid", run, match: 1, kind: "ffa", ranking: [["p1"], ["p2"]], roster: { p1: L1, p2: L2, p3: L3 }, seats: 3, left: ["p3"] });
		for (const t of [lea, lou, lia]) await begin(t, "lv6", "neon-bid");
		await report(lea, ffa("lv6"));
		await report(lou, ffa("lv6"));
		await grace();
		r = await report(lea, ffa("lv6"));
		check("free-for-all: two reporters confirm a third left — counted, the leaver last", r.body.counted === true, r.body);
		const gone = await ratingIn(lia, "neon-bid");
		check("…a loss for the leaver", gone?.games === 1 && gone.wins === 0 && (await matchesOfTok(lia)).matches[0]?.place === 2, gone);
		for (const t of [lea, lou, lia]) await begin(t, "lv7", "neon-bid");
		await report(lea, ffa("lv7"));
		await grace();
		r = await report(lea, ffa("lv7"));
		check("…one reporter alone cannot, with another player still there", r.body.counted !== true && (await ratingIn(lia, "neon-bid")).games === 1, r.body);
	}

	console.log("\naccounts: one atomic commit; a missing account; commits at once");
	{
		const ada = await testLogin("Ada");
		const abe = await testLogin("Abe");
		const [A1, A2] = [await id(ada), await id(abe)];
		// The audit's D11: a roster naming an account that does not exist.
		const ghost = { game: "neon-bid", run: "ghost1", match: 1, kind: "ffa", ranking: [["p1"], ["p2"], ["p3"]], roster: { p1: A1, p2: A2, p3: "ghost-account" }, seats: 3 };
		await report(ada, ghost);
		await report(abe, ghost);
		await grace();
		let r = await report(ada, ghost);
		check("a report naming a missing account counts for the two real ones", r.body.counted === true, r.body);
		check("…and the match is really there (not 'counted' over a failed write)", (await matchesOfTok(ada)).matches.some((m) => m.game === "neon-bid"), (await matchesOfTok(ada)).matches);
		r = await report(abe, ghost);
		check("…a repeat says so, with the rating", r.body.counted === true && r.body.already === true && typeof r.body.rating?.elo === "number", r.body);

		// Two last reports of one match at once: it counts once.
		const both = { game: "lokeshmohanty/battleship", run: "race1", match: 1, kind: "duel", ranking: [["p1"], ["p2"]], roster: { p1: A1, p2: A2 }, seats: 2 };
		const raced = await Promise.all([report(ada, both), report(abe, both)]);
		const c4 = await ratingIn(ada, "lokeshmohanty/battleship");
		check("two players reporting the same match at the same moment: counted once", c4?.games === 1 && raced.some((x) => x.body.counted), { c4, raced: raced.map((x) => x.body) });

		// Matches for one account committing at the same time all count (the
		// commit adds; it no longer reads, computes and overwrites).
		const hub = await testLogin("Hub");
		const H = await id(hub);
		const others = [];
		for (let i = 0; i < 6; i++) others.push(await testLogin(`Rim${i}`));
		const ids = await Promise.all(others.map(id));
		const body = (i) => ({ game: "lokeshmohanty/battleship", run: `hub${i}`, match: 1, kind: "duel", ranking: [["ph"], ["px"]], roster: { ph: H, px: ids[i] }, seats: 2 });
		for (let i = 0; i < 6; i++) await report(others[i], body(i));
		const done = await Promise.all(ids.map((_, i) => report(hub, body(i))));
		const hr = await ratingIn(hub, "lokeshmohanty/battleship");
		const sum = done.reduce((t, x) => t + (x.body.rating?.delta ?? 0), 0);
		check("six matches of one player committing at once: all six counted", done.every((x) => x.body.counted) && hr?.games === 6 && hr.wins === 6, { hr, done: done.map((x) => x.body) });
		check("…and the rating moved by all six", Math.abs(hr.elo - 1200 - sum) <= 6 && hr.elo > 1200 + 6 * 15, { elo: hr.elo, sum });
	}

	console.log("\naccounts: a single id at the end is not a run played alone");
	{
		// An abandoned solo run, then a two-seat match the other player left:
		// its result holds one id. The report says it began with two seats.
		const sol = await testLogin("Sol");
		const S = await id(sol);
		const run = (await call("POST", "/api/run/start", { token: sol, body: { game: "lokeshmohanty/light-cycles" } })).body.run;
		await call("POST", "/api/admin/age-run", { body: { run, ms: 60_000 } });
		const lone = { game: "lokeshmohanty/light-cycles", run, match: 1, kind: "ffa", ranking: [["ps"]], roster: { ps: S }, scores: { ps: 9 } };
		let r = await report(sol, { ...lone, seats: 2 });
		check("a report that began with two seats is not taken as solo", r.body.counted === false && /two signed-in/.test(r.body.why), r.body);
		r = await report(sol, lone);
		check("…nor one that does not say how many seats it began with", r.body.counted === false && /two signed-in/.test(r.body.why), r.body);
		r = await report(sol, { ...lone, seats: 1 });
		check("…and the run is still good for a round that did begin alone", r.body.counted === true, r.body);
	}

	console.log("\naccounts: solo runs, issued by the server");
	{
		const start = (token, game) => call("POST", "/api/run/start", { token, body: { game } });
		// Tests only: move a run's start into the past, as if time had passed.
		const age = (run, ms) => call("POST", "/api/admin/age-run", { body: { run, ms } });
		const report = (token, body) => call("POST", "/api/match/report", { token, body });
		// A report as of the moment its run was issued, on the server's own
		// clock (X-Test-Now, tests only): a run aged `ms` is then exactly `ms`
		// old, however long the requests took on a slow runner.
		const reportAsIssued = (token, body, run) => call("POST", "/api/match/report", { token, body, headers: { "X-Test-Now": String(run.at) } });
		const surv = (run, score, extra = {}) => ({ game: "neon-survival-mp", run, match: 1, kind: "coop", ranking: [["pa"]], roster: { pa: A }, scores: { pa: score }, seats: 1, ...extra });
		const ratingOf = async (token, game) => (await call("GET", "/api/me/matches", { token })).body.ratings.find((x) => x.game === game);
		const fresh = async (token = ana, ms = 60_000) => {
			const s = (await start(token, "neon-survival-mp")).body;
			if (ms) await age(s.run, ms);
			return s;
		};

		check("a run needs a sign-in", (await start(null, "neon-survival-mp")).status === 401);
		check("…and a game id", (await start(ana, "../etc")).status === 400);
		let r = await start(ana, "lokeshmohanty/battleship");
		check("…and a game that ranks games played alone (SOLO): others get no run", r.status === 400 && /alone/.test(r.body.error), r.body);
		check("…nor does a game that does not exist", (await start(ana, "no-such-game")).status === 400);
		const s = await fresh(ana, 0);
		check("a run: a random id, a seed and the server's clock", typeof s.run === "string" && s.run.length >= 16 && Number.isInteger(s.seed) && s.seed >= 0 && s.seed < 2 ** 31 && Math.abs(s.at - Date.now()) < 60_000, s);
		check("…a new one each time", (await start(ana, "neon-survival-mp")).body.run !== s.run);
		await age(s.run, 60_000);
		r = await report(ana, surv(s.run, 40));
		check("a solo run with its run counts on its own report", r.body.counted === true, r.body);
		const rt = await ratingOf(ana, "neon-survival-mp");
		check("…as a run: games and best score, never a win", rt?.best === 40 && rt.games === 2 && rt.wins === 0, rt);
		r = await report(ana, surv(s.run, 40));
		check("…once (the same report again)", r.body.counted === true && r.body.already === true, r.body);
		r = await report(ana, surv(s.run, 41, { match: 2 }));
		check("a run is good for one report", r.body.counted === false && /already reported/.test(r.body.why), r.body);
		r = await report(ana, surv("party-run-id", 12));
		check("a solo report without a run from the server is refused, and says why", r.body.counted === false && /run the server issued/.test(r.body.why), r.body);
		r = await report(ana, surv("AAAAAAAAAAAAAAAA", 12));
		check("…so is a forged one", r.body.counted === false && /unknown/.test(r.body.why), r.body);
		const theirs = await fresh(bo);
		r = await report(ana, surv(theirs.run, 12));
		check("…and another player's", r.body.counted === false && /another player/.test(r.body.why), r.body);
		r = await report(bo, { ...surv(theirs.run, 12), roster: { pa: Bo } });
		check("…which they can still use themselves", r.body.counted === true, r.body);
		const other = await fresh();
		r = await report(ana, { ...surv(other.run, 100), game: "lokeshmohanty/sudoku" });
		check("…and one issued for another game", r.body.counted === false && /another game/.test(r.body.why), r.body);
		const old = await fresh(ana, 7 * 3600_000);
		r = await report(ana, surv(old.run, 12));
		check("…and an expired one (six hours)", r.body.counted === false && /expired/.test(r.body.why), r.body);
		const quick = await fresh(ana, 0);
		r = await reportAsIssued(ana, surv(quick.run, 1), quick);
		check("a report sooner than the game's shortest run is refused", r.body.counted === false && /too fast/.test(r.body.why), r.body);
		const greedy = await fresh(ana, 10_000);
		r = await reportAsIssued(ana, surv(greedy.run, 100), greedy);
		check("a score above what the time since the run began allows is refused", r.body.counted === false && /more than a 10-second run/.test(r.body.why), r.body);
		for (const [bad, label] of [[1e308, "1e308"], [-1, "negative"], [2.5, "fractional"], [null, "missing"]]) {
			r = await reportAsIssued(ana, surv(greedy.run, bad), greedy);
			check(`…so is a ${label} score`, r.body.counted === false && /score/.test(r.body.why), r.body);
		}
		r = await reportAsIssued(ana, surv(greedy.run, 12, { match: 2 }), greedy);
		check("a refused report does not use the run up (it is claimed only once it counts)", r.body.counted === true, r.body);

		// Only SOLO games rank alone: no made-up score on any other game.
		const forged = { game: "lokeshmohanty/battleship", run: "party-run-x", match: 1, kind: "duel", ranking: [["pa"]], roster: { pa: A }, scores: { pa: 1e308 }, seats: 1 };
		r = await report(ana, forged);
		check("a solo report for a game not in SOLO is refused", r.body.counted === false && /does not rank games played alone/.test(r.body.why), r.body);
		r = await report(ana, { ...forged, game: "no-such-game" });
		check("…so is one for a game that does not exist (not in the table: 400)", r.status === 400 && /unknown game/.test(r.body.error), r.body);
		check("…and battleship's board is still a duel board", (await call("GET", "/api/lb/lokeshmohanty/battleship")).body.kind === "duel");

		// Neon Survival's board is best score whatever the latest match was:
		// a multi-ship run (free-for-all) puts its scores on it too.
		const ffa = { game: "neon-survival-mp", run: "ns-ffa-1", match: 1, kind: "ffa", ranking: [["pa"], ["pb"]], roster: { pa: A, pb: Bo }, scores: { pa: 70, pb: 3 } };
		await report(ana, ffa);
		r = await report(bo, ffa);
		check("a multi-ship Neon Survival run counts (two players agree)", r.body.counted === true, r.body);
		const ns = await call("GET", "/api/lb/neon-survival-mp");
		check("…its board stays best score (not flipped to free-for-all)", ns.body.kind === "coop", ns.body.kind);
		check("…with that run's score as Ana's best", ns.body.rows[0]?.id === A && ns.body.rows[0].best === 70, ns.body.rows);
	}

	console.log("\naccounts: a day's runs played alone");
	{
		// SOLO_PER_DAY is 8 here (50 deployed).
		const dee = await testLogin("Dee");
		const D = await id(dee);
		let last = null;
		for (let i = 0; i < 9; i++) {
			const s = (await call("POST", "/api/run/start", { token: dee, body: { game: "neon-survival-mp" } })).body;
			await call("POST", "/api/admin/age-run", { body: { run: s.run, ms: 60_000 } });
			last = await call("POST", "/api/match/report", { token: dee, body: { game: "neon-survival-mp", run: s.run, match: 1, kind: "coop", ranking: [["pd"]], roster: { pd: D }, scores: { pd: i }, seats: 1 } });
			if (i === 7) check("eight runs played alone count in a day", last.body.counted === true, last.body);
		}
		check("…the ninth does not, and says why", last.body.counted === false && /8 games of this one played alone rank a day/.test(last.body.why), last.body);
	}

	console.log("\naccounts: the day's solo cap is per game, and holds in parallel");
	{
		// SOLO_PER_DAY is 8 here, per account per game.
		const hal = await testLogin("Hal");
		const H = await id(hal);
		const runs = [];
		for (let i = 0; i < 11; i++) {
			const s = (await call("POST", "/api/run/start", { token: hal, body: { game: "lokeshmohanty/light-cycles" } })).body;
			await call("POST", "/api/admin/age-run", { body: { run: s.run, ms: 60_000 } });
			runs.push(s.run);
		}
		const raced = await Promise.all(
			runs.map((run, i) =>
				call("POST", "/api/match/report", { token: hal, body: { game: "lokeshmohanty/light-cycles", run, match: 1, kind: "ffa", ranking: [["ph"]], roster: { ph: H }, scores: { ph: 10 + i }, seats: 1 } }),
			),
		);
		check("Light Cycles rounds posted in parallel stop at the day's cap (11 at once, cap 8)", raced.filter((x) => x.body.counted).length === 8 && raced.filter((x) => /8 games of this one played alone rank a day/.test(x.body.why ?? "")).length === 3, raced.map((x) => x.body.counted || x.body.why));
		const ns = (await call("POST", "/api/run/start", { token: hal, body: { game: "neon-survival-mp" } })).body;
		await call("POST", "/api/admin/age-run", { body: { run: ns.run, ms: 60_000 } });
		const r = await call("POST", "/api/match/report", { token: hal, body: { game: "neon-survival-mp", run: ns.run, match: 1, kind: "coop", ranking: [["ph"]], roster: { ph: H }, scores: { ph: 30 }, seats: 1 } });
		check("…and another game's runs still rank: the cap is per game", r.body.counted === true, r.body);
		globalThis.__hal = { hal, H }; // Sudoku's turn, below
	}

	console.log("\naccounts: Sudoku, verified on the server");
	{
		// The server's solutionFor is a copy of the game's (worker/api/sudoku.js):
		// the grid the game deals must be the one the server computes, for the
		// attempt the game actually used.
		const RULES = new URL("../../web-games-v2/sudoku/sudoku-rules.js", import.meta.url);
		if (existsSync(RULES)) {
			new Function(readFileSync(RULES, "utf8"))();
			const G = globalThis.sudokuRules;
			const diff = [];
			const attempts = new Set();
			let n = 0;
			for (const level of SU.LEVEL_IDS) {
				for (let seed = 0; seed < (level === "expert" ? 40 : 60); seed++) {
					const g = G.puzzleFor(seed * 104729 + 7, level);
					attempts.add(g.attempt);
					n++;
					if (SU.solutionFor(SU.seedKey(seed * 104729 + 7, level), g.attempt).join("") !== g.solution.join("")) diff.push(`${level}/${seed}`);
				}
				for (const date of ["2026-11-14", "2026-11-15", "2026-11-16", "2027-02-28"]) {
					const g = G.dailyPuzzle(date, level);
					n++;
					if (SU.solutionFor(SU.dailyKey(date, level), g.attempt).join("") !== g.solution.join("")) diff.push(`${level}/${date}`);
				}
				for (let k = 0; k < SU.ATTEMPTS; k++) if (G.solutionFor(G.seedKey(12345, level), k).join("") !== SU.solutionFor(SU.seedKey(12345, level), k).join("")) diff.push(`${level}/attempt ${k}`);
			}
			check(`the server's solutionFor is the grid the game deals (${n} puzzles, attempts ${[...attempts].sort((x, y) => x - y).join(",")} used; every attempt of one seed)`, diff.length === 0, diff.join(" "));
			check("…and the game's ATTEMPTS is the server's", G.ATTEMPTS === SU.ATTEMPTS, G.ATTEMPTS);
		} else console.log("  skip the server's generator against the game's: ../web-games-v2 is not checked out");

		const GAME = "lokeshmohanty/sudoku";
		const age = (run, ms) => call("POST", "/api/admin/age-run", { body: { run, ms } });
		// A run `secs` old on the server's clock.
		const start = async (token, secs) => {
			const s = (await call("POST", "/api/run/start", { token, body: { game: GAME } })).body;
			if (secs) await age(s.run, secs * 1000);
			return s;
		};
		const text = (g) => g.join("");
		const solved = (run, secs, proof, who = "pa", acct = A) => ({ game: GAME, run, match: 1, kind: "coop", ranking: [[who]], roster: { [who]: acct }, scores: { [who]: secs }, proof, seats: 1 });
		const report = (token, body) => call("POST", "/api/match/report", { token, body });
		const fresh = (seed, level, attempt = 0) => ({ start: "new", level, daily: null, attempt, grid: text(SU.solutionFor(SU.seedKey(seed, level), attempt)) });
		const ratings = async (token) => (await call("GET", "/api/me/matches", { token })).body.ratings;

		let run = await start(ana, 100);
		let r = await report(ana, solved(run.run, 95, fresh(run.seed, "easy")));
		check("a solved puzzle from the run's seed counts", r.body.counted === true, r.body);
		run = await start(ana, 90);
		await report(ana, solved(run.run, 80, fresh(run.seed, "hard")));
		run = await start(ana, 210);
		await report(ana, solved(run.run, 200, fresh(run.seed, "easy")));
		const mine = await ratings(ana);
		const easy = mine.find((x) => x.game === `${GAME}@easy`);
		const hard = mine.find((x) => x.game === `${GAME}@hard`);
		check("each difficulty is its own board, its best the lowest time", easy?.best === 95 && easy.games === 2 && hard?.best === 80 && hard.games === 1 && easy.wins === 0, mine);
		check("…and the game's own board is untouched by solo runs (races)", !mine.some((x) => x.game === GAME), mine.map((x) => x.game));

		run = await start(ana, 300);
		r = await report(ana, solved(run.run, 100, fresh(run.seed, "medium")));
		const medium = (await ratings(ana)).find((x) => x.game === `${GAME}@medium`);
		check("a reported time is raised to the server's clock less 60 s (100 reported, run 300 s old → 240)", r.body.counted === true && medium?.best === 240, { r: r.body, medium });

		const today = new Date().toISOString().slice(0, 10);
		const daily = (level) => ({ start: "daily", level, daily: today, attempt: 0, grid: text(SU.solutionFor(SU.dailyKey(today, level), 0)) });
		run = await start(bo, 75);
		r = await report(bo, solved(run.run, 70, daily("easy"), "pb", Bo));
		check("today's puzzle counts too", r.body.counted === true, r.body);
		run = await start(bo, 75);
		r = await report(bo, solved(run.run, 65, daily("easy"), "pb", Bo));
		check("…once a day at each difficulty: again is refused", r.body.counted === false && /already ranked that day's puzzle/.test(r.body.why), r.body);
		r = await report(bo, solved(run.run, 65, daily("medium"), "pb", Bo));
		check("…while another difficulty's daily counts (same run, not used up by the refusal)", r.body.counted === true, r.body);

		// Racing: two daily reports at once on two runs, and one run twice at once.
		const [d1, d2] = [await start(bo, 75), await start(bo, 75)];
		const both = await Promise.all([report(bo, solved(d1.run, 70, daily("hard"), "pb", Bo)), report(bo, solved(d2.run, 70, daily("hard"), "pb", Bo))]);
		check("two daily reports racing: exactly one counts", both.filter((x) => x.body.counted === true).length === 1, both.map((x) => x.body));
		const one = await start(bo, 100);
		const twice = await Promise.all([1, 2].map((m) => report(bo, { ...solved(one.run, 95, fresh(one.seed, "easy"), "pb", Bo), match: m })));
		check("one run reported twice at once: exactly one counts", twice.filter((x) => x.body.counted === true).length === 1, twice.map((x) => x.body));

		const lb = await call("GET", `/api/lb/${GAME}@easy`);
		check("the easy board is a time board, lowest first", lb.body.kind === "time" && lb.body.rows[0]?.id === Bo && lb.body.rows[0].best === 70 && lb.body.rows[1]?.id === A, lb.body);
		check("…and names the game's levels", JSON.stringify(lb.body.levels) === JSON.stringify(SU.LEVEL_IDS), lb.body.levels);
		const me = (await call("GET", `/api/lb/${GAME}@easy?me=1`, { token: ana })).body.me;
		check("…and says where you stand by it", me?.rank === 2, me);
		const plain = await call("GET", `/api/lb/${GAME}`);
		check("the game's own board is the races' (free-for-all), with the levels beside it", plain.body.kind === "ffa" && plain.body.levels?.length === 4, plain.body);
		check("a level that is not one is not a board", (await call("GET", `/api/lb/${GAME}@nope`)).status === 400 && (await call("GET", "/api/lb/lokeshmohanty/battleship@easy")).status === 400);

		run = await start(ana, 600);
		const swapped = SU.solutionFor(SU.seedKey(run.seed, "easy"), 0).slice();
		[swapped[0], swapped[1]] = [swapped[1], swapped[0]];
		r = await report(ana, solved(run.run, 590, { ...fresh(run.seed, "easy"), grid: text(swapped) }));
		check("a grid that is not the solution is refused", r.body.counted === false && /not the solution/.test(r.body.why), r.body);
		r = await report(ana, solved(run.run, 590, fresh(run.seed + 1, "easy")));
		check("a valid solution of another puzzle is refused", r.body.counted === false && /not the solution/.test(r.body.why), r.body);
		r = await report(ana, solved(run.run, 590, { ...fresh(run.seed, "easy", 3), attempt: 2 }));
		check("…so is another attempt's grid under the wrong attempt", r.body.counted === false && /not the solution/.test(r.body.why), r.body);
		const badAttempts = [];
		for (const bad of [12, -1, 1.5, null]) {
			r = await report(ana, solved(run.run, 590, { ...fresh(run.seed, "easy"), attempt: bad }));
			if (!(r.body.counted === false && /which puzzle/.test(r.body.why))) badAttempts.push([bad, r.body]);
		}
		check("an attempt outside 0–11 (or not a whole number) is refused", badAttempts.length === 0, badAttempts);
		run = await start(ana, 40);
		r = await report(ana, solved(run.run, 39, fresh(run.seed, "expert")));
		check("a solve sooner than the difficulty allows is refused (the server's clock)", r.body.counted === false && /too fast/.test(r.body.why), r.body);
		run = await start(ana, 50);
		r = await report(ana, solved(run.run, 5, fresh(run.seed, "easy")));
		check("…and so is a reported time below it", r.body.counted === false && /too fast/.test(r.body.why), r.body);
		r = await report(ana, solved(run.run, 90, null));
		check("a Sudoku report without its grid is refused", r.body.counted === false && /grid/.test(r.body.why), r.body);
		r = await report(ana, solved(run.run, 45, { ...fresh(run.seed, "easy"), start: "resume" }));
		check("…and so is a resumed puzzle (not dealt in this run)", r.body.counted === false && /resumed/.test(r.body.why), r.body);
		r = await report(ana, solved(run.run, 45, { start: "daily", level: "easy", daily: "2020-01-01", attempt: 0, grid: text(SU.solutionFor(SU.dailyKey("2020-01-01", "easy"), 0)) }));
		check("…and an old day's puzzle", r.body.counted === false && /today/.test(r.body.why), r.body);
		check("none of those moved the bests", (await ratings(ana)).find((x) => x.game === `${GAME}@easy`)?.best === 95);
		// Hal used up the day's Light Cycles rounds above: Sudoku's are its own.
		const { hal, H } = globalThis.__hal;
		run = await start(hal, 100);
		r = await report(hal, solved(run.run, 95, fresh(run.seed, "easy"), "ph", H));
		check("Light Cycles rounds at their cap do not touch Sudoku's: a solve still counts", r.body.counted === true, r.body);
	}

	console.log("\naccounts: Light Cycles alone, a time bounded by the server's clock");
	{
		const GAME = "lokeshmohanty/light-cycles";
		const issued = new Map(); // run -> when the server issued it (its own clock)
		const start = async (token, ms) => {
			const s = (await call("POST", "/api/run/start", { token, body: { game: GAME } })).body;
			if (ms) await call("POST", "/api/admin/age-run", { body: { run: s.run, ms } });
			issued.set(s.run, s.at);
			return s;
		};
		const ride = (run, secs, extra = {}) => ({ game: GAME, run, match: 1, kind: "ffa", ranking: [["pa"]], roster: { pa: A }, scores: { pa: secs }, seats: 1, ...extra });
		// Every report here as of the moment its run was issued, on the
		// server's own clock (X-Test-Now, tests only): a run aged `ms` is then
		// exactly `ms` old. Its ceiling was a tenth of a second from 7.9 after
		// 10 s, and a slow runner's requests took longer than that (CI run
		// 44245172109 counted 7.9).
		const report = (token, body) => call("POST", "/api/match/report", { token, body, headers: { "X-Test-Now": String(issued.get(body.run)) } });
		let run = await start(ana, 0);
		let r = await report(ana, ride(run.run, 0.4));
		check("a round reported sooner than the countdown allows is refused", r.body.counted === false && /too fast/.test(r.body.why), r.body);
		r = await report(ana, { ...ride(run.run, 0), scores: undefined });
		check("a round with no score (a version from before it) is refused as unrankable, so the page stops asking for runs", r.body.counted === false && r.body.code === "unrankable", r.body);
		run = await start(ana, 60_000);
		r = await report(ana, ride(run.run, 42.3));
		check("a round alone, its time survived under the time since its run began, counts", r.body.counted === true, r.body);
		const alone = await call("GET", `/api/lb/${GAME}@alone`);
		check("…on the game's solo board, best score, in seconds", alone.body.kind === "coop" && alone.body.unit === "s" && alone.body.rows[0]?.id === A && alone.body.rows[0].best === 42.3, alone.body);
		const races = await call("GET", `/api/lb/${GAME}`);
		check("…beside its races (wins), which name the solo board and the one against bots", races.body.kind === "ffa" && races.body.levels?.join() === "alone" && races.body.botsBoard === true && !races.body.rows.some((x) => x.id === A), races.body);
		const tenths = await start(ana, 10_000);
		r = await report(ana, ride(tenths.run, 7.55));
		check("a time that is not in tenths is refused", r.body.counted === false && /score/.test(r.body.why), r.body);
		run = await start(ana, 10_000);
		r = await report(ana, ride(run.run, 7.9));
		check("a time over the seconds since the run began, less the 3.2 s countdown, plus 1 s, is refused (7.9 after 10 s)", r.body.counted === false && /more than a 10-second run/.test(r.body.why), r.body);
		r = await report(ana, ride(run.run, 7.8));
		check("…while 7.8 s after 10 s counts (the same run: a refusal does not use it up)", r.body.counted === true, r.body);
		check("…and a lower time does not lower the best", (await call("GET", `/api/lb/${GAME}@alone`)).body.rows[0].best === 42.3);
		// The pin is what makes those exact, and it is honoured: the same 7.9
		// after 10 s, reported 0.2 s later on the server's clock, counts.
		const later = await start(ana, 10_000);
		r = await call("POST", "/api/match/report", { token: ana, body: ride(later.run, 7.9), headers: { "X-Test-Now": String(later.at + 200) } });
		check("(the server's clock is the one pinned: 7.9 counts 10.2 s after its run began)", r.body.counted === true, r.body);
		// Review, 2026-11-15: the clock alone let a run kept for hours post
		// thousands of seconds. A 40 × 40 arena allows 107.9 s at most.
		run = await start(ana, 5.9 * 3600_000);
		r = await report(ana, ride(run.run, 21000));
		check("a run kept for hours cannot post more than the arena allows (21000 s after 5.9 h)", r.body.counted === false && /more than this game can make/.test(r.body.why), r.body);
		r = await report(ana, ride(run.run, 108.1));
		check("…nor 108.1 s", r.body.counted === false && /at most 108/.test(r.body.why), r.body);
		r = await report(ana, ride(run.run, 107.9));
		check("…while the longest ride there is, 107.9 s, counts", r.body.counted === true, r.body);
	}

	console.log("\naccounts: wins against bots, on a board of their own");
	{
		const eve = await testLogin("Eve");
		const fay = await testLogin("Fay");
		const E = await id(eve);
		const F = await id(fay);
		const start = async (token, game, ms = BOTS[game]?.minMs + 500, vs = "bots") => {
			const res = await call("POST", "/api/run/start", { token, body: vs ? { game, vs } : { game } });
			if (res.status === 200 && ms) await call("POST", "/api/admin/age-run", { body: { run: res.body.run, ms } });
			return res;
		};
		const report = (token, body) => call("POST", "/api/match/report", { token, body });
		const win = (run, who = "pe", acct = E, extra = {}) => ({ game: "lokeshmohanty/battleship", run, match: 1, kind: "duel", ranking: [[who], ["bot_1"]], roster: { [who]: acct }, ...extra });
		const ratingsOf = async (token) => (await call("GET", "/api/me/matches", { token })).body.ratings;

		let s = await start(eve, "neon-survival-mp");
		check("a run against bots is only for a game with that board (not co-op Neon Survival)", s.status === 400 && /against bots/.test(s.body.error), s.body);
		s = await start(null, "lokeshmohanty/battleship");
		check("…and needs a sign-in", s.status === 401);
		s = (await start(eve, "lokeshmohanty/battleship")).body;
		check("a run against bots: an id, a seed, the server's clock", typeof s.run === "string" && Number.isInteger(s.seed), s);
		let r = await report(eve, win(s.run));
		check("a win against a bot, the one person in the match, under its run, counts", r.body.counted === true && r.body.board === "bots" && r.body.wins === 1, r.body);
		r = await report(eve, win(s.run, "pe", E, { match: 2 }));
		check("…once: the run is used up", r.body.counted === false && /already reported/.test(r.body.why), r.body);
		check("…and it is not a rating: no battleship rating, Elo or ranked match for Eve", !(await ratingsOf(eve)).some((x) => x.game === "lokeshmohanty/battleship") && (await call("GET", "/api/me/matches", { token: eve })).body.matches.length === 0);
		check("…nor on the ranked board", !(await call("GET", "/api/lb/lokeshmohanty/battleship")).body.rows.some((x) => x.id === E));
		let bb = await call("GET", "/api/lb/lokeshmohanty/battleship?vs=bots");
		check("…but on the board of wins against bots", bb.body.kind === "bots" && bb.body.vs === "bots" && bb.body.rows[0]?.id === E && bb.body.rows[0].wins === 1 && bb.body.perDay === 3, bb.body);

		s = (await start(eve, "lokeshmohanty/battleship", 0)).body;
		r = await report(eve, win(s.run));
		check(`a win sooner than the game's fastest legal one (${BOTS["lokeshmohanty/battleship"].minMs / 1000} s) is refused`, r.body.counted === false && /too fast/.test(r.body.why), r.body);
		s = (await start(eve, "lokeshmohanty/battleship")).body;
		r = await report(eve, win(s.run, "pe", E, { ranking: [["bot_1"], ["pe"]] }));
		check("a loss does not count", r.body.counted === false && /only a win/.test(r.body.why), r.body);
		r = await report(eve, win(s.run, "pe", E, { ranking: [["pe", "bot_1"]] }));
		check("…nor a draw", r.body.counted === false && /only a win/.test(r.body.why), r.body);
		r = await report(eve, win(s.run, "pe", E, { kind: "teams", ranking: [["pe", "bot_1", "bot_2"], ["bot_3"]] }));
		check("…nor first place shared with bot teammates", r.body.counted === false && /only a win/.test(r.body.why), r.body);
		const nf = (await start(eve, "neon-fission")).body;
		r = await report(eve, { game: "neon-fission", run: nf.run, match: 1, kind: "ffa", ranking: [["pe"], ["pf"], ["bot_1"]], roster: { pe: E, pf: F } });
		check("a match with another person in it does not count against bots", r.body.counted === false && /one person/.test(r.body.why), r.body);
		check("…and is not on that board", !(await call("GET", "/api/lb/neon-fission?vs=bots")).body.rows.some((x) => x.id === E));
		r = await report(eve, win("party-run-id"));
		check("a win without a run from the server is refused", r.body.counted === false && /run the server issued/.test(r.body.why), r.body);
		const fays = (await start(fay, "lokeshmohanty/battleship")).body;
		r = await report(eve, win(fays.run));
		check("…so is another player's run", r.body.counted === false && /another player/.test(r.body.why), r.body);
		const solo = (await start(eve, "lokeshmohanty/light-cycles", 60_000, null)).body;
		r = await report(eve, { ...win(solo.run), game: "lokeshmohanty/light-cycles", kind: "ffa" });
		check("…and a solo run used for a win against bots", r.body.counted === false && /played alone/.test(r.body.why), r.body);
		const vb = (await start(eve, "lokeshmohanty/light-cycles", 60_000)).body;
		r = await report(eve, { game: "lokeshmohanty/light-cycles", run: vb.run, match: 1, kind: "ffa", ranking: [["pe"]], roster: { pe: E }, scores: { pe: 3 }, seats: 1 });
		check("…and a run against bots used for a round alone", r.body.counted === false && /against bots/.test(r.body.why), r.body);
		r = await report(eve, { ...win(s.run), game: "lokeshmohanty/battleship", kind: "coop" });
		check("a kind of game with no winner does not count", r.body.counted === false && /no winner/.test(r.body.why), r.body);

		// BOTS_PER_DAY is 3 here (20 deployed): Eve has 1 battleship win.
		for (let i = 0; i < 2; i++) await report(eve, win((await start(eve, "lokeshmohanty/battleship")).body.run));
		s = (await start(eve, "lokeshmohanty/battleship")).body;
		r = await report(eve, win(s.run));
		check("past the day's wins against bots in a game, a win does not count, and says why", r.body.counted === false && /3 wins against bots count a day/.test(r.body.why), r.body);
		const tt = (await start(eve, "lokeshmohanty/liars-dice")).body;
		r = await report(eve, { ...win(tt.run), game: "lokeshmohanty/liars-dice" });
		check("…in that game only: another game's still counts", r.body.counted === true && r.body.wins === 1, r.body);

		// Review, 2026-11-15: ten reports posted at once all passed a count read
		// before any claimed. The cap is now inside the claim.
		const gus = await testLogin("Gus");
		const G = await id(gus);
		const runs = [];
		for (let i = 0; i < 8; i++) runs.push((await start(gus, "neon-fission")).body.run);
		const raced = await Promise.all(runs.map((run) => report(gus, win(run, "pg", G, { game: "neon-fission", kind: "ffa" }))));
		const counted = raced.filter((x) => x.body.counted).length;
		check("wins against bots posted in parallel stop at the day's cap (8 at once, cap 3)", counted === 3 && raced.filter((x) => /3 wins against bots count a day/.test(x.body.why ?? "")).length === 5, raced.map((x) => x.body.counted || x.body.why));
		const gb = (await call("GET", "/api/lb/neon-fission?vs=bots&me=1", { token: gus })).body.me;
		check("…and the board has exactly those wins (the claim and the win in one batch)", gb?.wins === 3, gb);
		check("…a refused run is still unused, and says the cap, not \"already reported\"", !raced.some((x) => /already reported/.test(x.body.why ?? "")));
		// One run posted five times at once: one win, however the posts land
		// (the win is added only where the run carries this report's claim).
		const one = (await start(gus, "lokeshmohanty/liars-dice")).body.run;
		const same = await Promise.all(Array.from({ length: 5 }, () => report(gus, win(one, "pg", G, { game: "lokeshmohanty/liars-dice" }))));
		const tw = (await call("GET", "/api/lb/lokeshmohanty/liars-dice?vs=bots&me=1", { token: gus })).body.me;
		check("the same run posted five times at once counts once, and adds one win", same.filter((x) => x.body.counted).length === 1 && same.filter((x) => /already reported/.test(x.body.why ?? "")).length === 4 && tw?.wins === 1, { got: same.map((x) => x.body.counted || x.body.why), wins: tw?.wins });

		// Fay reaches three later: the tie goes to whoever got there first.
		for (let i = 0; i < 3; i++) await report(fay, win((await start(fay, "lokeshmohanty/battleship")).body.run, "pf", F));
		bb = await call("GET", "/api/lb/lokeshmohanty/battleship?vs=bots");
		check("ranked by wins; a tie goes to whoever reached it first", bb.body.rows.map((x) => `${x.id === E ? "E" : x.id === F ? "F" : "?"}${x.wins}`).join() === "E3,F3" && bb.body.rows[0].at < bb.body.rows[1].at, bb.body.rows);
		const mine = await call("GET", "/api/lb/lokeshmohanty/battleship?vs=bots&me=1", { token: fay });
		check("?me=1: where you stand on it", mine.body.me?.id === F && mine.body.me.rank === 2, mine.body.me);
		check("friends' board against bots needs a sign-in", (await call("GET", "/api/lb/lokeshmohanty/battleship?vs=bots&scope=friends")).status === 401);
		check("…and holds only you and your friends", (await call("GET", "/api/lb/lokeshmohanty/battleship?vs=bots&scope=friends", { token: fay })).body.rows.map((x) => x.id).join() === F);
		check("a game with no such board says so", (await call("GET", "/api/lb/neon-survival-mp?vs=bots")).status === 400);
		check("Fay's ratings are untouched by all of it", (await ratingsOf(fay)).length === 0, await ratingsOf(fay));
		const mm = (await call("GET", "/api/me/matches", { token: eve })).body;
		check("your matches answer carries the wins against bots, apart from the ratings", mm.botWins?.map((x) => `${x.game}:${x.wins}`).join() === "lokeshmohanty/battleship:3,lokeshmohanty/liars-dice:1" && !mm.ratings.some((x) => x.game === "lokeshmohanty/battleship"), mm);
		check("…and so does the public profile", (await call("GET", `/api/u/${E}`)).body.botWins?.length === 2);
		const ex = await call("GET", "/api/me/export", { token: eve });
		check("export: the wins against bots", ex.body.winsAgainstBots?.find((x) => x.game === "lokeshmohanty/battleship")?.wins === 3, ex.body.winsAgainstBots);
		await call("DELETE", "/api/me", { token: eve });
		check("delete: gone from the board", !(await call("GET", "/api/lb/lokeshmohanty/battleship?vs=bots")).body.rows.some((x) => x.id === E));
	}

	console.log("\naccounts: friends, presence and invites");
	{
		let r = await call("POST", `/api/friends/${Bo}`, { token: ana });
		check("asking is pending", r.body.state === "pending", r.body);
		let list = await call("GET", "/api/friends", { token: bo });
		check("…and they see it as incoming", list.body.incoming.some((p) => p.id === A), list.body);
		check("asking yourself is refused", (await call("POST", `/api/friends/${A}`, { token: ana })).status === 400);
		check("asking nobody is a 404", (await call("POST", "/api/friends/nobody123", { token: ana })).status === 404);
		r = await call("POST", `/api/friends/${A}`, { token: bo });
		check("asking back is the yes", r.body.state === "friends", r.body);
		const fr = await call("GET", "/api/lb/lokeshmohanty/battleship?scope=friends", { token: ana });
		check("now the friends' board holds both", fr.body.rows.length === 2, fr.body.rows);

		// Bo opens a page: the live socket.
		const heard = [];
		const ws = new WebSocket(`${B.replace("http", "ws")}/live`, ["neon", bo]);
		await new Promise((ok, bad) => {
			ws.onopen = ok;
			ws.onerror = bad;
			setTimeout(bad, 8000);
		}).catch(() => {});
		check("a signed-in page opens the live socket", ws.readyState === WebSocket.OPEN, ws.readyState);
		ws.onmessage = (e) => heard.push(JSON.parse(e.data));
		ws.send(JSON.stringify({ t: "status", game: "connect4" }));
		// Presence is written by the live socket's Durable Object as the status
		// lands (worker/api/live.js): asked until it shows, for 10 s.
		const friendRow = async (until) => {
			let row;
			for (const end = Date.now() + 10_000; ; await new Promise((r) => setTimeout(r, 150))) {
				list = await call("GET", "/api/friends", { token: ana });
				row = list.body.friends.find((p) => p.id === Bo);
				if (until(row) || Date.now() > end) return row;
			}
		};
		const boRow = await friendRow((row) => row?.online === true && row.game === "connect4");
		check("a friend with a page open is online, in their game", boRow?.online === true && boRow.game === "connect4", boRow);
		r = await call("POST", `/api/friends/${Bo}/invite`, { token: ana, body: { code: "123456" } });
		for (const end = Date.now() + 10_000; !heard.some((m) => m.t === "invite" && m.code === "123456") && Date.now() < end; ) await new Promise((res) => setTimeout(res, 100));
		check("an invite reaches the friend's open page", r.body.invited === true && heard.some((m) => m.t === "invite" && m.code === "123456" && m.from.id === A), heard);
		check("…and the answer does not say how many pages got it (appear offline would leak)", r.body.delivered === undefined, r.body);
		check("inviting someone who is not a friend is refused", (await call("POST", `/api/friends/${C}/invite`, { token: ana, body: { code: "123456" } })).status === 403);
		check("an invite needs a six-digit code", (await call("POST", `/api/friends/${Bo}/invite`, { token: ana, body: { code: "12" } })).status === 400);
		await call("PATCH", "/api/me", { token: bo, body: { appearOffline: true } });
		list = await call("GET", "/api/friends", { token: ana });
		check("appear offline: friends see them offline", list.body.friends.find((p) => p.id === Bo)?.online === false);
		await call("PATCH", "/api/me", { token: bo, body: { appearOffline: false } });
		list = await call("GET", "/api/friends", { token: ana });
		const back = list.body.friends.find((p) => p.id === Bo);
		check("…and turning it off shows them online again at once, in their game", back?.online === true && back.game === "connect4", back);
		ws.close();
		const gone = await friendRow((row) => row?.online === false);
		check("closing the last page goes offline", gone?.online === false, gone);
		const bad = new WebSocket(`${B.replace("http", "ws")}/live`, ["neon", "forged.token"]);
		const refused = await new Promise((r) => {
			bad.onopen = () => r(false);
			bad.onerror = () => r(true);
			bad.onclose = () => r(true);
			setTimeout(() => r(false), 5000);
		});
		check("the live socket refuses a forged token", refused);
	}

	console.log("\naccounts: groups");
	{
		const g = await call("POST", "/api/groups", { token: ana, body: { name: "Lunch table" } });
		check("making a group gives it a join code", g.body.id && /^[A-Z2-9]{8}$/.test(g.body.code), g.body);
		const j = await call("POST", "/api/groups/join", { token: cy, body: { code: g.body.code.toLowerCase() } });
		check("joining by its code (any case)", j.body.id === g.body.id, j.body);
		check("a wrong code is a 404", (await call("POST", "/api/groups/join", { token: cy, body: { code: "ZZZZZZZZ" } })).status === 404);
		check("a non-member cannot see it", (await call("GET", `/api/groups/${g.body.id}`, { token: bo })).status === 403);
		const got = await call("GET", `/api/groups/${g.body.id}`, { token: cy });
		check("members can", got.body.members.length === 2 && got.body.mine === false, got.body);
		// Ana and Cy play Battleship together: only that match is the group's.
		const gm = { game: "lokeshmohanty/battleship", run: "g1", match: 1, kind: "duel", ranking: [["pc"], ["pa"]], roster: { pa: A, pc: C } };
		await call("POST", "/api/match/report", { token: ana, body: gm });
		await call("POST", "/api/match/report", { token: cy, body: gm });
		const lb = await call("GET", `/api/lb/lokeshmohanty/battleship?scope=group:${g.body.id}`, { token: ana });
		check("the group's board counts only matches among its members", lb.body.rows.length === 2 && lb.body.rows[0].id === C && lb.body.rows[0].games === 1, lb.body.rows);
		check("…with its own rating, from 1200 (provisional K)", lb.body.rows[0].elo === 1200 + ELO_K_PROVISIONAL / 2 && lb.body.rows[1].elo === 1200 - ELO_K_PROVISIONAL / 2 && lb.body.rows[0].provisional === true, lb.body.rows);
		check("someone else's group board is refused", (await call("GET", `/api/lb/lokeshmohanty/battleship?scope=group:${g.body.id}`, { token: bo })).status === 403);
		check("only the owner removes members", (await call("DELETE", `/api/groups/${g.body.id}/members/${A}`, { token: cy })).status === 403);
		check("anyone may leave", (await call("DELETE", `/api/groups/${g.body.id}/members/${C}`, { token: cy })).body.removed === true);
		check("only the owner deletes it", (await call("DELETE", `/api/groups/${g.body.id}`, { token: cy })).status === 403);
		check("…and the owner can", (await call("DELETE", `/api/groups/${g.body.id}`, { token: ana })).body.deleted === true);
		check("my groups list is empty again", (await call("GET", "/api/groups", { token: ana })).body.groups.length === 0);
	}

	// A page's live socket for `token`: { heard, close }.
	const listen = async (token) => {
		const heard = [];
		const ws = new WebSocket(`${B.replace("http", "ws")}/live`, ["neon", token]);
		await new Promise((ok, bad) => {
			ws.onopen = ok;
			ws.onerror = bad;
			setTimeout(bad, 8000);
		}).catch(() => {});
		ws.onmessage = (e) => heard.push(JSON.parse(e.data));
		return { heard, close: () => ws.close() };
	};
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const person = async (name) => {
		const token = await testLogin(name);
		return { token, id: await id(token), name };
	};

	console.log("\naccounts: friend codes");
	{
		const fia = await person("Fia");
		const gus = await person("Gil");
		const me = (await call("GET", "/api/me", { token: fia.token })).body;
		me.friendCode ??= "NOCODE22"; // a server without friend codes: fail the checks, not the run
		check("an account has a short friend code", /^[A-HJKMNP-Z2-9]{8}$/.test(me.friendCode ?? ""), me.friendCode);
		check("…the same one every time", (await call("GET", "/api/me", { token: fia.token })).body.friendCode === me.friendCode);
		const dashed = `${me.friendCode.slice(0, 4)}-${me.friendCode.slice(4)}`.toLowerCase();
		const byCode = await call("GET", `/api/u/${dashed}`);
		check("a profile by friend code (any case, a dash or not) is the account's", byCode.status === 200 && byCode.body.id === fia.id && byCode.body.name === "Fia", byCode.body);
		check("…and is not cached publicly (it can be rotated)", !/public/.test(byCode.headers.get("cache-control") ?? ""), byCode.headers.get("cache-control"));
		const asked = await call("POST", `/api/friends/${me.friendCode}`, { token: gus.token });
		check("asking by friend code", asked.body.state === "pending" && (await call("GET", "/api/friends", { token: fia.token })).body.incoming.some((p) => p.id === gus.id), asked.body);
		const rot = await call("POST", "/api/me/friend-code", { token: fia.token });
		check("rotating gives a new code", /^[A-HJKMNP-Z2-9]{8}$/.test(rot.body.friendCode ?? "") && rot.body.friendCode !== me.friendCode, rot.body);
		check("…the old one is dead", (await call("GET", `/api/u/${me.friendCode}`)).status === 404 && (await call("POST", `/api/friends/${me.friendCode}`, { token: gus.token })).status === 404);
		check("…the new one works", (await call("GET", `/api/u/${rot.body.friendCode}`)).body.id === fia.id);
		check("…and an old link by account id still does", (await call("GET", `/api/u/${fia.id}`)).body.id === fia.id);
		check("only you rotate yours (signed in)", (await call("POST", "/api/me/friend-code")).status === 401);
		const ip = "10.98.0.1";
		let last = 0;
		for (let i = 0; i < 125 && last !== 429; i++) last = (await call("GET", `/api/u/ZZZZ${String(i).padStart(4, "2").replace(/[01]/g, "2")}`, { ip })).status;
		check("guessing friend codes from one address is cut off (enumeration)", last === 429, last);
		check("…while a profile by account id is still a public read", (await call("GET", `/api/u/${fia.id}`, { ip })).status === 200);
	}

	console.log("\naccounts: friend requests — pushed once, declined, blocked, capped");
	{
		const [p1, p2] = [await person("Pia"), await person("Quin")];
		const ear = await listen(p2.token);
		for (let i = 0; i < 3; i++) await call("POST", `/api/friends/${p2.id}`, { token: p1.token });
		const ear1 = await listen(p1.token);
		const acc = await call("POST", `/api/friends/${p1.id}`, { token: p2.token });
		await call("POST", `/api/friends/${p2.id}`, { token: p1.token }); // already friends
		await sleep(500);
		const asks = ear.heard.filter((m) => m.t === "friend");
		check("asking three times pushes one request", asks.length === 1 && asks[0].state === "asked" && asks[0].id === p1.id, ear.heard);
		check("…the yes is pushed to the asker", acc.body.state === "friends" && ear1.heard.filter((m) => m.t === "friend" && m.state === "friends").length === 1, ear1.heard);
		check("…and asking a friend again pushes nothing", ear.heard.filter((m) => m.t === "friend").length === 1);
		ear.close();
		ear1.close();

		const [x, y] = [await person("Xan"), await person("Yul")];
		await Promise.all([call("POST", `/api/friends/${y.id}`, { token: x.token }), call("POST", `/api/friends/${x.id}`, { token: y.token })]);
		await call("POST", `/api/friends/${y.id}`, { token: x.token });
		const lx = (await call("GET", "/api/friends", { token: x.token })).body;
		check("crossing requests end as one friendship, nothing left pending", lx.friends.filter((p) => p.id === y.id).length === 1 && !lx.incoming.length && !lx.outgoing.length, lx);

		const [d1, d2] = [await person("Dov"), await person("Eda")];
		await call("POST", `/api/friends/${d2.id}`, { token: d1.token });
		const no = await call("DELETE", `/api/friends/${d1.id}`, { token: d2.token });
		check("declining", no.status === 200 && !(await call("GET", "/api/friends", { token: d2.token })).body.incoming.length);
		const again = await call("POST", `/api/friends/${d2.id}`, { token: d1.token });
		check("…is remembered: asking again soon is refused", again.status === 429 && /again/.test(again.body.error), again.body);
		check("…withdrawing it does not reset that", (await call("DELETE", `/api/friends/${d2.id}`, { token: d1.token })).status === 200 && (await call("POST", `/api/friends/${d2.id}`, { token: d1.token })).status === 429);
		check("…the asker's list shows nothing pending", !(await call("GET", "/api/friends", { token: d1.token })).body.outgoing.length);
		const change = await call("POST", `/api/friends/${d1.id}`, { token: d2.token });
		check("…but who declined may still ask (then it is the other's to accept)", change.body.state === "pending" && (await call("GET", "/api/friends", { token: d1.token })).body.incoming.some((p) => p.id === d2.id), change.body);

		const [b1, b2] = [await person("Bea"), await person("Cal")];
		await call("POST", `/api/friends/${b2.id}`, { token: b1.token });
		await call("POST", `/api/friends/${b1.id}`, { token: b2.token });
		const blk = await call("POST", `/api/friends/${b1.id}/block`, { token: b2.token });
		const lb2 = (await call("GET", "/api/friends", { token: b2.token })).body;
		check("blocking ends a friendship and lists the blocked", blk.body.state === "blocked" && !lb2.friends.length && lb2.blocked?.some((p) => p.id === b1.id), lb2);
		check("…the blocked one no longer sees them", !(await call("GET", "/api/friends", { token: b1.token })).body.friends.length);
		const ear2 = await listen(b2.token);
		const tryAgain = await call("POST", `/api/friends/${b2.id}`, { token: b1.token });
		await sleep(400);
		check("…a request from them goes nowhere and pushes nothing (and does not say so)", tryAgain.status === 200 && !(await call("GET", "/api/friends", { token: b2.token })).body.incoming.length && !ear2.heard.some((m) => m.t === "friend"), { tryAgain: tryAgain.body, heard: ear2.heard });
		ear2.close();
		await call("DELETE", `/api/friends/${b2.id}`, { token: b1.token });
		check("…they cannot lift the block themselves", (await call("GET", "/api/friends", { token: b2.token })).body.blocked?.some((p) => p.id === b1.id));
		check("…you cannot ask someone you blocked", (await call("POST", `/api/friends/${b1.id}`, { token: b2.token })).status === 400);
		await call("DELETE", `/api/friends/${b1.id}/block`, { token: b2.token });
		check("unblocking: they may ask again", (await call("POST", `/api/friends/${b2.id}`, { token: b1.token })).body.state === "pending" && (await call("GET", "/api/friends", { token: b2.token })).body.incoming.some((p) => p.id === b1.id));

		// FRIENDS_MAX is 3 here.
		const t = await person("Tara");
		const fans = [];
		for (let i = 0; i < 4; i++) fans.push(await person(`Fan${i}`));
		for (const f of fans) await call("POST", `/api/friends/${t.id}`, { token: f.token });
		const own = await call("POST", `/api/friends/${p1.id}`, { token: t.token });
		check("a flood of incoming requests does not use up your friend cap", own.body.state === "pending", own.body);
		for (const f of fans.slice(0, 3)) await call("POST", `/api/friends/${f.id}`, { token: t.token });
		const over = await call("POST", `/api/friends/${fans[3].id}`, { token: t.token });
		check("…but accepting past the cap is refused", over.status === 400 && /at most 3/.test(over.body.error), over.body);
		check("…and so is accepting for someone at theirs", (await call("POST", `/api/friends/${t.id}`, { token: p1.token })).status === 400);
	}

	console.log("\naccounts: party invites — waiting, muted, rate-limited");
	{
		const [h, g, m] = [await person("Hux"), await person("Gia"), await person("Mo")];
		for (const o of [g, m]) {
			await call("POST", `/api/friends/${o.id}`, { token: h.token });
			await call("POST", `/api/friends/${h.id}`, { token: o.token });
		}
		const r = await call("POST", `/api/friends/${g.id}/invite`, { token: h.token, body: { code: "654321" } });
		check("inviting a friend with no page open: the same answer", r.status === 200 && r.body.invited === true && r.body.delivered === undefined, r.body);
		let waiting = await call("GET", "/api/invites", { token: g.token });
		check("…the invite waits for their next visit", waiting.body.invites?.length === 1 && waiting.body.invites[0].code === "654321" && waiting.body.invites[0].from.id === h.id && waiting.body.invites[0].from.name === "Hux", waiting.body);
		check("…only for them", (await call("GET", "/api/invites", { token: m.token })).body.invites?.length === 0);
		check("inviting the same friend again at once is refused", (await call("POST", `/api/friends/${g.id}/invite`, { token: h.token, body: { code: "654321" } })).status === 429);
		check("NOT NOW (or JOIN) clears it", (await call("DELETE", `/api/invites/${h.id}`, { token: g.token })).status === 200 && (await call("GET", "/api/invites", { token: g.token })).body.invites?.length === 0);
		await call("POST", `/api/friends/${m.id}/invite`, { token: h.token, body: { code: "111222" } });
		await sleep(4300); // INVITE_TTL_MS is 4 s here (10 minutes for real)
		check("an invite left waiting expires", (await call("GET", "/api/invites", { token: m.token })).body.invites?.length === 0);
		await call("POST", `/api/friends/${h.id}/mute`, { token: m.token });
		check("muting a friend: still a friend, marked muted", (await call("GET", "/api/friends", { token: m.token })).body.friends?.find((p) => p.id === h.id)?.muted === true);
		const ear = await listen(m.token);
		const muted = await call("POST", `/api/friends/${m.id}/invite`, { token: h.token, body: { code: "333444" } });
		await sleep(400);
		check("…their invite answers the same, but is neither pushed nor kept", muted.body.invited === true && !ear.heard.some((x) => x.t === "invite") && (await call("GET", "/api/invites", { token: m.token })).body.invites?.length === 0, { muted: muted.body, heard: ear.heard });
		ear.close();
		await call("DELETE", `/api/friends/${h.id}/mute`, { token: m.token });
		check("…and unmuting", (await call("GET", "/api/friends", { token: m.token })).body.friends?.find((p) => p.id === h.id)?.muted === false);
		await call("DELETE", `/api/friends/${g.id}`, { token: h.token });
		check("unfriending drops their waiting invites", (await call("GET", "/api/invites", { token: g.token })).body.invites?.length === 0);
	}

	console.log("\naccounts: a hidden player — befriended by link, seen by friends, private elsewhere");
	{
		const [hid, fr, st] = [await person("Hid"), await person("Fren"), await person("Stra")];
		// Hid and Stra play a ranked game; Hid then hides.
		// A boarded game (Tic Tac Toe has no boards since 2026-11-16), both reporting.
		const gm = { game: "lokeshmohanty/battleship", run: "hidden-1", match: 1, kind: "duel", ranking: [["ps"], ["ph"]], roster: { ph: hid.id, ps: st.id }, seats: 2 };
		await call("POST", "/api/match/report", { token: hid.token, body: gm });
		await call("POST", "/api/match/report", { token: st.token, body: gm });
		await call("PATCH", "/api/me", { token: hid.token, body: { hidePublic: true } });
		const code = (await call("GET", "/api/me", { token: hid.token })).body.friendCode;
		const anon = await call("GET", `/api/u/${code}`);
		check("a hidden player's friend link still names them, for ADD FRIEND", anon.status === 200 && anon.body.hidden === true && anon.body.name === "Hid" && anon.body.id === hid.id && !anon.body.ratings, anon.body);
		check("…and the request goes through", (await call("POST", `/api/friends/${hid.id}`, { token: fr.token })).body.state === "pending");
		await call("POST", `/api/friends/${fr.id}`, { token: hid.token });
		const asFriend = await call("GET", `/api/u/${hid.id}`, { token: fr.token });
		check("a friend sees their full profile", asFriend.body.hidden === true && Array.isArray(asFriend.body.ratings) && asFriend.body.matches?.length === 1, asFriend.body);
		check("…personal, never cached publicly", !/public/.test(asFriend.headers.get("cache-control") ?? ""));
		check("…anyone else does not", (await call("GET", `/api/u/${hid.id}`, { token: st.token })).body.ratings === undefined);
		const strangers = await call("GET", `/api/u/${st.id}`);
		const names = strangers.body.matches?.flatMap((x) => x.ranking.flat()) ?? [];
		check("in other people's public profiles a hidden player is \"(hidden)\", with no id", names.length === 2 && names.some((p) => p.name === "(hidden)" && p.id === null) && !JSON.stringify(strangers.body).includes(hid.id), names);
		check("…and their own name is still theirs", names.some((p) => p.id === st.id && p.name === "Stra"));
		await call("PATCH", "/api/me", { token: hid.token, body: { hidePublic: false } });
	}

	console.log("\naccounts: players you just played");
	{
		const [r1, r2, r3, r4] = [await person("Ria"), await person("Rex"), await person("Roo"), await person("Rue")];
		const play = async (run, others) => {
			const roster = { p0: r1.id };
			others.forEach((o, i) => (roster[`p${i + 1}`] = o.id));
			const gm = { game: "neon-bid", run, match: 1, kind: "ffa", ranking: Object.keys(roster).map((k) => [k]), roster };
			for (const t of [r1, ...others]) await call("POST", "/api/match/report", { token: t.token, body: gm });
		};
		await play("recent-1", [r2, r3, r4]);
		await call("POST", `/api/friends/${r2.id}`, { token: r1.token });
		await call("POST", `/api/friends/${r1.id}`, { token: r2.token });
		await call("POST", `/api/friends/${r3.id}/block`, { token: r1.token });
		await call("PATCH", "/api/me", { token: r4.token, body: { hidePublic: true } });
		let rec = await call("GET", "/api/friends/recent", { token: r1.token });
		check("recent players leave out friends, the blocked, the hidden and you", rec.status === 200 && rec.body.players?.length === 0, rec.body);
		await call("PATCH", "/api/me", { token: r4.token, body: { hidePublic: false } });
		rec = await call("GET", "/api/friends/recent", { token: r1.token });
		check("…and list the rest, with the game", rec.body.players?.length === 1 && rec.body.players[0].id === r4.id && rec.body.players[0].game === "neon-bid", rec.body);
		check("…signed in only", (await call("GET", "/api/friends/recent")).status === 401);
	}

	console.log("\naccounts: groups — bans, owners, caps");
	{
		const [o, m1, m2, j] = [await person("Oona"), await person("Mika"), await person("Mira"), await person("Jo")];
		let g = (await call("POST", "/api/groups", { token: o.token, body: { name: "Crew" } })).body;
		await call("POST", "/api/groups/join", { token: m1.token, body: { code: g.code } });
		await sleep(5);
		await call("POST", "/api/groups/join", { token: m2.token, body: { code: g.code } });
		const kick = await call("DELETE", `/api/groups/${g.id}/members/${m2.id}`, { token: o.token });
		check("kicking someone rotates the code", kick.body.removed === true && kick.body.code && kick.body.code !== g.code, kick.body);
		check("…the old code is dead", (await call("POST", "/api/groups/join", { token: m2.token, body: { code: g.code } })).status === 404);
		const back = await call("POST", "/api/groups/join", { token: m2.token, body: { code: kick.body.code } });
		check("…and the new one does not let them back in", back.status === 403, back.body);
		const view = (await call("GET", `/api/groups/${g.id}`, { token: o.token })).body;
		check("the owner sees who was removed", view.bans?.some((b) => b.id === m2.id) && view.code === kick.body.code, view);
		check("…members do not", (await call("GET", `/api/groups/${g.id}`, { token: m1.token })).body.bans === undefined);
		await call("DELETE", `/api/groups/${g.id}/bans/${m2.id}`, { token: o.token });
		check("letting them back: the current code works again", (await call("POST", "/api/groups/join", { token: m2.token, body: { code: kick.body.code } })).body.id === g.id);
		check("only the owner rotates the code", (await call("POST", `/api/groups/${g.id}/code`, { token: m1.token })).status === 403);
		const rot = await call("POST", `/api/groups/${g.id}/code`, { token: o.token });
		check("…and the owner can", /^[A-Z2-9]{8}$/.test(rot.body.code ?? "") && rot.body.code !== kick.body.code, rot.body);
		check("only the owner renames it", (await call("PATCH", `/api/groups/${g.id}`, { token: m1.token, body: { name: "Mine" } })).status === 403);
		check("…and the owner can", (await call("PATCH", `/api/groups/${g.id}`, { token: o.token, body: { name: "Night crew" } })).body.name === "Night crew");

		const tr = await call("POST", `/api/groups/${g.id}/owner`, { token: o.token, body: { account: m1.id } });
		check("handing the group over", tr.body.owner === m1.id && (await call("GET", `/api/groups/${g.id}`, { token: m1.token })).body.mine === true, tr.body);
		check("…to a member only", (await call("POST", `/api/groups/${g.id}/owner`, { token: m1.token, body: { account: j.id } })).status === 400);
		check("…the old owner is now a member like any other", (await call("DELETE", `/api/groups/${g.id}/members/${m2.id}`, { token: o.token })).status === 403);
		await call("POST", `/api/groups/${g.id}/owner`, { token: m1.token, body: { account: o.id } });
		const left = await call("DELETE", `/api/groups/${g.id}/members/${o.id}`, { token: o.token });
		const after = (await call("GET", `/api/groups/${g.id}`, { token: m1.token })).body;
		check("the owner may leave: the longest-standing member owns it", left.body.removed === true && after.owner === m1.id && after.members?.length === 2, after);

		g = (await call("POST", "/api/groups", { token: m2.token, body: { name: "Duo" } })).body;
		await call("POST", "/api/groups/join", { token: j.token, body: { code: g.code } });
		await call("DELETE", "/api/me", { token: m2.token });
		const kept = await call("GET", `/api/groups/${g.id}`, { token: j.token });
		check("an owner deleting their account leaves the group to the next member", kept.status === 200 && kept.body.owner === j.id && kept.body.members?.length === 1, kept.body);
		const solo = (await call("POST", "/api/groups", { token: o.token, body: { name: "Just me" } })).body;
		await call("DELETE", `/api/groups/${solo.id}/members/${o.id}`, { token: o.token });
		check("…and the last member leaving deletes it", (await call("GET", `/api/groups/${solo.id}`, { token: o.token })).status === 404);

		// GROUPS_MAX is 2 here: Jo is in Duo; one more, then joining is refused.
		const third = (await call("POST", "/api/groups", { token: o.token, body: { name: "Third" } })).body;
		check("joining up to the cap", (await call("POST", "/api/groups/join", { token: j.token, body: { code: third.code } })).body.id === third.id);
		const fourth = (await call("POST", "/api/groups", { token: m1.token, body: { name: "Fourth" } })).body;
		const capped = await call("POST", "/api/groups/join", { token: j.token, body: { code: fourth.code } });
		check("…joining past it is refused, as making one is", capped.status === 400 && /at most 2/.test(capped.body.error), capped.body);
		check("…joining one you are in again is not", (await call("POST", "/api/groups/join", { token: j.token, body: { code: third.code } })).status === 200);
		const gv = (await call("GET", `/api/groups/${third.id}`, { token: j.token })).body;
		check("a group says which games its members play, for its boards", Array.isArray(gv.games), gv);
	}

	console.log("\naccounts: a block stays silent; requests, groups and export edge cases");
	{
		const [v, wv, x] = [await person("Vee"), await person("Wes"), await person("Xia")];
		// Vee and Wes played; then Vee blocks Wes.
		const gm = { game: "lokeshmohanty/battleship", run: "block-1", match: 1, kind: "duel", ranking: [["pv"], ["pw"]], roster: { pv: v.id, pw: wv.id }, seats: 2 };
		await call("POST", "/api/match/report", { token: v.token, body: gm });
		await call("POST", "/api/match/report", { token: wv.token, body: gm });
		await call("POST", `/api/friends/${wv.id}/block`, { token: v.token });
		const ex = (await call("GET", "/api/me/export", { token: wv.token })).body;
		check("the blocked one's export does not show the block", !(ex.friends ?? []).some((r) => r.state === "blocked"), ex.friends);
		check("…nor do their recent players drop the one who blocked them", (await call("GET", "/api/friends/recent", { token: wv.token })).body.players?.some((p) => p.id === v.id));
		check("…while the blocker's leave them out", !(await call("GET", "/api/friends/recent", { token: v.token })).body.players?.some((p) => p.id === wv.id));
		await call("POST", `/api/friends/${v.id}`, { token: wv.token });
		await call("POST", `/api/friends/${x.id}`, { token: wv.token });
		const out = (await call("GET", "/api/friends", { token: wv.token })).body.outgoing.map((p) => p.id);
		check("asking someone who blocked you looks like asking anyone: it is in your outgoing list", out.includes(v.id) && out.includes(x.id), out);
		check("…and not in theirs", !(await call("GET", "/api/friends", { token: v.token })).body.incoming.length);
		await call("DELETE", `/api/friends/${wv.id}/block`, { token: v.token });
		check("unblocking: the request made while blocked turns up as incoming, to answer", (await call("GET", "/api/friends", { token: v.token })).body.incoming.some((p) => p.id === wv.id));
		check("…and nothing changed for the asker", (await call("GET", "/api/friends", { token: wv.token })).body.outgoing.some((p) => p.id === v.id));

		// Blocked while a request waited, or after a decline: the asker cannot
		// tell a block from a request nobody answered, or from the decline.
		const [ya, za, yd] = [await person("Yan"), await person("Zed"), await person("Yda")];
		await call("POST", `/api/friends/${za.id}`, { token: ya.token });
		await call("POST", `/api/friends/${ya.id}/block`, { token: za.token });
		check("a request waiting when its asker is blocked stays in their outgoing list", (await call("GET", "/api/friends", { token: ya.token })).body.outgoing.some((p) => p.id === za.id));
		const reask = await call("POST", `/api/friends/${za.id}`, { token: ya.token });
		check("…and asking again answers as for a request nobody answered", reask.status === 200 && reask.body.state === "pending", reask);
		check("…while the blocker still sees nothing", !(await call("GET", "/api/friends", { token: za.token })).body.incoming.length);
		await call("POST", `/api/friends/${za.id}`, { token: yd.token });
		await call("DELETE", `/api/friends/${yd.id}`, { token: za.token });
		await call("POST", `/api/friends/${yd.id}/block`, { token: za.token });
		const cool = await call("POST", `/api/friends/${za.id}`, { token: yd.token });
		check("declined, then blocked: the decline's cooldown still answers", cool.status === 429, cool);
		await call("DELETE", `/api/friends/${ya.id}/block`, { token: za.token });
		check("unblocking: their waiting request is incoming for the unblocker", (await call("GET", "/api/friends", { token: za.token })).body.incoming.some((p) => p.id === ya.id));
		check("…and unchanged for the asker", (await call("GET", "/api/friends", { token: ya.token })).body.outgoing.some((p) => p.id === za.id));

		const ear = await listen(x.token);
		for (let i = 0; i < 3; i++) {
			await call("POST", `/api/friends/${x.id}`, { token: v.token });
			await call("DELETE", `/api/friends/${x.id}`, { token: v.token });
		}
		await sleep(400);
		check("asking, withdrawing and asking again pushes one request a day", ear.heard.filter((m) => m.t === "friend").length === 1, ear.heard);
		ear.close();

		const xc = (await call("GET", "/api/me", { token: x.token })).body.friendCode;
		const byCode = await call("POST", `/api/friends/${xc}/block`, { token: wv.token });
		check("blocking by friend code blocks that account", byCode.status === 200 && (await call("GET", "/api/friends", { token: wv.token })).body.blocked?.some((p) => p.id === x.id), byCode);
		check("…and an unknown code is a 404", (await call("POST", "/api/friends/ZZZZ-ZZZZ/block", { token: wv.token })).status === 404);

		const g = (await call("POST", "/api/groups", { token: v.token, body: { name: "Edge" } })).body;
		check("removing an account that does not exist is a 404", (await call("DELETE", `/api/groups/${g.id}/members/nobody123456`, { token: v.token })).status === 404);
		check("removing someone who is not in the group is a 404, not a ban", (await call("DELETE", `/api/groups/${g.id}/members/${x.id}`, { token: v.token })).status === 404);
		check("…so they can still join", (await call("POST", "/api/groups/join", { token: x.token, body: { code: g.code } })).body.id === g.id);
		const kicked = (await call("DELETE", `/api/groups/${g.id}/members/${x.id}`, { token: v.token })).body;
		check("…and once a member, removing them works", kicked.removed === true);
		check("transferring to someone who left is refused", (await call("POST", `/api/groups/${g.id}/owner`, { token: v.token, body: { account: x.id } })).status === 400);
		const xe = (await call("GET", "/api/me/export", { token: x.token })).body;
		check("export: the groups you were removed from", xe.groupBans?.some((b) => b.grp === g.id && b.account === x.id), xe.groupBans);
		const ve = (await call("GET", "/api/me/export", { token: v.token })).body;
		check("…and the removals you made", ve.groupBans?.some((b) => b.grp === g.id && b.account === x.id), ve.groupBans);
	}

	console.log("\naccounts: a profile's boards say their own kind and unit");
	{
		const prof = await call("GET", `/api/u/${A}`);
		const lc = prof.body.ratings?.find((r) => r.game === "lokeshmohanty/light-cycles@alone");
		check("Light Cycles alone: best score, in seconds", lc?.kind === "coop" && lc.unit === "s", lc);
		const mine = await call("GET", "/api/me/matches", { token: ana });
		check("…on your own profile too", mine.body.ratings?.find((r) => r.game === "lokeshmohanty/light-cycles@alone")?.unit === "s");
		const su = mine.body.ratings?.find((r) => r.game.startsWith("lokeshmohanty/sudoku@"));
		check("Sudoku's level boards: a time", !su || su.kind === "time", su);
	}

	console.log("\naccounts: feedback, from the player's own GitHub account");
	{
		let r = await call("POST", "/api/feedback/connect4", { token: ana, body: { text: "no GitHub yet" } });
		check("signed in without GitHub: refused, and told to connect it", r.status === 403 && r.body.code === "github", r.body);
		const anaGh = await testLogin("Ana", "&github=ana-gh");
		check("(Ana connects GitHub: the same account)", (await call("GET", "/api/me", { token: anaGh })).body.id === A);
		r = await call("POST", "/api/feedback/connect4", { token: ana, body: { text: "Love it @someone — more columns?" } });
		check("now a post goes to GitHub", r.body.posted === true, r.body);
		check("…the thread opened by the App, signed with a real App JWT", fake.jwtParts === 3 && fake.discussions.size === 1 && [...fake.discussions.values()][0].title === "Feedback: connect4");
		check("…the comment posted by Ana's own GitHub account", fake.authors[0] === "ana-gh", fake.authors);
		check("…as she wrote it, with the @ unable to ping, no byline", fake.comments[0] === "Love it @​someone — more columns?", fake.comments[0]);
		await testLogin("Bo", "&github=bo-gh&expires=1");
		const before = fake.refreshed;
		await call("POST", "/api/feedback/connect4", { token: bo, body: { text: "second" } });
		check("an expired GitHub token is refreshed on the way", fake.refreshed === before + 1 && fake.authors[1] === "bo-gh", { refreshed: fake.refreshed, authors: fake.authors });
		check("the next post reuses the discussion", fake.discussions.size === 1);
		const got = await call("GET", "/api/feedback/connect4");
		check("reading it back: newest first, by GitHub login", got.body.comments[0]?.login === "bo-gh" && got.body.comments[1]?.name === "ana-gh" && got.body.comments[1]?.text.startsWith("Love it @someone"), got.body);
		check("posting needs a sign-in", (await call("POST", "/api/feedback/connect4", { body: { text: "x" } })).status === 401);
		check("empty feedback is refused", (await call("POST", "/api/feedback/connect4", { token: ana, body: { text: " " } })).status === 400);
		for (let i = 0; i < 4; i++) await call("POST", "/api/feedback/connect4", { token: ana, body: { text: `more ${i}` } });
		r = await call("POST", "/api/feedback/connect4", { token: ana, body: { text: "one too many" } });
		check("five posts a day, then a polite 429", r.status === 429, r.body);
		const ex = await call("GET", "/api/me/export", { token: ana });
		check("the export lists the sign-ins and that a GitHub token is kept — never the token", ex.body.identities?.some((i) => i.provider === "github" && i.githubTokenKept) && !JSON.stringify(ex.body).includes("ut-ana-gh"), ex.body.identities);
		check("the last sign-in cannot be disconnected", (await call("DELETE", "/api/me/identities/test", { token: cy })).status === 400);
		r = await call("DELETE", "/api/me/identities/github", { token: bo });
		check("disconnecting GitHub keeps the account", r.status === 200 && r.body.identities.every((i) => i.provider !== "github"), r.body);
		r = await call("POST", "/api/feedback/connect4", { token: bo, body: { text: "after disconnecting" } });
		check("…and posting needs it again", r.status === 403 && r.body.code === "github", r.body);
	}

	console.log("\naccounts: the hourly public snapshot");
	{
		await call("PATCH", "/api/me", { token: cy, body: { hidePublic: true } });
		let r = await call("POST", "/api/admin/snapshot");
		check("a snapshot is one commit", !!r.body.committed && fake.commits.length === 1 && fake.commits[0].parents.length === 0, r.body);
		check("…on a new stats branch", fake.refs.get("heads/stats") === r.body.committed);
		const tree = fake.trees.get(fake.commits[0].tree);
		const file = (p) => JSON.parse(tree.find((t) => t.path === p)?.content ?? "null");
		check("…holding the play counts", file("stats/summary.json")?.games.connect4.played === 3);
		const c4 = file("stats/lb/lokeshmohanty__battleship.json");
		check("…and each game's board, without who hid themselves", c4?.rows.some((x) => x.id === A) && !c4.rows.some((x) => x.id === C), c4?.rows);
		check("…and no board for a game without one (the old Connect 4 row)", !tree.some((t) => t.path === "stats/lb/connect4.json"), tree.map((t) => t.path));
		const text = JSON.stringify(tree);
		check("…and nothing private: no sessions, friends, groups or providers", !/session|friend|group|provider|test-session-key/i.test(text.replace(/"game"/g, "")));
		r = await call("POST", "/api/admin/snapshot");
		check("an unchanged snapshot is not committed again", r.body.skipped === "unchanged" && fake.commits.length === 1, r.body);
		await call("POST", "/api/stats/played", { body: { game: "neon-bid" } });
		r = await call("POST", "/api/admin/snapshot");
		check("a changed one is, on top of the last", fake.commits.length === 2 && fake.commits[1].parents[0] === fake.commits[0].sha, r.body);
		const post = fake.treePosts.at(-1);
		check("…sending only what changed, over the last tree (base_tree)", post.base_tree === fake.commits[0].tree && post.tree.length === 1 && post.tree[0].path === "stats/summary.json", post);
		const kept = fake.trees.get(fake.commits[1].tree);
		check("…the boards it did not send are still in the commit", kept.some((x) => x.path === "stats/lb/lokeshmohanty__battleship.json") && JSON.parse(kept.find((x) => x.path === "stats/summary.json").content).games["neon-bid"].played >= 1, kept.map((x) => x.path));
		await call("PATCH", "/api/me", { token: cy, body: { hidePublic: false } });
	}

	console.log("\naccounts: boards of 100+ friends and members, the group board's plan");
	{
		// Made in the database directly: 120 accounts befriending Ana, in a
		// group with her, each rated at Battleship, a few matches among them.
		const N = 120;
		const q = (v) => `'${v}'`;
		const fid = (i) => `bulk${String(i).padStart(3, "0")}`;
		const now = Date.now();
		const grp = "bulkgroup1";
		await w.sql(
			[
				`INSERT INTO accounts (id, provider, provider_uid, name, created) VALUES ${Array.from({ length: N }, (_, i) => `(${q(fid(i))}, 'test', ${q(fid(i))}, ${q(`Bulk ${i}`)}, ${now})`).join(", ")};`,
				`INSERT INTO friends (a, b, state, at) VALUES ${Array.from({ length: N }, (_, i) => `(${q(fid(i))}, ${q(A)}, 'friends', ${now})`).join(", ")};`,
				`INSERT INTO ratings (account, game, elo, games, wins, best) VALUES ${Array.from({ length: N }, (_, i) => `(${q(fid(i))}, 'lokeshmohanty/battleship', ${1000 + i}, 3, 1, NULL)`).join(", ")};`,
				`INSERT INTO groups (id, name, owner, code, created) VALUES (${q(grp)}, 'Bulk', ${q(A)}, 'BULKBULK', ${now});`,
				`INSERT INTO group_members (grp, account, joined) VALUES (${q(grp)}, ${q(A)}, ${now}), ${Array.from({ length: N }, (_, i) => `(${q(grp)}, ${q(fid(i))}, ${now})`).join(", ")};`,
				`INSERT INTO matches (id, game, kind, ranking, scores, at) VALUES ${Array.from({ length: 10 }, (_, i) => `('bm${i}', 'lokeshmohanty/battleship', 'duel', '[["${fid(2 * i)}"],["${fid(2 * i + 1)}"]]', NULL, ${now + i})`).join(", ")};`,
				`INSERT INTO match_players (match, account, place) VALUES ${Array.from({ length: 10 }, (_, i) => `('bm${i}', ${q(fid(2 * i))}, 0), ('bm${i}', ${q(fid(2 * i + 1))}, 1)`).join(", ")};`,
			].join("\n"),
		);
		const fr = await call("GET", "/api/lb/lokeshmohanty/battleship?scope=friends", { token: ana });
		check(`a friends' board with ${N} friends (D1 allows 100 bound parameters)`, fr.status === 200 && fr.body.rows.length === 100, { status: fr.status, error: fr.body.error, n: fr.body.rows?.length });
		check("…and where you stand on it", fr.body.me?.id === A, fr.body.me);
		const gb = await call("GET", `/api/lb/lokeshmohanty/battleship?scope=group:${grp}`, { token: ana });
		check(`a group's board with ${N + 1} members`, gb.status === 200 && gb.body.rows.length === 20, { status: gb.status, error: gb.body.error, n: gb.body.rows?.length });
		const bb = await call("GET", `/api/lb/lokeshmohanty/battleship?vs=bots&scope=group:${grp}`, { token: ana });
		check("…and its board against bots", bb.status === 200, { status: bb.status, error: bb.body.error });
		const ex = await call("GET", `/api/u/${fid(0)}`);
		check("a profile whose matches name many players", ex.status === 200, ex.body);
		// The group board's query, as D1 plans it: driven from the game's
		// matches (newest first, bounded), never a scan of match_players.
		const bound = GROUP_MATCHES_SQL.replace("?", "'lokeshmohanty/battleship'").replace("?", String(GROUP_SCAN)).replace("?", q(grp)).replace("?", String(GROUP_REPLAY));
		const plan = (await w.sql(`EXPLAIN QUERY PLAN ${bound}`))[0].map((r) => r.detail);
		console.log(`  (plan: ${plan.join(" | ")})`);
		check("the group board's plan: the game's matches by index matches_game_at", plan.some((d) => /SEARCH matches USING (COVERING )?INDEX matches_game_at/.test(d)), plan);
		check("…match_players only by its primary key, per match — no full scan", plan.some((d) => /SEARCH p USING .*(PRIMARY KEY|sqlite_autoindex_match_players)/.test(d)) && !plan.some((d) => /SCAN (p|match_players)\b/.test(d)), plan);
	}

	console.log("\naccounts: export and delete");
	{
		// Something of each kind to export: a run against bots, a pending report.
		await call("POST", "/api/run/start", { token: ana, body: { game: "lokeshmohanty/battleship", vs: "bots" } });
		await report(ana, { game: "lokeshmohanty/battleship", run: "exp1", match: 1, kind: "duel", ranking: [["pa"], ["pc"]], roster: { pa: A, pc: C }, seats: 2 });
		const ex = await call("GET", "/api/me/export", { token: ana });
		check("export: the account, favourites, ratings, matches, friends", ex.body.account.id === A && ex.body.favourites.length === 2 && ex.body.ratings.length >= 2 && ex.body.matches.length >= 2 && ex.body.friends.length >= 1, Object.keys(ex.body));
		check("…every run the server issued, alone and against bots", ex.body.runs?.some((x) => x.vs === "solo") && ex.body.runs.some((x) => x.vs === "bots"), ex.body.runs?.map((x) => x.vs));
		check("…reports not yet settled", ex.body.reports?.some((x) => x.state === "pending" && x.result?.game === "lokeshmohanty/battleship"), ex.body.reports);
		check("…the feedback posts and the presence row", ex.body.feedbackPosts?.length === 5 && "presence" in ex.body, { posts: ex.body.feedbackPosts, presence: ex.body.presence });
		check("…its matches in pages, this one the last", ex.body.matchesPage === 0 && ex.body.matchesNext === null, { page: ex.body.matchesPage, next: ex.body.matchesNext });
		check("…and a page past the end is empty", (await call("GET", "/api/me/export?page=3", { token: ana })).body.matches.length === 0);
		const del = await call("DELETE", "/api/me", { token: ana });
		check("delete: done at once", del.body.deleted === true);
		check("…the session is gone", (await call("GET", "/api/me", { token: ana })).status === 401);
		check("…the public profile is gone", (await call("GET", `/api/u/${A}`)).status === 404);
		const lb = await call("GET", "/api/lb/lokeshmohanty/battleship");
		check("…and the leaderboards no longer list them", !lb.body.rows.some((r) => r.id === A), lb.body.rows);
		const boList = await call("GET", "/api/friends", { token: bo });
		check("…nor their friends' lists", boList.body.friends.length === 0, boList.body);
		const bm = await call("GET", "/api/me/matches", { token: bo });
		check("the other player's history keeps the match, the name shown as deleted", bm.body.matches.some((m) => m.ranking.flat().some((p) => p.name === "(deleted)")), bm.body.matches.map((m) => m.ranking));
	}

	console.log("\naccounts: a write limit per address");
	{
		const ip = "10.99.0.1";
		let last = 0;
		for (let i = 0; i < 125; i++) last = (await call("POST", "/api/stats/played", { ip, body: { game: "connect4" } })).status;
		check("past 120 writes in the window an address is told to wait", last === 429, last);
		check("…while reads still work", (await call("GET", "/api/stats/summary", { ip })).status === 200);
	}
} catch (err) {
	check(`unexpected: ${err.message}`, false);
	console.log(err.stack);
} finally {
	w.stop();
	server.close();
}

console.log(failures ? `\n${failures} account check(s) failed` : "\nall account checks passed");
process.exit(failures ? 1 : 0);
