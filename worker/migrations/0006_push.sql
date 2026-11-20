-- worker/migrations/0006_push.sql — party invites as notifications (Web Push,
-- 2026-11-18; branch web-push). worker/api/push.js is the contract;
-- docs/accounts.md "Party invites by notification" the design.
--
-- Additive only: a Worker from before it never reads this table. Apply it
-- before deploying the Worker that does (docs/accounts.md "Migrations").

-- One row per device that turned invites on: the push service's endpoint
-- (a URL on a known push service's host, worker/api/webpush.js) and the
-- browser's keys the payload is encrypted for. One account per endpoint: the
-- same browser signed in as someone else moves the row to them. At most
-- PUSH_DEVICES_MAX rows an account; the least recently refreshed go first.
-- Deleted on TURN OFF, on sign-out, on a 404/410 from the push service, and
-- with the account.
CREATE TABLE push_subs (
	endpoint TEXT PRIMARY KEY,
	account TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
	p256dh TEXT NOT NULL,              -- the browser's P-256 public key, base64url
	auth TEXT NOT NULL,                -- its 16-byte auth secret, base64url
	created INTEGER NOT NULL,
	at INTEGER NOT NULL                -- last subscribed or refreshed by a page
);
CREATE INDEX push_subs_account ON push_subs (account, at);
