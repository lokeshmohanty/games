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
import * as SU from "../worker/api/sudoku.js";
import { freePort, startWrangler } from "./wrangler.mjs";

let failures = 0;
const check = (label, ok, detail = "") => {
	console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
	if (!ok) failures++;
};

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
	SOLO_PER_DAY: "8",
	BOTS_PER_DAY: "3",
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
const testLogin = async (name, extra = "") => tokenOf(await walk(`${B}/auth/test?name=${encodeURIComponent(name)}${extra}&back=${encodeURIComponent(SITE + "/profile.html")}`));

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
		const back = encodeURIComponent(`${SITE}/profile.html?x=1`);
		const ghUrl = await walk(`${B}/auth/github/start?back=${back}`);
		const gh = tokenOf(ghUrl);
		check("GitHub: consent → callback → back to the page with a token", !!gh && ghUrl.startsWith(`${SITE}/profile.html?x=1#token=`), ghUrl);
		const me = await call("GET", "/api/me", { token: gh });
		check("…as the GitHub profile's name and avatar", me.body.name === "Octo Cat" && me.body.avatar === "https://avatars.example/42" && me.body.provider === "github", me.body);
		const again = tokenOf(await walk(`${B}/auth/github/start?back=${back}`));
		check("signing in again is the same account", (await call("GET", "/api/me", { token: again })).body.id === me.body.id);
		const g = tokenOf(await walk(`${B}/auth/google/start?back=${back}`));
		const gme = await call("GET", "/api/me", { token: g });
		check("Google: the same flow, a different account", gme.body.name === "Goo Gle" && gme.body.provider === "google" && gme.body.id !== me.body.id, gme.body);
		// One account, both sign-ins: connect GitHub to the Google account.
		const linkTo = async (token, provider) => walk((await call("POST", `/api/me/link/${provider}`, { token, body: { back: `${SITE}/profile.html` } })).body.url);
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
		game: "connect4",
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
		const rating = mine.body.ratings.find((x) => x.game === "connect4");
		check("the winner's Elo goes up from 1200, games and wins counted", rating?.elo > 1200 && rating.games === 1 && rating.wins === 1, rating);
		check("…and the match is in the history, with names", mine.body.matches[0]?.won === true && mine.body.matches[0].ranking[1][0].name === "Bo", mine.body.matches[0]);
		const boR = (await call("GET", "/api/me/matches", { token: bo })).body.ratings.find((x) => x.game === "connect4");
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
		check("a shared first place counts as a win for both", r.body.counted === true);
		const coop = { game: "neon-survival-mp", run: "s1", match: 1, kind: "coop", ranking: [["pa", "pb"]], roster: { pa: A, pb: Bo }, scores: { pa: 33, pb: 33 } };
		await call("POST", "/api/match/report", { token: ana, body: coop });
		await call("POST", "/api/match/report", { token: bo, body: coop });
		const surv = (await call("GET", "/api/me/matches", { token: ana })).body.ratings.find((x) => x.game === "neon-survival-mp");
		check("co-op keeps the best score, and is never a win", surv?.best === 33 && surv.wins === 0, surv);
	}

	console.log("\naccounts: leaderboards");
	{
		let lb = await call("GET", "/api/lb/connect4");
		check("global: ranked by Elo", lb.body.kind === "duel" && lb.body.rows.length === 2 && lb.body.rows[0].elo >= lb.body.rows[1].elo, lb.body);
		check("…public, cacheable for a minute", lb.headers.get("access-control-allow-origin") && /max-age=60/.test(lb.headers.get("cache-control") ?? ""));
		const nb = await call("GET", "/api/lb/neon-bid");
		check("free-for-all: by wins", nb.body.rows.filter((r) => r.wins === 1).length === 2 && nb.body.rows.at(-1).wins === 0, nb.body.rows);
		const mine = await call("GET", "/api/lb/connect4?me=1", { token: ana });
		const listed = mine.body.rows.find((r) => r.id === A);
		check("?me=1: where you stand, the same as your row", mine.body.me?.id === A && mine.body.me.rank === listed?.rank, mine.body.me);
		check("…and not publicly cached", !/public/.test(mine.headers.get("cache-control") ?? ""), mine.headers.get("cache-control"));
		check("…needs a sign-in", (await call("GET", "/api/lb/connect4?me=1")).status === 401);
		check("…null when you have no ranked game of it", (await call("GET", "/api/lb/connect4?me=1", { token: cy })).body.me === null);
		await call("PATCH", "/api/me", { token: bo, body: { hidePublic: true } });
		const hidden = await call("GET", "/api/lb/connect4?me=1", { token: bo });
		check("…hidden from public boards: no rank, and says why", hidden.body.me?.rank === null && hidden.body.me.hidden === true, hidden.body.me);
		lb = await call("GET", "/api/lb/connect4");
		check("hide me from public leaderboards: gone from the global board", !lb.body.rows.some((r) => r.id === Bo), lb.body.rows);
		check("…and the public profile is gone", (await call("GET", `/api/u/${Bo}`)).status === 404);
		await call("PATCH", "/api/me", { token: bo, body: { hidePublic: false } });
		const prof = await call("GET", `/api/u/${A}`);
		check("a public profile: name, ratings, recent matches", prof.body.name === "Ana P" && prof.body.ratings.length >= 2 && prof.body.matches.length >= 2, prof.body);
		check("friends' board needs a sign-in", (await call("GET", "/api/lb/connect4?scope=friends")).status === 401);
		const fr = await call("GET", "/api/lb/connect4?scope=friends", { token: cy });
		check("…and holds only you and your friends", fr.body.rows.length === 0, fr.body.rows);
	}

	console.log("\naccounts: solo runs, issued by the server");
	{
		const start = (token, game) => call("POST", "/api/run/start", { token, body: { game } });
		// Tests only: move a run's start into the past, as if time had passed.
		const age = (run, ms) => call("POST", "/api/admin/age-run", { body: { run, ms } });
		const report = (token, body) => call("POST", "/api/match/report", { token, body });
		const surv = (run, score, extra = {}) => ({ game: "neon-survival-mp", run, match: 1, kind: "coop", ranking: [["pa"]], roster: { pa: A }, scores: { pa: score }, ...extra });
		const ratingOf = async (token, game) => (await call("GET", "/api/me/matches", { token })).body.ratings.find((x) => x.game === game);
		const fresh = async (token = ana, ms = 60_000) => {
			const s = (await start(token, "neon-survival-mp")).body;
			if (ms) await age(s.run, ms);
			return s;
		};

		check("a run needs a sign-in", (await start(null, "neon-survival-mp")).status === 401);
		check("…and a game id", (await start(ana, "../etc")).status === 400);
		let r = await start(ana, "connect4");
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
		r = await report(ana, surv(quick.run, 1));
		check("a report sooner than the game's shortest run is refused", r.body.counted === false && /too fast/.test(r.body.why), r.body);
		const greedy = await fresh(ana, 10_000);
		r = await report(ana, surv(greedy.run, 100));
		check("a score above what the time since the run began allows is refused", r.body.counted === false && /more than a 10-second run/.test(r.body.why), r.body);
		for (const [bad, label] of [[1e308, "1e308"], [-1, "negative"], [2.5, "fractional"], [null, "missing"]]) {
			r = await report(ana, surv(greedy.run, bad));
			check(`…so is a ${label} score`, r.body.counted === false && /score/.test(r.body.why), r.body);
		}
		r = await report(ana, surv(greedy.run, 12, { match: 2 }));
		check("a refused report does not use the run up (it is claimed only once it counts)", r.body.counted === true, r.body);

		// Only SOLO games rank alone: no made-up score on any other game.
		const forged = { game: "connect4", run: "party-run-x", match: 1, kind: "duel", ranking: [["pa"]], roster: { pa: A }, scores: { pa: 1e308 } };
		r = await report(ana, forged);
		check("a solo report for a game not in SOLO is refused", r.body.counted === false && /does not rank games played alone/.test(r.body.why), r.body);
		r = await report(ana, { ...forged, game: "no-such-game" });
		check("…so is one for a game that does not exist", r.body.counted === false && /does not rank games played alone/.test(r.body.why), r.body);
		check("…and connect4's board is still a duel board", (await call("GET", "/api/lb/connect4")).body.kind === "duel");

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
			last = await call("POST", "/api/match/report", { token: dee, body: { game: "neon-survival-mp", run: s.run, match: 1, kind: "coop", ranking: [["pd"]], roster: { pd: D }, scores: { pd: i } } });
			if (i === 7) check("eight runs played alone count in a day", last.body.counted === true, last.body);
		}
		check("…the ninth does not, and says why", last.body.counted === false && /8 games played alone rank a day/.test(last.body.why), last.body);
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
		const solved = (run, secs, proof, who = "pa", acct = A) => ({ game: GAME, run, match: 1, kind: "coop", ranking: [[who]], roster: { [who]: acct }, scores: { [who]: secs }, proof });
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
		check("a level that is not one is not a board", (await call("GET", `/api/lb/${GAME}@nope`)).status === 400 && (await call("GET", "/api/lb/connect4@easy")).status === 400);

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
	}

	console.log("\naccounts: Light Cycles alone, a time bounded by the server's clock");
	{
		const GAME = "lokeshmohanty/light-cycles";
		const start = async (token, ms) => {
			const s = (await call("POST", "/api/run/start", { token, body: { game: GAME } })).body;
			if (ms) await call("POST", "/api/admin/age-run", { body: { run: s.run, ms } });
			return s;
		};
		const ride = (run, secs, extra = {}) => ({ game: GAME, run, match: 1, kind: "ffa", ranking: [["pa"]], roster: { pa: A }, scores: { pa: secs }, ...extra });
		const report = (token, body) => call("POST", "/api/match/report", { token, body });
		// Ana is near the day's solo runs (SOLO_PER_DAY 8 here): refusals first.
		let run = await start(ana, 0);
		let r = await report(ana, ride(run.run, 0.4));
		check("a round reported sooner than the countdown allows is refused", r.body.counted === false && /too fast/.test(r.body.why), r.body);
		run = await start(ana, 60_000);
		r = await report(ana, ride(run.run, 42.3));
		check("a round alone, its time survived under the time since its run began, counts", r.body.counted === true, r.body);
		const alone = await call("GET", `/api/lb/${GAME}@alone`);
		check("…on the game's solo board, best score, in seconds", alone.body.kind === "coop" && alone.body.unit === "s" && alone.body.rows[0]?.id === A && alone.body.rows[0].best === 42.3, alone.body);
		const races = await call("GET", `/api/lb/${GAME}`);
		check("…beside its races (wins), which name the solo board and the one against bots", races.body.kind === "ffa" && races.body.levels?.join() === "alone" && races.body.botsBoard === true && !races.body.rows.some((x) => x.id === A), races.body);
		run = await start(ana, 10_000);
		r = await report(ana, ride(run.run, 12));
		check("a time over the seconds since the run began (plus 1 s) is refused", r.body.counted === false && /more than a 10-second run/.test(r.body.why), r.body);
		r = await report(ana, ride(run.run, 10.55));
		check("…so is one that is not in tenths", r.body.counted === false && /score/.test(r.body.why), r.body);
		r = await report(ana, ride(run.run, 10.9));
		check("…while 10.9 s after 10 s counts (the same run: a refusal does not use it up)", r.body.counted === true, r.body);
		check("…and a lower time does not lower the best", (await call("GET", `/api/lb/${GAME}@alone`)).body.rows[0].best === 42.3);
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
		const win = (run, who = "pe", acct = E, extra = {}) => ({ game: "connect4", run, match: 1, kind: "duel", ranking: [[who], ["bot_1"]], roster: { [who]: acct }, ...extra });
		const ratingsOf = async (token) => (await call("GET", "/api/me/matches", { token })).body.ratings;

		let s = await start(eve, "neon-survival-mp");
		check("a run against bots is only for a game with that board (not co-op Neon Survival)", s.status === 400 && /against bots/.test(s.body.error), s.body);
		s = await start(null, "connect4");
		check("…and needs a sign-in", s.status === 401);
		s = (await start(eve, "connect4")).body;
		check("a run against bots: an id, a seed, the server's clock", typeof s.run === "string" && Number.isInteger(s.seed), s);
		let r = await report(eve, win(s.run));
		check("a win against a bot, the one person in the match, under its run, counts", r.body.counted === true && r.body.board === "bots" && r.body.wins === 1, r.body);
		r = await report(eve, win(s.run, "pe", E, { match: 2 }));
		check("…once: the run is used up", r.body.counted === false && /already reported/.test(r.body.why), r.body);
		check("…and it is not a rating: no connect4 rating, Elo or ranked match for Eve", !(await ratingsOf(eve)).some((x) => x.game === "connect4") && (await call("GET", "/api/me/matches", { token: eve })).body.matches.length === 0);
		check("…nor on the ranked board", !(await call("GET", "/api/lb/connect4")).body.rows.some((x) => x.id === E));
		let bb = await call("GET", "/api/lb/connect4?vs=bots");
		check("…but on the board of wins against bots", bb.body.kind === "bots" && bb.body.vs === "bots" && bb.body.rows[0]?.id === E && bb.body.rows[0].wins === 1 && bb.body.perDay === 3, bb.body);

		s = (await start(eve, "connect4", 0)).body;
		r = await report(eve, win(s.run));
		check(`a win sooner than the game's fastest legal one (${BOTS.connect4.minMs / 1000} s) is refused`, r.body.counted === false && /too fast/.test(r.body.why), r.body);
		s = (await start(eve, "connect4")).body;
		r = await report(eve, win(s.run, "pe", E, { ranking: [["bot_1"], ["pe"]] }));
		check("a loss does not count", r.body.counted === false && /only a win/.test(r.body.why), r.body);
		r = await report(eve, win(s.run, "pe", E, { ranking: [["pe", "bot_1"]] }));
		check("…nor a draw", r.body.counted === false && /only a win/.test(r.body.why), r.body);
		const nf = (await start(eve, "neon-fission")).body;
		r = await report(eve, { game: "neon-fission", run: nf.run, match: 1, kind: "ffa", ranking: [["pe"], ["pf"], ["bot_1"]], roster: { pe: E, pf: F } });
		check("a match with another person in it does not count against bots", r.body.counted === false && /one person/.test(r.body.why), r.body);
		check("…and is not on that board", !(await call("GET", "/api/lb/neon-fission?vs=bots")).body.rows.some((x) => x.id === E));
		r = await report(eve, win("party-run-id"));
		check("a win without a run from the server is refused", r.body.counted === false && /run the server issued/.test(r.body.why), r.body);
		const fays = (await start(fay, "connect4")).body;
		r = await report(eve, win(fays.run));
		check("…so is another player's run", r.body.counted === false && /another player/.test(r.body.why), r.body);
		const solo = (await start(eve, "lokeshmohanty/light-cycles", 60_000, null)).body;
		r = await report(eve, { ...win(solo.run), game: "lokeshmohanty/light-cycles", kind: "ffa" });
		check("…and a solo run used for a win against bots", r.body.counted === false && /played alone/.test(r.body.why), r.body);
		const vb = (await start(eve, "lokeshmohanty/light-cycles", 60_000)).body;
		r = await report(eve, { game: "lokeshmohanty/light-cycles", run: vb.run, match: 1, kind: "ffa", ranking: [["pe"]], roster: { pe: E }, scores: { pe: 3 } });
		check("…and a run against bots used for a round alone", r.body.counted === false && /against bots/.test(r.body.why), r.body);
		r = await report(eve, { ...win(s.run), game: "connect4", kind: "coop" });
		check("a kind of game with no winner does not count", r.body.counted === false && /no winner/.test(r.body.why), r.body);

		// BOTS_PER_DAY is 3 here (20 deployed): Eve has 1 connect4 win.
		for (let i = 0; i < 2; i++) await report(eve, win((await start(eve, "connect4")).body.run));
		s = (await start(eve, "connect4")).body;
		r = await report(eve, win(s.run));
		check("past the day's wins against bots in a game, a win does not count, and says why", r.body.counted === false && /3 wins against bots count a day/.test(r.body.why), r.body);
		const tt = (await start(eve, "tic-tac-toe-js")).body;
		r = await report(eve, { ...win(tt.run), game: "tic-tac-toe-js" });
		check("…in that game only: another game's still counts", r.body.counted === true && r.body.wins === 1, r.body);

		// Fay reaches three later: the tie goes to whoever got there first.
		for (let i = 0; i < 3; i++) await report(fay, win((await start(fay, "connect4")).body.run, "pf", F));
		bb = await call("GET", "/api/lb/connect4?vs=bots");
		check("ranked by wins; a tie goes to whoever reached it first", bb.body.rows.map((x) => `${x.id === E ? "E" : x.id === F ? "F" : "?"}${x.wins}`).join() === "E3,F3" && bb.body.rows[0].at < bb.body.rows[1].at, bb.body.rows);
		const mine = await call("GET", "/api/lb/connect4?vs=bots&me=1", { token: fay });
		check("?me=1: where you stand on it", mine.body.me?.id === F && mine.body.me.rank === 2, mine.body.me);
		check("friends' board against bots needs a sign-in", (await call("GET", "/api/lb/connect4?vs=bots&scope=friends")).status === 401);
		check("…and holds only you and your friends", (await call("GET", "/api/lb/connect4?vs=bots&scope=friends", { token: fay })).body.rows.map((x) => x.id).join() === F);
		check("a game with no such board says so", (await call("GET", "/api/lb/neon-survival-mp?vs=bots")).status === 400);
		check("Fay's ratings are untouched by all of it", (await ratingsOf(fay)).length === 0, await ratingsOf(fay));
		const mm = (await call("GET", "/api/me/matches", { token: eve })).body;
		check("your matches answer carries the wins against bots, apart from the ratings", mm.botWins?.map((x) => `${x.game}:${x.wins}`).join() === "connect4:3,tic-tac-toe-js:1" && !mm.ratings.some((x) => x.game === "connect4"), mm);
		check("…and so does the public profile", (await call("GET", `/api/u/${E}`)).body.botWins?.length === 2);
		const ex = await call("GET", "/api/me/export", { token: eve });
		check("export: the wins against bots", ex.body.winsAgainstBots?.find((x) => x.game === "connect4")?.wins === 3, ex.body.winsAgainstBots);
		await call("DELETE", "/api/me", { token: eve });
		check("delete: gone from the board", !(await call("GET", "/api/lb/connect4?vs=bots")).body.rows.some((x) => x.id === E));
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
		const fr = await call("GET", "/api/lb/connect4?scope=friends", { token: ana });
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
		await new Promise((r) => setTimeout(r, 400));
		list = await call("GET", "/api/friends", { token: ana });
		const boRow = list.body.friends.find((p) => p.id === Bo);
		check("a friend with a page open is online, in their game", boRow?.online === true && boRow.game === "connect4", boRow);
		r = await call("POST", `/api/friends/${Bo}/invite`, { token: ana, body: { code: "123456" } });
		await new Promise((res) => setTimeout(res, 300));
		check("an invite reaches the friend's open page", r.body.delivered === 1 && heard.some((m) => m.t === "invite" && m.code === "123456" && m.from.id === A), heard);
		check("inviting someone who is not a friend is refused", (await call("POST", `/api/friends/${C}/invite`, { token: ana, body: { code: "123456" } })).status === 403);
		check("an invite needs a six-digit code", (await call("POST", `/api/friends/${Bo}/invite`, { token: ana, body: { code: "12" } })).status === 400);
		await call("PATCH", "/api/me", { token: bo, body: { appearOffline: true } });
		list = await call("GET", "/api/friends", { token: ana });
		check("appear offline: friends see them offline", list.body.friends.find((p) => p.id === Bo)?.online === false);
		await call("PATCH", "/api/me", { token: bo, body: { appearOffline: false } });
		ws.close();
		await new Promise((r) => setTimeout(r, 500));
		list = await call("GET", "/api/friends", { token: ana });
		check("closing the last page goes offline", list.body.friends.find((p) => p.id === Bo)?.online === false);
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
		// Ana and Cy play connect4 together: only that match is the group's.
		const gm = { game: "connect4", run: "g1", match: 1, kind: "duel", ranking: [["pc"], ["pa"]], roster: { pa: A, pc: C } };
		await call("POST", "/api/match/report", { token: ana, body: gm });
		await call("POST", "/api/match/report", { token: cy, body: gm });
		const lb = await call("GET", `/api/lb/connect4?scope=group:${g.body.id}`, { token: ana });
		check("the group's board counts only matches among its members", lb.body.rows.length === 2 && lb.body.rows[0].id === C && lb.body.rows[0].games === 1, lb.body.rows);
		check("…with its own Elo, from 1200", lb.body.rows[0].elo === 1216 && lb.body.rows[1].elo === 1184, lb.body.rows);
		check("someone else's group board is refused", (await call("GET", `/api/lb/connect4?scope=group:${g.body.id}`, { token: bo })).status === 403);
		check("only the owner removes members", (await call("DELETE", `/api/groups/${g.body.id}/members/${A}`, { token: cy })).status === 403);
		check("anyone may leave", (await call("DELETE", `/api/groups/${g.body.id}/members/${C}`, { token: cy })).body.removed === true);
		check("only the owner deletes it", (await call("DELETE", `/api/groups/${g.body.id}`, { token: cy })).status === 403);
		check("…and the owner can", (await call("DELETE", `/api/groups/${g.body.id}`, { token: ana })).body.deleted === true);
		check("my groups list is empty again", (await call("GET", "/api/groups", { token: ana })).body.groups.length === 0);
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
		const c4 = file("stats/lb/connect4.json");
		check("…and each game's board, without who hid themselves", c4?.rows.length === 2 && !c4.rows.some((x) => x.id === C), c4?.rows);
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
		check("…the boards it did not send are still in the commit", kept.some((x) => x.path === "stats/lb/connect4.json") && JSON.parse(kept.find((x) => x.path === "stats/summary.json").content).games["neon-bid"].played >= 1, kept.map((x) => x.path));
		await call("PATCH", "/api/me", { token: cy, body: { hidePublic: false } });
	}

	console.log("\naccounts: export and delete");
	{
		const ex = await call("GET", "/api/me/export", { token: ana });
		check("export: the account, favourites, ratings, matches, friends", ex.body.account.id === A && ex.body.favourites.length === 2 && ex.body.ratings.length >= 2 && ex.body.matches.length >= 2 && ex.body.friends.length === 1, Object.keys(ex.body));
		check("…its matches in pages, this one the last", ex.body.matchesPage === 0 && ex.body.matchesNext === null, { page: ex.body.matchesPage, next: ex.body.matchesNext });
		check("…and a page past the end is empty", (await call("GET", "/api/me/export?page=3", { token: ana })).body.matches.length === 0);
		const del = await call("DELETE", "/api/me", { token: ana });
		check("delete: done at once", del.body.deleted === true);
		check("…the session is gone", (await call("GET", "/api/me", { token: ana })).status === 401);
		check("…the public profile is gone", (await call("GET", `/api/u/${A}`)).status === 404);
		const lb = await call("GET", "/api/lb/connect4");
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
