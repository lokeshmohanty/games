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
| Wins against bots: their runs, the per-game minimums, the boards | the room server + D1 `runs` (`vs` 'bots'), `bot_wins` | `worker/api/bots.js`, `worker/migrations/0004_bot_wins.sql` |
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
- **Wins against bots have boards of their own** (2026-11-15: "ensure that
  games which allow singleplayer have leaderboard like neon survival",
  choice (b)) — one per game with bots, apart from the ranked boards
  because they can be farmed and mean nothing across games. Same level of
  checking as a solo run: a server-issued run, a minimum match length, a
  daily cap (below, "Against bots"). They never touch a rating.
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
5. Played alone, there is nobody to agree with — see "Solo runs". Played
   against bots and won, it goes to the game's board of wins against bots —
   see "Against bots".

## Solo runs (harder to fake)

*Lokesh, 2026-11-15: recommendations 1 (server-issued runs) and 2 (Sudoku
verified on the server); hardened after an adversarial review the same day.
Contract: `worker/api/runs.js`.*

**Only the games in `SOLO` (worker/api/runs.js) rank when played alone** —
Neon Survival, Sudoku and Light Cycles today. Every other game, and any id that is not a
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
| `lokeshmohanty/light-cycles` | races: wins (`ffa`); alone: best score, `lokeshmohanty/light-cycles@alone`, in seconds (`unit` "s") | 3 s (the 3.2 s countdown; the fastest crash alone is 4 squares after GO: 3.6 s of ticks, a 0.4 s score) | the time survived, seconds to the tenth, 0 to 1 + seconds since the run began |

**Boards are pinned.** A `SOLO` game's board kind comes from `SOLO`, never
from its latest match, so a solo run and a multi-player match cannot flip
it. Neon Survival's multi-ship runs are free-for-all matches; their
per-player scores also go to the best-score board (`commit` records `best`
for any match of a game whose board is "coop"). Their wins are still
counted in `ratings` but a best-score board does not show them. Sudoku's
`/api/lb/lokeshmohanty/sudoku` (and each level's) answers with `levels`, and
the leaderboard view shows a strip: Races · Easy · alone · … (`?level=`).

**Light Cycles alone** (web-games 4cc6e1a, branch `light-cycles-solo`).
With one rider, the round's result carries `scores: { id: seconds }` — the
race time ridden before the crash, **in tenths of a second**, rounded down
(23.4) — and the end card's details (time survived, squares ridden).
Tenths, not steps, because a step shortens from 100 to 60 ms as a round goes
on: a count of steps is not a time, and only a time can be bounded by the
server's clock. The bound is the strong check: the score may not pass 1 s
plus the seconds since the run was issued — and since the countdown (3.2 s)
is in that time but never in the score, a real round has more in hand. The
race time also stops while the host's tab is hidden; the server's clock
does not. Light Cycles' races keep the game's own board (wins), so solo
rounds rank on a level of their own, `@alone` (SOLO `levels: ["alone"]`,
`plain: "ffa"`), and the view's strip reads Races · Alone. Its rows say
"3.5 s" (the board's `unit`). A score must be a whole number of tenths.
**Until the pin moves** (registry still at 63360fd), the served Light Cycles
sends no score, so a solo round is refused ("no usable one").

**Sudoku, verified — within the free plan's 10 ms.** The game deals attempt
k of a puzzle from its own random stream (`streamOf(key, k)`): its full grid
first, `solutionFor(key, k)`, then the cells it takes away while the puzzle
keeps exactly one solution (web-games `sudoku/sudoku-rules.js`, commit
b90aafb; the key is `seedKey(seed, level)`, or `dailyKey(date, level)`). Its
solo result carries `proof: { start, level, daily, attempt, grid }`. The
puzzle having one solution, the only grid that solves it is its full grid,
so the server needs no removal and no uniqueness search: `worker/api/sudoku.js`
holds a **copy** of only the grid code, the seeded streams and the
randomized full-grid search, up to `solutionFor` (source lines and commit at
its top), and checks, cheapest first:
- the difficulty, how it was dealt (`new`, or `daily` for a date within 36 h
  of now; a resumed puzzle is not ranked), `attempt` a whole number 0–11,
  the grid's format;
- the server's time since the run began and the reported time are at least
  the difficulty's fastest plausible solve: easy 30 s, medium 45 s, hard
  60 s, expert 90 s (`MIN_SOLVE_S`);
- a daily puzzle: **one ranked per account per day per difficulty** (unique
  index `runs_daily`, so racing reports cannot both count);
- then the grid equals `solutionFor(key, attempt)`.

A player could name another attempt of the same seed than the one dealt;
every such grid is computable from the seed anyway, so it changes nothing —
the bound, as everywhere here, is the clock.

The time recorded is **max(reported, server time since the run began −
60 s)** (`CLOCK_SLACK_S`: the run begins before the puzzle is picked, and
the first-open rules sheet may sit in between), in seconds, lowest best. If
the game's generator changes, the copy must change with it: `just
test-accounts` compares the server's `solutionFor` with the grid the game's
`generate()` deals, for the attempt it used, for 236 puzzles (seeds and
dailies at every difficulty) and every attempt of one seed, when
`../web-games-v2` is checked out.

**CPU (Lokesh, 2026-11-15: everything within the Workers free plan, 10 ms of
CPU per request and per cron run).** Measured in Node, warm (JIT), and with
`--jitless` as a stand-in for a cold isolate; D1 and fetches are I/O, not
CPU, and are not in these:

| Path | Cost | Bound |
|---|---|---|
| Sudoku check, `solutionFor` | 2000 seeds per level: avg 0.08 ms, p95 0.10, p99.9 0.5, max 1.1 (warm); avg 3.0, max 4.9 (jitless); module load ~1.7 ms + first call ~2.5 ms on a fresh process | — |
| Hourly snapshot | 12 boards × 100 rows + summary/index of 300 games, built, digested and all sent: median 2.0, max 5.5 ms; nothing changed: ~1.1; the App JWT on a cold isolate (RSA-2048 import + sign): 2–4 ms more | `BOARDS_PER_RUN` = 12, longest-unchecked first; only changed files are sent, over the last tree (`base_tree`); a board nobody is ranked on any more is deleted. Before: every board every run, ~4.8 ms at 30 boards and 17.5 at 120 |
| A group's board (replays its matches) | ~1.7 ms per 1000 matches warm, ~2.2 jitless; 20 000 matches was 16.5 / 41 ms | the most recent `GROUP_REPLAY` = 2000 matches (worker/api/lb.js) |
| Export | ~0.75 ms per 1000 matches | `EXPORT_PAGE` = 2000 matches a page, `?page=`, `matchesNext`; the profile's EXPORT gathers every page |
| Room server relay (hub) | a 1 MiB message (the WebSocket limit) parsed and relayed to one member: ~3 ms; rooms hold ≤ 8 | — |
| Sign-in, sessions, vault | HMAC and AES-GCM on short strings: well under 1 ms | — |
| A win against bots (`POST /api/match/report`), a run start, a Light Cycles solo report, a 100-row board against bots | D1 faked as instant, 2000 calls each: avg 0.03 / 0.03 / 0.11 / 0.005 ms, max 1.9 ms (warm); avg 0.07 / 0.08 / 0.20 / 0.02 ms, max 0.5 ms (jitless); the first call on a fresh process ~1 ms | 4 D1 statements for a win; the board is one indexed query (`bot_wins_board`) plus two for `me` |

**Until the Sudoku pin moves.** The arcade serves the pinned Sudoku
(registry `lokeshmohanty/web-games.json`, commit 2997566), which ignores
the seed and sends no proof, so a solo Sudoku is refused ("…has none")
until web-games b90aafb is pushed and the pin moves to it. That commit
also changes every puzzle generate() deals, today's daily included.

**What it does not stop.** A player who waits out the clock and then
reports an invented score under the ceiling, up to 50 times a day. Runs
make faking slow and bounded. Sudoku's report is checked against the game
itself, but the solution travels in the game's own state on the player's
phone, so even there the real bound is the clock, not proof of play.
Multi-player Neon Survival scores are confirmed by two players' agreeing
reports, not capped.

## Against bots (a board of their own)

*Lokesh, 2026-11-15: "ensure that games which allow singleplayer have
leaderboard like neon survival" — choice (b): every game with bots gets a
board of wins against bots, apart from the real ranked boards, because it
can be farmed and is not comparable across games; anti-cheat at Neon
Survival's level (a one-use server-issued run, a minimum duration, a
ceiling — here a daily cap), within the free plan. Contract:
`worker/api/bots.js`.*

**Only the games in `BOTS` (worker/api/bots.js) have one** — every game
with bots and a winner: Tic Tac Toe (`tic-tac-toe-js`, the listed one),
Connect 4, Neon Fission, Neon Bid, Battleship, Liar's Dice, Light Cycles,
Sudoku. Neon Survival is co-op (nobody wins); Draw & Guess and Undercover
have no bots. Adding a game is one entry (its `minMs`).

**Who counts as "the only person".** The device decides, then the server
re-checks what it can see:
- the page reports only when it is the one person in the result's ranking
  and every other id is a bot (`bot_…`), it won (first place alone; in a
  team game, with bot teammates), and the run was issued for this game
  against bots;
- not when the game names a bot seat as a person (result `names`): Neon
  Fission's PLAYER seats are people passing the host's phone, which the
  platform sees as bot seats. A pass-the-phone game is a game among
  people, so it is not a win against bots (the device's own stats still
  file it under "vs bots"). Undercover is `kind: "local"`, never reported;
- not when a bot seated at the run's start, or one in the result, has left
  the party: most games hand the match to whoever is left when a bot is
  removed (Connect 4, Battleship, Liar's Dice, Light Cycles, Neon Fission),
  so REMOVE BOT would otherwise be a free win (found measuring, 2026-11-15);
- the server refuses a ranking without exactly one person, a person who is
  not the reporter, no bot, or a reporter who did not win outright.

**The run.** As a managed match begins with this player alone among bots,
`lib/sdk-managed.js` asks `POST /api/run/start { game, vs: "bots" }` —
*not waited for*: it is only the clock a win is checked against, so a
match against bots never waits on the network (a solo run waits, for its
seed). A game that runs its own matches (Neon Bid, Battleship, Liar's
Dice) is asked for by `lib/sdk-host.js` as the game starts and again as
each result lands, before the next match can begin. `lib/account.js` keeps
one run per game; a result spends it whatever becomes of it, a newer start
replaces it, and a late answer to an older start is dropped — so a
rematch's result can never post twice, and the old match is stopped
before the new run is asked for (`start()` stops ticker and bots first).

**The checks** (cheapest first; the run is claimed only after all pass,
conditionally, as for solo runs): a game in `BOTS`; a kind with a winner;
the people and the win, above; the run exists, is the reporter's, for this
game, a run against bots (not a solo run — nor the reverse), under 6 h old
and unused; fewer than **20 counted wins against bots per account per game
in the last day** (`BOTS_PER_DAY`); and at least the game's `minMs` since
the run began (server clock). Then `bot_wins` gains one, `at` the time.

| Game | `minMs` | The fastest legal win, and how it was found |
|---|---|---|
| `tic-tac-toe-js` | 1.8 s | the bot (win, block, centre, first free) is deterministic: every human line searched, a win needs at least 3 bot moves × 600 ms (4 moving second); 15 of 505 lines win. Played in the browser: a 4-move fork took 3.8–4.3 s from the run |
| `connect4` | 3.6 s | depth-5 minimax, deterministic: an exhaustive search proved no win within 6 human moves (first) or 5 (second), so at least 6 bot moves × 600 ms; a depth-8 human searcher's fastest of 8 wins in 20 games took 11 bot moves (6.6 s) |
| `neon-fission` | 1.8 s | the rules allow a win after one bot move (0.6 s: load a corner, burst it into the bot's cell); a search over the 54 cells found none within 3 human moves for 3 bot seeds, so 1.8 s — searched, not proven for every seed; a greedy human's fastest of 153 wins in 300 games took 27 s |
| `neon-bid` | 38 s | fixed: 12 lots, each ending with a 3.2 s show, and the result only after the last (lib/rounds.js onFinish) — 38.4 s whatever anyone bids |
| `lokeshmohanty/battleship` | 9.5 s | 12 fleet cells, one shot a volley, 0.9 s resolve between volleys: 11 × 0.9 = 9.9 s; fastest of 9640 simulated wins: 14 volleys, 11.7 s |
| `lokeshmohanty/liars-dice` | 17.5 s | 5 dice; the bot loses one only in a round where it acts (a 750 ms pause), with a 3.5 s reveal between rounds: 5 × 0.75 + 4 × 3.5 = 17.75 s, met exactly in 20 000 simulated games (one bot; 42 s against two) |
| `lokeshmohanty/light-cycles` | 3.5 s | the 3.2 s countdown, then a step every 100 ms; no bot can crash before step 7 (six bots: 3.9 s; one bot: step 20, 5.2 s); fastest simulated win 5.3 s against three bots |
| `lokeshmohanty/sudoku` | 30 s | a race: the bot fills a cell every few seconds (≥ 180 s for an easy puzzle), so the human's own solve sets the pace — the solo floor for an easy puzzle (`MIN_SOLVE_S`) |

Times run from the match's `init`; the server measures from the run's
issue (just before) to the report (just after the result), so its time is
never shorter. The scripts are not in the repo (they drove the rules in
Node with the real bots); re-measure when a game's pace changes.

**The board** (`GET /api/lb/<game>?vs=bots`, `bot_wins`): wins, all time;
a tie goes to whoever reached the count first. Everyone (minus hidden
players), friends, or a group's members; your own row and rank (`me`).
On the leaderboard page a game with this board gets a switch under the
games, **Ranked · Against bots** (`?vs=bots`): the same podium and rows,
"Wins vs bots", each row saying when the count was reached, and a note that
it is kept apart. The profile lists the wins under the ratings, not in
them ("Wins against bots: Tic Tac Toe 1"); a counted win's toast says
"Counted: 3 wins against bots." Not in the hourly snapshot, so no offline
copy.

**What it does not stop.** The host's browser plays the bots and is
trusted, so a player can make them lose, and a forged report that waits
out `minMs` counts. The cap (20 a game a day) and the minimum bound how
fast a board climbs; nothing proves a game was played. In a Sudoku race
the host does not time the human's solve, so `minMs` is the only bound
there. That is why these boards are apart from the ranked ones.

## The API

Everything under the room server, `https://neon-arcade-room.lokeshmohanty.workers.dev`
(or `?rs=` on loopback for development). Writes are limited to 120 per
address per 5-minute window (IpGate `api`).

| Route | Who | |
|---|---|---|
| `GET /auth/{github,google}/start?back=` → `…/callback` | anyone | sign in; back to `back#token=` |
| `GET /auth/test?name=&uid=&back=` | tests only (`AUTH_TEST=1`, loopback host) | |
| `GET/PATCH/DELETE /api/me`, `GET /api/me/export[?page=]`, `POST /api/me/signout` | signed in | profile, settings, delete, export (matches 2000 a page; `matchesNext`) |
| `GET/PUT /api/me/favs`, `GET /api/me/matches` | signed in | favs: game ids, `contributor:<login>`, `collection:<owner>/<repo>` (2026-11-15; same table, no migration) |
| `POST /api/stats/played`, `GET /api/stats/summary` | anyone | counts |
| `POST /api/match/report` | signed in | ranked results; played alone: `run` is the server's, plus the game's `proof` |
| `POST /api/run/start` | signed in | `{ game }` → `{ run, seed, at }`: a solo run (6 h, one counted report); `SOLO` games only. `{ game, vs: "bots" }`: a run for a match against bots; `BOTS` games only |
| `POST /api/admin/age-run` | tests only (`AUTH_TEST=1`, loopback host) | `{ run, ms }`: move a run's start into the past |
| `GET /api/lb/<game>?scope=global\|friends\|group:<id>` | global: anyone (`&me=1`: signed in) | signed in, also `me`: your row and rank even past the top 100, or `rank: null` with `need` (more games) or `hidden`; null with no ranked game. Global without `me=1` is the one cached publicly. Also `levels`, `unit` and `botsBoard` (the game has a board against bots) when they apply |
| `GET /api/lb/<game>?vs=bots&scope=…` | as above | the board of wins against bots: `kind: "bots"`, rows `{ rank, id, name, avatar, wins, first, at }`, `perDay`; `me` as above. No offline copy (not in the snapshot) |
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
| Solo runs and runs against bots: id, game, seed, start, used, counted, daily, `vs` | D1 `runs`, kept 4 days | no; deleted with the account |
| Wins against bots: game, count, first win, when the count was reached | D1 `bot_wins` | on the boards against bots, unless hidden; in the export (`winsAgainstBots`); deleted with the account |
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

`worker/migrations/0004_bot_wins.sql` (branch `solo-boards`, 2026-11-15)
adds `runs.vs` ('solo' for every existing row, or 'bots'), the index
`runs_vs`, and `bot_wins`. **Not applied or deployed.** It needs 0003
first (it alters `runs`), and the Worker that reads `runs.vs` must not be
deployed before it — every run start and solo report would fail. So, from
`worker/`, once the branch is merged:

1. `wrangler d1 migrations list arcade --remote` — shows what is pending
   (0003 too, if it still is).
2. `wrangler d1 migrations apply arcade --remote` — applies them in order.
3. `wrangler deploy`.
4. Check, signed in: win a Tic Tac Toe against the bot — "Counted: 1 win
   against bots."; the leaderboard's Tic Tac Toe → Against bots lists you;
   its Ranked board does not. Once the web-games pin moves past 4cc6e1a:
   ride Light Cycles alone — Light Cycles → Ranked → Alone lists the time.

A Worker from before 0004 never issues a run against bots (it answers 400
or 404), so the page sends no win; nothing breaks while it waits.

## Testing

- `just test-stats` — lib/stats.js in Node.
- `just test-accounts` — the API under `wrangler dev` with a local D1 and a
  fake GitHub/Google (OAuth, App JWT, GraphQL, Git Data); solo runs (issued,
  reused, expired, forged, too fast, over the ceiling, bad scores, games not
  in `SOLO`, pinned boards, the daily cap, racing claims) and Sudoku's check
  (valid, not a solution, another puzzle's clues, too fast, the clock floor,
  per-level boards, one daily), with the server's generator compared to the
  game's (`SOLO_PER_DAY` is 8 there); Light Cycles alone (counted on
  `@alone` in seconds, over the clock refused, not tenths refused, too
  fast); wins against bots (counted, reused run, too fast, a loss and a
  draw, another person in the match, no run, another's run, solo and bots
  runs crossed, a kind with no winner, the daily cap per game —
  `BOTS_PER_DAY` is 3 there — ties to whoever got there first, `me`,
  friends, no rating or ranked board touched, export, delete).
- `just test-social` — the whole flow in two browsers at 390×844, and a
  Neon Survival run played alone: issued, reported under its run, counted;
  a Light Cycles round alone (skipped while the served Light Cycles has no
  score: build from the branch, below); a Tic Tac Toe won against the bot
  (run asked for as the match begins, reported once, PLAY AGAIN asks for a
  new one, counted on the board against bots and not the ranked one), and
  the board in Paper light, Paper dark and Neon (`NEON_SHOTS=dir` saves
  screenshots).
- To play Light Cycles from the `light-cycles-solo` branch:
  `NEON_LOCAL_REPOS=lokeshmohanty/web-games=../web-games-lc
  NEON_PIN_OVERRIDE=lokeshmohanty/web-games=<sha> node
  scripts/fetch-community.mjs`, then `NEON_DIST=… just build` (the clone
  rule: scripts/fetch-community.mjs `checkout()` uses `../<repo>` only if it
  has the commit, so a clone under another name is named explicitly).
- `test-bots` checks a result reaches the device's stats and the portal.
