-- worker/migrations/0009_drop_boards.sql — the old ranked layer's tables go
-- (branch `drop-boards`, 2026-11-26; Lokesh approved). docs/accounts.md
-- "No boards (2026-11-25)" is the design.
--
-- `ratings` (0001), `runs` (0003, 0004) and `bot_wins` (0004) have not been
-- written since 2026-11-25 (no boards: party standings and head-to-head
-- only). Nothing references them: their foreign keys point out, to
-- `accounts`, and no trigger was ever made. Dropping a table drops its
-- indexes (ratings_game, runs_at, runs_account, runs_counted, runs_daily,
-- runs_vs, bot_wins_board) with it.
--
-- Destructive. The Worker from this branch no longer reads or deletes them;
-- the Worker before it does (the export, account deletion), so between this
-- migration and `just deploy-worker` those two answer 500. Apply it, then
-- deploy straight after (deploy-worker refuses while it is pending).

DROP TABLE IF EXISTS bot_wins;
DROP TABLE IF EXISTS runs;
DROP TABLE IF EXISTS ratings;
