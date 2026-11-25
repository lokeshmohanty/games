// src/App.tsx — the views, and the party that outlives them.
//
// The party (lib/party.js: the room, the roster, the running game's frame)
// is mounted once, the first time the address names it, into a layer that
// is never re-rendered. Moving to a profile or the portal only hides
// that layer: the connections and the game keep running, and BACK TO GAME
// (or Back) shows it again. Every other view is a Solid component, loaded
// on first visit.
import { createEffect, createSignal, ErrorBoundary, lazy, Match, onCleanup, Show, Switch } from "solid-js";
import { currentUrl, currentView, navigate, setNavigationGuard, viewOf, type View } from "./router";
// The start page, in the main bundle: a lazy chunk was one more round trip
// before the first paint.
import Portal from "./views/Portal";

const A = (window as any).NeonArcade;

const views: Record<Exclude<View, "party">, ReturnType<typeof lazy>> = {
	portal: Portal as any,
	profile: lazy(() => import("./views/Profile")),
	contribute: lazy(() => import("./views/Contribute")),
	contributors: lazy(() => import("./views/Contributors")),
	collections: lazy(() => import("./views/Collections")),
};

const TITLES: Record<View, string> = {
	portal: "Arcade Games",
	party: "Party — Arcade Games",
	profile: "Profile — Arcade Games",
	contribute: "Add your game — Arcade Games",
	contributors: "Contributors — Arcade Games",
	collections: "Collections — Arcade Games",
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

	// A NEW party asked for while one is mounted (START A PARTY, a card's
	// PLAY, Recently played, JOIN WITH A CODE, an invite): mountParty runs
	// once per page, so it is a fresh page — after the leave question when
	// the old party is live. Without this the address said "new party" while
	// the old one showed (review, 2026-11-15).
	setNavigationGuard((next) => {
		const p = party();
		if (!p || viewOf(next) !== "party") return true;
		const q = next.searchParams;
		// The code of the party already here (JOIN WITH A CODE, a code
		// link) is this party, not another: shown, never the leave question
		// (as party.js's hashchange handler has it).
		const code = next.hash.match(/[#&]c=(\d{6})/)?.[1];
		const live = p.live ?? (p.room && !p.room.closed);
		// Only while it is live: an ended party's code is a new join (a full
		// load, below), or nothing would run and JOIN WITH A CODE would wait
		// on JOINING… for ever (review, 2026-11-19).
		if (live && code && code === p.code && !q.has("fresh") && !q.has("dev") && !/[#&](i|a)=/.test(next.hash) && !(q.has("game") && q.get("game") !== p.game)) {
			navigate("./?party");
			return false;
		}
		const wantsNew = q.has("fresh") || q.has("dev") || /[#&](i|c|a)=/.test(next.hash) || (q.has("game") && q.get("game") !== p.game);
		if (!wantsNew) return true; // BACK TO GAME, ./?party: the same party
		if (!live) return void location.assign(next.href), false;
		A.leaveParty?.("Leave this party for another?").then((go: boolean) => go && location.assign(next.href));
		return false;
	});

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
					{/* A view's chunk that cannot load (a deploy since this page
					    loaded removed its hashed name): a fresh page, or with a
					    live party, a word and a button rather than nothing. */}
					<ErrorBoundary
						fallback={(err) => {
							console.error(err);
							const p = party();
							// Only a chunk that failed to load, and once: a view that
							// throws as it draws must not reload the page forever.
							const chunk = /dynamically imported module|Importing a module script failed|error loading dynamically/i.test(String((err as Error)?.message ?? err));
							let first = false;
							try {
								first = !sessionStorage.getItem("neon.chunkReload");
								sessionStorage.setItem("neon.chunkReload", "1");
							} catch {}
							if (chunk && first && !(p?.room && !p.room.closed)) location.reload();
							return (
								<main class="view-error">
									<p>The arcade was updated while this page was open.</p>
									<button type="button" class="neon-btn neon-btn--accent" onClick={() => location.reload()}>
										RELOAD
									</button>
								</main>
							);
						}}
					>
						{(() => {
							const V = views[currentView() as Exclude<View, "party">];
							return <V />;
						})()}
					</ErrorBoundary>
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
