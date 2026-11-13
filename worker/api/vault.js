// worker/api/vault.js — GitHub user tokens, kept encrypted, used to post
// feedback from the player's own GitHub account (Lokesh, 2026-11-13).
//
// The token is the arcade GitHub App's user-to-server token: it can do only
// what the App may (Discussions on lokeshmohanty/games) and only what the
// player may. It is stored AES-GCM encrypted under a key derived from
// SESSION_KEY (a database leak alone gives nothing), with its refresh token,
// and deleted when the player disconnects GitHub or deletes the account.
// GitHub expires user tokens after 8 hours; `tokenFor` refreshes on the way.

import { HttpError, b64url, unb64url } from "./http.js";

let keyFor = null; // { secret, key }
async function key(env) {
	if (!env.SESSION_KEY) throw new HttpError(503, "sign-in is not set up on this server (SESSION_KEY)");
	if (keyFor?.secret === env.SESSION_KEY) return keyFor.key;
	const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`neon-arcade/tokens/${env.SESSION_KEY}`));
	const k = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
	keyFor = { secret: env.SESSION_KEY, key: k };
	return k;
}

export async function seal(env, text) {
	if (text == null) return null;
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(env), new TextEncoder().encode(text));
	return `${b64url(iv)}.${b64url(ct)}`;
}

export async function open(env, sealed) {
	if (!sealed) return null;
	const [iv, ct] = sealed.split(".");
	try {
		const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64url(iv) }, await key(env), unb64url(ct));
		return new TextDecoder().decode(pt);
	} catch {
		return null; // SESSION_KEY rotated: the player reconnects GitHub
	}
}

/** Store a token response ({ access_token, expires_in?, refresh_token? }) on an identity. */
export async function keepTokens(env, provider, uid, tok) {
	await env.DB.prepare("UPDATE identities SET token_enc = ?, token_exp = ?, refresh_enc = ? WHERE provider = ? AND provider_uid = ?")
		.bind(
			await seal(env, tok.access_token),
			tok.expires_in ? Date.now() + Number(tok.expires_in) * 1000 : null,
			await seal(env, tok.refresh_token ?? null),
			provider,
			uid,
		)
		.run();
}

/**
 * A usable GitHub user token for `account`, refreshed if it is about to
 * expire; throws 403 with code "github" when there is none (not connected,
 * or GitHub has revoked it — the player connects again).
 */
export async function tokenFor(env, account) {
	const id = await env.DB.prepare("SELECT * FROM identities WHERE account = ? AND provider = 'github'").bind(account).first();
	const missing = (why) => Object.assign(new HttpError(403, why), { code: "github" });
	if (!id) throw missing("connect your GitHub account to post feedback — it is posted from your own account");
	if (id.token_enc && (!id.token_exp || id.token_exp > Date.now() + 60_000)) {
		const t = await open(env, id.token_enc);
		if (t) return { token: t, login: id.login };
	}
	const refresh = await open(env, id.refresh_enc);
	if (!refresh) throw missing("reconnect your GitHub account to post feedback");
	const res = await fetch(`${env.GITHUB_OAUTH_URL ?? "https://github.com"}/login/oauth/access_token`, {
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: env.GH_APP_CLIENT_ID,
			client_secret: env.GH_APP_CLIENT_SECRET,
			grant_type: "refresh_token",
			refresh_token: refresh,
		}),
	});
	const tok = await res.json().catch(() => ({}));
	if (!res.ok || !tok.access_token) throw missing("reconnect your GitHub account to post feedback");
	await keepTokens(env, "github", id.provider_uid, tok);
	return { token: tok.access_token, login: id.login };
}
