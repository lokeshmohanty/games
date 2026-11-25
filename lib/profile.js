// lib/profile.js — the profile view: your account, a group, or someone's
// public profile.
//
//   ./?page=profile            you: name, then friends (requests first) and
//                              your friend code, players you just played,
//                              groups, trophies, head-to-head (the people
//                              you have played, your record against each),
//                              history, settings, your data. Signed out: sign
//                              in, this device's own stats and trophies.
//   ./?page=profile&u=<who>    a player's public profile (recent matches; a
//                              friend's trophies and records; signed in, your
//                              head-to-head against them) with ADD FRIEND —
//                              the friend link and QR (<who>: a friend code,
//                              or an account id from before friend codes).
//   ./?page=profile&group=<id> a group: members and its code; the
//                              owner renames, rotates the code, removes, hands
//                              it over (worker/api/social.js).
//   ./?page=profile&join=<code> join a group by its code after signing in.
//
//   NeonArcade.profilePage.mount(root) → cleanup
//                              draws into root's [data-profile] (and its
//                              [data-title]) from the address as it is now;
//                              src/views/Profile.tsx mounts it again whenever
//                              the address changes.

window.NeonArcade = window.NeonArcade || {};

(() => {
	const A = () => NeonArcade.account;
	const UI = () => NeonArcade.accountUi;
	// The mount being drawn: its box and title, and the address it was drawn
	// from. Replaced on every mount, so a slow load for an earlier address
	// (another profile, or a view already left) draws into nothing.
	let ctx = null;
	const nowhere = () => document.createElement("div");
	const page = () => ctx?.box ?? nowhere();
	const title = () => ctx?.title ?? nowhere();
	/** Still drawing for the mount that was current as `c`? */
	const current = (c) => c === ctx;
	/** A link into this view, as a full address (shared, and in the QR). */
	const here = (query) => new URL(`./?page=profile&${query}`, location.href).href;
	/** Go somewhere in the arcade (src/router.ts takes the click). */
	const go = (href) => {
		const a = el("a");
		a.href = href;
		document.body.append(a);
		a.click();
		a.remove();
	};

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
	/** A section tests and links can find: [data-section=<key>]. */
	const keyed = (key, title, ...kids) => {
		const s = section(title, ...kids);
		s.dataset.section = key;
		return s;
	};
	const titleOf = (id) => [...(NeonArcade.CATALOG ?? []), ...(NeonArcade.UNLISTED ?? [])].find((c) => c.id === id)?.title ?? id;
	const toast = (t, k) => NeonArcade.toast?.(t, k);
	const fail = (err) => toast(err.message, "warn");
	const linkTo = (who) => here(`u=${encodeURIComponent(who)}`);
	/** ABCD-EFGH: a friend code as people read it out. */
	const spaced = (code) => (code && code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code ?? "");
	const day = (t) => new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

	function avatar(src) {
		const img = el("img");
		img.alt = "";
		img.referrerPolicy = "no-referrer";
		img.src = src || "assets/icon.svg";
		img.onerror = () => (img.src = "assets/icon.svg");
		return img;
	}

	/**
	 * A QR code as SVG: one path of whole modules with crispEdges, so it is
	 * sharp at any pixel density (audit D17: a 164 px canvas stretched over
	 * 132 CSS px at a phone's 3.5 was blurry).
	 */
	function qrSvg(text) {
		const { size, modules } = NeonArcade.qrMatrix(text, { ecl: "M" });
		const quiet = 4;
		const dim = size + quiet * 2;
		let d = "";
		for (let y = 0; y < size; y++) {
			for (let x = 0; x < size; x++) if (modules[y][x]) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
		}
		const NS = "http://www.w3.org/2000/svg";
		const svg = document.createElementNS(NS, "svg");
		svg.setAttribute("viewBox", `0 0 ${dim} ${dim}`);
		svg.setAttribute("class", "qr");
		svg.setAttribute("shape-rendering", "crispEdges");
		svg.setAttribute("role", "img");
		svg.setAttribute("aria-label", "QR code of your friend link");
		const bg = document.createElementNS(NS, "rect");
		bg.setAttribute("width", String(dim));
		bg.setAttribute("height", String(dim));
		bg.setAttribute("fill", "#fff"); // theme-exempt: a QR code is black on white for the camera
		const path = document.createElementNS(NS, "path");
		path.setAttribute("d", d);
		path.setAttribute("fill", "#000"); // theme-exempt: a QR code is black on white for the camera
		svg.append(bg, path);
		return svg;
	}

	// ---------------------------------------------------- head-to-head
	// No ratings and no boards (Lokesh, 2026-11-25: casual, not competitive):
	// what the account shows of how you play is who you beat and who beat
	// you, person by person (worker/api/match.js headToHead).

	/** "3–2", or "3–2–1" with draws: wins, losses, draws. */
	const record = (x) => `${x.wins}–${x.losses}${x.draws ? `–${x.draws}` : ""}`;
	const legend = (x) => (x.draws ? "won–lost–drawn" : "won–lost");

	/** Your record against one person (their profile): the total, then by game. */
	function versusSection(vs, name) {
		const total = vs.wins + vs.losses + vs.draws;
		if (!total) return keyed("vs", "Head-to-head", el("p", "muted", `You have not played ${name} yet — or not signed in, both of you.`));
		const line = el("p", "vs-total");
		line.append(el("span", "vs-you", "You "), el("span", "vs-score", record(vs)), el("span", "vs-them", ` ${name}`));
		const t = el("table");
		t.innerHTML = `<thead><tr><th>Game</th><th class="n">Won</th><th class="n">Lost</th><th class="n">Drawn</th></tr></thead>`;
		const tb = el("tbody");
		for (const [game, x] of Object.entries(vs.games).sort((a, b) => b[1].wins + b[1].losses + b[1].draws - (a[1].wins + a[1].losses + a[1].draws))) {
			const tr = el("tr");
			tr.dataset.game = game;
			tr.append(el("td", null, titleOf(game)), el("td", "n", String(x.wins)), el("td", "n", String(x.losses)), el("td", "n", String(x.draws)));
			tb.append(tr);
		}
		t.append(tb);
		return keyed("vs", "Head-to-head", line, el("p", "muted", legend(vs)), t);
	}

	/** The people you have played, most recent first, each a link to their profile with your record. */
	function rivalsList(rivals) {
		if (!rivals.length) return el("p", "muted", "Play someone who is signed in, and your record against them shows here.");
		const wrap = el("div");
		for (const r of rivals) {
			const a = el("a", "item rival");
			a.href = linkTo(r.id);
			a.dataset.rival = r.id;
			a.setAttribute("aria-label", `${r.name}: ${record(r)} (${legend(r)})`);
			a.append(el("span", "grow", r.name), el("span", `n ${r.wins > r.losses ? "won" : r.wins < r.losses ? "lost" : "even"}`, record(r)));
			wrap.append(a);
		}
		return wrap;
	}

	function historyList(matches, me) {
		if (!matches.length) return el("p", "muted", "No matches with signed-in players yet.");
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
			// A draw or a game played together is neither a win nor a loss.
			item.append(left, el("span", how === "won" ? "won" : how === "lost" ? "lost" : "even", how.toUpperCase()));
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

	/**
	 * Trophies and records (lib/records.js): this device's, which the account
	 * keeps in step when signed in. Repainted when a result or a sync changes them.
	 */
	function trophiesSection(note = null) {
		const R = NeonArcade.records;
		if (!R) return [];
		const box = el("div");
		const paint = () => box.replaceChildren(R.trophies());
		paint();
		const off = R.onChange(() => (box.isConnected ? paint() : off()));
		return [keyed("trophies", "Trophies and records", ...(note ? [el("p", "muted", note)] : []), box)];
	}

	function signedOut() {
		title().textContent = "Profile";
		const row = el("div", "row");
		row.append(btn("SIGN IN WITH GITHUB", () => A().signIn("github"), "neon-btn neon-btn--accent"), btn("SIGN IN WITH GOOGLE", () => A().signIn("google"), "neon-btn neon-btn--accent"));
		page().replaceChildren(
			section(
				"Sign in",
				el("p", null, "Optional. Keep favourites on every device, see how you do against the people you play, see friends online and invite them, make groups."),
				row,
				el("p", "muted", "We keep a display name, an avatar and a random id — never your email. You can export or delete everything at any time."),
			),
			section("On this device", localStats()),
			...trophiesSection(),
			section("Appearance", NeonArcade.theme.picker()),
		);
	}

	// ------------------------------------------------------- public profile

	async function publicProfile(who) {
		const c = ctx;
		page().replaceChildren(el("p", "muted", "Loading…"));
		try {
			// Signed in: a friend may see a hidden player's whole profile.
			const p = await A().api(`/api/u/${encodeURIComponent(who)}`, { auth: !!A().me });
			if (!current(c)) return;
			const me = A().me;
			if (me && p.id === me.id) return mine(); // your own friend link
			title().textContent = p.name;
			const whoBox = el("div", "who");
			whoBox.append(avatar(p.avatar), el("div", "name", p.name));
			const actions = el("div", "row");
			if (me) {
				await UI().loadFriends(true);
				if (!current(c)) return;
				const add = UI().addButton(p.id, p.name);
				add.className = "neon-btn neon-btn--accent";
				actions.append(add);
			} else {
				actions.append(btn("SIGN IN TO ADD AS A FRIEND", () => UI().signInChooser()));
			}
			if (p.hidden && !p.matches) {
				// Hidden: a name to befriend, nothing more.
				page().replaceChildren(section("Player", whoBox, el("p", "muted", "Keeps their games private. Friends see their profile."), actions));
				return;
			}
			page().replaceChildren(
				section("Player", whoBox, ...(p.hidden ? [el("p", "muted", "Keeps their profile private — you see this as their friend.")] : []), actions),
				// Signed in: how you do against them (worker/api/people.js `vs`).
				...(p.vs ? [versusSection(p.vs, p.name)] : []),
				// Only a friend gets their records (worker/api/people.js).
				...(p.records ? [keyed("trophies", "Trophies and records", NeonArcade.records?.trophies(p.records, { name: p.name }) ?? el("p", "muted", "…"))] : []),
				section("Recent matches", historyList(p.matches, p.id)),
			);
		} catch (err) {
			if (!current(c)) return;
			page().replaceChildren(section("Player", el("p", null, err.status === 404 ? "No such player — the link may be old, or its code was changed." : `Could not load it (${err.message}).`)));
		}
	}

	// ------------------------------------------------------- your profile

	async function mine() {
		const me = A().me;
		title().textContent = "Your profile";
		const sections = [];

		// Who: avatar, name (editable), provider.
		const who = el("div", "who");
		const nameBox = el("div", "grow");
		nameBox.append(el("div", "name", me.name), el("div", "muted", `Signed in with ${(me.identities ?? []).map((i) => ({ github: "GitHub", google: "Google" })[i.provider] ?? i.provider).join(" and ") || me.provider}`));
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
		sections.push(keyed("you", "You", who, nameRow));

		// Friends next, requests first (Lokesh, 2026-11-16: they were more than
		// a phone's screen down).
		const friendsBox = el("div");
		sections.push(keyed("friends", "Friends", friendsBox));

		// Friend code: the friend link, as text and a QR. A short code that can
		// be changed (an old link then stops working), not the account id.
		const code = me.friendCode;
		const link = linkTo(code ?? me.id);
		const codeRow = el("div", "row");
		if (code) codeRow.append(el("span", "code friend-code", spaced(code)));
		const copy = btn("COPY LINK", async () => {
			try {
				await navigator.clipboard.writeText(link);
				toast("Copied.", "good");
			} catch {
				toast(link);
			}
		});
		codeRow.append(copy);
		if (code) {
			codeRow.append(
				btn("NEW CODE", async () => {
					if (!(await UI().confirm("Make a new friend code? The links and QR codes you have shared stop working.", { ok: "NEW CODE" }))) return;
					try {
						const r = await A().api("/api/me/friend-code", { method: "POST" });
						A()._setMe({ ...A().me, friendCode: r.friendCode });
						toast("New friend code.", "good");
						draw();
					} catch (err) {
						fail(err);
					}
				}),
			);
		}
		const qrRow = el("div", "row");
		try {
			qrRow.append(qrSvg(link));
		} catch {}
		sections.push(
			keyed("code", "Your friend code", el("p", "muted", "Anyone who opens your link or scans this can send you a friend request."), codeRow, el("p", "code link", link), qrRow),
		);

		// People from your recent matches, to add (drawn if there are any).
		const recentBox = keyed("recent", "Players you just played", el("div", null, "…"));
		recentBox.hidden = true;
		sections.push(recentBox);
		// Groups.
		const groupsBox = el("div");
		sections.push(keyed("groups", "Groups", groupsBox));
		sections.push(...trophiesSection("Your friends see these on your profile and in a party."));
		// Head-to-head and history.
		const rivalsBox = el("div", null, "…");
		const historyBox = el("div", null, "…");
		sections.push(keyed("rivals", "Head-to-head", rivalsBox), section("Recent matches", historyBox));

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
		sections.push(
			section(
				"Privacy",
				toggle("Keep my profile private", "hidePublic"),
				el("p", "muted", "Private, you are left out of other people's match lists and \"Players you just played\", and strangers see only your name. Your friends still see your profile, and the people in groups you are in see you in its member list. Your friend link still lets people add you."),
				toggle("Appear offline to friends", "appearOffline"),
			),
		);
		// Per device, not per account (lib/push.js): this phone or this browser.
		if (NeonArcade.push) sections.push(keyed("notifications", "Notifications", NeonArcade.push.toggle()));

		// Sign-in methods: one account, GitHub and Google both if you like.
		// Feedback is posted from the GitHub one.
		const methods = el("div");
		for (const [provider, label] of [
			["github", "GitHub"],
			["google", "Google"],
		]) {
			const id = (me.identities ?? []).find((i) => i.provider === provider);
			const row = el("div", "item");
			row.dataset.method = provider;
			row.append(el("div", "grow", id ? `${label}${id.login ? ` — @${id.login}` : ""} · connected` : `${label} · not connected`));
			if (id) {
				const off = btn("DISCONNECT", async () => {
					if (!(await UI().confirm(`Disconnect ${label}?${provider === "github" ? " You will not be able to post feedback until you connect it again." : ""}`, { ok: "DISCONNECT" }))) return;
					try {
						await A().disconnect(provider);
						draw();
					} catch (err) {
						fail(err);
					}
				}, "party-mini");
				off.disabled = (me.identities ?? []).length < 2;
				if (off.disabled) off.title = "Connect another sign-in first";
				row.append(off);
			} else {
				row.append(btn("CONNECT", () => A().connect(provider).catch(fail), "party-mini"));
			}
			methods.append(row);
		}
		sections.push(section("Sign-in methods", methods, el("p", "muted", "Feedback on games is posted from your own GitHub account.")));
		sections.push(section("Appearance", NeonArcade.theme.picker()));
		// Favourites.
		const favs = NeonArcade.stats?.favs() ?? [];
		// A contributor is @login, a collection owner/repo (lib/stats.js favId).
		const favName = (id) => (NeonArcade.stats.isGameFav(id) ? titleOf(id) : id.replace(/^contributor:/, "@").replace(/^collection:/, ""));
		sections.push(section("Favourites", favs.length ? el("p", null, favs.map(favName).join(", ")) : el("p", "muted", "Tap ☆ at the top of a game.")));
		sections.push(section("On this device", localStats()));

		// Your data.
		const data = el("div", "row");
		data.append(
			btn("EXPORT MY DATA", async () => {
				try {
					// Matches come in pages (worker/api/me.js EXPORT_PAGE); gather them all.
					const all = await A().api("/api/me/export");
					for (let next = all.matchesNext; next != null; ) {
						const more = await A().api(`/api/me/export?page=${next}`);
						all.matches.push(...more.matches);
						next = more.matchesNext;
					}
					delete all.matchesPage;
					delete all.matchesNext;
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
					"Delete your account and everything in it — history, friends, favourites, trophies? A group you own passes to its longest-standing member. Matches stay in the other players' histories without your name. This cannot be undone.",
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

		drawFriends(friendsBox, await UI().loadFriends());
		drawRecent(recentBox);
		drawGroups(groupsBox);
		A()
			.api("/api/me/matches")
			.then((r) => {
				rivalsBox.replaceChildren(rivalsList(r.rivals ?? []));
				historyBox.replaceChildren(historyList(r.matches, me.id));
			})
			.catch((err) => {
				rivalsBox.textContent = historyBox.textContent = `Could not load (${err.message}).`;
			});
	}

	/** A person's other choices — mute, block, remove — in a sheet, so a phone's row keeps two buttons. */
	function moreSheet(p, kind) {
		const { dialog, body } = UI().sheet(p.name);
		const act = (label, fn, cls = "neon-btn") =>
			btn(label, async () => {
				dialog.close();
				try {
					await fn();
				} catch (err) {
					fail(err);
				}
				await UI().loadFriends(true);
			}, cls);
		const id = encodeURIComponent(p.id);
		const list = el("div", "sheet-actions");
		if (kind === "friend") {
			list.append(
				p.muted
					? act("UNMUTE INVITES", () => A().api(`/api/friends/${id}/mute`, { method: "DELETE" }))
					: act("MUTE INVITES", () => A().api(`/api/friends/${id}/mute`, { method: "POST" })),
				act("REMOVE FRIEND", async () => {
					if (await UI().confirm(`Remove ${p.name} from your friends?`, { ok: "REMOVE" })) await A().api(`/api/friends/${id}`, { method: "DELETE" });
				}),
			);
		}
		list.append(
			act("BLOCK", async () => {
				if (await UI().confirm(`Block ${p.name}? They stop being your friend and cannot ask again or invite you. They are not told.`, { ok: "BLOCK" })) {
					await A().api(`/api/friends/${id}/block`, { method: "POST" });
					toast(`${p.name} is blocked.`, "good");
				}
			}, "neon-btn neon-btn--danger"),
		);
		body.append(el("p", "neon-sheet-text", kind === "friend" ? "Muted, their party invites are dropped quietly; you stay friends." : "Blocked, they cannot ask again. They are not told."), list);
	}

	function drawFriends(box, f) {
		if (!box.isConnected && box.dataset.drawn) return;
		box.dataset.drawn = "1";
		box.replaceChildren();
		if (!f) return box.append(el("p", "muted", "Could not load your friends."));
		const more = (p, kind) => {
			const b = btn("⋯", () => moreSheet(p, kind), "party-mini more");
			b.setAttribute("aria-label", `More for ${p.name}`);
			return b;
		};
		for (const p of f.incoming) {
			const item = el("div", "item request");
			const asks = el("div", "grow");
			asks.append(el("div", "nm", p.name), el("div", "muted", "wants to be friends"));
			item.append(
				asks,
				btn("ACCEPT", async () => {
					await A().api(`/api/friends/${encodeURIComponent(p.id)}`, { method: "POST" }).catch(fail);
					UI().loadFriends(true);
				}, "party-mini is-accent"),
				btn("DECLINE", async () => {
					await A().api(`/api/friends/${encodeURIComponent(p.id)}`, { method: "DELETE" }).catch(fail);
					UI().loadFriends(true);
				}, "party-mini"),
				more(p, "request"),
			);
			item.dataset.incoming = p.id;
			box.append(item);
		}
		for (const p of f.friends) {
			const item = el("div", "item");
			const who = el("a", "grow line");
			who.href = `./?page=profile&u=${encodeURIComponent(p.id)}`;
			who.style.color = "inherit";
			const dot = el("span", "dot" + (p.online ? " on" : ""));
			who.append(dot, p.name, el("span", "muted", (p.online ? (p.game ? ` · playing ${titleOf(p.game)}` : " · online") : "") + (p.muted ? " · muted" : "")));
			item.append(who, more(p, "friend"));
			item.dataset.friend = p.id;
			box.append(item);
		}
		for (const p of f.outgoing) {
			const item = el("div", "item");
			item.append(
				el("div", "grow muted line", `${p.name} — asked`),
				btn("WITHDRAW", async () => {
					await A().api(`/api/friends/${encodeURIComponent(p.id)}`, { method: "DELETE" }).catch(fail);
					UI().loadFriends(true);
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
			const who = raw.match(/[?&]u=([^&#]+)/)?.[1] ?? raw;
			if (!who) return;
			try {
				const r = await A().api(`/api/friends/${encodeURIComponent(decodeURIComponent(who))}`, { method: "POST" });
				toast(r.state === "friends" ? "You are friends now." : "Friend request sent.", "good");
				input.value = "";
				UI().loadFriends(true);
			} catch (err) {
				fail(err);
			}
		};
		box.append(add);
		if (f.blocked?.length) {
			const blocked = el("details", "blocked");
			blocked.append(el("summary", null, `Blocked (${f.blocked.length})`));
			for (const p of f.blocked) {
				const item = el("div", "item");
				item.dataset.blocked = p.id;
				item.append(
					el("div", "grow line", p.name),
					btn("UNBLOCK", async () => {
						await A().api(`/api/friends/${encodeURIComponent(p.id)}/block`, { method: "DELETE" }).catch(fail);
						UI().loadFriends(true);
					}, "party-mini"),
				);
				blocked.append(item);
			}
			box.append(blocked);
		}
	}

	async function drawRecent(box) {
		let players = [];
		try {
			players = (await A().api("/api/friends/recent")).players ?? [];
		} catch {
			return; // a server from before it: no section
		}
		const list = box.querySelector("div");
		list.replaceChildren();
		for (const p of players) {
			const item = el("div", "item");
			item.dataset.recent = p.id;
			const who = el("a", "grow line");
			who.href = `./?page=profile&u=${encodeURIComponent(p.id)}`;
			who.style.color = "inherit";
			who.append(p.name, el("span", "muted", ` · ${titleOf(p.game)}`));
			const add = UI().addButton(p.id, p.name);
			item.append(who, ...(add ? [add] : []));
			list.append(item);
		}
		box.hidden = !players.length;
	}

	async function shareGroup(g) {
		const url = here(`join=${g.code}`);
		try {
			if (navigator.share) await navigator.share({ title: g.name, text: `Join "${g.name}" on Arcade Games`, url });
			else {
				await navigator.clipboard.writeText(url);
				toast("Join link copied.", "good");
			}
		} catch {}
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
			const open = el("a", null, g.name);
			open.href = `./?page=profile&group=${encodeURIComponent(g.id)}`;
			open.style.color = "var(--accent)";
			left.append(open, el("div", "muted", `${g.members} member${g.members === 1 ? "" : "s"}${g.mine ? " · yours" : ""} · code `));
			left.lastChild.append(el("span", "code", g.code));
			item.append(left, btn("SHARE", () => shareGroup(g), "party-mini"));
			item.dataset.group = g.id;
			box.append(item);
		}
		if (!groups.length) box.append(el("p", "muted", "A group is a few people you play with: share its code, and everyone in it can find the others."));
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

	// ------------------------------------------------------- a group

	async function groupPage(id) {
		const c = ctx;
		const back = el("a", "back", "← Your profile");
		back.href = "./?page=profile";
		page().replaceChildren(back, el("p", "muted", "Loading…"));
		let g;
		try {
			g = await A().api(`/api/groups/${encodeURIComponent(id)}`);
		} catch (err) {
			if (!current(c)) return;
			title().textContent = "Group";
			page().replaceChildren(back, section("Group", el("p", null, err.status === 403 ? "You are not in that group." : err.status === 404 ? "No such group — it may have been deleted." : `Could not load it (${err.message}).`)));
			return;
		}
		if (!current(c)) return;
		const me = A().me;
		const redraw = () => current(c) && groupPage(id);
		const call = async (path, opts, said) => {
			try {
				const r = await A().api(path, opts);
				if (said) toast(said, "good");
				return r;
			} catch (err) {
				fail(err);
				return null;
			}
		};
		title().textContent = g.name;
		const base = `/api/groups/${encodeURIComponent(id)}`;

		// The group: its code, shared; the owner renames it and changes the code.
		const codeRow = el("div", "row");
		codeRow.append(el("span", "code", g.code), btn("SHARE", () => shareGroup(g), "party-mini"));
		if (g.mine) {
			codeRow.append(
				btn("NEW CODE", async () => {
					if (!(await UI().confirm("Make a new join code? The old code and its links stop working.", { ok: "NEW CODE" }))) return;
					if (await call(`${base}/code`, { method: "POST" }, "New join code.")) redraw();
				}, "party-mini"),
			);
		}
		const kids = [el("p", "muted", `${g.members.length} member${g.members.length === 1 ? "" : "s"} · made ${day(g.created)}`), codeRow];
		if (g.mine) {
			const rename = el("form", "row");
			const name = el("input");
			name.type = "text";
			name.value = g.name;
			name.maxLength = 32;
			name.setAttribute("aria-label", "Group name");
			rename.append(name, el("button", "neon-btn", "RENAME"));
			rename.onsubmit = async (e) => {
				e.preventDefault();
				if (await call(base, { method: "PATCH", body: { name: name.value } }, "Renamed.")) redraw();
			};
			kids.push(rename);
		}
		const sections = [back, keyed("group", "Group", ...kids)];

		// Members, longest-standing first: who owns it next if the owner goes.
		const members = el("div");
		for (const m of g.members) {
			const item = el("div", "item");
			item.dataset.member = m.id;
			const who = el("a", "grow");
			who.href = `./?page=profile&u=${encodeURIComponent(m.id)}`;
			who.style.color = "inherit";
			const tags = `${m.id === g.owner ? "owner" : ""}${m.id === g.owner && m.id === me.id ? " · " : ""}${m.id === me.id ? "you" : ""}`;
			who.append(el("div", "nm", m.name), ...(tags ? [el("div", "muted", tags)] : []));
			item.append(who);
			if (g.mine && m.id !== me.id) {
				item.append(
					btn("MAKE OWNER", async () => {
						if (!(await UI().confirm(`Hand "${g.name}" to ${m.name}? You stay a member.`, { ok: "HAND OVER" }))) return;
						if (await call(`${base}/owner`, { method: "POST", body: { account: m.id } }, `${m.name} owns it now.`)) redraw();
					}, "party-mini"),
					btn("REMOVE", async () => {
						if (!(await UI().confirm(`Remove ${m.name}? They cannot join again until you let them, and the join code changes.`, { ok: "REMOVE" }))) return;
						if (await call(`${base}/members/${encodeURIComponent(m.id)}`, { method: "DELETE" }, `${m.name} is out; the code changed.`)) redraw();
					}, "party-mini is-danger"),
				);
			}
			members.append(item);
		}
		sections.push(keyed("members", "Members", members));
		if (g.mine && g.bans?.length) {
			const bans = el("div");
			for (const b of g.bans) {
				const item = el("div", "item");
				item.dataset.banned = b.id;
				item.append(
					el("div", "grow line", b.name),
					btn("LET BACK", async () => {
						if (await call(`${base}/bans/${encodeURIComponent(b.id)}`, { method: "DELETE" }, `${b.name} may join again.`)) redraw();
					}, "party-mini"),
				);
				bans.append(item);
			}
			sections.push(keyed("removed", "Removed", bans));
		}

		// Leaving, deleting.
		const out = el("div", "row");
		const heir = g.members.find((m) => m.id !== me.id);
		out.append(
			btn("LEAVE", async () => {
				const q = g.mine ? (heir ? `Leave "${g.name}"? ${heir.name} will own it.` : `Leave "${g.name}"? You are its last member, so it is deleted.`) : `Leave "${g.name}"?`;
				if (!(await UI().confirm(q, { ok: "LEAVE" }))) return;
				if (await call(`${base}/members/${encodeURIComponent(me.id)}`, { method: "DELETE" }, `You left "${g.name}".`)) go("./?page=profile");
			}),
		);
		if (g.mine) {
			out.append(
				btn("DELETE GROUP", async () => {
					if (!(await UI().confirm(`Delete "${g.name}" for everyone?`, { ok: "DELETE" }))) return;
					if (await call(base, { method: "DELETE" }, `"${g.name}" is deleted.`)) go("./?page=profile");
				}, "neon-btn neon-btn--danger"),
			);
		}
		sections.push(section("Leave", out));
		page().replaceChildren(...sections);
	}

	async function draw() {
		const c = ctx;
		const q = new URLSearchParams(location.search);
		const other = q.get("u");
		if (A()?.signedIn() && !A().me) await A().load();
		if (!current(c)) return;
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
			if (!current(c)) return;
			// Off the address, so going back here does not join again. Not a
			// navigation: the view is already drawing this address.
			q.delete("join");
			history.replaceState(null, "", `${location.pathname}${q.size ? `?${q}` : ""}`);
		}
		if (q.get("group")) return groupPage(q.get("group"));
		return mine();
	}

	/** Draw into `root` (its [data-profile] and [data-title]); → cleanup. */
	function mount(root) {
		const c = (ctx = { box: root.querySelector("[data-profile]"), title: root.querySelector("[data-title]") });
		// A new friends list (a request pushed, an answer given): the friends
		// section redraws in place.
		const onFriends = () => {
			const box = current(c) && c.box.querySelector('[data-section="friends"] > div');
			if (box) UI().loadFriends().then((f) => current(c) && drawFriends(box, f));
		};
		document.addEventListener("neon:friends", onFriends);
		draw();
		return () => {
			document.removeEventListener("neon:friends", onFriends);
			if (current(c)) ctx = null;
		};
	}

	NeonArcade.profilePage = { mount, draw };
})();
