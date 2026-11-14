#!/usr/bin/env bash
# Build the rules (src/lib.rs) into pkg/: the module game.json names and the
# wasm-bindgen glue index.html loads. Needs Nix; see sdk/v2/adapters/rust.
set -euo pipefail
cd "$(dirname "$0")"
../../adapters/rust/build.sh .
