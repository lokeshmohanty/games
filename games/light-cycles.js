// games/light-cycles.js — Light Cycles, as a mountable module.
//
// The casual counterweight to Onitama: one bit of input, no rules to read, and
// a round is over in under a minute. You ride, you leave a wall behind you, you
// do not touch a wall. Last one moving wins.
//
// ## Why this shape suits the transport
//
// It is a **grid on a fixed tick**, not a physics simulation, and that is the
// whole reason it can be an eight-player real-time game over a hand-made P2P
// mesh with no server. Per tick the host sends one head position per rider —
// a few dozen bytes — and every peer paints that cell into its own trail
// canvas. Nobody sends a trail; the trail is the accumulation of the heads.
// The data channels are ordered and reliable (`net.js` opens them that way), so
// a peer that paints every head it receives has, by construction, the same wall
// the host has.
//
// A latecomer has no history to accumulate, so it gets one full grid snapshot
// on arrival and streams from there.
//
// ## Steering
//
// You send the direction you want; the host refuses a reversal. Touch is
// relative — the left half of the screen turns you left, the right half turns
// you right — because that is one thumb and no aiming. Keyboard arrows are
// absolute, because on a keyboard that is what people press.

(() => {
	const COLS = 40;
	const ROWS = 40;
	// Clockwise, so turning right is +1 and turning left is +3 (mod 4).
	const ORDER = ["N", "E", "S", "W"];
	const STEP = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };

	// Eight riders, eight spawns, and two things had to be designed out of them.
	//
	// **They must not line up.** The first two are the two-player case; facing
	// each other down one row looks like the right picture and plays badly, with
	// both riders going straight into a head-on about a second in. Measured at
	// 23% of two-player rounds ending in a mutual crash before anyone steered.
	//
	// **They must not be exact opposites.** Rotating one spawn 180° about the
	// centre and getting another one is worse than it sounds: the two riders then
	// see mirror-image arenas, make mirror-image choices, and die on the same
	// tick. Offsetting the pair to `r: 14` and `r: 25` accidentally did exactly
	// that (14 + 25 = 39, and the grid is 0..39) and turned a 21-win run into 24
	// draws out of 30. `scripts/test-light-cycles.mjs` asserts no pair is a
	// mirror, because nothing about the numbers looks wrong.
	const SPAWNS = [
		{ c: 5, r: 14, d: "E" },
		{ c: 34, r: 24, d: "W" },
		{ c: 20, r: 5, d: "S" },
		{ c: 21, r: 34, d: "N" },
		{ c: 8, r: 8, d: "E" },
		{ c: 31, r: 30, d: "W" },
		{ c: 31, r: 8, d: "S" },
		{ c: 8, r: 30, d: "N" },
	];

	const COLORS = [
		"#00ffc8", "#ff4d6d", "#4da6ff", "#ffd24d",
		"#c77dff", "#7dff8a", "#ff9f45", "#ff6bd6",
	];

	const idx = (c, r) => r * COLS + c;
	const inBounds = (c, r) => c >= 0 && c < COLS && r >= 0 && r < ROWS;

	/**
	 * How much open space a rider can still reach from a cell.
	 *
	 * This is the only thing standing between a bot and driving into the nearest
	 * wall, and it is also the whole of its personality: preferring the roomier
	 * side is what makes it cut opponents off and fill its own half instead of
	 * wandering.
	 *
	 * The cap is the whole arena rather than a small number, and that is not an
	 * oversight. Capping it at 220 cells made every option on an open board come
	 * back saturated at 220, so the comparison carried no information and the bot
	 * silently degraded into "go straight unless that kills me" — it beat exactly
	 * that opponent 18 times in 30. Uncapped it is ~1600 cell visits per rider per
	 * tick, which at ten ticks a second is nothing.
	 */
	function openSpace(grid, c, r, cap = COLS * ROWS) {
		if (!inBounds(c, r) || grid[idx(c, r)]) return 0;
		const seen = new Uint8Array(COLS * ROWS);
		const queue = [idx(c, r)];
		seen[idx(c, r)] = 1;
		let count = 0;
		while (queue.length && count < cap) {
			const at = queue.pop();
			count++;
			const cc = at % COLS;
			const rr = (at - cc) / COLS;
			for (const [dc, dr] of Object.values(STEP)) {
				const nc = cc + dc;
				const nr = rr + dr;
				if (!inBounds(nc, nr)) continue;
				const ni = idx(nc, nr);
				if (seen[ni] || grid[ni]) continue;
				seen[ni] = 1;
				queue.push(ni);
			}
		}
		return count;
	}

	/** Free cells orthogonally adjacent to one cell. */
	function openNeighbours(grid, c, r) {
		let n = 0;
		for (const [dc, dr] of Object.values(STEP)) {
			if (inBounds(c + dc, r + dr) && !grid[idx(c + dc, r + dr)]) n++;
		}
		return n;
	}

	/**
	 * Breadth-first distance from a set of starting cells, ignoring whatever is
	 * painted on the starts themselves — the starts are heads, and a head always
	 * sits on its own wall.
	 *
	 * Returns -1 for anything unreachable.
	 */
	function distancesFrom(grid, sources) {
		const dist = new Int32Array(COLS * ROWS).fill(-1);
		let frontier = [];
		for (const at of sources) {
			if (dist[at] !== -1) continue;
			dist[at] = 0;
			frontier.push(at);
		}
		let d = 0;
		while (frontier.length) {
			d++;
			const next = [];
			for (const at of frontier) {
				const c = at % COLS;
				const r = (at - c) / COLS;
				for (const [dc, dr] of Object.values(STEP)) {
					const nc = c + dc;
					const nr = r + dr;
					if (!inBounds(nc, nr)) continue;
					const ni = idx(nc, nr);
					if (dist[ni] !== -1 || grid[ni]) continue;
					dist[ni] = d;
					next.push(ni);
				}
			}
			frontier = next;
		}
		return dist;
	}

	/**
	 * How much of the board this rider would own from a cell: every square it
	 * reaches before anybody else, minus every square they reach before it.
	 *
	 * This is the difference between a bot that has room and a bot that takes
	 * room. Space alone says "I am not about to die"; territory says "and you
	 * are not getting in here", which is how the game is actually won — you win
	 * by outlasting, and you outlast by owning more floor than the other rider.
	 */
	function territory(grid, myCell, enemyDist) {
		const mine = distancesFrom(grid, [myCell]);
		let score = 0;
		for (let i = 0; i < mine.length; i++) {
			const m = mine[i];
			const e = enemyDist ? enemyDist[i] : -1;
			if (m === -1) continue;
			if (e === -1 || m < e) score++;
			else if (e < m) score--;
		}
		return score;
	}

	/**
	 * The direction a bot wants next.
	 *
	 * Territory first, by a long way. Then — and this is what turns a bot that
	 * merely survives into one that wins — a preference for the *tighter* cell
	 * among options that score the same. Hugging a wall keeps the space you have
	 * not used yet in one piece; cutting across the middle of it saws your own
	 * territory in half, and you lose to whoever did not.
	 *
	 * `others` is every other living rider's head. With none — a solo practice
	 * round, or the last rider standing — this degrades to plain open space,
	 * which is the right answer when there is nobody to take anything from.
	 */
	function botDirection(grid, rider, others = []) {
		const i = ORDER.indexOf(rider.dir);
		const options = [
			{ dir: ORDER[i], bias: 1 }, // straight, barely preferred: it stops the jitter
			{ dir: ORDER[(i + 1) % 4], bias: 0 },
			{ dir: ORDER[(i + 3) % 4], bias: 0 },
		];
		// Computed once, not once per option: it does not depend on where we go.
		const enemyCells = others.filter((o) => o.alive !== false).map((o) => idx(o.c, o.r));
		const enemyDist = enemyCells.length ? distancesFrom(grid, enemyCells) : null;

		let best = null;
		for (const opt of options) {
			const [dc, dr] = STEP[opt.dir];
			const nc = rider.c + dc;
			const nr = rider.r + dr;
			if (!inBounds(nc, nr) || grid[idx(nc, nr)]) continue;
			const room = territory(grid, idx(nc, nr), enemyDist);
			const hug = 3 - openNeighbours(grid, nc, nr);
			// Territory dominates; hugging and the straight bias only separate
			// ties. A little noise on top, so two bots in similar positions do not
			// play out the identical game every round.
			const score = room * 100 + hug * 8 + opt.bias + Math.random() * 3;
			if (!best || score > best.score) best = { dir: opt.dir, score };
		}
		return best?.dir ?? rider.dir; // nothing survives: ride on and die facing forward
	}

	/**
	 * Move every living rider one cell and mark the crashes. Mutates `grid` and
	 * `riders`, and is the only place either changes during a race.
	 *
	 * Two passes, not one, because a head-on is not a collision with a wall:
	 * both riders enter the same empty cell in the same instant. Resolving them
	 * one at a time would paint the first rider's cell, then kill the second for
	 * hitting a wall that did not exist when it set off — the first rider
	 * surviving purely for being earlier in the array.
	 */
	function advance(grid, riders) {
		const targets = new Map();
		const next = riders.map((rider) => {
			if (!rider.alive) return null;
			const [dc, dr] = STEP[rider.dir];
			const c = rider.c + dc;
			const r = rider.r + dr;
			const dead = !inBounds(c, r) || grid[idx(c, r)] !== 0;
			if (!dead) targets.set(idx(c, r), (targets.get(idx(c, r)) ?? 0) + 1);
			return { c, r, dead };
		});

		for (let i = 0; i < riders.length; i++) {
			const rider = riders[i];
			if (!rider.alive) continue;
			const step = next[i];
			if (step.dead || targets.get(idx(step.c, step.r)) > 1) {
				rider.alive = false;
				continue;
			}
			rider.c = step.c;
			rider.r = step.r;
			grid[idx(step.c, step.r)] = i + 1;
		}
	}

	NeonArcade.lightCycleRules = { COLS, ROWS, ORDER, STEP, SPAWNS, COLORS, idx, inBounds, openSpace, openNeighbours, distancesFrom, territory, botDirection, advance };

	NeonArcade.registerGame({
		id: "light-cycles",
		name: "LIGHT CYCLES",
		blurb: "Ride, leave a wall, do not touch one. Last one moving wins.",
		shape: "free",
		seats: { min: 1, max: 8 },

		mount(ctx) {
			const { room } = ctx;

			const shell = NeonArcade.gameShell(ctx.root, {
				css: `
					.lc-arena { position: relative; }
					.lc-arena canvas { position: absolute; inset: 0; width: 100%; height: 100%;
						border-radius: 8px; }
					.lc-arena { border: 2px solid #2a2a4e; border-radius: 10px;
						box-shadow: 0 0 30px rgba(0, 255, 200, 0.15); touch-action: none; }
					.lc-zones { position: absolute; inset: 0; display: flex; }
					.lc-zone { flex: 1; display: flex; align-items: flex-end; justify-content: center;
						padding-bottom: 6px; color: rgba(255,255,255,0.16); font-size: 1.6rem;
						user-select: none; -webkit-user-select: none; }
					.lc-scores { display: flex; flex-wrap: wrap; gap: 4px 10px; justify-content: center;
						font-size: 0.72rem; letter-spacing: 0.06em; }
					.lc-scores span { white-space: nowrap; }
				`,
			});

			const fill = document.createElement("div");
			fill.className = "g-fill";
			const arena = document.createElement("div");
			arena.className = "lc-arena";
			const trailCanvas = document.createElement("canvas");
			const headCanvas = document.createElement("canvas");
			const zones = document.createElement("div");
			zones.className = "lc-zones";
			const leftZone = document.createElement("div");
			leftZone.className = "lc-zone";
			leftZone.textContent = "↰";
			const rightZone = document.createElement("div");
			rightZone.className = "lc-zone";
			rightZone.textContent = "↱";
			zones.append(leftZone, rightZone);
			arena.append(trailCanvas, headCanvas, zones);
			const scores = document.createElement("div");
			scores.className = "lc-scores";
			fill.append(arena, scores);
			shell.stage.append(fill);

			const trail2d = trailCanvas.getContext("2d");
			const head2d = headCanvas.getContext("2d");

			// ------------------------------------------------------------ state

			let riders = []; // { id, c, r, dir, alive, color, wins }
			let grid = new Uint8Array(COLS * ROWS);
			let racing = false;
			let winner = undefined; // undefined = no result yet, null = a draw
			let countdown = 0;
			let tickTimer = null;
			let countTimer = null;
			let tickMs = 100;
			let cellW = 8;
			let cellH = 8;
			let disposed = false;

			const me = () => riders.find((x) => x.id === room.selfId) ?? null;

			// ---------------------------------------------------------- drawing

			// How far a cell may be stretched from square before the arena is
			// letterboxed instead. A 40x40 grid drawn square on a 390x844 phone
			// leaves two thirds of the screen black; drawn to fill, the cells are
			// rectangles, which costs nothing because movement is on the grid and
			// not on the pixels. Past about this ratio it stops reading as an
			// arena and starts reading as a rendering bug.
			const MAX_STRETCH = 1.6;

			function layout() {
				const availW = shell.stage.clientWidth;
				const availH = shell.stage.clientHeight - shell.hud.offsetHeight - scores.offsetHeight - 30;
				let w = Math.max(160, availW);
				let h = Math.max(160, availH);
				if (w / h > MAX_STRETCH) w = h * MAX_STRETCH;
				if (h / w > MAX_STRETCH) h = w * MAX_STRETCH;
				cellW = Math.max(3, Math.floor(w / COLS));
				cellH = Math.max(3, Math.floor(h / ROWS));
				const pxW = cellW * COLS;
				const pxH = cellH * ROWS;
				const dpr = Math.min(window.devicePixelRatio || 1, 2);
				arena.style.width = pxW + "px";
				arena.style.height = pxH + "px";
				for (const [canvas, c2d] of [[trailCanvas, trail2d], [headCanvas, head2d]]) {
					canvas.width = pxW * dpr;
					canvas.height = pxH * dpr;
					c2d.setTransform(dpr, 0, 0, dpr, 0, 0);
				}
				repaintTrails();
				drawHeads();
			}

			/** Redraw every wall from the grid. Only on resize and on a snapshot. */
			function repaintTrails() {
				trail2d.clearRect(0, 0, cellW * COLS, cellH * ROWS);
				for (let r = 0; r < ROWS; r++) {
					for (let c = 0; c < COLS; c++) {
						const owner = grid[idx(c, r)];
						if (owner) paintCell(c, r, COLORS[(owner - 1) % COLORS.length]);
					}
				}
			}

			function paintCell(c, r, color) {
				trail2d.fillStyle = color;
				trail2d.globalAlpha = 0.85;
				trail2d.fillRect(c * cellW, r * cellH, cellW, cellH);
				trail2d.globalAlpha = 1;
			}

			function drawHeads() {
				head2d.clearRect(0, 0, cellW * COLS, cellH * ROWS);
				for (const rider of riders) {
					if (!rider.alive) continue;
					head2d.fillStyle = "#fff";
					head2d.shadowColor = rider.color;
					head2d.shadowBlur = Math.min(cellW, cellH) * 1.6;
					head2d.fillRect(rider.c * cellW, rider.r * cellH, cellW, cellH);
					head2d.shadowBlur = 0;
				}
			}

			function renderScores() {
				scores.replaceChildren(
					...riders.map((rider) => {
						const el = document.createElement("span");
						el.style.color = rider.color;
						el.style.opacity = rider.alive || !racing ? "1" : "0.4";
						el.textContent = `${ctx.nameOf(rider.id)} ${rider.wins}`;
						return el;
					}),
				);
			}

			function renderHud() {
				const mine = me();
				const parts = [];
				if (countdown > 0) {
					parts.push({ key: "s", text: countdown === 1 ? "GO" : `Starting in ${countdown - 1}…` });
				} else if (racing) {
					parts.push(
						mine?.alive
							? { key: "s", text: "Ride" }
							: { key: "s", text: mine ? "You crashed — watching" : "Spectating", className: "g-muted" },
					);
					parts.push({
						key: "n",
						text: `${riders.filter((r) => r.alive).length} still riding`,
						className: "g-muted",
					});
				} else if (winner !== undefined) {
					parts.push({
						key: "s",
						text: winner === null ? "Everyone crashed" : winner === room.selfId ? "You win" : `${ctx.nameOf(winner)} wins`,
					});
				} else {
					parts.push({ key: "s", text: "Getting ready…", className: "g-muted" });
				}
				shell.setHud(parts);
			}

			function render() {
				drawHeads();
				renderScores();
				renderHud();
			}

			// ------------------------------------------------------------ input

			/** Ask the host to face us a new way. It is free to refuse a reversal. */
			function steerTo(dir) {
				const mine = me();
				if (!racing || !mine?.alive) return;
				if (ORDER.indexOf(dir) === (ORDER.indexOf(mine.dir) + 2) % 4) return;
				if (ctx.isHost) applySteer(room.selfId, dir);
				else steerAction.send({ d: dir }, { target: room.hostId() });
			}

			function steerRelative(turn) {
				const mine = me();
				if (!mine) return;
				const i = ORDER.indexOf(mine.dir);
				steerTo(ORDER[(i + (turn === "left" ? 3 : 1)) % 4]);
			}

			const onZone = (turn) => (ev) => {
				ev.preventDefault();
				steerRelative(turn);
			};
			leftZone.addEventListener("pointerdown", onZone("left"));
			rightZone.addEventListener("pointerdown", onZone("right"));

			const onKey = (ev) => {
				const map = { ArrowUp: "N", ArrowRight: "E", ArrowDown: "S", ArrowLeft: "W" };
				if (map[ev.key]) {
					ev.preventDefault();
					steerTo(map[ev.key]);
				} else if (ev.key === "a" || ev.key === "A") steerRelative("left");
				else if (ev.key === "d" || ev.key === "D") steerRelative("right");
			};
			window.addEventListener("keydown", onKey);

			// ------------------------------------------------------- the wire

			const steerAction = room.makeAction("lcSteer");
			const tickAction = room.makeAction("lcTick");
			const roundAction = room.makeAction("lcRound");

			const roundPayload = () => ({
				riders: riders.map((r) => ({ id: r.id, c: r.c, r: r.r, dir: r.dir, alive: r.alive, wins: r.wins })),
				grid: Array.from(grid),
				countdown,
				racing,
				winner,
				tickMs,
			});

			function applySteer(playerId, dir) {
				const rider = riders.find((x) => x.id === playerId);
				if (!rider?.alive || !racing) return;
				// A reversal would drive straight into your own wall, which reads as
				// the game killing you for a mistap rather than for a decision.
				if (ORDER.indexOf(dir) === (ORDER.indexOf(rider.dir) + 2) % 4) return;
				rider.pending = dir;
			}

			steerAction.onMessage = (msg, { peerId }) => {
				if (ctx.isHost) applySteer(peerId, msg.d);
			};

			roundAction.onMessage = (msg, { peerId }) => {
				if (ctx.isHost || peerId !== room.hostId()) return;
				riders = msg.riders.map((r, i) => ({ ...r, color: COLORS[i % COLORS.length] }));
				grid = Uint8Array.from(msg.grid);
				countdown = msg.countdown;
				racing = msg.racing;
				winner = msg.winner;
				tickMs = msg.tickMs;
				repaintTrails();
				render();
				if (winner !== undefined && !racing) showResult();
				else shell.hideOverlay();
			};

			tickAction.onMessage = (msg, { peerId }) => {
				if (ctx.isHost || peerId !== room.hostId()) return;
				applyTick(msg);
			};

			/**
			 * Advance the local picture by one tick.
			 *
			 * The host runs this too, off its own payload, so there is exactly one
			 * implementation of "what a tick looks like" and the host cannot drift
			 * from the peers by rendering some other way.
			 */
			function applyTick(msg) {
				for (let i = 0; i < msg.p.length; i++) {
					const rider = riders[i];
					if (!rider) continue;
					const [c, r, d, alive] = msg.p[i];
					rider.dir = ORDER[d];
					if (alive) {
						rider.c = c;
						rider.r = r;
						grid[idx(c, r)] = i + 1;
						paintCell(c, r, rider.color);
					}
					rider.alive = !!alive;
				}
				drawHeads();
				renderHud();
				renderScores();
			}

			// ------------------------------------------------------- simulation

			function seat() {
				const players = ctx.players();
				riders = players.map((id, i) => ({
					id,
					...SPAWNS[i % SPAWNS.length],
					dir: SPAWNS[i % SPAWNS.length].d,
					alive: true,
					color: COLORS[i % COLORS.length],
					wins: riders.find((r) => r.id === id)?.wins ?? 0,
					pending: null,
				}));
			}

			function newRound() {
				if (!ctx.isHost) return;
				seat();
				grid = new Uint8Array(COLS * ROWS);
				for (let i = 0; i < riders.length; i++) grid[idx(riders[i].c, riders[i].r)] = i + 1;
				racing = false;
				winner = undefined;
				tickMs = 100;
				countdown = 4;
				repaintTrails();
				roundAction.send(roundPayload());
				render();
				shell.hideOverlay();

				clearInterval(countTimer);
				countTimer = setInterval(() => {
					if (disposed) return;
					countdown--;
					if (countdown <= 0) {
						clearInterval(countTimer);
						racing = true;
						roundAction.send(roundPayload());
						render();
						runTicks();
						return;
					}
					roundAction.send(roundPayload());
					render();
				}, 800);
			}

			function runTicks() {
				clearInterval(tickTimer);
				let ticks = 0;
				const schedule = () => {
					clearInterval(tickTimer);
					tickTimer = setInterval(() => {
						if (disposed) return;
						tick();
						ticks++;
						// A slow squeeze on the clock, so a cagey endgame between two
						// careful riders still ends.
						if (ticks % 120 === 0 && tickMs > 60) {
							tickMs -= 10;
							schedule();
						}
					}, tickMs);
				};
				schedule();
			}

			function tick() {
				if (!ctx.isHost || !racing) return;

				for (const rider of riders) {
					if (!rider.alive) continue;
					if (ctx.isBot(rider.id))
						rider.pending = botDirection(grid, rider, riders.filter((o) => o !== rider && o.alive));
					if (rider.pending) {
						rider.dir = rider.pending;
						rider.pending = null;
					}
				}

				advance(grid, riders);

				const payload = {
					p: riders.map((r) => [r.c, r.r, ORDER.indexOf(r.dir), r.alive ? 1 : 0]),
				};
				tickAction.send(payload);
				applyTick(payload);

				const alive = riders.filter((r) => r.alive);
				if (alive.length <= (riders.length > 1 ? 1 : 0)) endRound(alive[0]?.id ?? null);
			}

			function endRound(winnerId) {
				clearInterval(tickTimer);
				racing = false;
				winner = winnerId;
				const won = riders.find((r) => r.id === winnerId);
				if (won) won.wins++;
				roundAction.send(roundPayload());
				render();
				showResult();
			}

			function showResult() {
				const text =
					winner === null
						? "Everyone crashed"
						: winner === room.selfId
							? "You win"
							: `${ctx.nameOf(winner)} wins`;
				shell.showOverlay({
					title: text,
					lines: ctx.isHost ? [] : ["Waiting for the host to start the next round."],
					buttons: ctx.isHost ? [{ label: "NEXT ROUND", onClick: () => newRound() }] : [],
				});
			}

			// -------------------------------------------------------------- go

			const onResize = () => layout();
			window.addEventListener("resize", onResize);
			window.addEventListener("orientationchange", onResize);

			layout();
			render();
			if (ctx.isHost) newRound();

			return {
				onPeerJoin() {
					if (!ctx.isHost) return;
					// Mid-round arrivals watch this one out: dropping a rider into a
					// board that is already half wall is not a favour to them.
					roundAction.send(roundPayload());
				},
				onPeerLeave() {
					if (!ctx.isHost) return;
					const gone = riders.filter((r) => !ctx.players().includes(r.id));
					for (const rider of gone) rider.alive = false;
					if (racing) {
						const alive = riders.filter((r) => r.alive);
						if (alive.length <= 1) endRound(alive[0]?.id ?? null);
					}
				},
				debug: () => ({
					racing,
					countdown,
					winner,
					tickMs,
					riders: riders.map((r) => ({ id: r.id, c: r.c, r: r.r, dir: r.dir, alive: r.alive, wins: r.wins })),
					walls: grid.reduce((n, v) => n + (v ? 1 : 0), 0),
					mine: me()?.id ?? null,
				}),
				unmount() {
					disposed = true;
					clearInterval(tickTimer);
					clearInterval(countTimer);
					window.removeEventListener("resize", onResize);
					window.removeEventListener("orientationchange", onResize);
					window.removeEventListener("keydown", onKey);
					steerAction.onMessage = null;
					tickAction.onMessage = null;
					roundAction.onMessage = null;
					shell.destroy();
				},
			};
		},
	});
})();
