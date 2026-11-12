#!/usr/bin/env node
/**
 * test-live.mjs — the room server as deployed on real Cloudflare, over the
 * real internet, with real Chrome and the real public STUN servers.
 *
 *   RS_URL=https://<worker>.workers.dev node scripts/test-live.mjs
 *   just test-live https://<worker>.workers.dev
 *   … --only=ping,oracle,flows,hib,redraw,alarm,gate (default: ping,flows,hib,redraw; oracle and gate each run alone, 5 min after any other run)
 *
 * Every other suite runs the worker under `wrangler dev`, which is the real
 * code but not Cloudflare's edge: no hibernation, no real CF-Connecting-IP,
 * no edge timeouts. This one runs against a deployment. It is never part of
 * `just test` — it needs a deploy, and it waits out real idle periods.
 *
 *   ping    GET /ping: 204, readable cross-origin.
 *   oracle  time to WebSocket 101 and to a first (uncharged) reply for a
 *           live code vs a never-used one — the timing-oracle question
 *           (docs/room-server.md). Measured and reported; the check is only
 *           that the measurement ran. Needs nothing charged.
 *   flows   two to three browsers: host, join by code, messages both ways,
 *           host reload, guest reload twice, a rejoin nobody answers (RETRY,
 *           START A NEW PARTY), two tabs on one token (4409 → the stale tab
 *           stands down; releaseRejoin from it answers busy), a deliberate
 *           leave releasing the claim, and a full party (eight seats).
 *   hib     a party idles past Cloudflare's hibernation threshold; with the
 *           deployment's ROOM_DEBUG var set, the object's instance id proves
 *           it was really evicted. Then: an offer relayed to a hibernated
 *           socket, a socket close announced, a browser reload rejoining.
 *   redraw  `/room/new` whose first draw is a live code: the Worker must
 *           forward the client's upgrade a second time (`new Request(url,
 *           request)` after the 409), which only a deployment can vouch
 *           for. Forced by `?draw=<live code>`, honoured only when the
 *           deployment sets ROOM_DEBUG and ROOM_TEST_FORCE_REDRAW (a debug
 *           deployment, never the real one); skipped with a note otherwise.
 *   alarm   a room with nobody attached is swept by its alarm 15 min after
 *           its last touch — nothing touches it in between. ~16 min.
 *   gate    LAST, because it spends this machine's guess budget for five
 *           minutes: the 11th wrong code is refused (`blocked`), a member still
 *           re-dials from the exhausted address on its pass, the address
 *           still hosts (`/room/new`), /ping is never limited. Needs the
 *           deployment's ROOM_PASS_KEY secret (worker/README.md).
 *
 * All node-side sockets come from one address — this machine's — so unlike
 * test-worker.mjs nothing here forges CF-Connecting-IP (Cloudflare sets it).
 * Every join from here is charged and refunded on success, hosts dial
 * `/room/new` (never a dial or a guess), and re-dials ride member passes;
 * only claim probes (claimOf) and the gate section make failing guesses.
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync, globSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import dns from "node:dns";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { DIAL_FAILS } from "../worker/hub.js";

const require = createRequire(import.meta.url);
const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const PW_CACHE = join(homedir(), ".cache", "game-previews");
const PARTY = `file://${join(ROOT, "party.html")}`;
const TIMEOUT = 40_000;
const NO_ANSWER_WAIT = 50_000;

const args = process.argv.slice(2);
const RS = (process.env.RS_URL || args.find((a) => /^https?:\/\//.test(a)) || "").replace(/\/+$/, "");
if (!RS) {
	console.error("usage: RS_URL=https://<worker>.workers.dev node scripts/test-live.mjs [--only=ping,oracle,flows,hib,redraw,alarm,gate]");
	process.exit(2);
}
const only = (args.find((a) => a.startsWith("--only=")) ?? "").slice(7);
const SECTIONS = only ? new Set(only.split(",")) : new Set(["ping", "flows", "hib", "redraw"]);
// gate counts exactly ten wrong guesses from this IP, so it must start with
// a clean 5-min budget: oracle spends all DIAL_FAILS (10) dials, and hib's
// claim probes (a join with a wrong secret) are guesses too. Run gate on its
// own, 5 min after anything else, and run oracle on its own as well.
// Hosting no longer spends a dial (`/room/new`, since 2026-11-12) and
// re-dials ride passes, so what flows + hib spend from one address is
// their claim probes (claimOf: a guess and an unrefunded dial each) —
// eight or so, under DIAL_FAILS (10). A section failing "blocked" ran out
// of dials: run flows and hib apart. (redraw spends none: a host and a
// refunded join.)
if ((SECTIONS.has("gate") || SECTIONS.has("oracle")) && SECTIONS.size > 1) {
	console.error("gate and oracle each need this IP's clean 5-min budget: run each alone (--only=gate), 5 min after any other run");
	process.exit(2);
}
// The gate keys a client by its address — IPv4, or the IPv6 /64 — so a
// dual-stack host is two clients, and happy-eyeballs splits one run's
// guesses between them unpredictably (seen live: the block one guess early,
// then one late). gate therefore pins one family; LIVE_FAMILY pins any run.
if (SECTIONS.has("gate") && !process.env.LIVE_FAMILY) process.env.LIVE_FAMILY = "4";
if (process.env.LIVE_FAMILY) {
	// net.connect (and so node's WebSocket) calls dns.lookup at connect time.
	const family = Number(process.env.LIVE_FAMILY);
	const lookup = dns.lookup;
	dns.lookup = (host, opts, cb) => {
		if (typeof opts === "function") [cb, opts] = [opts, {}];
		if (typeof opts === "number") opts = { family: opts };
		return lookup.call(dns, host, { ...opts, family }, cb);
	};
}
const SAMPLES = Number(process.env.SAMPLES || 30);
const IDLE_MS = Number(process.env.IDLE_MS || 70_000);
const WS = RS.replace(/^http/, "ws");

let failures = 0;
const table = []; // [section, check, ok, ms]
let section = "";
const check = (label, ok, detail = "", ms = null) => {
	const t = ms === null ? "" : ` (${(ms / 1000).toFixed(1)}s)`;
	console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${t}${ok || !detail ? "" : ` — ${detail}`}`);
	table.push([section, label, ok, ms]);
	if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const code6 = () => String(100000 + (randomBytes(4).readUInt32BE() % 900000));
const secret = () => randomBytes(12).toString("hex");

// ------------------------------------------------------------ node sockets

/**
 * A long-lived room socket from node: `send`, a queue of replies to `next`
 * on, and `close`. Opens to `/room/<code>` (`"new"` hosts), with `pass`
 * ({id, pass, exp}) in the query when given — a member's re-dial.
 */
function sock(code, pass = null) {
	return new Promise((done, fail) => {
		const query = pass ? "?" + new URLSearchParams({ id: pass.id, exp: pass.exp, pass: pass.pass }) : "";
		const ws = new WebSocket(`${WS}/room/${code}${query}`);
		const inbox = [];
		const waiters = [];
		const s = {
			ws,
			inbox,
			closed: null,
			send: (m) => ws.send(JSON.stringify(code === "new" ? m : { code, ...m })),
			/** The next message matching `pred`, or {t:"timeout"}. */
			next(pred = () => true, ms = 10_000) {
				const i = inbox.findIndex(pred);
				if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
				return new Promise((r) => {
					const w = { pred, r };
					waiters.push(w);
					setTimeout(() => {
						const k = waiters.indexOf(w);
						if (k >= 0) waiters.splice(k, 1), r({ t: "timeout" });
					}, ms);
				});
			},
			close: () => ws.close(),
		};
		ws.onmessage = (e) => {
			const m = JSON.parse(e.data);
			const w = waiters.find((x) => x.pred(m));
			if (w) waiters.splice(waiters.indexOf(w), 1), w.r(m);
			else inbox.push(m);
		};
		ws.onclose = (e) => {
			s.closed = e.code;
			for (const w of waiters.splice(0)) w.r({ t: "closed", code: e.code });
		};
		ws.onopen = () => done(s);
		ws.onerror = () => fail(new Error("socket error"));
	});
}

/** One exchange: send `msg` to room `code`, resolve the first reply, hang up. */
async function call(code, msg) {
	try {
		const s = await sock(code);
		s.send(msg);
		const r = await s.next(() => true, 10_000);
		s.close();
		return r;
	} catch {
		return { t: "error", reason: "socket" };
	}
}
/** id-taken while `id`'s claim is held; "free" when the seat is open; no-room. */
const claimOf = async (code, id) => (await call(code, { t: "join", id, secret: "probe-" + secret() })).reason ?? "free";

/**
 * A bare WebSocket upgrade, timed: ms to the 101, the object's instance
 * id (X-Room-Instance, only under ROOM_DEBUG) and the draw count of a
 * `/room/new` (X-Room-Draws, likewise). Hung up at once — a socket that
 * never sends anything never binds (its dial stays spent).
 *
 * A refusal past the dial budget is a 101 too: the routing Worker accepts
 * that socket itself, says `{t:"error", reason:"blocked"}` and hangs up —
 * a browser never sees an HTTP status. So a 101 waits briefly for a first
 * frame (a room's socket sends nothing unasked) and reads `blocked` as the
 * 429 it stands for.
 */
function dial(code) {
	return new Promise((done) => {
		const url = new URL(`${RS}/room/${code}`);
		const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
			headers: {
				Connection: "Upgrade",
				Upgrade: "websocket",
				"Sec-WebSocket-Version": "13",
				"Sec-WebSocket-Key": randomBytes(16).toString("base64"),
			},
			agent: false,
			// LIVE_FAMILY=6 when Cloudflare challenges this host's IPv4
			// (see the preflight below); fetch/WebSocket pick IPv6 first anyway.
			family: Number(process.env.LIVE_FAMILY) || undefined,
		});
		const start = performance.now();
		req.on("upgrade", (res, socket, head) => {
			const ms = performance.now() - start;
			let bytes = head.toString("latin1");
			const settle = () => {
				socket.destroy();
				if (bytes.includes('"blocked"')) done({ ok: false, status: 429 });
				else done({ ok: true, ms, instance: res.headers["x-room-instance"] ?? null, draws: res.headers["x-room-draws"] ?? null });
			};
			if (bytes) return settle();
			const timer = setTimeout(settle, 400);
			socket.once("data", (d) => ((bytes += d.toString("latin1")), clearTimeout(timer), settle()));
		});
		req.on("response", (res) => (res.resume(), done({ ok: false, status: res.statusCode })));
		req.on("error", (e) => done({ ok: false, error: e.message }));
		req.end();
	});
}

/** ms to the socket opening, and to the reply to an uncharged message. */
async function firstReply(code) {
	const start = performance.now();
	try {
		const s = await sock(code);
		const open = performance.now() - start;
		// A release naming another room: answered "bad-code" by the object
		// after it loads its hub, and never charged.
		s.send({ t: "release", code: code === "000000" ? "000001" : "000000", id: "x", secret: "y" });
		const r = await s.next(() => true, 10_000);
		const reply = performance.now() - start;
		s.close();
		return { open, reply, ok: r.reason === "bad-code" };
	} catch {
		return { ok: false };
	}
}

/**
 * Host a node-side room (`/room/new`: the server draws the code); resolves
 * { code, id, secret, pass, exp, s } with s open.
 */
async function nodeHost() {
	const id = "h" + secret().slice(0, 6);
	const sec = secret();
	const s = await sock("new");
	s.send({ t: "host", id, secret: sec });
	const r = await s.next();
	if (r.t !== "room") throw new Error("host: " + JSON.stringify(r));
	return { code: r.code, id, secret: sec, pass: r.pass, exp: r.exp, s };
}
/** Join `code`; with `pass` ({id, pass, exp}) on the URL, as a member's re-dial. */
async function nodeJoin(code, id = "g" + secret().slice(0, 6), sec = secret(), pass = null) {
	const s = await sock(code, pass);
	s.send({ t: "join", id, secret: sec });
	const r = await s.next((m) => m.t === "joined" || m.t === "error");
	return { id, secret: sec, s, r, pass: r.pass, exp: r.exp };
}

const stats = (xs) => {
	const a = [...xs].sort((x, y) => x - y);
	const q = (p) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
	return { n: a.length, median: q(0.5), p90: q(0.9), min: a[0], max: a[a.length - 1] };
};
const fmt = (s) => !s.n ? "n=0" : `n=${s.n} median=${s.median.toFixed(0)}ms p90=${s.p90.toFixed(0)}ms min=${s.min.toFixed(0)} max=${s.max.toFixed(0)}`;

// ------------------------------------------------------------ browsers

function chromePath() {
	const found = [
		process.env.CHROME,
		"/run/current-system/sw/bin/google-chrome-stable",
		"/run/current-system/sw/bin/chromium",
		join(homedir(), ".nix-profile", "bin", "google-chrome-stable"),
	]
		.filter(Boolean)
		.find((p) => existsSync(p));
	if (!found) {
		console.error("error: no system Chrome found; set CHROME=/path/to/chrome");
		process.exit(1);
	}
	return found;
}
function loadPlaywright() {
	const found = [
		join(ROOT, "node_modules", "playwright"),
		join(PW_CACHE, "node_modules", "playwright"),
		...globSync(join(homedir(), ".npm", "_npx", "*", "node_modules", "playwright")),
	].find((p) => existsSync(p));
	if (!found) {
		execFileSync("npm", ["install", "--prefix", PW_CACHE, "--no-save", "--no-audit", "playwright"], { stdio: "inherit" });
		return require(join(PW_CACHE, "node_modules", "playwright"));
	}
	return require(found);
}

let browser = null;
async function getBrowser() {
	if (browser) return browser;
	const { chromium } = loadPlaywright();
	browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox"] });
	return browser;
}

/** A fresh context (its own localStorage) pointed at the deployment. No neon.stun: real public STUN. */
async function person(tag) {
	const context = await (await getBrowser()).newContext({ viewport: { width: 390, height: 844 } });
	await context.addInitScript((rs) => {
		try {
			localStorage.setItem("neon.rs", rs);
		} catch {}
	}, RS);
	const page = await context.newPage();
	page.on("pageerror", (err) => {
		console.log(`  FAIL page error on ${tag}: ${err.message}`);
		failures++;
	});
	page.tag = tag;
	return page;
}
const token = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("neon.room") || "null"));
const state = (page) =>
	page.evaluate(() => {
		const r = window.__party?.room;
		return {
			status: document.querySelector(".lobby-status")?.textContent ?? "",
			room: r
				? {
						id: r.selfId,
						host: r.hostId(),
						peers: r.directPeers(),
						members: r.getMembers().map((m) => ({ id: m.id, rc: !!m.reconnecting })),
						closed: r.closed,
					}
				: null,
		};
	});
const inParty = (s) => !!s?.room && !s.room.closed && s.room.host !== null && s.room.peers.length > 0;
async function waitUntil(page, pred, ms = TIMEOUT) {
	const start = Date.now();
	while (Date.now() - start < ms) {
		const s = await state(page).catch(() => null);
		if (s && pred(s)) return { ok: true, ms: Date.now() - start };
		await sleep(200);
	}
	return { ok: false, ms: Date.now() - start };
}
/** Every page names one host, sees n members, none reconnecting, all linked. */
async function converged(pages, ms = TIMEOUT) {
	const start = Date.now();
	while (Date.now() - start < ms) {
		const ss = await Promise.all(pages.map((p) => state(p).catch(() => null)));
		const hosts = new Set(ss.map((s) => s?.room?.host));
		if (
			ss.every((s) => s?.room && !s.room.closed) &&
			hosts.size === 1 &&
			!hosts.has(null) &&
			ss.every((s) => s.room.members.length === pages.length && s.room.members.every((m) => !m.rc)) &&
			ss.every((s) => s.room.peers.length === pages.length - 1)
		)
			return { ok: true, ms: Date.now() - start };
		await sleep(200);
	}
	return { ok: false, ms: Date.now() - start };
}
async function exchange(pages, ms = 10_000) {
	for (const p of pages)
		await p.evaluate(() => {
			const r = window.__party.room;
			window.__got ??= [];
			if (window.__gotRoom !== r) {
				window.__gotRoom = r;
				r.makeAction("live-test").onMessage = (d) => window.__got.push(d);
			}
		});
	const tokens = pages.map((p) => `${p.tag}-${secret().slice(0, 6)}`);
	await Promise.all(pages.map((p, i) => p.evaluate((t) => window.__party.room.makeAction("live-test").send(t), tokens[i])));
	const start = Date.now();
	while (Date.now() - start < ms) {
		const got = await Promise.all(pages.map((p) => p.evaluate(() => window.__got)));
		if (pages.every((_, i) => tokens.every((t, j) => i === j || got[i].includes(t)))) return { ok: true, ms: Date.now() - start };
		await sleep(100);
	}
	return { ok: false, ms: Date.now() - start };
}
async function host(page) {
	const start = Date.now();
	await page.goto(PARTY + "?fresh=1");
	await page.locator(".party-code-digits").waitFor({ timeout: TIMEOUT });
	return { ...(await token(page)), ms: Date.now() - start };
}
async function joinByCode(page, code) {
	await page.goto("about:blank");
	const start = Date.now();
	await page.goto(`${PARTY}#c=${code}`);
	const w = await waitUntil(page, inParty, NO_ANSWER_WAIT);
	return { ok: w.ok, ms: Date.now() - start };
}
const nextDialog = async (page, accept) => {
	const dlg = page.locator("dialog.neon-ask[open]");
	const shown = await dlg
		.waitFor({ timeout: 5000 })
		.then(() => true)
		.catch(() => false);
	if (!shown) return "(no dialog)";
	const text = (await dlg.locator("p").textContent()) ?? "";
	await dlg.locator(`[data-ask="${accept ? "yes" : "no"}"]`).click();
	return text;
};
const muteOffers = (page, muted) =>
	page.evaluate((m) => {
		if (!window.__muteInstalled) {
			window.__muteInstalled = true;
			const send = WebSocket.prototype.send;
			WebSocket.prototype.send = function (data) {
				if (window.__muted && typeof data === "string" && /"t":"(offer|answer)"/.test(data)) return;
				return send.call(this, data);
			};
		}
		window.__muted = m;
	}, muted);
/** Which ICE candidate types the page's links actually use. */
const pairTypes = (page) =>
	page.evaluate(async () => {
		const out = [];
		for (const pc of [...(window.__party?.room?.links?.values() ?? [])].map((l) => l.pc).filter(Boolean)) {
			const st = await pc.getStats();
			st.forEach((r) => {
				if (r.type === "candidate-pair" && r.nominated && r.state === "succeeded") {
					const l = st.get(r.localCandidateId);
					const rm = st.get(r.remoteCandidateId);
					out.push(`${l?.candidateType}->${rm?.candidateType}`);
				}
			});
		}
		return out;
	});

// ------------------------------------------------------------ sections

console.log(`room server: ${RS}`);
{
	// Cloudflare can answer an address it distrusts with a managed challenge
	// (403, cf-mitigated: challenge) that no WebSocket can solve. Seen
	// 2026-11-11 on a temporary-account deployment: this host's IPv4 (a
	// shared ISP address) always, its IPv6 never. Say so up front, rather
	// than let it read as the room server failing.
	const { execFileSync: run } = await import("node:child_process");
	for (const fam of ["-4", "-6"]) {
		let out = "";
		try {
			out = run("curl", [fam, "-s", "-o", "/dev/null", "-D", "-", "--max-time", "8", `${RS}/ping`]).toString();
		} catch {
			out = "(no route)";
		}
		const status = out.match(/^HTTP\/\S+ (\d+)/m)?.[1] ?? out.trim().slice(0, 20);
		console.log(`  ·    /ping over IPv${fam[1]}: ${status}${/cf-mitigated: challenge/i.test(out) ? " — CHALLENGED by Cloudflare" : ""}`);
	}
}
try {
	if (SECTIONS.has("ping")) {
		section = "ping";
		console.log("\nlive: GET /ping");
		const start = performance.now();
		const r = await fetch(`${RS}/ping`);
		check("204", r.status === 204, String(r.status), performance.now() - start);
		check("readable cross-origin", r.headers.get("access-control-allow-origin") === "*");
		check("not cached", /no-store/.test(r.headers.get("cache-control") ?? ""));
		const room = await fetch(`${RS}/room/123456`);
		check("a room path without an upgrade is 426", room.status === 426, String(room.status));
		const nope = await fetch(`${RS}/nothing`);
		check("anything else is 404", nope.status === 404, String(nope.status));
	}

	if (SECTIONS.has("oracle")) {
		section = "oracle";
		console.log(`\nlive: timing oracle — live code vs never-used code (${SAMPLES} samples each)`);
		const live = await nodeHost(); // kept attached, so its object stays warm
		const liveDial = [];
		const freshDial = [];
		const liveReply = [];
		const freshReply = [];
		// Interleaved, so drift in the network hits both alike.
		const refused = []; // statuses of upgrades that did not upgrade
		for (let i = 0; i < SAMPLES; i++) {
			const a = await dial(live.code);
			const b = await dial(code6());
			if (a.ok) liveDial.push(a.ms);
			else refused.push(a.status ?? a.error);
			if (b.ok) freshDial.push(b.ms);
			else refused.push(b.status ?? b.error);
			if (refused.length >= 4) break; // the dial budget is spent: probing has stopped
			const c = await firstReply(live.code);
			const d = await firstReply(code6());
			if (c.ok) liveReply.push(c.reply);
			if (d.ok) freshReply.push(d.reply);
			if (!c.ok || !d.ok) refused.push(429); // a WebSocket hides the status; the 101s above show it
		}
		if (!liveDial.length || !freshDial.length) throw new Error("no samples: " + JSON.stringify(refused));
		const ld = stats(liveDial);
		const fd = stats(freshDial);
		const lr = stats(liveReply);
		const fr = stats(freshReply);
		console.log(`  ·    101, live code:        ${fmt(ld)}`);
		console.log(`  ·    101, never-used code:  ${fmt(fd)}`);
		console.log(`  ·    first reply, live:     ${fmt(lr)}`);
		console.log(`  ·    first reply, unused:   ${fmt(fr)}`);
		// A simple classifier: threshold at the midpoint of the medians. How
		// often would a prober be right?
		const acc = (L, F) => {
			if (!L.length || !F.length) return NaN;
			const thr = (stats(L).median + stats(F).median) / 2;
			const fast = stats(L).median <= stats(F).median;
			const right = L.filter((x) => (fast ? x <= thr : x > thr)).length + F.filter((x) => (fast ? x > thr : x <= thr)).length;
			return right / (L.length + F.length);
		};
		console.log(`  ·    one-shot classifier accuracy: 101 ${(acc(liveDial, freshDial) * 100).toFixed(0)}%, reply ${(acc(liveReply, freshReply) * 100).toFixed(0)}% (50% = no signal)`);
		// Since the dial gate (2026-11-11) a prober gets DIAL_FAILS (10, the
		// guess limit since 2026-11-12) unrefunded upgrades per 5 min, then
		// 429 for every code alike. The live room's host (`/room/new`)
		// spent none of them.
		const probes = liveDial.length + freshDial.length + liveReply.length + freshReply.length;
		console.log(`  ·    probes that reached a room before refusal: ${probes}; then ${JSON.stringify(refused)}`);
		check(
			"probing is capped: refused (429) within the dial budget",
			refused.length > 0 && refused.every((s) => s === 429) && probes <= DIAL_FAILS,
			`${probes} probes, refused ${JSON.stringify(refused)}`,
		);
		live.s.close();
	}

	if (SECTIONS.has("flows")) {
		section = "flows";
		console.log("\nlive: browsers through the deployed room server, real STUN");
		const a = await person("a");
		const b = await person("b");
		const ta = await host(a);
		check("a hosts a party by code", /^\d{6}$/.test(ta.code ?? ""), JSON.stringify(ta), ta.ms);
		const j = await joinByCode(b, ta.code);
		check("b joins by code", j.ok, "", j.ms);
		const cv = await converged([a, b]);
		check("one host, both linked", cv.ok, "", cv.ms);
		const x = await exchange([a, b]);
		check("messages flow both ways", x.ok, "", x.ms);
		console.log(`  ·    candidate pairs in use: ${JSON.stringify(await pairTypes(a))}`);

		let t0 = Date.now();
		await a.reload();
		let r = await converged([a, b], NO_ANSWER_WAIT);
		check("host reload reconnects, one host", r.ok, "", Date.now() - t0);
		check("messages after host reload", (await exchange([a, b])).ok);
		for (const n of [1, 2]) {
			t0 = Date.now();
			await b.reload();
			r = await converged([a, b], NO_ANSWER_WAIT);
			check(`guest reload #${n} reconnects`, r.ok, "", Date.now() - t0);
		}
		check("messages after guest reloads", (await exchange([a, b])).ok);

		// A rejoin nobody answers, then RETRY.
		const tb = await token(b);
		await muteOffers(a, true);
		t0 = Date.now();
		await b.reload();
		const retry = b.locator("button", { hasText: /^RETRY$/ });
		const shown = await retry.waitFor({ timeout: NO_ANSWER_WAIT }).then(() => true, () => false);
		check("rejoin nobody answers: RETRY offered", shown, "", Date.now() - t0);
		check("the claim is kept on the server", (await claimOf(ta.code, tb.id)) === "id-taken");
		await muteOffers(a, false);
		t0 = Date.now();
		await retry.click();
		r = await converged([a, b], NO_ANSWER_WAIT);
		check("RETRY reconnects into the same seat", r.ok && (await b.evaluate(() => window.__party.room.selfId)) === tb.id, "", Date.now() - t0);

		// Two tabs, one token.
		const b2 = await b.context().newPage();
		b2.tag = "b2";
		t0 = Date.now();
		await b2.goto(PARTY);
		const w2 = await waitUntil(b2, inParty, NO_ANSWER_WAIT);
		check("a second tab with the same token takes the seat", w2.ok, "", Date.now() - t0);
		const told = await b
			.locator(".lobby-status", { hasText: /open in another tab/i })
			.waitFor({ timeout: TIMEOUT })
			.then(() => true, () => false);
		check("the first tab stands down (4409), says so", told);
		await sleep(5000);
		check("the second tab is still in the party", inParty(await state(b2)));
		const busy = await b.evaluate(() => NeonArcade.releaseRejoin());
		check("releaseRejoin from the stale tab answers busy", busy === "busy", String(busy));
		await sleep(1500);
		check("and the live tab keeps its seat", inParty(await state(b2)) && (await claimOf(ta.code, tb.id)) === "id-taken");
		await b2.close();

		// A rejoin that gets no answer, then START A NEW PARTY: releases the claim.
		await muteOffers(a, true);
		await b.goto(PARTY);
		await b.locator("button", { hasText: /^RETRY$/ }).waitFor({ timeout: NO_ANSWER_WAIT }).catch(() => {});
		await b.locator("button", { hasText: "START A NEW PARTY" }).click();
		await b.locator(".party-code-digits").waitFor({ timeout: TIMEOUT });
		const tb2 = await token(b);
		check("START A NEW PARTY hosts anew", !!tb2 && tb2.code !== ta.code);
		check("releaseRejoin gave the old seat back (released)", (await claimOf(ta.code, tb.id)) === "free");
		await muteOffers(a, false);

		// A deliberate leave releases the claim (one-member room: gone).
		const lone = await person("lone");
		const tl = await host(lone);
		const dlg = nextDialog(lone, true);
		await lone.locator("button.neon-btn", { hasText: /^NEW PARTY$/ }).first().click();
		await dlg;
		await lone.waitForFunction((old) => {
			const d = document.querySelector(".party-code-digits")?.textContent?.trim();
			return d && d !== old;
		}, tl.code, { timeout: TIMEOUT });
		check("NEW PARTY's leave released the claim before navigating", (await claimOf(tl.code, tl.id)) === "no-room");
		await lone.context().close();

		// A full party: a's room holds a and b's old seat (released) — fill
		// to eight with node members, then the ninth is refused.
		const fill = [];
		for (let i = 0; i < 12; i++) {
			const m = await nodeJoin(ta.code);
			if (m.r.t !== "joined") {
				check(`the room refuses a joiner when full (after ${fill.length} node joins)`, m.r.reason === "full", JSON.stringify(m.r));
				m.s.close();
				break;
			}
			fill.push(m);
		}
		// a, plus b's old seat: the claimOf probe after the release *joined*
		// it ("free"), and its claim is held for the grace like anyone's.
		const occupied = 2 + fill.length;
		check("full means eight seats", occupied === 8, `a + probe + ${fill.length}`);
		for (const m of fill) m.s.close();
		await b.context().close();
		await a.context().close();
	}

	if (SECTIONS.has("hib")) {
		section = "hib";
		console.log(`\nlive: hibernation — idle ${IDLE_MS / 1000}s, then everything still works`);
		const h = await nodeHost();
		const m = await nodeJoin(h.code);
		const q = await nodeJoin(h.code);
		check("(node room: host + two members)", m.r.t === "joined" && q.r.t === "joined");
		const a = await person("ha");
		const b = await person("hb");
		const ta = await host(a);
		const jb = await joinByCode(b, ta.code);
		check("(browser party a+b)", jb.ok);
		const before = await dial(h.code);
		const beforeA = await dial(ta.code);
		if (!before.instance) console.log("  ·    no X-Room-Instance: deploy with --var ROOM_DEBUG:1 to prove eviction");
		await sleep(IDLE_MS);
		const after = await dial(h.code);
		const afterA = await dial(ta.code);
		const evicted = !!before.instance && !!after.instance && before.instance !== after.instance;
		const evictedA = !!beforeA.instance && !!afterA.instance && beforeA.instance !== afterA.instance;
		// Without ROOM_DEBUG (a production deploy must not set it) eviction
		// cannot be proven, only survived: the checks below still run after
		// the idle, so report the proof as skipped rather than failed.
		const proves = !!before.instance;
		if (proves) {
			check("the node room's object was evicted (new instance)", evicted, `${before.instance} → ${after.instance}`);
			check("the browser room's object was evicted", evictedA, `${beforeA.instance} → ${afterA.instance}`);
		} else console.log("  ·    eviction proof skipped (no ROOM_DEBUG); the checks below run after the idle anyway");
		// An offer relayed between two sockets that hibernated with the object.
		m.s.send({ t: "offer", to: h.id, sdp: "ping-after-hibernation" });
		const got = await h.s.next((x) => x.t === "offer", 10_000);
		check("an offer is relayed between hibernated sockets", got.from === m.id && got.sdp === "ping-after-hibernation", JSON.stringify(got));
		// A socket closing after the wake-up is announced to the others.
		await sleep(IDLE_MS);
		const again = await dial(h.code);
		if (proves) check("(evicted again before the close)", !!again.instance && again.instance !== after.instance);
		q.s.close();
		const gone = await h.s.next((x) => x.t === "peer" && x.id === q.id && x.connected === false, 10_000);
		check("a hibernated socket's close is announced", gone.connected === false, JSON.stringify(gone));
		const held = await claimOf(h.code, q.id);
		check("the closed member's claim is held for its grace", held === "id-taken", held);
		// A reloaded browser rejoins a room whose object was evicted.
		await sleep(IDLE_MS);
		let t0 = Date.now();
		await b.reload();
		let cv = await converged([a, b], NO_ANSWER_WAIT);
		check("a browser reload rejoins after eviction", cv.ok, "", Date.now() - t0);
		check("messages after", (await exchange([a, b])).ok);
		await sleep(IDLE_MS);
		t0 = Date.now();
		await a.reload();
		cv = await converged([a, b], NO_ANSWER_WAIT);
		check("a host reload rejoins after eviction", cv.ok, "", Date.now() - t0);
		h.s.close();
		m.s.close();
		await a.context().close();
		await b.context().close();
	}

	if (SECTIONS.has("redraw")) {
		section = "redraw";
		console.log("\nlive: a live first draw is redrawn (the second forward of one upgrade)");
		const live = await nodeHost();
		const probe = await dial(`new?draw=${live.code}`);
		if (!probe.ok) check("(the forced /room/new upgraded)", false, JSON.stringify(probe));
		else if (probe.draws === null) {
			console.log("  ·    skipped: no X-Room-Draws — needs a debug deployment (--var ROOM_DEBUG:1 --var ROOM_TEST_FORCE_REDRAW:1), never the real one");
		} else if (probe.draws === "1") {
			console.log("  ·    skipped: ROOM_DEBUG is set but ROOM_TEST_FORCE_REDRAW is not (the draw was not forced)");
		} else {
			check("a forced live first draw took two draws and still upgraded", probe.draws === "2", `draws=${probe.draws}`);
			// End to end: the re-forwarded socket carries a host to a room.
			const got = await new Promise((done) => {
				const ws = new WebSocket(`${WS}/room/new?draw=${live.code}`);
				const timer = setTimeout(() => (ws.close(), done({ t: "timeout" })), 10_000);
				ws.onopen = () => ws.send(JSON.stringify({ t: "host", id: "r" + secret().slice(0, 6), secret: secret() }));
				ws.onmessage = (e) => (clearTimeout(timer), ws.close(), done(JSON.parse(e.data)));
				ws.onerror = () => (clearTimeout(timer), done({ t: "error", reason: "socket" }));
			});
			check("the redrawn socket hosts a room under another code", got.t === "room" && /^\d{6}$/.test(got.code) && got.code !== live.code, JSON.stringify(got));
			check("the live room's host is undisturbed", live.s.closed === null, String(live.s.closed));
			const guest = await nodeJoin(live.code);
			check("and the live room still seats a guest", guest.r.t === "joined", JSON.stringify(guest.r));
			guest.s.close();
		}
		live.s.close();
	}

	if (SECTIONS.has("alarm")) {
		section = "alarm";
		console.log("\nlive: the alarm sweeps an abandoned room (~16 min, nothing touches it)");
		const h = await nodeHost();
		h.s.close();
		await sleep(2000);
		check("(room held after its host's socket closed)", (await claimOf(h.code, h.id)) === "id-taken");
		const start = Date.now();
		// The probe above touched it; the TTL counts from there.
		await sleep(15 * 60_000 + 60_000);
		const v = await claimOf(h.code, h.id);
		check("after 16 min the room is gone (alarm fired; no request woke it)", v === "no-room", v, Date.now() - start);
	}

	if (SECTIONS.has("gate")) {
		section = "gate";
		console.log("\nlive: the guess limit on real CF-Connecting-IP (spends this IP's budget for 5 min)");
		// A real member first, with a claim — and a pass — to come back
		// with. Hosting is `/room/new`: no dial, no guess.
		const h = await nodeHost();
		const mem = await nodeJoin(h.code);
		mem.s.close();
		check("the deployment issues member passes (ROOM_PASS_KEY is set)", !!h.pass && !!mem.pass, JSON.stringify({ host: !!h.pass, member: !!mem.pass }));
		const answers = [];
		for (let i = 0; i < DIAL_FAILS; i++) answers.push((await call(code6(), { t: "join", id: "x", secret: "y" })).reason);
		check(`${DIAL_FAILS} wrong codes: no-room each`, answers.every((r) => r === "no-room"), answers.join());
		// A WebSocket hides the 429; the socket simply fails.
		// Refused before any room, on a socket the Worker accepts itself
		// to say why (a browser never sees the 429 it stands for).
		const next = await call(code6(), { t: "join", id: "x", secret: "y" });
		check("the next upgrade is refused before any room: blocked", next.reason === "blocked", JSON.stringify(next));
		const right = await call(h.code, { t: "join", id: "new", secret: "z" });
		check("even the right code is refused for a newcomer", right.reason === "blocked", JSON.stringify(right));
		// What equal budgets used to cost a shared address: its members'
		// re-dials. A pass is checked before the gate (2026-11-12).
		const back = await nodeJoin(h.code, mem.id, mem.secret, { id: mem.id, pass: mem.pass, exp: mem.exp }).catch((err) => ({ r: { t: "refused", err: String(err) } }));
		check("a member re-dials from the exhausted address on its pass", back.r.t === "joined", JSON.stringify(back.r));
		back.s?.close();
		const bare = await nodeJoin(h.code, mem.id, mem.secret).catch((err) => ({ r: { t: "refused", err: String(err) } }));
		check("without the pass it would not have", bare.r.t !== "joined", JSON.stringify(bare.r));
		bare.s?.close();
		const again = await nodeHost().catch((err) => ({ err: String(err) }));
		check("and the exhausted address still hosts (/room/new)", /^\d{6}$/.test(again.code ?? ""), JSON.stringify(again.err ?? again.code));
		again.s?.close();
		let pings = 0;
		for (let i = 0; i < 20; i++) if ((await fetch(`${RS}/ping`)).status === 204) pings++;
		check("/ping is never limited (20/20)", pings === 20, `${pings}/20`);
		h.s.close();
	}
} catch (err) {
	console.log(`  FAIL ${err.stack ?? err}`);
	failures++;
} finally {
	await browser?.close().catch(() => {});
}

console.log("\n| section | check | result | time |\n|---|---|---|---|");
for (const [s, l, ok, ms] of table) console.log(`| ${s} | ${l} | ${ok ? "ok" : "FAIL"} | ${ms === null ? "" : (ms / 1000).toFixed(1) + " s"} |`);
console.log(failures ? `\n${failures} failing` : "\nall passing");
process.exit(failures ? 1 : 0);
