---
name: split-party
description: Lokesh's "heir side only" rule for a party that splits as its host leaves — who crowns, who is lost, how a lost side rejoins — and the re-dial traps found on the way (2026-11-16).
metadata:
  type: project
---

**Lokesh (2026-11-16): "Heir side only."** When the host leaves and the rest
cannot all reach each other, only the piece holding the heir carries on.
Every other piece is **lost**: no crown, game stopped, "Lost connection to the
party" with TRY AGAIN (room server) and LEAVE PARTY. One party, never two.

How net.js does it (docs/index.md "A split party"):
- The heir is `_successor(gone)`: ranked over `lastRecord`, the roster the
  crown holder last published, minus members gone by their **own** goodbye
  (`departed`). Our own copy of the roster is not used, because our probes
  may have dropped the heir, and every piece must name the same member.
- A non-heir that only *computed* the heir (`heard` false) waits
  `HEIR_WAIT_MS` (10 s) for its record (`_watchHeir`). Silence, an heir
  already out of our roster, or concluding the heir gone ourselves (any
  `__gone` but its own) all lead to `_lose()`. The `!heard` guard at the top
  of `_vacateCrown` is what stops the second, self-crowning vacancy.
- `_lose` re-announces to the room server (`onIsolated`), and `rejoin()` asks
  again. The heir's record (a higher term) ends it in `_applyParty`. A lost
  member that the heir dropped carries its own seat back in (`__i`), the same
  path as a crown change that left it out.
- **Trade-off, accepted:** host and heir failing together leaves nobody
  hosting.
- **Not covered:** a partition between a *live* host and the rest is not a
  departure. Both sides keep a crown, and the term ordering heals it on
  reconnection.

The re-dial (fix-host-loss, then this):
- A dropped direct link is re-dialled on the **second** vouch (2.5 s), not the
  first, so a stale vouch for a member who is leaving costs no offer.
- **Trap: one-sided detection.** The higher id still holds the dead link and
  sets the lower id's offer aside. The offer is then marked seen, so
  `_resendOffer` (same envelope id) is dropped too. `_redial` on a `__q`
  naming ourselves abandons the offer and makes a fresh one.

Tests: test-plumbing "a split party" (fake transport: a 3-seat 1v1 split,
both probe orders, the heir's own goodbye, rejoin rather than fork, one-sided
detection), and test-party's lost-screen check (the shell's half, through
`onLost`).

Related: [[handover]], [[cross-network]], [[leaving-and-presence]].
