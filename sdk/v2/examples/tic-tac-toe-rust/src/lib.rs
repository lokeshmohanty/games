//! Tic Tac Toe — the SDK v2 example in Rust, compiled to WebAssembly
//! (docs/sdk-v2.md). The same game as ../tic-tac-toe, move for move.
//!
//! The whole game is one function, `dispatch`: JSON in, JSON out.
//!
//! In: any message the party shell sent (sdk/v2/protocol.json: `init`,
//! `roster`, `msg`, `join`, `takeOver`, `unmount`, …), or an event glue.js
//! made up from the page: `{"t":"click","i":4}`, `{"t":"again"}`,
//! `{"t":"wake"}` (the timer asked for below), `{"t":"debug"}` (tests).
//!
//! Out: `{ "out": [messages to post], "view": {what to draw}, "wake": ms }`,
//! plus `"answer"` for a request (`takeOver`). `wake` is there only when the
//! timer changes: a number (re)arms it, null cancels it.
//!
//! Rules, host authority, the bot, seating and results all live here;
//! glue.js only carries messages and draws `view`.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::cell::RefCell;
use wasm_bindgen::prelude::*;

const X: u8 = 1;
const O: u8 = 2;
const LINES: [[usize; 3]; 8] = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6],
];
const BOT_DELAY_MS: u32 = 500;

/// The host's word, sent on the "state" channel. The same shape as the
/// JavaScript example's, so tests read both alike.
#[derive(Clone, Serialize, Deserialize)]
struct State {
    board: [u8; 9],
    turn: u8,
    winner: Option<u8>, // 0 = draw, None = still going
    x: Option<String>,
    o: Option<String>,
}

impl State {
    fn new(x: Option<String>, o: Option<String>) -> Self {
        State { board: [0; 9], turn: X, winner: None, x, o }
    }
    fn mark_of(&self, id: &str) -> u8 {
        if self.x.as_deref() == Some(id) { X } else if self.o.as_deref() == Some(id) { O } else { 0 }
    }
    fn id_of(&self, mark: u8) -> Option<&str> {
        if mark == X { self.x.as_deref() } else { self.o.as_deref() }
    }
}

#[derive(Deserialize)]
struct Member {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    team: Option<String>,
}

#[derive(Deserialize)]
struct Party {
    #[serde(rename = "self")]
    me: String,
    host: String,
    members: Vec<Member>,
}

fn winner_of(board: &[u8; 9]) -> Option<u8> {
    for [a, b, c] in LINES {
        if board[a] != 0 && board[a] == board[b] && board[a] == board[c] {
            return Some(board[a]);
        }
    }
    if board.iter().all(|&m| m != 0) { Some(0) } else { None }
}

fn is_bot(id: Option<&str>) -> bool {
    id.is_some_and(|id| id.starts_with("bot_"))
}

/// One dispatch's answer, gathered as the game runs.
#[derive(Default)]
struct Reply {
    out: Vec<Value>,
    wake: Option<Option<u32>>, // None: leave the timer; Some(None): cancel
    answer: Option<bool>,
}

struct Game {
    party: Option<Party>,
    state: State,
    hud: String,
    bot: Option<String>, // the bot the armed timer will move for
}

impl Game {
    fn is_host(&self) -> bool {
        self.party.as_ref().is_some_and(|p| p.host == p.me)
    }
    fn me(&self) -> &str {
        self.party.as_ref().map_or("", |p| p.me.as_str())
    }
    fn name_of(&self, id: Option<&str>) -> String {
        let member = self.party.as_ref().and_then(|p| p.members.iter().find(|m| Some(m.id.as_str()) == id));
        member.map_or_else(|| "Player".into(), |m| m.name.clone())
    }
    fn seat(&self, team: &str) -> Option<String> {
        let p = self.party.as_ref()?;
        p.members.iter().find(|m| m.team.as_deref() == Some(team)).map(|m| m.id.clone())
    }

    fn handle(&mut self, ev: &Value, r: &mut Reply) {
        match ev["t"].as_str().unwrap_or("") {
            "init" => {
                self.party = Party::deserialize(&ev["party"]).ok();
                r.out.push(json!({ "t": "listen", "ch": "state" }));
                r.out.push(json!({ "t": "listen", "ch": "move" }));
                self.restart(r); // host only
            }
            "roster" => {
                if let Ok(p) = Party::deserialize(&ev["party"]) {
                    self.party = Some(p);
                }
                let moved = self.state.x != self.seat("A") || self.state.o != self.seat("B");
                if self.is_host() && self.state.winner.is_none() && moved {
                    self.restart(r);
                }
            }
            "msg" => {
                let from = ev["from"].as_str().unwrap_or("");
                match ev["ch"].as_str() {
                    // Only the host's word counts.
                    Some("state") if self.party.as_ref().is_some_and(|p| p.host == from) => {
                        if let Ok(next) = State::deserialize(&ev["d"]) {
                            let decided = self.state.winner.is_none() && next.winner.is_some();
                            self.state = next;
                            if decided {
                                self.report(r);
                            }
                        }
                    }
                    Some("move") if self.is_host() => {
                        if let Some(i) = ev["d"]["i"].as_u64().filter(|&i| i < 9) {
                            self.apply(from.to_owned(), i as usize, r);
                        }
                    }
                    _ => {}
                }
            }
            // Someone (re)joined: catch them up.
            "join" => self.publish(ev["who"].as_str(), r),
            // The crown moved to us mid-game; we have the whole state, so carry on.
            "takeOver" => {
                self.publish(None, r);
                self.bot_turn(r);
                r.answer = Some(true);
            }
            "unmount" => r.wake = Some(None),
            // From the page.
            "click" => {
                if let Some(i) = ev["i"].as_u64().filter(|&i| i < 9) {
                    self.play(i as usize, r);
                }
            }
            "again" => self.restart(r),
            "wake" => self.bot_move(r),
            _ => {}
        }
    }

    /// Host only: apply a move by `id` at square `i`, if it is legal.
    fn apply(&mut self, id: String, i: usize, r: &mut Reply) {
        let s = &mut self.state;
        let mark = s.mark_of(&id);
        if s.winner.is_some() || mark == 0 || mark != s.turn || s.board[i] != 0 {
            return;
        }
        s.board[i] = mark;
        s.turn = if mark == X { O } else { X };
        s.winner = winner_of(&s.board);
        if s.winner.is_some() {
            self.report(r);
        }
        self.publish(None, r);
        self.bot_turn(r);
    }

    fn play(&mut self, i: usize, r: &mut Reply) {
        if self.is_host() {
            self.apply(self.me().to_owned(), i, r);
        } else if let Some(p) = &self.party {
            r.out.push(json!({ "t": "send", "ch": "move", "d": { "i": i }, "to": p.host }));
        }
    }

    fn publish(&self, to: Option<&str>, r: &mut Reply) {
        if !self.is_host() {
            return;
        }
        let mut m = json!({ "t": "send", "ch": "state", "d": self.state });
        if let Some(to) = to {
            m["to"] = to.into();
        }
        r.out.push(m);
    }

    /// Everyone reports what they saw; the platform counts it once.
    fn report(&self, r: &mut Reply) {
        let s = &self.state;
        let ranking = match s.winner {
            Some(0) => json!([[s.x, s.o]]),
            Some(w) => json!([[s.id_of(w)], [s.id_of(if w == X { O } else { X })]]),
            None => return,
        };
        r.out.push(json!({ "t": "result", "r": { "kind": "duel", "ranking": ranking } }));
    }

    fn restart(&mut self, r: &mut Reply) {
        if !self.is_host() {
            return;
        }
        self.state = State::new(self.seat("A"), self.seat("B"));
        self.publish(None, r);
        self.bot_turn(r);
    }

    /// Host only: if a bot is to move, wake in a moment to move for it.
    fn bot_turn(&mut self, r: &mut Reply) {
        r.wake = Some(None);
        self.bot = None;
        let bot = self.state.id_of(self.state.turn);
        if self.is_host() && self.state.winner.is_none() && is_bot(bot) {
            self.bot = bot.map(str::to_owned);
            r.wake = Some(Some(BOT_DELAY_MS));
        }
    }

    /// Win if it can, block if it must, else the centre, else anything. The
    /// move arrives like anyone's: through the move channel, sent as the bot.
    fn bot_move(&mut self, r: &mut Reply) {
        let Some(bot) = self.bot.take() else { return };
        let board = self.state.board;
        let free: Vec<usize> = (0..9).filter(|&i| board[i] == 0).collect();
        let wins = |mark: u8| {
            free.iter().copied().find(|&i| {
                let mut b = board;
                b[i] = mark;
                winner_of(&b) == Some(mark)
            })
        };
        let mine = self.state.turn;
        let pick = wins(mine)
            .or_else(|| wins(if mine == X { O } else { X }))
            .or_else(|| free.contains(&4).then_some(4))
            .or_else(|| free.first().copied());
        if let Some(i) = pick {
            r.out.push(json!({ "t": "emitAs", "bot": bot, "ch": "move", "d": { "i": i }, "to": self.me() }));
        }
    }

    /// What to draw: the squares, the line above them, and the end card.
    fn view(&mut self) -> Value {
        let s = &self.state;
        let me = s.mark_of(self.me());
        let cells: Vec<&str> = s.board.iter().map(|&m| match m { X => "X", O => "O", _ => "" }).collect();
        let over = match s.winner {
            None => {
                self.hud = if me == 0 {
                    "SPECTATING".into()
                } else if s.turn == me {
                    "YOUR TURN".into()
                } else {
                    format!("{} TO MOVE", self.name_of(s.id_of(s.turn)))
                };
                Value::Null
            }
            Some(w) => {
                let title = if w == 0 {
                    "DRAW".into()
                } else if w == me {
                    "YOU WIN".into()
                } else {
                    format!("{} WINS", self.name_of(s.id_of(w)))
                };
                json!({ "title": title, "again": self.is_host() })
            }
        };
        json!({ "cells": cells, "hud": self.hud, "over": over })
    }
}

thread_local! {
    static GAME: RefCell<Game> = RefCell::new(Game {
        party: None,
        state: State::new(None, None),
        hud: String::new(),
        bot: None,
    });
}

/// The game's one entry point: a message or page event in, what to do out.
#[wasm_bindgen]
pub fn dispatch(input: &str) -> String {
    let Ok(ev) = serde_json::from_str::<Value>(input) else { return r#"{"out":[]}"#.into() };
    GAME.with(|g| {
        let mut g = g.borrow_mut();
        if ev["t"] == "debug" {
            return json!({ "out": [], "debug": g.state }).to_string();
        }
        let mut r = Reply::default();
        g.handle(&ev, &mut r);
        let mut res = Map::new();
        res.insert("out".into(), r.out.into());
        res.insert("view".into(), if g.party.is_some() { g.view() } else { Value::Null });
        if let Some(wake) = r.wake {
            res.insert("wake".into(), wake.into());
        }
        if let Some(ok) = r.answer {
            res.insert("answer".into(), ok.into());
        }
        Value::Object(res).to_string()
    })
}
