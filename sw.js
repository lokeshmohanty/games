// sw.js — the service worker that makes the arcade installable and playable
// offline.
//
// It lives at the repo root so its scope covers the whole site. This file is
// the template: scripts/assemble.mjs writes dist/sw.js from it, with the
// precache list and VERSION filled in. Registered by lib/pwa.js, which does
// nothing without a secure context.
//
// ## Why a snapshot (2026-11-14; was network-first since 2026-08-15)
//
// The pages here are a set of files that have to agree with each other —
// `party.js` calls into `net.js`, games register against `games.js` — so
// serving one file from an old deploy beside another from a new one breaks the
// app silently. Network-first prevented that by always asking the network, at
// the price of a round trip per file and a 3 s wait for any file on a bad link
// (docs/perf.md).
//
// Code is now served from **the precached snapshot of its VERSION**: written in
// one go at install, read as-is afterwards, never refreshed file by file (a
// per-file background refresh is exactly what would mix two deploys). So a
// page opens from the phone's own storage, and is always one coherent deploy.
// What is not in the snapshot comes from the network and is kept.
//
// What makes a deploy arrive: VERSION is a hash of every precached file
// (scripts/assemble.mjs, at build time, with the community games). A new deploy therefore means a new sw.js, which
// the browser finds on its own update check and installs beside the old
// snapshot — all of it, or not at all. The next page load is the new deploy,
// whole; a page already open stays on the snapshot it was loaded from until it
// closes ("a page keeps its deploy", below).
//
// Assets (icons, fonts, posters, a community game's gif) are cache-first, and are not
// re-downloaded behind each hit: they change with a deploy, so with VERSION.
//
// On a loopback address (`just run`) code stays network-first, so an edited
// file shows on reload without rehashing anything. The tests that exercise the
// real strategy register with `?snapshot` (lib/pwa.js reads localStorage
// "neon.sw" = "snapshot").

// A hash of SHELL's files and this one — written by scripts/assemble.mjs,
// never by hand.
const VERSION = "arcade-dev"; // dist/sw.js: a hash of what it precaches (scripts/assemble.mjs)
// The Python runtime's own cache (isAsset): named by a hash of sdk/pyodide/,
// so it outlives deploys that leave Pyodide alone and goes when it changes.
const RUNTIME = "arcade-pyodide-dev"; // dist/sw.js: scripts/assemble.mjs
// Network-first for code, for development (see above).
const DEV = ["localhost", "127.0.0.1", "[::1]"].includes(self.location.hostname) && !new URL(self.location.href).searchParams.has("snapshot");

// The shell: everything needed to open any page and start a game with no
// network at all. Preview videos and an outside repo's preview gif are
// deliberately absent: not a thing to pull down on mobile data before anybody
// has asked for them. The ~5 KB posters are in (scripts/assemble.mjs).
const SHELL = [
	// What scripts/assemble.mjs cannot derive. It adds, at build time, every
	// built chunk (app/), page, lib/ script and stylesheet, game file and frame
	// runtime, then writes the result into dist/sw.js with its VERSION.
	"./",
	"./CONTRIBUTING.md",
	"./manifest.webmanifest",
	"./assets/icon.svg",
	// The three faces (lib/theme.css): ~150 KB, worth it for an offline app
	// that would otherwise fall back to system fonts with no network.
	"./assets/fonts/space-grotesk.woff2",
	"./assets/fonts/nunito.woff2",
	"./assets/fonts/nunito-italic.woff2",
	"./assets/fonts/cascadia-code.woff2",
	// Stands in for a preview that will not load (a card with no poster).
	"./assets/placeholder.svg",
	"./assets/icon-192.png",
	"./assets/icon-512.png",
	"./assets/icon-maskable-512.png",
	"./assets/apple-touch-icon.png",
];

// Outside repos' games (registry/), fetched at deploy with their file list.
// Absent in a checkout that has not run `just community`: the shell alone.
try {
	importScripts("./community/precache.js");
} catch {
	self.COMMUNITY_SHELL = [];
}
SHELL.push(...(self.COMMUNITY_SHELL ?? []));


// Development only (DEV): how long to wait for the network before falling back
// to the cached copy.
const NETWORK_TIMEOUT_MS = 3000;

self.addEventListener("install", (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(VERSION);
			// All or nothing: a snapshot missing files must never activate — it
			// would replace a whole one, leave holes offline, and refill them
			// from whatever the network hands back. A failed install keeps the
			// old worker, and the browser tries again on its next update check.
			// (A file listed but absent fails scripts/assemble.mjs, so a 404
			// here is a network problem, not a stale list.)
			//
			// `no-cache`, not `reload`: the browser revalidates what its HTTP cache
			// holds (ETag / Last-Modified), so the files the first page just loaded
			// cost a 304 rather than their whole bodies again. Still fresh from the
			// server: a 304 is the server's word that the copy is current.
			//
			// fetch + put rather than cache.add: the same request, but through the
			// worker's own fetch, which test-pwa can intercept to fake a deploy.
			try {
				await Promise.all(
					SHELL.map(async (url) => {
						const res = await fetch(new Request(url, { cache: "no-cache" }));
						if (!res.ok) throw new Error(`${url}: ${res.status}`);
						await cache.put(url, res);
					}),
				);
			} catch (err) {
				await caches.delete(VERSION);
				throw err;
			}
			// Take over as soon as this version is ready. Pages already open stay
			// on the snapshot they were loaded from (pinned, below), so taking
			// over mixes nothing.
			await self.skipWaiting();
		})(),
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		(async () => {
			await prune();
			// The pages this worker is about to claim that no worker pinned —
			// a first visit, which loaded from the network, i.e. this deploy —
			// are this snapshot's from now on. Unpinned, the next deploy pruned
			// the snapshot their lazy chunks come from (review, 2026-11-15).
			const pins = await caches.open(PINS);
			for (const c of await self.clients.matchAll({ type: "window", includeUncontrolled: true })) {
				if (!(await pins.match(pinKey(c.id)))) await pin(c.id);
			}
			await self.clients.claim();
		})(),
	);
});

// ------------------------------------------------- a page keeps its deploy
//
// A page loaded from one snapshot keeps reading that snapshot until it
// closes, even after a newer worker takes over: the files it fetches later —
// qr-decode.js on a first scan (lib/load.js), a game frame's files
// (lib/bridge.js) — must agree with the files it already runs. Each
// navigation records which VERSION served it; the record lives in a cache of
// its own, because a worker's memory does not survive it being stopped.

const PINS = "arcade-pins";
// How long a fresh pin outlives a page not yet among the clients. Pruned early,
// a page would only read the current snapshot for what it loads later.
const PIN_GRACE_MS = 10_000;
const pinKey = (clientId) => `./__pin/${clientId}`;

async function pin(clientId) {
	if (!clientId) return;
	try {
		await (await caches.open(PINS)).put(pinKey(clientId), new Response(`${VERSION} ${Date.now()}`));
	} catch {}
}

/** The snapshot a page was loaded from, when it is an older one still kept. */
async function pinnedCache(clientId) {
	if (!clientId) return null;
	const hit = await (await caches.open(PINS)).match(pinKey(clientId));
	const version = hit && (await hit.text()).split(" ")[0];
	if (!version || version === VERSION || !(await caches.has(version))) return null;
	return caches.open(version);
}

/**
 * Drop every snapshot no open page was loaded from, and the pins of pages that
 * have gone. Run when this worker activates and after each navigation. A pin
 * younger than PIN_GRACE_MS is kept whether or not its page shows up yet: the
 * page a navigation is loading is not among the clients until it commits.
 */
async function prune() {
	const open = new Set((await self.clients.matchAll({ includeUncontrolled: true })).map((c) => c.id));
	const pins = await caches.open(PINS);
	const keep = new Set([VERSION, PINS, RUNTIME]);
	for (const req of await pins.keys()) {
		const id = new URL(req.url).pathname.split("/__pin/")[1];
		const [version, at] = (await (await pins.match(req)).text()).split(" ");
		if (open.has(id) || Date.now() - Number(at) < PIN_GRACE_MS) keep.add(version);
		else await pins.delete(req);
	}
	await Promise.all((await caches.keys()).filter((n) => !keep.has(n)).map((n) => caches.delete(n)));
}

/**
 * Assets are big and stable; code is small and must agree with its siblings.
 *
 * The Python runtime (sdk/pyodide/: ~13 MB for a Python game's core, more
 * for a web app's server, lib/py-server.js) is not in the precache: few
 * players open a Python game, and 13 MB is not a thing to pull down on mobile
 * data at install for everybody. It is cached the first time it is used —
 * a Python game picked online (lib/sdk-host.js prefetchWasm) — in a cache of
 * its own (RUNTIME), which a deploy does not prune: a Python game played once
 * online then plays offline for good. Offline before that, lib/sdk-host.js
 * says so (docs/sdk-v2.md, "Python").
 */
function isAsset(url) {
	return /\/assets\/|\/sdk\/pyodide\/|\.(?:png|jpg|jpeg|gif|svg|webp|ico|woff2?)$/i.test(url.pathname);
}
const isRuntime = (url) => /\/sdk\/pyodide\//.test(new URL(url).pathname);

/** Put a copy in the cache, ignoring the failures that are none of our business. */
async function store(request, response) {
	if (!response || !response.ok || response.type === "opaque") return response;
	try {
		const cache = await caches.open(isRuntime(request.url) ? RUNTIME : VERSION);
		await cache.put(request, response.clone());
	} catch {
		// Quota, or a response that cannot be cached. Not worth failing a page over.
	}
	return response;
}

/**
 * Cache first; the network only for what is not cached, which is then kept.
 * No refresh behind a hit: every portal visit used to download every preview
 * again. A changed asset arrives with the next VERSION's cache.
 */
async function cacheFirst(request) {
	const hit = await caches.match(request, { ignoreSearch: false });
	if (hit) return hit;
	const res = await fetch(request)
		.then((r) => store(request, r))
		.catch(() => null);
	if (res) return res;
	return new Response("", { status: 504, statusText: "Offline and not cached" });
}

/**
 * Code, from this VERSION's snapshot. Not in it (a file outside SHELL): the
 * network, kept for offline. A navigation with a query (./?game=…) is the
 * precached page — the query only steers its script.
 */
async function snapshot(request, event) {
	const navigating = request.mode === "navigate";
	if (navigating) {
		// This page is this VERSION's from now on; older snapshots may go.
		event.waitUntil(pin(event.resultingClientId).then(prune).catch(() => {}));
	} else {
		const older = await pinnedCache(event.clientId);
		const old = older && (await older.match(request));
		if (old) return old;
	}
	const cache = await caches.open(VERSION);
	const hit = (await cache.match(request)) ?? (navigating ? await cache.match(request, { ignoreSearch: true }) : null);
	if (hit) return hit;
	// Not in the snapshot. `no-cache`: an HTTP-cached copy from an older deploy
	// must not be kept under this VERSION. (A navigation's mode forbids
	// re-making the request; pages are all in SHELL anyway.)
	const res = await fetch(navigating ? request : new Request(request, { cache: "no-cache" }))
		.then((r) => store(request, r))
		.catch(() => null);
	if (res) return res;
	if (request.mode === "navigate") {
		const portal = await cache.match("./index.html");
		if (portal) return portal;
	}
	return new Response("", { status: 504, statusText: "Offline" });
}

/** Development: network first, with the cache as a timeout escape and an offline copy. */
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

	// A page we have seen, but not with this query: ./?game=… is the
	// precached shell, and the query only steers its script. Whether the
	// exact URL was cached on an earlier visit is luck (test-pwa caught it).
	if (request.mode === "navigate") {
		const page = await caches.match(request, { ignoreSearch: true });
		if (page) return page;
	}

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
	// Preview videos too (scripts/preview-media.mjs), even when a first request
	// carries no Range: Safari refuses a whole-file answer to a media request.
	// Offline, a card shows its cached poster instead.
	if (/\.(?:webm|mp4)$/i.test(url.pathname)) return;

	event.respondWith(isAsset(url) ? cacheFirst(request) : DEV ? networkFirst(request) : snapshot(request, event));
});
