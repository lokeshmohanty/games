-- worker/migrations/0007_records.sql — personal records and achievements,
-- synced from each device (branch `records`, 2026-11-24). worker/api/records.js
-- is the contract; docs/accounts.md "Records and achievements" the design.
--
-- Additive only: a Worker from before it never reads this table. Apply it
-- before deploying the Worker that does (docs/accounts.md "Migrations"):
-- the new Worker reads it on every profile a friend opens and on account
-- deletion.

-- One row per account and game: the device's state for that game as
-- lib/achievements.js cleans it (unlocked achievements and when, progress,
-- records, the game's stats), JSON, at most RECORD_BYTES. `game` is a game's
-- id or "*" (the platform's own: games played, days in a row, Explorer).
-- Merged with what a device sends by taking the best of each, never
-- replaced. Shown to the account's friends only; deleted with the account.
CREATE TABLE records (
	account TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
	game TEXT NOT NULL,
	data TEXT NOT NULL,
	at INTEGER NOT NULL,               -- last changed
	PRIMARY KEY (account, game)
);
