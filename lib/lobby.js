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

// --------------------------------------------------- shared with party.js
//
// The party shell and the game-page lobby walk the same handshake, so they
// share the pieces of it rather than keeping two copies that drift. They live
// here because every page that mounts either screen loads this file (and
// party.html loads it before party.js); lib/ui.js is not on every game page.

NeonArcade.el = el;

/** A remembered display name beats typing it again on every visit. */
NeonArcade.savedName = () => {
	try {
		return localStorage.getItem("neon.name") || "";
	} catch {
		return "";
	}
};
NeonArcade.rememberName = (name) => {
	try {
		localStorage.setItem("neon.name", name);
	} catch {}
};

/**
 * Take a party code to the party shell, the only screen that can join one:
 * a game-page lobby knows one game, and a newcomer who joined a party there
 * would be stranded in the wrong context. Anything but six digits is refused
 * (false) so the caller can say so rather than navigate nowhere. index.html
 * keeps its own four-line copy, because the portal loads none of lib/.
 */
NeonArcade.goJoinCode = (raw) => {
	const digits = String(raw ?? "").replace(/\D/g, "").slice(0, 6);
	if (digits.length !== 6) return false;
	location.href = "party.html#c=" + digits;
	return true;
};

// ------------------------------------------- asking first, telling everyone
//
// Leaving a party cannot be undone from this side — the seat, the crown and
// the rejoin token all go — so every way out asks first, and everyone left
// behind is told. Both shells register their room with guardParty() and feed
// their roster callbacks to a presence(); the rest is here, once.

let asking = null; // the open question's resolver, if one is up

/**
 * Ask a yes/no question in the page's own modal; resolves true for `ok`.
 * Not confirm(): that freezes the page's JavaScript while it is up, and a
 * host's game loop and the mesh's relaying freeze with it — for everyone.
 * A second question dismisses the first (as "no"), so two never stack.
 */
NeonArcade.ask = (question, { ok = "LEAVE", cancel = "STAY" } = {}) => {
	asking?.(false);
	return new Promise((resolve) => {
		const dlg = el("dialog", { className: "neon-ask" });
		const box = el("div", { className: "neon-ask-box" });
		const no = el("button", { className: "neon-btn", textContent: cancel });
		const yes = el("button", { className: "neon-btn neon-btn--accent", textContent: ok });
		no.dataset.ask = "no";
		yes.dataset.ask = "yes";
		const row = el("div", { className: "lobby-row" });
		row.append(no, yes);
		box.append(el("p", { textContent: question }), row);
		dlg.append(box);
		const done = (answer) => {
			if (asking !== done) return;
			asking = null;
			dlg.close();
			dlg.remove();
			resolve(answer);
		};
		asking = done;
		no.onclick = () => done(false);
		yes.onclick = () => done(true);
		// Escape, and a tap on the backdrop (the dialog itself, outside the
		// box), both mean "no": the safe answer is the easy one.
		dlg.addEventListener("cancel", (e) => {
			e.preventDefault();
			done(false);
		});
		dlg.addEventListener("click", (e) => e.target === dlg && done(false));
		document.body.append(dlg);
		dlg.showModal();
		no.focus();
	});
};

let toastLayer = null;
const TOAST_MS = 4500;
const TOASTS_MAX = 3;

/**
 * A short notice over whatever is on screen — the party screen or a game
 * mid-round — that never takes a tap and never pauses anything.
 * `kind`: "good", "warn" or nothing.
 */
NeonArcade.toast = (text, kind = "") => {
	if (!toastLayer) {
		toastLayer = el("div", { className: "neon-toasts", role: "status" });
		toastLayer.setAttribute("aria-live", "polite");
		document.body.append(toastLayer);
	}
	const note = el("div", { className: "neon-toast" + (kind ? ` is-${kind}` : ""), textContent: text });
	toastLayer.append(note);
	while (toastLayer.children.length > TOASTS_MAX) toastLayer.firstChild.remove();
	setTimeout(() => note.remove(), TOAST_MS);
};

// A reconnecting mark can come and go in a second — a socket blip the room
// server reports, a link renegotiating — and a crown can flicker while two
// computed heirs settle (net.js _outranks). Only what is still true after
// these delays is announced, so nobody is told about a hiccup that healed.
const LOST_NOTICE_MS = 2500;
const HOST_NOTICE_MS = 1200;

const LEFT_BECAUSE = {
	left: (n) => `${n} left the party.`,
	dropped: (n) => `${n} lost connection and left the party.`,
	removed: (n) => `${n} was removed from the party.`,
};

/**
 * Tell this player what changed in the party: who joined, who left (and
 * how), who lost connection and came back, and who holds the crown. Feed it
 * from every roster callback: `sync(room)` after onParty / onPeerJoin /
 * onHostVacant, `left(room, id, info)` from onPeerLeave (info carries the
 * reason, which the roster alone cannot tell). The first sync with a room —
 * a fresh join, or a reconnect's new room — is silent: it is the roster
 * this player is arriving into, not a change to it.
 */
NeonArcade.presence = () => {
	let room = null;
	let known = new Map(); // id -> { name, reconnecting }, humans only
	let host = null;
	let announcedHost = null;
	const lost = new Set(); // whose lost connection we announced
	const reasons = new Map();
	const toast = NeonArcade.toast;

	const snapshot = (r) =>
		new Map(
			r
				.getMembers()
				.filter((m) => !NeonArcade.isBotId(m.id))
				.map((m) => [m.id, { name: m.name || "Player", reconnecting: !!m.reconnecting }]),
		);

	function sync(r) {
		if (!r || r.closed) return;
		if (r !== room) {
			room = r;
			known = snapshot(r);
			host = announcedHost = r.hostId();
			lost.clear();
			return;
		}
		const now = snapshot(r);
		for (const [id, m] of now) {
			const was = known.get(id);
			if (!was) {
				if (id !== r.selfId) toast(`${m.name} joined the party.`, "good");
			} else if (m.reconnecting && !was.reconnecting) {
				setTimeout(() => {
					const still = room === r && !r.closed && r.getMember(id)?.reconnecting;
					if (!still || lost.has(id)) return;
					lost.add(id);
					toast(`${m.name} lost connection — holding their seat.`, "warn");
				}, LOST_NOTICE_MS);
			} else if (!m.reconnecting && was.reconnecting && lost.delete(id)) {
				toast(`${m.name} is back.`, "good");
			}
		}
		for (const [id, m] of known) {
			if (now.has(id) || id === r.selfId) continue;
			lost.delete(id);
			toast((LEFT_BECAUSE[reasons.get(id)] ?? LEFT_BECAUSE.left)(m.name), "warn");
			reasons.delete(id);
		}
		known = now;
		const h = r.hostId();
		if (h === host) return;
		host = h;
		setTimeout(() => {
			if (room !== r || r.closed || r.hostId() !== h || h === announcedHost) return;
			announcedHost = h;
			if (h === r.selfId) toast("You are the host now.", "good");
			else toast(`${r.getMember(h)?.name ?? "Someone"} is the host now.`);
		}, HOST_NOTICE_MS);
	}

	return {
		sync,
		left(r, id, info) {
			if (info?.reason) reasons.set(id, info.reason);
			sync(r);
		},
	};
};

// The room the page would leave, or null; and how it leaves. Set by
// guardParty(), read by every exit below.
const leaving = { room: () => null, askAlone: false, going: false, armed: false };
const GUARD = "neonGuard";

/** Whether anybody but this player — a person, not a bot — is in the room. */
const othersIn = (room) =>
	room.getMembers().some((m) => m.id !== room.selfId && !NeonArcade.isBotId(m.id));

/**
 * Register this page's party: `room()` returns the live room, or null when
 * there is none to leave. From then on every exit goes through leaveParty():
 * the "← All games" link (and any `a[data-leaves]`), the back button and
 * swipe-back, and — where the browser allows nothing better — the native
 * "Leave site?" prompt on a tab close or reload.
 *
 * `askAlone`: ask even with nobody else here. The party shell sets it — a
 * party that ends when you leave is worth a question, and its code may be
 * on its way to someone. A game page does not: one person against the bots
 * walking off is nobody's loss, and asking would only be in the way.
 */
NeonArcade.guardParty = ({ room, askAlone = false }) => {
	leaving.askAlone = askAlone;
	leaving.room = () => {
		const r = room();
		return r && !r.closed ? r : null;
	};
};

/**
 * Leave the party on purpose, asking first when anybody else is in it.
 * Resolves true once the leave has landed (the caller may navigate), false
 * if they chose to stay. Not asked (see guardParty's askAlone), the leave
 * still happens: it is what releases the seat and
 * drops the rejoin token, without which the next visit would silently
 * reconnect to the party this player just walked out of.
 */
NeonArcade.leaveParty = async (question = "Leave the party?") => {
	const room = leaving.room();
	if (!room) return true;
	const ask = leaving.askAlone || othersIn(room);
	if (ask && !(await NeonArcade.ask(NeonArcade.leaveQuestion(room, question)))) {
		return false;
	}
	leaving.going = true;
	room.leave();
	// An unload straight after the send can take the goodbye down with it;
	// room-join bounds this wait (LEAVE_ACK_MS).
	await NeonArcade.roomSettled?.();
	return true;
};

/**
 * The question, with what happens to the party after: a host is told who
 * inherits the crown (bots cannot hold it — see room.heir()), and everyone
 * that the others will be told.
 */
NeonArcade.leaveQuestion = (room, question) => {
	if (!room.isHost()) return `${question} The others will be told you left.`;
	const heir = room.heir();
	const after = heir
		? `You are the host; the crown will pass to ${room.getMember(heir)?.name ?? "someone"}.`
		: "You are the host and nobody else is here — the party ends.";
	return `${after} ${question}`;
};

// "← All games", and any other link marked as a way out of the party.
document.addEventListener("click", async (e) => {
	const link = e.target.closest?.("a.portal-link, a[data-leaves]");
	if (!link || e.defaultPrevented || e.button !== 0) return;
	if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // a new tab leaves nothing
	if (!leaving.room()) return;
	e.preventDefault();
	if (await NeonArcade.leaveParty("Leave the party for all games?")) location.href = link.href;
});

// The back button and swipe-back. A page cannot hold them, but it can put a
// history entry of its own on top: going back then lands on this same page,
// and that is where it asks. The entry is pushed from a tap or a key, not on
// load — Chrome skips entries a page added without one when going back, so
// one pushed at load would do nothing.
function armBack() {
	if (leaving.armed || !leaving.room()) return;
	leaving.armed = true;
	history.pushState({ [GUARD]: true }, "", location.href);
}
addEventListener("pointerdown", armBack, true);
addEventListener("keydown", armBack, true);
addEventListener("popstate", async (e) => {
	if (!leaving.armed || e.state?.[GUARD]) return;
	// A handshake link opened into this tab is a forward navigation the
	// shells' hashchange handlers deal with, not the player going back.
	if (NeonArcade.inviteFromUrl() || NeonArcade.answerFromUrl() || NeonArcade.codeFromUrl?.()) return;
	leaving.armed = false;
	// The party ended while the entry sat there: finish the back asked for.
	if (!leaving.room()) return history.back();
	if (await NeonArcade.leaveParty("Go back and leave the party?")) {
		history.back();
		// Nothing to go back to (the page was opened straight from a link),
		// or only to another entry of this page: land on the portal instead.
		setTimeout(() => (location.href = "index.html"), 600);
	} else {
		armBack(); // STAY was a tap, so this entry counts
	}
});

// AWAY: this page is hidden — another app, a locked phone. Published on the
// member record so the roster and a turn game's wait banner can say so
// (Lokesh, 2026-11-13: roster and banner, no toasts). Re-checked every two
// seconds as well as on the event, so a seat that came back by reload — whose
// record may still say away — is corrected, and nothing is sent when nothing
// changed.
const syncAway = () => {
	const room = leaving.room();
	if (!room || room.closed) return;
	const away = document.hidden;
	if (!!room.getMember(room.selfId)?.away !== away) room.setMeta({ away });
};
document.addEventListener("visibilitychange", syncAway);
setInterval(syncAway, 2000);

// A tab close or reload. All a page may show here is the browser's own
// generic prompt, and only when somebody would notice the seat go quiet.
// Going ahead is not a leave: the seat is held as RECONNECTING, which is
// exactly what a reload is for.
addEventListener("beforeunload", (e) => {
	const room = leaving.room();
	if (leaving.going || !room || !othersIn(room)) return;
	e.preventDefault();
	e.returnValue = "";
});

/**
 * A code box with a copy button and a QR of the same payload — a labelled
 * `.share` card when given a `label`, a bare block to drop into one otherwise.
 *
 * `linkValue`, when given, is the same payload wrapped in a URL. It is
 * offered as a second button rather than as the main value: a link is the
 * convenient thing to send through a chat app, but it is ~40 characters
 * longer, and the QR — the thing that gets scanned in person — should stay
 * as small as it can be.
 */
NeonArcade.shareBlock = ({ label, hint, value, qrValue, linkValue, title }) => {
	const wrap = el("div", label ? { className: "share" } : {});
	if (label) wrap.append(el("div", { className: "share-label", textContent: label }));
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
		shareBtn.onclick = () => navigator.share({ title, text: value }).catch(() => {});
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
		qrWrap.append(el("div", { className: "share-hint", textContent: "or scan this code" }));
		wrap.append(qrWrap);
	} catch {
		// A payload too large to encode is not fatal — the link still works.
	}
	return wrap;
};

/**
 * The answerer's side of a reply a person carries back. Between some networks
 * — a carrier NAT that connects only as the offerer (docs/network-testing.md,
 * 2026-11-12) — the waiting side's own ICE gives up ~15 s after its reply is
 * made, and with no signalling channel there is nothing to rebuild the link
 * over (no TURN, by choice). So the reply screen says to carry it back at
 * once, and a reply that failed says why and offers a fresh one: a reload
 * answers the same `#i=` invite again with a new connection. If the inviter
 * already used the old reply, their invite is spent, and they are told so
 * when they paste the new one ("Create a new invite").
 */
NeonArcade.REPLY_NOW = "Do it right away: between some networks a reply only works for about 15 seconds.";
NeonArcade.replyFailed = (setStatus) => {
	setStatus("Your reply was not used in time, or your network and theirs cannot connect directly.", "error");
	const hint = el("div", {
		className: "share-hint",
		textContent:
			"Make a new reply and have them scan or paste it straight away. If they already used the last one, ask them for a new invite.",
	});
	const again = el("button", { className: "neon-btn neon-btn--accent", textContent: "MAKE A NEW REPLY" });
	again.onclick = () => location.reload();
	return { hint, again };
};

/**
 * The inviter's half of the handshake: a box for the reply, and CONNECT /
 * PASTE / SCAN REPLY to fill it. Returns the nodes for the caller to place
 * under its own heading, the button `row` (to add to), and `close`, which
 * the caller must run whenever it tears the panel down — a camera left
 * running after the panel is gone keeps the recording indicator lit.
 *
 * `onConnected` runs once the reply is applied; without it the status stays
 * at "Connecting…" until the link actually opens and the room says so.
 */
NeonArcade.replyEntry = ({ room, setStatus, placeholder, scanPrompt, onConnected }) => {
	const box = el("textarea", {
		className: "share-code",
		rows: "3",
		placeholder,
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
			box.value = "";
			if (onConnected) onConnected();
			else setStatus("Connecting…");
		} catch (err) {
			setStatus(err.message, "error");
		}
		connectBtn.disabled = false;
		connectBtn.textContent = "CONNECT";
	};

	const connectBtn = el("button", { className: "neon-btn", textContent: "CONNECT" });
	connectBtn.onclick = () => connect(box.value.trim());

	// One tap instead of select-all-then-paste, where the browser allows
	// reading the clipboard at all (it needs a secure context and consent).
	const pasteBtn = el("button", { className: "neon-btn", textContent: "PASTE" });
	pasteBtn.onclick = async () => {
		try {
			const text = (await navigator.clipboard.readText()).trim();
			box.value = text;
			connect(text);
		} catch {
			setStatus("Clipboard is blocked here — paste into the box instead.", "error");
			box.focus();
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

	const close = () => {
		scanner?.stop();
		scanner = null;
		scanWrap.replaceChildren();
		scanWrap.hidden = true;
		scanBtn.textContent = "SCAN REPLY";
	};

	scanBtn.onclick = () => {
		if (scanner) return close();
		scanBtn.textContent = "CANCEL SCAN";
		scanWrap.hidden = false;
		setStatus(scanPrompt);
		scanner = NeonArcade.scanQr({
			onResult: (code) => {
				close();
				box.value = code;
				connect(code);
			},
			onError: (msg) => {
				close();
				setStatus(msg, "error");
			},
		});
		scanner.video.className = "scan-video";
		scanWrap.append(scanner.video);
	};

	const row = el("div", { className: "lobby-row" });
	row.append(connectBtn, pasteBtn, scanBtn);
	return { nodes: [box, row, scanWrap], row, close };
};

/**
 * A button that abandons the current session and starts hosting a fresh game.
 *
 * Guests would otherwise be stranded on "waiting for the host" screens whenever
 * the host stops rematching or leaves; this gives them a way to carry on
 * without reaching for the address bar.
 */
NeonArcade.hostNewGameButton = (label = "HOST A NEW GAME") => {
	const btn = el("button", { className: "neon-btn", textContent: label });
	btn.onclick = async () => {
		if (await NeonArcade.leaveParty("Leave the party and host a new game?")) NeonArcade.hostNewGame();
	};
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
	{ gameName, game, onReady, onStart, onEnd, onPeerJoin, onPeerLeave },
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
	const presence = NeonArcade.presence();
	NeonArcade.guardParty({ room: () => room });
	// Who held the crown when this lobby first saw one. A game page has no
	// party screen to fall back to, and every game keeps its state on that
	// host: when the crown moves, the session is over (checkCrown).
	let firstHost = null;
	let crownTimer = null;
	let stopScanner = null;
	// True while the initial host/guest choice is on screen, so the room-server
	// paths know whether it is still theirs to enhance — a player who has
	// already walked into the invite flow should not have a JOIN WITH CODE
	// button materialise under their thumb.
	let atChoice = true;

	// Seat facts, defaulted for a caller that did not pass a game def.
	const minSeats = game?.seats?.min ?? 2;
	const maxSeats = game?.seats?.max ?? 8;
	const botsAllowed = game?.bots !== false;
	/** Everyone who would take a seat if the game started now, bots included. */
	const seated = () => (room ? room.getMembers().length : 1);
	const botCount = () => (room ? room.bots().length : 0);

	// ------------------------------------------------------------ helpers

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
			name: NeonArcade.savedName() || NeonArcade.defaultName(),
			onPeerJoin: (id) => {
				renderPeers();
				if (started && startAction && room.isHost()) {
					// Late joiner: bring them straight into the running game.
					startAction.send({}, { target: id });
				}
				presence.sync(room);
				onPeerJoin?.(id);
				extra?.onPeerJoin?.(id);
			},
			onPeerLeave: (id, info) => {
				renderPeers();
				presence.left(room, id, info);
				onPeerLeave?.(id, info);
			},
			onParty: () => {
				presence.sync(room);
				checkCrown();
			},
			onHostVacant: () => {
				presence.sync(room);
				checkCrown();
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

	/**
	 * The crown moved: the host left, or lost its connection for good on a
	 * page with no room server to bring it back. Before START a guest would
	 * be left on "waiting for the host" with nobody to start; after it, a
	 * board that never moves again. Either way the session ends, and says
	 * why. Not on the spot: a crown can flicker while two computed heirs
	 * settle (net.js _outranks), and a false alarm must end nothing.
	 */
	const CROWN_SETTLE_MS = 1500;
	function checkCrown() {
		if (!room || room.closed || crownTimer) return;
		const host = room.hostId();
		if (!firstHost) {
			firstHost = host;
			return;
		}
		if (host === firstHost) return;
		crownTimer = setTimeout(() => {
			crownTimer = null;
			if (room.closed || room.hostId() === firstHost) return;
			const msg = started ? "The host left, so the game ended." : "The host left before the game started.";
			// Nothing here can carry on without them, so stop being a party:
			// otherwise this terminal screen would still ask before leaving.
			room.leave();
			NeonArcade.toast(msg, "warn");
			showDisconnected(msg);
		}, CROWN_SETTLE_MS);
	}

	/** Terminal screen shown when the session cannot continue. */
	function showDisconnected(msg) {
		// The game page's stage sits above this lobby; take the game down
		// so the screen is not drawn behind a board nobody can play.
		if (started) onEnd?.();
		container.style.display = "";
		sub.textContent = msg;
		stage.replaceChildren();
		const row = el("div", { className: "lobby-row" });
		row.append(NeonArcade.hostNewGameButton("HOST A NEW GAME"));
		const portal = el("a", {
			className: "neon-btn",
			textContent: "ALL GAMES",
			href: "index.html",
			"data-leaves": "",
		});
		row.append(portal);
		stage.append(row);
		setStatus(msg, "error");
		renderPeers();
	}

	// --------------------------------------------------------------- host

	function showHostChoice() {
		atChoice = true;
		// A local game has nothing to connect. Everyone is already here — they
		// are standing next to the phone — so the lobby's whole job is to get
		// out of the way.
		if (game?.local) {
			sub.textContent = "Played on this one device. Gather round and pass it along.";
			stage.replaceChildren();
			if (!room) {
				room = NeonArcade.createHost(roomOpts());
				bindRoom();
			}
			const row = el("div", { className: "lobby-row" });
			const go = el("button", {
				className: "neon-btn neon-btn--accent",
				textContent: "START",
			});
			// `begin()` rather than onStart directly: it is what hides the lobby
			// and guards against starting twice.
			go.onclick = () => begin();
			row.append(go);
			stage.append(row);
			setStatus("");
			return;
		}
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

		// The room server, when it is reachable, adds the cheap door: a
		// six-digit code that opens the persistent party shell (see
		// NeonArcade.goJoinCode for why it is never joined here).
		NeonArcade.roomServerReachable?.().then((ok) => {
			if (!ok || !atChoice || started) return;
			const joinBtn = el("button", {
				className: "neon-btn",
				textContent: "JOIN WITH A CODE",
			});
			joinBtn.onclick = () => {
				const raw = prompt("Enter the 6-digit party code");
				if (raw == null) return; // cancelled
				if (!NeonArcade.goJoinCode(raw)) {
					setStatus("That is not a six-digit party code.", "error");
				}
			};
			row.insertBefore(joinBtn, row.firstChild);
		});
	}

	/**
	 * Host a game with no other browser in it: you, and as many bots as you
	 * want. There is nothing to hand out and nothing to wait for, so this skips
	 * the invite entirely and goes straight to a roster and a START button.
	 */
	function soloFlow() {
		atChoice = false;
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
		atChoice = false;
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
			NeonArcade.shareBlock({
				label: "1. Send this invite link",
				hint: "Any chat app works — the link contains the connection details.",
				value: invite.link,
				title: gameName,
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
		const reply = NeonArcade.replyEntry({
			room,
			setStatus,
			placeholder: "Paste the code your friend sends back…",
			scanPrompt: "Point the camera at your friend's reply code…",
		});
		answerWrap.append(...reply.nodes);
		stage.append(answerWrap);
		stopScanner = reply.close;

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
		atChoice = false;
		sub.textContent = "You have been invited to play.";
		stage.replaceChildren();
		setStatus("Reading invite…");

		let linked = false;
		room = NeonArcade.createGuest(
			roomOpts({
				onOpen: () => {
					linked = true;
					setStatus("Connected! Waiting for the host to start…", "good");
					stage.replaceChildren();
					renderPeers();
				},
				onError: (msg, info) => {
					// Our reply's link failed before it ever opened: say why,
					// and offer a fresh reply rather than a dead screen.
					if (info?.reason === "no-route" && !linked && !started) {
						const { hint, again } = NeonArcade.replyFailed(setStatus);
						const row = el("div", { className: "lobby-row" });
						row.append(again, el("a", { className: "neon-btn", textContent: "ALL GAMES", href: "index.html", "data-leaves": "" }));
						stage.replaceChildren(hint, row);
						return;
					}
					setStatus(msg, "error");
					if (started) showDisconnected(msg);
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
			NeonArcade.shareBlock({
				label: "Send this code back",
				hint: `Show this screen to the host to scan, or send them the code. ${NeonArcade.REPLY_NOW}`,
				value: answer,
				linkValue: `${location.href.split("#")[0]}#a=${answer}`,
				title: gameName,
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
		// An `#i=` invite or a `#c=` code link is a fragment-only navigation
		// for a page that is already open. Both reload into the boot below,
		// which is the one place that decides what a code link can do here
		// (it checks the room server is reachable before sending it on).
		// With people already in the lobby that reload walks out on them, so
		// it is a leave like any other: asked first, and said goodbye to.
		if (!started && (NeonArcade.inviteFromUrl() || NeonArcade.codeFromUrl?.())) {
			const hash = location.hash;
			NeonArcade.clearHash();
			NeonArcade.leaveParty("Leave this game and open the other invite?").then((go) => {
				if (!go) return;
				history.replaceState(history.state, "", location.pathname + location.search + hash);
				location.reload();
			});
		}
	});

	// A code link opened fresh joins straight away; opened into a tab that
	// already had the page up, the hashchange above reloads into this same
	// branch. Party codes always route through the persistent party shell —
	// a game-page lobby only knows one game, so joining a party here would
	// strand the newcomer in the wrong UI context.
	const code = NeonArcade.codeFromUrl?.();
	const invite = NeonArcade.inviteFromUrl();
	if (invite) guestFlow(invite);
	else if (code) NeonArcade.roomServerReachable?.().then((ok) => {
		if (ok) {
			NeonArcade.goJoinCode(code);
		} else {
			NeonArcade.clearHash();
			setStatus("That is a party-code link, but the room server is not reachable here.", "error");
			showHostChoice();
		}
	});
	else showHostChoice();
};
