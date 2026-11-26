// scripts/check-migrations.mjs — refuse to deploy the Worker while the remote
// D1 has migrations it has not applied (review, 2026-11-21: a Worker that
// reads a table or column of a pending migration answers 500 to every party
// invite and every account deletion until it is applied). `just
// deploy-worker` runs it first, through `just check-migrations`:
//
//   wrangler d1 migrations list arcade --remote 2>&1 | node scripts/check-migrations.mjs
//
// It reads wrangler's output on stdin and passes only on wrangler's own
// "No migrations to apply" — anything else (pending migrations listed, no
// output, an error, not signed in) fails closed and says what to do.

let text = "";
for await (const chunk of process.stdin) text += chunk;
if (/No migrations to apply/i.test(text)) {
	console.log("check-migrations: the remote D1 has every migration");
	process.exit(0);
}
const pending = [...new Set(text.match(/\b\d{4}_[A-Za-z0-9_-]+\.sql\b/g) ?? [])];
console.error(
	pending.length
		? `check-migrations: the remote D1 has not applied ${pending.join(", ")}.\nApply them first, from worker/: nix shell nixpkgs#wrangler -c wrangler d1 migrations apply arcade --remote\n(docs/accounts.md "Migrations": migrate first, then deploy.)`
		: `check-migrations: could not tell whether the remote D1 is migrated (wrangler said:\n${text.trim().split("\n").slice(-6).join("\n") || "(nothing)"})\nRun \`wrangler d1 migrations list arcade --remote\` from worker/ and apply what it lists.`,
);
process.exit(1);
