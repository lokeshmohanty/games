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
	// A game page, not party.html: the lobby waits for a click before hosting
	// anything, so the only rooms on this page are the ones the test makes.
	// party.html hosts on boot, which would be a second, unaccounted room.
	await page.goto(PAGE("connect4.html", "?mockroom=1"));
	await page.evaluate(() => {
		localStorage.removeItem("neon.room");
		localStorage.removeItem("neon.rs");
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
	// that stale offer.
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
		r.createInvite = () => Promise.reject(new Error("no invite"));
		say({ t: "peer", id: peer, connected: true, offering: r.selfId });
		await wait(100);
		r.leave();
		return { setAside, answered };
	});
	check("(the glared offer was set aside)", staleGlare.setAside, JSON.stringify(staleGlare));
	check("a failed invite after the backstop answers no stale offer", staleGlare.answered.length === 0, JSON.stringify(staleGlare));

	// ------------------------------- 6f. late news of a departed member
	// A `rs` or `back` vouch can arrive after its subject has left; the host
	// once seated them again as "Player".
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
		await probe.goto(PAGE("connect4.html", "?rs=" + encodeURIComponent(rs)));
		const base = await probe.evaluate(() => NeonArcade._roomServerBase);
		check(`?rs=${rs} is ${ok ? "honoured" : "ignored"}`, ok ? base.startsWith(rs.replace(/^http/, "ws")) : !base.includes("evil"), base);
		await probe.close();
	}

	// ------------------------------------------- 8. the fallback path
	console.log("\nroom: the zero-server fallback");
	const plain = await context.newPage();
	await plain.goto(PAGE("connect4.html"));
	await plain.locator("button", { hasText: "INVITE A FRIEND" }).waitFor({ timeout: TIMEOUT });
	check("the classic invite flow is still offered", true);
	check(
		"JOIN WITH A CODE is hidden without the room server",
		(await plain.locator("button", { hasText: "JOIN WITH A CODE" }).count()) === 0,
	);
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
