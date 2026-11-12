# Across networks: what only a real NAT shows

*Established 2026-11-11, when `scripts/test-nat.mjs` (the namespace NAT lab,
see `docs/network-testing.md`) first ran. Every earlier suite ran on loopback,
where none of this can happen.*

## Decisions the lab forced

- **"No route" is its own verdict.** When the party *answered* (an offer
  arrived) but ICE failed, net.js calls `onError(msg, { reason: "no-route" })`
  and `joinRoom` rejects `no-route` at once (~15 s; since 2026-11-12 only
  after the role-swapped second try, so ~30 s — see below) with that message. Before,
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
- **Linux resolves the clash a carrier drops.** The first `portdep` model
  (fully-random for non-3478 UDP + a fullcone DNAT) connected in both
  directions: when the peer's packet to the STUN mapping clashes with the
  client's own earlier flow to that peer, conntrack's UDP clash resolution
  lets it through. The model needs an explicit dynamic set of endpoints the
  client sent to first, dropping their new inbound (test-nat.mjs `talked`).

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

## Two real networks (2026-11-12, `just test-pair`, docs/network-testing.md)

Owner's Airtel mobile CGNAT ↔ an institute NAT (bhaskara), live site and
deployed worker, STUN only. Learned:

- **This CGNAT's mapping follows the destination port.** All :3478 STUN
  servers see one mapping; :19302 and :443 get others. Only the :3478
  mapping accepts a stranger's packets. Google's :19302 srflx is useless
  here: with it alone even a first join fails no-route. Keep
  `stun.cloudflare.com:3478` in DEFAULT_ICE — it is the only reason this
  network connects at all.
- **Direction decides it.** It works only when the *other* side's checks
  reach the :3478 mapping before this side sends to them — i.e. the
  restrictive side must be the ICE *offerer* (the answerer checks ~1.2 s
  earlier). If this side checks first, the NAT opens a fresh filtered
  mapping for the peer and the session is dead for that pair of sockets.
- **Who offered after a reload was a race — verified, fixed 2026-11-12.**
  The isolated member's re-announce (`rejoinServer`) closed its socket and
  re-dialled 1 s later; a member returning inside that gap found nobody
  attached, and when the stayer re-attached the hub's `announce` (oldest
  attached *other than the subject*) could only name the returner. So the
  returner offered: bhaskara on a guest reload (fails), Airtel on a host
  reload (works — which is why host reloads passed 11/11). Reproduced
  without a network in test-room 6e9 (old rejoinServer: seat unattended,
  returner offered) and in the NAT lab, scenario 10 (old code: guest
  reloads failed 2 of 3 at 16.4 s). Fix: `rejoinServer` dials first and
  lets the hub's 4409 replace the retired socket, so the seat is never
  unattended and **the member who stayed always offers**.
- **…which makes the direction deterministic, not right.** No offerer rule
  knows the NATs: with the fix, an Airtel *host* reload is now always
  answered the wrong way (lab: 15.4 s instead of a lucky fast reconnect).
  What makes it work is the **role swap**: a pair whose first ICE try fails
  is tried once more with the answerer offering (net.js `_routeFailed`,
  room-join `onRouteFailed`; mesh relay: `_openRelayed(…, {retry})` on
  failure *or* the 15 s relay expiry, which usually comes first). The
  retry is marked on the packed code (`r.` prefix, read synchronously by
  `isRetrySignal`) / relayed envelope (`r:1`), so it is never swapped
  again; the offerer holds its no-route verdict SWAP_WAIT_MS (8 s) for the
  swapped offer; the *marked* retry is not glare (it often arrives before
  our own end sees the failure) — no other offer is exempt (see
  [[room-server]] traps). No hub change: the swapped offer is an ordinary
  relayed `offer`. Cost: a genuinely unconnectable pair now says no-route
  at the join deadline (30 s, +8 s once if a swap is under way; worst case
  38 s) with the first try's message, not ~15 s. Shortening the first try was rejected: Chrome's ICE
  failure (~15 s) is not configurable, and a watchdog would kill a slow
  first try that, for this NAT, may be the only direction that works.
  (The open watchdog added later, OPEN_TIMEOUT_MS, is 20 s from both
  descriptions being in — past Chrome's own verdict, so it never beats it.)
  Follow-up worth weighing: a client can detect its own port-dependent
  mapping (srflx ports differ between the :3478 and :19302 servers for one
  base) and volunteer to offer.
- **Trap: an offer told down a socket that is being replaced (2026-11-12).**
  Dialling first (above) keeps the old socket `current` while the new dial
  is out — and in a blackout that dial's SYN is held back for seconds while
  the old, established socket still *delivers* (the lab's netem drops only
  the router's egress; real one-way outages do the same). Scenario 5's
  "blackout outlasting the link by 5s" then failed ~half the runs: the
  host's re-announce reached the blacked-out guest on its old socket
  naming it the offerer; it gathered with STUN unreachable (`typ host`
  only), the offer flushed out when the network came back, the host
  answered (setting `answering`, which muted its own offer on the guest's
  re-announce), the wire kept the *answered* guard, and ICE failed. The
  host's answering side never reported failure, so no swap came, and the
  guest's no-route was terminal — both isolated, both sockets healthy,
  nobody left to offer. Fix (room-join `owed`): an `offering` notice that
  arrives on a retired socket is deferred to the replacing dial landing
  (a network that works), not acted on and not dropped — dropping it broke
  test-room 6e9, where it is what makes the stayer the offerer. Pinned by
  test-room 6e15 (a held join). Heal after the network returns: 2.3 s.
  Residual closed (2026-11-12): an answering link that never fails used to
  block the swap for good. net.js now arms an open watchdog
  (`OPEN_TIMEOUT_MS`, 20 s — Chrome's ~15 s verdict plus slack, counted
  from the answer taken / our answer gathered) on direct links (the
  answerer's only when a machine carries its answer — trap below); one
  not open by then goes through `_linkFailed`, exactly as ICE `failed`
  (once per link, `link.failed`): the answerer offers back and
  room-join's `answering` guard is released by `onRouteFailed`; a stuck
  *retry* ends in an explicit no-route. Relayed links already had the
  15 s relay expiry. Pinned by test-room 6e16 (fails without it). Chrome
  *does* fail a waiting answerer on its own across real NATs (~15.6 s,
  see "Final code" below). Still VERIFY the timing: the offerer's SWAP_WAIT_MS (8 s after its ~15 s failure) can
  close before a watchdog-driven swap lands if the answerer's re-gather
  is slow (≥ ~3 s) — then the offerer reports no-route first (terminal
  only for a joiner) and still answers the swap when it arrives.
- **Trap: a watchdog on the answerer must not apply where a human carries
  the reply (2026-11-12).** The open watchdog first armed on *every*
  answer once gathered — including the manual scan/paste flow (party.js /
  lobby.js joinFlow), where a person carries the reply back by QR, paste
  or `#a=` link, routinely > 20 s. The guest's connection was closed and it
  showed no-route with its reply QR still on screen; the host's later
  `acceptAnswer` then linked to nothing. Fix: the answerer arms only on
  `answerInvite(code, { watch: true })`, passed by room-join's
  `answerOffer` alone (relayed links keep their 15 s `_expire`); the
  offerer still arms in `acceptAnswer`, where the answer is in hand.
  Note the offerer answers ICE checks *before* it has the reply, so the
  waiting guest's ICE reads `connected` — any test of this must wait past
  two periods (see below). Pinned by test-room 6e17.
- **The watchdog re-arms once for a link whose ICE is up (2026-11-12).**
  "Opened" means the data channel; at expiry a link with
  iceConnectionState connected/completed (or connectionState
  connecting/connected with a selected pair) may be DTLS/SCTP retrying
  under loss, so it gets one more period, then fails. A `failed`/`closed`
  connection never re-arms. test-room 6e18.
- Test-side: a convergence check after a reload must require *new* links
  (`mark` the old RTCPeerConnections) — the reloading tab's old link can
  still look whole on the other end for a moment.

## Final code, two real networks, undeployed (2026-11-12)

`just test-pair --site=… --rs=… --rs-remote=… [--remote-hosts]
[--manual=SECS[,remote]]` against the working tree served from bhaskara
(static server + `wrangler dev`, reached here over `ssh -L`). Results in
docs/network-testing.md. Learned:

- **6/6 runs pass both ways**; every wrong-direction case is carried by the
  role swap at ~18 s (B joins 19.7–21.6 s). Nobody sees a final error.
- **Who offers after a reload is decided by the glare rule, not by who
  stayed.** The stayer sees itself isolated only after the returner has
  re-attached, so its re-announce names the returner while the returner's
  attach names the stayer: both offer, the lower id's stands. Airtel-host
  guest reloads were ~2 s with the host the lower id, ~18 s (swap) with
  the guest lower. Don't trust "the member who stayed always offers" above.
- **Manual scan/paste across these NATs has a ~15 s window.** The waiting
  answerer's ICE fails on its own at ~15.6 s (Chrome's verdict, not the
  watchdog): it shows no-route and the later `acceptAnswer` links to
  nothing. Lab/loopback reads `connected` there; a real port-dependent NAT
  sends the offerer's check responses out another mapping, which the
  answerer's filter drops. Works only with the offerer-only side inviting
  and the reply back within ~15 s; the other direction never (no swap in
  that flow).
- Test-side: bhaskara's login shell is fish (wrap in `bash -c`), it has no
  openssl (`head -c 32 /dev/urandom | base64`), and its :8000 is taken;
  `pkill -f` over ssh matches its own command line unless the pattern is
  `[w]rangler…`.

## The hard NAT says so, and its offer stands (2026-11-12, undeployed)

Fix for "who offers after a reload is a glare coin flip" (above). Decided:

- **Self-classification, not a rule about who stayed.** net.js
  `classifyNat`: one RTCPeerConnection asks both DEFAULT_ICE STUN servers
  (:3478, :19302); group srflx candidates by *foundation + address*
  (foundation = base, so two interfaces never look like one hard NAT —
  Chrome zeroes `raddr`/`rport` under mDNS, so they cannot be used), two
  ports in a group = hard. Chrome reports an identical mapping once
  (deduped per base), so "soft" needs gathering *complete* with no
  `icecandidateerror`; anything uncertain is `null` = the old rule.
  Started by room-join before the dial, never awaited. This
  machine (Airtel) classified hard from headless Chrome: 7085 vs 31597.
  **VERIFY on Firefox:** foundation = base is what Chrome and Safari do;
  Firefox is unchecked. Wrong there only reads hard as not-hard (the old
  rule), never the reverse — two ports are still required in one group.
- **Decided per address family, not vetoed by any error** (bhaskara,
  2026-11-12). A Tailscale `fd7a:` IPv6 address with no IPv6 route: IPv4
  answered from both servers in 45 ms with one mapping, every IPv6 STUN
  request timed out (701, ~40 s) — the 5 s cap fell and the one error
  flag made it `null`. Now: hard at once on two ports; a family with a
  mapping and no error *of its own* is soft `NAT_SOFT_SETTLE_MS` (2 s)
  after its first mapping (an identical second answer is never an event,
  so "settled" is the only evidence); an error whose `address` shows no
  family vetoes all. Mis-reading soft is harmless — only `natHard ===
  true` changes behaviour — but a hard NAT whose second answer is > 2 s
  late would read soft. test-room (stubbed candidate stream). VERIFY what
  Firefox/Safari put in the error's `address`.
- **Re-asked, not once per page** (review, 2026-11-12). Remembered per
  set of STUN servers (`fresh` replaces it; fewer than two servers =
  `null`, never remembered — it used to poison the page's one cache).
  room-join re-asks on isolation (`rejoinServer`) and on `online` /
  `navigator.connection` `change`; the last verdict stands until the new
  one lands, newest ask wins, a `natHard`-pinned room never asks. A phone
  moved from carrier to Wi-Fi otherwise stayed "hard". test-room 6e21.
- **Rollout trap: an old tab never answers a marked offer** (review,
  2026-11-12). The build before the marks decodes with plain `atob`;
  `h.`/`r.` throws, and its answerOffer swallows it. A hard member that
  set an old tab's plain offer aside (offer-back, or glare winner) waited
  for the 20 s backstop, which dropped theirs too → `no-answer`. Fix:
  `GLARE_FALLBACK_MS` (6 s from the later of ours leaving / theirs set
  aside) — ours unanswered → withdrawn, theirs answered; the backstop also
  answers a still-held offer (when ours was never answered). 6 s must stay
  above a current client's answer (gather ≤ 4 s + two hops) or two
  current clients would each answer the other's dropped offer. test-room
  6e20; 6e8 changed with it.
- **The mark rides the code** (`h.` after any `r.`; `isHardSignal`), and
  each side weighs the mark *its own offer was minted with*
  (`offeredHard`), not `room.natHard` now — classification can land
  mid-gather, and the two ends must reach one verdict.
- **Glare preference alone does not fix a host reload.** Only the stayer
  is named (the returner hears no notice), so there is no glare. A hard
  member offered to with nothing in flight sets the offer aside and offers
  back, marked; the far side's glare rule lets it stand. Never to a hard
  offer, never to the retry, never with a link to them up — bounded, no
  storm. Lab proof the test bites: with `natHard` forced null, scenario 10
  goes back to 15.4 s swaps.
- **Test-side:** test-room pins `NeonArcade._pinNat(null)` — otherwise the
  machine's own NAT (real STUN, file:// pages) decides glare checks with
  hand-made offers. Pin per room with the `natHard` option. Rooms in one
  page share the classification, so same-page pairs always fall back to
  the lower id. test-plumbing counts RTCPeerConnections: classification
  lives in room-join, never in the Room constructor, for that reason.
- **Not covered:** the mesh relay (`_openRelayed`, lower id) still needs
  the swap; two hard sides; a NAT hard in filtering only.
- **Verified on the real pair (2026-11-12, undeployed,
  docs/network-testing.md "Hard-NAT offer rule…"):** 7/7 runs both ways,
  Airtel's offer in use every time, no role swap; reloads 1.8–3.6 s; joins
  2.1–2.6 s (Airtel hosts) and 5.2–10.6 s (bhaskara hosts: the offer-back
  round trip). Airtel `natHard` true.
- **Trap: a dead IPv6 interface makes a soft NAT read `null`.** bhaskara
  (Tailscale `fd7a:` base, no v6 route): STUN over v6 times out with
  error 701 at ~39.9 s, so gathering is not complete by NAT_CLASSIFY_MS
  (5 s → `hard() || null`) and is `errored` when it is — `null`, never
  `false`, though the IPv4 base showed one mapping. Harmless while the
  hard side's mark decides; it matters only if a rule ever needs "soft".
- **Manual replies:** inherent ~15 s window, so UX only — lobby.js
  `REPLY_NOW` on the reply screen, `replyFailed` (status + MAKE A NEW
  REPLY = reload, re-answering the same `#i=`) on a pre-open `no-route`.
  UI tests force ICE `failed` by overriding `pc.connectionState` and
  calling `onconnectionstatechange` (the real `_watch` path). Real pair
  (2026-11-12): Airtel inviting, 5 s links; 25 s, and bhaskara inviting
  at any delay, fail at ~16 s with the replyFailed text + MAKE A NEW
  REPLY on party.html (~14–15 s after the reply appears).
- **Trap (test-side): on loopback the failed first reply had really
  connected.** The second reply then failed to link ~1 run in 2 under
  `just test` (passed standalone). Likely cause, *not verified*: the
  inviter caches the first replier's DTLS ClientHello (libwebrtc keeps one
  that arrives before the role is known) and replays it against the
  second reply's fingerprint. The tests now strip the invite's candidates
  before the first reply is answered (init-script wrapper, sessionStorage
  so the reload's reply is untouched) — what the real case looks like,
  since there ICE never connected. 3/3 green after. If a real "same
  invite, new reply" ever fails to link after a *connected* first reply,
  this is the suspect.
