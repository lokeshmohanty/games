# Justfile — the commands this project actually uses.
#
# Everything here is a thin wrapper over something already documented in
# `docs/index.md`; nothing new is invented. Since 2026-11-15 the shell is one
# page built with Vite and pnpm (docs/spa.md): `just run` is Vite's dev server,
# `just build` writes dist/ (what is deployed), and the browser suites serve
# dist/ (scripts/serve.mjs), so `just test` builds first.
#
#   just            list the recipes
#   just run        serve the arcade at http://127.0.0.1:8000
#   just test       every suite

port := "8000"
# pnpm, from the system or through Nix (no global install needed on NixOS).
pnpm := if `command -v pnpm || true` != "" { "pnpm" } else { "nix shell nixpkgs#pnpm nixpkgs#nodejs_24 -c pnpm" }

# List the recipes.
default:
    @just --list --unsorted

# Why a server: the shell is built by Vite (docs/spa.md), and the camera
# scanner and the service worker both need a *secure context*. `127.0.0.1`
# counts as secure, `http://<lan-ip>` does not — see `serve-lan` for what that
# means on a phone.
#
# (Note for editors: `just --list` shows only the LAST comment line above a
# recipe, so the one-line summary goes immediately before it and anything
# longer goes above a blank line.)

# Serve the arcade at http://127.0.0.1:{{port}} (Vite's dev server; edits reload).
run: install
    {{pnpm}} dev --host 127.0.0.1 --port {{port}}

# Install the shell's dependencies (pnpm-lock.yaml, exactly).
install:
    {{pnpm}} install --frozen-lockfile

# Build the site into dist/: type check, vite build, then scripts/assemble.mjs.
build: install
    {{pnpm}} build

# Installing and offline will work over the LAN; **the SCAN REPLY camera will
# not**, because a plain http:// LAN address is not a secure context and the
# browser refuses getUserMedia. Use PASTE for the reply code when testing so.

# Serve on every interface, so a phone on the same wifi can reach it.
serve-lan: install
    @ip=$(hostname -I 2>/dev/null | awk '{print $1}'); \
      echo "arcade → http://$ip:{{port}}  (camera scanning will not work; use PASTE)"
    {{pnpm}} dev --host 0.0.0.0 --port {{port}}

# Every suite, in the order they get slower.
test: check-bindings check-colours community build test-stats test-submission test-codec test-hub test-worker-do test-plumbing test-rules test-room test-party test-scan test-pwa test-bots test-rules-screen test-devkit test-protocol test-managed test-conformance test-webapp test-theme test-portal

# No browser needed — the signalling codec round-trip.
test-codec:
    node scripts/test-codec.mjs

# The room hub: codes, claims, rate limits, TTLs — no Cloudflare, no browser.
test-hub:
    node scripts/test-hub.mjs

# The Durable Object shell, evicted and woken by hand — fake state, no Cloudflare.
test-worker-do:
    node scripts/test-worker-do.mjs

# Not part of `test`: it needs wrangler, which on NixOS means `nix shell
# nixpkgs#wrangler` (a download the first time, then seconds to start) plus
# two free ports, and it waits out real 30s join deadlines. It starts and
# stops `wrangler dev` itself, and skips with a message when it cannot.

# The real room server under wrangler dev, with real browsers.
test-worker:
    node scripts/test-worker.mjs

# Not part of `test` either: it builds NAT routers out of network namespaces,
# so it runs inside `nix shell` (iproute2, nftables, conntrack-tools — NixOS's
# own `ip` will not do — and wrangler) under `unshare -rn`, which the wrapper
# script does. No sudo. About 4 minutes: several scenarios wait out real ICE
# failures and blackouts. See docs/network-testing.md.

# Symmetric NAT, network switches, lossy links, a blocked room server.
test-nat *args:
    scripts/test-nat.sh {{args}}

# Not part of `test`: it needs a *deployed* room server (wrangler deploy, or
# `wrangler deploy --temporary`) and waits out real idle periods so Cloudflare
# hibernates the room objects. Sections: --only=ping,oracle,flows,hib,alarm,gate
# (alarm takes ~16 min and is opt-in; gate spends this IP's guesses for 5 min,
# so it runs last). Hibernation is proven only when the deployment has the
# ROOM_DEBUG var (`--var ROOM_DEBUG:1`) — never on the real one. See
# docs/network-testing.md.

# The deployed room server on real Cloudflare: `just test-live https://….workers.dev`.
test-live url *args:
    RS_URL={{url}} node scripts/test-live.mjs {{args}}

# The NAT lab in front of the real internet (slirp4netns), against a deployment.
test-nat-live url *args:
    RS_URL={{url}} scripts/test-nat.sh {{args}}

# Not part of `test`: needs ssh access (keys, BatchMode) to a second machine on
# a DIFFERENT public network — `bhaskara` by default, PAIR_REMOTE or
# --remote=<host> otherwise — with node, a system Chrome and Playwright there.
# Tests the site and room server AS DEPLOYED (SITE=… overrides the site).
# Copies only scripts/test-pair.mjs to ~/neon-pair-test on the remote and kills
# its processes at the end. Flags: --runs=N (3), --stun4, --diag, --no-punch,
# --no-classify, --remote-hosts (the remote hosts, this machine joins),
# --site=URL / --rs=URL (both sides; loopback URLs forwarded over ssh -L test
# the working tree without a deploy), --site-remote / --rs-remote (the same
# servers as the remote reaches them), --manual=SECS[,remote] (scan/paste
# handshake, reply carried after SECS), --browser=firefox / --remote-browser=firefox
# (Playwright's Firefox instead of the system Chrome on that side).
# See docs/network-testing.md.

# Two real machines, two real networks: join, traffic, reloads, leave; NAT classification.
test-pair *args:
    node scripts/test-pair.mjs {{args}}

# Sealed channels, commit-reveal and the round clock, over real routing.
test-plumbing:
    node scripts/test-plumbing.mjs

# Join by code, reconnect, fallback — the real client against the in-page mock.
test-room:
    node scripts/test-room.mjs

# The games whose rules are testable without a document.
test-rules:
    node scripts/test-neon-bid.mjs
    node scripts/test-undercover.mjs
    node scripts/test-neon-fission.mjs

# Three real browser peers: recruiting, teams, game switching, succession.
test-party:
    node scripts/test-party.mjs

# SCAN REPLY against a fake camera, at real code density.
test-scan:
    node scripts/test-scan.mjs

# Manifest, icons, offline, and Chrome's own installability verdict.
test-pwa:
    node scripts/test-pwa.mjs

# SDK v2: three peers play a fixture that uses every service; every message is checked against sdk/v2/protocol.json.
test-protocol:
    node scripts/test-protocol.mjs

# SDK v2 managed state: views, refusals, end card, rematch, handover to the heir, a ticking game.
test-managed:
    node scripts/test-managed.mjs

# SDK v2 adapters: Tic Tac Toe in every language gives the reference's answers, call for call.
test-conformance *lanes: pyodide
    node scripts/test-conformance.mjs {{lanes}}
    cd sdk/v2/adapters/go && go test ./...

# Every game playable by one person, and the mobile layouts at 390x844.
test-bots:
    node scripts/test-bots.mjs

# A game's rules: shown on its first open, once; GOT IT; "?"; none without rules; 390x844 in every theme; offline.
test-rules-screen:
    node scripts/test-rules-screen.mjs

# Record a portal preview gif: `just preview connect4`, or `just preview all`.
preview game:
    scripts/make-preview.sh {{game}}

# Rebuild the app icons from assets/icon.svg. Only after editing the SVG.
icons:
    node scripts/make-icons.mjs

# sdk/v2/bindings/ is generated from sdk/v2/protocol.json: rewrite it after
# changing the protocol (scripts/gen-bindings.mjs). `just test` checks it.

# Regenerate the SDK v2 bindings (TS, Rust, Go, Python) from protocol.json.
bindings:
    node scripts/gen-bindings.mjs

# Fail if the SDK v2 bindings do not match protocol.json.
check-bindings:
    node scripts/gen-bindings.mjs --check

# Gather every game.json into lib/catalog.js (generated; committed so the
# site needs no build step). `just catalog --check` fails if it is stale.
catalog *args:
    node scripts/build-catalog.mjs {{args}}

# Fetch every registered outside repo at its pinned commit into community/
# (git-ignored) and write community/catalog.js + precache.js. A clone at
# ../<repo> that has the pinned commit is used instead of GitHub.
community:
    node scripts/fetch-community.mjs

# The game dev kit as an outside author uses it: the SDK examples served by
# sdk/dev-server.mjs, loaded with ./?dev=, played to the end; and the dev
# kit's old address (sdk/v1/dev-server.mjs, a build-time copy until 2027-02-15).
test-devkit:
    node scripts/test-devkit.mjs

# The Python runtime for Python games and web apps' servers (sdk/pyodide/,
# git-ignored, ~18 MB): fetched once, checked against its pinned hashes.
pyodide:
    node scripts/vendor-pyodide.mjs

# An ordinary web app and its FastAPI server, run unchanged by two peers
# (scripts/fixtures/webapp/): requests, shared address, images, no network.
test-webapp: pyodide
    node scripts/test-webapp.mjs

# Everything the platform checks before it lists a game (the registry PR
# check runs this): `just validate-game path/to/game`, `--static` for no browser.
validate-game *args:
    node scripts/validate-game.mjs {{args}}

# lib/stats.js with no browser: outcomes per kind, counting once, rematches.
test-stats:
    node scripts/test-stats.mjs

# The account API (worker/api/) under wrangler dev with a throwaway local D1,
# against a fake GitHub and Google. Not part of `test`: it needs wrangler
# (`nix shell nixpkgs#wrangler` on NixOS), and skips with a message without it.
test-accounts:
    node scripts/test-accounts.mjs

# The account layer in real browsers at 390x844 against wrangler dev: sign-in,
# profile, favourites on two devices, friends in a party, an invite, a ranked
# game, leaderboards, groups, feedback, deleting the account. Needs wrangler.
test-social:
    node scripts/test-social.mjs

# No colour named outside lib/theme.css (pages, styles, SDK, games). Pass
# other repos to check too: `just check-colours ../web-games`.
check-colours *dirs:
    node scripts/check-colours.mjs {{dirs}}

# Themes at 390x844: the default follows the system, the picker switches and
# remembers, a running game's frame (and its canvas) follows the page.
test-theme:
    node scripts/test-theme.mjs

# The portal's search, the bar and tabs on every page, Contributors, and the
# add-your-game guide (CONTRIBUTING.md rendered), at 390x844.
test-portal:
    node scripts/test-portal.mjs

# Not part of `test`: phone-speed numbers (docs/perf.md) — 390x844, 4x CPU, a
# throttling proxy for Slow 4G; portal, PLAY WITH BOTS, leaderboard, cold and
# warm. Takes a few minutes; `--runs 1` for a quick look.

# Phone-speed baseline: FCP, LCP, time to a bots game's frame (docs/perf.md).
perf *args:
    node scripts/perf.mjs {{args}}

# GitHub's page for proposing a repo's games (new) or a newer commit (pinned
# and moved), filled in as far as GitHub allows: `just propose owner/repo`.
propose repo *games:
    node scripts/propose.mjs {{repo}} {{games}}

# The rules a contributor's pull request is judged by (check-submission.mjs),
# with no network or git.
test-submission:
    node scripts/test-submission.mjs
