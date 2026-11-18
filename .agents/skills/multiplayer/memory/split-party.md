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
  crown holder last published. It skips passed-over heirs (`skipped`), held
  seats and, while anyone else could take it, `away` members.
- **One record, nothing local.** All of those marks come from the record
  itself. Our copy is never read: a relink clears `reconnecting` locally, and
  a review found two sides naming different heirs, both crowning.
- **Who may crown: an election in two phases.** This replaced counting
  "here" messages, which double-counted members across a split: two crowns,
  three once.
  - **Grants:** a named candidate grants itself and asks (`__c`). Each
    member grants **one** candidate per vacancy key (`granted`) and replies
    (`__gr`).
  - **Commit:** with a grant quorum, the candidate broadcasts `__ck`. A
    voter still holding its grant acknowledges (`__ka`) and is bound for
    good (`committed`). The candidate crowns only on an acknowledgement
    quorum.
  - **Safety:** quorums intersect, and the shared member acknowledges at most
    one commit per key. Grants alone failed when a winner's record never got
    out: the grants lapsed and a second candidate won.
  - **Quorum:** more than half of the record's humans, or exactly half
    including the tie-break heir.
  - **Delivery:** election messages flood the whole mesh (not only "missing"
    members). Requests and commits repeat every `REASK_MS`, and a release is
    said three times. A direct-link-only narrowing lost them on half-dead
    links and was dropped.
  - The key is: vacated, the record's term, the **tie-break heir** and the
    human ids. Members vote only on an equal key.
  - The tie-break heir is the oldest human by `joined`, never by
    `away`/`reconnecting`. Those change within a term, and a record marking
    the heir away that reached one side only made two keys, then two crowns.
  - **Grants lapse (unless acknowledged).** The voter frees a grant
    `2 × HEIR_WAIT_MS` after being asked. The candidate counts only within `HEIR_WAIT_MS` of standing, by
    both the monotonic and the wall clock. A dead candidate no longer binds
    everyone. Members that granted the named heir wait for the lapse before
    naming the next.
  - **Refused requests are kept** (`asks`): one refused because the host's
    link lingered, or because our grant was given, is granted when that
    changes.
  - **Threat model:** election messages can be forged, since `f` is unsigned
    (as with `__p`). Signing is the planned follow-up.
  - No quorum in `HEIR_WAIT_MS`: release (`__r`), never count them again,
    step aside. A voter is freed only by hearing that release; a release
    that overtook its request is remembered (`releases`).
- **No `lastRecord` means no vote** (a reload, a newcomer). That is also why
  a page reloaded mid-vote can't grant twice: its record and its grant died
  together. I chose this over persisting `granted` in sessionStorage, which
  would keep the vote but also the stale key.
- **Lost phones that relink** stand again in a new round (`_standAgain`, the
  first-ranked among self and direct links). Same key, same bindings.
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
  - Lost phones that relink stand again in a new round of the same election
    (`_standAgain`).
  - The shell withdraws a ranked start at the loss (`account.partyGone`).
  - The kept frame comes back only on the same run (`mounted.run`).
- **A held host's seat:** a host the room server holds a seat for sends no
  `__gone`. The member that concludes it gone broadcasts `__v` (crown
  vacant). A receiver with no link to the host runs its own `_suspect` and
  does not vacate on trust: taken on trust, one member's early give-up
  re-crowned a reloading host's heir (test-room 6e22).
- **Not covered:** a partition between a *live* host and the rest. Both sides
  keep a crown, and term ordering heals it.
- **Accepted residuals:**
  - With 2 humans and one fresh from a reload, nobody crowns if the reloaded
    one is the oldest.
  - A missed record that changes the humans set can still fork.
  - A candidate dying between its commit and its crown binds its quorum:
    nobody is elected for that vacancy.

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
