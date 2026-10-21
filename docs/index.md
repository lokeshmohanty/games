# games — Documentation

*Last synced: 2026-08-27 (Undercover; the portal rebuilt for phones).*

Entry point for all project documentation. Any LLM should be able to answer
questions about this project from this folder alone.

## Contents

- [The portal](#the-portal) — the phone layout and the filter tags
- [Connecting players](#connecting-players) — the serverless handshake, paid once per person
- [Parties](#parties) — the persistent group, teams, switching games, host succession
- [Bots](#bots) — why there is no single-player section, and what a bot actually is
- [Hidden information](#hidden-information) — sealed private state, and commit-reveal
- [Rounds and phases](#rounds-and-phases) — the shared clock for timed and simultaneous-turn games
- [Adding a game](#adding-a-game) — the module contract
- [Installing it](#installing-it) — the PWA: manifest, icons, service worker, offline
- [`../lib/README.md`](../lib/README.md) — the P2P core, registry, party, lobby and QR APIs
- (still missing: per-game design notes, decision log)

## How-to (verified commands)

| Task | Command |
|---|---|
| Test the signalling codec | `node scripts/test-codec.mjs` — no browser needed |
| Test the party end to end | `node scripts/test-party.mjs` — three real browser peers at 390x844: guest-side recruiting, teams, game switching, host succession |
| Test the room hub (codes, claims, TTLs) | `node scripts/test-hub.mjs` — pure hub logic against the real rules, no browser, no Cloudflare account needed |
| Test the join-by-code path | `node scripts/test-room.mjs` — the real client (lib/room-join.js, net.js, the party and lobby screens) against the in-page mock room server; WebRTC handshake itself is real |
| Regenerate a portal preview gif | `scripts/make-preview.sh <game>` (or `all`) — plays the game headless and writes `assets/<game>.gif` |
| Serve it locally | `just run` — http://127.0.0.1:8000. `just serve-lan` binds every interface for phone testing, but a plain LAN http:// address is not a secure context, so SCAN REPLY will not work there (use PASTE) |
| Run everything | `just test`, or `just --list` for the rest |
| Check the offline precache | `just check-precache` — every page and module in `sw.js`'s `SHELL`; nothing else warns when one is missed |
| Play locally with several peers | open `party.html`, click ADD PLAYER, open the invite link in another tab, paste the reply back (`file://` works; `python3 -m http.server 8000` also fine) |
| Test reply-code **scanning** | `node scripts/test-scan.mjs` — renders a real-sized reply code into a camera frame and feeds it to Chrome as a fake capture device. Scanning needs a camera *and* a secure context, so `file://` and plain `http://<ip>` will not do; the test serves the repo over `http://127.0.0.1` for that reason |
| Test installability and offline | `node scripts/test-pwa.mjs` — checks the manifest and icons, asserts the portal's layout at 390x844, asks **Chrome itself** whether anything blocks installing, then cuts the network and loads the pages |
| Test that every game is playable alone | `node scripts/test-bots.mjs` — starts each game with bots and no second browser, checks the bots actually play (Connect 4 is never left an open win), and checks no peer opens a connection to one |
| Test the private-state and round layers | `node scripts/test-plumbing.mjs` — real `Room` routing over a fake transport: a sealed message is unreadable by the peer relaying it, a tampered one is refused, commitments verify, phases advance |
| Test Onitama's rules and bot | `node scripts/test-onitama.mjs` — card orientation as a property, both victory conditions from both sides, and the bot measured against random play |
| Test Battleship's rules and audit | `node scripts/test-battleship.mjs` — fleets, sinking, and the audit tested by *breaking* it four ways |
| Test Undercover | `node scripts/test-undercover.mjs` — the deal, the win conditions, and the table sizes that survive a wrong vote |
| Test Liar's Dice | `node scripts/test-liars-dice.mjs` — wilds, the bid ladder, the at-least rule, and the reveal race that once accused an honest player |
| Test the Light Cycles arena | `node scripts/test-light-cycles.mjs` — head-on collisions, spawn symmetry, and the bot measured against a rider that only avoids crashing |
| Rebuild the app icons | `node scripts/make-icons.mjs` after editing `assets/icon.svg` — renders the PNGs the manifest needs |
| Get back to the portal | every page has a fixed `.portal-link` ("← ALL GAMES") linking to `index.html` |

Per-game recorder scenarios, the conversion profiles, and the NixOS/Playwright
traps live in the `game-previews` skill (`.agents/skills/game-previews/SKILL.md`).

Two more skills hold the traps that this document only summarises — read them
before changing either subsystem:

- `.agents/skills/multiplayer/` — the P2P layer. Its memory records why SCAN
  REPLY has failed twice, and the one test shape that catches it.
- `.agents/skills/pwa/` — installability and offline. Its memories record why an
  SVG in `manifest.icons` makes the app uninstallable, and why code is fetched
  network-first.

## The portal

`index.html` is `start_url`, so it is the first thing an installed app shows.
Two things about it are asserted rather than eyeballed, in `test-pwa.mjs`.

**Nine games have to fit a phone.** They did not: a `minmax(300px, 1fr)` column
at 80% width is a single column on a 390px screen, and a 200px image plus a
heading plus a paragraph plus a button is taller than the viewport — you
arrived at one card. Below 560px the grid is two columns, the artwork is a
ratio rather than a fixed height, the blurb is dropped (at that width it is four
words a line, and the meta line already says the thing somebody standing there
wants to know), and the header — title, tagline, party banner — is roughly
halved. Four whole cards now fit on screen *from the top of the page*, header
and all, which is the number the test enforces.

**One trap, and it had been there from the start.** `.game-card p` outranks a
bare `.game-meta` on specificity, so every rule ever written for the meta line
was silently ignored: it rendered at the blurb's size and margins, and on a
phone that wrapped it onto a second line. The rules are scoped
`.game-card .game-meta` now, and the test checks the computed size rather than
trusting the stylesheet.

**Filters.** Each card carries `data-tags`; a strip of chips filters on them,
one at a time. Nine games is more than a phone shows at once, so the chips are
how somebody with a particular evening in mind finds the right game — on their
own, against one other person, or with a room full. The tags are
`alone` · `duel` · `party` · `one-phone` · `strategy` · `quick`, and a new game
should be given whichever apply. A filter matching nothing says so rather than
leaving a blank page.

## Connecting players

The handshake is carried by the players — there is no signalling server and no
third-party relay (see `MEMORY.md` → no-third-party-services). **Update
(2026-10): a room server now exists as an optional layer.** See
[`room-server.md`](room-server.md) for the design; the summary below is what
changed.

**What the room server adds:**

- **Join by code.** The host reads a six-digit code off their screen; the
  newcomer types it. The signalling WebSocket handles the offer/answer exchange,
  so the two-sided scan/paste handshake is no longer the only path in.
- **Reconnect.** A reloaded browser keeps a rejoin token in `localStorage`;
  the room server routes them back to their seat, so a page refresh no longer
  costs a party seat. The old mesh-level reconnect grace still covers the
  gaps the room server cannot see.
- **Progressive enhancement.** When the room server is unreachable, the
  classic invite/scan/paste flow is unchanged — same code paths, same
  errors, just without the code-join button.

**What the room server does not change:**

- Game data still flows peer-to-peer over WebRTC data channels. The room
  server sees only signalling (SDP offers/answers), never game bytes.
- The party record is still replicated over the mesh; the room server's
  peer-state notices are advisory, and a live link always outranks them.
- The classic handshake still works for any pair that cannot reach the room
  server.

Deploy instructions live in `worker/README.md`; the client-side glue is
`lib/room-join.js`.

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

Two things about that scanner are load-bearing, and both were learned by it not
working:

- **Resolution is never traded for speed.** A reply code is a 70-90 module grid
  read off somebody else's screen, so pixels per module is the scarce resource.
  The scanner used to lower its working resolution when a decode ran long —
  and the frames that run long are the *empty* ones, the ones the camera sees
  while its owner is still lining the phone up. It therefore threw away the
  detail it needed before it had seen anything, and from then on could not read
  a reply code at all: camera live, preview fine, nothing ever scanned. Cost is
  managed instead by decoding the centred square (what the preview shows) and
  by running the cheap binarisation pass on most frames and the full ladder on
  every third.
- **A platform decoder that fails must not take ours with it.** Chrome exposes
  `BarcodeDetector` on platforms where the service behind it is missing, and
  `detect()` then rejects on every frame; the rejection used to skip the
  fallback entirely. It is now dropped permanently on first failure.

`scripts/test-scan.mjs` covers both, including the aiming that precedes a real
scan and a CPU throttled to phone speed.

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
- **Host controls** — assign teams, add or remove a bot, remove a member, hand
  over the crown, or delete the party.

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

## Bots

**There is no single-player section, and no single-player mode.** Every game is
multiplayer; a game played alone is one whose other seats are bots. That
collapsed a split the portal used to advertise — "Single Player" and
"Multiplayer" as separate shelves — which had the effect of telling somebody
holding one phone that three of the four games were not for them.

A bot is **an ordinary member of the party record**. It has an id, a name, a
team and a seat, it appears in every peer's roster, and `seats()`, `players()`
and `checkRoster()` count it exactly like a person. Two consequences follow, and
they are the whole design:

1. **No game module had to learn what a bot is.** A game reads `seats("B")[0]`
   and neither knows nor cares whether a browser is behind it. `ctx.isBot(id)`
   and `ctx.botSeats(team)` exist for the games that want to give one a brain.
2. **Only the host runs them.** Every game here is already host-authoritative —
   the host owns the board, the knot, the swarm — so the side that plays a bot
   is the side that was refereeing anyway. A bot's move is applied through the
   same function a person's tap goes through, and the broadcast that follows is
   indistinguishable.

Bot ids are prefixed `bot_` so the **routing** code can recognise one from an id
alone, without consulting the record. That matters in four places in `net.js`,
and each is a bug if forgotten: `_meshUp` must not try to open a connection to
one (a full ICE timeout, every roster change, forever); a broadcast must not
count one as a peer somebody has to relay to; `_heir` must never nominate one
for the crown; and `_hostLost` must drop them all, because the only browser
simulating them has gone.

Where the brains live:

| Game | Brain | Where |
|---|---|---|
| Connect 4 | minimax + alpha-beta, 5 plies, centre-first move ordering | `games/connect4.js` |
| Tug of War | a tap rate (~9/s) with jitter, one timer for all bots | `games/tug-of-war.js` |
| Neon Survival | steering: inverse-square flee from enemies, drift to gems, wall push-off, speed-capped | `games/neon-survival-mp.js` |
| Draw & Guess | none — `bots: false` in its registration | — |

Draw & Guess opts out on purpose. A bot that draws is replaying a canned doodle
and a bot that guesses is reading the word it was handed; neither is an
opponent, and both make the round worse for the people actually playing. The
lobby and the party screen both say so rather than offering a button that
disappoints.

Neon Survival's bots are the one case that needs the wire: every ship's position
reaches other players as a `pos` message, so the host publishes a bot's with
`room.emitAs(botId, "pos", …)`, which sends to real peers **and** delivers
locally (an ordinary broadcast never comes back to its sender, so without that
the one browser running the bot would be the one that never saw it move).

## Hidden information

Two problems stand between this architecture and any game with a secret, and
they need different answers. `lib/secrets.js` has both.

**A "private" message is not private.** `makeAction().send(data, { target })`
is *addressed*, not sealed. With no TURN server, a pair that cannot connect
directly is routine, and `net.js` then relays the envelope through whichever
peer can reach both — another player's browser. Your hand travels through the
hands of the people you are hiding it from.

```js
const secrets = NeonArcade.makeSecrets(room, { onError: (e) => show(e.reason) });
await secrets.ready();
const hand = secrets.channel("hand");
hand.onMessage = (cards, { from, to }) => render(cards);
await hand.send(playerId, cards);       // sealed end to end
```

Each browser publishes an ECDH public key on its own **party record** — chosen
over a broadcast because the record already replicates to late joiners
wholesale, so somebody arriving mid-hand learns every key published before they
existed with no re-announcement protocol to get wrong. `room.setMeta()` is the
door to that record; it refuses the fields the record owns (`id`, `name`,
`team`, `bot`, `joined`, `host`).

A message to a **bot** never reaches the wire at all: the host plays it, so the
channel delivers it locally with `to` naming the bot, and a bot brain reads its
private state through the same handler a person's does.

**The host can read everything**, because it is a player refereeing state it is
a legitimate recipient of. No addressing fixes that; commitment does.

```js
const c = await secrets.commit(myFleet);   // { digest, nonce, value }
publish(c.digest);                          // now
publish({ value: c.value, nonce: c.nonce });// at the reveal
await secrets.verify(opened);               // everyone checks
```

The digest is taken over a **canonical** serialisation — object keys sorted at
every depth — because `JSON.stringify` preserves insertion order, so a value
that has been through the network can serialise differently from the one that
was hashed. That is a verification failure with no bug behind it.

Both halves need WebCrypto, which needs a secure context. `file://` **is** one
in Chrome and Firefox, so the project's `file://` habit is safe here — but the
check is made at runtime, and `secrets.privacy()` returns `"plain"` rather than
silently sending in the clear. A game with a secret should refuse to deal on
`"plain"` — Battleship does exactly that.

### The worked example: Battleship

`games/battleship.js` is what this was built for, and it shows the pattern in
full. Nobody holds anybody else's fleet — not even the host. Each player commits
to a fleet before a shot is fired, answers hit-or-miss for their *own* board
during play, and opens the commitment at the end.

**Verifying the digest is not enough**, and this is the part that is easy to get
half right. A digest proves only that the fleet was decided before the shooting
started; a player can commit honestly and then simply lie about a hit. So the
reveal runs two checks — the digest against the revealed fleet, **and** every
answer replayed against it. A third catches the fleet that was legal-looking but
overlapping. `scripts/test-battleship.mjs` tests the audit by breaking it four
ways, because a commitment nobody can fail is decoration.

Battleship uses `commit`/`verify` but **not** the sealed channel: a fleet never
crosses the network during play at all, so there is nothing to seal.

### Liar's Dice, and the correction it forced

Liar's Dice was expected to be the sealed channel's first user — the host deals
five dice to each player, privately. **That build is wrong**, and the reasoning
is worth keeping. `secrets.channel()` seals a message against the *peers
relaying it*; it cannot seal anything against the sender. A host that deals is a
host that has read every cup, and the host is a player.

So Liar's Dice does what Battleship does: each player rolls **their own** dice
locally and publishes a commitment before a bid is made. Nothing about anybody's
hand crosses the wire until somebody calls, and then everything does at once and
every commitment is checked.

The generalisation: **commit-reveal is the answer whenever players can generate
their own secret.** The sealed channel only earns its place when one party must
know something the others must not — a **shared deck**, dealt without
replacement, where the hands must be disjoint and no player can roll their own.

### The sealed channel has no user

Nothing in the arcade uses `secrets.channel()` today. That is worth stating
plainly rather than leaving the module looking load-bearing.

It was built for a real problem — an addressed send is relayed *in plaintext
through another player's browser* whenever a pair has no direct link — and it is
proven against that by `scripts/test-plumbing.mjs`, which reads the bytes that
cross a relaying peer. But no game has needed it. Twice now the obvious
candidate turned out not to: a fleet and a roll of dice can each be generated by
the player who owns them, so both games commit instead and send nothing.

**Oh Hell, a trick-taking game off a shared deck, was built and then removed.**
It did use the channel — hands off one deck must be disjoint, so somebody has to
deal — and it worked. It was dropped because of what sealing *cannot* do:
protect a hand from the dealer. The host deals, the host is a player, and no
commitment fixes that because the host also chooses the shuffle it would be
committing to. The real answer is mental poker — a deck encrypted commutatively
by every player, which nobody can read and everybody can shuffle — and until
that exists, a dealt game here has a player who knows everything.

So the rule stands, and it is the useful part: **commit-reveal is the answer
whenever players can generate their own secret.** The sealed channel is for the
case where they cannot — and that case also needs a dealer nobody has to trust.

## Rounds and phases

`lib/rounds.js` is the clock Draw & Guess wrote by hand, generalised. The host
owns it and peers mirror; time crosses the wire as a **duration, never a
timestamp**, because two phones' clocks disagree by more than these phases last.

```js
const rounds = NeonArcade.makeRounds(ctx, {
  rounds: 5,
  phases: [{ name: "lock", ms: 20000, collect: true }, { name: "resolve", ms: 3000 }],
  botSubmit: (botId) => chooseFor(botId),
  onPhase: (i) => render(i),
  onCollect: ({ entries }) => resolve(entries),   // host only
});
rounds.start();          // host
rounds.submit(answer);   // anybody
```

A phase marked `collect` ends **as soon as every seated player has submitted**,
or at its deadline, whichever is first. That one rule is what makes
simultaneous-turn games work over this transport: nobody is racing anybody, so
a slow link costs its owner nothing and the host never arbitrates who acted
first. `botSubmit` exists because a collecting phase would otherwise wait out
its deadline for a seat with no browser behind it.

Peers see *who* has submitted, never *what* — the submissions themselves never
leave the host until `onCollect` decides what is public.

Battleship runs **two** schedulers, which is what `name` is for: placement is a
single collecting phase that ends the moment both fleets are committed, and the
battle is many, each ending the moment both players have picked a square. One
trap worth knowing — `botSubmit` is synchronous and `commit` is not, so a bot's
fleet and commitment have to be built and cached *before* the placement phase
opens. Liar's Dice cannot do that, because the number of dice changes every
round; it uses `rounds.submitFor(botId, digest)` from inside the phase instead.

`rounds.next()` ends the current phase immediately. Liar's Dice needed it — the
bidding is over when somebody calls a bluff, which is a game event and not a
clock — and Draw & Guess uses it too, so that everybody guessing correctly ends
the drawing phase instead of running out its sixty seconds.

**Draw & Guess now runs on this.** It is the game the scheduler was generalised
*from*, and moving it over is what proved the generalisation was real: a `phase`
string, a chain of `setTimeout`s, and a re-check inside every callback that the
phase it woke in was still the phase it was scheduled for, all became one
declaration. The re-check is gone entirely, because a disposed scheduler fires
nothing. `timeLeft` also stopped being broadcast — every peer counts down for
itself from the duration the host sent, and `test-party.mjs` asserts that three
peers agree on the clock to within a second.

## Games played on one device

`local: true` in the registration says a game is played by people **in the same
room, on one phone, passed from hand to hand**. `games/undercover.js` is the
first.

This is not a lesser kind of multiplayer. It is the answer to the cost this
whole project is organised around: a handshake is paid once per person, and for
six people round a table that is five handshakes to play a game nobody needed a
second screen for. A local game skips all of it — there is no room, no peers,
and no invite.

What the flag changes is small and deliberate:

- `NeonArcade.checkRoster` stops enforcing seats. A local game's players are
  names typed into one phone, not rows in the party record, so one member in
  the party is a perfectly good six-player game.
- `lib/lobby.js` offers a plain **START** instead of INVITE A FRIEND / PLAY A
  BOT. There is nothing to connect and nobody to wait for.

Everything else is the ordinary module contract. The game keeps its own list of
players and ignores `ctx.players()` entirely.

**What such a game is actually responsible for** is narrower than it looks. The
describing, the arguing and the voting happen between people; the phone deals
the secrets, remembers who is out, and — the only part that really matters —
never shows a secret to the wrong person. Undercover takes two deliberate taps
to reveal a word and one to hide it, and `scripts/test-bots.mjs` asserts that
nothing is on screen (or in the DOM) before the tap and nothing is left after
the pass.

Two traps found building it, both of which look like a sulky game rather than a
bug:

- **The table must survive one wrong vote.** The undercovers win at parity, so a
  table needs `n >= 2*others + 2`. Five players with one undercover *and* a
  blank does not: three against two, over the moment the table guesses wrong,
  before anybody has spoken twice.
- **No word may appear in two word-pairs.** A player who has seen the list
  before could otherwise rule out the other half. The test caught "Violin" in
  two pairs.

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

`lib/ui.js` supplies the furniture every game was rebuilding — an injected
`<style>`, a centred stage, a status line and a full-bleed overlay:

```js
const shell = NeonArcade.gameShell(ctx.root, { css: `#board { ... }` });
shell.stage.append(canvas);
shell.setHud([{ key: "turn", text: "Your move" }]);
```

It is factory functions over plain DOM, not a reactive layer — see the
[SolidJS decision](#adding-a-game) note below. The one idea borrowed from that
world is that `setHud` **updates text nodes in place** instead of rebuilding the
row. Two rules come with it: the stage reserves `52px` of top padding for the
fixed "← ALL GAMES" link (centring without it puts the status line underneath),
and the one child that should absorb leftover height takes `.g-fill` rather than
setting its own full height, which would overflow the stage.

**Vanilla is a decision, not an omission.** Converting to SolidJS was weighed on
2026-08-10 and again on 2026-08-27: the reactive surface is about a fifth of the
code, and JSX needs a compiler that emits ESM, which browsers refuse over
`file://` — a way of running this that the project verifies. The deploy
workflow uploads the repo with `path: '.'`, and `scripts/preview.mjs` drives the
game HTML directly. `lib/ui.js` is what that analysis recommended instead.

`games/tug-of-war.js` was written specifically to test that contract, and is
worth reading first when adding a game: it is the only one with more than one
player per side, so it is where `seats("A")` is read as a group rather than as
`seats("A")[0]`. Adding it needed no change to anything in `lib/` — one file,
one script tag in `party.html`, one thin page, one recorder scenario.

## Installing it

The arcade is a PWA: `manifest.webmanifest`, icons under `assets/`, and `sw.js`
at the repo root so its scope covers every page. `lib/pwa.js` registers the
worker and fills any `[data-install-slot]` element with an INSTALL APP button
when the browser says the app can be installed (the portal has one under the
title). On `file://` there is no secure context and none of this runs.

**The install button is Chromium-only, and that is not a bug here.** It is
driven by `beforeinstallprompt`, a non-standard event that only Chromium
implements — so Chrome, Edge and their relatives get a button and nothing else
ever will. `lib/pwa.js` therefore fills the slot with a sentence instead of
leaving it empty:

| Browser | What happens |
|---|---|
| Chrome / Edge / Chromium | INSTALL APP button, from the held `beforeinstallprompt` |
| Firefox on Android | hint: install from the ⋮ menu — Firefox can, the page cannot ask |
| Firefox on desktop | hint: it cannot install web apps at all (removed in Firefox 85, not restored) — but the page still works offline |
| iOS Safari | hint: Share → Add to Home Screen |

**Offline is unaffected by any of that.** Firefox supports service workers and
the Cache API fully, so the arcade caches and plays with no network there
exactly as it does in Chrome — it just lives in a tab. (Firefox does disable
service workers in Private Browsing windows.)

**The caching split is the design decision.** Code — the pages, `lib/`,
`games/` — is fetched **network-first**: those files must agree with each other,
and serving one from a stale cache beside another fetched fresh breaks the app
silently, days after the deploy responsible. Icons and preview gifs are
**cache-first**, being large, stable, and harmless when slightly old. The
offline copy is precached in one go at install, so with no network you get one
coherent deploy rather than an accumulation. The preview gifs are deliberately
left out of that precache (~2 MB, and nobody asked for them yet), which is why
`assets/placeholder.svg` exists.

**Do not put an SVG in the manifest's `icons`.** Listed with `sizes: "any"`,
Chrome selects it as *the* install icon, refuses it, and reports
`no-acceptable-icon` for the entire set — the app becomes uninstallable while
every hand-written check still passes. This was caught only by asking Chrome
through CDP, which `scripts/test-pwa.mjs` now does on every run. The SVG remains
the favicon via `<link rel="icon">`.

## Honest gaps

- Per-game design notes and a decision log are still missing.
- Scanning is verified at realistic code density — a reply code occupying part
  of a full-resolution frame, preceded by seconds of empty aiming frames, on a
  CPU throttled to phone speed — but via a fake capture device, **not** a real
  phone camera. Nothing here reproduces glare, autofocus or motion blur. A
  640x480 webcam is recorded as passing at close range only; below that, PASTE
  is the answer.
- The mesh is tested with three peers; nothing has exercised the 8-player cap,
  and no test forces a pair to fail so the relay path runs in anger.
- Bot *strength* is now measured for two of the six. Onitama's bot wins 20 of
  20 against random play; Light Cycles' wins 30 of 30 against a rider that only
  avoids crashing, and a per-tick budget assertion keeps the search inside its
  own tick with eight bots running. The other four are still asserted only
  negatively — Connect 4's is checked never to leave an immediate win on the
  board, which is not the same as checking it plays well — and **nothing
  measures whether any of them is fun to lose to**. Light Cycles' bot may in
  fact be too strong; that is a judgement no test here makes.
- **`secrets.channel()` has no user.** It is proven by `test-plumbing.mjs` and
  by nothing else. See the section above for why two likely candidates turned
  out not to need it, and why the one that did was removed.
- **Undercover trusts the room.** Anyone can look over a shoulder during the
  deal, and the phone cannot know. Two deliberate taps and an immediate hide are
  the whole defence, which is the same defence the card game it descends from
  has.
- `scripts/test-party.mjs`'s host-succession section is **intermittently
  flaky** — one failure in five runs on 2026-08-27, timing out waiting for the
  crown to be offered after the host's page closes. The other four passed and
  nothing else in the suite failed. Not investigated.
- `lib/rounds.js` does not survive host succession. If the crown moves
  mid-round the clock stops with it; every other game here has the same
  property, and nothing recovers a game in progress.
- **Battleship's audit is never triggered in real play**, because no player here
  can cheat: every client runs the same honest `answerShot`. The audit is tested
  against deliberately corrupted answers, which is the right test, but a genuine
  modified client has never been pointed at it.
- Battleship's placement auto-commits a few seconds before the deadline so a
  player who walks away cannot stall the game. That path is not covered by any
  test — it takes 142 seconds to reach.
- Liar's Dice trusts each player's *roll*. The commitment stops a player
  changing dice after seeing a bid, which is the cheat that decides rounds; it
  does nothing about a modified client that re-rolls until it likes its hand,
  and nothing short of a shared random beacon would.
- Draw & Guess's word still goes to the drawer **addressed, not sealed**. A
  relaying player could read it. That is the honest level of protection for a
  party game whose worst case is a spoiled round, but it is a choice, not an
  oversight.
- Onitama's card *movesets* are the published ones, but the first-player stamp
  on each card is ours — an even 8/8 split that keeps the mechanic without
  claiming to reproduce the physical deck. Marked `VERIFY` in the source.
- A genuinely stuck Onitama position — no legal move, so a card is passed — was
  never found: 375,000 random small placements against every card pair, plus an
  exhaustive sweep of the back two rows and one 3x3 corner against all 120
  pairs, produced none. The rule is implemented faithfully; the branch is
  almost certainly unreachable and its test fixture is built by hand.
- The Firefox install hints are reasoned from the platform, not observed —
  every browser test here runs headless Chrome. Firefox itself is unverified.
- Cross-network play over mobile data is expected to fail on carriers using
  CGNAT/symmetric NAT — confirmed in the wild on 2026-08-10. This is the
  no-TURN trade-off, not a bug; the error now names which case you hit.
- There is no TURN server by choice, so players behind symmetric NAT cannot
  connect at all; this surfaces as an explicit error, not a hang.
- Installability and offline are verified against headless Chrome only. No real
  phone has been asked to install it, and iOS in particular is unverified: it
  ignores the manifest's icons, gets no install event, and Safari's service
  worker eviction rules are its own.
- The service worker's `VERSION` is bumped by hand, there being no build step to
  hash anything. Forgetting it costs an out-of-date *offline* copy; because code
  is network-first it can never serve a stale app to a player who is online.
