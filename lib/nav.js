// lib/nav.js — the row at the top of the arcade's own pages (portal,
// leaderboards, collections, contributors, profile, add-your-game).
//
//   tabs   Games · Leaderboards · Community, and under Community its own
//          Collections · Contributors
//   ☰      a menu: Add your game, Theme, sign in — or who you are — and the
//          source on GitHub. Friend requests waiting for an answer show as a
//          count on ☰ and on your entry in it (lib/account-ui.js incomingCount).
//
// One row, phone and desktop alike: the buttons that used to sit above the
// tabs crowded a phone (Lokesh, 2026-11-15).
//
// A page marks where it goes with <nav data-nav data-page="games|leaderboard|
// contributors|collections|profile|contribute"></nav>. Game pages and the party keep
// their "← All games" pill instead: a running game has no room for a bar.

window.NeonArcade = window.NeonArcade || {};

(() => {
	const REPO = "https://github.com/lokeshmohanty/games";
	// The views keep their own addresses (src/router.ts); Community opens on
	// its first page.
	const TABS = [
		["games", "Games", "./"],
		["leaderboard", "Leaderboards", "./?page=leaderboard"],
		["community", "Community", "./?page=collections"],
	];
	const COMMUNITY = [
		["collections", "Collections", "./?page=collections"],
		["contributors", "Contributors", "./?page=contributors"],
	];
	let menus = 0;
	const tabOf = (page) => (COMMUNITY.some(([id]) => id === page) ? "community" : page);
	const el = (tag, cls, text) => {
		const n = document.createElement(tag);
		if (cls) n.className = cls;
		if (text != null) n.textContent = text;
		return n;
	};
	// GitHub's mark, inline: no request, and it takes the theme's ink.
	const GITHUB =
		'<svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';

	/** The waiting friend requests, as a badge on `node` (none: no badge). */
	function badge(node) {
		const n = NeonArcade.accountUi?.incomingCount?.() ?? 0;
		let b = node.querySelector(":scope > .site-badge");
		if (!n) return void b?.remove();
		if (!b) {
			b = el("span", "site-badge");
			node.append(b);
		}
		b.textContent = n > 9 ? "9+" : String(n);
		b.setAttribute("aria-label", `${n} friend request${n === 1 ? "" : "s"}`);
	}
	function badges() {
		for (const n of document.querySelectorAll(".site-menu-btn, .site-menu-item.acct-me")) badge(n);
		for (const b of document.querySelectorAll(".site-menu-btn")) {
			const n = NeonArcade.accountUi?.incomingCount?.() ?? 0;
			b.setAttribute("aria-label", n ? `Menu, ${n} friend request${n === 1 ? "" : "s"}` : "Menu");
		}
	}

	function item(tag, cls, label) {
		const n = el(tag, "site-menu-item" + (cls ? ` ${cls}` : ""));
		if (tag === "button") n.type = "button";
		if (label != null) n.append(label);
		return n;
	}

	// The ☰ button and its list. It closes on a choice, a tap outside, or Esc,
	// and gives focus back to the button.
	function menu(page) {
		const wrap = el("div", "site-menu");
		const btn = el("button", "site-menu-btn");
		btn.type = "button";
		btn.setAttribute("aria-expanded", "false");
		btn.setAttribute("aria-label", "Menu");
		btn.title = "Menu";
		btn.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';
		const list = el("div", "site-menu-list");
		list.id = `site-menu-${++menus}`;
		btn.setAttribute("aria-controls", list.id);
		list.hidden = true;

		const add = item("a", page === "contribute" ? "is-on" : "", "Add your game");
		add.href = "./?page=contribute";
		const look = item("button", "acct-theme", "Theme");
		look.onclick = () => {
			const { body } = NeonArcade.accountUi.sheet("Theme");
			body.append(NeonArcade.theme.picker());
		};
		list.append(add, look);
		const A = NeonArcade.account;
		if (A?.me) {
			const me = item("a", "acct-me" + (page === "profile" ? " is-on" : ""));
			me.href = "./?page=profile";
			if (A.me.avatar) {
				const img = el("img");
				img.src = A.me.avatar;
				img.alt = "";
				img.referrerPolicy = "no-referrer";
				me.append(img);
			}
			me.append(el("span", "site-menu-name", A.me.name));
			list.append(me);
		} else if (A?.signedIn()) {
			const me = item("a", "acct-me" + (page === "profile" ? " is-on" : ""), "Profile");
			me.href = "./?page=profile";
			list.append(me);
		} else if (A) {
			const sign = item("button", "acct-signin", "Sign in");
			sign.onclick = () => NeonArcade.accountUi?.signInChooser();
			list.append(sign);
		}
		const gh = item("a", "site-menu-gh");
		gh.href = REPO;
		gh.target = "_blank";
		gh.rel = "noopener";
		gh.innerHTML = GITHUB;
		gh.append("Source on GitHub");
		list.append(gh);

		const outside = (e) => !wrap.contains(e.target) && set(false);
		const esc = (e) => {
			if (e.key !== "Escape") return;
			set(false);
			btn.focus();
		};
		function set(open) {
			list.hidden = !open;
			btn.setAttribute("aria-expanded", String(open));
			wrap.classList.toggle("is-open", open);
			const how = open ? "addEventListener" : "removeEventListener";
			document[how]("pointerdown", outside, true);
			document[how]("keydown", esc);
			if (open) list.querySelector(".site-menu-item")?.focus();
		}
		btn.onclick = () => set(list.hidden);
		// A choice closes the list first; a sheet it opens takes the focus.
		list.addEventListener("click", (e) => e.target.closest(".site-menu-item") && set(false));
		wrap.append(btn, list);
		return wrap;
	}

	function tabRow(cls, entries, on) {
		const t = el("div", cls);
		t.setAttribute("role", "list");
		for (const [id, label, href] of entries) {
			const a = el("a", (cls === "site-tabs" ? "site-tab" : "site-subtab") + (id === on ? " is-on" : ""), label);
			a.href = href;
			a.setAttribute("role", "listitem");
			if (id === on) a.setAttribute("aria-current", "page");
			t.append(a);
		}
		return t;
	}

	function draw() {
		for (const nav of document.querySelectorAll("[data-nav]")) {
			const page = nav.dataset.page ?? "";
			nav.setAttribute("aria-label", "Arcade");
			const row = el("div", "site-row");
			row.append(tabRow("site-tabs", TABS, tabOf(page)), menu(page));
			nav.replaceChildren(row);
			if (tabOf(page) === "community") nav.append(tabRow("site-subtabs", COMMUNITY, page));
		}
		badges();
	}

	NeonArcade.nav = { draw, REPO };
	document.addEventListener("DOMContentLoaded", () => {
		draw();
		NeonArcade.account?.onChange(draw);
	});
	// A new friends list: only the counts change, so an open menu stays open.
	document.addEventListener("neon:friends", badges);
})();
