// lib/games.js — the registry every game plugs into.
//
// A game is one file in `games/`, which calls `NeonArcade.registerGame(...)`
// exactly once at load. Nothing else in the project needs to change: the party
// shell lists whatever has registered, and the per-game page mounts it. Adding
// a game is therefore a new file plus a script tag, never an edit to the shell.
//
//   NeonArcade.registerGame({
//     id: "tic-tac-toe",              // stable; used in URLs and party state
//     name: "TIC TAC TOE",            // shown in the lobby and the switcher
//     blurb: "Three in a row.",       // one line, shown in the game switcher
//     shape: "teams",                 // "teams" | "coop" | "free"
//     seats: { min: 2, max: 2 },      // active players, spectators excluded
//     bots: true,                     // can a seat be filled by the host? (default)
//     local: false,                   // played on ONE device, passed around
//     mount(ctx) {
//       ctx.root.append(myMarkup());
//       return { unmount() { ...stop timers, drop listeners... } };
//     },
//   });
//
// ## What `mount(ctx)` receives
//
//   root        an empty element to build into; the shell clears it afterwards
//   room        the Room from net.js (makeAction, selfId, isHost, getMembers…)
//   isHost      convenience for room.isHost() at mount time
//   seatOf(id)  "A" | "B" | null — null means spectator
//   seats(team) member ids on that team, in join order
//   players()   every non-spectator id, in join order
//   nameOf(id)  display name for a member
//   isBot(id)   true when that seat is simulated by the host, not a person
//   onEnd(fn)   register a callback for "take me back to the party"
//   end()       call it to leave the game and return to the party screen
//
// ## Bots
//
// A bot is an ordinary member of the roster that the host simulates. Seats,
// teams and `players()` include it, so a game that ignores `isBot` entirely
// still runs — it will simply sit there waiting for a move that never comes.
// A game that wants bots gives them a brain **on the host only** (every game
// here is host-authoritative anyway) and either applies their move to the
// authoritative state directly, or sends it with `room.emitAs(botId, ...)`
// when the game's own peers are the ones that carry that information.
//
// ## What `mount` must return
//
// An object with `unmount()`. The shell calls it before mounting anything
// else, and a game that leaves a requestAnimationFrame loop, a timer or a
// window listener behind will fight the next game for input. Games are
// switched without a page reload, so this is the one hard rule.
//
// ## Local games
//
// `local: true` says the game is played by people **in the same room, on one
// device**, passed from hand to hand. The roster is not a list of peers; it is
// a list of names typed into that one phone, and the game asks for them itself.
//
// This is not a lesser kind of multiplayer, it is the answer to the cost this
// whole project is organised around: a handshake is paid once per person, and
// for six people sitting at the same table that is five handshakes to play a
// game nobody needed a second screen for. A local game skips all of it.
//
// The registry's only job here is to stop enforcing seats — `checkRoster` has
// nothing useful to say about a game whose players are not in the party record
// — and to let the lobby offer a START button instead of an invite.
//
// `shape` tells the party screen how to read team assignments:
//   teams  Team A vs Team B; the party screen validates one side each
//   coop   everyone on one side, playing together
//   free   every player for themselves; teams are ignored
//
// Loaded as a traditional script so it works on file:// like everything else.

window.NeonArcade = window.NeonArcade || {};

(() => {
	const byId = new Map();
	const order = [];

	const REQUIRED = ["id", "name", "mount"];

	/** Register a game. Called once per file in `games/`, at load time. */
	NeonArcade.registerGame = (def) => {
		for (const key of REQUIRED) {
			if (!def?.[key]) throw new Error(`registerGame: missing "${key}"`);
		}
		if (byId.has(def.id)) throw new Error(`registerGame: duplicate id "${def.id}"`);
		const game = {
			blurb: "",
			shape: "free",
			// Bots are the default because a game nobody can play alone is the
			// exception here, not the rule. A game opts out by saying so — see
			// draw-guess, where there is nothing for a bot to do that is not a
			// parlour trick.
			bots: true,
			// A game played on one device, by people in the same room.
			local: false,
			seats: { min: 2, max: 8 },
			...def,
		};
		byId.set(game.id, game);
		order.push(game);
		return game;
	};

	/** Every registered game, in registration order. */
	NeonArcade.listGames = () => [...order];

	NeonArcade.getGame = (id) => byId.get(id) ?? null;

	/**
	 * Is this roster playable? Returns null when it is, or a sentence saying
	 * what is wrong — which the party screen shows next to the START button
	 * rather than letting the host start something that cannot work.
	 */
	NeonArcade.checkRoster = (game, members) => {
		if (!game) return "Pick a game first.";
		// A local game's players are people in the room, not rows in the party
		// record, so there is nothing here to check. One phone with one member
		// in the party is a perfectly good six-player game of Undercover.
		if (game.local) return game.validate?.(members) ?? null;
		const players = members.filter((m) => m.team && m.team !== "spectator");
		if (players.length < game.seats.min) {
			return `${game.name} needs at least ${game.seats.min} players — assign more to a team.`;
		}
		if (players.length > game.seats.max) {
			return `${game.name} takes at most ${game.seats.max} players — move some to spectators.`;
		}
		if (game.shape === "teams") {
			const a = players.filter((m) => m.team === "A").length;
			const b = players.filter((m) => m.team === "B").length;
			if (!a || !b) return `${game.name} is Team A against Team B — both sides need a player.`;
			if (game.seats.max === 2 && (a > 1 || b > 1)) {
				return `${game.name} is one against one — only one player per team.`;
			}
		}
		if (game.validate) return game.validate(members) ?? null;
		return null;
	};

	/**
	 * Build the `ctx` a game's `mount` receives. Both entry points use this:
	 * the party shell passes the assigned teams, and a standalone game page
	 * passes the legacy rule (host on A, the first other player on B), so one
	 * game file serves both without knowing which it is running under.
	 */
	NeonArcade.gameContext = ({ root, room, teamOf, onEnd }) => {
		const seatOf = (id) => {
			const t = teamOf ? teamOf(id) : null;
			return t === "spectator" ? null : (t ?? null);
		};
		const ordered = () => room.getMembers();
		return {
			root,
			room,
			isHost: room.isHost(),
			seatOf,
			seats: (team) =>
				ordered()
					.map((m) => m.id)
					.filter((id) => seatOf(id) === team),
			players: () =>
				ordered()
					.map((m) => m.id)
					.filter((id) => seatOf(id) !== null),
			nameOf: (id) => room.getMember(id)?.name ?? "Player",
			isBot: (id) => NeonArcade.isBotId(id),
			/** Bot seats on a side (or every bot playing, with no argument). */
			botSeats: (team) =>
				ordered()
					.map((m) => m.id)
					.filter((id) => NeonArcade.isBotId(id) && (team ? seatOf(id) === team : seatOf(id) !== null)),
			end: () => onEnd?.(),
			/** Whether `end()` does anything: the party shell, not a game page. */
			canEnd: !!onEnd,
			onEnd: (fn) => {
				// Kept for games that want to clean up on their own terms.
				root.addEventListener("neon:end", fn);
			},
		};
	};

	/**
	 * The banner for a turn game whose player to move has lost connection —
	 * or switched to another app (`away`), which stalls the turn just the same.
	 *
	 * Their seat is held RECONNECTING for the whole reconnect grace (minutes),
	 * and a turn game cannot move without them — so instead of a silent stall
	 * everyone sees who it is waiting for and for how long. After `waitMs` the
	 * host decides (Lokesh, 2026-11-12): WAIT (another `waitMs`, told to
	 * everyone), SKIP TURN (`skip(id)`, the game's own rule for passing a turn)
	 * or END GAME (party shell only, asked first). Guests are told the host is
	 * deciding. Nothing happens automatically: the host chooses.
	 *
	 * `turn()` returns the member id whose move it is, or null. Polled, so the
	 * game need not report roster changes. `NeonArcade.turnWaitMs` overrides
	 * the wait for tests. Returns `{ dispose }`.
	 */
	NeonArcade.turnWait = (ctx, { turn, skip, waitMs = NeonArcade.turnWaitMs ?? 30_000 }) => {
		const { room } = ctx;
		const sync = room.makeAction("tw$wait");
		const bar = document.createElement("div");
		bar.className = "turn-wait";
		bar.setAttribute("role", "status");
		bar.hidden = true;
		const text = document.createElement("p");
		const actions = document.createElement("div");
		actions.className = "turn-wait-actions";
		bar.append(text, actions);
		document.body.append(bar);

		let waitingOn = null;
		let deadline = 0;
		let mode = null; // "count" | "decide"

		const button = (label, onClick) => {
			const b = document.createElement("button");
			b.className = "neon-btn";
			b.textContent = label;
			b.onclick = onClick;
			return b;
		};
		const waitMore = () => {
			deadline = Date.now() + waitMs;
			sync.send({ id: waitingOn, ms: waitMs });
			draw();
		};

		function draw() {
			const name = ctx.nameOf(waitingOn);
			const left = deadline - Date.now();
			if (left > 0) {
				const s = Math.ceil(left / 1000);
				const why = room.getMember(waitingOn)?.reconnecting ? "reconnecting" : "switched away";
				text.textContent = `Waiting for ${name} — ${why} (${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")})`;
				if (mode !== "count") actions.replaceChildren();
				mode = "count";
				return;
			}
			if (mode === "decide") return;
			mode = "decide";
			if (!room.isHost()) {
				text.textContent = `${name} hasn't come back — ${ctx.nameOf(room.hostId())} decides.`;
				actions.replaceChildren();
				return;
			}
			text.textContent = `${name} hasn't come back.`;
			const id = waitingOn;
			actions.replaceChildren(
				button("WAIT", waitMore),
				button("SKIP TURN", () => {
					if (turn() === id) skip(id);
				}),
				...(ctx.canEnd
					? [
							button("END GAME", async () => {
								const ok = await NeonArcade.ask("End the game for everyone and go back to the party?", {
									ok: "END GAME",
									cancel: "KEEP WAITING",
								});
								if (ok) ctx.end();
							}),
						]
					: []),
			);
		}

		function tick() {
			const id = turn();
			const member = id && id !== room.selfId && !ctx.isBot(id) ? room.getMember(id) : null;
			if (!member?.reconnecting && !member?.away) {
				waitingOn = null;
				mode = null;
				bar.hidden = true;
				return;
			}
			if (waitingOn !== id) {
				waitingOn = id;
				deadline = Date.now() + waitMs;
				mode = null;
			}
			bar.hidden = false;
			draw();
		}

		sync.onMessage = (msg, { peerId }) => {
			if (peerId !== room.hostId() || msg?.id !== waitingOn) return;
			deadline = Date.now() + (msg.ms ?? waitMs);
			draw();
		};
		const timer = setInterval(tick, 250);
		tick();
		return {
			dispose() {
				clearInterval(timer);
				sync.onMessage = null;
				bar.remove();
			},
		};
	};

	/**
	 * Keep the screen on while a game runs (Lokesh, 2026-11-13). A phone that
	 * dims after 30 s untouched suspends the page, and a suspended page is a
	 * dropped player. The browser drops the lock whenever the page is hidden,
	 * so it is taken again on the way back. No Wake Lock API: nothing happens.
	 */
	let wakeWanted = false;
	let wakeLock = null;
	const takeWake = async () => {
		if (!wakeWanted || wakeLock || document.hidden || !navigator.wakeLock) return;
		try {
			const lock = await navigator.wakeLock.request("screen");
			lock.addEventListener("release", () => {
				if (wakeLock === lock) wakeLock = null;
			});
			wakeLock = lock;
			if (!wakeWanted) NeonArcade.keepAwake(false);
		} catch {
			// Refused (battery saver, no permission): the phone's own timeout stands.
		}
	};
	// Optional: the rules tests load this file in Node, which has no document.
	globalThis.document?.addEventListener("visibilitychange", takeWake);
	NeonArcade.keepAwake = (on) => {
		wakeWanted = !!on;
		if (on) return void takeWake();
		const lock = wakeLock;
		wakeLock = null;
		lock?.release().catch(() => {});
	};
	/** Whether a screen lock is held now, for the tests. */
	NeonArcade.awake = () => !!wakeLock;

	/**
	 * Pause a game the host simulates while the host is out of the app.
	 *
	 * A hidden page gets no animation frames, so Tug of War and Neon Survival
	 * froze for everyone with no word as to why, and taps sent meanwhile all
	 * landed at once on the way back. Instead (Lokesh, 2026-11-13) everyone
	 * sees "Paused — X left the app", and play resumes after a 3-2-1 once the
	 * host is back. Guests read the host's `away` from the roster; the host's
	 * own countdown is told to them so they count together.
	 *
	 * `onChange(paused)` fires on every change; `paused()` is for the game's
	 * loop and input. Returns `{ paused, dispose }`.
	 */
	NeonArcade.hostPause = (ctx, { onChange } = {}) => {
		const { room } = ctx;
		const sync = room.makeAction("hp$resume");
		const card = document.createElement("div");
		card.className = "host-pause";
		card.setAttribute("role", "status");
		card.hidden = true;
		const text = document.createElement("p");
		card.append(text);
		document.body.append(card);

		let paused = false;
		let count = 0; // seconds of the resume countdown left
		let countTimer = null;
		let wasAway = false;

		const hostAway = () => !room.isHost() && !!room.getMember(room.hostId())?.away;
		const countDown = () => {
			count = 3;
			clearInterval(countTimer);
			countTimer = setInterval(() => {
				count -= 1;
				if (count <= 0) clearInterval(countTimer);
				draw();
			}, 1000);
			draw();
		};
		function draw() {
			const away = hostAway();
			const back = wasAway && !away;
			wasAway = away;
			if (back) return void countDown(); // whether or not its message came first; draws again
			const hostHidden = room.isHost() && document.hidden;
			if (away) text.textContent = `Paused — ${ctx.nameOf(room.hostId())} left the app`;
			else if (count > 0) text.textContent = `Resuming in ${count}`;
			card.hidden = !(away || count > 0);
			const now = away || count > 0 || hostHidden;
			if (now !== paused) {
				paused = now;
				onChange?.(paused);
			}
		}

		const onVisible = () => {
			if (!room.isHost()) return;
			if (document.hidden) {
				clearInterval(countTimer);
				count = 0;
			} else {
				sync.send({ n: 3 });
				countDown();
			}
			draw();
		};
		document.addEventListener("visibilitychange", onVisible);
		sync.onMessage = (_msg, { peerId }) => {
			if (peerId === room.hostId() && !room.isHost()) countDown();
		};
		const poll = setInterval(draw, 250);
		draw();
		return {
			paused: () => paused,
			dispose() {
				clearInterval(poll);
				clearInterval(countTimer);
				document.removeEventListener("visibilitychange", onVisible);
				sync.onMessage = null;
				card.remove();
			},
		};
	};

	/**
	 * Mount one game on its own page, through the plain two-player lobby.
	 *
	 * This is the deep-link entry point: `connect4.html` is a shortcut straight
	 * into one game, while `party.html` is the shell that keeps a group together
	 * across several. Both mount the same module, so a game is implemented once.
	 *
	 * There are no team assignments here, so seats fall back to a rule rather
	 * than a choice. A one-against-one game keeps the rule this project always
	 * used: the host is Team A, the first other player is Team B, anyone after
	 * that spectates. A team game with room for more deals players out
	 * alternately instead, which is the only way a deep link can seat three bots
	 * without two of them watching. Games that are not team games put everybody
	 * on the same side.
	 */
	NeonArcade.mountGamePage = (lobbyEl, stage, gameId) => {
		const game = NeonArcade.getGame(gameId);
		if (!game) throw new Error(`mountGamePage: no game registered as "${gameId}"`);

		let handle = null;
		let room = null;

		const teamOf = (id) => {
			if (game.shape !== "teams") return "A";
			const host = room.hostId();
			if (id === host) return "A";
			const others = room.getMembers().map((m) => m.id).filter((x) => x !== host);
			const seat = others.indexOf(id);
			if (seat < 0) return "spectator";
			if (game.seats.max === 2) return seat === 0 ? "B" : "spectator";
			if (seat + 1 >= game.seats.max) return "spectator";
			// Alternate, so the host's side is not simply outnumbered by everyone
			// who happened to arrive after them.
			return seat % 2 === 0 ? "B" : "A";
		};

		NeonArcade.mountLobby(lobbyEl, {
			gameName: game.name,
			game,
			onReady(r) {
				room = r;
			},
			onStart() {
				stage.hidden = false;
				handle = game.mount(
					NeonArcade.gameContext({ root: stage, room, teamOf }),
				);
				NeonArcade.keepAwake(true);
			},
			// The session ended under the game (lobby.js showDisconnected).
			onEnd() {
				try {
					handle?.unmount?.();
				} catch (err) {
					console.error("unmount failed", err);
				}
				handle = null;
				stage.replaceChildren();
				stage.hidden = true;
				NeonArcade.keepAwake(false);
			},
			onPeerJoin: (id) => handle?.onPeerJoin?.(id),
			onPeerLeave: (id, info) => handle?.onPeerLeave?.(id, info),
		});

		// Returned, and published by each game page as `window.__game`, for the
		// same reason party.html publishes `window.__party`: the tests drive the
		// real page rather than a rehearsal of it, and the room and the mounted
		// game are otherwise closure variables nothing outside can see. Live
		// getters, so a handle obtained before START is still the right one after.
		return {
			game,
			get room() {
				return room;
			},
			get handle() {
				return handle;
			},
		};
	};
})();
