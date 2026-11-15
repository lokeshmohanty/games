# A prompt for your AI: make my game run on the Arcade

Copy everything below the line into your AI coding assistant (Claude,
ChatGPT, Copilot, Cursor…), in the folder of your game's repository. It
gives the assistant what it needs to adapt your game to the Arcade, or to
start a new one, and to check it the way the Arcade's pull-request check
will.

---

You are helping me put a game on **the Arcade**
(https://www.lokeshmohanty.in/games/, source https://github.com/lokeshmohanty/games).
It is a free, serverless, multiplayer games site. Players' phones connect to
each other directly (WebRTC), bots fill empty seats, and every game is
multiplayer; playing alone means playing the bots. Outside authors keep
their games in their own public GitHub repository. The Arcade pins a commit
of it, copies the listed game folders at deploy, and runs each game in a
sandboxed iframe.

**Before writing any code**, ask me, one question at a time if you need to:
1. Which game: an existing one of mine (show me what you found in this
   repo), or a new idea?
2. Which language: JavaScript, TypeScript (with Solid if it has UI), HTML
   and CSS only, Rust, C/C++, Go, or Python?
3. How many players, whether it is real-time or turn-based, and whether any
   player must keep information hidden from the others (a hand of cards, a
   sealed bid)?

Then read these, in this order, and follow them exactly. Fetch the raw files
if you cannot browse:
- https://raw.githubusercontent.com/lokeshmohanty/games/main/docs/sdk-v2.md
  (the contract: a message protocol, managed state, the adapters,
  WebAssembly, the manifest, the rules a game must follow)
- https://raw.githubusercontent.com/lokeshmohanty/games/main/CONTRIBUTING.md
  (the repository layout, the dev kit, validation, how to submit)
- https://raw.githubusercontent.com/lokeshmohanty/games/main/sdk/v2/protocol.json
  (every message, as JSON Schema)
- The example for my language:
  `https://github.com/lokeshmohanty/games/tree/main/sdk/v2/examples/tic-tac-toe-<lane>`,
  where `<lane>` is js, html, ts, rust, c, go or python, and its adapter's
  README in `sdk/v2/adapters/<lane>/`.

## What the Arcade requires (the short version; the docs are the authority)

- **One folder per game**, holding:
  - `game.json`: `"sdk": 2`, `id`, `name`, `blurb`, `entry` (an .html in
    the folder), `kind` (duel, ffa, teams, coop, local, shared), `shape`,
    `seats: { min, max }`, `bots`, `categories` (from arcade, party,
    strategy, puzzle), `license`, `author` (my GitHub login), `repo`, and
    `rules: "RULES.md"`;
  - for WebAssembly, also `"runtime": "wasm"` and `"wasm": "<file>"`; for
    Python, `"runtime": "python"`;
  - for the platform to run the game for me, `"state": "managed"`, plus
    `"tick"` (Hz) for a real-time game.
- **The frame can fetch nothing.** The Content Security Policy allows no
  network. The Arcade inlines every `<script src>` and stylesheet the entry
  page names, as classic scripts, so each script must be one complete
  bundle: no `import`, no `import()`, no code-splitting. Files come through
  the `asset` request, and a WASM module arrives as bytes in `init`. Never
  use WebRTC, WebSockets, fetch or remote URLs yourself.
- **Prefer managed state.** Write only the rules (`init`, `apply`, `view`,
  `turn`, `bot`, `result`, `snapshot`, `restore`, and optionally `tick`,
  `skip`, `leave`) and a draw function. The platform then does host
  authority, the views each phone sees, bots, waiting for a player who left,
  the end card, rematches and host handover. Use **Layer 1** (channels plus
  the shell's `commit` / `verify` / `seal` services) only when the host must
  not see a player's hidden information.
- **Bots** must exist for every seat that can be a bot (`bot({ seat })`),
  and must play sensibly, not randomly.
- **Results:** `result()` returns `{ kind, ranking: [[winner ids], …],
  scores?, title?, details? }`. Every phone reports the result, and the
  platform counts it once.
- **Look:** take colours from the theme (`arcade.theme.tokens` and
  `players`, or the CSS variables `var(--accent)` and so on), not literal
  colours. Design for a 390×844 phone first: touch and mouse, nothing
  scrolling sideways, nothing under the top-right buttons.
- **RULES.md:** the rules in plain language, with a short worked example of
  a turn and of how someone wins. Players see it the first time they open
  the game and behind "?".
- **Language lanes:** JS and HTML need no build. TS, Rust, C and Go need a
  build script, and the built output is committed, because the Arcade never
  builds contributor code. Copy the adapter files into the game folder: the
  frame may only read its own folder.

## Your workflow

1. Plan the change and show me the plan: files, the lane (managed or
   Layer 1), and how the bot plays. Wait for my OK.
2. Write the game folder, RULES.md and game.json. Port an existing game's
   logic faithfully; for a new game, keep it small and finished.
3. Test it exactly as the Arcade will. Clone https://github.com/lokeshmohanty/games
   beside my repo, then:
   - `node ../games/scripts/validate-game.mjs <my game folder>`: the
     manifest, size (10 MB), files, then a real browser mount at 390×844
     with bots and no CSP violation. It must pass.
   - The dev kit: `node ../games/sdk/dev-server.mjs <folder holding my
     games>` prints a link that opens the real Arcade with my game loaded
     from my machine. Play it against bots, and with a second browser tab
     invited as a friend.
   - For a managed game, also check the rules in isolation: call
     `init`/`apply`/`result` from a small script, play a full game with
     `bot()` on every seat, and check it ends.
4. Fix everything validation reports. Warnings about colours are allowed,
   but tell me about them.
5. Tell me how to submit. Either open https://www.lokeshmohanty.in/games/?page=contribute
   and paste my repo (it fills in GitHub's own page for a
   `registry/<me>/<repo>.json` pull request), or create that file by hand
   as CONTRIBUTING.md shows. The Arcade's check runs validate-game on my
   pinned commit.

Do not invent APIs. If something you need is not in sdk-v2.md or
protocol.json, say so and ask me rather than guessing.
