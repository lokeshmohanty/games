// scripts/manifest.mjs — what a game.json must say. Shared by the catalog
// build, `just validate-game` and the PR check, so all three agree.

// "shared": a web app (`app` below) — one screen every phone runs; no seats,
// bots or results.
export const KINDS = ["duel", "ffa", "teams", "coop", "local", "shared"];
export const SHAPES = ["teams", "coop", "free"];
export const RUNTIMES = ["js", "wasm", "python"];
// Licences that let the platform serve a copy of the game (redistribution).
export const LICENSES = ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "MPL-2.0", "GPL-3.0", "AGPL-3.0", "0BSD", "Unlicense"];

const ID = /^[a-z0-9][a-z0-9-]{1,31}$/;
// A literal colour (lib/theme.css owns them; a game should read its tokens).
export const COLOUR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\(\s*\d/;
// A path inside the repository: no "..", not absolute.
const PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[\w.\/-]+$/;
const TARGET = /^[A-Za-z_][\w.]*(:[A-Za-z_]\w*)?$/;

/**
 * An existing web app, run as it is (docs/sdk.md, "Web apps"). As the author
 * writes it, paths relative to the game folder:
 *
 *   "app": { "build": { "dir": "frontend", "run": "npm ci && npm run build", "out": "frontend/dist" },
 *            "server": { "python": "backend", "asgi": "main:app" } }
 *
 * or `"web": "site"` for a folder that needs no build. scripts/app-build.mjs
 * turns that into the published form, which is what the catalog reads:
 *
 *   "app": { "web": "web/", "server": { "kind": "asgi", "target": "main:app", "path": "server/",
 *            "files": [...], "deps": [...], "wheels": [...] } }
 */
export function validateApp(a) {
	const p = [];
	if (!a || typeof a !== "object" || Array.isArray(a)) return ['"app" must be an object'];
	const path = (v, what) => typeof v === "string" && PATH.test(v) || p.push(`"${what}" must be a path inside the repository`);
	if (a.build != null) {
		if (typeof a.build !== "object") p.push('"app.build" must be { dir, run, out }');
		else {
			path(a.build.dir, "app.build.dir");
			path(a.build.out, "app.build.out");
			if (typeof a.build.run !== "string" || !a.build.run || a.build.run.length > 300) p.push('"app.build.run" must be a command of at most 300 characters');
		}
	} else path(a.web, "app.web");
	if (a.server != null) {
		const s = a.server;
		if (typeof s !== "object") p.push('"app.server" must be an object');
		else if (s.files) {
			// The published form, written by scripts/app-build.mjs.
			if (!["asgi", "wsgi"].includes(s.kind) || !TARGET.test(s.target ?? "")) p.push('"app.server" is malformed');
		} else {
			path(s.python, "app.server.python");
			const target = s.asgi ?? s.wsgi;
			if ((s.asgi == null) === (s.wsgi == null) || !TARGET.test(target ?? "")) p.push('"app.server" needs one of "asgi" or "wsgi": "module:app"');
		}
	}
	return p;
}

/**
 * What is allowed but on its way out, as sentences. SDK v1 goes once every
 * listed game is on v2 (docs/sdk-v2.md); a web app needs nothing (it is
 * upgraded as it mounts).
 */
export function manifestWarnings(m) {
	const w = [];
	if (m?.sdk === 1 && m?.kind !== "shared") w.push('"sdk": 1 is deprecated and will be dropped: port the game to "sdk": 2 (docs/sdk-v2.md in lokeshmohanty/games)');
	return w;
}

/** Problems with a manifest, as sentences; empty when it is fine. */
export function validateManifest(m) {
	const p = [];
	if (!m || typeof m !== "object") return ["not a JSON object"];
	if (m.sdk !== 1 && m.sdk !== 2) p.push('"sdk" must be 1 or 2');
	// SDK v2 (docs/sdk-v2.md): a game in JavaScript, or compiled to WebAssembly.
	if (m.runtime != null && (m.sdk !== 2 || !RUNTIMES.includes(m.runtime))) p.push(`"runtime" needs "sdk": 2 and is one of ${RUNTIMES.join(", ")}`);
	if ((m.runtime === "wasm") !== (m.wasm != null)) p.push('"runtime": "wasm" goes with "wasm", the module\'s path, and only with it');
	if (m.wasm != null && (typeof m.wasm !== "string" || !PATH.test(m.wasm) || !m.wasm.endsWith(".wasm"))) p.push('"wasm" must be a .wasm path inside the game folder');
	// Layer 2 (docs/sdk-v2.md "Managed state"): the platform runs the rules.
	if (m.state != null && (m.sdk !== 2 || !["managed", "manual"].includes(m.state))) p.push('"state" needs "sdk": 2 and is "managed" or "manual"');
	if (m.tick != null && (m.state !== "managed" || !Number.isInteger(m.tick) || m.tick < 1 || m.tick > 60)) p.push('"tick" (Hz, 1–60) goes with "state": "managed"');
	if (m.viewRate != null && (m.tick == null || !Number.isInteger(m.viewRate) || m.viewRate < 1 || m.viewRate > m.tick)) p.push('"viewRate" (Hz) goes with "tick" and is at most it');
	if (m.opts != null && (typeof m.opts !== "object" || Array.isArray(m.opts))) p.push('"opts" must be an object');
	if (!ID.test(m.id ?? "")) p.push('"id" must be 2–32 of a-z, 0-9, -');
	if (typeof m.name !== "string" || !m.name || m.name.length > 40) p.push('"name" must be 1–40 characters');
	if (m.blurb != null && (typeof m.blurb !== "string" || m.blurb.length > 140)) p.push('"blurb" must be at most 140 characters');
	if (m.title != null && (typeof m.title !== "string" || !m.title || m.title.length > 40)) p.push('"title" must be 1–40 characters');
	if (m.description != null && (typeof m.description !== "string" || m.description.length > 300)) {
		p.push('"description" must be at most 300 characters');
	}
	if (typeof m.entry !== "string" || !/^[\w./-]+\.html$/.test(m.entry) || m.entry.includes("..")) {
		p.push('"entry" must be an .html path inside the game folder');
	}
	if (!KINDS.includes(m.kind)) p.push(`"kind" must be one of ${KINDS.join(", ")}`);
	if (m.shape != null && !SHAPES.includes(m.shape)) p.push(`"shape" must be one of ${SHAPES.join(", ")}`);
	const s = m.seats;
	if (!s || !Number.isInteger(s.min) || !Number.isInteger(s.max) || s.min < 1 || s.max < s.min || s.max > 16) {
		p.push('"seats" must be { min, max } with 1 ≤ min ≤ max ≤ 16');
	}
	if (m.players != null && (!Number.isInteger(m.players.min) || !Number.isInteger(m.players.max) || m.players.min < 1 || m.players.max < m.players.min)) {
		p.push('"players" (people at the table, for a local game) must be { min, max }');
	}
	if (!LICENSES.includes(m.license)) p.push(`"license" must be one of ${LICENSES.join(", ")}`);
	if (typeof m.author !== "string" || !m.author) p.push('"author" is required (GitHub user)');
	if (typeof m.repo !== "string" || !m.repo.startsWith("https://github.com/")) p.push('"repo" must be a https://github.com/ URL');
	if (m.bots != null && typeof m.bots !== "boolean") p.push('"bots" must be true or false');
	if (m.app != null) p.push(...validateApp(m.app));
	if ((m.kind === "shared") !== (m.app != null)) p.push('"kind": "shared" goes with "app", and only with it');
	return p;
}

/**
 * Problems with a contributor.json (optional, at the root of a games repo):
 * how its owner appears on the Contributors page. Their GitHub login and
 * avatar are known already; this is the part they choose.
 *
 *   { "name": "Ada", "bio": "Makes small strategy games.", "location": "Pune",
 *     "links": [{ "label": "Blog", "url": "https://…" }] }
 */
export function validateContributor(c) {
	const p = [];
	if (!c || typeof c !== "object" || Array.isArray(c)) return ["not a JSON object"];
	const text = (k, max) => {
		if (c[k] != null && (typeof c[k] !== "string" || c[k].length > max)) p.push(`"${k}" must be text of at most ${max} characters`);
	};
	text("name", 40);
	text("bio", 280);
	text("location", 40);
	if (c.links != null) {
		if (!Array.isArray(c.links) || c.links.length > 5) p.push('"links" is a list of at most 5');
		else
			for (const l of c.links) {
				if (!l || typeof l.label !== "string" || !l.label || l.label.length > 24) p.push("each link needs a label of 1–24 characters");
				if (!l || typeof l.url !== "string" || !/^https:\/\/[^\s]+$/.test(l.url) || l.url.length > 200) p.push("each link needs an https:// url");
			}
	}
	const known = new Set(["name", "bio", "location", "links"]);
	for (const k of Object.keys(c)) if (!known.has(k)) p.push(`unknown field "${k}"`);
	return p;
}
