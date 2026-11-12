# Neon Bid — design

*Decided 2026-11-12 with Lokesh. An original sealed-bid auction; 2–8 seats,
bots fill any of them. Mobile first.*

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
- **Simultaneous turns** on `lib/rounds.js` with `collect: true`: the round
  ends when everyone has committed (bots via `botSubmit`), with a timer as a
  backstop; an absent player's bid is 0.

## Bots

Host-side, through the same path as a person's bid. A bot values the
current gem by the marginal points it would add to its own hand (set step +
rainbow progress) and what it would deny the current leader, scales by
credits left per remaining lot, and bids that value plus a little noise. It
must beat a random bidder clearly (rules test).

## Screens (390×844 first)

- **Top:** the row of twelve gems (current one raised and pulsing; won gems
  show the winner's colour dot; discarded ones dim).
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
