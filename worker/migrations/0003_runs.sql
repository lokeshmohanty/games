-- worker/migrations/0003_runs.sql — server-issued solo runs (Lokesh,
-- 2026-11-15: harder-to-fake solo scores). worker/api/runs.js is the contract.
--
-- POST /api/run/start writes one row as a signed-in player starts a SOLO game
-- alone; the solo report that names it and passes the checks uses it up
-- (`used`, `counted`). A run may be reported for 6 h; rows are kept 4 days
-- (the per-day count, Sudoku's one ranked daily) and go with the account.

CREATE TABLE runs (
	id TEXT PRIMARY KEY,               -- random, handed to the player
	account TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
	game TEXT NOT NULL,
	seed INTEGER NOT NULL,             -- passed to the game's init (31-bit)
	at INTEGER NOT NULL,               -- the server's clock when it was issued
	used INTEGER,                      -- when a report claimed it; null until then
	counted INTEGER NOT NULL DEFAULT 0, -- 1 once a report counted with it
	daily TEXT                         -- Sudoku: "<date>:<level>" of a ranked daily puzzle
);
CREATE INDEX runs_at ON runs (at);
CREATE INDEX runs_account ON runs (account, at);
CREATE INDEX runs_counted ON runs (account, counted, used);
-- One ranked daily puzzle per account, day and difficulty.
CREATE UNIQUE INDEX runs_daily ON runs (account, daily) WHERE daily IS NOT NULL;
