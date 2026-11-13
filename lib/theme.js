// lib/theme.js — which theme the arcade wears, and the picker.
//
// Load it in <head>, before any stylesheet paints, so the page never flashes
// the wrong colours: it sets <html data-theme data-mode> at once from
// localStorage "neon.theme" ({ theme: "paper"|"neon", mode: "system"|"light"|"dark" }).
// Default: paper, following the system (lokeshmohanty.github.io's palette —
// Lokesh, 2026-11-13). The tokens themselves are in lib/theme.css.
//
//   NeonArcade.theme.get()            { theme, mode, dark }   (dark: what shows now)
//   NeonArcade.theme.set({ theme?, mode? })
//   NeonArcade.theme.onChange(fn)     → unsubscribe
//   NeonArcade.theme.picker()         a <div> of buttons, for a page or a sheet
//   NeonArcade.palette()              resolved colours, for canvases (below)
//
// Game frames (sandboxed: no storage of their own) get the theme from the
// party page: lib/bridge.js puts the attributes on the frame's <html> and
// sends a "theme" message on change; sdk/v1/client.js applies it and fires
// `neon:theme` on window, so a canvas game repaints.

window.NeonArcade = window.NeonArcade || {};

(() => {
	const KEY = "neon.theme";
	const THEMES = [
		{ id: "paper", label: "Paper", hint: "lokeshmohanty.github.io: warm paper, cool slate at night" },
		{ id: "neon", label: "Neon", hint: "the original arcade: black, cyan, magenta" },
	];
	const MODES = [
		{ id: "system", label: "Auto" },
		{ id: "light", label: "Light" },
		{ id: "dark", label: "Dark" },
	];
	const root = document.documentElement;
	const media = globalThis.matchMedia?.("(prefers-color-scheme: dark)");

	let choice = { theme: "paper", mode: "system" };
	try {
		const saved = JSON.parse(localStorage.getItem(KEY) ?? "null");
		if (THEMES.some((t) => t.id === saved?.theme)) choice.theme = saved.theme;
		if (MODES.some((m) => m.id === saved?.mode)) choice.mode = saved.mode;
	} catch {
		// Private mode, or a sandboxed frame: the frame is told by its page.
	}

	const listeners = new Set();
	const dark = () => (choice.theme === "neon" ? true : choice.mode === "system" ? !!media?.matches : choice.mode === "dark");

	function apply() {
		root.dataset.theme = choice.theme;
		root.dataset.mode = dark() ? "dark" : "light";
		paletteCache = null;
		const meta = document.querySelector('meta[name="theme-color"]');
		if (meta) meta.content = getComputedStyle(root).getPropertyValue("--bg").trim() || meta.content;
		for (const fn of listeners) {
			try {
				fn(get());
			} catch (err) {
				console.error(err);
			}
		}
	}
	const get = () => ({ ...choice, dark: dark() });

	function set(next) {
		choice = { ...choice, ...next };
		try {
			localStorage.setItem(KEY, JSON.stringify(choice));
		} catch {}
		apply();
	}

	// In a game frame the page decides, and tells it (bridge.js "theme"): the
	// frame following its own media query would undo the page's choice —
	// found by test-theme, a frame flipping to light under a dark page.
	if (!NeonArcade.inFrame) media?.addEventListener?.("change", () => choice.mode === "system" && apply());
	// Another tab picked a theme.
	if (!NeonArcade.inFrame) addEventListener("storage", (e) => {
		if (e.key !== KEY) return;
		try {
			choice = { ...choice, ...JSON.parse(e.newValue ?? "{}") };
			apply();
		} catch {}
	});

	/** The picker: theme buttons, then mode buttons (paper only). */
	function picker() {
		const box = document.createElement("div");
		box.className = "theme-picker";
		const row = (items, key, current) => {
			const r = document.createElement("div");
			r.className = "theme-row";
			r.setAttribute("role", "group");
			r.setAttribute("aria-label", key === "theme" ? "Theme" : "Light or dark");
			for (const it of items) {
				const b = document.createElement("button");
				b.type = "button";
				b.className = "theme-choice";
				b.dataset[key] = it.id;
				b.textContent = it.label;
				if (it.hint) b.title = it.hint;
				b.setAttribute("aria-pressed", String(current === it.id));
				b.onclick = () => {
					set({ [key]: it.id });
					draw();
				};
				r.append(b);
			}
			return r;
		};
		function draw() {
			const parts = [row(THEMES, "theme", choice.theme)];
			if (choice.theme === "paper") parts.push(row(MODES, "mode", choice.mode));
			box.replaceChildren(...parts);
		}
		draw();
		return box;
	}

	// ---------------------------------------------------------- palette

	// Canvas needs concrete colours. Each token is resolved through a 1x1
	// canvas into rgba(), so oklch() and friends work everywhere a canvas does,
	// and `alpha(name, a)` can make a translucent version of any of them.
	let paletteCache = null;
	const TOKENS = ["bg", "surface", "surface-2", "ink", "ink-2", "ink-3", "rule", "accent", "on-accent", "accent-2", "on-accent-2", "good", "warn", "danger", "glow"];
	let probe = null;
	function rgba(css) {
		probe ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
		if (!probe) return css;
		probe.canvas.width = probe.canvas.height = 1;
		probe.clearRect(0, 0, 1, 1);
		probe.fillStyle = "#000"; // theme-exempt: reset before parsing a token
		probe.fillStyle = css;
		probe.fillRect(0, 0, 1, 1);
		const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
		return [r, g, b, a / 255];
	}
	const str = ([r, g, b, a]) => `rgba(${r}, ${g}, ${b}, ${+a.toFixed(3)})`;

	function palette() {
		if (paletteCache) return paletteCache;
		const cs = getComputedStyle(root);
		const raw = {};
		for (const t of TOKENS) raw[t] = cs.getPropertyValue(`--${t}`).trim() || "transparent";
		const players = [];
		for (let i = 1; i <= 8; i++) players.push(cs.getPropertyValue(`--p${i}`).trim() || "#888"); // theme-exempt: a missing token
		const resolved = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, rgba(v)]));
		const pl = players.map(rgba);
		paletteCache = {
			...Object.fromEntries(Object.entries(resolved).map(([k, v]) => [k.replace(/-(\w)/g, (_, c) => c.toUpperCase()), str(v)])),
			players: pl.map(str),
			/** Seat `i`'s colour (0-based), wrapping after eight. */
			player: (i) => str(pl[((i % 8) + 8) % 8]),
			/** A token or player colour with alpha `a`: alpha("accent", 0.3), alpha(2, 0.5). */
			alpha(name, a) {
				const c = typeof name === "number" ? pl[((name % 8) + 8) % 8] : resolved[name] ?? rgba(name);
				return str([c[0], c[1], c[2], a]);
			},
			dark: dark(),
			glows: rgba(raw.glow)[3] > 0,
			fonts: {
				display: cs.getPropertyValue("--font-display").trim(),
				body: cs.getPropertyValue("--font-body").trim(),
				mono: cs.getPropertyValue("--font-mono").trim(),
			},
		};
		return paletteCache;
	}

	NeonArcade.theme = {
		THEMES,
		MODES,
		get,
		set,
		picker,
		onChange(fn) {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
		/** For a game frame: take the theme the page sent. */
		_adopt({ theme, mode }) {
			root.dataset.theme = theme;
			root.dataset.mode = mode;
			paletteCache = null;
			dispatchEvent(new Event("neon:theme"));
		},
	};
	NeonArcade.palette = palette;

	// In a game frame the page decides (bridge.js); everywhere else, now.
	if (!NeonArcade.inFrame) apply();
})();
