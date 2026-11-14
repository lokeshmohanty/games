#!/usr/bin/env bash
# Build dist/tic-tac-toe.js — type-check, then one minified classic IIFE — from
# src/ and the TypeScript adapter (../../adapters/ts). Node comes from Nix; npm
# runs in this folder only (the repo root has no package.json by design), and
# installs the exact versions in package-lock.json.
set -euo pipefail
cd "$(dirname "$0")"
nix shell nixpkgs#nodejs_24 -c bash -euo pipefail -c '
	npm ci --no-audit --no-fund
	npm run build
'
f=dist/tic-tac-toe.js
echo "$f: $(wc -c <"$f") bytes, $(gzip -9c "$f" | wc -c) gzipped"
