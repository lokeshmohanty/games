// lib/pwa.js — register the service worker and offer an install button.
//
// Loaded as a traditional script like everything else in lib/, and deliberately
// harmless when it cannot do its job: opened from file:// there is no secure
// context and no service worker, so this quietly does nothing and the page
// works exactly as it did before.
//
// Nothing here is required for the games to run. Installing only changes where
// the arcade lives — its own icon, its own window, no browser chrome — and,
// through sw.js, lets the single-player games work with no network at all.

window.NeonArcade = window.NeonArcade || {};

(() => {
	// Where this file was loaded from, so `../sw.js` resolves to the repo root
	// rather than to whatever directory the page happens to sit in. The worker
	// must be served from the root to have every page in its scope.
	const here = document.currentScript?.src || location.href;

	/** Already running as an installed app? Then there is nothing to offer. */
	const isInstalled = () =>
		window.matchMedia?.("(display-mode: standalone)").matches ||
		window.matchMedia?.("(display-mode: fullscreen)").matches ||
		window.matchMedia?.("(display-mode: minimal-ui)").matches ||
		// iOS Safari predates display-mode and reports this instead.
		window.navigator.standalone === true;

	NeonArcade.isInstalled = isInstalled;

	// --------------------------------------------------------- registration

	if ("serviceWorker" in navigator && window.isSecureContext) {
		// After load: registration competes with the page's own requests for
		// bandwidth, and on a first visit the page is what somebody is waiting for.
		window.addEventListener("load", () => {
			navigator.serviceWorker
				.register(new URL("../sw.js", here), { scope: new URL("./", new URL("../sw.js", here)) })
				.catch(() => {
					// A worker that will not register is not a reason to break the page.
					// Everything still works; it just will not work offline.
				});
		});
	}

	// -------------------------------------------------------- install button
	//
	// Chrome and Edge fire `beforeinstallprompt` when they consider the app
	// installable, and suppress their own UI if we call preventDefault. Holding
	// the event lets the offer live where somebody is already looking rather than
	// behind a menu they will never open.

	let deferred = null;
	const slots = () => document.querySelectorAll("[data-install-slot]");

	/** Fill every install slot on the page with whatever is currently on offer. */
	function render() {
		for (const slot of slots()) {
			slot.replaceChildren();
			if (isInstalled()) continue;

			if (deferred) {
				const btn = document.createElement("button");
				btn.className = "neon-btn neon-btn--accent install-btn";
				btn.type = "button";
				btn.textContent = "INSTALL APP";
				btn.onclick = async () => {
					const prompt = deferred;
					// One prompt per event: the browser will not let it be shown twice,
					// so drop it either way and wait for a fresh one.
					deferred = null;
					btn.disabled = true;
					try {
						await prompt.prompt();
						await prompt.userChoice;
					} catch {
						// Dismissed, or the browser changed its mind. Nothing to do.
					}
					render();
				};
				slot.append(btn);
				continue;
			}

			// iOS has no install event and no install button — Add to Home Screen
			// lives in the share sheet, and nobody finds it without being told.
			const iOS =
				/iphone|ipad|ipod/i.test(navigator.userAgent) ||
				(navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
			if (iOS) {
				const hint = document.createElement("p");
				hint.className = "install-hint";
				hint.textContent = "Install: tap Share, then Add to Home Screen.";
				slot.append(hint);
			}
		}
	}

	NeonArcade.renderInstallOffer = render;

	window.addEventListener("beforeinstallprompt", (e) => {
		e.preventDefault();
		deferred = e;
		render();
	});

	window.addEventListener("appinstalled", () => {
		deferred = null;
		render();
	});

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", render, { once: true });
	} else {
		render();
	}
})();
