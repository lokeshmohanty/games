# Neon Bid — design

*Decided 2026-11-12 with Lokesh. An original sealed-bid auction; 2–8 seats,
bots fill any of them. Mobile first.*

## Where the code is (SDK v2, 2026-11-14)

On branch `platform-v2` the game is an SDK v2 game ([sdk-v2.md](sdk-v2.md)),
**Layer 1**: it speaks the protocol itself rather than handing its rules to
the platform.
- `games/neon-bid/rules.js`: the rules as pure functions (lots, paying,
  scoring, the audit, the bot), exposed as `globalThis.neonBidRules`.
  `scripts/test-neon-bid.mjs` loads this file alone.
- `games/neon-bid/neon-bid.js`: the screen and the wire.
- `games/neon-bid/neon-bid.css`: the look, unchanged from v1.

**Why not managed state.** A managed game's rules run on the host, so every
bid would reach the host as it was placed, and the host is a player. Here
the host only ever holds digests until the bidding has closed.

| v1 (in the frame) | v2 (a shell service) |
|---|---|
| `makeSecrets().commit` / `verify` | the `commit` / `verify` requests, answered by the bidder's own shell |
| `secrets.keep` / `kept` (a reload) | `init.session` + `session.set` |
| `makeRounds` + `botSubmit` | `timer.open` / `timer.do`; a bot's turn arrives as a `timer` `bot` event, answered with `submitFor` |
| `room.makeAction("nbState" / "nbOpen")` | `arcade.channel("nbState" / "nbOpen")` |
| `takeOver()` | `arcade.answer("takeOver", …)` |
| `ctx.reportResult` | `arcade.result`, on every phone |

Openings go to the host on an ordinary channel, as in v1. They are sent only
once every commitment is in, so a phone that relays one learns nothing it
could still use. The game keeps its own end table and NEW GAME button: the
shell's end card is for managed games only.

One workaround: a `timer.do` that reaches the shell before `timer.open` has
loaded lib/rounds.js is dropped. So the host repeats `start` every 0.5 s until
the first phase comes back. `start` does nothing to a running clock.

## The game in one paragraph

Twelve glowing gems — four colours, three of each — are auctioned one at a
time. Every player has **100 credits for the whole game** (no income). Each
round everyone bids in secret at the same time; the bids are revealed
together. The **highest bid wins the gem and pays the second-highest bid**
(a lone bidder pays the reserve, 1). A **tie for highest refunds**: nobody
wins, nobody pays, and that gem is discarded. Bidding 0 is a pass. After the
twelfth lot, gems score and the most points wins.

## Scoring

| Gems of one colour | Points |
|---|---|
| 1 | 1 |
| 2 | 3 |
| 3 | 6 |

Plus **4 points** for owning at least one gem of every colour. Ties on points
break by credits left; still tied → shared win.

## Why these rules

- **Second price** rewards bidding what a gem is really worth to you, and
  still leaves room to bluff: overbidding is cheap when nobody else wants it,
  ruinous when someone does.
- **One budget, no refill** makes credits scarce, so late lots stay tense
  despite second-price discounts.
- **Escalating sets plus the rainbow bonus** pull in two directions — focus a
  colour or spread — and make a gem worth different amounts to different
  players, which is what makes an auction interesting.
- **Ties refund** keeps it gentle for casual players; the gem is lost to
  everyone, which is its own small sting.

## Fairness on this transport

- **The lot order is public from the start.** All twelve gems are laid out
  in a row (host shuffles once, broadcasts the order before the first bid).
  Nobody — including the host, who is also a player — knows anything the
  others don't, and seeing what's coming is part of the strategy.
- **Bids are commit-reveal** (`lib/secrets.js`): each player commits to
  `hash(bid, salt)` during the collect phase and reveals after everyone has
  committed. A bid cannot change after seeing anyone else's. The host
  verifies every reveal against its commitment and against the bidder's
  remaining credits; a bad reveal forfeits that player's bid (counted as 0).
  See [[unrefereed-honesty]] in the multiplayer skill memory.
- **Simultaneous turns** on the shell's clock (`timer.*`, lib/rounds.js) with
  `collect: true`: the round ends when everyone has committed (bots answer
  the clock's `bot` event with `submitFor`), with a timer as a backstop; an
  absent player's bid is 0.
- **The host settles only the lot on screen.** The lot being settled is always
  the round clock's lot, and only while its bids are opening. Until
  2026-11-14 the fallback timer for missing openings was armed *after* the
  host's and bots' openings. Those openings had already settled the lot
  synchronously, so the timer fired 4 s later into the next lot's bidding and
  settled it as "everybody passed". From then on the screen was one lot behind
  the game, so bids were applied to the wrong gems and bots were flagged as
  "never opened their bid". This happened in every game played against bots.
  `test-bots` now bids at a person's pace and checks every sealed bid against
  the lot it settled.

## Bots

Host-side, through the same path as a person's bid. A bot values the
current gem by the marginal points it would add to its own hand (set step +
rainbow progress) and what it would deny the current leader, scales by
credits left per remaining lot, and bids that value plus a little noise. It
must beat a random bidder clearly (rules test).

**A bot never bids its whole balance.** Its bid is capped a random 0–30%
below what it holds. At 6–8 seats the valuation runs past the balance; the bots
still on 100 credits then all bid exactly 100, tie for highest, and the tie
throws the gem away. That repeated every lot from about lot 4, in every 7–8
seat game, until the 2026-11-14 fix. `test-neon-bid` now checks every table
size from 2 to 8: most lots sell and no game stalls on ties.

## Screens (390×844 first)

- **Top:** the row of twelve gems (current one raised and pulsing; won gems
  show the winner's mark; discarded ones dim). A player's mark is a ring in
  their seat colour around their initial (two letters where initials clash).
  It is never a filled dot, because the seat colours and the gem colours are
  the same theme tokens (`--p1…--p8` and `--p2…--p5`), and a dot read as a gem.
- **Gem names follow the theme.** `--p3` is cyan under Neon and blue under
  Paper, so that gem is "Cyan" under Neon and "Blue" under Paper. It is renamed
  live when the theme is switched.
- **Middle:** the current gem, large, with what it's worth to *you* right now
  ("+3 points: completes a pair").
- **Bottom:** your credits, a bid stepper (−/+ and quick chips: 0, 5, 10,
  25), and a big BID button that turns into "waiting for 3 more…".
- **Reveal:** every player's bid flips over at once, winner highlighted, the
  price paid shown ("pays 14").
- **End:** a score table with each player's gems by colour.

## Out of scope (v1)

Effect lots (steal, freeze), income rounds, variable lot counts, a
spectator-only view beyond the existing spectator handling.
