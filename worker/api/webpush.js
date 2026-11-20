// worker/api/webpush.js — Web Push from this Worker, with no library and no
// push SaaS: the payload is encrypted for one browser (RFC 8291, the
// "aes128gcm" content coding of RFC 8188) and the request is signed with the
// arcade's VAPID key (RFC 8292). WebCrypto only, so it runs the same in
// workerd and in Node (scripts/push-fake.mjs is the receiving side, for the
// tests; scripts/push-cpu.mjs measures it).
//
// What the browser vendor's push service sees: that a message of ~600 bytes
// went to a subscription, when, and from which server. Not who sent it, nor
// what it says (docs/accounts.md "Party invites by notification").
//
// SSRF: the endpoint is a URL a browser handed the page, and the page handed
// us. We fetch it, so only known push services' hosts are accepted, over
// https with no port or credentials (pushEndpointOk) — checked when a page
// subscribes and again before every send — and redirects are not followed.

import { b64url, unb64url } from "./http.js";

const enc = new TextEncoder();

/**
 * The push services browsers use today (verified 2026-11-18): Chrome, Edge on
 * Android, Samsung Internet, Opera and Brave → Google FCM; Firefox → Mozilla
 * autopush; Safari (macOS, and iOS from the Home Screen) → Apple; Edge on
 * Windows → WNS. A host not here is refused; a browser on another service
 * gets "not available on this browser" (lib/push.js).
 */
export const PUSH_HOSTS = [
	/^fcm\.googleapis\.com$/,
	/^updates\.push\.services\.mozilla\.com$/,
	/^(?:[a-z0-9-]+\.)*push\.apple\.com$/,
	/^(?:[a-z0-9-]+\.)*notify\.windows\.com$/,
];
const ENDPOINT_MAX = 1024;

/**
 * May we fetch this endpoint? `loopback`: tests only (AUTH_TEST=1 on a
 * loopback host, http.js `testing`) — a fake push service on 127.0.0.1.
 */
export function pushEndpointOk(endpoint, { loopback = false } = {}) {
	if (typeof endpoint !== "string" || endpoint.length > ENDPOINT_MAX) return false;
	let u;
	try {
		u = new URL(endpoint);
	} catch {
		return false;
	}
	if (u.username || u.password || u.hash) return false;
	if (u.protocol === "https:" && !u.port && PUSH_HOSTS.some((re) => re.test(u.hostname))) return true;
	return loopback && u.protocol === "http:" && /^(?:127\.0\.0\.1|localhost)$/.test(u.hostname);
}

const concat = (...parts) => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
};

async function hkdf(salt, ikm, info, bytes) {
	const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
	return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

/** The browser's public key (p256dh) as an ECDH key; throws if it is not a P-256 point. */
export const importReceiverKey = (p256dh) => crypto.subtle.importKey("raw", unb64url(p256dh), { name: "ECDH", namedCurve: "P-256" }, false, []);

/**
 * Pad every message to this many bytes of plaintext, so its size does not
 * tell the push service how long a name was. One record (rs 4096).
 */
export const PAD_TO = 512;

/**
 * RFC 8291 §3.4 + RFC 8188: `text` encrypted for the subscription's keys
 * (p256dh, auth: base64url), as the aes128gcm body — header (salt, rs,
 * keyid = our one-off public key) then the single record.
 */
export async function encrypt(text, p256dh, auth) {
	const uaPublic = unb64url(p256dh);
	const uaKey = await importReceiverKey(p256dh);
	const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
	const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
	const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, local.privateKey, 256));
	const ikm = await hkdf(unb64url(auth), shared, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
	const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
	const data = enc.encode(text);
	if (data.length > 3800) throw new Error("push payload too large");
	// The last (only) record: data, the delimiter 0x02, then zero padding.
	const plain = new Uint8Array(Math.max(PAD_TO, data.length + 1));
	plain.set(data);
	plain[data.length] = 2;
	const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
	const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plain));
	const header = new Uint8Array(21);
	header.set(salt);
	new DataView(header.buffer).setUint32(16, 4096);
	header[20] = asPublic.length; // 65
	return concat(header, asPublic, sealed);
}

// ------------------------------------------------------------------ VAPID

// Per isolate: the imported signing key, and one JWT per push service origin
// (its `aud`), reused until an hour before it expires (VAPID_JWT_S).
let signer = null; // { id, key }
const jwts = new Map(); // `${aud} ${public key}` → { token, exp (ms) }
const VAPID_JWT_S = 12 * 3600; // RFC 8292 allows up to 24 h
const JWT_REUSE_MARGIN_MS = 3600_000;

/** The JWK for our key pair: the public key's x and y, the private scalar d. */
async function signingKey(pub, d) {
	const id = `${pub} ${d}`;
	if (signer?.id === id) return signer.key;
	const raw = unb64url(pub);
	if (raw.length !== 65 || raw[0] !== 4) throw new Error("VAPID_PUBLIC_KEY is not an uncompressed P-256 point");
	const jwk = { kty: "EC", crv: "P-256", x: b64url(raw.slice(1, 33)), y: b64url(raw.slice(33)), d, ext: true };
	const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
	signer = { id, key };
	return key;
}

/**
 * `Authorization: vapid t=<JWT>, k=<public key>` for a push service origin.
 * The JWT is cached per origin for its lifetime (less a margin).
 */
export async function vapidAuth(env, aud, t = Date.now()) {
	const pub = env.VAPID_PUBLIC_KEY;
	const k = `${aud} ${pub}`;
	const hit = jwts.get(k);
	if (hit && hit.exp - JWT_REUSE_MARGIN_MS > t) return `vapid t=${hit.token}, k=${pub}`;
	const key = await signingKey(pub, env.VAPID_PRIVATE_KEY);
	const exp = Math.floor(t / 1000) + VAPID_JWT_S;
	const part = (o) => b64url(enc.encode(JSON.stringify(o)));
	const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part({ aud, exp, sub: env.VAPID_SUBJECT || "https://github.com/lokeshmohanty/games" })}`;
	// WebCrypto's ECDSA signature is r || s, 64 bytes: exactly JWS's ES256.
	const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(unsigned));
	const token = `${unsigned}.${b64url(sig)}`;
	if (jwts.size > 64) jwts.clear(); // WNS hands out many hosts; keep it bounded
	jwts.set(k, { token, exp: exp * 1000 });
	return `vapid t=${token}, k=${pub}`;
}

export const vapidReady = (env) => !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);

/**
 * Send one message to one subscription { endpoint, p256dh, auth }.
 * Resolves { status, gone }: `gone` when the push service says the
 * subscription is no more (404, 410) or its endpoint is no longer allowed —
 * the caller deletes the row.
 */
export async function sendPush(env, sub, text, { ttl = 600, topic = null, urgency = "high", loopback = false } = {}) {
	if (!pushEndpointOk(sub.endpoint, { loopback })) return { status: 0, gone: true };
	const aud = new URL(sub.endpoint).origin;
	const body = await encrypt(text, sub.p256dh, sub.auth);
	const res = await fetch(sub.endpoint, {
		method: "POST",
		redirect: "manual",
		headers: {
			Authorization: await vapidAuth(env, aud),
			"Content-Encoding": "aes128gcm",
			"Content-Type": "application/octet-stream",
			TTL: String(Math.max(0, Math.round(ttl))),
			Urgency: urgency,
			...(topic ? { Topic: topic } : {}),
		},
		body,
	});
	await res.body?.cancel();
	return { status: res.status, gone: res.status === 404 || res.status === 410 };
}
