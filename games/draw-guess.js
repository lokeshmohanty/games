// games/draw-guess.js — Draw & Guess as a mountable module.
//
// Free-for-all: everyone on a team takes turns drawing while the rest guess,
// and the host referees the clock and the scoring. Party spectators are left
// out of the drawing rotation but still see the board and the chat.
//
// Extracted from the standalone page; the game logic is unchanged apart from
// reading its roster through the party (so spectators are excluded) and
// tearing itself down in unmount().

NeonArcade.registerGame({
	id: "draw-guess",
	name: "DRAW & GUESS",
	blurb: "Take turns drawing while everyone races to guess the word.",
	shape: "free",
	seats: { min: 2, max: 8 },
	// No bots. A bot that draws would be replaying a canned doodle, and a bot
	// that guesses would be reading the word it was already told — neither is an
	// opponent, and both make the round worse for the people actually playing.
	// This game is the one that still needs a second person.
	bots: false,

	mount(ctx) {
		const { root } = ctx;

		const style = document.createElement("style");
		style.textContent = `
      #game {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        /* Top padding clears the fixed "all games" pill; the canvas is flex:1
           so it simply takes the remaining height. */
        padding: 52px 8px 8px;
        gap: 8px;
        box-sizing: border-box;
      }
      #hud {
        display: flex;
        flex-wrap: wrap;
        gap: 8px 16px;
        align-items: center;
        justify-content: space-between;
        font-size: 0.85rem;
        min-height: 2.5em;
      }
      #hud .info {
        color: var(--accent);
        text-shadow: 0 0 6px var(--accent-glow);
      }
      #hud .scores {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
      }
      #hud .score-pill {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 20px;
        padding: 2px 12px;
        font-size: 0.8rem;
      }
      #hud .score-pill.me {
        border-color: var(--accent);
        box-shadow: 0 0 8px var(--accent-glow);
      }
      #hud .timer {
        font-size: 1.1rem;
        font-weight: bold;
        color: var(--accent2);
        text-shadow: 0 0 8px rgba(255, 0, 255, 0.4);
      }
      #word-display {
        text-align: center;
        font-size: clamp(1.2rem, 4vw, 1.8rem);
        letter-spacing: 4px;
        color: var(--accent);
        text-shadow: 0 0 10px var(--accent-glow);
        min-height: 1.5em;
        font-weight: bold;
      }
      #canvas-wrap {
        flex: 1;
        display: flex;
        justify-content: center;
        align-items: center;
        min-height: 0;
      }
      #board {
        border: 2px solid var(--accent);
        border-radius: 8px;
        box-shadow: 0 0 20px var(--accent-glow);
        background: #111;
        touch-action: none;
        max-width: 100%;
        max-height: 100%;
      }
      #tools {
        display: flex;
        gap: 6px;
        align-items: center;
        justify-content: center;
        flex-wrap: wrap;
        min-height: 2em;
      }
      .swatch {
        width: 28px;
        height: 28px;
        border-radius: 50%;
        border: 2px solid transparent;
        cursor: pointer;
        transition: transform 0.1s;
      }
      .swatch.active {
        border-color: #fff;
        transform: scale(1.15);
      }
      .size-btn {
        width: 28px;
        height: 28px;
        border-radius: 50%;
        border: 2px solid var(--border);
        background: var(--panel);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .size-btn.active {
        border-color: var(--accent);
      }
      .size-btn .dot {
        border-radius: 50%;
        background: #fff;
      }
      #clear-btn {
        font-size: 0.75rem;
        padding: 6px 12px;
      }
      #chat-area {
        height: 120px;
        display: flex;
        flex-direction: column;
        border: 1px solid var(--border);
        border-radius: 8px;
        background: var(--panel);
        overflow: hidden;
      }
      #chat-log {
        flex: 1;
        overflow-y: auto;
        padding: 6px 10px;
        font-size: 0.85rem;
        line-height: 1.4;
      }
      #chat-log .line {
        margin: 2px 0;
        word-break: break-word;
      }
      #chat-log .line.correct {
        color: var(--good);
        font-weight: bold;
      }
      #chat-log .line.system {
        color: var(--accent2);
        font-style: italic;
      }
      #chat-log .line .name {
        color: var(--accent);
      }
      #chat-input-row {
        display: flex;
        gap: 6px;
        padding: 6px;
        border-top: 1px solid var(--border);
      }
      #chat-input {
        flex: 1;
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: 6px;
        color: #fff;
        padding: 8px 12px;
        font-size: 0.9rem;
        font-family: var(--font);
      }
      #chat-input:focus {
        outline: none;
        border-color: var(--accent);
      }
      #chat-input:disabled {
        opacity: 0.5;
      }
      #chat-send {
        padding: 8px 16px;
      }
    `;
		root.append(style);
		const frame = document.createElement("div");
		frame.innerHTML = `<div id="game" hidden>
      <div id="hud"></div>
      <div id="word-display"></div>
      <div id="canvas-wrap">
        <canvas id="board"></canvas>
      </div>
      <div id="tools"></div>
      <div id="chat-area">
        <div id="chat-log"></div>
        <div id="chat-input-row">
          <input
            id="chat-input"
            type="text"
            placeholder="Type your guess…"
            autocomplete="off"
            maxlength="60"
          />
          <button id="chat-send" class="neon-btn">SEND</button>
        </div>
      </div>
    </div>
    <div id="overlay" class="overlay" hidden></div>`;
		while (frame.firstChild) root.append(frame.firstChild);



		// ── Config ──────────────────────────────────────────────
		const WORDS = [
			"cat",
			"dog",
			"house",
			"tree",
			"sun",
			"moon",
			"star",
			"fish",
			"bird",
			"boat",
			"car",
			"bike",
			"flower",
			"cloud",
			"mountain",
			"river",
			"pizza",
			"cake",
			"apple",
			"banana",
			"hat",
			"shoe",
			"book",
			"phone",
			"key",
			"door",
			"chair",
			"table",
			"lamp",
			"guitar",
			"drum",
			"robot",
			"rocket",
			"ghost",
			"skull",
			"heart",
			"eye",
			"hand",
			"umbrella",
			"clock",
			"bridge",
			"castle",
		];
		const CANVAS_W = 600;
		const CANVAS_H = 400;
		const DRAW_TIME = 60; // seconds
		const REVEAL_TIME = 5; // seconds
		const ROUNDS_PER_PLAYER = 2; // each player draws this many times
		const PALETTE = ["#0ff", "#f0f", "#4dff4d", "#ffd24d", "#fff", "#ff4d4d"];
		const SIZES = [3, 6, 12];
		const SCORE_BASE = 100;
		const SCORE_TIME_BONUS = 2;
		const DRAWER_BONUS = 50;

		// ── DOM ──────────────────────────────────────────────────
		const lobbyEl = document.getElementById("lobby");
		const gameEl = document.getElementById("game");
		const hudEl = document.getElementById("hud");
		const wordEl = document.getElementById("word-display");
		const canvas = document.getElementById("board");
		const c2d = canvas.getContext("2d");
		const toolsEl = document.getElementById("tools");
		const chatLog = document.getElementById("chat-log");
		const chatInput = document.getElementById("chat-input");
		const chatSend = document.getElementById("chat-send");
		const overlayEl = document.getElementById("overlay");

		canvas.width = CANVAS_W;
		canvas.height = CANVAS_H;

		// ── State ────────────────────────────────────────────────
		let room = null;
		let scores = {}; // peerId -> number
		let names = {}; // peerId -> "Player N"
		let phase = "lobby"; // lobby | choosing | drawing | reveal | gameover
		let drawerId = null;
		let currentWord = "";
		let wordHint = "";
		let round = 0;
		let totalRounds = 0;
		let timeLeft = 0;
		let guessedIds = new Set();
		let myColor = "#0ff";
		let drawColor = PALETTE[0];
		let drawSize = SIZES[1];
		let drawing = false;
		let lastPt = null;
		// The round clock is `lib/rounds.js` now, not two hand-rolled timers.
		// `timeLeft` survives only as what the HUD prints; it is fed by the
		// scheduler's tick and is no longer broadcast, because every peer runs
		// the same scheduler and counts down for itself.
		let rounds = null;
		let strokeThrottle = 0;
		let pendingStrokes = [];

		// ── Helpers ──────────────────────────────────────────────
		function colorFor(id) {
			const PAL = [
				"#0ff",
				"#f0f",
				"#4dff4d",
				"#ffd24d",
				"#ff4d4d",
				"#a0f",
				"#ff8c00",
				"#00ffaa",
			];
			let h = 0;
			for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
			return PAL[h % PAL.length];
		}

		function assignNames() {
			const all = ctx.players().sort();
			totalRounds = all.length * ROUNDS_PER_PLAYER;
			all.forEach((id, i) => {
				names[id] = "Player " + (i + 1);
			});
		}

		function nameOf(id) {
			return names[id] || id.slice(0, 6);
		}

		function clearCanvas() {
			c2d.fillStyle = "#111";
			c2d.fillRect(0, 0, CANVAS_W, CANVAS_H);
		}

		function drawSegment(s) {
			c2d.strokeStyle = s.color;
			c2d.lineWidth = s.size;
			c2d.lineCap = "round";
			c2d.lineJoin = "round";
			c2d.shadowBlur = 6;
			c2d.shadowColor = s.color;
			c2d.beginPath();
			c2d.moveTo(s.x0, s.y0);
			c2d.lineTo(s.x1, s.y1);
			c2d.stroke();
			c2d.shadowBlur = 0;
		}

		function drawDot(x, y, color, size) {
			c2d.fillStyle = color;
			c2d.shadowBlur = 6;
			c2d.shadowColor = color;
			c2d.beginPath();
			c2d.arc(x, y, size / 2, 0, Math.PI * 2);
			c2d.fill();
			c2d.shadowBlur = 0;
		}

		function pointerPos(e) {
			const rect = canvas.getBoundingClientRect();
			const cx = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
			const cy = (e.touches ? e.touches[0].clientY : e.clientY) - rect.top;
			return {
				x: (cx / rect.width) * CANVAS_W,
				y: (cy / rect.height) * CANVAS_H,
			};
		}

		function flushStrokes() {
			if (pendingStrokes.length === 0) return;
			const action = room.makeAction("stroke");
			for (const s of pendingStrokes) action.send(s);
			pendingStrokes = [];
		}

		function setupDrawing() {
			const onDown = (e) => {
				if (phase !== "drawing" || drawerId !== room.selfId) return;
				e.preventDefault();
				drawing = true;
				lastPt = pointerPos(e);
				drawDot(lastPt.x, lastPt.y, drawColor, drawSize);
				pendingStrokes.push({
					x0: lastPt.x,
					y0: lastPt.y,
					x1: lastPt.x,
					y1: lastPt.y,
					color: drawColor,
					size: drawSize,
				});
			};
			const onMove = (e) => {
				if (!drawing) return;
				e.preventDefault();
				const pt = pointerPos(e);
				const seg = {
					x0: lastPt.x,
					y0: lastPt.y,
					x1: pt.x,
					y1: pt.y,
					color: drawColor,
					size: drawSize,
				};
				drawSegment(seg);
				pendingStrokes.push(seg);
				lastPt = pt;
				const now = performance.now();
				if (now - strokeThrottle > 33) {
					flushStrokes();
					strokeThrottle = now;
				}
			};
			const onUp = () => {
				if (!drawing) return;
				drawing = false;
				flushStrokes();
			};
			canvas.addEventListener("mousedown", onDown);
			canvas.addEventListener("mousemove", onMove);
			canvas.addEventListener("mouseup", onUp);
			canvas.addEventListener("mouseleave", onUp);
			canvas.addEventListener("touchstart", onDown, { passive: false });
			canvas.addEventListener("touchmove", onMove, { passive: false });
			canvas.addEventListener("touchend", onUp);
		}

		function setupTools() {
			toolsEl.replaceChildren();
			PALETTE.forEach((c) => {
				const sw = document.createElement("div");
				sw.className = "swatch" + (c === drawColor ? " active" : "");
				sw.style.background = c;
				sw.onclick = () => {
					drawColor = c;
					toolsEl
						.querySelectorAll(".swatch")
						.forEach((s) => s.classList.remove("active"));
					sw.classList.add("active");
				};
				toolsEl.append(sw);
			});
			const sep = document.createElement("span");
			sep.style.width = "1px";
			sep.style.height = "24px";
			sep.style.background = "var(--border)";
			toolsEl.append(sep);
			SIZES.forEach((s) => {
				const btn = document.createElement("div");
				btn.className = "size-btn" + (s === drawSize ? " active" : "");
				const dot = document.createElement("div");
				dot.className = "dot";
				dot.style.width = s + "px";
				dot.style.height = s + "px";
				btn.append(dot);
				btn.onclick = () => {
					drawSize = s;
					toolsEl
						.querySelectorAll(".size-btn")
						.forEach((b) => b.classList.remove("active"));
					btn.classList.add("active");
				};
				toolsEl.append(btn);
			});
			const sep2 = document.createElement("span");
			sep2.style.width = "1px";
			sep2.style.height = "24px";
			sep2.style.background = "var(--border)";
			toolsEl.append(sep2);
			const clearBtn = document.createElement("button");
			clearBtn.className = "neon-btn";
			clearBtn.id = "clear-btn";
			clearBtn.textContent = "CLEAR";
			clearBtn.onclick = () => {
				if (phase === "drawing" && drawerId === room.selfId) {
					clearCanvas();
					room.makeAction("clear").send({});
				}
			};
			toolsEl.append(clearBtn);
		}

		function updateHud() {
			hudEl.replaceChildren();
			const info = document.createElement("div");
			info.className = "info";
			if (phase === "gameover") {
				info.textContent = "GAME OVER";
			} else if (
				phase === "choosing" ||
				phase === "drawing" ||
				phase === "reveal"
			) {
				info.textContent = `Round ${Math.min(round + 1, totalRounds)} / ${totalRounds}`;
			} else {
				info.textContent = "";
			}
			const timerEl = document.createElement("div");
			timerEl.className = "timer";
			if (phase === "drawing" || phase === "reveal")
				timerEl.textContent = timeLeft + "s";
			const scoresEl = document.createElement("div");
			scoresEl.className = "scores";
			const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
			for (const [id, sc] of sorted) {
				const pill = document.createElement("div");
				pill.className = "score-pill" + (id === room.selfId ? " me" : "");
				pill.textContent = `${nameOf(id)}: ${sc}`;
				scoresEl.append(pill);
			}
			hudEl.append(info, timerEl, scoresEl);
		}

		function updateWordDisplay() {
			if (phase === "drawing" && drawerId === room.selfId) {
				wordEl.textContent = currentWord.toUpperCase();
				wordEl.style.color = "var(--good)";
				wordEl.style.textShadow = "0 0 10px rgba(77,255,77,0.5)";
			} else if (phase === "drawing") {
				wordEl.textContent = wordHint;
				wordEl.style.color = "var(--accent)";
				wordEl.style.textShadow = "0 0 10px var(--accent-glow)";
			} else if (phase === "reveal" || phase === "gameover") {
				wordEl.textContent = currentWord ? currentWord.toUpperCase() : "";
				wordEl.style.color = "var(--accent2)";
				wordEl.style.textShadow = "0 0 10px rgba(255,0,255,0.5)";
			} else {
				wordEl.textContent = "";
			}
		}

		function updateInputState() {
			const canGuess =
				phase === "drawing" &&
				drawerId !== room.selfId &&
				!guessedIds.has(room.selfId);
			chatInput.disabled = !canGuess;
			chatInput.placeholder = canGuess
				? "Type your guess…"
				: drawerId === room.selfId
					? "You are drawing!"
					: guessedIds.has(room.selfId)
						? "You guessed it! �"
						: "Waiting…";
			chatSend.disabled = !canGuess;
		}

		function addChatLine(name, text, kind) {
			const line = document.createElement("div");
			line.className = "line" + (kind ? " " + kind : "");
			if (kind === "correct") {
				line.textContent = `🎉 ${name} guessed it!`;
			} else if (kind === "system") {
				line.textContent = text;
			} else {
				const nameSpan = document.createElement("span");
				nameSpan.className = "name";
				nameSpan.textContent = name + ": ";
				line.append(nameSpan, document.createTextNode(text));
			}
			chatLog.append(line);
			chatLog.scrollTop = chatLog.scrollHeight;
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

		// ── Host logic ───────────────────────────────────────────
		function broadcastState() {
			if (!room.isHost()) return;
			// `phase`, `round` and the countdown are not in here any more: every
			// peer gets those from the round clock, which is the whole point of
			// having moved onto it.
			room.makeAction("state").send({
				drawerId,
				wordHint,
				totalRounds,
				scores,
				guessedIds: [...guessedIds],
			});
		}

		function pickDrawer() {
			const players = ctx.players().sort();
			if (players.length === 0) return null;
			return players[round % players.length];
		}

		/**
		 * Build the round clock.
		 *
		 * This game is where `lib/rounds.js` came from: it had a `phase` string, a
		 * chain of `setTimeout`s walking choosing → drawing → reveal, and a
		 * re-check inside every callback that the phase it woke up in was still
		 * the phase it was scheduled for. All of that is now one declaration, and
		 * the re-check is gone because a disposed scheduler fires nothing.
		 *
		 * Rebuilt rather than reset on a new game: `dispose()` is one-way, and the
		 * number of rounds depends on how many people are playing.
		 */
		function buildRounds() {
			rounds?.dispose();
			rounds = NeonArcade.makeRounds(ctx, {
				name: "dg",
				rounds: totalRounds,
				phases: [
					{ name: "choosing", ms: 2000 },
					{ name: "drawing", ms: DRAW_TIME * 1000 },
					{ name: "reveal", ms: REVEAL_TIME * 1000 },
				],
				onPhase: (info) => {
					phase = info.phase;
					round = info.round;
					timeLeft = info.secondsLeft;
					if (info.phase === "choosing") enterChoosing();
					else if (info.phase === "drawing") enterDrawing();
					else if (info.phase === "reveal") enterReveal();
					updateHud();
					updateWordDisplay();
					updateInputState();
				},
				onTick: (info) => {
					// Every peer counts its own seconds off the duration the host
					// sent, so the number in the corner no longer rides on a state
					// broadcast once a second.
					timeLeft = info.secondsLeft;
					updateHud();
				},
				onFinish: () => {
					phase = "gameover";
					endGame();
				},
			});
		}

		/** Host picks the word and the drawer; everyone else just repaints. */
		function enterChoosing() {
			guessedIds = new Set();
			if (!room.isHost()) return;
			currentWord = WORDS[Math.floor(Math.random() * WORDS.length)];
			drawerId = pickDrawer();
			wordHint = "_".repeat(currentWord.length);
			broadcastState();
			// The word goes to one person. Addressed, not sealed — see
			// lib/secrets.js — which is the honest level of protection for a
			// party game where the cost of a leak is a spoiled round.
			wordAction.send({ word: currentWord }, { target: drawerId });
		}

		function clearCanvasOnAll() {
			// The host clears its own canvas as well: an ordinary broadcast never
			// comes back to its sender.
			clearCanvas();
			room.makeAction("clear").send({});
		}

		function enterDrawing() {
			if (!room.isHost()) return;
			clearCanvasOnAll();
			broadcastState();
		}

		function enterReveal() {
			if (!room.isHost()) return;
			// The word becomes public at the reveal.
			wordAction.send({ word: currentWord });
			broadcastState();
		}

		function endGame() {
			broadcastState();
			updateHud();
			updateWordDisplay();
			if (room.isHost()) {
				showOverlay("GAME OVER", "PLAY AGAIN", restart, finalScoresText());
			} else {
				showOverlay("GAME OVER", null, null, finalScoresText());
				const p = document.createElement("p");
				p.textContent = "Waiting for host…";
				overlayEl.append(p, NeonArcade.hostNewGameButton());
			}
		}

		function finalScoresText() {
			const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
			if (sorted.length === 0) return "";
			const [winnerId, winnerScore] = sorted[0];
			return `${nameOf(winnerId)} wins with ${winnerScore} points!`;
		}

		function restart() {
			scores = {};
			round = 0;
			guessedIds = new Set();
			chatLog.replaceChildren();
			hideOverlay();
			buildRounds();
			rounds.start();
		}

		function handleGuess(text, peerId) {
			if (!room.isHost()) return;
			if (phase !== "drawing") return;
			if (peerId === drawerId) return;
			if (guessedIds.has(peerId)) return;
			const guess = text.trim().toLowerCase();
			if (!guess) return;
			if (guess === currentWord.toLowerCase()) {
				guessedIds.add(peerId);
				// Read off the clock rather than the HUD's copy of it: the tick
				// only lands five times a second, and the bonus should reflect the
				// moment the guess arrived.
				const bonus = (rounds?.state().secondsLeft ?? 0) * SCORE_TIME_BONUS;
				scores[peerId] = (scores[peerId] || 0) + SCORE_BASE + bonus;
				scores[drawerId] = (scores[drawerId] || 0) + DRAWER_BONUS;
				room
					.makeAction("chat")
					.send({ peerId, name: nameOf(peerId), text: "", correct: true });
				addChatLine(nameOf(peerId), "", "correct");
				broadcastState();
				updateHud();
				// all guessers done?
				const guessers = ctx.players().filter(
					(id) => id !== drawerId,
				);
				// Everybody got it, so the drawing phase is over now rather than
				// when its clock runs out. This is exactly what `rounds.next()`
				// was added for.
				if (guessedIds.size >= guessers.length) rounds?.next();
			} else {
				room
					.makeAction("chat")
					.send({ peerId, name: nameOf(peerId), text, correct: false });
				addChatLine(nameOf(peerId), text, "");
			}
		}

		// ── Networking ───────────────────────────────────────────
		// ─ Networking ───────────────────────────────────────────
		// What used to be mountLobby's onReady/onStart, run directly: by the time
		// a module is mounted the room exists and the game is already starting.
		room = ctx.room;
		myColor = colorFor(room.selfId);

		/** The party knows what people called themselves; prefer that to "Player N". */
		function applyPartyNames() {
			for (const m of room.getMembers()) if (m.name) names[m.id] = m.name;
		}

		assignNames();
		applyPartyNames();
		setupTools();
		setupDrawing();
		clearCanvas();

		const stateAction = room.makeAction("state");
		const wordAction = room.makeAction("word");
		const strokeAction = room.makeAction("stroke");
		const clearAction = room.makeAction("clear");
		const guessAction = room.makeAction("guess");
		const chatAction = room.makeAction("chat");

		stateAction.onMessage = (data) => {
			drawerId = data.drawerId;
			wordHint = data.wordHint;
			totalRounds = data.totalRounds;
			scores = data.scores || {};
			guessedIds = new Set(data.guessedIds || []);
			updateHud();
			updateWordDisplay();
			updateInputState();
		};

		wordAction.onMessage = (data) => {
			currentWord = data.word;
			updateWordDisplay();
		};

		strokeAction.onMessage = (data) => drawSegment(data);
		clearAction.onMessage = () => clearCanvas();
		guessAction.onMessage = (data, { peerId }) => handleGuess(data.text, peerId);

		chatAction.onMessage = (data) => {
			if (data.correct) addChatLine(data.name, "", "correct");
			else addChatLine(data.name, data.text, "");
		};

		const sendGuess = () => {
			const text = chatInput.value.trim();
			if (!text) return;
			chatInput.value = "";
			if (room.isHost()) handleGuess(text, room.selfId);
			else guessAction.send({ text }, { target: room.hostId() });
		};
		chatSend.onclick = sendGuess;
		const onChatKey = (e) => {
			if (e.key === "Enter") sendGuess();
		};
		chatInput.addEventListener("keydown", onChatKey);

		// Formerly onStart.
		gameEl.hidden = false;
		clearCanvas();
		buildRounds();
		if (room.isHost()) {
			scores = {};
			round = 0;
			guessedIds = new Set();
			chatLog.replaceChildren();
			rounds.start();
		}
		updateHud();
		updateWordDisplay();
		updateInputState();

		return {
			onPeerJoin(peerId) {
				if (room.isHost()) {
					assignNames();
					applyPartyNames();
					scores[peerId] = scores[peerId] || 0;
					broadcastState();
					if (
						(phase === "drawing" || phase === "reveal" || phase === "choosing") &&
						peerId === drawerId
					) {
						wordAction.send({ word: currentWord }, { target: peerId });
					}
					addChatLine("", `${nameOf(peerId)} joined`, "system");
				}
				assignNames();
				applyPartyNames();
				updateHud();
			},
			onPeerLeave(peerId) {
				if (room.isHost()) {
					assignNames();
					applyPartyNames();
					addChatLine("", `${nameOf(peerId)} left`, "system");
					// The drawer walked off. End the phase rather than let everyone
					// stare at a canvas nobody is drawing on.
					if (peerId === drawerId && phase === "drawing") rounds?.next();
					broadcastState();
				}
				updateHud();
			},
			onRoster() {
				assignNames();
				applyPartyNames();
				updateHud();
			},
			unmount() {
				// One line where there were four: the round clock owns every timer
				// this game had, and disposing it is what stops them broadcasting
				// into whatever game is mounted next.
				rounds?.dispose();
				chatInput.removeEventListener("keydown", onChatKey);
				for (const a of [
					stateAction,
					wordAction,
					strokeAction,
					clearAction,
					guessAction,
					chatAction,
				]) {
					a.onMessage = null;
				}
				root.replaceChildren();
			},
		};
	},
});
