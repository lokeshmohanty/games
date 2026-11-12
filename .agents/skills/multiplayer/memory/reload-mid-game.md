---
name: reload-mid-game
description: How a guest who reloads mid-game gets the game back (party.js mounted notice, secrets.keep/kept) and the traps found building it.
metadata:
  type: project
---

**Lokesh (2026-11-12)** picked these from the audit backlog: a returner after a
reload came back to a blank game, and Battleship called them a cheat (the
fleet was re-rolled). Fixed the same day; test-worker section 10.

- **Re-sync is pulled by the returner, not pushed on join.** party.js sends
  `p$mounted` to the host after every non-host mount; the host's game gets
  `onPeerJoin(id, { back: true })`. Every game's onPeerJoin is a full state
  push, so this needed no per-game protocol.
- **Trap: net.js *does* re-announce some returners — before their page has
  mounted.** A first version skipped notices within 3 s of a net.js join
  (to avoid a double push for newcomers). On the room-server reload path the
  host heard onPeerJoin ~0.8 s before the guest mounted; that push was lost
  and the notice was then swallowed. No dedupe: a second push is harmless.
  Draw & Guess posts "joined" only for net.js joins.
- **Secrets: `secrets.keep/kept` (sessionStorage, keyed by member id).** A
  kept value is only taken back when the host's published digest is its
  digest (Neon Bid while collecting: when `submitted` includes us). Restore
  points: the state message (digests), and Neon Bid's onPhase too.
- **Battleship owes answers to volleys fired while it was away** — the host
  keeps `lastVolley` and re-sends it to a returner; reports dedupe by square.
- Not covered: a reload that outlasts a 4 s opening window (Liar's Dice call,
  Neon Bid open phase). Game pages (no party shell) have no rejoin at all.
- Test traps: Onitama's first mover is decided by the side card, not by
  team — drive whoever is to move through the board. Light Cycles' check is
  weak: an idle race ends during the reload, and the next round re-sends the
  whole grid anyway, so it passes even without the fix.

Related: [[leaving-and-presence]], [[room-server]], [[unrefereed-honesty]].
