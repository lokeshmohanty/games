#!/usr/bin/env bash
# sdk/v2/adapters/rust/build.sh — build a Rust game (a crate that uses this
# adapter) into the files the arcade runs:
#
#   <crate>/pkg/<name>_bg.wasm   the module: game.json "wasm"
#   <crate>/pkg/<name>.js        wasm-bindgen's glue: a <script src> in index.html
#
#   sdk/v2/adapters/rust/build.sh path/to/crate
#
# Needs only Nix: rustc, cargo, lld and the wasm-bindgen CLI come from
# nixpkgs. The CLI must be the exact version of the wasm-bindgen crate in the
# game's Cargo.lock (this adapter pins it); a mismatch stops the build.
set -euo pipefail
crate=$(cd "${1:?usage: build.sh <crate folder>}" && pwd)
nix shell nixpkgs#rustc nixpkgs#cargo nixpkgs#lld nixpkgs#wasm-bindgen-cli -c bash -euo pipefail -c '
	cd "$1"
	# The built module: the only .wasm among the artifacts cargo reports.
	wasm=$(cargo build --release --target wasm32-unknown-unknown --message-format=json-render-diagnostics |
		grep -o "\"[^\"]*\.wasm\"" | tail -1 | tr -d "\"")
	[ -n "$wasm" ] || { echo "build.sh: cargo built no .wasm (is the crate a cdylib?)" >&2; exit 1; }
	want=$(grep -A1 "^name = \"wasm-bindgen\"$" Cargo.lock | sed -n "s/^version = \"\(.*\)\"$/\1/p")
	have=$(wasm-bindgen --version | cut -d" " -f2)
	[ "$want" = "$have" ] || { echo "build.sh: Cargo.lock has wasm-bindgen $want, the CLI is $have; pin the crate to =$have" >&2; exit 1; }
	wasm-bindgen --target no-modules --out-dir pkg --no-typescript "$wasm"
' _ "$crate"

# wasm-bindgen's no-modules glue works out where it was loaded from, to fetch
# its .wasm itself: `new URL(document.currentScript.src, location.href)`. The
# arcade inlines every script (src "") into an about:srcdoc frame, where that
# throws on load. The module arrives in `init` instead (`arcade.wasm`), so
# skip the lookup when src is empty.
for glue in "$crate"/pkg/*.js; do
	find='document.currentScript !== null) {'
	grep -qF 'document.currentScript.src) {' "$glue" && continue # already patched
	grep -qF "$find" "$glue" || { echo "build.sh: $glue changed shape; re-check the currentScript patch" >&2; exit 1; }
	sed -i 's/document\.currentScript !== null) {/document.currentScript !== null \&\& document.currentScript.src) {/' "$glue"
done
ls -l "$crate"/pkg
