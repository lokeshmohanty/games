// scripts/test-protocol.mjs — SDK v2's wire, checked against its schema.
//
// sdk/v2/protocol.json is the contract every language's game is written to,
// so the shell must say exactly what it promises and nothing else. Three real
// browser peers form a party (invites, no room server), add a bot, and play
// scripts/fixtures/protocol-game — a fixture that uses every service once —
// loaded through the dev kit. Every message that crosses a frame, in both
// directions, is recorded through `NeonArcade.sdkTrace` and validated against
// the schema; the fixture's own report says each service did what it should.
// It also checks that the catalogue was covered: a message type the shell
// never sent or answered is listed.

import { spawn } from "node:child_process";
import { existsSync, globSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gameFrame, serve } from "./serve.mjs";

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA = JSON.parse(readFileSync(join(ROOT, "sdk/v2/protocol.json"), "utf8"));
const TIMEOUT = 40_000;
const DEV_PORT = 5190;
// Not reached by this run: join/leave need a peer to come and go mid-game,
// hostNew leaves the party. test-party covers those paths in the shell.
const NOT_EXERCISED = new Set(["join", "leave", "hostNew"]);
// What each peer's fixture must report, named here so a step whose event
// never comes fails instead of going missing from the report.
const EVERYONE = ["init", "theme", "theme.set", "roster", "ready", "channels+bin+emitAs", "meta", "fire-and-forget", "asset", "asset outside the folder is refused", "commit+verify", "timer", "paused", "done"];
const EXPECTED = {
	host: [...EVERYONE, "ask", "seal.send", "sealed (to a bot, on the host)", "timer collect", "wait skip"],
	p2: [...EVERYONE, "sealed", "takeOver"],
	p3: [...EVERYONE, "sealed"],
};

let failures = 0;
const check = (label, ok, detail = "") => {
	console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
	if (!ok) failures++;
};

// -- a JSON Schema validator, for the subset protocol.json uses ---------------

const deref = (ref) => ref.replace(/^#\//, "").split("/").reduce((o, k) => o[k], SCHEMA);
const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
/** Problems with `v` against `s`, as paths; empty when it conforms. */
function validate(v, s, at = "") {
	if (s.$ref) return validate(v, deref(s.$ref), at);
	const out = [];
	if (s.oneOf) {
		const passing = s.oneOf.filter((alt) => !validate(v, alt, at).length);
		if (passing.length !== 1) {
			// Name the closest alternative: the one whose `t` matches, when it is a message.
			const named = s.oneOf.map((alt) => (alt.$ref ? deref(alt.$ref) : alt)).find((alt) => alt.properties?.t?.const === v?.t);
			return named ? validate(v, named, at) : [`${at || "/"}: matches ${passing.length} of ${s.oneOf.length} alternatives`];
		}
	}
	if ("const" in s && v !== s.const) out.push(`${at}: must be ${JSON.stringify(s.const)}`);
	if (s.enum && !s.enum.includes(v)) out.push(`${at}: must be one of ${s.enum.join(", ")}`);
	if (s.type) {
		const types = [].concat(s.type);
		const t = typeOf(v);
		if (!types.includes(t) && !(t === "integer" && types.includes("number"))) return [...out, `${at}: is ${t}, not ${types.join("|")}`];
	}
	if (typeof v === "string") {
		if (s.minLength != null && v.length < s.minLength) out.push(`${at}: shorter than ${s.minLength}`);
		if (s.maxLength != null && v.length > s.maxLength) out.push(`${at}: longer than ${s.maxLength}`);
	}
	if (typeof v === "number") {
		if (s.minimum != null && v < s.minimum) out.push(`${at}: below ${s.minimum}`);
		if (s.maximum != null && v > s.maximum) out.push(`${at}: above ${s.maximum}`);
	}
	if (Array.isArray(v)) {
		if (s.minItems != null && v.length < s.minItems) out.push(`${at}: fewer than ${s.minItems} items`);
		if (s.maxItems != null && v.length > s.maxItems) out.push(`${at}: more than ${s.maxItems} items`);
		if (s.items) v.forEach((x, i) => out.push(...validate(x, s.items, `${at}/${i}`)));
	}
	if (v && typeof v === "object" && !Array.isArray(v)) {
		for (const k of s.required ?? []) if (!(k in v)) out.push(`${at}/${k}: required`);
		for (const [k, x] of Object.entries(v)) {
			if (s.properties?.[k]) out.push(...validate(x, s.properties[k], `${at}/${k}`));
			else if (s.additionalProperties === false) out.push(`${at}/${k}: not allowed`);
			else if (typeof s.additionalProperties === "object") out.push(...validate(x, s.additionalProperties, `${at}/${k}`));
		}
	}
	return out;
}

// -- the browsers ---------------------------------------------------------------

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
	if (!found) throw new Error("playwright not found (run `just test-bots` once to fetch it)");
	return require(found);
}

const site = await serve(8737);
const dev = spawn("node", [join(ROOT, "sdk/v1/dev-server.mjs"), join(ROOT, "scripts/fixtures"), String(DEV_PORT)], {
	env: { ...process.env, NEON_PLATFORM: site.base },
	stdio: "ignore",
});
process.on("exit", () => dev.kill());
const devBase = `http://127.0.0.1:${DEV_PORT}/protocol-game/`;
for (let i = 0; i < 50; i++) {
	if (await fetch(devBase + "game.json").then((r) => r.ok, () => false)) break;
	await new Promise((r) => setTimeout(r, 100));
}

const { chromium } = loadPlaywright();
const browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
// Every message across a frame, JSON-safe (an ArrayBuffer becomes its size).
await context.addInitScript(() => {
	window.__sdk = [];
	window.NeonArcade = window.NeonArcade || {};
	NeonArcade.turnWaitMs = 500; // the shell's turn-wait banner, 30 s for real
	NeonArcade.sdkTrace = (dir, m) => {
		const safe = JSON.parse(JSON.stringify(m, (_k, v) => (v instanceof ArrayBuffer ? { $buffer: v.byteLength } : v)));
		window.__sdk.push([dir, safe]);
	};
});
const pages = [];
for (const tag of ["host", "p2", "p3"]) {
	const page = await context.newPage();
	page.on("pageerror", (err) => check(`no page error on ${tag}`, false, err.message));
	page.on("console", (msg) => /Content Security Policy|Refused to/.test(msg.text()) && check(`no CSP violation on ${tag}`, false, msg.text()));
	pages.push(page);
}
const [host, p2, p3] = pages;
const withDev = (url) => {
	const u = new URL(url);
	u.searchParams.set("dev", devBase);
	return u.href;
};

/** Pretend a tab went to the background (or came back): what a phone does on switching apps. */
const setHidden = (page, hidden) =>
	page.evaluate((hidden) => {
		Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
		Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
		document.dispatchEvent(new Event("visibilitychange"));
	}, hidden);

async function invite(inviter, joiner) {
	await inviter.locator("button", { hasText: "ADD PLAYER" }).first().click();
	const box = inviter.locator("textarea.share-code").first();
	await box.waitFor({ timeout: TIMEOUT });
	await joiner.goto(withDev(await box.inputValue()));
	const replyBox = joiner.locator("textarea.share-code").first();
	await replyBox.waitFor({ timeout: TIMEOUT });
	await inviter.locator("textarea.share-code").last().fill(await replyBox.inputValue());
	await inviter.locator("button.neon-btn", { hasText: /^CONNECT$/ }).first().click();
	await joiner.locator(".party-member").first().waitFor({ timeout: TIMEOUT });
}

try {
	console.log("\nprotocol: a party of three and a bot");
	const q = new URLSearchParams({ dev: devBase, fresh: "1", rs: "http://127.0.0.1:1" });
	await host.goto(`${site.base}/party.html?${q}`);
	await host.locator(".party-member").first().waitFor({ timeout: TIMEOUT });
	await invite(host, p2);
	await invite(host, p3);
	await host.locator(".party-member").nth(2).waitFor({ timeout: TIMEOUT });
	await host.locator("button", { hasText: "ADD BOT" }).first().click({ timeout: TIMEOUT });
	await host.locator(".party-member").nth(3).waitFor({ timeout: TIMEOUT });
	// Everyone seated (a free game: any side), so the clock waits for all four.
	await host.evaluate(() => {
		const r = window.__party.room;
		for (const m of r.getMembers()) r.setTeam(m.id, "A");
	});
	await host.locator(".party-game", { hasText: "PROTOCOL CHECK" }).first().click({ timeout: TIMEOUT });
	const frames = await Promise.all(pages.map((p) => gameFrame(p, TIMEOUT)));
	check("the fixture mounts on all three", frames.length === 3);

	// The host asks a question; the shell's dialog answers it.
	const asked = frames[0].evaluate(() => window.fixtureAsk());
	await host.locator("dialog.neon-ask[open] [data-ask='yes']").click({ timeout: TIMEOUT });
	await asked;

	// The shell's own news: the theme changes; a player whose turn it is hides
	// their tab and the host skips them; the host hides theirs, which pauses all.
	await host.evaluate(() => NeonArcade.theme.set({ theme: "neon" }));
	const turnOf = await frames[0].evaluate(() => window.arcade.party.members.map((m) => m.id).filter((id) => !id.startsWith("bot_") && id !== window.arcade.party.self).sort()[0]);
	const waiting = pages[await Promise.all(pages.map((p) => p.evaluate(() => window.__party.room.selfId))).then((ids) => ids.indexOf(turnOf))];
	await setHidden(waiting, true);
	// On the party page, not in the frame: the banner is a shell service now.
	const skip = host.locator(".turn-wait:not([hidden]) button", { hasText: "SKIP TURN" });
	const shown = await skip.waitFor({ timeout: TIMEOUT }).then(() => true, () => false);
	const onTop = shown && (await skip.evaluate((b) => {
		const r = b.getBoundingClientRect();
		return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === b;
	}));
	check("the shell draws the turn-wait banner, over the game frame", onTop, shown ? "covered by something" : "no banner");
	if (shown) await skip.click();
	await setHidden(waiting, false);
	await setHidden(host, true);
	await new Promise((r) => setTimeout(r, 1500));
	await setHidden(host, false);

	const report = async (f) => f.evaluate(() => window.arcade.debug());
	const end = Date.now() + 60_000;
	let reports = await Promise.all(frames.map(report));
	while (!reports.every((r) => r.steps.done) && Date.now() < end) {
		await new Promise((r) => setTimeout(r, 500));
		reports = await Promise.all(frames.map(report));
	}
	// The shell's own request, as when the crown moves: p2's frame carries on.
	const kept = await p2.evaluate(() => window.__party.handle.takeOver());
	check("takeOver reaches the frame and its answer comes back", kept === true);
	reports = await Promise.all(frames.map(report));

	console.log("\nprotocol: every service, as each peer saw it");
	const who = ["host", "p2", "p3"];
	for (const name of [...new Set(Object.values(EXPECTED).flat())]) {
		const bad = reports
			.map((r, i) => [who[i], r.steps[name]])
			.filter(([w, v]) => EXPECTED[w].includes(name) && v !== true)
			.map(([w, v]) => `${w}: ${v === undefined ? "never reported" : v}`);
		check(name, !bad.length, bad.join("; "));
	}
	const extra = reports.flatMap((r, i) => Object.keys(r.steps).filter((k) => !EXPECTED[who[i]].includes(k)).map((k) => `${who[i]}: ${k}`));
	check("…and no step the test does not know about", !extra.length, extra.join(", "));

	// Back to the lobby: the host's `end`, then everyone's `unmount`.
	await frames[0].evaluate(() => window.fixtureEnd());
	await host.locator(".game-frame").waitFor({ state: "detached", timeout: TIMEOUT }).catch(() => {});

	console.log("\nprotocol: every message against sdk/v2/protocol.json");
	const traced = (await Promise.all(pages.map((p) => p.evaluate(() => window.__sdk)))).flat();
	const toShell = SCHEMA.$defs.toShell;
	const toFrame = SCHEMA.$defs.toFrame;
	const wrong = [];
	for (const [dir, m] of traced) {
		const problems = validate(m, dir === "toShell" ? toShell : toFrame);
		if (problems.length) wrong.push(`${dir} ${m.t}: ${problems.slice(0, 2).join("; ")}`);
	}
	check(`all ${traced.length} messages conform`, !wrong.length, [...new Set(wrong)].slice(0, 6).join(" | "));

	const seen = { toShell: new Set(), toFrame: new Set() };
	for (const [dir, m] of traced) seen[dir].add(m.t);
	for (const dir of ["toShell", "toFrame"]) {
		const types = SCHEMA.$defs[dir].oneOf.map((r) => deref(r.$ref).properties.t.const);
		const missing = types.filter((t) => !seen[dir].has(t) && !NOT_EXERCISED.has(t));
		check(`every ${dir === "toShell" ? "frame → shell" : "shell → frame"} message was exercised`, !missing.length, `never seen: ${missing.join(", ")}`);
		const unknown = [...seen[dir]].filter((t) => !types.includes(t));
		check(`…and nothing outside the catalogue (${dir})`, !unknown.length, unknown.join(", "));
	}
} catch (err) {
	check("the run completes", false, err.stack?.split("\n").slice(0, 3).join(" ") ?? String(err));
} finally {
	await browser.close();
	dev.kill();
	site.stop();
}
console.log(failures ? `\n${failures} protocol check(s) failed` : "\nall protocol checks passed");
process.exit(failures ? 1 : 0);
