-- worker/migrations/0002_identities.sql — one account, several sign-ins
-- (Lokesh, 2026-11-13: "register and connect both google/github"; feedback
-- needs a GitHub account connected).
--
-- An identity is one provider's user, attached to one arcade account. Signing
-- in with any of an account's identities is signing in to that account.
-- accounts.provider / provider_uid stay as they were (the first sign-in) but
-- nothing reads them for sign-in any more.

CREATE TABLE identities (
	provider TEXT NOT NULL,            -- "github" | "google" | "test"
	provider_uid TEXT NOT NULL,        -- the provider's stable user id
	account TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
	login TEXT,                        -- GitHub's username (shown with feedback); null elsewhere
	avatar TEXT,
	linked INTEGER NOT NULL,
	PRIMARY KEY (provider, provider_uid)
);
CREATE INDEX identities_account ON identities (account);

INSERT INTO identities (provider, provider_uid, account, login, avatar, linked)
	SELECT provider, provider_uid, id, NULL, avatar, created FROM accounts;

-- A GitHub identity's user token from the arcade's GitHub App (Lokesh,
-- 2026-11-13: feedback is posted from the player's own GitHub account). The
-- App limits it to Discussions on lokeshmohanty/games. AES-GCM encrypted
-- with a key derived from SESSION_KEY; gone on disconnect or account delete.
ALTER TABLE identities ADD COLUMN token_enc TEXT;
ALTER TABLE identities ADD COLUMN token_exp INTEGER;
ALTER TABLE identities ADD COLUMN refresh_enc TEXT;
