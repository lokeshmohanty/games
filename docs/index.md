# games — Documentation

*Last synced: never (freshly scaffolded). Refresh with the `docs-sync` skill.*

Entry point for all project documentation. Any LLM should be able to answer
questions about this project from this folder alone.

## Contents

- (nothing yet — docs-sync will populate: architecture, how-to/, reference/, decisions)

## How-to (verified commands)

| Task | Command |
|---|---|
| Regenerate a portal preview gif | `scripts/make-preview.sh <game>` (or `all`) — plays the game headless and writes `assets/<game>.gif`, which `index.html` already links |
| Play a P2P game locally with two peers | open the game, click CREATE GAME, open the invite link in a second tab, paste its reply code back, then START GAME (`file://` works; `python3 -m http.server 8000` also fine) |

Per-game scenarios, the conversion profiles, and the NixOS/Playwright traps live in
the `game-previews` skill (`.agents/skills/game-previews/SKILL.md`).

## Honest gaps

- Mostly a scaffold: architecture and per-game design docs are still missing.
