# Tic Tac Toe — SDK v2 managed state, in Python (docs/sdk-v2.md).
#
# The rules are a class; arcade.py (sdk/v2/adapters/python) runs it in
# Pyodide on the host and the platform does the rest: views, bots, the
# turn-wait banner, results, the end card, the heir. The same rules as
# ../tic-tac-toe-js, the conformance reference: same views, refusals, bot and
# result for the same moves (scripts/test-conformance.mjs). `python3 game.py`
# plays two bots against each other.

import arcade

LINES = [(0, 1, 2), (3, 4, 5), (6, 7, 8), (0, 3, 6), (1, 4, 7), (2, 5, 8), (0, 4, 8), (2, 4, 6)]


def winner_of(b):
    """1 or 2: that mark has a line; 0: a draw; None: still going."""
    for x, y, z in LINES:
        if b[x] and b[x] == b[y] == b[z]:
            return b[x]
    return 0 if all(b) else None


def square(action):
    """The square an action names, or None when it names none on the board."""
    i = action.get("i") if isinstance(action, dict) else None
    if isinstance(i, float) and i.is_integer():
        i = int(i)
    return i if type(i) is int and 0 <= i <= 8 else None


class TicTacToe(arcade.Game):
    def __init__(self, seats, opts, seed, match):
        def team(t, i):
            seat = next((s for s in seats if s.team == t), seats[i] if i < len(seats) else None)
            return seat.id if seat else None

        self.board = [0] * 9
        self.turn_mark = 1  # 1: X to move, 2: O
        self.winner = None
        self.x = team("A", 0)
        self.o = team("B", 1)

    def mark_of(self, id):
        return 1 if id == self.x else 2 if id == self.o else 0

    def id_of(self, mark):
        return self.x if mark == 1 else self.o

    def apply(self, action, by):
        i = square(action)
        if self.winner is not None:
            return "the game is over"
        if self.mark_of(by) != self.turn_mark:
            return "not your turn"
        if i is None or self.board[i]:
            return "that square is taken"
        self.board[i] = self.turn_mark
        self.turn_mark = 3 - self.turn_mark
        self.winner = winner_of(self.board)
        return None

    def view(self, seat):
        return {
            "board": list(self.board),
            "turn": self.turn_mark,
            "winner": self.winner,
            "x": self.x,
            "o": self.o,
            "you": self.mark_of(seat) if seat else 0,
        }

    def turn(self):
        return [self.id_of(self.turn_mark)] if self.winner is None else []

    def bot(self, seat):
        # Win if it can, block if it must, else the centre, else the first free.
        free = [i for i, m in enumerate(self.board) if not m]

        def wins(mark):
            return next((i for i in free if winner_of([mark if j == i else m for j, m in enumerate(self.board)]) == mark), None)

        i = wins(self.turn_mark)
        if i is None:
            i = wins(3 - self.turn_mark)
        if i is None:
            i = 4 if 4 in free else free[0] if free else None
        return None if i is None else {"i": i}

    def result(self):
        if self.winner is None:
            return None
        if self.winner == 0:
            return {"kind": "duel", "ranking": [[self.x, self.o]]}
        return {"kind": "duel", "ranking": [[self.id_of(self.winner)], [self.id_of(3 - self.winner)]]}

    def skip(self, seat):
        self.turn_mark = 3 - self.turn_mark
        return True

    # snapshot / restore: arcade.Game's defaults (every attribute above is JSON).


arcade.run(TicTacToe)
