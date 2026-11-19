---
name: signed-messages
description: Lokesh's 2026-11-18 decisions for signed party messages (id = key hash, sign control + relayable, refuse old clients, key per tab) and the traps found building it — hello ordering, aliased records, the newcomer's vote, replays, crown proofs.
metadata:
  type: project
---

**Lokesh (2026-11-18, settled, do not re-open):**
1. **Id = hash of the key.** ECDSA P-256, private half non-extractable, in
   IndexedDB. `id = base36(SHA-256(raw pk))`, 16 chars. The key crosses the
   link once it opens; **codes do not grow** beyond the longer id.
   *Why:* an id anyone can claim is what made every forgery possible; a
   hash-id needs no PKI and no extra bytes in a QR.
2. **Sign control + relayable.** Direct-link game traffic is proven by the
   link's verified owner, unsigned. A bot's message counts only from the
   current host (`o`), for a bot in its record. *Why:* 15–30 Hz paths stay
   free.
3. **Refuse unsigned, no transition window.** Old phones cannot join or stay;
   both sides told clearly, never a silent hang.
4. **Key per tab session** (approved): IndexedDB holds keys, sessionStorage
   `neon.key` names the tab's, the rejoin token's id names it for a rejoin.
   Two tabs = two players; a reload keeps the id. No IndexedDB → page-only key.

How net.js does it: docs/index.md "Who said it" (hello, `_authentic`,
`_proven`, `pend`, `rev`, `fw`, old clients). Don't re-derive it.

Traps found (each cost a debugging cycle):
- **Never talk before your own hello has left.** Verifying the far hello can
  finish before signing ours; `_linkOpened` then sent `__alive` first and the
  far side refused us as an old client. `_preHello` awaits `link.hello`.
- **A kept envelope must be a copy.** `_applyParty` makes the record object
  live (`this.party = next`); a proof or `hostEnv` holding the same object was
  edited by `setGame`/sorting and its signature broke two hand-overs later.
  `structuredClone` what you keep; `_send` JSON-copies what it defers.
- **Signing makes `_send` async.** Anything that closed a link right after a
  send lost the message: `removeMember` lingers the evictee's link until the
  queue drains, `leave()` signs its `__gone` then closes. Tests that muted a
  room "after" a send must wrap `_route`, not `_send`.
- **A forwarded host record is a vote.** Handing a newcomer the host's signed
  record (needed: a member's own copy is no longer anyone's word) made a page
  reloaded mid-vote heard again — it voted twice. Marked `fw` (unsigned):
  no vote, and established members ignore it. A stripped mark is a residual.
- **Signed ≠ fresh.** Anyone can resend a signed record; records carry `rev`
  (rises with the clock across reloads) and the same holder's older one is
  dropped.
- **Higher term needs proof**, or any member signs itself a crown. Election
  certificate = the `__ka` quorum the election already gathers; hand-over =
  the previous holder's signed record. A certificate is checked against the
  record of its vacancy's term, kept for the last few terms (`pastAnchors`),
  or two certified crowns at one term never heal.
- **Re-addressing breaks signatures**: introductions are broadcasts now.
- **Ids that were made up in tests** ("000000000000", "ghostseat") no longer
  rejoin: a seat is reconnected only with its key. Draw keys until one sorts
  where you need it.

Review 2026-11-19 (rejected 9cf8207; test-plumbing "who said it, reviewed"
holds each proof of concept):
- **Never take a certificate's word for its own key.** A member wrote
  `gone|0|self|self` and was its own quorum. The key is rebuilt from the
  vacated holder's signed record carried in the certificate (`rec`), which
  must be one we hold or newer, or proven itself (that is also how a phone
  two crowns behind catches up: the chain nests). Voters and checkers share
  `voteKeyOf`.
- **A signature without a party id replays across parties.** An old party's
  `__x` closed a new one the same tab founded; a certificate won elsewhere
  crowned its holder in a stranger's party. Every signed message carries
  `pa` = the record's `pid`.
- **The `seen` window is no defence**: 512 ids roll over in seconds at
  30 Hz. Bind freshness to state: `__k`/`__gone` name the seat's `joined`,
  `__x` the term, records `rev`, `pend` seats expire. Key `seen` by sender
  and id, or a member pre-empts another's message by its id.
- **A key anybody can make is not a member**: game traffic only from the
  record's members. `pend` stops invented seats, not sybils with real keys.
- **sessionStorage is copied** by duplicate-tab and window.open: hold a Web
  Lock per key for the page's life; a reload waits briefly for its
  predecessor to let go.
- **An unattested crown** (the candidate's vote alone) is taken only by one
  who no longer sees the old holder.

Re-review 2026-11-19 (9fd7e5a; test-plumbing "who said it, re-reviewed"):
- **A key speaking for itself through a relay proves a key, not a device.**
  A member made three keys "speak for themselves" via it and had a quorum.
  A seat votes only once a hello-verified link of its own proves it
  (`pend` 1: on another's word, expires; 2: spoke via a relay, plays, never
  votes). Real extra tabs with real links are inherent.
- **A rule checked only at the top of a proof is a rule an attacker wraps.**
  A self-vote under hand-overs (through a made-up key and back) skipped the
  "unseen" check that ran at depth 0. Every rule applies at every depth; a
  hand-over goes only to a voting member; an older record never with a
  smaller roster than the latest held.
- **A prompt any member can trigger is a nuisance tool.** "Reload to rejoin"
  only for a well-formed chain cut short ("far"), signed by seated members.

Costs: see docs/index.md "Who said it" (Node and throttled Chromium).

Related: [[split-party]], [[addressed-is-not-private]], [[bots-as-members]],
[[reload-mid-game]], [[room-server]].
