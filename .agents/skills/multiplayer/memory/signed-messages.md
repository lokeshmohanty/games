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

Costs: see docs/index.md "Who said it" (Node and throttled Chromium).

Related: [[split-party]], [[addressed-is-not-private]], [[bots-as-members]],
[[reload-mid-game]], [[room-server]].
