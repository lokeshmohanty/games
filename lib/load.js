// lib/load.js — a shell script fetched the first time it is needed.
//
// party.html used to run every library up front, though most parties never
// scan a QR code (qr-decode.js, 33 KB) or mount a web app with a server
// (py-server.js). Those load on first use instead:
//
//   await NeonArcade.load("qr-decode");   // lib/qr-decode.js, once per page
//
// Same folder as this file, a classic <script> (the libraries hang off
// window.NeonArcade), and the service worker's precache still holds them, so
// it works offline. A failed load is forgotten, so the next ask retries.

window.NeonArcade = window.NeonArcade || {};

(() => {
	// Bundled into the shell (src/main.tsx) it has no <script> of its own; the
	// files it loads are served as-is from the site's lib/ (scripts/assemble.mjs).
	const base = new URL(".", document.currentScript?.src || new URL("lib/load.js", document.baseURI));
	const loading = new Map();
	NeonArcade.load = (name) => {
		if (loading.has(name)) return loading.get(name);
		const done = new Promise((ok, fail) => {
			const s = document.createElement("script");
			s.src = new URL(`${name}.js`, base).href;
			s.onload = () => ok();
			s.onerror = () => {
				loading.delete(name);
				s.remove();
				fail(new Error(`${name}.js did not load`));
			};
			document.head.append(s);
		});
		loading.set(name, done);
		return done;
	};
})();
