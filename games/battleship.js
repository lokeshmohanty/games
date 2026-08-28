// games/battleship.js — Battleship, as a mountable module.
//
// This is the game the plumbing was built for. Everything else here is
// host-authoritative: one browser owns the truth and the rest render it. That
// cannot work when the truth is *where your ships are*, because the host is a
// player and would be holding the other player's fleet.
//
// So nobody holds anybody's fleet. Each player keeps their own board, answers
// hit-or-miss for shots aimed at it, and is bound to have told the truth by a
// **commitment** published before a shot was fired. At the end both fleets are
// revealed, every answer is re-checked against them, and a player whose answers
// do not match the fleet they committed to loses on the spot. See
// `lib/secrets.js`, and the `addressed-is-not-private` memory for why the
// obvious alternative — mail your fleet to the host — is not private at all.
//
// ## Both players fire at once
//
// Not alternating turns. A salvo round opens, both players pick a square, and
// the round resolves when both have — `lib/rounds.js` with `collect: true`.
// This is a real variant, and it is the one that suits this transport: nobody
// waits on anybody's turn, a slow link costs only its owner, and the host never
// has to decide who acted first. It also means both fleets can go down on the
// same volley, which is a draw and a good ending.
//
// ## What is public and what is not
//
//   public   the shots, the answers, both commitments, both fleets at the end
//   private  your fleet during play — and it never leaves your browser at all,
//            so there is nothing to intercept and nothing to relay
//
// The rules and the bot live outside `mount` as `NeonArcade.battleshipRules`,
// so `scripts/test-battleship.mjs` can play whole games with no document.

(() => {
	const SIZE = 8;

	// Four ships, eighteen percent of the water — the same density as the
	// classic ten-by-ten, on a board that fits a phone twice over (you need to
	// see your own waters and theirs at the same time).
	const FLEET = [
		{ id: "carrier", name: "CARRIER", len: 4 },
		{ id: "cruiser", name: "CRUISER", len: 3 },
		{ id: "sub", name: "SUB", len: 3 },
		{ id: "patrol", name: "PATROL", len: 2 },
	];
	const FLEET_CELLS = FLEET.reduce((n, s) => n + s.len, 0);

	const inBounds = (r, c) => r >= 0 && r < SIZE && c >= 0 && c < SIZE;
	const key = (r, c) => `${r},${c}`;

	/** The squares a placed ship occupies. */
	function cellsOf(ship) {
		const spec = FLEET.find((s) => s.id === ship.id);
		if (!spec) return [];
		const out = [];
		for (let i = 0; i < spec.len; i++) {
			out.push(ship.dir === "h" ? [ship.r, ship.c + i] : [ship.r + i, ship.c]);
		}
		return out;
	}

	/**
	 * Is this a legal fleet? Returns null when it is, or a sentence saying what
	 * is wrong — the placement UI shows that rather than silently refusing.
	 *
	 * Run on **both** sides. The placing player runs it to be told off; everyone
	 * else runs it at the reveal, because "the fleet you committed to was not a
	 * legal fleet" is its own kind of cheating and the digest alone would not
	 * catch it.
	 */
	function validateFleet(ships) {
		if (!Array.isArray(ships) || ships.length !== FLEET.length) {
			return `A fleet is ${FLEET.length} ships.`;
		}
		const ids = new Set(ships.map((s) => s.id));
		if (ids.size !== FLEET.length || FLEET.some((s) => !ids.has(s.id))) {
			return "That is not the right set of ships.";
		}
		const taken = new Set();
		for (const ship of ships) {
			if (ship.dir !== "h" && ship.dir !== "v") return "A ship lies across or down.";
			const cells = cellsOf(ship);
			for (const [r, c] of cells) {
				if (!inBounds(r, c)) return "A ship hangs off the edge.";
				if (taken.has(key(r, c))) return "Two ships overlap.";
				taken.add(key(r, c));
			}
		}
		return null;
	}

	/** A legal fleet, placed at random. Used by the bot and by RANDOMISE. */
	function randomFleet(rng = Math.random) {
		for (let attempt = 0; attempt < 500; attempt++) {
			const ships = [];
			const taken = new Set();
			let ok = true;
			for (const spec of FLEET) {
				let placed = null;
				for (let tries = 0; tries < 200 && !placed; tries++) {
					const dir = rng() < 0.5 ? "h" : "v";
					const r = Math.floor(rng() * (dir === "v" ? SIZE - spec.len + 1 : SIZE));
					const c = Math.floor(rng() * (dir === "h" ? SIZE - spec.len + 1 : SIZE));
					const candidate = { id: spec.id, r, c, dir };
					const cells = cellsOf(candidate);
					if (cells.some(([cr, cc]) => taken.has(key(cr, cc)))) continue;
					placed = candidate;
					for (const [cr, cc] of cells) taken.add(key(cr, cc));
				}
				if (!placed) {
					ok = false;
					break;
				}
				ships.push(placed);
			}
			if (ok && !validateFleet(ships)) return ships;
		}
		throw new Error("randomFleet: could not place a fleet");
	}

	/** Which ship, if any, sits on a square. */
	function shipAt(ships, r, c) {
		return ships.find((ship) => cellsOf(ship).some(([sr, sc]) => sr === r && sc === c)) ?? null;
	}

	/**
	 * The honest answer to one shot, given a fleet and every square already hit.
	 * `hits` is a Set of "r,c" and is *not* mutated — the caller decides whether
	 * the shot counts.
	 */
	function answerShot(ships, hits, r, c) {
		const ship = shipAt(ships, r, c);
		if (!ship) return { hit: false, sunk: null };
		const after = new Set(hits);
		after.add(key(r, c));
		const sunk = cellsOf(ship).every(([sr, sc]) => after.has(key(sr, sc)));
		return { hit: true, sunk: sunk ? ship.id : null };
	}

	const fleetSunk = (hits) => hits.size >= FLEET_CELLS;

	/**
	 * Re-run every answer a player gave against the fleet they finally revealed.
	 *
	 * This is what the commitment is *for*. A digest only proves the fleet was
	 * decided before the shooting started; it says nothing about whether the
	 * answers matched it. Both checks together are what make an unrefereed game
	 * honest, and either alone is theatre.
	 *
	 * Returns null when the player played straight, or the first inconsistency.
	 */
	function auditAnswers(ships, answers) {
		const bad = validateFleet(ships);
		if (bad) return `the revealed fleet is not legal: ${bad}`;
		const hits = new Set();
		for (const a of answers) {
			const [r, c] = a.at;
			if (!inBounds(r, c)) return `a shot at ${r},${c} is off the board`;
			const truth = answerShot(ships, hits, r, c);
			if (truth.hit !== !!a.hit) {
				return `${r},${c} was answered ${a.hit ? "hit" : "miss"} but the fleet says ${truth.hit ? "hit" : "miss"}`;
			}
			if ((truth.sunk ?? null) !== (a.sunk ?? null)) {
				return `${r},${c} was answered ${a.sunk ? `sinking ${a.sunk}` : "no sinking"} but the fleet disagrees`;
			}
			if (truth.hit) hits.add(key(r, c));
		}
		return null;
	}

	// ---------------------------------------------------------------- the bot
	//
	// Hunt and target, which is the standard and is genuinely most of what a
	// good human player does. Two states, no search:
	//
	//   target  a ship has been hit and not yet sunk — work outwards from the
	//           hits, and once two hits line up, only along that line
	//   hunt    nothing outstanding — shoot a parity lattice, because the
	//           smallest ship is two long and cannot hide between the squares

	function botTarget(shots, rng = Math.random) {
		const fired = new Set(shots.map((s) => key(s.at[0], s.at[1])));
		const free = (r, c) => inBounds(r, c) && !fired.has(key(r, c));

		// Hits that belong to a ship nobody has sunk yet.
		const sunkIds = new Set(shots.filter((s) => s.sunk).map((s) => s.sunk));
		const liveHits = [];
		{
			// A sinking answer accounts for that ship's hits, so walk the shots in
			// order and drop the ones a later sinking explained.
			const hitsInOrder = shots.filter((s) => s.hit);
			let accountedFor = 0;
			for (const s of shots) {
				if (s.sunk) accountedFor += FLEET.find((f) => f.id === s.sunk)?.len ?? 0;
			}
			// Everything hit beyond what the sunk ships account for is still live.
			const outstanding = hitsInOrder.length - accountedFor;
			if (outstanding > 0) {
				// Which hits are live cannot be known exactly without the fleet, so
				// take the most recent ones — they are the ones being worked on.
				liveHits.push(...hitsInOrder.slice(-outstanding).map((s) => s.at));
			}
		}

		if (liveHits.length >= 2) {
			// Two or more hits: if they share a row or a column, extend that line
			// and nothing else. This is the difference between sinking a cruiser in
			// three more shots and in nine.
			const rows = new Set(liveHits.map(([r]) => r));
			const cols = new Set(liveHits.map(([, c]) => c));
			if (rows.size === 1) {
				const r = liveHits[0][0];
				const cs = liveHits.map(([, c]) => c).sort((a, b) => a - b);
				const ends = [[r, cs[0] - 1], [r, cs[cs.length - 1] + 1]].filter(([rr, cc]) => free(rr, cc));
				if (ends.length) return ends[Math.floor(rng() * ends.length)];
			} else if (cols.size === 1) {
				const c = liveHits[0][1];
				const rs = liveHits.map(([r]) => r).sort((a, b) => a - b);
				const ends = [[rs[0] - 1, c], [rs[rs.length - 1] + 1, c]].filter(([rr, cc]) => free(rr, cc));
				if (ends.length) return ends[Math.floor(rng() * ends.length)];
			}
		}

		if (liveHits.length) {
			const around = [];
			for (const [r, c] of liveHits) {
				for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
					if (free(r + dr, c + dc)) around.push([r + dr, c + dc]);
				}
			}
			if (around.length) return around[Math.floor(rng() * around.length)];
		}

		// Hunt. The parity lattice halves the squares worth trying: a two-long
		// ship must cover one of them wherever it lies.
		const lattice = [];
		const rest = [];
		for (let r = 0; r < SIZE; r++) {
			for (let c = 0; c < SIZE; c++) {
				if (!free(r, c)) continue;
				((r + c) % 2 === 0 ? lattice : rest).push([r, c]);
			}
		}
		const pool = lattice.length ? lattice : rest;
		if (!pool.length) return null;
		return pool[Math.floor(rng() * pool.length)];
	}

	NeonArcade.battleshipRules = {
		SIZE, FLEET, FLEET_CELLS, inBounds, key, cellsOf, validateFleet,
		randomFleet, shipAt, answerShot, fleetSunk, auditAnswers, botTarget,
	};
})();

NeonArcade.registerGame({
	id: "battleship",
	name: "BATTLESHIP",
	blurb: "Commit your fleet, then both fire at once. Liars are caught at the reveal.",
	shape: "teams",
	seats: { min: 2, max: 2 },

	mount(ctx) {
		const { room } = ctx;
		const {
			SIZE, FLEET, FLEET_CELLS, inBounds, key, cellsOf, validateFleet,
			randomFleet, shipAt, answerShot, fleetSunk, auditAnswers, botTarget,
		} = NeonArcade.battleshipRules;

		const secrets = NeonArcade.makeSecrets(room, {
			onError: (e) => setNotice(e.reason),
		});

		// ------------------------------------------------------------- markup

		const shell = NeonArcade.gameShell(ctx.root, {
			css: `
				/* Width is set by layout() rather than here: the two grids share a
				   phone's height with a ship rack and two rows of buttons, and only
				   JS knows how much is left. Without an explicit width a CSS grid in
				   a centred flex column collapses to a single cell — which is exactly
				   what it did. */
				.bs-grid { display: grid; grid-template-columns: repeat(${SIZE}, 1fr);
					gap: 2px; background: #1a1a33; padding: 2px; border-radius: 6px;
					border: 2px solid #2a2a4e; touch-action: manipulation; }
				.bs-cell { aspect-ratio: 1; background: #0d0d1f; border: none; padding: 0;
					border-radius: 2px; color: var(--muted); font-size: 0.7rem; line-height: 1;
					display: flex; align-items: center; justify-content: center;
					touch-action: manipulation; cursor: pointer; }
				.bs-cell:disabled { cursor: default; }
				.bs-cell.ship { background: #2b4a6b; }
				.bs-cell.ghost { background: #1d3550; }
				.bs-cell.bad { background: #4a1f28; }
				.bs-cell.miss { background: #14142c; color: #4a4a6a; }
				.bs-cell.hit { background: #c62b2b; }
				.bs-cell.sunk { background: #6b1414; }
				.bs-cell.aim { outline: 2px solid var(--accent); outline-offset: -2px; }
				.bs-label { font-size: 0.62rem; letter-spacing: 0.16em; color: var(--muted);
					margin-bottom: 2px; }
				.bs-panel { display: flex; flex-direction: column; align-items: center; width: 100%; }
				.bs-ships { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; }
				.bs-ship { background: var(--panel); border: 2px solid var(--border);
					border-radius: 6px; padding: 6px 9px; font-size: 0.62rem; letter-spacing: 0.1em;
					color: var(--muted); min-height: 44px; cursor: pointer; }
				.bs-ship.sel { border-color: var(--accent); color: var(--accent); }
				.bs-ship.done { opacity: 0.45; }
				.bs-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
				.bs-actions .neon-btn { padding: 10px 16px; font-size: 14px;
					/* Narrower than the default button so three fit on one row of a
					   390px screen — but not shorter. Trimming the padding alone took
					   these to 36px, under the tap minimum. */
					min-height: 44px; }
				.bs-notice { font-size: 0.68rem; color: #ff9f45; min-height: 1.2em; text-align: center; }
				.bs-verdict { font-size: 0.66rem; color: var(--muted); text-align: center;
					max-width: 34ch; }
			`,
		});

		const fill = document.createElement("div");
		fill.className = "g-fill";
		const notice = document.createElement("div");
		notice.className = "bs-notice";

		const theirPanel = document.createElement("div");
		theirPanel.className = "bs-panel";
		const theirLabel = document.createElement("div");
		theirLabel.className = "bs-label";
		const theirGrid = document.createElement("div");
		theirGrid.className = "bs-grid";
		theirPanel.append(theirLabel, theirGrid);

		const myPanel = document.createElement("div");
		myPanel.className = "bs-panel";
		const myLabel = document.createElement("div");
		myLabel.className = "bs-label";
		const myGrid = document.createElement("div");
		myGrid.className = "bs-grid";
		myPanel.append(myLabel, myGrid);

		const ships = document.createElement("div");
		ships.className = "bs-ships";
		const actions = document.createElement("div");
		actions.className = "bs-actions";
		const verdict = document.createElement("div");
		verdict.className = "bs-verdict";

		fill.append(notice, theirPanel, myPanel, ships, actions, verdict);
		shell.stage.append(fill);

		const cellsFor = (grid) => {
			const out = [];
			for (let r = 0; r < SIZE; r++) {
				for (let c = 0; c < SIZE; c++) {
					const b = document.createElement("button");
					b.type = "button";
					b.className = "bs-cell";
					b.dataset.r = r;
					b.dataset.c = c;
					// "D4" reads better than "row 3 column 4" to anyone who has played
					// the game on paper, and it is what the labels on the grid say.
					b.setAttribute("aria-label", `${String.fromCharCode(65 + c)}${r + 1}`);
					grid.append(b);
					out.push(b);
				}
			}
			return out;
		};
		const theirCells = cellsFor(theirGrid);
		const myCells = cellsFor(myGrid);

		// -------------------------------------------------------------- state

		let phase = "waiting"; // waiting | place | fire | resolve | over
		let seats = [null, null]; // [A, B] — memberId
		let myFleet = [];
		let myCommit = null; // { digest, nonce, value }
		let digests = {}; // playerId -> digest
		let boards = {}; // playerId -> [{ at, hit, sunk }] — shots fired AT them
		let reveals = {}; // playerId -> { fleet, nonce }
		let audits = {}; // playerId -> null (clean) | string (what was wrong)
		let over = null; // { winner, reason }
		let placing = FLEET[0].id;
		let dir = "h";
		let hover = null;
		let aim = null;
		let submittedFire = false;
		let noticeText = "";
		let botFleets = {}; // botId -> { fleet, commit } — held by the host that plays them
		let disposed = false;
		let autoCommitTimer = null;

		const mySeat = () => seats.indexOf(room.selfId);
		const opponentOf = (id) => seats.find((s) => s && s !== id) ?? null;
		const opponent = () => opponentOf(room.selfId);
		const isSpectator = () => mySeat() < 0;

		const shotsAt = (id) => boards[id] ?? [];
		const hitsOn = (id) => shotsAt(id).filter((s) => s.hit).length;
		const isDown = (id) => hitsOn(id) >= FLEET_CELLS;

		const setNotice = (text) => {
			noticeText = text ?? "";
			notice.textContent = noticeText;
		};

		// ------------------------------------------------------------ the wire

		const stateAction = room.makeAction("bsState");
		const commitAction = room.makeAction("bsCommit");
		const shotsAction = room.makeAction("bsShots");
		const reportAction = room.makeAction("bsReport");
		const revealAction = room.makeAction("bsReveal");

		// -------------------------------------------------------------- phases
		//
		// Two schedulers, which is what `makeRounds`'s `name` is for. Placement is
		// one collecting phase that ends the moment both fleets are committed;
		// the battle is many, each of which ends the moment both players have
		// picked a square. Neither ever waits on a turn order.

		const setup = NeonArcade.makeRounds(ctx, {
			name: "bsSetup",
			rounds: 1,
			phases: [{ name: "place", ms: 150_000, collect: true }],
			botSubmit: (botId) => botFleets[botId]?.commit.digest,
			onPhase: () => {
				phase = "place";
				render();
			},
			onCollect: ({ entries }) => {
				// Host side. Everyone who committed in time is in `entries`; a seat
				// that is not there never deployed, and the game cannot start.
				const missing = ctx.players().filter((id) => !entries.has(id));
				if (missing.length) {
					finish(null, `${missing.map(ctx.nameOf).join(" and ")} never deployed a fleet.`);
					return;
				}
				digests = Object.fromEntries(entries);
				pushState();
				battle.start();
			},
			onTick: () => phase === "place" && renderHud(),
		});

		const battle = NeonArcade.makeRounds(ctx, {
			name: "bsFire",
			rounds: SIZE * SIZE,
			phases: [
				{ name: "fire", ms: 60_000, collect: true },
				// Long enough to read the splash, short enough that clearing a fleet
				// is a minute rather than three: a full game is ~35 volleys.
				{ name: "resolve", ms: 900 },
			],
			botSubmit: (botId) => {
				const target = opponentOf(botId);
				return target ? botTarget(shotsAt(target)) : null;
			},
			onPhase: (info) => {
				phase = info.phase;
				if (info.phase === "fire") {
					submittedFire = false;
					aim = null;
				}
				render();
			},
			onTick: () => renderHud(),
			onCollect: ({ entries }) => {
				// Host side. Publish both shots together — that is what makes the
				// round simultaneous rather than a race — and then everybody answers
				// for their own board.
				const volley = [];
				for (const [by, at] of entries) {
					if (!at) continue;
					const target = opponentOf(by);
					if (!target) continue;
					volley.push({ by, target, at });
				}
				shotsAction.send(volley);
				applyVolley(volley);
			},
		});

		/**
		 * Answer the shot aimed at our own board — and nothing else.
		 *
		 * Every player is the sole authority on their own water, because they are
		 * the only one holding the fleet. That is only safe because the answer is
		 * checked against a commitment afterwards; without the audit this is just
		 * an honour system.
		 */
		function applyVolley(volley) {
			for (const shot of volley) {
				const iAnswer = shot.target === room.selfId
					|| (ctx.isHost && ctx.isBot(shot.target));
				if (!iAnswer) continue;
				const fleet = shot.target === room.selfId ? myFleet : botFleets[shot.target]?.fleet;
				if (!fleet) continue;
				const hits = new Set(shotsAt(shot.target).filter((s) => s.hit).map((s) => key(s.at[0], s.at[1])));
				const truth = answerShot(fleet, hits, shot.at[0], shot.at[1]);
				reportAction.send({ target: shot.target, at: shot.at, hit: truth.hit, sunk: truth.sunk });
				recordReport({ target: shot.target, at: shot.at, hit: truth.hit, sunk: truth.sunk });
			}
			render();
		}

		function recordReport(rep) {
			const list = (boards[rep.target] ??= []);
			// Ordered channels, but a report can still arrive twice if a peer
			// re-sends; the board is a history and a duplicate would corrupt the
			// hit count the sinking test depends on.
			if (list.some((s) => s.at[0] === rep.at[0] && s.at[1] === rep.at[1])) return;
			list.push({ at: rep.at, hit: rep.hit, sunk: rep.sunk ?? null });
			if (ctx.isHost) checkForEnd();
		}

		function checkForEnd() {
			if (!ctx.isHost || over) return;
			const down = ctx.players().filter(isDown);
			if (!down.length) return;
			const alive = ctx.players().filter((id) => !isDown(id));
			finish(alive.length === 1 ? alive[0] : null,
				alive.length === 1 ? null : "Both fleets went down on the same volley.");
		}

		/** Host side. Stop the clocks and ask everyone to open their commitment. */
		function finish(winner, reason) {
			if (over) return;
			over = { winner, reason: reason ?? null };
			// Set the phase by hand. Disposing the schedulers is what stops the
			// clock, and a disposed scheduler fires no `onPhase` — so without this
			// the game sits in "fire" forever, telling the winner to pick a square
			// and leaving the enemy grid live.
			phase = "over";
			battle.dispose();
			setup.dispose();
			pushState();
			doReveal();
		}

		// ------------------------------------------------------- commit/reveal

		async function commitFleet(fleet) {
			myFleet = fleet;
			myCommit = await secrets.commit(fleet);
			return myCommit.digest;
		}

		function doReveal() {
			// Everybody opens at once. Nobody can wait to see the other fleet
			// first, because the digests were published before a shot was fired
			// and a late reveal proves nothing extra.
			if (myCommit) {
				const payload = { fleet: myCommit.value, nonce: myCommit.nonce };
				revealAction.send(payload);
				recordReveal(room.selfId, payload);
			}
			if (ctx.isHost) {
				for (const [botId, held] of Object.entries(botFleets)) {
					const payload = { fleet: held.commit.value, nonce: held.commit.nonce };
					revealAction.send({ ...payload, as: botId });
					recordReveal(botId, payload);
				}
			}
		}

		async function recordReveal(playerId, payload) {
			reveals[playerId] = payload;
			const digest = digests[playerId];
			const okDigest = digest
				? await secrets.verify({ digest, nonce: payload.nonce, value: payload.fleet })
				: false;
			audits[playerId] = !okDigest
				? "the fleet revealed is not the fleet committed to"
				: auditAnswers(payload.fleet, shotsAt(playerId));
			render();
		}

		// ----------------------------------------------------------- messages

		stateAction.onMessage = (msg, { peerId }) => {
			if (ctx.isHost || peerId !== room.hostId()) return;
			seats = msg.seats;
			digests = msg.digests ?? {};
			boards = msg.boards ?? {};
			over = msg.over ?? null;
			if (over) {
				phase = "over";
				battle.dispose();
				setup.dispose();
				doReveal();
			}
			render();
		};

		commitAction.onMessage = () => {};

		shotsAction.onMessage = (volley, { peerId }) => {
			if (ctx.isHost || peerId !== room.hostId()) return;
			applyVolley(volley);
		};

		reportAction.onMessage = (rep, { peerId }) => {
			// Only the owner of a board may answer for it. Without this check any
			// peer could call its opponent's ships sunk.
			const owner = rep.target;
			const allowed = peerId === owner || (peerId === room.hostId() && NeonArcade.isBotId(owner));
			if (!allowed) return;
			recordReport(rep);
			render();
		};

		revealAction.onMessage = (payload, { peerId }) => {
			const who = payload.as ?? peerId;
			if (payload.as && peerId !== room.hostId()) return;
			recordReveal(who, { fleet: payload.fleet, nonce: payload.nonce });
		};

		function pushState() {
			if (!ctx.isHost) return;
			stateAction.send({ seats, digests, boards, over });
		}

		// ----------------------------------------------------------- placement

		function placeAt(r, c) {
			const spec = FLEET.find((s) => s.id === placing);
			if (!spec) return;
			const candidate = { id: spec.id, r, c, dir };
			const rest = myFleet.filter((s) => s.id !== spec.id);
			const trial = [...rest, candidate];
			// Only complain about *this* ship: a half-placed fleet is not an
			// invalid fleet, it is an unfinished one.
			const cells = cellsOf(candidate);
			if (cells.some(([cr, cc]) => !inBounds(cr, cc))) return setNotice("That hangs off the edge.");
			const taken = new Set(rest.flatMap(cellsOf).map(([cr, cc]) => key(cr, cc)));
			if (cells.some(([cr, cc]) => taken.has(key(cr, cc)))) return setNotice("That overlaps another ship.");
			myFleet = trial;
			setNotice("");
			const next = FLEET.find((s) => !myFleet.some((p) => p.id === s.id));
			placing = next?.id ?? spec.id;
			render();
		}

		async function submitFleet(fleet) {
			const bad = validateFleet(fleet);
			if (bad) return setNotice(bad);
			clearTimeout(autoCommitTimer);
			setNotice("");
			const digest = await commitFleet(fleet);
			if (disposed) return;
			setup.submit(digest);
			render();
		}

		// -------------------------------------------------------------- render

		function paintTheirs() {
			const them = opponent();
			const history = them ? shotsAt(them) : [];
			const byCell = new Map(history.map((s) => [key(s.at[0], s.at[1]), s]));
			const sunkIds = new Set(history.filter((s) => s.sunk).map((s) => s.sunk));
			const revealed = them && reveals[them] ? reveals[them].fleet : null;

			for (const cell of theirCells) {
				const r = +cell.dataset.r;
				const c = +cell.dataset.c;
				const shot = byCell.get(key(r, c));
				let cls = "bs-cell";
				let text = "";
				if (shot?.hit) {
					const ship = revealed ? shipAt(revealed, r, c) : null;
					cls += ship && sunkIds.has(ship.id) ? " sunk" : " hit";
					text = "✕";
				} else if (shot) {
					cls += " miss";
					text = "·";
				} else if (revealed && shipAt(revealed, r, c)) {
					// Only after the reveal: this is where their ships actually were.
					cls += " ship";
				}
				if (aim && aim[0] === r && aim[1] === c) cls += " aim";
				cell.className = cls;
				cell.textContent = text;
				cell.disabled = phase !== "fire" || submittedFire || isSpectator() || !!shot;
			}
		}

		function paintMine() {
			const history = shotsAt(room.selfId);
			const shotMap = new Map(history.map((s) => [key(s.at[0], s.at[1]), s]));
			const ghost = phase === "place" && hover ? previewCells() : null;

			for (const cell of myCells) {
				const r = +cell.dataset.r;
				const c = +cell.dataset.c;
				const shot = shotMap.get(key(r, c));
				const mine = shipAt(myFleet, r, c);
				let cls = "bs-cell";
				let text = "";
				if (shot?.hit) {
					cls += " hit";
					text = "✕";
				} else if (shot) {
					cls += " miss";
					text = "·";
				} else if (mine) {
					cls += " ship";
				}
				if (ghost) {
					const on = ghost.cells.some(([gr, gc]) => gr === r && gc === c);
					if (on) cls += ghost.ok ? " ghost" : " bad";
				}
				cell.className = cls;
				cell.textContent = text;
				cell.disabled = phase !== "place";
			}
		}

		function previewCells() {
			const spec = FLEET.find((s) => s.id === placing);
			if (!spec || !hover) return null;
			const candidate = { id: spec.id, r: hover[0], c: hover[1], dir };
			const cells = cellsOf(candidate);
			const rest = myFleet.filter((s) => s.id !== spec.id);
			const taken = new Set(rest.flatMap(cellsOf).map(([r, c]) => key(r, c)));
			const ok = cells.every(([r, c]) => inBounds(r, c)) && !cells.some(([r, c]) => taken.has(key(r, c)));
			return { cells: cells.filter(([r, c]) => inBounds(r, c)), ok };
		}

		function renderControls() {
			ships.replaceChildren();
			actions.replaceChildren();
			verdict.textContent = "";

			if (phase === "place" && !isSpectator()) {
				const committed = !!myCommit;
				for (const spec of FLEET) {
					const placed = myFleet.some((s) => s.id === spec.id);
					const btn = document.createElement("button");
					btn.type = "button";
					btn.className = "bs-ship" + (placing === spec.id ? " sel" : "") + (placed ? "" : " done");
					btn.textContent = `${spec.name} ${spec.len}`;
					btn.disabled = committed;
					btn.addEventListener("click", () => {
						placing = spec.id;
						render();
					});
					ships.append(btn);
				}
				const add = (label, onClick, disabled = false) => {
					const b = document.createElement("button");
					b.type = "button";
					b.className = "neon-btn";
					b.textContent = label;
					b.disabled = disabled;
					b.addEventListener("click", onClick);
					actions.append(b);
					return b;
				};
				add(dir === "h" ? "ACROSS" : "DOWN", () => {
					dir = dir === "h" ? "v" : "h";
					render();
				}, committed);
				add("RANDOMISE", () => {
					myFleet = randomFleet();
					placing = FLEET[0].id;
					setNotice("");
					render();
				}, committed);
				add(committed ? "COMMITTED" : "COMMIT FLEET", () => submitFleet(myFleet),
					committed || myFleet.length !== FLEET.length);
				return;
			}

			if (phase === "over" || over) {
				const lines = [];
				for (const id of ctx.players()) {
					const a = audits[id];
					if (a === undefined) lines.push(`${ctx.nameOf(id)}: waiting for their reveal…`);
					else if (a === null) lines.push(`${ctx.nameOf(id)}: fleet verified ✓`);
					else lines.push(`${ctx.nameOf(id)}: CHEATED — ${a}`);
				}
				verdict.textContent = lines.join("  ·  ");
				if (ctx.isHost) {
					const b = document.createElement("button");
					b.type = "button";
					b.className = "neon-btn";
					b.textContent = "NEW GAME";
					b.addEventListener("click", () => newGame());
					actions.append(b);
				}
			}
		}

		function renderHud() {
			const parts = [];
			const them = opponent();
			if (phase === "place") {
				const left = setup.state().secondsLeft;
				parts.push(myCommit
					? { key: "s", text: "Fleet committed — waiting for them", className: "g-muted" }
					: { key: "s", text: "Place your fleet" });
				if (left > 0 && left < 100000) parts.push({ key: "t", text: `${left}s`, className: "g-muted" });
			} else if (phase === "fire") {
				parts.push(submittedFire
					? { key: "s", text: "Locked in — waiting for them", className: "g-muted" }
					: { key: "s", text: isSpectator() ? "Spectating" : "Pick a square" });
				const ready = battle.state().submitted.length;
				parts.push({ key: "n", text: `${ready}/2 ready`, className: "g-muted" });
			} else if (phase === "resolve") {
				parts.push({ key: "s", text: "Incoming…", className: "g-muted" });
			} else if (over) {
				const cheat = ctx.players().find((id) => audits[id]);
				if (cheat) parts.push({ key: "s", text: `${ctx.nameOf(cheat)} was caught cheating`, className: "g-warn" });
				else if (over.winner === room.selfId) parts.push({ key: "s", text: "You win" });
				else if (over.winner) parts.push({ key: "s", text: `${ctx.nameOf(over.winner)} wins` });
				else parts.push({ key: "s", text: over.reason ?? "Draw" });
			} else {
				parts.push({ key: "s", text: "Getting ready…", className: "g-muted" });
			}
			if (them && phase !== "place") {
				parts.push({ key: "h", text: `${hitsOn(them)}/${FLEET_CELLS} hit`, className: "g-muted" });
			}
			shell.setHud(parts);
		}

		/**
		 * Size the two boards. During placement there is only one and it gets
		 * everything; in battle the enemy's is the one being aimed at, so it takes
		 * the larger share and your own drops to a readable reminder.
		 */
		function layout() {
			const w = shell.stage.clientWidth;
			const availH = shell.stage.clientHeight - shell.hud.offsetHeight - 24;
			if (phase === "place") {
				const size = Math.max(200, Math.min(w * 0.96, availH - 160));
				myGrid.style.width = `${Math.floor(size)}px`;
			} else {
				const size = Math.max(180, Math.min(w * 0.96, (availH - 90) * 0.6));
				theirGrid.style.width = `${Math.floor(size)}px`;
				myGrid.style.width = `${Math.floor(Math.min(w * 0.62, size * 0.66))}px`;
			}
		}

		function render() {
			const them = opponent();
			theirLabel.textContent = them ? `${ctx.nameOf(them).toUpperCase()}'S WATERS` : "THEIR WATERS";
			myLabel.textContent = "YOUR WATERS";
			// During placement the enemy grid is nothing but noise, and the board
			// you are working on needs every pixel a phone has.
			theirPanel.hidden = phase === "place";
			paintTheirs();
			paintMine();
			renderControls();
			renderHud();
			layout();
		}

		// -------------------------------------------------------------- input

		theirGrid.addEventListener("click", (ev) => {
			const cell = ev.target.closest(".bs-cell");
			if (!cell || cell.disabled) return;
			const at = [+cell.dataset.r, +cell.dataset.c];
			aim = at;
			submittedFire = true;
			battle.submit(at);
			render();
		});

		myGrid.addEventListener("click", (ev) => {
			const cell = ev.target.closest(".bs-cell");
			if (!cell || phase !== "place" || myCommit) return;
			placeAt(+cell.dataset.r, +cell.dataset.c);
		});

		myGrid.addEventListener("pointermove", (ev) => {
			if (phase !== "place" || myCommit) return;
			const cell = ev.target.closest(".bs-cell");
			const next = cell ? [+cell.dataset.r, +cell.dataset.c] : null;
			if (JSON.stringify(next) === JSON.stringify(hover)) return;
			hover = next;
			paintMine();
		});
		myGrid.addEventListener("pointerleave", () => {
			hover = null;
			paintMine();
		});

		// --------------------------------------------------------------- start

		async function newGame() {
			if (!ctx.isHost) return;
			seats = [ctx.seats("A")[0] ?? null, ctx.seats("B")[0] ?? null];
			digests = {};
			boards = {};
			reveals = {};
			audits = {};
			over = null;
			// A fleet already laid out, not an empty grid: COMMIT works immediately
			// and rearranging is the option rather than the obligation.
			myFleet = randomFleet();
			myCommit = null;
			placing = FLEET[0].id;
			setNotice("");

			// Bot fleets are made and committed here, before the phase opens,
			// because `botSubmit` is synchronous and a commitment is not.
			botFleets = {};
			for (const id of ctx.players()) {
				if (!ctx.isBot(id)) continue;
				const fleet = randomFleet();
				botFleets[id] = { fleet, commit: await secrets.commit(fleet) };
			}
			if (disposed) return;
			pushState();
			setup.start();
			render();
		}

		/**
		 * Commit whatever is on the board — filling in anything unplaced — a few
		 * seconds before the deadline.
		 *
		 * The alternative is a game that cannot start because somebody put their
		 * phone down. It happens on the player's own device, so the fleet still
		 * never leaves it.
		 */
		function armAutoCommit() {
			clearTimeout(autoCommitTimer);
			autoCommitTimer = setTimeout(() => {
				if (disposed || myCommit || phase !== "place" || isSpectator()) return;
				const filled = [...myFleet];
				if (validateFleet(filled)) {
					const spare = randomFleet();
					for (const spec of FLEET) {
						if (!filled.some((s) => s.id === spec.id)) {
							filled.length = 0;
							filled.push(...spare);
							break;
						}
					}
				}
				setNotice("Out of time — your fleet was committed as it stood.");
				submitFleet(filled.length ? filled : randomFleet());
			}, 142_000);
		}

		(async () => {
			await secrets.ready();
			if (disposed) return;
			if (secrets.privacy() !== "sealed") {
				// A commitment needs a hash. Without WebCrypto there is no honest
				// game to play here, and pretending otherwise is worse than saying so.
				setNotice("This browser cannot make a sealed commitment, so Battleship cannot be played honestly here.");
				return;
			}
			seats = [ctx.seats("A")[0] ?? null, ctx.seats("B")[0] ?? null];
			myFleet = randomFleet();
			armAutoCommit();
			render();
			if (ctx.isHost) newGame();
		})();

		const onResize = () => layout();
		window.addEventListener("resize", onResize);
		window.addEventListener("orientationchange", onResize);

		return {
			onPeerJoin() {
				if (!ctx.isHost) return;
				seats = [ctx.seats("A")[0] ?? null, ctx.seats("B")[0] ?? null];
				pushState();
				setup.sync();
				battle.sync();
				render();
			},
			onPeerLeave() {
				if (!ctx.isHost) return;
				const left = seats.filter(Boolean).filter((id) => !ctx.players().includes(id));
				if (left.length && !over) finish(opponentOf(left[0]), `${ctx.nameOf(left[0])} left.`);
			},
			debug: () => ({
				phase,
				seats: [...seats],
				committed: !!myCommit,
				digests: Object.keys(digests).length,
				myFleetCells: myFleet.flatMap(cellsOf).length,
				hitsOnMe: hitsOn(room.selfId),
				shotsAtMe: shotsAt(room.selfId).length,
				theirBoard: opponent() ? shotsAt(opponent()).map((s) => ({ ...s })) : [],
				shotsAtThem: opponent() ? shotsAt(opponent()).length : 0,
				hitsOnThem: opponent() ? hitsOn(opponent()) : 0,
				over: over ? { ...over } : null,
				audits: { ...audits },
				fleetsRevealed: Object.keys(reveals).length,
			}),
			unmount() {
				disposed = true;
				clearTimeout(autoCommitTimer);
				window.removeEventListener("resize", onResize);
				window.removeEventListener("orientationchange", onResize);
				setup.dispose();
				battle.dispose();
				secrets.dispose();
				for (const a of [stateAction, commitAction, shotsAction, reportAction, revealAction]) {
					a.onMessage = null;
				}
				shell.destroy();
			},
		};
	},
});
