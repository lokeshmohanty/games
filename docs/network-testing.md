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
  198.51.100.1 on br0:  STUN (udp 3478, a 40-line binding responder in the
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
  `localStorage["neon.stun"] = "198.51.100.1:3478"`. (The room server is not
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
| 3 | both symmetric | code join and classic join both fail explicitly, with the *network* named, RETRY offered, and the verdict not later replaced by "nobody answered"; host not left with a phantom member | fails at 15.5 s (ICE's own verdict) |
| 4 | symmetric vs cone; then full cone + two symmetric | the first fails explicitly; in the second all three join, the symmetric pair has no direct link, messages between them arrive relayed through the third, and the doomed pair raises no error on a working party | 15.5 s; joins 0.3 s |
| 5 | network switch and blackouts on cone NATs | conntrack flush is invisible; 4 s and 8 s blackouts keep the link (`DISCONNECT_GRACE_MS`); blackouts that outlast the link heal; a guest's and then the host's public address changing heals to one host with links back | links drop ~9–10 s in; healed 0.5–1.5 s later (10.5 s after a switch) |
| 6 | three cone NATs, `netem delay 200ms 50ms loss 10%` on every WAN | code, both joins, messages, and a reload all inside the 30 s deadline | joins ~7 s; reload ~8 s |
| 7 | one router drops the room server's port | a code join says "Could not reach the room server" with RETRY; that client still hosts classically (no code) and the invite/reply connects it | 8.1 s (the dial timeout) |
| 8 | three cone NATs, one switches network | only the mover re-announces; it is back in the full mesh, the crown never moves, nobody sees an error | 10.9 s |

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
  vary (port-block allocation, mapping timeouts, hairpinning) and none is
  modelled. Mobile data on 2026-08-10 is still the only field observation.
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
  wrong secret) and `oracle`'s dials spend the same per-IP budget. Results
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
(a phone hotspot, a VPS). The local lab (default mode) remains the evidence
for cone↔cone, reloads and network-switch healing.
