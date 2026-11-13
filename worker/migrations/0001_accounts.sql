-- worker/migrations/0001_accounts.sql — the D1 database "arcade": accounts,
-- results, ratings, friends, groups, feedback. docs/accounts.md explains each
-- table and what is public. No email and no provider token is ever stored.

CREATE TABLE accounts (
	id TEXT PRIMARY KEY,               -- our public id (random), never the provider's
	provider TEXT NOT NULL,            -- "github" | "google" | "test"
	provider_uid TEXT NOT NULL,        -- the provider's stable user id
	name TEXT NOT NULL,                -- display name, editable
	avatar TEXT,                       -- provider avatar URL
	created INTEGER NOT NULL,
	hide_public INTEGER NOT NULL DEFAULT 0,    -- out of public leaderboards and snapshots
	appear_offline INTEGER NOT NULL DEFAULT 0, -- friends never see us online
	UNIQUE (provider, provider_uid)
);

CREATE TABLE sessions (
	sid TEXT PRIMARY KEY,
	account TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
	created INTEGER NOT NULL,
	exp INTEGER NOT NULL               -- sliding: pushed on when used
);
CREATE INDEX sessions_account ON sessions (account);

CREATE TABLE favs (
	account TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
	game TEXT NOT NULL,
	PRIMARY KEY (account, game)
);

-- Anonymous: how often each game is played, reported by hosts.
CREATE TABLE plays (
	game TEXT PRIMARY KEY,
	count INTEGER NOT NULL DEFAULT 0,
	with_bots INTEGER NOT NULL DEFAULT 0,
	updated INTEGER NOT NULL
);

-- One player's word on how a match ended, until two agree (or it expires).
CREATE TABLE reports (
	match TEXT NOT NULL,               -- sha-256 of game|run|match
	account TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
	digest TEXT NOT NULL,              -- of the canonical result; reports must match
	payload TEXT NOT NULL,
	at INTEGER NOT NULL,
	PRIMARY KEY (match, account)
);
CREATE INDEX reports_at ON reports (at);

CREATE TABLE matches (
	id TEXT PRIMARY KEY,
	game TEXT NOT NULL,
	kind TEXT NOT NULL,
	ranking TEXT NOT NULL,             -- JSON [[account, …], …]
	scores TEXT,                       -- JSON {account: number} or null
	at INTEGER NOT NULL
);
CREATE INDEX matches_game_at ON matches (game, at);

CREATE TABLE match_players (
	match TEXT NOT NULL REFERENCES matches (id) ON DELETE CASCADE,
	account TEXT NOT NULL,
	place INTEGER NOT NULL,
	PRIMARY KEY (match, account)
);
CREATE INDEX match_players_account ON match_players (account);

CREATE TABLE ratings (
	account TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
	game TEXT NOT NULL,
	elo REAL NOT NULL DEFAULT 1200,    -- duel games
	games INTEGER NOT NULL DEFAULT 0,
	wins INTEGER NOT NULL DEFAULT 0,
	best REAL,                         -- co-op: best score
	PRIMARY KEY (account, game)
);
CREATE INDEX ratings_game ON ratings (game);

-- a asked b; "pending" until b accepts, then "friends" (one row per pair).
CREATE TABLE friends (
	a TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
	b TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
	state TEXT NOT NULL,
	at INTEGER NOT NULL,
	PRIMARY KEY (a, b)
);
CREATE INDEX friends_b ON friends (b);

-- Who is online, and in which game: written by the UserLive object.
CREATE TABLE presence (
	account TEXT PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
	online INTEGER NOT NULL,
	game TEXT,
	at INTEGER NOT NULL
);

CREATE TABLE groups (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	owner TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
	code TEXT NOT NULL UNIQUE,         -- the join code
	created INTEGER NOT NULL
);

CREATE TABLE group_members (
	grp TEXT NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
	account TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
	joined INTEGER NOT NULL,
	PRIMARY KEY (grp, account)
);
CREATE INDEX group_members_account ON group_members (account);

-- One GitHub Discussion per game; posts per account per day are counted here.
CREATE TABLE feedback_threads (
	game TEXT PRIMARY KEY,
	discussion_id TEXT NOT NULL,
	url TEXT NOT NULL
);
CREATE TABLE feedback_log (
	account TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
	at INTEGER NOT NULL
);
CREATE INDEX feedback_log_account ON feedback_log (account, at);

-- Small worker state: the last snapshot's digest, the GitHub ids it found.
CREATE TABLE kv (
	k TEXT PRIMARY KEY,
	v TEXT NOT NULL
);
