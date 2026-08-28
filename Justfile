# Justfile — the commands this project actually uses.
#
# Everything here is a thin wrapper over something already documented in
# `docs/index.md`; nothing new is invented, and nothing here is required. The
# repo has no build step and no dependencies, so `just run` is a static file
# server and that is genuinely all it needs to be.
#
#   just            list the recipes
#   just run        serve the arcade at http://127.0.0.1:8000
#   just test       every suite

port := "8000"

# List the recipes.
default:
    @just --list --unsorted

# Why a server at all, when every page also works by double-clicking the HTML:
# the camera scanner and the service worker both need a *secure context*, and
# `file://` is not one. `127.0.0.1` counts as secure, `http://<lan-ip>` does
# not — see `serve-lan` for what that means on a phone.
#
# (Note for editors: `just --list` shows only the LAST comment line above a
# recipe, so the one-line summary goes immediately before it and anything
# longer goes above a blank line.)

# Serve the arcade at http://127.0.0.1:{{port}} .
run:
    @echo "arcade → http://127.0.0.1:{{port}}   (ctrl-c to stop)"
    python3 -m http.server {{port}} --bind 127.0.0.1

# Installing and offline will work over the LAN; **the SCAN REPLY camera will
# not**, because a plain http:// LAN address is not a secure context and the
# browser refuses getUserMedia. Use PASTE for the reply code when testing so.

# Serve on every interface, so a phone on the same wifi can reach it.
serve-lan:
    @ip=$(hostname -I 2>/dev/null | awk '{print $1}'); \
      echo "arcade → http://$ip:{{port}}  (camera scanning will not work; use PASTE)"
    python3 -m http.server {{port}}

# Every suite, in the order they get slower.
test: test-codec test-plumbing test-rules test-party test-scan test-pwa test-bots

# No browser needed — the signalling codec round-trip.
test-codec:
    node scripts/test-codec.mjs

# Sealed channels, commit-reveal and the round clock, over real routing.
test-plumbing:
    node scripts/test-plumbing.mjs

# The three games whose rules are testable without a document.
test-rules:
    node scripts/test-onitama.mjs
    node scripts/test-light-cycles.mjs
    node scripts/test-battleship.mjs

# Three real browser peers: recruiting, teams, game switching, succession.
test-party:
    node scripts/test-party.mjs

# SCAN REPLY against a fake camera, at real code density.
test-scan:
    node scripts/test-scan.mjs

# Manifest, icons, offline, and Chrome's own installability verdict.
test-pwa:
    node scripts/test-pwa.mjs

# Every game playable by one person, and the mobile layouts at 390x844.
test-bots:
    node scripts/test-bots.mjs

# Record a portal preview gif: `just preview onitama`, or `just preview all`.
preview game:
    scripts/make-preview.sh {{game}}

# Rebuild the app icons from assets/icon.svg. Only after editing the SVG.
icons:
    node scripts/make-icons.mjs

# Catches the one mistake sw.js cannot warn about: a page or module added to the
# repo but not to `SHELL`, which simply is not there offline.

# Check every page and module is in the sw.js precache list.
check-precache:
    @node -e ' \
      const fs = require("fs"); \
      const sw = fs.readFileSync("sw.js", "utf8"); \
      const listed = new Set([...sw.matchAll(/"\.\/([^"]+)"/g)].map((m) => m[1])); \
      const onDisk = [ \
        ...fs.readdirSync(".").filter((f) => f.endsWith(".html")), \
        ...fs.readdirSync("lib").filter((f) => /\.(js|css)$/.test(f)).map((f) => "lib/" + f), \
        ...fs.readdirSync("games").filter((f) => f.endsWith(".js")).map((f) => "games/" + f), \
      ]; \
      const missing = onDisk.filter((f) => !listed.has(f)); \
      if (missing.length) { console.error("not precached by sw.js:\n  " + missing.join("\n  ")); process.exit(1); } \
      console.log(`all ${onDisk.length} pages and modules are in the sw.js precache`); \
    '
