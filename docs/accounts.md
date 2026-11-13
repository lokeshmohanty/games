# Accounts, results and the social layer

*Built 2026-11-13 (branches `platform-2`). Plan of record:
`~/.claude/plans/1-a-b-2-generic-whistle.md`, Phases 1–6.*

Signing in is optional and changes nothing about playing: every game works
with no account, offline, from any page. An account adds favourites on every
device, ranked matches against people, friends online and party invites,
groups with their own leaderboards, and feedback on games.

## What runs where

| Piece | Where | File |
|---|---|---|
| This device's results, favourites, recently played | localStorage | `lib/stats.js` |
| Portal cards, stars, counts, account bar | the page | `lib/portal.js` |
| Token, API calls, favourites sync, match reports, live socket | the page | `lib/account.js` |
| Sign-in chooser, ADD FRIEND, INVITE, feedback sheet | the page | `lib/account-ui.js` |
| Profile, leaderboards pages | the page | `profile.html` + `lib/profile.js`, `leaderboard.html` + `lib/leaderboard.js` |
| The API | the room server (Cloudflare Worker) | `worker/api/*.js` |
| Accounts, matches, ratings, friends, groups | D1 database `arcade` | `worker/migrations/0001_accounts.sql` |
| Presence and pushed invites | Durable Object `UserLive`, one per account | `worker/api/live.js` |
| Feedback | GitHub Discussions, posted by the arcade's GitHub App | `worker/api/feedback.js` |
| Public hourly snapshot | GitHub branch `stats` | `worker/api/snapshot.js` |

Game frames never see any of it: they are sandboxed (docs/sdk.md), and the
token lives in the party page's localStorage only.

## Decisions (Lokesh, 2026-11-13)

- **Bearer token in localStorage**, not a cookie: the Worker is on
  `*.workers.dev`, another site, so a cookie would be third-party.
- **Leaderboards are human-only and confirmed**: a match counts when two
  players who were in it, each signed in, report the same result. Bots,
  one-phone games, dev-kit games and matches with fewer than two accounts
  never count. A disagreement voids the match.
- **Feedback via a GitHub App** with a "from <name>" byline — works for
  Google accounts and nobody grants the arcade access to their GitHub. No
  giscus.
- **D1 is the live store; GitHub holds an hourly public copy of the
  aggregates** (counts and the top 100 per game).
- **Google and GitHub OAuth, the GitHub App and D1** are the accepted outside
  services (memory `no-third-party-services`); multiplayer itself is
  unchanged.

## A result's journey

1. A game calls `ctx.reportResult(r)` on every peer (docs/sdk.md).
2. `lib/party.js` records it on the device once per run + match + ranking
   (`lib/stats.js`), then calls `NeonArcade.onResult`.
3. `lib/account.js`: the **host** sends `POST /api/stats/played` (anonymous,
   one count per match). A **signed-in** player in a match with people sends
   `POST /api/match/report` with `roster` — party member id → account id, read
   from each member's `acct` meta (which `attach` publishes).
4. The server (`worker/api/match.js`) keys the match by
   `sha256(game|run|match)`; the first report waits, the second matching one
   **commits** it: `matches`, `match_players`, `ratings` (Elo for duels, K 32
   from 1200; wins; best co-op score). A pending reporter re-sends after 3, 8
   and 20 s so it hears that it counted.

## The API

Everything under the room server, `https://neon-arcade-room.lokeshmohanty.workers.dev`
(or `?rs=` on loopback for development). Writes are limited to 120 per
address per 5-minute window (IpGate `api`).

| Route | Who | |
|---|---|---|
| `GET /auth/{github,google}/start?back=` → `…/callback` | anyone | sign in; back to `back#token=` |
| `GET /auth/test?name=&uid=&back=` | tests only (`AUTH_TEST=1`, loopback host) | |
| `GET/PATCH/DELETE /api/me`, `GET /api/me/export`, `POST /api/me/signout` | signed in | profile, settings, delete, export |
| `GET/PUT /api/me/favs`, `GET /api/me/matches` | signed in | |
| `POST /api/stats/played`, `GET /api/stats/summary` | anyone | counts |
| `POST /api/match/report` | signed in | ranked results |
| `GET /api/lb/<game>?scope=global\|friends\|group:<id>` | global: anyone | |
| `GET /api/u/<id>` | anyone | public profile (404 when hidden) |
| `GET /api/friends`, `POST/DELETE /api/friends/<id>`, `POST /api/friends/<id>/invite` | signed in | |
| `GET/POST /api/groups`, `POST /api/groups/join`, `GET/DELETE /api/groups/<id>`, `DELETE /api/groups/<id>/members/<acct>` | signed in | |
| `GET /api/feedback/<game>` / `POST` | read: anyone; post: signed in, 5 a day | |
| `wss /live` (subprotocols `["neon", token]`) | signed in | presence, invites |

CORS: signed-in answers name the asking origin only if it is in
`ALLOWED_ORIGINS` (default `https://www.lokeshmohanty.in,https://lokeshmohanty.github.io`)
or loopback; public reads are open.

## What is stored, and what is public

| Data | Stored | Public? |
|---|---|---|
| Provider + provider user id, display name, avatar URL | D1 `accounts` | name + avatar on a public profile and boards, unless hidden |
| Sessions (id, expiry; 60 days, sliding) | D1 `sessions` | no |
| Favourites, friends, groups, presence | D1 | no (friends see each other online unless "appear offline") |
| Ranked matches and ratings | D1 | on boards and public profiles, unless hidden |
| Play counts per game | D1 `plays` | yes (summary, snapshot) |
| Feedback text | GitHub Discussions | yes, with the display name |
| Hourly snapshot: counts + top 100 per game | GitHub branch `stats` | yes; hidden players left out |

Never stored: email, provider access tokens (used once to read the profile).
**Delete** removes every row of the account at once; matches stay in the
other players' histories with the name shown as "(deleted)"; snapshots already
committed keep the old name and rating until the next one. **Export** returns
everything as JSON.

## Setting it up (Lokesh, once)

**Status 2026-11-13: done** — D1, all secrets, GitHub + Google OAuth apps,
the GitHub App and the "Game feedback" category are set; Worker version
b35232de deployed with the D1 binding, `UserLive` and the cron. Verified
live: the API, both providers' redirects, back-page allowlist, test sign-in
off in production, the room server (`just test-live`). Not yet seen live: a
real person signing in, a ranked game between two real accounts, a posted
comment, the first `stats` commit (at :07 past the hour).

Before that: the site works without it — signed out, every page
behaves as before — but `wrangler.toml` now declares the D1 binding, so the
**room server cannot be redeployed until step 1 gives it a real database id**.
Until the secrets exist, sign-in answers 503 "not set up", and feedback and
the snapshot are skipped.

1. **D1** — *done 2026-11-13*: `arcade`, APAC, id `893ae81c-0572-4e96-95fa-50f47747b6da`
   (in `wrangler.toml`), migration 0001 applied remotely.
2. **Session key**: `node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64"))' | wrangler secret put SESSION_KEY`
   (not `openssl`: it is not installed on this machine, and an empty pipe
   uploads an empty key — which happened once, 2026-11-13).
3. **GitHub OAuth app** (github.com → Settings → Developer settings → OAuth
   Apps): callback `https://neon-arcade-room.lokeshmohanty.workers.dev/auth/github/callback`;
   `wrangler secret put GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`.
4. **Google OAuth client** (console.cloud.google.com → APIs & Services →
   Credentials → OAuth client ID, *Web application*): redirect URI
   `…/auth/google/callback`, consent screen with scopes `openid`, `profile`;
   `wrangler secret put GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
5. **GitHub App** (Settings → Developer settings → GitHub Apps → New): no
   webhook; repository permissions **Discussions: read & write** and
   **Contents: read & write**; install it on `lokeshmohanty/games` only.
   `wrangler secret put GH_APP_ID`, and the downloaded private key:
   `wrangler secret put GH_APP_KEY < key.pem` (PKCS#1 as GitHub gives it is
   fine). On the repository: enable Discussions and add a category named
   **Game feedback** (announcement-style, so only the App starts threads).
6. **Deploy**: `wrangler deploy` (the `UserLive` class migration `v3` and the
   hourly cron come with it).
7. Check: sign in on the site with each provider; play a ranked game with a
   second account; wait for :07 past the hour and look at the `stats` branch.

## Testing

- `just test-stats` — lib/stats.js in Node.
- `just test-accounts` — 100 checks on the API under `wrangler dev` with a
  local D1 and a fake GitHub/Google (OAuth, App JWT, GraphQL, Git Data).
- `just test-social` — the whole flow in two browsers at 390×844.
- `test-bots` checks a result reaches the device's stats and the portal.
