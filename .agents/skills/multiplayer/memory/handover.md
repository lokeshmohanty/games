---
name: handover
description: How a running game survives its host leaving (party.js takeOverGame, per-game takeOver, rounds.adopt) — Lokesh's choices and the traps found.
metadata:
  type: project
---

**Lokesh (2026-11-13):** a crown change hands the game over instead of ending
it. The departed host's seat is **held like any lost player's**; games with
hidden information **resume at a clean point** (Liar's Dice re-rolls the
round, Neon Bid reopens the unsettled lot); Battleship, whose bots' fleets left
with the old host, still ends.

- party.js `checkCrown` (1.5 s settle): the new host sets `ctx.isHost = true`
  and calls `handle.takeOver()`; true → `p$handover` to the others (toasts),
  false → `setGame(null)`. An old host whose tab survived remounts as a guest.
- **`onPeerLeave` for the old host fires before the crown moves**, so the heir
  heard it as a guest and ignored it. `takeOver` must reconcile seats whose
  owner is gone (Onitama remembers names in `leftNames`; Connect 4 re-runs
  `rosterChanged`).
- **Trap: a restarted phase at the same round/index was no change to the
  guests' mirrors** — they kept what they had submitted to the old host (Neon
  Bid: a "sealed" bid nobody held). `rounds.js` now publishes an epoch, bumped
  by `adopt` when it re-enters a phase.
- Room-server parties hold the old host's seat, so an ending says "The host
  changed, so the game ended…", not "…left".
- A closed tab is AWAY first, so Neon Survival's heir starts with the
  host-pause 3-2-1 before the swarm moves (test waits for it).

Related: [[reload-mid-game]], [[bots-as-members]], [[leaving-and-presence]].
