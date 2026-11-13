// scripts/manifest.mjs — what a game.json must say. Shared by the catalog
// build, `just validate-game` and the PR check, so all three agree.

export const KINDS = ["duel", "ffa", "teams", "coop", "local"];
export const SHAPES = ["teams", "coop", "free"];
// Licences that let the platform serve a copy of the game (redistribution).
export const LICENSES = ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "MPL-2.0", "GPL-3.0", "AGPL-3.0", "0BSD", "Unlicense"];

const ID = /^[a-z0-9][a-z0-9-]{1,31}$/;

/** Problems with a manifest, as sentences; empty when it is fine. */
export function validateManifest(m) {
	const p = [];
	if (!m || typeof m !== "object") return ["not a JSON object"];
	if (m.sdk !== 1) p.push('"sdk" must be 1');
	if (!ID.test(m.id ?? "")) p.push('"id" must be 2–32 of a-z, 0-9, -');
	if (typeof m.name !== "string" || !m.name || m.name.length > 40) p.push('"name" must be 1–40 characters');
	if (m.blurb != null && (typeof m.blurb !== "string" || m.blurb.length > 140)) p.push('"blurb" must be at most 140 characters');
	if (typeof m.entry !== "string" || !/^[\w./-]+\.html$/.test(m.entry) || m.entry.includes("..")) {
		p.push('"entry" must be an .html path inside the game folder');
	}
	if (!KINDS.includes(m.kind)) p.push(`"kind" must be one of ${KINDS.join(", ")}`);
	if (m.shape != null && !SHAPES.includes(m.shape)) p.push(`"shape" must be one of ${SHAPES.join(", ")}`);
	const s = m.seats;
	if (!s || !Number.isInteger(s.min) || !Number.isInteger(s.max) || s.min < 1 || s.max < s.min || s.max > 16) {
		p.push('"seats" must be { min, max } with 1 ≤ min ≤ max ≤ 16');
	}
	if (!LICENSES.includes(m.license)) p.push(`"license" must be one of ${LICENSES.join(", ")}`);
	if (typeof m.author !== "string" || !m.author) p.push('"author" is required (GitHub user)');
	if (typeof m.repo !== "string" || !m.repo.startsWith("https://github.com/")) p.push('"repo" must be a https://github.com/ URL');
	return p;
}
