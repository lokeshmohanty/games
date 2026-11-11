#!/usr/bin/env bash
# scripts/test-nat.sh — run scripts/test-nat.mjs inside its own user+network
# namespace, with the tools it needs.
#
# Why a wrapper rather than plain `node`: the suite builds NAT routers out of
# network namespaces, which needs root — but only root *of a user namespace it
# owns* (`unshare -rn`), so nothing touches the host's real network and no
# sudo is involved. The network tools come from nixpkgs because NixOS's
# system `ip` is not usable here, and the room server is the real worker run
# by nixpkgs' wrangler (npx's workerd does not link on NixOS).
#
#   scripts/test-nat.sh [--only=1,3] [--verbose]
#
# Live mode — RS_URL=https://<deployed worker> scripts/test-nat.sh (or
# `just test-nat-live <url>`): no wrangler dev; slirp4netns gives the lab's
# "internet" namespace a way out to the host's real network (user-mode NAT,
# still no privilege), so the lab NATs sit in front of the real internet,
# real Cloudflare and the real public STUN servers. A headless Chrome on the
# host's own network is started too and reached by the lab over CDP via
# slirp's host-loopback alias (10.0.2.2), for scenario 9.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
pkgs=(nixpkgs#iproute2 nixpkgs#nftables nixpkgs#conntrack-tools nixpkgs#wrangler)
if [ -z "${RS_URL:-}" ]; then
	exec nix shell "${pkgs[@]}" -c unshare -rn node "$here/test-nat.mjs" "$@"
fi

chrome="${CHROME:-$(command -v google-chrome-stable || command -v chromium || echo /run/current-system/sw/bin/google-chrome-stable)}"
profile="$(mktemp -d)"
port=$((20000 + RANDOM % 20000))
"$chrome" --headless=new --no-sandbox --remote-debugging-address=127.0.0.1 --remote-debugging-port="$port" \
	--user-data-dir="$profile" about:blank >/dev/null 2>&1 &
host_chrome=$!
trap 'kill $host_chrome 2>/dev/null; wait $host_chrome 2>/dev/null; rm -rf "$profile"' EXIT
export HOST_CDP="http://10.0.2.2:$port"

nix shell "${pkgs[@]}" nixpkgs#slirp4netns -c bash -c '
	unshare -rn node "$0" "$@" &
	pid=$!
	self=$(readlink /proc/self/ns/net)
	for _ in $(seq 100); do
		[ "$(readlink /proc/$pid/ns/net 2>/dev/null)" != "$self" ] && break
		sleep 0.1
	done
	slirp4netns --configure --enable-ipv6 --mtu=65520 --userns-path=/proc/$pid/ns/user --netns-type=path /proc/$pid/ns/net tap0 >/dev/null &
	slirp=$!
	rc=0; wait $pid || rc=$?
	kill $slirp 2>/dev/null || true
	exit $rc
' "$here/test-nat.mjs" "$@"
