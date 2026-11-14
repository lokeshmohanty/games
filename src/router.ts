// src/router.ts — which view the address names, without a server.
//
// GitHub Pages has no rewrites, and the hash is taken: invites travel in it
// (#i=, #c=, #a=; lib/net.js, lib/room-join.js). So views are named in the
// query, on index.html itself:
//
//   ./                         the portal
//   ./?page=leaderboard        leaderboard | profile | contribute | contributors
//   ./?game=connect4 …         the party (party.html's own words: game, mode,
//   ./?party  ./#i=…           fresh, dev — and any invite or code link)
//
// The old pages (party.html, leaderboard.html, …) are redirect stubs into
// these, so links, bookmarks and installed shortcuts keep working.
import { createSignal } from "solid-js";

export type View = "portal" | "party" | "leaderboard" | "profile" | "contribute" | "contributors";
const PAGES: View[] = ["leaderboard", "profile", "contribute", "contributors"];
const PARTY_KEYS = ["game", "mode", "fresh", "dev", "party", "rs"];

export function viewOf(url: URL): View {
	const q = url.searchParams;
	const page = q.get("page") as View | null;
	if (page && PAGES.includes(page)) return page;
	if (PARTY_KEYS.some((k) => q.has(k)) || /[#&](i|c|a)=/.test(url.hash)) return "party";
	return "portal";
}

const [url, setUrl] = createSignal(new URL(location.href));
export const currentUrl = url;
export const currentView = () => viewOf(url());

/** Go to `href` (relative to the page) without reloading: the party stays. */
export function navigate(href: string, { replace = false } = {}) {
	const next = new URL(href, location.href);
	if (next.origin !== location.origin) return void (location.href = next.href);
	history[replace ? "replaceState" : "pushState"](null, "", next.href);
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
	const to = shellUrl(a.href);
	if (!to) return;
	e.preventDefault();
	navigate(to);
});
