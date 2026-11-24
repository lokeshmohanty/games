// lib/party.js — the persistent party shell.
//
// The party is the thing that lasts; a game is just what it is currently
// mounting. Because every game is a module (see lib/games.js) and the room is
// a mesh (see lib/net.js), switching games is a DOM swap rather than a page
// navigation, so nobody reconnects and nobody re-scans anything.
//
// What this screen owns:
//   - the roster: who is here, what they are called, which team they are on
//   - recruiting: ANY member can mint an invite, not only the host
//   - the game switcher, with the roster validated against each game's shape
//   - host controls: hand over the crown, remove someone, delete the party
//   - succession: when the host goes, the crown passes to the longest-present
//     remaining member automatically
//
// A classic script on window.NeonArcade, bundled into the shell by src/main.tsx
// (docs/spa.md).

(() => {
	// Shared with lib/lobby.js, loaded first.
	const { el, savedName, rememberName, shareBlock } = NeonArcade;

	// Room-server join failures (lib/room-join.js), in the party screen's own
	// words. Anything not listed shows the reason's own message, which
	// room-join already words for a person.
	const JOIN_ERRORS = {
		unreachable: "Could not reach the room server. Check your connection and retry.",
	};
	// The network failed us, not the party: worth trying again as-is.
	// "no-route" too — the pair of networks had no path this time, and a
	// phone that moves to other wifi or a hotspot may well have one.
	const RETRYABLE = new Set(["unreachable", "blocked", "no-route"]);
	// The server's answer that the seat a rejoin token claims is gone for good.
	// "no-answer" is not one: the party may only be slow to answer, so
	// room-join keeps the claim and the token, and the screen offers RETRY
	// beside START A NEW PARTY (which gives the claim back).
	const SEAT_GONE = new Set(["no-room", "id-taken", "bad-code", "full"]);

	const TEAMS = [
		{ key: "A", label: "TEAM A" },
		{ key: "B", label: "TEAM B" },
		{ key: "spectator", label: "WATCHING" },
	];

	// This device's player colour (Lokesh, 2026-11-21: "every game with
	// colours"): an index into the theme's --p1…--p8, never a colour, since
	// every theme draws them differently. Remembered here, offered to each
	// party as our record's `colorWant`; the host's record settles `color`
	// (net.js assignColors: the first to pick keeps it). docs/index.md
	// "Player colours".
	const COLOR_KEY = "neon.color";
	const savedColor = () => {
		try {
			const v = localStorage.getItem(COLOR_KEY);
			const i = v === null ? NaN : Number(v);
			return Number.isInteger(i) && i >= 0 && i < (NeonArcade.PALETTE_SIZE ?? 8) ? i : null;
		} catch {
			return null;
		}
	};
	const colorNames = () => NeonArcade.theme?.playerNames?.() ?? ["Red", "Yellow", "Blue", "Magenta", "Green", "Orange", "Purple", "Teal"];
	/** A seat's colour as CSS: its member's settled `color`, else its place. */
	const seatColor = (m, i = 0) => `var(--p${((Number.isInteger(m?.color) ? m.color : i) % 8) + 1})`;

	/**
	 * @param {HTMLElement} container  where the party screen lives
	 * @param {HTMLElement} stage      where a mounted game builds itself
	 */
	NeonArcade.mountParty = (container, stage) => {
		container.replaceChildren();

		const shell = el("div", { className: "lobby party" });
		const title = el("h1", { className: "lobby-title", textContent: "PARTY" });
		const sub = el("p", { className: "lobby-sub" });
		const body = el("div", { className: "lobby-stage" });
		const statusEl = el("div", { className: "lobby-status" });
		shell.append(title, sub, body, statusEl);
		// The one-page shell keeps the party across views, so "← Games"
		// no longer leaves it: this does (lib/lobby.js asks first).
		if (NeonArcade.shell) {
			const leave = el("a", { className: "neon-btn", href: "./", textContent: "LEAVE PARTY" });
			leave.dataset.leaves = "";
			// A live room is lib/lobby.js's to leave (leaveParty). Without one —
			// reconnecting, RETRY, "open in another tab" — there is still a
			// saved seat to give back, or the next visit reconnects to it, or
			// finds it "open in another tab" (2026-11-15).
			leave.addEventListener("click", (e) => {
				if ((!closed && room && !room.closed) || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
				e.preventDefault();
				if (leave.dataset.going) return;
				leave.dataset.going = "1";
				forgetSeat().finally(() => (location.href = leave.href));
			});
			const row = el("div", { className: "lobby-row party-leave" });
			row.append(leave);
			shell.append(row);
		}
		container.append(shell);

		let room = null;
		let mounted = null; // { id, handle, host } — host: who held the crown at mount
		let stopScanner = null;
		let invitePanel = null;
		// The room-server code this party is meeting under, when it is: the
		// one number a newcomer can type instead of carrying an invite and a
		// reply by hand. Set by whichever flow hosted or joined through the
		// room server; null for a classic-invite-only party.
		let partyCode = null;
		// Whether the party code's QR is unfolded. It survives re-renders, which
		// rebuild the whole screen on every roster change.
		let codeQrOpen = false;
		let codeQr = null; // { link, canvas } — the party code's QR, drawn once
		// The game the address names (./?game=connect4, a portal card's link):
		// offered up front — PLAY A BOT, INVITE A FRIEND, START GAME — until it
		// has been started once, then this is an ordinary party (Lokesh,
		// 2026-11-13: a game's link is a party shortcut). CHANGE PLAYERS and
		// PLAY WITH FRIENDS (below) offer the game in hand up front again, so
		// it becomes that game.
		let quickGame = (() => {
			const id = new URLSearchParams(location.search).get("game");
			return id && NeonArcade.getGame(id) ? id : null;
		})();
		let quick = false; // hostFlow sets it: this load hosts a fresh party for quickGame
		// Its frame starts building now, while the party is still being set
		// up, so the mount finds the files fetched (lib/bridge.js).
		if (quickGame) NeonArcade.prefetchFrame?.(NeonArcade.getGame(quickGame));
		// A game page's first choice (Lokesh, 2026-11-13): null until picked,
		// then "bots" (seats filled with bots, no code on show) or "friends"
		// (the party code, invites). Someone joining by code means friends.
		let quickMode = null;
		// PLAY WITH BOTS from a card, or a one-device game: nobody else is
		// coming, so hostFlow hosts at once, without the room server's probe
		// and dial (up to 2.5 s + 8 s on a phone), and the game starts with no
		// START tap. A party code is fetched later, only if friends are
		// wanted (ensureCode). Measured 2026-11-14 (docs/perf.md): a cold
		// PLAY WITH BOTS took 7.3 s and a tap to reach the game.
		let autoStart = false;
		// Set when hostFlow skipped the room server on purpose (autoStart):
		// the one kind of party ensureCode may host again under a code. A
		// party hosted classically because the server was down keeps its
		// classic invites.
		let skippedServer = false;
		// A card's PLAY WITH BOTS / PLAY WITH FRIENDS (lib/portal.js) arrives as
		// ?mode=bots|friends: that choice is made already. Taken once.
		let pendingMode = (() => {
			const m = new URLSearchParams(location.search).get("mode");
			return m === "bots" || m === "friends" ? m : null;
		})();
		// A tap's ?start=1 (or PLAY SOMETHING's ?start=pick): the game's
		// remembered (or smallest) table at once, with no table on screen, so
		// it stays one tap. Taken once.
		let startNow = new URLSearchParams(location.search).has("start");
		// PLAY SOMETHING's random pick (?start=pick): the remembered table's
		// size, every other seat a bot (Lokesh, 2026-11-23: "Bots only for
		// random picks"), and the PERSON seats saved for that game left as
		// they were. A card's tap (?start=1) seats them. Until a table drawn
		// on screen starts instead (CHANGE PLAYERS).
		let botsOnly = new URLSearchParams(location.search).get("start") === "pick";
		// A room-server join still meeting the party: { ctl, done }, so START
		// A NEW PARTY can cancel it (see startFresh). Null otherwise.
		let joining = null;
		// Set the moment this page is done with its party (deleted, removed,
		// closed by the host). The room keeps firing callbacks until its links
		// are torn down — deleteParty waits 250ms for the notice to drain — and
		// a render in that window would paint the live roster over the
		// terminal screen.
		let closed = false;
		const presence = NeonArcade.presence();
		// The party screen pulled up over a running game (PARTY), which keeps
		// running underneath; and the pill that does it, shown only mid-game.
		let peeking = false;
		const partyPill = el("button", { className: "party-pill", textContent: "PARTY" });
		partyPill.hidden = true;
		partyPill.onclick = () => setPeek(true);
		// Beside it, FEEDBACK and FAVOURITE for the game in hand — the one
		// running, else the one a game page sent us here for (Lokesh,
		// 2026-11-14: moved here from every portal card).
		const topActions = el("div", { className: "top-actions" });
		const topButton = (cls, icon, label) => {
			const b = el("button", { className: `top-btn ${cls}`, type: "button" });
			b.append(el("span", { className: "icon", textContent: icon, "aria-hidden": "true" }), el("span", { className: "label", textContent: label }));
			return b;
		};
		const feedbackBtn = topButton("top-feedback", "💬", "Feedback");
		const favBtn = topButton("top-fav", "☆", "Favourite");
		// "?": the game's rules (manifest "rules"), any time (lib/rules.js).
		const rulesBtn = topButton("top-rules", "?", "Rules");
		const inHand = () => mounted?.id ?? quickGame;
		const titleOf = (id) => NeonArcade.CATALOG?.find((g) => g.id === id)?.title ?? NeonArcade.getGame(id)?.name ?? id;
		rulesBtn.onclick = () => inHand() && NeonArcade.rules?.show(NeonArcade.getGame(inHand()));
		feedbackBtn.onclick = () => inHand() && NeonArcade.accountUi?.feedback(inHand(), titleOf(inHand()));
		favBtn.onclick = () => {
			const id = inHand();
			if (!id || !NeonArcade.stats) return;
			const on = NeonArcade.stats.toggleFav(id);
			NeonArcade.toast(on ? `${titleOf(id)} is a favourite.` : `${titleOf(id)} is no longer a favourite.`);
		};
		function paintTop() {
			const id = inHand();
			feedbackBtn.hidden = favBtn.hidden = !id;
			rulesBtn.hidden = !id || !NeonArcade.rules?.has(NeonArcade.getGame(id));
			if (!id) return;
			const title = titleOf(id);
			rulesBtn.title = `How to play ${title}`;
			rulesBtn.setAttribute("aria-label", rulesBtn.title);
			const on = !!NeonArcade.stats?.isFav(id);
			favBtn.setAttribute("aria-pressed", String(on));
			favBtn.querySelector(".icon").textContent = on ? "★" : "☆";
			favBtn.title = `${on ? "Remove" : "Add"} ${title} ${on ? "from" : "to"} favourites`;
			favBtn.setAttribute("aria-label", favBtn.title);
			feedbackBtn.title = `Feedback on ${title}`;
			feedbackBtn.setAttribute("aria-label", feedbackBtn.title);
		}
		topActions.append(rulesBtn, feedbackBtn, favBtn, partyPill);
		// One row across the top (lib/styles.css .top-band): "← Games" at the
		// left, these at the right. Two fixed pills overlapped once the
		// phone's text was larger (Firefox at 130%, Lokesh's phone,
		// 2026-11-15); in one row ← GAMES gives up its word instead.
		const band = el("div", { className: "top-band" });
		const back = document.querySelector("#party-layer > .portal-link");
		if (back) band.append(back);
		band.append(topActions);
		document.body.append(band);
		// ← GAMES whole when its word fits beside the right end, else the
		// arrow alone (.is-tight). The word is measured even while hidden
		// (lib/styles.css), so the choice cannot flip back and forth.
		const fitBack = () => {
			const word = back?.querySelector(".label");
			if (!word || !band.clientWidth) return;
			const gap = (n) => parseFloat(getComputedStyle(n).columnGap) || 0;
			const whole = back.querySelector(".icon").offsetWidth + gap(back) + word.offsetWidth + 24 + 2; // its padding and border
			back.classList.toggle("is-tight", whole > band.clientWidth - topActions.offsetWidth - gap(band));
		};
		if (back && "ResizeObserver" in window) {
			const fit = new ResizeObserver(fitBack);
			fit.observe(band);
			fit.observe(topActions);
			document.fonts?.ready.then(fitBack);
		}
		paintTop();
		NeonArcade.stats?.onChange((what) => what === "favs" && paintTop());

		// Pending check that the crown really moved under a running game.
		let crownTimer = null;
		// Cut off from the side of a split party that holds the crown
		// (net.js _lose): the game stops and the screen says so.
		let lost = false;
		// Every way off this page asks first while the party is live (lobby.js).
		// A party a game page opened is "you and the bots" until someone joins:
		// walking off it alone is not asked (see guardParty).
		NeonArcade.guardParty({ room: () => (closed ? null : room), askAlone: () => !quickGame });
		// Signing in (or the friends list arriving) changes the party screen.
		NeonArcade.account?.onChange(() => {
			NeonArcade.account?.attach(room);
			render();
		});

		const setStatus = (text, kind) => {
			statusEl.textContent = text;
			statusEl.className = "lobby-status" + (kind ? ` is-${kind}` : "");
		};

		// ------------------------------------------------------ game mounting

		function syncGame() {
			if (closed || lost) return;
			const wanted = room?.getGame() ?? null;
			if (mounted?.id === wanted) return;

			if (mounted) {
				// Ended because the crown moved under it (checkCrown): say so,
				// or a game vanishing mid-move reads as a crash.
				if (!wanted && room && mounted.host !== room.hostId()) {
					const was = room.getMember(mounted.host);
					NeonArcade.toast(
						was
							? `The host changed, so the game ended — ${room.getMember(room.hostId())?.name ?? "the new host"} picks the next one.`
							: "The host left, so the game ended.",
						"warn",
					);
				}
				// A game that leaves a loop or a listener behind would fight the next
				// one for input, so unmount is not optional.
				try {
					mounted.handle?.unmount?.();
				} catch (err) {
					console.error("unmount failed", err);
				}
				stage.replaceChildren();
				mounted = null;
			}
			setPeek(false);
			if (!wanted) NeonArcade.account?.status(null);
			partyPill.hidden = !wanted;
			paintTop();
			NeonArcade.keepAwake(!!wanted);
			if (!wanted) {
				container.hidden = false;
				stage.hidden = true;
				render();
				return;
			}

			const game = NeonArcade.getGame(wanted);
			if (!game) return setStatus(`Unknown game "${wanted}".`, "error");

			container.hidden = true;
			stage.hidden = false;
			const ctx = NeonArcade.gameContext({
				root: stage,
				room,
				teamOf: (id) => room.getMember(id)?.team ?? null,
				onEnd: () => room.isHost() && room.setGame(null),
			});
			// A game says how it ended (its `result`, lib/sdk-host.js). Kept
			// on this device (lib/stats.js), once per run and ranking however
			// often it is reported; then offered to whoever listens — the
			// account's match report (lib/account.js).
			const run = room.getRun?.() ?? null;
			ctx.reportResult = (r) => {
				const how = NeonArcade.stats?.record(wanted, r, {
					me: room.selfId,
					key: `${run}|${r?.match ?? 0}|${JSON.stringify(r?.ranking)}`,
				});
				if (how) NeonArcade.onResult?.({ game: wanted, run, result: r, how, room });
				return how; // falsy: a result this device already had
			};
			NeonArcade.stats?.played(wanted);
			NeonArcade.account?.status(wanted);
			try {
				// CHANGE PLAYERS and PLAY WITH FRIENDS on the end card
				// (lib/sdk-managed.js), for the host alone with bots.
				ctx.canChangePlayers = canChangePlayers;
				ctx.changePlayers = changePlayers;
				ctx.canPlayWithFriends = canPlayWithFriends;
				ctx.playWithFriends = playWithFriends;
				mounted = { id: wanted, handle: game.mount(ctx), host: room.hostId(), ctx, run };
				paintTop();
				syncAddress();
				// The first time this device opens it: the rules, over the game,
				// on this phone only — the game carries on underneath.
				NeonArcade.rules?.firstOpen(game, () => mounted?.id === wanted);
				const hi = mountedNotice();
				handoverNotice();
				if (!room.isHost() && room.hostId()) hi.send({ game: wanted }, { target: room.hostId() });
			} catch (err) {
				console.error(err);
				mounted = null;
				partyPill.hidden = true;
				paintTop();
				NeonArcade.keepAwake(false);
				container.hidden = false;
				stage.hidden = true;
				setStatus(`${game.name} failed to start: ${err.message}`, "error");
			}
		}

		/**
		 * A member who mounts the game the host is running says so, and the
		 * host's game hears it as `onPeerJoin(id, { back: true })`. This is
		 * for a returner after a reload: net.js fires onPeerJoin only for a new
		 * id, never for a held seat coming back — and when it does re-announce
		 * one, it is before their page has mounted anything, so whatever the
		 * game pushed then was lost. Only the fresh mount knows when it is ready.
		 * A newcomer's notice repeats what net.js already triggered, which
		 * every game's onPeerJoin takes as a harmless second push.
		 */
		function mountedNotice() {
			const action = room.makeAction("p$mounted");
			action.onMessage = (msg, { peerId }) => {
				if (!room.isHost() || mounted?.id !== msg?.game) return;
				mounted.handle?.onPeerJoin?.(peerId, { back: true });
			};
			return action;
		}

		/**
		 * Pull the party screen up over the running game, or put it away. The
		 * game keeps running underneath — nobody else's round waits on this —
		 * and the screen gains BACK TO GAME, and END GAME for the host.
		 */
		function setPeek(on) {
			on = on && !!mounted && !closed;
			if (on === peeking) return;
			peeking = on;
			container.classList.toggle("party-peek", on);
			container.hidden = !on && !!mounted;
			partyPill.hidden = on || !mounted;
			if (on) {
				container.scrollTop = 0;
				render();
			}
		}

		/**
		 * The crown moved under a running game. Every game keeps its state on
		 * the host that started it, so a new host has nothing to carry on
		 * from: the game is over, and saying so beats a board that silently
		 * never moves again. The new host ends it for everyone (only the host
		 * can set the game); the rest hear it through the record and are told
		 * in syncGame. Not on the spot — a crown can flicker for a moment
		 * while two computed heirs settle (net.js _outranks), and a false
		 * alarm must not end anybody's game.
		 */
		const CROWN_SETTLE_MS = 1500;
		function checkCrown() {
			if (!mounted || closed || crownTimer || room.hostId() === mounted.host) return;
			crownTimer = setTimeout(() => {
				crownTimer = null;
				if (!mounted || closed || room.closed || room.hostId() === mounted.host) return;
				if (room.isHost()) return takeOverGame();
				// We held the crown and it moved on (a blip long enough for the
				// party to crown the heir): our copy of the game still thinks it
				// is the referee. Mount it again as a guest; the new host's game
				// hears the mounted notice and sends us where things stand.
				if (mounted.host === room.selfId) remountAsGuest();
			}, CROWN_SETTLE_MS);
		}

		/**
		 * The crown moved to us under a running game. A game that can carry on
		 * from what everyone was sent — `takeOver()` returning true — does, and
		 * the departed host's seat is held like any lost player's (Lokesh,
		 * 2026-11-13); one that cannot (its state, or a secret it needs, lived
		 * only on the old host) ends as before. The others are told which.
		 */
		async function takeOverGame() {
			const name = NeonArcade.getGame(mounted.id)?.name ?? "The game";
			const was = mounted;
			let kept = false;
			mounted.ctx.isHost = true;
			try {
				// A framed game answers across its frame (lib/bridge.js), so this
				// may be a promise; an in-page game's plain boolean awaits the same.
				kept = !!(await mounted.handle?.takeOver?.());
			} catch (err) {
				console.error("takeOver failed", err);
			}
			if (mounted !== was || closed) return;
			if (!kept) {
				mounted.ctx.isHost = false;
				return room.setGame(null);
			}
			mounted.host = room.selfId;
			room.makeAction("p$handover").send({ game: mounted.id });
			NeonArcade.toast(`You are the host now — ${name} goes on.`, "good");
		}

		/** Guests: the new host kept the game going, so it is theirs now. */
		function handoverNotice() {
			room.makeAction("p$handover").onMessage = (msg, { peerId }) => {
				if (!mounted || msg?.game !== mounted.id || peerId !== room.hostId()) return;
				if (mounted.host === peerId) return;
				mounted.host = peerId;
				const name = NeonArcade.getGame(mounted.id)?.name ?? "The game";
				NeonArcade.toast(`${room.getMember(peerId)?.name ?? "The new host"} carries ${name} on.`, "good");
			};
		}

		function remountAsGuest() {
			const id = mounted.id;
			try {
				mounted.handle?.unmount?.();
			} catch (err) {
				console.error("unmount failed", err);
			}
			stage.replaceChildren();
			mounted = null;
			syncGame();
			if (mounted?.id === id) mounted.host = room.hostId();
		}

		// ------------------------------------------------------------- render

		/**
		 * The party's six-digit code for INVITE, whoever this member is (Lokesh,
		 * 2026-11-16: any party member can invite a friend). The host and anyone
		 * in by code know it; a member in by a classic invite does not, so
		 * whoever knows it publishes it in the party record (meta `pcode`, which
		 * only members see) and the rest read it there — the host's first.
		 */
		function sharedCode() {
			if (partyCode && room.self()?.pcode !== partyCode) room.setMeta({ pcode: partyCode });
			if (partyCode) return partyCode;
			const valid = (m) => (/^\d{6}$/.test(String(m?.pcode ?? "")) ? m.pcode : null);
			return valid(room.getMember(room.hostId())) ?? room.getMembers().map(valid).find(Boolean) ?? null;
		}

		function render() {
			if (!room || closed) return;
			if (lost) return lostScreen();
			syncAddress();
			NeonArcade.account?.attach(room);
			// Behind a running game nobody can see it, and every roster event
			// (a mark, a meta change, a team move) used to rebuild it all, QR
			// included. setPeek and the game's end both render on the way back.
			if (container.hidden && mounted && !peeking) return;
			// A name being typed survives the rebuild: value, caret and focus.
			const typing = document.activeElement?.dataset?.partyName !== undefined
				? { value: document.activeElement.value, at: document.activeElement.selectionStart, to: document.activeElement.selectionEnd }
				: null;
			// A quick-table control in use keeps the focus across the rebuild.
			qtFocus = document.activeElement?.dataset?.qt ?? null;
			// So does a colour swatch.
			colorFocus = document.activeElement?.dataset?.color ?? null;
			body.replaceChildren();
			const me = room.self();
			const isHost = room.isHost();

			const quickOn = quick && isHost && !mounted && !closed;
			title.textContent = quickOn ? NeonArcade.getGame(quickGame).name : "PARTY";
			sub.textContent = isHost
				? "You are the host. Add players, pick teams, choose a game."
				: "Waiting for the host to start something.";
			if (quickOn) quickBlock();
			// Played on one device: nobody to name yourself to, invite or list.
			if (quickOn && NeonArcade.getGame(quickGame).local) return;
			// A game page before its choice, or playing the bots: no code, no
			// roster to manage — the two buttons, or the bot controls, are all.
			if (quickOn && quickMode !== "friends") return;

			// -- over a running game -------------------------------------------
			if (peeking && mounted) {
				const name = NeonArcade.getGame(mounted.id)?.name ?? "the game";
				sub.textContent = isHost
					? `${name} is still running. End it to pick another, or go back to it.`
					: `${name} is still running. The host can end it.`;
				const peekRow = el("div", { className: "lobby-row" });
				const back = el("button", { className: "neon-btn neon-btn--accent", textContent: "BACK TO GAME" });
				back.onclick = () => setPeek(false);
				peekRow.append(back);
				if (isHost) {
					const end = el("button", { className: "neon-btn", textContent: "END GAME" });
					end.onclick = async () => {
						const ok = await NeonArcade.ask(`End ${name} for everyone and go back to the party?`, {
							ok: "END GAME",
							cancel: "KEEP PLAYING",
						});
						if (ok && mounted && room.isHost()) room.setGame(null);
					};
					peekRow.append(end);
				}
				// The seats of a game played alone, for the next round (the
				// end card has it too, in a managed game; this is every game's).
				// Both end the game, so both ask first, as END GAME does (the
				// end card's, between rounds, need not).
				const ending = async (what, ok, go) => {
					if (await NeonArcade.ask(`End ${name} and ${what}?`, { ok, cancel: "KEEP PLAYING" })) go();
				};
				if (canChangePlayers()) {
					const seats = el("button", { className: "neon-btn party-seats", textContent: "CHANGE PLAYERS" });
					seats.onclick = () => ending("change the players", "CHANGE PLAYERS", changePlayers);
					peekRow.append(seats);
				}
				// During play, PLAY WITH FRIENDS is here (the end card has it
				// between rounds; Lokesh, 2026-11-22: "Bottom, between rounds").
				if (canPlayWithFriends()) {
					const friends = el("button", { className: "neon-btn neon-btn--accent party-play-friends", textContent: "PLAY WITH FRIENDS" });
					friends.setAttribute("aria-label", "Play with friends: end this game and open the party lobby");
					friends.onclick = () => ending("open the lobby to play with friends", "PLAY WITH FRIENDS", playWithFriends);
					peekRow.append(friends);
				}
				body.append(peekRow);
			}

			// -- your name ---------------------------------------------------
			const youWrap = el("div", { className: "share" });
			youWrap.append(el("div", { className: "share-label", textContent: "You" }));
			const nameRow = el("div", { className: "lobby-row" });
			const nameInput = el("input", {
				className: "lobby-input",
				value: me?.name ?? "",
				maxLength: "16",
				placeholder: "Your name",
			});
			nameInput.dataset.partyName = "";
			const saveName = () => {
				const v = nameInput.value.trim().slice(0, 16);
				if (!v || v === me?.name) return;
				rememberName(v);
				room.setName(v);
			};
			nameInput.addEventListener("change", saveName);
			nameInput.addEventListener("blur", saveName);
			nameRow.append(nameInput);
			youWrap.append(nameRow, colorPicker());
			body.append(youWrap);
			if (typing) {
				nameInput.value = typing.value;
				nameInput.focus();
				nameInput.setSelectionRange(typing.at, typing.to);
			}

			// -- the party code -------------------------------------------------
			//
			// The room-server door: six digits, and a QR of the `#c=` link for
			// a phone across the table. It is shown only when this party
			// actually has one — a classic-invite party has not, and a phantom
			// code is a promise nobody can keep. The QR is folded away by
			// default: at full scanning size it would push the roster below the
			// fold on a phone, and the digits alone are what most people need.
			// A party that skipped the room server to start a bots game at once
			// asks for its code now, while it is still just us (ensureCode).
			if (!partyCode && isHost && !quickOn) ensureCode();
			if (partyCode) {
				const codeWrap = el("div", { className: "share" });
				codeWrap.append(
					el("div", { className: "share-label", textContent: "Party code" }),
					el("div", {
						className: "share-hint",
						textContent: "Anyone with this code joins straight away — no scanning, no pasting.",
					}),
					el("div", { className: "party-code-digits", textContent: partyCode }),
				);
				const qrBtn = el("button", {
					className: "neon-btn party-code-qr-btn",
					textContent: codeQrOpen ? "HIDE QR" : "SHOW QR",
				});
				qrBtn.onclick = () => {
					codeQrOpen = !codeQrOpen;
					render();
				};
				codeWrap.append(qrBtn);
				if (codeQrOpen) {
					// The page's own query rides along, so a test's mock (or a
					// loopback `?rs=` server) is the one the scanner reaches too.
					const link = NeonArcade.shareBase() + "#c=" + partyCode;
					// Encoded once per link, not on every re-render.
					if (codeQr?.link !== link) {
						try {
							const canvas = NeonArcade.qrCanvas(link, {
								scale: 3,
								quiet: 3,
								dark: "#000", // theme-exempt: QR
								light: "#fff", // theme-exempt: QR
							});
							canvas.className = "share-qr party-code-qr";
							codeQr = { link, canvas };
						} catch {
							// Too long to encode (a very long path): the digits still work.
							codeQr = { link, canvas: null };
						}
					}
					if (codeQr.canvas) codeWrap.append(codeQr.canvas);
				}
				body.append(codeWrap);
			}

			// -- roster ------------------------------------------------------
			const rosterWrap = el("div", { className: "share" });
			rosterWrap.append(
				el("div", {
					className: "share-label",
					textContent: `Party (${room.getMembers().length})`,
				}),
			);
			for (const m of room.getMembers()) {
				const isBot = NeonArcade.isBotId(m.id);
				const row = el("div", { className: "party-member" });
				row.dataset.member = m.id;
				const label = el("div", { className: "party-name" });
				// Their player colour, named for anyone who cannot tell it.
				const dot = el("span", { className: "party-dot", role: "img" });
				dot.style.setProperty("--seat", seatColor(m));
				dot.setAttribute("aria-label", colorNames()[m.color] ?? "No colour yet");
				dot.dataset.memberColor = String(m.color ?? "");
				label.append(dot, el("span", { textContent: m.name }));
				// A bot seat a person on the host's phone plays (the quick
				// table's, or the toggle below): PERSON, not BOT.
				if (isBot) {
					label.append(el("span", { className: "party-tag is-bot", textContent: m.local === true ? "PERSON" : "BOT" }));
				}
				// A held seat: their links are down, the reconnect grace is
				// running, and coming back is automatic — one reload costs one
				// RECONNECT and nothing else.
				if (m.reconnecting) {
					label.append(
						el("span", {
							className: "party-tag is-reconnecting",
							textContent: "RECONNECTING",
						}),
					);
				} else if (m.away) {
					// Switched to another app or locked the phone; still connected.
					label.append(el("span", { className: "party-tag is-away", textContent: "AWAY" }));
				}
				if (m.id === room.hostId()) {
					label.append(el("span", { className: "party-tag is-host", textContent: "HOST" }));
				}
				if (m.id === room.selfId) {
					label.append(el("span", { className: "party-tag", textContent: "YOU" }));
				}
				row.append(label);

				const controls = el("div", { className: "party-controls" });
				for (const team of TEAMS) {
					const btn = el("button", {
						className:
							"party-team" + ((m.team ?? "spectator") === team.key ? " is-on" : ""),
						textContent: team.label,
					});
					btn.disabled = !isHost;
					btn.onclick = () => room.setTeam(m.id, team.key);
					controls.append(btn);
				}
				if (isHost && m.id !== room.selfId) {
					// A bot cannot hold the crown — there is no browser behind it to
					// run the party — so it is only ever offered REMOVE.
					// Both are small and side by side, and neither can be taken
					// back from this end — so a mis-tap asks first. A bot's
					// removal is just a seat freed, and is not asked about.
					if (!isBot) {
						const crown = el("button", { className: "party-mini", textContent: "MAKE HOST" });
						crown.onclick = async () => {
							// The game's state lives on its host; see checkCrown.
							const ending = mounted ? " The game in progress ends." : "";
							const ok = await NeonArcade.ask(`Hand the crown to ${m.name}? Only they can give it back.${ending}`, {
								ok: "MAKE HOST",
								cancel: "KEEP IT",
							});
							if (ok && room.getMember(m.id)) room.transferHost(m.id);
						};
						controls.append(crown);
					}
					// BOT / PERSON for the host alone with bots, when a game
					// takes people at bot seats ("sameDevice"): the roster's
					// own way to the quick table's choice. Not over a running
					// game, which has its seats already.
					if (isBot && !mounted && !othersHere(room) && sameDeviceNames().length) {
						const on = m.local === true;
						const person = el("button", { className: "party-mini party-person", type: "button", textContent: "PERSON" });
						person.dataset.person = m.id;
						person.setAttribute("aria-pressed", String(on));
						person.setAttribute("aria-label", `${m.name}: a person beside you plays this seat`);
						person.onclick = () => setPerson(room.getMember(m.id) ?? m, !on);
						controls.append(person);
					}
					const kick = el("button", {
						className: "party-mini is-danger",
						textContent: "REMOVE",
					});
					kick.onclick = async () => {
						if (!isBot) {
							const ok = await NeonArcade.ask(`Remove ${m.name} from the party?`, {
								ok: "REMOVE",
								cancel: "CANCEL",
							});
							if (!ok) return;
						}
						room.removeMember(m.id);
					};
					controls.append(kick);
				}
				// Signed in, and so are they: ADD FRIEND (lib/account-ui.js).
				const friend = NeonArcade.accountUi?.memberControl(m);
				if (friend) controls.append(friend);
				row.append(controls);
				rosterWrap.append(row);
			}
			// -- bots ---------------------------------------------------------
			//
			// Only the host runs bots, so only the host is offered the button. The
			// selected game decides whether it is offered at all: a game that a
			// bot cannot meaningfully play says so in its registration.
			// (The quick block has its own.)
			if (isHost && !quickOn) {
				const game = NeonArcade.getGame(room.getGame());
				const botsAllowed = !game || game.bots !== false;
				const full = room.getMembers().length >= room.maxMembers;
				const botRow = el("div", { className: "lobby-row" });
				const addBot = el("button", {
					className: "neon-btn",
					textContent: "ADD BOT",
					disabled: !botsAllowed || full,
				});
				addBot.onclick = () => room.addBot();
				botRow.append(addBot);
				if (!botsAllowed) {
					botRow.append(
						el("div", {
							className: "share-hint",
							textContent: `${game.name} needs real players — a bot has nothing to do in it.`,
						}),
					);
				} else if (full) {
					botRow.append(
						el("div", { className: "share-hint", textContent: "The party is full." }),
					);
				}
				rosterWrap.append(botRow);
				if (!mounted && !othersHere(room) && sameDeviceNames().length && room.getMembers().some((m) => NeonArcade.isBotId(m.id))) {
					rosterWrap.append(
						el("div", {
							className: "share-hint party-person-hint",
							textContent: `PERSON: someone beside you plays that seat on this phone, in ${sameDeviceNames().join(", ")}. Other games play it as a bot.`,
						}),
					);
				}
			}
			body.append(rosterWrap);
			// Friends online with INVITE, and FEEDBACK on the game in play.
			if (NeonArcade.accountUi) body.append(NeonArcade.accountUi.partyBlock({ partyCode: sharedCode(), game: mounted?.id ?? null, picked: room.getGame() || quickGame || null }));
			// One game, one decision: the rest of the party screen waits until
			// it has been played.
			if (quickOn) return;

			// -- games -------------------------------------------------------
			const gamesWrap = el("div", { className: "share" });
			gamesWrap.append(el("div", { className: "share-label", textContent: "Game" }));
			const games = NeonArcade.listGames();
			if (!games.length) {
				gamesWrap.append(
					el("div", { className: "share-hint", textContent: "No games are loaded." }),
				);
			}
			for (const game of games) {
				const card = el("button", { className: "party-game" });
				card.append(
					el("div", { className: "party-game-name", textContent: game.name }),
					el("div", { className: "party-game-blurb", textContent: game.blurb }),
				);
				const problem = NeonArcade.checkRoster(game, room.getMembers());
				if (problem) {
					card.append(el("div", { className: "party-game-warn", textContent: problem }));
				}
				card.disabled = !isHost || !!problem;
				card.onclick = async () => {
					// Over a running game, switching ends it for everyone.
					if (mounted && mounted.id !== game.id) {
						const was = NeonArcade.getGame(mounted.id)?.name ?? "the game";
						const ok = await NeonArcade.ask(`Switch to ${game.name}? This ends ${was} for everyone.`, {
							ok: "SWITCH",
							cancel: "KEEP PLAYING",
						});
						if (!ok || !room.isHost()) return;
					}
					room.setGame(game.id);
				};
				gamesWrap.append(card);
			}
			body.append(gamesWrap);

			// -- actions -----------------------------------------------------
			const actions = el("div", { className: "lobby-row" });
			const addBtn = el("button", {
				className: "neon-btn neon-btn--accent",
				textContent: "ADD PLAYER",
			});
			// Deliberately not host-only: whoever is standing next to the new
			// player should be the one doing the scanning.
			addBtn.onclick = () => showInvite();
			actions.append(addBtn);

			if (isHost) {
				const del = el("button", { className: "neon-btn", textContent: "DELETE PARTY" });
				del.onclick = async () => {
					const ok = await NeonArcade.ask("This will end the party for everyone and make them leave. Are you sure?", {
						ok: "DELETE",
						cancel: "CANCEL",
					});
					if (!ok || closed) return;
					setStatus("Party deleted.", "error");
					room.deleteParty();
					showClosed("You deleted the party.");
				};
				actions.append(del);
			}
			const refresh = el("button", {
				className: "neon-btn",
				textContent: "NEW PARTY",
			});
			refresh.onclick = async () => {
				refresh.disabled = true;
				if (await NeonArcade.leaveParty("Leave this party and start a fresh one with a new code?")) {
					NeonArcade.hostNewGame();
				} else refresh.disabled = false;
			};
			actions.append(refresh);
			// A way out like "← Games": lobby.js asks, leaves, then goes.
			const portal = el("a", {
				className: "neon-btn",
				textContent: "GAMES",
				href: "./",
				"data-leaves": "",
			});
			actions.append(portal);
			body.append(actions);

			if (invitePanel) body.append(invitePanel);
		}

		// ------------------------------------------------------ player colour

		// The room our saved colour was offered to (once each: net.js says it
		// again while the host's record disagrees, _reassert).
		let colorRoom = null;
		// The swatch that had the focus before a rebuild (render).
		let colorFocus = null;
		/** Offer this device's colour to the party, once per room, once we are on its record. */
		function offerColor() {
			if (!room || closed || colorRoom === room || !room.self()) return;
			colorRoom = room;
			const want = savedColor();
			const r = room;
			// Not inside the party event that called us: on the host, setMeta commits.
			if (want !== null && r.self()?.colorWant !== want) queueMicrotask(() => r === room && !closed && r.setMeta({ colorWant: want }));
		}
		/** Pick colour `i`: remembered on this device, and asked of the party. */
		function pickColor(i) {
			try {
				localStorage.setItem(COLOR_KEY, String(i));
			} catch {}
			// Not yet on the record: offerColor sends the saved pick once we are.
			if (!room?.self()) return;
			colorRoom = room;
			room.setMeta({ colorWant: i });
		}
		/**
		 * The colour picker: a swatch per player colour, each 44px with its
		 * name's letter (and its name to a screen reader), yours pressed. One
		 * a person picked before you is marked taken: picking it still asks,
		 * and you have the nearest free one until it is free (assignColors).
		 */
		function colorPicker() {
			const me = room.self();
			const names = colorNames();
			const members = room.getMembers();
			const holder = (i) => members.find((m) => m.id !== room.selfId && m.color === i);
			// Taken: what a pick of it would not get you now — the host's record
			// settled again with that wish (net.js assignColors): a colour an
			// earlier picker holds (their wish or a stand-in), or a bot's
			// mid-game. One a person was only given is not: picking takes it.
			const live = !!room.getGame();
			const wouldGet = (i) => {
				const copy = members.map((m) => ({ ...m, ...(m.id === room.selfId ? { colorWant: i, colorAt: undefined } : {}) }));
				NeonArcade.assignColors?.(copy, { live });
				return copy.find((m) => m.id === room.selfId)?.color;
			};
			const wrap = el("div", { className: "color-pick" });
			const row = el("div", { className: "color-swatches", role: "group" });
			row.setAttribute("aria-label", "Your colour");
			for (let i = 0; i < names.length; i++) {
				const who = holder(i);
				const taken = !!who && me?.color !== i && wouldGet(i) !== i;
				const b = el("button", { className: "color-swatch" + (taken ? " is-taken" : ""), type: "button" });
				b.style.setProperty("--swatch", `var(--p${i + 1})`);
				b.dataset.color = String(i);
				b.setAttribute("aria-pressed", String(me?.color === i));
				b.setAttribute("aria-label", taken ? `${names[i]}, taken by ${who.name}` : names[i]);
				if (taken) b.title = `${names[i]}: ${who.name} has it`;
				b.append(el("span", { className: "color-glyph", textContent: names[i][0], "aria-hidden": "true" }));
				b.onclick = () => pickColor(i);
				row.append(b);
				if (colorFocus === String(i)) queueMicrotask(() => b.isConnected && b.focus());
			}
			const want = me?.colorWant;
			let says = Number.isInteger(me?.color) ? `You are ${names[me.color]}.` : "Pick your colour.";
			if (Number.isInteger(want) && Number.isInteger(me?.color) && want !== me.color) {
				const first = holder(want);
				says = `${names[want]} is taken${first ? ` by ${first.name}` : ""}: you are ${names[me.color]} until it is free.`;
			}
			wrap.append(el("div", { className: "share-label color-label", textContent: "Your colour" }), row, el("div", { className: "share-hint color-says", textContent: says }));
			return wrap;
		}

		// ------------------------------------------------------- quick start

		/**
		 * Who plays where when the quick game starts: the rule game pages always
		 * had. The host is Team A. A one-against-one game seats the first other
		 * member on B and the rest watch; a bigger team game deals the others
		 * out alternately (B first, so the host's side is not simply
		 * outnumbered); any other game seats everyone on one side — except
		 * one person and bots in a free game, dealt out like a team game, so a
		 * game with a teams mode of its own (Bubble Rush) can be played that
		 * way alone (2026-11-17). Past the game's seats, the rest watch.
		 */
		function quickTeams(game) {
			const hostId = room.hostId();
			const teams = new Map([[hostId, "A"]]);
			const others = room.getMembers().map((m) => m.id).filter((id) => id !== hostId);
			const solo = others.every((id) => NeonArcade.isBotId(id));
			others.forEach((id, seat) => {
				let team;
				if (seat + 1 >= game.seats.max) team = "spectator";
				else if (game.shape === "teams" && game.seats.max === 2) team = seat === 0 ? "B" : "spectator";
				else if (game.shape === "teams" || (game.shape === "free" && solo)) team = seat % 2 === 0 ? "B" : "A";
				else team = "A";
				teams.set(id, team);
			});
			return teams;
		}

		// ------------------------------------------------------- quick table
		//
		// SINGLE PLAYER of a game whose seats leave a choice opens on its table
		// (Lokesh, 2026-11-17, "Quick table before start"): how many play —
		// you, and bots in the other seats — and, in a game that takes them
		// (manifest "sameDevice"), which seats are people beside you, passed
		// the phone on their turns. Such a seat is a bot to the party marked
		// `local` (room.setBotMeta), and the game is told (lib/sdk-managed.js).
		// The table is remembered per game (written at START, and as it is
		// changed while you are the one person here).
		//
		// Since 2026-11-21 (Lokesh: "when a user clicks on a game, directly
		// take to the single-player game page") a card's tap starts the
		// remembered table at once (?mode=bots&start=1, like PLAY SOMETHING),
		// so the table is never passed through before a game. It is reached
		// instead from CHANGE PLAYERS — the end card's (lib/sdk-managed.js) or
		// the party screen's over a running game — which ends the game and
		// shows the table, and in the party lobby for the game (PLAY WITH
		// FRIENDS), whose ADD BOT and REMOVE BOT set the seats (remembered
		// while you are the one person there), and a friend takes a bot's.

		const TABLE_KEY = "neon.table"; // { [game id]: { n, people: [seat index…] } }
		/** Does SINGLE PLAYER of `game` open on the table? Not for a one-device game, a people-only one, or a fixed number of seats. */
		const hasTable = (game) => !game.local && game.bots !== false && game.seats.max > game.seats.min;
		const tableRange = (game) => [game.seats.min, Math.min(game.seats.max, room?.maxMembers ?? 8)];
		const tablesSaved = () => {
			try {
				const all = JSON.parse(localStorage.getItem(TABLE_KEY) ?? "{}");
				return all && typeof all === "object" && !Array.isArray(all) ? all : {};
			} catch {
				return {};
			}
		};
		/** The table last started for `game`, or its smallest: { n, people }. */
		function savedTable(game) {
			const t = tablesSaved()[game.id];
			const [lo, hi] = tableRange(game);
			const n = Number.isInteger(t?.n) ? Math.min(hi, Math.max(lo, t.n)) : lo;
			const people = game.sameDevice && Array.isArray(t?.people) ? t.people.filter((i) => Number.isInteger(i) && i > 0 && i < n) : [];
			return { n, people };
		}
		function saveTable(game) {
			const members = room.getMembers();
			const all = tablesSaved();
			// A random pick's start keeps the PERSON seats chosen for this game.
			const people = botsOnly ? (all[game.id]?.people ?? []) : members.flatMap((m, i) => (m.local === true ? [i] : []));
			all[game.id] = { n: members.length, people };
			try {
				localStorage.setItem(TABLE_KEY, JSON.stringify(all));
			} catch {}
		}
		/** Seat `n`: bots join, or the last ones go. */
		function setTableSize(game, n) {
			const [lo, hi] = tableRange(game);
			n = Math.min(hi, Math.max(lo, n));
			let have = room.getMembers().length;
			while (have < n && room.addBot()) have++;
			const bots = room.getMembers().filter((m) => NeonArcade.isBotId(m.id));
			while (have > n && bots.length) {
				room.removeMember(bots.pop().id);
				have--;
			}
		}
		/**
		 * The lobby's seat count (PLAY WITH FRIENDS, or a card's MULTI-PLAYER):
		 * how many play, people and bots, as the host last set it (the stepper,
		 * ADD BOT, REMOVE BOT) or found it. A friend who joins takes a bot's
		 * seat rather than one more (fitTable): a two-seat game that was you
		 * and a bot is you and your friend, not a friend left watching.
		 */
		let seatTarget = 0;
		const humans = () => room.getMembers().filter((m) => !NeonArcade.isBotId(m.id)).length;
		function fitTable() {
			if (!seatTarget || !room || closed || mounted || !quick || quickMode !== "friends" || !room.isHost()) return;
			const bots = room.getMembers().filter((m) => NeonArcade.isBotId(m.id));
			let over = room.getMembers().length - Math.max(seatTarget, humans());
			while (over-- > 0 && bots.length) room.removeMember(bots.pop().id);
		}
		/** Is there a game played alone whose seats CHANGE PLAYERS may show: the host, nobody else here, a game with a table. */
		function canChangePlayers() {
			const game = mounted ? NeonArcade.getGame(mounted.id) : null;
			return !!game && !!room && !closed && !lost && room.isHost() && !othersHere(room) && hasTable(game);
		}
		/** CHANGE PLAYERS: end the game played alone and show its table; START GAME plays it. */
		function changePlayers() {
			if (!canChangePlayers()) return;
			quickGame = mounted.id;
			quick = true;
			quickMode = "bots";
			quickGoing = startNow = false;
			pendingMode = null;
			room.setGame(null);
			syncGame();
			focusQuick();
		}
		/**
		 * PLAY WITH FRIENDS from a game played alone (Lokesh, 2026-11-21: one
		 * tap on a card starts the game against bots, "it has a button at
		 * bottom to rather play with friends"; 2026-11-22: "Bottom, between
		 * rounds"). Where: the bottom of the end card (lib/sdk-managed.js)
		 * and of the shell's start screens, and during play the party screen
		 * pulled up over the game (PARTY) — never a bar over or under the
		 * game, so a board keeps its whole height. For the host alone with
		 * bots (gone once a person is in the party), online, in a game not
		 * played on one phone.
		 */
		function canPlayWithFriends() {
			const game = mounted ? NeonArcade.getGame(mounted.id) : null;
			return !!game && !game.local && !!room && !closed && !lost && room.isHost() && !othersHere(room) && navigator.onLine !== false;
		}
		/**
		 * End the game played alone and open the party lobby for that game —
		 * the code, INVITE A FRIEND, the seats (its bots stay, and friends
		 * take their seats), START GAME.
		 */
		function playWithFriends() {
			if (!canPlayWithFriends()) return;
			quickGame = mounted.id;
			quick = true;
			quickMode = "friends";
			quickGoing = startNow = false;
			pendingMode = null;
			// Nobody beside you any more: their seats go back to the bots.
			for (const m of room.getMembers()) if (NeonArcade.isBotId(m.id)) setPerson(m, false);
			seatTarget = room.getMembers().length;
			room.setGame(null);
			syncGame();
			ensureCode();
			focusQuick();
		}
		/** After CHANGE PLAYERS or PLAY WITH FRIENDS: the keyboard lands on the screen's first control, not on a button that is gone. */
		const focusQuick = () => queueMicrotask(() => body.querySelector(".party-quick button:not(:disabled), .party-quick [tabindex]")?.focus());
		/** A bot seat `m` played by a person beside you, or a bot again. */
		const setPerson = (m, on) => {
			if ((m.local === true) === on) return;
			if (on) peopleMine = true;
			room.setBotMeta?.(m.id, { local: on });
		};
		// PERSON seats are this page's own choice, made at the quick table or
		// on the roster, and hold only while it hosts and is the one person
		// here (review, 2026-11-17): a second person, or the crown moving to
		// another phone (whose page never chose them), turns them back into
		// bots. Run on every party change (roomOpts onParty).
		let peopleMine = false;
		function tidyPeople() {
			if (!room || closed || !room.isHost()) return;
			const marked = room.getMembers().filter((m) => NeonArcade.isBotId(m.id) && m.local === true);
			if (!marked.length || (peopleMine && !othersHere(room))) return;
			for (const m of marked) room.setBotMeta?.(m.id, { local: false });
		}
		/** The games that seat people at bot seats, by name ("Neon Fission"). */
		const sameDeviceNames = () => NeonArcade.listGames().filter((g) => g.sameDevice).map((g) => titleOf(g.id));
		/** "You, 1 person beside you and 2 bots"; in the lobby, "You, 2 friends and 1 bot". */
		function tableSays() {
			const bots = room.getMembers().filter((m) => NeonArcade.isBotId(m.id));
			const people = bots.filter((m) => m.local === true).length;
			const friends = humans() - 1;
			const n = bots.length - people;
			const parts = ["You"];
			if (friends > 0) parts.push(`${friends} friend${friends === 1 ? "" : "s"}`);
			if (people) parts.push(`${people} ${people === 1 ? "person" : "people"} beside you`);
			if (n) parts.push(`${n} bot${n === 1 ? "" : "s"}`);
			if (parts.length === 1) return "Just you";
			return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
		}
		// The table's live region, kept out of the screen rebuilt on every
		// roster change, so a change is announced once (and is announced).
		const quickLive = el("div", { className: "visually-hidden", role: "status" });
		shell.append(quickLive);
		const announce = () => (quickLive.textContent = `${room.getMembers().length} players. ${tableSays()}.`);
		// The table control that had the focus before a rebuild (render).
		let qtFocus = null;
		// PLAY SOMETHING is starting the remembered table: not drawn meanwhile.
		let quickGoing = false;

		/**
		 * Players − n +: from `lo` to `hi` seats, bots joining or going as it
		 * moves; `after()` once a step has landed. A labelled group: arrow
		 * keys, Home and End.
		 */
		function stepperOf(game, lo, hi, after) {
			const n = room.getMembers().length;
			const stepper = el("div", { className: "quick-stepper", role: "group" });
			stepper.setAttribute("aria-label", "Players");
			const count = el("span", { className: "quick-n", id: "quick-n", textContent: String(n) });
			const stepBtn = (key, text, label, d, off) => {
				const b = el("button", { className: "quick-step", type: "button", textContent: text, disabled: off });
				b.dataset.qt = key;
				b.setAttribute("aria-label", label);
				b.setAttribute("aria-describedby", "quick-n");
				b.onclick = () => step(d);
				return b;
			};
			const step = (d) => {
				const now = room.getMembers().length;
				const to = d === -Infinity ? lo : d === Infinity ? hi : Math.min(hi, Math.max(lo, now + d));
				if (to === now) return;
				setTableSize(game, to);
				after?.();
				announce();
			};
			stepper.addEventListener("keydown", (e) => {
				const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, Home: -Infinity, End: Infinity }[e.key];
				if (!d) return;
				e.preventDefault();
				step(d);
			});
			stepper.append(
				el("span", { className: "quick-label", textContent: "Players", "aria-hidden": "true" }),
				stepBtn("minus", "−", "One player fewer", -1, n <= lo),
				count,
				stepBtn("plus", "+", "One player more", 1, n >= hi),
			);
			return stepper;
		}

		/** The table: Players − n +, START GAME, then the seats, named and coloured. */
		function tableBlock(game, wrap, start, problem) {
			const [lo, hi] = tableRange(game);
			const members = room.getMembers();
			sub.textContent = game.sameDevice
				? "On this phone: you, bots, and anyone beside you. Set the table, then start."
				: "You and the bots, on this phone. Choose how many play, then start.";
			wrap.classList.add("quick-table");
			botsOnly = false; // a table on screen is the one that starts
			// Remembered as it changes, not only at START: CHANGE PLAYERS then
			// PLAY WITH FRIENDS instead still keeps it.
			const remember = () => !othersHere(room) && saveTable(game);
			const stepper = stepperOf(game, lo, hi, remember);

			const says = el("div", { className: "share-hint party-bots-count", textContent: tableSays() });
			const row = el("div", { className: "lobby-row quick-go" });
			row.append(start);

			const list = el("ol", { className: "quick-seats" });
			list.setAttribute("aria-label", "Seats");
			members.forEach((m, i) => {
				const isBot = NeonArcade.isBotId(m.id);
				const person = isBot && m.local === true;
				const li = el("li", { className: "quick-seat" + (person ? " is-person" : "") });
				li.style.setProperty("--seat", seatColor(m, i));
				const who = m.id === room.selfId ? m.name || "You" : person ? `Player ${i + 1}` : m.name;
				li.append(el("span", { className: "quick-dot", "aria-hidden": "true" }), el("span", { className: "quick-who", textContent: who }));
				if (!isBot) li.append(el("span", { className: "party-tag", textContent: "YOU" }));
				else if (game.sameDevice) {
					const seg = el("span", { className: "quick-seg", role: "group" });
					seg.setAttribute("aria-label", `Seat ${i + 1}`);
					for (const [text, on] of [["BOT", false], ["PERSON", true]]) {
						const b = el("button", { className: "quick-seg-btn", type: "button", textContent: text });
						b.dataset.qt = `seat${i}-${on ? "person" : "bot"}`;
						b.setAttribute("aria-pressed", String(person === on));
						b.onclick = () => {
							if (person === on) return;
							setPerson(m, on);
							remember();
							announce();
						};
						seg.append(b);
					}
					li.append(seg);
				} else li.append(el("span", { className: "party-tag is-bot", textContent: "BOT" }));
				list.append(li);
			});

			wrap.append(stepper, says, row, list, colorPicker());
			if (game.sameDevice) {
				wrap.append(el("div", { className: "share-hint", textContent: "Someone beside you? Make their seat PERSON and pass them the phone on their turn." }));
			}
			// Friends need a network; offline the table is bots (and people here) only.
			if (navigator.onLine !== false) {
				const other = el("button", { className: "party-switch", textContent: "Play with friends instead" });
				other.onclick = () => {
					// Nobody beside you any more: their seats go back to the bots.
					for (const m of room.getMembers()) if (NeonArcade.isBotId(m.id)) setPerson(m, false);
					quickMode = "friends";
					seatTarget = room.getMembers().length;
					ensureCode();
					render();
				};
				wrap.append(other);
			}
			if (problem) wrap.append(el("div", { className: "share-hint", textContent: problem }));
			body.append(wrap);
			keepQtFocus(wrap);
		}
		/** Keep the focus on the table control in use across the rebuild; a stepper button that just went disabled hands it to the other. */
		function keepQtFocus(wrap) {
			if (!qtFocus) return;
			let to = wrap.querySelector(`[data-qt="${qtFocus}"]`);
			if (to?.disabled) to = wrap.querySelector(`[data-qt="${qtFocus === "plus" ? "minus" : "plus"}"]`);
			to?.focus();
		}

		function quickBlock() {
			const game = NeonArcade.getGame(quickGame);
			const botsAllowed = game.bots !== false && !game.local;
			const min = game.seats?.min ?? 2;
			const max = game.seats?.max ?? 8;
			const wrap = el("div", { className: "share party-quick" });
			const row = el("div", { className: "lobby-row" });
			const button = (text, onClick, accent = false) => {
				const b = el("button", { className: "neon-btn" + (accent ? " neon-btn--accent" : ""), textContent: text });
				b.onclick = onClick;
				return b;
			};
			const teams = quickTeams(game);
			const members = room.getMembers().map((m) => ({ ...m, team: teams.get(m.id) ?? m.team }));
			const problem = NeonArcade.checkRoster(game, members);
			const start = button(game.local ? "START" : "START GAME", () => startQuick(), true);
			start.disabled = !!problem;
			const seated = members.filter((m) => m.team !== "spectator").length;
			// A person already here (in by the party code) is playing with friends.
			if (!quickMode && members.some((m) => m.id !== room.selfId && !NeonArcade.isBotId(m.id))) quickMode = "friends";
			const startQuick = () => {
				const table = quickMode === "bots" && hasTable(game);
				if (table) saveTable(game);
				// PERSON seats start only from the table: shown, or the one last
				// played that a tap starts (Lokesh, 2026-11-22: "Yes, reuse the
				// table" — a group passing one phone just taps and plays).
				if (!table) for (const m of room.getMembers()) if (NeonArcade.isBotId(m.id)) setPerson(m, false);
				const now = quickTeams(game);
				for (const [id, team] of now) if (room.getMember(id)?.team !== team) room.setTeam(id, team);
				quick = false;
				room.setGame(game.id);
			};
			const withBots = (go = false) => {
				quickMode = "bots";
				if (hasTable(game)) {
					// From a card: the table first, unless PLAY SOMETHING said
					// start — then it is never drawn, not even for a frame.
					go = quickGoing = go && startNow;
					startNow = false;
					// The table as it was last played (or the smallest), PERSON
					// seats included, whether it is drawn or a tap starts it —
					// but a random pick (PLAY SOMETHING) seats bots only.
					const t = savedTable(game);
					setTableSize(game, t.n);
					const people = botsOnly && quickGoing ? [] : t.people;
					room.getMembers().forEach((m, i) => NeonArcade.isBotId(m.id) && setPerson(m, people.includes(i)));
				} else {
					// Enough bots to make the game legal: the common case is one tap.
					let n = room.getMembers().length;
					while (n < min && n < max && room.addBot()) n++;
				}
				// Arrived by PLAY WITH BOTS: straight into the game. Outside this
				// render, which is still building the screen being replaced.
				if (go && !NeonArcade.checkRoster(game, room.getMembers().map((m) => ({ ...m, team: quickTeams(game).get(m.id) ?? m.team })))) {
					queueMicrotask(() => room && !closed && quick && startQuick());
				} else quickGoing = false;
				render();
			};
			const withFriends = () => {
				quickMode = "friends";
				seatTarget = room.getMembers().length;
				ensureCode();
				render();
			};
			const labels = NeonArcade.playLabels(game);
			const botLabel = labels.solo;
			if (pendingMode && !quickMode) {
				const m = pendingMode;
				pendingMode = null;
				if (m === "bots" && botsAllowed) return void withBots(autoStart);
				if (m === "friends") return void withFriends();
			}
			// The lobby's seats are a table too: remembered for the game while
			// you are the one person here, so the next tap on its card plays it.
			const remember = () => quickMode === "friends" && hasTable(game) && !othersHere(room) && saveTable(game);
			const botControls = () => {
				// The lobby's seat count follows them (fitTable).
				const add = button("ADD BOT", () => {
					seatTarget = room.getMembers().length + 1; // first: fitTable keeps the bot
					if (!room.addBot()) seatTarget = room.getMembers().length;
					remember();
				});
				add.disabled = seated >= max || room.getMembers().length >= room.maxMembers;
				const bots = room.getMembers().filter((m) => NeonArcade.isBotId(m.id));
				const drop = button("REMOVE BOT", () => {
					room.removeMember(bots.at(-1).id);
					seatTarget = room.getMembers().length;
					remember();
				});
				drop.disabled = !bots.length;
				return [add, drop];
			};

			if (game.local && autoStart && !problem) {
				autoStart = false;
				queueMicrotask(() => room && !closed && quick && startQuick());
			}
			if (game.local) {
				sub.textContent = "Played on this one device. Gather round and pass it along.";
				row.append(start);
			} else if (!quickMode) {
				sub.textContent = botsAllowed
					? "On this device against bots, or with friends on theirs — no server, no sign-up."
					: "With friends on their own phones — no server, no sign-up.";
				row.classList.add("party-choice");
				if (botsAllowed) row.append(button(botLabel, () => withBots(), true));
				row.append(button(labels.multi, withFriends, true));
			} else if (quickMode === "bots" && hasTable(game) && !quickGoing) {
				return void tableBlock(game, wrap, start, problem);
			} else if (quickMode === "bots") {
				sub.textContent = min <= 1 ? "Just you — add bots if you want company." : "You against the bots. Add or remove them, then start.";
				row.append(...botControls(), start);
				const nBots = room.getMembers().filter((m) => NeonArcade.isBotId(m.id)).length;
				wrap.append(el("div", { className: "share-hint party-bots-count", textContent: nBots ? `You and ${nBots} bot${nBots === 1 ? "" : "s"}` : "Just you" }));
				const other = el("button", { className: "party-switch", textContent: "Play with friends instead" });
				other.onclick = withFriends;
				wrap.append(row, colorPicker(), other);
				if (problem) wrap.append(el("div", { className: "share-hint", textContent: problem }));
				body.append(wrap);
				return;
			} else {
				sub.textContent = "Share the code below, or send an invite. Bots can fill empty seats.";
				// The seats: ADD BOT and REMOVE BOT (the contract the suites
				// and validate-game drive), and who is at the table. A friend
				// who joins takes a bot's seat (fitTable).
				if (botsAllowed) {
					row.append(...botControls());
					wrap.classList.add("quick-lobby");
					wrap.append(el("div", { className: "share-hint party-bots-count", textContent: `${room.getMembers().length} players: ${tableSays()}` }));
				}
				if (!invitePanel) {
					row.append(button("INVITE A FRIEND", () => showInvite()));
				}
				row.append(start);
			}
			wrap.append(row);
			if (quickMode && problem) wrap.append(el("div", { className: "share-hint", textContent: problem }));
			body.append(wrap);
			keepQtFocus(wrap);
			if (invitePanel) body.append(invitePanel);
		}

		// ------------------------------------------------------------ invites

		// The invite on screen, withdrawn (its PeerConnection closed) when it is
		// cancelled, replaced or the party ends — not left open for the life of
		// the room.
		let openInvite = null;
		const withdrawInvite = () => {
			openInvite?.withdraw?.();
			openInvite = null;
		};

		async function showInvite() {
			stopScanner?.();
			withdrawInvite();
			invitePanel = el("div", { className: "share" });
			invitePanel.append(
				el("div", { className: "share-label", textContent: "1. Send this invite" }),
				el("div", {
					className: "share-hint",
					textContent:
						"They scan it, or you send the link. Everyone else in the party connects to them automatically afterwards.",
				}),
			);
			render();
			setStatus("Preparing invite…");

			let invite;
			try {
				invite = await room.createInvite();
				openInvite = invite;
			} catch (err) {
				invitePanel = null;
				render();
				return setStatus(err.message, "error");
			}
			setStatus("");

			invitePanel.append(shareBlock({ value: invite.link }));

			invitePanel.append(
				el("div", { className: "share-label", textContent: "2. Take their reply" }),
				el("div", {
					className: "share-hint",
					textContent: "Scan it off their screen, or paste the code they send back.",
				}),
			);
			const reply = NeonArcade.replyEntry({
				room,
				setStatus,
				placeholder: "Paste their reply code…",
				scanPrompt: "Point the camera at their reply code…",
				onConnected: () => {
					setStatus("Connected.", "good");
					openInvite = null; // answered: it is a link now, not an invite
					invitePanel = null;
					render();
				},
			});
			stopScanner = reply.close;

			const cancel = el("button", { className: "neon-btn", textContent: "CANCEL" });
			cancel.onclick = () => {
				reply.close();
				withdrawInvite();
				invitePanel = null;
				render();
			};
			reply.row.append(cancel);
			invitePanel.append(...reply.nodes);
			render();
		}

		// ------------------------------------------------------- terminal ui

		/**
		 * The party split as its host left, and this phone is on a side that
		 * cannot take the crown (net.js _lose; Lokesh, 2026-11-16/17: only the
		 * heir's side — or one holding a quorum — carries on). The game stops
		 * and the screen says so, with TRY AGAIN where a room server may still
		 * reach the others, and LEAVE PARTY. Hidden, not unmounted, for
		 * LOST_KEEP_MS: a phone back in touch within it resumes the game where
		 * it was, its own hidden state (a hand, a sealed bid) included; after
		 * that the game is dropped, and comes back as for any returner.
		 */
		const LOST_KEEP_MS = 60_000;
		let lostDrop = null;
		function showLost(on) {
			if (closed || on === lost) return;
			lost = on;
			if (on) {
				clearTimeout(crownTimer);
				crownTimer = null;
				if (mounted) lostDrop = setTimeout(dropLostGame, LOST_KEEP_MS);
				// Out of the match from here, though its frame is kept a while:
				// a ranked start without a result is withdrawn now (lib/account.js),
				// so leaving or closing the tab while lost is never booked as a
				// departure — the game is not unmounted, so matchEnd will not.
				NeonArcade.account?.partyGone?.();
				container.classList.remove("party-peek");
				peeking = false;
				partyPill.hidden = true;
				container.hidden = false;
				stage.hidden = true;
				NeonArcade.keepAwake(false);
				paintTop();
				NeonArcade.toast("Lost connection to the party.", "warn");
				return render();
			}
			clearTimeout(lostDrop);
			lostDrop = null;
			setStatus("");
			NeonArcade.toast("Back in the party.", "good");
			// The same run of the same game: a new run (the heir started it
			// again meanwhile) is a fresh mount, not the frame we kept.
			if (mounted && room.getGame() === mounted.id && (room.getRun?.() ?? null) === mounted.run) {
				// Kept underneath: shown again, and the host is asked where
				// things stand, as a returner's mounted notice does.
				container.hidden = true;
				stage.hidden = false;
				partyPill.hidden = false;
				NeonArcade.keepAwake(true);
				paintTop();
				if (!room.isHost() && room.hostId()) room.makeAction("p$mounted").send({ game: mounted.id }, { target: room.hostId() });
				return;
			}
			// Anything else the kept frame was running is over.
			dropLostGame(true);
			render();
			syncGame();
		}

		/** Lost for longer than LOST_KEEP_MS (or found on another run): the hidden game goes. */
		function dropLostGame(found = false) {
			lostDrop = null;
			if ((!lost && !found) || !mounted) return;
			try {
				mounted.handle?.unmount?.();
			} catch (err) {
				console.error("unmount failed", err);
			}
			stage.replaceChildren();
			mounted = null;
			paintTop();
		}

		function lostScreen() {
			body.replaceChildren();
			title.textContent = "PARTY";
			sub.textContent = "Lost connection to the party.";
			// Sworn to a candidate we cannot reach (net.js `stranded`): it may
			// have won and carried on out of our reach, or never come back.
			// With a room server, TRY AGAIN may still find it, so it stays,
			// with NEW PARTY beside it; without one, NEW PARTY (and the
			// shell's LEAVE PARTY) is the way on.
			if (room.stranded) {
				body.append(
					el("p", {
						className: "lobby-sub party-lost",
						textContent: room.canRejoin
							? "This phone gave its vote to a player it can't reach. If they carried on, TRY AGAIN may find them; otherwise start a new party."
							: "This phone gave its vote to a player it can't reach, and there is no room server to find them through. Start a new party, or leave.",
					}),
				);
				const row = el("div", { className: "lobby-row" });
				if (room.canRejoin) {
					const again = el("button", { className: "neon-btn neon-btn--accent", textContent: "TRY AGAIN" });
					again.onclick = () => {
						room.rejoin();
						setStatus("Trying to get back in…");
					};
					row.append(again);
				}
				const fresh = el("button", { className: room.canRejoin ? "neon-btn" : "neon-btn neon-btn--accent", textContent: "NEW PARTY" });
				fresh.onclick = async () => {
					if (await NeonArcade.leaveParty?.("Leave this party and start a new one?")) NeonArcade.hostNewGame?.();
				};
				row.append(fresh);
				body.append(row);
				setStatus("This phone can't reach the player it voted for.", "error");
				return;
			}
			const why = el("p", {
				className: "lobby-sub party-lost",
				textContent: room.canRejoin
					? "The rest of the party carries on without this phone, and its game stopped here. Trying to get back in through the room server…"
					: "The rest of the party carries on without this phone, and its game stopped here. There is no room server to find them again through: leave, and ask to be invited back.",
			});
			body.append(why);
			if (room.canRejoin) {
				const row = el("div", { className: "lobby-row" });
				const again = el("button", { className: "neon-btn neon-btn--accent", textContent: "TRY AGAIN" });
				again.onclick = () => {
					room.rejoin();
					setStatus("Trying to get back in…");
				};
				row.append(again);
				body.append(row);
			}
			setStatus("Lost connection to the party.", "error");
		}

		function showClosed(msg, actions = freshPartyRow) {
			closed = true;
			partyCode = null; // an ended party's code is no longer this page's party (src/App.tsx's guard)
			clearTimeout(crownTimer);
			NeonArcade.keepAwake(false);
			container.classList.remove("party-peek");
			peeking = false;
			partyPill.hidden = true;
			stopScanner?.();
			withdrawInvite();
			invitePanel = null;
			container.hidden = false;
			stage.hidden = true;
			if (mounted) {
				// Same reason as syncGame: a game that throws on the way out must
				// not leave this screen half-drawn.
				try {
					mounted.handle?.unmount?.();
				} catch (err) {
					console.error("unmount failed", err);
				}
				stage.replaceChildren();
				mounted = null;
			}
			title.textContent = "PARTY";
			sub.textContent = msg;
			actions();
			setStatus(msg, "error");
		}

		/**
		 * Another tab of this browser reconnected with our rejoin token and
		 * has the seat now (room-join's `displaced`), or holds the seat this
		 * page was about to give back (releaseRejoin's `busy` — a live page,
		 * by its seat lock); this one has already let go of its links and
		 * will not redial — two tabs taking turns would each knock the other
		 * off every second. USE IT HERE is the reload the other tab made:
		 * this page reconnects with the token and the *other* one lands here
		 * instead. Without `fresh` in the address, or the reload would only
		 * come back to this screen.
		 *
		 * No START A NEW PARTY: it gives back the claim the token names, and
		 * that claim is the other tab's live seat now. (Pressed on a RETRY
		 * screen while another tab holds the seat, it lands here too —
		 * startFresh.)
		 */
		function showDisplaced() {
			showClosed("This party is open in another tab.", () => {
				body.replaceChildren();
				const row = el("div", { className: "lobby-row" });
				const here = el("button", {
					className: "neon-btn neon-btn--accent",
					textContent: "USE IT HERE",
				});
				here.onclick = () => {
					here.disabled = true;
					// The hash would make the boot join by code, not reconnect.
					NeonArcade.clearHash();
					dropFreshFlags();
					location.reload();
				};
				row.append(here);
				body.append(row);
			});
		}

		/**
		 * Leave whatever this page still holds and start over. A join still
		 * in flight is cancelled — which hands its seat back — and a claim
		 * left over from a rejoin nobody answered is given back too, so the
		 * old party does not keep a seat for a browser that has moved on.
		 */
		async function startFresh() {
			if ((await forgetSeat()) === "busy") {
				// The token's seat is live in another tab of this browser.
				// Releasing it would knock that tab out of its party, and a
				// new party here would overwrite the token both tabs share —
				// the other tab's next reload would land in *this* party. So
				// nothing is started: this tab says where the party is, and
				// offers to take it over instead.
				return showDisplaced();
			}
			NeonArcade.hostNewGame();
		}

		/**
		 * Give back the seat this page still claims without a live room: a
		 * join in flight is cancelled (which hands its seat back), else the
		 * token's claim is released. Resolves releaseRejoin's answer — "busy"
		 * when a live page of this browser holds that seat, which keeps it.
		 */
		async function forgetSeat() {
			let outcome = "released";
			if (joining) {
				joining.ctl.abort();
				await joining.done.catch(() => {});
			} else outcome = await NeonArcade.releaseRejoin?.();
			// The leave is in flight; let it land before unloading.
			await NeonArcade.roomSettled?.();
			return outcome;
		}

		/** A START A NEW PARTY row, with whatever message goes above it. */
		function freshPartyRow() {
			body.replaceChildren();
			const row = el("div", { className: "lobby-row" });
			const fresh = NeonArcade.hostNewGameButton("START A NEW PARTY");
			fresh.onclick = () => {
				fresh.disabled = true;
				startFresh();
			};
			row.append(fresh, el("a", { className: "neon-btn", textContent: "GAMES", href: "./", "data-leaves": "" }));
			body.append(row);
			return row;
		}

		/**
		 * Run a room-server join cancellably: START A NEW PARTY pressed while
		 * it is still meeting the party aborts it rather than leaving its
		 * claim behind.
		 */
		function trackedJoin(joinCode) {
			const ctl = new AbortController();
			const done = NeonArcade.joinRoom(joinCode, { ...roomOpts(), signal: ctl.signal });
			joining = { ctl, done };
			const clear = () => {
				if (joining?.done === done) joining = null;
			};
			done.then(clear, clear);
			return done;
		}

		/**
		 * A join through the room server failed. Say why in the party's own
		 * words, and offer a way on: RETRY when the failure is the network's
		 * (the party may well still be there) or `canRetry` says so, a fresh
		 * party either way.
		 */
		function showJoinFailed(err, retry, canRetry = false) {
			title.textContent = "PARTY";
			setStatus(JOIN_ERRORS[err?.reason] ?? err?.message ?? String(err), "error");
			const row = freshPartyRow();
			if (canRetry || RETRYABLE.has(err?.reason)) {
				const again = el("button", {
					className: "neon-btn neon-btn--accent",
					textContent: "RETRY",
				});
				again.onclick = retry;
				row.prepend(again);
			}
		}

		// ---------------------------------------------------------- wiring up

		function roomOpts() {
			return {
				name: savedName() || NeonArcade.defaultName(),
				// A full party opened to friends (PLAY WITH FRIENDS from an
				// eight-seat table) takes a newcomer in place of its newest
				// bot, never over a running game (net.js createInvite,
				// _addMember).
				// `now`: give the seat up (the newcomer is being admitted);
				// else only say whether one would be (the invite is made).
				// `reserved`: seats outstanding invites already count on.
				yieldBot: (now, reserved = 0) => {
					if (!room || closed || mounted || room.getGame() || !room.isHost()) return false;
					const bots = room.getMembers().filter((m) => NeonArcade.isBotId(m.id));
					if (!now) return bots.length > reserved;
					if (!bots.length) return false;
					room.removeMember(bots.at(-1).id);
					return true;
				},
				onParty: () => {
					offerColor();
					tidyPeople();
					fitTable();
					presence.sync(room);
					NeonArcade.account?.attach(room);
					checkCrown();
					render();
					syncGame();
					// A game that is already running wants to know the teams moved.
					mounted?.handle?.onRoster?.();
				},
				onPeerJoin: (id) => {
					presence.sync(room);
					render();
					mounted?.handle?.onPeerJoin?.(id);
				},
				onPeerLeave: (id, info) => {
					presence.left(room, id, info);
					render();
					mounted?.handle?.onPeerLeave?.(id, info);
				},
				onHostVacant: () => {
					presence.sync(room);
					checkCrown();
					render();
				},
				onLost: (on) => showLost(on),
				// Neither is leaving: a ranked match's start is withdrawn (lib/account.js).
				onEvicted: () => (NeonArcade.account?.partyGone?.(), showClosed("You were removed from the party.")),
				onPartyClosed: () => (NeonArcade.account?.partyGone?.(), showClosed("The host closed the party.")),
				// The status line is on the party screen, which a game hides.
				onError: (msg) => {
					setStatus(msg, "error");
					if (mounted) NeonArcade.toast(msg, "warn");
				},
				onDisplaced: () => showDisplaced(),
				// Back from the back/forward cache with the seat free: the boot
				// decides again, by the token, what this page is now.
				onRestored: () => location.reload(),
			};
		}

		/** Someone opened an invite link: answer it and wait to be let in. */
		async function joinFlow(inviteCode) {
			let linked = false;
			const identity = await NeonArcade.identity();
			room = NeonArcade.createGuest({
				...roomOpts(),
				identity,
				onError: (msg, info) => {
					// Our reply's link failed before it ever opened — it was
					// carried back too late, or these networks have no path:
					// say so, and offer a fresh reply (lobby.js replyFailed).
					if (info?.reason === "no-route" && !linked && !closed) {
						const { hint, again } = NeonArcade.replyFailed(setStatus);
						title.textContent = "JOINING";
						const row = freshPartyRow();
						row.prepend(again);
						body.prepend(hint);
						return;
					}
					setStatus(msg, "error");
				},
			});
			room.resume();
			title.textContent = "JOINING";
			sub.textContent = "Send this reply back so they can let you in.";
			body.replaceChildren();
			setStatus("Preparing your reply…");

			let answer;
			try {
				answer = await room.answerInvite(inviteCode);
			} catch (err) {
				room.leave();
				title.textContent = "PARTY";
				sub.textContent = "Ask for a fresh invite — they expire when the inviter reloads.";
				freshPartyRow();
				return setStatus("That invite is not readable: " + err.message, "error");
			}
			setStatus("Waiting for them to accept…");
			body.append(
				shareBlock({
					label: "Your reply code",
					hint: `Show this to whoever invited you, or send it back to them. ${NeonArcade.REPLY_NOW}`,
					value: answer,
				}),
			);

			room.onOpen = () => {
				linked = true;
				// In through an invite, so any rejoin token left over is for some
				// other party — and a later reload must not reconnect to that one.
				// Released rather than just cleared: the old party drops the seat
				// at once, and a token another tab holds live ("busy") is kept.
				NeonArcade.releaseRejoin?.();
				title.textContent = "PARTY";
				setStatus("");
				NeonArcade.clearHash();
				render();
				syncGame();
			};
		}

		/**
		 * Join through the room server: six digits, and the offer that used to
		 * be pasted back by hand arrives over the wire instead. The party
		 * record — roster, teams, the game under way — arrives with the first
		 * link and renders as usual, so joining a party mid-game is the same
		 * DOM swap switching games has always been.
		 *
		 * joinRoom resolves only once a link to the party is open (and rejects
		 * `no-answer` if none opens), so everything until then is honestly
		 * "meeting the party", and a resolve really does mean connected.
		 */
		async function joinCodeFlow(joinCode) {
			codeFailed = false;
			title.textContent = "JOINING";
			sub.textContent = `Joining party ${joinCode}…`;
			body.replaceChildren();
			setStatus("Meeting the party…");
			try {
				const made = await trackedJoin(joinCode);
				room = made.room;
				partyCode = joinCode;
				room.resume();
				// Only on the party's own address: joined while another view
				// shows (Back during the join), clearHash would rewrite that
				// view's entry into a party address.
				if (!NeonArcade.shell || document.body.dataset.view === "party") NeonArcade.clearHash();
				title.textContent = "PARTY";
				setStatus("");
				render();
				syncGame();
				toldJoin(joinCode);
			} catch (err) {
				if (err?.reason === "aborted") return; // START A NEW PARTY is on its way
				toldJoin(joinCode, err);
				if (err?.reason === "displaced") return showDisplaced();
				// The hash stays, so the link that brought us here is still the
				// one RETRY (or a reload) tries again.
				codeFailed = true;
				sub.textContent = `Could not join party ${joinCode}.`;
				showJoinFailed(err, () => joinCodeFlow(joinCode));
			}
		}

		/**
		 * How a code join ended, for the portal's JOIN WITH A CODE
		 * (src/JoinCode.tsx), which stays on screen until then and says why
		 * one failed in place: `neon:code-join` on document, `{ code, ok }`,
		 * and `reason` and `message` when it failed.
		 */
		function toldJoin(code, err) {
			const detail = err ? { code, ok: false, reason: err.reason ?? null, message: JOIN_ERRORS[err.reason] ?? err.message ?? String(err) } : { code, ok: true };
			document.dispatchEvent(new CustomEvent("neon:code-join", { detail }));
		}
		// A code join failed, and nothing has happened since: another code may
		// be tried in place (joinCode, below), with no page load.
		let codeFailed = false;

		/**
		 * This browser was in a party and its token is still live — the
		 * reload case the room server exists for. It reconnects on its own:
		 * the same member id returns, the seat was held, the team comes back
		 * with it. A visible way out, because "automatic" must never mean
		 * "inescapable" — and the way out is a reload rather than a second
		 * host flow, so the two can never race to own this page.
		 */
		async function reconnectFlow(token) {
			title.textContent = "PARTY";
			sub.textContent = `Reconnecting to party ${token.code}…`;
			// START A NEW PARTY goes through hostNewGame, which drops the token
			// first, so "start fresh" means it.
			freshPartyRow();
			setStatus("Reconnecting…");
			try {
				const made = await trackedJoin(token.code);
				room = made.room;
				partyCode = token.code;
				room.resume();
				setStatus("");
				render();
				syncGame();
				toldJoin(token.code); // a code typed for the party we hold a seat in
			} catch (err) {
				if (err?.reason === "aborted") return; // START A NEW PARTY is on its way
				toldJoin(token.code, err);
				if (err?.reason === "displaced") return showDisplaced();
				// Only an answer that says the seat is gone ends the claim. A
				// network that failed us says nothing about the party, so the
				// token is kept for RETRY — or for the next reload.
				if (SEAT_GONE.has(err?.reason)) NeonArcade.clearRejoinToken?.();
				// Nobody answering a rejoin is either a slow party or one that
				// ended — a lone host who reloaded has nobody to answer them.
				// RETRY covers the first, START A NEW PARTY the second; say
				// both, so neither reads as a dead end.
				const silent = err?.reason === "no-answer";
				sub.textContent = silent
					? `Nobody from party ${token.code} answered. It may have ended — start a new party, or retry if they are still playing.`
					: `Could not reconnect to party ${token.code}.`;
				showJoinFailed(err, () => reconnectFlow(token), silent);
			}
		}

		/**
		 * Give a party hosted without the room server (autoStart) its code,
		 * once friends are wanted: PLAY WITH FRIENDS, or the party screen after
		 * the bots game. A room-server room cannot be grafted onto a live one,
		 * so while it is still just us and bots the party is hosted again
		 * through the server and the bots re-seated — nothing anyone could
		 * lose. Never with another person here, or a game running: they would
		 * be dropped, so that party keeps its classic invite. A failed probe
		 * waits 30 s before the next try (net.js caches only success).
		 */
		let coding = null;
		let codeTriedAt = 0;
		const othersHere = (r) => r.getMembers().some((m) => m.id !== r.selfId && !NeonArcade.isBotId(m.id));
		// An invite on screen is bound to this room (its reply box answers it),
		// so a party with one open is left alone until it closes.
		const inviting = () => !!(invitePanel || openInvite);
		function ensureCode() {
			if (!skippedServer || coding || partyCode || !room || closed || mounted || room.getGame() || !NeonArcade.hostRoom) return;
			if (!room.isHost() || othersHere(room) || inviting() || Date.now() - codeTriedAt < 30_000) return;
			codeTriedAt = Date.now();
			coding = (async () => {
				// The token names a seat a live page of this browser holds (a
				// SINGLE PLAYER started beside it): hosting would write this
				// party's token over it, and that page's next reload would walk
				// in here. So no code while it lasts; the classic invite stays,
				// and the next ask (30 s on) looks again.
				const saved = NeonArcade.rejoinToken?.();
				if (saved && (await NeonArcade.seatHeld?.(saved.id))) return;
				if (!(await NeonArcade.roomServerReachable?.())) return;
				const old = room;
				let made;
				try {
					made = await NeonArcade.hostRoom(roomOpts());
				} catch {
					return;
				}
				// Things moved while we dialled: someone came in by invite, a
				// game started, the page was closed. Keep what is here.
				// Not a failure, so no 30 s wait before the next ask.
				if (room !== old || closed || old.closed || mounted || old.getGame() || othersHere(old) || inviting()) {
					codeTriedAt = 0;
					return void made.room.leave();
				}
				const bots = old.getMembers().filter((m) => NeonArcade.isBotId(m.id)).map((m) => m.team);
				room = made.room;
				partyCode = made.code;
				skippedServer = false;
				old.leave();
				room.resume();
				for (const team of bots) room.addBot(team);
				render();
				syncGame();
			})().finally(() => {
				coding = null;
			});
		}

		/**
		 * A `?fresh=1` load is intentionally starting a new party; don't leave
		 * the flag in the URL, or a later reload/bookmark would keep spawning
		 * new parties instead of reconnecting. Only that flag goes (and `mode`
		 * and `start`: a card's choice is for this load, not every reload): `?rs=`
		 * (loopback only) and `?mockroom=` choose the room server and must
		 * outlive it.
		 */
		function dropFreshFlags() {
			const params = new URLSearchParams(location.search);
			if (!["fresh", "mode", "start"].some((k) => params.has(k))) return;
			params.delete("fresh");
			params.delete("mode");
			params.delete("start");
			// The shell is one page (src/router.ts): an address with no party
			// word in it would read as the portal on Back/Forward.
			if (!["game", "dev", "party"].some((k) => params.has(k))) params.set("party", "");
			const query = params.toString();
			try {
				history.replaceState(
					history.state, // src/router.ts keeps its count of the arcade's entries here
					"",
					location.pathname + (query ? "?" + query : "") + location.hash,
				);
			} catch {}
		}

		/**
		 * The game this page plays alone against bots, or null: the host, no
		 * other person, no party code (the party skipped the room server and
		 * has not been given one), not the lobby for friends, a game with bots
		 * that is not played on one phone.
		 */
		function soloBotsGame() {
			if (!room || closed || lost || !room.isHost() || othersHere(room) || partyCode || !skippedServer) return null;
			if (quick && quickMode === "friends") return null;
			const id = mounted?.id ?? (quick ? quickGame : null);
			const g = id ? NeonArcade.getGame(id) : null;
			return g && !g.local && g.bots !== false ? id : null;
		}
		/**
		 * A reload in the middle of a game played alone starts a new one
		 * against bots at once, as the card's tap does (Lokesh, 2026-11-22: "A
		 * fresh bots game"): while this page plays alone, the address is the
		 * tap's, `?game=<id>&fresh=1&mode=bots&start=1`. Once friends are
		 * wanted (the lobby, a party code, another person) the flags go
		 * (dropFreshFlags), so a reload reconnects as before. Only while the
		 * party view shows: another view's address is that view's.
		 */
		function syncAddress() {
			if (NeonArcade.shellView && NeonArcade.shellView(location.href) !== "party") return;
			const id = soloBotsGame();
			if (!id) return dropFreshFlags();
			const params = new URLSearchParams(location.search);
			const want = { game: id, fresh: "1", mode: "bots", start: botsOnly ? "pick" : "1" };
			if (Object.entries(want).every(([k, v]) => params.get(k) === v) && !params.has("party")) return;
			params.delete("party");
			for (const [k, v] of Object.entries(want)) params.set(k, v);
			try {
				history.replaceState(history.state, "", `${location.pathname}?${params}${location.hash}`);
			} catch {}
		}
		// Back on the party view (BACK TO GAME, Back): its address again.
		new MutationObserver(() => document.body.dataset.view === "party" && syncAddress()).observe(document.body, { attributes: true, attributeFilter: ["data-view"] });

		/** Nobody else is coming (PLAY WITH BOTS, a one-device game): host at once, no room server. */
		function startsAtOnce() {
			const qg = quickGame ? NeonArcade.getGame(quickGame) : null;
			return !!qg && (!!qg.local || (pendingMode === "bots" && qg.bots !== false));
		}

		/**
		 * Host the party. Through the room server when it is reachable,
		 * which is what gives the party its code, its rejoin token and its
		 * cross-network legs; classically — an invite, carried by a person —
		 * when it is not, which is the mode the whole arcade ran in before
		 * the room server existed and still does, unchanged.
		 */
		async function hostFlow() {
			if (room) return;
			quick = !!quickGame;
			// The probe and the dial take a moment; say so rather than show
			// an empty page.
			sub.textContent = "Starting the party…";
			setStatus("Starting the party…");
			dropFreshFlags();
			autoStart = startsAtOnce();
			skippedServer = autoStart;
			if (!autoStart && (await NeonArcade.roomServerReachable?.())) {
				try {
					const made = await NeonArcade.hostRoom(roomOpts());
					room = made.room;
					partyCode = made.code;
				} catch {
					// The room server was reachable and then failed us. The
					// party does not need it: fall through and host classically.
					partyCode = null;
				}
			}
			if (!room) room = NeonArcade.createHost({ ...roomOpts(), identity: await NeonArcade.identity() });
			room.resume();
			setStatus("");
			render();
			syncGame();
		}

		// Boot decides what this page load is for. The room-server branches are
		// async because reachability is a probe; the flows themselves render.
		// A `?fresh=1` load means "start a new party" even if a rejoin token is
		// still in localStorage from an old one — hostNewGame already dropped it
		// on the way here, and the flag keeps the boot from looking for it.
		const fresh = new URLSearchParams(location.search).has("fresh");
		const invite = NeonArcade.inviteFromUrl();
		const code = NeonArcade.codeFromUrl?.();
		const token = NeonArcade.rejoinToken?.();
		(async () => {
			// A card's tap (or a one-device game) starts at once: it needs no
			// room server (hostFlow), so nothing here waits on one. A seat
			// this browser still has saved:
			//  - held by a live page of this browser (another tab's party; a
			//    local lock, no network): the bots game starts here anyway
			//    (Lokesh, 2026-11-23: "Start the bots game anyway"), that tab
			//    keeps its party and its token, and a note says so. A reload
			//    here is a fresh bots game (syncAddress), never a reconnect
			//    into that tab's party; no code is hosted over its token
			//    (ensureCode). The blocking "open in another tab" screen stays
			//    for the ways in that would take the seat: START A PARTY, a
			//    code link (#c=), a reconnect, a displaced seat;
			//  - else handed back in the background, only once the room
			//    server answers: offline, or with no server, the token stays
			//    (releaseRejoin clears it even when it could not release it),
			//    so that party can still be rejoined.
			if (fresh && startsAtOnce()) {
				if (token) {
					if ((await NeonArcade.seatHeld?.(token.id)) === true) NeonArcade.toast("Your party is still open in another tab.");
					else if (navigator.onLine !== false) NeonArcade.roomServerReachable?.().then((up) => up && NeonArcade.releaseRejoin?.());
				}
				return hostFlow();
			}
			// A code link to the party this browser already has a seat in is a
			// way back to that seat, not a reason to give it up.
			if (code && !fresh && token?.code === code && NeonArcade.joinRoom) {
				NeonArcade.clearHash();
				return reconnectFlow(token);
			}
			// Moving on from a party this browser still holds a seat in (the
			// portal's START A PARTY, a code link): give the seat back first, or
			// the old party keeps it for the whole grace — and the new party's
			// token would overwrite one another tab may be using live, whose
			// next reload would then land here. An invite waits until it has
			// linked (joinFlow), so an invite that fails costs nothing. `busy`
			// means a live page of this browser holds that seat (room-join's
			// seat lock) — a socket the server still has open is not one.
			if (token && (fresh || code) && !invite && (await NeonArcade.releaseRejoin?.()) === "busy") {
				if (code && !fresh) toldJoin(code, { reason: "displaced", message: "This party is open in another tab." });
				return showDisplaced();
			}
			if (fresh) return hostFlow();
			if (invite) joinFlow(invite);
			else if (code) joinCodeFlow(code);
			// A token means this browser was in a room-server party, so the
			// reconnect is tried even when the probe would fail: an
			// unreachable server then answers "unreachable", which keeps the
			// token and offers RETRY. Probing first instead silently hosted a
			// brand-new party over the one the player was in.
			else if (token && NeonArcade.joinRoom) reconnectFlow(token);
			else hostFlow();
		})();

		// A reply that comes back as a link lands here when it opens in this very
		// tab; anywhere else it would be a fresh document with no room in it.
		//
		// An invite (`#i=`) or a code (`#c=`) link into a tab that already has
		// this page up is a fragment-only navigation, so it reloads into the
		// boot that joins it. Never silently: with a live party here, the player
		// is asked first, and leaves it properly if they go.
		window.addEventListener("hashchange", () => {
			const answer = NeonArcade.answerFromUrl();
			if (answer) {
				if (room && !closed) {
					NeonArcade.clearHash();
					room.acceptAnswer(answer).catch((err) => setStatus(err.message, "error"));
				}
				return;
			}
			const linkCode = NeonArcade.codeFromUrl?.();
			if (!NeonArcade.inviteFromUrl() && !linkCode) return;
			const live = room && !closed && !room.closed;
			if (!live) return location.reload();
			// The code of the party we are already in: nothing to do.
			if (linkCode && linkCode === partyCode) return NeonArcade.clearHash();
			// Asked with the hash cleared, so the back-button guard does not
			// read this forward step as a step back; put back for the reload.
			const hash = location.hash;
			NeonArcade.clearHash();
			NeonArcade.leaveParty("Leave this party and join the other one?").then((go) => {
				if (!go) return;
				history.replaceState(history.state, "", location.pathname + location.search + hash);
				location.reload();
			});
		});

		// Live getters, published as `window.__party` (and as `window.__game`,
		// the name the old game pages used): the tests drive the real
		// screen rather than a rehearsal of it, and these are otherwise closure
		// variables nothing outside can reach. `handle` is what lets a game be
		// tested **through the party shell**, with several real peers — the
		// only place a dealt hand actually crosses a wire.
		return {
			get room() {
				return room;
			},
			get game() {
				return mounted?.id ?? null;
			},
			get handle() {
				return mounted?.handle ?? null;
			},
			/** The party's code, once it has one (the router's guard: a link to this party is not another). */
			get code() {
				return partyCode;
			},
			/**
			 * Is this party still going: a room, not closed by it or by the
			 * host, not removed from, not cut off. (A room object can outlive
			 * the party: removed, its page still holds it.)
			 */
			get live() {
				return !!room && !room.closed && !closed && !lost;
			},
			/**
			 * Would joinCode take `code`: only after a code join failed and
			 * nothing since (else the caller loads the address instead).
			 */
			canJoinCode(code) {
				return codeFailed && !room && !joining && !closed && /^\d{6}$/.test(code ?? "");
			},
			/**
			 * Join party `code` here, with no page load (canJoinCode; else
			 * false). The portal's JOIN WITH A CODE tries the next code so,
			 * its dialog still open. The steps are the boot's.
			 */
			joinCode(code) {
				if (!this.canJoinCode(code)) return false;
				codeFailed = false;
				history.replaceState(history.state, "", `${location.pathname}${location.search}#c=${code}`);
				const token = NeonArcade.rejoinToken?.();
				(async () => {
					if (token?.code === code && NeonArcade.joinRoom) return NeonArcade.clearHash(), reconnectFlow(token);
					if (token && (await NeonArcade.releaseRejoin?.()) === "busy") return toldJoin(code, { reason: "displaced", message: "This party is open in another tab." }), showDisplaced();
					joinCodeFlow(code);
				})();
				return true;
			},
		};
	};
})();
