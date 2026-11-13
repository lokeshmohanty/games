// worker/api/index.js — the account API's routes. The room server
// (worker/index.js) hands it everything under /api/ and /auth/, and /live.
// docs/accounts.md is the design; each module's header is its contract.
//
// Every write is charged to the sender's address (the IpGate `api` counter,
// API_WRITES per window) before it touches D1. Reads are free and, where
// public, open to every origin.

import { auth, requireAccount, sessionOf, accountForToken } from "./auth.js";
import { getFeedback, postFeedback } from "./feedback.js";
import { HttpError, fail, json, preflight } from "./http.js";
import { leaderboard } from "./lb.js";
import { matchesOf, played, publicProfile, ratingsOf, report, summary } from "./match.js";
import { deleteMe, exportMe, getFavs, getMe, link, patchMe, putFavs, signOut, unlink } from "./me.js";
import { runSnapshot } from "./snapshot.js";
import {
	addFriend,
	createGroup,
	deleteGroup,
	getGroup,
	invite,
	joinGroup,
	listFriends,
	listGroups,
	removeFriend,
	removeMember,
} from "./social.js";

const WRITE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * `gate()` resolves true when this address may write now (worker/index.js
 * charges its IpGate); false answers 429.
 */
export async function api(request, env, { gate = async () => true } = {}) {
	const url = new URL(request.url);
	const path = url.pathname;
	const method = request.method;
	if (method === "OPTIONS") return preflight(env, request);
	try {
		if (!env.DB) throw new HttpError(503, "accounts are not set up on this server (no D1 binding)");
		if (path.startsWith("/auth/")) return await auth(request, env, path);
		if (path === "/live") return await live(request, env);
		if (WRITE.has(method) && !(await gate())) throw new HttpError(429, "too many changes from this address; wait a few minutes");

		const seg = path.split("/").slice(2).map(decodeURIComponent); // after /api/
		const [a, b, c, d] = seg;
		const send = (body, opts) => json(env, request, body, opts);
		const open = (body, cache = "no-store") => json(env, request, body, { open: true, cache });
		const me = () => requireAccount(env, request);

		// ------------------------------------------------ public reads
		if (method === "GET" && a === "stats" && b === "summary") return open(await summary(env), "public, max-age=300");
		if (method === "GET" && a === "lb" && b) {
			const game = seg.slice(1).join("/");
			const scope = url.searchParams.get("scope") ?? "global";
			// ?me=1 on the global board: add where you stand (personal, so not cached).
			const who = scope === "global" && !url.searchParams.has("me") ? null : await me();
			const lb = await leaderboard(env, who, game, scope);
			return who ? send(lb) : open(lb, "public, max-age=60");
		}
		if (method === "GET" && a === "u" && b) return open(await publicProfile(env, b), "public, max-age=60");
		if (method === "GET" && a === "feedback" && b) return open(await getFeedback(env, seg.slice(1).join("/")));

		// ------------------------------------------------ counts (no sign-in)
		if (method === "POST" && a === "stats" && b === "played") return open(await played(env, request));

		// ------------------------------------------------ the signed-in player
		if (a === "me" && !b) {
			if (method === "GET") return send(await getMe(env, await me()));
			if (method === "PATCH") return send(await patchMe(env, await me(), request));
			if (method === "DELETE") return send(await deleteMe(env, await me()));
		}
		if (a === "me" && b === "export" && method === "GET") return send(await exportMe(env, await me()));
		if (a === "me" && b === "signout" && method === "POST") {
			await signOut(env, await me());
			return send({ signedOut: true });
		}
		if (a === "me" && b === "favs") {
			if (method === "GET") return send(await getFavs(env, await me()));
			if (method === "PUT") return send(await putFavs(env, await me(), request));
		}
		if (a === "me" && b === "link" && c && method === "POST") return send(await link(env, await me(), c, request));
		if (a === "me" && b === "identities" && c && method === "DELETE") return send(await unlink(env, await me(), c));
		if (a === "me" && b === "matches" && method === "GET") {
			const m = await me();
			return send({ matches: await matchesOf(env, m.id), ratings: await ratingsOf(env, m.id) });
		}
		if (a === "match" && b === "report" && method === "POST") return send(await report(env, await me(), request));
		if (a === "feedback" && b && method === "POST") return send(await postFeedback(env, await me(), seg.slice(1).join("/"), request));

		// ------------------------------------------------ friends
		if (a === "friends" && !b && method === "GET") return send(await listFriends(env, await me()));
		if (a === "friends" && b && !c) {
			if (method === "POST") return send(await addFriend(env, await me(), b));
			if (method === "DELETE") return send(await removeFriend(env, await me(), b));
		}
		if (a === "friends" && b && c === "invite" && method === "POST") return send(await invite(env, await me(), b, request));

		// ------------------------------------------------ groups
		if (a === "groups" && !b) {
			if (method === "GET") return send(await listGroups(env, await me()));
			if (method === "POST") return send(await createGroup(env, await me(), request));
		}
		if (a === "groups" && b === "join" && method === "POST") return send(await joinGroup(env, await me(), request));
		if (a === "groups" && b && b !== "join" && !c) {
			if (method === "GET") return send(await getGroup(env, await me(), b));
			if (method === "DELETE") return send(await deleteGroup(env, await me(), b));
		}
		if (a === "groups" && b && c === "members" && d && method === "DELETE") return send(await removeMember(env, await me(), b, d));

		// ------------------------------------------------ tests only
		if (a === "admin" && b === "snapshot" && method === "POST" && env.AUTH_TEST === "1" && /^127\.|^localhost$/.test(url.hostname)) {
			return send(await runSnapshot(env));
		}

		throw new HttpError(404, "not found");
	} catch (err) {
		return fail(env, request, err);
	}
}

/** /live: the session token rides as the second WebSocket subprotocol. */
async function live(request, env) {
	if (request.headers.get("Upgrade") !== "websocket") throw new HttpError(426, "websocket required");
	const protocols = (request.headers.get("Sec-WebSocket-Protocol") ?? "").split(",").map((s) => s.trim());
	const token = protocols[0] === "neon" ? protocols[1] : null;
	const me = token ? await accountForToken(env, token) : null;
	if (!me) throw new HttpError(401, "sign in first");
	if (!env.LIVE) throw new HttpError(503, "live updates are not set up on this server");
	const headers = new Headers(request.headers);
	headers.set("X-Account", me.id);
	return env.LIVE.get(env.LIVE.idFromName(me.id)).fetch(new Request(request.url, { headers }));
}

/** The cron (wrangler.toml [triggers]): the hourly public snapshot. */
export async function scheduledSnapshot(env) {
	if (!env.DB) return;
	try {
		console.log("snapshot", JSON.stringify(await runSnapshot(env)));
	} catch (err) {
		console.error("snapshot failed", err);
	}
}

export { sessionOf };
