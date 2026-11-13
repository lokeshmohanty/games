// scripts/test-accounts.mjs — the account API (worker/api/) end to end, under
// `wrangler dev` with a throwaway local D1, against a fake GitHub and Google
// (one node server playing OAuth, the GitHub App, GraphQL and the Git Data
// API). Every rule in docs/accounts.md that can be checked from outside is.
//
// Needs wrangler (see scripts/wrangler.mjs); skips with a message without it.

import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { freePort, startWrangler } from "./wrangler.mjs";

let failures = 0;
const check = (label, ok, detail = "") => {
	console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
	if (!ok) failures++;
};

// ------------------------------------------------------------- fake GitHub

const fake = { discussions: new Map(), comments: [], commits: [], refs: new Map(), trees: new Map(), graphql: 0 };
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
		const ok = form.get("code") === (p === "/g/token" ? "g-code" : "gh-code") && form.get("client_secret");
		return ok ? send(200, { access_token: p === "/g/token" ? "g-tok" : "gh-tok" }) : send(400, { error: "bad_verification_code" });
	}
	if (p === "/user") return req.headers.authorization === "Bearer gh-tok" ? send(200, { id: 42, login: "octo", name: "Octo Cat", avatar_url: "https://avatars.example/42" }) : send(401, {});
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
		if (req.headers.authorization !== "Bearer inst-token") return send(401, { message: "bad token" });
		const { query, variables } = JSON.parse(raw);
		if (query.includes("discussionCategories")) return send(200, { data: { repository: { id: "R1", discussionCategories: { nodes: [{ id: "C1", name: "Game feedback" }] } } } });
		if (query.includes("createDiscussion")) {
			const id = `D${fake.discussions.size + 1}`;
			fake.discussions.set(id, { ...variables, comments: [] });
			return send(200, { data: { createDiscussion: { discussion: { id, url: `https://github.com/lokeshmohanty/games/discussions/${id}` } } } });
		}
		if (query.includes("addDiscussionComment")) {
			fake.discussions.get(variables.id).comments.push({ body: variables.body, createdAt: new Date().toISOString() });
			fake.comments.push(variables.body);
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
		const b = raw ? JSON.parse(raw) : {};
		if (git === "trees") {
			const sha = `t${fake.trees.size + 1}`;
			fake.trees.set(sha, b.tree);
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
	GITHUB_CLIENT_ID: "gh-client",
	GITHUB_CLIENT_SECRET: "gh-secret",
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
const testLogin = async (name) => tokenOf(await walk(`${B}/auth/test?name=${encodeURIComponent(name)}&back=${encodeURIComponent(SITE + "/profile.html")}`));

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
		await call("PATCH", "/api/me", { token: bo, body: { hidePublic: true } });
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

	console.log("\naccounts: feedback, through the GitHub App");
	{
		let r = await call("POST", "/api/feedback/connect4", { token: ana, body: { text: "Love it @someone — more columns?" } });
		check("a post goes to GitHub", r.body.posted === true, r.body);
		check("…signed with a real App JWT", fake.jwtParts === 3);
		check("…as the player, by name, with the @ unable to ping", /^\*\*from Ana P\*\* · signed in with test\n\nLove it @​someone/.test(fake.comments[0] ?? ""), fake.comments[0]);
		check("…in a new discussion for the game", fake.discussions.size === 1 && [...fake.discussions.values()][0].title === "Feedback: connect4");
		await call("POST", "/api/feedback/connect4", { token: bo, body: { text: "second" } });
		check("the next post reuses the discussion", fake.discussions.size === 1);
		const got = await call("GET", "/api/feedback/connect4");
		check("reading it back: newest first, by name", got.body.comments[0]?.name === "Bo" && got.body.comments[1]?.text.startsWith("Love it @someone"), got.body);
		check("posting needs a sign-in", (await call("POST", "/api/feedback/connect4", { body: { text: "x" } })).status === 401);
		check("empty feedback is refused", (await call("POST", "/api/feedback/connect4", { token: ana, body: { text: " " } })).status === 400);
		for (let i = 0; i < 4; i++) await call("POST", "/api/feedback/connect4", { token: ana, body: { text: `more ${i}` } });
		r = await call("POST", "/api/feedback/connect4", { token: ana, body: { text: "one too many" } });
		check("five posts a day, then a polite 429", r.status === 429, r.body);
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
		await call("PATCH", "/api/me", { token: cy, body: { hidePublic: false } });
	}

	console.log("\naccounts: export and delete");
	{
		const ex = await call("GET", "/api/me/export", { token: ana });
		check("export: the account, favourites, ratings, matches, friends", ex.body.account.id === A && ex.body.favourites.length === 2 && ex.body.ratings.length >= 2 && ex.body.matches.length >= 2 && ex.body.friends.length === 1, Object.keys(ex.body));
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
