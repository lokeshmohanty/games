# Putting your game in the arcade

You write the game; the arcade gives it players. Connections between phones
(no server, no sign-up), the party screen, bots in empty seats, host
handover, offline play and the installed app all come from the platform.
Your code stays in **your own public GitHub repository**; the arcade lists it
at a commit you choose.

The full reference is [`docs/sdk.md`](docs/sdk.md). This page is the
workflow.

## 1. Start from the example

Copy [`sdk/v1/example/tic-tac-toe/`](sdk/v1/example/tic-tac-toe) into your
repository. One folder per game; a repository may hold several games.

```
my-games/
  laser-chess/
    game.json        the manifest — id, name, seats, kind, licence…
    index.html       your page: only your own <script> and <link> tags
    laser-chess.js   NeonArcade.registerGame({ id, name, mount(ctx) { … } })
    preview.gif      shown on the portal (optional)
```

The example is ~170 lines and has everything a game needs: host-authoritative
state, a move channel, a bot, `ctx.reportResult`, and the handle hooks
(`onRoster`, `onPeerJoin`, `takeOver`, `unmount`). Worked examples of
larger games: Connect 4, Neon Bid (hidden information), Undercover (one phone
passed around) and Neon Survival (real-time co-op) in [`games/`](games), and
six more in [lokeshmohanty/arcade-games](https://github.com/lokeshmohanty/arcade-games).

## 2. Play it in the real arcade, from your machine

```sh
curl -fsSLO https://www.lokeshmohanty.in/games/sdk/v1/dev-server.mjs
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

It checks the manifest, that every script is one complete bundle (no
`import`, no code-splitting), that nothing uses the network, the 5 MB limit,
and then mounts the game with bots at phone size (390×844) and plays 5 s
looking for errors and sideways scrolling. The pull-request check runs
exactly this.

**The rules** (why: [`docs/sdk.md`](docs/sdk.md)):

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
8. **Colours come from the theme.** Use the CSS tokens (`var(--ink)`,
   `var(--accent)`, `var(--p1)`…`var(--p8)` for players…) and, on a canvas,
   `NeonArcade.palette()` — then redraw on the `neon:theme` event. Players pick
   a theme (Paper light/dark, Neon); your game follows it. A colour that must
   not change (a QR code) carries a `theme-exempt` comment saying why.

Built files must be **committed**: the arcade never builds or runs your
tooling, it copies the folder at the pinned commit.

## Your card on the Contributors page

Optional: a `contributor.json` at the root of your repository says how you
appear on the [Contributors](contributors.html) page — your GitHub avatar
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

Push your repository, then add one file here:

```json
// registry/<your-github-user>/<your-repo>.json
{
  "repo": "https://github.com/<your-github-user>/<your-repo>",
  "commit": "<the full 40-character commit sha>",
  "games": ["laser-chess"]
}
```

The check fetches that commit, validates every listed game and plays each in
a headless browser. Once merged, the next deploy lists your games as
`<your-github-user>/<id>`.

**Updates come by themselves.** Every 30 minutes a workflow
(`registry-bump.yml`) looks at your repo's default branch; when it has moved,
it opens a pull request bumping your `commit`, runs the same checks, and
puts the result in the PR. A maintainer reads the diff and merges it (owners
in `registry/trusted.txt` are merged automatically when the checks pass).
You never edit the pin by hand after the first PR.

## Review and removal

A maintainer reads the diff of what will be served (the pinned folders) and
plays the game. A game can be removed — by reverting its registry file — for
breaking the rules above, for content that is hateful, sexual or harmful,
or on its author's request.
