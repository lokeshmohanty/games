# Putting your game in the arcade

You write the game; the arcade gives it players. Connections between phones
(no server, no sign-up), the party screen, bots in empty seats, host
handover, offline play and the installed app all come from the platform.
Your code stays in **your own public GitHub repository**; the arcade lists it
at a commit you choose.

The full reference is [`docs/sdk-v2.md`](docs/sdk-v2.md). This page is the
workflow. If you work with an AI assistant, give it
[`docs/contributor-prompt.md`](docs/contributor-prompt.md).

*Changing the arcade itself rather than adding a game? See
[Working on the arcade itself](#working-on-the-arcade-itself) at the end.*

## Already have a web app? Bring it as it is

A site you already built — React, Vite, plain HTML — and the Python server it
talks to (FastAPI, Starlette or Flask) run unchanged. Add two files to your
repository and propose it (step 4):

- a `LICENSE` (see rule 6), and
- a `game.json` that says how to build it:

```json
{
  "sdk": 2, "id": "my-game", "name": "My Game", "blurb": "…",
  "kind": "shared", "seats": { "min": 1, "max": 8 }, "bots": false,
  "entry": "index.html", "license": "MIT",
  "author": "<your-github-user>", "repo": "https://github.com/<you>/<repo>",
  "app": {
    "build":  { "dir": "frontend", "run": "npm ci && npm run build", "out": "frontend/dist" },
    "server": { "python": "backend", "asgi": "main:app" }
  }
}
```

Paths are relative to the folder holding `game.json` (the registry entry may
list `"."`, the repository itself). Use `"web": "site"` instead of `build`
for a folder that needs no build, and `"wsgi": "app:app"` for Flask.

What the arcade does for you:

- **builds** your site at the pinned commit, in a throwaway container with no
  secrets — commit your lock file;
- **runs your server on the host's phone** (Python in WebAssembly — no server
  of yours is needed, and none is contacted). Every request your site makes
  to *any* address — `http://localhost:8000/state` included — goes to it.
  Dependencies come from `pyproject.toml` or `requirements.txt`; one that
  cannot run in a browser (a database driver, say) imports as a stub that
  only fails if it is used;
- **shares your address**: `?game=<id>` set with `history.pushState` or
  `location.href` moves every phone in the party there, so a game shared by
  link is shared across the party;
- serves `<img src="/x.svg">`, `fetch("/data.json")` and
  `window.open("/rules.html")` from your built site.

`kind: "shared"` means one screen that every phone runs and anyone may act
on: no seats, bots or results. When the host leaves, the game ends — the
server's state left with them. Your server's state lives in memory for the
length of a game; a database it would use instead is not there.

To try it: build it, then run the dev kit (step 2) in the folder with
`game.json`. Packages Pyodide does not ship are stubs in the dev kit; the
arcade's build fetches them.

## 1. Start from an example

The same small game, Tic Tac Toe, is written once for each language the
arcade takes. Copy the one for your language into your repository. Each is a
complete managed game: the rules, a bot, a drawing, `game.json` and `RULES.md`.
The platform does the rest: syncing the phones, host handover, rejoining and
the end card. Play each one first to see what you'll get.

- **JavaScript**, no build: [code](sdk/v2/examples/tic-tac-toe-js) · [play it](https://www.lokeshmohanty.in/games/?game=tic-tac-toe-js)
- **HTML and CSS**, no drawing code, only `data-arcade-*` attributes: [code](sdk/v2/examples/tic-tac-toe-html) · [play it](https://www.lokeshmohanty.in/games/?game=tic-tac-toe-html)
- **TypeScript**, with the view in Solid, built by Vite: [code](sdk/v2/examples/tic-tac-toe-ts) · [play it](https://www.lokeshmohanty.in/games/?game=tic-tac-toe-ts)
- **Rust**, compiled to WebAssembly with wasm-bindgen: [code](sdk/v2/examples/tic-tac-toe-rust) · [play it](https://www.lokeshmohanty.in/games/?game=tic-tac-toe-rust)
- **C/C++**, compiled to WebAssembly with Emscripten: [code](sdk/v2/examples/tic-tac-toe-c) · [play it](https://www.lokeshmohanty.in/games/?game=tic-tac-toe-c)
- **Go**, compiled to WebAssembly with TinyGo: [code](sdk/v2/examples/tic-tac-toe-go) · [play it](https://www.lokeshmohanty.in/games/?game=tic-tac-toe-go)
- **Python**, run by the arcade's own Pyodide: [code](sdk/v2/examples/tic-tac-toe-python) · [play it](https://www.lokeshmohanty.in/games/?game=tic-tac-toe-python)

A language with a build has a `build.sh`, and its adapter, with a README, is
in [`sdk/v2/adapters/`](sdk/v2/adapters). One folder per game; a repository
may hold several games:

```
my-games/
  laser-chess/
    game.json        the manifest: "sdk": 2, id, name, seats, kind, licence…
    index.html       your page: only your own <script> and <link> tags
    laser-chess.js   your rules and drawing: arcade.managed({ init, apply, view, … })
    RULES.md         how to play: shown on a first open and behind "?"
    preview.gif      shown on the portal (optional)
```

The contract (the messages, managed state, the manifest) is
[`docs/sdk-v2.md`](docs/sdk-v2.md). Larger worked examples are Connect 4,
Neon Bid (hidden information), Neon Fission, Undercover (one phone passed
around) and Neon Survival (real time) in [`games/`](games), with more in
[lokeshmohanty/web-games](https://github.com/lokeshmohanty/web-games).

### How to play: RULES.md

The first time someone opens your game on a device, the arcade shows your
rules over it, and the party's **?** button shows them again at any time.
Write them in a Markdown file in the game's folder and name it in
`game.json`: `"rules": "RULES.md"`. Without it there is no **?** and nothing
is shown.

- **Short.** A phone reads it in about a minute: the goal in a sentence or
  two, then *How to play*, *Scoring*, *Winning*, *Example* and *Controls*.
- **An example with real values.** One turn played out, what it scored, and
  how a game is won. Connect 4's numbers the columns and plays a short
  game out ([`games/connect4/RULES.md`](games/connect4/RULES.md)).
- **What your code does**, not what the board game you know does: board
  size, timers, ties, what bots do, which taps and keys work.
- **Plain Markdown only:** headings, paragraphs, flat lists, bold, italic,
  `code` and links. Tables, images, nested lists and HTML are not drawn.

The arcade fetches the file from your folder, so it works offline like the
rest of your game. Nothing reaches your game: the sheet is the player's
own, and your game keeps running under it, for them and for everyone else.

## 2. Play it in the real arcade, from your machine

```sh
curl -fsSLO https://www.lokeshmohanty.in/games/sdk/dev-server.mjs
node dev-server.mjs          # serves this folder on http://127.0.0.1:5174
```

It prints one link per game. Open it: the live arcade loads your game from
your machine (only from `localhost`/`127.0.0.1`). Press **PLAY A BOT**, or
**INVITE A FRIEND** and open the invite in a second tab to be the other
player. Edit, reload. Chrome may ask once to let the site reach your machine.

## 3. Check it like the arcade will

```sh
git clone https://github.com/lokeshmohanty/games && cd games
just validate-game ../my-games/laser-chess      # or: node scripts/validate-game.mjs …
```

It checks the manifest, the 10 MB limit and (for a WebAssembly game) the
module, warns about code that looks as if it loads more code or uses the
network, and then mounts the game with bots at phone size (390×844) and plays
5 s under the frame's real CSP, failing on any CSP violation, error or
sideways scrolling. The pull-request check runs
exactly this.

**The rules** (why: [`docs/sdk-v2.md`](docs/sdk-v2.md#the-rules-a-game-must-follow-v2)). Rules 1–3 are for games
written for the SDK; a web app (above) is held to them by the arcade itself.

1. Each `<script>` is a complete bundle — plain JS needs nothing; with a
   bundler, emit single files (no dynamic `import()`, no chunks).
2. No network: no `fetch`, WebSocket or CDN. Ship files in the folder and
   load them with `ctx.assets.url(path)`.
3. Scripts and stylesheets come from the game's own folder.
4. Host-authoritative: the host's copy is the truth; bots run on the host.
5. Phone first: it must fit and play at 390×844 with touch.
6. An OSI licence that allows redistribution (MIT, Apache-2.0, BSD, ISC,
   MPL-2.0, GPL-3.0, AGPL-3.0, 0BSD, Unlicense) — the arcade serves a copy.
7. Your own work: no recreations of someone else's game, characters or art.
8. **Colours: the theme's, if you want them.** Your own colours are
   allowed; your game then keeps its look whatever theme the player picked,
   and the check prints a warning, not a failure. To follow the theme, use
   the CSS tokens (`var(--ink)`, `var(--accent)`, `var(--p1)`…`var(--p8)` for
   players…) and, on a canvas, `NeonArcade.palette()` — then redraw on the
   `neon:theme` event. A line that should not count carries `theme-exempt`.

Built files must be **committed**: the arcade never builds or runs your
tooling, it copies the folder at the pinned commit.

## Your card on the Contributors page

Optional: a `contributor.json` at the root of your repository says how you
appear on the [Contributors](./?page=contributors) page — your GitHub avatar
and login are shown anyway.

```json
{
  "name": "Ada Lovelace",
  "bio": "Small strategy games for two.",
  "location": "London",
  "links": [{ "label": "Blog", "url": "https://example.com" }]
}
```

Name ≤ 40, bio ≤ 280, location ≤ 40 characters, up to 5 https links. It is
read at the same pinned commit as your games, so it changes with your next
pin bump.

## 4. Open a pull request

On the [Add your game](./?page=contribute) page, type your repository
(`owner/name`) under **Propose your games**: it opens GitHub's page for your
registry file, filled in with your latest commit and every folder holding a
`game.json`. Commit it there and GitHub offers the pull request. (From a
checkout: `just propose owner/name`.) The file it makes:

```json
// registry/<your-github-user>/<your-repo>.json
{
  "repo": "https://github.com/<your-github-user>/<your-repo>",
  "commit": "<the full 40-character commit sha>",
  "games": ["laser-chess"]
}
```

Your pull request is checked by itself (the **Check game submission**
workflow, on every PR that touches `registry/`):

- it changes only `registry/<you>/<repo>.json` — your own repos;
- the entry is well formed and its commit is in your public repo;
- an update moves your pin forward (never back, never to another branch);
- every listed game is fetched (and a web app built) at that commit and
  passes `validate-game` (manifest, 10 MB, no CSP violation,
  your `contributor.json`, and a play with bots at phone size — for a web app,
  its server starting and answering; own colours are a warning).

The result is posted as a comment and as labels — `game-submission`,
`submission: new` / `update`, and `checks passed` / `changes needed` — so
maintainers can filter submissions (`label:game-submission`). Push a fix and
it is checked again. Once a maintainer merges it, the site deploys by itself
and lists your games as `<your-github-user>/<id>`.

**To update**, push to your repo, then press **Check for updates** on your
card on the [Contributors](./?page=contributors) page (or use Propose your games
again, or `just propose`). One tap copies your new commit and opens your
pin's edit page: select the old commit in the `"commit"` line, paste, then
*Commit changes → Create a new branch… and start a pull request*. (GitHub can
fill in a new file but not an edit, so this one paste is the only typing.)
The pull request is yours to open; nothing opens one for you.

## Review and removal

A maintainer reads the diff of what will be served (the pinned folders) and
plays the game. A game can be removed — by reverting its registry file — for
breaking the rules above, for content that is hateful, sexual or harmful,
or on its author's request.

## Working on the arcade itself

For changes to the platform (the shell, the party, the SDK, the Worker), not
to a game in your own repository.

1. **Run it:** `just run` serves the site at http://127.0.0.1:8000, and edits
   reload. You need Node 24 and pnpm; the recipes install the dependencies
   from the lockfile. [docs/development.md](docs/development.md) covers the
   LAN server, the build and where the code is.
2. **Read first:** [`docs/`](docs/index.md) explains how things work and why,
   and records the decisions taken. Read the part you're changing before you
   change it.
3. **House rules:**
   - Phones come first. Check every UI change at 390×844, with no sideways
     scroll and tap targets of at least 44 px.
   - Colours come only from the theme tokens in `lib/theme.css`
     (`just check-colours`).
   - The games and `lib/` stay framework-free.
   - Nothing reaches outside the site except STUN. That means no
     third-party services, CDNs or trackers.
4. **Test:** `just test` runs every suite. The Worker suites
   (`just test-worker`, `just test-accounts`, `just test-social`) run under
   wrangler. A change to how something behaves comes with a test that fails
   without it.
5. **Pull request:** work on a branch and open a pull request against `main`.
   Update the matching page in `docs/` in the same pull request.
