// lib/stats.js — what this device remembers about your games: results,
// favourites, and what you played last.
//
// Everything here is on the device (localStorage), needs no account and works
// offline. Signing in (lib/account.js) syncs favourites and reports results to
// the leaderboards; this file is the part that never needs a network.
//
// A result comes from a game's `ctx.reportResult(r)` (sdk/v1/client.js →
// lib/bridge.js → party.js), in one shape for every game:
//
//   { kind: "duel" | "ffa" | "teams" | "coop" | "local",
//     ranking: [[id, …], [id, …], …],   // places: ranking[0] won; a slot
//                                       // holding several is a tie / a team
//     match?: number,                   // which match of this run (a rematch
//                                       // counts up), so identical ends count
//     scores?: { id: number },          // optional, e.g. coop survival time
//     reason?: string }                 // optional, e.g. "left"
//
// A game reports on every peer (each one saw the end); `record` keeps one per
// run (party `run` id, net.js setGame), match and ranking, so a repeated report
// is not counted twice.
//
// Keys: neon.stats {[gameId]: Rec}, neon.favs [gameId], neon.recent [gameId]
// (newest first, at most 10). Pure functions are exported for the Node tests.

window.NeonArcade = window.NeonArcade || {};

(() => {
	const KEYS = { stats: "neon.stats", favs: "neon.favs", recent: "neon.recent", seen: "neon.seen" };
	const RECENT_MAX = 10;
	const SEEN_MAX = 50;

	const load = (key, fallback) => {
		try {
			const v = JSON.parse(globalThis.localStorage?.getItem(key) ?? "null");
			return v ?? fallback;
		} catch {
			return fallback;
		}
	};
	const save = (key, value) => {
		try {
			globalThis.localStorage?.setItem(key, JSON.stringify(value));
		} catch {
			// Private mode or full: the session still has it in memory.
		}
	};

	const empty = () => ({ played: 0, won: 0, lost: 0, drawn: 0, vsBots: 0, vsPeople: 0, streak: 0, best: 0, bestScore: null, last: 0 });

	/** Is this a well-formed result? (A game's report crosses the frame.) */
	function valid(r) {
		return (
			!!r &&
			["duel", "ffa", "teams", "coop", "local"].includes(r.kind) &&
			Array.isArray(r.ranking) &&
			r.ranking.length > 0 &&
			r.ranking.every((slot) => Array.isArray(slot) && slot.every((id) => typeof id === "string"))
		);
	}

	/**
	 * How the result went for `me`: "won" | "lost" | "drawn" | "played" (coop,
	 * local), or null when `me` was not in it (a spectator).
	 */
	function outcome(r, me) {
		if (r.kind === "local") return "played";
		const place = r.ranking.findIndex((slot) => slot.includes(me));
		if (place < 0) return null;
		if (r.kind === "coop") return "played";
		// One slot holding everyone: nobody beat anybody.
		if (r.ranking.length === 1) return r.ranking[0].length > 1 ? "drawn" : "won";
		return place === 0 ? "won" : "lost";
	}

	/** A new stats object with `r` applied for `me`. Pure. */
	function apply(stats, gameId, r, me, isBot, now = Date.now()) {
		const how = outcome(r, me);
		if (!how) return stats;
		const rec = { ...empty(), ...(stats[gameId] ?? {}) };
		const others = r.ranking.flat().filter((id) => id !== me);
		rec.played++;
		if (others.length && others.every(isBot)) rec.vsBots++;
		else if (others.some((id) => !isBot(id))) rec.vsPeople++;
		if (how === "won") {
			rec.won++;
			rec.streak++;
			rec.best = Math.max(rec.best, rec.streak);
		} else if (how === "lost") {
			rec.lost++;
			rec.streak = 0;
		} else if (how === "drawn") {
			rec.drawn++;
			rec.streak = 0;
		}
		const score = r.scores?.[me];
		if (typeof score === "number" && Number.isFinite(score)) rec.bestScore = Math.max(rec.bestScore ?? -Infinity, score);
		rec.last = now;
		return { ...stats, [gameId]: rec };
	}

	/** Recently played, newest first, without duplicates. Pure. */
	const touch = (recent, gameId) => [gameId, ...recent.filter((id) => id !== gameId)].slice(0, RECENT_MAX);

	/** Favourites with `gameId` toggled. Pure. */
	const toggle = (favs, gameId) => (favs.includes(gameId) ? favs.filter((id) => id !== gameId) : [...favs, gameId]);

	/** Merge two favourite lists (this device's and an account's). Pure. */
	const mergeFavs = (a, b) => [...new Set([...(a ?? []), ...(b ?? [])])];

	const listeners = new Set();
	const changed = (what) => {
		for (const fn of listeners) {
			try {
				fn(what);
			} catch (err) {
				console.error(err);
			}
		}
	};

	NeonArcade.stats = {
		valid,
		outcome,
		apply,
		touch,
		toggle,
		mergeFavs,

		read: () => load(KEYS.stats, {}),
		favs: () => load(KEYS.favs, []),
		recent: () => load(KEYS.recent, []),
		isFav: (gameId) => load(KEYS.favs, []).includes(gameId),

		/** Star or unstar a game. Returns whether it is a favourite now. */
		toggleFav(gameId) {
			const next = toggle(load(KEYS.favs, []), gameId);
			save(KEYS.favs, next);
			changed("favs");
			return next.includes(gameId);
		},
		setFavs(list) {
			save(KEYS.favs, [...new Set(list)]);
			changed("favs");
		},

		/** A game was started on this device. */
		played(gameId) {
			save(KEYS.recent, touch(load(KEYS.recent, []), gameId));
			changed("recent");
		},

		/**
		 * Count a result for this player. `key` identifies it (run id + ranking)
		 * so the same end reported twice counts once. Returns the outcome, or
		 * null when it was not counted (invalid, a spectator, seen before).
		 */
		record(gameId, r, { me, isBot = (id) => id.startsWith("bot_"), key } = {}) {
			if (!valid(r) || !me) return null;
			const seen = load(KEYS.seen, []);
			const id = key ?? `${gameId}|${JSON.stringify(r.ranking)}|${Math.floor(Date.now() / 10_000)}`;
			if (seen.includes(id)) return null;
			const how = outcome(r, me);
			if (!how) return null;
			save(KEYS.seen, [id, ...seen].slice(0, SEEN_MAX));
			save(KEYS.stats, apply(load(KEYS.stats, {}), gameId, r, me, isBot));
			changed("stats");
			return how;
		},

		/** Call `fn(what)` after any change; returns an unsubscribe. */
		onChange(fn) {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
	};
})();
