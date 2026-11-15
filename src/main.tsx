// src/main.tsx — the arcade's one page (docs/spa.md).
//
// The shell's libraries are the same framework-free files they always were
// (lib/*.js hang off window.NeonArcade; the game frames inline lib/theme.css
// and lib/styles.css),
// imported here in the order the old pages loaded them. theme.js and the
// shared CSS are not among them: index.html links them as-is, so the saved
// theme applies before the first paint and the frames share the same files. The community catalog is fetched at
// deploy (scripts/fetch-community.mjs), so it is loaded at run time, after
// the libraries it registers its games with.
import "../lib/pwa.js";
import "../lib/load.js";
import "../lib/qr.js";
import "../lib/net.js";
import "../lib/room-join.js";
import "../lib/games.js";
import "../lib/lobby.js";
import "../lib/stats.js";
import "../lib/account.js";
import "../lib/account-ui.js";
import "../lib/markdown.js";
import "../lib/rules.js";
import "../lib/party.js";
import "../lib/bridge.js";
import "../lib/sdk-managed.js";
import "../lib/sdk-host.js";
import "../lib/catalog.js";
import "../lib/nav.js";
import { render } from "solid-js/web";
import App from "./App";
import { viewOf } from "./router";

// For the shell's vanilla code: it is one page now (lib/lobby.js, party.js).
const NA = (window as any).NeonArcade;
NA.shell = true;
NA.shellView = (href: string) => viewOf(new URL(href, location.href));

/** A classic script, once (the community catalog: generated, not bundled). */
const script = (src: string) =>
	new Promise<void>((done) => {
		const s = document.createElement("script");
		s.src = src;
		s.onload = s.onerror = () => done(); // absent until fetched: nothing breaks
		document.head.append(s);
	});

// Drawn at once, the catalogs behind: holding the first paint for the
// community catalog (and a lazy portal chunk) took cold FCP from 0.47 s to
// 1.21 s (perf, 2026-11-15). The party waits for them (App: `catalogs`): it
// needs every game registered. ?dev= (lib/bridge.js) registers its game first.
export const catalogs: Promise<void> = script("community/catalog.js")
	.then(() => NA.devGame)
	.then(() => {
		NA.portal?.draw?.(); // the community games' cards, on a portal already drawn
	});
NA.catalogs = catalogs;
const app = document.getElementById("app")!;
app.replaceChildren(); // the static first frame (index.html) goes
render(() => <App />, app);
