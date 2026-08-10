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
//   - succession: when the host goes, the longest-present member is offered it
//
// Loaded as a traditional script so it works on file:// like everything else.

(() => {
	const el = (tag, props = {}) => {
		const node = document.createElement(tag);
		for (const [k, v] of Object.entries(props)) {
			if (k === "textContent") node.textContent = v;
			else if (k in node) node[k] = v;
			else node.setAttribute(k, v);
		}
		return node;
	};

	const TEAMS = [
		{ key: "A", label: "TEAM A" },
		{ key: "B", label: "TEAM B" },
		{ key: "spectator", label: "WATCHING" },
	];

	/** A remembered display name beats typing it again on every visit. */
	function savedName() {
		try {
			return localStorage.getItem("neon.name") || "";
		} catch {
			return "";
		}
	}
	function rememberName(name) {
		try {
			localStorage.setItem("neon.name", name);
		} catch {}
	}

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

		const setStatus = (text, kind) => {
			statusEl.textContent = text;
			statusEl.className = "lobby-status" + (kind ? ` is-${kind}` : "");
		};

		// ------------------------------------------------------ game mounting

		function syncGame() {
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
			if (!room) return;
			body.replaceChildren();
			const me = room.self();
			const isHost = room.isHost();
			const hostGone = room.hostId() === null;

			sub.textContent = hostGone
				? "The host left. The party is still here."
				: isHost
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

			// -- roster ------------------------------------------------------
			const rosterWrap = el("div", { className: "share" });
			rosterWrap.append(
				el("div", {
					className: "share-label",
					textContent: `Party (${room.getMembers().length})`,
				}),
			);
			for (const m of room.getMembers()) {
				const row = el("div", { className: "party-member" });
				const label = el("div", { className: "party-name" });
				label.append(el("span", { textContent: m.name }));
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
					const crown = el("button", { className: "party-mini", textContent: "MAKE HOST" });
					crown.onclick = () => room.transferHost(m.id);
					const kick = el("button", {
						className: "party-mini is-danger",
						textContent: "REMOVE",
					});
					kick.onclick = () => room.removeMember(m.id);
					controls.append(crown, kick);
				}
				row.append(controls);
				rosterWrap.append(row);
			}
			body.append(rosterWrap);

			// -- succession --------------------------------------------------
			if (hostGone) {
				const heirWrap = el("div", { className: "share" });
				const heir = room._heir();
				if (heir === room.selfId) {
					heirWrap.append(
						el("div", {
							className: "share-hint",
							textContent: "You have been here longest — the party is yours to take.",
						}),
					);
					const take = el("button", {
						className: "neon-btn neon-btn--accent",
						textContent: "TAKE OVER AS HOST",
					});
					take.onclick = () => {
						if (room.claimHost()) render();
					};
					const row = el("div", { className: "lobby-row" });
					row.append(take);
					heirWrap.append(row);
				} else {
					heirWrap.append(
						el("div", {
							className: "share-hint",
							textContent: `Waiting for ${room.getMember(heir)?.name ?? "someone"} to take over…`,
						}),
					);
				}
				body.append(heirWrap);
			}

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
					setStatus("Party deleted.", "error");
					room.deleteParty();
					showClosed("You deleted the party.");
				};
				actions.append(del);
			}
			const portal = el("a", {
				className: "neon-btn",
				textContent: "ALL GAMES",
				href: "index.html",
			});
			actions.append(portal);
			body.append(actions);

			if (invitePanel) body.append(invitePanel);
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

			invitePanel.append(shareBlock(invite.link));

			invitePanel.append(
				el("div", { className: "share-label", textContent: "2. Take their reply" }),
				el("div", {
					className: "share-hint",
					textContent: "Scan it off their screen, or paste the code they send back.",
				}),
			);
			const box = el("textarea", {
				className: "share-code",
				rows: "3",
				placeholder: "Paste their reply code…",
				autocomplete: "off",
				spellcheck: "false",
			});
			const connect = async (code) => {
				if (!code) return;
				setStatus("Connecting…");
				try {
					await room.acceptAnswer(code);
					box.value = "";
					setStatus("Connected.", "good");
					invitePanel = null;
					render();
				} catch (err) {
					setStatus(err.message, "error");
				}
			};

			const connectBtn = el("button", { className: "neon-btn", textContent: "CONNECT" });
			connectBtn.onclick = () => connect(box.value.trim());

			// One tap instead of select-all-and-paste, where the browser allows it.
			const pasteBtn = el("button", { className: "neon-btn", textContent: "PASTE" });
			pasteBtn.onclick = async () => {
				try {
					const text = await navigator.clipboard.readText();
					box.value = text.trim();
					connect(box.value);
				} catch {
					setStatus("Clipboard is blocked here — paste into the box instead.", "error");
					box.focus();
				}
			};

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
				setStatus("Point the camera at their reply code…");
				scanner = NeonArcade.scanQr({
					onResult: (code) => {
						closeScanner();
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
			stopScanner = closeScanner;

			const cancel = el("button", { className: "neon-btn", textContent: "CANCEL" });
			cancel.onclick = () => {
				closeScanner();
				invitePanel = null;
				render();
			};

			const row = el("div", { className: "lobby-row" });
			row.append(connectBtn, pasteBtn, scanBtn, cancel);
			invitePanel.append(box, row, scanWrap);
			render();
		}

		/** A copyable/shareable value with a QR of the same thing. */
		function shareBlock(value) {
			const wrap = el("div");
			const box = el("textarea", {
				className: "share-code",
				readOnly: true,
				rows: "3",
				value,
			});
			box.addEventListener("focus", () => box.select());
			wrap.append(box);

			const row = el("div", { className: "lobby-row" });
			const copy = el("button", { className: "neon-btn", textContent: "COPY" });
			copy.onclick = async () => {
				try {
					await navigator.clipboard.writeText(value);
				} catch {
					box.select();
				}
				copy.textContent = "COPIED";
				setTimeout(() => (copy.textContent = "COPY"), 1500);
			};
			row.append(copy);
			if (navigator.share) {
				const share = el("button", { className: "neon-btn", textContent: "SHARE" });
				share.onclick = () => navigator.share({ text: value }).catch(() => {});
				row.append(share);
			}
			wrap.append(row);

			try {
				const canvas = NeonArcade.qrCanvas(value, {
					scale: 3,
					quiet: 3,
					dark: "#000",
					light: "#fff",
				});
				canvas.className = "share-qr";
				const qrWrap = el("div", { className: "share-qr-wrap" });
				qrWrap.append(
					canvas,
					el("div", { className: "share-hint", textContent: "or scan this code" }),
				);
				wrap.append(qrWrap);
			} catch {
				// Too large to encode is survivable — the link still works.
			}
			return wrap;
		}

		// ------------------------------------------------------- terminal ui

		function showClosed(msg) {
			stopScanner?.();
			container.hidden = false;
			stage.hidden = true;
			if (mounted) {
				mounted.handle?.unmount?.();
				mounted = null;
			}
			sub.textContent = msg;
			body.replaceChildren();
			const row = el("div", { className: "lobby-row" });
			row.append(NeonArcade.hostNewGameButton("START A NEW PARTY"));
			row.append(
				el("a", { className: "neon-btn", textContent: "ALL GAMES", href: "index.html" }),
			);
			body.append(row);
			setStatus(msg, "error");
		}

		// ---------------------------------------------------------- wiring up

		function roomOpts() {
			return {
				name: savedName() || "Player",
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
				return setStatus("That invite is not readable: " + err.message, "error");
			}
			setStatus("Waiting for them to accept…");
			body.append(
				el("div", { className: "share-label", textContent: "Your reply code" }),
				el("div", {
					className: "share-hint",
					textContent: "Show this to whoever invited you, or send it back to them.",
				}),
				shareBlock(answer),
			);

			room.onOpen = () => {
				title.textContent = "PARTY";
				setStatus("");
				NeonArcade.clearHash();
				render();
				syncGame();
			};
		}

		function hostFlow() {
			room = NeonArcade.createHost(roomOpts());
			room.resume();
			render();
			syncGame();
		}

		const invite = NeonArcade.inviteFromUrl();
		if (invite) joinFlow(invite);
		else hostFlow();

		// A reply that comes back as a link lands here when it opens in this very
		// tab; anywhere else it would be a fresh document with no room in it.
		window.addEventListener("hashchange", () => {
			const answer = NeonArcade.answerFromUrl();
			if (!answer || !room) return;
			NeonArcade.clearHash();
			room.acceptAnswer(answer).catch((err) => setStatus(err.message, "error"));
		});

		return {
			get room() {
				return room;
			},
		};
	};
})();
