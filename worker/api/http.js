// worker/api/http.js — responses, CORS and request bodies for the account API.
//
// The site is on another origin (www.lokeshmohanty.in, or 127.0.0.1 in
// development), and signed-in requests carry `Authorization: Bearer …`, which
// makes the browser ask first (a preflight). So: an allowlist of origins
// (ALLOWED_ORIGINS, comma-separated, plus any loopback origin), answered with
// that origin, never `*`, on anything that needs a sign-in. Public reads
// (counts, leaderboards, a public profile, feedback) are open to every origin.

export const DEFAULT_ORIGINS = "https://www.lokeshmohanty.in,https://lokeshmohanty.github.io";

const LOOPBACK = /^https?:\/\/(localhost|127(?:\.\d{1,3}){3}|\[::1\])(:\d+)?$/;

export function allowedOrigin(env, origin) {
	if (!origin) return null;
	if (LOOPBACK.test(origin)) return origin;
	const list = (env.ALLOWED_ORIGINS ?? DEFAULT_ORIGINS).split(",").map((s) => s.trim());
	return list.includes(origin) ? origin : null;
}

/** CORS headers for `request`; `open` for public reads. */
export function cors(env, request, open = false) {
	const origin = request.headers.get("Origin");
	const ok = allowedOrigin(env, origin);
	return {
		"Access-Control-Allow-Origin": ok ?? (open ? "*" : "null"),
		"Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
		"Access-Control-Allow-Headers": "Authorization, Content-Type",
		"Access-Control-Max-Age": "600",
		Vary: "Origin",
	};
}

export const preflight = (env, request) => new Response(null, { status: 204, headers: cors(env, request, true) });

export class HttpError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

export function json(env, request, body, { status = 200, open = false, cache = "no-store" } = {}) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache, ...cors(env, request, open) },
	});
}

export function fail(env, request, err) {
	const status = err instanceof HttpError ? err.status : 500;
	if (status === 500) console.error(err);
	// `code` lets a page act on a kind of refusal (e.g. "github": connect it).
	const body = { error: status === 500 ? "server error" : err.message, ...(err.code ? { code: err.code } : {}) };
	return json(env, request, body, { status, open: true });
}

/** The JSON body, at most `max` bytes. */
export async function body(request, max = 16 * 1024) {
	const text = await request.text();
	if (text.length > max) throw new HttpError(413, "request too large");
	if (!text) return {};
	try {
		return JSON.parse(text);
	} catch {
		throw new HttpError(400, "body is not JSON");
	}
}

/** A random id: `n` bytes, base64url. */
export function randomId(n = 12) {
	const b = crypto.getRandomValues(new Uint8Array(n));
	return b64url(b);
}

export function b64url(bytes) {
	let s = "";
	for (const x of new Uint8Array(bytes)) s += String.fromCharCode(x);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64url(s) {
	const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
	return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export async function sha256(text) {
	return b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

export async function hmac(key, text) {
	const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return b64url(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(text)));
}

/** Constant-time string comparison. */
export function same(a, b) {
	if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
	let d = 0;
	for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return d === 0;
}

/**
 * A game id as the catalogs write it: `id` or `owner/id`. Not `dev/…`: a game
 * loaded through the dev kit is nobody's to count yet.
 */
export const GAME_ID = /^(?:(?!dev\/)[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/)?[a-z0-9][a-z0-9-]{1,31}$/;

export const now = () => Date.now();
