// games/tug-of-war.js — Tug of War as a mountable module.
//
// Written to exercise the parts of the game contract nothing else did:
//
//   - the first "teams" game with MORE than one player per side. Connect 4 only
//     ever reads seats("A")[0], so a team as a *group* was untested.
//   - the first game where a mid-game team change is meaningful rather than
//     cosmetic, which is what onRoster() is for.
//   - a host-authoritative simulation loop, so unmount() has to stop a
//     requestAnimationFrame and a broadcast interval, not just listeners.
//
// Everyone taps as fast as they can; each tap yanks the knot toward their side.
// A tap is worth more on a smaller team — impulse is divided by the team's size
// — so 1-against-4 is still a game, and a party never has to split evenly.

NeonArcade.registerGame({
	id: "tug-of-war",
	name: "TUG OF WAR",
	blurb: "Tap to pull. Two teams, any sizes — drag the knot past your line.",
	shape: "teams",
	seats: { min: 2, max: 8 },

	mount(ctx) {
		const { room, root } = ctx;

		// -- tuning ---------------------------------------------------------
		// Sized so an unopposed tapper needs ~5s to cross the line: fast enough to
		// feel responsive, long enough that an evenly matched pull is a stalemate
		// broken by out-tapping rather than by one lucky burst.
		const IMPULSE = 0.0012; // knot movement per tap, before team-size scaling
		const DAMPING = 0.9; // how fast a yank bleeds off
		const WIN_AT = 1; // |pos| that crosses a team's line
		const STATE_MS = 66; // host broadcast, ~15Hz
		const TAP_MIN_MS = 60; // ignore taps faster than a human can produce

		// -- markup ---------------------------------------------------------

		const style = document.createElement("style");
		style.textContent = `
			#tug {
				position: absolute;
				inset: 0;
				display: flex;
				flex-direction: column;
				/* Top padding clears the fixed "all games" pill. */
				padding: 52px 12px 12px;
				gap: 10px;
				box-sizing: border-box;
			}
			#tug-hud {
				display: flex;
				justify-content: space-between;
				align-items: center;
				gap: 12px;
				font-size: 0.85rem;
				min-height: 2.2em;
			}
			#tug-hud .side {
				display: flex;
				flex-direction: column;
				gap: 2px;
				max-width: 45%;
			}
			#tug-hud .side.b {
				text-align: right;
			}
			#tug-hud .team {
				letter-spacing: 2px;
				font-weight: bold;
			}
			#tug-hud .team.a {
				color: var(--accent);
				text-shadow: 0 0 8px var(--accent-glow);
			}
			#tug-hud .team.b {
				color: var(--accent2);
				text-shadow: 0 0 8px rgba(255, 0, 255, 0.4);
			}
			#tug-hud .roster {
				color: var(--muted);
				font-size: 0.75rem;
				word-break: break-word;
			}
			#tug-canvas {
				width: 100%;
				flex: 1;
				min-height: 0;
				border: 2px solid var(--border);
				border-radius: 10px;
				background: #0d0d16;
				touch-action: manipulation;
			}
			#tug-tap {
				font-family: var(--font);
				font-size: 1.1rem;
				letter-spacing: 3px;
				font-weight: bold;
				padding: 22px 12px;
				border-radius: 10px;
				border: 2px solid var(--accent);
				background: var(--panel);
				color: var(--accent);
				cursor: pointer;
				user-select: none;
				-webkit-tap-highlight-color: transparent;
				touch-action: manipulation;
			}
			#tug-tap:active:not(:disabled) {
				background: var(--accent);
				color: #000;
			}
			#tug-tap:disabled {
				border-color: var(--border);
				color: var(--muted);
				cursor: default;
			}
			#tug-overlay p {
				color: var(--muted);
				margin: 0;
			}
		`;

		const wrap = document.createElement("div");
		wrap.id = "tug";
		wrap.innerHTML = `
			<div id="tug-hud">
				<div class="side a">
					<span class="team a">TEAM A</span>
					<span class="roster" id="tug-roster-a"></span>
				</div>
				<div class="side b">
					<span class="team b">TEAM B</span>
					<span class="roster" id="tug-roster-b"></span>
				</div>
			</div>
			<canvas id="tug-canvas"></canvas>
			<button id="tug-tap" type="button">PULL!</button>
		`;
		const overlay = document.createElement("div");
		overlay.id = "tug-overlay";
		overlay.className = "overlay";
		overlay.hidden = true;
		root.append(style, wrap, overlay);

		const canvas = wrap.querySelector("#tug-canvas");
		const c2d = canvas.getContext("2d");
		const tapBtn = wrap.querySelector("#tug-tap");
		const rosterA = wrap.querySelector("#tug-roster-a");
		const rosterB = wrap.querySelector("#tug-roster-b");

		// -- state ----------------------------------------------------------

		// pos runs -1 (Team A has won) .. +1 (Team B has won).
		let state = { pos: 0, winner: null, pulls: { A: 0, B: 0 } };
		let vel = 0;
		let shown = 0; // rendered position, eased toward state.pos
		let flash = { A: 0, B: 0 }; // brief glow after a team pulls
		let lastTap = 0;
		let raf = null;
		let stateTimer = null;
		let running = true;

		const myTeam = () => ctx.seatOf(room.selfId); // "A" | "B" | null

		const pullAction = room.makeAction("tugPull");
		const stateAction = room.makeAction("tugState");

		function renderRosters() {
			const label = (team) =>
				ctx
					.seats(team)
					.map((id) => ctx.nameOf(id))
					.join(", ") || "nobody";
			rosterA.textContent = label("A");
			rosterB.textContent = label("B");
		}

		function updateTapButton() {
			const team = myTeam();
			tapBtn.disabled = !team || state.winner !== null;
			tapBtn.textContent = !team
				? "SPECTATING"
				: state.winner !== null
					? "ROUND OVER"
					: `PULL FOR TEAM ${team}!`;
		}

		// -- simulation (host) ----------------------------------------------

		/**
		 * A tap is worth more on a smaller team, so lopsided sides still play.
		 * An empty team would divide by zero, so it simply cannot pull.
		 */
		function applyPull(team) {
			const size = ctx.seats(team).length;
			if (!size || state.winner !== null) return;
			vel += (team === "A" ? -IMPULSE : IMPULSE) / size;
			state.pulls[team]++;
			flash[team] = 1;
		}

		function step() {
			if (room.isHost() && state.winner === null) {
				state.pos = Math.max(-1, Math.min(1, state.pos + vel));
				vel *= DAMPING;
				if (Math.abs(state.pos) >= WIN_AT) {
					state.winner = state.pos <= -WIN_AT ? "A" : "B";
					broadcast();
					finish();
				}
			}
			shown += (state.pos - shown) * 0.25;
			flash.A *= 0.88;
			flash.B *= 0.88;
			draw();
			if (running) raf = requestAnimationFrame(step);
		}

		// -- drawing ---------------------------------------------------------

		function resize() {
			const rect = canvas.getBoundingClientRect();
			const dpr = window.devicePixelRatio || 1;
			canvas.width = Math.max(1, Math.floor(rect.width * dpr));
			canvas.height = Math.max(1, Math.floor(rect.height * dpr));
			c2d.setTransform(dpr, 0, 0, dpr, 0, 0);
		}

		function draw() {
			const w = canvas.width / (window.devicePixelRatio || 1);
			const h = canvas.height / (window.devicePixelRatio || 1);
			c2d.clearRect(0, 0, w, h);

			const midY = h / 2;
			const zone = w * 0.14;

			// Goal zones: cross into one and that team has won.
			c2d.fillStyle = `rgba(0, 255, 255, ${0.08 + flash.A * 0.18})`;
			c2d.fillRect(0, 0, zone, h);
			c2d.fillStyle = `rgba(255, 0, 255, ${0.08 + flash.B * 0.18})`;
			c2d.fillRect(w - zone, 0, zone, h);

			c2d.strokeStyle = "#333";
			c2d.lineWidth = 2;
			c2d.beginPath();
			c2d.moveTo(zone, 0);
			c2d.lineTo(zone, h);
			c2d.moveTo(w - zone, 0);
			c2d.lineTo(w - zone, h);
			c2d.stroke();

			// Each side's letter, large and faint down its goal zone. The board is
			// otherwise a lot of empty dark, and at a glance you should be able to
			// tell which end is yours without reading the HUD.
			c2d.save();
			c2d.font = `bold ${Math.min(zone * 1.1, h * 0.4)}px ${getComputedStyle(document.body).fontFamily}`;
			c2d.textAlign = "center";
			c2d.textBaseline = "middle";
			c2d.fillStyle = `rgba(0, 255, 255, ${0.16 + flash.A * 0.3})`;
			c2d.fillText("A", zone / 2, h / 2);
			c2d.fillStyle = `rgba(255, 0, 255, ${0.16 + flash.B * 0.3})`;
			c2d.fillText("B", w - zone / 2, h / 2);
			c2d.restore();

			// Centre line, so the knot's drift is readable at a glance.
			c2d.strokeStyle = "#2a2a3e";
			c2d.setLineDash([6, 8]);
			c2d.beginPath();
			c2d.moveTo(w / 2, 0);
			c2d.lineTo(w / 2, h);
			c2d.stroke();
			c2d.setLineDash([]);

			const knotX = w / 2 + shown * (w / 2 - zone);

			// Rope.
			c2d.strokeStyle = "#6b5a3a";
			c2d.lineWidth = 6;
			c2d.beginPath();
			c2d.moveTo(0, midY);
			c2d.lineTo(w, midY);
			c2d.stroke();

			// Knot, tinted toward whichever side is winning.
			const lead = shown < 0 ? "#0ff" : shown > 0 ? "#f0f" : "#fff";
			c2d.shadowBlur = 20;
			c2d.shadowColor = lead;
			c2d.fillStyle = lead;
			c2d.beginPath();
			c2d.arc(knotX, midY, 16, 0, Math.PI * 2);
			c2d.fill();
			c2d.shadowBlur = 0;

			// Pull counts, parked above the rope on each side.
			c2d.font = "bold 13px " + getComputedStyle(document.body).fontFamily;
			c2d.textBaseline = "middle";
			c2d.fillStyle = "#0ff";
			c2d.textAlign = "left";
			c2d.fillText(`${state.pulls.A} pulls`, 10, midY - 34);
			c2d.fillStyle = "#f0f";
			c2d.textAlign = "right";
			c2d.fillText(`${state.pulls.B} pulls`, w - 10, midY - 34);
		}

		// -- networking ------------------------------------------------------

		function broadcast(target) {
			if (room.isHost()) stateAction.send(state, target ? { target } : undefined);
		}

		pullAction.onMessage = (_data, { peerId }) => {
			if (!room.isHost()) return;
			const team = ctx.seatOf(peerId);
			if (team === "A" || team === "B") applyPull(team);
		};

		stateAction.onMessage = (data) => {
			if (room.isHost()) return; // the host already holds the truth
			const hadWinner = state.winner;
			// Flash whichever team's count moved, so a guest sees pulls land too.
			for (const team of ["A", "B"]) {
				if (data.pulls[team] > state.pulls[team]) flash[team] = 1;
			}
			state = data;
			updateTapButton();
			if (state.winner && !hadWinner) finish();
			if (!state.winner && hadWinner) hideOverlay();
		};

		// -- input -------------------------------------------------------------

		function pull() {
			const team = myTeam();
			if (!team || state.winner !== null) return;
			const now = performance.now();
			if (now - lastTap < TAP_MIN_MS) return;
			lastTap = now;
			if (room.isHost()) applyPull(team);
			else pullAction.send({}, { target: room.hostId() });
		}

		const onTap = (e) => {
			e.preventDefault();
			pull();
		};
		const onKey = (e) => {
			if (e.code === "Space" || e.code === "Enter") {
				e.preventDefault();
				pull();
			}
		};

		tapBtn.addEventListener("pointerdown", onTap);
		// The canvas is the biggest target on a phone, so it pulls as well.
		canvas.addEventListener("pointerdown", onTap);
		window.addEventListener("keydown", onKey);
		window.addEventListener("resize", resize);

		// -- round flow --------------------------------------------------------

		function showOverlay(msg, btnText, btnCb) {
			overlay.replaceChildren();
			const h1 = document.createElement("h1");
			h1.textContent = msg;
			overlay.append(h1);
			if (btnText) {
				const btn = document.createElement("button");
				btn.className = "neon-btn";
				btn.textContent = btnText;
				btn.onclick = btnCb;
				overlay.append(btn);
			} else {
				const p = document.createElement("p");
				p.textContent = "Waiting for the host…";
				overlay.append(p);
			}
			overlay.hidden = false;
		}

		const hideOverlay = () => (overlay.hidden = true);

		function finish() {
			updateTapButton();
			const mine = myTeam();
			const msg = !mine
				? `TEAM ${state.winner} WINS`
				: state.winner === mine
					? "YOUR TEAM WINS!"
					: "YOUR TEAM LOSES";
			showOverlay(msg, room.isHost() ? "REMATCH" : null, restart);
		}

		function restart() {
			state = { pos: 0, winner: null, pulls: { A: 0, B: 0 } };
			vel = 0;
			shown = 0;
			hideOverlay();
			updateTapButton();
			broadcast();
		}

		// -- boot ---------------------------------------------------------------

		renderRosters();
		updateTapButton();
		resize();
		if (room.isHost()) {
			broadcast();
			stateTimer = setInterval(() => broadcast(), STATE_MS);
		}
		raf = requestAnimationFrame(step);

		return {
			onPeerJoin(peerId) {
				renderRosters();
				// Bring the newcomer straight to the current round.
				if (room.isHost()) broadcast(peerId);
			},
			onPeerLeave() {
				renderRosters();
			},
			/** Teams moved in the party screen — sides and impulse both change. */
			onRoster() {
				renderRosters();
				updateTapButton();
			},
			unmount() {
				// A simulation loop and a broadcast interval both outlive the DOM
				// unless they are stopped here, and would then fight — and network
				// with — whatever game is mounted next.
				running = false;
				cancelAnimationFrame(raf);
				clearInterval(stateTimer);
				tapBtn.removeEventListener("pointerdown", onTap);
				canvas.removeEventListener("pointerdown", onTap);
				window.removeEventListener("keydown", onKey);
				window.removeEventListener("resize", resize);
				pullAction.onMessage = null;
				stateAction.onMessage = null;
				root.replaceChildren();
			},
		};
	},
});
