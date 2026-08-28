# An addressed message is not a private one

Written 2026-08-27, when `lib/secrets.js` was built and the question "can we
just use `send(data, { target })` for a player's hand?" had to be answered.

**Why:** the answer looks like yes. `makeAction().send(data, { target })` names
one recipient, `_send` walks straight to `this.links.get(env.t)`, and every
other peer's `_deliver` is never called. Reading the routing code, it is a
point-to-point send. It is not, and the case where it is not is the *normal*
case here rather than an edge one.

## The leak

`net.js:1065` — when there is no direct link to the target:

```js
if (env.h <= 0) return;
const relayed = { ...env, h: env.h - 1 };
for (const [id, link] of this.links) {
    if (id !== env.f && link !== from) link.send(relayed);
}
```

The envelope is handed to **every peer that might reach them**, in plaintext,
with the payload intact. Those peers are the other players.

And this is not the rare path. The project refuses a TURN server on purpose, so
a pair that cannot connect directly is an expected outcome, not a failure — it
is the whole reason relaying exists. A hidden-information game built on bare
`target` leaks exactly when the network is imperfect, which means it works in
every test on one machine and leaks in the room where people are actually
playing.

## The two problems, which need two answers

Conflating them produces a fix that solves neither.

| Problem | Who is the adversary | Answer |
|---|---|---|
| A relayed private message is readable | another **player**, mid-route | encrypt it end to end |
| The host knows everything it referees | the **host**, legitimately holding the state | commit-reveal |

Encryption does nothing about the second: the host is a valid recipient of the
state it is adjudicating. Commitments do nothing about the first: a commitment
you must eventually open still travels. `lib/secrets.js` has both, and a game
with a secret usually needs both.

## Decisions inside `secrets.js` worth not re-deriving

- **Public keys ride the party record** (`room.setMeta`), not a broadcast of
  their own. The record is already adopted wholesale by late joiners
  (`_applyParty`), so somebody arriving mid-hand gets every key published before
  they existed — with no re-announcement protocol to get wrong.
- **The AEAD binds channel, sender and recipient**, not just the payload.
  Without that, a relay could replay somebody's sealed hand into a different
  channel and the tag would still verify.
- **Commit digests are taken over a canonical serialisation** — keys sorted at
  every depth. `JSON.stringify` preserves insertion order, so a value that has
  been through the network can serialise differently from the one that was
  hashed. That is a verification failure with no bug behind it and nothing to
  see in a diff.
- **A private message to a bot never reaches the wire.** The host plays it, so
  the channel delivers locally with `to` naming the bot — the same trick
  `emitAs` plays for public moves. See [[bots-as-members]].
- **WebCrypto needs a secure context, and `file://` is one** in Chrome and
  Firefox — verified by running it, not assumed. It is still checked at runtime:
  `secrets.privacy()` returns `"plain"` rather than downgrading silently, and a
  game with a secret should refuse to deal on `"plain"`.

## Nothing uses it, and the search is the useful part

As of 2026-08-27 **no game uses `secrets.channel()`.** It is proven by
`scripts/test-plumbing.mjs` and by nothing else. That is worth knowing before
anybody assumes the module is load-bearing.

Twice the obvious candidate turned out not to need it. Battleship and Liar's
Dice both hide something, and in both the player can generate their own secret —
a fleet you lay out, dice you roll — so commit-reveal covers it and nothing has
to travel. See [[unrefereed-honesty]].

**The rule that came out of it:** could each player generate this for
themselves? If yes, commit. Sealing is for the case where they cannot.

A shared deck is that case: hands off one deck must be **disjoint**, so nobody
can generate their own and somebody has to deal. Oh Hell (trick-taking) was
built on exactly that, used the channel, worked — and was removed on 2026-08-27,
because of what sealing cannot do.

**Sealing does not protect a secret from the sender.** It protects it from the
peers *relaying* it. A host that deals has read every hand, and the host is a
player. No commitment fixes it either: the host chooses the shuffle it would be
committing to. The honest fix is mental poker — a deck encrypted commutatively
by all players, which nobody can read and everybody can shuffle — and it is not
built. Until it is, a dealt game here has one player who knows everything, and
saying "the hands are sealed" would imply more than is true.

One consequence to know before anyone tries to remove the dealer: Oh Hell's host
validated every play against the hand it dealt, which worked *because* the
dealer knew. Taking that knowledge away means re-solving move validation too.

## The only test shape that catches a regression

`scripts/test-plumbing.mjs` builds **real `Room` instances over a fake
transport** rather than mocking the room. That is not a convenience: the fake
link is what lets the test *read the wire*, so "the relay carried no plaintext"
is asserted against the bytes that crossed Ana's browser, not against a belief
about the code. The topology is built deliberately lopsided — host↔Ana,
Ana↔Bo, no host↔Bo — because with a full mesh nothing is relayed and the test
would pass while proving nothing.

If a game ever does use the channel, note that **with bots a deal never leaves
the host**, so a single browser proves nothing about sealing. Only a test with
several real peers — `scripts/test-party.mjs` — shows secrets actually crossing
a wire. `mountParty` exposes `handle` for exactly that.
