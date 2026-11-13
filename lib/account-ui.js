// lib/account-ui.js — the account's pieces of the party screen, the portal and
// the profile page: the sign-in chooser, ADD FRIEND on a party member, the
// "friends online" block with INVITE, and the feedback sheet for a game.
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

	function signInChooser(why = "Sign in to keep favourites everywhere, get ranked against people, and play with friends.") {
		const { body } = sheet("Sign in");
		body.append(el("p", "neon-sheet-text", why));
		const row = el("div", "lobby-row");
		row.append(btn("WITH GITHUB", () => A().signIn("github"), "neon-btn neon-btn--accent"), btn("WITH GOOGLE", () => A().signIn("google"), "neon-btn neon-btn--accent"));
		body.append(row, el("p", "neon-sheet-small", "We keep a display name, an avatar and a random id — never your email. Playing never needs an account."));
	}

	// ------------------------------------------------------------- friends

	let friends = null; // { friends, incoming, outgoing }
	let friendsLoad = null;
	// Buttons on screen that show a relation: repainted whenever the list
	// arrives (a request accepted elsewhere, a push over the live socket).
	const painters = new Set();
	function loadFriends(force) {
		if (!A()?.me) return Promise.resolve(null);
		if (friends && !force) return Promise.resolve(friends);
		friendsLoad ??= A()
			.api("/api/friends")
			.then((f) => {
				friends = f;
				for (const paint of [...painters]) paint();
				return f;
			})
			.catch(() => null)
			.finally(() => (friendsLoad = null));
		return friendsLoad;
	}
	A()?.onChange(() => loadFriends(true));

	const relation = (id) => {
		if (!friends) return null;
		if (friends.friends.some((f) => f.id === id)) return "friends";
		if (friends.outgoing.some((f) => f.id === id)) return "asked";
		if (friends.incoming.some((f) => f.id === id)) return "asking";
		return "none";
	};

	/** ADD FRIEND (or FRIEND) for a party member who is signed in, else null. */
	function memberControl(m) {
		const me = A()?.me;
		const acct = m.acct?.id;
		if (!me || !acct || acct === me.id) return null;
		const b = el("button", "party-mini");
		const paint = () => {
			if (!b.isConnected && b.dataset.drawn) return painters.delete(paint);
			b.dataset.drawn = "1";
			const r = relation(acct);
			b.textContent = r === "friends" ? "FRIENDS ✓" : r === "asked" ? "ASKED" : r === "asking" ? "ACCEPT FRIEND" : "ADD FRIEND";
			b.disabled = r === "friends" || r === "asked";
		};
		paint();
		painters.add(paint);
		if (!friends) loadFriends();
		b.onclick = async () => {
			b.disabled = true;
			try {
				const r = await A().api(`/api/friends/${encodeURIComponent(acct)}`, { method: "POST" });
				NeonArcade.toast?.(r.state === "friends" ? `You and ${m.name} are friends.` : `Friend request sent to ${m.name}.`, "good");
				await loadFriends(true);
			} catch (err) {
				NeonArcade.toast?.(err.message, "warn");
			}
			paint();
		};
		return b;
	}

	/**
	 * The party screen's account block: sign in, or friends online with INVITE
	 * (needs the party's six-digit code), and FEEDBACK on the game in play.
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
		const holder = el("div", "party-friends-list", "…");
		list.append(holder);
		wrap.append(list);
		loadFriends(true).then((f) => {
			holder.replaceChildren();
			const online = (f?.friends ?? []).filter((x) => x.online);
			if (!online.length) {
				holder.append(el("p", "share-hint", f?.friends?.length ? "None of your friends is online." : "Add friends from your profile, or from a party."));
				return;
			}
			for (const x of online) {
				const row = el("div", "party-friend");
				row.append(el("span", null, x.game ? `${x.name} · playing` : x.name));
				const inv = btn("INVITE", async () => {
					inv.disabled = true;
					try {
						const r = await A().api(`/api/friends/${encodeURIComponent(x.id)}/invite`, { method: "POST", body: { code: partyCode } });
						NeonArcade.toast?.(r.delivered ? `Invited ${x.name}.` : `${x.name} has no page open right now.`, r.delivered ? "good" : "warn");
					} catch (err) {
						NeonArcade.toast?.(err.message, "warn");
						inv.disabled = false;
					}
				}, "party-mini");
				if (!partyCode) {
					inv.disabled = true;
					inv.title = "Invites need the party code (the room server).";
				}
				row.append(inv);
				holder.append(row);
			}
		});
		return wrap;
	}

	// ------------------------------------------------------------ feedback

	async function feedback(game, title) {
		const { body } = sheet(`Feedback: ${title}`);
		const list = el("div", "fb-list", "Loading…");
		const form = el("form", "fb-form");
		body.append(form, list);
		if (A()?.me) {
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
					NeonArcade.toast?.(err.message, "warn");
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
					item.append(el("div", "fb-name", c.name), el("div", "fb-body", c.text));
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
		confirm, sheet, signInChooser, memberControl, partyBlock, feedback, loadFriends, relation };
})();
