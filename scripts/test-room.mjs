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
