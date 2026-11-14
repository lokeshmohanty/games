//! `arcade` — write an SDK v2 managed game in Rust (docs/sdk-v2.md,
//! "Managed state (Layer 2)").
//!
//! Implement [`Game`] for your state, then `arcade::export!(MyGame);`. The
//! macro makes the one function the platform calls, `dispatch`: one
//! `rulesCall` in as JSON, its `rulesOut` back (sdk/v2/protocol.json). The
//! page's glue hands that function to `arcade.managedJson`, and the platform
//! does the rest: host authority, views for each phone, bots, the turn-wait
//! banner, results, rejoin and handover. You never touch JSON or the protocol.
//!
//! ```ignore
//! use arcade::{Game, Outcome, Seat};
//!
//! struct Counter { n: u32, seats: Vec<String> }
//!
//! impl Game for Counter {
//!     type Action = u32;          // what `arcade.act(…)` sends
//!     type View = u32;            // what each phone draws
//!     type Snapshot = (u32, Vec<String>);
//!     fn init(seats: Vec<Seat>, _opts: serde_json::Value, _seed: i64, _match_no: i64) -> Self {
//!         Counter { n: 0, seats: seats.into_iter().map(|s| s.id).collect() }
//!     }
//!     fn apply(&mut self, by_how_much: u32, _by: &str) -> Result<(), String> {
//!         if by_how_much > 3 { return Err("at most 3".into()) }
//!         self.n += by_how_much;
//!         Ok(())
//!     }
//!     fn view(&self, _seat: Option<&str>) -> u32 { self.n }
//!     fn turn(&self) -> Vec<String> { self.seats.clone() }
//!     fn bot(&self, _seat: &str) -> Option<u32> { Some(1) }
//!     fn result(&self) -> Option<Outcome> { None }
//!     fn snapshot(&self) -> Self::Snapshot { (self.n, self.seats.clone()) }
//!     fn restore((n, seats): Self::Snapshot) -> Self { Counter { n, seats } }
//! }
//!
//! arcade::export!(Counter);
//! ```
//!
//! Build with `sdk/v2/adapters/rust/build.sh` (see README.md).

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use std::cell::RefCell;
use std::collections::BTreeMap;

/// Re-exported for [`export!`], so a game need not depend on wasm-bindgen.
#[doc(hidden)]
pub use wasm_bindgen;

/// A seated player, as `init` hands them over (protocol.json
/// `rulesCall.seats`), in party order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Seat {
    /// The member's id; a bot's starts with `bot_`.
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// The team the player picked in the lobby (`"A"`, `"B"`, …), if any.
    #[serde(default)]
    pub team: Option<String>,
    #[serde(default)]
    pub bot: bool,
}

/// The kind of match, for [`Outcome`] (docs/sdk.md "Reporting a result").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Duel,
    Ffa,
    Teams,
    Coop,
    Local,
}

/// How a match ended (docs/sdk.md "Reporting a result"). `ranking[0]` won; a
/// slot of several is a tie or a team, so a draw is everyone in one slot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Outcome {
    pub kind: Kind,
    pub ranking: Vec<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scores: Option<BTreeMap<String, f64>>,
}

impl Outcome {
    /// An outcome without scores.
    pub fn new(kind: Kind, ranking: Vec<Vec<String>>) -> Self {
        Outcome { kind, ranking, scores: None }
    }
}

/// The refusal `apply` gives, without calling your rule, when an action does
/// not deserialise into [`Game::Action`]. To refuse such actions yourself (or
/// in a particular order), make `Action` an untagged enum with a catch-all
/// variant holding a `serde_json::Value`.
pub const NOT_A_MOVE: &str = "that is not a move in this game";

/// A managed game's rules (docs/sdk-v2.md "Managed state"). The platform
/// calls them on the host only; every phone draws what [`Game::view`] gives.
///
/// The three types are anything serde can carry. Their JSON is what the page
/// sees: a struct's fields come out in declaration order, while a
/// `serde_json::Value` object (and `json!`) comes out with its keys sorted.
pub trait Game: Sized {
    /// A move: what the page sends with `arcade.act(…)`, and what
    /// [`Game::bot`] returns.
    type Action: Serialize + DeserializeOwned;
    /// What one seat may see; the page gets it in `arcade.on("view", …)`.
    type View: Serialize;
    /// Everything the heir needs to carry on when the host leaves.
    type Snapshot: Serialize + DeserializeOwned;

    /// A new match. `opts` is the manifest's `opts` (an object), `seed` a
    /// random number, `match_no` 0 and then 1, 2, … on each PLAY AGAIN.
    fn init(seats: Vec<Seat>, opts: Value, seed: i64, match_no: i64) -> Self;
    /// Make `by`'s move, or refuse it: `Err(reason)` is shown to that player.
    fn apply(&mut self, action: Self::Action, by: &str) -> Result<(), String>;
    /// What `seat` may see; `None` is a spectator.
    fn view(&self, seat: Option<&str>) -> Self::View;
    /// Whose move it is: drives the bots and the turn-wait banner.
    fn turn(&self) -> Vec<String>;
    /// The move a bot on `seat` makes (`None`: it has none).
    fn bot(&self, seat: &str) -> Option<Self::Action>;
    /// How the match ended, once it has.
    fn result(&self) -> Option<Outcome>;
    /// For the heir: see [`Game::restore`].
    fn snapshot(&self) -> Self::Snapshot;
    /// The crown moved to this phone: carry on from the old host's snapshot.
    fn restore(snapshot: Self::Snapshot) -> Self;
    /// With manifest `"tick"`: one fixed step, with each seat's latest
    /// `arcade.input(…)` (a bot's comes from [`Game::bot`]).
    fn tick(&mut self, inputs: BTreeMap<String, Value>, dt: f64) {
        let _ = (inputs, dt);
    }
    /// The host chose SKIP TURN for `seat`: apply the game's rule for a missed
    /// turn and return true, or false if the game cannot skip.
    fn skip(&mut self, seat: &str) -> bool {
        let _ = seat;
        false
    }
}

/// One `rulesCall`. Every argument has a default, so a call that leaves one
/// out still reaches the rule.
#[derive(Deserialize)]
struct Call {
    #[serde(rename = "fn")]
    rule: String,
    #[serde(default)]
    seats: Vec<Seat>,
    #[serde(default)]
    opts: Value,
    #[serde(default)]
    seed: i64,
    #[serde(default, rename = "match")]
    match_no: i64,
    #[serde(default)]
    action: Value,
    #[serde(default)]
    by: String,
    #[serde(default)]
    inputs: BTreeMap<String, Value>,
    #[serde(default)]
    dt: f64,
    #[serde(default)]
    seat: Option<String>,
    #[serde(default)]
    snapshot: Value,
}

#[derive(Serialize)]
struct Returned<T> {
    v: T,
}

#[derive(Serialize)]
struct Failed<'a> {
    err: &'a str,
}

fn ok<T: Serialize>(v: T) -> String {
    serde_json::to_string(&Returned { v }).unwrap_or_else(|e| err(&format!("arcade: could not serialise the answer: {e}")))
}

fn err(msg: &str) -> String {
    serde_json::to_string(&Failed { err: msg }).unwrap_or_else(|_| r#"{"err":"arcade: error"}"#.into())
}

/// The body of the `dispatch` that [`export!`] makes: one `rulesCall` (JSON)
/// in, its `rulesOut` (JSON) out. Public so native tests can drive a game
/// exactly as the platform will.
pub fn dispatch<G: Game>(slot: &RefCell<Option<G>>, call: &str) -> String {
    // A panic aborts the WebAssembly call midway and leaves the game borrowed:
    // from then on say so, rather than trap again.
    let Ok(mut slot) = slot.try_borrow_mut() else {
        return err("arcade: the game panicked on an earlier call");
    };
    let call: Call = match serde_json::from_str(call) {
        Ok(c) => c,
        Err(e) => return err(&format!("arcade: not a rules call: {e}")),
    };
    match call.rule.as_str() {
        "init" => {
            let opts = if call.opts.is_null() { Value::Object(Default::default()) } else { call.opts };
            *slot = Some(G::init(call.seats, opts, call.seed, call.match_no));
            ok(())
        }
        "restore" => match serde_json::from_value(call.snapshot) {
            Ok(s) => {
                *slot = Some(G::restore(s));
                ok(())
            }
            Err(e) => err(&format!("arcade: not a snapshot of this game: {e}")),
        },
        rule => {
            let Some(game) = slot.as_mut() else {
                return err("arcade: no game yet (init comes first)");
            };
            let seat = call.seat.as_deref();
            match rule {
                "apply" => match serde_json::from_value::<G::Action>(call.action) {
                    Ok(action) => ok(game.apply(action, &call.by).err()),
                    Err(_) => ok(NOT_A_MOVE),
                },
                "view" => ok(game.view(seat)),
                "turn" => ok(game.turn()),
                "bot" => ok(game.bot(seat.unwrap_or_default())),
                "result" => ok(game.result()),
                "snapshot" => ok(game.snapshot()),
                "tick" => {
                    game.tick(call.inputs, call.dt);
                    ok(())
                }
                "skip" => ok(game.skip(seat.unwrap_or_default())),
                other => err(&format!("no rule \"{other}\"")),
            }
        }
    }
}

/// `arcade::export!(MyGame);` — make `MyGame` the module's game: a
/// wasm-bindgen `dispatch(call: &str) -> String` holding one `MyGame`. The
/// page's glue: `wasm_bindgen.initSync({ module: arcade.wasm });
/// arcade.managedJson(wasm_bindgen.dispatch);`.
#[macro_export]
macro_rules! export {
    ($game:ty) => {
        ::std::thread_local! {
            static __ARCADE_GAME: ::core::cell::RefCell<::core::option::Option<$game>> =
                const { ::core::cell::RefCell::new(::core::option::Option::None) };
        }

        /// The game's rules behind one function of strings: a `rulesCall` in,
        /// its `rulesOut` out (sdk/v2/protocol.json).
        #[$crate::wasm_bindgen::prelude::wasm_bindgen(wasm_bindgen = $crate::wasm_bindgen)]
        pub fn dispatch(call: &str) -> ::std::string::String {
            __ARCADE_GAME.with(|game| $crate::dispatch::<$game>(game, call))
        }
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Serialize, Deserialize)]
    struct Counter {
        n: u32,
        seats: Vec<String>,
    }

    #[derive(Serialize)]
    struct CounterView<'a> {
        n: u32,
        mine: bool,
        by: &'a str,
    }

    impl Game for Counter {
        type Action = u32;
        type View = CounterView<'static>;
        type Snapshot = Counter;
        fn init(seats: Vec<Seat>, opts: Value, seed: i64, match_no: i64) -> Self {
            let n = opts["start"].as_u64().unwrap_or(0) as u32 + seed as u32 + match_no as u32;
            Counter { n, seats: seats.into_iter().map(|s| s.id).collect() }
        }
        fn apply(&mut self, k: u32, by: &str) -> Result<(), String> {
            if !self.seats.iter().any(|s| s == by) {
                return Err(format!("{by} is not seated"));
            }
            self.n += k;
            Ok(())
        }
        fn view(&self, seat: Option<&str>) -> Self::View {
            CounterView { n: self.n, mine: seat.is_some(), by: "z" }
        }
        fn turn(&self) -> Vec<String> {
            self.seats.clone()
        }
        fn bot(&self, _seat: &str) -> Option<u32> {
            (self.n < 10).then_some(1)
        }
        fn result(&self) -> Option<Outcome> {
            (self.n >= 10).then(|| Outcome::new(Kind::Coop, vec![self.seats.clone()]))
        }
        fn snapshot(&self) -> Counter {
            Counter { n: self.n, seats: self.seats.clone() }
        }
        fn restore(s: Counter) -> Self {
            s
        }
    }

    fn run(slot: &RefCell<Option<Counter>>, call: &str) -> String {
        dispatch(slot, call)
    }

    #[test]
    fn every_rule_answers_in_rules_out_form() {
        let g = RefCell::new(None);
        assert_eq!(run(&g, r#"{"fn":"view","seat":null}"#), r#"{"err":"arcade: no game yet (init comes first)"}"#);
        let init = r#"{"fn":"init","seats":[{"id":"a","name":"A","team":null,"bot":false}],"opts":{"start":2},"seed":3,"match":1}"#;
        assert_eq!(run(&g, init), r#"{"v":null}"#);
        assert_eq!(run(&g, r#"{"fn":"view","seat":"a"}"#), r#"{"v":{"n":6,"mine":true,"by":"z"}}"#);
        assert_eq!(run(&g, r#"{"fn":"view","seat":null}"#), r#"{"v":{"n":6,"mine":false,"by":"z"}}"#);
        assert_eq!(run(&g, r#"{"fn":"apply","action":2,"by":"a"}"#), r#"{"v":null}"#);
        assert_eq!(run(&g, r#"{"fn":"apply","action":2,"by":"q"}"#), r#"{"v":"q is not seated"}"#);
        assert_eq!(run(&g, r#"{"fn":"apply","action":"two","by":"a"}"#), format!(r#"{{"v":"{NOT_A_MOVE}"}}"#));
        assert_eq!(run(&g, r#"{"fn":"turn"}"#), r#"{"v":["a"]}"#);
        assert_eq!(run(&g, r#"{"fn":"bot","seat":"a"}"#), r#"{"v":1}"#);
        assert_eq!(run(&g, r#"{"fn":"result"}"#), r#"{"v":null}"#);
        assert_eq!(run(&g, r#"{"fn":"skip","seat":"a"}"#), r#"{"v":false}"#);
        assert_eq!(run(&g, r#"{"fn":"tick","inputs":{},"dt":0.1}"#), r#"{"v":null}"#);
        assert_eq!(run(&g, r#"{"fn":"wobble"}"#), r#"{"err":"no rule \"wobble\""}"#);
        let snap = run(&g, r#"{"fn":"snapshot"}"#);
        assert_eq!(snap, r#"{"v":{"n":8,"seats":["a"]}}"#);
        run(&g, r#"{"fn":"apply","action":2,"by":"a"}"#);
        assert_eq!(run(&g, r#"{"fn":"result"}"#), r#"{"v":{"kind":"coop","ranking":[["a"]]}}"#);
        assert_eq!(run(&g, r#"{"fn":"bot","seat":"a"}"#), r#"{"v":null}"#);
        let restore = format!(r#"{{"fn":"restore","snapshot":{}}}"#, &snap[5..snap.len() - 1]);
        assert_eq!(run(&g, &restore), r#"{"v":null}"#);
        assert_eq!(run(&g, r#"{"fn":"view","seat":"a"}"#), r#"{"v":{"n":8,"mine":true,"by":"z"}}"#);
        assert!(run(&g, r#"{"fn":"restore","snapshot":7}"#).starts_with(r#"{"err":"arcade: not a snapshot"#));
        assert!(run(&g, "not json").starts_with(r#"{"err":"arcade: not a rules call"#));
    }

    #[test]
    fn a_held_game_is_reported_not_trapped() {
        let g: RefCell<Option<Counter>> = RefCell::new(None);
        let _held = g.borrow_mut();
        assert_eq!(dispatch(&g, r#"{"fn":"turn"}"#), r#"{"err":"arcade: the game panicked on an earlier call"}"#);
    }
}
