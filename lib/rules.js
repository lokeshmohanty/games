// lib/rules.js — a game's rules, shown by the shell (Lokesh, 2026-11-15:
// "the first time the user opens it, a screen with the game rules … and a '?'
// button so that the player can see this anytime").
//
// A game names a Markdown file in its folder (manifest "rules", e.g.
// RULES.md; docs/sdk-v2.md). The shell fetches it from the game's own folder
// (same origin, so offline from the service worker's snapshot: assemble.mjs
// and fetch-community.mjs precache it) and draws it with lib/markdown.js in a
// sheet over the game. Nothing is sent to the game or the party: the sheet is
// this phone's alone, and a game running underneath keeps running for
// everyone, this phone included.
//
//   NeonArcade.rules.has(game)              does it have rules?
//   NeonArcade.rules.show(game)             the sheet, now ("?")
//   NeonArcade.rules.firstOpen(game, still) the sheet, if this device has
//                                           not seen it (party.js, on mount)
//
// Seen is per game and per device: localStorage "neon.rules.<id>". Under
// automation (navigator.webdriver) the first-open sheet stays away, so the
// suites that drive games are not stopped by it; localStorage "neon.rules"
// = "on" brings it back (scripts/test-rules-screen.mjs), "off" turns it off.

window.NeonArcade = window.NeonArcade || {};

(() => {
	const seenKey = (id) => `neon.rules.${id}`;
	const store = {
		get(k) {
			try {
				return localStorage.getItem(k);
			} catch {
				return null;
			}
		},
		set(k, v) {
			try {
				localStorage.setItem(k, v);
			} catch {}
		},
	};

	const has = (game) => typeof game?.rules === "string" && !!game.rules;
	/** The rules file's address: the game's folder, then the manifest's path. */
	const urlOf = (game) => new URL(game.rules, game.base ?? new URL(game.path ?? "", document.baseURI)).href;
	const seen = (id) => store.get(seenKey(id)) === "seen";
	const markSeen = (id) => store.set(seenKey(id), "seen");
	const autoOpen = () => {
		const v = store.get("neon.rules");
		return v ? v === "on" : !navigator.webdriver;
	};

	// One fetch per game per page; a failure is forgotten, so "?" tries again.
	const texts = new Map();
	function load(game) {
		const url = urlOf(game);
		if (!texts.has(url)) {
			texts.set(
				url,
				fetch(url).then((r) => {
					if (!r.ok) throw new Error(`${r.status}`);
					return r.text();
				}),
			);
			texts.get(url).catch(() => texts.delete(url));
		}
		return texts.get(url);
	}

	const el = (tag, cls, text) => {
		const n = document.createElement(tag);
		if (cls) n.className = cls;
		if (text != null) n.textContent = text;
		return n;
	};

	let open = null; // the <dialog> on screen
	function close() {
		open?.close();
	}

	/** The rules sheet for `game`, now. Resolves when it is drawn. */
	async function show(game) {
		if (!has(game)) return;
		open?.remove();
		const d = el("dialog", "neon-sheet rules-sheet");
		d.dataset.game = game.id;
		d.setAttribute("aria-label", `How to play ${game.title ?? game.name ?? ""}`.trim());
		const head = el("div", "neon-sheet-head");
		const x = el("button", "neon-sheet-x", "✕");
		x.type = "button";
		x.setAttribute("aria-label", "Close");
		x.onclick = () => d.close();
		head.append(el("h2", null, "RULES"), x);
		const body = el("div", "neon-sheet-body rules-body");
		body.append(el("p", "neon-sheet-small", "Loading the rules…"));
		const foot = el("div", "rules-foot");
		const ok = el("button", "neon-btn neon-btn--accent rules-ok", "GOT IT");
		ok.type = "button";
		ok.autofocus = true;
		ok.onclick = () => d.close();
		foot.append(ok);
		d.append(head, body, foot);
		// However it closes (GOT IT, ✕, Escape, a tap outside), it has been seen.
		d.addEventListener("close", () => {
			markSeen(game.id);
			d.remove();
			if (open === d) open = null;
		});
		d.addEventListener("click", (e) => e.target === d && d.close());
		document.body.append(d);
		d.showModal();
		open = d;
		try {
			const md = await load(game);
			const base = urlOf(game).replace(/[^/]*$/, "");
			body.innerHTML = NeonArcade.markdown?.render(md, { base }) ?? "";
			if (!NeonArcade.markdown) body.append(el("pre", null, md));
		} catch {
			body.replaceChildren(el("p", "neon-sheet-text", "The rules could not be loaded. Try again with ? once you are online."));
		}
		body.scrollTop = 0;
	}

	/**
	 * The sheet, the first time this device opens `game`: fetched first, so a
	 * failed fetch shows nothing (and it is offered again next time), and
	 * dropped when `still()` says the game is no longer the one mounted.
	 */
	async function firstOpen(game, still = () => true) {
		if (!has(game) || seen(game.id) || !autoOpen()) return false;
		try {
			await load(game);
		} catch {
			return false;
		}
		if (!still() || seen(game.id) || open?.dataset.game === game.id) return false;
		await show(game);
		return true;
	}

	/** Whether the sheet is open now (lib/sdk-host.js pauses a game played alone). */
	const isOpen = () => !!open;
	NeonArcade.rules = { has, show, firstOpen, close, seen, url: urlOf, isOpen };
})();
