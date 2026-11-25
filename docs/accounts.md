# Accounts, results and the social layer

*Built 2026-11-13 (branches `platform-2`), Phases 1–6 of the platform plan.*

Signing in is optional and changes nothing about playing: every game works
with no account, offline, from any page. An account adds favourites on every
device, a head-to-head record against each person you play, friends online
and party invites, groups, and feedback on games. There are no leaderboards
and no ratings (Lokesh, 2026-11-25: casual, not competitive — "No boards"
below).

## What runs where

| Piece | Where | File |
|---|---|---|
| This device's results, favourites, recently played | localStorage | `lib/stats.js` |
| Portal cards, stars, counts, account bar | the page | `lib/portal.js` |
| Token, API calls, favourites sync, match reports, live socket | the page | `lib/account.js` |
| Sign-in chooser, ADD FRIEND, INVITE, a pushed request's ACCEPT/DECLINE, "Players you just played", the shared friends list, feedback sheet | the page | `lib/account-ui.js` |
| Profile view (head-to-head included) | the page | `./?page=profile` (`src/views/Profile.tsx` + `lib/profile.js`); the old `./?page=leaderboard` and `leaderboard.html` land there (`src/router.ts` legacyAddress); docs/spa.md |
| The API | the room server (Cloudflare Worker) | `worker/api/*.js` |
| Accounts, matches, friends, groups (and the old `ratings`, no longer written) | D1 database `arcade` | `worker/migrations/0001_accounts.sql` |
| Head-to-head: each account's record against each other, from confirmed matches | the room server, read from D1 `match_players` | `worker/api/match.js` (`headToHead`, `rivalsOf`) |
| The games the server knows, and their kinds | generated from the catalogs, bundled with the Worker | `worker/api/games.js` (`scripts/build-games-table.mjs`) |
| Friends, invites, groups (contract), public profiles | the room server + D1 (friend codes, bans, waiting invites, mutes) | `worker/api/social.js`, `worker/api/people.js`, `worker/migrations/0005_social.sql` |
| Presence and pushed invites | Durable Object `UserLive`, one per account | `worker/api/live.js` |
| Invites as notifications (Web Push): devices, encryption, VAPID; the offer card and the profile switch; the notification and its tap | the room server + D1 `push_subs`; the page; the service worker | `worker/api/push.js`, `worker/api/webpush.js`, `worker/migrations/0006_push.sql`; `lib/push.js`; `sw.js` |
| Feedback | GitHub Discussions, posted by the arcade's GitHub App | `worker/api/feedback.js` |
| Public hourly snapshot (play counts only) | GitHub branch `stats` | `worker/api/snapshot.js` |

Game frames never see any of it: they are sandboxed (docs/platform.md), and the
token lives in the party page's localStorage only.

## Decisions (Lokesh, 2026-11-13)

- **Bearer token in localStorage**, not a cookie: the Worker is on
  `*.workers.dev`, another site, so a cookie would be third-party.
- **No boards, no ratings** (Lokesh, 2026-11-25; memory
  `casual-not-competitive`: UX > performance >>> anti-cheat): party
  standings (lib/party.js) and head-to-head only — "No boards" below. The
  bullets on ratings, solo runs and wins against bots further down are
  history: superseded by this one.
- **Matches are human-only and confirmed**: a match counts when two
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
  aggregates** (play counts; until 2026-11-25 also the top 100 per game).
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
   runs its own matches); in a match with a winner among signed-in people it also
   sends `POST /api/match/start` ("I am seated"). At the result the **host**
   sends `POST /api/stats/played` (anonymous, one count per match), and a
   **signed-in** player in a match with people sends `POST /api/match/report`
   with `roster` — party member id → account id, read from each member's
   `acct` meta (which `attach` publishes), or from the start for a member who
   has gone — `seats` (how many the match began with) and `left` (who of them
   left the party for good).
4. The server (`worker/api/match.js`) keys the match by
   `sha256(game|run|match)` and **commits** it when the rules below say so:
   `matches` and `match_players`, in one batch. A pending reporter re-sends
   after 3, 8, 20 and 40 s (71 s in all, past the 45 s grace) so it hears
   that it counted: the answer's `vs` (its head-to-head in this game against
   each other account in the match) goes to the end card ("You 5–3 Asha")
   and the toast.
5. Played alone, against bots, or on one phone, nothing is sent: the device
   keeps its own stats and records (lib/stats.js, lib/records.js).

## Who a match counts for

*An audit, 2026-11-15, found two colluding accounts could record a match —
a loss — for a third that never played it (account ids are public), and that
a party member's `acct` meta, being self-published, could name anyone. Fixed
2026-11-16, branch `social-ratings`. Contract: `worker/api/match.js`.*

A report names accounts; only the accounts that **reported the agreeing
result themselves** are recorded — `match_players`, and so the head-to-head.

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
free-for-all second behind a guest is second — not a win — though it is
still a win in the head-to-head against the signed-in player in third. On a team the side
keeps its place, so the guest's side still wins or loses.

**One atomic commit.** The match, its players and the reporters' outcomes
are one D1 batch, whose first statement is a plain
`INSERT` of the match: a second commit of the same match (two last reports
at once) fails on its primary key and rolls back whole; an account that no
longer exists is left out before the batch (it used to write `matches`, fail
on the foreign key, and answer "counted, already" ever after). Nothing is
read and overwritten (no ratings since 2026-11-25), so two matches
committing at once for one account both count.

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
third side appears. (A report without `teams`, from an older page, is
booked as free-for-all. In a drawn team game the history shows the leaver
in the draw, and their head-to-head counts it as neither: the same place in
a team game.) The server records
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
Fission, Light Cycles, Sudoku, Connect 4, Tic Tac Toe and the other managed
community games. In a game
that runs its own matches (Neon Bid, Battleship, Liar's Dice) a departure is
never recorded; the leaver gets nothing, and the others' match counts with
them only.

## No boards (2026-11-25)

*Lokesh, 2026-11-25 (memory `casual-not-competitive`): "party standings +
head-to-head only, no global boards".* Removed in branch `standings`:

- **Boards**: global, friends', groups' and the boards of wins against bots
  (`worker/api/lb.js`, `lib/leaderboard.js`, `src/views/Leaderboard.tsx`,
  the Leaderboards tab). `GET /api/lb/…` answers **410** with a reason, so
  an older cached page gets a plain answer. `./?page=leaderboard` (with any
  `game=`, `scope=`, `vs=`) is replaced by `./?page=profile` as it is
  entered or popped (`src/router.ts` legacyAddress), and `leaderboard.html`
  is a static stub (copied by scripts/assemble.mjs, precached) that sends a
  bookmark to the same place.
- **Ratings**: pairwise Elo, provisional K, the end card's "Rating +12 →
  1534" (`ratingDeltas`, `sideDeltas`, `shownRating`). Nothing writes
  `ratings` any more; `GET /api/me/matches` and public profiles no longer
  carry `ratings` or `botWins`.
- **Solo runs and wins against bots**: server-issued runs and seeds
  (`worker/api/runs.js`), Sudoku's server-side grid check
  (`worker/api/sudoku.js`), the per-game minimum times and daily caps
  (`worker/api/bots.js`) — checks that existed only to protect boards.
  `POST /api/run/start` answers **410**; games always play on a local seed
  (lib/sdk-managed.js). A report with a bot in it, or one signed-in player,
  is answered `{ counted: false, why }` and nothing is kept.
- **The snapshot's boards**: the hourly snapshot writes only
  `stats/summary.json`; its first run after this deletes `stats/lb/*` and
  `stats/index.json` from the `stats` branch (they are in its kv state).
- **"leaderboard": false** in a game's manifest: still accepted (manifests
  in community repos carry it) and read by nothing — the catalog no longer
  copies it, and the Worker's table has no `NO_BOARD`. A game that set it
  (Connect 4, Tic Tac Toe, Undercover, Draw & Guess, Glowdown, Guess What,
  29) now counts towards head-to-head like any other.

Kept: the two-report agreement and the leaver rule ("Who a match counts
for", "Leaving is a loss"), because head-to-head reads confirmed matches —
they keep one player from writing another's record alone; personal records
and achievements ("Records and achievements", 0007) — not boards; play
counts; the party's own standings (lib/party.js), which never touched the
server.

**Tables not dropped.** `ratings`, `runs` and `bot_wins` stay in D1, no
longer written (one additive migration, 0008, adds `match_players.team`:
"Head-to-head"); the export still returns their rows, and deleting an
account still deletes them. Dropping them is a later, explicit migration
(STATUS.md).

## Head-to-head

A person's record against another, from the matches both are recorded in
(`worker/api/match.js` `H2H_SQL`; `match_players` joined to itself on the
match): a place ahead is a **win**, behind a **loss**, the same place a
**draw** — except in a `teams` match, where the same team or the same place
(two sides level) counts as neither; `coop` matches are played together and
never count — a co-op game's scored free-for-all (Neon Survival's
multi-ship runs) is stored as `coop` for this (Lokesh, 2026-11-25). A
leaver's forfeit is a loss, against the other team only: a leaver from the
winning side is booked in a last place of their own, and
`match_players.team` (migration 0008: the report's `teams` label, else
`#<slot>` from the game's ranking for an older page) keeps their teammates
from "beating" them (a review, 2026-11-25). Only games the Worker still
knows (GAMES) count, in every total alike. No rating, no ranking of anybody.

**Old cached shells.** A shell from before 2026-11-25 reads `ratings` and
`botWins` on a profile and from `/api/me/matches`, and failed on undefined
("Could not load"). Both answers carry them, empty (`[]`), until the
table-drop migration (STATUS.md).

- `GET /api/u/<who>` signed in, not your own: `vs: { wins, losses, draws,
  games: { <game>: { wins, losses, draws } } }` — your record against them.
  The profile draws it as "You 2–0 Bo" and a table by game
  (`[data-section="vs"]`).
- `GET /api/me/matches`: `rivals: [{ id, name, wins, losses, draws, last }]`,
  everyone you have a record against, most recently played first, at most
  50. Your profile lists them under Head-to-head, each row a 44px link to
  their profile (`[data-section="rivals"] a[data-rival]`).
- `POST /api/match/report` answers, once a match counts (and on a repeat),
  `vs: [{ id, name, wins, losses, draws }]`: your record **in this game**
  against each other account in the match. The end card says "You 5–3 Asha"
  (lib/account.js endCard, `.managed-rating`), in place when the answer
  lands after the card; a toast says it once.

Cost: one indexed join per account (`match_players_account`, then the
primary key per match); no cap on how far back it reads. Fine for casual
play; if an account ever has thousands of matches, bound it by
`matches.at` (VERIFY with `EXPLAIN QUERY PLAN` on real data first).

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
a game) — a result, a play count, a match start; the summary leaves out
games no longer in it — and a result of
another kind than its game's — except the extra kinds the table lists
(`KINDS`, from `EXTRA_KINDS` in the generator: Bubble Rush is `ffa` and its
teams mode reports `teams`) and a scored free-for-all of a co-op game
(Neon Survival's multi-ship runs). `just games-table --check` (in
`just test`, the platform CI check, and `just deploy-worker`) fails when a
catalog moved on — a registry pin that adds a game needs the table
regenerated before the Worker is deployed, or that game's matches are not recorded.

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
hidden player ("Keep my profile private", `accounts.hide_public`) is, to
anyone but a friend, only `{ id, name, hidden: true }` (the people in groups
they joined still see them on the group's member list — joining a group is their
choice, and the privacy text says so) — enough to add them from their friend link —
and a signed-in friend sees the whole profile (so the profile page asks
with the token). In anyone's recent matches a hidden player other than the
profile's own and the one asking reads "(hidden)" with `id: null`, and
their score is left out. Signed in or by code, the answer is personal
(never cached publicly).

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
owns it next) and the owner's controls; no boards since 2026-11-25.

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
when **no page of theirs is in view and in use** (`live.js` `attentive`):
every page says whether it is visible and active as that changes
(`{t:"vis", visible, active}`, and on status and ping; a phone that switches
apps hides the page before freezing it; active = a tap, click or key on the
page within 5 minutes, or a game frame holding the focus, since a game's own
taps land in its frame), and a socket not heard from for 5 minutes
(`ATTENTIVE_MS`; a visible page pings every 4) counts as a frozen page. The
active flag is there so a desktop tab left on the arcade does not keep a
phone quiet for hours (re-review, 2026-11-21). An open socket alone is not
"open": Android and iOS keep a switched-away app's socket for minutes (the
review of 2026-11-21 found the first version never pushed in that, the main,
case). Chosen over a per-socket staleness timer alone because hiding is
reported at once, while a timer would leave the first minutes after
switching away silent. A page from before these flags counts as visible
and active while fresh. A hidden page that comes back shows the invite too; tapping the
notification focuses it, and the card is not shown twice.

**Only news makes a notification** (review, 2026-11-21: a friend re-inviting
every 20 s made a closed phone buzz every 20 s). News is an invite whose
code has not reached one of this friend's devices as a notification from
this sender within the invite's 10 minutes; a new code is news too, but at
most once per pair every 2 minutes (`INVITE_NOTIFY_AGAIN_MS`). The record is
D1 `invite_notices` (sender, recipient, code, when), written only once a
push service accepted the message: an invite first shown on a page in view
still notifies when repeated after that page is gone, and NOT NOW (which
deletes the waiting invite) does not make the next repeat news again
(re-review, 2026-11-21: both were wrong in the first fix). A repeat still
refreshes the waiting invite and reaches open pages. Both deliveries run after the sender
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
invites. After a 401 the page says so ("Signed out, so party invites by
notification are off on this device…") and, once signed in again, shows the
offer card one more time (localStorage `neon.push.reoffer`): the switch was
turned off for the player, not by them. `DELETE /api/push` needs **no sign-in** for that reason: the
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

## Records and achievements

*Built 2026-11-24 (branch `records`; Lokesh, 2026-11-21). The author's side —
the manifest, the condition language, the platform's own achievements, the
panels — is [platform.md](platform.md) "Achievements and records".*

Decisions (Lokesh, 2026-11-21):
- **Storage:** on the device, synced to the account when signed in. No
  anti-cheat: the device's word is taken (memory casual-not-competitive).
- **Visibility:** friends see your trophies and best times on your profile
  and in the party. No global ranking.
- **Definitions:** in each game's game.json, as conditions on its result;
  the platform checks, stores and shows them.

How it runs:
- **The device first.** lib/records.js counts each result lib/stats.js
  counted (once per run, match and ranking), in localStorage
  `neon.records` (`{ games: { [game]: state }, dirty: [game], v: { [game]:
  version }, owner }`), offline and signed out as well.
- **One device, several accounts** (review, 2026-11-24: switching account
  on a shared device used to merge A's records into B's account for good).
  The device's records and lib/stats.js's stats belong to `owner`. A device
  played on signed out has none, and the first account to sign in takes
  them. Another account signing in never gets them: they are set aside
  (localStorage `neon.records.aside`, one copy per account), that account's
  own set-aside copy comes back (or none), and only then is its account's
  copy taken. Play while signed out after A counts as A's. Signing out
  keeps the device's copy as it is (still A's).
- **Sync.** Signed in (on the page's load, or on signing in): `GET
  /api/me/records`; each game's copy and the device's become one by taking
  the best of each, on the device; whatever the account lacks or has worse
  is sent back with `PUT`, at most 16 games a request. After each counted
  result the changed games go up 1.5 s later. A game is unmarked only if it
  did not change while its PUT was in flight (its version is the one sent),
  or the server refused it (`rejected`, or a 4xx for the whole request): a
  refused game would be refused again and must not hold up the rest;
  "busy" (below) is not a refusal and goes again. A game's stats from lib/stats.js ride with it (`s`) and
  come back the same way (`NeonArcade.stats.mergeIn`). A server from before
  0007 answers 404: everything stays on the device.
- **The merge** (lib/achievements.js `merge`, the same code on both sides):
  an achievement unlocked on either side, at the earlier time; progress the
  larger (a run of days: the later run, the longer best; Every Level's
  values: both); a record the better (min/max) or the larger (sum, count);
  stats each the larger, the win streak from the side played last. Counts
  from two devices are not added — each device's count is a lower bound,
  and adding would count a synced game twice. A device with less can never
  lower anything. A record whose kind changed (an author edited `best`)
  takes the device's kind on the server (`merge(kept, sent, game, {
  prefer: "y" })`): the device knows the manifest.
- **Bounds** (lib/achievements.js `clean`, worker/api/records.js): anything
  malformed is dropped and every list bounded (64 achievements, 64 progress
  entries, 16 records of 16 groups, 100 values for a `distinct`, 200 games
  played). The page trims a game's entry to `RECORD_BYTES` (8 KB) before
  sending (`fit`: progress first, then record groups; unlocks and stats
  kept); the Worker refuses a larger one as "too big" rather than trimming
  it (trimming a crafted 63 KB body cost ~160 ms of CPU; `clean` and
  `merge` stay linear, ~2 ms for it). The platform's entry is bounded by
  construction within `PLATFORM_BYTES` (20 KB: it lists every game
  played). A request refused whole with 413 is halved and sent again; a
  single game still refused is dropped from the queue. A request body is
  at most 64 KB (a 193 KB PUT cost 10–20 ms of CPU, the free plan allows
  10), 64 games, 200 games an account. Ids must be a game's (`GAME_ID`, not
  `dev/`) or `"*"`; a bad id or a game over the account's limit is refused
  on its own (`rejected: { [game]: why }`) and the rest are kept. The game
  need not be in the Worker's table (`GAMES`): nothing ranks by it. A
  `"__proto__"` group or value is skipped, never assigned.
- **Races.** A PUT writes a game only if nobody wrote it since it was read
  (`UPDATE … WHERE at = ?`, `at` moving on with every write; a new row
  `ON CONFLICT DO NOTHING`); one that lost the race is read, merged and
  tried again, up to 8 times (each round one writer wins), then answered
  "busy" in `rejected`, which the page sends again. Six PUTs at once, each
  with its own unlock, keep all six (test-accounts; twelve at once lost ten
  before this).
- **Friends only.** `GET /api/u/<who>` carries `records` for the player and
  signed-in friends, never for a stranger, a friend code without sign-in,
  or the publicly cached copy. In the party, **🏆 TROPHIES** beside a
  friend's ADD FRIEND / FRIENDS ✓ opens theirs (lib/account-ui.js
  `memberControl`, lib/records.js `friendSheet`).

## The API

Everything under the room server, `https://neon-arcade-room.lokeshmohanty.workers.dev`
(or `?rs=` on loopback for development). Writes are limited to 120 per
address per 5-minute window (IpGate `api`).

| Route | Who | |
|---|---|---|
| `GET /auth/{github,google}/start?back=` → `…/callback` | anyone | sign in; back to `back#token=` |
| `GET /auth/test?name=&uid=&back=` | tests only (`AUTH_TEST=1`, loopback host) | |
| `GET/PATCH/DELETE /api/me`, `GET /api/me/export[?page=]`, `POST /api/me/signout` | signed in | profile, settings, delete, export (matches 2000 a page; `matchesNext`; also pending reports and starts, feedback posts, presence, and the old ranked layer's `ratings`, `winsAgainstBots`, `runs`) |
| `GET/PUT /api/me/favs` | signed in | favs: game ids, `contributor:<login>`, `collection:<owner>/<repo>` (2026-11-15; same table, no migration) |
| `GET /api/me/matches` | signed in | `{ matches, rivals }`: your last 30 matches, and everyone you have a head-to-head record against ("Head-to-head") |
| `POST /api/stats/played`, `GET /api/stats/summary` | anyone | counts |
| `POST /api/match/report` | signed in | a match among signed-in people, with `seats` and `left`. Answers `{ counted, vs }` (your head-to-head in this game against each other account in it), `{ pending, settleAt }` or `{ counted: false, why }` (bots, one phone, fewer than two accounts, a disagreement) |
| `POST /api/match/start`, `DELETE /api/match/start` | signed in | `{ game, run, match }`: this account is seated in that match with a winner (duel, ffa, teams) — the evidence a departure needs; DELETE withdraws it (the match ended without a result) |
| header `X-Test-Now: <ms>` on `POST /api/match/report` | tests only (`AUTH_TEST=1`, loopback host; ignored otherwise) | the server's "now" for that report (http.js `requestNow`) |
| `GET /api/lb/…`, `POST /api/run/start` | anyone | **410** since 2026-11-25 ("No boards") |
| `GET /api/u/<id or friend code>` | anyone | public profile (recent matches); hidden: a name to befriend, or all of it for a signed-in friend; by code: charged against guessing. Signed in, not your own: `vs`, your head-to-head against them. `records` (records and achievements, below) only for the player and their signed-in friends, hidden or not |
| `GET /api/me/records`, `PUT /api/me/records` `{ games: { [game]: state } }` | signed in | records and achievements per game (`"*"`: across games); PUT merges each game with the stored copy, taking the best of each, and answers the merged copies; `rejected: { [game]: why }` for any game it could not keep (the rest are kept); a body of at most 64 KB and 64 games, 8 KB a game (20 KB for `"*"`), 200 games an account (2026-11-24, 0007) |
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
| Display name, avatar URL | D1 `accounts` | name + avatar on a public profile and in other people's match lists, unless hidden |
| Sign-ins: provider, provider user id, GitHub login | D1 `identities` | several per account (GitHub, Google); the GitHub login shows on your feedback |
| GitHub App user token + refresh token | D1 `identities`, AES-GCM encrypted | only to post your feedback as you; Discussions on this repo only; deleted on disconnect or delete |
| Sessions (id, expiry; 60 days, sliding) | D1 `sessions` | no |
| Favourites, friends, groups, presence | D1 | no (friends see each other online unless "appear offline") |
| Friend code | D1 `accounts.friend_code` | to whoever you give it; rotatable |
| Blocks, declines (7 days), mutes, group bans, waiting invites (10 minutes), when a request was last pushed | D1 `friends`, `mutes`, `group_bans`, `invites`, `request_pushes` | no; in the export (your own rows; never a block of someone else's on you; group bans of you and by you; when your requests were pushed); deleted with the account |
| Devices getting party invites as notifications: the push service's endpoint, the browser's public key and auth secret, which VAPID key (a fingerprint), created, last refreshed; when a waiting invite last made a notification | D1 `push_subs` (0006), at most 5 an account; `invite_notices` (sender, recipient, code, when; per pair) | no; in the export as push service host and the two dates only (no endpoint, no keys); deleted on TURN OFF, sign-out, a 404/410 from the push service, and with the account |
| Matches among signed-in people (who played, in what place) and the head-to-head read from them | D1 `matches`, `match_players` | recent matches on public profiles, unless hidden; a head-to-head only to the two people in it |
| Old ratings (until 2026-11-25) | D1 `ratings`, no longer written | no longer shown; in the export (`ratings`); deleted with the account |
| Reports not yet settled, "I am seated" starts, outcomes waiting to be read | D1 `reports` (15 min; starts 1 h after their last beat) | no; in the export (`reports`); deleted with the account |
| Old solo runs and runs against bots (until 2026-11-25) | D1 `runs`, no longer written | no; in the export; deleted with the account |
| Old wins against bots (until 2026-11-25) | D1 `bot_wins`, no longer written | no longer shown; in the export (`winsAgainstBots`); deleted with the account |
| Records and achievements: per game, unlocked achievements and when, progress, records, the game's stats (played, won, per bot count, time); across games, games played, days in a row | D1 `records` (0007), one row per game, as the devices sent them, merged | to the player's friends only (profile, party); in the export (`records`); deleted with the account |
| Play counts per game | D1 `plays` | yes (summary, snapshot) |
| Feedback text | GitHub Discussions | yes, with the display name |
| Hourly snapshot: play counts (until 2026-11-25 also the top 100 per game; those files are deleted by its next run) | GitHub branch `stats` | yes |

Never stored: email; Google's token (used once to read the profile). The
GitHub App user token is the one provider token kept — encrypted, narrow,
and only so your feedback is your own.
**Delete** removes every row of the account at once (a group it owns
passes to its longest-standing member); matches stay in the
other players' histories with the name shown as "(deleted)". **Export** returns
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
with `just games-table` and commit before deploying. Since 2026-11-21 it
also refuses while the remote D1 has a migration not yet applied
(`just check-migrations`): migrate first, then deploy.

## Deploying invites by notification (branch `web-push`, 2026-11-18)

Once, by Lokesh, after the merge. **The migration must come before the
Worker**: a Worker deployed without 0006 answers 500 to every party invite
(it reads `invite_notices` after an invite to a friend not in view, and
`push_subs`) and to every account deletion. `just deploy-worker` therefore
refuses while `wrangler d1 migrations list arcade --remote` lists anything
pending (`just check-migrations`, scripts/check-migrations.mjs). Between the
migration and steps 1–2 (the keys), the new Worker answers `GET /api/push`
with `{ key: null }`, so no page offers anything and invites behave as
before. From the repo root:

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
   `just deploy-worker` (never a bare `wrangler deploy`; it refuses while
   the remote D1 still lists a pending migration).
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

*History: the ratings are gone since 2026-11-25 ("No boards"); kept for the
record of what was deployed when.*

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
its index, and `invite_notices` (per sender and recipient, the last invite
that reached a device as a notification, and its code). Additive; **migrate
first, then deploy** — `just deploy-worker` refuses otherwise ("Deploying
invites by notification" above).

`worker/migrations/0007_records.sql` (branch `records`, 2026-11-24) adds
`records` (account, game, data JSON, at; one row per account and game).
Additive: the deployed Worker never reads it. The new Worker reads it on
every profile a signed-in friend opens, on every records sync and on
account deletion, so **migrate first, then deploy**, from `worker/`, once
the branch is merged:

1. `wrangler d1 migrations list arcade --remote` — 0007 pending (0006 must
   be applied already).
2. `wrangler d1 migrations apply arcade --remote`.
3. From the root: `just deploy-worker` (it refuses while a migration is
   pending; never a bare `wrangler deploy`).
4. The site (Pages, from CI) in either order: a page from before never
   asks `/api/me/records`, and a new page on an old Worker gets 404 and
   keeps everything on the device.
5. Check, signed in on two devices: win a Neon Fission against a bot on
   one ("🏆 Unlocked: First Win"); open the profile on the other — Trophies
   and records lists it after the page loads; a friend's profile shows it,
   a stranger's view of yours does not.

### 0008 (branch `standings`, 2026-11-25)

`worker/migrations/0008_match_teams.sql` adds `match_players.team` (who
played for whom in a team match, for head-to-head). Additive; the Worker
from this branch writes it on every match commit, so after the merge:

1. From `worker/`: `nix shell nixpkgs#wrangler -c wrangler d1 migrations apply arcade --remote`
   (0007 too, if it is still pending).
2. From the root: `just deploy-worker` (it refuses while a migration is pending).
3. Check, signed in on two devices: a Connect 4 between them ends with
   "You 1–0 <name>" on the winner's card; each one's profile of the other
   shows the record.

## Testing

- `just test-stats` — lib/stats.js in Node.
- `just test-records` (2026-11-24) — lib/achievements.js and lib/records.js
  in Node: every condition operator, malformed conditions and declarations
  refused, each kind of achievement and record, the platform's own, clean
  and merge, and a result through lib/stats.js unlocking once, a beaten
  record, and a sync with a stub account taking the best of both.
- `just test-accounts` also covers records and achievements (0007): two
  devices' copies merged (earlier unlocks, larger counts, better records per
  level, stats, the platform's), a device with less lowering nothing,
  malformed entries dropped, bad ids, sizes and counts refused; a friend
  sees them on the profile (hidden or not, never cached publicly), a
  stranger, the signed-out and a friend code do not, unfriending removes
  them; the export; deletion.
- `test-bots` plays Neon Fission against a bot to the end and checks the
  unlocks (Regular as the tenth game; First Win exactly when won), the
  notice, the record from the result's facts, the time and wins per bot
  count; then 🏆 YOUR RECORDS from PARTY over the end card, 🏆 in the band with no game running, and the profile's trophies at
  390×844 and 354×696 (12px text, 44px taps, ✓/🔒 with words).
- `just test-accounts` — the API under `wrangler dev` with a local D1 and a
  fake GitHub/Google (OAuth, App JWT, GraphQL, Git Data). Since 2026-11-25
  (branch `standings`): head-to-head (a duel's wins, losses and a draw,
  free-for-all places, teammates counting as neither, co-op never, the
  mirror from the other side, nothing on your own profile or signed out,
  `rivals` most recent first, capped at 50 with 120 opponents, the report's
  per-game `vs`), the boards and runs answering 410, old `ratings` and
  `bot_wins` rows served nowhere but the export, a game that once said
  `"leaderboard": false` counting, the snapshot writing only the summary and
  deleting old board files. Still: toAccounts with no server (guests'
  places, leavers' places, teams forfeits); the audit's collusion repro
  (two colluders naming a third: counted for them only, after the grace)
  and the spoofed `acct`; kind flipping and unknown ids; guests in a
  free-for-all; leaving is a loss (duel on the winner's word, not without
  the leaver's start, not while their seated page still beats, not when
  they report it, not with a used-up start, not for a made-up match
  number, not after a withdrawal, an emptied side's empty slot, a
  free-for-all confirmed by two, not by one); a missing account in the
  roster; two last reports at once; six commits for one player at once; the
  export's reports, feedback posts and presence. `MATCH_GRACE_MS` is 3 s
  there. `just test-submission` checks the retired `leaderboard` field is
  still accepted and that the catalog no longer carries it.
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
  there), and a group with no boards.
- `just test-social` — the whole flow in two browsers at 390×844. Since
  2026-11-25: a Connect 4 between Ana and Bo is reported by both and the end
  card says "You 1–0 Bo" (never a rating); Neon Fission with Bo leaving —
  his page said it was seated, Ana's report names him, waits out the grace
  and counts, her end card says "You 1–0 Bo" in place and inside the
  screen, and Bo's head-to-head has the loss; Bo's profile says "You 2–0
  Bo" with a row per game, Ana's own lists him under Head-to-head as a link,
  both at 390×844 and 354×696 (12px text, 44px rows, no sideways scroll);
  alone or against bots nothing is sent (Tic Tac Toe, Neon Fission with the
  bot removed); the group page has no boards.
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
  and account deletion. Since the re-review: an invite first shown on a
  page in view and in use notifies when repeated after the page closes, and
  only once; NOT NOW then a repeat makes none; a visible but idle page does
  not keep the device quiet. Each check added after the review and the
  re-review of 2026-11-21 failed against the Worker before it. (`just
  test-just` holds `deploy-worker` to `check-migrations` and checks its
  verdicts.)
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
  reachable leaves an on switch on; the page reports itself in view and in
  use, and hidden; a hidden page (app switched away) gets the invite and the
  device a notification; signing out, and a session ended elsewhere (401),
  remove the device — the 401 says so, and signing in again brings the offer
  back once. Chromium cannot subscribe to FCM here, so the page's
  `PushManager` is stubbed with a subscription on the fake service.
