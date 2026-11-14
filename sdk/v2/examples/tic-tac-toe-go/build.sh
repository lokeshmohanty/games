#!/usr/bin/env bash
# Build the rules (main.go) into tic-tac-toe.wasm with TinyGo, and vendor the
# two scripts the page needs next to it: TinyGo's wasm_exec.js (the Go
# runtime's JavaScript half, from the same TinyGo, so the two always match)
# and the adapter's arcade-go.js. Needs Nix. The outputs are committed.
set -euo pipefail
cd "$(dirname "$0")"
nix shell nixpkgs#tinygo -c bash -euo pipefail -c '
	tinygo version
	tinygo build -o tic-tac-toe.wasm -target wasm -scheduler=none -no-debug .
	install -m 644 "$(tinygo env TINYGOROOT)/targets/wasm_exec.js" wasm_exec.js
'
install -m 644 ../../adapters/go/arcade-go.js arcade-go.js
ls -l tic-tac-toe.wasm wasm_exec.js arcade-go.js
echo "gzip: $(gzip -9c tic-tac-toe.wasm | wc -c) bytes"
