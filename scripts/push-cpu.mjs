// scripts/push-cpu.mjs — what one invite notification costs the Worker in CPU
// (the free plan allows 10 ms a request, docs/accounts.md "CPU"): the
// payload's encryption (RFC 8291) and the VAPID JWT (RFC 8292), signed once
// per push service origin and then reused from the cache.
//
// Measured in Node the way the other rows of that table are: warm (JIT), and
// with `node --jitless scripts/push-cpu.mjs` as a stand-in for a cold
// isolate. WebCrypto is native in both Node and workerd (BoringSSL there,
// OpenSSL here), so the JS around it is the part that differs. The fetch to
// the push service and D1 are I/O, not CPU, and are not in these.

import { performance } from "node:perf_hooks";
import { encrypt, vapidAuth } from "../worker/api/webpush.js";
import { makeSubscription, makeVapidKeys } from "./push-fake.mjs";

const N = Number(process.argv[2] ?? 500);
const v = await makeVapidKeys();
const env = { VAPID_PUBLIC_KEY: v.publicKey, VAPID_PRIVATE_KEY: v.privateKey };
const sub = await makeSubscription("https://fcm.googleapis.com/fcm/send/x");
const msg = JSON.stringify({ t: "invite", from: { id: "AbCdEfGhIjKlMnOp", name: "Asha Kulkarni" }, code: "123456", game: "Connect 4", at: Date.now() });

const time = async (fn) => {
	const t = performance.now();
	await fn();
	return performance.now() - t;
};
const stats = (xs) => {
	const s = [...xs].sort((a, b) => a - b);
	const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
	return `avg ${(s.reduce((a, b) => a + b, 0) / s.length).toFixed(3)} ms, p95 ${at(0.95).toFixed(3)}, p99 ${at(0.99).toFixed(3)}, max ${s.at(-1).toFixed(3)}`;
};

const firstEncrypt = await time(() => encrypt(msg, sub.keys.p256dh, sub.keys.auth));
const firstJwt = await time(() => vapidAuth(env, "https://fcm.googleapis.com"));
const enc = [];
const signed = [];
const cached = [];
for (let i = 0; i < N; i++) {
	enc.push(await time(() => encrypt(msg, sub.keys.p256dh, sub.keys.auth)));
	// A new origin each time: an uncached JWT (the key stays imported).
	signed.push(await time(() => vapidAuth(env, `https://h${i}.notify.windows.com`)));
	cached.push(await time(() => vapidAuth(env, "https://fcm.googleapis.com")));
}
// Process CPU (every thread: WebCrypto runs off the main one in Node) for a
// whole push: encrypt + a cached JWT, as the second device on one service.
const cpu0 = process.cpuUsage();
for (let i = 0; i < N; i++) {
	await encrypt(msg, sub.keys.p256dh, sub.keys.auth);
	await vapidAuth(env, "https://fcm.googleapis.com");
}
const cpu = process.cpuUsage(cpu0);
console.log(`node ${process.version}${process.execArgv.includes("--jitless") ? " --jitless" : ""}, ${N} runs`);
console.log(`  first call on a fresh process: encrypt ${firstEncrypt.toFixed(2)} ms, JWT (key import + sign) ${firstJwt.toFixed(2)} ms`);
console.log(`  encrypt one payload (ECDH key pair + derive, 3 HKDF, AES-GCM): ${stats(enc)}`);
console.log(`  a JWT for a new origin (ES256 sign):                           ${stats(signed)}`);
console.log(`  a cached JWT:                                                  ${stats(cached)}`);
console.log(`  process CPU per push (encrypt + cached JWT), all threads:     ${((cpu.user + cpu.system) / 1000 / N).toFixed(3)} ms`);
