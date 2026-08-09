// lib/lobby.js — reusable neon lobby for the invite-link handshake.
//
// There is no signaling server, so the players carry the handshake themselves.
// The lobby walks them through it:
//
//   HOST                                    GUEST
//   [CREATE GAME]
//     -> invite link + QR                   opens the link
//                                             -> answer code + QR
//     <- paste the answer code
//   [START GAME]                            game begins on every peer
//
// The host can repeat the invite step for additional players (each guest needs
// its own offer). Everything after the handshake flows peer-to-peer.
//
// Games keep the same entry point as before — mountLobby(container, opts) with
// onReady / onStart / onPeerJoin / onPeerLeave — so the per-game changes are
// limited to how the room is obtained.
//
// Loaded as a traditional script (not an ES module) so it works on file://.

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
 * A button that abandons the current session and starts hosting a fresh game.
 *
 * Guests would otherwise be stranded on "waiting for the host" screens whenever
 * the host stops rematching or leaves; this gives them a way to carry on
 * without reaching for the address bar.
 */
NeonArcade.hostNewGameButton = (label = "HOST A NEW GAME") => {
	const btn = el("button", { className: "neon-btn", textContent: label });
	btn.onclick = () => NeonArcade.hostNewGame();
	return btn;
};

/**
 * @param {HTMLElement} container  Element to mount the lobby into.
 * @param {object} opts
 * @param {string} opts.gameName  Display title shown in the lobby.
 * @param {(room: object) => void} opts.onReady  Called once connected (set up game actions here).
 * @param {() => void} [opts.onStart]  Called on ALL peers when the host starts.
 * @param {(peerId: string) => void} [opts.onPeerJoin]
 * @param {(peerId: string) => void} [opts.onPeerLeave]
 */
NeonArcade.mountLobby = (
	container,
	{ gameName, onReady, onStart, onPeerJoin, onPeerLeave },
) => {
	container.replaceChildren();

	const lobby = el("div", { className: "lobby" });
	const title = el("h1", { className: "lobby-title", textContent: gameName });
	const sub = el("p", { className: "lobby-sub" });
	const stage = el("div", { className: "lobby-stage" });
	const statusEl = el("div", { className: "lobby-status" });
	const peersEl = el("div", { className: "peer-list" });
	lobby.append(title, sub, stage, statusEl, peersEl);
	container.append(lobby);

	let room = null;
	let started = false;
	let startAction = null;
	let stopScanner = null;

	// ------------------------------------------------------------ helpers

	/** A labelled code box with a copy button and a QR of the same payload. */
	function shareBlock({ label, hint, value, qrValue }) {
		const wrap = el("div", { className: "share" });
		wrap.append(el("div", { className: "share-label", textContent: label }));
		if (hint) wrap.append(el("div", { className: "share-hint", textContent: hint }));

		const box = el("textarea", {
			className: "share-code",
			readOnly: true,
			rows: "3",
			value,
		});
		box.addEventListener("focus", () => box.select());
		wrap.append(box);

		const row = el("div", { className: "lobby-row" });
		const copyBtn = el("button", { className: "neon-btn", textContent: "COPY" });
		copyBtn.onclick = async () => {
			try {
				await navigator.clipboard.writeText(value);
			} catch {
				// Clipboard permission can be denied (and is unavailable on
				// file://); selecting the text still lets the player copy manually.
				box.select();
			}
			copyBtn.textContent = "COPIED";
			setTimeout(() => (copyBtn.textContent = "COPY"), 1500);
		};
		row.append(copyBtn);

		// Web Share is the fastest path on a phone; only offer it when present.
		if (navigator.share) {
			const shareBtn = el("button", { className: "neon-btn", textContent: "SHARE" });
			shareBtn.onclick = () =>
				navigator.share({ title: gameName, text: value }).catch(() => {});
			row.append(shareBtn);
		}
		wrap.append(row);

		try {
			const canvas = NeonArcade.qrCanvas(qrValue ?? value, {
				scale: 3,
				quiet: 3,
				dark: "#000",
				light: "#fff",
			});
			canvas.className = "share-qr";
			const qrWrap = el("div", { className: "share-qr-wrap" });
			qrWrap.append(canvas);
			qrWrap.append(
				el("div", { className: "share-hint", textContent: "or scan this code" }),
			);
			wrap.append(qrWrap);
		} catch {
			// A payload too large to encode is not fatal — the link still works.
		}
		return wrap;
	}

	function setStatus(text, kind) {
		statusEl.textContent = text;
		statusEl.className = "lobby-status" + (kind ? ` is-${kind}` : "");
	}

	function renderPeers() {
		const n = room ? room.peerCount() : 0;
		peersEl.replaceChildren();
		peersEl.append(
			el("div", {
				className: n ? "peer" : "peer-empty",
				textContent: n
					? `You + ${n} other player${n > 1 ? "s" : ""} connected`
					: "No other players yet",
			}),
		);
	}

	/** Wire the shared room callbacks once, whichever side we are. */
	function roomOpts(extra) {
		return {
			onPeerJoin: (id) => {
				renderPeers();
				if (started && startAction && room.isHost()) {
					// Late joiner: bring them straight into the running game.
					startAction.send({}, { target: id });
				}
				onPeerJoin?.(id);
				extra?.onPeerJoin?.(id);
			},
			onPeerLeave: (id) => {
				renderPeers();
				onPeerLeave?.(id);
			},
			onError: (msg) => {
				setStatus(msg, "error");
				// Once play has begun the lobby is hidden, so an error here would be
				// invisible and the player would just sit there. Bring the lobby back
				// as a terminal screen with a way to carry on.
				if (started) showDisconnected(msg);
			},
			...extra,
		};
	}

	/** Register the start channel and hand the room to the game. */
	function bindRoom() {
		startAction = room.makeAction("start");
		startAction.onMessage = () => begin();
		onReady?.(room);
		room.resume();
	}

	function begin() {
		if (started) return;
		started = true;
		stopScanner?.();
		container.style.display = "none";
		onStart?.();
	}

	/** Terminal screen shown when the session cannot continue. */
	function showDisconnected(msg) {
		container.style.display = "";
		sub.textContent = msg;
		stage.replaceChildren();
		const row = el("div", { className: "lobby-row" });
		row.append(NeonArcade.hostNewGameButton("HOST A NEW GAME"));
		const portal = el("a", {
			className: "neon-btn",
			textContent: "ALL GAMES",
			href: "index.html",
		});
		row.append(portal);
		stage.append(row);
		setStatus(msg, "error");
		renderPeers();
	}

	// --------------------------------------------------------------- host

	function showHostChoice() {
		sub.textContent = "Play with a friend on any device — no server, no sign-up.";
		stage.replaceChildren();
		const row = el("div", { className: "lobby-row" });
		const createBtn = el("button", {
			className: "neon-btn neon-btn--accent",
			textContent: "CREATE GAME",
		});
		createBtn.onclick = () => hostFlow();
		row.append(createBtn);
		stage.append(row);
		setStatus("");
	}

	async function hostFlow() {
		// INVITE ANOTHER re-enters here and rebuilds the stage, which would
		// otherwise orphan a running camera.
		stopScanner?.();
		if (!room) {
			room = NeonArcade.createHost(roomOpts());
			bindRoom();
		}
		stage.replaceChildren();
		setStatus("Preparing invite…");

		let invite;
		try {
			invite = await room.createInvite();
		} catch (err) {
			setStatus("Could not create an invite: " + err.message, "error");
			return;
		}
		setStatus("Send the invite, then paste the code your friend sends back.");

		stage.append(
			shareBlock({
				label: "1. Send this invite link",
				hint: "Any chat app works — the link contains the connection details.",
				value: invite.link,
			}),
		);

		// Answer entry.
		const answerWrap = el("div", { className: "share" });
		answerWrap.append(
			el("div", { className: "share-label", textContent: "2. Get their reply code" }),
			el("div", {
				className: "share-hint",
				textContent:
					"Scan it straight off their screen, or paste it if they are not with you.",
			}),
		);
		const answerBox = el("textarea", {
			className: "share-code",
			rows: "3",
			placeholder: "Paste the code your friend sends back…",
			autocomplete: "off",
			spellcheck: "false",
		});
		const connect = async (code) => {
			if (!code) return;
			connectBtn.disabled = true;
			connectBtn.textContent = "…";
			setStatus("Connecting…");
			try {
				await room.acceptAnswer(code);
				answerBox.value = "";
				setStatus("Connecting…");
			} catch (err) {
				setStatus(err.message, "error");
			}
			connectBtn.disabled = false;
			connectBtn.textContent = "CONNECT";
		};

		const connectBtn = el("button", { className: "neon-btn", textContent: "CONNECT" });
		connectBtn.onclick = () => connect(answerBox.value.trim());

		// Scanning the reply off the other player's screen removes the only
		// copy-paste left in the flow when both players are in the same room.
		const scanBtn = el("button", {
			className: "neon-btn neon-btn--accent",
			textContent: "SCAN REPLY",
		});
		const scanWrap = el("div", { className: "scan-wrap" });
		scanWrap.hidden = true;
		let scanner = null;

		const closeScanner = () => {
			scanner?.stop();
			scanner = null;
			scanWrap.replaceChildren();
			scanWrap.hidden = true;
			scanBtn.textContent = "SCAN REPLY";
		};

		scanBtn.onclick = () => {
			if (scanner) return closeScanner();
			scanBtn.textContent = "CANCEL SCAN";
			scanWrap.hidden = false;
			setStatus("Point the camera at your friend's reply code…");
			scanner = NeonArcade.scanQr({
				onResult: (code) => {
					closeScanner();
					answerBox.value = code;
					connect(code);
				},
				onError: (msg) => {
					closeScanner();
					setStatus(msg, "error");
				},
			});
			scanner.video.className = "scan-video";
			scanWrap.append(scanner.video);
		};

		const answerRow = el("div", { className: "lobby-row" });
		answerRow.append(connectBtn, scanBtn);
		answerWrap.append(answerBox, answerRow, scanWrap);
		stage.append(answerWrap);

		// Leaving the camera running after the lobby is gone would keep the
		// recording indicator lit.
		stopScanner = closeScanner;

		// Host controls.
		const controls = el("div", { className: "lobby-row" });
		const againBtn = el("button", {
			className: "neon-btn",
			textContent: "INVITE ANOTHER",
		});
		againBtn.onclick = () => hostFlow();
		const startBtn = el("button", {
			className: "neon-btn neon-btn--accent",
			textContent: "START GAME",
		});
		startBtn.onclick = () => {
			if (room.peerCount() === 0) {
				setStatus("Connect at least one other player first.", "error");
				return;
			}
			startAction.send({});
			begin();
		};
		controls.append(againBtn, startBtn);
		stage.append(controls);
	}

	// -------------------------------------------------------------- guest

	async function guestFlow(inviteCode) {
		sub.textContent = "You have been invited to play.";
		stage.replaceChildren();
		setStatus("Reading invite…");

		room = NeonArcade.createGuest(
			roomOpts({
				onOpen: () => {
					setStatus("Connected! Waiting for the host to start…", "good");
					stage.replaceChildren();
					renderPeers();
				},
			}),
		);
		bindRoom();

		let answer;
		try {
			answer = await room.answerInvite(inviteCode);
		} catch (err) {
			setStatus(
				"That invite could not be read. Ask for a fresh link — invites expire when the host reloads.",
				"error",
			);
			return;
		}

		setStatus("Send this code back to the host to finish connecting.");
		stage.append(
			shareBlock({
				label: "Send this code back",
				hint: "Show this screen to the host to scan, or send them the code.",
				value: answer,
			}),
		);
	}

	// --------------------------------------------------------------- boot

	renderPeers();

	// Opening an invite for a page the player already has open changes only the
	// fragment, which does not re-run any of this. Reload so the invite is
	// actually picked up — otherwise the link silently appears to do nothing.
	window.addEventListener("hashchange", () => {
		if (!started && NeonArcade.inviteFromUrl()) location.reload();
	});

	const invite = NeonArcade.inviteFromUrl();
	if (invite) guestFlow(invite);
	else showHostChoice();
};
