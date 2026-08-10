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
//   onEnd(fn)   register a callback for "take me back to the party"
//   end()       call it to leave the game and return to the party screen
//
// ## What `mount` must return
//
// An object with `unmount()`. The shell calls it before mounting anything
// else, and a game that leaves a requestAnimationFrame loop, a timer or a
// window listener behind will fight the next game for input. Games are
// switched without a page reload, so this is the one hard rule.
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
			end: () => onEnd?.(),
			onEnd: (fn) => {
				// Kept for games that want to clean up on their own terms.
				root.addEventListener("neon:end", fn);
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
	 * There are no team assignments here, so seats fall back to the rule this
	 * project always used: whoever hosts is Team A, the first other player is
	 * Team B, and anyone after that spectates. Games that are not one-against-one
	 * put everybody on the same side instead.
	 */
	NeonArcade.mountGamePage = (lobbyEl, stage, gameId) => {
		const game = NeonArcade.getGame(gameId);
		if (!game) throw new Error(`mountGamePage: no game registered as "${gameId}"`);

		let handle = null;
		let room = null;

		const teamOf = (id) => {
			if (game.shape !== "teams") return "A";
			const ids = room.getMembers().map((m) => m.id);
			const host = room.hostId();
			if (id === host) return "A";
			const challenger = ids.find((x) => x !== host);
			return id === challenger ? "B" : "spectator";
		};

		NeonArcade.mountLobby(lobbyEl, {
			gameName: game.name,
			onReady(r) {
				room = r;
			},
			onStart() {
				stage.hidden = false;
				handle = game.mount(
					NeonArcade.gameContext({ root: stage, room, teamOf, onEnd: () => {} }),
				);
			},
			onPeerJoin: (id) => handle?.onPeerJoin?.(id),
			onPeerLeave: (id) => handle?.onPeerLeave?.(id),
		});
	};
})();
