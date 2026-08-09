# games — Documentation

*Last synced: never (freshly scaffolded). Refresh with the `docs-sync` skill.*

Entry point for all project documentation. Any LLM should be able to answer
questions about this project from this folder alone.

## Contents

- [Connecting two players](#connecting-two-players) — the serverless handshake, scanning, and how a stuck guest recovers
- [`../lib/README.md`](../lib/README.md) — the P2P core, lobby, QR encode/decode APIs
- (still missing — docs-sync will populate: architecture, per-game design, decisions)

## How-to (verified commands)

| Task | Command |
|---|---|
| Regenerate a portal preview gif | `scripts/make-preview.sh <game>` (or `all`) — plays the game headless and writes `assets/<game>.gif`, which `index.html` already links |
| Play a P2P game locally with two peers | open the game, click CREATE GAME, open the invite link in a second tab, paste its reply code back, then START GAME (`file://` works; `python3 -m http.server 8000` also fine) |
| Test reply-code **scanning** | needs a camera *and* a secure context, so `file://` and plain `http://<ip>` will not do. Either use the deployed `https://` site, or drive Chrome with a fake camera: `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream --use-file-for-fake-video-capture=<file>.y4m` (Chrome opens the file lazily, so it can be rewritten with the real reply QR just before SCAN REPLY is clicked) |
| Get back to the portal from a game | every game has a fixed `.portal-link` ("← ALL GAMES") linking to `index.html` |

Per-game scenarios, the conversion profiles, and the NixOS/Playwright traps live in
the `game-previews` skill (`.agents/skills/game-previews/SKILL.md`).

## Connecting two players

The handshake is carried by the players — there is no signalling server and no
third-party relay (see `MEMORY.md` → no-third-party-services). Full API notes
live in [`../lib/README.md`](../lib/README.md).

| Step | Same room | Apart |
|---|---|---|
| Host → guest | guest scans the invite QR with their phone camera | host sends the invite link over any chat app |
| Guest → host | host clicks **SCAN REPLY** and points the camera at the guest's screen | guest sends the reply code back; host pastes it and clicks **CONNECT** |

**SCAN REPLY** is served by `lib/qr-decode.js`, a from-scratch QR decoder plus
camera scanner (`NeonArcade.qrDecode()` / `NeonArcade.scanQr()`). It prefers the
browser's `BarcodeDetector` where that exists (Android Chrome) and falls back to
its own decoder, because desktop Chrome and iOS Safari do not ship one. Always
call the returned `stop()` — it releases the camera, which the browser will not
do on its own.

### Getting unstuck

`NeonArcade.hostNewGame()` (button: `NeonArcade.hostNewGameButton()`) strips the
`#i=` invite fragment and reloads, turning a guest into a host. It is offered
wherever a guest would otherwise be stranded:

- a guest's game-over screen, while the host decides whether to rematch;
- the terminal screen the lobby shows if the host disconnects mid-game — the
  host is the hub every guest relays through, so losing it ends the session.

## Honest gaps

- Mostly a scaffold: architecture and per-game design docs are still missing.
- Scanning is verified against synthetic camera frames (rotation, blur, noise)
  and a fake-camera end-to-end run, **not** against a real phone camera.
- There is no TURN server by choice, so players behind symmetric NAT cannot
  connect at all; this surfaces as an explicit error, not a hang.
