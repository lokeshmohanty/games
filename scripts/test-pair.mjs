#!/usr/bin/env node
/**
 * test-pair.mjs — two real machines on two different public networks, the
 * site and room server AS DEPLOYED (or as given), real Chrome on each, real
 * public STUN.
 *
 *   node scripts/test-pair.mjs [--runs=3] [--stun4] [--remote=bhaskara]
 *        [--remote-hosts] [--site=URL] [--rs=URL] [--manual=SECS[,remote]]
 *   just test-pair [...same flags]
 *
 * Every other browser suite runs its peers on one machine (loopback, or the
 * namespace NAT lab, or the lab behind slirp4netns), so every candidate pair
 * either trivially connects or must hairpin through this machine's own NAT.
 * This one puts the second player on a different machine on a different
 * network: the only setting in which a direct cross-network path is real.
 *
 * Roles (the same file runs on both machines):
 *   pair        (default) this machine. Classifies both NATs over STUN,
 *               then starts `ssh <remote> node ~/neon-pair-test/test-pair.mjs
 *               drive` and runs each phase on both: this machine hosts and
 *               the remote joins by code, or the other way round with
 *               --remote-hosts.
 *   drive       one person with one tab, obeying JSON commands on stdin
 *               (host, join, exchange, pings, mark, whole, reload, retry,
 *               stats, leave, bare, eval, close, quit). This machine's side
 *               runs the same handler in-process.
 *   stun        prints this machine's NAT mapping behaviour as JSON (a
 *               40-line node dgram STUN client; no browser).
 *   punch       the remote end of the hole-punch probe (punchProbe): which
 *               side must send first for UDP to get through at all.
 *
 * Per run, both ends assert: joined within JOIN_BOUND; one host (both name
 * the same id); both linked; game-like traffic both ways (30 ticks each way
 * at ~30 Hz, plus 10 ping/pong round trips); and they REPORT the selected
 * ICE candidate pair from getStats on both ends, who offered the link and
 * whether it is the role-swapped retry. Then: the guest reloads and
 * reconnects (twice); the host reloads and reconnects; the guest leaves
 * (ALL GAMES, confirmed) and the host sees it at once.
 * If ICE finds no path, the expected product behaviour is the explicit
 * "no-route" message at ~15–20 s — that is asserted instead, and the NAT
 * classification says whose mapping is to blame.
 *
 * --stun4: this machine's browser uses one STUN server by IPv4 literal
 * (localStorage "neon.stun", the test hook in lib/net.js; STUN4=host:port,
 * default stun.cloudflare.com:3478), so its only server-reflexive candidate
 * is IPv4. Host candidates over IPv6 still exist; they cannot pair with an
 * IPv4-only remote anyway.
 * --diag: wrap RTCPeerConnection (test instrumentation) and print, after
 * each reconnect, who offered, the candidates signalled and every pair's
 * check counters. --no-punch skips the browserless hole-punch probe,
 * --no-classify the STUN classification.
 *
 * --site=URL / SITE and --rs=URL / RS: the site and the room server both
 * sides use instead of the deployed ones (RS goes into localStorage
 * "neon.rs"). Use loopback URLs reached on both machines — e.g. a static
 * server and `wrangler dev` on the remote, forwarded here with ssh -L —
 * so the final code is tested across networks without a deploy.
 * --site-remote / --rs-remote (RS_REMOTE): the remote's own URLs for the
 * same servers, when the forward here had to use another port.
 * --manual=SECS[,remote]: after the runs, the manual (scan/paste)
 * handshake on bare pages through the room API, the reply carried back
 * after SECS; this machine invites unless `,remote`.
 *
 * Needs: ssh access to the remote (BatchMode — keys, no prompts), node and
 * a system Chrome there, and Playwright on both machines (looked for where
 * scripts/test-live.mjs looks; installed into ~/.cache/game-previews if
 * absent). Nothing secret is copied; the script copies only this file.
 * The remote's processes are killed at the end (pkill on the script path).
 */
import { createRequire } from "node:module";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, globSync } from "node:fs";
import { createSocket } from "node:dgram";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import dns from "node:dns/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const SELF = fileURLToPath(import.meta.url);

const REMOTE_DIR = "neon-pair-test"; // under the remote's $HOME
const JOIN_BOUND = 30_000; // joined (or told why not) within this
const NO_ROUTE_MIN = 8_000; // the explicit no-route verdict: ~15 s by design
const NO_ROUTE_MAX = 25_000;
const RECONNECT = 45_000;
const LEAVE_SEEN = 5_000;
// What the page says when it has given up: net.js's ICE verdict, room-join's
// no-route / no-answer, or any other explicit failure on .lobby-status.
const VERDICT = /cannot connect directly|no route between them|nobody answered|could not|no party|error|failed/i;
const NO_ROUTE = /cannot connect directly|no route between them/i;
/** In the party, or told why not — never "still waiting". */
const settled = (s, fresh = false) => whole(s, 2, fresh) || (!s.room?.peers?.length && VERDICT.test(s.status)); // "at once": the leave is announced, not timed out

const args = process.argv.slice(2);
const opt = (k, d) => (args.find((a) => a.startsWith(`--${k}=`)) ?? `=${d}`).split("=").slice(1).join("=");
const flag = (k) => args.includes(`--${k}`);
const role = args[0] && !args[0].startsWith("--") ? args[0] : "pair";
// The site and room server under test: as deployed by default; --site / SITE
// and --rs / RS point both machines at another (e.g. a static server and
// `wrangler dev` on one machine, reached by the other over ssh -L, so both
// browsers see them on loopback — docs/network-testing.md).
const SITE = (opt("site", "") || process.env.SITE || "https://www.lokeshmohanty.in/games/").replace(/\/?$/, "/");
const PARTY = SITE + "party.html";
const RS = opt("rs", "") || process.env.RS || ""; // localStorage "neon.rs" on both sides
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag8 = () => randomBytes(4).toString("hex");

// ------------------------------------------------------------ STUN (node)

/** One binding request from `sock` to host:port; resolves {ip, port} or null. */
function bind(sock, host, port, ms = 3000) {
	return new Promise((done) => {
		const tid = randomBytes(12);
		const req = Buffer.alloc(20);
		req.writeUInt16BE(0x0001, 0); // Binding Request
		req.writeUInt16BE(0, 2);
		req.writeUInt32BE(0x2112a442, 4); // magic cookie
		tid.copy(req, 8);
		const onMsg = (msg) => {
			if (msg.length < 20 || msg.readUInt16BE(0) !== 0x0101 || !msg.subarray(8, 20).equals(tid)) return;
			for (let o = 20; o + 4 <= msg.length; ) {
				const type = msg.readUInt16BE(o);
				const len = msg.readUInt16BE(o + 2);
				const v = msg.subarray(o + 4, o + 4 + len);
				if ((type === 0x0020 || type === 0x0001) && v[1] === 0x01) {
					const x = type === 0x0020;
					const p = v.readUInt16BE(2) ^ (x ? 0x2112 : 0);
					const a = v.readUInt32BE(4) ^ (x ? 0x2112a442 : 0);
					finish({ ip: [a >>> 24, (a >>> 16) & 255, (a >>> 8) & 255, a & 255].join("."), port: p });
					return;
				}
				o += 4 + Math.ceil(len / 4) * 4;
			}
		};
		const timers = [];
		const finish = (r) => {
			sock.off("message", onMsg);
			timers.forEach(clearTimeout);
			done(r);
		};
		sock.on("message", onMsg);
		// RFC 5389-style retransmits; UDP drops are not a NAT verdict.
		for (const t of [0, 500, 1500]) timers.push(setTimeout(() => sock.send(req, port, host), t));
		timers.push(setTimeout(() => finish(null), ms));
	});
}

const STUN_SERVERS = [
	["stun.l.google.com", 19302],
	["stun.cloudflare.com", 3478],
	["stun.nextcloud.com", 3478], // same port as Cloudflare's, another address
];

/**
 * Mapping behaviour, IPv4: one socket asks three servers — two on port
 * 3478 at different addresses, one on 19302. Same mapped ip:port from all
 * = endpoint-independent mapping (a hole one peer's STUN found works for
 * any peer); the same for both :3478 servers but not :19302 = the mapping
 * follows the destination *port* (seen on an Indian mobile-carrier CGNAT,
 * 2026-11-12); all different = address-dependent (symmetric). Anything but
 * endpoint-independent is not traversable by STUN alone unless the other
 * side's packets reach the mapping first — the punch probe measures that.
 * A second socket shows how ports are allocated.
 */
async function classify() {
	const servers = [];
	for (const [h, p] of STUN_SERVERS) {
		const ip = await dns.lookup(h, { family: 4 }).then((r) => r.address, () => null);
		servers.push({ name: `${h}:${p}(${ip})`, ip, port: p });
	}
	const sockets = [];
	for (let s = 0; s < 2; s++) {
		const sock = createSocket("udp4");
		await new Promise((r) => sock.bind(0, r));
		const local = sock.address().port;
		const mapped = [];
		for (const sv of servers) mapped.push({ server: sv.name, ...(sv.ip ? await bind(sock, sv.ip, sv.port) : null) });
		sock.close();
		sockets.push({ localPort: local, mapped });
	}
	const seen = sockets[0].mapped.filter((m) => m.ip);
	const keys = new Set(seen.map((m) => `${m.ip}:${m.port}`));
	const m = Object.fromEntries(sockets[0].mapped.map((x, i) => [i, x.ip ? `${x.ip}:${x.port}` : null]));
	const mapping =
		seen.length < 2
			? "unknown (STUN unreachable)"
			: keys.size === 1
				? "endpoint-independent"
				: m[1] === m[2] && m[1] && m[0]
					? "destination-port-dependent (same for both :3478 servers, new for :19302)"
					: "address-dependent (symmetric)";
	const preserved = sockets.every((s) => s.mapped.filter((m) => m.ip).every((m) => m.port === s.localPort));
	return { machine: hostname(), mapping, portPreserved: preserved, sockets };
}

/**
 * Hole punching between the two machines, without a browser — what ICE
 * will meet, measured directly. The remote binds a socket (its public port
 * from STUN); this machine binds one and opens a mapping by asking one STUN
 * server (`via`). Then either the remote punches at that mapping first and
 * this machine answers 2.5 s later ("remote-first", what happens when the
 * remote is the ICE answerer: an answerer starts its checks ~1 s before the
 * offerer has the answer), or this machine sends first ("local-first").
 * Reports whether anything got through either way.
 */
async function punchRemote() {
	const out = (o) => process.stdout.write("@@" + JSON.stringify(o) + "\n");
	const sock = createSocket("udp4");
	await new Promise((r) => sock.bind(0, r));
	const cf = await dns.lookup("stun.cloudflare.com", { family: 4 });
	out({ ev: "pub", pub: await bind(sock, cf.address, 3478) });
	sock.on("message", (m, r) => {
		if (m.length >= 8 && m.readUInt32BE(4) === 0x2112a442) return; // STUN, not a probe
		out({ ev: "saw", from: `${r.address}:${r.port}` });
		sock.send("pong", r.port, r.address);
	});
	let timer = null;
	for await (const line of createInterface({ input: process.stdin })) {
		const c = JSON.parse(line);
		if (c.punch) timer = setInterval(() => sock.send("punch", c.punch.port, c.punch.ip), 200);
		if (c.quit) break;
	}
	clearInterval(timer);
	sock.close();
	process.exit(0);
}
async function punchProbe(remote, via, order) {
	const [vh, vp] = via.split(":");
	const L = createSocket("udp4");
	await new Promise((r) => L.bind(0, r));
	const vip = (await dns.lookup(vh, { family: 4 })).address;
	const mine = await bind(L, vip, Number(vp));
	const child = spawn("ssh", ["-o", "BatchMode=yes", remote, "node", `${REMOTE_DIR}/test-pair.mjs`, "punch"], { stdio: ["pipe", "pipe", "inherit"] });
	const seen = new Set();
	let pub = null;
	const gotPub = new Promise((done) =>
		createInterface({ input: child.stdout }).on("line", (l) => {
			if (!l.startsWith("@@")) return;
			const m = JSON.parse(l.slice(2));
			if (m.ev === "pub") (pub = m.pub), done();
			if (m.ev === "saw") seen.add(m.from);
		}),
	);
	await Promise.race([gotPub, sleep(15_000)]);
	let back = 0;
	L.on("message", (m) => m.toString() !== "" && !(m.length >= 8 && m.readUInt32BE(4) === 0x2112a442) && back++);
	let lt = null;
	const local = () => (lt = setInterval(() => pub && L.send("hello", pub.port, pub.ip), 200));
	const far = () => child.stdin.write(JSON.stringify({ punch: mine }) + "\n");
	if (!mine || !pub) {
		child.stdin.end();
		L.close();
		return { via, order, error: "no STUN mapping" };
	}
	if (order === "remote-first") far(), await sleep(2500), local();
	else local(), await sleep(2500), far();
	await sleep(4000);
	clearInterval(lt);
	child.stdin.write('{"quit":1}\n');
	child.stdin.end();
	L.close();
	return { via, order, mapped: mine.port, remoteSaw: [...seen], localGot: back, through: seen.size > 0 && back > 0 };
}

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
	if (!found) throw new Error("no system Chrome found; set CHROME=/path/to/chrome");
	return found;
}
function loadPlaywright() {
	const cache = join(homedir(), ".cache", "game-previews");
	const found = [
		join(SELF, "..", "..", "node_modules", "playwright"),
		join(cache, "node_modules", "playwright"),
		...globSync(join(homedir(), ".npm", "_npx", "*", "node_modules", "playwright")),
	].find((p) => existsSync(p));
	if (found) return require(found);
	execFileSync("npm", ["install", "--prefix", cache, "--no-save", "--no-audit", "playwright"], { stdio: "inherit" });
	return require(join(cache, "node_modules", "playwright"));
}

let browser = null;
async function person(tagName, init = {}) {
	browser ??= await loadPlaywright().chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox"] });
	const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
	await context.addInitScript((kv) => {
		try {
			for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v);
		} catch {}
	}, init);
	if (flag("diag")) await context.addInitScript(recordIce);
	const page = await context.newPage();
	page.errors = [];
	page.on("pageerror", (e) => page.errors.push(e.message));
	page.tag = tagName;
	return page;
}

/**
 * --diag only (test instrumentation, never the default): wrap
 * RTCPeerConnection so every connection — including ones that fail and are
 * closed — leaves a record: its ICE state changes with timestamps, and at
 * each connected/failed/disconnected moment every candidate and every
 * candidate pair with its check counters. `diag` reads window.__ice.
 */
function recordIce() {
	const Orig = window.RTCPeerConnection;
	if (!Orig || Orig.__wrapped) return;
	window.__ice = [];
	const W = function (...a) {
		const pc = new Orig(...a);
		const rec = { n: window.__ice.length, at: new Date().toISOString().slice(11, 19), states: [], snaps: [] };
		const t0 = performance.now();
		window.__ice.push(rec);
		// What signalling actually carried: candidate lines of each description set.
		const cands = (d) => (d?.sdp ?? "").split(/\r?\n/).filter((l) => l.startsWith("a=candidate")).map((l) => l.split(" ").slice(4, 8).join(" "));
		for (const side of ["Local", "Remote"]) {
			const orig = pc[`set${side}Description`].bind(pc);
			pc[`set${side}Description`] = (d, ...rest) => {
				rec.states.push(`set${side}(${d?.type ?? "implicit"}, ${cands(d).length} cands)@${Math.round(performance.now() - t0)}`);
				if (side === "Remote") rec.remoteSdp = cands(d);
				return orig(d, ...rest);
			};
		}
		const add = pc.addIceCandidate.bind(pc);
		pc.addIceCandidate = (c, ...rest) => ((rec.added ??= []).push(c?.candidate ?? null), add(c, ...rest));
		pc.addEventListener("icegatheringstatechange", () => rec.states.push(`gather:${pc.iceGatheringState}@${Math.round(performance.now() - t0)}`));
		pc.addEventListener("iceconnectionstatechange", async () => {
			const s = pc.iceConnectionState;
			rec.states.push(`${s}@${Math.round(performance.now() - t0)}`);
			if (!["connected", "failed", "disconnected"].includes(s)) return;
			try {
				const st = await pc.getStats();
				const c = (x) => `${x?.candidateType}:${x?.address}:${x?.port}`;
				const snap = { state: s, local: [], remote: [], pairs: [] };
				st.forEach((r) => {
					if (r.type === "local-candidate") snap.local.push(c(r));
					if (r.type === "remote-candidate") snap.remote.push(c(r));
					if (r.type === "candidate-pair")
						snap.pairs.push(`${c(st.get(r.localCandidateId))} -> ${c(st.get(r.remoteCandidateId))} ${r.state}${r.nominated ? " N" : ""} sent=${r.requestsSent} got=${r.responsesReceived} in=${r.requestsReceived}`);
				});
				rec.snaps.push(snap);
			} catch {}
		});
		return pc;
	};
	W.prototype = Orig.prototype;
	W.__wrapped = true;
	Object.setPrototypeOf(W, Orig);
	window.RTCPeerConnection = W;
}
const diag = (page) => page.evaluate(() => window.__ice ?? null).catch(() => null);
const printDiag = (who, recs) => {
	for (const r of recs ?? []) {
		console.log(`    [diag ${who}] pc#${r.n} @${r.at} ${r.states.join(" ")}`);
		console.log(`      remote SDP candidates: ${JSON.stringify(r.remoteSdp ?? null)}; addIceCandidate: ${JSON.stringify(r.added ?? [])}`);
		for (const sn of r.snaps) {
			console.log(`      ${sn.state}: local ${sn.local.join(" ")}`);
			console.log(`      ${" ".repeat(sn.state.length)}  remote ${sn.remote.join(" ")}`);
			for (const p of sn.pairs) console.log(`        ${p}`);
		}
	}
};

const state = (page) =>
	page.evaluate(() => {
		const r = window.__party?.room;
		const old = window.__oldPcs ?? new Set();
		const pcs = [...(r?.links?.values() ?? [])].map((l) => l.pc);
		return {
			status: document.querySelector(".lobby-status")?.textContent ?? "",
			room: r
				? {
						id: r.selfId,
						host: r.hostId(),
						peers: r.directPeers(),
						members: r.getMembers().map((m) => ({ id: m.id, rc: !!m.reconnecting })),
						closed: r.closed,
						fresh: pcs.length > 0 && pcs.every((pc) => !old.has(pc)),
					}
				: null,
		};
	});
/** Linked to `n - 1` peers, `n` members, none reconnecting, one host named. */
const whole = (s, n = 2, fresh = false) =>
	!!s?.room &&
	!s.room.closed &&
	s.room.host !== null &&
	s.room.members.length === n &&
	s.room.members.every((m) => !m.rc) &&
	s.room.peers.length === n - 1 &&
	(!fresh || s.room.fresh);
async function waitFor(page, pred, ms) {
	const start = Date.now();
	let s = null;
	while (Date.now() - start < ms) {
		s = await state(page).catch(() => null);
		if (s && pred(s)) return { ok: true, ms: Date.now() - start, s };
		await sleep(150);
	}
	return { ok: false, ms: Date.now() - start, s };
}
/**
 * Remember the links in use now, so a later "reconnected" means *new*
 * links — otherwise a check run before the drop is noticed passes at once
 * on the old state (docs/network-testing.md, the convergence trap).
 */
const mark = (page) => page.evaluate(() => (window.__oldPcs = new Set([...(window.__party?.room?.links?.values() ?? [])].map((l) => l.pc))));

/** The selected candidate pair of every link, from getStats. */
const pairInfo = (page) =>
	page.evaluate(async () => {
		const out = [];
		for (const link of window.__party?.room?.links?.values() ?? []) {
			if (!link.pc) continue;
			const st = await link.pc.getStats();
			let pair = null;
			st.forEach((r) => {
				if (r.type === "transport" && r.selectedCandidatePairId) pair = st.get(r.selectedCandidatePairId);
			});
			if (!pair) st.forEach((r) => r.type === "candidate-pair" && r.nominated && r.state === "succeeded" && (pair = r));
			if (!pair) {
				out.push({ peer: link.peerId, pair: null });
				continue;
			}
			const c = (x) => x && { type: x.candidateType, protocol: x.protocol, address: x.address ?? x.ip, port: x.port, network: x.networkType };
			out.push({
				peer: link.peerId,
				offered: !!link.offered,
				retry: !!link.retry,
				local: c(st.get(pair.localCandidateId)),
				remote: c(st.get(pair.remoteCandidateId)),
				rttMs: pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null,
			});
		}
		return out;
	});
const fmtPair = (p) =>
	!p?.local ? "(no selected pair)" : `${p.local.type}/${p.local.protocol} ${p.local.address}:${p.local.port} -> ${p.remote.type} ${p.remote.address}:${p.remote.port}${p.rttMs != null ? ` rtt=${p.rttMs}ms` : ""}`;

/**
 * Game-like traffic on the page's room: install the listener (idempotent per
 * room object); `send` then fires 30 ticks at ~30 Hz and, from the pinger,
 * 10 ping/pong round trips. The far side echoes pings.
 */
const listen = (page) =>
	page.evaluate(() => {
		const r = window.__party.room;
		window.__ticks ??= [];
		window.__pongs ??= new Map();
		if (window.__listenRoom === r) return;
		window.__listenRoom = r;
		const act = r.makeAction("pair-test");
		act.onMessage = (d) => {
			if (d.k === "tick") window.__ticks.push(d);
			else if (d.k === "ping") act.send({ k: "pong", n: d.n, run: d.run });
			else if (d.k === "pong") window.__pongs.set(`${d.run}:${d.n}`, performance.now());
		};
	});
const sendTicks = (page, run) =>
	page.evaluate(async (run) => {
		const act = window.__party.room.makeAction("pair-test");
		for (let i = 0; i < 30; i++) {
			act.send({ k: "tick", run, i, x: Math.random() });
			await new Promise((r) => setTimeout(r, 33));
		}
	}, run);
const gotTicks = (page, run, ms = 10_000) =>
	page.evaluate(
		async ([run, ms]) => {
			const start = performance.now();
			while (performance.now() - start < ms) {
				const got = window.__ticks.filter((t) => t.run === run).map((t) => t.i);
				if (got.length >= 30) return { ok: true, inOrder: got.every((v, k) => v === k), ms: Math.round(performance.now() - start) };
				await new Promise((r) => setTimeout(r, 50));
			}
			return { ok: false, got: window.__ticks.filter((t) => t.run === run).length };
		},
		[run, ms],
	);
const pings = (page, run) =>
	page.evaluate(async (run) => {
		const act = window.__party.room.makeAction("pair-test");
		const rtts = [];
		for (let n = 0; n < 10; n++) {
			const t0 = performance.now();
			act.send({ k: "ping", n, run });
			while (!window.__pongs.has(`${run}:${n}`) && performance.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 5));
			if (window.__pongs.has(`${run}:${n}`)) rtts.push(window.__pongs.get(`${run}:${n}`) - t0);
		}
		rtts.sort((a, b) => a - b);
		return { n: rtts.length, median: rtts.length ? Math.round(rtts[rtts.length >> 1]) : null };
	}, run);

// ------------------------------------------------------------ role: drive

/**
 * One person with one browser tab, driven by commands. The same handler
 * serves this machine's side in-process and the remote's over ssh (role
 * `drive`, one JSON command per stdin line, `@@`-prefixed JSON replies), so
 * either machine can host. Every reply carries the command's `id`.
 */
function driver(init = {}) {
	let page = null;
	const errors = [];
	const fresh = async (tagName) => {
		if (page) errors.push(...page.errors), await page.context().close().catch(() => {});
		page = await person(tagName, init);
	};
	const whom = (s) => ({ self: s?.room?.id, host: s?.room?.host, status: s?.status ?? "" });
	return async function handle(cmd) {
		switch (cmd.c) {
			case "host": {
				// A fresh party on party.html; its code from the stored token.
				await fresh("host");
				const t0 = Date.now();
				await page.goto(PARTY + "?fresh=1");
				await page.locator(".party-code-digits").waitFor({ timeout: 40_000 });
				const tok = await page.evaluate(() => JSON.parse(localStorage.getItem("neon.room") || "null"));
				await listen(page).catch(() => {});
				return { code: tok?.code ?? null, tok, ms: Date.now() - t0 };
			}
			case "join": {
				// Join by code in a fresh context: in the party, or an explicit verdict on screen.
				await fresh("guest");
				await page.goto("about:blank");
				const t0 = Date.now();
				await page.goto(`${PARTY}#c=${cmd.code}`);
				const w = await waitFor(page, (s) => settled(s), JOIN_BOUND + 5000);
				const ok = w.ok && whole(w.s);
				if (ok) await listen(page);
				return { ok, ms: Date.now() - t0, ...whom(w.s), errors: page.errors };
			}
			case "listen":
				await listen(page);
				return {};
			case "exchange": {
				const [, got] = await Promise.all([sendTicks(page, cmd.mine), gotTicks(page, cmd.theirs)]);
				return { got };
			}
			case "pings":
				return await pings(page, cmd.run);
			case "mark":
				await mark(page);
				return {};
			case "whole": {
				// Linked to the other member (new links only, with `fresh`).
				const r = await waitFor(page, (s) => whole(s, 2, !!cmd.fresh), cmd.ms ?? RECONNECT);
				if (r.ok) await listen(page);
				return { ok: r.ok, ms: r.ms, ...whom(r.s) };
			}
			case "alone": {
				const r = await waitFor(page, (s) => !!s.room && s.room.members.length === 1 && s.room.peers.length === 0, cmd.ms ?? 20_000);
				return { ok: r.ok, ms: r.ms, members: r.s?.room?.members };
			}
			case "reload": {
				await mark(page);
				const t = Date.now();
				await page.reload();
				const r = await waitFor(page, (s) => settled(s, true), RECONNECT);
				r.ok &&= whole(r.s, 2, true);
				if (r.ok) await listen(page);
				return { ok: r.ok, ms: Date.now() - t, ...whom(r.s) };
			}
			case "retry": {
				// The page's own recovery after a failed reconnect: RETRY.
				const btn = page.locator("button", { hasText: /^RETRY$/ });
				if (!(await btn.count())) return { ok: false, offered: false, status: (await state(page)).status };
				await mark(page);
				const t = Date.now();
				await btn.first().click();
				const r = await waitFor(page, (s) => whole(s, 2, true), RECONNECT);
				if (r.ok) await listen(page);
				return { ok: r.ok, offered: true, ms: Date.now() - t, ...whom(r.s) };
			}
			case "diag":
				return { recs: await diag(page) };
			case "stats":
				return { pairs: await pairInfo(page) };
			case "leave": {
				// ALL GAMES, confirmed: the deliberate leave (leaveThenGo).
				page.once("dialog", (d) => d.accept());
				const t = Date.now();
				await page.locator("a.neon-btn", { hasText: /^ALL GAMES$/ }).click();
				await page.waitForURL(/index\.html/, { timeout: 15_000 }).catch(() => {});
				return { ms: Date.now() - t, url: page.url(), token: await page.evaluate(() => localStorage.getItem("neon.room")).catch(() => "?") };
			}
			case "bare":
				// The site's net.js on a page with no party glue: the manual
				// (scan/paste) handshake, driven through the room API.
				await fresh("bare");
				await page.goto(SITE + "index.html");
				await page.addScriptTag({ url: SITE + "lib/net.js" });
				return {};
			case "eval":
				// Test instrumentation only: `fn` is this script's own source text.
				return { value: await page.evaluate(`(${cmd.fn})(${JSON.stringify(cmd.arg ?? null)})`) };
			case "close": {
				// End of a run: drop the tab, hand back its page errors.
				if (page) errors.push(...page.errors), await page.context().close().catch(() => {});
				page = null;
				return { errors: errors.splice(0) };
			}
			default:
				throw new Error(`unknown command ${cmd.c}`);
		}
	};
}

async function driveRole() {
	const out = (o) => process.stdout.write("@@" + JSON.stringify(o) + "\n");
	const handle = driver(baseInit());
	let closing = false;
	const quit = async () => {
		if (closing) return;
		closing = true;
		await browser?.close().catch(() => {});
		process.exit(0);
	};
	process.on("SIGTERM", quit);
	process.on("SIGINT", quit);
	const rl = createInterface({ input: process.stdin });
	rl.on("close", quit); // ssh went away: never leave a browser behind
	for await (const line of rl) {
		let cmd;
		try {
			cmd = JSON.parse(line);
		} catch {
			continue;
		}
		if (cmd.c === "quit") {
			out({ id: cmd.id });
			await quit();
		}
		try {
			out({ id: cmd.id, ...(await handle(cmd)) });
		} catch (e) {
			out({ id: cmd.id, error: String(e?.message ?? e).slice(0, 300) });
		}
	}
	await quit();
}

// ------------------------------------------------------------ role: pair (default)

/** localStorage both sides start with: the room server, when --rs/RS names one. */
function baseInit() {
	return RS ? { "neon.rs": RS } : {};
}

/** This machine's side: the driver, in-process. Same `ask` as the remote's. */
function localSide(init) {
	const handle = driver({ ...baseInit(), ...init });
	return {
		name: hostname(),
		ask: (cmd) => handle(cmd).catch((e) => ({ error: String(e?.message ?? e).slice(0, 300) })),
		quit: async () => {},
	};
}

/** The remote's side: one ssh session running `drive`, for the whole test. */
function remoteSide(remote) {
	// --rs-remote: the same server as the remote sees it, when the forward
	// here could not take the remote's port.
	const rs = opt("rs-remote", "") || process.env.RS_REMOTE || RS;
	const extra = [`--site=${opt("site-remote", "") || SITE}`, ...(rs ? [`--rs=${rs}`] : []), ...(flag("diag") ? ["--diag"] : [])];
	const child = spawn("ssh", ["-o", "BatchMode=yes", remote, "node", `${REMOTE_DIR}/test-pair.mjs`, "drive", ...extra], { stdio: ["pipe", "pipe", "pipe"] });
	const waiting = new Map();
	let seq = 0;
	let exited = false;
	createInterface({ input: child.stdout }).on("line", (l) => {
		if (!l.startsWith("@@")) return console.log(`    [${remote}] ${l}`);
		const m = JSON.parse(l.slice(2));
		waiting.get(m.id)?.(m);
		waiting.delete(m.id);
	});
	createInterface({ input: child.stderr }).on("line", (l) => console.log(`    [${remote}!] ${l}`));
	child.on("exit", (c) => {
		exited = true;
		for (const r of waiting.values()) r({ error: `ssh exited (${c})` });
		waiting.clear();
	});
	const ask = (cmd, ms = 90_000) => {
		if (exited) return Promise.resolve({ error: "ssh exited" });
		const id = ++seq;
		return new Promise((r) => {
			waiting.set(id, r);
			setTimeout(() => waiting.delete(id) && r({ error: `timeout waiting for ${cmd.c}` }), ms);
			child.stdin.write(JSON.stringify({ ...cmd, id }) + "\n");
		});
	};
	return { name: remote, ask, quit: () => ask({ c: "quit" }, 15_000) };
}

/**
 * The manual handshake (party.js/lobby.js joinFlow's scan/paste path),
 * across the two machines, through the room API on a bare page: `off`
 * mints an invite, `ans` answers it, and the reply is carried back only
 * after `delayMs` — a person scanning a QR. Must link: the answerer's
 * open watchdog must not apply to a reply a human carries.
 */
async function manualHandshake(off, ans, delayMs, check) {
	const label = `manual handshake, ${off.name} invites, ${ans.name} answers, reply after ${delayMs / 1000}s`;
	console.log(`\n${label}`);
	for (const s of [off, ans]) {
		const r = await s.ask({ c: "bare" }, 60_000);
		if (r.error) return check(`${s.name}: bare page with net.js`, false, r.error), "FAIL (setup)";
	}
	const mk = (host) => `async () => {
		const room = (window.__m = NeonArcade[${JSON.stringify(host ? "createHost" : "createGuest")}]({
			name: ${JSON.stringify(host ? "Off" : "Ans")},
			onOpen: () => (window.__mOpen ??= Date.now()),
			onError: (m, x) => (window.__mErr ??= [m, x?.reason ?? null, Date.now()]),
		}));
		room.resume();
		window.__mGot = [];
		room.makeAction("m").onMessage = (d) => window.__mGot.push(d);
		window.__mT0 = Date.now();
	}`;
	await off.ask({ c: "eval", fn: mk(true) });
	await ans.ask({ c: "eval", fn: mk(false) });
	const inv = await off.ask({ c: "eval", fn: "async () => (await window.__m.createInvite()).code" });
	if (!inv.value) return check(`${label}: invite`, false, JSON.stringify(inv)), "FAIL (invite)";
	const rep = await ans.ask({ c: "eval", fn: "async (code) => window.__m.answerInvite(code)", arg: inv.value });
	if (!rep.value) return check(`${label}: reply`, false, JSON.stringify(rep)), "FAIL (reply)";
	const tAnswered = Date.now();
	console.log(`  ·    invite ${inv.value.length} chars, reply ${rep.value.length} chars; holding the reply ${delayMs / 1000}s`);
	const peek = "async () => ({ open: window.__mOpen ?? null, err: window.__mErr ?? null, errAfter: window.__mErr ? ((window.__mErr[2] - window.__mT0) / 1000).toFixed(1) + 's' : null, peers: window.__m.directPeers().length, closed: window.__m.closed, ice: [...window.__m.pending.values(), ...window.__m.links.values()].map((l) => l.pc?.iceConnectionState) })";
	await sleep(delayMs);
	const midAns = (await ans.ask({ c: "eval", fn: peek })).value;
	console.log(`  ·    answerer before the reply lands: ${JSON.stringify(midAns)}`);
	check(`${label}: answerer still waiting, no verdict`, !midAns?.err && !midAns?.closed, JSON.stringify(midAns));
	const acc = await off.ask({ c: "eval", fn: "async (code) => { try { await window.__m.acceptAnswer(code); return 'ok'; } catch (e) { return String(e.message); } }", arg: rep.value });
	check(`${label}: acceptAnswer`, acc.value === "ok", JSON.stringify(acc));
	const t = Date.now();
	let a = null;
	let b = null;
	while (Date.now() - t < 30_000) {
		a = (await off.ask({ c: "eval", fn: peek })).value;
		b = (await ans.ask({ c: "eval", fn: peek })).value;
		if (a?.peers === 1 && b?.peers === 1) break;
		if (a?.err || b?.err) break;
		await sleep(250);
	}
	const linked = a?.peers === 1 && b?.peers === 1;
	check(`${label}: both ends linked`, linked, `offerer ${JSON.stringify(a)}, answerer ${JSON.stringify(b)}`, Date.now() - t);
	if (!linked) {
		if (flag("diag")) {
			printDiag(`offerer ${off.name}`, (await off.ask({ c: "diag" }, 15_000)).recs);
			printDiag(`answerer ${ans.name}`, (await ans.ask({ c: "diag" }, 15_000)).recs);
		}
		for (const s of [off, ans]) await s.ask({ c: "close" });
		return `FAIL (${a?.err?.[0] ?? b?.err?.[0] ?? "not linked"}${b?.errAfter ? `; answerer's verdict ${b.errAfter} after answering` : ""})`;
	}
	await off.ask({ c: "eval", fn: "async () => window.__m.makeAction('m').send({ from: 'off' })" });
	await ans.ask({ c: "eval", fn: "async () => window.__m.makeAction('m').send({ from: 'ans' })" });
	await sleep(1500);
	const ga = (await off.ask({ c: "eval", fn: "async () => window.__mGot" })).value ?? [];
	const gb = (await ans.ask({ c: "eval", fn: "async () => window.__mGot" })).value ?? [];
	check(`${label}: a message each way`, ga.some((d) => d.from === "ans") && gb.some((d) => d.from === "off"), `offerer got ${JSON.stringify(ga)}, answerer got ${JSON.stringify(gb)}`);
	const pair = (await off.ask({ c: "eval", fn: `async () => { const l = [...window.__m.links.values()][0]; const st = await l.pc.getStats(); let p = null; st.forEach((r) => r.type === "transport" && r.selectedCandidatePairId && (p = st.get(r.selectedCandidatePairId))); const c = (x) => x && x.candidateType + " " + x.address + ":" + x.port; return p && c(st.get(p.localCandidateId)) + " -> " + c(st.get(p.remoteCandidateId)); }` })).value;
	console.log(`  ·    offerer's pair: ${pair}`);
	for (const s of [off, ans]) await s.ask({ c: "eval", fn: "async () => window.__m.leave()" });
	for (const s of [off, ans]) {
		const c = await s.ask({ c: "close" });
		check(`${label}: no page errors (${s.name})`, !(c.errors ?? []).length, (c.errors ?? []).join(" | "));
	}
	return `linked ${((Date.now() - t) / 1000).toFixed(1)}s after the reply (${((Date.now() - tAnswered) / 1000).toFixed(0)}s after answering)`;
}

async function pairRole() {
	const remote = opt("remote", process.env.PAIR_REMOTE || "bhaskara");
	const runs = Number(opt("runs", 3));
	const stun4 = flag("stun4");
	const remoteHosts = flag("remote-hosts");
	let failures = 0;
	const rows = [];
	let row = null;
	const check = (label, ok, detail = "", ms = null) => {
		const t = ms === null ? "" : ` (${(ms / 1000).toFixed(1)}s)`;
		console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${t}${ok || !detail ? "" : ` — ${detail}`}`);
		if (!ok) failures++, row && (row.fails = (row.fails ?? 0) + 1);
	};

	console.log(`site: ${PARTY}   room server: ${RS || "the page's default"}   remote: ${remote}   host: ${remoteHosts ? remote : "this machine"}   runs: ${runs}${stun4 ? "   local STUN: IPv4 literal only" : ""}`);
	execFileSync("ssh", ["-o", "BatchMode=yes", remote, "mkdir", "-p", REMOTE_DIR]);
	execFileSync("scp", ["-q", "-o", "BatchMode=yes", SELF, `${remote}:${REMOTE_DIR}/test-pair.mjs`]);

	let directPossible = true;
	if (!flag("no-classify")) {
		console.log("\nNAT mapping (IPv4, node dgram STUN; same mapped ip:port from all servers = endpoint-independent)");
		const here = await classify();
		const there = JSON.parse(execFileSync("ssh", ["-o", "BatchMode=yes", remote, "node", `${REMOTE_DIR}/test-pair.mjs`, "stun"]).toString().trim().split("\n").pop());
		for (const n of [here, there]) {
			console.log(`  ·    ${n.machine}: ${n.mapping}; port preserved: ${n.portPreserved}`);
			for (const s of n.sockets) console.log(`         local :${s.localPort} -> ${s.mapped.map((m) => `${m.server}=${m.ip ? `${m.ip}:${m.port}` : "no reply"}`).join("  ")}`);
		}
		directPossible = here.mapping === "endpoint-independent" || there.mapping === "endpoint-independent";
	}
	if (!flag("no-punch")) {
		console.log("\nHole punching, no browser (this machine's mapping opened via one STUN server; who sends first):");
		for (const via of ["stun.cloudflare.com:3478", "stun.l.google.com:19302"])
			for (const order of ["remote-first", "local-first"]) {
				const r = await punchProbe(remote, via, order);
				console.log(`  ·    mapping via ${via.padEnd(25)} ${order.padEnd(13)} ${r.error ?? (r.through ? `through (remote saw ${r.remoteSaw.join(", ")}; local mapping :${r.mapped})` : "nothing got through")}`);
			}
	}

	const init = {};
	if (stun4) {
		// STUN4=host:port picks the server; Cloudflare's :3478 by default —
		// on a network whose NAT treats port 3478 specially (see the punch
		// probe) a :19302-only browser fails where the product would not.
		const [h, p] = (process.env.STUN4 || "stun.cloudflare.com:3478").split(":");
		const { address } = await dns.lookup(h, { family: 4 });
		init["neon.stun"] = `${address}:${p}`;
		console.log(`  ·    local browser STUN: ${init["neon.stun"]} only`);
	}
	const local = localSide(init);
	const far = remoteSide(remote);
	const H = remoteHosts ? far : local;
	const G = remoteHosts ? local : far;
	const dir = `${H.name.slice(0, 9)}>${G.name.slice(0, 9)}`;

	for (let run = 1; run <= runs; run++) {
		row = { run, dir, mode: stun4 ? "stun4" : "default" };
		rows.push(row);
		console.log(`\nrun ${run}/${runs}: ${H.name} hosts, ${G.name} joins`);

		const dumpDiag = async (when) => {
			if (!flag("diag")) return;
			console.log(`  ·    ICE records ${when}:`);
			printDiag(`host ${H.name}`, (await H.ask({ c: "diag" }, 15_000)).recs);
			printDiag(`guest ${G.name}`, (await G.ask({ c: "diag" }, 15_000)).recs);
		};
		/**
		 * A fresh party: H hosts, G joins by code. Used at the start of a run
		 * and again after a phase failed, so each later phase is still tested
		 * from a working party rather than skipped. ok when both are linked.
		 */
		const setup = async (label) => {
			const h = await H.ask({ c: "host" }, 60_000);
			check(`${label}: host has code ${h.code}`, /^\d{6}$/.test(h.code ?? ""), JSON.stringify(h), h.ms);
			if (!h.code) return { ok: false };
			const joined = await G.ask({ c: "join", code: h.code }, JOIN_BOUND + 30_000);
			if (!joined.ok) {
				const explicit = NO_ROUTE.test(joined.status ?? "");
				console.log(`  ·    joiner says: "${joined.status ?? joined.error}" after ${((joined.ms ?? 0) / 1000).toFixed(1)}s`);
				if (directPossible) check(`${label}: joined (a direct path may exist)`, false, joined.status ?? joined.error);
				check(`${label}: an explicit no-route verdict, not a hang`, explicit && joined.ms >= NO_ROUTE_MIN && joined.ms <= NO_ROUTE_MAX, `${joined.ms}ms: ${joined.status}`, joined.ms);
				await dumpDiag(`after the failed join (${label})`);
				return { ok: false, explicit, ms: joined.ms };
			}
			check(`${label}: guest joined by code (bound ${JOIN_BOUND / 1000}s)`, joined.ms <= JOIN_BOUND, "", joined.ms);
			const hw = await H.ask({ c: "whole", ms: 20_000 }, 40_000);
			check(`${label}: host sees the guest linked, two members`, hw.ok, hw.status, hw.ms);
			check(`${label}: one host — both name the host's id`, hw.host === hw.self && joined.host === hw.self, `host says ${hw.host}, guest says ${joined.host}, host id ${hw.self}`);
			// The glare rule (lower id's offer stands) can decide who offers
			// after a reload, so the order matters to the direction.
			console.log(`  ·    ids: host ${hw.self}, guest ${joined.self} (lower: ${hw.self < joined.self ? "host" : "guest"})`);
			row.lower = hw.self < joined.self ? "H" : "G";
			return { ok: hw.ok, ms: joined.ms };
		};
		const exchange = async (label) => {
			const mine = `h${run}-${tag8()}`;
			const theirs = `g${run}-${tag8()}`;
			await H.ask({ c: "listen" }, 10_000);
			await G.ask({ c: "listen" }, 10_000);
			const [hx, gx] = await Promise.all([H.ask({ c: "exchange", mine, theirs }, 30_000), G.ask({ c: "exchange", mine: theirs, theirs: mine }, 30_000)]);
			check(`${label}: 30 ticks each way, in order`, hx.got?.ok && gx.got?.ok && hx.got.inOrder && gx.got.inOrder, `host got ${JSON.stringify(hx.got ?? hx)}, guest got ${JSON.stringify(gx.got ?? gx)}`);
			const p = await H.ask({ c: "pings", run: `${mine}-p` }, 60_000);
			check(`${label}: 10 ping/pong round trips`, p.n === 10, `${p.n}/10`);
			return p.median;
		};
		/** Selected pairs on both ends, who offered the link, and whether it was the swapped retry. */
		const pairs = async (label) => {
			const hp = (await H.ask({ c: "stats" }, 15_000)).pairs ?? [];
			const gp = (await G.ask({ c: "stats" }, 15_000)).pairs ?? [];
			console.log(`  ·    ${label} host pair:  ${hp.map(fmtPair).join(" | ")}`);
			console.log(`  ·    ${label} guest pair: ${gp.map(fmtPair).join(" | ")}`);
			check(`${label}: both ends report a selected pair`, !!hp[0]?.local && !!gp[0]?.local);
			const who = hp[0]?.offered ? "H" : gp[0]?.offered ? "G" : "?";
			const swap = hp[0]?.retry || gp[0]?.retry ? "+swap" : "";
			return `${hp[0]?.local?.type ?? "?"}->${hp[0]?.remote?.type ?? "?"}/${gp[0]?.local?.type ?? "?"}->${gp[0]?.remote?.type ?? "?"} off=${who}${swap}`;
		};
		const ms = (x) => `${(x / 1000).toFixed(1)}s`;
		const quitRun = async () => {
			for (const s of [H, G]) {
				const c = await s.ask({ c: "close" }, 15_000);
				check(`no page errors (${s.name})`, !(c.errors ?? []).length, (c.errors ?? [c.error]).join(" | "));
			}
		};

		// 1. Join by code.
		const first = await setup("join");
		row.join = first.ok ? `ok ${ms(first.ms)}` : first.explicit ? `no-route ${ms(first.ms)}` : "FAIL";
		if (!first.ok) {
			row.outcome = "no direct path";
			await quitRun();
			continue;
		}
		row.rtt = await exchange("join");
		row.pair = await pairs("join");

		// 2. Guest reloads, twice.
		let lost = false;
		for (const k of [1, 2]) {
			await H.ask({ c: "mark" }, 10_000);
			const t = Date.now();
			const gr = await G.ask({ c: "reload" }, RECONNECT + 30_000);
			const hr1 = await H.ask({ c: "whole", fresh: true, ms: gr.ok ? RECONNECT : 3000 }, RECONNECT + 30_000);
			const lbl = `guest reload ${k}`;
			check(`${lbl}: guest back in, new link`, gr.ok, gr.status ?? gr.error, gr.ms);
			check(`${lbl}: host sees the new link`, hr1.ok, hr1.status, Date.now() - t);
			check(`${lbl}: both name the same host`, !!gr.host && gr.host === hr1.host, `guest says ${gr.host}, host says ${hr1.host}`);
			if (gr.ok && hr1.ok) {
				row[`gr${k}`] = `ok ${ms(Math.max(gr.ms, Date.now() - t))}`;
				await exchange(lbl);
				row[`gr${k}`] += ` ${(await pairs(lbl)).split(" ").pop()}`;
				await dumpDiag(`after ${lbl}`);
				continue;
			}
			row[`gr${k}`] = NO_ROUTE.test(gr.status ?? "") ? `no-route ${ms(gr.ms)}` : "FAIL";
			console.log(`  ·    guest's verdict after ${ms(gr.ms ?? 0)}: "${gr.status ?? gr.error}"`);
			await dumpDiag(`after ${lbl}`);
			// Does the page's own RETRY recover it?
			const t2 = Date.now();
			const rt = await G.ask({ c: "retry" }, RECONNECT + 30_000);
			const hr1b = rt.ok ? await H.ask({ c: "whole", ms: 20_000 }, 40_000) : { ok: false };
			console.log(`  ·    guest RETRY: ${!rt.offered ? `no RETRY button (status "${rt.status}")` : rt.ok && hr1b.ok ? `reconnected in ${ms(Date.now() - t2)}` : `failed after ${ms(rt.ms)}: "${rt.status}"`}`);
			row.retry = !rt.offered ? "no button" : rt.ok && hr1b.ok ? `ok ${ms(Date.now() - t2)}` : "FAIL";
			if (rt.ok && hr1b.ok) continue; // RETRY healed it: carry on in the same party.
			if (!(await setup(`re-formed after ${lbl}`)).ok) {
				lost = true;
				break;
			}
		}
		if (lost) {
			row.outcome = "could not re-form";
			await quitRun();
			continue;
		}

		// 3. Host reloads.
		await G.ask({ c: "mark" }, 10_000);
		let t = Date.now();
		const waited = G.ask({ c: "whole", fresh: true, ms: RECONNECT }, RECONNECT + 30_000);
		const hr2 = await H.ask({ c: "reload" }, RECONNECT + 30_000);
		const gw = await waited;
		check("host reload: host back in", hr2.ok, hr2.status ?? hr2.error, Date.now() - t);
		check("host reload: guest sees a new link", gw.ok, gw.status, gw.ms);
		// The crown may pass to the guest while the host is away (succession);
		// what must hold is that both ends agree on exactly one.
		check("host reload: both name the same host", !!gw.host && gw.host === hr2.host, `guest says ${gw.host}, host says ${hr2.host}`);
		if (hr2.ok && gw.ok) {
			row.crown = hr2.host === hr2.self ? "kept" : "moved";
			row.hostReload = `ok ${ms(Math.max(Date.now() - t, gw.ms))}`;
			await exchange("host reload");
			row.hostReload += ` ${(await pairs("host reload")).split(" ").pop()}`;
		} else {
			row.hostReload = NO_ROUTE.test(gw.status ?? hr2.status ?? "") ? `no-route ${ms(gw.ms)}` : "FAIL";
			console.log(`  ·    after host reload: host says "${hr2.status}", guest says "${gw.status}"`);
			await dumpDiag("after host reload");
			if (!(await setup("re-formed after host reload")).ok) {
				row.outcome = "could not re-form";
				await quitRun();
				continue;
			}
		}

		// 4. Guest leaves (ALL GAMES, confirmed); the host sees it at once.
		t = Date.now();
		const left = G.ask({ c: "leave" }, 30_000);
		const gone = await H.ask({ c: "alone", ms: 20_000 }, 40_000);
		const lv = await left;
		check("guest leave: guest navigated away, token dropped", /index\.html/.test(lv.url ?? "") && lv.token === null, JSON.stringify(lv), lv.ms);
		check(`guest leave: host down to one member within ${LEAVE_SEEN / 1000}s`, gone.ok && gone.ms <= LEAVE_SEEN, JSON.stringify(gone.members), gone.ms);
		row.leave = gone.ok && gone.ms <= LEAVE_SEEN ? `ok ${ms(gone.ms)}` : "FAIL";
		await quitRun();
		row.outcome = row.fails ? `${row.fails} failed` : "all passed";
	}

	if (runs) {
		console.log("\nrun dir                  join        rtt    lower pair at join (host l->r / guest l->r, offerer)  guest reload 1        guest reload 2        RETRY      host reload (crown)              leave    outcome");
		for (const r of rows) {
			const c = (v, w) => String(v ?? "-").padEnd(w);
			console.log(`${c(r.run, 4)}${c(r.dir, 21)}${c(r.join, 12)}${c(r.rtt != null ? r.rtt + "ms" : null, 7)}${c(r.lower, 6)}${c(r.pair, 48)}${c(r.gr1, 22)}${c(r.gr2, 22)}${c(r.retry, 11)}${c(r.hostReload && r.crown ? `${r.hostReload} (${r.crown})` : r.hostReload, 33)}${c(r.leave, 9)}${r.outcome ?? "?"}`);
		}
		console.log("  (off=H/G: who offered the link in use; +swap: it is the role-swapped retry)");
	}

	const manual = opt("manual", "");
	if (manual) {
		// --manual=<seconds>[,local|remote]: who mints the invite (default: this machine).
		const [secs, who] = manual.split(",");
		const [off, ans] = who === "remote" ? [far, local] : [local, far];
		const res = await manualHandshake(off, ans, Number(secs || 25) * 1000, check);
		console.log(`  ·    manual handshake: ${res}`);
	}

	await far.quit();
	console.log(`\n${failures ? `${failures} FAILED` : "all passed"}`);
	return failures;
}

// ------------------------------------------------------------ main

let code = 0;
try {
	if (role === "stun") console.log(JSON.stringify(await classify()));
	else if (role === "punch") await punchRemote();
	else if (role === "drive") await driveRole();
	else code = (await pairRole()) ? 1 : 0;
} catch (e) {
	console.error(e);
	code = 1;
} finally {
	await browser?.close().catch(() => {});
	if (role === "pair") {
		// Whatever happened, leave nothing running on the remote.
		const remote = opt("remote", process.env.PAIR_REMOTE || "bhaskara");
		try {
			execFileSync("ssh", ["-o", "BatchMode=yes", remote, "pkill", "-f", `${REMOTE_DIR}/test-pair.mjs`], { stdio: "ignore" });
		} catch {}
	}
}
process.exit(code);
