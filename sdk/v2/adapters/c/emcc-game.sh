#!/usr/bin/env bash
# emcc-game.sh — build a C/C++ managed game (sdk/v2/adapters/c) for the arcade.
#
#   emcc-game.sh <out-dir> <source.c|.cc…> [-- extra emcc flags]
#
# Writes <out-dir>/rules.wasm (game.json "wasm") and <out-dir>/rules.js (its
# loader, defining ArcadeC), and copies the adapter's glue next to them as
# <out-dir>/arcade-c.js. The page names rules.js, then arcade-c.js, then its
# draw code. Emscripten comes from Nix; its cache (the libc it builds once,
# ~40 s) goes to $EM_CACHE, default ~/.cache/arcade-emscripten.
#
# Why these flags, so no author has to find out again:
# - MODULARIZE + EXPORT_NAME=ArcadeC, a classic script (not EXPORT_ES6): the
#   shell inlines every script into an about:srcdoc frame, where import,
#   import.meta and a script's own URL do not exist.
# - The module comes as bytes in `init` (arcade-c.js passes wasmBinary), so the
#   loader's fetch path is never taken. SINGLE_FILE would also work but skips
#   the platform's prefetch and grows the page by a third (base64).
# - ENVIRONMENT=web, FILESYSTEM=0, MALLOC=emmalloc, -Oz, --closure 1: small
#   (closure takes the loader from 7 KB to under 3 KB; -flto made it bigger).
# - DYNAMIC_EXECUTION=0: no eval / new Function (the frame's CSP has no
#   'unsafe-eval').
# - INITIAL_MEMORY 1 MB, growing as needed: not the default 16 MB per frame.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
[ $# -ge 2 ] || { echo "usage: emcc-game.sh <out-dir> <sources…> [-- emcc flags]" >&2; exit 2; }
out="$1"; shift
srcs=(); extra=()
while [ $# -gt 0 ]; do
	if [ "$1" = "--" ]; then shift; extra=("$@"); break; fi
	srcs+=("$1"); shift
done
mkdir -p "$out"
export EM_CACHE="${EM_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/arcade-emscripten}"
mkdir -p "$EM_CACHE"

flags=(
	-Oz --closure 1 -I"$here"
	-sMODULARIZE=1 -sEXPORT_NAME=ArcadeC -sENVIRONMENT=web
	-sFILESYSTEM=0 -sMALLOC=emmalloc -sDYNAMIC_EXECUTION=0 -sTEXTDECODER=2
	-sINITIAL_MEMORY=1MB -sALLOW_MEMORY_GROWTH=1
	-sEXPORTED_FUNCTIONS=_dispatch,_malloc,_free
	-sEXPORTED_RUNTIME_METHODS=UTF8ToString,stringToUTF8,lengthBytesUTF8
	-sINCOMING_MODULE_JS_API=wasmBinary,print,printErr
	--no-entry -Wno-version-check
)
nix shell nixpkgs#emscripten -c emcc "${flags[@]}" "${srcs[@]}" "${extra[@]}" -o "$out/rules.js"

# The loader must stay one classic script that never needs its own URL.
# (Emscripten 6.0.9 guards its `new URL(".", currentScript.src)` with a
# try, so nothing needs patching; this fails loudly if a later one does not.)
js="$out/rules.js"
if grep -qE 'import\.meta|\bimport\(' "$js"; then
	echo "emcc-game.sh: $js uses import/import.meta — the arcade inlines it as a classic script" >&2; exit 1
fi
if grep -q 'currentScript' "$js" && ! grep -qE 'try\{[A-Za-z_$]+=\(?new URL\("\.",_scriptName\)' "$js"; then
	echo "emcc-game.sh: $js reads its own script URL outside a try; check it loads inlined in a srcdoc frame" >&2; exit 1
fi
cp "$here/arcade-c.js" "$out/arcade-c.js"
ls -l "$out"
