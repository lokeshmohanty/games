# Across networks: what only a real NAT shows

*Established 2026-11-11, when `scripts/test-nat.mjs` (the namespace NAT lab,
see `docs/network-testing.md`) first ran. Every earlier suite ran on loopback,
where none of this can happen.*

## Decisions the lab forced

- **"No route" is its own verdict.** When the party *answered* (an offer
  arrived) but ICE failed, net.js calls `onError(msg, { reason: "no-route" })`
  and `joinRoom` rejects `no-route` at once (~15 s) with that message. Before,
  the join waited to 30 s and said "nobody answered — it may have ended",
  blaming a party that was there. Keep the two apart: `no-answer` = nobody
  offered; `no-route` = somebody did and no path exists (no TURN, by choice).
- **An isolated member re-announces.** When the *last* link closes while the
  roster still has people (net.js `onIsolated`), room-join re-dials the room
  server with the same claim, unconditionally. The server's announcement is
  the only thing that makes anybody offer. Without it a network switch healed
  only when TCP noticed the dead socket (40 s+, two hosts meanwhile), and a
  blackout a little longer than the link's patience left *both* sockets
  healthy and the party split forever.
- **Glare rule.** Two isolated members re-announcing together can each be told
  to offer. An offer arriving while ours is in flight to the same member: the
  lower id's stands, the higher id answers it. `answering` stops us offering to
  someone we are answering; net.js closes the leftover invite (`forPeer`) once
  the pair links. Two links per pair would each close the other's.

## Traps in the lab itself

- A Linux router that does not drop new inbound on its WAN *input* is not a
  cone NAT: an early hole punch is confirmed into conntrack and squats on the
  port, and masquerade remaps the outbound punch. Two "cone" homes then fail.
- IPv6 link-local addresses arriving after link-up read to Chrome as a network
  change and abort loads with `ERR_NETWORK_CHANGED`. The lab is IPv4-only.
- A convergence check that does not first wait for the disruption to be seen
  passes instantly on the pre-disruption state. Wait for the drop, then for
  the heal, and require links back — a roster can look whole with every link
  down.
- nft: `fwd` is a keyword (name chains something else), and one-line rulesets
  need newlines between chains.

## Numbers (headless Chrome, 2026-11-11)

ICE gives up on a pair with no path at ~15 s. Chrome declares a stalled link
`disconnected` some seconds in; with `DISCONNECT_GRACE_MS` (3 s) the link is
dropped ~9–10 s after a blackout starts, so 8 s blackouts survive. Network
switch to links back: ~10.5 s.

## Against the real internet (2026-11-11, `just test-nat-live <url>`)

slirp4netns (`--enable-ipv6`, unprivileged) attached to the lab's
"internet" namespace puts the lab NATs in front of the host's real network;
the deployed worker and real public STUN replace the lab's. Learned:

- **Real STUN cannot see the lab NATs.** Every lab client's srflx is the
  host's public address, so two lab clients (or a lab client and the host)
  meet only by hairpinning through the host's real NAT. This host's ISP
  CGNAT does not hairpin: cone↔cone and host↔lab fail with an explicit
  `no-route` at ~16 s — correct behaviour, same as two phones on one
  carrier CGNAT. A real cross-network *success* needs a second public
  address (hotspot, VPS); still unverified.
- **Cloudflare challenged the host's IPv4** (403, `cf-mitigated:
  challenge`), never its IPv6. The lab pins the worker's hostname to a TCP
  forwarder that dials over IPv6; WebRTC stays IPv4 through the lab NATs.
  A challenged player would see "Could not reach the room server".
- Symmetric↔symmetric with real STUN: explicit failure at 15.4–17.4 s,
  matching the local lab.
