# STATUS — volatile state

*Update in place; keep short; absolute dates. History lives in git log.*
*Not loaded by default — `AGENTS.md` points here on demand. Keep it that way:
if this file grows past ~10KB, split the archive out rather than making every
session pay for it.*

# TODO(user added)

*Updates/tasks/queries added by the owner; process only when he says, then
act → record → clear the item. This is the single inbox — do not create a
separate `TODO.md`.*

## Current focus (2026-08-27)

Plumbing first, then a deep game, then a casual one — in that order, mobile
first throughout.

Shipped this session:

**Plumbing.**
- `lib/secrets.js` — sealed private channels and commit-reveal. The problem it
  solves is specific: an addressed `send({ target })` is relayed through another
  *player's* browser whenever a pair cannot connect directly, which with no TURN
  server is routine. Keys are ECDH on the party record (it already replicates to
  late joiners), payloads are AES-GCM with the channel, sender and recipient
  authenticated. Commitments hash a **canonical** serialisation, because
  `JSON.stringify` key order is not stable across a round trip.
- `lib/rounds.js` — the round/phase clock Draw & Guess had written by hand, plus
  the two things it lacked: a `collect` phase that ends when everyone has
  submitted (simultaneous turns, which suit this transport better than anything
  else), and `botSubmit` so a collecting phase is not held open by a seat with
  no browser behind it. Durations on the wire, never timestamps.
- `lib/ui.js` — the stage/HUD/overlay chrome four games had each rebuilt.
  Factory functions over plain DOM. `setHud` updates text nodes in place.
- `room.setMeta()` in `net.js`, refusing the fields the party record owns.
- `scripts/test-plumbing.mjs` (31 checks) drives **real `Room` routing over a
  fake transport**, which is the only way to read the wire and prove the relay
  carries ciphertext.

**Onitama** (`games/onitama.js`, `onitama.html`) — the deep one. Rules and the
alpha-beta search live *outside* `mount`, as `NeonArcade.onitamaRules`, so
`scripts/test-onitama.mjs` plays whole games with no document. Iterative
deepening under a 500ms budget. Beats random play 20/20.

**Light Cycles** (`games/light-cycles.js`, `light-cycles.html`) — the casual
one. Grid on a fixed tick, so eight players cost a few dozen bytes per tick and
peers accumulate the trail from head positions. Bot scores **territory**
(Voronoi), not just open space. Beats a never-crash rider 30/30.

**SolidJS was re-weighed and re-rejected** (asked again 2026-08-27). Reactive
surface is ~20% of the code; JSX needs a compiler emitting ESM, which browsers
refuse over `file://`. `lib/ui.js` is the counter-offer from the 2026-08-10
analysis, finally built.

**Battleship** (`games/battleship.js`, `battleship.html`) — the game the
plumbing existed for, built next because two of the three top Next actions said
nothing used it yet. Nobody holds anybody's fleet, not even the host: you commit
to yours, answer hit-or-miss for your own board, and open the commitment at the
end. **Verifying the digest is not enough** — it proves only *when* the fleet was
fixed, so the reveal also replays every answer against it, and refuses a
revealed fleet that is not legal. `test-battleship.mjs` tests the audit by
breaking it four ways. Both players fire in the same round (`rounds.js` with
`collect: true`) rather than taking turns, which is the shape that suits this
transport: nobody waits on a turn order.

**Liar's Dice** (`games/liars-dice.js`) — and a correction. It was meant to be
the sealed channel's first user: host deals five dice to each player, privately.
**That build is wrong.** `secrets.channel()` seals against the *peers relaying*
a message, never against the sender — a host that deals is a host that has read
every cup, and the host is a player. So it does what Battleship does: each
player rolls their own dice and commits before a bid. The generalisation:
commit-reveal is the answer whenever players can generate their own secret; the
sealed channel only earns its place with a **shared deck** dealt without
replacement, which is still unbuilt.

**Draw & Guess moved onto `lib/rounds.js`** — the game the scheduler was
generalised *from*, which is what makes it the proof. A `phase` string, a chain
of `setTimeout`s and a re-check in every callback became one declaration; the
re-check is gone because a disposed scheduler fires nothing. `timeLeft` stopped
being broadcast — each peer counts down from the duration the host sent, and
`test-party.mjs` asserts three peers agree to within a second.

`rounds.next()` was added for both: a phase that ends on a game event rather
than a clock (a called bluff; everyone guessing right).

**Oh Hell removed** (2026-08-27, at Lokesh's call). It was the sealed channel's
only user and it worked, but sealing cannot protect a hand from the *dealer* —
the host deals and the host is a player — and no commitment fixes that, because
the host chooses the shuffle it would commit to. Mental poker is the honest fix
and is not built. So `secrets.channel()` is back to having **no user**, which
the docs now say plainly rather than leaving the module looking load-bearing.

**Undercover** (`games/undercover.js`) — and with it a new category: games
played **on one device**, passed round a table. `local: true` in the
registration is the whole of it. `checkRoster` stops enforcing seats (a local
game's players are names typed into one phone, not rows in the party record) and
`lib/lobby.js` offers a plain START instead of INVITE / PLAY A BOT.

This is the answer to the cost the whole project is organised around: a
handshake is paid once per person, and for six people at one table that is five
handshakes to play a game nobody needed a second screen for.

Two traps found building it, both of which read as a sulky game rather than a
bug:
- **A table must survive one wrong vote** (`n >= 2*others + 2`). Five players
  with one undercover *and* a blank does not — three against two, over on the
  first wrong guess, before anybody had spoken twice.
- **No word may appear in two word-pairs**, or a returning player can rule out
  the other half. The test caught "Violin" in two.

All eleven suites pass (424 checks): codec, party, scan, pwa, bots, plumbing,
onitama, light-cycles, battleship, liars-dice, undercover.

## Next actions

- [ ] **More one-device party games.** `local: true` makes them cheap now, and
      the category is the one the arcade was missing. Candidates, roughly in
      order of how different they are from Undercover: a **hot-potato word
      game** (a letter combo and a timer that goes off when it likes — frantic
      rather than deductive), **charades/fishbowl** (teams, a timer, words
      everyone types in first), and a **werewolf narrator** (deal roles by
      passing, then the phone runs night and day).
- [ ] `secrets.channel()` has no user again. Leave it — it is proven, it is
      small, and the next game that genuinely needs a dealer nobody has to trust
      will need **mental poker** underneath it anyway (commutative encryption
      over BigInt, no dependency), not just a sealed pipe.
- [ ] `scripts/test-party.mjs`'s host-succession section flaked once in five
      runs on 2026-08-27 (timed out waiting for the crown to be offered after
      the host's page closed). Four passes either side, nothing else failed.
      Not investigated.
- [ ] Draw & Guess's word is sent to the drawer addressed, not sealed — a
      relaying player can read it. Fine for a party game; worth a line in the
      game if anyone ever cares.
- [ ] Light Cycles' bot may be too strong to be fun (30/30 against a
      never-crash baseline). There is no difficulty concept anywhere in the
      arcade; if one is wanted, decide it once and apply it to all six.
- [ ] Onitama's per-card first-player stamps are ours, not the published deck.
      Marked `VERIFY` in the source — correct them against a real box.
- [ ] `lib/rounds.js` does not survive host succession. Neither does any game,
      but this one is new and it is written down now.
- [ ] Retrofit the other four games onto `lib/ui.js`. Deferred deliberately:
      they are tested and working, and the shell was proven on the two new games
      first.
- [ ] Verify on real phones — scanning and installing are both still only
      tested against headless Chrome. iOS is wholly unverified: no install
      event, manifest icons ignored, its own service-worker eviction rules.
- [ ] **The Firefox hints have never been seen in Firefox.** They are reasoned
      from the platform. Open the portal in Firefox desktop and Android once.
- [ ] No test forces a pair to fail, so the two-hop relay path is unexercised;
      the 8-player cap is likewise untested.
- [ ] `sw.js`'s `VERSION` is bumped by hand. Harmless while online (code is
      network-first), but the offline copy goes stale if it is forgotten.
