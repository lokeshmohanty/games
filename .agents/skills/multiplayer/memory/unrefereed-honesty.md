# Making an unrefereed game honest: two checks, not one

Written 2026-08-27, building `games/battleship.js` — the first game where no
browser could be allowed to hold the authoritative state.

**Why:** every other game here is host-authoritative, and that is fine while the
state is public. It collapses the moment the state is *your ships*, because the
host is a player and would be holding the other player's fleet. The fix is not
obvious, and the half-fix is very obvious — which is the trap.

## The shape that works

Nobody holds anybody else's secret. Each player:

1. **commits** to their fleet before a shot is fired — publish
   `SHA-256(nonce | canonical(fleet))`, keep the fleet local;
2. **answers for their own board** during play — they are the only one who can;
3. **reveals** fleet and nonce at the end, and everybody re-checks.

The fleet never crosses the network during play at all, so there is nothing to
intercept and nothing to relay. See [[addressed-is-not-private]] for why
"just mail it to the host, addressed" is not a private send.

## The half-fix that looks complete

**Verifying the digest is not enough.** It proves only that the fleet was
decided before the shooting started. It says nothing about whether the answers
given during play matched it — a player can commit honestly and then simply lie
about a hit, and the digest verifies perfectly at the reveal.

So the reveal runs **two** checks:

| Check | Catches |
|---|---|
| digest matches the revealed fleet | swapping the fleet after the fact |
| every answer replayed against that fleet | lying about any individual shot |

`auditAnswers()` is the second one, and `scripts/test-battleship.mjs` tests it
by *breaking* it four ways — denying a real hit, inventing one, announcing a
sinking that never happened, suppressing a real one. A commitment nobody can
fail is decoration.

There is a third, easy to miss: **a revealed fleet must also be a legal fleet.**
Overlapping ships would let a player pack twelve cells into eight squares and
survive four extra hits, and the digest would verify it happily. `auditAnswers`
runs `validateFleet` first for that reason.

## Two smaller traps, both cost a debugging cycle

- **`JSON.stringify` key order is not stable across a round trip.** A fleet that
  has been through the network comes back with keys in whatever order the sender
  used, hashes differently, and fails verification with no bug behind it. Hence
  `NeonArcade._canon` — hash a canonical form, always.
- **`makeRounds`'s `botSubmit` is synchronous and `commit` is not.** A bot's
  fleet and its commitment must be built *before* the placement phase opens, and
  cached; the callback can then return the digest. Battleship does this in
  `newGame()`.

## Where this generalises — and where the sealed channel actually belongs

**Commit-reveal is the answer whenever players can generate their own secret.**
Battleship (place your own fleet) and Liar's Dice (roll your own dice, added
2026-08-27) both do, so neither needs `secrets.channel()` at all.

Liar's Dice was built expecting to be the sealed channel's first user — the
host deals five dice to each player, privately. That build is wrong, and the
reason is worth keeping: sealing protects a message from the peers **relaying**
it, never from the **sender**. A host that deals has read every cup, and the
host is a player.

The sealed channel earns its place only when one party must know something the
others must not, and no player can generate it themselves — a **shared deck**
dealt without replacement, where the hands have to be disjoint. A card game.
Not a dice game, and not a board anyone lays out for themselves.

## The async trap that accuses an honest player

Verifying a commitment is asynchronous. Settling a round changes the state the
verification is checked against — in Liar's Dice, the loser drops a die. Read
the player's dice count *after* the await and you compare the hand they rolled
against the number of dice they hold **now**, and report them as a cheat.

It appeared once, in one bot, in a suite that otherwise passed. **Snapshot every
piece of state a reveal is judged against before the first `await`.** A false
cheating accusation is the worst thing either of these games can do, and it is
invisible until it fires.
