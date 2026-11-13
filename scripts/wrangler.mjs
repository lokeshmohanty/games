// scripts/wrangler.mjs — the Worker under `wrangler dev`, with a throwaway
// local D1 (migrations applied) and Durable Object state, for the tests.
//
// Wrangler comes from $WRANGLER (a command line), else `wrangler` on PATH,
// else `nix shell nixpkgs#wrangler` (npx wrangler cannot link workerd on
// NixOS). Resolves { base, stop } or null when it cannot start.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function freePort() {
	return new Promise((done) => {
		const srv = createServer();
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address();
			srv.close(() => done(port));
		});
	});
}

function command() {
	if (process.env.WRANGLER) return process.env.WRANGLER.split(/\s+/);
	const onPath = (process.env.PATH ?? "").split(":").some((d) => d && existsSync(join(d, "wrangler")));
	return onPath ? ["wrangler"] : ["nix", "shell", "nixpkgs#wrangler", "-c", "wrangler"];
}

/** `vars`: { NAME: value } passed as --var. */
export async function startWrangler(vars = {}) {
	const [cmd, ...pre] = command();
	const state = mkdtempSync(join(tmpdir(), "neon-worker-"));
	const env = { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" };
	const migrate = spawnSync(cmd, [...pre, "d1", "migrations", "apply", "arcade", "--local", "--persist-to", state], {
		cwd: join(ROOT, "worker"),
		env,
		encoding: "utf8",
		timeout: 240_000,
	});
	if (migrate.status !== 0) {
		console.log(`skip: could not apply D1 migrations (${cmd} ${pre.join(" ")})`);
		console.log(`${migrate.stdout ?? ""}${migrate.stderr ?? ""}`.split("\n").slice(-15).join("\n"));
		rmSync(state, { recursive: true, force: true });
		return null;
	}
	const port = await freePort();
	const inspector = await freePort();
	const args = ["dev", "--port", String(port), "--ip", "127.0.0.1", "--inspector-port", String(inspector), "--persist-to", state];
	for (const [k, v] of Object.entries(vars)) args.push("--var", `${k}:${v}`);
	let log = "";
	let exited = false;
	const child = spawn(cmd, [...pre, ...args], { cwd: join(ROOT, "worker"), detached: true, stdio: ["ignore", "pipe", "pipe"], env });
	child.stdout.on("data", (d) => (log += d));
	child.stderr.on("data", (d) => (log += d));
	child.on("error", (err) => ((exited = true), (log += String(err))));
	child.on("exit", () => (exited = true));
	const stop = () => {
		try {
			process.kill(-child.pid, "SIGTERM");
		} catch {}
		rmSync(state, { recursive: true, force: true });
	};
	process.on("exit", stop);
	const base = `http://127.0.0.1:${port}`;
	const deadline = Date.now() + 180_000;
	while (Date.now() < deadline && !exited) {
		try {
			if ((await fetch(base + "/not-a-room")).status === 404) return { base, stop, log: () => log };
		} catch {}
		await sleep(500);
	}
	stop();
	console.log(`skip: wrangler dev did not start (${cmd} ${pre.join(" ")}).`);
	console.log(log.split("\n").slice(-20).join("\n"));
	return null;
}
