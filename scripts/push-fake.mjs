// scripts/push-fake.mjs — a fake push service on loopback, for the tests: the
// browser vendor's side of Web Push, written apart from worker/api/webpush.js
// so it checks that code rather than repeating it.
//
// For every message the Worker sends it:
//   - checks the VAPID header (RFC 8292): `vapid t=<JWT>, k=<key>`, k is the
//     arcade's public key, the JWT is ES256 and verifies under it, `aud` is
//     this service's origin, `exp` is in the future and within 24 h, `sub` is
//     a mailto: or https: URL;
//   - decrypts the body as the browser would (RFC 8291 + RFC 8188, aes128gcm)
//     with the subscription's private key and auth secret, which only the
//     test (playing the browser) holds;
//   - answers 201, or whatever status the test set for that endpoint (410…).
//
// Used by scripts/test-push.mjs (the API under wrangler dev, and the browser).

import { createServer } from "node:http";
import { webcrypto as crypto } from "node:crypto";

const enc = new TextEncoder();
export const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
export const unb64url = (s) => new Uint8Array(Buffer.from(s, "base64url"));

async function hkdf(salt, ikm, info, bytes) {
	const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
	return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

/** A VAPID key pair as the Worker takes it: public = raw P-256 point, private = d (both base64url). */
export async function makeVapidKeys() {
	const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
	const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
	const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
	return { publicKey: b64url(raw), privateKey: jwk.d };
}

/** A browser's subscription at `endpoint`: what it hands the page, plus what only it keeps. */
export async function makeSubscription(endpoint) {
	const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
	const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
	const auth = crypto.getRandomValues(new Uint8Array(16));
	return {
		endpoint,
		keys: { p256dh: b64url(pub), auth: b64url(auth) },
		// Only the "browser" (the test) has these.
		secret: { privateKey: pair.privateKey, privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey), pub, auth },
	};
}

/** RFC 8291 receiver: the plaintext of an aes128gcm body, or throws. */
export async function decrypt(body, secret) {
	const salt = body.slice(0, 16);
	const rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0);
	const idlen = body[20];
	const asPublic = body.slice(21, 21 + idlen);
	const sealed = body.slice(21 + idlen);
	if (idlen !== 65 || asPublic[0] !== 4) throw new Error(`keyid is not a P-256 point (${idlen} bytes)`);
	if (sealed.length > rs) throw new Error("more than one record");
	const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
	const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, secret.privateKey, 256));
	const info = new Uint8Array([...enc.encode("WebPush: info\0"), ...secret.pub, ...asPublic]);
	const ikm = await hkdf(secret.auth, shared, info, 32);
	const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
	const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
	const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
	const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, sealed));
	let end = plain.length - 1;
	while (end >= 0 && plain[end] === 0) end--;
	if (plain[end] !== 2) throw new Error("no last-record delimiter (0x02)");
	return { text: new TextDecoder().decode(plain.slice(0, end)), padded: plain.length };
}

/** RFC 8292: the JWT and key of an Authorization header, verified. Returns the claims or throws. */
export async function verifyVapid(header, { publicKey, origin }) {
	const m = /^vapid t=([^,\s]+),\s*k=([A-Za-z0-9_-]+)$/.exec(header ?? "");
	if (!m) throw new Error(`not a vapid Authorization header: ${header}`);
	const [, jwt, k] = m;
	if (k !== publicKey) throw new Error("k is not the arcade's public key");
	const [h, c, s] = jwt.split(".");
	const head = JSON.parse(Buffer.from(h, "base64url").toString());
	const claims = JSON.parse(Buffer.from(c, "base64url").toString());
	if (head.alg !== "ES256" || head.typ !== "JWT") throw new Error(`header ${JSON.stringify(head)}`);
	const key = await crypto.subtle.importKey("raw", unb64url(k), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
	if (!(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, unb64url(s), enc.encode(`${h}.${c}`)))) throw new Error("JWT signature does not verify");
	const nowS = Date.now() / 1000;
	if (claims.aud !== origin) throw new Error(`aud ${claims.aud} is not ${origin}`);
	if (!(claims.exp > nowS && claims.exp <= nowS + 86400)) throw new Error(`exp ${claims.exp} not within 24 h`);
	if (!/^(mailto:|https:)/.test(claims.sub ?? "")) throw new Error(`sub ${claims.sub}`);
	return { jwt, claims };
}

/**
 * Start the fake on a free loopback port. `vapidPublicKey`: what k must be.
 * `.register(sub)` makes a subscription decryptable; `.status.set(path, 410)`
 * changes one endpoint's answer; `.received` lists every message.
 */
export async function startFakePush({ vapidPublicKey }) {
	const subs = new Map(); // path → secret
	const status = new Map(); // path → answer
	const received = [];
	const server = createServer(async (req, res) => {
		const chunks = [];
		for await (const ch of req) chunks.push(ch);
		const body = new Uint8Array(Buffer.concat(chunks));
		const path = new URL(req.url, "http://x").pathname;
		const got = { path, at: Date.now(), ttl: req.headers.ttl, topic: req.headers.topic ?? null, urgency: req.headers.urgency ?? null, size: body.length };
		try {
			if (req.method !== "POST") throw new Error(`method ${req.method}`);
			if (req.headers["content-encoding"] !== "aes128gcm") throw new Error(`Content-Encoding ${req.headers["content-encoding"]}`);
			if (!/^\d+$/.test(req.headers.ttl ?? "")) throw new Error("no TTL");
			const v = await verifyVapid(req.headers.authorization, { publicKey: vapidPublicKey, origin: fake.base });
			got.jwt = v.jwt;
			got.claims = v.claims;
			const secret = subs.get(path);
			if (!secret) throw new Error(`no subscription at ${path}`);
			const { text, padded } = await decrypt(body, secret);
			got.padded = padded;
			got.payload = JSON.parse(text);
			got.ok = true;
		} catch (err) {
			got.ok = false;
			got.error = err.message;
		}
		received.push(got);
		res.writeHead(status.get(path) ?? (got.ok ? 201 : 400));
		res.end();
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const fake = {
		base: `http://127.0.0.1:${server.address().port}`,
		received,
		status,
		register(sub) {
			subs.set(new URL(sub.endpoint).pathname, sub.secret);
			return sub;
		},
		/** A new subscription on this service, registered. */
		async subscription(name) {
			return fake.register(await makeSubscription(`${fake.base}/push/${name}`));
		},
		/** Messages to `name` so far. */
		to: (name) => received.filter((r) => r.path === `/push/${name}`),
		async waitFor(pred, ms = 8000) {
			for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (pred()) return true;
			return pred();
		},
		stop: () => server.close(),
	};
	return fake;
}
