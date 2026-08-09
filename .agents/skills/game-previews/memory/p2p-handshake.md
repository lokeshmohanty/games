# Driving the P2P handshake in the recorder

Rewritten 2026-08-09, when `lib/net.js` dropped Trystero for a manual
invite/answer handshake. Replaces the old `joinRoom` / `waitForPeer` helpers,
which typed a shared room code into `.lobby-input` — that element no longer
exists.

**Why:** the previews are the only automated coverage the P2P games have, so
they break silently whenever the lobby's connection flow changes. They also
masked the bug that prompted the rewrite (see below).

## How `connectPeers` works

`scripts/preview.mjs` drives the same steps a human does:

1. Page 0 (always the **host**, always the recorded page) clicks `CREATE GAME`
   — or `INVITE ANOTHER` for the second and later guests.
2. Read the invite link out of the first `textarea.share-code`.
3. Guest opens the link, produces a reply code in *its* first
   `textarea.share-code`.
4. Host fills the **last** `textarea.share-code` with that reply and clicks
   `CONNECT`, then waits for `.peer` to say "other player".

Only the host can start the game, so `startGame` clicks page 0 unconditionally.

## Traps

- **Navigate the guest to `about:blank` first.** The guest page is already
  sitting on the same game file, so going straight to the invite differs only in
  the `#i=` fragment — a fragment-only navigation that re-runs nothing, leaving
  the recorder waiting forever for a reply code. (Real users hit this too; the
  lobby now reloads itself on `hashchange`, but the recorder does it explicitly
  rather than depending on that.)
- **Previews no longer need network access.** The old "peers never connected"
  advice pointed at Nostr relays; there is no signalling service any more. STUN
  is still contacted, but two pages on one machine pair over host candidates
  even offline.
- Connection is now deterministic rather than a discovery race, so a failure
  here is a real bug, not flakiness worth retrying. One transient 30s timeout
  was observed under two concurrent Chrome launches — retry once before
  investigating.

## What the previews were hiding

Both pages used to join within ~1s of each other, which is the *only* window in
which Trystero's Nostr discovery reliably worked. Every real game — where the
second player joins seconds or minutes later — hung on "Waiting for peers to
join…". Verified 2026-08-09 against the deployed site: a 60s gap never connected
in 180s. Any future preview scenario that connects two peers back-to-back should
be assumed **not** to cover the join timing real players experience.
