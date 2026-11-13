// worker/api/github.js — the arcade's GitHub App: feedback threads
// (Discussions, GraphQL) and the hourly public snapshot (Git Data API).
//
// The App is Lokesh's, installed on lokeshmohanty/games only, with
// Discussions: read & write and Contents: read & write. The Worker signs a
// short JWT with the App's private key (GH_APP_KEY — the PEM GitHub gives you,
// PKCS#1 or PKCS#8 both accepted), trades it for an installation token, and
// keeps that for its hour. Secrets: GH_APP_ID, GH_APP_KEY; vars: GH_REPO
// (default lokeshmohanty/games), GITHUB_API (default https://api.github.com —
// a fake in tests).

import { HttpError, b64url } from "./http.js";

export const repoOf = (env) => env.GH_REPO ?? "lokeshmohanty/games";
const api = (env) => env.GITHUB_API ?? "https://api.github.com";

export const configured = (env) => !!(env.GH_APP_ID && env.GH_APP_KEY);

// ------------------------------------------------------------ the App's key

function pemBytes(pem) {
	const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
	return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** DER length bytes. */
function derLen(n) {
	if (n < 128) return [n];
	const out = [];
	while (n) {
		out.unshift(n & 255);
		n >>= 8;
	}
	return [0x80 | out.length, ...out];
}

/** Wrap a PKCS#1 RSA key (GitHub's "BEGIN RSA PRIVATE KEY") as PKCS#8. */
export function pkcs1to8(pkcs1) {
	// SEQUENCE { INTEGER 0, SEQUENCE { OID rsaEncryption, NULL }, OCTET STRING pkcs1 }
	const algo = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
	const octet = [0x04, ...derLen(pkcs1.length), ...pkcs1];
	const inner = [0x02, 0x01, 0x00, ...algo, ...octet];
	return new Uint8Array([0x30, ...derLen(inner.length), ...inner]);
}

let signingKey = null;
async function appKey(env) {
	if (signingKey?.pem === env.GH_APP_KEY) return signingKey.key;
	const pem = env.GH_APP_KEY.replace(/\\n/g, "\n");
	const der = pem.includes("BEGIN RSA PRIVATE KEY") ? pkcs1to8(pemBytes(pem)) : pemBytes(pem);
	const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
	signingKey = { pem: env.GH_APP_KEY, key };
	return key;
}

async function appJwt(env) {
	const t = Math.floor(Date.now() / 1000);
	const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
	const unsigned = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iat: t - 60, exp: t + 540, iss: String(env.GH_APP_ID) })}`;
	const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await appKey(env), new TextEncoder().encode(unsigned));
	return `${unsigned}.${b64url(sig)}`;
}

let installation = null; // { token, until, repo }
async function token(env) {
	if (!configured(env)) throw new HttpError(503, "the GitHub App is not set up on this server");
	if (installation && installation.repo === repoOf(env) && installation.until > Date.now() + 60_000) return installation.token;
	const jwt = await appJwt(env);
	const headers = { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json", "User-Agent": "neon-arcade" };
	const found = await fetch(`${api(env)}/repos/${repoOf(env)}/installation`, { headers });
	if (!found.ok) throw new HttpError(502, `GitHub App is not installed on ${repoOf(env)} (${found.status})`);
	const { id } = await found.json();
	const res = await fetch(`${api(env)}/app/installations/${id}/access_tokens`, { method: "POST", headers });
	if (!res.ok) throw new HttpError(502, `GitHub installation token: ${res.status}`);
	const t = await res.json();
	installation = { token: t.token, until: Date.parse(t.expires_at) || Date.now() + 50 * 60_000, repo: repoOf(env) };
	return installation.token;
}

export async function rest(env, method, path, payload) {
	const res = await fetch(`${api(env)}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${await token(env)}`,
			Accept: "application/vnd.github+json",
			"User-Agent": "neon-arcade",
			...(payload ? { "Content-Type": "application/json" } : {}),
		},
		body: payload ? JSON.stringify(payload) : undefined,
	});
	if (res.status === 404 && method === "GET") return null;
	if (!res.ok) throw new HttpError(502, `GitHub ${method} ${path}: ${res.status}`);
	return res.status === 204 ? {} : res.json();
}

export async function graphql(env, query, variables = {}) {
	const res = await fetch(`${api(env)}/graphql`, {
		method: "POST",
		headers: { Authorization: `Bearer ${await token(env)}`, "Content-Type": "application/json", "User-Agent": "neon-arcade" },
		body: JSON.stringify({ query, variables }),
	});
	const out = await res.json().catch(() => ({}));
	if (!res.ok || out.errors?.length) throw new HttpError(502, `GitHub GraphQL: ${out.errors?.[0]?.message ?? res.status}`);
	return out.data;
}

/** GraphQL as a player, with their GitHub App user token (vault.js). */
export async function graphqlAs(env, userToken, query, variables = {}) {
	const res = await fetch(`${api(env)}/graphql`, {
		method: "POST",
		headers: { Authorization: `Bearer ${userToken}`, "Content-Type": "application/json", "User-Agent": "neon-arcade" },
		body: JSON.stringify({ query, variables }),
	});
	const out = await res.json().catch(() => ({}));
	if (res.status === 401) throw Object.assign(new HttpError(403, "reconnect your GitHub account to post feedback"), { code: "github" });
	if (!res.ok || out.errors?.length) throw new HttpError(502, `GitHub GraphQL: ${out.errors?.[0]?.message ?? res.status}`);
	return out.data;
}

/** For tests: forget the cached installation token. */
export const _reset = () => {
	installation = null;
	signingKey = null;
};
