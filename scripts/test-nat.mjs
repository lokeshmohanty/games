#!/usr/bin/env node
/**
 * test-nat.mjs — multiplayer across real (simulated) networks.
 *
 *   just test-nat                         # or: scripts/test-nat.sh
 *   scripts/test-nat.sh --only=3,5        # a subset of scenarios
 *
 * Every other suite runs its peers on one machine's loopback, where every
 * candidate pair connects and no NAT is in the way. That is exactly the
 * setting in which the failures this project promises to *name* — symmetric
 * NAT, a dead room server, a phone that changes network — cannot happen. This
 * suite builds the networks instead, out of Linux network namespaces:
 *
 *   "internet" namespace (this process)
 *     198.51.100.1  — STUN binding server (udp 3478, below), the repo over
 *                     http (8000), and the real room server (`wrangler dev`,
 *                     8787) — the same worker/ code that deploys
 *     br0           — the public segment every NAT router's WAN sits on
 *   per site: a router namespace (198.51.100.1x on WAN, 10.x.0.1 on LAN,
 *             nftables NAT, optional netem) and a client namespace behind
 *             it (10.x.0.2) running its own headless Chrome
 *
 * NAT behaviours, all stock nftables:
 *   cone       masquerade — endpoint-independent mapping, address-and-port-
 *              dependent filtering ("port-restricted cone"): the common home
 *              router. Two of these connect by hole punching.
 *   fullcone   the same plus a DNAT of every inbound UDP port back to the
 *              client — endpoint-independent filtering. Rare, but it is the
 *              one cone a symmetric NAT can still reach.
 *   symmetric  masquerade fully-random — a fresh port per destination, so
 *              the address STUN saw is not the one a peer would have to use.
 *              Many mobile carriers. With no TURN, two of these, or one and
 *              a port-restricted cone, cannot connect at all; the code must
 *              say so, not wait.
 *   portdep    the owner's mobile carrier CGNAT, as measured 2026-11-12
 *              (docs/network-testing.md, "Two machines"): the mapping toward
 *              STUN's port 3478 keeps the client's port and takes packets
 *              from anybody (a DNAT, as fullcone), every other UDP flow gets
 *              a fresh random port. So a peer's checks reach the client only
 *              through the STUN mapping, and only if they arrive *before*
 *              the client has sent to that peer: once it has, the carrier
 *              drops them (a set of endpoints the client opened its own
 *              flow to — Linux alone would let them through, resolving the
 *              conntrack clash, which the carrier does not). Against a cone
 *              NAT it connects when this side offers and never when it
 *              answers — the answerer checks first.
 *
 * It must run as root of a user namespace that owns all of this, so it is
 * launched by scripts/test-nat.sh (`nix shell … -c unshare -rn node …`);
 * nothing touches the host's real network and no privilege is needed. Each
 * Chrome is started inside its client namespace through an `nsenter`
 * wrapper, so Playwright still drives all of them over its ordinary pipe.
 *
 * STUN here is a 40-line responder, not a TURN server, and never becomes
 * one: the project has no TURN by choice (see lib/net.js's DEFAULT_ICE).
 */
import { createRequire } from "node:module";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect, createServer as createTcpServer } from "node:net";
import {
	chmodSync,
	existsSync,
	globSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = "198.51.100.1"; // TEST-NET-2: never a real address
const HTTP_PORT = 8000;
const RS_PORT = 8787;
const STUN_PORT = 3478;
// A second STUN port on the same responder, as DEFAULT_ICE has two servers on
// two ports: net.js classifyNat compares the mappings the two see, and only
// the portdep router maps them differently ("hard").
const STUN_PORT_2 = 3479;
// The lab's own STUN and room servers go in through storage (net.js
// iceDefault, room-join.js resolveBase): the app takes neither from the URL
// — `?rs=` only for a loopback server — on purpose.
const BASE = `http://${PUBLIC}:${HTTP_PORT}/party.html`;
// joinRoom's own deadline (room-join.js JOIN_ANSWER_MS) plus slack: every
// "must fail explicitly" check allows this long and no longer.
const FAIL_BOUND_MS = 35_000;

const args = process.argv.slice(2);
// Live mode (`just test-nat-live <url>`, 2026-11-11): RS_URL names a deployed
// room server, test-nat.sh attaches slirp4netns to this namespace, and the
// lab's routers sit in front of the *real* internet — real Cloudflare, the
// real public STUN servers (net.js DEFAULT_ICE; no neon.stun), and the
// host's own NAT behind every lab NAT. HOST_CDP, when set, is a Chrome on
// the host's normal network (reached over slirp's host-loopback alias).
const LIVE = process.env.RS_URL ? process.env.RS_URL.replace(/\/+$/, "") : null;
const HOST_CDP = process.env.HOST_CDP || null;
const only = (args.find((a) => a.startsWith("--only=")) ?? "").slice(7);
// Live, only what one public address can show. Real STUN reports the
// *host's* public address for every lab client, so two lab clients can only
// meet by hairpinning through the host's real NAT — which a carrier CGNAT
// does not do (2026-11-11: 1 and 5 fail with no-route for exactly that
// reason). 3 (symmetric: explicit error) and 9 (a peer on the host's own
// network) are meaningful; 7 blocks the local room server's port.
const ONLY = only ? new Set(only.split(",").map(Number)) : LIVE ? new Set([3, 9]) : null;
const VERBOSE = args.includes("--verbose");

// Root, but not the host's root: a user namespace maps uid 0 to one real uid.
if (process.getuid() !== 0 || /^\s*0\s+0\s+4294967295/.test(readFileSync("/proc/self/uid_map", "utf8"))) {
	console.error("error: run through scripts/test-nat.sh — this needs its own user+network namespace");
	process.exit(2);
}

// ------------------------------------------------------------- utilities

let failures = 0;
const results = []; // [scenario, check, ok, ms]
let scenarioName = "";
const check = (label, ok, detail = "", ms = null) => {
	const t = ms === null ? "" : ` (${(ms / 1000).toFixed(1)}s)`;
	console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${t}${ok || !detail ? "" : ` — ${detail}`}`);
	results.push([scenarioName, label, ok, ms]);
	if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Which binary on PATH — the nix-shell one, since the system `ip` is broken. */
function bin(name) {
	const found = execFileSync("sh", ["-c", `command -v ${name}`]).toString().trim();
	if (!found) throw new Error(`${name} not on PATH; run through scripts/test-nat.sh`);
	return found;
}
const IP = bin("ip");
const NFT = bin("nft");
const TC = bin("tc");
const CONNTRACK = bin("conntrack");
const NSENTER = bin("nsenter");

const sh = (cmd, cmdArgs, input) =>
	execFileSync(cmd, cmdArgs, { input, stdio: ["pipe", "pipe", "pipe"] }).toString();

// ------------------------------------------------------------- the network

const children = new Set();
const SELF_NET = readlinkSync("/proc/self/ns/net");

/** A fresh network namespace, held open by a sleeping child. */
async function netns() {
	const proc = spawn("unshare", ["-n", "sleep", "infinity"], { stdio: "ignore" });
	children.add(proc);
	const path = `/proc/${proc.pid}/ns/net`;
	for (let i = 0; i < 100; i++) {
		try {
			if (readlinkSync(path) !== SELF_NET) return { pid: proc.pid, path, proc };
		} catch {}
		await sleep(20);
	}
	throw new Error("network namespace did not come up");
}
const inNs = (ns, cmd, cmdArgs, input) => sh(NSENTER, [`--net=${ns.path}`, "--", cmd, ...cmdArgs], input);

function setupInternet() {
	sh(IP, ["link", "set", "lo", "up"]);
	sh(IP, ["link", "add", "br0", "type", "bridge"]);
	sh(IP, ["addr", "add", `${PUBLIC}/24`, "dev", "br0"]);
	sh(IP, ["link", "set", "br0", "up"]);
}

/**
 * Live mode: wait for slirp4netns's tap0 (test-nat.sh attaches it from
 * outside), then forward and masquerade the lab's public segment out of it.
 * The real internet then sees every lab client as the host — behind the
 * lab NAT, this masquerade, slirp's own NAT and the host's real router.
 */
async function connectInternet() {
	for (let i = 0; i < 100; i++) {
		if (/inet 10\.0\.2\.100/.test(sh(IP, ["-4", "addr", "show"]))) break;
		await sleep(100);
	}
	if (!/inet 10\.0\.2\.100/.test(sh(IP, ["-4", "addr", "show"]))) throw new Error("slirp4netns did not attach (no tap0 10.0.2.100)");
	// slirp's IPv6 (fd00::100) needs its duplicate-address check to finish.
	for (let i = 0; i < 50 && !/inet6 fd00::[0-9a-f:]+\/64 scope global(?! tentative)/.test(sh(IP, ["-6", "addr", "show", "tap0"])); i++) await sleep(100);
	sh("sh", ["-c", "echo 1 > /proc/sys/net/ipv4/ip_forward"]);
	sh(NFT, ["-f", "-"], `table ip livenat {\nchain post {\n type nat hook postrouting priority 100;\n oifname "tap0" masquerade\n}\n}\n`);
	// The signalling path only: the room server's hostname is pinned (Chrome
	// --host-resolver-rules) to a TCP forwarder here, which dials it over
	// IPv6. Found 2026-11-11 on a temporary-account deployment: Cloudflare
	// answered this host's *IPv4* address (a shared ISP address) with a
	// managed challenge (403, cf-mitigated: challenge) — which a WebSocket
	// cannot solve — and its IPv6 address normally. WebRTC (UDP, STUN) still
	// leaves through the lab NATs over IPv4; only TLS to the worker is moved.
	const host = new URL(LIVE).hostname;
	const fwd = createTcpServer((client) => {
		const up = connect({ host, port: 443, family: 6 });
		client.pipe(up).pipe(client);
		const end = () => (client.destroy(), up.destroy());
		up.on("error", (e) => (console.log(`    [forwarder] ${e.message}`), end()));
		client.on("error", end);
	});
	await new Promise((r) => fwd.listen(443, PUBLIC, r));
	liveForwarder = fwd;
}
let liveForwarder = null;

let siteCount = 0;
/**
 * One home network: a NAT router and a client behind it. `nat` is "cone",
 * "fullcone" or "symmetric" (see the header); `blockRs` drops the room
 * server's port at this router, which is what a filtering network does.
 */
async function makeSite(nat, { blockRs = false } = {}) {
	const n = ++siteCount;
	const router = await netns();
	const client = await netns();
	// IPv4 only. IPv6 would bring each veth a link-local address a second or
	// two after it comes up, and Chrome's network-change watcher treats that
	// as the network changing — aborting whatever was loading with
	// ERR_NETWORK_CHANGED, which a slow (netem) page load is still doing.
	for (const ns of [router, client]) {
		inNs(ns, "sh", ["-c", "echo 1 > /proc/sys/net/ipv6/conf/all/disable_ipv6; echo 1 > /proc/sys/net/ipv6/conf/default/disable_ipv6"]);
	}
	const wan = `${PUBLIC.split(".").slice(0, 3).join(".")}.${10 + n}`;
	const lanNet = `10.${n}.0`;
	sh(IP, ["link", "add", `w${n}`, "type", "veth", "peer", "name", `wan${n}`]);
	sh(IP, ["link", "set", `w${n}`, "master", "br0", "up"]);
	sh(IP, ["link", "set", `wan${n}`, "netns", String(router.pid)]);
	sh(IP, ["link", "add", `lan${n}`, "type", "veth", "peer", "name", `eth${n}`]);
	sh(IP, ["link", "set", `lan${n}`, "netns", String(router.pid)]);
	sh(IP, ["link", "set", `eth${n}`, "netns", String(client.pid)]);
	const r = (...a) => inNs(router, IP, a);
	r("link", "set", "lo", "up");
	r("link", "set", `wan${n}`, "name", "wan");
	r("link", "set", `lan${n}`, "name", "lan");
	r("addr", "add", `${wan}/24`, "dev", "wan");
	r("addr", "add", `${lanNet}.1/24`, "dev", "lan");
	r("link", "set", "wan", "up");
	r("link", "set", "lan", "up");
	inNs(router, "sh", ["-c", "echo 1 > /proc/sys/net/ipv4/ip_forward"]);
	const c = (...a) => inNs(client, IP, a);
	c("link", "set", "lo", "up");
	c("link", "set", `eth${n}`, "name", "eth0");
	c("addr", "add", `${lanNet}.2/24`, "dev", "eth0");
	c("link", "set", "eth0", "up");
	c("route", "add", "default", "via", `${lanNet}.1`);
	// Live: the router's way out is the "internet" namespace, which NATs
	// once more onto slirp4netns and so onto the host's real network.
	if (LIVE) r("route", "add", "default", "via", PUBLIC);
	const masq =
		nat === "symmetric"
			? "masquerade fully-random"
			: nat === "portdep"
				? `udp dport ${STUN_PORT} masquerade\n oifname "wan" meta l4proto udp masquerade fully-random\n oifname "wan" masquerade`
				: "masquerade";
	const pre =
		nat === "fullcone" || nat === "portdep"
			? `chain pre {\n type nat hook prerouting priority -100;\n iifname "wan" udp dport 1024-65535 dnat to ${lanNet}.2\n}`
			: "";
	// portdep: an endpoint the client has opened its own (fresh-port) flow
	// to may not then open one into the STUN mapping (see the header).
	const talked =
		nat === "portdep"
			? `table ip carrier {\nset talked {\n type ipv4_addr . inet_service;\n flags dynamic,timeout;\n timeout 60s;\n}\n` +
				`chain portdep {\n type filter hook forward priority 0;\n` +
				` oifname "wan" udp dport != ${STUN_PORT} ct state new update @talked { ip daddr . udp dport }\n` +
				` iifname "wan" ct state new ip saddr . udp sport @talked drop\n}\n}\n`
			: "";
	const block = blockRs
		? `table inet filter {\nchain rsblock {\n type filter hook forward priority 0;\n ip daddr ${PUBLIC} tcp dport ${RS_PORT} drop\n}\n}`
		: "";
	inNs(
		router,
		NFT,
		["-f", "-"],
		`table ip nat {\nchain post {\n type nat hook postrouting priority 100;\n oifname "wan" ${masq}\n}\n${pre}\n}\n` +
			// What every home router's firewall does with an unsolicited packet
			// for the router itself. Without it the packet is *accepted* into
			// conntrack (then refused by the stack), and that confirmed entry
			// squats on the very port the outbound hole punch needs — the NAT
			// then picks another port and a cone behaves like a symmetric NAT.
			`table ip filter {\nchain in {\n type filter hook input priority 0;\n iifname "wan" ct state new drop\n}\n}\n${block}\n${talked}`,
	);
	return { n, nat, router, client, wan, lan: `${lanNet}.2` };
}

/** Add latency and loss on a site's WAN, both directions' worth on egress. */
function netem(site, spec) {
	inNs(site.router, TC, ["qdisc", "replace", "dev", "wan", "root", "netem", ...spec.split(" ")]);
}

/**
 * The network under a client changes: its router's public address moves and
 * every NAT mapping is forgotten — what a phone walking from wifi onto
 * cellular, or a router re-dialling its uplink, looks like from outside.
 */
function switchNetwork(site) {
	const next = `${PUBLIC.split(".").slice(0, 3).join(".")}.${110 + site.n}`;
	inNs(site.router, IP, ["addr", "del", `${site.wan}/24`, "dev", "wan"]);
	inNs(site.router, IP, ["addr", "add", `${next}/24`, "dev", "wan"]);
	try {
		inNs(site.router, CONNTRACK, ["-F"]);
	} catch {} // an empty table answers non-zero on some versions
	site.wan = next;
	// Deleting the old address took the default route with it.
	if (LIVE) inNs(site.router, IP, ["route", "replace", "default", "via", PUBLIC]);
}

// ------------------------------------------------------------- the servers

/**
 * A STUN binding responder (RFC 5389): enough for a browser to learn its
 * server-reflexive address, which is all STUN ever does here.
 */
function startStun(port = STUN_PORT) {
	const sock = createSocket("udp4");
	sock.on("message", (msg, rinfo) => {
		if (msg.length < 20 || msg.readUInt16BE(0) !== 0x0001 || msg.readUInt32BE(4) !== 0x2112a442) return;
		const txn = msg.subarray(8, 20);
		const attr = Buffer.alloc(12);
		attr.writeUInt16BE(0x0020, 0); // XOR-MAPPED-ADDRESS
		attr.writeUInt16BE(8, 2);
		attr.writeUInt8(0, 4);
		attr.writeUInt8(1, 5); // IPv4
		attr.writeUInt16BE(rinfo.port ^ 0x2112, 6);
		const ip = rinfo.address.split(".").map(Number);
		const cookie = [0x21, 0x12, 0xa4, 0x42];
		for (let i = 0; i < 4; i++) attr.writeUInt8(ip[i] ^ cookie[i], 8 + i);
		const head = Buffer.alloc(20);
		head.writeUInt16BE(0x0101, 0); // Binding Success Response
		head.writeUInt16BE(attr.length, 2);
		head.writeUInt32BE(0x2112a442, 4);
		txn.copy(head, 8);
		sock.send(Buffer.concat([head, attr]), rinfo.port, rinfo.address);
	});
	return new Promise((r) => sock.bind(port, "0.0.0.0", () => r(sock)));
}

const TYPES = {
	".html": "text/html",
	".js": "text/javascript",
	".mjs": "text/javascript",
	".css": "text/css",
	".json": "application/json",
	".webmanifest": "application/manifest+json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".gif": "image/gif",
};
function startHttp() {
	const server = createServer((req, res) => {
		const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname));
		const file = join(ROOT, path === "/" ? "index.html" : path);
		if (!file.startsWith(ROOT) || !existsSync(file) || !statSync(file).isFile()) {
			res.writeHead(404).end();
			return;
		}
		res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
		res.end(readFileSync(file));
	});
	return new Promise((r) => server.listen(HTTP_PORT, "0.0.0.0", () => r(server)));
}

const persist = mkdtempSync(join(tmpdir(), "neon-nat-rs-"));
async function startRoomServer() {
	const proc = spawn(
		"wrangler",
		// A fresh member-pass key per run, as production has one
		// (worker/README.md): members' re-dials ride their passes.
		["dev", "--ip", "0.0.0.0", "--port", String(RS_PORT), "--persist-to", persist, "--var", `ROOM_PASS_KEY:${randomBytes(32).toString("base64url")}`],
		{
			cwd: join(ROOT, "worker"),
			env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1", NO_COLOR: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	children.add(proc);
	let log = "";
	proc.stdout.on("data", (d) => (log += d));
	proc.stderr.on("data", (d) => (log += d));
	const start = Date.now();
	while (Date.now() - start < 90_000) {
		const up = await new Promise((r) => {
			const s = connect(RS_PORT, "127.0.0.1", () => (s.destroy(), r(true)));
			s.on("error", () => r(false));
		});
		if (up) return proc;
		if (proc.exitCode !== null) break;
		await sleep(500);
	}
	console.error(log);
	throw new Error("wrangler dev did not start");
}

// ------------------------------------------------------------- browsers

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
	const found = [
		join(ROOT, "node_modules", "playwright"),
		join(homedir(), ".cache", "game-previews", "node_modules", "playwright"),
		...globSync(join(homedir(), ".npm", "_npx", "*", "node_modules", "playwright")),
	].find((p) => existsSync(p));
	// No network in here to install it from: test-room.mjs installs it on
	// first run, and this suite reuses that copy.
	if (!found) throw new Error("playwright not found — run `just test-room` once first");
	return require(found);
}

const { chromium } = loadPlaywright();
const wrappers = mkdtempSync(join(tmpdir(), "neon-nat-chrome-"));
const CHROME = chromePath();

/**
 * One device: a whole browser (its own localStorage, like a separate phone)
 * running inside `site`'s client namespace.
 */
async function device(site, tag) {
	const wrapper = join(wrappers, `chrome-${site.n}`);
	writeFileSync(wrapper, `#!/bin/sh\nexec ${NSENTER} --net=${site.client.path} -- ${CHROME} "$@"\n`);
	chmodSync(wrapper, 0o755);
	const browser = await chromium.launch({
		executablePath: wrapper,
		args: [
			// Root inside a user namespace: Chrome's own sandbox cannot nest.
			"--no-sandbox",
			// crypto.subtle (lib/secrets.js) needs a secure context, and this
			// origin is plain http on a non-loopback address.
			`--unsafely-treat-insecure-origin-as-secure=http://${PUBLIC}:${HTTP_PORT}`,
			...(LIVE ? [`--host-resolver-rules=MAP ${new URL(LIVE).hostname} ${PUBLIC}`] : []),
		],
	});
	// A cached service worker would serve pages from before an edit.
	const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 390, height: 844 } });
	await context.addInitScript(
		([stun, rs]) => {
			try {
				if (stun) localStorage.setItem("neon.stun", stun);
				localStorage.setItem("neon.rs", rs);
			} catch {}
		},
		// Live: the deployed room server, and no STUN override at all.
		LIVE ? [null, LIVE] : [`${PUBLIC}:${STUN_PORT},${PUBLIC}:${STUN_PORT_2}`, `http://${PUBLIC}:${RS_PORT}`],
	);
	const page = await context.newPage();
	page.on("dialog", (d) => d.accept());
	page.on("pageerror", (err) => {
		console.log(`  FAIL page error on ${tag}: ${err.message}`);
		failures++;
	});
	page.on("requestfailed", (req) => {
		console.log(`    [${tag}] request failed: ${req.url()} ${req.failure()?.errorText ?? ""}`);
	});
	page.on("console", (m) => {
		if (VERBOSE || /\[neon\]/.test(m.text())) console.log(`    [${tag}] ${m.text()}`);
	});
	return { browser, page, tag, site };
}

/**
 * Live mode: a device on the host's *normal* network — a Chrome test-nat.sh
 * started outside every namespace, driven over CDP through slirp's alias
 * for the host's loopback. It loads the repo from file://, as test-live does.
 */
async function hostDevice(tag) {
	const browser = await chromium.connectOverCDP(HOST_CDP);
	const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
	await context.addInitScript((rs) => {
		try {
			localStorage.setItem("neon.rs", rs);
		} catch {}
	}, LIVE);
	const page = await context.newPage();
	page.on("dialog", (d) => d.accept());
	page.on("pageerror", (err) => {
		console.log(`  FAIL page error on ${tag}: ${err.message}`);
		failures++;
	});
	// Closing a CDP-connected browser only disconnects; the context goes.
	return { browser: { close: () => context.close() }, page, tag, site: null, base: `file://${join(ROOT, "party.html")}` };
}

/** Everything a check needs to know about one page's party, in one read. */
const state = (dev) =>
	dev.page.evaluate(() => {
		const r = window.__party?.room;
		const st = document.querySelector(".lobby-status");
		return {
			status: st?.textContent ?? "",
			error: !!st?.classList.contains("is-error"),
			sub: document.querySelector(".lobby-sub")?.textContent ?? "",
			code: document.querySelector(".party-code-digits")?.textContent ?? null,
			room: r
				? {
						id: r.selfId,
						host: r.hostId(),
						term: r.party.term,
						peers: r.directPeers(),
						members: r.getMembers().map((m) => ({ id: m.id, rc: !!m.reconnecting })),
						closed: r.closed,
						nat: r.natHard,
					}
				: null,
		};
	});

/** Poll `pred(state)` until it holds; returns { ok, ms, s } either way. */
async function waitFor(dev, pred, limit) {
	const start = Date.now();
	let s;
	while (Date.now() - start < limit) {
		s = await state(dev).catch(() => null);
		if (s && pred(s)) return { ok: true, ms: Date.now() - start, s };
		await sleep(250);
	}
	return { ok: false, ms: Date.now() - start, s };
}

/** In the party: a direct link open and a host known. */
const inParty = (s) => !!s.room && !s.room.closed && s.room.host !== null && s.room.peers.length > 0;
/**
 * Converged: every page names the same host, nobody is RECONNECTING, and —
 * with `links` — every page holds a direct link to every other (a party
 * whose roster looks whole but whose links are all down is the failure
 * scenario 5 exists to catch).
 */
async function converged(devs, limit, { links = false, trace = VERBOSE } = {}) {
	const start = Date.now();
	let last = [];
	let shown = "";
	while (Date.now() - start < limit) {
		last = await Promise.all(devs.map((d) => state(d).catch(() => null)));
		const line = last.map((s, i) => `${devs[i].tag}: ${brief(s)}`).join(" | ");
		if (trace && line !== shown) console.log(`    +${((Date.now() - start) / 1000).toFixed(1)}s ${(shown = line)}`);
		const hosts = new Set(last.map((s) => s?.room?.host));
		const ok =
			last.every((s) => s?.room && !s.room.closed) &&
			hosts.size === 1 &&
			!hosts.has(null) &&
			last.every((s) => s.room.members.length === devs.length && s.room.members.every((m) => !m.rc)) &&
			(!links || last.every((s) => s.room.peers.length === devs.length - 1));
		if (ok) return { ok: true, ms: Date.now() - start, last };
		await sleep(250);
	}
	return { ok: false, ms: Date.now() - start, last };
}
const brief = (s) =>
	s?.room
		? `host=${s.room.host?.slice(0, 4)} term=${s.room.term} peers=${s.room.peers.length} ` +
			`members=${s.room.members.map((m) => m.id.slice(0, 4) + (m.rc ? "(rc)" : "")).join(",")} ` +
			`status="${s.status}"`
		: `no room; status="${s?.status}" sub="${s?.sub}"`;

/** Game-level traffic: every page sends a token, every other page must get it. */
async function exchange(devs, limit = 10_000) {
	for (const d of devs) {
		await d.page.evaluate(() => {
			const r = window.__party.room;
			window.__got ??= [];
			if (window.__gotRoom !== r) {
				window.__gotRoom = r;
				r.makeAction("nat-test").onMessage = (data) => window.__got.push(data);
			}
		});
	}
	const tokens = devs.map((d) => `${d.tag}-${Math.random().toString(36).slice(2, 8)}`);
	await Promise.all(devs.map((d, i) => d.page.evaluate((t) => window.__party.room.makeAction("nat-test").send(t), tokens[i])));
	const start = Date.now();
	while (Date.now() - start < limit) {
		const got = await Promise.all(devs.map((d) => d.page.evaluate(() => window.__got)));
		if (devs.every((_, i) => tokens.every((t, j) => i === j || got[i].includes(t)))) return { ok: true, ms: Date.now() - start };
		await sleep(100);
	}
	return { ok: false, ms: Date.now() - start };
}

// ------------------------------------------------------------- party flows

/** Host a party through the room server; returns its code. */
async function hostByCode(dev) {
	const start = Date.now();
	await dev.page.goto((dev.base ?? BASE) + "?fresh=1");
	const w = await waitFor(dev, (s) => /^\d{6}$/.test(s.code ?? ""), 20_000);
	return { code: w.s?.code, ms: Date.now() - start, ok: w.ok };
}

async function joinByCode(dev, code, limit = FAIL_BOUND_MS) {
	const start = Date.now();
	await dev.page.goto(`${dev.base ?? BASE}#c=${code}`);
	const w = await waitFor(dev, (s) => inParty(s) || s.error, limit);
	return { ...w, ms: Date.now() - start, joined: !!w.s && inParty(w.s) };
}

/** The classic flow, through the real UI: invite out, reply back, CONNECT. */
async function joinClassic(host, guest, limit = FAIL_BOUND_MS) {
	const start = Date.now();
	await host.page.locator("button", { hasText: "ADD PLAYER" }).first().click();
	const inviteBox = host.page.locator("textarea.share-code").first();
	await inviteBox.waitFor({ timeout: 15_000 });
	const link = await inviteBox.inputValue();
	await guest.page.goto(link);
	const replyBox = guest.page.locator("textarea.share-code").first();
	await replyBox.waitFor({ timeout: 15_000 });
	const reply = await replyBox.inputValue();
	await host.page.locator("textarea.share-code").last().fill(reply);
	await host.page.locator("button.neon-btn", { hasText: /^CONNECT$/ }).first().click();
	// The guest is the one with nothing else to look at: it either gets in
	// or is told why not.
	const w = await waitFor(guest, (s) => inParty(s) || s.error, limit);
	const h = await state(host);
	return { ...w, ms: Date.now() - start, joined: !!w.s && inParty(w.s), host: h };
}

async function closeAll(devs) {
	await Promise.all(devs.map((d) => d.browser.close().catch(() => {})));
}
function dropSites(sites) {
	for (const s of sites) {
		for (const ns of [s.router, s.client]) {
			ns.proc.kill();
			children.delete(ns.proc);
		}
	}
}

// ------------------------------------------------------------- scenarios

const scenarios = [];
const scenario = (n, name, fn) => scenarios.push({ n, name, fn });

scenario(1, "two port-restricted cone NATs, join by code, reloads", async () => {
	const sites = [await makeSite("cone"), await makeSite("cone")];
	const [h, g] = [await device(sites[0], "host"), await device(sites[1], "guest")];
	try {
		const made = await hostByCode(h);
		check("host gets a party code", made.ok, `status: ${(await state(h)).status}`, made.ms);
		const j = await joinByCode(g, made.code);
		check("guest joins by code across two NATs", j.joined, brief(j.s), j.ms);
		const c = await converged([h, g], 15_000);
		check("both agree on the party", c.ok, c.last.map(brief).join(" | "), c.ms);
		const nat = await Promise.all([h, g].map(state));
		check("a cone NAT classifies as not hard", nat.every((s) => s.room?.nat === false), JSON.stringify(nat.map((s) => s.room?.nat)));
		const x = await exchange([h, g]);
		check("game messages flow both ways", x.ok, "", x.ms);

		let start = Date.now();
		await h.page.reload();
		const hr = await waitFor(h, inParty, 45_000);
		check("host reload reconnects", hr.ok, brief(hr.s), Date.now() - start);
		const c2 = await converged([h, g], 20_000);
		check("party converges after host reload (one host, no RECONNECTING)", c2.ok, c2.last.map(brief).join(" | "), Date.now() - start);
		const x2 = await exchange([h, g]);
		check("messages flow after host reload", x2.ok, "", x2.ms);

		start = Date.now();
		await g.page.reload();
		const gr = await waitFor(g, inParty, 45_000);
		check("guest reload reconnects", gr.ok, brief(gr.s), Date.now() - start);
		const c3 = await converged([h, g], 20_000);
		check("party converges after guest reload", c3.ok, c3.last.map(brief).join(" | "), Date.now() - start);
		const x3 = await exchange([h, g]);
		check("messages flow after guest reload", x3.ok, "", x3.ms);
	} finally {
		await closeAll([h, g]);
		dropSites(sites);
	}
});

scenario(2, "two cone NATs, classic invite/reply", async () => {
	const sites = [await makeSite("cone"), await makeSite("cone")];
	const [h, g] = [await device(sites[0], "host"), await device(sites[1], "guest")];
	try {
		await hostByCode(h);
		const j = await joinClassic(h, g);
		check("guest joins by invite/reply across two NATs", j.joined, brief(j.s), j.ms);
		const c = await converged([h, g], 15_000);
		check("both agree on the party", c.ok, c.last.map(brief).join(" | "), c.ms);
		const x = await exchange([h, g]);
		check("game messages flow both ways", x.ok, "", x.ms);
	} finally {
		await closeAll([h, g]);
		dropSites(sites);
	}
});

scenario(3, "both behind symmetric NAT: explicit failure", async () => {
	const sites = [await makeSite("symmetric"), await makeSite("symmetric")];
	const [h, g] = [await device(sites[0], "host"), await device(sites[1], "guest")];
	try {
		const made = await hostByCode(h);
		const j = await joinByCode(g, made.code, FAIL_BOUND_MS + 10_000);
		check("code join does not connect", !j.joined, brief(j.s));
		check("code join fails with an explicit error within the bound", !!j.s?.error && j.ms <= FAIL_BOUND_MS, brief(j.s), j.ms);
		// Specific: ICE's own verdict, not "nobody answered", which would
		// blame a party that did answer. Since the role swap (2026-11-12)
		// the second try outlasts joinRoom's 30 s deadline, which then
		// reports no-route with the first try's message (~30.3 s).
		check(
			"the error names the network, not a silent or vanished party",
			/direct connection/i.test(j.s?.status ?? "") && !/answered|no longer meeting/i.test(j.s?.status ?? ""),
			`status="${j.s?.status}" sub="${j.s?.sub}"`,
		);
		const retry = await g.page.locator("button", { hasText: "RETRY" }).count();
		check("…with RETRY offered (another network may have a path)", retry > 0);
		await sleep(FAIL_BOUND_MS - j.ms + 1000);
		const later = await state(g);
		check("…and the verdict is not replaced by a later one", later.status === j.s?.status, `now "${later.status}"`);
		const hs = await state(h);
		check("the host is not left believing anyone joined", hs.room?.members.length === 1, brief(hs));

		// The classic flow has the same NAT, so the same verdict, on both ends.
		await hostByCode(h);
		const c = await joinClassic(h, g, FAIL_BOUND_MS + 10_000);
		check("classic join does not connect", !c.joined, brief(c.s));
		check("classic join: guest told explicitly within the bound", !!c.s?.error && c.ms <= FAIL_BOUND_MS, brief(c.s), c.ms);
		const hs2 = await waitFor(h, (s) => s.error, 10_000);
		check("classic join: host told explicitly too", hs2.ok, brief(hs2.s));
		check("classic join: the error says why", /symmetric|no route|direct/i.test(c.s?.status ?? ""), `status="${c.s?.status}"`);
	} finally {
		await closeAll([h, g]);
		dropSites(sites);
	}
});

scenario(4, "mixed NATs, and a relayed three-peer party", async () => {
	// One symmetric against a port-restricted cone: no TURN, no path.
	let sites = [await makeSite("cone"), await makeSite("symmetric")];
	let devs = [await device(sites[0], "cone"), await device(sites[1], "sym")];
	try {
		const made = await hostByCode(devs[0]);
		const j = await joinByCode(devs[1], made.code, FAIL_BOUND_MS + 10_000);
		check("symmetric vs port-restricted cone: no connection", !j.joined, brief(j.s));
		check("…and an explicit error within the bound", !!j.s?.error && j.ms <= FAIL_BOUND_MS, brief(j.s), j.ms);
	} finally {
		await closeAll(devs);
		dropSites(sites);
	}

	// One symmetric against a full cone: the cone accepts the peer-reflexive
	// address, so this one connects.
	sites = [await makeSite("fullcone"), await makeSite("symmetric"), await makeSite("symmetric")];
	devs = [await device(sites[0], "full"), await device(sites[1], "symA"), await device(sites[2], "symB")];
	try {
		const made = await hostByCode(devs[0]);
		const j = await joinByCode(devs[1], made.code);
		check("symmetric vs full cone: connects", j.joined, brief(j.s), j.ms);
		const j2 = await joinByCode(devs[2], made.code);
		check("a second symmetric peer joins the full-cone host", j2.joined, brief(j2.s), j2.ms);
		const c = await converged(devs, 20_000);
		check("all three agree on the party", c.ok, c.last.map(brief).join(" | "), c.ms);
		const [a, b] = await Promise.all([state(devs[1]), state(devs[2])]);
		check(
			"the two symmetric peers have no direct link (the case relaying exists for)",
			!a.room.peers.includes(b.room.id) && !b.room.peers.includes(a.room.id),
			`symA peers=${a.room.peers} symB=${b.room.id}`,
		);
		const x = await exchange(devs);
		check("messages between the unlinked pair arrive through the third", x.ok, "", x.ms);
		// Leave the doomed relayed negotiation time to time out (15s), and
		// make sure nobody turned it into an error on a working party.
		await sleep(17_000);
		const after = await Promise.all(devs.map(state));
		check("a failed pair inside a working party raises no error", after.every((s) => !s.error), after.map(brief).join(" | "));
		const x2 = await exchange(devs);
		check("messages still flow after the pair gives up", x2.ok, "", x2.ms);
	} finally {
		await closeAll(devs);
		dropSites(sites);
	}
});

scenario(5, "network switch mid-party", async () => {
	const sites = [await makeSite("cone"), await makeSite("cone")];
	const [h, g] = [await device(sites[0], "host"), await device(sites[1], "guest")];
	try {
		const made = await hostByCode(h);
		await joinByCode(g, made.code);
		const c0 = await converged([h, g], 15_000, { links: true });
		check("party up before the switch", c0.ok, c0.last.map(brief).join(" | "));

		// NAT rebinding with the same address: a cone NAT keeps the port, so
		// the link should not even notice.
		inNs(sites[1].router, CONNTRACK, ["-F"]);
		await sleep(8000);
		const x0 = await exchange([h, g]);
		check("conntrack flush on a cone NAT: messages still flow", x0.ok, "", x0.ms);

		// A short blackout — a lift, a tunnel. Chrome reports the link
		// `disconnected` a few seconds in; DISCONNECT_GRACE_MS (3s) is what
		// keeps a blip that ends soon after from costing the link.
		for (const ms of [4000, 8000]) {
			netem(sites[1], "loss 100%");
			const t0 = Date.now();
			let dropped = false;
			while (Date.now() - t0 < ms) {
				const s = await state(h);
				if (!s.room.peers.length || s.room.members.some((m) => m.rc)) dropped = true;
				await sleep(200);
			}
			inNs(sites[1].router, TC, ["qdisc", "del", "dev", "wan", "root"]);
			await sleep(3000);
			const s = await state(h);
			if (!s.room.peers.length || s.room.members.some((m) => m.rc)) dropped = true;
			check(`a ${ms / 1000}s blackout does not cost the link`, !dropped, brief(s));
			const xb = await exchange([h, g]);
			check(`…and messages written meanwhile still arrive`, xb.ok, "", xb.ms);
			await converged([h, g], 30_000, { links: true });
		}

		// A long blackout: long enough to cost the link on both ends, too
		// short for TCP to give up on the signalling socket. Neither side
		// has a dead socket to notice, yet both are isolated — and somebody
		// still has to offer.
		for (const after of [500, 5000]) {
			netem(sites[1], "loss 100%");
			const lost = await waitFor(h, (s) => !s.room.peers.length, 20_000);
			await sleep(after);
			inNs(sites[1].router, TC, ["qdisc", "del", "dev", "wan", "root"]);
			const label = `a blackout outlasting the link by ${after / 1000}s`;
			check(`${label} costs the link`, lost.ok, brief(lost.s), lost.ms);
			const healed = await converged([h, g], 25_000, { links: true, trace: true });
			check("…and the party heals once the network is back", healed.ok, healed.last.map(brief).join(" | "), healed.ms);
			const xl = await exchange([h, g]);
			check("…messages flow again", xl.ok, "", xl.ms);
		}

		// The guest's network changes: new public address, mappings gone.
		const start = Date.now();
		switchNetwork(sites[1]);
		const seen = await waitFor(h, (s) => s.room?.members.some((m) => m.rc) || s.room?.peers.length === 0, 30_000);
		check("host notices the guest's links are gone", seen.ok, brief(seen.s), seen.ms);
		// Bound: Chrome's disconnect (~7s) + DISCONNECT_GRACE_MS (3s) + the
		// socket probe (≤3s) + a re-dial and an ICE round. Without the probe
		// this took 40s+ — TCP had to notice the dead socket on its own.
		const c = await converged([h, g], 25_000, { links: true, trace: true });
		check(
			"party recovers after the switch (one host, no RECONNECTING, links back)",
			c.ok,
			c.last.map(brief).join(" | "),
			Date.now() - start,
		);
		const x = await exchange([h, g]);
		check("messages flow after the switch", x.ok, "", x.ms);

		// Now the host's network moves too: the crown holder is the one cut
		// off, so both sides may crown — the terms must reconcile to one.
		const start2 = Date.now();
		switchNetwork(sites[0]);
		const seen2 = await waitFor(g, (s) => s.room?.members.some((m) => m.rc) || s.room?.peers.length === 0, 30_000);
		check("guest notices the host's links are gone", seen2.ok, brief(seen2.s), seen2.ms);
		const c2 = await converged([h, g], 25_000, { links: true, trace: true });
		check(
			"host's network switch: one host again afterwards",
			c2.ok,
			c2.last.map(brief).join(" | "),
			Date.now() - start2,
		);
		const x2 = await exchange([h, g]);
		check("messages flow after the host's switch", x2.ok, "", x2.ms);
	} finally {
		await closeAll([h, g]);
		dropSites(sites);
	}
});

scenario(6, "lossy, latent links (10% loss, 200ms each way)", async () => {
	const sites = [await makeSite("cone"), await makeSite("cone"), await makeSite("cone")];
	for (const s of sites) netem(s, "delay 200ms 50ms loss 10%");
	const devs = [await device(sites[0], "host"), await device(sites[1], "g1"), await device(sites[2], "g2")];
	try {
		const made = await hostByCode(devs[0]);
		check("host gets a code over a lossy link", made.ok, "", made.ms);
		const j = await joinByCode(devs[1], made.code);
		check("first guest joins within the deadline", j.joined, brief(j.s), j.ms);
		const j2 = await joinByCode(devs[2], made.code);
		check("second guest joins within the deadline", j2.joined, brief(j2.s), j2.ms);
		const c = await converged(devs, 30_000);
		check("all three agree on the party", c.ok, c.last.map(brief).join(" | "), c.ms);
		const x = await exchange(devs, 15_000);
		check("messages arrive (reliable channel over a lossy path)", x.ok, "", x.ms);
		const start = Date.now();
		await devs[1].page.reload();
		const r = await waitFor(devs[1], inParty, 45_000);
		check("a reload reconnects over the lossy link", r.ok, brief(r.s), Date.now() - start);
	} finally {
		await closeAll(devs);
		dropSites(sites);
	}
});

scenario(7, "room server unreachable from one client", async () => {
	const sites = [await makeSite("cone"), await makeSite("cone", { blockRs: true })];
	const [h, g] = [await device(sites[0], "host"), await device(sites[1], "blocked")];
	try {
		const made = await hostByCode(h);
		const start = Date.now();
		const j = await joinByCode(g, made.code, 20_000);
		check("blocked client trying a code is told explicitly", !j.joined && !!j.s?.error, brief(j.s), j.ms);
		check("…that it is the room server it cannot reach", /room server/i.test(j.s?.status ?? ""), `status="${j.s?.status}"`);
		const retry = await g.page.locator("button", { hasText: "RETRY" }).count();
		check("…with RETRY offered", retry > 0);

		// Its own party: no code, the classic invite flow instead.
		await g.page.goto(BASE + "?fresh=1");
		const solo = await waitFor(g, (s) => !!s.room, 15_000);
		check("blocked client still hosts, classically (no party code)", solo.ok && !solo.s.code, brief(solo.s), Date.now() - start);
		const ok = await joinClassic(g, h);
		check("…and the classic invite/reply connects it across NATs", ok.joined, brief(ok.s), ok.ms);
		const x = await exchange([h, g]);
		check("messages flow", x.ok, "", x.ms);
	} finally {
		await closeAll([h, g]);
		dropSites(sites);
	}
});

scenario(8, "three peers, one changes network", async () => {
	const sites = [await makeSite("cone"), await makeSite("cone"), await makeSite("cone")];
	const devs = [await device(sites[0], "host"), await device(sites[1], "g1"), await device(sites[2], "mover")];
	try {
		const made = await hostByCode(devs[0]);
		await joinByCode(devs[1], made.code);
		await joinByCode(devs[2], made.code);
		const c0 = await converged(devs, 20_000, { links: true });
		check("full mesh of three", c0.ok, c0.last.map(brief).join(" | "), c0.ms);
		const start = Date.now();
		switchNetwork(sites[2]);
		const lost = await waitFor(devs[2], (s) => !s.room.peers.length, 30_000);
		check("the mover loses its links", lost.ok, brief(lost.s), lost.ms);
		// The two who did not move keep their own link the whole time, so
		// only the mover is isolated and only the mover re-announces.
		const c = await converged(devs, 30_000, { links: true, trace: true });
		check("the mover is back in the full mesh", c.ok, c.last.map(brief).join(" | "), Date.now() - start);
		const after = await Promise.all(devs.map(state));
		check("the crown never left the host who stayed", after.every((s) => s.room.host === after[0].room.id), after.map(brief).join(" | "));
		check("nobody was shown an error", after.every((s) => !s.error), after.map(brief).join(" | "));
		const x = await exchange(devs);
		check("messages flow among all three", x.ok, "", x.ms);
	} finally {
		await closeAll(devs);
		dropSites(sites);
	}
});

scenario(9, "live: a peer on the host's own network and one behind a lab NAT", async () => {
	if (!LIVE || !HOST_CDP) {
		console.log("  skip: live mode only (RS_URL and HOST_CDP, set by test-nat.sh)");
		return;
	}
	for (const nat of ["cone", "symmetric"]) {
		const sites = [await makeSite(nat)];
		const devs = [await hostDevice("home"), await device(sites[0], nat)];
		try {
			const made = await hostByCode(devs[0]);
			check(`home hosts a party (vs ${nat})`, made.ok, "", made.ms);
			const j = await joinByCode(devs[1], made.code, FAIL_BOUND_MS + 10_000);
			const pairs = await devs[1].page.evaluate(async () => {
				const out = [];
				for (const l of window.__party?.room?.links?.values() ?? []) {
					const st = await l.pc?.getStats();
					st?.forEach((r) => {
						if (r.type === "candidate-pair" && r.nominated && r.state === "succeeded")
							out.push(`${st.get(r.localCandidateId)?.candidateType}->${st.get(r.remoteCandidateId)?.candidateType}`);
					});
				}
				return out;
			});
			console.log(`  ·    ${nat}: joined=${j.joined} in ${(j.ms / 1000).toFixed(1)}s, pairs ${JSON.stringify(pairs)}, status "${j.s?.status}"`);
			check(`lab ${nat} peer joins the home peer, or is told why within the bound`, j.joined || (!!j.s?.error && j.ms <= FAIL_BOUND_MS), brief(j.s), j.ms);
			if (j.joined) {
				const x = await exchange(devs);
				check(`…messages flow (${nat})`, x.ok, "", x.ms);
				const start = Date.now();
				await devs[1].page.reload();
				const c = await converged(devs, 45_000, { links: true });
				check(`…the lab peer's reload reconnects (${nat})`, c.ok, c.last.map(brief).join(" | "), Date.now() - start);
			}
		} finally {
			await closeAll(devs);
			dropSites(sites);
		}
	}
});

scenario(10, "a port-dependent carrier NAT: its offer stands, both directions", async () => {
	// The 2026-11-12 pair (docs/network-testing.md, "Two machines"): the
	// owner's carrier CGNAT, which connects only as the ICE offerer, against
	// an institute's cone NAT. After a reload both ends offer, and the lower
	// id's offer used to stand: half the reloads took the failing direction
	// and waited ~18 s for the role swap. Now the carrier side classifies
	// itself hard (two STUN ports, two mappings: net.js classifyNat), marks
	// its offers, and the glare rule lets them stand — and offered to with
	// nothing of its own in flight, it offers back. Every reconnect here is
	// the carrier's own offer, first try, no swap.
	const FAST_MS = 6000;
	/** Who offered the link `dev` holds to `peer`, and was it the swap's? */
	const linkTo = (dev, peer) =>
		dev.page.evaluate((p) => {
			const l = window.__party?.room?.links.get(p);
			return l ? { offered: !!l.offered, retry: !!l.retry } : null;
		}, peer);
	/** The carrier's link to `other` is its own first-try offer. */
	const carrierOffered = async (carrier, other) => {
		const id = (await state(other)).room?.id;
		const l = id && (await linkTo(carrier, id));
		return { ok: !!l && l.offered && !l.retry, l };
	};
	/** Reload `dev`; ms until every page is back with new links both ways. */
	const reloadTimed = async (dev, devs) => {
		const start = Date.now();
		await dev.page.reload();
		const r = await waitFor(dev, (s) => inParty(s) || s.error, 45_000);
		const ok = r.ok && inParty(r.s);
		const c = ok ? await converged(devs, 40_000, { links: true }) : { ok: false, last: [] };
		return { ok: ok && c.ok, ms: Date.now() - start, s: r.s };
	};

	let sites = [await makeSite("portdep"), await makeSite("cone")];
	let devs = [await device(sites[0], "carrier"), await device(sites[1], "cone")];
	try {
		const [h, g] = devs;
		const made = await hostByCode(h);
		const j = await joinByCode(g, made.code);
		check("cone guest joins the carrier host by code", j.joined, brief(j.s), j.ms);
		const nat = await Promise.all(devs.map(state));
		check("the carrier NAT classifies as hard, the cone as not", nat[0].room?.nat === true && nat[1].room?.nat === false, JSON.stringify(nat.map((s) => s.room?.nat)));
		for (let i = 1; i <= 3; i++) {
			const r = await reloadTimed(g, devs);
			check(`guest reload ${i} reconnects (links both ways) in < ${FAST_MS / 1000}s`, r.ok && r.ms < FAST_MS, brief(r.s), r.ms);
			const o = await carrierOffered(h, g);
			check(`…on the carrier's own offer, no swap`, o.ok, JSON.stringify(o.l));
		}
		for (let i = 1; i <= 2; i++) {
			const r = await reloadTimed(h, devs);
			check(`host reload ${i} reconnects in < ${FAST_MS / 1000}s`, r.ok && r.ms < FAST_MS, brief(r.s), r.ms);
			const o = await carrierOffered(h, g);
			check(`…on the carrier's own offer, no swap`, o.ok, JSON.stringify(o.l));
		}
		const x = await exchange(devs);
		check("messages flow", x.ok, "", x.ms);
	} finally {
		await closeAll(devs);
		dropSites(sites);
	}

	// The other way round: the cone side hosts and is the one told to offer
	// — the direction that cannot work. The carrier guest, offered to with
	// nothing in flight, offers back marked hard, and the host's glare rule
	// lets it stand: a first try, not the swap.
	sites = [await makeSite("cone"), await makeSite("portdep"), await makeSite("cone")];
	devs = [await device(sites[0], "cone"), await device(sites[1], "carrier"), await device(sites[2], "cone2")];
	let start;
	try {
		const [h, g, g2] = devs;
		const made = await hostByCode(h);
		const j = await joinByCode(g, made.code);
		check("carrier guest joins a cone host by code", j.joined, brief(j.s), j.ms);
		const o = await carrierOffered(g, h);
		check("…on its own offer, the first try", o.ok, JSON.stringify(o.l));
		for (let i = 1; i <= 2; i++) {
			const r = await reloadTimed(g, [h, g]);
			check(`carrier guest reload ${i} reconnects in < ${FAST_MS / 1000}s`, r.ok && r.ms < FAST_MS, brief(r.s), r.ms);
			const o2 = await carrierOffered(g, h);
			check(`…on the carrier's own offer, no swap`, o2.ok, JSON.stringify(o2.l));
		}
		for (let i = 1; i <= 2; i++) {
			const r = await reloadTimed(h, [h, g]);
			check(`cone host reload ${i} reconnects in < ${FAST_MS / 1000}s`, r.ok && r.ms < FAST_MS, brief(r.s), r.ms);
			const o2 = await carrierOffered(g, h);
			check(`…on the carrier's own offer, no swap`, o2.ok, JSON.stringify(o2.l));
		}
		// A third member, joined under the lowest id there is, so the mesh
		// relay has it offer to the carrier guest (the lower id offers; the
		// relay knows nothing of NATs) — the direction that fails — and the
		// role swap still has to carry that pair.
		// (A token for the code is a claim the server has not seen: it
		// seats a newcomer under that id.)
		await g2.page.context().addInitScript((code) => {
			try {
				localStorage.setItem("neon.room", JSON.stringify({ code, id: "000000000000", secret: "lab-relay-swap" }));
			} catch {}
		}, made.code);
		start = Date.now();
		const j2 = await joinByCode(g2, made.code);
		check("a third member joins the cone host", j2.joined, brief(j2.s), j2.ms);
		const c = await converged(devs, 60_000, { links: true, trace: VERBOSE });
		check("the relayed pair (cone offers to carrier) links after the swap", c.ok, c.last.map(brief).join(" | "), Date.now() - start);
		const after = await Promise.all(devs.map(state));
		check("nobody was shown an error", after.every((s) => !s.error), after.map(brief).join(" | "));
	} finally {
		await closeAll(devs);
		dropSites(sites);
	}
});

// ------------------------------------------------------------- run

let stun, stun2, http;
try {
	setupInternet();
	stun = await startStun();
	stun2 = await startStun(STUN_PORT_2);
	http = await startHttp();
	if (LIVE) {
		await connectInternet();
		const ping = await new Promise((done) => {
			// Through the forwarder, exactly as the lab's Chrome will go.
			const req = httpsRequest(LIVE + "/ping", { lookup: (_h, _o, cb) => cb(null, [{ address: PUBLIC, family: 4 }]) }, (res) => (res.resume(), done(res.statusCode)));
			req.on("error", (e) => done(e.message));
			req.end();
		});
		console.log(`live: room server ${LIVE} (/ping ${ping}), real public STUN, real internet via slirp4netns`);
		if (ping !== 204) throw new Error("the deployed room server is not reachable from the lab");
	} else {
		process.stdout.write("starting the room server (wrangler dev)… ");
		await startRoomServer();
		console.log("up");
	}
	for (const s of scenarios) {
		if (ONLY && !ONLY.has(s.n)) continue;
		scenarioName = `${s.n}. ${s.name}`;
		console.log(`\n${scenarioName}`);
		try {
			await s.fn();
		} catch (err) {
			check("scenario ran to completion", false, err.stack ?? String(err));
		}
	}
} finally {
	for (const c of children) c.kill();
	stun?.close();
	stun2?.close();
	http?.close();
	liveForwarder?.close();
	rmSync(wrappers, { recursive: true, force: true });
	rmSync(persist, { recursive: true, force: true });
}

console.log("\nsummary");
for (const [sc, label, ok, ms] of results) {
	console.log(`  ${ok ? "ok  " : "FAIL"} [${sc.split(".")[0]}] ${label}${ms === null ? "" : ` — ${(ms / 1000).toFixed(1)}s`}`);
}
console.log(failures ? `\n${failures} failure(s)` : "\nall cross-network checks passed");
process.exit(failures ? 1 : 0);
