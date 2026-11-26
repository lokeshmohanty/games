// src/router.ts — which view the address names, without a server.
//
// GitHub Pages has no rewrites, and the hash is taken: invites travel in it
// (#i=, #c=, #a=; lib/net.js, lib/room-join.js). So views are named in the
// query, on index.html itself:
//
//   ./                         the portal, on its default tab (below)
//   ./?page=games&tab=mine     the portal's tabs: My Games | All Games
//   ./?page=games&tab=all      (and its search, ?q=, on All Games)
//   ./?page=profile            profile | contribute | contributors | collections
//   ./?game=connect4 …         the party (its words: game, mode, fresh, dev,
//   ./?party  ./?party#i=…     party — and any invite or code link)
//
// The old pages (party.html, …) and their redirect stubs were removed on
// 2026-11-15: these are the only addresses. The leaderboards went on
// 2026-11-25 (no boards: party standings and head-to-head only, docs/
// accounts.md "No boards"): ./?page=leaderboard, with whatever it named, is
// taken to the profile, where head-to-head lives (legacyAddress), and
// leaderboard.html is a static stub that sends a bookmark there too.
//
// A portal address that names no tab (./, ./?q=…, an old bookmark) is
// given one as it is entered (portalAddress): All Games for a search, else
// NeonArcade.homeTab() — index.html's, the rule the first paint used. So the
// address always says which tab shows, starring a game never moves you,
// and Back returns to the tab you left.
import { createMemo, createRoot, createSignal } from "solid-js";

export type View = "portal" | "party" | "profile" | "contribute" | "contributors" | "collections";
const PAGES: View[] = ["profile", "contribute", "contributors", "collections"];
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

/**
 * A view that is gone, as the address that replaced it: the leaderboard
 * (?page=leaderboard&game=…&scope=…) → the profile; ?rs= and ?mockroom=
 * ride along, as on any view. Anything else: `url` itself.
 */
export function legacyAddress(url: URL): URL {
	if (url.searchParams.get("page") !== "leaderboard" || /[#&](i|c|a)=/.test(url.hash)) return url;
	const out = new URL(url);
	const keep = ["rs", "mockroom"].filter((k) => url.searchParams.has(k)).map((k) => [k, url.searchParams.get(k) as string]);
	out.search = `?${new URLSearchParams([["page", "profile"], ...keep])}`;
	out.hash = "";
	return out;
}

export type PortalTab = "mine" | "all";
/** The tab a portal address names, or null when it names none. */
export function portalTab(url: URL): PortalTab | null {
	const t = url.searchParams.get("tab");
	return t === "mine" || t === "all" ? t : null;
}
/** `url` with its tab named: the same URL when it has one or is not the portal. */
export function portalAddress(url: URL): URL {
	url = legacyAddress(url);
	if (viewOf(url) !== "portal" || (url.searchParams.get("page") === "games" && portalTab(url))) return url;
	const out = new URL(url);
	const q = out.searchParams;
	const tab = portalTab(url) ?? (q.has("q") ? "all" : ((window as any).NeonArcade?.homeTab?.() ?? "all"));
	q.delete("page");
	q.delete("tab");
	out.search = `?${new URLSearchParams([["page", "games"], ["tab", tab], ...q])}`;
	return out;
}
/** Name the tab of the address now showing, in place (no new history entry). */
const settle = () => {
	const here = new URL(location.href);
	const there = portalAddress(here);
	if (there !== here) history.replaceState(history.state, "", there.href);
	return there;
};

const [url, setUrl] = createSignal(settle());
export const currentUrl = url;
// A memo: a hash or query change within a view does not re-create it.
export const currentView = createRoot(() => createMemo(() => viewOf(url())));

/** True to go ahead; App installs one for "a new party while one is mounted". */
let guard: (next: URL) => boolean = () => true;
export const setNavigationGuard = (fn: (next: URL) => boolean) => (guard = fn);

/** Go to `href` (relative to the page) without reloading: the party stays. */
export function navigate(href: string, { replace = false } = {}) {
	let next = new URL(href, location.href);
	if (next.origin !== location.origin) return void (location.href = next.href);
	next = portalAddress(next);
	if (!guard(next)) return;
	// How many of the arcade's own entries lie behind this one: lib/lobby.js's
	// back guard asks only when Back would leave the arcade (depth 0).
	const depth = (history.state?.arcadeDepth ?? 0) + (replace ? 0 : 1);
	history[replace ? "replaceState" : "pushState"]({ arcadeDepth: depth }, "", next.href);
	setUrl(next);
	scrollTo(0, 0);
}
addEventListener("popstate", () => setUrl(settle()));

/**
 * A link to the shell (./ or index.html, with any query and hash) as the
 * address to navigate to, or null for anything else (another file, another
 * site), which the browser loads itself.
 */
export function shellUrl(href: string): string | null {
	const u = new URL(href, location.href);
	if (u.origin !== location.origin) return null;
	const base = new URL("./", location.href);
	if (u.pathname !== base.pathname && u.pathname !== `${base.pathname}index.html`) return null;
	const out = new URL(`./${u.search}`, base);
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
