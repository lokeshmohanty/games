# STATUS — volatile state

*Update in place; keep short; absolute dates. History lives in git log.*
*Not loaded by default — `AGENTS.md` points here on demand. Keep it that way:
if this file grows past ~10KB, split the archive out rather than making every
session pay for it.*

# TODO(user added)

*Updates/tasks/queries added by the owner; process only when he says, then
act → record → clear the item. This is the single inbox — do not create a
separate `TODO.md`.*

## Current focus (2026-08-10)

Parties landed: connecting several people no longer costs a handshake per pair.
The star topology became a mesh whose signalling rides over existing links, so
one manual scan per person is the whole cost, and any member can recruit.

Shipped this session:
- `lib/net.js` — mesh + relayed signalling, party record (names/teams/host),
  probe-before-drop departure detection, host handover and succession.
- `lib/games.js` — game registry and the `mount(ctx) -> { unmount() }` contract.
- `lib/party.js` + `party.html` — the persistent party screen.
- `games/*.js` — the three multiplayer games as modules; their `.html` pages are
  now thin wrappers that mount the same modules.
- Handshake: smaller codes (active ICE-TCP dropped), early ICE cutoff, PASTE
  button, `#a=` reply links.
- `scripts/test-codec.mjs`, `scripts/test-party.mjs` — first tests in the repo.

## Next actions

- [ ] Verify on real phones — scanning is still only tested against a fake
      camera, and the party screen has only been checked at 390x844 headless.
- [ ] No test forces a pair to fail, so the two-hop relay path is unexercised;
      the 8-player cap is likewise untested.
- [ ] `index.html` still falls back to `via.placeholder.com` for a missing
      preview gif — the last third-party contact in the project.

## Open obligations / blockers

- (none)
