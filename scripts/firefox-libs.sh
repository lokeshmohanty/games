#!/usr/bin/env bash
# scripts/firefox-libs.sh — the libraries Playwright's own Firefox needs on
# NixOS, as an LD_LIBRARY_PATH (docs/development.md "Firefox"):
#
#   npx playwright install firefox     # once (node_modules/.bin/playwright)
#   LD_LIBRARY_PATH=$(scripts/firefox-libs.sh) node scripts/test-theme.mjs
#
# Elsewhere the system has them already and this is not needed.
set -euo pipefail
libs="gtk3^out glib^out dbus-glib^out dbus^lib xorg.libX11^out xorg.libXcomposite^out xorg.libXdamage^out
xorg.libXext^out xorg.libXfixes^out xorg.libXrandr^out xorg.libXrender^out xorg.libxcb^out xorg.libXtst^out
xorg.libXi^out xorg.libXcursor^out alsa-lib^out pango^out cairo^out gdk-pixbuf^out atk^out freetype^out
fontconfig^lib libxkbcommon^out mesa^out libdrm^out stdenv.cc.cc^lib zlib^out libGL^out libpulseaudio^out
harfbuzz^out at-spi2-atk^out at-spi2-core^out libffi^out nss^out nspr^out"
args=()
for l in $libs; do args+=("nixpkgs#$l"); done
nix build --no-link --print-out-paths "${args[@]}" | while read -r p; do [ -d "$p/lib" ] && printf '%s/lib:' "$p"; done | sed 's/:$//'
