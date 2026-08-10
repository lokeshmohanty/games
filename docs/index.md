# games — Documentation

*Last synced: 2026-08-10.*

Entry point for all project documentation. Any LLM should be able to answer
questions about this project from this folder alone.

## Contents

- [Connecting players](#connecting-players) — the serverless handshake, paid once per person
- [Parties](#parties) — the persistent group, teams, switching games, host succession
- [Adding a game](#adding-a-game) — the module contract
- [`../lib/README.md`](../lib/README.md) — the P2P core, registry, party, lobby and QR APIs
- (still missing: per-game design notes, decision log)

## How-to (verified commands)

| Task | Command |
|---|---|
| Test the signalling codec | `node scripts/test-codec.mjs` — no browser needed |
| Test the party end to end | `node scripts/test-party.mjs` — three real browser peers at 390x844: guest-side recruiting, teams, game switching, host succession |
| Regenerate a portal preview gif | `scripts/make-preview.sh <game>` (or `all`) — plays the game headless and writes `assets/<game>.gif` |
| Play locally with several peers | open `party.html`, click ADD PLAYER, open the invite link in another tab, paste the reply back (`file://` works; `python3 -m http.server 8000` also fine) |
| Test reply-code **scanning** | needs a camera *and* a secure context, so `file://` and plain `http://<ip>` will not do. Either use the deployed `https://` site, or drive Chrome with a fake camera: `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream --use-file-for-fake-video-capture=<file>.y4m` |
| Get back to the portal | every page has a fixed `.portal-link` ("← ALL GAMES") linking to `index.html` |

Per-game recorder scenarios, the conversion profiles, and the NixOS/Playwright
traps live in the `game-previews` skill (`.agents/skills/game-previews/SKILL.md`).

## Connecting players

The handshake is carried by the players — there is no signalling server and no
third-party relay (see `MEMORY.md` → no-third-party-services).

| Step | Same room | Apart |
|---|---|---|
| Inviter → newcomer | newcomer scans the invite QR with their phone camera | inviter sends the invite link over any chat app |
| Newcomer → inviter | inviter taps **SCAN REPLY** and points the camera at the newcomer's screen | newcomer sends the reply code back; inviter taps **PASTE**, or pastes it and taps **CONNECT** |

**That cost is paid once per person, by whoever is next to them.** Any member
can invite, not only the host, and once someone is connected the rest of the
party negotiates with them automatically over the links that already exist.
This is why the topology is a mesh rather than the star it used to be: the
expensive part of a mesh was never the connections, it was the copy-pastes.

**SCAN REPLY** is served by `lib/qr-decode.js`, a from-scratch QR decoder plus
camera scanner. It prefers the browser's `BarcodeDetector` where that exists
(Android Chrome) and falls back to its own decoder, because desktop Chrome and
iOS Safari do not ship one. Always call the returned `stop()` — it releases the
camera, which the browser will not do on its own.

## Parties

`party.html` is the shell that keeps a group together. Because every game is a
mountable module and the room is a mesh, **switching games is a DOM swap, not a
page navigation** — nobody reconnects and nobody re-scans.

- **Roster** — everyone's name, editable and remembered in `localStorage`.
- **Teams** — each member is Team A, Team B, or WATCHING. Each game declares the
  shape it wants (`teams` / `coop` / `free`) and the switcher refuses to start
  one whose roster does not fit, saying why.
- **Spectators** are excluded from `players()`, so a game seats and scores only
  the people actually playing.
- **Host controls** — assign teams, remove a member, hand over the crown, or
  delete the party.

### When the host goes

The party outlives it. A dropped link is not assumed to be a departure: the
party probes first, and anyone still connected to that member vouches for them.
Only silence counts as gone, and that conclusion is broadcast so everyone drops
them together.

If the host was the one who went, the longest-present remaining member (ties
broken by id, so everyone nominates the same person) is **offered** the crown —
never given it silently. Everyone else is told who is taking over. The only
thing that ends a party is the host explicitly choosing DELETE PARTY.

A page reload is the one case that cannot be rescued: WebRTC credentials are
per-connection, so a reloaded browser must handshake again — though any member
can invite them straight back in.

## Adding a game

One file in `games/`, one script tag in `party.html`, one in its own page.
Nothing in the shell changes; the switcher lists whatever registered itself.
The contract is documented at the top of `lib/games.js` and summarised in
[`../lib/README.md`](../lib/README.md#adding-a-game).

The rule that matters: `mount(ctx)` must return an object with `unmount()` that
stops every loop, timer and window listener it started. Games are swapped
without a page reload, so anything left running fights the next game for input.

Each game keeps a standalone page (`connect4.html` and friends) as a deep link
into that one game. Those pages mount the same module through the plain
two-player lobby, so a game is implemented exactly once.

`games/tug-of-war.js` was written specifically to test that contract, and is
worth reading first when adding a game: it is the only one with more than one
player per side, so it is where `seats("A")` is read as a group rather than as
`seats("A")[0]`. Adding it needed no change to anything in `lib/` — one file,
one script tag in `party.html`, one thin page, one recorder scenario.

## Honest gaps

- Per-game design notes and a decision log are still missing.
- Scanning is verified against synthetic camera frames and a fake-camera
  end-to-end run, **not** against a real phone camera.
- The mesh is tested with three peers; nothing has exercised the 8-player cap,
  and no test forces a pair to fail so the relay path runs in anger.
- Cross-network play over mobile data is expected to fail on carriers using
  CGNAT/symmetric NAT — confirmed in the wild on 2026-08-10. This is the
  no-TURN trade-off, not a bug; the error now names which case you hit.
- There is no TURN server by choice, so players behind symmetric NAT cannot
  connect at all; this surfaces as an explicit error, not a hang.
- `index.html` still falls back to a `via.placeholder.com` image when a preview
  gif is missing — the one third-party contact left in the project.
