---
name: split-party
description: Lokesh's "heir side only" + "skip hidden + quorum" rules for a party that splits as its host leaves — who is named, who may crown, who is lost, how a lost side rejoins — and the re-dial traps (2026-11-16/17).
metadata:
  type: project
---

**Lokesh (2026-11-16): "Heir side only"; (2026-11-17): "Skip hidden + quorum".**
When the host leaves and the rest cannot all reach each other, exactly one
piece carries on. Every other piece is **lost**: no crown, game hidden then
stopped, "Lost connection to the party" with TRY AGAIN (room server) and
LEAVE PARTY. One party, never two.

How net.js does it (docs/index.md "A split party"):
- **Who is named:** `_successor(gone)` ranks `lastRecord`, the roster the
  crown holder last published. It skips own-goodbye departures (`departed`),
  passed-over heirs (`skipped`), held seats, and, while anyone else could
  take it, `away` members. Everyone reads the same record.
- **Who may crown:** whoever is named crowns only with a quorum (`_quorum`):
  more than half of the record's humans, or exactly half including
  `firstHeir`. Own-goodbye departures and the old holder (`vacated`) are left
  out of both sides of the fraction. A side is self plus direct links only.
- **An heir alone against a majority is lost; it does not crown.** I read
  that as what Lokesh's quorum decision implies: the majority would pass over
  a cut-off heir, so if the heir crowned too, the party would fork. Confirm
  with Lokesh if it is questioned.
- **Waiting for the heir:** `computed` means "the crown is an heir we
  computed and have not heard". It is not `!heard`: a reloaded page has heard
  nobody (a review found that mixing the two lost a reloaded heir, and with
  it the whole party). The wait is `HEIR_WAIT_MS` (`_watchHeir`); then the
  heir is skipped (`_succeed`).
- **Being lost and coming back:**
  - `_lose` re-announces now and after `LOST_RETRY_MS`.
  - `_outranks` while lost takes only a newer term than `lostTerm`, the heir
    itself, or the old host at the old term **if it still seats the heir**.
  - Lost phones that relink retry the quorum after the heir's wait
    (`_retakeWithQuorum`).
- **A held host's seat:** a host the room server holds a seat for sends no
  `__gone`. The member that concludes it gone broadcasts `__v` (crown
  vacant). A receiver with no link to the host runs its own `_suspect` and
  does not vacate on trust: taken on trust, one member's early give-up
  re-crowned a reloading host's heir (test-room 6e22).
- **Not covered:** a partition between a *live* host and the rest. Both sides
  keep a crown, and term ordering heals it.

The re-dial (fix-host-loss, then this):
- A dropped direct link is re-dialled on the **second** vouch (2.5 s), not the
  first, so a stale vouch for a member who is leaving costs no offer.
- **Trap: one-sided detection.** The higher id still holds the dead link and
  sets the lower id's offer aside. The offer is then marked seen, so
  `_resendOffer` (same envelope id) is dropped too. `_redial` on a `__q`
  naming ourselves abandons the offer, but only one already sent, and makes a
  fresh one.
- **Trap:** an offer abandoned mid-gather used to still go out, and its
  answer landed on the fresh offer. Now an abandoned offer is not sent, and
  answers echo the offer's nonce.

Tests: test-plumbing "a split party" and "…reviewed" (fake transport: the
splits, the reloaded heir, the hidden heir, the frozen heir, a minority heir,
lost phones relinking into a quorum, the old host's same-term record, the
held host's seat, the room-server retries, nonces). test-party's lost screen
goes through `_lose` and the heir's record, at 390x844 and 354x696, in three
themes.

Related: [[handover]], [[cross-network]], [[leaving-and-presence]].
