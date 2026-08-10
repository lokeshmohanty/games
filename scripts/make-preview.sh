#!/usr/bin/env bash
# make-preview.sh — regenerate a game's portal preview gif, end to end.
#
#   scripts/make-preview.sh connect4
#   scripts/make-preview.sh all --width 600
#
# Drives the game in a real browser (scripts/preview.mjs), then converts the
# recording to assets/<game>.gif, which index.html already references. No human
# has to play the game and nothing takes over the screen — the browser runs
# headless, so this is safe to run while you work.
#
# Conversion goes through the `screen-rec` CLI (from the nix harness) so gif
# encoding settings stay in one place; plain ffmpeg is used if it is absent.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Ask the recorder which games it can drive rather than keeping a second list
# here: a new game should be registered in exactly one place, and a duplicate
# list is one that eventually disagrees.
read -r -a GAMES <<< "$(node "$ROOT/scripts/preview.mjs" --list)"

# Per-game conversion profile "width fps quality". The Neon Survival games are
# constant motion over a dark field, which defeats gif inter-frame compression —
# they need a smaller frame and fewer colours to stay under ~1MB. Flags override.
profile_for() {
  case "$1" in
    neon-survival|neon-survival-mp) echo "480 10 low" ;;
    # Constant glow and a moving knot defeat inter-frame compression the same
    # way the survival games do, so it gets the smaller frame too.
    tug-of-war) echo "480 12 low" ;;
    *) echo "600 12 medium" ;;
  esac
}

WIDTH=""
FPS=""
QUALITY=""
SECONDS_ARG=""
# Seconds to drop off the end. The recorder now stops as soon as the player
# dies, so the default is 0; use this when a run still ends on something you
# don't want in the loop.
TRIM_END=0
targets=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --width) WIDTH="$2"; shift 2 ;;
    --fps) FPS="$2"; shift 2 ;;
    --quality) QUALITY="$2"; shift 2 ;;
    --seconds) SECONDS_ARG="$2"; shift 2 ;;
    --trim-end) TRIM_END="$2"; shift 2 ;;
    -h|--help)
      printf 'usage: make-preview.sh <game|all> [--width N] [--fps N] [--quality low|medium|high] [--seconds N] [--trim-end N]\n'
      printf '  --trim-end N  drop the last N seconds (e.g. a game-over screen you do not want looping)\n'
      printf 'games: %s\n' "${GAMES[*]}"
      printf 'defaults per game: %s\n' "$(for g in "${GAMES[@]}"; do printf '%s=(%s) ' "$g" "$(profile_for "$g")"; done)"
      exit 0 ;;
    all) targets=("${GAMES[@]}"); shift ;;
    -*) printf 'error: unknown flag %s\n' "$1"; exit 2 ;;
    *) targets+=("$1"); shift ;;
  esac
done

[ "${#targets[@]}" -gt 0 ] || { printf 'error: name a game (or `all`)\ngames: %s\n' "${GAMES[*]}"; exit 2; }

for game in "${targets[@]}"; do
  case " ${GAMES[*]} " in *" $game "*) ;; *) printf 'error: unknown game %s\nvalid: %s\n' "$game" "${GAMES[*]}"; exit 2 ;; esac

  read -r p_width p_fps p_quality <<<"$(profile_for "$game")"
  width="${WIDTH:-$p_width}"
  fps="${FPS:-$p_fps}"
  quality="${QUALITY:-$p_quality}"

  printf '== %s (%spx, %sfps, %s) ==\n' "$game" "$width" "$fps" "$quality" >&2
  args=("$ROOT/scripts/preview.mjs" "$game")
  [ -n "$SECONDS_ARG" ] && args+=(--seconds "$SECONDS_ARG")

  # preview.mjs prints video=/start=/duration= on stdout; diagnostics go to stderr.
  out="$(node "${args[@]}")" || { printf 'error: recording %s failed\n' "$game"; exit 1; }
  video="$(sed -n 's/^video=//p' <<<"$out")"
  start="$(sed -n 's/^start=//p' <<<"$out")"
  played="$(sed -n 's/^duration=//p' <<<"$out")"
  [ -n "$video" ] && [ -f "$video" ] || { printf 'error: %s produced no video\n' "$game"; exit 1; }

  # --trim-end shortens the clip from the end; refuse to trim it out of existence.
  keep=()
  if awk -v t="$TRIM_END" 'BEGIN{exit !(t>0)}'; then
    dur="$(awk -v p="$played" -v t="$TRIM_END" 'BEGIN{printf "%.1f", p-t}')"
    if awk -v d="$dur" 'BEGIN{exit !(d<1)}'; then
      printf 'error: --trim-end %s leaves only %ss of a %ss clip\n' "$TRIM_END" "$dur" "$played"
      exit 2
    fi
    keep=(--duration "$dur")
    printf '   trimming last %ss (%ss -> %ss)\n' "$TRIM_END" "$played" "$dur" >&2
  fi

  dest="$ROOT/assets/$game.gif"
  mkdir -p "$ROOT/assets"
  rm -f "$dest"   # index.html references a fixed name; replace in place

  if command -v screen-rec >/dev/null 2>&1; then
    screen-rec convert "$video" --format gif --width "$width" --fps "$fps" \
      --quality "$quality" --start "$start" "${keep[@]}" --output "$dest" || exit 1
  else
    case "$quality" in low) colors=64 ;; high) colors=256 ;; *) colors=128 ;; esac
    ffmpeg -nostdin -v error -y -ss "$start" ${keep[0]:+-t ${keep[1]}} -i "$video" \
      -vf "fps=$fps,scale=$width:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=$colors:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" \
      -loop 0 "$dest" || exit 1
    printf 'converted: %s -> %s\n' "$video" "$dest"
  fi
  rm -f "$video"
done

printf '\nassets:\n' >&2
ls -la "$ROOT/assets"
