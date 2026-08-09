// lib/lobby.js — reusable neon-styled lobby: room-code entry, live peer
// roster, and a host-gated Start button. Mounts into a container element and
// yields a connected room once the player joins.
//
// Flow:
//   1. Player enters (or auto-gets) a room code and hits JOIN.
//   2. A P2P room is created; peers appear in the roster as they connect.
//   3. The host sees a START GAME button; others see "Waiting for host…".
//   4. On start, the lobby hides itself and calls onStart() on every peer.
//
// Games set up their action channels in onReady(room) and begin gameplay in
// onStart(). Late joiners are the game's responsibility: on onPeerJoin, the
// host should re-send full current state to the new peer (see each game).
//
// Loaded as a traditional script (not an ES module) so it works on file://
// without a local server. Uses window.NeonArcade.createRoom from net.js.

/** Tiny element factory: el("div", { className, textContent, ...attrs }). */
function el(tag, props = {}) {
	const node = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (k === "textContent") node.textContent = v;
		else if (k in node) node[k] = v;
		else node.setAttribute(k, v);
	}
	return node;
}

/**
 * @param {HTMLElement} container  Element to mount the lobby into.
 * @param {object} opts
 * @param {string} opts.appId     Unique app id for this game.
 * @param {string} opts.gameName  Display title shown in the lobby.
 * @param {(room: object) => void} opts.onReady  Called once connected (set up game actions here).
 * @param {() => void} [opts.onStart]            Called on ALL peers when the host starts the game.
 */
NeonArcade.mountLobby = (
	container,
	{ appId, gameName, onReady, onStart, onPeerJoin, onPeerLeave },
) => {
	// Build the lobby with DOM methods (no innerHTML) to avoid XSS from
	// user-controlled strings like the room code.
	container.replaceChildren();
	const lobby = el("div", { className: "lobby" });
	const title = el("h1", { className: "lobby-title", textContent: gameName });
	const sub = el("p", {
		className: "lobby-sub",
		textContent: "Enter a room code and share it with friends.",
	});
	const row = el("div", { className: "lobby-row" });
	const codeInput = el("input", {
		className: "lobby-input",
		placeholder: "ROOM",
		maxlength: "8",
		value: randomCode(),
		autocomplete: "off",
	});
	const joinBtn = el("button", { className: "neon-btn", textContent: "JOIN" });
	const statusEl = el("div", { className: "lobby-status" });
	const peersEl = el("div", { className: "peer-list" });
	const startBtn = el("button", {
		className: "neon-btn neon-btn--accent",
		textContent: "START GAME",
	});
	startBtn.hidden = true;
	row.append(codeInput, joinBtn);
	lobby.append(title, sub, row, statusEl, peersEl, startBtn);
	container.append(lobby);

	let room = null;
	let started = false;
	let startAction = null;

	joinBtn.onclick = async () => {
		const code = (codeInput.value || randomCode()).trim().toUpperCase();
		codeInput.value = code;
		codeInput.disabled = true;
		joinBtn.disabled = true;
		joinBtn.textContent = "…";
		statusEl.textContent = "Connecting…";

		room = await NeonArcade.createRoom({
			appId,
			roomId: code,
			onPeerJoin: (peerId) => {
				renderPeers();
				statusEl.textContent = `Connected — ${room.peerCount()} peer(s) in room ${code}`;
				renderStart();
				// Late joiner: if the game already started, bring them in immediately.
				if (started && startAction) startAction.send({}, { target: peerId });
				onPeerJoin?.(peerId);
			},
			onPeerLeave: (peerId) => {
				renderPeers();
				statusEl.textContent = `Peer left — ${room.peerCount()} peer(s) remaining`;
				renderStart();
				onPeerLeave?.(peerId);
			},
			onHostChange: () => renderStart(),
		});

		// Host broadcasts start; every peer (incl. host) runs begin().
		startAction = room.makeAction("start");
		startAction.onMessage = () => begin();

		startBtn.onclick = () => {
			if (!room.isHost()) return;
			startAction.send({});
			begin();
		};

		statusEl.textContent = `Connected — share room code: ${code}`;
		renderPeers();
		renderStart();
		onReady?.(room);
	};

	function begin() {
		if (started) return;
		started = true;
		container.style.display = "none";
		onStart?.();
	}

	function renderPeers() {
		const n = room ? room.peerCount() : 0;
		peersEl.replaceChildren();
		const plural = n > 1 ? "s" : "";
		const line = el("div", {
			className: n ? "peer" : "peer-empty",
			textContent: n
				? `You + ${n} other player${plural}`
				: "Waiting for peers to join…",
		});
		peersEl.append(line);
	}

	function renderStart() {
		if (!room) return;
		startBtn.hidden = false;
		if (room.isHost()) {
			startBtn.disabled = false;
			startBtn.textContent = "START GAME";
		} else {
			startBtn.disabled = true;
			startBtn.textContent = "Waiting for host…";
		}
	}

	function randomCode() {
		return Math.random().toString(36).slice(2, 6).toUpperCase();
	}
};
