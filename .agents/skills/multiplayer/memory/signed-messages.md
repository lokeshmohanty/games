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

Round 3 (2026-11-20; "who said it, round 3"): **a lone vote must never
displace a crown already held at that term.** Once a departed host had
really gone, Cy's self-vote on its last record passed every "do you still see
the vacated holder" check and won the term on the lower id. A lone vote is
refused against an anchor at that term or a hand-over by the holder it calls
vacated, and an attested crown outranks a lone one at one term.

**Lokesh (2026-11-20), round 4: "Refuse it".** A phone never accepts that a
host has left while it is that host or still holds a live link to it — for
every election certificate, at every depth — as an honest voter refuses to
grant. *Why:* a crown counts keys with real links, and one member can add a
key cheaply (an extra tab or in-page room); two keys deposed a live host
in a full mesh. Accepted cost: a real partial split with the host alive
stays two working parties until the broken links are noticed. Also: no
election at a term its holder handed over at (`handovers`); at one term a
hand-over outranks an election, and that a lone vote; on an older record,
only acks from humans still in the latest count. What remains, by design:
real keys win a real vacancy, never a host its electorate can see.

Round 5 (2026-11-20): **seeing a holder is not the same as its key being
here.** "Still linked to it" means a link that never dropped (`_sees`):
a phone that relinked to a reloaded old host held the new crown back for
good (R). A healed partition must merge: the old host, and those linked to
it, take an election whose candidate and voters all dropped and regained
their links to them since the vacated record (S); a host commits a lot, so
64 revisions are kept. And **a hand-over and an election on one vacancy
exclude each other** — whichever is learnt second is refused — or a vanished
host plus one extra key took an elected crown back with a later hand-over
(K). Cost: the honest race (MAKE HOST, crash before it spreads, election on
the far side) splits.

Round 6: **heal evidence must be something an attacker cannot produce
while staying reachable.** A closed-and-reopened link is not: a member
closes its own connection at will, and bouncing links let G3 back in (B6).
The S rule now needs each voter concluded gone by us (`_confirmGone`: no
link, nobody vouching, past the grace) and linked again since the vacated
record. And K's mirror counts only crowns taken (`elected`), never a commit
that went nowhere.

Merge with main (2026-11-20, test-worker): **a page holding a Web Lock is
kept out of Chrome's back/forward cache.** The key lock is let go on
`pagehide` and retaken on a persisted `pageshow`, as room-join does with the
seat lock. And under per-tab keys a tab that joins another party keeps its
id (only the seat is new); test-worker's "as a new member" now checks that.

**Joins that hung only on slow runners (2026-11-21).** Found by reading the
links of a failing join under real load (taskset, two CPUs, busy loops) and
on CI (`gh workflow run test.yml --ref <branch>`, dumps on failure):
- a channel can open before the far description reads back: wait for it
  before signing a hello (`_fingerprints`);
- an answering side's first message on a fresh channel can go missing: say
  the hello again until the far side answers, and keep a signed message that
  overtakes it (only unsigned control means an old client);
- two links for one pair must be ranked the same on both ends (`_linkRank`);
- the test mock's per-message timers reordered notices under Chrome's
  nested-timeout clamp; it now delivers in order, one message per task, as a
  socket does (a batch in one task starved a dial's continuation and lost
  the notice behind its reply).
Latency alone (0–800 ms per hello) reproduced only the mock's case; CPU
starvation reproduced the rest.

Costs: see docs/index.md "Who said it" (Node and throttled Chromium).

Related: [[split-party]], [[addressed-is-not-private]], [[bots-as-members]],
[[reload-mid-game]], [[room-server]].
