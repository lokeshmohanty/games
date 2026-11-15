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
| Profile, leaderboards views | the page | `./?page=profile` (`src/views/Profile.tsx` + `lib/profile.js`), `./?page=leaderboard` (`src/views/Leaderboard.tsx` + `lib/leaderboard.js`); docs/spa.md |
| The API | the room server (Cloudflare Worker) | `worker/api/*.js` |
| Accounts, matches, ratings, friends, groups | D1 database `arcade` | `worker/migrations/0001_accounts.sql` |
| Solo runs: issued runs and their seeds, the per-game limits, Sudoku's check | the room server + D1 `runs` | `worker/api/runs.js`, `worker/api/sudoku.js`, `worker/migrations/0003_runs.sql` |
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
- **A run played alone ranks on its own report** (2026-11-15) — one
  player, no bots, and only in the games the server has limits for
  (Neon Survival, Sudoku) — under a run the server issued as it began, and
  only if it passes the server's checks (below, "Solo runs"). Recorded as a run
  (games, best score), never a win, never Elo.
- **Feedback from the player's own GitHub account** (changed 2026-11-13:
  "the discussions should be from the users account"; "for feedback, require
  github account — he can register and connect both google/github"). One
  arcade account holds several sign-ins (D1 `identities`); GitHub sign-in
  and "Connect GitHub" both go through the arcade's **GitHub App**, whose
  user token can only do what the App may — Discussions on
  lokeshmohanty/games — and it is **kept, encrypted** (worker/api/vault.js:
  AES-GCM under a key derived from SESSION_KEY; refreshed when it expires;
  deleted on disconnect or account deletion) so a comment is posted as the
  player, "via" the App. The App still opens each game's thread. No giscus,
  and the old GitHub OAuth app is retired.
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
5. Played alone, there is nobody to agree with — see "Solo runs".

## Solo runs (harder to fake)

*Lokesh, 2026-11-15: recommendations 1 (server-issued runs) and 2 (Sudoku
verified on the server); hardened after an adversarial review the same day.
Contract: `worker/api/runs.js`.*

**Only the games in `SOLO` (worker/api/runs.js) rank when played alone** —
Neon Survival and Sudoku today. Every other game, and any id that is not a
game, is refused: no run is issued for it, and a solo report for it does
not count. Adding a game means adding its limits there.

1. A signed-in player starts a managed game **alone** (one seat, theirs, no
   bots). Before the rules' `init`, `lib/sdk-managed.js` asks
   `NeonArcade.account.startRun(game)` → `POST /api/run/start { game }` →
   `{ run, seed, at }` (400 for a game not in `SOLO`; 429 past 200 runs a
   day). The server keeps the run with the account, the game, the seed and
   its own clock (D1 `runs`). The game's `init` gets that `seed`. Signed
   out, offline, not a `SOLO` game, or no answer within 2.5 s: a local
   seed, and the run simply does not rank (the leaderboard says so).
2. At the end, `lib/account.js` reports it with `run` = the server's run (not
   the party's) and the game's `proof`, if the result has one.
3. The server checks, and refuses with `{ counted: false, why }`: a game not
   in `SOLO`; a run unknown (a party run id, a forged one), another
   account's, another game's, older than **6 h**, or already counted; past
   **50 counted solo runs per account per day** (`SOLO_PER_DAY`); a score
   that is not a finite number from 0 up to the game's ceiling; then the
   game's own limits (below). **Only then is the run claimed** — late, so a
   refused report (or a Worker that runs out of CPU mid-check) leaves the run
   usable, and conditionally (`UPDATE … WHERE used IS NULL`), so two reports
   racing with one run cannot both count. The cost: a refused score can be
   re-sent lower; the ceilings are public anyway.

| Game | Board (pinned) | Shortest run (server clock) | Score |
|---|---|---|---|
| `neon-survival-mp` | best score — every run, alone or with others | 1 s (an unsteered ship can die 2 s in) | whole gems, 0 to 5 + 2 × seconds (at most 1.2 spawn a second) |
| `lokeshmohanty/sudoku` | races: wins (`ffa`); alone: **one time board per difficulty**, `lokeshmohanty/sudoku@<level>` | by difficulty, below | checked on the server, below |

**Boards are pinned.** A `SOLO` game's board kind comes from `SOLO`, never
from its latest match, so a solo run and a multi-player match cannot flip
it. Neon Survival's multi-ship runs are free-for-all matches; their
per-player scores also go to the best-score board (`commit` records `best`
for any match of a game whose board is "coop"). Their wins are still
counted in `ratings` but a best-score board does not show them. Sudoku's
`/api/lb/lokeshmohanty/sudoku` (and each level's) answers with `levels`, and
the leaderboard view shows a strip: Races · Easy · alone · … (`?level=`).

**Sudoku, verified.** The game deals a new puzzle with `puzzleFor(seed,
level)` from the init seed (arcade-games `sudoku/sudoku-rules.js`, commit
d05ae1d) and its solo result carries `proof: { start, level, daily, grid }`
— the 81-digit solved grid. `worker/api/sudoku.js` holds a **copy** of the
generator (named source and commit at its top). It checks, cheapest first,
generating the puzzle last:
- the difficulty, how it was dealt (`new`, or `daily` for a date within 36 h
  of now; a resumed puzzle is not ranked), the grid's format;
- the server's time since the run began and the reported time are at least
  the difficulty's fastest plausible solve: easy 30 s, medium 45 s, hard
  60 s, expert 90 s (`MIN_SOLVE_S`);
- the grid is a valid solution (every row, column and box);
- a daily puzzle: **one ranked per account per day per difficulty** (unique
  index `runs_daily`, so racing reports cannot both count);
- then the puzzle, regenerated from the run's seed (or the date): the grid
  keeps every clue.

The time recorded is **max(reported, server time since the run began −
60 s)** (`CLOCK_SLACK_S`: the run begins before the puzzle is picked, and
the first-open rules sheet may sit in between), in seconds, lowest best. If
the game's generator changes, the copy must change with it: `just
test-accounts` compares both for ten seeds at every difficulty when
`../arcade-games-v2` is checked out.

**CPU.** Regenerating a puzzle is the costly step. Measured with
`puzzleFor` in warm Node, 280 seeds per level (2026-11-15), avg / p95 / max
ms: easy 0.7 / 0.8 / 1.3, medium 1.1 / 1.6 / 2.5, hard 3.5 / 8.6 / 16,
expert 7.4 / 18 / 65 (an earlier review measured 0.8/10, 1.3/3, 3.8/21,
7.9/38 avg/max). The Workers free plan allows 10 ms of CPU per request:
hard and expert reports would often exceed it. **VERIFY the account's
plan** (a paid plan allows 30 s). A report cut off by the limit does not use
up its run.

**Until the Sudoku pin moves.** The arcade serves the pinned Sudoku
(registry `lokeshmohanty/arcade-games.json`, commit 2997566), which ignores
the seed and sends no proof, so a solo Sudoku is refused ("…has none")
until arcade-games d05ae1d is pushed and the pin moves to it.

**What it does not stop.** A player who waits out the clock and then
reports an invented score under the ceiling, up to 50 times a day. Runs
make faking slow and bounded. Sudoku's report is checked against the game
itself, but the solution travels in the game's own state on the player's
phone, so even there the real bound is the clock, not proof of play.
Multi-player Neon Survival scores are confirmed by two players' agreeing
reports, not capped.

## The API

Everything under the room server, `https://neon-arcade-room.lokeshmohanty.workers.dev`
(or `?rs=` on loopback for development). Writes are limited to 120 per
address per 5-minute window (IpGate `api`).

| Route | Who | |
|---|---|---|
| `GET /auth/{github,google}/start?back=` → `…/callback` | anyone | sign in; back to `back#token=` |
| `GET /auth/test?name=&uid=&back=` | tests only (`AUTH_TEST=1`, loopback host) | |
| `GET/PATCH/DELETE /api/me`, `GET /api/me/export`, `POST /api/me/signout` | signed in | profile, settings, delete, export |
| `GET/PUT /api/me/favs`, `GET /api/me/matches` | signed in | favs: game ids, `contributor:<login>`, `collection:<owner>/<repo>` (2026-11-15; same table, no migration) |
| `POST /api/stats/played`, `GET /api/stats/summary` | anyone | counts |
| `POST /api/match/report` | signed in | ranked results; played alone: `run` is the server's, plus the game's `proof` |
| `POST /api/run/start` | signed in | `{ game }` → `{ run, seed, at }`: a solo run (6 h, one counted report); `SOLO` games only |
| `POST /api/admin/age-run` | tests only (`AUTH_TEST=1`, loopback host) | `{ run, ms }`: move a run's start into the past |
| `GET /api/lb/<game>?scope=global\|friends\|group:<id>` | global: anyone (`&me=1`: signed in) | signed in, also `me`: your row and rank even past the top 100, or `rank: null` with `need` (more games) or `hidden`; null with no ranked game. Global without `me=1` is the one cached publicly |
| `GET /api/u/<id>` | anyone | public profile (404 when hidden) |
| `GET /api/friends`, `POST/DELETE /api/friends/<id>`, `POST /api/friends/<id>/invite` | signed in | |
| `GET/POST /api/groups`, `POST /api/groups/join`, `GET/DELETE /api/groups/<id>`, `DELETE /api/groups/<id>/members/<acct>` | signed in | |
| `GET /api/feedback/<game>` / `POST` | read: anyone; post: GitHub connected, 5 a day | posted as the player |
| `POST /api/me/link/<github\|google>`, `DELETE /api/me/identities/<provider>` | signed in | connect / disconnect a sign-in (never the last) |
| `wss /live` (subprotocols `["neon", token]`) | signed in | presence, invites |

CORS: signed-in answers name the asking origin only if it is in
`ALLOWED_ORIGINS` (default `https://www.lokeshmohanty.in,https://lokeshmohanty.github.io`)
or loopback; public reads are open.

## What is stored, and what is public

| Data | Stored | Public? |
|---|---|---|
| Display name, avatar URL | D1 `accounts` | name + avatar on a public profile and boards, unless hidden |
| Sign-ins: provider, provider user id, GitHub login | D1 `identities` | several per account (GitHub, Google); the GitHub login shows on your feedback |
| GitHub App user token + refresh token | D1 `identities`, AES-GCM encrypted | only to post your feedback as you; Discussions on this repo only; deleted on disconnect or delete |
| Sessions (id, expiry; 60 days, sliding) | D1 `sessions` | no |
| Favourites, friends, groups, presence | D1 | no (friends see each other online unless "appear offline") |
| Ranked matches and ratings | D1 | on boards and public profiles, unless hidden |
| Solo runs: id, game, seed, start, used, counted, daily | D1 `runs`, kept 4 days | no; deleted with the account |
| Play counts per game | D1 `plays` | yes (summary, snapshot) |
| Feedback text | GitHub Discussions | yes, with the display name |
| Hourly snapshot: counts + top 100 per game | GitHub branch `stats` | yes; hidden players left out |

Never stored: email; Google's token (used once to read the profile). The
GitHub App user token is the one provider token kept — encrypted, narrow,
and only so your feedback is your own.
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
3. **GitHub sign-in = the GitHub App** (since 2026-11-13; the OAuth app of
   the first setup is retired): in the App's settings set **Callback URL**
   `https://neon-arcade-room.lokeshmohanty.workers.dev/auth/github/callback`,
   keep **Expire user authorization tokens** ticked, **Generate a new client
   secret**, then `wrangler secret put GH_APP_CLIENT_ID` (the App's *Client
   ID*, not its App ID) and `GH_APP_CLIENT_SECRET`. Then
   `wrangler secret delete GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`, and
   delete the OAuth app on GitHub.
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

## Migrations

`worker/migrations/0002_identities.sql` adds `identities` (copying each
account's first sign-in) and the token columns: `wrangler d1 migrations
apply arcade --remote` before deploying a Worker that reads them.

`worker/migrations/0003_runs.sql` adds `runs` (solo runs). **Not yet applied
or deployed (2026-11-15).** Order matters — the new Worker reads and deletes
from `runs` (a report, `POST /api/run/start`, and account deletion), so
from `worker/`:

1. `wrangler d1 migrations apply arcade --remote` (applies 0003 only; check
   with `wrangler d1 migrations list arcade --remote`).
2. `wrangler deploy`.
3. Check: signed in, play Neon Survival alone for a minute — "Counted on the
   leaderboard."; a Sudoku solved alone appears on its board as a time.

Until then the deployed Worker (2dd27a0a, 2026-11-14 per STATUS.md: from
before solo runs ranked at all) answers `POST /api/run/start` with 404 — the page plays on a local seed
and sends no solo report — and would refuse one anyway ("a ranked match
needs two signed-in players").

## Testing

- `just test-stats` — lib/stats.js in Node.
- `just test-accounts` — the API under `wrangler dev` with a local D1 and a
  fake GitHub/Google (OAuth, App JWT, GraphQL, Git Data); solo runs (issued,
  reused, expired, forged, too fast, over the ceiling, bad scores, games not
  in `SOLO`, pinned boards, the daily cap, racing claims) and Sudoku's check
  (valid, not a solution, another puzzle's clues, too fast, the clock floor,
  per-level boards, one daily), with the server's generator compared to the
  game's (`SOLO_PER_DAY` is 8 there).
- `just test-social` — the whole flow in two browsers at 390×844, and a
  Neon Survival run played alone: issued, reported under its run, counted.
- `test-bots` checks a result reaches the device's stats and the portal.
