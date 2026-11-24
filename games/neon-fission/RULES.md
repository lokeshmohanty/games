# Neon Fission

Fill cells with orbs until they burst. A burst takes over the cells next to it, and bursts set off more bursts. Be the last player with cells on the grid.

## Setting up
- The setup shows only the first time, for a party's first game with friends. The host picks a **plain grid** or **voids**, then taps **START**.
- **Voids** take 2 or 4 cells out of the grid, placed differently every game, in pairs facing each other across the middle so neither side gets a better board. A void holds nothing and cannot be played. The cells next to a void have one neighbour fewer, so they burst one orb sooner.
- **PLAY AGAIN** goes straight on with the same choice, and so does a game started alone or with people on your phone (with the choice you last played; a plain grid the first time).
- At the end the host sees **Next game: plain grid · CHANGE** (tap SEE THE BOARD to reach it): CHANGE picks the grid for the next game.

## How to play
- 2 to 8 players take turns in seat order. Each player has a colour.
- A random player goes first in the first game. On each **PLAY AGAIN**, the player after them in seat order goes first, so everyone gets a turn to start.
- The grid is 6 × 9 for 2 to 4 players, and 8 × 12 for 5 to 8.
- On your turn, add one orb to an empty cell or to a cell that is already yours. You cannot play in another player's cell.
- A cell bursts when it holds as many orbs as it has neighbours (up, down, left, right):
  - a corner cell bursts at **2** orbs,
  - an edge cell at **3**,
  - any other cell at **4**.
  - A cell next to a void bursts one orb sooner.
- A dashed ring around a cell means it is one orb away from bursting.
- When a cell bursts, it empties and sends one orb to each neighbour. Every cell that gets an orb becomes yours, with all the orbs already in it.
- If that fills a neighbour up, it bursts too. Bursts run in waves until the grid settles.
- Bots can fill empty seats.

## Scoring
- There are no points. What counts is having cells.
- The end card shows the turns played, the biggest chain and how many cells the winner held.

## Winning
- Once you have had your first turn, owning no cells puts you out.
- If you miss your first turn (the host skips it), you get one more round. Missing it twice counts as a turn.
- The last player with cells on the grid wins. The rest are ranked by how long they lasted.
- A chain stops as soon as one player owns every orb on the grid.
- If a player leaves, their cells stay until someone takes them.

## Example
Columns are A to F from the left, rows 1 to 9 from the top. Red holds A1 (1 orb) and B1 (2 orbs). Blue holds A2 (2 orbs), C1 (1 orb), B2 (1 orb) and F9 (1 orb).

1. Red adds an orb to the corner A1. It now holds 2, a corner's limit, so it bursts.
2. **Wave 1:** A1 empties and sends one orb to B1 and one to A2. B1 now holds 3. A2 turns red and also holds 3. Both are edge cells, so both burst.
3. **Wave 2:** B1 sends orbs to A1, C1 and B2. A2 sends orbs to A1, B2 and A3. C1 turns red with 2 orbs and B2 turns red with 3. A1 has picked up 2 orbs again, so it bursts once more.
4. **Wave 3:** A1 sends one orb each to B1 and A2. Nothing else is full, and the grid settles.
5. Red now holds B1, A2, A3, C1 and B2. Blue is down to F9.

Without Blue's orb in F9, wave 2 would have taken Blue's last cell. The chain stops right there, Blue is out and Red wins.

## Controls
- Tap a cell to add your orb.
- Tap the grid while a chain is playing to skip to the end of it.

## Playing on one phone
- In **SINGLE PLAYER / SAME DEVICE**, add bots in the party, then start.
- Before the first move, switch any seat from **BOT** to **PLAYER** for a person sitting with you, then tap **START**.
- On a player's turn, the top of the screen shows their name and colour: pass them the phone.
