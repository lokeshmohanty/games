#!/usr/bin/env node
/**
 * test-room.mjs — the room-server path: join by code, reconnect, fallback.
 *
 *   node scripts/test-room.mjs
 *
 * Everything under test is real: lib/room-join.js's protocol, lib/net.js's
 * reconnect grace, the party and lobby screens — and the WebRTC handshake
 * itself, two real peer connections in one page. The only thing faked is the
 * room server, replaced by the in-page mock (`?mockroom=1`), the same shape
 * of trick as test-scan.mjs's fake camera: the transport is faked, the
 * client above it is not.
 *
 * A reload is simulated as what a reload actually is: every connection dies
 * without a goodbye — no `room.leave()`, which would hand the seat back —
 * the room server sees the socket drop, and the one thing that survives, the
 * rejoin token, is put back. Nothing else in the page is re-created, because
 * nothing else survives a reload either.
 *
 * The server-side rules (claims, rate limits, TTLs) are not tested here;
 * scripts/test-hub.mjs covers them against the real hub logic.
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync, globSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const PW_CACHE = join(homedir(), ".cache", "game-previews");
const PAGE = (name, query = "") => `file://${join(ROOT, name)}${query}`;
const TIMEOUT = 40_000;

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
		execFileSync("npm", ["install", "--prefix", PW_CACHE, "--no-save", "--no-audit", "playwright"], {
			stdio: "inherit",
		});
		return require(join(PW_CACHE, "node_modules", "playwright"));
	}
	return require(found);
}

let failures = 0;
const check = (label, ok, detail = "") => {
	console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
	if (!ok) failures++;
};

/** Poll a predicate inside the page until it holds, or TIMEOUT. */
async function until(page, evalFn, arg, label) {
	const start = Date.now();
	while (Date.now() - start < TIMEOUT) {
		if (await page.evaluate(evalFn, arg)) return true;
		await new Promise((r) => setTimeout(r, 200));
	}
	console.log(`    (${label} never came true)`);
	return false;
}

const { chromium } = loadPlaywright();
const browser = await chromium.launch({
	executablePath: chromePath(),
	args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
});
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
page.on("pageerror", (err) => {
	console.log(`  FAIL page error: ${err.message}`);
	failures++;
});

try {
	// ------------------------------------------------------------- setup
	// The harness, not party.html: nothing is mounted, so the only rooms on
	// this page are the ones the test makes. party.html hosts on boot, which
	// would be a second, unaccounted room.
	await page.goto(PAGE("scripts/room-harness.html", "?mockroom=1"));
	await page.evaluate(() => {
		localStorage.removeItem("neon.room");
		localStorage.removeItem("neon.rs");
		// Every glare check here assumes the lower-id rule unless a room is
		// given `natHard` itself: the machine's own NAT must not decide them.
		NeonArcade._pinNat(null);
		/**
		 * A reload of `made`'s page: links die, the signalling socket dies,
		 * nothing is said on the way out — and the token survives.
		 */
		window.__reload = (made, token) => {
			const r = made.room;
			r.closed = true;
			for (const link of [...r.links.values(), ...r.pending.values()]) link.close();
			r.links.clear();
			r.pending.clear();
			window.__neonRoomMock.drop(r.selfId);
			localStorage.setItem("neon.room", JSON.stringify(token));
		};
	});

	// ------------------------------------------------- 1. join by code
	console.log("\nroom: join by code");
	const code = await page.evaluate(async () => {
		const made = await NeonArcade.hostRoom({
			name: "Host",
			reconnectGraceMs: 400,
			onError: (m) => (window.__errs ??= []).push(m),
		});
		window.__host = made;
		window.__hostToken = NeonArcade.rejoinToken();
		return made.code;
	});
	check("host gets a 6-digit code", /^\d{6}$/.test(code ?? ""), String(code));
	check("host wrote a rejoin token", await page.evaluate(() => !!NeonArcade.rejoinToken()?.secret));
	check(
		"the host named no code: it dialled /room/new, and the server drew one",
		await page.evaluate(() => JSON.stringify(window.__neonRoomMock.dials) === JSON.stringify([{ code: "new", pass: "none" }])),
		await page.evaluate(() => JSON.stringify(window.__neonRoomMock.dials)),
	);
	check("its token holds the member pass the server issued", await page.evaluate(() => !!window.__hostToken?.pass && window.__hostToken.exp > Date.now()));

	const guestId = await page.evaluate(async (c) => {
		// A fresh guest: the rejoin token must be cleared first, because the
		// host's token is in this page's localStorage and would be adopted
		// as a rejoin — same id, same seat, one member where two should be.
		localStorage.removeItem("neon.room");
		const made = await NeonArcade.joinRoom(c, {
			name: "Guest",
			reconnectGraceMs: 400,
			onError: (m) => (window.__errs ??= []).push(m),
		});
		window.__guest = made;
		window.__guestToken = NeonArcade.rejoinToken();
		return made.room.selfId;
	}, code);
	check("guest joined", !!guestId);
	check(
		"joinRoom resolved only once a link was open",
		await page.evaluate(() => window.__guest.room.directPeers().length === 1),
	);
	check("guest kept its own id", await page.evaluate(() => NeonArcade.rejoinToken()?.id === window.__guest.room.selfId));
	check("a first join carries no pass (it has none yet)", await page.evaluate((c) => window.__neonRoomMock.dials.at(-1)?.code === c && window.__neonRoomMock.dials.at(-1)?.pass === "none", code));
	check("and its token holds one now", await page.evaluate(() => !!window.__guestToken?.pass));

	// The offer crossed the mock, the WebRTC handshake completed, and each
	// side's party record now holds them both.
	check(
		"host's mesh reached the guest",
		await until(
			page,
			() => window.__host.room.directPeers().length === 1,
			undefined,
			"direct link",
		),
	);
	check(
		"both party records agree on two members",
		await until(
			page,
			() =>
				window.__host.room.getMembers().length === 2 &&
				window.__guest.room.getMembers().length === 2,
			undefined,
			"records",
		),
	);

	// The room server's socket state is advisory: a live link outranks it.
	await page.evaluate((id) => window.__host.room.serverPeerState(id, false), guestId);
	check(
		"a live link outranks the server's word",
		!(await page.evaluate((id) => !!window.__host.room.getMember(id)?.reconnecting, guestId)),
	);

	// Team assignment survives everything that follows — it is the seat.
	await page.evaluate((id) => window.__host.room.setTeam(id, "B"), guestId);
	check(
		"team assignment replicated",
		await until(
			page,
			(id) => window.__guest.room.getMember(id)?.team === "B",
			guestId,
			"team",
		),
	);

	// ---------------------------------------------- 2. reload and rejoin
	console.log("\nroom: reload, seat held, rejoin");
	await page.evaluate(() => window.__reload(window.__guest, window.__guestToken));
	check(
		"the seat is held as RECONNECTING, not dropped",
		await until(
			page,
			(id) => {
				const m = window.__host.room.getMember(id);
				return !!m?.reconnecting && window.__host.room.getMembers().length === 2;
			},
			guestId,
			"held seat",
		),
	);

	const rejoined = await page.evaluate(async (c) => {
		const made = await NeonArcade.joinRoom(c, { name: "Guest", reconnectGraceMs: 400 });
		window.__guest = made;
		return made.room.selfId;
	}, code);
	check("rejoin adopted the old member id", rejoined === guestId, `${rejoined} vs ${guestId}`);
	check(
		"and dialled with the token's pass, which the server finds valid",
		await page.evaluate((c) => window.__neonRoomMock.dials.findLast((d) => d.code === c)?.pass === "valid", code),
	);
	check(
		"the link came back",
		await until(
			page,
			() => window.__host.room.directPeers().length === 1,
			undefined,
			"relink",
		),
	);
	check(
		"the seat came back: same team, same member",
		await until(
			page,
			(id) => {
				const m = window.__host.room.getMember(id);
				return m?.team === "B" && !m?.reconnecting;
			},
			guestId,
			"seat restored",
		),
	);

	// -------------------------------------- 3. and again, and again
	// The offer guard once cleared only for brand-new members, so a member
	// who reloaded a second time was never offered to again.
	console.log("\nroom: a guest reloads twice");
	for (const round of [2, 3]) {
		await page.evaluate(() => window.__reload(window.__guest, window.__guestToken));
		await until(page, () => window.__host.room.directPeers().length === 0, undefined, "link down");
		const again = await page.evaluate(async (c) => {
			try {
				const made = await NeonArcade.joinRoom(c, { name: "Guest", reconnectGraceMs: 2000, answerTimeoutMs: 15000 });
				window.__guest = made;
				return made.room.selfId;
			} catch (err) {
				return `error: ${err.reason}`;
			}
		}, code);
		check(`rejoin #${round} reconnected the same seat`, again === guestId, String(again));
	}

	// ------------------------------------------------ 4. the host reloads
	// The host is the oldest member; the server once named them as their
	// own offerer when they came back, so nobody offered and the host could
	// never reconnect. Now the guest offers.
	console.log("\nroom: the host reloads and reconnects");
	const hostId = await page.evaluate(() => window.__host.room.selfId);
	await page.evaluate(() => window.__reload(window.__host, window.__hostToken));
	await until(page, () => window.__guest.room.directPeers().length === 0, undefined, "link down");
	const hostBack = await page.evaluate(async (c) => {
		try {
			const made = await NeonArcade.joinRoom(c, { name: "Host", reconnectGraceMs: 2000, answerTimeoutMs: 15000 });
			window.__host = made;
			return made.room.selfId;
		} catch (err) {
			return `error: ${err.reason}`;
		}
	}, code);
	check("the host's rejoin resolved with its own id", hostBack === hostId, String(hostBack));
	check(
		"host and guest are linked and agree on two members",
		await until(
			page,
			() =>
				window.__host.room.directPeers().length === 1 &&
				window.__host.room.getMembers().length === 2 &&
				window.__guest.room.getMembers().length === 2,
			undefined,
			"host relink",
		),
	);

	// ------------------------------------------- 5. grace runs out
	console.log("\nroom: grace expiry drops the seat");
	await page.evaluate(() => window.__reload(window.__guest, window.__guestToken));
	check(
		"after the grace, the member is dropped",
		await until(
			page,
			() => window.__host.room.getMembers().length === 1,
			undefined,
			"drop",
		),
	);

	// ----------------------------------------- 6. nobody left to answer
	// A code whose members have all gone — their claims outlive them until
	// the TTL — still says "joined". The join must not wait forever for an
	// offer nobody will make: it fails, explicitly, inside the deadline.
	console.log("\nroom: a code nobody answers");
	const answerless = await page.evaluate(async () => {
		localStorage.removeItem("neon.room");
		const lone = await NeonArcade.hostRoom({ name: "Gone" });
		window.__reload(lone, NeonArcade.rejoinToken());
		localStorage.removeItem("neon.room");
		const started = Date.now();
		try {
			await NeonArcade.joinRoom(lone.code, { name: "Late", answerTimeoutMs: 1500 });
			return { reason: "resolved" };
		} catch (err) {
			return { reason: err.reason, message: err.message, ms: Date.now() - started, token: NeonArcade.rejoinToken() };
		}
	});
	check("joining it fails with no-answer", answerless.reason === "no-answer", JSON.stringify(answerless));
	check("within the deadline", answerless.ms < 1500 + 1000, String(answerless.ms));
	check("with a human sentence", /nobody/i.test(answerless.message ?? ""));
	check("and leaves no rejoin token behind", answerless.token === null);

	// ------------------------------- 6b. a rejoin nobody answers
	// A lone host who reloads has nobody to answer them. The party may only
	// be slow, so the claim and the token survive for RETRY; giving them
	// back is START A NEW PARTY's job (releaseRejoin), not the timeout's.
	console.log("\nroom: a rejoin nobody answers keeps its claim");
	const heldRejoin = await page.evaluate(async () => {
		localStorage.removeItem("neon.room");
		const lone = await NeonArcade.hostRoom({ name: "Lone" });
		const token = NeonArcade.rejoinToken();
		window.__reload(lone, token);
		const claims = () => window.__neonRoomMock.rooms.get(lone.code);
		let reason;
		try {
			await NeonArcade.joinRoom(lone.code, { name: "Lone", answerTimeoutMs: 1500 });
			reason = "resolved";
		} catch (err) {
			reason = err.reason;
		}
		const kept = { reason, token: NeonArcade.rejoinToken()?.id === token.id, claim: !!claims()?.has(token.id) };
		await NeonArcade.releaseRejoin();
		return { ...kept, tokenAfter: NeonArcade.rejoinToken(), roomAfter: !!claims() };
	});
	check("it fails with no-answer", heldRejoin.reason === "no-answer", JSON.stringify(heldRejoin));
	check("the token survives, for RETRY", heldRejoin.token === true);
	check("the claim survives on the server", heldRejoin.claim === true);
	check(
		"releaseRejoin gives both back (and the empty room goes)",
		heldRejoin.tokenAfter === null && heldRejoin.roomAfter === false,
		JSON.stringify(heldRejoin),
	);

	// ------------------------------- 6c. two hostless members meet
	// The lone host reloads; meanwhile a newcomer types the code and is
	// told to offer to the returning host. They link — and neither has a
	// record, so neither knows a host. Resolving on "a link opened" once
	// left both in a party with nobody at its head, forever. A join now
	// needs a host as well as a link; nobody crowns themselves at term 0.
	console.log("\nroom: two members with no host never settle for that");
	const hostless = await page.evaluate(async () => {
		localStorage.removeItem("neon.room");
		const lone = await NeonArcade.hostRoom({ name: "Host" });
		const token = NeonArcade.rejoinToken();
		window.__reload(lone, token);
		localStorage.removeItem("neon.room");
		const fresh = NeonArcade.joinRoom(lone.code, { name: "Newbie", answerTimeoutMs: 3000 });
		await new Promise((r) => setTimeout(r, 300));
		localStorage.setItem("neon.room", JSON.stringify(token));
		const back = NeonArcade.joinRoom(lone.code, { name: "Host", answerTimeoutMs: 3000 });
		const settled = await Promise.allSettled([fresh, back]);
		const claims = window.__neonRoomMock.rooms.get(lone.code);
		return {
			outcomes: settled.map((s) =>
				s.status === "fulfilled" ? `resolved host=${s.value.room.hostId()}` : s.reason.reason,
			),
			hostClaim: !!claims?.has(token.id),
			claims: claims?.size ?? 0,
		};
	});
	check(
		"neither join resolves into a hostless party",
		hostless.outcomes.every((o) => o === "no-answer"),
		JSON.stringify(hostless),
	);
	check(
		"the newcomer's claim is released, the rejoiner's held",
		hostless.hostClaim && hostless.claims === 1,
		JSON.stringify(hostless),
	);

	// --------------------------------------- 6d. a party full of bots
	// Host + guest + six bots is eight. The guest's own held seat once
	// counted against them, so after a reload they could never get back in;
	// and a genuine newcomer waited out the whole deadline to hear "nobody
	// answered" instead of "full".
	console.log("\nroom: a full party");
	const full = await page.evaluate(async () => {
		localStorage.removeItem("neon.room");
		const host = await NeonArcade.hostRoom({ name: "Host", reconnectGraceMs: 60000 });
		localStorage.removeItem("neon.room");
		let guest = await NeonArcade.joinRoom(host.code, { name: "G" });
		const token = NeonArcade.rejoinToken();
		await new Promise((r) => setTimeout(r, 500));
		for (let i = 0; i < 6; i++) host.room.addBot();
		await new Promise((r) => setTimeout(r, 500));
		const size = host.room.getMembers().length;
		const guestId = guest.room.selfId;
		window.__reload(guest, token);
		let back;
		try {
			guest = await NeonArcade.joinRoom(host.code, { name: "G", answerTimeoutMs: 15000 });
			back = guest.room.selfId === guestId;
		} catch (err) {
			back = `error: ${err.reason}`;
		}
		localStorage.removeItem("neon.room");
		const started = Date.now();
		let newcomer;
		try {
			await NeonArcade.joinRoom(host.code, { name: "Late", answerTimeoutMs: 15000 });
			newcomer = { reason: "resolved" };
		} catch (err) {
			newcomer = { reason: err.reason, ms: Date.now() - started, message: err.message };
		}
		const claims = window.__neonRoomMock.rooms.get(host.code)?.size;
		host.room.leave();
		guest.room.leave();
		return { size, back, newcomer, claims };
	});
	check("the party is full", full.size === 8, String(full.size));
	check("a member of the full party reconnects after a reload", full.back === true, String(full.back));
	check("a newcomer hears full", full.newcomer.reason === "full", JSON.stringify(full.newcomer));
	check("long before the deadline", full.newcomer.ms < 5000, String(full.newcomer.ms));
	check("and the newcomer's claim is given back", full.claims === 2, String(full.claims));

	// ---------------------------------------- 6e. cancelling a join
	// START A NEW PARTY during a reconnect used to navigate away with the
	// claim still held. An aborted join hands it back on the spot.
	console.log("\nroom: an aborted rejoin releases its claim");
	const aborted = await page.evaluate(async () => {
		localStorage.removeItem("neon.room");
		const lone = await NeonArcade.hostRoom({ name: "Lone" });
		const token = NeonArcade.rejoinToken();
		window.__reload(lone, token);
		const ctl = new AbortController();
		const pending = NeonArcade.joinRoom(lone.code, { name: "Lone", signal: ctl.signal, answerTimeoutMs: 15000 });
		await new Promise((r) => setTimeout(r, 300));
		const started = Date.now();
		ctl.abort();
		// Synchronous by contract: the claim is gone before abort() returns.
		const roomAtAbort = !!window.__neonRoomMock.rooms.get(lone.code);
		const tokenAtAbort = NeonArcade.rejoinToken();
		let reason;
		try {
			await pending;
			reason = "resolved";
		} catch (err) {
			reason = err.reason;
		}
		return { reason, ms: Date.now() - started, roomAtAbort, tokenAtAbort };
	});
	check("it rejects aborted, at once", aborted.reason === "aborted" && aborted.ms < 500, JSON.stringify(aborted));
	check(
		"the claim and the token are gone before abort() returns",
		aborted.roomAtAbort === false && aborted.tokenAtAbort === null,
		JSON.stringify(aborted),
	);

	// -------------------------- 6e2. a leave during a redial
	// A leave that finds the signalling socket mid-redial has no socket to
	// say so on. It used to be dropped — the dial landed, was hung up
	// without a word, and the party held the seat for 5 minutes.
	console.log("\nroom: a leave during a redial still gives the seat back");
	const owed = await page.evaluate(async () => {
		const mock = window.__neonRoomMock;
		const wait = (ms) => new Promise((r) => setTimeout(r, ms));
		localStorage.removeItem("neon.room");
		const host = await NeonArcade.hostRoom({ name: "Host" });
		const seat = async (name) => {
			localStorage.removeItem("neon.room");
			return (await NeonArcade.joinRoom(host.code, { name })).room;
		};
		// Redial only scheduled (RETRY_FIRST_MS away) when the leave comes.
		const g1 = await seat("G1");
		mock.drop(g1.selfId);
		await wait(50);
		g1.leave();
		await NeonArcade.roomSettled();
		const scheduled = mock.rooms.get(host.code)?.has(g1.selfId) ?? false;
		// Redial in flight: the server's reply is held back 400 ms, and the
		// leave lands while the dial is out.
		const g2 = await seat("G2");
		const connect = mock.connect;
		mock.connect = (path) => {
			const ws = connect.call(mock, path);
			const send = ws.send;
			ws.send = (raw) => setTimeout(() => send.call(ws, raw), 400);
			return ws;
		};
		mock.drop(g2.selfId);
		await wait(1150);
		g2.leave();
		await NeonArcade.roomSettled();
		mock.connect = connect;
		const inFlight = mock.rooms.get(host.code)?.has(g2.selfId) ?? false;
		const token = NeonArcade.rejoinToken();
		host.room.leave();
		return { scheduled, inFlight, token };
	});
	check("redial scheduled: the claim is given back", owed.scheduled === false, JSON.stringify(owed));
	check("redial in flight: the claim is given back", owed.inFlight === false, JSON.stringify(owed));
	check("and the token is gone", owed.token === null, JSON.stringify(owed));

	// ---------------------- 6e2b. an owed leave never takes a live seat
	// The owed leave used to dial `join` with the claim and then `leave`:
	// if another tab of this browser had taken the seat meanwhile, that join
	// hung the live tab up (4409) and the leave gave its seat away. It is a
	// `release` now, which never binds; a `busy` is asked again in case it
	// is our own old socket, and left alone if it stays busy.
	console.log("\nroom: a leave during a redial never takes another tab's seat");
	const owedRelease = await page.evaluate(async () => {
		const mock = window.__neonRoomMock;
		const wait = (ms) => new Promise((r) => setTimeout(r, ms));
		// Every message any socket sends, by type, while `fn` runs.
		const watch = async (fn) => {
			const sent = [];
			const connect = mock.connect;
			mock.connect = (path) => {
				const ws = connect.call(mock, path);
				const send = ws.send;
				ws.send = (raw) => (sent.push(JSON.parse(raw).t), send.call(ws, raw));
				return ws;
			};
			try {
				await fn();
			} finally {
				mock.connect = connect;
			}
			return { releases: sent.filter((t) => t === "release").length, joins: sent.filter((t) => t === "join").length };
		};
		localStorage.removeItem("neon.room");
		const host = await NeonArcade.hostRoom({ name: "Host" });
		const out = {};

		// A twin tab holds the seat live by the time we leave mid-redial.
		localStorage.removeItem("neon.room");
		const g = (await NeonArcade.joinRoom(host.code, { name: "G" })).room;
		const token = NeonArcade.rejoinToken();
		mock.drop(g.selfId); // our socket is gone; the redial is scheduled
		const twin = mock.connect(`/room/${host.code}`);
		let twinClosed = null;
		twin.onclose = (e) => (twinClosed = e.code);
		const twinReply = await new Promise((r) => {
			twin.onopen = () => {
				twin.onmessage = (e) => r(JSON.parse(e.data).t);
				twin.send(JSON.stringify({ t: "join", code: host.code, id: token.id, secret: token.secret }));
			};
		});
		let settledMs;
		const twinDials = await watch(async () => {
			const started = Date.now();
			g.leave();
			await NeonArcade.roomSettled();
			settledMs = Date.now() - started;
			await wait(300);
		});
		out.twin = {
			twinReply,
			twinClosed,
			bound: mock.rooms.get(host.code)?.get(token.id)?.socket === twin,
			settledMs,
			...twinDials,
		};
		twin.close();

		// Our own old socket, closed here but not yet seen closing by the
		// server: busy at first, then released once the server notices.
		localStorage.removeItem("neon.room");
		const g2 = (await NeonArcade.joinRoom(host.code, { name: "G2" })).room;
		mock.drop(g2.selfId);
		await wait(50);
		const member = mock.rooms.get(host.code).get(g2.selfId);
		let staleClosed = null;
		const stale = { readyState: 1, close: (code) => (staleClosed = code) };
		member.socket = stale;
		setTimeout(() => member.socket === stale && (member.socket = null), 2000);
		const ownDials = await watch(async () => {
			g2.leave();
			await NeonArcade.roomSettled();
		});
		out.own = {
			...ownDials,
			staleClosed,
			claim: mock.rooms.get(host.code)?.has(g2.selfId) ?? false,
			token: NeonArcade.rejoinToken(),
		};
		host.room.leave();
		return out;
	});
	const { twin: tw, own } = owedRelease;
	check("(the twin tab took the seat)", tw.twinReply === "joined", JSON.stringify(tw));
	check("the leave never joins", tw.joins === 0, JSON.stringify(tw));
	check("the twin is never hung up (no 4409)", tw.twinClosed === null && tw.bound, JSON.stringify(tw));
	check("busy is asked again, four times in all", tw.releases === 4, JSON.stringify(tw));
	check("and navigation waits at most 6 s for it", tw.settledMs >= 4000 && tw.settledMs <= 6500, JSON.stringify(tw));
	check("our own stale socket: released after a retry", own.releases >= 2 && !own.claim, JSON.stringify(own));
	check("without binding the seat or hanging up the stale socket", own.joins === 0 && own.staleClosed === null, JSON.stringify(own));
	check("and the token is gone", own.token === null, JSON.stringify(own));

	// ------------------------------- 6e3. glare, then our offer fails
	// The lower id sets the higher id's offer aside for its own. If its own
	// then cannot be made, the set-aside offer is the pair's only one: it
	// is answered, not left for both to wait on until the next notice.
	console.log("\nroom: glare, and then our own offer fails");
	const glare = await page.evaluate(async () => {
		const wait = (ms) => new Promise((r) => setTimeout(r, ms));
		localStorage.removeItem("neon.room");
		const a = await NeonArcade.hostRoom({ name: "A" });
		const sock = window.__neonRoomMock.rooms.get(a.code).get(a.room.selfId).socket;
		const sent = [];
		const send = sock.send;
		sock.send = (raw) => {
			sent.push(JSON.parse(raw));
			return send.call(sock, raw);
		};
		// A real offer to answer, from a room outside this one.
		const other = NeonArcade.createHost({ name: "Other" });
		const { code: theirs } = await other.createInvite();
		const peer = "zzzzzzzzzzzz"; // above any minted id: A's offer stands
		a.room.createInvite = () => new Promise((_, no) => setTimeout(() => no(new Error("gather failed")), 300));
		const inject = (m) => sock.onmessage({ data: JSON.stringify(m) });
		inject({ t: "peer", id: peer, connected: true, offering: a.room.selfId });
		inject({ t: "offer", from: peer, sdp: theirs });
		const ignoredAtFirst = !sent.some((m) => m.t === "answer");
		let answered = false;
		for (let i = 0; i < 50 && !answered; i++) {
			await wait(200);
			answered = sent.some((m) => m.t === "answer" && m.to === peer);
		}
		other.leave();
		a.room.leave();
		return { ignoredAtFirst, answered };
	});
	check("their offer is set aside while ours is in flight", glare.ignoredAtFirst, JSON.stringify(glare));
	check("and answered once ours fails", glare.answered, JSON.stringify(glare));

	// ----------------------------- 6e4. a redial refused "blocked"
	// "blocked" on a redial used to end signalling for good. A valid claim
	// is never charged, so it only means the server could not check ours
	// just then: try again, with the backoff.
	console.log("\nroom: a redial answered blocked tries again");
	const unblocked = await page.evaluate(async () => {
		const mock = window.__neonRoomMock;
		const wait = (ms) => new Promise((r) => setTimeout(r, ms));
		localStorage.removeItem("neon.room");
		const host = await NeonArcade.hostRoom({ name: "Host" });
		localStorage.removeItem("neon.room");
		const g = (await NeonArcade.joinRoom(host.code, { name: "G" })).room;
		let refusals = 2;
		const connect = mock.connect;
		mock.connect = (path) => {
			const ws = connect.call(mock, path);
			const send = ws.send;
			ws.send = (raw) => {
				if (refusals > 0 && JSON.parse(raw).t === "join") {
					refusals--;
					setTimeout(() => ws.onmessage?.({ data: JSON.stringify({ t: "error", reason: "blocked" }) }), 0);
					return;
				}
				return send.call(ws, raw);
			};
			return ws;
		};
		mock.drop(g.selfId);
		let back = false;
		for (let i = 0; i < 60 && !back; i++) {
			await wait(250);
			back = !!mock.rooms.get(host.code)?.get(g.selfId)?.socket;
		}
		mock.connect = connect;
		const out = { refusals, back, closed: g.closed };
		g.leave();
		host.room.leave();
		return out;
	});
	check("both refusals were met", unblocked.refusals === 0, JSON.stringify(unblocked));
	check("and the signalling socket came back", unblocked.back && !unblocked.closed, JSON.stringify(unblocked));

	// ------------------------------- 6e4b. passes and server-drawn codes
	// A member's every re-dial — a redial after a drop, a reload's rejoin,
	// a release — presents the pass its seat came with, so the routing
	// Worker never charges it against the address's dial budget. Hosting
	// dials /room/new and never names a code.
	console.log("\nroom: the network coming back redials at once");
	// A redial backs off to one try per 30 s; the browser's `online` event
	// is news worth more than the timer, so it goes now.
	const online = await page.evaluate(async () => {
		const mock = window.__neonRoomMock;
		const wait = (ms) => new Promise((r) => setTimeout(r, ms));
		localStorage.removeItem("neon.room");
		const host = await NeonArcade.hostRoom({ name: "Host" });
		localStorage.removeItem("neon.room");
		const g = await NeonArcade.joinRoom(host.code, { name: "G" });
		const attached = () => !!mock.rooms.get(host.code)?.get(g.room.selfId)?.socket;
		mock.down = true;
		mock.drop(g.room.selfId);
		await wait(3500); // tries at ~1 s and ~3 s fail; the next waits ~4 s
		mock.down = false;
		const stillOut = !attached();
		const t0 = Date.now();
		dispatchEvent(new Event("online"));
		let ms = null;
		for (let i = 0; i < 40 && ms === null; i++) {
			await wait(50);
			if (attached()) ms = Date.now() - t0;
		}
		g.room.leave();
		host.room.leave();
		return { stillOut, ms };
	});
	check("(the outage kept the guest off the room server)", online.stillOut);
	check("`online` redials straight away, not at the next backoff step", online.ms !== null && online.ms < 1000, JSON.stringify(online));

	console.log("\nroom: hosts never name a code; every re-dial carries the pass");
	const passes = await page.evaluate(async () => {
		const mock = window.__neonRoomMock;
		const wait = (ms) => new Promise((r) => setTimeout(r, ms));
		localStorage.removeItem("neon.room");
		const from = mock.dials.length;
		const host = await NeonArcade.hostRoom({ name: "Host" });
		localStorage.removeItem("neon.room");
		const g = await NeonArcade.joinRoom(host.code, { name: "G" });
		const opened = mock.dials.slice(from);
		const issued = NeonArcade.rejoinToken();
		const before = mock.dials.length;
		mock.drop(g.room.selfId);
		let back = false;
		for (let i = 0; i < 60 && !back; i++) {
			await wait(250);
			back = !!mock.rooms.get(host.code)?.get(g.room.selfId)?.socket;
		}
		const redials = mock.dials.slice(before);
		const refreshed = NeonArcade.rejoinToken();
		window.__reload(g, NeonArcade.rejoinToken());
		// The host, isolated by that reload, re-announces at once (a dial of
		// its own, before it lets go of the old socket): let it land, so the
		// window below holds the release's dial alone.
		await wait(300);
		const r0 = mock.dials.length;
		const released = await NeonArcade.releaseRejoin();
		const release = mock.dials.slice(r0);
		const codes = [];
		const h0 = mock.dials.length;
		for (let i = 0; i < 6; i++) {
			localStorage.removeItem("neon.room");
			const h = await NeonArcade.hostRoom({ name: "H" + i });
			codes.push(h.code);
			h.room.leave();
		}
		const hostDials = mock.dials.slice(h0);
		host.room.leave();
		return { code: host.code, opened, issued, back, redials, refreshed, released, release, codes, hostDials };
	});
	check("host dialled new, the guest its code, neither with a pass", JSON.stringify(passes.opened) === JSON.stringify([{ code: "new", pass: "none" }, { code: passes.code, pass: "none" }]), JSON.stringify(passes.opened));
	check("a dropped socket redials", passes.back, JSON.stringify(passes));
	check("every redial presented a valid pass", passes.redials.length > 0 && passes.redials.every((d) => d.code === passes.code && d.pass === "valid"), JSON.stringify(passes.redials));
	check("and the token kept a pass for the next one", !!passes.refreshed?.pass && passes.refreshed.exp >= passes.issued.exp, JSON.stringify(passes.refreshed));
	check("a release presents the pass too", passes.released === "released" && passes.release.length === 1 && passes.release[0].pass === "valid", JSON.stringify(passes.release));
	check("six more hosts: six server-drawn codes, all different", new Set(passes.codes).size === 6 && passes.codes.every((c) => /^\d{6}$/.test(c)), passes.codes.join());
	check("and not one named a code", passes.hostDials.every((d) => d.code === "new"), JSON.stringify(passes.hostDials));

	// ------------------------------- 6e5. two tabs, one rejoin token
	// Two tabs with the same token used to trade the seat every second:
	// each bind hung up the other's socket (4409), which redialled. The
	// one knocked off now stands down, and says so.
	console.log("\nroom: a second tab with the same token takes the seat once");
	const twins = await page.evaluate(async () => {
		const mock = window.__neonRoomMock;
		const wait = (ms) => new Promise((r) => setTimeout(r, ms));
		localStorage.removeItem("neon.room");
		const host = await NeonArcade.hostRoom({ name: "Host" });
		localStorage.removeItem("neon.room");
		let displaced = 0;
		const first = await NeonArcade.joinRoom(host.code, { name: "Twin", onDisplaced: () => displaced++ });
		// The second tab: same localStorage, so the same token and seat.
		const second = await NeonArcade.joinRoom(host.code, { name: "Twin", answerTimeoutMs: 20000 });
		const sameSeat = first.room.selfId === second.room.selfId;
		let dials = 0;
		const connect = mock.connect;
		mock.connect = (path) => (dials++, connect.call(mock, path));
		await wait(4000);
		mock.connect = connect;
		const out = {
			sameSeat,
			displaced,
			firstClosed: first.room.closed,
			secondLinked: second.room.directPeers().includes(host.room.selfId),
			dials,
			members: host.room.getMembers().length,
			token: NeonArcade.rejoinToken()?.id === second.room.selfId,
		};
		second.room.leave();
		host.room.leave();
		return out;
	});
	check("the second tab gets in, into the same seat", twins.sameSeat && twins.secondLinked, JSON.stringify(twins));
	check("the first is told, once", twins.displaced === 1, JSON.stringify(twins));
	check("and has let go of the party", twins.firstClosed, JSON.stringify(twins));
	check("nobody re-dials afterwards", twins.dials === 0, JSON.stringify(twins));
	check("the party still counts one of them", twins.members === 2, JSON.stringify(twins));
	check("the token is left for the tab that has the seat", twins.token, JSON.stringify(twins));

	// ------------------------------- 6e6. releaseRejoin never takes a live seat
	// Found 2026-11-11 (review): a stale tab pressing START A NEW PARTY gave
	// its claim back by joining with it and leaving — and the join hung up
	// the live tab holding that seat. A release now asks without binding.
	console.log("\nroom: releaseRejoin leaves another tab's live seat alone");
	const released = await page.evaluate(async () => {
		const mock = window.__neonRoomMock;
		localStorage.removeItem("neon.room");
		const host = await NeonArcade.hostRoom({ name: "Host" });
		localStorage.removeItem("neon.room");
		let displaced = 0;
		const live = await NeonArcade.joinRoom(host.code, { name: "Twin", onDisplaced: () => displaced++ });
		// The stale tab shares the token and releases it.
		const busy = await NeonArcade.releaseRejoin();
		await new Promise((r) => setTimeout(r, 200));
		const out = {
			busy,
			displaced,
			closed: live.room.closed,
			bound: !!mock.rooms.get(host.code)?.get(live.room.selfId)?.socket,
			token: NeonArcade.rejoinToken()?.id === live.room.selfId,
		};
		// And once that tab is gone too, the release goes through.
		window.__reload(live, NeonArcade.rejoinToken());
		out.later = await NeonArcade.releaseRejoin();
		out.claimAfter = !!mock.rooms.get(host.code)?.has(live.room.selfId);
		out.tokenAfter = NeonArcade.rejoinToken();
		host.room.leave();
		return out;
	});
	check("the release answers busy", released.busy === "busy", JSON.stringify(released));
	check("the live tab is not knocked off", released.displaced === 0 && !released.closed && released.bound, JSON.stringify(released));
	check("and keeps its token", released.token, JSON.stringify(released));
	check("a detached claim is released", released.later === "released" && !released.claimAfter, JSON.stringify(released));
	check("and its token dropped", released.tokenAfter === null, JSON.stringify(released));

	// ------------------------------- 6e7. a leave after the redial gave up
	// A redial answered no-room/full/id-taken is final; a leave after it used
	// to be "owed" and dial join *again* — charged, slow, and into whoever
	// re-hosted the code meanwhile.
	console.log("\nroom: a leave after a final redial failure dials nothing");
	const gaveUp = await page.evaluate(async () => {
		const mock = window.__neonRoomMock;
		const wait = (ms) => new Promise((r) => setTimeout(r, ms));
		localStorage.removeItem("neon.room");
		const host = await NeonArcade.hostRoom({ name: "Host" });
		localStorage.removeItem("neon.room");
		const errors = [];
		const g = (await NeonArcade.joinRoom(host.code, { name: "G", onError: (m) => errors.push(m) })).room;
		mock.drop(g.selfId);
		mock.rooms.delete(host.code); // and the room is gone by the redial
		for (let i = 0; i < 40 && !errors.length; i++) await wait(100);
		let dials = 0;
		const connect = mock.connect;
		mock.connect = (path) => (dials++, connect.call(mock, path));
		const started = Date.now();
		g.leave();
		await NeonArcade.roomSettled();
		const settledMs = Date.now() - started;
		await wait(300);
		mock.connect = connect;
		host.room.leave();
		return { errors: errors.length, dials, settledMs };
	});
	check("(the redial was refused: no-room)", gaveUp.errors === 1, JSON.stringify(gaveUp));
	check("the leave dials nothing", gaveUp.dials === 0, JSON.stringify(gaveUp));
	check("and settles at once", gaveUp.settledMs < 500, JSON.stringify(gaveUp));

	// ------------------------------- 6e8. a set-aside offer expires with ours
	// The OFFERING_MS backstop forgot our offer but kept the one we set
	// aside for it under the glare rule; a later failed invite then answered
	// that stale offer. Now the backstop answers it *then* (ours never left:
	// theirs is the pair's only offer) and keeps nothing for later.
	console.log("\nroom: the offer backstop forgets a glared offer too");
	const staleGlare = await page.evaluate(async () => {
		const mock = window.__neonRoomMock;
		const wait = (ms) => new Promise((r) => setTimeout(r, ms));
		localStorage.removeItem("neon.room");
		const host = await NeonArcade.hostRoom({ name: "Host", offerBackstopMs: 200 });
		const r = host.room;
		const socket = mock.rooms.get(host.code).get(r.selfId).socket;
		const say = (msg) => socket.onmessage({ data: JSON.stringify(msg) });
		const peer = "zzzzzzzzzzzz"; // above any drawn id: its offer is the one set aside
		const answered = [];
		r.createInvite = () => new Promise(() => {}); // our offer: in flight for good
		r.answerInvite = (sdp) => (answered.push(sdp), Promise.reject(new Error("test")));
		say({ t: "peer", id: peer, connected: true, offering: r.selfId });
		say({ t: "offer", from: peer, sdp: "STALE" });
		const setAside = answered.length === 0;
		await wait(400); // the backstop fires
		const atBackstop = answered.slice();
		r.createInvite = () => Promise.reject(new Error("no invite"));
		say({ t: "peer", id: peer, connected: true, offering: r.selfId });
		await wait(100);
		r.leave();
		return { setAside, atBackstop, answered };
	});
	check("(the glared offer was set aside)", staleGlare.setAside, JSON.stringify(staleGlare));
	check("the backstop answers the offer still set aside, once", staleGlare.atBackstop.join() === "STALE", JSON.stringify(staleGlare));
	check("a failed invite after the backstop answers no stale offer", staleGlare.answered.length === 1, JSON.stringify(staleGlare));

	// ------------------------------- 6e9. the re-announce never lets go first
	// An isolated member re-announces by re-dialling. It used to close its
	// socket first and dial a second later; a member returning inside that
	// gap found nobody attached, and when the first came back the server
	// named the *returning* one to offer (2026-11-12, two real networks: the
	// direction a port-dependent carrier NAT cannot connect in). Now the
	// new socket replaces the old on the server, and the seat is never
	// unattended — so whoever returns, the member who stayed offers.
	console.log("\nroom: an isolated member re-announces without letting go of its seat");
	const reannounce = await page.evaluate(async () => {
		const mock = window.__neonRoomMock;
		const wait = (ms) => new Promise((r) => setTimeout(r, ms));
		localStorage.removeItem("neon.room");
		const host = await NeonArcade.hostRoom({ name: "Host", reconnectGraceMs: 60_000 });
		localStorage.removeItem("neon.room");
		const g = await NeonArcade.joinRoom(host.code, { name: "G", reconnectGraceMs: 60_000 });
		for (let i = 0; i < 50 && host.room.directPeers().length === 0; i++) await wait(100);
		const token = NeonArcade.rejoinToken();
		const seat = () => mock.rooms.get(host.code)?.get(host.room.selfId);
		const firstSocket = seat()?.socket;
		let unattended = 0;
		const watcher = setInterval(() => !seat()?.socket && unattended++, 5);
		const invites = [];
		const create = host.room.createInvite.bind(host.room);
		host.room.createInvite = (o) => (invites.push(o?.forPeer ?? null), create(o));
		window.__reload(g, token);
		// Back at once: inside the second the host's socket used to be away.
		const back = await NeonArcade.joinRoom(host.code, { name: "G", reconnectGraceMs: 60_000 });
		await wait(1500);
		clearInterval(watcher);
		const out = {
			unattended,
			replaced: !!seat()?.socket && seat().socket !== firstSocket,
			oldClosed: firstSocket?.readyState === 3,
			hostOffered: invites.includes(back.room.selfId),
			linked: host.room.directPeers().includes(back.room.selfId),
			hostAlive: !host.room.closed,
		};
		back.room.leave();
		host.room.leave();
		return out;
	});
	check("the host's seat was never unattended", reannounce.unattended === 0, JSON.stringify(reannounce));
	check("its new socket replaced the old one (no displaced-tab verdict)", reannounce.replaced && reannounce.oldClosed && reannounce.hostAlive, JSON.stringify(reannounce));
	check("the member who stayed offered to the one who returned", reannounce.hostOffered && reannounce.linked, JSON.stringify(reannounce));

	// ------------------------------- 6e10. a failed route, roles swapped
	// Some NATs open only to a peer whose checks arrive first, so the
	// answerer (which checks first) can never connect to them. A pair whose
	// first ICE try fails is tried once more with the answerer offering.
	// The first try is broken here by its DTLS fingerprint, which fails the
	// connection as surely as a NAT and much sooner.
	console.log("\nroom: a pair whose first try fails is retried the other way round");
	const swapped = await page.evaluate(async () => {
		const { packSignal, unpackSignal } = NeonArcade._codec;
		localStorage.removeItem("neon.room");
		const errs = [];
		const host = await NeonArcade.hostRoom({ name: "Host", onError: (m) => errs.push(m) });
		const create = host.room.createInvite.bind(host.room);
		const offers = [];
		host.room.createInvite = async (o) => {
			const made = await create(o);
			offers.push(o);
			if (offers.length > 1) return made;
			const s = await unpackSignal(made.code);
			const sdp = s.sdp.replace(/(a=fingerprint:sha-256 )([0-9A-F]{2})/, (_, a, b) => a + (b === "00" ? "11" : "00"));
			return { ...made, code: await packSignal({ s: s.slot, i: s.peerId, n: s.name }, sdp) };
		};
		localStorage.removeItem("neon.room");
		const gErrs = [];
		const start = Date.now();
		let joined = null;
		let g = null;
		try {
			g = await NeonArcade.joinRoom(host.code, { name: "G", onError: (m) => gErrs.push(m) });
			joined = "ok";
		} catch (err) {
			joined = err.reason ?? String(err);
		}
		const out = {
			joined,
			ms: Date.now() - start,
			hostOffers: offers.length,
			linked: !!g && host.room.directPeers().includes(g.room.selfId),
			errs,
			gErrs,
		};
		g?.room.leave();
		host.room.leave();
		return out;
	});
	check("the join still succeeds", swapped.joined === "ok", JSON.stringify(swapped));
	check("the host offered once only: the second offer was the guest's", swapped.hostOffers === 1 && swapped.linked, JSON.stringify(swapped));
	check("nobody was told there was no route", swapped.errs.length === 0 && swapped.gErrs.length === 0, JSON.stringify(swapped));

	// ------------------------------- 6e11. an unanswered invite mutes nothing
	// Found 2026-11-12 (review): any invite minted for a peer counted as "a
	// negotiation with them still under way", and an invite nobody answers
	// never expires. One left over — a glare loser's offer the other side
	// set aside — silenced both the swap and the no-route verdict, and the
	// join ended "no-answer" at the deadline instead of connecting.
	console.log("\nroom: a leftover unanswered invite does not mute the swap");
	const leftover = await page.evaluate(async () => {
		const { packSignal, unpackSignal } = NeonArcade._codec;
		localStorage.removeItem("neon.room");
		const host = await NeonArcade.hostRoom({ name: "Host" });
		const hostId = host.room.selfId;
		const create = host.room.createInvite.bind(host.room);
		let n = 0;
		host.room.createInvite = async (o) => {
			const made = await create(o);
			if (++n > 1) return made;
			const s = await unpackSignal(made.code);
			const sdp = s.sdp.replace(/(a=fingerprint:sha-256 )([0-9A-F]{2})/, (_, a, b) => a + (b === "00" ? "11" : "00"));
			return { ...made, code: await packSignal({ s: s.slot, i: s.peerId, n: s.name }, sdp) };
		};
		const createGuest = NeonArcade.createGuest;
		NeonArcade.createGuest = (o) => {
			const r = createGuest(o);
			r.createInvite({ forPeer: hostId }).catch(() => {}); // never sent, never answered
			return r;
		};
		localStorage.removeItem("neon.room");
		const start = Date.now();
		let joined;
		let g = null;
		try {
			g = await NeonArcade.joinRoom(host.code, { name: "G", answerTimeoutMs: 15000 });
			joined = "ok";
		} catch (err) {
			joined = err.reason ?? String(err);
		}
		NeonArcade.createGuest = createGuest;
		const out = { joined, ms: Date.now() - start, hostOffers: n };
		g?.room.leave();
		host.room.leave();
		return out;
	});
	check("the join still connects, the other way round", leftover.joined === "ok" && leftover.hostOffers === 1, JSON.stringify(leftover));

	// The glue also closes the invites of its own that nobody will answer:
	// one the far side's glare rule set aside, one past the OFFERING_MS
	// backstop, one to a member whose socket dropped.
	console.log("\nroom: invites nobody will answer are closed");
	const dropped = await page.evaluate(async () => {
		const mock = window.__neonRoomMock;
		const wait = (ms) => new Promise((r) => setTimeout(r, ms));
		const unanswered = (r, peer) => [...r.pending.values()].filter((l) => l.forPeer === peer && !l.peerId).length;
		const setup = async (o = {}) => {
			localStorage.removeItem("neon.room");
			const h = await NeonArcade.hostRoom({ name: "H", ...o });
			const socket = mock.rooms.get(h.code).get(h.room.selfId).socket;
			const sent = [];
			const send = socket.send;
			socket.send = (raw) => (sent.push(JSON.parse(raw)), send.call(socket, raw));
			const say = (msg) => socket.onmessage({ data: JSON.stringify(msg) });
			const offered = async (peer) => {
				for (let i = 0; i < 60 && !sent.some((m) => m.t === "offer" && m.to === peer); i++) await wait(100);
			};
			return { h, sent, say, offered };
		};
		const out = {};
		// Glare, lost: the lower id's offer is answered and ours set aside there.
		{
			const { h, sent, say, offered } = await setup();
			const peer = "000000000000"; // below any drawn id: its offer stands
			say({ t: "peer", id: peer, connected: true, offering: h.room.selfId });
			await offered(peer);
			const before = unanswered(h.room, peer);
			const other = NeonArcade.createHost({ name: "Other" });
			const { code: theirs } = await other.createInvite();
			say({ t: "offer", from: peer, sdp: theirs });
			for (let i = 0; i < 60 && !sent.some((m) => m.t === "answer" && m.to === peer); i++) await wait(100);
			out.glare = { before, answered: sent.some((m) => m.t === "answer"), after: unanswered(h.room, peer) };
			other.leave();
			h.room.leave();
		}
		// The backstop.
		{
			const { h, say, offered } = await setup({ offerBackstopMs: 1500 });
			const peer = "zzzzzzzzzzzz";
			say({ t: "peer", id: peer, connected: true, offering: h.room.selfId });
			await offered(peer);
			const before = unanswered(h.room, peer);
			await wait(1700);
			out.backstop = { before, after: unanswered(h.room, peer) };
			h.room.leave();
		}
		// Their socket dropped.
		{
			const { h, say, offered } = await setup();
			const peer = "zzzzzzzzzzzz";
			say({ t: "peer", id: peer, connected: true, offering: h.room.selfId });
			await offered(peer);
			const before = unanswered(h.room, peer);
			say({ t: "peer", id: peer, connected: false });
			out.gone = { before, after: unanswered(h.room, peer) };
			h.room.leave();
		}
		return out;
	});
	for (const [label, k] of [["set aside by the far side's glare rule", "glare"], ["past the offer backstop", "backstop"], ["to a member whose socket dropped", "gone"]]) {
		check(`an invite ${label} is closed`, dropped[k].before === 1 && dropped[k].after === 0, JSON.stringify(dropped[k]));
	}
	check("(and the lower id's offer was answered)", dropped.glare.answered, JSON.stringify(dropped.glare));

	// ------------------------------- 6e12. only the marked retry skips glare
	// An offer from a member who had answered ours was taken as the swapped
	// retry, whatever it was — a plain one (a re-announce's) made a second
	// link for the pair, and each end's replace closed the other's. Only an
	// offer flagged as the retry inside its code skips the glare rule.
	console.log("\nroom: only the flagged retry skips the glare rule");
	const marked = await page.evaluate(async () => {
		const mock = window.__neonRoomMock;
		const wait = (ms) => new Promise((r) => setTimeout(r, ms));
		localStorage.removeItem("neon.room");
		const h = await NeonArcade.hostRoom({ name: "H" });
		const socket = mock.rooms.get(h.code).get(h.room.selfId).socket;
		const sent = [];
		const send = socket.send;
		socket.send = (raw) => (sent.push(JSON.parse(raw)), send.call(socket, raw));
		const say = (msg) => socket.onmessage({ data: JSON.stringify(msg) });
		const peer = "zzzzzzzzzzzz"; // above any drawn id: ours is the offer that stands
		h.room.createInvite = () => Promise.resolve({ code: "OURS" }); // in flight, never opens
		say({ t: "peer", id: peer, connected: true, offering: h.room.selfId });
		await wait(50);
		// Their answer to ours (for a slot this stub never made: ignored).
		say({ t: "answer", from: peer, sdp: await NeonArcade._codec.packSignal({ s: "none", i: peer }, "v=0\r\n") });
		const other = NeonArcade.createHost({ name: "Other" });
		const plain = (await other.createInvite()).code;
		const retry = (await other.createInvite({ retry: true })).code;
		say({ t: "offer", from: peer, sdp: plain });
		await wait(1500);
		const plainAnswered = sent.some((m) => m.t === "answer" && m.to === peer);
		say({ t: "offer", from: peer, sdp: retry });
		for (let i = 0; i < 60 && !sent.some((m) => m.t === "answer" && m.to === peer); i++) await wait(100);
		const retryAnswered = sent.some((m) => m.t === "answer" && m.to === peer);
		other.leave();
		h.room.leave();
		return { plainAnswered, retryAnswered };
	});
	check("a plain offer after they answered ours is still glare", !marked.plainAnswered, JSON.stringify(marked));
	check("the flagged retry is answered", marked.retryAnswered, JSON.stringify(marked));

	// ------------------------------- 6e13. a re-announce keeps answered offers
	// rejoinServer dials before it hangs up, so the server never forgot our
	// seat. An offer the peer has answered is negotiating directly: the new
	// socket cleared its guard anyway, and the next notice minted a second
	// invite — two links for one pair. An offer nobody answered may have
	// gone down a socket already dead (NAT lab scenario 5), so that one is
	// re-offered — with the stale invite closed, never two.
	console.log("\nroom: a re-announce keeps answered offers, re-offers the rest once");
	const kept = await page.evaluate(async () => {
		const mock = window.__neonRoomMock;
		const wait = (ms) => new Promise((r) => setTimeout(r, ms));
		const reannounce = async (answer) => {
			localStorage.removeItem("neon.room");
			const h = await NeonArcade.hostRoom({ name: "H" });
			const seat = () => mock.rooms.get(h.code).get(h.room.selfId);
			const first = seat().socket;
			const peer = "zzzzzzzzzzzz";
			let invites = 0;
			const create = h.room.createInvite.bind(h.room);
			h.room.createInvite = (o) => (invites++, create(o));
			const notice = (socket) => socket.onmessage({ data: JSON.stringify({ t: "peer", id: peer, connected: true, offering: h.room.selfId }) });
			notice(first);
			for (let i = 0; i < 60 && ![...h.room.pending.values()].some((l) => l.forPeer === peer); i++) await wait(50);
			await wait(1000); // gathered and sent
			// Their answer (for a slot nobody made: what matters is that it came).
			if (answer) first.onmessage({ data: JSON.stringify({ t: "answer", from: peer, sdp: await NeonArcade._codec.packSignal({ s: "none", i: peer }, "v=0\r\n") }) });
			h.room.onIsolated(); // what net.js calls when the last link goes
			for (let i = 0; i < 50 && seat().socket === first; i++) await wait(50);
			const replaced = seat().socket !== first;
			notice(seat().socket);
			await wait(1500);
			const open = [...h.room.pending.values()].filter((l) => l.forPeer === peer && !l.peerId).length;
			h.room.leave();
			return { replaced, invites, open };
		};
		return { answered: await reannounce(true), unanswered: await reannounce(false) };
	});
	check("(the new socket replaced the old)", kept.answered.replaced && kept.unanswered.replaced, JSON.stringify(kept));
	check("an answered offer is not minted twice", kept.answered.invites === 1, JSON.stringify(kept.answered));
	check("an unanswered one is offered again, its stale invite closed", kept.unanswered.invites === 2 && kept.unanswered.open === 1, JSON.stringify(kept.unanswered));

	// ------------------------------- 6e15. no offer from a socket being replaced
	// rejoinServer's dial can take seconds — a blackout holds its SYN back —
	// and the socket it replaces still delivers. Told to offer down that
	// socket, an isolated member offered with candidates gathered while its
	// own network was down (host only: STUN never answered); the peer
	// answered, its `answering` guard then muted its own offer on our
	// re-announce, and the dead offer was the pair's only one: no route,
	// for good (NAT lab scenario 5, 2026-11-12). The notice is deferred to
	// the dial landing — a network that works — not dropped: it is still
	// the server's word that we offer (6e9).
	console.log("\nroom: a member re-announcing does not offer down the socket it is replacing");
	const held = await page.evaluate(async () => {
		const mock = window.__neonRoomMock;
		const wait = (ms) => new Promise((r) => setTimeout(r, ms));
		localStorage.removeItem("neon.room");
		const h = await NeonArcade.hostRoom({ name: "H" });
		const seat = () => mock.rooms.get(h.code).get(h.room.selfId);
		const first = seat().socket;
		const peer = "zzzzzzzzzzzz";
		let invites = 0;
		const create = h.room.createInvite.bind(h.room);
		h.room.createInvite = (o) => (invites++, create(o));
		// Hold the re-announce's join on the wire for a while.
		const connect = mock.connect.bind(mock);
		mock.connect = (path) => {
			const ws = connect(path);
			const send = ws.send.bind(ws);
			ws.send = (raw) => (JSON.parse(raw).t === "join" ? setTimeout(() => send(raw), 1500) : send(raw));
			return ws;
		};
		h.room.onIsolated(); // what net.js calls when the last link goes
		await wait(100);
		const stillFirst = seat().socket === first;
		first.onmessage({ data: JSON.stringify({ t: "peer", id: peer, connected: true, offering: h.room.selfId }) });
		await wait(1000);
		const during = invites;
		for (let i = 0; i < 50 && seat().socket === first; i++) await wait(50);
		mock.connect = connect;
		const replaced = seat().socket !== first;
		await wait(1000);
		const landed = invites;
		// The server's next word changes nothing: that offer is out.
		seat().socket.onmessage({ data: JSON.stringify({ t: "peer", id: peer, connected: true, offering: h.room.selfId }) });
		await wait(1000);
		const after = invites;
		h.room.leave();
		return { stillFirst, during, replaced, landed, after };
	});
	check("(the dial was held, then replaced the old socket)", held.stillFirst && held.replaced, JSON.stringify(held));
	check("no offer is made from a notice on the socket being replaced", held.during === 0, JSON.stringify(held));
	check("…it is made once the dial lands, and only once", held.landed === 1 && held.after === 1, JSON.stringify(held));

	// ------------------------------- 6e14. the deadline waits for a swap
	// The join deadline fell while the swapped second try was about to
	// connect, and said no-route. A swap under way when it falls now gets
	// SWAP_WAIT_MS more, once — still always a verdict in the end.
	console.log("\nroom: the join deadline waits for a swap already under way");
	const late = await page.evaluate(async () => {
		const { packSignal, unpackSignal } = NeonArcade._codec;
		localStorage.removeItem("neon.room");
		const host = await NeonArcade.hostRoom({ name: "Host" });
		const create = host.room.createInvite.bind(host.room);
		let n = 0;
		host.room.createInvite = async (o) => {
			const made = await create(o);
			if (++n > 1) return made;
			const s = await unpackSignal(made.code);
			const sdp = s.sdp.replace(/(a=fingerprint:sha-256 )([0-9A-F]{2})/, (_, a, b) => a + (b === "00" ? "11" : "00"));
			return { ...made, code: await packSignal({ s: s.slot, i: s.peerId, n: s.name }, sdp) };
		};
		// The guest's swapped offer is slow: it goes out after the deadline.
		const createGuest = NeonArcade.createGuest;
		let failedAt = null;
		const start = Date.now();
		NeonArcade.createGuest = (o) => {
			const r = createGuest(o);
			const mint = r.createInvite.bind(r);
			r.createInvite = async (opts) => {
				failedAt = Date.now() - start;
				await new Promise((ok) => setTimeout(ok, 4000));
				return mint(opts);
			};
			return r;
		};
		localStorage.removeItem("neon.room");
		let joined;
		let g = null;
		try {
			g = await NeonArcade.joinRoom(host.code, { name: "G", answerTimeoutMs: 4000 });
			joined = "ok";
		} catch (err) {
			joined = err.reason ?? String(err);
		}
		NeonArcade.createGuest = createGuest;
		const out = { joined, ms: Date.now() - start, failedAt };
		g?.room.leave();
		host.room.leave();
		return out;
	});
	check("(the first try failed before the deadline)", late.failedAt !== null && late.failedAt < 4000, JSON.stringify(late));
	check("the swap connects past the deadline", late.joined === "ok" && late.ms > 4000, JSON.stringify(late));

	// ------------------------------- 6e16. a link that never says failed
	// An answering link was seen sitting in `connecting` for 25 s+ without
	// ever failing (Chrome, 2026-11-12), and while it sat there the pair was
	// "still trying": no swap, no verdict, and room-join's `answering`
	// guard muted our own offer. The open watchdog (net.js OPEN_TIMEOUT_MS)
	// treats it as failed. Simulated by a broken fingerprint (a real,
	// quick failure) whose `failed` the stuck side never gets to hear.
	console.log("\nroom: a link stuck in connecting is treated as failed");
	const stuck = await page.evaluate(async () => {
		const { packSignal, unpackSignal } = NeonArcade._codec;
		const wait = (ms) => new Promise((r) => setTimeout(r, ms));
		const breakCode = async (made) => {
			const s = await unpackSignal(made.code);
			const sdp = s.sdp.replace(/(a=fingerprint:sha-256 )([0-9A-F]{2})/, (_, a, b) => a + (b === "00" ? "11" : "00"));
			return { ...made, code: await packSignal({ s: s.slot, i: s.peerId, n: s.name, ...(s.retry ? { r: 1 } : {}) }, sdp) };
		};
		// `room`'s links matching `which` never hear `failed`; count what
		// the watchdog does about them.
		const silence = (room, which) => {
			const seen = { silenced: 0, failed: 0, routeFailed: 0 };
			const links = [];
			const watch = room._watch.bind(room);
			room._watch = (link) => {
				watch(link);
				if (!which(link)) return;
				links.push(link);
				const handler = link.pc.onconnectionstatechange;
				link.pc.onconnectionstatechange = () => {
					if (link.pc.connectionState === "failed") return void seen.silenced++;
					handler();
				};
			};
			const failed = room._linkFailed.bind(room);
			room._linkFailed = (link) => (which(link) && seen.failed++, failed(link));
			const routeFailed = room.onRouteFailed;
			room.onRouteFailed = (...a) => (seen.routeFailed++, routeFailed(...a));
			room.openTimeoutMs = 3000;
			// What a late `failed` would do, after the watchdog already has.
			seen.again = () => {
				const before = seen.routeFailed;
				for (const l of links) room._linkFailed(l);
				return seen.routeFailed - before;
			};
			return seen;
		};
		const out = {};
		// The joiner's first answer is the stuck one: the watchdog fails it,
		// the joiner offers back, and the join connects.
		{
			localStorage.removeItem("neon.room");
			const host = await NeonArcade.hostRoom({ name: "Host" });
			const create = host.room.createInvite.bind(host.room);
			let hostOffers = 0;
			host.room.createInvite = async (o) => {
				const made = await create(o);
				return ++hostOffers > 1 ? made : breakCode(made);
			};
			const createGuest = NeonArcade.createGuest;
			let seen = null;
			let room = null;
			let retries = 0;
			NeonArcade.createGuest = (o) => {
				room = createGuest(o);
				seen = silence(room, (l) => !l.offered && !l.retry);
				const mint = room.createInvite.bind(room);
				room.createInvite = (opts) => (opts?.retry && retries++, mint(opts));
				return room;
			};
			localStorage.removeItem("neon.room");
			const start = Date.now();
			let joined;
			let g = null;
			try {
				g = await NeonArcade.joinRoom(host.code, { name: "G", answerTimeoutMs: 15000 });
				joined = "ok";
			} catch (err) {
				joined = err.reason ?? String(err);
			}
			NeonArcade.createGuest = createGuest;
			const fired = seen.failed;
			const again = seen.again();
			out.join = { joined, ms: Date.now() - start, hostOffers, retries, ...seen, failed: fired, again, linked: !!g && host.room.directPeers().includes(g.room.selfId) };
			g?.room.leave();
			host.room.leave();
		}
		// The retry is stuck as well, on the side answering it: that side
		// still reaches a verdict, explicitly, instead of waiting for good.
		{
			localStorage.removeItem("neon.room");
			const errs = [];
			const host = await NeonArcade.hostRoom({ name: "Host", onError: (m, info) => errs.push(info?.reason ?? m) });
			const seen = silence(host.room, (l) => !l.offered && l.retry);
			const create = host.room.createInvite.bind(host.room);
			host.room.createInvite = async (o) => breakCode(await create(o));
			const createGuest = NeonArcade.createGuest;
			NeonArcade.createGuest = (o) => {
				const r = createGuest(o);
				const mint = r.createInvite.bind(r);
				r.createInvite = async (opts) => breakCode(await mint(opts));
				return r;
			};
			localStorage.removeItem("neon.room");
			let joined;
			try {
				await NeonArcade.joinRoom(host.code, { name: "G", answerTimeoutMs: 15000 });
				joined = "ok";
			} catch (err) {
				joined = err.reason ?? String(err);
			}
			NeonArcade.createGuest = createGuest;
			for (let i = 0; i < 100 && !errs.length; i++) await wait(100);
			await wait(500);
			out.retry = { joined, errs, ...seen, pending: host.room.pending.size };
			host.room.leave();
		}
		return out;
	});
	check("(the stuck side never heard failed)", stuck.join.silenced >= 1 && stuck.retry.silenced >= 1, JSON.stringify(stuck));
	check("the watchdog fails the stuck answer once, and the joiner offers back once", stuck.join.failed === 1 && stuck.join.routeFailed === 1 && stuck.join.retries === 1, JSON.stringify(stuck.join));
	check("a late failed after the watchdog does nothing", stuck.join.again === 0, JSON.stringify(stuck.join));
	check("…and the join connects the other way round", stuck.join.joined === "ok" && stuck.join.linked && stuck.join.hostOffers === 1, JSON.stringify(stuck.join));
	check("a stuck retry ends in an explicit no-route on the side stuck answering it", stuck.retry.failed === 1 && stuck.retry.errs.length === 1 && stuck.retry.errs[0] === "no-route", JSON.stringify(stuck.retry));
	check("…with nothing left pending", stuck.retry.pending === 0, JSON.stringify(stuck.retry));

	// ------------------------------- 6e17. a reply a person carries back
	// In the scan/paste flow the guest's reply goes back by QR, paste or a
	// link over chat — routinely longer than the open watchdog. The guest's
	// answer must not be on that clock (only room-join's machine-carried
	// answers are: answerInvite's `watch`), or its link is closed as
	// "no-route" while the reply is still on screen.
	console.log("\nroom: a manual reply accepted after the open watchdog still links");
	const slowReply = await page.evaluate(async () => {
		const wait = (ms) => new Promise((r) => setTimeout(r, ms));
		const errs = [];
		const host = NeonArcade.createHost({ name: "H", onError: (m, i) => errs.push("host:" + (i?.reason ?? m)) });
		const guest = NeonArcade.createGuest({ name: "G", onError: (m, i) => errs.push("guest:" + (i?.reason ?? m)) });
		host.resume?.();
		guest.resume?.();
		host.openTimeoutMs = 3000;
		guest.openTimeoutMs = 3000;
		const inv = await host.createInvite();
		const reply = await guest.answerInvite(inv.code ?? inv);
		// The person carrying it back: past two watchdog periods, since the
		// guest's ICE is up long before (the host answers its checks) and the
		// watchdog's one re-arm would otherwise hide the bug.
		await wait(7000);
		const guestPending = guest.pending.size;
		let accepted = "ok";
		try {
			await host.acceptAnswer(reply);
		} catch (err) {
			accepted = String(err.message ?? err);
		}
		for (let i = 0; i < 80 && !(host.directPeers().length && guest.directPeers().length); i++) await wait(100);
		const out = { guestPending, accepted, host: host.directPeers().length, guest: guest.directPeers().length, errs };
		host.leave();
		guest.leave();
		return out;
	});
	check("the guest still holds its answer after the watchdog period", slowReply.guestPending === 1, JSON.stringify(slowReply));
	check("…the host takes it late and both ends link, with no error", slowReply.accepted === "ok" && slowReply.host === 1 && slowReply.guest === 1 && slowReply.errs.length === 0, JSON.stringify(slowReply));

	// ------------------------------- 6e18. ICE up, channel not yet: once more
	// "Opened" means the data channel. A link whose ICE is connected when the
	// watchdog runs out may be DTLS/SCTP retrying under loss: it gets one
	// more period, never a second. Simulated by a reply nobody takes, its
	// connection's state pinned to ICE-connected or still checking.
	console.log("\nroom: the open watchdog re-arms once for a link whose ICE is up");
	const rearm = await page.evaluate(async () => {
		const wait = (ms) => new Promise((r) => setTimeout(r, ms));
		const T = 1500;
		const run = async (iceConnected) => {
			const host = NeonArcade.createHost({ name: "H" });
			const guest = NeonArcade.createGuest({ name: "G" });
			guest.openTimeoutMs = T;
			const fails = [];
			const failed = guest._linkFailed.bind(guest);
			let start = 0;
			guest._linkFailed = (l) => (fails.push(Date.now() - start), failed(l));
			const inv = await host.createInvite();
			const watch = guest._watch.bind(guest);
			// Pinned either way: a real offerer answers ICE checks before it
			// has our reply, so the untouched connection reads as ICE-up.
			guest._watch = (link) => {
				watch(link);
				Object.defineProperty(link.pc, "iceConnectionState", { get: () => (iceConnected ? "connected" : "checking") });
				Object.defineProperty(link.pc, "connectionState", { get: () => "connecting" });
				if (!iceConnected) Object.defineProperty(link.pc, "sctp", { get: () => null });
			};
			const answer = guest.answerInvite.bind(guest);
			// Start timing at the arming: just after gathering, inside answerInvite.
			const arm = guest._armOpen.bind(guest);
			guest._armOpen = (l, again) => (again || (start = Date.now()), arm(l, again));
			await answer(inv.code ?? inv, { watch: true });
			await wait(T * 3 + 1000);
			const out = { fails, pending: guest.pending.size };
			host.leave();
			guest.leave();
			return out;
		};
		return { plain: await run(false), up: await run(true) };
	});
	check("a link with no ICE path fails at one period", rearm.plain.fails.length === 1 && rearm.plain.fails[0] < 1500 + 700, JSON.stringify(rearm));
	check("a link with ICE up fails at two periods, not three", rearm.up.fails.length === 1 && rearm.up.fails[0] >= 3000 && rearm.up.fails[0] < 3000 + 700 && rearm.up.pending === 0, JSON.stringify(rearm));

	// ------------------------------- 6e19. a hard NAT's offer stands
	// Across a port-dependent (hard) NAT and a plain one only the hard side's
	// offer connects (docs/network-testing.md, 2026-11-12). After a reload
	// both ends offer and the lower id's stood — a coin flip, and the wrong
	// half waited ~18 s for the role swap. The glare rule now prefers the
	// offer marked hard (`h.`, net.js classifyNat); a hard member that is
	// offered to with nothing of its own in flight offers back instead.
	console.log("\nroom: glare prefers the hard-NAT offer");
	check("(the glare rule is exposed)", await page.evaluate(() => typeof NeonArcade._glareWinner === "function"));
	const rule = await page.evaluate(() => {
		const w = NeonArcade._glareWinner;
		return [w("a", false, "b", false), w("b", false, "a", false), w("b", true, "a", false), w("a", false, "b", true), w("a", true, "b", true), w("b", true, "a", true)];
	});
	check("neither or both hard: the lower id's offer stands", rule[0] === "a" && rule[1] === "a" && rule[4] === "a" && rule[5] === "a", JSON.stringify(rule));
	check("exactly one hard: the hard side's stands, whatever the ids", rule[2] === "b" && rule[3] === "b", JSON.stringify(rule));
	const pref = await page.evaluate(async () => {
		const mock = window.__neonRoomMock;
		const wait = (ms) => new Promise((r) => setTimeout(r, ms));
		// H with `natHard` pinned, its own offer stubbed (never opens); the
		// peer's offers are real codes from another room, marked or not.
		const run = async ({ natHard, peer, theirsHard, ours }) => {
			localStorage.removeItem("neon.room");
			const h = await NeonArcade.hostRoom({ name: "H", natHard });
			const socket = mock.rooms.get(h.code).get(h.room.selfId).socket;
			const sent = [];
			const send = socket.send;
			socket.send = (raw) => (sent.push(JSON.parse(raw)), send.call(socket, raw));
			const say = (msg) => socket.onmessage({ data: JSON.stringify(msg) });
			const asked = [];
			h.room.createInvite = (o) => (asked.push(o), Promise.resolve({ code: (o.hard ? "h." : "") + "OURS" }));
			if (ours) say({ t: "peer", id: peer, connected: true, offering: h.room.selfId });
			await wait(50);
			const other = NeonArcade.createHost({ name: "Other" });
			say({ t: "offer", from: peer, sdp: (await other.createInvite({ hard: theirsHard })).code });
			for (let i = 0; i < 30 && !sent.some((m) => m.to === peer && (m.t === "answer" || m.t === "offer")); i++) await wait(100);
			await wait(300);
			const offers = sent.filter((m) => m.t === "offer" && m.to === peer).map((m) => m.sdp);
			const answered = sent.some((m) => m.t === "answer" && m.to === peer);
			other.leave();
			h.room.leave();
			return { offers, answered, asked: asked.map((o) => !!o.hard) };
		};
		const low = "000000000000"; // below any drawn id: the lower id's rule favours them
		const high = "zzzzzzzzzzzz";
		return {
			// Both in flight: H (hard, higher id) keeps its own.
			hardKeeps: await run({ natHard: true, peer: low, theirsHard: false, ours: true }),
			// Both in flight: H (plain, lower id) yields to a hard offer.
			softYields: await run({ natHard: false, peer: high, theirsHard: true, ours: true }),
			// Unknown NAT: the lower-id rule, unchanged.
			unknown: await run({ natHard: null, peer: low, theirsHard: false, ours: true }),
			// Nothing in flight, H hard, a plain offer: H offers back, marked.
			counter: await run({ natHard: true, peer: low, theirsHard: false, ours: false }),
			// …but never to a hard offer: both hard, it is answered.
			bothHard: await run({ natHard: true, peer: low, theirsHard: true, ours: false }),
		};
	});
	check("a hard member keeps its offer over a plain one from a lower id", !pref.hardKeeps.answered && pref.hardKeeps.offers.length === 1 && pref.hardKeeps.offers[0] === "h.OURS", JSON.stringify(pref.hardKeeps));
	check("a plain member answers a hard offer from a higher id, its own dropped", pref.softYields.answered && pref.softYields.offers.length === 1 && pref.softYields.offers[0] === "OURS", JSON.stringify(pref.softYields));
	check("an unknown NAT keeps the lower-id rule", pref.unknown.answered && pref.unknown.offers[0] === "OURS", JSON.stringify(pref.unknown));
	check("a hard member offered to out of the blue offers back, marked, and does not answer", !pref.counter.answered && pref.counter.offers.length === 1 && pref.counter.offers[0] === "h.OURS", JSON.stringify(pref.counter));
	check("a hard offer to a hard member is answered, not countered", pref.bothHard.answered && pref.bothHard.offers.length === 0, JSON.stringify(pref.bothHard));
	// The whole exchange through the mock, two real rooms: the plain host is
	// told to offer, the hard guest offers back, the host's glare rule lets
	// the guest's stand — so the link in use is the guest's offer.
	const e2e = await page.evaluate(async () => {
		const run = async (hostHard, guestHard) => {
			localStorage.removeItem("neon.room");
			const h = await NeonArcade.hostRoom({ name: "H", natHard: hostHard });
			localStorage.removeItem("neon.room");
			const g = await NeonArcade.joinRoom(h.code, { name: "G", natHard: guestHard });
			const link = g.room.links.get(h.room.selfId);
			const out = { offeredByGuest: !!link?.offered, links: [h.room.links.size, g.room.links.size] };
			g.room.leave();
			h.room.leave();
			return out;
		};
		return { guestHard: await run(false, true), hostHard: await run(true, false), neither: await run(false, false) };
	});
	check("a hard guest joining a plain host: its own offer is the link", e2e.guestHard.offeredByGuest && e2e.guestHard.links.join() === "1,1", JSON.stringify(e2e));
	check("a hard host: the host's offer, as before", !e2e.hostHard.offeredByGuest && e2e.hostHard.links.join() === "1,1", JSON.stringify(e2e));
	check("neither hard: the host's offer, as before", !e2e.neither.offeredByGuest && e2e.neither.links.join() === "1,1", JSON.stringify(e2e));

	// ------------------------------- 6e20. an offer back nobody answers
	// A tab still on the build before the `h.` mark cannot read a marked
	// offer (its base64 decode throws, and the throw is swallowed): it
	// never answers. A hard member that set that tab's plain offer aside to
	// offer back — or won ordinary glare against it — waited for that
	// answer until the 20 s backstop, which then dropped theirs too, and
	// the join ended `no-answer`. Now ours is given up after
	// GLARE_FALLBACK_MS (6 s from ours leaving) and theirs is answered.
	console.log("\nroom: an offer nobody answers yields to the one set aside");
	const fallback = await page.evaluate(async () => {
		const mock = window.__neonRoomMock;
		const wait = (ms) => new Promise((r) => setTimeout(r, ms));
		const run = async ({ natHard, ours, answerOurs }) => {
			localStorage.removeItem("neon.room");
			const h = await NeonArcade.hostRoom({ name: "H", natHard });
			const socket = mock.rooms.get(h.code).get(h.room.selfId).socket;
			const say = (msg) => socket.onmessage({ data: JSON.stringify(msg) });
			// The old tab: a real room whose offer is real, and which never
			// answers H's (H's own invite is a stub that goes nowhere).
			const old = NeonArcade.createHost({ name: "Old", selfId: ours ? "zzzzzzzzzzzz" : "000000000000" });
			const peer = old.selfId;
			const sent = [];
			const send = socket.send;
			socket.send = (raw) => {
				const m = JSON.parse(raw);
				sent.push({ ...m, at: performance.now() });
				// H's answer reaches the old tab, which takes it.
				if (m.t === "answer" && m.to === peer) old.acceptAnswer(m.sdp).catch(() => {});
				return send.call(socket, raw);
			};
			h.room.createInvite = (o) => Promise.resolve({ code: (o.hard ? "h." : "") + "OURS" });
			// When H decides to answer (its gather comes after, and is the
			// network's time, not the rule's).
			let answering = null;
			const answerInvite = h.room.answerInvite.bind(h.room);
			h.room.answerInvite = (...a) => ((answering ??= performance.now()), answerInvite(...a));
			if (ours) say({ t: "peer", id: peer, connected: true, offering: h.room.selfId });
			await wait(50);
			const theirs = (await old.createInvite()).code;
			say({ t: "offer", from: peer, sdp: theirs });
			const offerAt = () => sent.find((m) => m.t === "offer" && m.to === peer)?.at;
			for (let i = 0; i < 20 && !offerAt(); i++) await wait(50);
			// A well-formed code for no slot of H's: taken as an answer, ignored.
			if (answerOurs) say({ t: "answer", from: peer, sdp: theirs });
			for (let i = 0; i < 100 && !(h.room.links.get(peer)?.open && old.links.get(h.room.selfId)?.open); i++) await wait(100);
			const out = {
				offered: sent.filter((m) => m.t === "offer" && m.to === peer).map((m) => m.sdp),
				answeredAfter: answering && offerAt() ? Math.round(answering - offerAt()) : null,
				linked: !!h.room.links.get(peer)?.open,
			};
			old.leave();
			h.room.leave();
			return out;
		};
		const [counter, glare, answered] = await Promise.all([
			// H hard, offered to out of the blue: offers back, marked.
			run({ natHard: true, ours: false }),
			// H plain, the lower id, both in flight: ours stands, theirs aside.
			run({ natHard: false, ours: true }),
			// Ours *is* answered (the far side took it): no fallback.
			run({ natHard: true, ours: false, answerOurs: true }),
		]);
		return { counter, glare, answered };
	});
	check("(a hard member offered back, marked)", fallback.counter.offered.join() === "h.OURS", JSON.stringify(fallback.counter));
	check("its offer unanswered, it answers the one set aside within 6–7 s", fallback.counter.answeredAfter >= 5900 && fallback.counter.answeredAfter <= 7000, JSON.stringify(fallback.counter));
	check("…and the pair links", fallback.counter.linked, JSON.stringify(fallback.counter));
	check("the glare winner unanswered: the same", fallback.glare.offered.join() === "OURS" && fallback.glare.answeredAfter >= 5900 && fallback.glare.answeredAfter <= 7000 && fallback.glare.linked, JSON.stringify(fallback.glare));
	check("an offer that was answered keeps the other set aside", fallback.answered.answeredAfter === null && !fallback.answered.linked, JSON.stringify(fallback.answered));

	// ------------------------------- 6e21. the NAT is asked again
	// The classification was once per page: a phone that moved from its
	// carrier's hard NAT onto Wi-Fi stayed "hard" until reloaded, and kept
	// offering back in a direction that may now fail. room-join re-asks
	// (`fresh`) when it finds itself isolated and on the browser's network
	// events; the next offer carries the new verdict.
	console.log("\nroom: the NAT is classified again after a network change");
	const reask = await page.evaluate(async () => {
		const mock = window.__neonRoomMock;
		const wait = (ms) => new Promise((r) => setTimeout(r, ms));
		const real = NeonArcade.classifyNat;
		let verdict = true;
		const asks = [];
		NeonArcade.classifyNat = (servers, o) => (asks.push(!!o?.fresh), Promise.resolve(verdict));
		try {
			localStorage.removeItem("neon.room");
			const h = await NeonArcade.hostRoom({ name: "H" });
			const socket = mock.rooms.get(h.code).get(h.room.selfId).socket;
			const say = (msg) => socket.onmessage({ data: JSON.stringify(msg) });
			const marks = [];
			h.room.createInvite = (o) => (marks.push(!!o.hard), new Promise(() => {}));
			await wait(20);
			const first = h.room.natHard;
			say({ t: "peer", id: "aaaaaaaaaaa1", connected: true, offering: h.room.selfId });
			verdict = false;
			// Rooms other sections left open are listening too: count what
			// one event asks, before and after ours leaves.
			let before = asks.length;
			dispatchEvent(new Event("online"));
			const perEvent = asks.length - before;
			await wait(20);
			const afterOnline = h.room.natHard;
			say({ t: "peer", id: "aaaaaaaaaaa2", connected: true, offering: h.room.selfId });
			verdict = true;
			h.room.onIsolated(); // rejoinServer: re-dials, and re-asks
			await wait(200); // the replacing dial lands (mock)
			const afterIsolated = h.room.natHard;
			const fresh = mock.rooms.get(h.code).get(h.room.selfId).socket;
			fresh.onmessage({ data: JSON.stringify({ t: "peer", id: "aaaaaaaaaaa3", connected: true, offering: h.room.selfId }) });
			h.room.leave();
			before = asks.length;
			dispatchEvent(new Event("online")); // a left room asks nothing
			const afterLeave = asks.length - before;
			await wait(20);
			// A pinned room never asks.
			localStorage.removeItem("neon.room");
			const p = await NeonArcade.hostRoom({ name: "P", natHard: false });
			before = asks.length;
			dispatchEvent(new Event("online"));
			const withPinned = asks.length - before;
			await wait(20);
			const pinned = p.room.natHard;
			p.room.leave();
			return { first, afterOnline, afterIsolated, marks, asks, perEvent, afterLeave, withPinned, pinned };
		} finally {
			NeonArcade.classifyNat = real;
		}
	});
	check("the first verdict is taken", reask.first === true, JSON.stringify(reask));
	check("an `online` event asks afresh, and the next offer carries the new verdict", reask.afterOnline === false && reask.marks[1] === false && reask.asks.slice(1).every(Boolean), JSON.stringify(reask));
	check("isolation (rejoinServer) asks afresh too", reask.afterIsolated === true && reask.marks[2] === true, JSON.stringify(reask));
	check("a left room stops listening; a pinned room never asks", reask.perEvent >= 1 && reask.afterLeave === reask.perEvent - 1 && reask.withPinned === reask.afterLeave && reask.pinned === false, JSON.stringify(reask));
	// The real classifier's memory: per set of STUN servers, and a set
	// that cannot tell never stands in for another.
	const cache = await page.evaluate(async () => {
		NeonArcade._pinNat(undefined);
		try {
			const two = [{ urls: "stun:127.0.0.1:9" }, { urls: "stun:127.0.0.1:7" }];
			const one = [{ urls: "stun:127.0.0.1:9" }];
			const short = await NeonArcade.classifyNat(one);
			const a = NeonArcade.classifyNat(two);
			const b = NeonArcade.classifyNat([...two].reverse());
			const c = NeonArcade.classifyNat(two, { fresh: true });
			const d = NeonArcade.classifyNat(two);
			return { short, a: a !== null, same: a === b, fresh: c !== a, kept: d === c, other: NeonArcade.classifyNat([{ urls: "stun:127.0.0.1:9" }, { urls: "stun:127.0.0.1:5" }]) !== a };
		} finally {
			NeonArcade._pinNat(null);
		}
	});
	check("fewer than two STUN servers: null, and nothing remembered for others", cache.short === null && cache.a, JSON.stringify(cache));
	// The verdict itself, over a stubbed candidate stream. A soft IPv4 NAT
	// on a host with an unroutable IPv6 address (bhaskara, 2026-11-12):
	// both IPv4 answers in 45 ms, one mapping; IPv6 requests time out (701)
	// and gathering never completes in time. It read null; it is soft.
	const verdicts = await page.evaluate(async () => {
		const Real = window.RTCPeerConnection;
		const srflx = (addr, port, f = "1") => ({ candidate: { candidate: `candidate:${f} 1 udp 1686052607 ${addr} ${port} typ srflx raddr 0.0.0.0 rport 0` } });
		const run = (script) => {
			window.RTCPeerConnection = class {
				createDataChannel() {}
				async createOffer() {
					return {};
				}
				async setLocalDescription() {
					for (const [ms, ev] of script) {
						setTimeout(() => (ev === "end" ? this.onicecandidate?.({ candidate: null }) : ev.errorCode ? this.onicecandidateerror?.(ev) : this.onicecandidate?.(ev)), ms);
					}
				}
				close() {}
			};
			const t0 = performance.now();
			const p = NeonArcade.classifyNat([{ urls: "stun:a.test:3478" }, { urls: "stun:b.test:19302" }], { fresh: true });
			window.RTCPeerConnection = Real; // the constructor has run
			return p.then((v) => ({ v, ms: Math.round(performance.now() - t0) }));
		};
		NeonArcade._pinNat(undefined);
		try {
			const v6err = (ms) => [ms, { errorCode: 701, address: "fd7a:115c:a1e0::x", url: "stun:a.test:3478" }];
			const [softV4, hardV4, v4err, unknownErr, complete] = await Promise.all([
				run([[45, srflx("14.139.128.10", 43774)], v6err(100), v6err(150)]),
				run([[40, srflx("223.181.108.216", 7085)], [60, srflx("223.181.108.216", 31597)], v6err(100)]),
				run([[45, srflx("14.139.128.10", 43774)], [80, { errorCode: 701, address: "10.0.0.x", url: "stun:b.test:19302" }]]),
				run([[45, srflx("14.139.128.10", 43774)], [80, { errorCode: 701, address: "", url: "stun:b.test:19302" }]]),
				run([[45, srflx("14.139.128.10", 43774)], [60, "end"]]),
			]);
			return { softV4, hardV4, v4err, unknownErr, complete };
		} finally {
			window.RTCPeerConnection = Real;
			NeonArcade._pinNat(null);
		}
	});
	check("IPv4 one mapping, IPv6 timing out (701): soft, without waiting out IPv6", verdicts.softV4.v === false && verdicts.softV4.ms < 3000, JSON.stringify(verdicts));
	check("two ports for one base: hard at once, whatever IPv6 does", verdicts.hardV4.v === true && verdicts.hardV4.ms < 500, JSON.stringify(verdicts));
	check("an error in the mapped family itself still means unknown", verdicts.v4err.v === null && verdicts.unknownErr.v === null, JSON.stringify(verdicts));
	check("gathering complete with one mapping and no error: soft at once", verdicts.complete.v === false && verdicts.complete.ms < 500, JSON.stringify(verdicts));
	check("one classification per set of servers, re-asked only when fresh", cache.same && cache.fresh && cache.kept && cache.other, JSON.stringify(cache));

	// ------------------------------- 6f. late news of a departed member
	// A `rs` or `back` vouch can arrive after its subject has left; the host
	// once seated them again as "Player".
	// ------------------- 6e22. a returning host is heard by everyone
	// Three members; the host reloads. The server names the oldest stayer
	// (A) to offer, and A relinks inside its own departure grace, so A
	// never doubted the host. The other stayer (B) did conclude the host
	// gone first — its vouch request went out while every link to the host
	// was down — so it holds the host's seat RECONNECTING and has computed
	// A as heir (unheard). B's _meshUp skips a held seat, and the host,
	// the higher id, never offers to B over the relay: before 2026-11-12
	// nobody told B the host was back, and B stayed unlinked with its own
	// crown for good (NAT lab scenario 11, a cone host and two carriers).
	// Now a returning host that adopts a record naming itself publishes it.
	console.log("\nroom: a returning host's record reaches a member who gave up on it");
	const heard = await page.evaluate(async () => {
		const wait = (ms) => new Promise((r) => setTimeout(r, ms));
		localStorage.removeItem("neon.room");
		const h = await NeonArcade.hostRoom({ name: "H", reconnectGraceMs: 60_000 });
		const hToken = NeonArcade.rejoinToken();
		localStorage.removeItem("neon.room");
		const a = await NeonArcade.joinRoom(h.code, { name: "A", reconnectGraceMs: 60_000 });
		// B under the lowest id there is, so B is the one who must offer.
		localStorage.setItem("neon.room", JSON.stringify({ code: h.code, id: "000000000000", secret: "lowest-id" }));
		const b = await NeonArcade.joinRoom(h.code, { name: "B", reconnectGraceMs: 60_000 });
		const hid = h.room.selfId;
		for (let i = 0; i < 100 && !(b.room.directPeers().includes(a.room.selfId) && b.room.directPeers().includes(hid)); i++) await wait(100);
		const meshed = b.room.directPeers().length === 2;
		window.__reload(h, hToken);
		// B's own conclusion, as if its vouch request found nobody linked.
		b.room._confirmGone(hid);
		const bGaveUp = !!b.room.party.members.find((m) => m.id === hid)?.reconnecting && b.room.hostId() !== hid;
		const back = await NeonArcade.joinRoom(h.code, { name: "H", reconnectGraceMs: 60_000 });
		let ok = false;
		for (let i = 0; i < 100 && !ok; i++) {
			await wait(100);
			ok =
				b.room.directPeers().includes(hid) &&
				b.room.hostId() === hid &&
				b.room.getMembers().every((m) => !m.reconnecting) &&
				back.room.directPeers().length === 2;
		}
		const out = {
			meshed,
			bGaveUp,
			ok,
			bPeers: b.room.directPeers(),
			bHost: b.room.hostId(),
			hid,
			bRc: b.room.getMembers().filter((m) => m.reconnecting).map((m) => m.id),
			hostPeers: back.room.directPeers().length,
		};
		for (const r of [b, a, back]) r.room.leave();
		return out;
	});
	check("three members meshed before the host's reload", heard.meshed, JSON.stringify(heard));
	check("B held the host's seat and computed another heir", heard.bGaveUp, JSON.stringify(heard));
	check("the returning host's record reaches B: B links to it and names it host", heard.ok, JSON.stringify(heard));

	// --------- 6e23. a member back from a reload, and a lost relayed offer
	// Three members; A reloads. B (the lowest id, so B offers over the
	// relay) suspected A while nobody held a link to it. The host relinks A,
	// and its commit sends B's relayed offer on its way — through a host
	// that, in NAT lab scenario 11, did not hold A's link yet: the offer was
	// lost. B then concluded A gone (RECONNECTING; _meshUp skips a held
	// seat) and, A being the higher id, nobody offered again: unmeshed for
	// good. Now a new link is announced (`__alive`, so a suspicion it
	// answers is settled) and an expired relayed offer that was never
	// answered is sent once more.
	console.log("\nroom: a third member does not give up on one back from a reload");
	// `drops`: 1, the host loses the copy of B's offer sent before anyone
	// was linked to A, and the copy B sends again on an `__alive` links
	// them at once; "all", it loses every copy of that offer (same id), and
	// only the expiry's fresh offer is left.
	const lostOffer = (drops) =>
		page.evaluate(async (drops) => {
			const wait = (ms) => new Promise((r) => setTimeout(r, ms));
			localStorage.removeItem("neon.room");
			const h = await NeonArcade.hostRoom({ name: "H", reconnectGraceMs: 60_000 });
			localStorage.removeItem("neon.room");
			let a = await NeonArcade.joinRoom(h.code, { name: "A", reconnectGraceMs: 60_000 });
			const aToken = NeonArcade.rejoinToken();
			localStorage.setItem("neon.room", JSON.stringify({ code: h.code, id: "000000000000", secret: `lowest-id-${drops}` }));
			const b = await NeonArcade.joinRoom(h.code, { name: "B", reconnectGraceMs: 60_000 });
			const aid = a.room.selfId;
			for (let i = 0; i < 100 && b.room.directPeers().length < 2; i++) await wait(100);
			const meshed = b.room.directPeers().length === 2;
			b.room.relayTimeoutMs = 4000;
			// The host loses B's relayed offers to A, as a forwarder with no
			// link to A yet does.
			let dropped = 0;
			let first = null;
			const inbound = h.room._inbound.bind(h.room);
			h.room._inbound = (link, msg) => {
				if (msg?.__g === "offer" && msg.f === b.room.selfId && msg.t === aid) {
					first ??= msg.id;
					if (drops === "all" ? msg.id === first : dropped < drops) return void dropped++;
				}
				return inbound(link, msg);
			};
			window.__reload(a, aToken);
			a = await NeonArcade.joinRoom(h.code, { name: "A", reconnectGraceMs: 60_000 });
			let gaveUp = false;
			let linked = false;
			const t0 = Date.now();
			while (Date.now() - t0 < 12_000 && !linked) {
				await wait(100);
				if (b.room.party.members.find((m) => m.id === aid)?.reconnecting) gaveUp = true;
				linked = b.room.directPeers().includes(aid) && a.room.directPeers().includes(b.room.selfId);
			}
			const out = { meshed, dropped, gaveUp, linked, ms: Date.now() - t0 };
			for (const r of [b, a, h]) r.room.leave();
			return out;
		}, drops);
	const once = await lostOffer(1);
	check("three members meshed, and B's first relayed offer to A was lost", once.meshed && once.dropped === 1, JSON.stringify(once));
	check("B never held A's seat as RECONNECTING (the host's new link vouched)", !once.gaveUp, JSON.stringify(once));
	check("B sent the same offer again on the host's __alive: linked well inside the relay expiry", once.linked && once.ms < 3000, JSON.stringify(once));
	const all = await lostOffer("all");
	check("every copy lost: the expired, unanswered offer is made afresh and links", all.dropped >= 1 && all.linked && all.ms >= 3000, JSON.stringify(all));

	console.log("\nroom: a late vouch does not resurrect anybody");
	const ghost = await page.evaluate(async () => {
		localStorage.removeItem("neon.room");
		const host = await NeonArcade.hostRoom({ name: "Host" });
		const before = host.room.getMembers().length;
		host.room._inbound(null, { __i: { id: "ghost1", rs: true }, f: "other", t: host.room.selfId, id: "late-rs" });
		host.room._inbound(null, { __i: { id: "ghost2", back: true }, f: "other", t: host.room.selfId, id: "late-back" });
		const after = host.room.getMembers().length;
		host.room.leave();
		return { before, after };
	});
	check("the host's roster is unchanged", ghost.before === ghost.after, JSON.stringify(ghost));

	// -------------------------------------------------- 7. the UI
	console.log("\nroom: the screens");
	const ui = await context.newPage();
	// The earlier sections left a rejoin token in localStorage; without this
	// the boot would try to reconnect into a room this page's mock never had.
	await ui.addInitScript(() => localStorage.removeItem("neon.room"));
	await ui.goto(PAGE("party.html", "?mockroom=1"));
	// The boot itself hosts through the room server, which writes the token;
	// let it finish, then clear the token and reload, so the reloaded page is
	// a FRESH host rather than a reconnect into this page's now-orphaned one.
	await ui.locator(".party-member").first().waitFor({ timeout: TIMEOUT });
	await ui.evaluate(() => localStorage.removeItem("neon.room"));
	await ui.reload();
	await ui.locator(".party-code-digits").waitFor({ timeout: TIMEOUT });
	const digits = await ui.locator(".party-code-digits").textContent();
	check("the party screen shows the code big", /^\d{6}$/.test(digits.trim()), digits);
	check(
		"the roster renders one member",
		(await ui.locator(".party-member").allTextContents()).length === 1,
	);

	// A code link into a fresh page joins straight away — and a code no room
	// is meeting answers with an explicit error, never a silent wait.
	const bad = await context.newPage();
	await bad.goto(PAGE("party.html", "?mockroom=1#c=123456"));
	await bad.locator(".lobby-status").first().waitFor({ timeout: TIMEOUT });
	check(
		"a dead code says so explicitly",
		await until(
			bad,
			() => /no longer meeting|not reachable/i.test(
				document.querySelector(".lobby-status")?.textContent ?? "",
			),
			undefined,
			"error status",
		),
	);
	check(
		"a dead code still offers a way out",
		(await bad.locator("button", { hasText: "START A NEW PARTY" }).count()) > 0,
	);

	// START A NEW PARTY while another tab of this browser holds the token's
	// seat live: the release answers busy, and this tab says so instead of
	// giving the seat away or hosting a party that would take the token.
	const twinTab = await bad.evaluate(async () => {
		localStorage.removeItem("neon.room");
		const host = await NeonArcade.hostRoom({ name: "Host" });
		localStorage.removeItem("neon.room");
		window.__twinTab = await NeonArcade.joinRoom(host.code, { name: "Twin" });
		return window.__twinTab.room.selfId;
	});
	await bad.locator("button", { hasText: "START A NEW PARTY" }).first().click();
	check(
		"START A NEW PARTY over a live seat says it is open in another tab",
		await until(
			bad,
			() => /open in another tab/i.test(document.querySelector(".lobby-status")?.textContent ?? ""),
			undefined,
			"busy status",
		),
	);
	const twinAfter = await bad.evaluate(() => ({
		url: location.search,
		token: NeonArcade.rejoinToken()?.id,
		closed: window.__twinTab.room.closed,
		useHere: [...document.querySelectorAll("button")].some((b) => b.textContent === "USE THIS TAB INSTEAD"),
	}));
	check("no new party was started", !/fresh/.test(twinAfter.url), JSON.stringify(twinAfter));
	check("the other tab keeps its seat and its token", twinAfter.token === twinTab && !twinAfter.closed, JSON.stringify(twinAfter));
	check("and USE THIS TAB INSTEAD is offered", twinAfter.useHere, JSON.stringify(twinAfter));

	// `?rs=` is honoured only when it names this machine: a link that could
	// pick the signalling server could swap the DTLS fingerprints in the
	// SDP it relays and sit in the middle of every data channel.
	const rsRule = await bad.evaluate(() => NeonArcade._roomServerBase);
	check("(the base resolver is exposed for this check)", typeof rsRule === "string");
	for (const [rs, ok] of [
		["https://evil.example", false],
		["http://127.0.0.1:8787", true],
		["http://localhost:1", true],
		["http://[::1]:8787", true],
		["http://127.0.0.1.evil.example", false],
	]) {
		const probe = await context.newPage();
		await probe.goto(PAGE("scripts/room-harness.html", "?rs=" + encodeURIComponent(rs)));
		const base = await probe.evaluate(() => NeonArcade._roomServerBase);
		check(`?rs=${rs} is ${ok ? "honoured" : "ignored"}`, ok ? base.startsWith(rs.replace(/^http/, "ws")) : !base.includes("evil"), base);
		await probe.close();
	}

	// ------------------------------------------- 8. the fallback path
	console.log("\nroom: the zero-server fallback");
	// A game page opens the party shell; with no room server it offers the
	// classic invite, and no code that nobody could use.
	const plain = await context.newPage();
	await plain.goto(PAGE("connect4.html", "?rs=http://localhost:1"));
	await plain.locator("button", { hasText: "INVITE A FRIEND" }).waitFor({ timeout: TIMEOUT });
	check("a game page still offers the classic invite", true);
	check("…and shows no party code without the room server", (await plain.locator(".party-code-digits").count()) === 0);
	const plainParty = await context.newPage();
	await plainParty.goto(PAGE("party.html", "?rs=http://localhost:1"));
	await plainParty.evaluate(() => localStorage.removeItem("neon.room"));
	await plainParty.reload();
	await plainParty.locator(".party-member").first().waitFor({ timeout: TIMEOUT });
	check(
		"the party screen hosts classically without the room server",
		(await plainParty.locator(".party-code-digits").count()) === 0,
	);
} catch (err) {
	console.log(`  FAIL unexpected: ${err.message}`);
	failures++;
}

await browser.close();
console.log(failures ? `\n${failures} failing` : "\nall passing");
process.exit(failures ? 1 : 0);
