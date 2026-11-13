// lib/lobby.js — the pieces every party screen shares.
//
// There is no signaling server, so the players carry the handshake themselves:
// shareBlock shows an invite or a reply (QR, link, copyable code) and
// replyEntry takes one back (scan or paste). Around that: the in-page
// question every way out of a party asks (ask, guardParty, leaveParty), the
// toasts that tell everyone who came and went (toast, presence), AWAY and
// OFFLINE, and the remembered name.
//
// It used to also hold mountLobby, the two-player lobby each game page had.
// Game pages are party shortcuts now (2026-11-13), so the party shell
// (lib/party.js) is the one screen that connects anybody.
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
// party.html loads this before party.js.

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

// ------------------------------------------- asking first, telling everyone
//
// Leaving a party cannot be undone from this side — the seat, the crown and
// the rejoin token all go — so every way out asks first, and everyone left
// behind is told. The party shell registers its room with guardParty() and
// feeds its roster callbacks to a presence(); the rest is here.

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
 * `askAlone`: ask even with nobody else here — a boolean, or a function
 * asked each time. The party shell sets it — a party that ends when you
 * leave is worth a question, and its code may be on its way to someone —
 * except for a party a game page opened (`?game=`): one person against the
 * bots walking off is nobody's loss, and asking would only be in the way.
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
	const alone = typeof leaving.askAlone === "function" ? leaving.askAlone() : leaving.askAlone;
	const ask = alone || othersIn(room);
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

// OFFLINE: the device says it has no network. Said plainly while in a
// party, rather than letting links quietly fail; the party heals itself
// when the network is back (room-join redials at once on `online`).
// `navigator.onLine` is only trusted when it says offline — true can still
// mean a captive portal — so this is never the only check, just the honest one.
let offlineBar = null;
const syncOffline = () => {
	const room = leaving.room();
	const off = !!room && !room.closed && navigator.onLine === false;
	if (off && !offlineBar) {
		offlineBar = document.createElement("div");
		offlineBar.className = "neon-offline";
		offlineBar.setAttribute("role", "status");
		offlineBar.textContent = "You're offline — the party reconnects when the network is back.";
		document.body.append(offlineBar);
	} else if (!off && offlineBar) {
		offlineBar.remove();
		offlineBar = null;
		if (room && !room.closed) NeonArcade.toast("Back online.", "good");
	}
};
addEventListener("offline", syncOffline);
addEventListener("online", syncOffline);

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
