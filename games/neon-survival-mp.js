// games/neon-survival-mp.js — Neon Survival co-op as a mountable module.
//
// Co-op: everyone on a team is in the same run, dodging the same hazards, and
// the host simulates the world and broadcasts it. Spectators watch without a
// ship of their own.
//
// This is also the solo game: `seats.min` is 1, so hosting alone and pressing
// nothing else gives you exactly the single-player run this arcade started
// with. Bots fill the other ships when you want company — the host steers them
// and publishes their positions with `room.emitAs`, so every other peer sees a
// bot ship arrive through the same `pos` messages a person's ship does.
//
// Extracted from the standalone page; the game logic is unchanged apart from
// reading its roster through the party (so spectators are excluded) and
// tearing itself down in unmount().

NeonArcade.registerGame({
	id: "neon-survival-mp",
	// Not "co-op" any more: with a minimum of one seat this is the whole game,
	// solo run included, and there is no other Neon Survival to distinguish it
	// from. The module id keeps the `-mp` suffix because it is in URLs and in
	// saved party state; renaming that would break links to buy nothing.
	name: "NEON SURVIVAL",
	blurb: "Dodge the swarm — alone, with bots, or with friends. Last ship flying keeps the run alive.",
	shape: "coop",
	seats: { min: 1, max: 8 },

	mount(ctx) {
		const { root } = ctx;

		const style = document.createElement("style");
		style.textContent = `
      #game {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
      }
      #ui {
        position: absolute;
        /* Clears the fixed "all games" pill in the top-left corner. */
        top: 58px;
        left: 12px;
        right: 12px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        pointer-events: none;
        z-index: 5;
        font-size: 0.9rem;
      }
      #ui .stat {
        background: rgba(0, 0, 0, 0.5);
        padding: 4px 12px;
        border-radius: 6px;
        border: 1px solid var(--border);
      }
      #score {
        color: var(--accent);
        font-weight: bold;
        text-shadow: 0 0 8px var(--accent-glow);
      }
      #alive {
        color: var(--good);
        text-shadow: 0 0 8px rgba(77, 255, 77, 0.4);
      }
      #me-color {
        width: 14px;
        height: 14px;
        border-radius: 50%;
        display: inline-block;
        vertical-align: middle;
        margin-left: 8px;
        box-shadow: 0 0 8px currentColor;
      }
      #gameCanvas {
        border: 2px solid var(--border);
        box-shadow: 0 0 20px rgba(0, 255, 255, 0.15);
        touch-action: none;
        max-width: 95vw;
        max-height: 80vh;
      }
      .ghost-msg {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        color: var(--muted);
        font-size: 1.5rem;
        text-align: center;
        pointer-events: none;
        z-index: 4;
        text-shadow: 0 0 10px rgba(255, 255, 255, 0.2);
      }
    `;
		root.append(style);
		const frame = document.createElement("div");
		frame.innerHTML = `<div id="game" hidden>
      <div id="ui">
        <div class="stat"><span id="score">Score: 0</span></div>
        <div class="stat"><span id="alive">Alive: 1</span></div>
        <div class="stat">You<span id="me-color"></span></div>
      </div>
      <canvas id="gameCanvas"></canvas>
    </div>
    <div id="overlay" class="overlay" hidden></div>`;
		while (frame.firstChild) root.append(frame.firstChild);

		// Window-level listeners have to come off again on unmount, or the next
		// game mounted into this page inherits this one's input handling.
		const windowListeners = [];
		const addWindowListener = (type, fn, opts) => {
			windowListeners.push([type, fn, opts]);
			window.addEventListener(type, fn, opts);
		};

		// scripts/preview.mjs steers this game by reading its live state from the
		// page, which worked when everything was a top-level binding in a classic
		// script. Inside a module those are closure variables, so publish live
		// views of them instead — and take them down again on unmount.
		const debugNames = ["player", "enemies", "gems", "gameActive", "peers", "botShips"];
		Object.defineProperties(window, {
			player: { configurable: true, get: () => player },
			enemies: { configurable: true, get: () => enemies },
			gems: { configurable: true, get: () => gems },
			gameActive: { configurable: true, get: () => gameActive },
			// scripts/test-bots.mjs reads these two: `peers` is what any player
			// sees of everyone else, and `botShips` is what the host is steering.
			peers: { configurable: true, get: () => peers },
			botShips: { configurable: true, get: () => botShips },
		});
		const releaseDebugGlobals = () => {
			for (const n of debugNames) delete window[n];
		};



		// ── Config ──────────────────────────────────────────────
		const PALETTE = [
			"#0ff",
			"#f0f",
			"#4dff4d",
			"#ffd24d",
			"#ff4d4d",
			"#a0f",
			"#ff8c00",
			"#00ffaa",
		];
		const POS_INTERVAL = 50; // ms — broadcast position every 50ms (~20Hz)
		const STATE_INTERVAL = 80; // ms — host broadcasts world state (~12Hz)
		const SPAWN_INTERVAL_INIT = 1000; // ms — initial enemy spawn rate
		const SPAWN_INTERVAL_MIN = 300; // ms — fastest spawn rate
		const MAX_GEMS = 3;
		const PLAYER_SIZE = 15;
		const ENEMY_SIZE = 8;
		const GEM_SIZE = 5;

		// Bot ships. A person moves by pointing, which is instantaneous and has no
		// speed limit at all; a bot has one, and that cap is the whole reason it
		// can die. At 4px a frame it outruns the early swarm and loses to the late
		// one, which is the same arc a person's run has.
		const BOT_SPEED = 4;
		const BOT_DANGER = 110; // px — how far ahead a bot notices an enemy
		const BOT_GREED = 0.55; // pull toward a gem, relative to fleeing

		// ── DOM ──────────────────────────────────────────────────
		const lobbyEl = document.getElementById("lobby");
		const gameEl = document.getElementById("game");
		const canvas = document.getElementById("gameCanvas");
		const c2d = canvas.getContext("2d");
		const scoreEl = document.getElementById("score");
		const aliveEl = document.getElementById("alive");
		const meColorEl = document.getElementById("me-color");
		const overlayEl = document.getElementById("overlay");

		// ── State ────────────────────────────────────────────────
		let room = null;
		let myColor = "#0ff";
		let player = { x: 0, y: 0, alive: true, id: null };
		let peers = {}; // peerId -> { x, y, color, alive }
		let enemies = []; // host-authoritative
		let gems = []; // host-authoritative
		let particles = [];
		let score = 0;
		let aliveCount = 1;
		let gameActive = false;
		let lastPosSend = 0;
		let lastStateSend = 0;
		let lastSpawn = 0;
		let spawnRate = SPAWN_INTERVAL_INIT;
		let ghostMsgEl = null;

		function colorFor(id) {
			let h = 0;
			for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
			return PALETTE[h % PALETTE.length];
		}

		function resize() {
			const w = Math.min(window.innerWidth - 24, 800);
			const h = Math.min(window.innerHeight - 100, 600);
			canvas.width = w;
			canvas.height = h;
			if (!gameActive) {
				player.x = canvas.width / 2;
				player.y = canvas.height / 2;
			}
		}
		addWindowListener("resize", resize);

		function handleInput(clientX, clientY) {
			if (!gameActive || !player.alive) return;
			const rect = canvas.getBoundingClientRect();
			player.x = clientX - rect.left;
			player.y = clientY - rect.top;
		}

		addWindowListener("mousemove", (e) =>
			handleInput(e.clientX, e.clientY),
		);
		addWindowListener(
			"touchstart",
			(e) => {
				if (!gameActive) return;
				handleInput(e.touches[0].clientX, e.touches[0].clientY);
				e.preventDefault();
			},
			{ passive: false },
		);
		addWindowListener(
			"touchmove",
			(e) => {
				if (!gameActive) return;
				handleInput(e.touches[0].clientX, e.touches[0].clientY);
				e.preventDefault();
			},
			{ passive: false },
		);

		// ── Game logic (host) ────────────────────────────────────
		function spawnEnemy() {
			const side = Math.floor(Math.random() * 4);
			let x, y;
			if (side === 0) {
				x = Math.random() * canvas.width;
				y = -20;
			} else if (side === 1) {
				x = canvas.width + 20;
				y = Math.random() * canvas.height;
			} else if (side === 2) {
				x = Math.random() * canvas.width;
				y = canvas.height + 20;
			} else {
				x = -20;
				y = Math.random() * canvas.height;
			}

			// Home toward nearest alive player
			const alivePlayers = [
				{ x: player.x, y: player.y },
				...Object.values(peers).filter((p) => p.alive),
			];
			if (alivePlayers.length === 0) return;
			const target =
				alivePlayers[Math.floor(Math.random() * alivePlayers.length)];
			const angle = Math.atan2(target.y - y, target.x - x);
			const speed = 1.5 + score / 15;
			enemies.push({
				x,
				y,
				vx: Math.cos(angle) * speed,
				vy: Math.sin(angle) * speed,
				size: ENEMY_SIZE,
			});
		}

		function spawnGem() {
			gems.push({
				x: Math.random() * (canvas.width - 20) + 10,
				y: Math.random() * (canvas.height - 20) + 10,
				size: GEM_SIZE,
			});
		}

		function createParticles(x, y, color) {
			for (let i = 0; i < 8; i++) {
				particles.push({
					x,
					y,
					vx: (Math.random() - 0.5) * 5,
					vy: (Math.random() - 0.5) * 5,
					life: 1,
					color,
				});
			}
		}

		// ── Bots (host only) ─────────────────────────────────────
		//
		// The host owns a ship per bot and steers it the way it steers nothing
		// else: everything about a person's ship arrives over the wire, while a
		// bot's is computed here and then published as if it had.

		let botShips = {}; // bot member id -> { x, y, alive, color }

		/** Match the ship list to the roster; new bots enter at a random edge. */
		function syncBotShips() {
			const seated = new Set(ctx.botSeats());
			for (const id of seated) {
				if (botShips[id]) continue;
				botShips[id] = {
					x: Math.random() * (canvas.width - 80) + 40,
					y: Math.random() * (canvas.height - 80) + 40,
					alive: true,
					color: colorFor(id),
				};
			}
			for (const id of Object.keys(botShips)) {
				if (!seated.has(id)) {
					delete botShips[id];
					delete peers[id];
				}
			}
		}

		/**
		 * One frame of bot movement: flee what is close, drift toward a gem when
		 * nothing is, and stay off the walls.
		 *
		 * Steering is a sum of vectors rather than a plan, which is what keeps it
		 * legible — and beatable. A bot cornered by two enemies from opposite
		 * sides will pick the average of the two escapes and die, exactly as a
		 * flustered person does.
		 */
		function steerBot(ship) {
			let dx = 0;
			let dy = 0;

			for (const e of enemies) {
				const ex = ship.x - e.x;
				const ey = ship.y - e.y;
				const d = Math.hypot(ex, ey);
				if (d > BOT_DANGER || d === 0) continue;
				// Inverse-square: the nearest threat dominates, so a bot commits to
				// one escape instead of dithering between several distant ones.
				const w = (BOT_DANGER / d) ** 2;
				dx += (ex / d) * w;
				dy += (ey / d) * w;
			}

			const threatened = Math.hypot(dx, dy) > 0.001;
			let nearestGem = null;
			let nearestD = Infinity;
			for (const g of gems) {
				const d = Math.hypot(g.x - ship.x, g.y - ship.y);
				if (d < nearestD) {
					nearestD = d;
					nearestGem = g;
				}
			}
			if (nearestGem && nearestD > 0) {
				const pull = threatened ? BOT_GREED : 1;
				dx += ((nearestGem.x - ship.x) / nearestD) * pull;
				dy += ((nearestGem.y - ship.y) / nearestD) * pull;
			}

			// Walls push back, so a bot fleeing outward does not pin itself in a
			// corner where there is nowhere left to dodge.
			const margin = 60;
			if (ship.x < margin) dx += (margin - ship.x) / margin;
			if (ship.x > canvas.width - margin) dx -= (ship.x - (canvas.width - margin)) / margin;
			if (ship.y < margin) dy += (margin - ship.y) / margin;
			if (ship.y > canvas.height - margin) dy -= (ship.y - (canvas.height - margin)) / margin;

			const len = Math.hypot(dx, dy);
			if (len > 0.001) {
				ship.x += (dx / len) * BOT_SPEED;
				ship.y += (dy / len) * BOT_SPEED;
			}
			ship.x = Math.max(PLAYER_SIZE, Math.min(canvas.width - PLAYER_SIZE, ship.x));
			ship.y = Math.max(PLAYER_SIZE, Math.min(canvas.height - PLAYER_SIZE, ship.y));
		}

		/** Host only. Move every bot, then resolve what it ran into. */
		function updateBots() {
			syncBotShips();
			for (const [id, ship] of Object.entries(botShips)) {
				if (!ship.alive) continue;
				steerBot(ship);

				for (const e of enemies) {
					if (Math.hypot(ship.x - e.x, ship.y - e.y) < PLAYER_SIZE / 2 + e.size) {
						ship.alive = false;
						createParticles(ship.x, ship.y, ship.color);
						// Through the same channel a person's death takes, so the
						// alive count and the game-over check need no special case.
						room.emitAs(id, "down", {});
						break;
					}
				}
				if (!ship.alive) continue;

				for (let i = gems.length - 1; i >= 0; i--) {
					const g = gems[i];
					if (Math.hypot(ship.x - g.x, ship.y - g.y) < PLAYER_SIZE / 2 + g.size) {
						createParticles(g.x, g.y, "#4dff4d");
						collectGem(i);
					}
				}
			}
		}

		/** Publish every bot ship on the same cadence as our own. */
		function broadcastBotPos() {
			for (const [id, ship] of Object.entries(botShips)) {
				room.emitAs(id, "pos", {
					x: ship.x,
					y: ship.y,
					color: ship.color,
					alive: ship.alive,
				});
			}
		}

		function updateHost(time) {
			updateBots();
			// Spawn enemies
			if (time - lastSpawn > spawnRate) {
				spawnEnemy();
				lastSpawn = time;
				spawnRate = Math.max(
					SPAWN_INTERVAL_MIN,
					SPAWN_INTERVAL_INIT - score * 10,
				);
			}
			// Random gems
			if (gems.length < MAX_GEMS && Math.random() < 0.02) spawnGem();

			// Move enemies
			for (const e of enemies) {
				e.x += e.vx;
				e.y += e.vy;
			}
			// Cull off-screen enemies (far gone)
			enemies = enemies.filter(
				(e) =>
					e.x > -100 &&
					e.x < canvas.width + 100 &&
					e.y > -100 &&
					e.y < canvas.height + 100,
			);
		}

		function checkCollisions() {
			if (!player.alive) return;
			// Enemy collision (local detection for own player)
			for (const e of enemies) {
				if (
					Math.hypot(player.x - e.x, player.y - e.y) <
					PLAYER_SIZE / 2 + e.size
				) {
					player.alive = false;
					createParticles(player.x, player.y, myColor);
					room.makeAction("down").send({}, { target: room.hostId() });
					showGhostMsg("You're down! Spectating…");
					break;
				}
			}
			// Gem collision (local detection, host validates)
			for (let i = gems.length - 1; i >= 0; i--) {
				const g = gems[i];
				if (
					Math.hypot(player.x - g.x, player.y - g.y) <
					PLAYER_SIZE / 2 + g.size
				) {
					createParticles(g.x, g.y, "#4dff4d");
					if (room.isHost()) {
						collectGem(i);
					} else {
						room
							.makeAction("collect")
							.send({ x: g.x, y: g.y }, { target: room.hostId() });
					}
				}
			}
		}

		function collectGem(index) {
			// host-only: validate and remove
			if (index >= 0 && index < gems.length) {
				gems.splice(index, 1);
				score++;
				scoreEl.textContent = "Score: " + score;
				broadcastState();
			}
		}

		function findGemIndex(x, y) {
			return gems.findIndex((g) => Math.hypot(g.x - x, g.y - y) < 20);
		}

		// ── Networking ───────────────────────────────────────────
		function broadcastPos() {
			if (!room) return;
			room.makeAction("pos").send({
				x: player.x,
				y: player.y,
				color: myColor,
				alive: player.alive,
			});
		}

		function broadcastState() {
			if (!room || !room.isHost()) return;
			const alivePeers =
				(player.alive ? 1 : 0) +
				Object.values(peers).filter((p) => p.alive).length;
			aliveCount = alivePeers;
			aliveEl.textContent = "Alive: " + aliveCount;
			room.makeAction("state").send({
				enemies: enemies.map((e) => ({
					x: e.x,
					y: e.y,
					vx: e.vx,
					vy: e.vy,
					size: e.size,
				})),
				gems: gems.map((g) => ({ x: g.x, y: g.y, size: g.size })),
				score,
				aliveCount,
			});
		}

		function showGhostMsg(text) {
			if (ghostMsgEl) ghostMsgEl.remove();
			ghostMsgEl = document.createElement("div");
			ghostMsgEl.className = "ghost-msg";
			ghostMsgEl.textContent = text;
			gameEl.append(ghostMsgEl);
		}

		function removeGhostMsg() {
			if (ghostMsgEl) {
				ghostMsgEl.remove();
				ghostMsgEl = null;
			}
		}

		function showOverlay(title, btnText, btnCb, sub) {
			overlayEl.replaceChildren();
			const h1 = document.createElement("h1");
			h1.textContent = title;
			overlayEl.append(h1);
			if (sub) {
				const p = document.createElement("p");
				p.textContent = sub;
				overlayEl.append(p);
			}
			if (btnText) {
				const btn = document.createElement("button");
				btn.className = "neon-btn";
				btn.textContent = btnText;
				btn.onclick = btnCb;
				overlayEl.append(btn);
			}
			overlayEl.hidden = false;
		}

		function hideOverlay() {
			overlayEl.hidden = true;
		}

		function resetGame() {
			player = {
				x: canvas.width / 2,
				y: canvas.height / 2,
				alive: true,
				id: room ? room.selfId : null,
			};
			enemies = [];
			gems = [];
			particles = [];
			score = 0;
			aliveCount = ctx.players().length;
			spawnRate = SPAWN_INTERVAL_INIT;
			lastSpawn = 0;
			// A new run means new ships. Dropping them rather than reviving them
			// keeps one rule: a bot ship exists only while the roster says so.
			botShips = {};
			peers = Object.fromEntries(
				Object.entries(peers).filter(([id]) => !ctx.isBot(id)),
			);
			scoreEl.textContent = "Score: 0";
			aliveEl.textContent = "Alive: " + aliveCount;
			removeGhostMsg();
		}

		function startGame() {
			resetGame();
			gameActive = true;
			hideOverlay();
			if (room && room.isHost()) {
				// host initializes the world
				for (let i = 0; i < 2; i++) spawnGem();
				broadcastState();
			}
			requestAnimationFrame(loop);
		}

		function gameOver() {
			gameActive = false;
			if (room && room.isHost()) {
				showOverlay(
					"GAME OVER",
					"PLAY AGAIN",
					() => {
						room.makeAction("restart").send({});
						startGame();
					},
					"Final Score: " + score,
				);
			} else {
				showOverlay("GAME OVER", null, null, "Final Score: " + score);
				const p = document.createElement("p");
				p.textContent = "Waiting for host…";
				overlayEl.append(p, NeonArcade.hostNewGameButton());
			}
		}

		// ── Render ───────────────────────────────────────────────
		function draw() {
			// Motion trail fade
			c2d.fillStyle = "rgba(10, 10, 10, 0.3)";
			c2d.fillRect(0, 0, canvas.width, canvas.height);

			// Gems (host-authoritative state, but everyone renders from state)
			c2d.shadowBlur = 15;
			c2d.shadowColor = "#4dff4d";
			c2d.fillStyle = "#4dff4d";
			for (const g of gems) {
				c2d.beginPath();
				c2d.arc(g.x, g.y, g.size, 0, Math.PI * 2);
				c2d.fill();
			}

			// Enemies
			c2d.shadowColor = "#ff4d4d";
			c2d.fillStyle = "#ff4d4d";
			for (const e of enemies) {
				c2d.beginPath();
				c2d.arc(e.x, e.y, e.size, 0, Math.PI * 2);
				c2d.fill();
			}

			// Peers (interpolated)
			for (const [id, p] of Object.entries(peers)) {
				if (p.x == null) continue;
				const alpha = p.alive ? 1 : 0.3;
				c2d.globalAlpha = alpha;
				c2d.shadowBlur = 15;
				c2d.shadowColor = p.color;
				c2d.fillStyle = p.color;
				c2d.fillRect(
					p.x - PLAYER_SIZE / 2,
					p.y - PLAYER_SIZE / 2,
					PLAYER_SIZE,
					PLAYER_SIZE,
				);
				c2d.globalAlpha = 1;
			}

			// Self
			if (player.alive) {
				c2d.shadowBlur = 15;
				c2d.shadowColor = myColor;
				c2d.fillStyle = myColor;
				c2d.fillRect(
					player.x - PLAYER_SIZE / 2,
					player.y - PLAYER_SIZE / 2,
					PLAYER_SIZE,
					PLAYER_SIZE,
				);
			} else {
				// ghost: dim outline
				c2d.globalAlpha = 0.3;
				c2d.shadowBlur = 5;
				c2d.shadowColor = myColor;
				c2d.strokeStyle = myColor;
				c2d.lineWidth = 1;
				c2d.strokeRect(
					player.x - PLAYER_SIZE / 2,
					player.y - PLAYER_SIZE / 2,
					PLAYER_SIZE,
					PLAYER_SIZE,
				);
				c2d.globalAlpha = 1;
			}

			// Particles (cosmetic, client-side)
			for (const p of particles) {
				c2d.globalAlpha = p.life;
				c2d.fillStyle = p.color;
				c2d.fillRect(p.x, p.y, 2, 2);
			}
			c2d.globalAlpha = 1;
			c2d.shadowBlur = 0;
		}

		function updateParticles() {
			for (let i = particles.length - 1; i >= 0; i--) {
				const p = particles[i];
				p.x += p.vx;
				p.y += p.vy;
				p.life -= 0.02;
				if (p.life <= 0) particles.splice(i, 1);
			}
		}

		function interpolatePeers() {
			// Snap-render peers at their last-known position (no extrapolation).
			// Light smoothing could lerp toward target; keep simple for now.
		}

		// ── Main loop ────────────────────────────────────────────
		function loop(time) {
			if (!gameActive) return;

			if (room && room.isHost()) {
				updateHost(time);
			}
			checkCollisions();
			updateParticles();
			draw();

			// Broadcast position at ~20Hz
			if (time - lastPosSend > POS_INTERVAL) {
				broadcastPos();
				if (room && room.isHost()) broadcastBotPos();
				lastPosSend = time;
			}
			// Host broadcasts state at ~12Hz
			if (room && room.isHost() && time - lastStateSend > STATE_INTERVAL) {
				broadcastState();
				lastStateSend = time;
				if (aliveCount === 0) {
					room.makeAction("gameover").send({});
					gameOver();
				}
			}

			requestAnimationFrame(loop);
		}

		// ── Lobby + networking setup ─────────────────────────────
		// ─ Networking ───────────────────────────────────────────
		// Formerly mountLobby's onReady: the room is already live when a module
		// is mounted, so this runs immediately.
		room = ctx.room;
		myColor = colorFor(room.selfId);
		player.id = room.selfId;
		meColorEl.style.color = myColor;
		meColorEl.style.background = myColor;
		resize();

		const posAction = room.makeAction("pos");
		const stateAction = room.makeAction("state");
		const collectAction = room.makeAction("collect");
		const downAction = room.makeAction("down");
		const gameoverAction = room.makeAction("gameover");
		const restartAction = room.makeAction("restart");

		posAction.onMessage = (data, { peerId }) => {
			peers[peerId] = { ...data, id: peerId };
		};

		stateAction.onMessage = (data) => {
			if (room.isHost()) return; // host already has this state
			enemies = data.enemies || [];
			gems = data.gems || [];
			score = data.score;
			aliveCount = data.aliveCount;
			scoreEl.textContent = "Score: " + score;
			aliveEl.textContent = "Alive: " + aliveCount;
		};

		collectAction.onMessage = (data) => {
			if (!room.isHost()) return;
			const idx = findGemIndex(data.x, data.y);
			if (idx >= 0) collectGem(idx);
		};

		downAction.onMessage = (data, { peerId }) => {
			if (!room.isHost()) return;
			if (peers[peerId]) peers[peerId].alive = false;
			const alivePeers = Object.values(peers).filter((p) => p.alive).length;
			aliveCount = alivePeers + (player.alive ? 1 : 0);
			aliveEl.textContent = "Alive: " + aliveCount;
			broadcastState();
			if (aliveCount === 0) {
				gameoverAction.send({});
				gameOver();
			}
		};

		gameoverAction.onMessage = () => {
			if (!room.isHost()) gameOver();
		};

		restartAction.onMessage = () => startGame();

		/** Everyone on a team is in the run; spectators just watch. */
		const isPlaying = (id) => ctx.seatOf(id) !== null;

		// Formerly onStart.
		gameEl.hidden = false;
		resize();
		startGame();

		return {
			onPeerJoin(peerId) {
				if (!isPlaying(peerId)) return;
				peers[peerId] = {
					x: canvas.width / 2,
					y: canvas.height / 2,
					color: colorFor(peerId),
					alive: true,
				};
				aliveCount =
					(player.alive ? 1 : 0) + Object.values(peers).filter((p) => p.alive).length;
				aliveEl.textContent = "Alive: " + aliveCount;
				if (room.isHost() && gameActive) broadcastState();
			},
			onPeerLeave(peerId) {
				delete peers[peerId];
				aliveCount =
					(player.alive ? 1 : 0) + Object.values(peers).filter((p) => p.alive).length;
				aliveEl.textContent = "Alive: " + aliveCount;
				if (room.isHost()) {
					broadcastState();
					if (aliveCount === 0 && gameActive) {
						gameoverAction.send({});
						gameOver();
					}
				}
			},
			onRoster() {
				for (const id of Object.keys(peers)) if (!isPlaying(id)) delete peers[id];
			},
			unmount() {
				// The animation loop bails as soon as this is false, so clearing it
				// is what actually stops the game; the RAF id is never held anywhere.
				gameActive = false;
				for (const [type, fn, opts] of windowListeners) {
					window.removeEventListener(type, fn, opts);
				}
				for (const a of [
					posAction,
					stateAction,
					collectAction,
					downAction,
					gameoverAction,
					restartAction,
				]) {
					a.onMessage = null;
				}
				releaseDebugGlobals();
				root.replaceChildren();
			},
		};
	},
});
