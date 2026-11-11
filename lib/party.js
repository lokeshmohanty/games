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
		let mounted = null; // { id, handle }
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
		// A room-server join still meeting the party: { ctl, done }, so START
		// A NEW PARTY can cancel it (see startFresh). Null otherwise.
		let joining = null;
		// Set the moment this page is done with its party (deleted, removed,
		// closed by the host). The room keeps firing callbacks until its links
		// are torn down — deleteParty waits 250ms for the notice to drain — and
		// a render in that window would paint the live roster over the
		// terminal screen.
		let closed = false;

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
				mounted = { id: wanted, handle: game.mount(ctx) };
			} catch (err) {
				console.error(err);
				mounted = null;
				container.hidden = false;
				stage.hidden = true;
				setStatus(`${game.name} failed to start: ${err.message}`, "error");
			}
		}

		// ------------------------------------------------------------- render

		function render() {
			if (!room || closed) return;
			body.replaceChildren();
			const me = room.self();
			const isHost = room.isHost();

			sub.textContent = isHost
				? "You are the host. Add players, pick teams, choose a game."
				: "Waiting for the host to start something.";

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
					try {
						const canvas = NeonArcade.qrCanvas(link, {
							scale: 3,
							quiet: 3,
							dark: "#000",
							light: "#fff",
						});
						canvas.className = "share-qr party-code-qr";
						codeWrap.append(canvas);
					} catch {
						// Too long to encode (a very long path): the digits still work.
					}
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
					if (!isBot) {
						const crown = el("button", { className: "party-mini", textContent: "MAKE HOST" });
						crown.onclick = () => room.transferHost(m.id);
						controls.append(crown);
					}
					const kick = el("button", {
						className: "party-mini is-danger",
						textContent: "REMOVE",
					});
					kick.onclick = () => room.removeMember(m.id);
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
			if (isHost) {
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
				card.onclick = () => room.setGame(game.id);
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
				del.onclick = () => {
					if (!confirm("This will end the party for everyone and make them leave. Are you sure?")) return;
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
				if (!confirmLeave("Leave this party and start a fresh one with a new code?")) return;
				refresh.disabled = true;
				await leaveThenGo(() => NeonArcade.hostNewGame());
			};
			actions.append(refresh);
			const portal = el("a", {
				className: "neon-btn",
				textContent: "ALL GAMES",
				href: "index.html",
			});
			// Leaving for real, not just navigating: leave() is what releases
			// the seat and drops the rejoin token. Without it the portal's party
			// banner would land on a page that finds the token and silently
			// reconnects to the party this player just said they were leaving.
			portal.onclick = async (e) => {
				// Navigation waits for the leave to land (leaveThenGo), so the
				// link never follows itself.
				e.preventDefault();
				if (!confirmLeave("This will make you leave the party. Are you sure?")) return;
				await leaveThenGo(() => (location.href = portal.href));
			};
			actions.append(portal);
			body.append(actions);

			if (invitePanel) body.append(invitePanel);
		}

		/**
		 * Leave the party, then navigate — but only once the room server has
		 * the leave. An unload straight after the send can take the frame
		 * down with it, and then the old party holds a seat for a browser
		 * that is gone (room-join's LEAVE_ACK_MS bounds the wait).
		 */
		async function leaveThenGo(go) {
			room.leave();
			await NeonArcade.roomSettled?.();
			go();
		}

		/**
		 * Ask before a deliberate leave. A host is also told what happens to
		 * the party without them: who inherits the crown, or that nobody is
		 * left to and it ends (bots cannot hold it — see room.heir()).
		 */
		function confirmLeave(question) {
			if (!room.isHost()) return confirm(question);
			const heir = room.heir();
			const after = heir
				? `You are the host; the crown will pass to ${room.getMember(heir)?.name ?? "someone"}.`
				: "You are the host and nobody else is here — the party ends.";
			return confirm(`${after} ${question}`);
		}

		// ------------------------------------------------------------ invites

		async function showInvite() {
			stopScanner?.();
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
					invitePanel = null;
					render();
				},
			});
			stopScanner = reply.close;

			const cancel = el("button", { className: "neon-btn", textContent: "CANCEL" });
			cancel.onclick = () => {
				reply.close();
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
			stopScanner?.();
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
			row.append(fresh, el("a", { className: "neon-btn", textContent: "ALL GAMES", href: "index.html" }));
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
					render();
					syncGame();
					// A game that is already running wants to know the teams moved.
					mounted?.handle?.onRoster?.();
				},
				onPeerJoin: (id) => {
					render();
					mounted?.handle?.onPeerJoin?.(id);
				},
				onPeerLeave: (id) => {
					render();
					mounted?.handle?.onPeerLeave?.(id);
				},
				onHostVacant: () => render(),
				onEvicted: () => showClosed("You were removed from the party."),
				onPartyClosed: () => showClosed("The host closed the party."),
				onError: (msg) => setStatus(msg, "error"),
				onDisplaced: () => showDisplaced(),
			};
		}

		/** Someone opened an invite link: answer it and wait to be let in. */
		async function joinFlow(inviteCode) {
			room = NeonArcade.createGuest(roomOpts());
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
					hint: "Show this to whoever invited you, or send it back to them.",
					value: answer,
				}),
			);

			room.onOpen = () => {
				// In through an invite, so any rejoin token left over is for some
				// other party — and a later reload must not reconnect to that one.
				NeonArcade.clearRejoinToken?.();
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
			if (!confirm("Leave this party and join the other one?")) {
				NeonArcade.clearHash();
				return;
			}
			leaveThenGo(() => location.reload());
		});

		// Live getters, published by party.html as `window.__party`, for the same
		// reason each game page publishes `window.__game`: the tests drive the
		// real screen rather than a rehearsal of it, and both of these are
		// otherwise closure variables nothing outside can reach. `handle` is what
		// lets a game be tested **through the party shell** — with several real
		// peers — rather than only through its own deep-link page, which is the
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
