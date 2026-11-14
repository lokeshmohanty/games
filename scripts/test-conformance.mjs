// scripts/test-conformance.mjs — the same game in every language gives the
// same answers.
//
// SDK v2 promises that a game may be written in any language "with minor
// modifications". Each lane ships Tic Tac Toe as a managed game
// (sdk/v2/examples/tic-tac-toe-<lane>), and the JavaScript one is the
// reference. For each, this builds the real sandboxed frame (the shell's
// buildFrameDoc: the real CSP, the real runtime), plays host to it over the
// protocol itself (hello → init, with the module bytes for WASM and the
// runtime files for Python), and runs one scripted match through `rules`:
// every view for both seats and a spectator, refusals and their reasons,
// a bot's moves, snapshot → restore, skip, and the result. Every lane's
// transcript must equal the reference's, call for call.
//
//   node scripts/test-conformance.mjs            every lane present
//   node scripts/test-conformance.mjs rust c     only these (plus the reference)

import { existsSync, globSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkTrace } from "./protocol-check.mjs";
import { serve } from "./serve.mjs";

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLES = join(ROOT, "sdk/v2/examples");
const LANES = ["js", "html", "ts", "rust", "c", "go", "python"];
const REFERENCE = "js";

let failures = 0;
const check = (label, ok, detail = "") => {
	console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
	if (!ok) failures++;
};

// The match. X is a person, O a bot. Each step is one `rules` request (a
// list of calls); the transcript is every outcome.
const X = "pX";
const O = "bot_O";
const SEATS = [
	{ id: X, name: "Ada", team: "A", bot: false },
	{ id: O, name: "Bot", team: "B", bot: true },
];
const views = () => [
	{ fn: "view", seat: X },
	{ fn: "view", seat: O },
	{ fn: "view", seat: null },
	{ fn: "turn" },
	{ fn: "result" },
];
const SCRIPT = [
	[{ fn: "init", seats: SEATS, opts: {}, seed: 7, match: 0 }, ...views()],
	[{ fn: "apply", action: { i: 4 }, by: O }], // not O's turn
	[{ fn: "apply", action: { i: 4 }, by: X }, ...views()],
	[{ fn: "apply", action: { i: 4 }, by: O }], // taken
	[{ fn: "apply", action: { i: 9 }, by: O }], // off the board
	[{ fn: "bot", seat: O }], // the bot's choice, applied next as O
	"BOT",
	[{ fn: "snapshot" }],
	"RESTORE", // a fresh init, then restore what snapshot gave: as an heir would
	views(),
	[{ fn: "skip", seat: X }, ...views()], // X's turn skipped: O to move
	[{ fn: "bot", seat: O }],
	"BOT",
	[{ fn: "apply", action: { i: 0 }, by: X }, ...views()],
	[{ fn: "bot", seat: O }],
	"BOT",
	[{ fn: "apply", action: { i: 8 }, by: X }, ...views()],
	[{ fn: "bot", seat: O }],
	"BOT",
	[{ fn: "apply", action: { i: 6 }, by: X }, ...views()],
	[{ fn: "bot", seat: O }],
	"BOT",
	views(),
	[{ fn: "apply", action: { i: 2 }, by: X }, ...views()],
	[{ fn: "init", seats: SEATS, opts: {}, seed: 8, match: 1 }, ...views()], // a rematch starts clean
];

function chromePath() {
	const found = [process.env.CHROME, "/run/current-system/sw/bin/google-chrome-stable", "/run/current-system/sw/bin/chromium", join(homedir(), ".nix-profile", "bin", "google-chrome-stable")]
		.filter(Boolean)
		.find((p) => existsSync(p));
	if (!found) throw new Error("no system Chrome found; set CHROME=/path/to/chrome");
	return found;
}
function loadPlaywright() {
	const found = [join(ROOT, "node_modules", "playwright"), join(homedir(), ".cache", "game-previews", "node_modules", "playwright"), ...globSync(join(homedir(), ".npm", "_npx", "*", "node_modules", "playwright"))].find((p) => existsSync(p));
	if (!found) throw new Error("playwright not found (run `just test-bots` once to fetch it)");
	return require(found);
}

/** Runs in the page: mount `game` in a sandboxed frame and play SCRIPT through it. */
async function runInPage({ game, script }) {
	const doc = await NeonArcade.buildFrameDoc(game);
	const frame = document.createElement("iframe");
	frame.setAttribute("sandbox", "allow-scripts");
	document.body.append(frame);
	const channel = new MessageChannel();
	const port = channel.port1;
	const trace = [];
	const errors = [];
	let seq = 0;
	const waiting = new Map();
	const post = (m, transfer) => {
		const msg = { v: 2, ...m };
		trace.push(["toFrame", JSON.parse(JSON.stringify(msg, (_k, v) => (v instanceof ArrayBuffer ? { $buffer: v.byteLength } : v)))]);
		port.postMessage(msg, transfer ?? []);
	};
	let ready;
	const readyP = new Promise((r) => (ready = r));
	const wasm = game.wasm ? await fetch(new URL(game.wasm, game.base)).then((r) => r.arrayBuffer()) : null;
	port.onmessage = async (e) => {
		const m = e.data;
		trace.push(["toShell", JSON.parse(JSON.stringify(m))]);
		if (m.t === "hello") {
			const init = {
				t: "init",
				game: { id: game.id, name: game.name },
				party: { self: "pX", host: "pX", members: [{ id: "pX", name: "Ada", team: "A" }, { id: "bot_O", name: "Bot", team: "B", bot: true }] },
				seats: { min: 2, max: 2 },
				local: false,
				canEnd: false,
				storage: {},
				session: {},
				theme: { name: "paper", mode: "light", dark: false, tokens: { bg: "rgba(255, 255, 255, 1)" }, players: Array(8).fill("rgba(0, 0, 0, 1)"), fonts: {} },
				features: [],
			};
			if (wasm) {
				const bytes = wasm.slice(0);
				post({ ...init, wasm: bytes }, [bytes]);
			} else post(init);
		} else if (m.t === "ready") ready();
		else if (m.t === "reply") {
			waiting.get(m.re)?.(m);
			waiting.delete(m.re);
		} else if (m.t === "runtime.file" || m.t === "asset") {
			// What sdk-host answers: the platform's runtime folder, or the game's own.
			const base = m.t === "runtime.file" ? new URL("sdk/v1/pyodide/", document.baseURI) : new URL(game.base);
			try {
				const res = await fetch(new URL(m.path, base));
				if (!res.ok) throw new Error(res.status);
				if (m.as === "text") post({ t: "reply", re: m.id, ok: true, text: await res.text(), type: "" });
				else {
					const bytes = await res.arrayBuffer();
					post({ t: "reply", re: m.id, ok: true, bytes, type: res.headers.get("content-type") ?? "" }, [bytes]);
				}
			} catch (err) {
				post({ t: "reply", re: m.id, ok: false, err: String(err.message) });
			}
		}
	};
	frame.addEventListener("load", () => frame.contentWindow.postMessage({ t: "neon:port" }, "*", [channel.port2]), { once: true });
	frame.srcdoc = doc;
	const timeout = (ms, what) => new Promise((_, no) => setTimeout(() => no(new Error(`${what}: no answer in ${ms / 1000} s`)), ms));
	await Promise.race([readyP, timeout(game.runtime === "python" ? 90_000 : 20_000, "ready")]);
	const call = (calls) =>
		Promise.race([
			new Promise((resolve) => {
				const id = ++seq;
				waiting.set(id, resolve);
				post({ t: "rules", id, calls });
			}),
			timeout(10_000, "rules"),
		]);
	const transcript = [];
	let lastBot = null;
	let snap = null;
	for (const step of script) {
		let calls = step;
		if (step === "BOT") calls = [{ fn: "apply", action: lastBot, by: "bot_O" }];
		if (step === "RESTORE") calls = [{ fn: "init", seats: script[0][0].seats, opts: {}, seed: 99, match: 0 }, { fn: "restore", snapshot: snap }];
		const r = await call(calls);
		if (!r.ok) errors.push(`rules refused: ${r.err}`);
		const out = r.out ?? [];
		if (calls[0].fn === "bot") lastBot = out[0]?.v ?? null;
		if (calls[0].fn === "snapshot") {
			snap = out[0]?.v ?? null;
			transcript.push({ calls: ["snapshot"], out: ["(opaque)"] });
			continue;
		}
		transcript.push({ calls: calls.map((c) => c.fn + (c.seat !== undefined ? `:${c.seat}` : "") + (c.action ? JSON.stringify(c.action) : "")), out });
	}
	frame.remove();
	return { transcript, trace, errors };
}

const want = process.argv.slice(2);
const lanes = LANES.filter((l) => existsSync(join(EXAMPLES, `tic-tac-toe-${l}`, "game.json")) && (!want.length || want.includes(l) || l === REFERENCE));
const site = await serve(8742);
const { chromium } = loadPlaywright();
const browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox"] });
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
const consoleErrors = [];
page.on("console", (m) => m.type() === "error" && !/room server|Failed to load resource/i.test(m.text()) && consoleErrors.push(m.text()));
await page.goto(site.url("party.html?fresh=1&rs=http://127.0.0.1:1"));
await page.waitForFunction(() => !!window.NeonArcade?.buildFrameDoc);

const results = {};
try {
	for (const lane of lanes) {
		console.log(`\nconformance: ${lane}`);
		const dir = `sdk/v2/examples/tic-tac-toe-${lane}/`;
		const m = JSON.parse(readFileSync(join(ROOT, dir, "game.json"), "utf8"));
		check("a managed SDK v2 game", m.sdk === 2 && m.state === "managed", m);
		const game = { id: m.id, name: m.name, entry: m.entry, sdk: 2, runtime: m.runtime ?? "js", wasm: m.wasm, base: site.url(dir) };
		const before = consoleErrors.length;
		try {
			results[lane] = await page.evaluate(runInPage, { game, script: SCRIPT });
		} catch (err) {
			check("its frame comes up and answers", false, err.message.split("\n")[0]);
			continue;
		}
		const { transcript, trace, errors } = results[lane];
		check("its frame comes up and answers every request", !errors.length, errors.join("; "));
		check("no console error from it (CSP violations included)", consoleErrors.length === before, consoleErrors.slice(before, before + 3).join(" | "));
		const wrong = checkTrace(trace);
		check("every message it said conforms to protocol.json", !wrong.length, wrong.slice(0, 3).join(" | "));
		if (lane === REFERENCE) {
			const last = transcript.at(-2).out;
			check("(the reference match ends in a result)", !!last.find((o) => o?.v?.ranking), last);
			continue;
		}
		const ref = results[REFERENCE]?.transcript ?? [];
		const diffs = [];
		transcript.forEach((step, i) => {
			const a = JSON.stringify(step.out);
			const b = JSON.stringify(ref[i]?.out);
			if (a !== b) diffs.push(`step ${i} ${step.calls.join(",")}: ${a.slice(0, 160)} ≠ ${b?.slice(0, 160)}`);
		});
		check(`every answer equals the reference's (${transcript.length} steps)`, !diffs.length && transcript.length === ref.length, diffs.slice(0, 3).join("\n        "));
	}
	const missing = LANES.filter((l) => !lanes.includes(l));
	if (missing.length && !want.length) console.log(`\n  (not present yet: ${missing.join(", ")})`);
} finally {
	await browser.close();
	site.stop();
}
console.log(failures ? `\n${failures} conformance check(s) failed` : `\nall conformance checks passed (${lanes.join(", ")})`);
process.exit(failures ? 1 : 0);
