// lib/nav.js — the bar and tabs at the top of the arcade's own pages
// (portal, leaderboards, contributors, profile, add-your-game).
//
//   left   the source on GitHub, and "Add your game" (contribute.html)
//   right  the theme, and sign in — or who you are
//   tabs   Games · Leaderboards · Contributors
//
// A page marks where it goes with <nav data-nav data-page="games|leaderboard|
// contributors|profile|contribute"></nav>. Game pages and the party keep
// their "← All games" pill instead: a running game has no room for a bar.

window.NeonArcade = window.NeonArcade || {};

(() => {
	const REPO = "https://github.com/lokeshmohanty/games";
	const TABS = [
		["games", "Games", "index.html"],
		["leaderboard", "Leaderboards", "leaderboard.html"],
		["contributors", "Contributors", "contributors.html"],
	];
	const el = (tag, cls, text) => {
		const n = document.createElement(tag);
		if (cls) n.className = cls;
		if (text != null) n.textContent = text;
		return n;
	};
	// GitHub's mark, inline: no request, and it takes the theme's ink.
	const GITHUB =
		'<svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';

	function bar(page) {
		const left = el("div", "site-left");
		const gh = el("a", "site-link site-icon");
		gh.href = REPO;
		gh.target = "_blank";
		gh.rel = "noopener";
		gh.title = "The arcade's source on GitHub";
		gh.setAttribute("aria-label", "The arcade's source on GitHub");
		gh.innerHTML = GITHUB;
		const add = el("a", "site-link" + (page === "contribute" ? " is-on" : ""), "Add your game");
		add.href = "contribute.html";
		left.append(gh, add);

		const right = el("div", "site-right");
		const look = el("button", "site-link acct-theme", "Theme");
		look.type = "button";
		look.setAttribute("aria-label", "Choose a theme");
		look.onclick = () => {
			const { body } = NeonArcade.accountUi.sheet("Theme");
			body.append(NeonArcade.theme.picker());
		};
		right.append(look);
		const A = NeonArcade.account;
		if (A?.me) {
			const me = el("a", "site-link acct-me" + (page === "profile" ? " is-on" : ""));
			me.href = "profile.html";
			if (A.me.avatar) {
				const img = el("img");
				img.src = A.me.avatar;
				img.alt = "";
				img.referrerPolicy = "no-referrer";
				me.append(img);
			}
			me.append(A.me.name);
			right.append(me);
		} else if (A?.signedIn()) {
			const me = el("a", "site-link acct-me", "Profile");
			me.href = "profile.html";
			right.append(me);
		} else if (A) {
			const sign = el("button", "site-link acct-signin", "Sign in");
			sign.type = "button";
			sign.onclick = () => NeonArcade.accountUi?.signInChooser();
			right.append(sign);
		}
		const row = el("div", "site-bar");
		row.append(left, right);
		return row;
	}

	function tabs(page) {
		const t = el("div", "site-tabs");
		t.setAttribute("role", "list");
		for (const [id, label, href] of TABS) {
			const a = el("a", "site-tab" + (id === page ? " is-on" : ""), label);
			a.href = href;
			a.setAttribute("role", "listitem");
			if (id === page) a.setAttribute("aria-current", "page");
			t.append(a);
		}
		return t;
	}

	function draw() {
		for (const nav of document.querySelectorAll("[data-nav]")) {
			const page = nav.dataset.page ?? "";
			nav.setAttribute("aria-label", "Arcade");
			nav.replaceChildren(bar(page), tabs(page));
		}
	}

	NeonArcade.nav = { draw, REPO };
	document.addEventListener("DOMContentLoaded", () => {
		draw();
		NeonArcade.account?.onChange(draw);
	});
})();
