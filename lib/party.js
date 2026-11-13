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
// Loaded as a traditional script so it works on file:// like everything else.

(() => {
	// Shared with the game-page lobby, which party.html loads first.
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
		// The game a game page sent us here to play (connect4.html redirects to
		// party.html?game=connect4): offered up front — PLAY A BOT, INVITE A
		// FRIEND, START GAME — until it has been started once, then this is an
		// ordinary party (Lokesh, 2026-11-13: game pages are party shortcuts).
		const quickGame = (() => {
			const id = new URLSearchParams(location.search).get("game");
			return id && NeonArcade.getGame(id) ? id : null;
		})();
		let quick = false; // hostFlow sets it: this load hosts a fresh party for quickGame
		let quickTable = false; // PLAY A BOT / INVITE pressed: the table is being set
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
		document.body.append(partyPill);
		// Pending check that the crown really moved under a running game.
		let crownTimer = null;
		// Every way off this page asks first while the party is live (lobby.js).
		// A party a game page opened is "you and the bots" until someone joins:
		// walking off it alone is not asked (see guardParty).
		NeonArcade.guardParty({ room: () => (closed ? null : room), askAlone: () => !quickGame });

		const setStatus = (text, kind) => {
			statusEl.textContent = text;
			statusEl.className = "lobby-status" + (kind ? ` is-${kind}` : "");
		};

		// ------------------------------------------------------ game mounting

		function syncGame() {
			if (closed) return;
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
			partyPill.hidden = !wanted;
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
			try {
				mounted = { id: wanted, handle: game.mount(ctx), host: room.hostId(), ctx };
				const hi = mountedNotice();
				handoverNotice();
				if (!room.isHost() && room.hostId()) hi.send({ game: wanted }, { target: room.hostId() });
			} catch (err) {
				console.error(err);
				mounted = null;
				partyPill.hidden = true;
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

		function render() {
			if (!room || closed) return;
			// Behind a running game nobody can see it, and every roster event
			// (a mark, a meta change, a team move) used to rebuild it all, QR
			// included. setPeek and the game's end both render on the way back.
			if (container.hidden && mounted && !peeking) return;
			// A name being typed survives the rebuild: value, caret and focus.
			const typing = document.activeElement?.dataset?.partyName !== undefined
				? { value: document.activeElement.value, at: document.activeElement.selectionStart, to: document.activeElement.selectionEnd }
				: null;
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
			youWrap.append(nameRow);
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
					const link = location.href.split("#")[0] + "#c=" + partyCode;
					// Encoded once per link, not on every re-render.
					if (codeQr?.link !== link) {
						try {
							const canvas = NeonArcade.qrCanvas(link, {
								scale: 3,
								quiet: 3,
								dark: "#000",
								light: "#fff",
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
				const label = el("div", { className: "party-name" });
				label.append(el("span", { textContent: m.name }));
				if (isBot) {
					label.append(el("span", { className: "party-tag is-bot", textContent: "BOT" }));
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
			}
			body.append(rosterWrap);
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
			// A way out like "← All games": lobby.js asks, leaves, then goes.
			const portal = el("a", {
				className: "neon-btn",
				textContent: "ALL GAMES",
				href: "index.html",
				"data-leaves": "",
			});
			actions.append(portal);
			body.append(actions);

			if (invitePanel) body.append(invitePanel);
		}

		// ------------------------------------------------------- quick start

		/**
		 * Who plays where when the quick game starts: the rule game pages always
		 * had. The host is Team A. A one-against-one game seats the first other
		 * member on B and the rest watch; a bigger team game deals the others
		 * out alternately (B first, so the host's side is not simply
		 * outnumbered); any other game seats everyone on one side. Past the
		 * game's seats, the rest watch.
		 */
		function quickTeams(game) {
			const hostId = room.hostId();
			const teams = new Map([[hostId, "A"]]);
			const others = room.getMembers().map((m) => m.id).filter((id) => id !== hostId);
			others.forEach((id, seat) => {
				let team;
				if (seat + 1 >= game.seats.max) team = "spectator";
				else if (game.shape !== "teams") team = "A";
				else if (game.seats.max === 2) team = seat === 0 ? "B" : "spectator";
				else team = seat % 2 === 0 ? "B" : "A";
				teams.set(id, team);
			});
			return teams;
		}

		function quickBlock() {
			const game = NeonArcade.getGame(quickGame);
			const botsAllowed = game.bots !== false && !game.local;
			const min = game.seats?.min ?? 2;
			const max = game.seats?.max ?? 8;
			sub.textContent = game.local
				? "Played on this one device. Gather round and pass it along."
				: botsAllowed
					? "Play with friends on any device, or against bots — no server, no sign-up."
					: "Play with a friend on any device — no server, no sign-up.";
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
			const start = button(game.local ? "START" : "START GAME", () => {
				const now = quickTeams(game);
				for (const [id, team] of now) if (room.getMember(id)?.team !== team) room.setTeam(id, team);
				quick = false;
				room.setGame(game.id);
			}, true);
			start.disabled = !!problem;
			const invite = button("INVITE A FRIEND", () => {
				quickTable = true;
				showInvite();
			}, !quickTable);
			const seated = members.filter((m) => m.team !== "spectator").length;
			// Somebody already here — a friend in by the party code — sets the
			// table as surely as PLAY A BOT does.
			const tableSet = quickTable || members.length > 1;

			if (game.local) {
				row.append(start);
			} else if (!tableSet) {
				row.append(invite);
				if (botsAllowed) {
					row.append(button(min <= 1 ? "PLAY ALONE" : "PLAY A BOT", () => {
						quickTable = true;
						// Enough bots to make the game legal: the common case is one tap.
						let n = room.getMembers().length;
						while (n < min && n < max && room.addBot()) n++;
						render();
					}));
				}
			} else {
				if (botsAllowed) {
					const add = button("ADD BOT", () => room.addBot());
					add.disabled = seated >= max || room.getMembers().length >= room.maxMembers;
					const bots = room.getMembers().filter((m) => NeonArcade.isBotId(m.id));
					const drop = button("REMOVE BOT", () => room.removeMember(bots.at(-1).id));
					drop.disabled = !bots.length;
					row.append(add, drop);
				}
				if (!invitePanel) row.append(invite);
				row.append(start);
			}
			wrap.append(row);
			if (tableSet && problem) wrap.append(el("div", { className: "share-hint", textContent: problem }));
			body.append(wrap);
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

		function showClosed(msg, actions = freshPartyRow) {
			closed = true;
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
		 * has the seat now (room-join's `displaced`); this one has already
		 * let go of its links and will not redial — two tabs taking turns
		 * would each knock the other off every second. The way back is the
		 * reload the other tab made: this page reconnects with the token and
		 * the *other* one lands here instead.
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
					textContent: "USE THIS TAB INSTEAD",
				});
				here.onclick = () => {
					here.disabled = true;
					// The hash would make the boot join by code, not reconnect.
					NeonArcade.clearHash();
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
			if (joining) {
				joining.ctl.abort();
				await joining.done.catch(() => {});
			} else if ((await NeonArcade.releaseRejoin?.()) === "busy") {
				// The token's seat is live in another tab of this browser.
				// Releasing it would knock that tab out of its party, and a
				// new party here would overwrite the token both tabs share —
				// the other tab's next reload would land in *this* party. So
				// nothing is started: this tab says where the party is, and
				// offers to take it over instead.
				return showDisplaced();
			}
			// The abort's leave is in flight; let it land before unloading.
			await NeonArcade.roomSettled?.();
			NeonArcade.hostNewGame();
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
			row.append(fresh, el("a", { className: "neon-btn", textContent: "ALL GAMES", href: "index.html", "data-leaves": "" }));
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
				onParty: () => {
					presence.sync(room);
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
				onEvicted: () => showClosed("You were removed from the party."),
				onPartyClosed: () => showClosed("The host closed the party."),
				// The status line is on the party screen, which a game hides.
				onError: (msg) => {
					setStatus(msg, "error");
					if (mounted) NeonArcade.toast(msg, "warn");
				},
				onDisplaced: () => showDisplaced(),
			};
		}

		/** Someone opened an invite link: answer it and wait to be let in. */
		async function joinFlow(inviteCode) {
			let linked = false;
			room = NeonArcade.createGuest({
				...roomOpts(),
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
			title.textContent = "JOINING";
			sub.textContent = `Joining party ${joinCode}…`;
			body.replaceChildren();
			setStatus("Meeting the party…");
			try {
				const made = await trackedJoin(joinCode);
				room = made.room;
				partyCode = joinCode;
				room.resume();
				NeonArcade.clearHash();
				title.textContent = "PARTY";
				setStatus("");
				render();
				syncGame();
			} catch (err) {
				if (err?.reason === "aborted") return; // START A NEW PARTY is on its way
				if (err?.reason === "displaced") return showDisplaced();
				// The hash stays, so the link that brought us here is still the
				// one RETRY (or a reload) tries again.
				sub.textContent = `Could not join party ${joinCode}.`;
				showJoinFailed(err, () => joinCodeFlow(joinCode));
			}
		}

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
			} catch (err) {
				if (err?.reason === "aborted") return; // START A NEW PARTY is on its way
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
			// A `?fresh=1` load is intentionally starting a new party; don't leave
			// the flag in the URL, or a later reload/bookmark would keep spawning
			// new parties instead of reconnecting. Only that flag goes: `?rs=`
			// (loopback only) and `?mockroom=` choose the room server and must
			// outlive it.
			const params = new URLSearchParams(location.search);
			if (params.has("fresh")) {
				params.delete("fresh");
				const query = params.toString();
				try {
					history.replaceState(
						null,
						"",
						location.pathname + (query ? "?" + query : "") + location.hash,
					);
				} catch {}
			}
			if (await NeonArcade.roomServerReachable?.()) {
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
			if (!room) room = NeonArcade.createHost(roomOpts());
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
			// linked (joinFlow), so an invite that fails costs nothing.
			if (token && (fresh || code) && !invite && (await NeonArcade.releaseRejoin?.()) === "busy") {
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

		// Live getters, published by party.html as `window.__party` (and as
		// `window.__game`, the name game pages used): the tests drive the real
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
		};
	};
})();
