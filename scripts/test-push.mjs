// scripts/test-push.mjs — party invites as notifications (Web Push), end to
// end: the API under `wrangler dev` with a local D1, sending to a fake push
// service (scripts/push-fake.mjs) that decrypts every message as the browser
// would and checks its VAPID signature; then the page in Chromium at 390x844
// and 354x696 — the offer card, the profile's switch, the service worker's
// notification and its tap.
//
// What a browser cannot do here: Chromium without Google's keys cannot
// subscribe to FCM, so the page's PushManager is stubbed to hand out a
// subscription on the fake service (keys only the test holds); the message
// the Worker sends there is decrypted and then handed to the real service
// worker with CDP ServiceWorker.deliverPushMessage. A real notification
// click cannot be made from CDP, so the tap is a NotificationEvent
// dispatched in the worker with the real notification (clients.openWindow
// recorded, since it needs a real click).
//
// Needs wrangler (scripts/wrangler.mjs); skips with a message without it.

import { existsSync } from "node:fs";
import { webcrypto as crypto } from "node:crypto";
import { pushEndpointOk } from "../worker/api/webpush.js";
import { PUSH_DEVICES_MAX } from "../worker/api/push.js";
import { decrypt, makeVapidKeys, startFakePush, unb64url, b64url } from "./push-fake.mjs";
import { loadPlaywright } from "./playwright.mjs";
import { phoneFloors, serve } from "./serve.mjs";
import { startWrangler } from "./wrangler.mjs";

let failures = 0;
const check = (label, ok, detail = "") => {
	console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
	if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TIMEOUT = 30_000;

// ------------------------------------------------------------ no server

console.log("\npush: the fake push service against RFC 8291's own example (Appendix A)");
{
	const uaPub = unb64url("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4");
	const jwk = { kty: "EC", crv: "P-256", d: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94", x: b64url(uaPub.slice(1, 33)), y: b64url(uaPub.slice(33)) };
	const privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
	const body = unb64url(
		"DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
	);
	const got = await decrypt(body, { privateKey, pub: uaPub, auth: unb64url("BTBZMqHH6r4Tts7J_aSIgg") }).catch((e) => ({ text: e.message }));
	check("the receiver side decrypts the RFC's message (so it checks the Worker, not itself)", got.text === "When I grow up, I want to be a watermelon", got.text);
}

console.log("\npush: which endpoints the Worker will fetch (webpush.js pushEndpointOk)");
{
	const ok = [
		"https://fcm.googleapis.com/fcm/send/abc:def",
		"https://fcm.googleapis.com/wp/abc",
		"https://updates.push.services.mozilla.com/wpush/v2/gAAAA",
		"https://web.push.apple.com/QGuQyavX",
		"https://wns2-par02p.notify.windows.com/w/?token=BQYAAA",
	];
	const refused = [
		"http://fcm.googleapis.com/fcm/send/abc", // not https
		"https://fcm.googleapis.com.evil.example/x",
		"https://evilfcm.googleapis.com/x",
		"https://fcm.googleapis.com:8443/x", // a port
		"https://user:pw@fcm.googleapis.com/x", // credentials
		"https://push.apple.com.evil.example/x",
		"https://notify.windows.com.evil.example/x",
		"https://169.254.169.254/latest/meta-data",
		"https://10.0.0.1/x",
		"https://[::1]/x",
		"ftp://fcm.googleapis.com/x",
		"not a url",
		`https://fcm.googleapis.com/${"a".repeat(1100)}`,
	];
	check("the browsers' push services are accepted", ok.every((u) => pushEndpointOk(u)), ok.filter((u) => !pushEndpointOk(u)));
	check("anything else is refused", refused.every((u) => !pushEndpointOk(u)), refused.filter((u) => pushEndpointOk(u)));
	check("a loopback fake push service only in tests", !pushEndpointOk("http://127.0.0.1:9/push/x") && pushEndpointOk("http://127.0.0.1:9/push/x", { loopback: true }) && !pushEndpointOk("http://10.0.0.1/x", { loopback: true }));
}

// ------------------------------------------------------------ the Worker

const vapid = await makeVapidKeys();
const fake = await startFakePush({ vapidPublicKey: vapid.publicKey });
const DEVICES = 3;
const w = await startWrangler({
	AUTH_TEST: "1",
	SESSION_KEY: "push-test-key-0123456789",
	VAPID_PUBLIC_KEY: vapid.publicKey,
	VAPID_PRIVATE_KEY: vapid.privateKey,
	PUSH_DEVICES_MAX: String(DEVICES),
});
if (!w) {
	fake.stop();
	process.exit(0);
}
const B = w.base;
const SITE = "http://127.0.0.1:8000";
let ipN = 0;
const freshIp = () => `10.30.${Math.floor(++ipN / 250)}.${ipN % 250}`;

/** One API call: { status, body, headers }. */
async function call(method, path, { token, body, ip = freshIp() } = {}) {
	const res = await fetch(B + path, {
		method,
		redirect: "manual",
		headers: { Origin: SITE, "CF-Connecting-IP": ip, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
		body: body ? JSON.stringify(body) : undefined,
	});
	const text = await res.text();
	let parsed = text;
	try {
		parsed = JSON.parse(text);
	} catch {}
	return { status: res.status, body: parsed, headers: res.headers, text };
}
async function login(name) {
	let url = `${B}/auth/test?name=${encodeURIComponent(name)}&uid=${encodeURIComponent(name)}&back=${encodeURIComponent(SITE + "/")}`;
	for (let i = 0; i < 6 && !url.startsWith(SITE); i++) {
		const res = await fetch(url, { redirect: "manual" });
		url = new URL(res.headers.get("location"), url).href;
	}
	const token = new URL(url).hash.match(/token=([^&]+)/)?.[1];
	return { token, name, id: (await call("GET", "/api/me", { token })).body.id };
}
const befriend = async (x, y) => {
	await call("POST", `/api/friends/${y.id}`, { token: x.token });
	await call("POST", `/api/friends/${x.id}`, { token: y.token });
};
const subscribeAs = (p, sub) => call("POST", "/api/push", { token: p.token, body: { endpoint: sub.endpoint, keys: sub.keys } });
const rows = async (where) => (await w.sql(`SELECT endpoint, account FROM push_subs WHERE ${where} ORDER BY at`))[0];
// What a sender is told: status, body and every header but the clock's.
const answer = (r) => JSON.stringify({ s: r.status, b: r.text, h: [...r.headers].filter(([k]) => !/^(date|cf-ray)$/i.test(k)) });
const listen = async (token) => {
	const heard = [];
	const ws = new WebSocket(`${B.replace("http", "ws")}/live`, ["neon", token]);
	await new Promise((ok, bad) => {
		ws.onopen = ok;
		ws.onerror = bad;
		setTimeout(bad, 8000);
	}).catch(() => {});
	ws.onmessage = (e) => heard.push(JSON.parse(e.data));
	return { heard, close: () => ws.close() };
};
/** `who` is offline to `friend` (their last live socket has closed). */
const offline = async (friend, who) => {
	for (const end = Date.now() + 10_000; Date.now() < end; await sleep(150)) {
		const f = (await call("GET", "/api/friends", { token: friend.token })).body.friends?.find((x) => x.id === who.id);
		if (f && !f.online) return true;
	}
	return false;
};

const pw = loadPlaywright();
let browser = null;
let site = null;

try {
	console.log("\npush: subscribing, the allowlist, the device cap");
	{
		const key = await call("GET", "/api/push");
		check("GET /api/push gives the VAPID public key to subscribe with", key.status === 200 && key.body.key === vapid.publicKey, key.body);
		const zed = await login("Zed");
		const sub = await fake.subscription("zed1");
		check("subscribing needs a sign-in", (await call("POST", "/api/push", { body: { endpoint: sub.endpoint, keys: sub.keys } })).status === 401);
		const r = await subscribeAs(zed, sub);
		check("a device on a loopback fake push service is accepted in tests", r.status === 200 && r.body.on === true, r.body);
		check("…one row, keyed to the account", (await rows(`account = '${zed.id}'`)).length === 1);
		check("subscribing again refreshes the same row", (await subscribeAs(zed, sub)).status === 200 && (await rows(`account = '${zed.id}'`)).length === 1);
		const refusedHosts = ["https://evil.example/push/1", "http://fcm.googleapis.com/fcm/send/1", "https://fcm.googleapis.com.evil.example/1", "https://fcm.googleapis.com:8443/1", "https://169.254.169.254/x", "http://10.0.0.1/push/1", "https://[::1]/push"];
		const statuses = [];
		for (const endpoint of refusedHosts) statuses.push((await call("POST", "/api/push", { token: zed.token, body: { endpoint, keys: sub.keys } })).status);
		check("endpoints off the push services' hosts are refused (400), and nothing is stored", statuses.every((s) => s === 400) && (await rows(`account = '${zed.id}'`)).length === 1, statuses);
		const shortKey = await call("POST", "/api/push", { token: zed.token, body: { endpoint: `${fake.base}/push/zbad`, keys: { p256dh: "AAAA", auth: sub.keys.auth } } });
		const notPoint = await call("POST", "/api/push", { token: zed.token, body: { endpoint: `${fake.base}/push/zbad`, keys: { p256dh: "B" + "A".repeat(86), auth: sub.keys.auth } } });
		const noAuth = await call("POST", "/api/push", { token: zed.token, body: { endpoint: `${fake.base}/push/zbad`, keys: { p256dh: sub.keys.p256dh } } });
		check("keys that are not a P-256 point and a 16-byte secret are refused", shortKey.status === 400 && notPoint.status === 400 && noAuth.status === 400, [shortKey.status, notPoint.status, noAuth.status]);
		// A real push service's host is accepted too (and removed at once: no
		// invite is ever sent to it from here).
		const real = { endpoint: "https://fcm.googleapis.com/fcm/send/test-push-not-real", keys: sub.keys };
		check("…and a real push service's host is accepted", (await subscribeAs(zed, real)).status === 200);
		check("DELETE /api/push forgets that device", (await call("DELETE", "/api/push", { token: zed.token, body: { endpoint: real.endpoint } })).body.on === false && (await rows(`endpoint = '${real.endpoint}'`)).length === 0);

		console.log(`  (PUSH_DEVICES_MAX is ${DEVICES} here, ${PUSH_DEVICES_MAX} deployed)`);
		const subs = [];
		for (let i = 2; i <= DEVICES + 1; i++) {
			subs.push(await fake.subscription(`zed${i}`));
			await sleep(5);
			await subscribeAs(zed, subs.at(-1));
		}
		let mine = (await rows(`account = '${zed.id}'`)).map((r) => r.endpoint);
		check(`past ${DEVICES} devices, the least recently refreshed goes`, mine.length === DEVICES && !mine.includes(sub.endpoint), mine);
		await sleep(5);
		await subscribeAs(zed, subs[0]); // zed2 refreshed: now zed3 is the oldest
		await subscribeAs(zed, sub);
		mine = (await rows(`account = '${zed.id}'`)).map((r) => r.endpoint);
		check("…a device in use (refreshed) keeps its place", mine.length === DEVICES && mine.includes(subs[0].endpoint) && !mine.includes(subs[1].endpoint), mine);
		const other = await login("Yan");
		check("someone else cannot delete my device", (await call("DELETE", "/api/push", { token: other.token, body: { endpoint: sub.endpoint } })).status === 200 && (await rows(`endpoint = '${sub.endpoint}'`)).length === 1);
		await subscribeAs(other, sub);
		const moved = await rows(`endpoint = '${sub.endpoint}'`);
		check("the same browser signed in as someone else: the device is theirs now (one row)", moved.length === 1 && moved[0].account === other.id, moved);
		check("no message was sent to any of these", fake.received.length === 0, fake.received.length);
	}

	console.log("\npush: an invite, pushed only when no page is open");
	{
		const [asha, bo, cy, dee, eve, fay, gus, hal] = [await login("Asha"), await login("Bo"), await login("Cy"), await login("Dee"), await login("Eve"), await login("Fay"), await login("Gus"), await login("Hal")];
		for (const x of [asha, cy, dee, eve, fay, hal]) await befriend(x, bo);
		await befriend(asha, gus);
		const bo1 = await fake.subscription("bo1");
		await subscribeAs(bo, bo1);

		const ear = await listen(bo.token);
		const live = await call("POST", `/api/friends/${bo.id}/invite`, { token: asha.token, body: { code: "111111", game: "Connect 4" } });
		for (const end = Date.now() + 8000; !ear.heard.some((m) => m.t === "invite") && Date.now() < end; ) await sleep(100);
		await sleep(1500);
		check("Bo has a page open: the page gets the invite…", ear.heard.some((m) => m.t === "invite" && m.code === "111111"), ear.heard);
		check("…and no notification is sent", fake.to("bo1").length === 0, fake.to("bo1"));
		ear.close();
		check("(Bo's last page closed: offline)", await offline(cy, bo));

		const pushed = await call("POST", `/api/friends/${bo.id}/invite`, { token: cy.token, body: { code: "222222", game: "Connect 4" } });
		await fake.waitFor(() => fake.to("bo1").length >= 1);
		const m = fake.to("bo1")[0];
		check("no page open: one notification to Bo's device", fake.to("bo1").length === 1, fake.received);
		check("…its VAPID JWT verifies under the arcade's key, for this push service's origin", m?.ok === true && m.claims?.aud === fake.base, m?.error ?? m?.claims);
		check("…and it decrypts with the browser's private key to the invite", m?.payload?.t === "invite" && m.payload.from?.id === cy.id && m.payload.from?.name === "Cy" && m.payload.code === "222222" && m.payload.game === "Connect 4", m?.payload);
		check("…TTL the invite's 10 minutes, urgent, one topic per sender, padded to 512 bytes", m?.ttl === "600" && m.urgency === "high" && /^inv[A-Za-z0-9_-]+$/.test(m.topic ?? "") && m.topic.length <= 32 && m.padded === 512, { ttl: m?.ttl, urgency: m?.urgency, topic: m?.topic, padded: m?.padded });
		check("the sender's answer is identical whether a page or a notification got it", answer(live) === answer(pushed) && pushed.body.invited === true, [answer(live), answer(pushed)]);
		const noDevice = await call("POST", `/api/friends/${gus.id}/invite`, { token: asha.token, body: { code: "333333" } });
		check("…or neither (a friend with no page and no device)", answer(noDevice) === answer(pushed), answer(noDevice));

		await call("POST", `/api/friends/${bo.id}/invite`, { token: dee.token, body: { code: "444444" } });
		await fake.waitFor(() => fake.to("bo1").length >= 2);
		const m2 = fake.to("bo1")[1];
		check("a second message to the same push service reuses the cached JWT", m2?.ok && m2.jwt === m.jwt, { a: m?.jwt?.slice(-12), b: m2?.jwt?.slice(-12) });
		check("no game named: the payload has none (the notification says \"Tap to see the invite.\")", m2?.payload && !("game" in m2.payload), m2?.payload);
		check("the invite limits still apply: Cy again at once is refused, nothing sent", (await call("POST", `/api/friends/${bo.id}/invite`, { token: cy.token, body: { code: "222222" } })).status === 429 && (await sleep(800), fake.to("bo1").length === 2));

		await call("POST", `/api/friends/${eve.id}/mute`, { token: bo.token });
		const muted = await call("POST", `/api/friends/${bo.id}/invite`, { token: eve.token, body: { code: "555555" } });
		await call("POST", `/api/friends/${fay.id}/block`, { token: bo.token });
		const blocked = await call("POST", `/api/friends/${bo.id}/invite`, { token: fay.token, body: { code: "666666" } });
		await sleep(1500);
		check("muted: answered the same, and no notification", answer(muted) === answer(pushed) && fake.to("bo1").length === 2, answer(muted));
		check("blocked: refused as before (no longer friends), and no notification", blocked.status === 403 && fake.to("bo1").length === 2, blocked.status);

		const bo2 = await fake.subscription("bo2");
		await subscribeAs(bo, bo2);
		fake.status.set("/push/bo1", 410);
		fake.status.set("/push/bo2", 404);
		await call("POST", `/api/friends/${bo.id}/invite`, { token: hal.token, body: { code: "777777" } });
		await fake.waitFor(() => fake.to("bo1").length >= 3 && fake.to("bo2").length >= 1);
		let left = [];
		for (const end = Date.now() + 8000; Date.now() < end; await sleep(200)) if (!(left = await rows(`account = '${bo.id}'`)).length) break;
		check("a 410 and a 404 from the push service delete those devices", fake.to("bo1").length === 3 && fake.to("bo2").length === 1 && left.length === 0, { left, sent: [fake.to("bo1").length, fake.to("bo2").length] });
	}

	console.log("\npush: export and account deletion");
	{
		const ivy = await login("Ivy");
		await subscribeAs(ivy, await fake.subscription("ivy1"));
		await subscribeAs(ivy, await fake.subscription("ivy2"));
		const ex = await call("GET", "/api/me/export", { token: ivy.token });
		const devices = ex.body.pushDevices ?? [];
		const raw = JSON.stringify(devices);
		check("the export lists the player's devices: push service and dates", devices.length === 2 && devices.every((d) => d.service === new URL(fake.base).host && d.created > 0 && d.at > 0), devices);
		check("…without the endpoints or keys (they would let anyone send to the device)", !/ivy1|ivy2|p256dh|auth|endpoint/.test(raw), raw);
		check("deleting the account deletes its devices", (await call("DELETE", "/api/me", { token: ivy.token })).body.deleted === true && (await rows(`account = '${ivy.id}'`)).length === 0);
	}

	// ------------------------------------------------------------ browser

	const chrome = [process.env.CHROME, "/run/current-system/sw/bin/google-chrome-stable", "/run/current-system/sw/bin/chromium", "/usr/bin/google-chrome"].filter(Boolean).find(existsSync);
	browser = await pw.chromium.launch({ executablePath: chrome, args: ["--no-sandbox"] });
	site = await serve(8747);
	const RS = encodeURIComponent(B);
	const page = (p, extra = "") => `${site.base}/${p}${p.includes("?") ? "&" : "?"}rs=${RS}${extra}`;
	const inView = (p, sel) =>
		p.evaluate((sel) => {
			const r = document.querySelector(sel)?.getBoundingClientRect();
			return !!r && r.width > 0 && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && document.documentElement.scrollWidth <= innerWidth;
		}, sel);
	const floors = async (p, sel, label) => {
		const f = await phoneFloors(p, sel);
		check(`${label}: every text ≥ 12px and every tap ≥ 44px (${f.measured.text} texts, ${f.measured.taps} taps)`, f.measured.taps > 0 && !f.text.length && !f.taps.length, f);
	};

	/** A signed-in phone whose PushManager hands out `sub` (on the fake push service). */
	async function phone(name, viewport, sub) {
		const ctx = await browser.newContext({ viewport, isMobile: true, hasTouch: true });
		await ctx.grantPermissions(["notifications"], { origin: site.base });
		await ctx.addInitScript((s) => {
			try {
				const KEY = "test.pushsub";
				const make = (j) => ({ endpoint: j.endpoint, options: { userVisibleOnly: true, applicationServerKey: null }, toJSON: () => ({ endpoint: j.endpoint, expirationTime: null, keys: j.keys }), getKey: () => null, unsubscribe: async () => (localStorage.removeItem(KEY), true) });
				PushManager.prototype.getSubscription = async function () {
					const j = localStorage.getItem(KEY);
					return j ? make(JSON.parse(j)) : null;
				};
				PushManager.prototype.subscribe = async function (opts) {
					localStorage.setItem("test.pushopts", JSON.stringify({ userVisibleOnly: opts.userVisibleOnly, key: btoa(String.fromCharCode(...new Uint8Array(opts.applicationServerKey))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") }));
					localStorage.setItem(KEY, JSON.stringify(s));
					return make(s);
				};
			} catch {} // a sandboxed game frame: no storage, no PushManager
		}, { endpoint: sub.endpoint, keys: sub.keys });
		const p = await ctx.newPage();
		p.on("pageerror", (e) => check(`no page error on ${name}'s phone (${e.message})`, false));
		await p.goto(`${B}/auth/test?name=${encodeURIComponent(name)}&uid=${encodeURIComponent(name)}&back=${encodeURIComponent(page("?page=profile"))}`);
		await p.locator(".who .name").waitFor({ timeout: TIMEOUT });
		const token = await p.evaluate(() => localStorage.getItem("neon.token"));
		const id = await p.evaluate(() => NeonArcade.account.me.id);
		return { ctx, p, token, id, name };
	}
	const friendsLoaded = (p) => p.evaluate(() => new Promise((r) => (NeonArcade.accountUi?.loadFriends(true) ?? Promise.resolve()).then(() => setTimeout(r, 300))));

	for (const [vw, vh] of [
		[390, 844],
		[354, 696],
	]) {
		const tag = `${vw}x${vh}`;
		console.log(`\npush: the page at ${tag}`);
		const sub = await fake.subscription(`page-${vw}`);
		const asha = await phone(`Asha${vw}`, { width: vw, height: vh }, sub);
		const bo = await phone(`Bo${vw}`, { width: vw, height: vh }, sub);

		await bo.p.goto(page("index.html"));
		await bo.p.locator(".site-menu .acct-me").waitFor({ state: "attached", timeout: TIMEOUT });
		await friendsLoaded(bo.p);
		check("no friend yet: no offer", (await bo.p.locator(".neon-push-offer").count()) === 0);
		await befriend(asha, bo);
		await bo.p.reload();
		const offer = bo.p.locator(".neon-push-offer");
		check("the first time there is a friend, the offer shows", await offer.waitFor({ timeout: TIMEOUT }).then(() => true, () => false));
		check("…asking \"Get party invites when the arcade is closed?\" with TURN ON and NOT NOW", (await offer.locator("p").textContent()) === "Get party invites when the arcade is closed?" && (await offer.locator("button").allTextContents()).join() === "TURN ON,NOT NOW");
		check("…on the screen, nothing scrolling sideways", await inView(bo.p, ".neon-push-offer"));
		await floors(bo.p, ".neon-push-offer", "…the card");
		check("…and nothing asked of the browser yet (no subscription)", (await bo.p.evaluate(() => localStorage.getItem("test.pushsub"))) === null);

		if (vw === 390) {
			await offer.locator("button", { hasText: "NOT NOW" }).click();
			check("NOT NOW: the card goes", (await offer.count()) === 0);
			await bo.p.reload();
			await bo.p.locator(".site-menu .acct-me").waitFor({ state: "attached", timeout: TIMEOUT });
			await friendsLoaded(bo.p);
			check("…and never comes back on this device", (await bo.p.locator(".neon-push-offer").count()) === 0 && (await bo.p.evaluate(() => localStorage.getItem("neon.push.offer"))) === "no");

			await bo.p.goto(page("?page=profile"));
			const sw = bo.p.locator('[data-section="notifications"] [data-setting="push"]');
			await bo.p.waitForFunction(() => document.querySelector('[data-setting="push"]') && !document.querySelector('[data-setting="push"]').disabled, null, { timeout: TIMEOUT });
			check("the profile has the per-device switch, off", (await sw.getAttribute("aria-checked")) === "false" && (await sw.textContent()).includes("Party invites on this device"));
			await sw.scrollIntoViewIfNeeded();
			await floors(bo.p, '[data-section="notifications"]', "…the section");
			check("…nothing scrolling sideways", await bo.p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
			await sw.click();
			await bo.p.waitForFunction(() => document.querySelector('[data-setting="push"]').getAttribute("aria-checked") === "true", null, { timeout: TIMEOUT });
			const opts = JSON.parse((await bo.p.evaluate(() => localStorage.getItem("test.pushopts"))) ?? "{}");
			check("switched on: subscribed with userVisibleOnly and the server's key", opts.userVisibleOnly === true && opts.key === vapid.publicKey, opts);
			check("…and the server has this device", (await rows(`account = '${bo.id}'`)).length === 1);
			await sw.click();
			await bo.p.waitForFunction(() => document.querySelector('[data-setting="push"]').getAttribute("aria-checked") === "false" && !document.querySelector('[data-setting="push"]').disabled, null, { timeout: TIMEOUT });
			check("switched off: the server forgets the device and the browser unsubscribes", (await rows(`account = '${bo.id}'`)).length === 0 && (await bo.p.evaluate(() => localStorage.getItem("test.pushsub"))) === null);
			await sw.click();
			await bo.p.waitForFunction(() => document.querySelector('[data-setting="push"]').getAttribute("aria-checked") === "true", null, { timeout: TIMEOUT });
		} else {
			await offer.locator("button", { hasText: "TURN ON" }).click();
			check("TURN ON: turned on, and said so", await bo.p.locator(".neon-toast", { hasText: "Party invites will show as notifications" }).waitFor({ timeout: TIMEOUT }).then(() => true, () => false));
			check("…the server has this device", (await rows(`account = '${bo.id}'`)).length === 1);
			await bo.p.goto(page("?page=profile"));
			await bo.p.waitForFunction(() => document.querySelector('[data-setting="push"]')?.getAttribute("aria-checked") === "true", null, { timeout: TIMEOUT }).catch(() => {});
			check("…and the profile's switch shows it on", (await bo.p.locator('[data-setting="push"]').getAttribute("aria-checked")) === "true");
			await floors(bo.p, '[data-section="notifications"]', "…the section");
		}

		// Bo closes the arcade (a blank tab); Asha invites from her party.
		await bo.p.goto("about:blank");
		check("(Bo's arcade closed: offline)", await offline(asha, bo));
		const before = fake.to(`page-${vw}`).length;
		// Connect 4 picked, MULTI-PLAYER: the party screen with its code.
		await asha.p.goto(page("?party", "&game=connect4"));
		await asha.p.locator("button", { hasText: "MULTI-PLAYER" }).click({ timeout: TIMEOUT });
		await asha.p.locator(".party-code-digits").waitFor({ timeout: TIMEOUT });
		const code = (await asha.p.locator(".party-code-digits").textContent()).replace(/\D/g, "");
		const inv = asha.p.locator(`.party-friend[data-friend="${bo.id}"] button:visible`, { hasText: "INVITE" }).first();
		await inv.click({ timeout: TIMEOUT });
		await asha.p.locator(".neon-toast", { hasText: `Invited ${bo.name}.` }).waitFor({ timeout: TIMEOUT });
		await fake.waitFor(() => fake.to(`page-${vw}`).length > before);
		const msg = fake.to(`page-${vw}`).at(-1);
		check("the party screen's INVITE reaches Bo's device, encrypted and signed", msg?.ok === true && msg.payload?.from?.name === asha.name && msg.payload.code === code && msg.payload.game === "Connect 4", msg?.error ?? msg?.payload);

		// Into the real service worker, as the push service would deliver it.
		const cdp = await bo.ctx.newCDPSession(bo.p);
		const regs = [];
		cdp.on("ServiceWorker.workerRegistrationUpdated", (e) => regs.push(...e.registrations));
		await cdp.send("ServiceWorker.enable");
		for (const end = Date.now() + 10_000; !regs.some((r) => r.scopeURL.startsWith(site.base)) && Date.now() < end; ) await sleep(100);
		const reg = regs.find((r) => r.scopeURL.startsWith(site.base));
		const worker = bo.ctx.serviceWorkers().find((x) => x.url().startsWith(site.base));
		check("(Bo's phone has the arcade's service worker)", !!reg && !!worker, regs);
		const shown = async () => worker.evaluate(async () => (await self.registration.getNotifications()).map((n) => ({ title: n.title, body: n.body, tag: n.tag, data: n.data })));
		await cdp.send("ServiceWorker.deliverPushMessage", { origin: new URL(site.base).origin, registrationId: reg.registrationId, data: JSON.stringify(msg.payload) });
		let notes = [];
		for (const end = Date.now() + 8000; !(notes = await shown()).length && Date.now() < end; ) await sleep(100);
		check(`push → a notification: "${asha.name} invited you to a party", the game as its body`, notes.length === 1 && notes[0].title === `${asha.name} invited you to a party` && notes[0].body === "Connect 4" && notes[0].tag === `invite:${asha.id}`, notes);
		await cdp.send("ServiceWorker.deliverPushMessage", { origin: new URL(site.base).origin, registrationId: reg.registrationId, data: "not json" });
		for (const end = Date.now() + 8000; (notes = await shown()).length < 2 && Date.now() < end; ) await sleep(100);
		check("a payload it cannot read still shows a notification (userVisibleOnly)", notes.some((n) => n.title === "A friend invited you to a party" && n.tag === "invite:unknown"), notes);
		await worker.evaluate(async () => (await self.registration.getNotifications({ tag: "invite:unknown" })).forEach((n) => n.close()));

		// The tap, with no arcade page open: opens ./?invite=<Asha>.
		const tap = () =>
			worker.evaluate(async (tag) => {
				self.__opened = null;
				Object.defineProperty(self.clients, "openWindow", { configurable: true, value: async (u) => ((self.__opened = u), null) });
				const [n] = await self.registration.getNotifications({ tag });
				try {
					self.dispatchEvent(new NotificationEvent("notificationclick", { notification: n }));
				} catch {}
				await new Promise((r) => setTimeout(r, 500));
				return { opened: self.__opened, left: (await self.registration.getNotifications({ tag })).length };
			}, `invite:${asha.id}`);
		const t1 = await tap();
		check("tapped with the arcade closed: it opens the arcade at that invite, and the notification goes", t1.opened === `${site.base}/?invite=${encodeURIComponent(asha.id)}` && t1.left === 0, t1);
		// (Plus ?rs=: this page's room server is the test's wrangler.)
		await bo.p.goto(`${t1.opened ?? `${site.base}/?invite=${asha.id}`}&rs=${RS}`);
		const card = bo.p.locator(".neon-invite[data-invite]", { hasText: "invited you to a party" });
		check("…which shows the waiting invite with JOIN and NOT NOW", await card.waitFor({ timeout: TIMEOUT }).then(() => true, () => false));
		check("…JOIN for that party's code, and the address loses ?invite=", ((await card.locator("a", { hasText: "JOIN" }).getAttribute("href")) ?? "").endsWith(`#c=${code}`) && (await card.locator("button", { hasText: "NOT NOW" }).count()) === 1 && !bo.p.url().includes("invite="), bo.p.url());
		check("…on the screen", await inView(bo.p, ".neon-invite[data-invite]"));
		await floors(bo.p, ".neon-invite[data-invite]", "…the invite");

		// The tap with an arcade page open: that page shows it, nothing opens.
		await bo.p.evaluate(() => document.querySelector(".neon-invite[data-invite]")?.remove());
		await cdp.send("ServiceWorker.deliverPushMessage", { origin: new URL(site.base).origin, registrationId: reg.registrationId, data: JSON.stringify(msg.payload) });
		for (const end = Date.now() + 8000; !(await shown()).length && Date.now() < end; ) await sleep(100);
		const t2 = await tap();
		check("tapped with an arcade page open: no new window…", t2.opened === null, t2);
		check("…the open page shows the invite", await card.waitFor({ timeout: TIMEOUT }).then(() => true, () => false));
		await card.locator("button", { hasText: "NOT NOW" }).click();
		for (const end = Date.now() + 8000; Date.now() < end; await sleep(200)) if (!(await call("GET", "/api/invites", { token: bo.token })).body.invites?.length) break;
		await bo.p.goto(page("", `&invite=${encodeURIComponent(asha.id)}`));
		check("a notification tapped after its invite is gone says so", await bo.p.locator(".neon-toast", { hasText: "That invite has expired." }).waitFor({ timeout: TIMEOUT }).then(() => true, () => false));

		await bo.p.evaluate(() => NeonArcade.account.signOut());
		let after = [];
		for (const end = Date.now() + 8000; Date.now() < end; await sleep(200)) if (!(after = await rows(`account = '${bo.id}'`)).length) break;
		check("signing out: this device stops getting the account's invites", after.length === 0 && (await bo.p.evaluate(() => localStorage.getItem("test.pushsub"))) === null, after);
		await asha.ctx.close();
		await bo.ctx.close();
	}
} catch (err) {
	check(`unexpected: ${err.message}`, false);
	console.log(err.stack);
} finally {
	await browser?.close();
	site?.stop();
	w.stop();
	fake.stop();
}

console.log(failures ? `\n${failures} push check(s) failed` : "\nall push checks passed");
process.exit(failures ? 1 : 0);
