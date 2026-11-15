-- worker/migrations/0004_bot_wins.sql — wins against bots, on their own boards
-- (Lokesh, 2026-11-15: "ensure that games which allow singleplayer have
-- leaderboard like neon survival", choice (b)). worker/api/bots.js is the
-- contract.
--
-- A run is now either a solo run (`vs` 'solo', every row before this) or a
-- match against bots (`vs` 'bots'), issued by POST /api/run/start as such a
-- match begins and used up by the one win that names it. The wins are kept
-- apart from `ratings`: farmable, and not comparable across games, so they
-- never move a rating or a ranked board.

ALTER TABLE runs ADD COLUMN vs TEXT NOT NULL DEFAULT 'solo';
-- The per-game daily cap counts a player's counted runs of one kind and game.
CREATE INDEX runs_vs ON runs (account, vs, game, counted, used);

CREATE TABLE bot_wins (
	account TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
	game TEXT NOT NULL,
	wins INTEGER NOT NULL DEFAULT 0,
	first INTEGER NOT NULL,            -- the first counted win
	at INTEGER NOT NULL,               -- when `wins` was reached: ties go to the earlier
	PRIMARY KEY (account, game)
);
CREATE INDEX bot_wins_board ON bot_wins (game, wins DESC, at);
