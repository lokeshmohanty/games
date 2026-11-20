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
//
// When: an invite (social.js invite) that no open page of the friend's got —
// their UserLive has no sockets — is sent to each of their devices, after the
// sender has been answered (ctx.waitUntil), so the answer is the same
// `{ invited: true }` whether anything was pushed (D16). Mutes, blocks and
// every invite limit apply before this is reached. A 404 or 410 from the push
// service deletes the device's row; so does an endpoint no longer allowed.
//
// Table push_subs (0006). The export lists a player's devices by push
// service and dates, not their endpoints or keys (me.js exportMe).

import { HttpError, body, now, testing } from "./http.js";
import { importReceiverKey, pushEndpointOk, sendPush, vapidReady } from "./webpush.js";

// Five: each device costs ~0.6–0.7 ms of CPU per invite (encryption), on top
// of ~4 ms for a cold isolate's first push (scripts/push-cpu.mjs), inside 10 ms.
export const PUSH_DEVICES_MAX = 5;
const devicesMax = (env) => Number(env.PUSH_DEVICES_MAX ?? PUSH_DEVICES_MAX);
const B64URL = /^[A-Za-z0-9_-]+$/;

export function pushKey(env) {
	return { key: vapidReady(env) ? env.VAPID_PUBLIC_KEY : null };
}

export async function subscribe(env, me, request) {
	if (!vapidReady(env)) throw new HttpError(503, "invites by notification are not set up on this server");
	const b = await body(request);
	const endpoint = b.endpoint;
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
	await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO push_subs (endpoint, account, p256dh, auth, created, at) VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT (endpoint) DO UPDATE SET
			   created = CASE WHEN push_subs.account = excluded.account THEN push_subs.created ELSE excluded.created END,
			   account = excluded.account, p256dh = excluded.p256dh, auth = excluded.auth, at = excluded.at`,
		).bind(endpoint, me.id, p256dh, auth, t, t),
		// The cap: the devices refreshed longest ago go (a page refreshes its
		// row once a day, lib/push.js), so a device in use keeps its place.
		env.DB.prepare(
			`DELETE FROM push_subs WHERE account = ? AND endpoint NOT IN
			   (SELECT endpoint FROM push_subs WHERE account = ? ORDER BY at DESC, endpoint LIMIT ?)`,
		).bind(me.id, me.id, devicesMax(env)),
	]);
	return { on: true };
}

export async function unsubscribe(env, me, request) {
	const { endpoint } = await body(request);
	if (typeof endpoint !== "string") throw new HttpError(400, "which endpoint?");
	await env.DB.prepare("DELETE FROM push_subs WHERE endpoint = ? AND account = ?").bind(endpoint, me.id).run();
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
		const subs = (await env.DB.prepare("SELECT endpoint, p256dh, auth FROM push_subs WHERE account = ? ORDER BY at DESC LIMIT ?").bind(account, devicesMax(env)).all()).results ?? [];
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
