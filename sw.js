// sw.js — the service worker that makes the arcade installable and playable
// offline.
//
// It lives at the repo root so its scope covers every page, and it is written
// the same way as everything else here: a plain script, no build step, no
// dependencies. Registered by lib/pwa.js, which knows not to try on file://.
//
// ## What it caches, and why the split
//
// Code (HTML, CSS, JS) is served **network-first**. The pages here are a set of
// files that have to agree with each other — `party.js` calls into `net.js`,
// games register against `games.js` — so serving one from a stale cache while
// another comes fresh is a real way to break the app, and it is a failure that
// arrives silently, days after the deploy that caused it. Going to the network
// first means an online player always runs one coherent deploy. The cache is
// the fallback, not the source of truth.
//
// Assets (icons, the portal's preview gifs) are served **cache-first**. They
// are large, they change rarely, and a slightly old preview gif is a cosmetic
// difference rather than a broken page. They are revalidated in the background,
// so the next visit has the new one.
//
// The offline snapshot is written in one go at install, so what you get with no
// network is a single coherent deploy rather than an accumulation of whatever
// happened to be fetched when.

// Bump when the precached shell should be rebuilt. Because code is network-
// first, a forgotten bump costs an out-of-date *offline* copy — never a stale
// app for an online player, which is the failure mode that would be hard to
// notice.
const VERSION = "arcade-games-v7";

// The shell: everything needed to open any page and start a game with no
// network at all. The preview gifs are deliberately absent — they are ~2 MB
// together, which is not a reasonable thing to pull down on mobile data before
// anybody has asked for them, and they are cached on first sight anyway.
const SHELL = [
	"./",
	"./index.html",
	"./party.html",
	"./connect4.html",
	"./onitama.html",
	"./light-cycles.html",
	"./battleship.html",
	"./liars-dice.html",
	"./oh-hell.html",
	"./draw-guess.html",
	"./neon-survival.html",
	"./neon-survival-mp.html",
	"./tug-of-war.html",
	"./manifest.webmanifest",
	"./lib/styles.css",
	"./lib/qr.js",
	"./lib/qr-decode.js",
	"./lib/net.js",
	"./lib/games.js",
	"./lib/secrets.js",
	"./lib/rounds.js",
	"./lib/ui.js",
	"./lib/lobby.js",
	"./lib/party.js",
	"./lib/pwa.js",
	"./games/connect4.js",
	"./games/onitama.js",
	"./games/light-cycles.js",
	"./games/battleship.js",
	"./games/liars-dice.js",
	"./games/oh-hell.js",
	"./games/draw-guess.js",
	"./games/neon-survival-mp.js",
	"./games/tug-of-war.js",
	"./assets/icon.svg",
	// Stands in for a preview gif that will not load — which, offline, is all of
	// them, since the gifs are not precached.
	"./assets/placeholder.svg",
	"./assets/icon-192.png",
	"./assets/icon-512.png",
	"./assets/icon-maskable-512.png",
	"./assets/apple-touch-icon.png",
];

// How long to wait for the network before falling back to the cached copy. The
// request is left running either way, so a slow connection still refreshes the
// cache for next time — this only decides how long somebody stares at nothing.
const NETWORK_TIMEOUT_MS = 3000;

self.addEventListener("install", (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(VERSION);
			// One at a time rather than cache.addAll: addAll rejects as a unit, so a
			// single 404 (a page removed but left in this list) would throw away the
			// whole offline copy.
			await Promise.all(
				SHELL.map((url) =>
					cache.add(new Request(url, { cache: "reload" })).catch(() => {}),
				),
			);
			// Take over as soon as this version is ready. Safe here because the
			// worker holds no state a page depends on, and because code is fetched
			// network-first, so an old page and a new worker cannot disagree.
			await self.skipWaiting();
		})(),
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		(async () => {
			const names = await caches.keys();
			await Promise.all(names.filter((n) => n !== VERSION).map((n) => caches.delete(n)));
			await self.clients.claim();
		})(),
	);
});

/** Assets are big and stable; code is small and must agree with its siblings. */
function isAsset(url) {
	return /\/assets\/|\.(?:png|jpg|jpeg|gif|svg|webp|ico|woff2?)$/i.test(url.pathname);
}

/** Put a copy in the cache, ignoring the failures that are none of our business. */
async function store(request, response) {
	if (!response || !response.ok || response.type === "opaque") return response;
	try {
		const cache = await caches.open(VERSION);
		await cache.put(request, response.clone());
	} catch {
		// Quota, or a response that cannot be cached. Not worth failing a page over.
	}
	return response;
}

/** Cache first, refreshed in the background for next time. */
async function cacheFirst(request) {
	const hit = await caches.match(request, { ignoreSearch: false });
	const fetching = fetch(request)
		.then((res) => store(request, res))
		.catch(() => null);
	if (hit) return hit;
	const res = await fetching;
	if (res) return res;
	return new Response("", { status: 504, statusText: "Offline and not cached" });
}

/** Network first, with the cache as both a timeout escape and an offline copy. */
async function networkFirst(request) {
	const fetching = fetch(request)
		.then((res) => store(request, res))
		.catch(() => null);

	// Don't leave somebody looking at a blank page while a bad connection
	// decides. If the cache has an answer, show it once the network has had a
	// fair chance; the request above carries on regardless.
	const timed = new Promise((resolve) => setTimeout(() => resolve(null), NETWORK_TIMEOUT_MS));
	const quick = await Promise.race([fetching, timed]);
	if (quick) return quick;

	const hit = await caches.match(request);
	if (hit) return hit;

	const res = await fetching;
	if (res) return res;

	// A page we have never seen, with no network. The portal is the one thing
	// worth offering instead — everything reachable from it is already cached.
	if (request.mode === "navigate") {
		const portal = await caches.match("./index.html");
		if (portal) return portal;
	}
	return new Response("", { status: 504, statusText: "Offline" });
}

self.addEventListener("fetch", (event) => {
	const { request } = event;
	if (request.method !== "GET") return;

	const url = new URL(request.url);
	// Only our own files. There is nothing else to serve: the one piece of
	// outside contact this project makes is STUN, which is not HTTP at all.
	if (url.origin !== self.location.origin) return;
	// Range requests are the browser asking for a slice of a file; a cached
	// whole-file response is the wrong answer to that question.
	if (request.headers.has("range")) return;

	event.respondWith(isAsset(url) ? cacheFirst(request) : networkFirst(request));
});
