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
//   result()                            → r | null    the outcome, as docs/platform.md "Results"
//   snapshot() / restore({ snapshot })               for the heir
//   skip({ seat })                      → bool        optional: pass a missed turn
//   leave({ seat })                     → bool        optional: a seated player left for good
//
// and this file does everything else, which every game used to write by hand:
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
		// The end card's extras (drawCard). How long a match took: the host
		// times it from init (an heir from its copy, `ms` in) and tells every
		// phone with the result. The series counts the results this mount saw.
		let startedAt = Date.now(); // this match's start, on this phone's clock
		let timed = null; // { m, ms }: how long match m took
		const series = { draws: 0, wins: new Map() }; // wins: id -> matches won
		const named = new Map(); // id -> { name, seat }: still named once they have left
		// Who left for good since the heir's copy was taken: on a takeover only
		// these are told to `leave` (the copy already has the earlier ones), and
		// never someone who has come back since.
		let leftSinceSnap = new Set();
		const actBudget = new Map(); // guest -> acts left this second
		const budgetReset = setInterval(() => actBudget.clear(), 1000);
		const MAX_ACTS_PER_SECOND = 30;

		const seats = () => ctx.players();
		// The account layer hears once of each match this phone sees begin — the
		// host as it starts one, a guest at its first view — with who is seated
		// (lib/account.js matchStart: the result's seats and departures).
		let begun = -1;
		const began = (m) => {
			if (m <= begun) return;
			begun = m;
			NeonArcade.account?.matchStart?.(game.id, { room, seats: seats(), kind: game.kind, match: m });
		};
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

		const DETAILS_KEY = "neon.overDetails"; // the card's DETAILS open on this device: "1"
		const MAX_DETAILS = 8; // a game's own rows (result `details`)

		/** Who is seated, by name and seat (their colour): kept for after they leave. */
		const remember = () =>
			seats().forEach((id, seat) => named.set(id, { name: room.getMember(id)?.name ?? named.get(id)?.name ?? "Player", seat }));

		/** 754 s → "12:34"; an hour or more → "1:02:03". */
		const clock = (ms) => {
			const t = Math.max(0, Math.round(ms / 1000));
			const two = (n) => String(n).padStart(2, "0");
			const h = Math.floor(t / 3600);
			const m = Math.floor(t / 60) % 60;
			return h ? `${h}:${two(m)}:${two(t % 60)}` : `${m}:${two(t % 60)}`;
		};
		const shown = (v) => (typeof v === "string" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(Math.round(v * 100) / 100) : "");

		/** A game's own `details`: at most MAX_DETAILS rows of short strings or numbers. */
		const detailsOf = (r) =>
			(Array.isArray(r.details) ? r.details : [])
				.map((d) => [shown(d?.label).slice(0, 32), shown(d?.value).slice(0, 40)])
				.filter(([label, value]) => label && value)
				.slice(0, MAX_DETAILS);

		/** A small table: `rows` of [label, value]. */
		const table = (section, caption, rows) => {
			const t = document.createElement("table");
			t.dataset.section = section;
			const cap = document.createElement("caption");
			cap.textContent = caption;
			t.append(cap);
			for (const [label, value] of rows) {
				const tr = document.createElement("tr");
				const th = document.createElement("th");
				th.scope = "row";
				th.textContent = label;
				const td = document.createElement("td");
				td.textContent = value;
				tr.append(th, td);
				t.append(tr);
			}
			return t;
		};

		/**
		 * The end card (Lokesh, 2026-11-15: everything, but extra information
		 * behind a toggle so the screen stays simple). Always: the title, the
		 * ranking, PLAY AGAIN or who can, SEE THE BOARD. Behind DETAILS: the
		 * series and the time, your stats, the game's own details.
		 */
		const drawCard = (r) => {
			card?.remove();
			card = null;
			remember();
			if (!r) return;
			const ranking = (Array.isArray(r.ranking) ? r.ranking : []).filter(Array.isArray);
			// A game may name its own bot seats (result `names`): a person
			// playing on the host's phone is a bot seat to the platform
			// (Neon Fission's "Player 3"). Never a real member's name.
			const given = (id) => (NeonArcade.isBotId(id) && typeof r.names?.[id] === "string" && r.names[id].trim() ? r.names[id].trim().slice(0, 24) : null);
			const nameOf = (id) => given(id) ?? room.getMember(id)?.name ?? named.get(id)?.name ?? "Player";
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
			card.setAttribute("aria-labelledby", "managed-over-title");
			const box = document.createElement("div");
			const h = document.createElement("h2");
			h.id = "managed-over-title";
			h.textContent = title;
			box.append(h);

			const body = document.createElement("div");
			body.className = "managed-body";
			// The ranking: place (a tie or a team shares one), seat colour, name,
			// score. Co-op is one slot: no places, best score first.
			const scoreOf = (id) => (typeof r.scores?.[id] === "number" && Number.isFinite(r.scores[id]) ? r.scores[id] : null);
			const placed = ranking.length > 1 || r.kind !== "coop";
			const rows = ranking.flatMap((slot, i) => slot.map((id) => ({ id, place: i + 1 })));
			if (!placed) rows.sort((a, b) => (scoreOf(b.id) ?? -Infinity) - (scoreOf(a.id) ?? -Infinity));
			const list = document.createElement("ol");
			list.className = "managed-rank";
			list.setAttribute("aria-label", "Ranking");
			rows.forEach(({ id, place }, i) => {
				const li = document.createElement("li");
				li.dataset.id = id;
				if (id === room.selfId) li.className = "is-you";
				const at = document.createElement("span");
				at.className = "managed-place";
				at.textContent = placed ? String(place) : "";
				const dot = document.createElement("span");
				dot.className = "managed-dot";
				dot.style.background = `var(--p${((named.get(id)?.seat ?? i) % 8) + 1})`;
				const who = document.createElement("span");
				who.className = "managed-name";
				who.textContent = nameOf(id);
				if (id === room.selfId) {
					const you = document.createElement("small");
					you.textContent = "you";
					who.append(" ", you);
				}
				const score = document.createElement("span");
				score.className = "managed-score";
				score.textContent = scoreOf(id) === null ? "" : shown(scoreOf(id));
				li.append(at, dot, who, score);
				list.append(li);
			});
			if (rows.length) body.append(list);
			// A line the account layer fills — the rating change once the
			// server answers, in place if that is after this is drawn
			// (lib/account.js endCard).
			const ranked = document.createElement("p");
			ranked.className = "managed-rating";
			ranked.setAttribute("aria-live", "polite");
			ranked.hidden = true;
			body.append(ranked);
			NeonArcade.account?.endCard?.(game.id, match, ranked, room.getRun?.() ?? null);

			// DETAILS: closed until opened, then open on this device's next cards.
			const extra = document.createElement("div");
			extra.className = "managed-details";
			extra.id = "managed-over-details";
			const me = ranking.some((slot) => slot.includes(room.selfId));
			// Only who has won one: eight rows of "0 won" would bury the rest.
			const winners = [...series.wins.keys()].sort((a, b) => series.wins.get(b) - series.wins.get(a));
			const took = timed?.m === match ? timed.ms : null;
			extra.append(
				table("series", "Series", [
					["Match", String(match + 1)],
					...(took === null ? [] : [["Time", clock(took)]]),
					...winners.map((id) => [nameOf(id), `${series.wins.get(id)} won`]),
					...(series.draws ? [["Draws", String(series.draws)]] : []),
				]),
			);
			const rec = NeonArcade.stats?.read?.()?.[game.id];
			extra.append(
				table(
					"stats",
					"Your stats",
					rec
						? [
								["Played", String(rec.played ?? 0)],
								["Won", String(rec.won ?? 0)],
								["Streak", `${rec.streak ?? 0} (best ${rec.best ?? 0})`],
								["Vs bots · people", `${rec.vsBots ?? 0} · ${rec.vsPeople ?? 0}`],
								...(typeof rec.bestScore === "number" ? [["Best score", shown(rec.bestScore)]] : []),
							]
						: [["Played", me ? "not counted" : "you watched"]],
				),
			);
			const own = detailsOf(r);
			if (own.length) extra.append(table("game", game.title ?? game.name ?? "This game", own));
			let open = false;
			try {
				open = localStorage.getItem(DETAILS_KEY) === "1";
			} catch {}
			const toggle = document.createElement("button");
			toggle.type = "button";
			toggle.className = "managed-toggle";
			toggle.textContent = "DETAILS";
			toggle.setAttribute("aria-controls", extra.id);
			const setOpen = (on) => {
				open = on;
				extra.hidden = !on;
				toggle.setAttribute("aria-expanded", String(on));
			};
			setOpen(open);
			toggle.onclick = () => {
				setOpen(!open);
				try {
					localStorage.setItem(DETAILS_KEY, open ? "1" : "0");
				} catch {}
			};
			body.append(toggle, extra);
			box.append(body);

			const actions = document.createElement("div");
			actions.className = "managed-actions";
			if (room.isHost()) {
				const again = document.createElement("button");
				again.className = "neon-btn";
				again.textContent = "PLAY AGAIN";
				again.onclick = () => rematch();
				actions.append(again);
			} else {
				const p = document.createElement("p");
				p.textContent = `${nameOf(room.hostId())} can start another`;
				actions.append(p);
			}
			const look = document.createElement("button");
			look.className = "neon-btn";
			look.textContent = "SEE THE BOARD";
			look.onclick = () => (look.textContent = card?.classList.toggle("is-peek") ? "SHOW RESULT" : "SEE THE BOARD");
			actions.append(look);
			box.append(actions);
			card.append(box);
			ctx.root.append(card);
		};

		/**
		 * A result for match `m`, which took `ms` (the host's clock): reported
		 * once on this phone, counted in the series, and the card.
		 */
		const decided = (r, m, ms) => {
			if (m < match || (over && m === match)) return; // never backwards, never twice
			match = m;
			over = r;
			timed = Number.isFinite(ms) && ms >= 0 ? { m, ms } : null;
			const ranking = Array.isArray(r.ranking) ? r.ranking : [];
			if (r.kind !== "coop" && r.kind !== "local" && Array.isArray(ranking[0])) {
				if (ranking.length === 1 && ranking[0].length > 1) series.draws += 1;
				else for (const id of ranking[0]) series.wins.set(id, (series.wins.get(id) ?? 0) + 1);
			}
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
				const ms = Date.now() - startedAt;
				resCh.send({ r, m: match, ms });
				decided(r, match, ms);
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
			// ms: how long the match has run (or took), for the heir's end card.
			const ms = over ? (timed?.m === match ? timed.ms : null) : Date.now() - startedAt;
			if (live && e === epoch) snapCh.send({ s: wireOut(out.v ?? null), m: match, over, ms }, { target: heir });
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
			// The match before stops here, before any await: a rematch waits for
			// the server's run (startRun), and a ticker still running meanwhile
			// stepped the finished world and re-reported its result into the new
			// match (review, 2026-11-15).
			live = false;
			clearInterval(ticker);
			ticker = null;
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
				// Played alone (one seat, ours, no bots) and signed in: the server
				// issues the run and its seed, so the score can rank (lib/account.js
				// startRun, docs/accounts.md "Solo runs"). Offline, signed out or
				// slow, it is a local seed and the run simply does not rank.
				// Ours the only person's seat among bots: a run for the board of
				// wins against bots ("Against bots"), asked for here, as the match
				// begins, and not waited for — it only starts the server's clock.
				const e = epoch;
				began(match);
				const seats = seatList();
				const alone = seats.length === 1 && !seats[0].bot && seats[0].id === room.selfId;
				const people = seats.filter((p) => !p.bot);
				const vsBots = people.length === 1 && people[0].id === room.selfId && seats.length > 1 && game.kind !== "coop" && game.kind !== "local";
				if (vsBots) NeonArcade.account?.startRun?.(game.id, { vs: "bots", bots: seats.filter((p) => p.bot).map((p) => p.id) });
				const issued = alone ? await NeonArcade.account?.startRun?.(game.id) : null;
				if (disposed || e !== epoch) return false;
				const seed = Number.isInteger(issued?.seed) ? issued.seed : Math.floor(Math.random() * 2 ** 31);
				const [out] = await run([{ fn: "init", seats, opts: game.opts ?? {}, seed, match }]);
				if (out?.err) {
					fail(new Error(out.err));
					return false;
				}
				over = null; // only now: the new match exists
			}
			leftSinceSnap = new Set();
			startedAt = Date.now() - (snap && !over && Number.isFinite(snap.ms) ? snap.ms : 0);
			if (over && timed?.m !== match && Number.isFinite(snap?.ms)) timed = { m: match, ms: snap.ms };
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
			if (!over && d.m === match) began(match);
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
			if (peerId === room.hostId() && !room.isHost() && d?.r) decided(d.r, d.m, d.ms);
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
				if (over) resCh.send({ r: over, m: match, ms: timed?.m === match ? timed.ms : null }, { target: id });
				tellTurn(lastTurn, id);
				refresh().catch(fail);
			},
			/**
			 * The party record changed. Every view is sent again if it differs
			 * from nothing: a phone whose link dropped and came back without a
			 * reload fires no join, and a view sent into the outage is lost.
			 */
			roster() {
				remember(); // names for the end card, before anyone leaves
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
				// Taken down with its match undecided while still in the party:
				// the account layer withdraws this phone's start (lib/account.js matchEnd).
				if (begun >= 0) NeonArcade.account?.matchEnd?.(game.id, { decided: !!over, room });
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
