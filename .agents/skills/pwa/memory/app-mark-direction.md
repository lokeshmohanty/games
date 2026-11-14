# The app mark follows Paper, not Neon

Decided 2026-11-14 by Lokesh, choosing a new logo.

**Why:** the default theme has been Paper since 2026-11-13 (`lib/theme.css`).
Neon (cyan/black/glow) is now an optional theme. `assets/icon.svg` was still the
cyan joystick from the Neon days, so the installed icon matched a theme most
people never see. Trap hit on 2026-11-14: I told him "cyan on black matches the
portal" without reading `lib/theme.css`, and had to correct it. Read the theme
tokens before claiming what the brand colours are.

## Choices made

- Scope: the app icon (favicon, install PNGs, maskable) **and** a header lockup
  next to the portal `<h1>`.
- Concept: "linked players": two joysticks, one wire, for "every game is
  multiplayer".
- Icon colours: Paper dark slate tile `oklch(0.19 0.012 260)`, player 1 in the
  Paper dark `--accent`, player 2 in `--accent-2`, flat with no glow. The icon is
  a fixed raster, so it cannot follow the theme.
- Header lockup: draws with theme tokens (`--accent`, `--accent-2`, `--ink`), so
  it follows Paper and Neon, light and dark, by itself.
- Process: show an option sheet first (every icon size plus the maskable crop
  plus the lockup in each theme), then let him pick.

Option sheet (4 variants, A–D): https://claude.ai/artifact/MctQN4fSg3imRQTeYPGooc.
**He picked A, "Wired twins"** (2026-11-14): two sticks on their own bases, one
cable arching over from ball to ball. I had recommended C ("A-frame") and he
chose otherwise, so present options as options. Known weakness, accepted: at
32 px and below the arc can read as headphones.

Related: [[installability-verdict]], [[caching-split]].
