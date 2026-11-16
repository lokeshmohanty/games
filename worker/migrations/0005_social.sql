-- worker/migrations/0005_social.sql — friends, groups and party invites,
-- fixed and extended (2026-11-16; branch social-friends). worker/api/social.js
-- is the contract; docs/accounts.md "Friends, groups and invites" the design.
--
-- Additive only: safe on a database that holds 0001–0004's rows, and a Worker
-- from before it never reads these. Apply it before deploying the Worker that
-- does (docs/accounts.md "Migrations").
--
-- `friends.state` was free text already: besides 'pending' and 'friends' it
-- now holds 'blocked' (a = who blocked b) and 'declined' (a asked, b said no,
-- at = when: a may not ask again for a while). No column changes there.

-- A short friend code people can say and rotate, instead of the account id.
-- Given lazily — the first time the account's own profile is read — so no
-- backfill: SQLite has no good random text to fill it with, and NULLs do not
-- collide in a UNIQUE index.
ALTER TABLE accounts ADD COLUMN friend_code TEXT;
CREATE UNIQUE INDEX accounts_friend_code ON accounts (friend_code);

-- Who a group's owner removed: they cannot join again with any code until the
-- owner lets them (a kick also rotates the code).
CREATE TABLE group_bans (
	grp TEXT NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
	account TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
	at INTEGER NOT NULL,
	PRIMARY KEY (grp, account)
);
CREATE INDEX group_bans_account ON group_bans (account);

-- Party invites that wait for a friend who has no page open: one per sender
-- and recipient (a newer invite replaces it), shown when the friend next
-- opens the arcade, gone on JOIN, on NOT NOW, or after 10 minutes.
CREATE TABLE invites (
	recipient TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
	sender TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
	code TEXT NOT NULL,                -- the party's six-digit room-server code
	at INTEGER NOT NULL,
	PRIMARY KEY (recipient, sender)
);
CREATE INDEX invites_sender ON invites (sender, at);

-- Friends whose invites this account does not want to hear about (mute):
-- still friends, still listed, but nothing of theirs is pushed or kept.
CREATE TABLE mutes (
	account TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
	muted TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
	at INTEGER NOT NULL,
	PRIMARY KEY (account, muted)
);
CREATE INDEX mutes_muted ON mutes (muted);

-- When a friend request was last pushed to someone, per pair: at most once a
-- day, however often it is withdrawn and asked again.
CREATE TABLE request_pushes (
	asker TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
	target TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
	at INTEGER NOT NULL,
	PRIMARY KEY (asker, target)
);
CREATE INDEX request_pushes_target ON request_pushes (target);
