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
	NeonArcade.managedEngine = ({ game, ctx, room, call, toFrame, chan, onTurn, paused, bin }) => {
		const tickHz = Number.isFinite(game.tick) && game.tick > 0 ? Math.min(60, game.tick) : 0;
		const viewEvery = tickHz ? Math.max(1, Math.round(tickHz / Math.min(tickHz, game.viewRate > 0 ? game.viewRate : 15))) : 1;
		// Binary inside actions, inputs, views and snapshots crosses between
		// phones as { $bin } (lib/sdk-host.js binOut / binIn).
		const wireOut = bin?.out ?? ((v) => v);
		const wireIn = bin?.in ?? ((v) => v);
		const act = chan("m$act"); // guest → host: { a, m }
		const input = chan("m$in"); // guest → host: { i }
		const viewCh = chan("m$view"); // host → a phone: { v, m }
		const turnCh = chan("m$turn"); // host → everyone: { who } for the turn-wait banner
		const snapCh = chan("m$snap"); // host → heir: { s, m, over }
		const resCh = chan("m$res"); // host → everyone (or a newcomer): { r, m }
		const rejCh = chan("m$rej"); // host → a guest: { a, reason }
		const againCh = chan("m$again"); // host → everyone: a rematch began

		let ready = false; // this phone's frame has registered its rules
		let live = false; // we are the host and the rules are initialised
		let goLive; // resolves the next time `live` turns true
		let whenLive = new Promise((r) => (goLive = r));
		// Bumped by every start (a match, a rematch, a takeover): an await that
		// began under an older epoch drops what it got. Found by review: a
		// refresh in flight across PLAY AGAIN ended the new match at once.
		let epoch = 0;
		let match = 0;
		let over = null; // the result, once the match is decided
		let lastView = undefined; // this phone's, kept until the frame is ready
		const sent = new Map(); // phone -> JSON of the view it last got
		let snapshot = null; // the heir's copy: { s, m, over }
		const bots = new Map(); // bot seat -> its pending move's timer
		let inputs = {}; // ticking: seat -> latest input
		let ticker = null;
		let ticks = 0;
		let lastSnap = 0;
		let lastTurn = null; // who the banner waits on, as last told
		let busy = Promise.resolve(); // calls run one at a time, in order
		let disposed = false;
		let card = null;
		// Who left for good since the heir's copy was taken: on a takeover only
		// these are told to `leave` (the copy already has the earlier ones), and
		// never someone who has come back since.
		let leftSinceSnap = new Set();
		const actBudget = new Map(); // guest -> acts left this second
		const budgetReset = setInterval(() => actBudget.clear(), 1000);
		const MAX_ACTS_PER_SECOND = 30;

		const seats = () => ctx.players();
		const seatList = () => room.getMembers().filter((m) => seats().includes(m.id)).map((m) => ({ id: m.id, name: m.name, team: m.team ?? null, bot: NeonArcade.isBotId(m.id) }));
		const viewer = (id) => (seats().includes(id) ? id : null);

		/** Queue `calls` behind the ones in flight; resolves to their outcomes. */
		const run = (calls) => {
			const next = busy.then(() => {
				if (disposed) return calls.map(() => ({ err: "unmounted" }));
				let timer;
				return Promise.race([
					call(calls).finally(() => clearTimeout(timer)),
					new Promise((_, no) => (timer = setTimeout(() => no(new Error("the game did not answer")), CALL_TIMEOUT_MS))),
				]);
			});
			busy = next.catch(() => {});
			return next;
		};
		const fail = (err) => {
			if (disposed) return;
			console.warn(`${game.id}: ${err?.message ?? err}`);
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

		/** A result for match `m`: reported once on this phone, and the card. */
		const decided = (r, m) => {
			if (m < match || (over && m === match)) return; // never backwards, never twice
			match = m;
			over = r;
			ctx.reportResult?.({ ...r, match: m }, game);
			drawCard(r);
		};

		// -- the host -------------------------------------------------------------

		/**
		 * After any change: views to whoever's changed, the banner, bots, the
		 * result, the heir's copy. `before`: calls to make first in the same
		 * round trip (a tick).
		 */
		async function refresh({ views = true, snap = true, before = [] } = {}) {
			if (!live || disposed) return;
			const e = epoch;
			const ids = room.getMembers().map((m) => m.id).filter((id) => !NeonArcade.isBotId(id));
			const calls = [...before, { fn: "turn" }, { fn: "result" }];
			if (views) for (const id of ids) calls.push({ fn: "view", seat: viewer(id) });
			const out = await run(calls);
			if (!live || e !== epoch) return;
			for (const o of out.slice(0, before.length)) if (o?.err) fail(new Error(o.err));
			const [turnOut, resOut, ...viewOuts] = out.slice(before.length);
			const turn = Array.isArray(turnOut?.v) ? turnOut.v : [];
			if (views) {
				ids.forEach((id, i) => {
					if (viewOuts[i]?.err) return fail(new Error(viewOuts[i].err));
					const v = viewOuts[i]?.v ?? null;
					const w = wireOut(v);
					const json = JSON.stringify(w);
					if (sent.get(id) === json) return;
					sent.set(id, json);
					if (id === room.selfId) show(v);
					else viewCh.send({ v: w, m: match }, { target: id });
				});
			}
			const r = resOut?.v ?? null;
			if (r && !over) {
				resCh.send({ r, m: match });
				decided(r, match);
				// The heir's copy must know it is over, now: ticking, the copy is
				// rate-limited and the ticker stops here, so without this an heir
				// restored a running match from a second before the end.
				sendSnapshot(true).catch(fail);
				snap = false;
			}
			// A lone human on turn gets the shell's banner while they are gone,
			// on every phone.
			const people = turn.filter((id) => !NeonArcade.isBotId(id));
			tellTurn(!over && people.length === 1 && turn.length === 1 ? people[0] : null);
			if (!over && !tickHz) for (const id of turn) if (NeonArcade.isBotId(id)) botMove(id);
			if (snap) sendSnapshot().catch(fail);
		}

		function tellTurn(who, to) {
			if (to) return turnCh.send({ who }, { target: to });
			if (who === lastTurn) return;
			lastTurn = who;
			onTurn(who);
			turnCh.send({ who });
		}

		async function sendSnapshot(force = false) {
			const heir = room.heir?.();
			if (!heir || NeonArcade.isBotId(heir) || heir === room.selfId) return;
			if (tickHz && !force && Date.now() - lastSnap < SNAP_EVERY_MS) return;
			lastSnap = Date.now();
			const e = epoch;
			const [out] = await run([{ fn: "snapshot" }]);
			if (out?.err) return fail(new Error(out.err));
			if (live && e === epoch) snapCh.send({ s: wireOut(out.v ?? null), m: match, over }, { target: heir });
		}

		function botMove(id) {
			if (bots.has(id)) return;
			const e = epoch;
			const wait = BOT_MS[0] + Math.random() * (BOT_MS[1] - BOT_MS[0]);
			bots.set(
				id,
				setTimeout(async () => {
					try {
						if (!live || over || e !== epoch) return;
						const [out] = await run([{ fn: "bot", seat: id }]);
						if (out?.v != null && live && e === epoch) await applyBy(out.v, id, match);
					} catch (err) {
						fail(err);
					} finally {
						if (e === epoch) bots.delete(id);
					}
				}, wait),
			);
		}

		/** Apply `a` by seat `by` in match `m`; the reason when it is refused. */
		async function applyBy(a, by, m) {
			if (!live) return "the game is starting";
			if (m !== match) return "that move was for the last game";
			if (over) return "the game is over";
			const e = epoch;
			const [out] = await run([{ fn: "apply", action: a, by }]);
			if (e !== epoch) return "that move was for the last game";
			const v = out?.err ? out.err : out?.v;
			const reason = v === undefined || v === null || v === true ? null : typeof v === "string" ? v : "not allowed";
			if (!reason) await refresh();
			return reason;
		}

		async function start(snap) {
			if (disposed) return false;
			epoch += 1;
			for (const t of bots.values()) clearTimeout(t);
			bots.clear();
			sent.clear();
			inputs = {};
			lastTurn = null;
			const replay = snap ? [...leftSinceSnap].filter((id) => !room.getMember(id)) : [];
			if (snap) {
				const [out] = await run([{ fn: "restore", snapshot: snap.s }]);
				if (out?.err) {
					fail(new Error(out.err));
					return false;
				}
				// A result this phone already heard for that match stands, even if
				// the copy was taken a moment before it.
				const known = snap.m === match ? over : null;
				match = snap.m;
				over = snap.over ?? known;
			} else {
				over = null;
				const [out] = await run([{ fn: "init", seats: seatList(), opts: game.opts ?? {}, seed: Math.floor(Math.random() * 2 ** 31), match }]);
				if (out?.err) {
					fail(new Error(out.err));
					return false;
				}
			}
			leftSinceSnap = new Set();
			live = true;
			goLive();
			drawCard(over);
			if (tickHz) startTicking();
			// Taking over: whoever left after the copy was taken (the old host,
			// usually) is told to the rules now.
			if (replay.length && !over) await run(replay.map((seat) => ({ fn: "leave", seat })));
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
					// Only seated players' inputs: a bot removed, a player gone or
					// moved to watching must not leave a ghost behind.
					const seated = new Set(seats());
					for (const k of Object.keys(inputs)) if (!seated.has(k)) delete inputs[k];
					const botSeats = [...seated].filter((id) => NeonArcade.isBotId(id));
					const e = epoch;
					const moves = botSeats.length ? await run(botSeats.map((seat) => ({ fn: "bot", seat }))) : [];
					if (e !== epoch) return;
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
			if (!room.isHost() || !d || !("a" in d)) return;
			const left = actBudget.get(peerId) ?? MAX_ACTS_PER_SECOND;
			if (left <= 0) return; // a flood must not starve everyone's rules calls
			actBudget.set(peerId, left - 1);
			try {
				const reason = await applyBy(wireIn(d.a), peerId, d.m);
				if (reason) rejCh.send({ a: d.a, reason }, { target: peerId });
			} catch (err) {
				fail(err);
				rejCh.send({ a: d.a, reason: "the host could not apply it" }, { target: peerId });
			}
		};
		input.onMessage = (d, { peerId }) => {
			if (room.isHost() && d && "i" in d && seats().includes(peerId)) inputs[peerId] = wireIn(d.i);
		};
		viewCh.onMessage = (d, { peerId }) => {
			if (peerId !== room.hostId() || room.isHost() || !d) return;
			if (d.m > match) {
				match = d.m;
				over = null;
				drawCard(null);
			}
			// A copy from an older match is no copy: restoring it would rewind.
			if (snapshot && d.m > snapshot.m) snapshot = null;
			show(wireIn(d.v ?? null));
		};
		turnCh.onMessage = (d, { peerId }) => {
			if (peerId === room.hostId() && !room.isHost() && d) onTurn(typeof d.who === "string" ? d.who : null);
		};
		snapCh.onMessage = (d, { peerId }) => {
			if (peerId !== room.hostId() || room.isHost() || !d) return;
			snapshot = { ...d, s: wireIn(d.s) };
			leftSinceSnap = new Set();
		};
		resCh.onMessage = (d, { peerId }) => {
			if (peerId === room.hostId() && !room.isHost() && d?.r) decided(d.r, d.m);
		};
		rejCh.onMessage = (d, { peerId }) => {
			if (peerId === room.hostId() && d) toFrame({ t: "rejected", a: d.a ?? null, reason: String(d.reason ?? "") });
		};
		againCh.onMessage = (d, { peerId }) => {
			if (peerId !== room.hostId() || !d || d.m < match) return;
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
				try {
					if (room.isHost()) {
						const reason = await applyBy(a, room.selfId, match);
						if (reason) toFrame({ t: "rejected", a, reason });
					} else act.send({ a: wireOut(a), m: match }, { target: room.hostId() });
				} catch (err) {
					fail(err);
				}
			},
			/** This phone's player's latest input (`input`), for a ticking game. */
			input(i) {
				if (room.isHost()) inputs[room.selfId] = i;
				else input.send({ i: wireOut(i) }, { target: room.hostId() });
			},
			/** The turn-wait banner's SKIP TURN. */
			async skip(seat) {
				// The heir's banner gets its buttons as the crown arrives, a moment
				// before the takeover runs (party.js waits for the crown to
				// settle): a SKIP pressed then waits for it instead of vanishing.
				if (!live) await Promise.race([whenLive, new Promise((r) => setTimeout(r, 5000))]);
				if (!live) return;
				const e = epoch;
				// Only if it is still their turn: the banner may be a beat behind.
				const [t] = await run([{ fn: "turn" }]);
				if (e !== epoch || !Array.isArray(t?.v) || !t.v.includes(seat)) return;
				const [out] = await run([{ fn: "skip", seat }]);
				if (e !== epoch) return;
				if (out?.v === true) await refresh();
				else NeonArcade.toast?.("This game cannot skip a turn", "warn");
			},
			/** Someone joined or came back: their view, the banner, and the result if it is over. */
			peerJoined(id) {
				leftSinceSnap.delete(id);
				if (!live) return;
				sent.delete(id);
				if (over) resCh.send({ r: over, m: match }, { target: id });
				tellTurn(lastTurn, id);
				refresh().catch(fail);
			},
			/**
			 * The party record changed. Every view is sent again if it differs
			 * from nothing: a phone whose link dropped and came back without a
			 * reload fires no join, and a view sent into the outage is lost.
			 */
			roster() {
				if (!live) return;
				sent.clear();
				refresh().catch(fail);
			},
			/** A member left the party for good (not a held seat): the rules' `leave`. */
			async peerLeft(id) {
				leftSinceSnap.add(id);
				if (!live || over || !seats().length) return;
				const e = epoch;
				const [out] = await run([{ fn: "leave", seat: id }]);
				if (e === epoch && out?.v === true) await refresh();
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
				epoch += 1;
				clearInterval(ticker);
				clearInterval(budgetReset);
				for (const t of bots.values()) clearTimeout(t);
				card?.remove();
				for (const c of [act, input, viewCh, turnCh, snapCh, resCh, rejCh, againCh]) c.onMessage = null;
			},
		};
	};
})();
