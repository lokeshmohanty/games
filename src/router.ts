// src/router.ts — which view the address names, without a server.
//
// GitHub Pages has no rewrites, and the hash is taken: invites travel in it
// (#i=, #c=, #a=; lib/net.js, lib/room-join.js). So views are named in the
// query, on index.html itself:
//
//   ./                         the portal
//   ./?page=leaderboard        leaderboard | profile | contribute | contributors
//                              | collections
//   ./?game=connect4 …         the party (party.html's own words: game, mode,
//   ./?party  ./#i=…           fresh, dev — and any invite or code link)
//
// The old pages (party.html, leaderboard.html, …) are redirect stubs into
// these, so links, bookmarks and installed shortcuts keep working.
import { createMemo, createRoot, createSignal } from "solid-js";

export type View = "portal" | "party" | "leaderboard" | "profile" | "contribute" | "contributors" | "collections";
const PAGES: View[] = ["leaderboard", "profile", "contribute", "contributors", "collections"];
// Not ?rs= or ?mockroom= (they choose the room server and ride along on any view).
const PARTY_KEYS = ["game", "mode", "fresh", "dev", "party"];

export function viewOf(url: URL): View {
	const q = url.searchParams;
	// An invite, code or answer link is the party, whatever view it was made on.
	if (/[#&](i|c|a)=/.test(url.hash)) return "party";
	const page = q.get("page") as View | null;
	if (page && PAGES.includes(page)) return page;
	if (PARTY_KEYS.some((k) => q.has(k))) return "party";
	return "portal";
}

const [url, setUrl] = createSignal(new URL(location.href));
export const currentUrl = url;
// A memo: a hash or query change within a view does not re-create it.
export const currentView = createRoot(() => createMemo(() => viewOf(url())));

/** True to go ahead; App installs one for "a new party while one is mounted". */
let guard: (next: URL) => boolean = () => true;
export const setNavigationGuard = (fn: (next: URL) => boolean) => (guard = fn);

/** Go to `href` (relative to the page) without reloading: the party stays. */
export function navigate(href: string, { replace = false } = {}) {
	const next = new URL(href, location.href);
	if (next.origin !== location.origin) return void (location.href = next.href);
	if (!guard(next)) return;
	// How many of the arcade's own entries lie behind this one: lib/lobby.js's
	// back guard asks only when Back would leave the arcade (depth 0).
	const depth = (history.state?.arcadeDepth ?? 0) + (replace ? 0 : 1);
	history[replace ? "replaceState" : "pushState"]({ arcadeDepth: depth }, "", next.href);
	setUrl(next);
	scrollTo(0, 0);
}
addEventListener("popstate", () => setUrl(new URL(location.href)));

/**
 * The old page names, as they still appear in the shell's vanilla code
 * (lib/party.js "← All games", lib/nav.js tabs…), mapped to views.
 */
const OLD: Record<string, string> = {
	"index.html": "./",
	"party.html": "./",
	"leaderboard.html": "./?page=leaderboard",
	"profile.html": "./?page=profile",
	"contribute.html": "./?page=contribute",
	"contributors.html": "./?page=contributors",
};

/** An old page's URL as the shell's own (its query and hash carried over). */
export function shellUrl(href: string): string | null {
	const u = new URL(href, location.href);
	if (u.origin !== location.origin) return null;
	const base = new URL("./", location.href);
	if (!u.pathname.startsWith(base.pathname)) return null;
	const name = u.pathname.slice(base.pathname.length) || "index.html";
	const to = OLD[name];
	if (to === undefined) return null;
	const out = new URL(to, base);
	for (const [k, v] of u.searchParams) out.searchParams.set(k, v);
	if (name === "party.html" && ![...u.searchParams.keys()].some((k) => PARTY_KEYS.includes(k))) out.searchParams.set("party", "");
	out.hash = u.hash;
	return out.href;
}

// Every same-page link becomes a navigation, so moving around the arcade
// never drops the party's connections (the point of one page).
document.addEventListener("click", (e) => {
	if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
	const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
	if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
	// A way out of the party is lib/lobby.js's to handle (it asks, then loads).
	if (a.hasAttribute("data-leaves")) return;
	// A jump within this view (#section) is the browser's to do.
	const here = new URL(location.href);
	if (a.hash && a.pathname === here.pathname && a.search === here.search) return;
	const to = shellUrl(a.href);
	if (!to) return;
	e.preventDefault();
	navigate(to);
}, true); // capture: a link whose own handler stops the click (portal cards) still navigates in-app
