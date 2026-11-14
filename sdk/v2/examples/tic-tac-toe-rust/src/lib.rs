//! Tic Tac Toe — SDK v2 managed state, in Rust compiled to WebAssembly
//! (docs/sdk-v2.md "Managed state", sdk/v2/adapters/rust).
//!
//! The whole game is its rules and a draw function. The rules are here, as
//! an `arcade::Game`; the draw function is tic-tac-toe.js. The platform runs
//! the rules on the host, sends each phone its view, moves the bots, shows
//! the turn-wait banner, reports the result, draws the end card and hands the
//! game to the heir if the host leaves.
//!
//! These are the rules of ../tic-tac-toe-js, the conformance reference, and
//! must give exactly its views and results (scripts/test-conformance.mjs).

use arcade::{Game, Kind, Outcome, Seat};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const LINES: [[usize; 3]; 8] = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];

/// Some(1) or Some(2): that mark won; Some(0): a draw; None: still going.
fn winner_of(b: &[u8; 9]) -> Option<u8> {
    for [x, y, z] in LINES {
        if b[x] != 0 && b[x] == b[y] && b[x] == b[z] {
            return Some(b[x]);
        }
    }
    b.iter().all(|&m| m != 0).then_some(0)
}

/// The whole state, and the heir's snapshot. Marks: 0 empty, 1 X, 2 O.
#[derive(Clone, Serialize, Deserialize)]
pub struct TicTacToe {
    board: [u8; 9],
    turn: u8,
    winner: Option<u8>,
    x: Option<String>,
    o: Option<String>,
}

/// A move, `{"i": 0..8}`. Anything else is kept, to be refused in the
/// reference's order (game over, then turn, then square).
#[derive(Serialize, Deserialize)]
#[serde(untagged)]
pub enum Move {
    Square { i: i64 },
    Other(Value),
}

/// One seat's view: the state, and which mark is `you` (0: spectating).
#[derive(Serialize)]
pub struct View {
    #[serde(flatten)]
    state: TicTacToe,
    you: u8,
}

impl TicTacToe {
    fn mark_of(&self, id: &str) -> u8 {
        if self.x.as_deref() == Some(id) {
            1
        } else if self.o.as_deref() == Some(id) {
            2
        } else {
            0
        }
    }
    fn id_of(&self, mark: u8) -> Vec<String> {
        if mark == 1 { &self.x } else { &self.o }.iter().cloned().collect()
    }
}

impl Game for TicTacToe {
    type Action = Move;
    type View = View;
    type Snapshot = TicTacToe;

    fn init(seats: Vec<Seat>, _opts: Value, _seed: i64, _match_no: i64) -> Self {
        let team = |t: &str, i: usize| seats.iter().find(|s| s.team.as_deref() == Some(t)).or(seats.get(i)).map(|s| s.id.clone());
        TicTacToe { board: [0; 9], turn: 1, winner: None, x: team("A", 0), o: team("B", 1) }
    }

    fn apply(&mut self, mv: Move, by: &str) -> Result<(), String> {
        if self.winner.is_some() {
            return Err("the game is over".into());
        }
        if self.mark_of(by) != self.turn {
            return Err("not your turn".into());
        }
        let i = match mv {
            Move::Square { i } if (0..9).contains(&i) && self.board[i as usize] == 0 => i as usize,
            _ => return Err("that square is taken".into()),
        };
        self.board[i] = self.turn;
        self.turn = 3 - self.turn;
        self.winner = winner_of(&self.board);
        Ok(())
    }

    fn view(&self, seat: Option<&str>) -> View {
        View { state: self.clone(), you: seat.map_or(0, |s| self.mark_of(s)) }
    }

    fn turn(&self) -> Vec<String> {
        if self.winner.is_none() { self.id_of(self.turn) } else { vec![] }
    }

    /// Win if it can, block if it must, else the centre, else the first free.
    fn bot(&self, _seat: &str) -> Option<Move> {
        let free: Vec<usize> = (0..9).filter(|&i| self.board[i] == 0).collect();
        let wins = |mark: u8| {
            free.iter().copied().find(|&i| {
                let mut b = self.board;
                b[i] = mark;
                winner_of(&b) == Some(mark)
            })
        };
        let i = wins(self.turn)
            .or_else(|| wins(3 - self.turn))
            .or_else(|| free.contains(&4).then_some(4))
            .or_else(|| free.first().copied());
        i.map(|i| Move::Square { i: i as i64 })
    }

    fn result(&self) -> Option<Outcome> {
        let ranking = match self.winner? {
            0 => vec![self.x.iter().chain(&self.o).cloned().collect()],
            w => vec![self.id_of(w), self.id_of(3 - w)],
        };
        Some(Outcome::new(Kind::Duel, ranking))
    }

    fn skip(&mut self, _seat: &str) -> bool {
        self.turn = 3 - self.turn;
        true
    }

    fn snapshot(&self) -> TicTacToe {
        self.clone()
    }

    fn restore(snapshot: TicTacToe) -> Self {
        snapshot
    }
}

arcade::export!(TicTacToe);

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn plays_like_the_reference() {
        let g = RefCell::new(None::<TicTacToe>);
        let run = |c: &str| arcade::dispatch(&g, c);
        let seats = r#"[{"id":"pX","name":"Ada","team":"A","bot":false},{"id":"bot_O","name":"Bot","team":"B","bot":true}]"#;
        assert_eq!(run(&format!(r#"{{"fn":"init","seats":{seats},"opts":{{}},"seed":7,"match":0}}"#)), r#"{"v":null}"#);
        assert_eq!(run(r#"{"fn":"view","seat":null}"#), r#"{"v":{"board":[0,0,0,0,0,0,0,0,0],"turn":1,"winner":null,"x":"pX","o":"bot_O","you":0}}"#);
        assert_eq!(run(r#"{"fn":"apply","action":{"i":4},"by":"bot_O"}"#), r#"{"v":"not your turn"}"#);
        assert_eq!(run(r#"{"fn":"apply","action":{"i":4.5},"by":"pX"}"#), r#"{"v":"that square is taken"}"#);
        assert_eq!(run(r#"{"fn":"apply","action":null,"by":"pX"}"#), r#"{"v":"that square is taken"}"#);
        assert_eq!(run(r#"{"fn":"apply","action":{"i":4},"by":"pX"}"#), r#"{"v":null}"#);
        assert_eq!(run(r#"{"fn":"apply","action":{"i":9},"by":"bot_O"}"#), r#"{"v":"that square is taken"}"#);
        assert_eq!(run(r#"{"fn":"turn"}"#), r#"{"v":["bot_O"]}"#);
        assert_eq!(run(r#"{"fn":"bot","seat":"bot_O"}"#), r#"{"v":{"i":0}}"#);
        assert_eq!(run(r#"{"fn":"view","seat":"bot_O"}"#), r#"{"v":{"board":[0,0,0,0,1,0,0,0,0],"turn":2,"winner":null,"x":"pX","o":"bot_O","you":2}}"#);
        assert_eq!(run(r#"{"fn":"result"}"#), r#"{"v":null}"#);
        assert_eq!(run(r#"{"fn":"skip","seat":"bot_O"}"#), r#"{"v":true}"#);
    }

    #[test]
    fn a_draw_ranks_both_together() {
        let mut g = TicTacToe::init(vec![], Value::Null, 0, 0);
        (g.x, g.o) = (Some("a".into()), Some("b".into()));
        g.board = [1, 2, 1, 1, 2, 2, 2, 1, 1];
        g.winner = winner_of(&g.board);
        assert_eq!(serde_json::to_string(&g.result()).unwrap(), r#"{"kind":"duel","ranking":[["a","b"]]}"#);
        assert!(g.turn().is_empty());
        assert_eq!(g.apply(Move::Square { i: 0 }, "a"), Err("the game is over".into()));
    }
}
