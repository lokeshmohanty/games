// worker/api/push.js — party invites as notifications, when the arcade is
// closed (Web Push; Lokesh, 2026-11-15 and 2026-11-18). Opt-in per device,
// party invites only: no friend requests, no reminders, nothing else.
//
//   GET    /api/push   { key }: the VAPID public key a page subscribes with,
//                      or null while the server has none (nothing is offered)
//   POST   /api/push   { endpoint, keys: { p256dh, auth } } → { on: true }:
//                      this device gets this account's invites. The same
//                      endpoint again just refreshes it (or moves it to the
//                      account now signed in there). At most PUSH_DEVICES_MAX
//                      devices: past that, the one least recently refreshed goes
//   DELETE /api/push   { endpoint } → { on: false }: not this device any more
//                      (no sign-in needed: the endpoint is the device's secret)
//
// Endpoints are stored and compared in one spelling (canonicalEndpoint), and
// with a fingerprint of the VAPID key they were made with: only rows of the
// current key are sent to; others are deleted.
//
// When: an invite (social.js invite) that is news (no invite of the sender's
// waiting, or a new party code, at most every 2 minutes) and that no page of
// the friend's has in view (live.js: hidden, frozen or none) is sent to each
// of their devices, after the
// sender has been answered (ctx.waitUntil), so the answer is the same
// `{ invited: true }` whether anything was pushed (D16). Mutes, blocks and
// every invite limit apply before this is reached. A 404 or 410 from the push
// service deletes the device's row; so does an endpoint no longer allowed.
//
// Table push_subs (0006). The export lists a player's devices by push
// service and dates, not their endpoints or keys (me.js exportMe).

import { HttpError, body, now, testing } from "./http.js";
import { canonicalEndpoint, importReceiverKey, pushEndpointOk, sendPush, vapidFingerprint, vapidReady } from "./webpush.js";

// Five: each device costs ~0.6–0.7 ms of CPU per invite (encryption), on top
// of ~4 ms for a cold isolate's first push (scripts/push-cpu.mjs), inside 10 ms.
export const PUSH_DEVICES_MAX = 5;
const devicesMax = (env) => Number(env.PUSH_DEVICES_MAX ?? PUSH_DEVICES_MAX);
const B64URL = /^[A-Za-z0-9_-]+$/;

export function pushKey(env) {
	return { key: vapidReady(env) ? env.VAPID_PUBLIC_KEY.trim() : null };
}

export async function subscribe(env, me, request) {
	if (!vapidReady(env)) throw new HttpError(503, "invites by notification are not set up on this server");
	const b = await body(request);
	const endpoint = canonicalEndpoint(b.endpoint);
	// Unpadded base64url, as PushSubscription.toJSON() gives it (a stray '=' forgiven).
	const p256dh = typeof b.keys?.p256dh === "string" ? b.keys.p256dh.replace(/=+$/, "") : null;
	const auth = typeof b.keys?.auth === "string" ? b.keys.auth.replace(/=+$/, "") : null;
	if (!pushEndpointOk(endpoint, { loopback: testing(env, request) })) throw new HttpError(400, "that push service is not one the arcade sends to");
	if (!p256dh || !B64URL.test(p256dh) || p256dh.length !== 87) throw new HttpError(400, "keys.p256dh is a P-256 public key (base64url)");
	if (!auth || !B64URL.test(auth) || auth.length !== 22) throw new HttpError(400, "keys.auth is 16 bytes (base64url)");
	try {
		await importReceiverKey(p256dh);
	} catch {
		throw new HttpError(400, "keys.p256dh is not a P-256 public key");
	}
	const t = now();
	const fp = await vapidFingerprint(env);
	await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO push_subs (endpoint, account, p256dh, auth, vapid, created, at) VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (endpoint) DO UPDATE SET
			   created = CASE WHEN push_subs.account = excluded.account THEN push_subs.created ELSE excluded.created END,
			   account = excluded.account, p256dh = excluded.p256dh, auth = excluded.auth, vapid = excluded.vapid, at = excluded.at`,
		).bind(endpoint, me.id, p256dh, auth, fp, t, t),
		// Devices made with an older key cannot be sent to any more.
		env.DB.prepare("DELETE FROM push_subs WHERE account = ? AND vapid != ?").bind(me.id, fp),
		// The cap: the devices refreshed longest ago go (a page refreshes its
		// row once a day, lib/push.js), so a device in use keeps its place.
		env.DB.prepare(
			`DELETE FROM push_subs WHERE account = ? AND endpoint NOT IN
			   (SELECT endpoint FROM push_subs WHERE account = ? ORDER BY at DESC, endpoint LIMIT ?)`,
		).bind(me.id, me.id, devicesMax(env)),
	]);
	return { on: true };
}

/**
 * Forget a device by its endpoint — with or without a sign-in. The endpoint
 * is the device's own secret (the browser hands it only to this site's page),
 * so holding it is the proof: a page whose session expired still stops its
 * device getting that account's invites (review, 2026-11-21). The worst a
 * stolen endpoint does here is turn one device's notifications off.
 */
export async function unsubscribe(env, request) {
	const endpoint = canonicalEndpoint((await body(request)).endpoint);
	if (!endpoint) throw new HttpError(400, "which endpoint?");
	await env.DB.prepare("DELETE FROM push_subs WHERE endpoint = ?").bind(endpoint).run();
	return { on: false };
}

/** A Topic header (≤ 32 base64url characters): a newer invite from the same sender replaces one not yet delivered. */
const topicOf = (sender) => `inv${String(sender).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 29)}`;

/**
 * The invite `msg` to every device of `account`. Never throws: it runs after
 * the answer has gone (ctx.waitUntil), and a failure is only logged.
 */
export async function pushInvite(env, account, msg, { ttlMs, loopback = false } = {}) {
	if (!vapidReady(env)) return 0;
	try {
		const fp = await vapidFingerprint(env);
		const rows = (await env.DB.prepare("SELECT endpoint, p256dh, auth, vapid FROM push_subs WHERE account = ? ORDER BY at DESC").bind(account).all()).results ?? [];
		// Made with an older VAPID key: the push service would refuse them (403,
		// not 410), so they go now; their pages subscribe again on their next visit.
		if (rows.some((s) => s.vapid !== fp)) await env.DB.prepare("DELETE FROM push_subs WHERE account = ? AND vapid != ?").bind(account, fp).run();
		const subs = rows.filter((s) => s.vapid === fp).slice(0, devicesMax(env));
		if (!subs.length) return 0;
		const text = JSON.stringify(msg);
		let sent = 0;
		await Promise.all(
			subs.map(async (s) => {
				try {
					const r = await sendPush(env, s, text, { ttl: ttlMs / 1000, topic: topicOf(msg.from?.id), loopback });
					if (r.gone) await env.DB.prepare("DELETE FROM push_subs WHERE endpoint = ? AND account = ?").bind(s.endpoint, account).run();
					else if (r.status >= 200 && r.status < 300) sent++;
					else console.error("push", r.status, new URL(s.endpoint).host);
				} catch (err) {
					console.error("push", err);
				}
			}),
		);
		return sent;
	} catch (err) {
		console.error("push", err);
		return 0;
	}
}
