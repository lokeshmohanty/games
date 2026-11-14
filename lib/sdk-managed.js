// lib/sdk-managed.js — SDK v2's Layer 2: the platform runs the game.
//
// A managed game (manifest `"state": "managed"`) writes only its rules:
//
//   init({ seats, opts, seed, match })  → ()          state lives in the game
//   apply({ action, by })               → ok | reason  a move, by a seat
//   tick({ inputs, dt })                → ()          real-time games (manifest `tick`)
//   view({ seat })                      → json        what that seat may see (null: a spectator)
//   turn()                              → [seat]      whose move it is
//   bot({ seat })                       → action|null a bot's move (or, ticking, its input)
//   result()                            → r | null    the outcome, as sdk.md "Reporting a result"
//   snapshot() / restore({ snapshot })               for the heir
//   skip({ seat })                      → bool        optional: pass a missed turn
//   leave({ seat })                     → bool        optional: a seated player left for good
//
// and this file does everything else, which every v1 game wrote by hand:
//
//   - Host authority. Every phone's frame holds the rules; only the host's
//     are live. A guest's `act` travels to the host, is applied there, and
//     each phone gets its own `view` — sent only when it changed.
//   - Bots: after every change the host asks `turn()`, and a bot seat on it
//     moves after a human-feeling pause. Ticking, a bot's input comes from
//     `bot()` every tick.
//   - Waiting: a lone human on turn who has left or lost connection gets the
//     shell's turn-wait banner; SKIP calls the game's `skip`.
//   - Results: `result()` is checked after every change, reported once on
//     every phone, and the shell draws the end card with PLAY AGAIN.
//   - Handover: the host sends `snapshot()` to the heir (net.js `heir()`)
//     after every change, at most once a second when ticking. When the crown
//     moves, the heir restores it and carries on — no game writes `takeOver`.
//   - Rejoin: a phone that comes back is sent its view at once.
//
// The calls cross into the frame as one `rules` request with a list of calls
// (protocol.json), so a tick and its views are one round trip.

window.NeonArcade = window.NeonArcade || {};

(() => {
	const BOT_MS = [600, 1100]; // a bot's pause before moving, min–max
	const SNAP_EVERY_MS = 1000; // ticking: the heir's copy at most this stale
	const CALL_TIMEOUT_MS = 5000;

	/**
	 * The engine for one mount. `call(calls)` sends a `rules` request and
	 * resolves to its list of outcomes ({ v } or { err }); `toFrame(msg)` posts
	 * to this phone's frame; `chan(name)` is a service channel (v:m$…).
	 */
	NeonArcade.managedEngine = ({ game, ctx, room, call, toFrame, chan, onTurn, paused }) => {
		const tickHz = Number.isFinite(game.tick) && game.tick > 0 ? Math.min(60, game.tick) : 0;
		const viewEvery = tickHz ? Math.max(1, Math.round(tickHz / Math.min(tickHz, game.viewRate > 0 ? game.viewRate : 15))) : 1;
		const act = chan("m$act"); // guest → host: { a }
		const input = chan("m$in"); // guest → host: { i }
		const viewCh = chan("m$view"); // host → a phone: { v, m }
		const snapCh = chan("m$snap"); // host → heir: { s, m }
		const resCh = chan("m$res"); // host → everyone: { r, m }
		const rejCh = chan("m$rej"); // host → a guest: { a, reason }
		const againCh = chan("m$again"); // host → everyone: a rematch began

		let ready = false; // this phone's frame has registered its rules
		let live = false; // we are the host and the rules are initialised
		let match = 0;
		let over = null; // the result, once the match is decided
		let lastView = undefined; // this phone's, kept until the frame is ready
		const sent = new Map(); // phone -> JSON of the view it last got
		let snapshot = null; // the heir's copy: { s, m }
		const bots = new Map(); // bot seat -> its pending move's timer
		const inputs = {}; // ticking: seat -> latest input
		let ticker = null;
		let ticks = 0;
		let lastSnap = 0;
		let busy = Promise.resolve(); // calls run one at a time, in order
		let disposed = false;
		let card = null;
		const departed = new Set(); // left the party for good while we were mounted

		const seats = () => ctx.players();
		const seatList = () => room.getMembers().filter((m) => seats().includes(m.id)).map((m) => ({ id: m.id, name: m.name, team: m.team ?? null, bot: NeonArcade.isBotId(m.id) }));
		const humans = () => room.getMembers().map((m) => m.id).filter((id) => !NeonArcade.isBotId(id));
		const viewer = (id) => (seats().includes(id) ? id : null);

		/** Queue `calls` behind the ones in flight; resolves to their outcomes. */
		const run = (calls) => {
			const next = busy.then(() =>
				disposed
					? calls.map(() => ({ err: "unmounted" }))
					: Promise.race([call(calls), new Promise((_, no) => setTimeout(() => no(new Error("the game did not answer")), CALL_TIMEOUT_MS))]),
			);
			busy = next.catch(() => {});
			return next;
		};
		const fail = (err) => {
			if (disposed) return;
			console.warn(`${game.id}: ${err.message ?? err}`);
		};

		// -- what this phone sees ---------------------------------------------------

		const show = (v) => {
			lastView = v;
			if (ready) toFrame({ t: "view", state: v });
		};

		const drawCard = (r) => {
			card?.remove();
			card = null;
			if (!r) return;
			const ranking = Array.isArray(r.ranking) ? r.ranking : [];
			const nameOf = (id) => room.getMember(id)?.name ?? "Player";
			let title = "GAME OVER";
			// A game may name its own ending ("SOLVED IN 3:12"); else the ranking does.
			if (typeof r.title === "string" && r.title.trim()) title = r.title.trim().slice(0, 40).toUpperCase();
			else if (r.kind === "coop") title = "GAME OVER";
			else if (ranking.length === 1 && ranking[0].length > 1) title = "DRAW";
			else if (ranking[0]?.includes(room.selfId)) title = "YOU WIN";
			else if (ranking[0]?.length) title = `${ranking[0].map(nameOf).join(" & ").toUpperCase()} ${ranking[0].length > 1 ? "WIN" : "WINS"}`;
			card = document.createElement("div");
			card.className = "managed-over";
			card.setAttribute("role", "dialog");
			const box = document.createElement("div");
			const h = document.createElement("h2");
			h.textContent = title;
			box.append(h);
			if (room.isHost()) {
				const again = document.createElement("button");
				again.className = "neon-btn";
				again.textContent = "PLAY AGAIN";
				again.onclick = () => rematch();
				box.append(again);
			} else {
				const p = document.createElement("p");
				p.textContent = `${nameOf(room.hostId())} can start another`;
				box.append(p);
			}
			const look = document.createElement("button");
			look.className = "neon-btn";
			look.textContent = "SEE THE BOARD";
			look.onclick = () => (look.textContent = card?.classList.toggle("is-peek") ? "SHOW RESULT" : "SEE THE BOARD");
			box.append(look);
			card.append(box);
			ctx.root.append(card);
		};

		const decided = (r, m) => {
			if (over && m === match) return;
			match = m;
			over = r;
			ctx.reportResult?.({ ...r, match: m }, game);
			drawCard(r);
		};

		// -- the host -------------------------------------------------------------

		/** After any change: views to whoever's changed, the heir's copy, bots, result. */
		// `before`: calls to make first in the same round trip (a tick).
		async function refresh({ views = true, snap = true, before = [] } = {}) {
			if (!live || disposed) return;
			const ids = room.getMembers().map((m) => m.id).filter((id) => !NeonArcade.isBotId(id));
			const calls = [...before, { fn: "turn" }, { fn: "result" }];
			if (views) for (const id of ids) calls.push({ fn: "view", seat: viewer(id) });
			const out = await run(calls);
			if (!live) return;
			for (const o of out.slice(0, before.length)) if (o?.err) fail(new Error(o.err));
			const [turnOut, resOut, ...viewOuts] = out.slice(before.length);
			const turn = Array.isArray(turnOut?.v) ? turnOut.v : [];
			if (views) {
				ids.forEach((id, i) => {
					if (viewOuts[i]?.err) return fail(new Error(viewOuts[i].err));
					const v = viewOuts[i]?.v ?? null;
					const json = JSON.stringify(v);
					if (sent.get(id) === json) return;
					sent.set(id, json);
					if (id === room.selfId) show(v);
					else viewCh.send({ v, m: match }, { target: id });
				});
			}
			const r = resOut?.v ?? null;
			if (r && !over) {
				resCh.send({ r, m: match });
				decided(r, match);
			}
			// A lone human on turn gets the shell's banner while they are gone.
			const people = turn.filter((id) => !NeonArcade.isBotId(id));
			onTurn(!over && people.length === 1 && turn.length === 1 ? people[0] : null);
			if (!over && !tickHz) for (const id of turn) if (NeonArcade.isBotId(id)) botMove(id);
			if (snap) sendSnapshot();
		}

		async function sendSnapshot(force = false) {
			const heir = room.heir?.();
			if (!heir || NeonArcade.isBotId(heir) || heir === room.selfId) return;
			if (tickHz && !force && Date.now() - lastSnap < SNAP_EVERY_MS) return;
			lastSnap = Date.now();
			const [out] = await run([{ fn: "snapshot" }]);
			if (out?.err) return fail(new Error(out.err));
			if (live) snapCh.send({ s: out.v ?? null, m: match, over }, { target: heir });
		}

		function botMove(id) {
			if (bots.has(id)) return;
			const wait = BOT_MS[0] + Math.random() * (BOT_MS[1] - BOT_MS[0]);
			bots.set(
				id,
				setTimeout(async () => {
					if (!live || over) return bots.delete(id);
					const [out] = await run([{ fn: "bot", seat: id }]);
					bots.delete(id);
					if (out?.v != null && live) await applyBy(out.v, id);
				}, wait),
			);
		}

		/** Apply `a` by seat `by`; the reason when the game refuses. */
		async function applyBy(a, by) {
			if (!live || over) return "the game is over";
			const [out] = await run([{ fn: "apply", action: a, by }]);
			const v = out?.err ? out.err : out?.v;
			const reason = v === undefined || v === null || v === true ? null : typeof v === "string" ? v : "not allowed";
			if (!reason) await refresh();
			return reason;
		}

		async function start(snap) {
			if (disposed) return false;
			for (const t of bots.values()) clearTimeout(t);
			bots.clear();
			sent.clear();
			if (snap) {
				const [out] = await run([{ fn: "restore", snapshot: snap.s }]);
				if (out?.err) {
					fail(new Error(out.err));
					return false;
				}
				match = snap.m;
				over = snap.over ?? null;
			} else {
				over = null;
				const [out] = await run([{ fn: "init", seats: seatList(), opts: game.opts ?? {}, seed: Math.floor(Math.random() * 2 ** 31), match }]);
				if (out?.err) {
					fail(new Error(out.err));
					return false;
				}
			}
			live = true;
			drawCard(over);
			if (tickHz) startTicking();
			// Taking over: whoever left before the crown reached us (the old
			// host, usually) is told to the rules now.
			if (snap && departed.size && !over) await run([...departed].map((seat) => ({ fn: "leave", seat })));
			await refresh();
			return true;
		}

		function rematch() {
			if (!room.isHost()) return;
			match += 1;
			againCh.send({ m: match });
			drawCard(null);
			start(null).catch(fail);
		}

		function startTicking() {
			clearInterval(ticker);
			const dt = 1 / tickHz;
			let stepping = false;
			ticker = setInterval(async () => {
				// A tick still in flight (a slow phone) is not stacked behind.
				if (!live || over || disposed || stepping || paused()) return;
				stepping = true;
				try {
					ticks += 1;
					const botSeats = seats().filter((id) => NeonArcade.isBotId(id));
					const moves = botSeats.length ? await run(botSeats.map((seat) => ({ fn: "bot", seat }))) : [];
					botSeats.forEach((seat, i) => {
						if (moves[i]?.v != null) inputs[seat] = moves[i].v;
					});
					await refresh({ views: ticks % viewEvery === 0, snap: true, before: [{ fn: "tick", inputs: { ...inputs }, dt }] });
				} catch (err) {
					fail(err);
				} finally {
					stepping = false;
				}
			}, 1000 / tickHz);
		}

		// -- the wire -------------------------------------------------------------

		act.onMessage = async (d, { peerId }) => {
			if (!room.isHost() || !live || !d || !("a" in d)) return;
			const reason = await applyBy(d.a, peerId);
			if (reason) rejCh.send({ a: d.a, reason }, { target: peerId });
		};
		input.onMessage = (d, { peerId }) => {
			if (room.isHost() && d && "i" in d && seats().includes(peerId)) inputs[peerId] = d.i;
		};
		viewCh.onMessage = (d, { peerId }) => {
			if (peerId !== room.hostId() || room.isHost() || !d) return;
			if (d.m > match) {
				match = d.m;
				over = null;
				drawCard(null);
			}
			show(d.v ?? null);
		};
		snapCh.onMessage = (d, { peerId }) => {
			if (peerId === room.hostId() && !room.isHost() && d) snapshot = d;
		};
		resCh.onMessage = (d, { peerId }) => {
			if (peerId === room.hostId() && !room.isHost() && d?.r) decided(d.r, d.m);
		};
		rejCh.onMessage = (d, { peerId }) => {
			if (peerId === room.hostId() && d) toFrame({ t: "rejected", a: d.a ?? null, reason: String(d.reason ?? "") });
		};
		againCh.onMessage = (d, { peerId }) => {
			if (peerId !== room.hostId() || !d) return;
			match = d.m;
			over = null;
			drawCard(null);
		};

		return {
			/** This phone's frame registered its rules (it said `ready`). */
			ready() {
				if (ready) return;
				ready = true;
				if (lastView !== undefined) toFrame({ t: "view", state: lastView });
				if (room.isHost() && !live) start(null).catch(fail);
			},
			/** This phone's player acted (`act` from its frame). */
			async act(a) {
				if (room.isHost()) {
					const reason = await applyBy(a, room.selfId);
					if (reason) toFrame({ t: "rejected", a, reason });
				} else act.send({ a }, { target: room.hostId() });
			},
			/** This phone's player's latest input (`input`), for a ticking game. */
			input(i) {
				if (room.isHost()) inputs[room.selfId] = i;
				else input.send({ i }, { target: room.hostId() });
			},
			/** The turn-wait banner's SKIP TURN. */
			async skip(seat) {
				if (!live) return;
				const [out] = await run([{ fn: "skip", seat }]);
				if (out?.v === true) await refresh();
				else NeonArcade.toast?.("This game cannot skip a turn", "warn");
			},
			/** Someone joined or came back: their view, and the heir may have changed. */
			peerJoined(id) {
				if (!live) return;
				sent.delete(id);
				refresh().catch(fail);
			},
			roster() {
				if (live) refresh().catch(fail);
			},
			/** A member left the party for good (not a held seat): the rules' `leave`. */
			async peerLeft(id) {
				departed.add(id);
				if (!live || over || !seats().length) return;
				const [out] = await run([{ fn: "leave", seat: id }]);
				if (out?.v === true) await refresh();
			},
			/** The crown moved here: carry on from the heir's copy, if we have one. */
			async takeOver() {
				if (live) return true;
				if (!snapshot) return false;
				return start(snapshot).catch((err) => {
					fail(err);
					return false;
				});
			},
			dispose() {
				disposed = true;
				live = false;
				clearInterval(ticker);
				for (const t of bots.values()) clearTimeout(t);
				card?.remove();
				for (const c of [act, input, viewCh, snapCh, resCh, rejCh, againCh]) c.onMessage = null;
			},
		};
	};
})();
