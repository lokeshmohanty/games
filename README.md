# Arcade Games

Free multiplayer games for the browser, made for phones first. Play against
bots, with friends on their own phones, or with people passing one phone round.
Nothing to install and no account needed.

**Play: [lokeshmohanty.in/games](https://www.lokeshmohanty.in/games/)**

## Games

From this repository:

- **Neon Survival**: dodge the swarm, alone, with bots or with friends. 1–8 players.
- **Connect 4**: drop discs and get four in a row. One against one.
- **Neon Bid**: twelve gems, 100 credits, sealed bids, and the winner pays the
  second-highest bid. 2–8 players.
- **Neon Fission**: load cells with orbs until they burst and take their
  neighbours. The last player with cells wins. 2–8 players.
- **Undercover**: one word, one impostor, one phone passed round the table.

Also listed: Battleship, Draw & Guess, Liar's Dice, Light Cycles and Sudoku,
from [lokeshmohanty/web-games](https://github.com/lokeshmohanty/web-games), and
any game a contributor adds (see below).

## How to play

- **Alone:** open a game and choose **SINGLE PLAYER**. Bots fill the other
  seats, and once the page has loaded it works with no network.
- **On one phone:** party games say **SINGLE PLAYER / SAME DEVICE**, so you can
  pass the phone round.
- **Together:** choose **MULTI-PLAYER**, then **INVITE A FRIEND**. Share the
  link, show the QR code, or read out the party's code. Everyone connects once.
  After that the host can switch between games, add bots and set teams, and
  nobody has to reconnect.

Games connect phones directly to each other (WebRTC). No game data goes
through a server.

**Install it:** use **INSTALL APP** on the home screen, or the browser's own
install option (on iOS: Share → Add to Home Screen). Firefox on Android installs
from its ⋮ menu. Firefox on desktop can't install web apps, but it plays
offline just the same.

**Signing in is optional.** It adds leaderboards, friends and favourites that
follow you between devices.

## Add your game

Anyone can put a game in the arcade from their own GitHub repository, in
JavaScript, TypeScript, Rust, C/C++, Go or Python. See
**[CONTRIBUTING.md](CONTRIBUTING.md)**, or open the
[Add your game](https://www.lokeshmohanty.in/games/contribute.html) page.

## For developers

How the arcade works (the handshake, parties, bots, the SDK, accounts) is in
[`docs/`](docs/index.md). Running it locally, the tests and changing the arcade
itself are covered in [CONTRIBUTING.md](CONTRIBUTING.md#working-on-the-arcade-itself)
and [docs/development.md](docs/development.md).

## Licence

[MIT](LICENSE)
