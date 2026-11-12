# Testing across real networks

*Added 2026-11-11. The suite: `scripts/test-nat.mjs`, run by `just test-nat`
(or `scripts/test-nat.sh [--only=3,5] [--verbose]`).*

Every other browser suite runs its peers on one machine's loopback, where every
candidate pair connects and no NAT is in the way. That is precisely the setting
in which the failures this project promises to *name* cannot happen: symmetric
NAT, a room server a network blocks, a phone whose network changes under a
party. This suite builds those networks out of Linux network namespaces and
runs the real pages, the real room server and real headless Chrome across them.

## The lab

```
"internet" namespace — the test process itself
  198.51.100.1 on br0:  STUN (udp 3478 and 3479, a 40-line binding responder in the
                        script), the repo over http (8000), and the real
                        room server — `wrangler dev` of worker/ (8787)
  per site:  router ns   wan 198.51.100.1x  ── nftables NAT, optional netem
             client ns   10.x.0.2 behind it ── its own headless Chrome
```

- **No privilege.** `scripts/test-nat.sh` runs the suite as root of its own
  user namespace (`nix shell … -c unshare -rn node …`); nothing touches the
  host's network and no sudo is involved. The network tools come from nixpkgs
  (`iproute2`, `nftables`, `conntrack-tools`) because NixOS's system `ip` is
  not usable here; wrangler too (npx's `workerd` does not link on NixOS).
- **One browser per device.** Each Chrome is launched through an `nsenter`
  wrapper into its client namespace, so it sees only that network, while
  Playwright still drives all of them over its ordinary pipe. Separate
  browsers, so separate `localStorage` — rejoin tokens behave as on real
  phones.
- **Pages** load `party.html`, and each browser context's init script sets
  `localStorage["neon.rs"] = "http://198.51.100.1:8787"` and
  `localStorage["neon.stun"] = "198.51.100.1:3478,198.51.100.1:3479"` — two
  ports, as DEFAULT_ICE has two servers on two ports, so net.js
  `classifyNat` sees `portdep` map them differently (hard) and `cone` not
  (since 2026-11-12). (The room server is not
  a `?rs=` param here: a link may only name a loopback room server, since
  2026-11-11 — see docs/room-server.md.) The STUN key is the one test hook
  this added to `lib/net.js`: it
  replaces the public STUN servers, which the lab cannot reach, with the
  lab's. Storage only, and only a plain `host:port` — it was briefly also a
  `?stun=` query param, which let any link point a player at a STUN server
  that forges addresses (or, given `turn:…`, crash the connection); removed
  2026-11-11. Still STUN only — there is no TURN, by choice.
- **IPv4 only** inside the lab: a veth's IPv6 link-local address appears a
  second after the link comes up, and Chrome reads that as a network change and
  aborts whatever is loading (`ERR_NETWORK_CHANGED`).

### NAT behaviours

| Name | nftables | Behaviour |
|---|---|---|
| `cone` | `masquerade` + input drop of new inbound | endpoint-independent mapping, address-and-port-dependent filtering — the common home router. Two of these connect by hole punching. |
| `fullcone` | the same + `dnat` of every inbound UDP port to the client | endpoint-independent filtering. Rare; the one cone a symmetric NAT can still reach. |
| `symmetric` | `masquerade fully-random` | a fresh port per destination, so the address STUN saw is useless to a peer. Many mobile carriers (CGNAT). |
| `portdep` | `masquerade` toward udp :3478, `masquerade fully-random` for other UDP, `dnat` of inbound UDP to the client, and a dynamic set (`talked`) dropping new inbound from any endpoint the client already sent to | the owner's carrier CGNAT as measured on 2026-11-12 (below): only the STUN-port mapping takes a stranger's packets, and only if they arrive before this side has sent to that stranger. Against `cone` it connects when this side *offers* and never when it answers. |

**Trap found building it:** without the router's input drop, a peer's hole
punch that arrives *first* is accepted into conntrack (then refused by the
stack), and that confirmed entry squats on the very port the outbound punch
needs — the NAT picks another port and a cone behaves like a symmetric NAT.
Every real router firewalls its own input, so the lab does too. (A router that
does not would make even two "cone" homes fail to connect.)

## Scenarios and what they assert

Every scenario asserts the outcome **and** a time bound. "Explicit failure"
means an error in the status line with a reason, within 35 s (the 30 s join
deadline plus slack) — never a spinner.

| # | Setup | Asserted | Measured (2026-11-11) |
|---|---|---|---|
| 1 | two cone NATs, join by code | joins; messages both ways; host reload and guest reload each reconnect and converge on one host | join 0.6 s; each reload 1.5 s |
| 2 | two cone NATs, classic invite/reply through the real UI | joins; messages flow | 0.7 s |
| 3 | both symmetric | code join and classic join both fail explicitly, with the *network* named, RETRY offered, and the verdict not later replaced by "nobody answered"; host not left with a phantom member | fails at 15.5 s (ICE's own verdict); since the role swap (2026-11-12) the code join at 30.3 s — the swapped second try is cut by the 30 s deadline, which says no-route — and the classic join still at 15.4 s (no path to swap over) |
| 4 | symmetric vs cone; then full cone + two symmetric | the first fails explicitly; in the second all three join, the symmetric pair has no direct link, messages between them arrive relayed through the third, and the doomed pair raises no error on a working party | 15.5 s (30.3 s since the role swap); joins 0.3 s |
| 5 | network switch and blackouts on cone NATs | conntrack flush is invisible; 4 s and 8 s blackouts keep the link (`DISCONNECT_GRACE_MS`); blackouts that outlast the link heal; a guest's and then the host's public address changing heals to one host with links back | links drop ~9–10 s in; healed 0.5–1.5 s later (10.5 s after a switch) |
| 6 | three cone NATs, `netem delay 200ms 50ms loss 10%` on every WAN | code, both joins, messages, and a reload all inside the 30 s deadline | joins ~7 s; reload ~8 s |
| 7 | one router drops the room server's port | a code join says "Could not reach the room server" with RETRY; that client still hosts classically (no code) and the invite/reply connects it | 8.1 s (the dial timeout) |
| 8 | three cone NATs, one switches network | only the mover re-announces; it is back in the full mesh, the crown never moves, nobody sees an error | 10.9 s |
| 10 | `portdep` host + `cone` guest; then `cone` host + `portdep` guest + a second `cone` guest under id `000000000000` | the carrier classifies hard, the cone not; join, three guest reloads and two host reloads each reconnect with links both ways in < 6 s on the carrier's own first-try offer (no swap); the reverse join, two carrier-guest reloads and two cone-host reloads the same; the relayed pair (the low-id cone offers first; the relay knows nothing of NATs) links after the swap; nobody sees an error | (2026-11-12, hard-NAT glare preference) join 0.3 s, guest reloads 0.3 s, host reloads 0.5 s; reverse join 0.6 s, its reloads 0.5–0.6 s, cone-host reloads 0.3 s; relayed pair 15.7 s. With the classification switched off (same run, `natHard` forced null): host reloads 15.4 s, reverse join 15.7 s, carrier-guest reloads 15.4 s — the swap. Before the earlier fixes: guest reloads failed 2 of 3 at 16.4 s |

## Bugs it found (fixed 2026-11-11)

1. **A code join between two networks with no path ended in the wrong
   message.** ICE fails at ~15 s and net.js said so precisely, but the join
   kept waiting to its 30 s deadline and then replaced that with "Nobody in
   that party answered … It may have ended" — blaming a party that did answer.
   Now net.js tags that error `{ reason: "no-route" }`, `joinRoom` settles on
   it at once with net.js's message, a rejoin keeps its claim for RETRY (not
   exercised by the lab), and the party screen offers RETRY (another network
   may have a path).
2. **A network switch took 40 s+ to heal, with two hosts meanwhile.** The
   switched client's signalling socket was dead but undetected (no traffic,
   so TCP never noticed), and nobody offers to a member the server has not just
   announced. Both sides ran the reconnect grace, both crowned, and only an
   eventual TCP failure re-dialled.
3. **A blackout slightly longer than the link's patience never healed.** Both
   ends lost the link, but both signalling sockets survived — so *nobody*
   re-announced, nobody offered, and the party sat split with two hosts and
   each other RECONNECTING until the 5-minute grace dropped them.

   The fix for 2 and 3 is one rule: when a member loses its **last** link
   while the party still has people in it (net.js `onIsolated`), room-join
   re-dials the room server with the same claim. The server's re-announcement
   makes the elected member offer. When both ends re-announce at once each may
   be told to offer, so room-join has a glare rule — the lower id's offer
   stands, the higher id answers it — and net.js closes the unanswered invite
   once the pair is linked. The lab shows the heal and one link per pair
   afterwards; it does not assert that glare itself occurred in a given run.
4. `NeonArcade.hostNewGame()` (NEW PARTY, START A NEW PARTY) dropped `?rs=`,
   quietly moving a new party onto the default room server. It carried
   `?rs=` for a while; since 2026-11-11 the room server comes from storage
   (`neon.rs`), which a new party keeps without the URL, and `?rs=` is
   loopback-only, so NEW PARTY carries no query at all.

## What it cannot show

- **Real phones and real carriers.** The NAT types are Linux's; real CGNATs
  vary (port-block allocation, mapping timeouts, hairpinning). One is
  approximated (`portdep`, from the 2026-11-12 measurements); the rest are
  not modelled. Mobile data on 2026-08-10 is still the only field observation.
- **A device that knows its own network changed.** Here the *router's* address
  moves, so Chrome on the client sees nothing. On a phone walking from wifi to
  cellular, the browser's own network-change watcher fires too — which closes
  sockets sooner (likely faster healing), but is not exercised.
- **ICE restart** — the code has none; a switch is healed by a fresh link, not
  by restarting the old one. The measurement above is that path.
- **Same-LAN play** (mDNS `.local` host candidates between two clients behind
  one router) is not built: every client has its own router.
- **Deployed Cloudflare** — in the default (wrangler dev) mode. See the
  live mode below for what a deployment showed.
- **IPv6**, and TCP-only networks (ICE-TCP), are not modelled.
- **Eight players.** The largest party here is three.

## Live mode: real Cloudflare and the real internet (2026-11-11)

Two suites run against a *deployed* worker (first verified on a
`wrangler deploy --temporary` preview deployment, then repeated on the owner's
permanent deployment, https://neon-arcade-room.lokeshmohanty.workers.dev):

- `just test-live <url>` — `scripts/test-live.mjs`, from the host's own
  network: `ping`, `flows`, `hib` by default; `alarm` (opt-in, ~16 min);
  `oracle` and `gate` each **alone**, 5 min after any other run — `gate`
  counts exactly ten wrong guesses and `hib`'s claim probes (a join with a
  wrong secret) and `oracle`'s dials spend the same per-IP budget (10
  unrefunded dials per 5 min since 2026-11-12, and a host's is never
  refunded — `flows` and `hib` together come close; run them apart if one
  reports `unreachable`). Results
  are tabulated at the end. `hib` proves eviction only when the deployment
  has `--var ROOM_DEBUG:1` (the 101 then names the object's instance) —
  never set it on the real deployment, it tells a prober whether a room is
  warm; without it the proof is skipped and the post-idle checks still run.
- `just test-nat-live <url>` — this lab with `RS_URL` set. `test-nat.sh`
  attaches `slirp4netns --enable-ipv6` to the lab's "internet" namespace
  (still no privilege), which masquerades the lab's public segment out of
  it, so every lab NAT sits in front of the host's real network. No
  `neon.stun` (real public STUN), no `wrangler dev`. It also starts a
  headless Chrome on the host's *own* network, driven over CDP through
  slirp's host-loopback alias `10.0.2.2` — scenario 9.

What it showed (one machine, one public IPv4 — a mobile ISP's shared
address — and IPv6):

| Check | Result |
|---|---|
| room server reachable from inside the lab | only over IPv6: Cloudflare answered the host's IPv4 with a managed challenge (`403`, `cf-mitigated: challenge`) on every request. The lab pins the worker's hostname (`--host-resolver-rules`) to a TCP forwarder in the internet namespace that dials it over IPv6; WebRTC still leaves over IPv4 through the lab NATs. |
| 3. symmetric ↔ symmetric, real STUN | code and classic joins fail explicitly at 15.4–17.4 s, network named, RETRY, verdict not replaced — green |
| 9. host-network peer ↔ lab cone / lab symmetric | both fail **explicitly** at 16.4 s ("no route") — green as an explicit-failure check, but no connection |
| 1, 5. cone ↔ cone, network switch | fail with no-route at 16.7 s: **not a bug.** Real STUN reports the *host's* public address for every lab client (the lab NATs are invisible to it), so two lab clients — or a lab client and the host — can only meet by hairpinning through the host's real NAT, which this ISP's CGNAT does not do. That is exactly two phones on one carrier CGNAT. Live mode therefore defaults to 3 and 9. |

**So the real-internet *success* path across two different public
addresses is still unverified by a test** — it needs a second real network
(a phone hotspot, a VPS). *(2026-11-12: now tested between two machines —
see "Two machines, two public networks" below.)* The local lab (default mode) remains the evidence
for cone↔cone, reloads and network-switch healing.

## Two machines, two public networks (2026-11-12)

`just test-pair [--runs=3] [--stun4] [--diag]` — `scripts/test-pair.mjs`.
This machine hosts on the **live site** (`SITE`, default
https://www.lokeshmohanty.in/games/) with the **deployed** room server and
real public STUN; a second machine on a different network (`bhaskara`, over
ssh — `--remote=`/`PAIR_REMOTE` for another) joins by code. The script copies
itself to `~/neon-pair-test` there, drives the remote browser over the ssh
session's stdin/stdout, and kills the remote processes at the end. Not in
`just test`: it needs that ssh access. Per run it asserts join within 30 s,
both ends agreeing on one host, 30 ticks each way at ~30 Hz plus 10 ping/pong
round trips, and reports the selected ICE pair from `getStats` on both ends;
then a guest reload (remote; on failure the page's RETRY is tried), a host
reload (local), and a deliberate guest leave (ALL GAMES) that the host must
see within 5 s. A phase that fails is followed by a fresh party, so later
phases are still tested. Before the runs it classifies both NATs with a node
STUN client and runs a **browserless hole-punch probe** between the machines.

First results (this machine: Airtel mobile CGNAT, 223.181.108.216;
bhaskara: an institute NAT, 14.139.128.10, IPv4 only; 16 runs over the
script's development, the last 3 with the final script):

| | Result |
|---|---|
| this machine's NAT | mapping follows the destination **port**: every server on :3478 (Cloudflare, Nextcloud, Twilio, freeswitch) sees one mapping, :19302 and :443 each get another. Only the :3478 mapping accepts packets from an endpoint it has not sent to; and once this side has sent to the peer first, the NAT opens a new filtered mapping for it and drops the peer's packets to the :3478 one. |
| bhaskara's NAT | endpoint-independent mapping, port-preserving; address-and-port-dependent filtering (this side's packets from an unannounced port never get in). |
| punch probe | through **only** when bhaskara sends first to this machine's :3478 mapping; never via the :19302 mapping, never when this machine sends first. |
| join by code | 15/15 connected in 2.9–5.2 s (default STUN list, or Cloudflare's alone), srflx↔srflx over UDP/IPv4, RTT ~70–100 ms. Works because the host offers and the guest, as ICE *answerer*, starts its checks ~1.2 s before the host has the answer — bhaskara sends first. |
| guest reload | **15/16 failed** with the explicit no-route message at 18.3 s. `--diag` shows why: after the reload the *returning guest* offered, so this machine answered and checked first. Cause (verified 2026-11-12, test-room 6e9 and lab scenario 10): the host, isolated by the reload, re-announced by closing its socket and re-dialling 1 s later; the guest got back inside that gap, and the hub, on the host's return, could name only the guest. The page's RETRY then reconnects in 2.4–3.2 s (the host offers). |
| host reload | 11/11 (from a working party) reconnected in 3.3–4.1 s; the crown passed to the guest every time, both ends agreeing. |
| leave | 11/11: the host dropped the guest in 0.2 s, the guest's token was cleared. |
| `--stun4` | with Cloudflare's :3478 by IPv4 literal: same as above. With Google's :19302 only (`STUN4=stun.l.google.com:19302`), even the first join fails no-route at 17.3 s — on this network only a :3478 STUN server yields a usable candidate. |

So: a real cross-network connection **does** work STUN-only between these two
networks, but only in one ICE direction, and the product did not pick the
direction — which side offered after a reload was an accident of who reached
the room server first. See the multiplayer skill's `cross-network` memory.

**Fixed (2026-11-12, uncommitted, not deployed), two parts.** The re-announce
dials before it hangs up, so the member who stayed always offers (room-server.md,
"Who offers to whom"). And a pair whose first ICE try fails is tried once with
the roles swapped, over the room server or the mesh relay — the answerer
offers — so the direction no longer decides whether a pair connects, only how
long it takes: ~15 s more for the wrong one. Expected on this pair: guest
reloads fast (the Airtel host offers), host reloads ~20 s (bhaskara offers,
fails, Airtel offers back) where they were lucky and fast before. VERIFY with
`just test-pair --runs=3` once deployed. Verified undeployed below.

### Final code across the two networks, undeployed (2026-11-12)

The working tree, not the live site: bhaskara served the repo
(`python3 -m http.server 8010 --bind 127.0.0.1`; its :8000 was taken) and
ran `wrangler dev --port 8787 --ip 127.0.0.1 --var ROOM_PASS_KEY:<random>`
in `worker/`; this machine reached both over `ssh -N -L 8010:127.0.0.1:8010
-L 8788:127.0.0.1:8787 bhaskara` (its own :8787 was busy). Both browsers on
loopback, so `neon.rs` is honoured; real public STUN (DEFAULT_ICE, no
`neon.stun`). The script grew the flags for it:

    just test-pair --site=http://127.0.0.1:8010/ --rs=http://127.0.0.1:8788 \
      --rs-remote=http://127.0.0.1:8787 [--remote-hosts] [--manual=SECS[,remote]]

`--remote-hosts` swaps the roles (both sides now run the same command
driver, role `drive`); each run does two guest reloads; the table reports
who offered the link in use (`off=H/G`), whether it is the role-swapped
retry (`+swap`), and which member has the lower id (the glare rule's
tie-break). Airtel = this machine (offerer-only), bhaskara = the institute NAT.

| run | host → guest | lower id | join | guest reload 1 | guest reload 2 | host reload (crown) | leave |
|---|---|---|---|---|---|---|---|
| A1 | Airtel → bhaskara | guest | 2.2 s | 17.9 s, swap | 17.8 s, swap | 18.5 s, swap (moved) | 0.2 s |
| A2 | Airtel → bhaskara | host | 2.4 s | 2.7 s | 2.4 s | 18.0 s, swap (moved) | 0.2 s |
| A3 | Airtel → bhaskara | host | 2.3 s | 2.1 s | 1.9 s | 17.9 s, swap (moved) | 0.2 s |
| B1 | bhaskara → Airtel | host | 19.7 s, swap | 17.9 s, swap | 17.9 s, swap | 17.7 s, swap (moved) | 0.2 s |
| B2 | bhaskara → Airtel | guest | 20.9 s, swap | 18.1 s, swap | 18.3 s, swap | 1.9 s (kept) | 0.2 s |
| B3 | bhaskara → Airtel | guest | 21.6 s, swap | 18.2 s, swap | 18.3 s, swap | 3.6 s (moved) | 0.2 s |

Every phase of all 6 runs passed (plus 2 earlier A runs while the script was
being built, same pattern): nobody saw a final error, page errors none, every
link srflx↔srflx UDP/IPv4, RTT 60–100 ms, the link in use always offered by
Airtel. The role swap carries every wrong-direction case at ~18 s.

**"The member who stayed offers" does not hold after a reload.** When the
returning member has the *lower id*, it ends up the offerer (A1's guest
reloads; A2/A3 with the host lower were ~2 s). `--diag` (A1): the guest
offered at once on its return; the staying host offered a second later; the
host set its own aside under the glare rule and answered; ICE failed; the
swap linked at ~18 s. The stayer notices it is isolated only *after* the
returner has re-attached, so its re-announce (room-join `rejoinServer` →
hub `announce`, worker/hub.js:322) names the returner to offer, while the
returner's attach named the stayer: both offer, the lower id's stands
(room-join `wire`, the `msg.t === "offer"` branch). Same in B's host reloads
(fast only when the Airtel guest is the lower id). Not fixed here; the swap
makes it a delay, not a failure.

**Manual scan/paste handshake** (`--manual`, bare page + room API,
`createInvite` / `answerInvite` / `acceptAnswer`, codes over ssh):

| invites → answers | reply carried after | result |
|---|---|---|
| Airtel → bhaskara | 3 s, 10 s | linked 2.6 s after the reply |
| Airtel → bhaskara | 25 s (twice) | **failed**: the answerer's own ICE went `disconnected`/`failed` 15.6 s after answering → no-route on its screen; the later `acceptAnswer` links to nothing |
| bhaskara → Airtel | 3 s, 25 s | failed, no-route 16.0 s after answering (wrong direction; this flow has no swap) |

The open watchdog is not the cause (it is not armed there, 6e17 holds): it is
Chrome's own ICE verdict. The lab assumption that a waiting answerer reads
`connected` because the offerer answers its checks is false across these
NATs — the Airtel side's responses leave by another mapping and bhaskara's
filter drops them. So between these networks a manual join works only with
Airtel inviting and the reply back within ~15 s. Path: net.js `_watch`
(`failed` → `_linkFailed`) → `_routeFailed` → `_noRoute`, no `onRouteFailed`
outside room-join.

**Both follow-ups addressed in code, undeployed (2026-11-12, later):**
reload direction — each client classifies its own NAT (net.js
`classifyNat`) and a hard side's offer wins glare, or is offered back
(docs/room-server.md, "Who offers to whom"; lab scenario 10 above). The
manual window is inherent without TURN, so the UI now says so: the reply
screen asks for it back right away, and a failed reply explains and offers
MAKE A NEW REPLY (docs/index.md, Honest gaps). Re-measured below.

### Hard-NAT offer rule across the two networks, undeployed (2026-11-12)

Same setup as above (working tree served from bhaskara, `wrangler dev`,
`ssh -L 8010 -L 8788:…:8787`, real public STUN). `room.natHard` read on
party.html: **Airtel `true`** (0.5 s after hosting), **bhaskara `null`**,
not `false` — see the trap below.

| run | host → guest | lower id | join | guest reload 1 | guest reload 2 | host reload (crown) | leave |
|---|---|---|---|---|---|---|---|
| A1 | Airtel → bhaskara | host | 2.2 s | 1.9 s | 1.8 s | 2.8 s (kept) | 0.3 s |
| A2 | Airtel → bhaskara | guest | 2.1 s | 3.6 s | 1.9 s | 3.0 s (moved) | 0.2 s |
| A3 | Airtel → bhaskara | guest | 2.6 s | 1.9 s | 1.9 s | 3.0 s (moved) | 0.2 s |
| B1 | bhaskara → Airtel | guest | 5.2 s | 3.3 s | 2.9 s | 2.1 s (kept) | 0.2 s |
| B2 | bhaskara → Airtel | host | 10.6 s | 3.0 s | 3.0 s | 1.8 s (kept) | 0.2 s |
| B3 | bhaskara → Airtel | guest | 7.9 s | 3.2 s | 2.9 s | 1.9 s (kept) | 0.2 s |
| B4 (`--diag`) | bhaskara → Airtel | guest | 5.3 s | 3.1 s | 2.8 s | 1.9 s (kept) | 0.2 s |

All 7 runs passed every phase, no page errors, every link srflx↔srflx
UDP/IPv4, and **the link in use was offered by Airtel every time, never
the role-swapped retry** — whatever the ids (A2/A3: guest lower, still
~2 s; the A1–A3 of the run above were ~18 s swaps). B joins pay the
offer-back round trip: `--diag` B4, host bhaskara offered (pc#1, :41),
Airtel's marked offer arrived a second later and was answered and
connected ~1 s after (pc#2, :42). B2's 10.6 s ran without `--diag`, cause
not captured.

**Trap: bhaskara never classifies soft.** Its Chrome has a Tailscale
IPv6 base (`fd7a:…`) with no IPv6 route. STUN over it to both servers
goes unanswered: gathering stays open to ~39.9 s, then two
`icecandidateerror` 701 ("STUN binding request timed out", `[::x]`), then
complete. classifyNat times out at NAT_CLASSIFY_MS (5 s, net.js:76) with
`hard() || null` (net.js:144), and even at completion the error makes it
`null` (net.js:133, `errored` set at net.js:143) — though its IPv4 base
had one mapping from both servers. Harmless here (Airtel's `h.` mark
decides), but a soft side with a dead IPv6 interface (common: Tailscale,
v6-less Wi-Fi) reads "unknown", never "soft". Not fixed here.

**Manual handshake** (`--manual`, bare page + room API) and the real
party.html `#i=` reply screen (joinFlow), driven over the same `drive`
role:

| invites → answers | reply after | result |
|---|---|---|
| Airtel → bhaskara | 5 s | linked 1.4 s after the reply (`--manual`); 0.8 s (party.html) |
| Airtel → bhaskara | 25 s | failed: answerer's no-route 16.5 s after answering; party.html showed "Your reply was not used in time, or your network and theirs cannot connect directly." + MAKE A NEW REPLY at 14.2 s after the reply was on screen |
| bhaskara → Airtel | 5 s | failed: answerer's no-route 16.0 s after answering (wrong direction); party.html showed the same text + button |
| bhaskara → Airtel | 25 s | failed at 16.1 s; party.html text + button at 14.6 s |

The reply screen carries REPLY_NOW ("Do it right away: between some
networks a reply only works for about 15 seconds.") from the start. The
`--manual` check "answerer still waiting, no verdict" fails by design
past ~15 s on this pair (it was written for loopback).
