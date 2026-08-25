// lib/lobby.js — reusable neon lobby for the invite-link handshake.
//
// There is no signaling server, so the players carry the handshake themselves.
// The lobby walks them through it:
//
//   HOST                                    GUEST
//   [INVITE A FRIEND]
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
 * @param {object} [opts.game]  The registered game def, for seat counts and bots.
 * @param {(room: object) => void} opts.onReady  Called once connected (set up game actions here).
 * @param {() => void} [opts.onStart]  Called on ALL peers when the host starts.
 * @param {(peerId: string) => void} [opts.onPeerJoin]
 * @param {(peerId: string) => void} [opts.onPeerLeave]
 */
NeonArcade.mountLobby = (
	container,
	{ gameName, game, onReady, onStart, onPeerJoin, onPeerLeave },
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

	// Seat facts, defaulted for a caller that did not pass a game def.
	const minSeats = game?.seats?.min ?? 2;
	const maxSeats = game?.seats?.max ?? 8;
	const botsAllowed = game?.bots !== false;
	/** Everyone who would take a seat if the game started now, bots included. */
	const seated = () => (room ? room.getMembers().length : 1);
	const botCount = () => (room ? room.bots().length : 0);

	// ------------------------------------------------------------ helpers

	/**
	 * A labelled code box with a copy button and a QR of the same payload.
	 *
	 * `linkValue`, when given, is the same payload wrapped in a URL. It is
	 * offered as a second button rather than as the main value: a link is the
	 * convenient thing to send through a chat app, but it is ~40 characters
	 * longer, and the QR — the thing that gets scanned in person — should stay
	 * as small as it can be.
	 */
	function shareBlock({ label, hint, value, qrValue, linkValue }) {
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

		if (linkValue) {
			const linkBtn = el("button", { className: "neon-btn", textContent: "COPY LINK" });
			linkBtn.onclick = async () => {
				try {
					await navigator.clipboard.writeText(linkValue);
					linkBtn.textContent = "COPIED";
					setTimeout(() => (linkBtn.textContent = "COPY LINK"), 1500);
				} catch {
					box.value = linkValue;
					box.select();
				}
			};
			row.append(linkBtn);
		}

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
		const others = room ? room.peerCount() : 0;
		const botted = botCount();
		const people = others - botted;
		peersEl.replaceChildren();

		// Bots are counted separately: "You + 3 other players connected" is a lie
		// when two of them are this browser talking to itself, and the difference
		// matters — a bot cannot be waited for, and it cannot leave.
		const parts = [];
		// "other player" is load-bearing: scripts/preview.mjs waits on this exact
		// wording to know the handshake finished. See the game-previews skill.
		if (people > 0) {
			parts.push(`${people} other player${people > 1 ? "s" : ""} connected`);
		}
		if (botted > 0) parts.push(`${botted} bot${botted > 1 ? "s" : ""}`);
		peersEl.append(
			el("div", {
				className: others ? "peer" : "peer-empty",
				textContent: parts.length ? `You + ${parts.join(" and ")}` : "No other players yet",
			}),
		);
	}

	/**
	 * The START button, shared by both host paths.
	 *
	 * It refuses on the seat count rather than on the peer count: with bots a
	 * game can be perfectly legal with nobody else connected, and a game whose
	 * minimum is one seat is legal on its own.
	 */
	function startButton() {
		const btn = el("button", {
			className: "neon-btn neon-btn--accent",
			textContent: "START GAME",
		});
		btn.onclick = () => {
			if (seated() < minSeats) {
				setStatus(
					botsAllowed
						? `This game needs ${minSeats} players — connect somebody, or add a bot.`
						: `This game needs ${minSeats} players — connect somebody first.`,
					"error",
				);
				return;
			}
			startAction.send({});
			begin();
		};
		return btn;
	}

	/**
	 * A row of ADD BOT / REMOVE BOT controls, or nothing when this game has
	 * opted out of bots. Re-rendered in place so the count stays truthful.
	 */
	function botControls(onChange) {
		const wrap = el("div", { className: "lobby-row" });
		if (!botsAllowed) return wrap;

		const addBtn = el("button", { className: "neon-btn", textContent: "ADD BOT" });
		const dropBtn = el("button", { className: "neon-btn", textContent: "REMOVE BOT" });
		const refresh = () => {
			addBtn.disabled = seated() >= maxSeats;
			dropBtn.disabled = botCount() === 0;
			renderPeers();
			onChange?.();
		};
		addBtn.onclick = () => {
			room?.addBot();
			refresh();
		};
		dropBtn.onclick = () => {
			const last = room?.bots().at(-1);
			if (last) room.removeMember(last.id);
			refresh();
		};
		wrap.append(addBtn, dropBtn);
		refresh();
		return wrap;
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
		sub.textContent = botsAllowed
			? "Play with friends on any device, or against bots — no server, no sign-up."
			: "Play with a friend on any device — no server, no sign-up.";
		stage.replaceChildren();
		const row = el("div", { className: "lobby-row" });
		const createBtn = el("button", {
			className: "neon-btn neon-btn--accent",
			textContent: "INVITE A FRIEND",
		});
		createBtn.onclick = () => hostFlow();
		row.append(createBtn);

		// The second path: no handshake at all. This is what makes every game in
		// the arcade playable on one device, which is the only reason a
		// single-player section ever existed.
		if (botsAllowed) {
			const soloBtn = el("button", {
				className: "neon-btn",
				textContent: minSeats <= 1 ? "PLAY ALONE" : "PLAY A BOT",
			});
			soloBtn.onclick = () => soloFlow();
			row.append(soloBtn);
		}
		stage.append(row);
		setStatus("");
	}

	/**
	 * Host a game with no other browser in it: you, and as many bots as you
	 * want. There is nothing to hand out and nothing to wait for, so this skips
	 * the invite entirely and goes straight to a roster and a START button.
	 */
	function soloFlow() {
		stopScanner?.();
		if (!room) {
			room = NeonArcade.createHost(roomOpts());
			bindRoom();
		}
		stage.replaceChildren();

		// Enough bots to make the game legal, so the common case is one tap.
		while (seated() < minSeats && seated() < maxSeats) room.addBot();

		const wrap = el("div", { className: "share" });
		wrap.append(
			el("div", { className: "share-label", textContent: "Your table" }),
			el("div", {
				className: "share-hint",
				textContent:
					"Bots are run by this device. Add or drop them until it looks like a fair fight.",
			}),
		);
		stage.append(wrap);
		stage.append(botControls());

		const controls = el("div", { className: "lobby-row" });
		const inviteBtn = el("button", { className: "neon-btn", textContent: "INVITE A FRIEND" });
		inviteBtn.onclick = () => hostFlow();
		controls.append(inviteBtn, startButton());
		stage.append(controls);
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

		// One tap instead of select-all-then-paste, where the browser allows
		// reading the clipboard at all (it needs a secure context and consent).
		const pasteBtn = el("button", { className: "neon-btn", textContent: "PASTE" });
		pasteBtn.onclick = async () => {
			try {
				const text = (await navigator.clipboard.readText()).trim();
				answerBox.value = text;
				connect(text);
			} catch {
				setStatus("Clipboard is blocked here — paste into the box instead.", "error");
				answerBox.focus();
			}
		};

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
		answerRow.append(connectBtn, pasteBtn, scanBtn);
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
		controls.append(againBtn, startButton());
		stage.append(controls);
		stage.append(botControls());
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
				linkValue: `${location.href.split("#")[0]}#a=${answer}`,
			}),
		);
	}

	// --------------------------------------------------------------- boot

	renderPeers();

	// Opening an invite for a page the player already has open changes only the
	// fragment, which does not re-run any of this. Reload so the invite is
	// actually picked up — otherwise the link silently appears to do nothing.
	//
	// A reply link (`#a=`) is the opposite case: it must NOT reload, because
	// reloading would destroy the very room the answer belongs to. It only
	// works when the link opens in this tab; from a chat app that opens a new
	// one there is no room to accept it, which is why the code itself remains
	// the primary way a reply travels.
	window.addEventListener("hashchange", () => {
		const answer = NeonArcade.answerFromUrl();
		if (answer && room?.isHost()) {
			NeonArcade.clearHash();
			room.acceptAnswer(answer).catch((err) => setStatus(err.message, "error"));
			return;
		}
		if (!started && NeonArcade.inviteFromUrl()) location.reload();
	});

	const invite = NeonArcade.inviteFromUrl();
	if (invite) guestFlow(invite);
	else showHostChoice();
};
