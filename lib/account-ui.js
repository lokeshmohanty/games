// lib/account-ui.js — the account's pieces of the party screen, the portal and
// the profile page: the sign-in chooser, ADD FRIEND on a party member, the
// "friends online" block with INVITE, a pushed friend request with ACCEPT and
// DECLINE, "Players you just played" on the end card, and the feedback sheet
// for a game. The friends list is fetched once and shared (loadFriends).
// Everything here talks to lib/account.js; nothing here is needed to play.

window.NeonArcade = window.NeonArcade || {};

(() => {
	const A = () => NeonArcade.account;
	const el = (tag, cls, text) => {
		const n = document.createElement(tag);
		if (cls) n.className = cls;
		if (text != null) n.textContent = text;
		return n;
	};
	const btn = (label, onClick, cls = "neon-btn") => {
		const b = el("button", cls, label);
		b.type = "button";
		b.onclick = onClick;
		return b;
	};

	/** A <dialog> sheet with a title and a close button; returns { dialog, body }. */
	function sheet(title) {
		document.querySelector("dialog.neon-sheet")?.remove();
		const d = el("dialog", "neon-sheet");
		const head = el("div", "neon-sheet-head");
		head.append(el("h2", null, title), btn("✕", () => d.close(), "neon-sheet-x"));
		head.lastChild.setAttribute("aria-label", "Close");
		const body = el("div", "neon-sheet-body");
		d.append(head, body);
		d.addEventListener("close", () => d.remove());
		d.addEventListener("click", (e) => e.target === d && d.close());
		document.body.append(d);
		d.showModal();
		return { dialog: d, body };
	}

	function signInChooser(why = "Sign in to keep favourites everywhere, get ranked against people, and play with friends. Feedback is posted from your GitHub account — sign in with Google and you can connect GitHub later.") {
		const { body } = sheet("Sign in");
		body.append(el("p", "neon-sheet-text", why));
		const row = el("div", "lobby-row");
		row.append(btn("WITH GITHUB", () => A().signIn("github"), "neon-btn neon-btn--accent"), btn("WITH GOOGLE", () => A().signIn("google"), "neon-btn neon-btn--accent"));
		body.append(row, el("p", "neon-sheet-small", "We keep a display name, an avatar and a random id — never your email. Playing never needs an account."));
	}

	// ------------------------------------------------------------- friends

	// The friends list, cached for the whole page (audit D15: the party screen
	// redraws on every roster change and used to fetch it each time, so the
	// list blinked). Fetched again when something says it changed — a push
	// over the live socket, signing in — or when it is a minute old.
	const FRESH_MS = 60_000;
	let friends = null; // { friends, incoming, outgoing, blocked }
	let friendsAt = 0;
	let friendsLoad = null;
	// Things on screen that show a relation or the list: repainted whenever
	// the list arrives. Each removes itself once it has left the page.
	const painters = new Set();
	function loadFriends(force) {
		if (!A()?.me) return Promise.resolve(null);
		const fresh = friends && Date.now() - friendsAt < FRESH_MS;
		if (friends && !force && fresh) return Promise.resolve(friends);
		friendsLoad ??= A()
			.api("/api/friends")
			.then((f) => {
				friends = { friends: [], incoming: [], outgoing: [], blocked: [], ...f };
				friendsAt = Date.now();
				for (const paint of [...painters]) paint();
				document.dispatchEvent(new CustomEvent("neon:friends"));
				return friends;
			})
			.catch(() => friends)
			.finally(() => (friendsLoad = null));
		// Stale but there: answer with it now, and repaint when the new one lands.
		return friends && !force ? Promise.resolve(friends) : friendsLoad;
	}
	A()?.onChange((me) => {
		if (!me) {
			friends = null;
			document.dispatchEvent(new CustomEvent("neon:friends"));
		}
		loadFriends(true);
	});
	// Who is online changes without a push: a minute at a time, while
	// something on a visible page shows it.
	setInterval(() => {
		if (painters.size && document.visibilityState === "visible" && A()?.me) loadFriends(true);
	}, FRESH_MS);
	/** Paint now and on every new list, until `node` has left the page. */
	function painted(node, paint) {
		const run = () => {
			if (!node.isConnected && node.dataset.drawn) return painters.delete(run);
			node.dataset.drawn = "1";
			paint();
		};
		run();
		painters.add(run);
		return run;
	}

	const relation = (id) => {
		if (!friends) return null;
		if (friends.friends.some((f) => f.id === id)) return "friends";
		if (friends.blocked?.some((f) => f.id === id)) return "blocked";
		if (friends.outgoing.some((f) => f.id === id)) return "asked";
		if (friends.incoming.some((f) => f.id === id)) return "asking";
		return "none";
	};
	/** Friend requests waiting for an answer (the ☰ badge, lib/nav.js). */
	const incomingCount = () => (A()?.me ? (friends?.incoming?.length ?? 0) : 0);

	/** POST /api/friends/<id>: ask, or accept. Says what happened. */
	async function befriend(id, name) {
		const r = await A().api(`/api/friends/${encodeURIComponent(id)}`, { method: "POST" });
		NeonArcade.toast?.(r.state === "friends" ? `You and ${name} are friends.` : `Friend request sent to ${name}.`, "good");
		await loadFriends(true);
		return r;
	}

	/** ADD FRIEND (or FRIEND) for someone signed in, by account; null for yourself. */
	function addButton(acct, name) {
		const me = A()?.me;
		if (!me || !acct || acct === me.id) return null;
		const b = el("button", "party-mini");
		b.type = "button";
		b.dataset.addFriend = acct;
		const paint = painted(b, () => {
			const r = relation(acct);
			b.textContent = r === "friends" ? "FRIENDS ✓" : r === "asked" ? "ASKED" : r === "asking" ? "ACCEPT FRIEND" : r === "blocked" ? "BLOCKED" : "ADD FRIEND";
			b.disabled = r === "friends" || r === "asked" || r === "blocked";
		});
		if (!friends) loadFriends();
		b.onclick = async () => {
			b.disabled = true;
			try {
				await befriend(acct, name);
			} catch (err) {
				NeonArcade.toast?.(err.message, "warn");
			}
			paint();
		};
		return b;
	}
	/** ADD FRIEND (or FRIEND) for a party member who is signed in, else null. */
	const memberControl = (m) => addButton(m.acct?.id, m.name);

	/**
	 * "Players you just played" on the end card (lib/sdk-managed.js): the
	 * signed-in people in `ids` this player might add — not themselves, not a
	 * friend, nobody blocked, nobody who hides from public boards (their
	 * `acct.hide`). Null when there is nobody.
	 */
	function justPlayed(ids, room) {
		const me = A()?.me;
		if (!me || !room) return null;
		const people = [...new Set(ids)]
			.map((id) => room.getMember?.(id))
			.filter((m) => m?.acct?.id && m.acct.id !== me.id && !m.acct.hide);
		if (!people.length) return null;
		const wrap = el("div", "just-played");
		wrap.append(el("div", "just-played-label", "Players you just played"));
		const list = el("div", "just-played-list");
		wrap.append(list);
		painted(wrap, () => {
			list.replaceChildren();
			for (const m of people) {
				const r = relation(m.acct.id);
				if (r === "friends" || r === "blocked") continue;
				const row = el("div", "just-played-row");
				row.append(el("span", null, m.acct.name ?? m.name), addButton(m.acct.id, m.acct.name ?? m.name));
				list.append(row);
			}
			wrap.hidden = !list.children.length;
		});
		if (!friends) loadFriends();
		return wrap;
	}

	/**
	 * A friend request, pushed: who, and ACCEPT / DECLINE right there (Lokesh,
	 * 2026-11-16: requests up front). The profile lists it too.
	 */
	function requestNotice(msg) {
		const id = msg.id;
		if (!id || document.querySelector(`.neon-invite[data-request="${CSS.escape(id)}"]`)) return;
		const box = el("div", "neon-invite neon-request");
		box.dataset.request = id;
		box.setAttribute("role", "alert");
		box.append(el("p", null, `${msg.name ?? "Someone"} wants to be friends.`));
		const row = el("div", "neon-invite-row");
		const answer = (method, said) => async () => {
			box.remove();
			try {
				await A().api(`/api/friends/${encodeURIComponent(id)}`, { method });
				NeonArcade.toast?.(said, "good");
			} catch (err) {
				NeonArcade.toast?.(err.message, "warn");
			}
			loadFriends(true);
		};
		row.append(
			btn("ACCEPT", answer("POST", `You and ${msg.name} are friends.`), "neon-btn neon-btn--accent"),
			btn("DECLINE", answer("DELETE", "Declined."), "neon-btn"),
		);
		box.append(row);
		// Above an invite, if one is showing.
		document.body.append(box);
		setTimeout(() => box.remove(), 60_000);
	}

	/**
	 * The party screen's account block: sign in, or friends online with INVITE,
	 * and FEEDBACK on the game in play. `partyCode` is the party's six digits,
	 * whoever this member is: the host and anyone in by code know it, and the
	 * rest read it from the party record (lib/party.js) — so every signed-in
	 * member can invite (Lokesh, 2026-11-16). Drawn from the cached list at
	 * once; a newer list repaints only this block.
	 */
	function partyBlock({ partyCode, game } = {}) {
		const wrap = el("div", "party-account");
		const me = A()?.me;
		if (game) {
			const meta = NeonArcade.getGame?.(game);
			wrap.append(btn(`FEEDBACK ON ${meta?.name ?? game}`, () => feedback(game, meta?.title ?? meta?.name ?? game), "neon-btn party-feedback"));
		}
		if (!me) {
			if (A()?.signedIn()) return wrap; // still loading
			const row = el("div", "party-signin");
			row.append(el("span", null, "Play friends and get ranked:"), btn("SIGN IN", () => signInChooser()));
			wrap.append(row);
			return wrap;
		}
		const list = el("div", "party-friends");
		list.append(el("div", "share-label", "Friends online"));
		const holder = el("div", "party-friends-list", friends ? null : "…");
		list.append(holder);
		wrap.append(list);
		// Rows already invited keep saying so across a repaint.
		const invited = new Set();
		painted(holder, () => {
			if (!friends) return;
			holder.replaceChildren();
			const online = friends.friends.filter((x) => x.online);
			if (!online.length) {
				holder.append(el("p", "share-hint", friends.friends.length ? "None of your friends is online." : "Add friends from your profile, or from a party."));
				return;
			}
			for (const x of online) {
				const row = el("div", "party-friend");
				row.dataset.friend = x.id;
				row.append(el("span", null, x.game ? `${x.name} · playing` : x.name));
				const inv = btn(invited.has(x.id) ? "INVITED" : "INVITE", async () => {
					inv.disabled = true;
					try {
						await A().api(`/api/friends/${encodeURIComponent(x.id)}/invite`, { method: "POST", body: { code: partyCode } });
						// The same words whether a page of theirs is open: the server
						// keeps the invite for ten minutes, and appear offline means
						// nobody may tell (audit D16).
						invited.add(x.id);
						inv.textContent = "INVITED";
						NeonArcade.toast?.(`Invited ${x.name}.`, "good");
					} catch (err) {
						NeonArcade.toast?.(err.message, "warn");
						inv.disabled = false;
					}
				}, "party-mini");
				inv.disabled = invited.has(x.id);
				if (!partyCode) {
					inv.disabled = true;
					inv.title = "Invites need the party code (the room server).";
				}
				row.append(inv);
				holder.append(row);
			}
		});
		loadFriends();
		return wrap;
	}

	// ------------------------------------------------------------ feedback

	async function feedback(game, title) {
		const { body } = sheet(`Feedback: ${title}`);
		const list = el("div", "fb-list", "Loading…");
		const form = el("form", "fb-form");
		body.append(form, list);
		const connectGitHub = (why) => {
			form.replaceChildren(
				el("p", "neon-sheet-text", why),
				btn("CONNECT GITHUB", () => A().connect("github").catch((err) => NeonArcade.toast?.(err.message, "warn")), "neon-btn neon-btn--accent"),
			);
		};
		if (A()?.me && !A().has("github")) {
			connectGitHub("Feedback is posted from your own GitHub account. Connect it once — the arcade can then comment on this repository's discussions for you, nothing else.");
		} else if (A()?.me) {
			const text = el("textarea", "fb-text");
			text.maxLength = 2000;
			text.rows = 3;
			text.placeholder = "What would make it better? Posted publicly on GitHub with your name.";
			const send = el("button", "neon-btn neon-btn--accent", "POST");
			send.type = "submit";
			form.append(text, send);
			form.onsubmit = async (e) => {
				e.preventDefault();
				if (!text.value.trim()) return;
				send.disabled = true;
				try {
					await A().api(`/api/feedback/${game.split("/").map(encodeURIComponent).join("/")}`, { method: "POST", body: { text: text.value } });
					text.value = "";
					NeonArcade.toast?.("Thanks — posted.", "good");
					draw();
				} catch (err) {
					if (err.code === "github" || /GitHub account/.test(err.message)) connectGitHub(err.message);
					else NeonArcade.toast?.(err.message, "warn");
				}
				send.disabled = false;
			};
		} else {
			form.append(el("p", "neon-sheet-text", "Sign in to post feedback."), btn("SIGN IN", () => signInChooser()));
		}
		async function draw() {
			try {
				const f = await A().api(`/api/feedback/${game.split("/").map(encodeURIComponent).join("/")}`, { auth: false });
				list.replaceChildren();
				if (!f.comments.length) list.append(el("p", "share-hint", "No feedback yet. Be the first."));
				for (const c of f.comments) {
					const item = el("div", "fb-item");
					item.append(el("div", "fb-name", c.login ? `@${c.login}` : c.name), el("div", "fb-body", c.text));
					list.append(item);
				}
				if (f.url) {
					const a = el("a", "fb-link", "See it on GitHub");
					a.href = f.url;
					a.target = "_blank";
					a.rel = "noopener";
					list.append(a);
				}
			} catch (err) {
				list.textContent = `Could not load feedback (${err.message}).`;
			}
		}
		draw();
	}

	// Pages without the party's lobby.js (the portal, profile, leaderboards)
	// still get notices, drawn the same way (.neon-toasts in styles.css).
	NeonArcade.toast ??= (text, kind = "") => {
		let layer = document.querySelector(".neon-toasts");
		if (!layer) {
			layer = el("div", "neon-toasts");
			layer.setAttribute("role", "status");
			layer.setAttribute("aria-live", "polite");
			document.body.append(layer);
		}
		const note = el("div", "neon-toast" + (kind ? ` is-${kind}` : ""), text);
		layer.append(note);
		while (layer.children.length > 3) layer.firstChild.remove();
		setTimeout(() => note.remove(), 4500);
	};

	/** Yes or no in a sheet; resolves true for yes. */
	function confirm(question, { ok = "YES", cancel = "CANCEL" } = {}) {
		return new Promise((resolve) => {
			const { dialog, body } = sheet("Are you sure?");
			let answer = false;
			body.append(el("p", "neon-sheet-text", question));
			const row = el("div", "lobby-row");
			row.append(
				btn(cancel, () => dialog.close()),
				btn(ok, () => {
					answer = true;
					dialog.close();
				}, "neon-btn neon-btn--danger"),
			);
			body.append(row);
			dialog.addEventListener("close", () => resolve(answer));
		});
	}

	NeonArcade.accountUi = {
		confirm, sheet, signInChooser, memberControl, addButton, justPlayed, requestNotice, partyBlock, feedback, loadFriends, relation, incomingCount, befriend };
})();
