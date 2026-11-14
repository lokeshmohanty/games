#!/usr/bin/env bash
# Vendor the Python adapter into this folder and check the game under CPython.
# Nothing is compiled: the platform ships Pyodide (sdk/v1/pyodide/, `just
# pyodide`) and the frame asks the shell for it (`runtime.file`). The shell
# inlines only scripts inside the game's folder, so the adapter's files are
# copied here, and the copies are committed.
set -euo pipefail
cd "$(dirname "$0")"
adapter=../../adapters/python
cp "$adapter/arcade-python.js" "$adapter/arcade.py" .
# Pyodide 314 is CPython 3.14: check the game there, natively. Run as a
# script, arcade.run plays two bots through the adapter's dispatch to a result.
out=$(nix shell nixpkgs#python314 -c python3 -B game.py)
echo "$out" | tail -n 2
grep -q "'ranking'" <<<"$out" || { echo "build.sh: the bots did not finish a match" >&2; exit 1; }
ls -l arcade-python.js arcade.py game.py
