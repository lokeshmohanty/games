# Tic Tac Toe

Take turns marking squares on a 3 by 3 grid. The first to get three of their marks in a line wins.

## How to play
- Two players: **X** (Team A) and **O** (Team B). Playing alone, a bot takes the other mark.
- Who moves first is picked at random for the first game. After that it alternates: on **PLAY AGAIN**, whoever went second last time goes first.
- Then you take turns.
- On your turn, mark any empty square. A square that is taken cannot be played again.

## Scoring
- There are no points. Three of your marks in a line ends the game at once.
- A line can run across, down, or corner to corner: eight lines in all.

## Winning
- The first player to complete a line of three wins.
- If all nine squares fill with no line, the game is a draw.
- The end card offers **PLAY AGAIN** for a rematch.

## Example
Squares are numbered 1 to 9, left to right, top row first.

1. X takes the centre, 5.
2. O takes the top middle, 2.
3. X takes the corner 1. X now threatens the diagonal 1, 5, 9.
4. O blocks by taking 9.
5. X takes 7. That makes two threats at once: the diagonal 3, 5, 7 and the column 1, 4, 7.
6. O can block only one of them, and takes 3.
7. X takes 4. The column 1, 4, 7 is complete, and X wins.

Had O blocked every line until the ninth square was filled, the game would end in a draw.

## The bot
- It wins if it can, blocks you if it must, otherwise takes the centre, otherwise the first free square.

## Controls
- Tap or click a square to mark it.
