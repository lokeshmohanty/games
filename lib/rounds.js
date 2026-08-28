// lib/rounds.js — the round-and-phase clock every timed game was writing by
// hand.
//
// Draw & Guess already had one of these: `phase` is a string, a chain of
// `setTimeout`s walks it from choosing to drawing to reveal, each callback
// re-checks that the phase it woke up in is still the phase it was scheduled
// for, and the whole thing is rebroadcast to peers as part of the game state.
// That shape is correct, and it is about eighty lines of correct that no second
// game should have to get right again — the re-check especially, which is the
// difference between a torn-down round and a timer firing into it.
//
// So it lives here, with the two things the hand-rolled version did not have:
//
//   **Simultaneous turns.** A phase marked `collect: true` ends as soon as every
//   seated player has submitted, or at its deadline, whichever comes first. That
//   single rule is what makes lock-in games possible over this transport — no
//   player is racing another, so a slow link costs its owner nothing, and the
//   host never has to arbitrate who acted first.
//
//   **Bots that take their turn.** A collecting phase would otherwise sit and
//   wait out its deadline for a seat nobody is behind. `botSubmit` is called on
//   the host for each bot seat when the phase opens.
//
// Host-authoritative like everything else: the host owns the clock and says
// what phase it is; peers mirror. Time is sent as a **duration**, never as a
// timestamp, because two phones' clocks disagree by more than these phases last.
//
// Loaded as a traditional script so it works on file:// like everything else.

window.NeonArcade = window.NeonArcade || {};

(() => {
	const TICK_MS = 200;

	/**
	 * @param {object} ctx   the game context from `NeonArcade.gameContext`
	 * @param {object} spec
	 * @param {number} [spec.rounds]      how many times to walk the phase list
	 * @param {Array}  spec.phases        [{ name, ms, collect }]
	 * @param {string} [spec.name]        distinguishes two schedulers in one game
	 * @param {Function} [spec.onPhase]   (info) => void — every peer, on entry
	 * @param {Function} [spec.onTick]    (info) => void — every peer, ~5/s
	 * @param {Function} [spec.onCollect] (info) => void — **host only**, at the
	 *                                    end of a collecting phase, with what
	 *                                    everybody submitted
	 * @param {Function} [spec.botSubmit] (botId, info) => value — **host only**,
	 *                                    when a collecting phase opens
	 * @param {Function} [spec.onFinish]  (info) => void — after the last round
	 */
	NeonArcade.makeRounds = (ctx, spec) => {
		const { room } = ctx;
		const phases = spec.phases ?? [];
		const totalRounds = spec.rounds ?? 1;
		if (!phases.length) throw new Error("makeRounds: at least one phase");

		const state = room.makeAction("r$" + (spec.name ?? "round"));
		const inbox = room.makeAction("r$" + (spec.name ?? "round") + "!");

		let round = 0;
		let index = 0;
		let endsAt = 0;
		let running = false;
		// Until the host says otherwise there is no phase — not "the first one".
		// A mirror that assumes round 0 phase 0 is indistinguishable from a
		// mirror that has been told round 0 phase 0, and the difference decides
		// whether the guest ever renders the opening phase. See `primed`.
		let primed = false;
		let finished = false;
		let disposed = false;
		let deadline = null;
		let ticker = null;
		let lastSecond = -1;

		// Host-side only. What each player has submitted this phase; cleared on
		// entry, handed to `onCollect` on exit.
		let entries = new Map();
		// Mirrored on every peer so a game can show "3 of 4 ready" without the
		// submissions themselves ever leaving the host.
		let submitted = [];

		const phase = () => phases[index] ?? null;

		const info = () => ({
			round,
			rounds: totalRounds,
			phase: primed ? (phase()?.name ?? null) : null,
			index,
			msLeft: Math.max(0, endsAt - Date.now()),
			secondsLeft: Math.max(0, Math.ceil((endsAt - Date.now()) / 1000)),
			submitted: [...submitted],
			finished,
		});

		// -- the clock (host) ------------------------------------------------

		/** Everyone who must submit before a collecting phase can end early. */
		const seats = () => ctx.players();

		const allIn = () => {
			const need = seats();
			return need.length > 0 && need.every((id) => entries.has(id));
		};

		const publish = () => {
			state.send({ r: round, i: index, ms: Math.max(0, endsAt - Date.now()), s: submitted, f: finished });
		};

		const enter = (nextRound, nextIndex) => {
			if (disposed) return;
			round = nextRound;
			index = nextIndex;
			primed = true;
			const p = phase();
			entries = new Map();
			submitted = [];
			endsAt = Date.now() + (p.ms ?? 0);
			publish();
			spec.onPhase?.(info());

			// Bots act as the phase opens rather than at some staggered delay: the
			// deadline is the only pacing this needs, and a bot that "thinks" for a
			// while is a flourish the game itself can add by delaying its answer.
			if (p.collect) {
				for (const botId of ctx.botSeats()) {
					const value = spec.botSubmit?.(botId, info());
					if (value !== undefined) record(botId, value);
				}
			}

			clearTimeout(deadline);
			if (p.collect && allIn()) return void queueAdvance();
			deadline = setTimeout(advance, Math.max(0, p.ms ?? 0));
		};

		// A collecting phase that is already satisfied still yields to the event
		// loop before advancing, so `onPhase` has returned — and the game has
		// drawn the phase — before `onCollect` tears it down again.
		const queueAdvance = () => {
			clearTimeout(deadline);
			deadline = setTimeout(advance, 0);
		};

		const advance = () => {
			if (disposed || !running) return;
			const p = phase();
			if (p.collect) {
				spec.onCollect?.({ ...info(), entries: new Map(entries) });
			}
			if (index + 1 < phases.length) return enter(round, index + 1);
			if (round + 1 < totalRounds) return enter(round + 1, 0);
			finished = true;
			running = false;
			clearTimeout(deadline);
			publish();
			spec.onFinish?.(info());
		};

		const record = (playerId, value) => {
			if (!room.isHost() || !phase()?.collect) return;
			if (!seats().includes(playerId)) return;
			entries.set(playerId, value);
			submitted = [...entries.keys()];
			publish();
			if (allIn()) queueAdvance();
		};

		// -- the mirror (everyone) -------------------------------------------

		state.onMessage = (msg, { peerId }) => {
			// Only the crown's clock counts. Without this a peer that still
			// believes in a departed host would take phase changes from anyone.
			if (peerId !== room.hostId()) return;
			// `primed` is what makes the *first* message count. Without it the
			// opening phase is silently swallowed on every guest: the host says
			// "round 0, phase 0", the mirror is already sitting on those two
			// numbers, and a plain equality check calls that no change.
			const changed = !primed || msg.r !== round || msg.i !== index;
			primed = true;
			round = msg.r;
			index = msg.i;
			endsAt = Date.now() + (msg.ms ?? 0);
			submitted = msg.s ?? [];
			finished = !!msg.f;
			if (finished) {
				spec.onFinish?.(info());
			} else if (changed) {
				spec.onPhase?.(info());
			}
		};

		inbox.onMessage = (msg, { peerId }) => {
			if (!room.isHost()) return;
			if (msg?.r !== round || msg?.i !== index) return; // stale, from a phase that has gone
			record(peerId, msg.v);
		};

		ticker = setInterval(() => {
			if (disposed) return;
			const now = info();
			if (now.secondsLeft !== lastSecond) {
				lastSecond = now.secondsLeft;
				spec.onTick?.(now);
			}
		}, TICK_MS);

		return {
			/** Host only. Begin at round 0, phase 0. */
			start() {
				if (!room.isHost() || running) return;
				running = true;
				finished = false;
				primed = true;
				enter(0, 0);
			},
			/** Submit this player's answer for the phase that is open now. */
			submit(value) {
				if (disposed || !phase()?.collect) return false;
				if (room.isHost()) record(room.selfId, value);
				else inbox.send({ r: round, i: index, v: value }, { target: room.hostId() });
				return true;
			},
			/** Host only. Submit on behalf of a bot it is playing. */
			submitFor(botId, value) {
				if (!room.isHost() || !NeonArcade.isBotId(botId)) return false;
				record(botId, value);
				return true;
			},
			/**
			 * Host only. End the current phase now, without waiting for its
			 * deadline or its submissions.
			 *
			 * Added for Liar's Dice, whose bidding phase ends when somebody calls a
			 * bluff — a game event, not a clock. Without it such a phase has to be
			 * given a deadline nobody intends to reach, and the round then sits
			 * there after it is already decided.
			 */
			next() {
				if (!room.isHost() || !running || disposed) return false;
				queueAdvance();
				return true;
			},
			/** Host only. Re-announce the current phase — for a peer that just joined. */
			sync() {
				if (room.isHost() && running) publish();
			},
			state: info,
			dispose() {
				disposed = true;
				running = false;
				clearTimeout(deadline);
				clearInterval(ticker);
				state.onMessage = null;
				inbox.onMessage = null;
			},
		};
	};
})();
