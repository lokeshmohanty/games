"""arcade.py — write an arcade game's rules in Python (SDK v2, managed state).

The platform runs a managed game's rules on the host and asks them questions
(docs/sdk-v2.md, "Managed state"). This module turns those questions into
method calls on one object, so a game is a class and never sees JSON or the
protocol:

    import arcade

    class TicTacToe(arcade.Game):
        def __init__(self, seats, opts, seed, match): ...   # a new match
        def apply(self, action, by): ...    # None allows the move; a str refuses it (the reason)
        def view(self, seat): ...           # what this seat may see; seat None = a spectator
        def turn(self): ...                 # [ids] whose move it is
        def bot(self, seat): ...            # a bot's action, or None
        def result(self): ...               # None while playing, else {"kind", "ranking", ...}
        # optional: skip(self, seat), tick(self, inputs, dt), snapshot(self), restore(cls, snapshot)

    arcade.run(TicTacToe)

Every value going out must be JSON: dicts, lists, str, int, float, bool,
None (dataclasses are turned into dicts). Dicts keep the order they were
built in, which is the order the platform sees.

In the arcade, sdk/v2/adapters/python/arcade-python.js boots Pyodide in the
game's frame, runs the game's module, and hands `dispatch` to
`arcade.managedJson`. Run with plain Python (`python3 game.py`), `run` plays
the game's bots against each other instead and prints how it went.
"""

import dataclasses
import json
import sys

__all__ = ["Game", "Seat", "run", "dispatch"]


@dataclasses.dataclass
class Seat:
    """A seat at the table: a person or a bot."""

    id: str
    name: str = ""
    team: str | None = None
    bot: bool = False

    @classmethod
    def from_json(cls, s):
        s = s if isinstance(s, dict) else {}
        return cls(id=s.get("id"), name=s.get("name") or "", team=s.get("team"), bot=bool(s.get("bot")))


class Game:
    """Subclass this. `__init__` starts a match; the platform calls the rest."""

    def __init__(self, seats, opts, seed, match):
        pass

    def apply(self, action, by):
        return "this game takes no moves"

    def view(self, seat):
        return None

    def turn(self):
        return []

    def bot(self, seat):
        return None

    def result(self):
        return None

    def snapshot(self):
        """The whole state, for the heir. By default: the instance's attributes."""
        return dict(vars(self))

    @classmethod
    def restore(cls, snapshot):
        """A game from what `snapshot` returned. By default: those attributes back."""
        game = cls.__new__(cls)
        vars(game).update(snapshot)
        return game

    # skip(self, seat) -> bool and tick(self, inputs, dt) are optional: a game
    # without skip says it cannot skip a turn; tick is for "tick" in game.json.


_game_class = None
_game = None


def _encode(value):
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return dataclasses.asdict(value)
    raise TypeError(f"{type(value).__name__} is not JSON")


def _call(c):
    global _game
    fn = c.get("fn")
    if _game_class is None:
        raise RuntimeError("arcade.run(YourGame) was never called")
    if fn == "init":
        seats = [Seat.from_json(s) for s in c.get("seats") or []]
        _game = _game_class(seats, c.get("opts") or {}, c.get("seed"), c.get("match", 0))
        return None
    if fn == "restore":
        _game = _game_class.restore(c.get("snapshot"))
        return None
    if _game is None:
        raise RuntimeError(f'"{fn}" before "init"')
    if fn == "apply":
        return _game.apply(c.get("action"), c.get("by"))
    if fn == "view":
        return _game.view(c.get("seat"))
    if fn == "turn":
        return list(_game.turn())
    if fn == "bot":
        return _game.bot(c.get("seat"))
    if fn == "result":
        return _game.result()
    if fn == "snapshot":
        return _game.snapshot()
    if fn == "skip":
        skip = getattr(_game, "skip", None)
        if skip is None:
            return False
        done = skip(c.get("seat"))
        return True if done is None else bool(done)
    if fn == "tick" and hasattr(_game, "tick"):
        return _game.tick(c.get("inputs") or {}, c.get("dt"))
    raise RuntimeError(f'no rule "{fn}"')


def dispatch(text):
    """One rules call as JSON in, its outcome as JSON out: {"v": …} or {"err": "…"}."""
    try:
        out = {"v": _call(json.loads(text))}
    except Exception as err:  # the author's bug goes back to the platform as the call's error
        out = {"err": str(err) or type(err).__name__}
    try:
        return json.dumps(out, default=_encode, allow_nan=False, separators=(",", ":"))
    except (TypeError, ValueError) as err:
        return json.dumps({"err": f'"{json.loads(text).get("fn")}" returned something that is not JSON: {err}'})


def run(game_class):
    """Hand the platform your game. Call once, at the end of your module."""
    global _game_class
    if not (isinstance(game_class, type) and issubclass(game_class, Game)):
        raise TypeError("arcade.run takes your Game subclass")
    _game_class = game_class
    if sys.platform != "emscripten":
        _play_locally()


def _play_locally(moves=500):
    """Outside the arcade: two bots play one match, through dispatch, as the host would."""
    ask = lambda **c: json.loads(dispatch(json.dumps(c)))
    seats = [{"id": "bot_A", "name": "Bot A", "team": "A", "bot": True}, {"id": "bot_B", "name": "Bot B", "team": "B", "bot": True}]
    print(ask(fn="init", seats=seats, opts={}, seed=1, match=0))
    for _ in range(moves):
        result = ask(fn="result")
        if result.get("v") is not None or "err" in result:
            break
        on_turn = ask(fn="turn").get("v") or []
        if not on_turn:
            break
        action = ask(fn="bot", seat=on_turn[0]).get("v")
        print(on_turn[0], action, ask(fn="apply", action=action, by=on_turn[0]))
    print("view:", ask(fn="view", seat=None))
    print("result:", ask(fn="result"))
