#!/usr/bin/env bash
# Build the game's WebAssembly module and its wasm-bindgen glue into pkg/.
# Needs Nix; the wasm-bindgen CLI must match the crate's pinned version
# (Cargo.toml), so both come from the same nixpkgs here.
set -euo pipefail
cd "$(dirname "$0")"
nix shell nixpkgs#rustc nixpkgs#cargo nixpkgs#lld nixpkgs#wasm-bindgen-cli -c bash -euo pipefail -c '
	cargo build --release --target wasm32-unknown-unknown
	wasm-bindgen --target no-modules --out-dir pkg --no-typescript \
		target/wasm32-unknown-unknown/release/tic_tac_toe_rust.wasm
'
# The glue works out where it was loaded from, to fetch its .wasm itself:
# `new URL(document.currentScript.src, location.href)`. In the arcade the
# script is inlined (src "") into an about:srcdoc frame, where that throws.
# The module arrives in `init` instead, so skip the lookup when src is empty.
glue=pkg/tic_tac_toe_rust.js
find='document.currentScript !== null) {'
grep -qF "$find" "$glue" || { echo "build.sh: the wasm-bindgen glue changed; re-check the currentScript patch" >&2; exit 1; }
sed -i 's/document\.currentScript !== null) {/document.currentScript !== null \&\& document.currentScript.src) {/' "$glue"
ls -l pkg
