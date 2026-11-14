// scripts/protocol-check.mjs — sdk/v2/protocol.json, and a validator for the
// subset of JSON Schema it uses. Shared by test-protocol and test-managed, so
// "every message conforms" means the same thing in both. No dependency: the
// repo has none by design, and the subset is small (type, const, enum,
// required, properties, additionalProperties, items, oneOf, $ref, lengths,
// bounds).

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SCHEMA = JSON.parse(readFileSync(join(ROOT, "sdk/v2/protocol.json"), "utf8"));

export const deref = (ref) => ref.replace(/^#\//, "").split("/").reduce((o, k) => o[k], SCHEMA);
const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
/** Problems with `v` against `s`, as paths; empty when it conforms. */
export function validate(v, s, at = "") {
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


/** Problems with traced [direction, message] pairs, one line per bad message. */
export function checkTrace(traced) {
	const wrong = [];
	for (const [dir, m] of traced) {
		const problems = validate(m, SCHEMA.$defs[dir]);
		if (problems.length) wrong.push(`${dir} ${m.t}: ${problems.slice(0, 2).join("; ")}`);
	}
	return [...new Set(wrong)];
}

/** Every message type in one direction's catalogue. */
export const catalogue = (dir) => SCHEMA.$defs[dir].oneOf.map((r) => deref(r.$ref).properties.t.const);
