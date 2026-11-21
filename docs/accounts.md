# Accounts, results and the social layer

*Built 2026-11-13 (branches `platform-2`), Phases 1–6 of the platform plan.*

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
| Sign-in chooser, ADD FRIEND, INVITE, a pushed request's ACCEPT/DECLINE, "Players you just played", the shared friends list, feedback sheet | the page | `lib/account-ui.js` |
| Profile, leaderboards views | the page | `./?page=profile` (`src/views/Profile.tsx` + `lib/profile.js`), `./?page=leaderboard` (`src/views/Leaderboard.tsx` + `lib/leaderboard.js`); docs/spa.md |
| The API | the room server (Cloudflare Worker) | `worker/api/*.js` |
| Accounts, matches, ratings, friends, groups | D1 database `arcade` | `worker/migrations/0001_accounts.sql` |
| The games the server knows, and their kinds | generated from the catalogs, bundled with the Worker | `worker/api/games.js` (`scripts/build-games-table.mjs`) |
| Friends, invites, groups (contract), public profiles | the room server + D1 (friend codes, bans, waiting invites, mutes) | `worker/api/social.js`, `worker/api/people.js`, `worker/migrations/0005_social.sql` |
| Solo runs: issued runs and their seeds, the per-game limits, Sudoku's check | the room server + D1 `runs` | `worker/api/runs.js`, `worker/api/sudoku.js`, `worker/migrations/0003_runs.sql` |
| Wins against bots: their runs, the per-game minimums, the boards | the room server + D1 `runs` (`vs` 'bots'), `bot_wins` | `worker/api/bots.js`, `worker/migrations/0004_bot_wins.sql` |
| Presence and pushed invites | Durable Object `UserLive`, one per account | `worker/api/live.js` |
| Invites as notifications (Web Push): devices, encryption, VAPID; the offer card and the profile switch; the notification and its tap | the room server + D1 `push_subs`; the page; the service worker | `worker/api/push.js`, `worker/api/webpush.js`, `worker/migrations/0006_push.sql`; `lib/push.js`; `sw.js` |
| Feedback | GitHub Discussions, posted by the arcade's GitHub App | `worker/api/feedback.js` |
| Public hourly snapshot | GitHub branch `stats` | `worker/api/snapshot.js` |

Game frames never see any of it: they are sandboxed (docs/platform.md), and the
token lives in the party page's localStorage only.

## Decisions (Lokesh, 2026-11-13)

- **Bearer token in localStorage**, not a cookie: the Worker is on
  `*.workers.dev`, another site, so a cookie would be third-party.
- **Leaderboards are human-only and confirmed**: a match counts when two
  players who were in it, each signed in, report the same result — and
  (2026-11-16, after an audit) only for the accounts that reported it
  themselves; see "Who a match counts for". Bots, one-phone games,
  dev-kit games and matches with fewer than two accounts never count. A
  disagreement voids the match.
- **Leaving a ranked match is a loss** (Lokesh, 2026-11-16), when the
  server can confirm the departure — "Leaving is a loss" below.
- **A skill rating for free-for-all and teams** (Lokesh, 2026-11-16):
  pairwise Elo in the same `elo` column as duels, provisional for a
  player's first 10 rated games; those boards order by it, wins still
  shown; the rating change is on the end card — "The rating" below.
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

1. A game sends `result` on every peer (docs/platform.md, "Results").
2. `lib/party.js` records it on the device once per run + match + ranking
   (`lib/stats.js`), then calls `NeonArcade.onResult`.
3. `lib/account.js`: as each match begins, every phone notes who is seated
   (`matchStart`, called by `lib/sdk-managed.js` — the host as it starts a
   match, a guest at its first view — and by `lib/sdk-host.js` for a game that
   runs its own matches); in a ranked match among signed-in people it also
   sends `POST /api/match/start` ("I am seated"). At the result the **host**
   sends `POST /api/stats/played` (anonymous, one count per match), and a
   **signed-in** player in a match with people sends `POST /api/match/report`
   with `roster` — party member id → account id, read from each member's
   `acct` meta (which `attach` publishes), or from the start for a member who
   has gone — `seats` (how many the match began with) and `left` (who of them
   left the party for good).
4. The server (`worker/api/match.js`) keys the match by
   `sha256(game|run|match)` and **commits** it when the rules below say so:
   `matches`, `match_players`, `ratings` (the rating for duel, free-for-all
   and teams; wins; best co-op score), all in one batch. A pending reporter
   re-sends after 3, 8, 20 and 40 s (71 s in all, past the 45 s grace) so it
   hears that it counted, and by how much: the answer's `rating` goes to the
   end card ("Rating +12 → 1534") and the toast.
5. Played alone, there is nobody to agree with — see "Solo runs". Played
   against bots and won, it goes to the game's board of wins against bots —
   see "Against bots".

## Who a match counts for

*An audit, 2026-11-15, found two colluding accounts could record a match —
a loss — for a third that never played it (account ids are public), and that
a party member's `acct` meta, being self-published, could name anyone. Fixed
2026-11-16, branch `social-ratings`. Contract: `worker/api/match.js`.*

A report names accounts; only the accounts that **reported the agreeing
result themselves** are recorded — `match_players`, ratings, wins, games.

- **At once**, when every account named in the result (except any it says
  left) has sent the same result.
- **After the grace** (`MATCH_GRACE_MS`, 45 s from the first report), with
  only the reporters, when at least two agree. It is decided at the next
  report of that match (the reporters' own re-sends reach past it), or when
  its reports expire (15 min: every report request and the hourly cron settle
  up to 5 expiring matches first — `sweep`).
- A named account that did not report gets nothing: it is not in the stored
  ranking, its profile does not list the match, and a late report of its own
  is told "this match counted without your report". The one exception is the
  leaver rule.
- A different result from an account another report names voids the match
  (kv `void:<match>`, kept 1 h, then deleted by the sweep).
- So claiming another account's id in the party record is harmless: that
  account would have to report the match, or have said itself that it sat
  down in it (below).

**Guests** (no account) drop out of their place but the place stays: in a
free-for-all second behind a guest is second — not a win — though beating
the signed-in player in third still raises the rating. On a team the side
keeps its place, so the guest's side still wins or loses.

**One atomic commit.** The match, its players, every rating and the
reporters' outcomes are one D1 batch, whose first statement is a plain
`INSERT` of the match: a second commit of the same match (two last reports
at once) fails on its primary key and rolls back whole; an account that no
longer exists is left out before the batch (it used to write `matches`, fail
on the foreign key, and answer "counted, already" ever after). Ratings change
by increments (`games + 1`, `wins + w`, `elo + delta`, `MAX`/`MIN` of best),
computed from the ratings read just before, so two matches committing at
once for one account both count (the old read-compute-overwrite lost one).

## Leaving is a loss

*Lokesh, 2026-11-16: "if a signed-in player leaves a ranked match that the
others finish and report, it counts as a loss for the leaver, after the
existing reconnect grace" — designed so it cannot be used against someone
who did not leave.*

A player has **left** when the party says so: LEAVE PARTY (onPeerLeave after
2.5 s), or a seat no longer held once the 5-minute reconnect grace ran out —
a closed tab is held, so a match that ends inside the grace is not a loss.
Each reporter's page lists, in `left`, the people seated as the match began
who are no longer members; it is part of the result, so the reporters must
agree on it. Leaving forfeits (`toAccounts`): a place the game left empty
for an emptied side goes first (games keep it for the devices' stats; a 1v1
whose leaver was ahead, `[[], [host]]`, becomes host first, leaver last);
then in a duel or free-for-all each leaver goes to a last place shared by the
leavers (a place only leavers held goes). **Teams** are booked by team —
each report carries `teams`, party id → team as the match began: a team all
of whose players left forfeits as a side, last; a player who left a team
that played on stays in their side's place (or, if that side won, goes last
alone), so the others' outcome is the game's — a draw stays a draw, and no
third side appears — and their loss is rated against the opposing teams
only (`sideDeltas`), never their teammates. (A report without `teams`, from
an older page, is booked as free-for-all. In a drawn team game the history
shows the leaver in the draw; the loss is in their rating and they get no
win. Group boards replay stored places without teams.) The server records
such an account only if, when the match is settled:

1. **its own page said it was seated in this very match** —
   `POST /api/match/start { game, run, match }`, sent by the leaver's page as
   the match began (the host as it starts it, a guest at its first view),
   kept as a `reports` row (digest `start`, key
   `sha256("start|game|run|match")`; `payload` keeps when it was first said,
   `at` its last beat; kept 1 h after that) — first said before the match's
   first report;
   not used up by any report of its own of that match (sent first thing,
   even when that report is then refused, voided or too late); and not
   withdrawn: when a match ends **without a result** while the page is still
   in the party — END GAME, the host leaving or switching games, being
   removed, the party closed — the page sends `DELETE /api/match/start`
   (`lib/account.js` `matchEnd`, `partyGone`). Leaving the party, or closing
   the page, keeps it. A departure that counts uses the start up too;
2. **two reporting accounts confirm it** — or the one player still there
   when everyone else left (a duel: the winner's report alone counts, with
   the leaver's own start as the evidence);
3. **the grace has passed** with no report of its own — a player still there
   who reports the real result voids the made-up one;
4. **its seated page has stopped beating** — the page re-posts its start
   every 60 s while the match runs, a failed beat once more 15 s later
   (`lib/account.js` `HEARTBEAT_MS`; free of the per-address write limit —
   only a new start is charged — but written at most once per 30 s per row
   (`BEAT_WRITE_MS`; a beat sooner is answered, not written), and never past
   2 h from the start (`START_MAX_MS`: then it ages out); an account keeps at
   most 3 live starts, a new one evicting its oldest — so beats cannot flood
   D1's 100 000 writes a day, a review, 2026-11-16), and a departure
   needs the last beat older than `MATCH_STALE_MS` (4.5 min: three lost
   beats in a row), whatever the account's other pages say. (The
   first version read `presence`, one row per account: a second page on the
   home screen made a player still in the match look gone, and one liar
   could book them a loss — a review, 2026-11-16.) The beat stops with the
   match's result, a withdrawal, the next match, or leaving the party. A
   report naming a leaver is re-sent for 251 s (not 71), past the 4.5
   minutes after a last beat at most 60 s before the leaving (a LEAVE PARTY
   that settles later than that is settled by the sweep, unseen on the card);
   a later report of the leaver's own is told the match counted **against**
   them ("Counted as a loss: you left"), on the toast and the end card.

So a colluder cannot name an account that never sat down with them in that
very match (1) — not a match number they make up, not a match that was
ended without a result — nor one still playing it (3, 4). An adversarial
review (2026-11-16) found the first version keyed starts by run only, so one
player could END GAME on a real opponent and then file a made-up "match 7"
won against them alone; and that a refused report left the start usable.
Both are closed above, as is the presence hole (rule 4). What it still does
not stop: a victim whose seated page is frozen for 4.5 minutes (a phone that
suspends the tab) while the match goes on; and a withdrawal lost to the
network. A report of ours that does not count — offline to its last
re-send, refused, or answered 429 or 5xx — withdraws our start, and reports
and withdrawals are sent with `keepalive` so one sent as the page closes
still goes; a withdrawal is exempt from the per-address write limit. A page
restored from the back-forward cache keeps withdrawing (only a real unload
latches).  **It
binds unmodified pages only**: the start is the player's own word, so a
modified page can withhold it, or withdraw it before leaving, and escape the
loss — and a host losing a duel can still END GAME so nothing is recorded.
It is a deterrent against leaving, not proof. A player whose connection drops for good
mid-match takes the loss, as one who left. Pages may also disagree about a
departure that lands right at the end (one saw the grace run out, one not):
that voids the match, as any disagreement does.

**Managed games only.** Only a managed game (`lib/sdk-managed.js`) knows a
match's number as it begins, so only managed games send starts: Neon
Fission, Light Cycles, Sudoku (and Draw & Guess until its pin moves to a
manifest without boards). In a game
that runs its own matches (Neon Bid, Battleship, Liar's Dice) a departure is
never recorded; the leaver gets nothing, and the others' match counts with
them only.

## The rating

*Lokesh, 2026-11-16 (approved: a skill rating for free-for-all and teams,
provisional early; the rating change on the end card).*

**Pairwise Elo** (`ratingDeltas`): every two players in different places are
a game, the one ahead winning (the same place: a draw); a player's change is
the sum over opponents of K × (score − expected), divided by the number of
opponents — so beating a stronger player counts more, and a duel is plain
Elo. **Teams**: each place is a side rated at its members' mean; the side's
change is shared by its members — each moves by it times the mean side size
over their own side's size (with their own K), so uneven sides still sum to
zero (3 against 1: +16 each against −48; a review, 2026-11-16). A side's
size is its players as the match began, leavers included, so a teammate
who stays shares the change with the one who left (−24, not −36); and the
factor is capped at 2, so one against many never swings past 2 × K (then
not quite zero-sum). **K** is 48 for a player's first
10 rated games of a game (`provisional`), then 32; everyone starts at 1200.
Duels, free-for-all and teams share it; co-op has none.

- **Boards** for duel, free-for-all and teams order by rating; rows keep
  games and wins ("12 games · 5 wins") and say "provisional". The global
  board still needs `LB_MIN_GAMES` (5) games; friends' and groups' show
  everyone, provisional or not. A group board replays its matches with the
  same rating.
- **Existing rows**: free-for-all and teams ratings were never moved (all at
  1200), so nobody is reset and no match is replayed (CPU); everyone starts
  provisional. **No migration**: a free-for-all or teams board has no best
  score, so its rows count rated games in `ratings.best` (0 for every
  existing row); the API shows that as `rated` and `provisional`, and `best`
  as null (`shownRating`). On a duel board `rated` is `games`.
- **The answer** to a report that counted (and a repeat after) carries
  `rating: { elo, delta, provisional, rated }`; each reporter's is kept in
  its report row (digest `counted`, 15 min) for its re-send to read. The end
  card (`lib/sdk-managed.js`) leaves a line for the account layer
  (`NeonArcade.account.endCard`), which shows "Ranked: waiting for the other
  players to confirm…", then "Rating +12 → 1534 · provisional" — in place,
  however late the answer lands, on every card drawn for that match.

## The games the server knows

*An audit, 2026-11-15: a board's kind was its latest match's, sent by the
reporter (a duel board could be flipped to wins), and any id matching the
pattern got a board, a snapshot file and a play count.*

`worker/api/games.js` lists every game the site lists and its manifest kind
(and, since 2026-11-21, its catalog title, `TITLES`: the body of an invite's
notification, "Party invites by notification"), generated from `lib/catalog.js` and `community/catalog.js` by
`scripts/build-games-table.mjs` (`just games-table`) and committed, like
`lib/catalog.js`, so the Worker bundles it. The Worker refuses any id
not in it (the tables have no prototype: `constructor` or `__proto__` is not
a game) — a result, a play count, a board, a match start; the snapshot and
the summary leave out boards of games no longer in it — and a result of
another kind than its game's — except the extra kinds the table lists
(`KINDS`, from `EXTRA_KINDS` in the generator: Bubble Rush is `ffa` and its
teams mode reports `teams`, rated as teams on its one free-for-all board)
and a scored free-for-all of a co-op game (Neon Survival's multi-ship runs). A board's kind is SOLO's pin, else the
table's; `@level` boards are SOLO's only. `just games-table --check` (in
`just test`, the platform CI check, and `just deploy-worker`) fails when a
catalog moved on — a registry pin that adds a game needs the table
regenerated before the Worker is deployed, or that game simply does not rank.

## Games without boards

*Lokesh, 2026-11-16: "Leaderboard is optional, remove it for games which
don't make sense (like tic-tac-toe since its a solved game)" — he chose Tic
Tac Toe (all seven language versions), Connect 4, Undercover and Draw &
Guess.*

A manifest may say **`"leaderboard": false`** (default true; validated by
`scripts/manifest.mjs`, carried into the catalog by `catalog-lib.mjs`, and
into the Worker's table as `NO_BOARD`, `worker/api/games.js`). For such a
game:

- **The page** (`lib/account.js` `boardless`) sends no report, asks for no
  run (alone or against bots) and posts no match start, silently — no
  "Not ranked" toast; the end card has no rating line. The device's own
  stats (`lib/stats.js`) still count it, wins and losses.
- **The Worker** refuses a result (`{ counted: false, why: "this game has no
  leaderboard", code: "no-board" }`), a run (400, `code: "no-board"`), a
  match start, and a win against bots; its boards and levels answer **404**;
  ratings and wins against bots of it are left out of profiles, `GET
  /api/me/matches` and the snapshot. Tic Tac Toe and Connect 4 are out of
  `BOTS`. Its **play count** still lands and is still in the summary: a
  count is not a board.
- **The leaderboard view** does not list it; an old `?game=connect4` link
  shows the first game with a board.
- **Existing rows** — the live D1 has `ratings` and `bot_wins` rows for
  `connect4` and `tic-tac-toe-js` — are kept (no destructive migration) and
  simply not served; the export still includes them, as the player's data.
- **Draw & Guess** is in web-games: its manifest change is on web-games
  branch `no-board-draw-guess` (commit 5521041); until the pin moves it is
  still ranked, and after, it is not — the table follows the catalog (`just
  games-table`).

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
   `{ run, seed, at }` (400 for a game not in `SOLO`; 429 past 200 runs of
   that game a day). The server keeps the run with the account, the game, the seed and
   its own clock (D1 `runs`). The game's `init` gets that `seed`. Signed
   out, offline, not a `SOLO` game, or no answer within 2.5 s: a local
   seed, and the run simply does not rank (the leaderboard says so). A game
   whose result this session carried nothing to rank by — no score of the
   player's and no `proof`, e.g. Light Cycles before its pin moves — is not
   reported and gets no more runs this session (no request, no wait); the
   server's refusal for it carries `code: "unrankable"`, which does the
   same. Any other refusal is toasted once per game and reason per session,
   then only logged.
2. At the end, `lib/account.js` reports it with `run` = the server's run (not
   the party's) and the game's `proof`, if the result has one.
3. The server checks, and refuses with `{ counted: false, why }`: a game not
   in `SOLO`; a run unknown (a party run id, a forged one), another
   account's, another game's, older than **6 h**, or already counted; past
   **50 counted solo runs per account per game per day** (`SOLO_PER_DAY`;
   per game since 2026-11-15, so quick Light Cycles rounds cannot use up the
   day's Sudoku and Neon Survival); a score that is not a finite number
   from 0 up to the game's ceiling (and its `max`); then the game's own
   limits (below). **Only then is the run claimed** — late, so a refused
   report (or a Worker that runs out of CPU mid-check) leaves the run
   usable — and in **one conditional UPDATE**: `… WHERE id = ? AND used IS
   NULL AND (SELECT COUNT(*) of the account's counted runs of this game in
   the last day) < cap`. Two reports racing with one run cannot both count,
   and reports posted in parallel cannot all pass a count read before any
   claimed (an adversarial review, 2026-11-15, had ten parallel posts all
   count against a cap of three). When nothing changed, the run is read
   again to say which: already reported, or the cap. The cost: a refused
   score can be re-sent lower; the ceilings are public anyway.

| Game | Board (pinned) | Shortest run (server clock) | Score |
|---|---|---|---|
| `neon-survival-mp` | best score — every run, alone or with others | 1 s (an unsteered ship can die 2 s in) | whole gems, 0 to 5 + 2 × seconds (at most 1.2 spawn a second) |
| `lokeshmohanty/sudoku` | races: wins (`ffa`); alone: **one time board per difficulty**, `lokeshmohanty/sudoku@<level>` | by difficulty, below | checked on the server, below |
| `lokeshmohanty/light-cycles` | races: wins (`ffa`); alone: best score, `lokeshmohanty/light-cycles@alone`, in seconds (`unit` "s") | 3 s (the 3.2 s countdown; the fastest crash alone is 4 squares after GO: 3.6 s of ticks, a 0.4 s score) | the time survived, seconds to the tenth, 0 to (seconds since the run began − 3.2 + 1), and never over 108 |

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
server's clock. The bound is the strong check: the page waits for the run
before the rules' `init` (`lib/sdk-managed.js` `start`: `await
startRun`, then `init`), and the server stamps the run before it answers,
so the whole countdown — 4 beats of 0.8 s, on 20 Hz ticks, which never run
faster than real time — lies inside the server's time but never in the
score. A score may be at most the seconds since the run was issued, less
3.2, plus 1 s of slack (SOLO `leadMs`, `base`). And the arena caps it
outright (SOLO `max`): 40 × 40 cells allow 1599 steps at most — 120 each at
100, 90, 80 and 70 ms, the remaining 1119 at 60 ms — 107.9 s, so nothing
over 108 counts however long a run was kept (the review found 21 000 s
accepted after waiting out a 6-hour run). The race time also stops while
the host's tab is hidden; the server's clock does not. Light Cycles' races keep the game's own board (wins), so solo
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
| A group's board (replays its matches, with the rating) | D1 faked as instant, 30 calls: 500 duels median 0.7 ms warm, 2.3 jitless; ~330 four-player free-for-alls (the pair budget) 0.8 / 2.9; 16-player 0.3 / 0.9; a fresh process's first call 2–5 ms (module compile). The first budget (1000 / 8000) measured 9.2 ms jitless, at the limit | the newest `GROUP_REPLAY` = 500 matches and at most `GROUP_PAIRS` = 4000 pairs of players, from the game's newest `GROUP_SCAN` = 3000 matches (worker/api/lb.js; was 2000 matches, all duels-only Elo) |
| A match report (16 players: canonical, three digests, settling 16 reports, the rating) | 2000 calls, D1 faked: avg 0.18 ms, p99 0.47 warm; avg 0.31, p99 0.79 jitless; first call ~8–14 ms (WebCrypto's first digest) | D1 per report: the sweep (1 select + a 3-statement batch), whether it counted (1), the void mark (1), the report and our start (1 batch), its reports (1); committing adds accounts (1), ratings (1), departures (1, only with `left`) and one batch of 3 + 2 × players statements |
| Export | ~0.75 ms per 1000 matches | `EXPORT_PAGE` = 2000 matches a page, `?page=`, `matchesNext`; the profile's EXPORT gathers every page |
| Room server relay (hub) | a 1 MiB message (the WebSocket limit) parsed and relayed to one member: ~3 ms; rooms hold ≤ 8 | — |
| Sign-in, sessions, vault | HMAC and AES-GCM on short strings: well under 1 ms | — |
| An invite to a friend with no page open, sent as notifications (Web Push) | per device ~0.6 ms warm, ~0.7 jitless (encryption; the JWT cached per push service); a fresh process's first push ~3.7 ms more | `PUSH_DEVICES_MAX` = 5 devices an account ("Party invites by notification") |
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
with bots, a winner and boards: Neon Fission, Neon Bid, Battleship, Liar's Dice, Light Cycles,
Sudoku. Neon Survival is co-op (nobody wins); Draw & Guess and Undercover
have no bots. Adding a game is one entry (its `minMs`).

**Who counts as "the only person".** The device decides, then the server
re-checks what it can see:
- the page reports only when it is the one person in the result's ranking
  and every other id is a bot (`bot_…`), it won (first place alone, in
  every kind: bot teammates sharing first place could have done the
  winning, and no game in `BOTS` mixes people and bots on a team), and the
  run was issued for this game against bots;
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
  not the reporter, no bot, or a reporter not alone in first place.

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

**The checks** (cheapest first): a game in `BOTS`; a kind with a winner;
the people and the win, above; the run exists, is the reporter's, for this
game, a run against bots (not a solo run — nor the reverse), under 6 h old
and unused; fewer than **20 counted wins against bots per account per game
in the last day** (`BOTS_PER_DAY`); and at least the game's `minMs` since
the run began (server clock). Then one batch — one transaction — holds the
claim and the win: the same conditional UPDATE as a solo run's (unused and
under the cap, so parallel posts stop at the cap), which also stamps the
run with a random nonce of this report's (`runs.claim`), and the
`bot_wins` upsert only `WHERE EXISTS (… runs WHERE id = ? AND claim =
<that nonce>)`. Only the report that claimed the run adds its win — not
another posted in the same millisecond (so not `used = t`), and without
relying on `changes()` across a D1 batch, which is undocumented — and a
failure can neither spend a run without its win nor add a win without
its run.

`minMs` is the measured floor below, less about 1 s: a run against bots is
not waited for, so the server stamps it up to a request's latency *after*
the match began, and its time can be that much shorter than the match. The
report's own trip adds back time, but nothing guarantees it.

| Game | `minMs` | The fastest legal win, and how it was found |
|---|---|---|
| ~~`tic-tac-toe-js`~~ (no boards since 2026-11-16) | 0.8 s (floor 1.8) | the bot (win, block, centre, first free) is deterministic: every human line searched, a win needs at least 3 bot moves × 600 ms (4 moving second); 15 of 505 lines win. Played in the browser: a 4-move fork took 3.8–4.3 s from the run |
| ~~`connect4`~~ (no boards since 2026-11-16) | 2.6 s (floor 3.6) | depth-5 minimax, deterministic: an exhaustive search proved no win within 6 human moves (first) or 5 (second), so at least 6 bot moves × 600 ms; a depth-8 human searcher's fastest of 8 wins in 20 games took 11 bot moves (6.6 s) |
| `neon-fission` | 1.2 s | the rules allow a win after one bot move (0.6 s: load a corner, burst it into the bot's cell); a search over the 54 cells found none within 3 human moves for 3 bot seeds (1.8 s, searched, not proven for every seed), so two bot moves, 1.2 s, refuses no real win; a greedy human's fastest of 153 wins in 300 games took 27 s |
| `neon-bid` | 37 s (floor 38.4) | fixed: 12 lots, each ending with a 3.2 s show, and the result only after the last (lib/rounds.js onFinish) — 38.4 s whatever anyone bids |
| `lokeshmohanty/battleship` | 8.5 s (floor 9.9) | 12 fleet cells, one shot a volley, 0.9 s resolve between volleys: 11 × 0.9 = 9.9 s; fastest of 9640 simulated wins: 14 volleys, 11.7 s |
| `lokeshmohanty/liars-dice` | 16.5 s (floor 17.75) | 5 dice; the bot loses one only in a round where it acts (a 750 ms pause), with a 3.5 s reveal between rounds: 5 × 0.75 + 4 × 3.5 = 17.75 s, met exactly in 20 000 simulated games (one bot; 42 s against two) |
| `lokeshmohanty/light-cycles` | 2.9 s (floor 3.9) | the 3.2 s countdown, then a step every 100 ms; no bot can crash before step 7 (six bots: 3.9 s; one bot: step 20, 5.2 s); fastest simulated win 5.3 s against three bots |
| `lokeshmohanty/sudoku` | 29 s (floor 30) | a race: the bot fills a cell every few seconds (≥ 180 s for an easy puzzle), so the human's own solve sets the pace — the solo floor for an easy puzzle (`MIN_SOLVE_S`) |

Floors run from the match's `init`. The scripts are not in the repo (they drove the rules in
Node with the real bots); re-measure when a game's pace changes.

**The board** (`GET /api/lb/<game>?vs=bots`, `bot_wins`): wins, all time;
a tie goes to whoever reached the count first. Everyone (minus hidden
players), friends, or a group's members; your own row and rank (`me`).
On the leaderboard page a game with this board gets a switch under the
games, **Ranked · Against bots** (`?vs=bots`): the same podium and rows,
"Wins vs bots" (the game's chip says so too while it shows), each row
saying when the count was reached, and a note that it is kept apart;
signed out, the bar says to sign in and beat the bots alone. A `?vs=bots`
link for a game without the board shows its Ranked board instead. The
empty board's SINGLE PLAYER goes to `./?game=<id>&fresh=1&mode=bots`. The profile lists the wins under the ratings, not in
them ("Wins against bots: Neon Fission 1"); a counted win's toast says
"Counted: 3 wins against bots." Not in the hourly snapshot, so no offline
copy.

**What it does not stop.** The host's browser plays the bots and is
trusted, so a player can make them lose, and a forged report that waits
out `minMs` counts. The cap (20 a game a day) and the minimum bound how
fast a board climbs; nothing proves a game was played. In a Sudoku race
the host does not time the human's solve, so `minMs` is the only bound
there. That is why these boards are apart from the ranked ones.

## Friends, groups and invites

*Branch `social-friends`, 2026-11-16: an audit's defects D5–D10 and D13–D17,
and Lokesh's decisions 1–6. Contract: `worker/api/social.js`; public
profiles: `worker/api/people.js`; migration 0005.*

**Friend requests.** A request is pushed to the other's open pages once —
asking again, or asking a friend, pushes nothing — and shows as a notice
with ACCEPT and DECLINE (`lib/account-ui.js` `requestNotice`), as a count
on the ☰ button and on your entry in it (`lib/nav.js`), and at the top of
the profile, right under "You" (at 354×696 the request and its buttons are
on the first screen). Two people asking each other at once end as one
friendship. **Decline is remembered**: the row becomes `'declined'` and its
asker cannot ask again for 7 days (`DECLINE_COOLDOWN_MS`; a 429 says how
long); withdrawing does not reset that, and the one who declined may still
ask. A request is pushed at most once a pair a day, however often it is
withdrawn and asked again (D1 `request_pushes`). **Block**
(`friends.state = 'blocked'`, a = who blocked) ends the friendship and
anything pending and drops waiting invites. It is never told: a request
from the blocked one is kept and sits in their outgoing list like any
other, but the blocker never sees it and nothing is pushed; their export,
friends list and recent players do not show the block (only the blocker's
own blocks are applied there). A request they were waiting on when blocked,
and a decline's cooldown, stay as they were, so a block looks like a request
nobody answered. Only the blocker lifts it; a request that waited through
the block then shows as incoming, to answer. **Mute** (D1 `mutes`) keeps a friend but drops their invites quietly —
the sender is answered the same. The cap (200, `FRIENDS_MAX`) counts your
friends plus your own outgoing requests, never incoming ones (a flood
cannot fill it), and holds on accept for both people.

**Friend codes** (decision 6). Each account gets a short code — eight
letters and digits without look-alikes, shown `ABCD-EFGH` — the first time
its own profile is read (`ensureFriendCode`; no backfill). The friend link
and QR carry it (`./?page=profile&u=<code>`); NEW CODE on the profile
rotates it, and the old one answers 404. Links by account id still work
(the id is public on boards anyway; block is the answer to someone who uses
it) — **until we decide otherwise; nothing removes them yet**. Every lookup
by code, `GET /api/u/<code>` or `POST /api/friends/<code>`, is charged to
the sender's address against the write budget (120 per 5 minutes), so codes
cannot be walked (31⁸ ≈ 8.5 × 10¹¹ of them).

**Public profiles and hidden players** (D5, D6). `GET /api/u/<who>` lives
in `worker/api/people.js` now (match.js's `publicProfile` is unused). A
player hidden from public boards is, to anyone but a friend, only
`{ id, name, hidden: true }` (the people in groups they joined still see
them on the group's member list and boards — joining a group is their
choice, and the privacy text says so) — enough to add them from their friend link —
and a signed-in friend sees the whole profile (so the profile page asks
with the token). In anyone's recent matches a hidden player other than the
profile's own and the one asking reads "(hidden)" with `id: null`, and
their score is left out. Signed in or by code, the answer is personal
(never cached publicly). Ratings carry their board's own `kind` and `unit`
where the server pins them (`runs.js` SOLO), so the profile shows Sudoku's
level boards as times and Light Cycles alone in seconds (D14).

**Party invites.** The party screen lists every friend, online first, then
those not on now ("not on now — they'll see it next time, for 10 min"), so
a friend who appears offline looks exactly like one who is not on, and
either can be invited. Notices — an invite, friend requests — go in one
stack at the bottom of the screen (`NeonArcade.account.notices()`).
**Any member can invite** (decision 1): whoever knows
the six-digit code (the host, anyone in by code) publishes it in the party
record as member meta `pcode`, and a member in by a classic invite reads it
there, the host's first (`lib/party.js` `sharedCode`). The friend still
taps JOIN. **Waiting invites** (decision 2): every invite is also kept in
D1 `invites`, one per sender and recipient, for 10 minutes
(`INVITE_TTL_MS`); a page shows the waiting ones as it loads ("Asha invited
you to a party", JOIN / NOT NOW, one at a time), and JOIN or NOT NOW
deletes it. Limits: one invite to the same friend per 20 s, 20 friends per
sender per 10 minutes, 10 waiting per recipient. The answer is
`{ invited: true }` whether or not a page got it — a count would show
whether a friend who appears offline has pages open (D16) — and the party
screen says "Invited" either way. **Appear offline** is applied where
presence is read, never written into `presence`, so turning it off shows
the player online at once; a heartbeat also says online.

The party screen draws friends online from one shared list
(`loadFriends`), fetched on sign-in, on a live push, or when a minute old
while something shows it — no longer on every redraw (D15).

**Players you just played** (decision 4): on the end card, the signed-in
people of the match who are not friends, blocked or hiding (their `acct`
meta's `hide`), each with ADD FRIEND (`lib/account-ui.js` `justPlayed`, one
hook in `lib/sdk-managed.js`); and on the profile, from `match_players`:
the last 50 matches, a dozen people, `GET /api/friends/recent`.

**Groups** (D7, D8, D10, decision 3). Removing someone bans them
(`group_bans`) and rotates the code; the owner can let them back. The owner
can rotate the code, rename, and hand the group to a member; the owner may
leave, and the group then passes to its longest-standing member — as it
does when an owner deletes their account — and the last member out deletes
it. The group cap (20) holds on join as on create. The group page,
`./?page=profile&group=<id>`, lists members (longest-standing first: who
owns it next), the games its members are ranked in with links to the
group's boards, and the owner's controls.

**Profile QR** (D17): SVG, one path of whole modules with
`shape-rendering: crispEdges`, sharp at any pixel density.

## Party invites by notification (Web Push)

*Branch `web-push`, 2026-11-18. Lokesh's decisions of 2026-11-15 and
2026-11-18. Contract: `worker/api/push.js`; crypto: `worker/api/webpush.js`;
page: `lib/push.js`; the notification: `sw.js`; migration 0006.*

**Scope: opt-in, per device, party invites only.** No friend requests, no
reminders, no marketing; widening it needs asking Lokesh again. The only
outside contact it adds is the browser vendors' push services (Google FCM
for Chrome, Edge on Android, Samsung Internet, Opera and Brave; Mozilla
autopush for Firefox; Apple for Safari, on iOS only from the Home Screen;
Microsoft WNS for Edge on Windows). They see that a message of a fixed size
went to a device, and when — not who sent it or what it says.

**The offer.** The first time a signed-in player has a friend, a small card
joins the notices at the bottom of the screen, once per device: "Get party
invites when the arcade is closed?" TURN ON / NOT NOW. Either answer is
final on that device (localStorage `neon.push.offer`); the card is not shown
where the browser has no Push API, where notifications are blocked, or while
the server has no VAPID key. The browser's permission is asked only on the
TURN ON tap. The profile's **Notifications** section has the same setting as
a per-device switch, always ("Party invites on this device when the arcade
is closed"); it says why when it cannot be turned on (no Push API — on
iPhone, add the arcade to the Home Screen first; blocked in the browser;
not set up on the server).

**Who gets one.** An invite (`POST /api/friends/<id>/invite`) goes, after
every existing check — friends only (a block ends the friendship, so a
blocked sender is refused with the same 403 as before), a mute drops it
quietly, the 20 s / 20 friends / 10 waiting limits — to the friend's open
pages through `UserLive`, as before. It is **also** sent to their devices
when **no page of theirs is in view** (`live.js` `attentive`): every page
says whether it is visible as that changes (`{t:"vis", visible}`, and on
status and ping; a phone that switches apps hides the page before freezing
it), and a socket not heard from for 5 minutes (`ATTENTIVE_MS`; a visible
page pings every 4) counts as a frozen page. An open socket alone is not
"open": Android and iOS keep a switched-away app's socket for minutes (the
review of 2026-11-21 found the first version never pushed in that, the main,
case). Chosen over a per-socket staleness timer alone because hiding is
reported at once, while a timer would leave the first minutes after
switching away silent. A page from before `visible` counts as visible while
fresh. A hidden page that comes back shows the invite too; tapping the
notification focuses it, and the card is not shown twice.

**Only news makes a notification** (review, 2026-11-21: a friend re-inviting
every 20 s made a closed phone buzz every 20 s). A notification goes when the
sender has no unexpired invite waiting for this friend, or the party code is
new — and then at most once per pair every 2 minutes
(`INVITE_NOTIFY_AGAIN_MS`, D1 `invites.pushed`). A repeat still refreshes the
waiting invite and reaches open pages. Both deliveries run after the sender
is answered (`ctx.waitUntil`): the answer is `{ invited: true }`, the same
bytes and headers, whether a page got it, a notification, or nothing (D16).
The invite still waits in D1 for 10 minutes as before.

**What it says.** "Asha invited you to a party", with the game's title as
the body ("Connect 4") — the game in play, else the one the party picked
(`partyBlock`'s `picked`, lib/party.js) — or "Tap to see the invite." with
none. The page sends the game's **id**; the Worker checks it against its
table of games and writes the catalog's title (`worker/api/games.js`
`TITLES`, generated with the rest of the table), so the body is never text
a sender wrote (review, 2026-11-21: it was free text, a phishing line). An
id the arcade does not list shows no game line. One notification per friend (`tag invite:<sender>`; a newer one
replaces it). A push whose payload cannot be read still shows "A friend
invited you to a party" (Chrome requires a notification for every push to a
`userVisibleOnly` subscription). **Tapping it** focuses an open arcade page,
which fetches the waiting invites and shows that one (JOIN / NOT NOW, the
existing card), or opens the arcade at `./?invite=<sender>`, which does the
same as it loads and then drops `invite=` from the address. If the invite
has gone (10 minutes, or answered elsewhere), the page says "That invite
has expired."

**Delivery.** Each message is encrypted for the one browser (RFC 8291,
`aes128gcm`: a fresh ECDH key pair per message, HKDF, AES-128-GCM, one
record padded to 512 bytes so a name's length does not show) and signed
with the arcade's VAPID key (RFC 8292, ES256; the JWT is cached per push
service origin for 12 h less an hour, per isolate). Headers: `TTL` = the
invite's 10 minutes, `Urgency: high`, `Topic: inv<sender>` (an undelivered
invite from the same friend is replaced). WebCrypto only — no library, no
CDN, no push SaaS. A **404 or 410** from the push service deletes the
device's row; other refusals are logged.

**SSRF.** The Worker fetches a URL a browser handed the page. Only
`https://` with no port or credentials on `fcm.googleapis.com`,
`updates.push.services.mozilla.com`, `*.push.apple.com` or
`*.notify.windows.com` is accepted (`PUSH_HOSTS`). The two wildcards are
the vendors' own: Apple's web push guide says to allow
`https://*.push.apple.com`, and Microsoft's WNS firewall page lists
`*.notify.windows.com` (checked 2026-11-21). Narrowing them to
`web.push.apple.com` or `wns2-*` is not done: neither vendor documents
those as the only hosts, and every name under those two domains is the
vendor's own, so the wildcard adds no SSRF reach. It is checked
when subscribing (400 otherwise) and again before each send (a row whose
endpoint no longer passes is deleted). Redirects are not followed. Under
`AUTH_TEST=1` on a loopback host, `http://127.0.0.1` / `localhost` is also
accepted, for the tests' fake push service.

**Devices.** One D1 row per endpoint (`push_subs`), keyed to the account
signed in there: the same browser signed in as someone else moves the row
to them (a page re-tells the server when the account signed in differs from
the one it last told, localStorage `neon.push.sent`). Endpoints are stored,
sent to and deleted in one spelling (`new URL(endpoint).href`): upper case,
`:443` or `https:host` were each a row of their own, and one device got one
push per spelling (review, 2026-11-21). Each row records a fingerprint of
the VAPID key it was made with; only rows of the current key are sent to,
and the rest are deleted. At most **5 devices** an account (`PUSH_DEVICES_MAX`, bounded by
CPU, below): a sixth evicts the one refreshed longest ago, and a page with
the setting on refreshes its row once a day (or when the browser rotated the
subscription), so a device in use keeps its place. **TURN OFF** deletes the
row, then unsubscribes the browser (offline, the row stays until the push
service answers 410). **Signing out** does the same first, and so does a
session that **ended elsewhere** (expired, or signed out on another device:
the page's next 401), so a shared phone stops getting that account's
invites. `DELETE /api/push` needs **no sign-in** for that reason: the
endpoint is the device's own secret, so holding it is the proof, and the
most a stolen endpoint does there is turn one device's notifications off.
Deleting the account deletes every row. The **export** lists each device as its push service's host and
two dates (`pushDevices`), **not** the endpoint or the keys: an endpoint
with its keys lets anyone send to that device, and an export is a file
people keep and pass around.

**CPU** (`node scripts/push-cpu.mjs`, `--jitless` for a cold isolate;
measured 2026-11-18 on Node 24): encrypting one payload avg 0.53 ms, p99
1.4 (warm) / 0.68, p99 1.6 (jitless); signing a new JWT 0.10–0.13 ms; a
cached JWT 0.005 ms; process CPU per push (encrypt + cached JWT, all
threads) 0.58 ms warm, 0.73 jitless; the first push on a fresh process
~2.6 ms (encrypt) + ~1.1 ms (key import + JWT). So an invite to a friend
with 5 devices on a cold isolate is ~4 + 5 × 0.7 ≈ 7.5 ms worst case, inside
the free plan's 10 ms; the usual case (one or two devices, warm) is ~1 ms.
Not measured on Cloudflare itself (`wrangler tail` shows real CPU after a
deploy) — **VERIFY** there once.

**What it does not do.** The tap cannot join a party by itself: it shows
the invite, and JOIN is still the player's. iOS needs the arcade on the
Home Screen (Safari's rule). A browser on a push service not in the list
gets "cannot" on its switch. **There is no `pushsubscriptionchange`
handler**: when a browser or push service rotates a subscription, the
worker cannot tell the server (it has no session), so invites sent between
the rotation and the player's next visit are lost; that visit's page
subscribes again and tells the server (lib/push.js `refresh`). **Changing
the VAPID key pair** turns every device off until its page's next visit:
the Worker stops sending to rows of the old key and deletes them, and the
page deletes its old row, unsubscribes and subscribes with the new key.
Nothing to clean up by hand.

## The API

Everything under the room server, `https://neon-arcade-room.lokeshmohanty.workers.dev`
(or `?rs=` on loopback for development). Writes are limited to 120 per
address per 5-minute window (IpGate `api`).

| Route | Who | |
|---|---|---|
| `GET /auth/{github,google}/start?back=` → `…/callback` | anyone | sign in; back to `back#token=` |
| `GET /auth/test?name=&uid=&back=` | tests only (`AUTH_TEST=1`, loopback host) | |
| `GET/PATCH/DELETE /api/me`, `GET /api/me/export[?page=]`, `POST /api/me/signout` | signed in | profile, settings, delete, export (matches 2000 a page; `matchesNext`; also runs, pending reports and starts, feedback posts, presence) |
| `GET/PUT /api/me/favs`, `GET /api/me/matches` | signed in | favs: game ids, `contributor:<login>`, `collection:<owner>/<repo>` (2026-11-15; same table, no migration) |
| `POST /api/stats/played`, `GET /api/stats/summary` | anyone | counts |
| `POST /api/match/report` | signed in | ranked results, with `seats` and `left`; played alone (`seats` 1): `run` is the server's, plus the game's `proof`. Answers `{ counted, rating? }`, `{ pending, settleAt }` or `{ counted: false, why }` |
| `POST /api/match/start`, `DELETE /api/match/start` | signed in | `{ game, run, match }`: this account is seated in that ranked match with a winner (duel, ffa, teams) — the evidence a departure needs; DELETE withdraws it (the match ended without a result) |
| `POST /api/run/start` | signed in | `{ game }` → `{ run, seed, at }`: a solo run (6 h, one counted report); `SOLO` games only. `{ game, vs: "bots" }`: a run for a match against bots; `BOTS` games only |
| `POST /api/admin/age-run` | tests only (`AUTH_TEST=1`, loopback host) | `{ run, ms }`: move a run's start into the past |
| header `X-Test-Now: <ms>` on `POST /api/match/report` | tests only (`AUTH_TEST=1`, loopback host; ignored otherwise) | the server's "now" for that report (http.js `requestNow`): a check at a boundary of a run's age is exact, not as late as the request (test-accounts pins its reports to the run's `at`, so a run aged `ms` is exactly `ms` old) |
| `GET /api/lb/<game>?scope=global\|friends\|group:<id>` | global: anyone (`&me=1`: signed in) | signed in, also `me`: your row and rank even past the top 100, or `rank: null` with `need` (more games) or `hidden`; null with no ranked game. Global without `me=1` is the one cached publicly. Also `levels`, `unit` and `botsBoard` (the game has a board against bots) when they apply |
| `GET /api/lb/<game>?vs=bots&scope=…` | as above | the board of wins against bots: `kind: "bots"`, rows `{ rank, id, name, avatar, wins, first, at }`, `perDay`; `me` as above. No offline copy (not in the snapshot) |
| `GET /api/u/<id or friend code>` | anyone | public profile; hidden: a name to befriend, or all of it for a signed-in friend; by code: charged against guessing |
| `GET /api/friends`, `GET /api/friends/recent`, `POST/DELETE /api/friends/<id or code>`, `POST/DELETE /api/friends/<id>/block`, `…/mute`, `POST /api/friends/<id>/invite` | signed in | invite `{ code, game? }` → `{ invited: true }`, always the same; `game` is a game's id, named in a notification by its catalog title (an unknown id: no game line) |
| `GET /api/invites`, `DELETE /api/invites/<sender>` | signed in | invites waiting (10 minutes) |
| `GET /api/push` | anyone | `{ key }`: the VAPID public key to subscribe with, or null while the server has none |
| `POST /api/push` `{ endpoint, keys: { p256dh, auth } }` | signed in | this device gets this account's party invites as notifications (`{ on: true }`; push-service hosts only, 400 otherwise; at most 5 devices, the least recently refreshed goes; the endpoint stored as its canonical URL) |
| `DELETE /api/push` `{ endpoint }` | anyone holding the endpoint (no sign-in: an expired session still forgets its device) | `{ on: false }` |
| `POST /api/me/friend-code` | signed in | a new friend code; the old one dies |
| `GET/POST /api/groups`, `POST /api/groups/join`, `GET/PATCH/DELETE /api/groups/<id>`, `POST /api/groups/<id>/code`, `POST /api/groups/<id>/owner`, `DELETE /api/groups/<id>/members/<acct>`, `DELETE /api/groups/<id>/bans/<acct>` | signed in | |
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
| Friend code | D1 `accounts.friend_code` | to whoever you give it; rotatable |
| Blocks, declines (7 days), mutes, group bans, waiting invites (10 minutes), when a request was last pushed | D1 `friends`, `mutes`, `group_bans`, `invites`, `request_pushes` | no; in the export (your own rows; never a block of someone else's on you; group bans of you and by you; when your requests were pushed); deleted with the account |
| Devices getting party invites as notifications: the push service's endpoint, the browser's public key and auth secret, which VAPID key (a fingerprint), created, last refreshed; when a waiting invite last made a notification | D1 `push_subs` (0006), at most 5 an account; `invites.pushed` | no; in the export as push service host and the two dates only (no endpoint, no keys); deleted on TURN OFF, sign-out, a 404/410 from the push service, and with the account |
| Ranked matches and ratings | D1 | on boards and public profiles, unless hidden |
| Reports not yet settled, "I am seated" starts, outcomes waiting to be read | D1 `reports` (15 min; starts 1 h after their last beat) | no; in the export (`reports`); deleted with the account |
| Solo runs and runs against bots: id, game, seed, start, used, counted, daily, `vs` | D1 `runs`, kept 4 days | no; deleted with the account |
| Wins against bots: game, count, first win, when the count was reached | D1 `bot_wins` | on the boards against bots, unless hidden; in the export (`winsAgainstBots`); deleted with the account |
| Play counts per game | D1 `plays` | yes (summary, snapshot) |
| Feedback text | GitHub Discussions | yes, with the display name |
| Hourly snapshot: counts + top 100 per game | GitHub branch `stats` | yes; hidden players left out |

Never stored: email; Google's token (used once to read the profile). The
GitHub App user token is the one provider token kept — encrypted, narrow,
and only so your feedback is your own.
**Delete** removes every row of the account at once (a group it owns
passes to its longest-standing member); matches stay in the
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
6. **Deploy**: `just deploy-worker` — never a bare `wrangler deploy`, which skips the games-table check (the `UserLive` class migration `v3` and the
   hourly cron come with it).
7. Check: sign in on the site with each provider; play a ranked game with a
   second account; wait for :07 past the hour and look at the `stats` branch.

## Deploying the Worker

**Always `just deploy-worker`, never a bare `wrangler deploy`.** It fetches
the registry's games (`just community`) and checks the Worker's table of
games against them (`just check-games`) before deploying: a Worker whose
table lacks a game refuses that game's play counts and results (a review,
2026-11-16: Bubble Rush was missing from this branch's table). After a pin
PR that adds a game or changes one, the submission check warns; regenerate
with `just games-table` and commit before deploying.

## Deploying invites by notification (branch `web-push`, 2026-11-18)

Once, by Lokesh, after the merge. Until steps 2–3 are done the new Worker
answers `GET /api/push` with `{ key: null }`, so no page offers anything and
invites behave exactly as before; nothing breaks while it waits. From the
repo root:

1. **The key pair**, with Node's own WebCrypto (nothing to install):
   `node scripts/vapid-keys.mjs > .env.vapid-public 2> .env.vapid-private`.
   Both files match `.env.*`, which `.gitignore` covers
   (`git check-ignore -v .env.vapid-private` says so). Never commit them;
   run `git status` before staging anything, never `git add -A`.
2. **The secrets** (no newline is written, and the Worker trims anyway):
   `cd worker && wrangler secret put VAPID_PUBLIC_KEY < ../.env.vapid-public`
   and `wrangler secret put VAPID_PRIVATE_KEY < ../.env.vapid-private`.
   The public key is not secret — it is served at `GET /api/push` — but as a
   secret it needs no edit to `wrangler.toml`. Optionally
   `wrangler secret put VAPID_SUBJECT` with a `mailto:` or `https:` contact
   for the push services (default `https://github.com/lokeshmohanty/games`).
   Then keep `.env.vapid-private` somewhere safe off the repo, or delete it:
   a lost key only means making a new pair (every device turns off until its
   page subscribes again; see "What it does not do").
3. **The migration**, then the Worker (it reads `push_subs` on every invite
   to an offline friend and on account deletion, so migrate first), from
   `worker/`: `wrangler d1 migrations list arcade --remote` (0006 pending),
   `wrangler d1 migrations apply arcade --remote`, then from the root
   `just deploy-worker` (never a bare `wrangler deploy`).
4. **The site** (Pages, from CI as usual). Site and Worker may go in either
   order: a page from before never asks `/api/push`, and an older Worker
   answers it 404, which the page treats as "not available".
5. **Check**, on a phone with Chrome or Firefox: sign in, have a friend; the
   card asks once; TURN ON; close the arcade; the friend invites from a
   party — "<name> invited you to a party" with the game's title arrives;
   tapping it opens the invite with JOIN. `wrangler tail` meanwhile shows the
   invite request's CPU (expected ≲ 2 ms with one device). The profile's
   switch turns it off.

## Deploying the ratings and integrity changes (branch `social-ratings`, 2026-11-16)

**No migration**: the new rows live in existing tables (`reports` rows with
digest `start` / `counted`; a free-for-all or teams board's rated games in
`ratings.best`). From the repo root, after the merge:

1. `just community` (the registry's games, for the table), then
   `just check-games` — `worker/api/games.js` must match; if not,
   `just games-table` and commit it.
2. `just deploy-worker` (runs both of the above, then `wrangler deploy` in
   `worker/`).
3. Check: two signed-in players finish a Neon Fission — both end cards say
   "Rating +24 → 1224 · provisional"; the leaderboard's Neon Bid board shows
   "Rating"; `GET /api/lb/nobody/x` answers 400; `GET /api/lb/connect4`
   answers 404 and a finished Connect 4 sends no report.

Order with the site: the site and the Worker can go in either order. A page
from before (cached by the service worker) sends no `seats`, so its solo
runs are refused as "a ranked match needs two signed-in players" until it
updates, and it never sends `left` or a start (no departures from it).

## Migrations

`worker/migrations/0002_identities.sql` adds `identities` (copying each
account's first sign-in) and the token columns: `wrangler d1 migrations
apply arcade --remote` before deploying a Worker that reads them.

`worker/migrations/0003_runs.sql` adds `runs` (solo runs). **Applied and
deployed 2026-11-15.** Order matters — the new Worker reads and deletes
from `runs` (a report, `POST /api/run/start`, and account deletion), so
from `worker/`:

1. `wrangler d1 migrations apply arcade --remote` (applies 0003 only; check
   with `wrangler d1 migrations list arcade --remote`).
2. `just deploy-worker` (never a bare `wrangler deploy`).
3. Check: signed in, play Neon Survival alone for a minute — "Counted on the
   leaderboard."; a Sudoku solved alone appears on its board as a time.

Until then the deployed Worker (2dd27a0a, 2026-11-14 per STATUS.md: from
before solo runs ranked at all) answers `POST /api/run/start` with 404 — the page plays on a local seed
and sends no solo report — and would refuse one anyway ("a ranked match
needs two signed-in players").

`worker/migrations/0004_bot_wins.sql` (branch `solo-boards`, 2026-11-15)
adds `runs.vs` ('solo' for every existing row, or 'bots'), `runs.claim`
(the nonce of the report that used a run up), the index `runs_vs`, and
`bot_wins`. **Applied and deployed** after the `solo-boards` merge. It needs 0003
first (it alters `runs`), and the Worker that reads `runs.vs` must not be
deployed before it — every run start and solo report would fail. So, from
`worker/`, once the branch is merged:

1. `wrangler d1 migrations list arcade --remote` — shows what is pending
   (0003 too, if it still is).
2. `wrangler d1 migrations apply arcade --remote` — applies them in order.
3. `just deploy-worker` (never a bare `wrangler deploy`).
4. Check, signed in: win a Tic Tac Toe against the bot — "Counted: 1 win
   against bots."; the leaderboard's Tic Tac Toe → Against bots lists you;
   its Ranked board does not. Once the web-games pin moves past 4cc6e1a:
   ride Light Cycles alone — Light Cycles → Ranked → Alone lists the time.

A Worker from before 0004 never issues a run against bots (it answers 400
or 404), so the page sends no win; nothing breaks while it waits.

`worker/migrations/0005_social.sql` (branch `social-friends`, 2026-11-16)
adds `accounts.friend_code` (with a UNIQUE index; filled lazily, so no
backfill), `group_bans`, `invites`, `mutes` (indexed both ways) and
`request_pushes`. Additive: it touches no
existing row, and the deployed Worker never reads the new columns or
tables. The new Worker reads all of them (every `/api/me`, friends list,
invite, group join and account deletion), so **migrate first, then
deploy**, from `worker/`, once the branch is merged:

1. `wrangler d1 migrations list arcade --remote` — 0005 pending (0003 and
   0004 are applied).
2. `wrangler d1 migrations apply arcade --remote`.
3. `wrangler deploy`.
4. Check, signed in: the profile shows a friend code `ABCD-EFGH`;
   `/api/u/<that code>` answers; an invite to a friend with no page open
   appears when they next open the arcade.

`worker/migrations/0006_push.sql` (branch `web-push`, 2026-11-18) adds
`push_subs` (one row per device that turned invites by notification on) and
its index, and `invites.pushed` (when a waiting invite last made a
notification). Additive; **migrate first, then deploy** — "Deploying invites by
notification" above.

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
- `just test-accounts` also covers (2026-11-16): the rating with no server
  (beating a stronger player counts more, provisional K, teams, guests'
  places, leavers' places); the audit's collusion repro (two colluders
  naming a third: counted for them only, after the grace) and the spoofed
  `acct`; kind flipping and unknown ids (result, play count, board, level,
  match start); guests in a free-for-all; leaving is a loss (duel on the
  winner's word, not without the leaver's start, not while they are online
  in the game, not when they report it, not with a start their own report
  used up, not for a made-up match number, not after a withdrawal, not
  after a refused report of theirs, not while their seated page still beats
  even with a second page on the home screen (the review's repro), an emptied side's empty slot, free-for-all
  confirmed by two, not by one; with no server: a 1v1 emptied side, 2v2 with
  one leaver ahead, drawn and behind); a missing account in
  the roster; two last reports at once; six commits for one player at once;
  boards of 120 friends and 121 members; the group board's query plan
  (`EXPLAIN QUERY PLAN` through `wrangler d1 execute`); a single id at the
  end with `seats` 2 is not solo; the export's runs, reports, feedback posts
  and presence; games without boards (a Connect 4 result refused, its
  boards 404, no run or match start, old rows not served, the play count
  still lands). `MATCH_GRACE_MS` is 3 s there. `just test-submission`
  checks the `leaderboard` field and that the catalog carries it.
- `just test-accounts` also covers friends, invites and groups (0005):
  friend codes (by code, any case, rotated, the old one dead, id links
  still working, guessing cut off), one push per request, crossing
  requests, decline remembered, block and unblock, the cap on incoming and
  on accept (`FRIENDS_MAX` 3 there), waiting invites (kept, cleared,
  expired — `INVITE_TTL_MS` 4 s there — rate-limited, muted), no
  `delivered` count, appear offline off at once, a hidden player
  (befriended by code, seen by a friend, "(hidden)" elsewhere), recent
  players, group bans and code rotation, rename, transfer, the owner
  leaving or deleting the account, the group cap on join (`GROUPS_MAX` 2
  there), and ratings' kind and unit.
- `just test-social` — the whole flow in two browsers at 390×844, and a
  Neon Survival run played alone: issued, reported under its run, counted;
  a Light Cycles round alone (skipped while the served Light Cycles has no
  score: build from the branch, below); against bots (since 2026-11-16):
  Tic Tac Toe asks for no run and sends nothing; Neon Fission asks for its
  run as the match begins, a win handed over by removing the bot is not
  reported, and a win through the account layer counts on the board
  against bots and not the ranked one; the board in Paper light, Paper dark
  and Neon (`NEON_SHOTS=dir` saves screenshots). Since 2026-11-16 also: a
  Connect 4 between Ana and Bo is played but not reported (no end-card
  line, the device's stats still count it); Neon Fission with Bo leaving —
  his page said it was seated, Ana's report names him, waits out the grace
  and counts, her end card says "Rating +24 → 1224 · provisional" in place
  and inside the screen, and Bo has a loss; the leaderboard strip without
  games that have no boards, an old `?game=connect4` falling back; and an
  abandoned solo run never filing a later two-seat match as solo.
  Friends: a pushed request accepted from its notice,
  "Invited" either way, NOT NOW forgetting an invite on the server, a member
  in by a classic invite inviting, no friends refetch on party redraws, the
  end card's "Players you just played", the ☰ badge, the profile at
  390×844 and 354×696 in all three themes, the SVG QR, an invite waiting
  for the next visit, and the group page removing someone.
- To play Light Cycles from the `light-cycles-solo` branch:
  `NEON_LOCAL_REPOS=lokeshmohanty/web-games=../web-games-lc
  NEON_PIN_OVERRIDE=lokeshmohanty/web-games=<sha> node
  scripts/fetch-community.mjs`, then `NEON_DIST=… just build` (the clone
  rule: scripts/fetch-community.mjs `checkout()` uses `../<repo>` only if it
  has the commit, so a clone under another name is named explicitly).
- `test-bots` checks a result reaches the device's stats and the portal.
- `just test-push` (2026-11-18; in `test-wrangler`) — invites by
  notification. With no server: the fake push service decrypts RFC 8291's
  own example message (so it checks the Worker rather than repeating it),
  and the endpoint allowlist (push services accepted; http, look-alike
  hosts, ports, credentials, metadata and private addresses refused;
  loopback only in tests). Under `wrangler dev`, sending to a fake push
  service (`scripts/push-fake.mjs`) that verifies every VAPID JWT and
  decrypts every payload with the subscription's private key: subscribe
  (signed in only), refused hosts and bad keys, a real host accepted,
  unsubscribe, the device cap (`PUSH_DEVICES_MAX` 3 there) evicting the
  least recently refreshed, an endpoint moving accounts, four spellings of
  one endpoint as one row, DELETE without a sign-in by any spelling; an
  invite to a friend with a page in view is not pushed, without one it is
  (payload, the game's catalog title from its id, TTL, Urgency, Topic,
  512-byte padding), the sender's answer byte-identical across page /
  notification / neither / muted / repeats, the JWT reused per origin, a
  missing game, the pair limit (`INVITE_AGAIN_MS` 1 s there), a repeat with
  the same code or a new code too soon makes no notification and a new code
  after the gap does (`INVITE_NOTIFY_AGAIN_MS` 8 s there), free text or an
  unknown id shows no game, a hidden page and a quiet page (`ATTENTIVE_MS`
  2.5 s there) get a notification as well, muted and blocked send nothing,
  a row of an older VAPID key is not sent to and is deleted, a 410 and a
  404 delete their rows; the export (hosts and dates, no endpoints or keys)
  and account deletion. Each check added after the review of 2026-11-21
  failed against the Worker before it.
  In Chromium at 390×844 and 354×696 (`phoneFloors`, in view, no sideways
  scroll): no offer before a friend; the offer after one; NOT NOW never
  again; the profile switch on (subscribed with `userVisibleOnly` and the
  server's key), off (row gone, unsubscribed), on; TURN ON from the card;
  INVITE on the party screen with Connect 4 picked reaches the device;
  `ServiceWorker.deliverPushMessage` → the notification's title, body and
  tag; an unreadable payload still notifies; the tap with no page open
  opens `./?invite=<sender>` (openWindow recorded: CDP cannot click a
  notification, so the tap is a `NotificationEvent` with the real
  notification), which shows the invite with JOIN for the party's code; the
  tap with a page open shows it there; an expired one says so; the key not
  reachable leaves an on switch on; a hidden page (app switched away) gets
  the invite and the device a notification; signing out, and a session
  ended elsewhere (401), remove the device. Chromium cannot subscribe to FCM here, so the page's
  `PushManager` is stubbed with a subscription on the fake service.
