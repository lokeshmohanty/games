// src/App.tsx — the views, and the party that outlives them.
//
// The party (lib/party.js: the room, the roster, the running game's frame)
// is mounted once, the first time the address names it, into a layer that
// is never re-rendered. Moving to the leaderboard or a profile only hides
// that layer: the connections and the game keep running, and BACK TO GAME
// (or Back) shows it again. Every other view is a Solid component, loaded
// on first visit.
import { createEffect, createSignal, lazy, Match, onCleanup, Show, Switch } from "solid-js";
import { currentUrl, currentView, navigate, type View } from "./router";
// The start page, in the main bundle: a lazy chunk was one more round trip
// before the first paint.
import Portal from "./views/Portal";

const A = (window as any).NeonArcade;

const views: Record<Exclude<View, "party">, ReturnType<typeof lazy>> = {
	portal: Portal as any,
	leaderboard: lazy(() => import("./views/Leaderboard")),
	profile: lazy(() => import("./views/Profile")),
	contribute: lazy(() => import("./views/Contribute")),
	contributors: lazy(() => import("./views/Contributors")),
};

const TITLES: Record<View, string> = {
	portal: "Arcade Games",
	party: "Party — Arcade Games",
	leaderboard: "Leaderboard — Arcade Games",
	profile: "Profile — Arcade Games",
	contribute: "Add your game — Arcade Games",
	contributors: "Contributors — Arcade Games",
};

// The party screen and its game want the page unzoomable (as party.html
// was); the rest of the arcade lets people zoom.
const viewport = document.querySelector('meta[name="viewport"]');
const ZOOMABLE = "width=device-width, initial-scale=1.0";
const FIXED = "width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no";

export default function App() {
	const layer = document.getElementById("party-layer")!;
	const [party, setParty] = createSignal<any>(null);
	const [playing, setPlaying] = createSignal<string | null>(null);
	let mounting = false;
	// The catalogs (src/main.tsx): only the portal draws before them (and
	// redraws after); the other views read them as they mount — the
	// contributors view drew without the community repos, now and then.
	const [catalogsIn, setCatalogsIn] = createSignal(false);
	A.catalogs.then(() => setCatalogsIn(true));

	createEffect(() => {
		const v = currentView();
		document.title = TITLES[v];
		viewport?.setAttribute("content", v === "party" ? FIXED : ZOOMABLE);
		layer.hidden = v !== "party";
		document.body.dataset.view = v;
		if (v === "party" && !party() && !mounting) {
			// After the catalogs (src/main.tsx): the party reads ?game= against
			// every registered game. Tests reach the live room and game through
			// these, as on party.html.
			mounting = true;
			A.catalogs.then(() => {
				const p = A.mountParty(document.getElementById("party"), document.getElementById("stage"));
				(window as any).__party = (window as any).__game = p;
				setParty(p);
				if (A.devError) A.toast(A.devError, "warn");
			});
		}
	});
	// A live party behind another view (its game, if one runs): for the pill.
	const poll = setInterval(() => {
		const p = party();
		setPlaying(p?.room && !p.room.closed ? (p.game ?? "") : null);
	}, 500);
	onCleanup(() => clearInterval(poll));
	void currentUrl;

	return (
		<>
			<Switch>
				<Match when={currentView() !== "party" && (currentView() === "portal" || catalogsIn())}>
					{(() => {
						const V = views[currentView() as Exclude<View, "party">];
						return <V />;
					})()}
				</Match>
			</Switch>
			<Show when={currentView() !== "party" && playing() !== null}>
				<button type="button" class="back-to-game neon-btn neon-btn--accent" onClick={() => navigate("./?party")}>
					{playing() ? "BACK TO GAME" : "BACK TO PARTY"}
				</button>
			</Show>
		</>
	);
}
