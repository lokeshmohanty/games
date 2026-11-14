#!/usr/bin/env bash
# Build the rules (tic-tac-toe.c) into pkg/: rules.wasm, its loader rules.js,
# and the adapter's glue arcade-c.js, vendored from sdk/v2/adapters/c (the
# shell inlines only files inside the game's folder). Needs Nix (Emscripten
# 6.0.9 from nixpkgs). pkg/ is committed: the arcade's CI never builds
# contributor code.
set -euo pipefail
cd "$(dirname "$0")"
../../adapters/c/emcc-game.sh pkg tic-tac-toe.c
