// lib/ui.js — the chrome every game builds, built once.
//
// Four games independently grew the same three things: a `<style>` tag injected
// at mount, a centred stage with a status line above it, and a full-bleed
// overlay for "you won" / "waiting for the host". They are not quite identical,
// which is the tell — the differences are drift, not design.
//
// This is deliberately **factory functions over plain DOM**, not a reactive
// layer. The 2026-08-10 look at converting this repo to SolidJS measured the
// reactive surface at roughly a fifth of the code and rejected the conversion
// on `file://` and the buildless deploy; what it recommended instead was
// exactly this file. So the one idea worth borrowing is borrowed and nothing
// else: `setHud` **updates text nodes in place** rather than rebuilding the
// row, which is the single thing Draw & Guess's per-tick `replaceChildren()`
// was doing wrong and the reason its score pills flicker under a screen reader.
//
// Loaded as a traditional script so it works on file:// like everything else.

window.NeonArcade = window.NeonArcade || {};

(() => {
	const el = (tag, className, text) => {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (text != null) node.textContent = text;
		return node;
	};

	/**
	 * Build a game's outer furniture and hand back the parts.
	 *
	 *   const shell = NeonArcade.gameShell(ctx.root, { css: `#board { ... }` });
	 *   shell.stage.append(myCanvas);
	 *   shell.setHud([{ key: "turn", text: "Your move" }]);
	 *
	 * Nothing here is mandatory: a game that wants a different layout can ignore
	 * it and append to `ctx.root` as before. It exists to stop the fifth game
	 * copying the fourth game's overlay.
	 */
	NeonArcade.gameShell = (root, opts = {}) => {
		const style = el("style");
		style.textContent = `
			.g-stage { position: absolute; inset: 0; display: flex; flex-direction: column;
				align-items: center; justify-content: center; gap: 8px;
				/* Safe-area padding, not margin: on a notched phone in landscape the
				   board must not slide under the rounded corner, and the stage is
				   the only element that knows how tall the rest of the chrome is. */
				padding-left: max(12px, env(safe-area-inset-left));
				padding-right: max(12px, env(safe-area-inset-right));
				padding-bottom: max(12px, env(safe-area-inset-bottom));
				/* Room reserved for the "ALL GAMES" link, which is fixed-positioned
				   at the top-left of every game page. Centring the stage without
				   this puts the status line underneath it — which is exactly what
				   happened, and looked like a text bug rather than a layout one. */
				padding-top: calc(env(safe-area-inset-top) + 52px); }
			/* The one child that should absorb whatever height is left over. A
			   game that sets its own full height here instead overflows the stage and
			   pushes the status line off the top. */
			.g-fill { flex: 1 1 auto; min-height: 0; width: 100%;
				display: flex; flex-direction: column; align-items: center;
				justify-content: center; gap: 8px; }
			.g-hud { display: flex; flex-wrap: wrap; align-items: baseline;
				justify-content: center; gap: 4px 14px; min-height: 1.5em;
				font-size: clamp(0.85rem, 3vw, 1.1rem); color: var(--accent);
				text-shadow: 0 0 8px var(--accent-glow); text-align: center; }
			.g-hud .g-muted { color: var(--muted); text-shadow: none; }
			.g-hud .g-warn { color: #ff4d4d; text-shadow: 0 0 8px rgba(255, 77, 77, 0.5); }
			.g-overlay p { color: var(--muted); margin: 0; }
			.g-overlay .g-actions { display: flex; flex-wrap: wrap; gap: 10px;
				justify-content: center; }
		` + (opts.css ?? "");

		const stage = el("div", "g-stage");
		const hud = el("div", "g-hud");
		hud.setAttribute("role", "status");
		// Polite, not assertive: a turn indicator that interrupts every other
		// announcement is worse than one that waits its turn.
		hud.setAttribute("aria-live", "polite");
		stage.append(hud);

		const overlay = el("div", "overlay g-overlay");
		overlay.hidden = true;
		root.append(style, stage, overlay);

		const cells = new Map();

		return {
			root,
			stage,
			hud,
			overlay,

			/**
			 * Set the status line. `parts` is `[{ key, text, className }]`; a key
			 * that is already on screen has its text node updated, a key that has
			 * gone is removed, and everything else is left alone.
			 */
			setHud(parts) {
				const seen = new Set();
				for (const part of parts) {
					if (!part) continue;
					seen.add(part.key);
					let node = cells.get(part.key);
					if (!node) {
						node = el("span");
						cells.set(part.key, node);
						hud.append(node);
					}
					if (node.textContent !== String(part.text)) node.textContent = String(part.text);
					const cls = part.className ?? "";
					if (node.className !== cls) node.className = cls;
				}
				for (const [key, node] of cells) {
					if (seen.has(key)) continue;
					node.remove();
					cells.delete(key);
				}
			},

			/**
			 * Cover the stage. `buttons` may be plain `{ label, onClick }` or a
			 * ready-made element, which is how the "HOST A NEW GAME" button from
			 * net.js gets in.
			 */
			showOverlay({ title, lines = [], buttons = [] } = {}) {
				overlay.replaceChildren();
				if (title) overlay.append(el("h1", null, title));
				for (const line of lines) if (line) overlay.append(el("p", null, line));
				if (buttons.length) {
					const actions = el("div", "g-actions");
					for (const b of buttons) {
						if (!b) continue;
						if (b instanceof HTMLElement) {
							actions.append(b);
							continue;
						}
						const btn = el("button", "neon-btn", b.label);
						btn.addEventListener("click", b.onClick);
						actions.append(btn);
					}
					overlay.append(actions);
				}
				overlay.hidden = false;
			},

			hideOverlay() {
				overlay.hidden = true;
			},

			/** Drop everything this shell put in the DOM. Call from `unmount`. */
			destroy() {
				style.remove();
				stage.remove();
				overlay.remove();
				cells.clear();
			},
		};
	};
})();
