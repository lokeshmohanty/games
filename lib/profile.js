// lib/profile.js — profile.html: your account, or someone's public profile.
//
//   profile.html            you: name, settings, friend code, friends, groups,
//                           ratings, history, favourites, your data. Signed
//                           out: sign in, and this device's own stats.
//   profile.html?u=<id>     a player's public profile (ratings, recent
//                           matches) with ADD FRIEND — the friend-code link.
//   profile.html?join=<code> join a group by its code after signing in.

window.NeonArcade = window.NeonArcade || {};

(() => {
	const A = () => NeonArcade.account;
	const UI = () => NeonArcade.accountUi;
	const page = () => document.querySelector("[data-profile]");
	const q = new URLSearchParams(location.search);

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
	const section = (title, ...kids) => {
		const s = el("section");
		s.append(el("h2", null, title), ...kids);
		return s;
	};
	const titleOf = (id) => (NeonArcade.CATALOG ?? []).find((g) => g.id === id)?.title ?? id;
	const kindOf = (id) => (NeonArcade.CATALOG ?? []).find((g) => g.id === id)?.kind ?? null;
	const toast = (t, k) => NeonArcade.toast?.(t, k);
	const fail = (err) => toast(err.message, "warn");
	const linkTo = (id) => `${location.origin}${location.pathname}?u=${encodeURIComponent(id)}`;

	function avatar(src) {
		const img = el("img");
		img.alt = "";
		img.referrerPolicy = "no-referrer";
		img.src = src || "assets/icon.svg";
		img.onerror = () => (img.src = "assets/icon.svg");
		return img;
	}

	function ratingsTable(ratings) {
		if (!ratings.length) return el("p", "muted", "No ranked games yet — play a friend who is signed in.");
		const t = el("table");
		t.innerHTML = `<thead><tr><th>Game</th><th class="n">Rating</th><th class="n">Won</th><th class="n">Games</th></tr></thead>`;
		const tb = el("tbody");
		for (const r of ratings) {
			const tr = el("tr");
			const kind = kindOf(r.game);
			tr.append(
				el("td", null, titleOf(r.game)),
				el("td", "n", kind === "duel" ? String(Math.round(r.elo)) : kind === "coop" ? `best ${r.best ?? "–"}` : "–"),
				el("td", "n", String(r.wins)),
				el("td", "n", String(r.games)),
			);
			tb.append(tr);
		}
		t.append(tb);
		return t;
	}

	function historyList(matches, me) {
		if (!matches.length) return el("p", "muted", "No ranked matches yet.");
		const wrap = el("div");
		for (const m of matches) {
			const item = el("div", "item");
			const others = m.ranking
				.flat()
				.filter((p) => p.id !== me)
				.map((p) => p.name)
				.join(", ");
			const how = m.kind === "coop" ? "played" : m.ranking.length === 1 ? "draw" : m.won ? "won" : "lost";
			const left = el("div", "grow");
			left.append(el("div", null, `${titleOf(m.game)} — ${others || "—"}`), el("div", "muted", new Date(m.at).toLocaleString()));
			item.append(left, el("span", how === "won" ? "won" : "lost", how.toUpperCase()));
			wrap.append(item);
		}
		return wrap;
	}

	// ------------------------------------------------------- signed out

	function localStats() {
		const stats = NeonArcade.stats?.read() ?? {};
		const ids = Object.keys(stats);
		if (!ids.length) return el("p", "muted", "Nothing played on this device yet.");
		const t = el("table");
		t.innerHTML = `<thead><tr><th>Game</th><th class="n">Won</th><th class="n">Played</th><th class="n">Best streak</th></tr></thead>`;
		const tb = el("tbody");
		for (const id of ids.sort((a, b) => stats[b].played - stats[a].played)) {
			const r = stats[id];
			const tr = el("tr");
			tr.append(el("td", null, titleOf(id)), el("td", "n", String(r.won)), el("td", "n", String(r.played)), el("td", "n", String(r.best)));
			tb.append(tr);
		}
		t.append(tb);
		return t;
	}

	function signedOut() {
		document.querySelector("[data-title]").textContent = "Profile";
		const row = el("div", "row");
		row.append(btn("SIGN IN WITH GITHUB", () => A().signIn("github"), "neon-btn neon-btn--accent"), btn("SIGN IN WITH GOOGLE", () => A().signIn("google"), "neon-btn neon-btn--accent"));
		page().replaceChildren(
			section(
				"Sign in",
				el("p", null, "Optional. Keep favourites on every device, get ranked when you play people, see friends online and invite them, make groups with their own leaderboards."),
				row,
				el("p", "muted", "We keep a display name, an avatar and a random id — never your email. You can export or delete everything at any time."),
			),
			section("On this device", localStats()),
			section("Appearance", NeonArcade.theme.picker()),
		);
	}

	// ------------------------------------------------------- public profile

	async function publicProfile(id) {
		page().replaceChildren(el("p", "muted", "Loading…"));
		try {
			const p = await A().api(`/api/u/${encodeURIComponent(id)}`, { auth: false });
			document.querySelector("[data-title]").textContent = p.name;
			const who = el("div", "who");
			who.append(avatar(p.avatar), el("div", "name", p.name));
			const actions = el("div", "row");
			const me = A().me;
			if (me && me.id !== p.id) {
				await UI().loadFriends(true);
				const rel = UI().relation(p.id);
				const add = btn(rel === "friends" ? "FRIENDS ✓" : rel === "asked" ? "ASKED" : rel === "asking" ? "ACCEPT FRIEND" : "ADD FRIEND", async () => {
					add.disabled = true;
					try {
						const r = await A().api(`/api/friends/${encodeURIComponent(p.id)}`, { method: "POST" });
						add.textContent = r.state === "friends" ? "FRIENDS ✓" : "ASKED";
						toast(r.state === "friends" ? `You and ${p.name} are friends.` : `Friend request sent.`, "good");
					} catch (err) {
						fail(err);
						add.disabled = false;
					}
				}, "neon-btn neon-btn--accent");
				add.disabled = rel === "friends" || rel === "asked";
				actions.append(add);
			} else if (!me) {
				actions.append(btn("SIGN IN TO ADD AS A FRIEND", () => UI().signInChooser()));
			}
			page().replaceChildren(
				section("Player", who, actions),
				section("Ratings", ratingsTable(p.ratings)),
				section("Recent matches", historyList(p.matches, p.id)),
			);
		} catch (err) {
			page().replaceChildren(section("Player", el("p", null, err.status === 404 ? "No such player, or they keep their profile private." : `Could not load it (${err.message}).`)));
		}
	}

	// ------------------------------------------------------- your profile

	async function mine() {
		const me = A().me;
		document.querySelector("[data-title]").textContent = "Your profile";
		const sections = [];

		// Who: avatar, name (editable), provider.
		const who = el("div", "who");
		const nameBox = el("div", "grow");
		nameBox.append(el("div", "name", me.name), el("div", "muted", `Signed in with ${me.provider === "github" ? "GitHub" : me.provider === "google" ? "Google" : me.provider}`));
		who.append(avatar(me.avatar), nameBox);
		const nameRow = el("form", "row");
		const name = el("input");
		name.type = "text";
		name.value = me.name;
		name.maxLength = 24;
		name.setAttribute("aria-label", "Display name");
		name.dataset.name = "";
		const save = el("button", "neon-btn", "SAVE NAME");
		nameRow.append(name, save);
		nameRow.onsubmit = async (e) => {
			e.preventDefault();
			try {
				A()._setMe(await A().api("/api/me", { method: "PATCH", body: { name: name.value } }));
				toast("Saved.", "good");
			} catch (err) {
				fail(err);
			}
		};
		sections.push(section("You", who, nameRow));

		// Settings.
		const toggle = (label, key) => {
			const l = el("label", "toggle");
			const box = el("input");
			box.type = "checkbox";
			box.checked = !!me[key];
			box.dataset.setting = key;
			box.onchange = async () => {
				try {
					A()._setMe(await A().api("/api/me", { method: "PATCH", body: { [key]: box.checked } }));
				} catch (err) {
					box.checked = !box.checked;
					fail(err);
				}
			};
			l.append(box, el("span", null, label));
			return l;
		};
		sections.push(section("Privacy", toggle("Hide me from public leaderboards (and the public snapshot)", "hidePublic"), toggle("Appear offline to friends", "appearOffline")));

		// Friend code: the public profile link, as text and a QR.
		const code = el("div", "row");
		const link = linkTo(me.id);
		const copy = btn("COPY LINK", async () => {
			try {
				await navigator.clipboard.writeText(link);
				toast("Copied.", "good");
			} catch {
				toast(link);
			}
		});
		code.append(el("span", "code", link), copy);
		const qrRow = el("div", "row");
		try {
			const qr = NeonArcade.qrCanvas(link, { scale: 4 });
			qr.className = "qr";
			qrRow.append(qr);
		} catch {}
		sections.push(section("Your friend code", el("p", "muted", "Anyone who opens this can send you a friend request."), code, qrRow));

		// Friends.
		const friendsBox = el("div");
		sections.push(section("Friends", friendsBox));
		// Groups.
		const groupsBox = el("div");
		sections.push(section("Groups", groupsBox));
		// Ratings and history.
		const ratingsBox = el("div", null, "…");
		const historyBox = el("div", null, "…");
		sections.push(section("Ratings", ratingsBox), section("Recent ranked matches", historyBox));
		sections.push(section("Appearance", NeonArcade.theme.picker()));
		// Favourites.
		const favs = NeonArcade.stats?.favs() ?? [];
		sections.push(section("Favourites", favs.length ? el("p", null, favs.map(titleOf).join(", ")) : el("p", "muted", "Tap ☆ on a game in the portal.")));
		sections.push(section("On this device", localStats()));

		// Your data.
		const data = el("div", "row");
		data.append(
			btn("EXPORT MY DATA", async () => {
				try {
					const all = await A().api("/api/me/export");
					const a = el("a");
					a.href = URL.createObjectURL(new Blob([JSON.stringify(all, null, 2)], { type: "application/json" }));
					a.download = "arcade-account.json";
					a.click();
				} catch (err) {
					fail(err);
				}
			}),
			btn("SIGN OUT", async () => {
				await A().signOut();
				draw();
			}),
			btn("DELETE MY ACCOUNT", async () => {
				const ok = await UI().confirm(
					"Delete your account and everything in it — ratings, history, friends, groups you own, favourites? Matches stay in the other players' histories without your name. Public snapshots already published keep your name and rating until the next one. This cannot be undone.",
					{ ok: "DELETE", cancel: "KEEP IT" },
				);
				if (!ok) return;
				try {
					await A().deleteAccount();
					toast("Your account is deleted.", "good");
					draw();
				} catch (err) {
					fail(err);
				}
			}, "neon-btn neon-btn--danger"),
		);
		sections.push(section("Your data", data));
		page().replaceChildren(...sections);

		drawFriends(friendsBox);
		drawGroups(groupsBox);
		A()
			.api("/api/me/matches")
			.then((r) => {
				ratingsBox.replaceChildren(ratingsTable(r.ratings));
				historyBox.replaceChildren(historyList(r.matches, me.id));
			})
			.catch((err) => {
				ratingsBox.textContent = historyBox.textContent = `Could not load (${err.message}).`;
			});
	}

	async function drawFriends(box) {
		const f = await UI().loadFriends(true);
		box.replaceChildren();
		if (!f) return box.append(el("p", "muted", "Could not load your friends."));
		for (const p of f.incoming) {
			const item = el("div", "item");
			item.append(
				el("div", "grow", `${p.name} wants to be friends`),
				btn("ACCEPT", async () => {
					await A().api(`/api/friends/${encodeURIComponent(p.id)}`, { method: "POST" }).catch(fail);
					drawFriends(box);
				}, "party-mini"),
				btn("DECLINE", async () => {
					await A().api(`/api/friends/${encodeURIComponent(p.id)}`, { method: "DELETE" }).catch(fail);
					drawFriends(box);
				}, "party-mini"),
			);
			item.dataset.incoming = p.id;
			box.append(item);
		}
		for (const p of f.friends) {
			const item = el("div", "item");
			const who = el("a", "grow");
			who.href = `?u=${encodeURIComponent(p.id)}`;
			who.style.color = "inherit";
			const dot = el("span", "dot" + (p.online ? " on" : ""));
			who.append(dot, p.name, el("span", "muted", p.online ? (p.game ? ` · playing ${titleOf(p.game)}` : " · online") : ""));
			item.append(
				who,
				btn("REMOVE", async () => {
					if (!(await UI().confirm(`Remove ${p.name} from your friends?`, { ok: "REMOVE" }))) return;
					await A().api(`/api/friends/${encodeURIComponent(p.id)}`, { method: "DELETE" }).catch(fail);
					drawFriends(box);
				}, "party-mini"),
			);
			item.dataset.friend = p.id;
			box.append(item);
		}
		for (const p of f.outgoing) {
			const item = el("div", "item");
			item.append(
				el("div", "grow muted", `${p.name} — asked`),
				btn("WITHDRAW", async () => {
					await A().api(`/api/friends/${encodeURIComponent(p.id)}`, { method: "DELETE" }).catch(fail);
					drawFriends(box);
				}, "party-mini"),
			);
			box.append(item);
		}
		if (!f.friends.length && !f.incoming.length && !f.outgoing.length) box.append(el("p", "muted", "No friends yet. Share your friend code, or use ADD FRIEND in a party."));
		const add = el("form", "row");
		const input = el("input");
		input.type = "text";
		input.placeholder = "A friend's code or link";
		input.setAttribute("aria-label", "Friend code or link");
		add.append(input, el("button", "neon-btn", "ADD"));
		add.onsubmit = async (e) => {
			e.preventDefault();
			const raw = input.value.trim();
			const id = raw.match(/[?&]u=([^&#]+)/)?.[1] ?? raw;
			if (!id) return;
			try {
				const r = await A().api(`/api/friends/${encodeURIComponent(decodeURIComponent(id))}`, { method: "POST" });
				toast(r.state === "friends" ? "You are friends now." : "Friend request sent.", "good");
				input.value = "";
				drawFriends(box);
			} catch (err) {
				fail(err);
			}
		};
		box.append(add);
	}

	async function drawGroups(box) {
		let groups = [];
		try {
			groups = (await A().api("/api/groups")).groups;
		} catch (err) {
			box.replaceChildren(el("p", "muted", `Could not load your groups (${err.message}).`));
			return;
		}
		box.replaceChildren();
		for (const g of groups) {
			const item = el("div", "item");
			const left = el("div", "grow");
			const lb = el("a", null, g.name);
			lb.href = `leaderboard.html?scope=${encodeURIComponent(`group:${g.id}`)}`;
			lb.style.color = "var(--accent)";
			left.append(lb, el("div", "muted", `${g.members} member${g.members === 1 ? "" : "s"} · code `), );
			left.lastChild.append(el("span", "code", g.code));
			const share = btn("SHARE", async () => {
				const url = `${location.origin}${location.pathname}?join=${g.code}`;
				try {
					if (navigator.share) await navigator.share({ title: g.name, text: `Join "${g.name}" on Arcade Games`, url });
					else {
						await navigator.clipboard.writeText(url);
						toast("Join link copied.", "good");
					}
				} catch {}
			}, "party-mini");
			const leave = btn(g.mine ? "DELETE" : "LEAVE", async () => {
				const ok = await UI().confirm(g.mine ? `Delete "${g.name}" for everyone?` : `Leave "${g.name}"?`, { ok: g.mine ? "DELETE" : "LEAVE" });
				if (!ok) return;
				const path = g.mine ? `/api/groups/${g.id}` : `/api/groups/${g.id}/members/${A().me.id}`;
				await A().api(path, { method: "DELETE" }).catch(fail);
				drawGroups(box);
			}, "party-mini");
			item.append(left, share, leave);
			item.dataset.group = g.id;
			box.append(item);
		}
		if (!groups.length) box.append(el("p", "muted", "A group is a few people with their own leaderboard: only games they play together count."));
		const make = el("form", "row");
		const name = el("input");
		name.type = "text";
		name.placeholder = "New group's name";
		name.maxLength = 32;
		name.setAttribute("aria-label", "New group name");
		make.append(name, el("button", "neon-btn", "CREATE"));
		make.onsubmit = async (e) => {
			e.preventDefault();
			try {
				const g = await A().api("/api/groups", { method: "POST", body: { name: name.value } });
				toast(`Made "${g.name}" — share code ${g.code}.`, "good");
				drawGroups(box);
			} catch (err) {
				fail(err);
			}
		};
		const join = el("form", "row");
		const code = el("input");
		code.type = "text";
		code.placeholder = "A group's join code";
		code.setAttribute("aria-label", "Group join code");
		join.append(code, el("button", "neon-btn", "JOIN"));
		join.onsubmit = async (e) => {
			e.preventDefault();
			try {
				const g = await A().api("/api/groups/join", { method: "POST", body: { code: code.value } });
				toast(`Joined "${g.name}".`, "good");
				drawGroups(box);
			} catch (err) {
				fail(err);
			}
		};
		box.append(make, join);
	}

	async function draw() {
		const other = q.get("u");
		if (A()?.signedIn() && !A().me) await A().load();
		if (other && other !== A()?.me?.id) return publicProfile(other);
		if (!A()?.me) {
			if (q.get("join")) toast("Sign in, then you will join the group.", "");
			return signedOut();
		}
		const join = q.get("join");
		if (join) {
			try {
				const g = await A().api("/api/groups/join", { method: "POST", body: { code: join } });
				toast(`Joined "${g.name}".`, "good");
			} catch (err) {
				fail(err);
			}
			q.delete("join");
			history.replaceState(null, "", `${location.pathname}${q.size ? `?${q}` : ""}`);
		}
		return mine();
	}

	NeonArcade.profilePage = { draw };
	document.addEventListener("DOMContentLoaded", draw);
})();
