# games — Documentation

*Last synced: 2026-11-15 (SDK v1 and the old pages removed; docs/platform.md; lib/README.md's API and connectivity moved here).*

Entry point for all project documentation. Any LLM should be able to answer
questions about this project from this folder alone.

## Contents

- [The portal](#the-portal) — the home screen's sub-tabs (My Games · All Games), sections, PLAY SOMETHING, the phone layout and the search
- [Connecting players](#connecting-players) — the serverless handshake, paid once per person; `scanQr`; connectivity (relaying, STUN, NAT classification, no TURN); who said it (signed party messages)
- [Parties](#parties) — the persistent group, teams, switching games, host succession; the party API (`mountParty`, the room controller, lib/lobby.js)
- [Bots](#bots) — why there is no single-player section, and what a bot actually is
- [Hidden information](#hidden-information) — sealed private state, and commit-reveal
- [Rounds and phases](#rounds-and-phases) — the shared clock for timed and simultaneous-turn games
- [Adding a game](#adding-a-game) — where the author's guide and the protocol live
- [Accounts and the social layer](accounts.md) — sign-in, ranked matches, leaderboards (ranked, solo runs, and wins against bots kept apart), friends, invites, groups, feedback, the public snapshot; what is stored; the one-time setup
- [A prompt for contributors' AI](contributor-prompt.md) — paste into an AI assistant to adapt or write a game for the platform
- [Suggestions](suggestions.md) — formalising and improving the platform: contract, contributors, quality, trust, players, operations
- [Developing the arcade](development.md) — running it, where the code is, the stack and why, tests, the service worker, previews and icons
- [The shell is one page](spa.md) — Solid + Vite, the query router, the party kept across views, the build and the generated service worker
- [The game SDK v2](sdk-v2.md) — the language-neutral message protocol (sdk/v2/protocol.json), shell services, managed state, WebAssembly, adapters, bindings, examples
- [The platform](platform.md) — the sandbox, the manifest's base fields, theme, results, the rules a game follows, the registry and pins, the submission check, the dev kit, validate-game, web apps
- [Achievements and records](platform.md#achievements-and-records) — personal records and trophies for every game you can play alone, declared in game.json as data-only conditions on the result (`lib/achievements.js`), kept on the device (`lib/records.js`), synced to the account and shown to friends only ([accounts.md](accounts.md#records-and-achievements), D1 0007); 🏆 Records in the party's top band (on the PARTY screen mid-game), the profile's trophies, a friend's 🏆 TROPHIES in the party
- [Installing it](#installing-it) — the PWA: manifest, icons, service worker, offline
- [Performance](perf.md) — the phone-speed harness (`just perf`), the 2026-11-14 baseline, and each refactor phase measured against it
- [Testing across real networks](network-testing.md) — the NAT lab: symmetric NAT, network switches, lossy links, a blocked room server
- [`../lib/README.md`](../lib/README.md) — every lib/ file in a line, with pointers here for depth
- [Neon Bid](neon-bid.md) — the sealed-bid gem auction's design, as approved
- Neon Fission (`games/neon-fission/`, rules in its `RULES.md`) — the chain-reaction grid for 2–8: a managed ffa game; `"sameDevice"`: at SINGLE PLAYER's quick table ([The party API](#the-party-api)) one person can make bot seats PERSON, people on the same phone (the seat arrives with `local` in `init`; those seats' turns are reported as the person's, so no bot plays them; the end card names them via the result's `names`, docs/sdk-v2.md). Its own "set the table" screen before the first move went on 2026-11-17: the platform's table is the one place. Each move's chain is replayed on every phone, about 1.5 s at most, and a tap skips it. The move that ends the game plays wave by wave and then marks the cells it took: 5.25 s at most for any chain, its waves sharing a 4.3 s budget (at most 300 ms each, about 40 ms in a 104-wave chain), so it always ends inside the end card's 6 s hold. The turn line and chips wait for it, and so does the end card (`arcade.idle()`, docs/sdk-v2.md; rules.js `pace`). Under reduced motion nothing animates
- (still missing: design notes for the other games, decision log)

## How-to (verified commands)

| Task | Command |
|---|---|
| Test the signalling codec | `node scripts/test-codec.mjs` — no browser needed |
| Test the party end to end | `node scripts/test-party.mjs` — three real browser peers at 390x844: guest-side recruiting, teams, game switching, host succession |
| Test the room hub (codes, claims, TTLs) | `node scripts/test-hub.mjs` — pure hub logic against the real rules, no browser, no Cloudflare account needed |
| Test the join-by-code path | `node scripts/test-room.mjs` — the real client (lib/room-join.js, net.js, the party and lobby screens) against the in-page mock room server; WebRTC handshake itself is real |
| Test across real (simulated) networks | `just test-nat` — NAT routers built from network namespaces (cone, full cone, symmetric), netem loss/latency, a network switch mid-party, a blocked room server; real Chrome per device and the real worker under `wrangler dev`. Needs `nix shell`, so not in `just test`. See [network-testing.md](network-testing.md) |
| Regenerate a portal preview | `scripts/make-preview.sh <game>` (or `all`) — plays the game headless and writes `assets/<game>.webp` (poster), `.webm` and `.mp4`; no gif is kept. An outside repo's game (web-games, card-games): `--gif ../<repo>/<game>/preview.gif` (its card is its own gif) |
| Serve it locally | `just run` — http://127.0.0.1:8000. `just serve-lan` binds every interface for phone testing, but a plain LAN http:// address is not a secure context, so SCAN REPLY will not work there (use PASTE) |
| Run everything | `just test`, or `just --list` for the rest |
| Check the offline precache | `just build` — `scripts/assemble.mjs` derives the precache list from what it built and copied, and fails if a listed file is missing; `just test-pwa` then plays every game offline |
| Play locally with several peers | `just run`, open http://127.0.0.1:8000/?party, click ADD PLAYER, open the invite link in another tab, paste the reply back |
| Test reply-code **scanning** | `node scripts/test-scan.mjs` — renders a real-sized reply code into a camera frame and feeds it to Chrome as a fake capture device. Scanning needs a camera *and* a secure context, so a plain `http://<ip>` will not do; the test serves the site over `http://127.0.0.1` for that reason |
| Test installability and offline | `node scripts/test-pwa.mjs` — checks the manifest and icons, asserts the portal's layout at 390x844, asks **Chrome itself** whether anything blocks installing, then cuts the network and loads the pages |
| Test achievements and records | `just test-records` — every condition operator, malformed declarations refused, unlocking, records, merging and a sync, in Node; `just test-accounts` the account's copy and friends-only reads; `test-bots` an unlock after a real game against a bot, and the panels at 390x844 and 354x696 |
| Test that every game is playable alone | `node scripts/test-bots.mjs` — starts each game with bots and no second browser, checks the bots actually play (Connect 4 is never left an open win), and checks no peer opens a connection to one |
| Test the private-state and round layers | `node scripts/test-plumbing.mjs` — real `Room` routing over a fake transport: a sealed message is unreadable by the peer relaying it, a tampered one is refused, commitments verify, phases advance |
| Test Battleship's rules and audit | `node battleship/test-battleship.mjs` in the web-games repo (lokeshmohanty/web-games) — fleets, sinking, and the audit tested by *breaking* it four ways |
| Test Undercover | `node scripts/test-undercover.mjs` — the deal, the win conditions, and the table sizes that survive a wrong vote |
| Test Liar's Dice | `node liars-dice/test-liars-dice.mjs` in the web-games repo — wilds, the bid ladder, the at-least rule, and the reveal race that once accused an honest player |
| Test Neon Bid's rules, audit and bot | `node scripts/test-neon-bid.mjs` — second price, the reserve, tie refunds, scoring and tie-breaks, the bid audit broken six ways, and the bot measured against a random and an even-spending bidder |
| Test Neon Fission's rules and bot | `node scripts/test-neon-fission.mjs` — capacities, a three-wave chain (RULES.md's example), conversion, knock-outs only after a first turn, the chain stopping once one player owns every orb, the bot (legal, fast, takes a win; vs random and greedy players), 210 whole bot games that all end, and the same-device seats in the managed layer |
| Test the Light Cycles arena | `node light-cycles/test-light-cycles.mjs` in the web-games repo — head-on collisions, spawn symmetry, and the bot measured against a rider that only avoids crashing |
| Rebuild the app icons | `node scripts/make-icons.mjs` after editing `assets/icon.svg` — renders the PNGs the manifest needs |
| Get back to the portal | the party has a `.portal-link` ("← Games", in index.html) linking to `./`, at the left of the fixed top band once the party mounts (`.top-band`, lib/party.js); it keeps the party (LEAVE PARTY leaves it) |

Per-game recorder scenarios, the conversion profiles, and the NixOS/Playwright
traps live in the `game-previews` skill (`.agents/skills/game-previews/SKILL.md`).

Two more skills hold the traps that this document only summarises — read them
before changing either subsystem:

- `.agents/skills/multiplayer/` — the P2P layer. Its memory records why SCAN
  REPLY has failed twice, and the one test shape that catches it.
- `.agents/skills/pwa/` — installability and offline. Its memories record why an
  SVG in `manifest.icons` makes the app uninstallable, and why code is served
  from one versioned snapshot (network-first until 2026-11-14).

## The portal

The portal (`./`, the manifest's `start_url`) is the first thing an installed app shows.
**Since 2026-11-13 its cards are drawn, not written** (`lib/portal.js`): one
per game in `NeonArcade.CATALOG` — this repo's manifests and every pinned
outside repo's — so a merged registry PR appears with no edit here. Each card
has your own record on this device and, for a community game, its author. A
game is starred (☆, `lib/stats.js`) and given feedback (💬) only from
inside it, at the party's top right beside PARTY (2026-11-14; a star on the
cards was tried on 2026-11-15 and taken out the next day, Lokesh: "Only
inside games"); a contributor or a collection is starred on its own page.
Every star lands in My Games at once. **One tap on a card starts the game
against bots** (Lokesh, 2026-11-21: "directly take to the single-player game
page … this prevents the delay the user has to face waiting for party
creation"): `./?game=<id>&fresh=1&mode=bots&start=1` (`lib/portal.js`
`tapLink`), the game's remembered table at once with no room server (see
[The party API](#the-party-api), "One tap, and PLAY WITH FRIENDS"). A
one-device game (Undercover) starts at once too (`&start=1`, no bots); a
people-only game (Draw & Guess) has no bots to start against and opens
straight on its lobby with friends (`&mode=friends`). The card's SINGLE
PLAYER and a Recently played chip take the same address. (On 2026-11-18 a
tap became one: it used to take two on a phone, the first only showing the
card's two buttons; from then until 2026-11-21 it opened the game's party
screen.) The buttons, SINGLE PLAYER and MULTI-PLAYER, show on hover with a
mouse, on keyboard focus, and after a long press on a touch screen; a tap
off them closes them. A sideways swipe of a row is not a tap (a click after
the pointer moved 10px, or after the row scrolled, is dropped; a click with
no pointer behind it, from the keyboard or assistive tech, always counts).
The card's title is its button, named by the game: Enter and Space open it.
A tap outside the open ☰ menu only closes the menu. Its layout is asserted rather than
eyeballed, in `test-pwa.mjs` and `test-portal.mjs` "My Games · All Games"
(390x844, Lokesh's phone at 354x696, and 320x640); what is in each section,
in `test-portal.mjs`.

**Two sub-tabs** (Lokesh, 2026-11-15: "All favourites land under My
Games"). Under the tab row, Games has **My Games · All Games**, each an
address (`./?page=games&tab=mine` / `tab=all`); `./` opens on My Games once
the device has a favourite or a recently played game, else on All Games,
decided before the first paint ([spa.md](spa.md) "The portal's sub-tabs").
Under the brand and the party banner:

- **My Games** — Recently played (PLAY SOMETHING at its heading's right;
  its titles wrap, never scroll sideways), then ★ Favourites as a **grid
  that scrolls down**: two columns on a phone, more as the screen widens
  (Lokesh, 2026-11-21: "vertical scrollable with multiple columns instead of
  horizontal scrollable with single row"; `.section-row.is-grid`). The
  button sits in ★ Favourites' heading instead when nothing was played yet.
  With neither, a line on how to star (★, from inside a game), PLAY
  SOMETHING and ALL GAMES.
- **All Games** — the search, then Popular (with **PLAY SOMETHING** at its
  right: one tap into the single player of a popular game with bots, never
  people-only or Python, varied per visit) and the categories, each still a
  row. Each category's heading has **SEE ALL**: the genre's own page,
  `./?page=games&tab=all&genre=<id>` (`arcade`, `party`, `strategy`,
  `solo`, `other`; `lib/portal.js` `GENRES`), its title, ← All Games, and
  every game of the genre in the same grid as My Games (Lokesh,
  2026-11-21). It is a real address: a reload or a shared link opens it, and
  Back returns to All Games; so does ← All Games, as Back (no new history
  entry) when SEE ALL led there (the entry's `history.state.genreFrom`). A
  genre with no game (More games, while every game has a category) or an
  unknown id is All Games, its address fixed. No search there.

Changing sub-tab closes any card left open, so a row on the other sub-tab is
never held back as "in use" and is current when you return (review,
2026-11-16).

**The home screen is sections** (Lokesh, 2026-11-15: "show the favourites,
then the top 3~5 games based on popularity, and then pre-defined
categories"). Top to bottom (`lib/portal.js` `SECTIONS`, each with its
sub-tab; an empty one is hidden):

- **★ Favourites** (My Games) — the games starred, in the order starred,
  then the contributors and collections starred (`contributor:<login>`,
  `collection:<owner>/<repo>`) as buttons that search for their games on
  All Games.
- **Popular** — the five most played (`/api/stats/summary`, else the public
  snapshot), examples aside. The counts are kept on the device
  (`neon.plays`), so the row paints at once and in the same order offline;
  with no counts ever, the catalog's order. Counts that land late never
  replace a row someone is using (a finger down on it, a card long-pressed
  open, hovered with a mouse, or reached by keyboard): the row is redrawn when they leave it, at the
  scroll it had (`lib/portal.js` `inUse`; a slow phone had the card close
  under the finger, review 2026-11-16).
- **Arcade · Party · Strategy · Puzzle / Single player · Examples** — the
  catalog's `categories` (`scripts/manifest.mjs`); a game sits in every one
  it is in. Puzzle / Single player also takes any game one person can start
  (`seats.min ≤ 1`). **More games** catches a game no category takes.

A game therefore has several cards. Preview videos get their sources only
when the card nears the screen and play only while at least half of it is
on screen, so the home screen plays a handful, not dozens; on a phone each
section is one row that scrolls sideways inside itself (two cards and the
edge of a third), and every row (Recently played's too) scrolls to the
screen's edges while its first card lines up with the column above, with no
scrollbar. **Search** replaces All Games' sections with one grid of the
matches, one card per game; the query stays in `?q=`.

**Real-device findings (Lokesh's OnePlus, 354x696 at DPR 3.5, 2026-11-15)**,
fixed and asserted: every home tap target is at least 44px (START A PARTY
and JOIN WITH A CODE were 34px, the sub-tabs 36px); every line on a card is
at least 12px (the meta line was 9.9px; it keeps one line by dropping its
letter-spacing and narrowing the card's side margins to 4px); Recently
played and the search were 80% wide on a phone, narrower than the cards,
because their base rules came after the phone rules in portal.css. On a
phone the party banner is its two buttons (the heading said what START A
PARTY says), which paid for the sub-tab row.

**The second Android pass (the same phone, Chrome and Firefox, 2026-11-15;
fixed 2026-11-19, branch `phone-shell`)**, asserted with computed sizes
(`scripts/serve.mjs` `phoneFloors`) at 390x844 and 354x696:

- **JOIN WITH A CODE** was the browser's `prompt()`: no number keypad, a
  wrong code popped a second native dialog, and automated phone testing
  stalls on native dialogs. It is an in-page dialog now (`src/JoinCode.tsx`):
  a numeric field (`inputmode="numeric"`, `autocomplete="one-time-code"`, a
  pasted "12-34-56" keeps its digits), focus in the field and back on the
  button, Escape / CANCEL / ✕ / a tap outside to close. It stays open while
  the party joins behind it (lib/party.js `neon:code-join`): a wrong or
  expired code, a full party or no network is said under the field, and the
  next code is tried in place (the party's `joinCode`, once its
  `canJoinCode` says yes: one history entry), with no page load. CANCEL
  while a join is still meeting the party leaves you on the party screen,
  which says so; a join that ends while another view shows leaves that
  view's address alone. The code of the party you are already in shows that
  party, never "Leave this party for another?" (src/App.tsx's guard) —
  while it is live: the code of one that ended for you (removed, closed) is
  a new join, so the dialog always gets its answer.
- **A card took two taps** — one opens the game now (above).
- **Firefox with the phone's text larger** (Firefox for Android applies the
  system font size as text zoom, px included): the in-game top buttons ran
  into ← Games and the portal's tabs ran under ☰. The game's top band is one
  row (`.top-band`) and ← Games becomes its arrow alone when its word does
  not fit (the word clipped, not hidden, so the link is still named "Games"); the portal's tabs scroll sideways inside their column, the
  sub-tabs wrap. Held at 130% and 200%, at both sizes (test-party,
  test-portal, in Playwright's Firefox).
- **The game's frame stayed light under a dark page** — in Chrome too.
  Paper following the system is the default, and `sdk/v2/runtime.js` wrote
  the choice, "system", into the frame's `data-mode`, which matches no
  theme block; it writes what shows now (`theme.dark`). test-theme checks
  every theme in Chrome and Firefox.
- **The shell's chrome over a game** was under the floors: the top band 33px,
  the end card's DETAILS 32px and its "you" and captions 11.5px, the party's
  TEAM and REMOVE buttons 32px and its tags 10.4px. All 44px and 12px now
  (test-party, test-managed).
- **Inside the six community games** (lokeshmohanty/web-games, pinned at
  2c64576, 2026-11-20): Draw & Guess's pens and brush sizes were 28px
  `<div>`s (44px buttons now), CLEAR 28px, the guess field and SEND 38px;
  labels, ship buttons, racer names, seat names, scores and the bid's
  caption were 9.9–11.5px; Battleship's end put NEW GAME off a 354x696
  screen. Its ship rack and buttons keep one row each from 354px wide, so
  placement squares stay 39.6px at 354x696 and 40.4px at 360x640.
  Five in a Row and Snakes & Ladders joined them (web-games branch
  `new-games`, 2026-11-22; test-taps plays your turn, a game zoomed in and
  out with a ghost waiting, your roll, a move playing and each end). A
  block for a game the registry's pin does not have yet skips, saying so
  (`scripts/serve.mjs` `communityHas`), so main stays green between the
  games repo's merge and the pin's.
  The three games of lokeshmohanty/card-games joined them (branch
  `card-games`, 2026-11-23): each one's settings screen at friends' first
  game (host and guest), a one-tap start straight into play on the
  settings kept on the phone (the settings only the first time, Lokesh
  2026-11-23, as Ludo), Glowdown's turn, a pick, a hand of 9 fanned in
  rows and eight players with a hand of 30; 29's bid, trump pick, asking for the trump and turn;
  Guess What's clue-giver, guesser, answer and one-phone screens; and each
  end's "Next game: … · CHANGE" with its choices above the tucked end card.
  Their blocks (and test-bots') skip, saying so, only while the registry
  does not list them (`scripts/serve.mjs` `registryLists`); listed but
  missing fails.
  `just test-taps` (CI shard 5) plays every phase of each and holds the
  whole frame to `phoneSizes` (390x844 and 354x696, in `scripts/serve.mjs`)
  with `phoneFloors`' `hit: true`: box and hit area, every enabled control
  plus `cursor: pointer` elements, and a covered target fails unless the
  step covers it on purpose (`under`); it also tests phoneFloors itself on
  pages made to trip it. Exemptions are scoped by window width (`upTo`)
  and printed with their reason when they let something through: Sudoku's
  cells are 36px at 354 and 40px at 390 (a tap only selects; digits come
  from a 48px pad), its pencil notes 11px at 354; Battleship's squares
  under 390px wide (44px from 390).

Not covered by that pass: the leaderboard view still scrolls sideways at
200% text, and it and Contributors keep a few labels under 12px
(9.6–11.5px); iOS remains unverified. **UNSURE:** the long press that shows
a card's two buttons on a touch screen is the browser's `contextmenu`,
tested only as that event: unverified on a real Android phone, and Safari
on iOS fires none, so there it shows nothing. Lokesh's call (2026-11-18)
stands either way: one tap plays the game (since 2026-11-21, against bots),
and PLAY WITH FRIENDS (end card, PARTY) offers the other choice.

**Nine games have to fit a phone.** They did not: a `minmax(300px, 1fr)` column
at 80% width is a single column on a 390px screen, and a 200px image plus a
heading plus a paragraph plus a button is taller than the viewport — you
arrived at one card. Below 560px a row holds two cards (the search's grid two
columns), the artwork is a
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

**Tags and search.** The filter chips are gone (2026-11-15): the sections do
their job. Each card still carries `data-tags`, and the search reads them
(`tag:quick`, `type:duel`, `players:4`, `author:`, `from:`; `lib/portal.js`
`parseQuery`). The tags are `alone` · `duel` · `party` · `one-phone` ·
`strategy` · `quick`, and a new game should be given whichever apply. A
search matching nothing says so rather than leaving a blank page.

**The search box says only "Search games"** (Lokesh, 2026-11-21: "don't
mislead by displaying them in the placeholder"). It used to read "Search —
or author:name type:duel tag:quick players:4". The fields work (test-portal
"search"), but the placeholder misled two ways: `author:name` taken
literally matches no author, and a phone's keyboard puts a space after the
colon, and `type: duel` found nothing. A space after the colon is now the
same field, and a field still waiting for its value (`author:`) narrows
nothing yet. The fields stay, unadvertised in the page: a starred
contributor or collection is opened as one (`author:`, `from:`).

**First visit: a name** (Lokesh, 2026-11-21: "first time a user enters, pop
up asking for his name (default: random two word title case name), with a
button to generate a new random name"). Once per device, over the portal,
an in-page dialog (`src/NamePrompt.tsx`, `.neon-sheet`; never `prompt()`):
the field holds a random two-word Title Case name ("Brave Otter"), NEW NAME
rolls another (never one shown already in that dialog), THAT'S ME keeps the
field. Focus starts in the field (selected) and goes back where it was;
Escape, ✕ or a tap outside keep the *suggested* name, not a half-typed
edit. Whichever way it closes, the name is saved where the party reads it
(localStorage `neon.name`, `NeonArcade.rememberName`), and a party already
running behind the portal takes it at once (`room.setName`), so it never
asks again; a name typed on the party screen counts too. A signed-in account
with a display name is not asked: that name is saved. The names
(`lib/names.js`) are an adjective and an animal, a thing from nature or a
small object, kept kind, about 220 × 280 words (some 63,000 names within
the 16-character name field). **The default name is one of them**:
`NeonArcade.defaultName()` (lib/net.js) is this device's own random name,
chosen once and kept (`neon.defaultName`), never the device ("Android",
"Linux") it used to be. **Automation:** under `navigator.webdriver` the
dialog stays away, as the rules sheet does (lib/rules.js), so no suite is
stopped by it; localStorage `neon.namePrompt` = `"on"` brings it back
(test-portal "a first visit asks for a name"), `"off"` turns it off
anywhere. Asserted at 390x844 and 354x696.

## Contributors and collections

*Lokesh, 2026-11-15: "Contributors can share multiple game repositories …
add a collections page … always sorted by popularity. Both Contributor and
Collections can be favourited."*

A **collection** is one games repository the arcade lists: an outside one
pinned in `registry/<owner>/<repo>.json`, and the arcade's own
(`lokeshmohanty/games`). Every catalog entry carries its `repo`, so the
collections are derived, never listed by hand (`lib/collections.js` `list`).
A contributor (a GitHub login; `NeonArcade.CONTRIBUTORS`, merged to one per
person) can own several.

- **Collections** (`./?page=collections`, `src/views/Collections.tsx`): one
  card per repo, **most played first** — the sum of its games' plays from
  `/api/stats/summary` (else the public snapshot), the same counts the
  portal's cards show; ties by `owner/repo`. Each card: name, owner, games
  and plays, up to three posters (the ~5 KB webp, never a gif) and a few game
  names, ★, SEE ITS GAMES and the repo on GitHub.
- **Contributors** (`./?page=contributors`): one card per person — their
  games and the games' total plays, each of their collections (games, plays,
  a link to its games, GitHub, and CHECK FOR UPDATES when it is pinned:
  `lib/propose.js`), their profile links, ★.
- **A collection's games** are the portal searched by
  `from:<owner>/<repo>` (`lib/portal.js` `matches`: a `from:` value with a
  slash is a repo; without, still arcade, community or an owner).
- **★ favourites** go in the same list as games' (`lib/stats.js`,
  `neon.favs`) as `contributor:<login>` and `collection:<owner>/<repo>`;
  games keep their plain ids. Starred cards come first on each page, the
  rest keep their order. Signed in, they sync like game favourites
  (`/api/me/favs`; the worker accepts the two prefixes since 2026-11-15, no
  migration). A worker from before that refuses the list with 400, and the
  page then sends only the games', so a stale deploy never stops game
  favourites syncing. The profile lists them as `@login` and `owner/repo`.
- The cards are made once per visit and moved, not redrawn, when a star or
  the counts arrive and reorder them (a CHECK FOR UPDATES answer stays). The
  four tabs fit 390 px (and 360) with a narrower tab below 480 px
  (`lib/styles.css`). Tests: `test-portal.mjs` "contributors" and
  "collections"; `test-stats`, `test-accounts`, `test-social` for the ids.

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

`NeonArcade.scanQr({ onResult, onError })` returns `{ video, stop }`: mount
`video`, and always call `stop()`. `onError` is always delivered
asynchronously, so `scanner = scanQr({ ... })` has finished assigning before
any callback can try to clean `scanner` up. Camera access needs a secure
context, so scanning works on the deployed `https://` site and on loopback but
not over a plain `http://` LAN address; the lobby says so and falls back to
pasting.

### Connectivity

Moved here from lib/README.md on 2026-11-15; net.js is the code.

- **Relayed signalling.** Once any link exists, offers and answers for every
  further pair travel over it (`_openRelayed` in `net.js`), which is why the
  mesh costs a player nothing the star did not. The host is a field in the
  party record, not the shape of the network.
- **Relayed messages.** A pair that cannot connect directly is not fatal:
  messages to it are relayed through a member who can reach both, capped at two
  hops and deduplicated by envelope id. A relayed negotiation that has not
  opened after 15 s is abandoned and, the first time, tried once more the other
  way round ([Honest gaps](#honest-gaps)). Nobody offers to a seat held for a reconnect until
  its owner is back.
- **Big messages.** Anything over ~12 KB is chunked and reassembled, and sends
  pause when the channel's buffer fills, so per-frame broadcasts cannot grow it
  without bound. A part is `{ __c: <chunk id>, i, n, p }` and is told by that
  whole shape (`fromWire`, at most 1024 parts), never by `__c` alone: the
  election's request is `{ __c: <vote key>, … }`, and until 2026-11-18 every one
  sent over a real link was taken for a part and dropped.
- **STUN is the only outside contact** (`stun.cloudflare.com`,
  `stun.l.google.com`), used to discover each peer's public IP:port; it never
  sees game data. Pass `iceServers` to `createHost`/`createGuest` to override,
  or set `localStorage["neon.stun"] = "host:port"` (or two, comma-separated)
  for a whole session — the NAT lab's hook (`scripts/test-nat.mjs`), STUN only.
  Deliberately not a query param: a link anyone can send must not choose a
  player's STUN server.
- **NAT classification.** `NeonArcade.classifyNat(iceServers?, { fresh }?)`
  asks those two STUN servers (two hosts, two ports) where one local socket
  appears from, remembered per set of servers unless `fresh`. Two public ports
  for one base mean a **hard** NAT (endpoint/port-dependent mapping), which
  connects only as the ICE offerer. Resolves `true` (two ports for one base, at
  once), `false` (an address family with one mapping and no STUN error of its
  own, 2 s after its first mapping or at gathering complete — another family's
  timeouts do not veto it), or `null` (fewer than two servers, every mapped
  family erroring, nothing by 5 s). No traffic but STUN to servers already
  configured. room-join stores it as `room.natHard`, marks that side's offers
  `h.`, and its glare rule lets a hard offer stand over a plain one
  ([room-server.md](room-server.md), "Who offers to whom").
- **Gathering** stops shortly after the first server-reflexive candidate rather
  than waiting for `complete` (the rest is usually redundant interfaces), which
  is what makes the invite QR appear promptly. Candidates are otherwise kept,
  including `.local` mDNS ones: peers resolve them over multicast DNS, and on a
  LAN with no route to STUN they are the only way two browsers connect. The one
  exception is the ICE-TCP `tcptype active` placeholder, which two browsers can
  never pair.
- **No TURN server**, deliberately: running one would reintroduce the
  dependency this design removes. Networks that block direct connections
  surface as an explicit error rather than an indefinite wait. To cover them
  anyway, pass a TURN entry in `iceServers`.

### Who said it: signed party messages

Since 2026-11-18 a member's id proves itself, and so does every message that
counts. Before, the sender field `f` was whatever the sender wrote: a relay
could speak as anyone, a member could evict another, crown itself with a
higher-term record, or forge election votes. lib/net.js is the code; the
skill memory `signed-messages.md` keeps the reasons.

**Lokesh's decisions (2026-11-18), settled:**

1. **An id is its key's hash.** Each member has an ECDSA P-256 key pair; the
   private half is non-extractable and kept in IndexedDB (`neon.keys`). The id
   is base36 of SHA-256 of the raw public key, 16 characters. The public key
   crosses a link once it opens, so **codes do not grow** beyond the longer
   id (16 characters instead of 10 or 12).
2. **What is signed: control messages and anything relayable.** Game traffic
   over a direct link is proven by the link's owner, with no per-message
   signature, so the 15–30 Hz real-time paths cost nothing.
3. **Old clients are refused, with no transition window.** An old phone
   cannot join or stay, and both sides are told, never left waiting.
4. **The key is per tab session.** sessionStorage (`neon.key`) names the key
   a tab plays as, so a reload keeps the id (reload-mid-game) and a second
   tab is a second player. The room server's rejoin token holds the id, and a
   rejoin loads that id's key (`NeonArcade.identity({ id })`). A browser
   without IndexedDB gets a key for the page only; its id changes per load.
   A page holds the Web Lock `neon.key:<id>` while it is shown (it lets go
   going into the back/forward cache, and takes it back on return). "Duplicate tab"
   and `window.open` copy sessionStorage, so a tab whose key another live
   page holds mints its own (a reload waits up to 1.5 s for its
   predecessor to let go). A rejoin may borrow a key another tab holds, for
   that seat only: the room server then decides which tab keeps the seat
   ("open in another tab").

**API.** `await NeonArcade.identity()` is this tab's identity (`{ id, pub,
sign }`); `{ id }` loads one this browser holds (or null); `{ fresh: true }`
makes another (tests, a second room in one page). `createHost`/`createGuest`
**require** `{ identity }`; `hostRoom`/`joinRoom` find it themselves.
`NeonArcade.isMemberId(id)` tells a member id from a bot's or an old client's.

**A link proves its owner (the hello).** When a data channel opens, each side
sends `{ __hi: 1, k, s }` before anything else: `k` is its raw public key,
`s` signs `"neon-link|" + <the far side's DTLS fingerprint> + "|" + <its own>`,
the fingerprints of this RTCPeerConnection's two descriptions. The receiver
checks the fingerprints against its own connection, the signature, and that
the key hashes to the id the code or relayed offer named (`link.peerId`).
Only then is the link registered (`_linkOpened`), and nothing but the hello
is taken before. So the hello is good for this connection only, and a member
who relays an offer under somebody else's id, then answers it itself, gets a
link that closes unregistered (the relayed-offer hijack). A side never talks
before its own hello has left, or the far side would take it for an old
client.

**A hello survives a loaded machine** (CI and a loaded laptop, 2026-11-21).
These four fixes made joins and rejoins that hung on slow runners finish:
- **It waits for both fingerprints.** A channel can open before the far
  description reads back as set, and a hello signed over an empty
  fingerprint was refused as forged. A hello now waits for the description
  we set, and briefly for both fingerprints to show.
- **It is said again.** The first message an answering side sends on a fresh
  channel was seen lost while the next one arrived. A hello is now said again
  every 700 ms until the far side answers on the link.
- **A message that overtakes it is kept.** A signed message that arrives
  before the hello comes from a current client whose hello went missing. It
  is kept and taken in order, before anything that arrived while the hello
  was checked. At most 64 messages and 1 MB may wait; past either, the link
  is refused. An *unsigned*
  control message is still an old client, refused at once.
- **Two links for one pair settle on the same one.** Both sides keep the
  same link, the lower id's offer (then the DTLS fingerprints decide), rather
  than "the last to open". With a hello to wait for, each side had kept the
  link the other closed.

A hello that never comes in `HELLO_MS` (6 s) still ends the link, saying the
peer did not say who they are.

**A message counts only if its sender is proven** (`_authentic`):

- it came over the link whose owner is its sender (`f`), or
- it carries the sender's signature: `k` (whose hash must be `f`) and `s`
  over the canonical envelope. That is the envelope with keys sorted at every
  depth, minus what a relay may change (`h`, `m`) and minus `s`, `k`, `cp` and
  `fw`. Verified keys are cached per id.
- **It is for this party.** The founder mints a party id (`pid`, in the
  record), and every signed message carries it (`pa`). A message signed for
  another party is refused, so an old party's `__x` or a certificate won in
  another party counts for nothing here. A newcomer learns the id from its
  first record.
- A bot's message (`f` a `bot_` id) counts only from the crown: `o` names the
  host, the host sent it (on its link, or signed), and the bot is in its
  record.
- Game traffic counts only from a member of the record: anybody can make a
  key, and a stranger's signed message carried in by a member used to reach
  the game. A proven sender not yet in our copy (its record is still on the
  way) is held 3 s for the record that seats it, so a first move is not lost.
- `seen` (the duplicate filter) is keyed by sender and id, so a member cannot
  send something of its own under the id another's message will carry and
  have that one dropped as a copy.

Everything else is dropped and counted (`room.refused`, `room.refusals`).
Relays forward signatures untouched. A link's messages are handled in order
even while one waits on a verification, and our own sends keep their order
behind a signature (one queue per room). An acknowledgement (`__ka`) is
verified even on its sender's own link, because it is kept as proof.

**What a proven sender still may not do.**

- `__k` (evict) and `__x` (close the party) count only from the crown.
- **Replays.** A signed message can be sent again by anybody, and the `seen`
  window (512 ids) rolls over in seconds at 30 Hz, so freshness is bound to
  state, not to that window:
  - `__k` and `__gone` name a seat by its `joined` (`j`), so a replay after the
    member came back names an old seat and is refused;
  - `__x` carries the crown's term (`tr`), and a party past that term ignores it;
  - records carry `rev` (below);
  - a seat introduced by somebody else that never proves itself (`pend`) is
    dropped after 30 s, so a replayed introduction seats no ghost.
- **A record (`__p`) is its host's word.** `f` must be its host, except the
  record a host sends as it hands the crown over (`transferHost`). Beyond a
  newcomer's first record, a record is taken only if its crown is proven
  (`_proven`):
  - it is the holder whose own record we last took, at that term; or
  - it carries `cp`, an **election certificate**: the quorum of signed
    `__ka` the election already gathers, and `rec`, the vacated holder's own
    signed record that the election's key was made from. **The key is never
    taken from the certificate.** It is rebuilt from `rec` (`voteKeyOf`, the
    same function voters use), and `rec` must be of the term before, signed
    by its own host, and proven itself:
    - either it is a record of that holder we took, or newer (never an
      older one: an early, smaller roster could make one voter a quorum);
    - or its own proof checks back to one we hold.

    So a member cannot write itself a key with only itself as human (review,
    2026-11-19). A record older than the latest of that holder's we hold
    counts only if its humans include every human of the latest, since a
    smaller roster makes the quorum easier. The candidate's own vote is its
    record's signature; or
  - `cp` is a **hand-over**: the previous holder's signed record naming this
    one, itself proven the same way. The new holder must be a voting (not
    `pend`) member of the record handed over, and of our record of that
    holder where we hold one. A self-vote wrapped in hand-overs through a
    key made for the purpose and back was taken (re-review, 2026-11-19).

  Proofs nest — a certificate carries its record, and that record its own
  proof — up to three crowns back (`PROOF_DEPTH`). So a phone asleep through
  two changes of host checks the chain back to the record it holds, and
  follows. A newer crown it cannot follow back far enough is not followed, and
  the player is told once: "This phone missed changes of host it cannot
  check. Reload the page to rejoin the party." (onError, reason `behind`).
  Without this, a phone went its own way in silence. Only a well-formed chain
  cut short (`_proven` says "far"), and signed by members we seat, prompts. A
  junk or forged record is refused quietly, or any member could make
  everyone reload.

  **A phone never accepts that a holder has left while it is that holder,
  or still sees it** (Lokesh, 2026-11-20: "Refuse it"). This applies to
  every election certificate, at every depth of a proof, exactly as an
  honest voter refuses to grant. Before this, two members, or one member
  with an extra room in its page, signed a quorum and deposed a host its
  whole electorate could still see (round 4).

  **"Sees" means a link to it that never dropped** (`_sees`). A link that
  opened after ours had closed, or while its seat was held for a reconnect,
  is that key here again, not that holder still hosting. It counts as seeing
  only once that holder speaks as host again. Without this, a phone that
  relinked to a reloaded old host before the new crown's record reached it
  held that crown back for good (round 5, R). This gives up the protection
  only for a phone whose own link to the host dropped and re-formed, which an
  attacker cannot schedule.

  **A refused certificate is held back** (`unseen`) and looked at again
  whenever a link opens, closes or goes with its seat. It is taken when one
  of these holds:
  - **We no longer see the holder:** our link to it closed, or it re-formed
    after a drop.
  - **The election shows a healed partition.** We are the holder, or still
    see it, but the candidate and every voter are members we ourselves
    concluded gone and now link to again, both after we took the record the
    election was won from. "Concluded gone" (`_confirmGone`) means no link,
    and nobody vouching for them, for the whole departure grace (2.5 s). A
    member that closes and re-dials its own links never shows that: within
    the grace it is back before we conclude, and one link at a time the
    others vouch for it. Bounced links once posed as a healed partition and
    let G3 back in (round 6, B6). Only a quorum genuinely cut off from the
    host's side for longer than the grace qualifies (round 5, S). The old host
    then steps down and follows the elected one, and so do the members
    linked to it. A colluding quorum can stage this on purpose: drop every
    link to the host's side for longer than the grace, then come back
    crowned. From the host's side that is a real partition, and players see
    those seats drop or show as reconnecting meanwhile (round 7).

  What this costs and does not cost:
  - **The cost is bounded.** In a real partial split with the host alive,
    the host's side and the elected side are two working parties until the
    partition heals, or the links that broke are noticed and closed. The
    host's side is not a hang: its host hosts and its members follow it.
    One limit: if the host's side commits more than 64 records during the
    partition (`REVS_KEPT`), the record the election was won from is no
    longer held. The heal then fails, and the two parties stay apart until
    someone reloads.
  - **An honest election is not slowed by it.** A member still linked to a
    host that really died vouches for it until its own link closes, which
    already held the vacancy back. When the link closes, the held crown is
    taken.

  **A hand-over and an election on the same vacancy exclude each other.**
  Whichever a phone learns second, it refuses:
  - **an election after a hand-over:** a holder that handed the crown over
    left no vacancy, so no election on its record counts for the term it
    handed over at (`handovers`, learnt from the hand-over record and from any
    proof carrying it);
  - **a hand-over after an election:** a holder whose vacancy we took an
    election crown for may not hand that term on afterwards (`elected`). Only
    a crown taken counts: a commit that never crowned, the holder staying,
    must not refuse its later MAKE HOST for good (round 6). A host that vanished (a reload: its key lives on) once
    signed a hand-over later, to its own extra key, and took an elected, live
    crown back (round 5, K).

  The cost (accepted, round 5): the honest race now splits instead of
  healing. MAKE HOST, then the old host crashes before the hand-over has
  spread, while the far side elects: each phone keeps whichever crown it
  learnt first. It is rare.

  **Where two crowns meet at one term** otherwise, how each came decides it,
  whatever the ids: a hand-over outranks an election others attested, and
  that outranks one won by the candidate's vote alone. Only between two
  crowns that came the same way does the lower id decide. A crown won by its
  holder's vote alone (half the humans, and the tie-break heir) also never
  displaces a crown we hold at that term (round 3).

  **On an older record of the vacated holder's** than the latest we hold (one
  of the last 64, and a superset of the latest's humans), only acks from
  humans still in the latest count. The older record's humans stay the
  denominator, so the quorum only gets stricter. A seat that joined, was
  counted, and left had voted on.

  **What remains.** A quorum of real keys can still win a real vacancy. It
  cannot depose a host its electorate can still see over links that never
  dropped. Two exceptions:
  - a phone whose own link to the host dropped and re-formed no longer
    counts as seeing it;
  - a healed partition's election is taken by design.

  A vanished host cannot take back, by a later hand-over, a crown elected on
  its vacancy. A member with extra real connections (tabs or in-page rooms,
  each with its own key and links) has extra votes in a genuine vacancy.

  Without this, "a higher term wins" let any member crown itself by signing a
  record. From the holder already known, only a newer record (`rev`, which
  rises with the clock across a reload) is taken, so a replayed old record
  cannot roll the party back.
- **A seat votes only once a link of its own proves it.** Until then it is
  `pend`: it plays, and an election does not count it (`_voteKey`,
  `_successor`, `heir()`, `transferHost`). There are two levels:
  - **1: seated on another member's word** (an introduction). Unless it
    speaks for itself within 30 s, the seat is dropped, so a replayed
    introduction seats no ghost.
  - **2: it spoke for itself, but through a relay.** Its `__i` came in carried
    by a member: a key exists, not a second device. A member once made three
    keys "speak for themselves" through it and won a quorum with their votes
    (re-review, 2026-11-19).

  Only a hello-verified link clears the mark:
  - the host's own link to it opens;
  - its `__i` reaches the host over that link;
  - the host commits a record while holding such a link (a crown changing
    hands keeps the old marks).

  `by` names the member whose word or relay it came on. That member's
  `__alive` does not settle a suspicion about it. **Inherent:** a member that
  runs real extra peers has that many votes, each with its own key and
  hello-verified links. Extra tabs work, and so do extra in-page rooms over
  real WebRTC links. A vote costs a real peer connection, not a real device.
  Only a real-world identity could stop that.
  Introductions are broadcasts now. A member used to re-address an `__i` to
  the host it knew, and that would break the signature.
- The newcomer's first record is the host's own signed envelope, handed on
  by whoever linked it and marked `fw`. It gives the newcomer no vote: a page
  reloaded mid-vote must not grant twice. Established members ignore `fw`
  copies. **A first record is trusted**, since a fresh page has nothing to check it
  against. One that its deliverer wrote about itself (`{ host: <deliverer> }`)
  is taken only over a link to the member the newcomer meant to reach
  (`link.named`): the inviter whose invite it answered, or the member the
  room server named, whichever side offered. Any other first record, the host's handed on by a member,
  is taken on that member's word.
- Games: a managed game's `v:m$act`/`v:m$in` now carry a proven seat; a
  guest cannot act as another seat or a bot. lib/bridge.js takes a web app's
  `p$httpr` only from the member it asked, and `p$addr` (the app's address)
  only from the host (Lokesh, 2026-11-20: "host-only"; a guest's navigation
  moves its own screen only). A phone the crown passes to says its address
  at once (the bridge's `onRoster`), so the party follows the new host's.

**Old clients.** A peer that talks before saying hello is a build from
before signing (an ordered channel, and a current client always says hello
first). After `HELLO_MS` (6 s) of silence, so is one that never speaks.
- **We are in the party, the old peer is joining or staying.** We send it an
  unsigned `__k` naming it, which old code takes as an eviction ("You were
  removed from the party.").
- **The old peer is the party, we are the newcomer.** We do not evict
  anyone from their own party. We say goodbye (`__gone`) instead.
- **Codes.** An invite or reply whose id is not 16 characters is refused
  at once: "That reply came from an older version of the arcade. Ask them to
  reload the page to update". That needs no byte more in the code.

What the old side sees is not always "reload" (deviations from "both sides
told", 2026-11-18):
- An old member refused by a new party sees only what old code can show:
  **"You were removed from the party."**
- **An old newcomer gets nothing.** A new party refuses its code, and its own
  client says "Nobody in that party answered" after 30 s.
- **A party mid-deploy fractures until everyone reloads.** Old phones keep
  playing with each other and new ones with each other; neither side can
  link to the other.

Our own player is told on `onError` (reason `outdated`; `outdated-self` if
the far side is newer), naming who where it can: "<name> is on an older
version of the arcade. They need to reload the page to update." A code join
ends with that message at once, not "nobody answered" 30 s later.

**Costs** (measured 2026-11-19, a Ryzen 7 5875U laptop; per operation):

| | Node 24 | Chrome | Chrome, CPU ×4 | Chrome, CPU ×6 |
| --- | --- | --- | --- | --- |
| sign a control message | 70 µs | 76 µs | 216 µs | 299 µs |
| sign a 6-member record | 86 µs | 113 µs | 258 µs | 340 µs |
| verify a relayed message (key cached) | 125 µs | 113 µs | 352 µs | 494 µs |
| an unsigned message on its sender's link | 1 µs | 2 µs | 2 µs | 6 µs |
| a new key pair and its id (stored) | 0.35 ms | 1.8 ms | 9.5 ms | 28 ms |

Chrome's CPU throttling slows the page's thread, not WebCrypto's own, so
the throttled columns are a floor for a phone, not a measurement of one
(VERIFY on a real mid-range Android). Expect around a millisecond per
signature or verification there. Signatures are made for control messages
(rare) and for game traffic only when it must be relayed. At 30 Hz that is
30 signs a second on the sender and 30 verifies a second on whoever receives
it relayed: a few percent of a phone's CPU, and only on a pair with no
direct link. Direct game traffic costs a field read.

Tested in test-plumbing "who said it" (every forgery class, and each one seen
failing on unsigned routing first), the crown and hand-over tests under
"membership and the crown", and test-party "signed messages". That test has
four tabs, fully meshed. The host's tab dies and the heir is elected by
signed grants and acknowledgements over real links (its certificate is
checked). It also covers ids per tab, an id surviving a reload, and an old
client's reply refused on screen.

## Parties

The party (`./?party`, lib/party.js) is the shell that keeps a group together. Because every game is a
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
- **PARTY, mid-game** — a pill top-right while a game runs pulls the party
  screen up over it (the game keeps running underneath): BACK TO GAME for
  everyone, END GAME (asked first) for the host. Picking another game from
  there asks too, since it ends the one running.
- **A turn game waiting on a lost player** (Connect 4, Liar's Dice)
  says so: "Waiting for X — reconnecting (0:30)" for everyone. After 30 s the
  host decides — WAIT (another 30 s, for everyone), SKIP TURN (the game's own rule
  for passing a turn) or END GAME (asked first). Lokesh chose
  "host decides" over a bot taking the seat. The seat itself is still held for
  the full grace; a player who leaves for good is handled by each game
  (Connect 4: the side that stays wins). The collecting games (Battleship, Neon
  Bid, Draw & Guess) never stall — their phases have deadlines.
- **Leaving the app** (another app, a locked phone). The screen is kept on while
  a game runs (Screen Wake Lock), since a phone that dims suspends the page. A
  hidden page publishes `away`: the roster says AWAY and a turn game's banner
  says "switched away". A host out of the app stops its simulation anyway — a
  hidden page gets no frames — so a game the host simulates (Neon Survival)
  pauses for everyone and says why, takes no input meanwhile (it used to land
  all at once on return), and resumes after a 3-2-1. Lokesh's choices,
  2026-11-13.

### When the host goes

The party outlives it. A dropped link is not assumed to be a departure: the
party probes first, and anyone still connected to that member vouches for them.
Only silence counts as gone, and that conclusion is broadcast so everyone drops
them together.

Leaving on purpose is not a dropped link: `room.leave()` broadcasts the
leaver's own `__gone` first, so everyone drops the seat (and passes the crown,
if it was the host's) immediately. A reload or a closed tab never calls it.

**Every way out asks first, and everyone left is told** (lib/lobby.js
`guardParty` / `leaveParty` / `presence`). The fixed "← Games" link, ALL
GAMES, NEW PARTY, HOST A NEW GAME, opening another party's link, and the back
button or swipe-back (a history entry of the page's own, pushed on the first
tap — Chrome skips one pushed without a gesture) all raise the same in-page
question, which names the heir for a host; REMOVE and MAKE HOST ask too. The
question is a `<dialog>`, never `confirm()`, which would freeze the host's game
loop and relaying for everyone while it was up. A tab close or reload can only
get the browser's own "Leave site?" prompt, and only with another person in
the party; going ahead is not a leave — the seat is held, as a reload should.
The party shell asks even a host who is alone (the party ends) — except in a
party a game page opened, where one person against the bots is never asked.

Everyone else gets a toast, over the game if one is running: who joined, who
left and how (on purpose, lost connection, removed by the host), who lost
connection and came back, and who holds the crown now. A reconnecting mark or a
crown move is announced only if it still holds a moment later (2.5 s / 1.2 s),
so a blip that heals is not news.

If the host was the one who went, the longest-present remaining member (ties
broken by id, so everyone nominates the same person; bots and reconnecting
seats skipped) **takes the crown automatically** — no offer, no button.
`room.heir()` names that member beforehand, for the host's leave prompt. The
only thing that ends a party is the host explicitly choosing DELETE PARTY.

The party record carries a crown **term**. The member who takes the crown (or
the host who hands it over) bumps it and publishes; everyone else only
*computes* the heir and waits for that record. Ordering records by term is what
reconciles two hosts:

- a higher term always wins — a host cut off by a partition steps down when it
  hears the newer record, and introduces the members only it could reach to the
  new host;
- two hosts at the same term (both sides of a partition crowned someone) settle
  on the lower id, which every browser agrees on;
- a member that computed an heir yields to a host still speaking at the old
  term, which is how a false "the host is gone" heals.

**A split party: one side carries on, never two** (Lokesh, 2026-11-16
"heir side only", and 2026-11-17 "skip hidden + quorum"). The host's departure
can leave the rest in pieces that cannot reach each other: two guests that
talked only through the host (no TURN, by design), or a re-dial that had not
landed yet. The heir is named by `_successor` from the roster the host last
published (`lastRecord`). Every input comes from that record and none from
this browser's own copy, which a probe, a relink or a goodbye may have
changed since, so every piece names the same member. A review found two
pieces naming different heirs, and both crowning, because one read a held
seat that its relink had cleared. `_successor` skips:

- held seats (`reconnecting` on the record);
- heirs already passed over;
- while anyone else could take it, members whose phone is in the background
  (`away` on the record, from `visibilitychange`).

A member gone by its own goodbye since the record is not on the record
either: if it was the heir, it is passed over after the wait.

**An election decides who may crown** (2026-11-17/18; Raft's vote, without
terms). It has two phases.

1. **Grants.** The member named stands: it grants itself and asks everyone
   (`__c`). Every member grants **one** candidate per vacancy (`__gr`). A
   candidate counts grants only inside the heir's wait from when it stood.
2. **Commit.** With a quorum of grants, the candidate commits (`__ck`). A
   voter that still holds its grant to that candidate acknowledges (`__ka`),
   and is then bound to it for that vacancy **for good**. From then on the
   voter's grant never lapses, it grants nobody else, and it acknowledges no
   other commit. The candidate crowns only on a quorum of acknowledgements.

A quorum is more than half of the record's humans, or exactly half with the
tie-break heir among them. The old crown holder is left out of both sides of
the fraction.

**Why there is never a second crown.** Any two quorums of one vacancy share a
member, and that member acknowledges at most one commit, so at most one
candidate ever crowns, however late its record gets out. Grants alone were
not enough. A winner whose record never left kept its voters only until
their grants lapsed, and then a second candidate won too (2026-11-18). An
earlier version counted who had said "here" through the mesh instead. A
member that reached both sides before a split was counted twice, which gave
two crowns, and three once. Any presence count fails like that.

**Messages are re-sent and flooded.** Election messages are not acknowledged
by the transport. A candidate repeats its request or commit every 2 s
(`REASK_MS`) while it matters, and says a release three times. Voters answer
a repeat as they answered the first. The messages go round the whole mesh
rather than only to the members the sender could not reach itself, so a
half-dead link loses none of them.

Members vote only on an equal key: who left, the record's term, the
tie-break heir and the record's humans. Two records of one term can differ,
and different fractions could both be met.

The tie-break heir is the oldest of those humans by `joined`, whatever their
`away` or held seat. Those marks change within a term, and a review got two
crowns from a record marking the first heir away that reached only one side
of a split: the two keys differed in the tie-break alone, and each side won
its exact half. `away` and held seats still steer who is *named*, never who
wins a tie.

A page with no record heard from a crown holder (a fresh reload, a newcomer)
has no vote. That is also what stops a page reloaded mid-vote from granting
a second candidate: its grant died with the old page, and so did its record.
It waits for the crown's record, and is lost after the heir's wait. A member
still linked to the host that left grants nobody, because the host is not
gone for it.

**Grants lapse, unless acknowledged.** A voter frees its grant twice the
heir's wait after it was asked, on its own clock, unless it acknowledged that
candidate's commit. A candidate counts grants only inside the heir's wait
from when it stood, by both its monotonic and its wall clock. A voter
acknowledges only while it still holds the grant. The candidate waits for
acknowledgements until every grant it holds could have lapsed, then gives up
and releases the rest. Crown safety rests on the commit, not on these clocks.
The clocks only keep a quorum of grants meaningful when the commit is made.

- **Background clocks.** Timers can only fire late, which frees a grant
  later. That is safe.
- **Relayed delivery.** A relay only delays the request, so it is also safe.
- **A device asleep.** A sleeping device stops the monotonic clock but not
  the wall clock, so the candidate checks both.
- **Residual.** A backward jump of the wall clock during a candidate's sleep
  could defeat both checks.

**Liveness.**

- **A candidate that dies before committing** never releases. Its grants
  lapse, and the next in line is elected after about twice the heir's wait
  (about 20 s).
- **A candidate that dies between its commit and its crown** leaves the
  voters that acknowledged bound to it for good. That quorum cannot elect
  anyone else, so the window is narrower, but it costs the vacancy.
- Members that granted a named heir wait for their grant to lapse before
  naming the next.

**A refused request is kept.** It is refused while the voter still holds the
link of the member that left, or while the voter's grant is given. It is
granted when that changes (the link drops, the grant lapses or is released),
if it is still young enough to count.

**Waiting, standing aside, and being lost:**

- Every member that only computed the heir (`computed`, which is not the
  same as never having heard anyone: a fresh page has done neither) waits up
  to 10 s for its record (net.js `HEIR_WAIT_MS`).
- A silent or frozen heir never asks, so nobody is bound to it. When its
  wait runs out, or the member's own piece concludes it gone (anything but
  the heir's own goodbye), the next in line is named.
- A candidate without a quorum within the heir's wait releases its grants
  (`__r`) and never counts them again. It steps aside for the next in line.
  A voter is free again only when it hears that release.
- A member named with nobody left, or bound to a candidate it cannot reach,
  is **lost** (`room.lost`, `onLost(true)`).

A lost member:

- **Stops its game and says so.** The screen reads "Lost connection to the
  party", with TRY AGAIN where a room server may still reach the others, and
  LEAVE PARTY. A ranked start without a result is withdrawn at once, so
  leaving while lost is never booked as a departure.
  - TRY AGAIN calls `room.rejoin()`, the re-announce an isolated member
    makes. It is also made at once, and again after 5, 15 and 30 s.
  - The game frame is hidden, not torn down, for 60 s. A phone back in touch
    within that time resumes it, its own hidden state included, but only if
    it is the same run of the same game. A new run mounts fresh.
- **Rejoins rather than forks when a path comes back.** Its loss ends in any
  of these cases (`onLost(false)`):
  - a record at a newer term than it lost at;
  - the heir itself speaking;
  - the old host at the old term, but only if that record still seats the
    heir (otherwise it would put us in a second party beside the heir's).

  A member the heir dropped meanwhile carries its own seat back in.
- **Can still win an election.** After the heir's wait, lost phones that
  link up again stand again in a new round of the same election.
  - A member others are sworn to stands first, whatever its rank, because
    they can elect nobody else.
  - Otherwise the member that ranks first stands, among those it now links
    to directly. Members seen acknowledging another's commit are left out of
    that ranking (the acknowledgements flood, so everyone sees them).
  - The key is the same, so the same grants bind, and a sworn member grants
    nobody else.

  Without a room server, that, or LEAVE PARTY, is the way forward.
- **Says when it is stranded.** A phone sworn to a candidate that is past its
  deadline with no crown reaching the phone (`room.stranded`) cannot help
  elect anyone. That candidate may also have won and carried on out of
  reach. The screen says the phone gave its vote to a player it can't reach.
  - With a room server, TRY AGAIN stays, because it may find them, and NEW
    PARTY sits beside it.
  - Without a room server, NEW PARTY and LEAVE PARTY are the way on.

**Cases that are not splits.** An heir that left by its own goodbye is not a
split: it is passed over after the wait, and the next in line takes the
crown. A host whose seat the room server
holds sends no `__gone`. Whoever concludes it gone broadcasts that the crown
is vacant (`__v`), so an heir that reached the host only through a relay
still learns it. The receiver does not take it on trust: it probes the host
itself and concludes in its turn, so one member's false alarm (a host
reloading) cannot move the crown for everyone.

**Known gaps:**

- **A live host's partition.** A partition between a *live* host and the
  rest is not a departure: both sides keep a crown, and term ordering heals
  it on reconnection.
- **Host and majority fail together.** If the host and every candidate on
  the majority side fail together, nobody carries on.
- **Two humans, one reloading.** If one of the two humans is fresh from a
  reload when the host dies, that one has no vote. The other has only half,
  and wins only if it is the tie-break heir. If the reloaded one is the
  oldest, nobody crowns. The same holds whenever the tie-break heir's vote
  died in a reload and the rest split evenly.
- **A missed record that changes the humans.** A record that adds or drops a
  member reaches one side of a split only: the two sides' keys then count
  different rosters, and each could win its own election.

**Threat model.** Since 2026-11-18 every election message is signed by its
sender ([Who said it](#who-said-it-signed-party-messages)). A relay can drop a
grant, a commit, an acknowledgement or a release, never write one. A crown
won by election is shown with every record its holder publishes, as the
quorum of signed acknowledgements, so a member cannot crown itself with a
higher term. No phone takes an election on a holder it still sees, or is
(Lokesh, 2026-11-20). What remains:
- **A malicious *voter***: one that acknowledges two candidates for one key
  can help make two certificates. The quorum intersection assumes each
  member acknowledges at most one, which an honest client does (`committed`).
- **Real keys are votes.** Ids a member makes up never count (`pend`), but
  keys a member really holds, with real links, are members — in tabs it
  really runs, or rooms in its own page. In a genuine vacancy they vote.

A narrowing, which took election messages only over the sender's own link,
was dropped: it lost them on a half-dead link (and before signing it never
stopped forgery either). Tested in test-plumbing ("a split party",
"…reviewed", "…re-reviewed", "…by election", "…election re-reviewed",
"…with a commit") and test-party (the lost screen).

A link reported `disconnected` gets 3 s to recover before it counts as dropped,
because a phone on a briefly lost signal often recovers the same connection.
The cost is paid by a closed tab, which also arrives as `disconnected`: in
headless Chrome, closing the host's tab re-crowned the heir after 8 s without
the grace and 11 s with it. A deliberate `leave()` is not affected.

A page reload is the one case that cannot be rescued: WebRTC credentials are
per-connection, so a reloaded browser must handshake again — though any member
can invite them straight back in, and a room-server member does so on its own.

### The party API

Moved here from lib/README.md on 2026-11-15. The shell's internal contract:
games never call it (they speak [sdk-v2.md](sdk-v2.md) from a frame).

**`NeonArcade.mountParty(container, stage)`** (lib/party.js) mounts the party
screen in `container`; mounted games build themselves into `stage`. It handles
joining (`#i=` / `#c=` in the URL), recruiting, teams, switching and
succession.

**A game's address is a shortcut into it** (2026-11-13): `./?game=<id>&fresh=1`
([spa.md](spa.md); a portal card's link adds `&mode=bots&start=1` since
2026-11-21, below). With `?game=` the host of a fresh
party gets a **quick start** first: the game's name as the title, INVITE A
FRIEND and SINGLE PLAYER (enough bots to make it legal), then ADD
BOT / REMOVE BOT and START GAME (START alone for a local game, which shows
nothing else). START seats people by the rule the old game pages had — host on
A; a one-against-one game puts the first other member on B and the rest watch;
a bigger team game deals the others out alternately, B first; any other game
seats everyone on one side — except one person and bots in a `free` game,
dealt out like a team game (2026-11-17), so Bubble Rush's TEAMS can be played
alone; past the game's seats, the rest watch. After the
first game it is an ordinary party. A party opened this way does not ask a
lone host before leaving.

**One tap, and PLAY WITH FRIENDS** (Lokesh, 2026-11-21). A portal card's tap
is `./?game=<id>&fresh=1&mode=bots&start=1`: hosted at once with no room
server (`startsAtOnce`), the table last played on that game seated, PERSON
seats included (Lokesh, 2026-11-22: "Yes, reuse the table" — a group
passing one phone just taps and plays), the game started with no START
tap. The party code is fetched later, only if friends are wanted
(`ensureCode`).
- **A reload mid-game is a fresh bots game** (Lokesh, 2026-11-22: "A fresh
  bots game"). While this page plays alone (the host, no other person, no
  party code, not the lobby for friends), the address stays the tap's
  (party.js `syncAddress`), so a reload starts a new game against bots at
  once. Once friends are wanted (the lobby, a code, another person) the
  flags go, and a reload rejoins as before. Invite links never carry them
  (`shareBase` drops `start` as well as `fresh` and `mode`).
- **A seat this browser still holds** when a tap starts a game: held by a
  live tab (a local lock, no network), the bots game starts here anyway
  (Lokesh, 2026-11-23: "Start the bots game anyway"), that tab keeps its
  party and its token, and a toast says "Your party is still open in
  another tab." A reload here is a fresh bots game, never a reconnect into
  that party, and PLAY WITH FRIENDS hosts no code over its token
  (`ensureCode`). The blocking "This party is open in another tab" screen
  stays where the seat itself is wanted: START A PARTY, a code link (`#c=`),
  JOIN WITH A CODE, a reconnect, a seat displaced by another tab. Otherwise
  the seat is handed back in the background once the room server answers.
  Offline, or with no server, the token stays: nothing released it.
- **PLAY WITH FRIENDS** (party.js `playWithFriends`; Lokesh, 2026-11-22:
  "Bottom, between rounds"). It sits where nothing else needs the space:
  the bottom of the end card (lib/sdk-managed.js, after PLAY AGAIN, CHANGE
  PLAYERS and SEE THE BOARD), and of the shell's own start screens (the
  quick table's and the bots quick start's "Play with friends instead").
  During play it is on the party screen pulled up over the game (PARTY),
  beside BACK TO GAME, END GAME and CHANGE PLAYERS; that is also where Neon
  Bid and Liar's Dice, which have no shell end card, offer it between
  rounds. Never a bar over or under the game: from 2026-11-21 to 11-22 it was
  a bar with 52 px of its own at the bottom, which shrank the boards bound
  by height at 354x696 (Sudoku's cells to 34 px, Battleship's squares to
  35.8 px, Neon Fission's eight-player grid to 36 px). It is offered to the
  host alone with bots (no other person in the party), online, in a game
  that is not `local` (`canPlayWithFriends`). A tap **ends the bots game and
  opens the party lobby for that game** (Lokesh's decision): the game's
  name, the code (the party is hosted again through the room server, the
  bots re-seated), INVITE A FRIEND, the seats, START GAME. PERSON seats turn
  back into bots. From PARTY over a running game it asks first, as END GAME
  beside it does, and so does CHANGE PLAYERS there; from the end card,
  between rounds, neither asks. A game's
  own setup screen inside its frame (Bubble Rush's mode, Battleship's
  fleet) gets no button of the shell's; PARTY has it there.
- **The lobby's seats:** ADD BOT and REMOVE BOT, as before (the contract
  test-managed, test-protocol, `scripts/preview.mjs` and validate-game
  drive), under a line saying who is at the table ("3 players: You, 1
  friend and 1 bot"); the bots carried over from the game played alone stay.
  For a game with a table, a change while you are the one person here is
  remembered (`neon.table`), so the next tap on the card plays it. A full
  party (PLAY WITH FRIENDS from an eight-seat table) still lets a friend in:
  an invite that would be refused as full is made anyway when the host's
  page would give up a bot's seat, and its newest bot goes only as the
  newcomer is admitted (net.js `createInvite` asks `yieldBot(false)`,
  `_addMember` calls `yieldBot(true)`; INVITE and a join by code alike),
  never over a running game, so an invite that lapses or a join that fails
  costs no bot. Each such invite reserves its bot (`yieldReserved`, passed
  to `yieldBot`), so two invites never count on one bot: the second is
  refused as full when it is made, and a join that would still take the
  party past `maxMembers` at admission is let go (`_addMember` returns
  false). The party never exceeds `maxMembers`. A friend
  who joins takes a bot's seat rather than one more (`seatTarget`,
  `fitTable`): Connect 4 that was you and a bot is you and your friend, not
  a friend left watching.
- **CHANGE PLAYERS** (`changePlayers`): on the end card (lib/sdk-managed.js,
  a managed game's), and on the party screen pulled up over any game (PARTY),
  for the host alone with bots in a game with a table. It ends the game and
  shows the table; START GAME plays the next round at it. A game that is not
  managed (Neon Bid, Liar's Dice) has no shell end card, so there it is the
  PARTY screen's button.

**The quick table** (Lokesh, 2026-11-17: "I don't see option to add more
players/bots in single player mode in neon fission"; he chose "Quick table
before start"). Since 2026-11-21 it is not passed through before a game
(above): it shows from CHANGE PLAYERS, and from the plain SINGLE PLAYER
address (`./?game=<id>&fresh=1&mode=bots`, an unlisted game's, or the party
screen's SINGLE PLAYER). SINGLE PLAYER of a game whose seats leave a choice —
`seats.max > seats.min`, bots allowed, not a `local` game — opens on a
compact table instead of starting at once (party.js `tableBlock`):
- **Players − n +** from `seats.min` to `seats.max` (capped at the party's
  `maxMembers`). You fill seat 1 and bots the rest; each seat is listed with
  its bot's name and its seat colour (`--p1`…`--p8`). A one-seat game keeps
  Players 1: alone, no bots. The stepper adds and removes real bots as it
  moves, so the table is the party.
- **PERSON seats**, for a game with `"sameDevice": true` (Neon Fission): each
  bot seat toggles BOT / PERSON — someone beside you, passed the phone on
  their turn. A PERSON seat is a bot to the party, marked `local: true` on
  its record (`room.setBotMeta`), shown as "Player n" (as the game names
  it); lib/sdk-managed.js passes `local` on that seat to the game's `init`
  (only for a game that declares `sameDevice`), and never asks for a solo
  run against bots with one at the table (that person is no bot). The game
  plays such a seat for the one person; with two or more people there is no
  one phone, so it is a bot.
- **PERSON seats never hide** (review, 2026-11-17). After the table the
  party screen's roster tags such a seat PERSON, not BOT, and gives every
  bot row a 44 px PERSON toggle while the host is the only person here and
  no game runs (with a line naming the games that take it); a game started
  from the party screen plays them too. They are this page's own choice and
  are cleared (party.js `tidyPeople`, on every party change) when a second
  person joins, when the crown moves to another phone, when "Play with
  friends instead" is chosen, and when a quick start other than the table
  starts the game. A card's tap (`start=1`) seats the table last played,
  PERSON seats included (since 2026-11-22); PLAY SOMETHING's random pick
  (`start=pick`) seats bots in every other seat, its size the remembered
  one, and leaves the PERSON seats saved for that game as they were
  (Lokesh, 2026-11-23: "Bots only for random picks").
- **START GAME** sits right under the stepper whatever the count. The table
  is remembered per game (localStorage `neon.table`,
  `{ [id]: { n, people: [seat…] } }`), written at START and as the table (or
  the lobby's stepper) changes while you are the one person here, so the
  next tap on the card plays it.
- **No table** for fixed seats (Connect 4, Tic Tac Toe, Battleship: 2 and 2),
  a `local` game (Undercover, which takes its names itself) or a people-only
  one (Draw & Guess has no SINGLE PLAYER): they start as before.
  **PLAY SOMETHING** adds `start=pick` to the card's address: the
  remembered (or smallest) table's size at once, bots only, never drawn
  (`quickGoing`, `botsOnly`); `start` is dropped from the address with
  `fresh` and `mode` once friends are wanted.
- **Offline** it is the same table (a bots game never asks the room server);
  the friends link hides while `navigator.onLine` is false.
- **Phones and access:** every control is 44 px, the list ellipsises names
  at 354 px; the stepper is a labelled group with arrow keys, Home and End;
  a live region outside the rebuilt screen announces "4 players. You and 3
  bots."; the control in use keeps the focus across re-renders.
- Tested in test-bots ("quick table", at 390×844 and 354×696 in all three
  themes; CHANGE PLAYERS and PLAY WITH FRIENDS on the end card at both
  sizes, the game keeping the whole screen), test-pwa (offline: no card shows it; the plain address does, for
  exactly the games with a choice), test-portal ("one tap on a game starts
  it against bots": no table, no room server, no bar, PLAY WITH FRIENDS
  from PARTY, the lobby's ADD BOT remembered, at both sizes) and test-party
  (PARTY offers PLAY WITH FRIENDS alone with a bot, not with people in the
  party).

**The room controller** (lib/net.js `createHost` / `createGuest`):

| method | description |
| --- | --- |
| `selfId` | this member's id: its signing key's hash, 16 characters ([Who said it](#who-said-it-signed-party-messages)) |
| `refused` / `refusals` | messages dropped as unproven or unauthorised, and the last few reasons |
| `peerCount()` | number of other members |
| `getMembers()` | `[{ id, name, team, joined, bot? }]`, in join order |
| `getMember(id)` / `self()` | one member record |
| `isHost()` / `hostId()` | who holds the crown |
| `directPeers()` | peers this browser has an actual connection to |
| `getGame()` | the mounted game's id, or null |
| `makeAction(name)` | `{ send(data, { target }?), onMessage }` — broadcast or targeted |
| `setName(name)` | change your display name |
| `setTeam(id, team)` | host only: `"A"`, `"B"` or `"spectator"` |
| `setGame(id)` | host only: everyone mounts it; `null` returns to the party |
| `transferHost(id)` | host only: hand over the crown (never to a bot) |
| `heir()` | who would take the crown if we left now; skips us, bots and reconnecting seats; `null` if nobody |
| `lost` / `onLost(on)` | this side of a split party cannot take the crown or reach the side that did (see "A split party") |
| `canRejoin` / `rejoin()` | whether a room server may put us back in touch, and asking it to |
| `removeMember(id)` | host only: remove someone (a bot included) |
| `addBot(team?)` | host only: seat a simulated member; defaults to the emptier side. Returns its id |
| `bots()` | every bot in the roster (readable by anyone) |
| `setBotMeta(botId, patch)` | host only: merge fields into a bot's record (not `id`, `name`, `team`, `bot` and the other reserved ones); the quick table's `{ local: true }`. A message never edits a bot: the host's `__i` handler refuses a bot's id (below) |
| `emitAs(botId, action, data, opts?)` | host only: send as a bot, and deliver locally too |
| `NeonArcade.isBotId(id)` | a bot's id is prefixed `bot_`, so routing can tell without the record |
| `deleteParty()` | host only: end it for everyone |
| `leave()` | tell the party we are going (the seat drops at once), then close every connection. Never called on reload/unload |
| `detach()` | close every connection *without* telling anyone, as a reload would — the seat is held as RECONNECTING. For when the same member id is reconnecting from elsewhere (another tab took the seat; room-join's "displaced") |
| `createInvite({ forPeer, retry, hard }?)` | mint an invite (any member). Refuses with `err.reason === "full"` at `maxMembers` — unless `forPeer` names a member who already holds a seat (a reload coming back), whose own seat is not counted against them. `retry` marks the role-swapped second try (below); `NeonArcade._codec.isRetrySignal(code)` reads that mark synchronously. `hard` marks an offer from a hard-NAT network (`natHard`, below; `h.` prefix, `isHardSignal`) for the far side's glare rule. Rejects with `reason: "withdrawn"` if the invite was dropped while it gathered. Resolves `{ code, link, withdraw }`: `withdraw()` closes the invite's PeerConnection unless an answer already took it — call it when the invite is cancelled or replaced |
| `natHard` | this network's NAT maps one local port to different public ports per destination (`true`), does not (`false`), or unknown (`null`). Set by room-join from `NeonArcade.classifyNat()` — in parallel with the dial, never awaited, and asked again on isolation and on `online` / `navigator.connection` `change`; pin it with the `natHard` option |
| `dropInvites(forPeer)` | close every invite minted `forPeer` that no answer has taken — an invite never expires on its own, so whoever knows it will not be answered (the far side's glare rule set it aside, the peer went away) drops it. One that took an answer is left to finish. Returns how many it closed |

`makeAction` is idempotent: calling it twice with one name returns the same
channel, so `room.makeAction("state").send(...)` inside a helper is fine.

`createHost`/`createGuest` take `onLeave(reason)`, called once on every exit:
`"left"` (`leave()`), `"evicted"` (the host removed us), `"closed"` (the
party was deleted) or `"detached"` (`detach()`). `lib/room-join.js` uses it to
release the room-server claim — on every reason but `"detached"`.

`onError(message, info?)` carries `info.reason === "no-route"` when a link
failed ICE and we hold no other — the pair has no path (no TURN).
`onRouteFailed(peerId, { offered, message })` comes first, for a link made
with `createInvite`/`answerInvite` on its first try: return true when you can
still signal that peer, and swap the roles — offer back with
`createInvite({ forPeer, retry: true })` if we answered, or expect their offer
if we offered (the no-route verdict then waits 8 s for it). room-join does
this over the room server. And `onIsolated()` fires when the *last* link
closes while the roster still has people: the mesh has nothing left to
renegotiate over, so room-join re-dials the room server to be offered to again
([network-testing.md](network-testing.md)).

A direct link both ends have described that has not opened 20 s later
(`room.openTimeoutMs`) is failed as ICE `failed` would be — once ICE is up
(DTLS/SCTP still retrying) it gets one more period first. The offerer's clock
starts in `acceptAnswer`. The answerer's starts only with
`answerInvite(code, { watch: true })`, which is for an answer a machine
delivers (room-join passes it). The scan/paste flows (party.js, lobby.js) call
`answerInvite(code)` without it: a person carries that reply back, for as long
as it takes.

**Shared handshake pieces** (lib/lobby.js; `party.js` requires it to be loaded
first, which `src/main.tsx`'s import order does):

| export | description |
| --- | --- |
| `NeonArcade.el(tag, props)` | the small DOM builder the party screen uses |
| `NeonArcade.savedName()` / `rememberName(name)` | the display name remembered in `localStorage` (`neon.name`) |
| `NeonArcade.shareBlock({ label, hint, value, qrValue, linkValue, title })` | a code box with a copy button and a QR; a labelled `.share` card when `label` is given. `linkValue` adds a second copy-as-link button so the QR stays small |
| `NeonArcade.replyEntry({ room, setStatus, placeholder, scanPrompt, onConnected })` | the inviter's reply box with CONNECT / PASTE / SCAN REPLY. Returns `{ nodes, row, close }` — place `nodes`, add buttons to `row`, and always call `close()` on teardown (it stops the camera) |
| `NeonArcade.ask(question, { ok, cancel })` | a yes/no question in the page's own `<dialog class="neon-ask">` (buttons `[data-ask="yes"]` / `[data-ask="no"]`); resolves `true` for yes. Never `confirm()`: it freezes the page's JS — the host's game loop and the mesh's relaying with it. Escape and a tap outside mean no; a second question dismisses the first |
| `NeonArcade.toast(text, kind)` | a notice over whatever is on screen (`.neon-toasts`, under the portal link), `kind` `"good"` / `"warn"`; takes no taps, gone after 4.5 s, at most 3 |
| `NeonArcade.presence()` | `{ sync(room), left(room, id, info) }`: feed it every roster callback and it toasts what changed — joined, left (with the reason), lost connection (after 2.5 s still lost) and back, the crown moving (after 1.2 s still moved). The first sync with a room is silent |
| `NeonArcade.guardParty({ room, askAlone })` | register the page's party: `room()` returns the live room or null. From then on "← Games" (and any `a[data-leaves]`), back / swipe-back (a history entry pushed on the first tap) and `beforeunload` (only with another person present) all go through `leaveParty`. `askAlone` (boolean or function): ask even with nobody else here (the party shell, except a party a game's address opened) |
| `NeonArcade.leaveParty(question)` / `leaveQuestion(room, question)` | ask (naming the heir, for a host), then `leave()` and wait for `roomSettled()`; resolves `true` once it may navigate, `false` if they stayed. Not asked, it still leaves — that is what drops the rejoin token |
| `NeonArcade.REPLY_NOW` / `NeonArcade.replyFailed(setStatus)` | the replier's side of a hand-carried reply: the "do it right away" sentence for the reply screen (between some networks a reply works for ~15 s — [Honest gaps](#honest-gaps)), and, on a `no-route` before the link ever opened, the error status plus `{ hint, again }` — a hint node and a MAKE A NEW REPLY button (a reload: the same `#i=` invite answered afresh) for the caller to place |

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
   indistinguishable. When the crown moves the bots stay, and the new host
   plays them — from the running game if it is handed over (below, Honest
   gaps), else from the next one. They used to be dropped, which cost the
   party its bots every time a host's connection blinked.

Bot ids are prefixed `bot_` so the **routing** code can recognise one from an id
alone, without consulting the record. That matters in four places in `net.js`,
and each is a bug if forgotten: `_meshUp` must not try to open a connection to
one (a full ICE timeout, every roster change, forever); a broadcast must not
count one as a peer somebody has to relay to; `_ranked` (behind `_heir` and
`heir()`) must never nominate one for the crown, and neither may
`transferHost`; and `_vacateCrown` must drop them all, because the only browser
simulating them has gone.

Where the brains live:

| Game | Brain | Where |
|---|---|---|
| Connect 4 | minimax + alpha-beta, 5 plies, centre-first move ordering | `games/connect4/connect4.js` |
| Neon Survival | steering: inverse-square flee from enemies, drift to gems, wall push-off, speed-capped | `games/neon-survival-mp/neon-survival-mp.js` |
| Neon Bid | marginal points (plus a share of the rainbow) + half the leader's gain, scaled by credits per lot it can expect to win, ±15% noise | `games/neon-bid/neon-bid.js` (`NeonArcade.neonBidRules.botBid`) |
| Neon Fission | every legal cell simulated in full (chains included) and judged (material, safe corners and edges, loaded cells, cells beside an enemy one orb from bursting); the best 8 checked against the next player's strongest reply; takes a win at once | `games/neon-fission/rules.js` (`botMove`) |
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
they need different answers. `lib/secrets.js` has both, and a game reaches
them as SDK v2 shell services: `seal.*`, `commit`, `verify` (docs/sdk-v2.md,
"The catalogue").

**A "private" message is not private.** `makeAction().send(data, { target })`
is *addressed*, not sealed. With no TURN server, a pair that cannot connect
directly is routine, and `net.js` then relays the envelope through whichever
peer can reach both — another player's browser. Your hand travels through the
hands of the people you are hiding it from.

```js
arcade.send("seal.listen", { ch: "hand" });   // every phone: publishes its key too
arcade.on("sealed", ({ ch, d, from, to }) => ch === "hand" && render(d));
await arcade.request("seal.send", { ch: "hand", to: playerId, d: cards });  // sealed end to end
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
const c = await arcade.request("commit", { value: myFleet });   // { digest, nonce }
publish(c.digest);                                               // now
publish({ value: myFleet, nonce: c.nonce });                     // at the reveal
const { valid } = await arcade.request("verify", { digest, nonce, value });  // everyone checks
arcade.send("session.set", { key: "fleet", value: JSON.stringify({ myFleet, ...c }) });  // survives a reload of this tab
(await arcade.init).session.fleet;                               // ...and comes back after one
```

**A reload must not turn an honest player into a cheat.** A reload keeps the
seat but not the page, so a commitment held only in a closure is gone: the
player cannot open it, and the audit then flags them. `session.set` keeps it
in this tab's session storage, which the shell holds for the frame (a
sandboxed frame has none), and `init.session` hands it back after a reload
(lib/secrets.js `keep`/`kept` is the same idea in the shell). A kept value is never
trusted by itself — Battleship, Liar's Dice and Neon Bid take it back only
when the digest the host published for them is its digest (or, for a bid
still being collected, when the host already counts them in). Battleship
also re-sends a returner the last volley, whose answer they owed while away.
The re-sync itself comes from the party shell: a member who mounts a running
game says so, and the host's game re-sends its state (`onPeerJoin(id,
{ back: true })`, lib/party.js). Draw & Guess replays the canvas so far.
test-worker section 10 reloads a guest mid-game in six games.

The digest is taken over a **canonical** serialisation — object keys sorted at
every depth — because `JSON.stringify` preserves insertion order, so a value
that has been through the network can serialise differently from the one that
was hashed. That is a verification failure with no bug behind it.

Both halves need WebCrypto, which needs a secure context. The arcade is served
over https (or loopback), which is one — but the check is made at runtime: with
no WebCrypto, `seal.send` is refused ("no WebCrypto") rather than silently
sending in the clear (lib/secrets.js `privacy()` is `"plain"`). A game with a
secret should refuse to deal then.

### The worked example: Battleship

`web-games: battleship/battleship.js` is what this was built for, and it shows the pattern in
full. Nobody holds anybody else's fleet — not even the host. Each player commits
to a fleet before a shot is fired, answers hit-or-miss for their *own* board
during play, and opens the commitment at the end.

**Verifying the digest is not enough**, and this is the part that is easy to get
half right. A digest proves only that the fleet was decided before the shooting
started; a player can commit honestly and then simply lie about a hit. So the
reveal runs two checks — the digest against the revealed fleet, **and** every
answer replayed against it. A third catches the fleet that was legal-looking but
overlapping. `battleship/test-battleship.mjs` (web-games) tests the audit by breaking it four
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

### Neon Bid: a bid is a commitment

`games/neon-bid/neon-bid.js` ([design](neon-bid.md)) is the third user of the pattern,
and the simplest: the secret is a single number. Each player commits to
their bid in a `collect` phase, opens it only after everyone has committed,
and the host audits each opening **twice** — against its digest, and against
the bidder's credits *snapshotted before the await* (the Liar's Dice race).
A bad opening counts as 0, so it neither wins the lot nor sets the winner's
price. The lot order is shuffled once and published before the first bid, so
the host — a player — knows nothing the others do not.

Bots' bids are decided and committed while the previous lot is on show,
because `botSubmit` is synchronous and `commit` is not (the Battleship
trap); a backstop `submitFor` covers a commitment that is late.

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
A game reaches it as the SDK v2 `timer.*` service (docs/sdk-v2.md); the shell
runs the clock.

```js
// every phone opens the same clock; the host's runs it
arcade.send("timer.open", { name: "t", rounds: 5, bots: true,
  phases: [{ name: "lock", ms: 20000, collect: true }, { name: "resolve", ms: 3000 }] });
arcade.on("timer", (m) => {
  if (m.ev === "phase") render(m.info);                          // every phone
  if (m.ev === "bot") arcade.send("timer.do", { name: "t", op: "submitFor", bot: m.bot, value: chooseFor(m.bot) });  // host
  if (m.ev === "collect") resolve(m.entries);                    // host only
});
if (arcade.isHost()) arcade.send("timer.do", { name: "t", op: "start" });
arcade.send("timer.do", { name: "t", op: "submit", value: answer });   // anybody
```

A phase marked `collect` ends **as soon as every seated player has submitted**,
or at its deadline, whichever is first. That one rule is what makes
simultaneous-turn games work over this transport: nobody is racing anybody, so
a slow link costs its owner nothing and the host never arbitrates who acted
first. The `bot` event (`botSubmit` in lib/rounds.js) exists because a
collecting phase would otherwise wait out its deadline for a seat with no
browser behind it.

Peers see *who* has submitted, never *what* — the submissions themselves never
leave the host until its `collect` event decides what is public.

Battleship runs **two** schedulers, which is what `name` is for: placement is a
single collecting phase that ends the moment both fleets are committed, and the
battle is many, each ending the moment both players have picked a square. One
trap worth knowing — `botSubmit` is synchronous and `commit` is not, so a bot's
fleet and commitment have to be built and cached *before* the placement phase
opens. Liar's Dice cannot do that, because the number of dice changes every
round; it uses `rounds.submitFor(botId, digest)` from inside the phase instead.

`next` (`timer.do` op `next`, lib/rounds.js `rounds.next()`) ends the current phase immediately. Liar's Dice needed it — the
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

`local: true` in the registration (`"kind": "local"` in game.json) says a game is
played by people **in the same room, on one phone, passed from hand to hand**.
`games/undercover/undercover.js` is the first; since 2026-11-14 it is an SDK v2
game on Layer 1 that speaks only to the shell (storage, session, result).

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

Everything else is the ordinary game contract. The game keeps its own list of
players and ignores the party's members entirely.

**A seated game can share one phone too** (2026-11-17): with `"sameDevice":
true` (Neon Fission) the party's seats stay the game's seats, and SINGLE
PLAYER's quick table lets the one person make bot seats PERSON — someone
beside them, passed the phone on their turn ([The party API](#the-party-api),
"The quick table"). The card then says SINGLE PLAYER / SAME DEVICE, as it
does for a `local` game; until that day every `party`-category game said so,
including Neon Bid and Liar's Dice, whose sealed bids and hidden cups cannot
share a screen.

**What such a game is actually responsible for** is narrower than it looks. The
describing, the arguing and the voting happen between people; the phone deals
the secrets, remembers who is out, and — the only part that really matters —
never shows a secret to the wrong person. Undercover takes two deliberate taps
to reveal a word and one to hide it, and `scripts/test-bots.mjs` asserts that
nothing is on screen (or in the DOM) before the tap and nothing is left after
the pass. The hand in progress is kept in the game's session (`session.set`
"hand"), so a reload mid-hand carries on, but `revealed` is never kept: a hand
reloaded mid-deal comes back on "Pass to …" and needs the tap again (also
asserted there).

Two traps found building it, both of which look like a sulky game rather than a
bug:

- **The table must survive one wrong vote.** The undercovers win at parity, so a
  table needs `n >= 2*others + 2`. Five players with one undercover *and* a
  blank does not: three against two, over the moment the table guesses wrong,
  before anybody has spoken twice.
- **No word may appear in two word-pairs.** A player who has seen the list
  before could otherwise rule out the other half. The test caught "Violin" in
  two pairs.

**The words** live in `games/undercover/words.js`: about 750 pairs across 14
topics (Food & drink … Science & space), each split into *easy* pairs (the same
family, pulled apart within a round) and *hard* ones (nearly the same thing —
Butterfly / Moth). The host ticks any set of topics and a difficulty on the
WORDS screen; everyone is told the topic on the reveal, never the word. The
phone keeps the keys of pairs it has dealt in its storage (`store.set` "seen") and draws
only unseen pairs until a pool is spent (`drawPair`), so a table that plays
every week works through the whole list before meeting a pair again. Points
carry across hands, and across reloads (storage "scores") — civilian 1, undercover 3,
blank 4, to everyone on the winning side — and reset on RESET SCORES.
`scripts/test-undercover.mjs` holds every topic to at least 20 pairs per
difficulty and still forbids a word in two pairs anywhere in the list.

## Adding a game

The author's guide is [CONTRIBUTING.md](../CONTRIBUTING.md) (layout, the
seven Tic Tac Toe examples, the dev kit, checking, proposing); the protocol a
game speaks is [sdk-v2.md](sdk-v2.md); what the platform asks of a game — the
manifest, the sandbox, results, the rules — is [platform.md](platform.md). A
game is a folder with a `game.json` (`"sdk": 2`) in this repo's `games/` or in
the author's own repository, pinned in `registry/`.

A game's address, `./?game=<id>&fresh=1`, is a **shortcut into the party
shell** (since 2026-11-13): the host gets a quick start for that game (INVITE
A FRIEND, PLAY A BOT, START GAME) before the ordinary party screen
([The party API](#the-party-api), `mountParty`). There used to be a separate two-player lobby on
each game's own page, without join by code, rejoin after a reload, PARTY, END
GAME or the turn banner's choices; Lokesh chose one connection path over
teaching it all that, and the pages themselves were deleted on 2026-11-15. A
game is implemented exactly once, and connected exactly once.

**The shell is Solid + Vite since 2026-11-15** ([spa.md](spa.md)). It was
weighed and rejected on 2026-08-10 and 2026-08-27, when the reactive surface
was about a fifth of the code and opening the HTML from disk (`file://`) was a
supported way to run the arcade. The re-measure of 2026-11-14 found two things changed:
- **The reactive surface** had grown to 35–40% of the shell.
- **Running from disk** (`file://`) was already gone for games, and Lokesh
  dropped it for the shell too.

Moving between pages also dropped the party, which only one page can fix.
The games stay framework-free in their frames, and so do the shell's
libraries (lib/*.js, bundled as modules).

No game the platform tests has more than one player per side of a `teams`
game. Connect 4 reads `seats("A")[0]`; a game with several per side would be
the first to exercise the group reading — test it in the party with a
2-against-1 roster.

## Installing it

The arcade is a PWA: `manifest.webmanifest`, icons under `assets/`, and `sw.js`
at the repo root so its scope covers every page. `lib/pwa.js` registers the
worker and fills any `[data-install-slot]` element with an INSTALL APP button
when the browser says the app can be installed (the portal has one under the
title). Without a secure context (a plain `http://` LAN address) none of
this runs, and the arcade works as before, online.

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

**The caching design (2026-11-14).** Code — the pages, `lib/`, `games/` — must
agree with each other: serving one file from an old deploy beside another from a
new one breaks the app silently, days after the deploy responsible. So code is
served from **one precached snapshot per `VERSION`**, written whole at install
and never refreshed file by file. A page opens from the phone's own storage,
and is always one coherent deploy. `VERSION` is a content hash of every
precached file, written by `scripts/assemble.mjs` into `dist/sw.js` at build
time (with the community games; docs/spa.md), so a deploy is a new
`sw.js`, which the browser's own update check installs beside the old snapshot
and activates — the next page load is the new deploy, whole. The install is
all or nothing: a deploy that cannot be fetched whole leaves the old snapshot in
place. A page already open stays on the snapshot it was loaded from until it
closes, lazy loads and game frames included: each navigation records which
VERSION served it ("pins"), and old snapshots are pruned once no open page uses
them. `test-pwa` checks each of those against a staged deploy.

Until 2026-11-14 code was **network-first** for the same coherence reason, at a
round trip per file and a 3 s wait for any file on a bad link (docs/perf.md).
On a loopback address (`just run`) it still is, so an edited file shows on
reload; tests opt into the real strategy with localStorage `neon.sw=snapshot`.

Icons, fonts, posters and an outside repo's preview gif are **cache-first**,
with no download behind a hit (every portal visit used to refetch every
preview). Preview videos are left to the network: the portal fetches each clip
once with `fetch()` and every card showing that game plays the same `blob:`
URL (lib/portal.js; a card per section had fetched it again, 2026-11-15).
Offline a card shows its precached ~5 KB poster; `assets/placeholder.svg` is
for a card with none.

**A page offline is matched without its query** when the exact URL was never
cached: `./?game=connect4&fresh=1` gets the precached shell, whose script
reads the query. Before 2026-11-13 it fell straight to the portal, so a game
link opened offline depended on having visited that exact URL online. A
framed game's files (`games/<id>/`) are precached like the rest, and so is
its frame, prebuilt at deploy (`frames/<id>.html`, docs/sdk-v2.md). The Python runtime
(`sdk/pyodide/`) is the exception: cached on first use, in its own cache.

**Do not put an SVG in the manifest's `icons`.** Listed with `sizes: "any"`,
Chrome selects it as *the* install icon, refuses it, and reports
`no-acceptable-icon` for the entire set — the app becomes uninstallable while
every hand-written check still passes. This was caught only by asking Chrome
through CDP, which `scripts/test-pwa.mjs` now does on every run. The SVG remains
the favicon via `<link rel="icon">`.

**The app mark is "linked players"**: two joysticks, one per player, joined by
one cable (2026-11-14). `assets/icon.svg` holds it in the Paper theme's
dark-mode colours as fixed hex: slate tile `#111419`, player 1 in the accent,
player 2 in accent-2. An installed icon cannot follow the theme. The manifest's
`background_color` and `theme_color` match the tile. The portal's title is a
lockup (`h1.brand` in `index.html`). It draws the same glyph inline, coloured by
theme tokens, so it follows Paper light, Paper dark and Neon. Change one and you
must change the other. The SVG must also stay strict XML, because a browser
loads the favicon as a standalone file and refuses the whole thing over one
`--` in a comment. `make-icons.mjs` pastes the SVG into HTML, which forgives
that, so the PNGs give no warning. From 2026-08-16 to 2026-11-14 no tab showed
the icon for exactly this reason. `test-pwa` now parses the file.

## Honest gaps

- Per-game design notes and a decision log are still missing.
- **Signed party messages: what they do not cover** (2026-11-18; [Who said
  it](#who-said-it-signed-party-messages)). The sender of every message is
  proven, which closed the relay renaming a member and swapping its key, the
  forged eviction, the self-crowning record and forged votes. Still open:
  - **A newcomer trusts its first record.** A fresh page (a newcomer, a
    reload) has nothing to check a record against. Since 2026-11-19 a record
    its deliverer wrote about itself counts only from the member the invite
    or code named. The host's record handed on by a member is taken on that
    member's word, so the member a fresh page links to first can hand it a
    stale or false party.
  - **Replays.** Signed messages carry the party id. Records, `__k`,
    `__gone`, `__x` and introductions are bound to state (see "Replays"
    above). Left on the seen window and idempotence: the
    `__i` vouches `back`/`rs` (a replay can mark a member back or as a
    room-server member), `__alive`/`__q`/`__v` (they only start or settle one's
    own probe), and election messages (their key names the vacancy and term).
  - **The `fw` mark is unsigned.** A member who strips it from the record it
    hands a reloaded page gives that page back its vote, on a stale record.
  - **A malicious voter** can acknowledge two candidates for one key. The
    election's safety assumes it does not (see the threat model under "When
    the host goes").
  - **A relay can crown itself for those behind it** (re-review, 2026-11-19).
    In a relay layout (Host–Cy–Ana, no Host–Ana link) with two humans left,
    Cy is half and maybe the tie-break heir. Cy can write a crown change for
    Ana while the host is alive: Ana has no link to the host, so she cannot
    see it alive, exactly as when it is really gone. This is inherent to
    letting a lone survivor win; the host itself, and anyone linked to it,
    refuse.
  - **A newcomer with no party id yet** is captured by a record from another
    party, handed on by the member it linked to. It has nothing to check the
    `pa` against.
  - **The key's Web Lock under the back/forward cache.** Chrome keeps a page
    that holds a Web Lock out of the cache: test-worker caught it after the
    merge with main, 2026-11-20. So a page lets go of its keys' locks on
    `pagehide`, as room-join does with a seat's lock, and one restored from
    the cache takes this tab's back. A page in the cache therefore holds no
    lock, and a duplicate opened meanwhile may take its key. Safari and
    Firefox are not tested (VERIFY).
  - **Extra votes cost real peer connections, not real devices.** Any member
    can seat extra voters by opening extra rooms in its own page (or extra
    tabs), each with its own key and real WebRTC links to the host. Nothing
    here can tell those from other people's phones.
  - **A relay-only player never votes.** Without a hello-verified link to the
    host (the NAT lab's two symmetric peers, relayed by a third), a seat
    stays `pend` 2: it plays, but no election counts it.
  - **Records grow with elections.** A certificate carries the record it was
    won from, nested up to three deep. Measured on a 6-member party: about
    2.5 KB after one election, 3.7 KB after two, 4.8 KB after three.
  - **The old side is not always told.** When a new client joins an *old*
    party, it leaves with a goodbye rather than evict the old host from its
    own party: the old side sees a member leave, not "reload". A code join
    from an old client gets no answer from a new party, and its own client
    says "Nobody in that party answered" after 30 s.
  - A host whose crown came by election and who reloads takes its proof
    back only from the stayer's copy of its own record (`_keepProof`).
  - Members more than three crowns behind, or whose latest record of the
    vacancy's term has humans the certificate's record lacks, cannot check
    it. Those whose chain is cut short, signed by members they seat, are told
    to reload (reason `behind`) rather than left split; a junk record is
    refused quietly.
  - **No election deposes a host its electorate still sees** (Lokesh,
    2026-11-20). The holder said to have left, and anyone who still sees it
    (a link that never dropped), refuse every election certificate on it,
    attested or not. A member that does not see that host takes the
    certificate, as it would a real one: in a relay layout, those behind the
    relay (A2, above), and a phone whose own link to the host dropped and
    re-formed. Before this rule, an attested certificate from two colluding
    members, or from one member with an extra room, deposed a live host even
    in a full mesh.
  - **The cost of that rule.** Where the host *was* alive (a partition), the
    host's side and the elected side are two working parties until the
    partition heals. At that point the old host and its members take the
    election: they concluded its candidate and voters gone, past the
    departure grace, and now link to them again. They also take it if their
    links to the host are noticed and close first. Past 64 records on the
    host's side during the partition, the heal fails until someone reloads.
  - **The honest race splits** (round 5, K's cost): a hand-over and an
    election on one vacancy exclude each other, and each phone keeps
    whichever it learnt first.
  - **Extra connections are extra votes in a real vacancy.** A quorum of
    real keys can win a genuine vacancy. A member with extra real
    connections has that many votes there, though it cannot depose a host
    its electorate can see.
  - Tested over the fake transport (every class) and real links (test-party's
    four-tab election, test-nat's relayed scenario). No hostile client has
    been run against a real party.
- Scanning is verified at realistic code density — a reply code occupying part
  of a full-resolution frame, preceded by seconds of empty aiming frames, on a
  CPU throttled to phone speed — but via a fake capture device, **not** a real
  phone camera. Nothing here reproduces glare, autofocus or motion blur. A
  640x480 webcam is recorded as passing at close range only; below that, PASTE
  is the answer.
- The mesh is tested with three peers; nothing has exercised the 8-player cap.
  The relay path *does* now run in anger: `test-nat.mjs` scenario 4 puts two
  peers behind symmetric NATs, which cannot link, and their messages arrive
  through the third.
- Bot *strength* is now measured for two. Neon Bid's wins every one of 2,000 games against a
  random bidder and against one that spends evenly (`test-neon-bid.mjs`, which
  prints the rates); Light Cycles' wins 30 of 30 against a rider that only
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
- `scripts/test-bots.mjs`'s Neon Survival check "the bot ships are being
  flown, not parked" is **intermittently flaky** — failed 2 of 8 runs on
  2026-11-12 (both inside a full `just test`; standalone 0 of 5, and 0 of 1
  with the new Neon Bid section removed). Not investigated; the page is
  reloaded between sections, so no state is shared with the section before it.
- The crown term converges two hosts on one only when the higher is
  **proven** (an election certificate or a hand-over, since 2026-11-18). Two
  crown holders at one term, neither proven to the other (two parties' founders
  meeting), now each keep their own crown. Before, the lower id took both,
  which a member signing a record naming itself could exploit. Two elections
  at one term with different keys (the missed-record residual) both carry
  certificates, and the lower id wins as before. Tested over a fake
  transport only (`test-plumbing.mjs`); no real partition has been staged.
- When two direct links to the same peer open at once, each side keeps the one
  that opened *last* and closes the other. If the two sides disagree on the
  order, both links close and the pair falls back to relaying until the next
  roster change. Not observed; reasoned from the code. The one place two
  offers were *made* likely — two isolated members re-announcing to the room
  server together, or a reload's returner and the member who stayed — now
  has a glare rule in room-join (a hard-NAT side's offer stands, else the
  lower id's); relayed negotiation already had one.
- **A reply carried by hand has ~15 s between some networks.** Measured
  2026-11-12 between a carrier NAT that connects only as the offerer and an
  institute NAT: the replying side's own ICE gives up ~15.6 s after its
  reply is made (Chrome's verdict, not ours), and the scan/paste flow has no
  signalling channel to rebuild the link over — inherent without TURN. A
  reply carried back later links to nothing; with the restrictive side
  replying it never links. The reply screen says to carry it back right
  away; a reply that fails says it was not used in time or the networks
  cannot connect directly, and offers MAKE A NEW REPLY (the same invite,
  answered afresh) or a new invite if the old reply was used. Nothing waits.
  Join by code has no such window (the room server carries the reply and the
  role swap). The UI is tested with a forced ICE failure (test-party,
  test-bots); the 15 s itself only on the real pair.
- A relayed negotiation is abandoned after 15 s and tried once the other way
  round (2026-11-12, for NATs that connect in one direction only); after
  that nothing retries it on a timer — the next roster change does. A pair that failed once stays
  relay-only until somebody joins, leaves or is edited. A direct link that *drops* while
  the member stays reachable is different. The second vouch for it, 2.5 s
  after the drop, dials it again (net.js `_vouch`, 2026-11-16). The second,
  not the first, so that a stale vouch for a member who is leaving does not
  cost an offer. Left relay-only, a pair split in two when their relay, the
  host, left. A drop is often seen at one end first. When the higher id still
  holds the dead link, it sets aside the lower id's offer, and a resend of
  that offer would be dropped as already seen. So when the higher id notices
  and asks about the lower id (`__q`), the lower id abandons its offer and
  makes a fresh one (`_redial`). It abandons only an offer already sent: one
  still gathering is left to go out, and an offer abandoned while it gathers
  is never sent. Each offer carries a nonce that its answer echoes, so an
  answer to an abandoned offer cannot land on the one that replaced it.
- The 3 s grace on `disconnected` is observed in the NAT lab, not on a phone:
  4 s and 8 s blackouts keep the link; Chrome itself declares `disconnected`
  some seconds in, so a link survives a blackout of roughly 9 s. It cannot
  rescue a network *switch* (nothing performs an ICE restart); that heals by
  the member re-announcing itself to the room server once its last link
  drops, measured at ~10.5 s from switch to links back. A classic (no room
  server) party has no such path: a switched member is simply gone.
- `leave()`'s `__gone` is best-effort: it is handed to the channel, which is
  kept alive 250 ms to drain. A page that navigates away instantly may cut it
  off, and the peers then fall back to the probe (and, for a room-server
  member, the reconnect grace).
- **A crown that moves under a running game hands it over** (2026-11-13). Every
  game keeps its state on its host, but each sends it to everyone, so 1.5 s
  after the move (a flicker that settles back changes nothing) the new host
  calls the game's `takeOver()` and carries on from what it was sent; the old
  host's seat is held like any lost player's (the turn banner covers a turn
  of theirs), and an old host whose tab survived the blip remounts as a guest.
  What is lost is whatever lived only on the old host, so: Connect 4
  continues where it was; Light
  Cycles restarts the round, wins kept; Neon Survival takes the bots' ships
  over from where they were last seen; Draw & Guess goes on if the new host
  knows the word, else restarts the round with a new one; Liar's Dice re-rolls
  the round, dice kept; Neon Bid reopens the unsettled lot, credits and gems
  kept (Lokesh's choices). **Battleship ends** ("…so the game ended."): the
  bots' fleets left with the old host. Undercover is one device. Not covered:
  a game's in-flight message the old host never relayed; Neon Survival's
  first seconds under the new host include the 3-2-1 (the old host's closed
  tab read as out of the app). test-worker 14, test-party.
- **Battleship's audit is never triggered in real play**, because no player here
  can cheat: every client runs the same honest `answerShot`. The audit is tested
  against deliberately corrupted answers, which is the right test, but a genuine
  modified client has never been pointed at it.
- Battleship's placement auto-commits a few seconds before the deadline so a
  player who walks away cannot stall the game. That path is not covered by any
  test — it takes 142 seconds to reach.
- Neon Bid's bot may be too strong for a casual table: it beats both baseline
  bidders in every measured game, and nothing here measures it against people.
  Its audit, like Battleship's, has only been tripped by deliberately broken
  openings in the rules test — every real client opens honestly.
- Liar's Dice trusts each player's *roll*. The commitment stops a player
  changing dice after seeing a bid, which is the cheat that decides rounds; it
  does nothing about a modified client that re-rolls until it likes its hand,
  and nothing short of a shared random beacon would.
- Draw & Guess's word still goes to the drawer **addressed, not sealed**. A
  relaying player could read it. That is the honest level of protection for a
  party game whose worst case is a spoiled round, but it is a choice, not an
  oversight.
- Onitama was removed 2026-11-13 (Lokesh): it recreated a published board
  game, which the platform's own rules (CONTRIBUTING.md) do not allow.
- The Firefox install hints are reasoned from the platform, not observed.
  Firefox's *multiplayer* is verified (2026-11-12): `just test-pair
  --browser=firefox` on production, Firefox↔Chrome and Firefox↔Firefox
  across two real networks, every phase passed, and `classifyNat` reads the
  carrier NAT hard there as in Chrome (docs/network-testing.md). Every other
  suite runs headless Chrome.
- Cross-network play over mobile data is expected to fail on carriers using
  CGNAT/symmetric NAT — confirmed in the wild on 2026-08-10, and reproduced in
  the NAT lab (symmetric vs symmetric, and symmetric vs a port-restricted
  cone: explicit error at ~15 s, ~30 s for a code join since the role-swapped
  second try of 2026-11-12). This is the no-TURN trade-off, not a bug;
  the error now names which case you hit. The lab's NATs are Linux's; no real
  carrier's has been modelled (see network-testing.md, "What it cannot show").
- There is no TURN server by choice, so players behind symmetric NAT cannot
  connect at all; this surfaces as an explicit error, not a hang.
- Installability and offline are verified against headless Chrome only. No real
  phone has been asked to install it, and iOS in particular is unverified: it
  ignores the manifest's icons, gets no install event, and Safari's service
  worker eviction rules are its own.
- A deploy reaches an open page only on its next load; an installed app left
  open for days stays on the deploy it opened with. Nothing tells the player a
  newer one is waiting.
