# Bots are party members, not a game mode

*Established 2026-08-26, when the portal's Single Player / Multiplayer split was
removed and every game gained bots.*

## The decision

A bot is **a member of the party record** — an id, a name, a team, a seat, a
`joined` time — that the host's browser plays for. It is not a mode, not a flag
on the game, and not a second code path through any game module.

The whole payoff is that **no game module had to learn what a bot is**. A game
reads `ctx.seats("B")[0]` and neither knows nor cares whether a browser is
behind it. `NeonArcade.checkRoster`, `players()`, spectator handling, the party
switcher's validation — all of it counts a bot as a player, unchanged.

The alternative considered and rejected: a separate "vs computer" mode per game
page that skips the lobby. It is simpler for exactly one case (solo) and cannot
mix a bot into a real party, which is the case people actually asked for.

## Why the id carries the fact

Bot ids are prefixed `bot_` (`NeonArcade.isBotId`). The party record also has
`bot: true`, and that replicates for free because `_applyParty` adopts the
host's record wholesale — but the **routing** code needs to recognise one from
an id alone, before or without consulting a member record.

Four places in `net.js`, each a real bug if forgotten:

| Place | What goes wrong |
|---|---|
| `_meshUp` | opens a WebRTC connection to a browser that does not exist — a full ICE timeout, on every roster change, forever, silently |
| `_send` broadcast `missing` | counts a bot as a peer somebody must relay to, so every broadcast asks for pointless forwarding |
| `_heir` | nominates a bot for the crown; nothing is there to accept it and the party is stuck |
| `_hostLost` | leaves bots in the roster after the only browser simulating them has gone — seats that never move again |

`scripts/test-bots.mjs` asserts the first one from the guest's side
(`directPeers()` must not grow when the host adds a bot) because it is the one
that would rot quietly: nothing in the UI reports it.

## Host-side only, always

Every game here is already host-authoritative — the host owns the board, the
knot, the swarm. So the side that plays a bot is the side that was refereeing
anyway, and a bot's move goes through the **same function a person's move goes
through**. No new validation path, no new state, no divergence.

`room.emitAs(botId, action, data)` exists for the one case where the game's own
peers carry the information rather than the host's state broadcast: Neon
Survival publishes every ship's position as a `pos` message. It sends to real
peers **and delivers locally**, because an ordinary broadcast never comes back
to its sender — without that, the one browser running the bot would be the one
browser that never saw it move.

## A game may opt out

`bots: false` in the registration. Draw & Guess is the only one: a bot that
draws replays a canned doodle, a bot that guesses reads the word it was handed.
Both are parlour tricks that make the round worse for the people playing. The
lobby and the party screen both *say* this rather than hiding the button, so
nobody wonders whether it is broken.

See also [[../../pwa/memory/install-prompt-is-chromium-only]].
