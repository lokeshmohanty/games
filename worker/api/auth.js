// worker/api/auth.js — signing in with GitHub or Google, and sessions.
//
// The authorization-code flow, done here so the client secrets never leave
// the Worker:
//
//   GET /auth/<github|google>/start?back=<page>  → the provider's consent page
//   GET /auth/<provider>/callback?code&state     → back to <page>#token=<token>
//
// `back` must be one of the arcade's own origins (http.js allowedOrigin): no
// open redirect. `state` is signed (SESSION_KEY) and carries back + expiry,
// so a callback nobody started is refused. Scopes are the least that gives a
// stable id, a name and an avatar: GitHub `read:user`, Google `openid profile`.
// No email, and no provider token is kept once the profile is read.
//
// The token is `<sid>.<hmac(sid)>`: the page keeps it in localStorage and
// sends it as `Authorization: Bearer`. The session row (D1 `sessions`) is the
// truth — sign-out and account deletion delete it — and its expiry slides
// forward while it is used.
//
// For tests only: with AUTH_TEST=1 *and* the request on a loopback host,
// `GET /auth/test?name=…&back=…` signs in as a made-up account. Every
// provider URL can be pointed at a fake (GITHUB_OAUTH_URL, GITHUB_API,
// GOOGLE_AUTH_URL, GOOGLE_TOKEN_URL, GOOGLE_USERINFO_URL).

import { HttpError, allowedOrigin, hmac, now, randomId, same } from "./http.js";

export const SESSION_DAYS = 60;
const DAY = 86_400_000;
const STATE_MS = 10 * 60_000;

const PROVIDERS = {
	github: (env) => ({
		authorize: `${env.GITHUB_OAUTH_URL ?? "https://github.com"}/login/oauth/authorize`,
		token: `${env.GITHUB_OAUTH_URL ?? "https://github.com"}/login/oauth/access_token`,
		scope: "read:user",
		id: env.GITHUB_CLIENT_ID,
		secret: env.GITHUB_CLIENT_SECRET,
		async profile(accessToken) {
			const res = await fetch(`${env.GITHUB_API ?? "https://api.github.com"}/user`, {
				headers: { Authorization: `Bearer ${accessToken}`, "User-Agent": "neon-arcade", Accept: "application/vnd.github+json" },
			});
			if (!res.ok) throw new HttpError(502, `GitHub profile: ${res.status}`);
			const u = await res.json();
			return { uid: String(u.id), name: u.name || u.login, avatar: u.avatar_url ?? null };
		},
	}),
	google: (env) => ({
		authorize: env.GOOGLE_AUTH_URL ?? "https://accounts.google.com/o/oauth2/v2/auth",
		token: env.GOOGLE_TOKEN_URL ?? "https://oauth2.googleapis.com/token",
		scope: "openid profile",
		id: env.GOOGLE_CLIENT_ID,
		secret: env.GOOGLE_CLIENT_SECRET,
		async profile(accessToken) {
			const res = await fetch(env.GOOGLE_USERINFO_URL ?? "https://openidconnect.googleapis.com/v1/userinfo", {
				headers: { Authorization: `Bearer ${accessToken}` },
			});
			if (!res.ok) throw new HttpError(502, `Google profile: ${res.status}`);
			const u = await res.json();
			return { uid: String(u.sub), name: u.name || u.given_name || "Player", avatar: u.picture ?? null };
		},
	}),
};

function sessionKey(env) {
	if (!env.SESSION_KEY) throw new HttpError(503, "sign-in is not set up on this server (SESSION_KEY)");
	return env.SESSION_KEY;
}

/** Where to send the browser back to, or a 400. Only the arcade's own pages. */
function backUrl(env, raw) {
	let url;
	try {
		url = new URL(raw);
	} catch {
		throw new HttpError(400, "back must be a URL");
	}
	if (!allowedOrigin(env, url.origin)) throw new HttpError(400, "back must be one of the arcade's own pages");
	url.hash = "";
	return url.href;
}

async function signState(env, data) {
	const body = btoa(JSON.stringify(data));
	return `${body}.${await hmac(sessionKey(env), "state:" + body)}`;
}
async function readState(env, state) {
	const [body, sig] = String(state ?? "").split(".");
	if (!body || !sig || !same(sig, await hmac(sessionKey(env), "state:" + body))) throw new HttpError(400, "sign-in state is not ours");
	const data = JSON.parse(atob(body));
	if (!(data.exp > now())) throw new HttpError(400, "sign-in took too long; try again");
	return data;
}

const clean = (name) =>
	String(name ?? "")
		.replace(/[\u0000-\u001f\u007f]/g, "")
		.trim()
		.slice(0, 24) || "Player";

/** Find or make the account for a provider identity; returns its row. */
export async function upsertAccount(env, provider, { uid, name, avatar }) {
	const found = await env.DB.prepare("SELECT * FROM accounts WHERE provider = ? AND provider_uid = ?").bind(provider, uid).first();
	if (found) {
		// The avatar follows the provider; the name is ours to keep once edited.
		if (avatar && avatar !== found.avatar) await env.DB.prepare("UPDATE accounts SET avatar = ? WHERE id = ?").bind(avatar, found.id).run();
		return { ...found, avatar: avatar ?? found.avatar };
	}
	const id = randomId(9);
	await env.DB.prepare("INSERT INTO accounts (id, provider, provider_uid, name, avatar, created) VALUES (?, ?, ?, ?, ?, ?)")
		.bind(id, provider, uid, clean(name), avatar, now())
		.run();
	return env.DB.prepare("SELECT * FROM accounts WHERE id = ?").bind(id).first();
}

/** A new session for `account`; returns the token. */
export async function newSession(env, account) {
	const sid = randomId(18);
	await env.DB.prepare("INSERT INTO sessions (sid, account, created, exp) VALUES (?, ?, ?, ?)")
		.bind(sid, account, now(), now() + SESSION_DAYS * DAY)
		.run();
	return `${sid}.${await hmac(sessionKey(env), "sid:" + sid)}`;
}

/** The signed-in account for `request`, or null. Slides the session on. */
export async function sessionOf(env, request) {
	const auth = request.headers.get("Authorization") ?? "";
	const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
	return token ? accountForToken(env, token) : null;
}

export async function accountForToken(env, token) {
	const [sid, sig] = String(token).split(".");
	if (!sid || !sig || !env.SESSION_KEY || !same(sig, await hmac(env.SESSION_KEY, "sid:" + sid))) return null;
	const row = await env.DB.prepare(
		"SELECT a.*, s.exp AS session_exp FROM sessions s JOIN accounts a ON a.id = s.account WHERE s.sid = ?",
	)
		.bind(sid)
		.first();
	if (!row || row.session_exp < now()) return null;
	// Slide at most once a day, not on every request.
	if (row.session_exp - now() < (SESSION_DAYS - 1) * DAY) {
		await env.DB.prepare("UPDATE sessions SET exp = ? WHERE sid = ?").bind(now() + SESSION_DAYS * DAY, sid).run();
	}
	return { ...row, sid };
}

export async function requireAccount(env, request) {
	const me = await sessionOf(env, request);
	if (!me) throw new HttpError(401, "sign in first");
	return me;
}

const redirect = (to) => new Response(null, { status: 302, headers: { Location: to, "Cache-Control": "no-store" } });

/** /auth/… routes. */
export async function auth(request, env, path) {
	const url = new URL(request.url);

	if (path === "/auth/test") {
		const loopback = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/.test(url.hostname);
		if (env.AUTH_TEST !== "1" || !loopback) throw new HttpError(404, "not found");
		const back = backUrl(env, url.searchParams.get("back") ?? "");
		const name = clean(url.searchParams.get("name"));
		const account = await upsertAccount(env, "test", { uid: url.searchParams.get("uid") ?? name, name, avatar: null });
		return redirect(`${back}#token=${await newSession(env, account.id)}`);
	}

	const [, , provider, step] = path.split("/");
	const make = PROVIDERS[provider];
	if (!make || !["start", "callback"].includes(step)) throw new HttpError(404, "not found");
	const p = make(env);
	if (!p.id || !p.secret) throw new HttpError(503, `${provider} sign-in is not set up on this server`);
	const callback = `${url.origin}/auth/${provider}/callback`;

	if (step === "start") {
		const back = backUrl(env, url.searchParams.get("back") ?? "");
		const state = await signState(env, { back, provider, exp: now() + STATE_MS, n: randomId(6) });
		const q = new URLSearchParams({ client_id: p.id, redirect_uri: callback, scope: p.scope, state, response_type: "code" });
		if (provider === "google") q.set("prompt", "select_account");
		return redirect(`${p.authorize}?${q}`);
	}

	const state = await readState(env, url.searchParams.get("state"));
	if (state.provider !== provider) throw new HttpError(400, "sign-in state is for another provider");
	const back = new URL(state.back);
	const code = url.searchParams.get("code");
	if (!code) {
		// Declined on the consent page: back where they were, saying so.
		back.hash = "signin=cancelled";
		return redirect(back.href);
	}
	const res = await fetch(p.token, {
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ client_id: p.id, client_secret: p.secret, code, redirect_uri: callback, grant_type: "authorization_code" }),
	});
	const tok = await res.json().catch(() => ({}));
	if (!res.ok || !tok.access_token) throw new HttpError(502, `${provider} refused the sign-in (${tok.error ?? res.status})`);
	const profile = await p.profile(tok.access_token);
	const account = await upsertAccount(env, provider, profile);
	back.hash = `token=${await newSession(env, account.id)}`;
	return redirect(back.href);
}

export async function signOut(env, me) {
	await env.DB.prepare("DELETE FROM sessions WHERE sid = ?").bind(me.sid).run();
}
