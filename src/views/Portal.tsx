// src/views/Portal.tsx — the home screen: brand, the party banner, then the
// Games tab's two sub-tabs (was index.html; docs/spa.md):
//   My Games   (./?page=games&tab=mine) recently played, ★ favourites, or
//              how to star when there are none
//   All Games  (./?page=games&tab=all) the search, Popular (with PLAY
//              SOMETHING) and the categories, each with SEE ALL: its own
//              page (&genre=<id>), a grid
// The router names the sub-tab for ./ (src/router.ts portalAddress); this
// view follows the address, so Back moves between them.
//
// The sections, cards and search stay lib/portal.js's vanilla DOM
// (NeonArcade.portal): it draws them into [data-sections] and .games-grid
// on mount. lib/pwa.js fills the install slot, lib/nav.js the bar and tabs.
// index.html's speculationrules prefetch of party.html is gone: the party is
// this page.
import { createEffect, on, onCleanup, onMount } from "solid-js";
import "../../lib/portal.js";
import { openJoinCode } from "../JoinCode";
import { askNameOnce } from "../NamePrompt";
import { currentUrl, navigate, portalTab, viewOf } from "../router";
import "./portal.css";

const A = (window as any).NeonArcade;

/**
 * Join a party by its six-digit code. Lives on the portal because the code
 * is the one piece of party plumbing a newcomer meets before they have a
 * party open. An in-page dialog (src/JoinCode.tsx), never prompt(): a
 * number keypad, and a wrong code said in place.
 */
function joinWithCode(event: MouseEvent) {
	event.stopPropagation();
	openJoinCode(event.currentTarget as HTMLElement);
}

export default function Portal() {
	let main!: HTMLElement;
	let nav!: HTMLElement;
	const tab = () => portalTab(currentUrl()) ?? "all";
	onMount(() => {
		nav.dataset.page = tab();
		A.nav.draw();
		A.renderInstallOffer?.(); // the slot is new on every visit
		onCleanup(A.portal.mount(main, tab()));
		askNameOnce(); // a first visit's name (src/NamePrompt.tsx), once per device
	});
	// A sub-tab chosen, Back to the other one, or to another search: the same
	// view, redrawn. (An address of another view: this one is going.)
	createEffect(
		on(
			currentUrl,
			(u) => {
				const t = viewOf(u) === "portal" ? portalTab(u) : null;
				if (!t) return;
				if (nav.dataset.page !== t) {
					nav.dataset.page = t;
					A.nav.draw();
				}
				A.portal.show(t);
			},
			{ defer: true },
		),
	);
	return (
		<main class="view-portal" ref={main}>
			{/* lib/nav.js: the tabs, the ☰ menu, and the sub-tabs My Games · All Games. */}
			<nav class="site-nav" data-nav ref={nav} />
			<h1 class="brand">
				<svg class="mark" viewBox="96 104 320 288" aria-hidden="true">
					<g transform="translate(0 9)" stroke-linecap="round">
						<path class="wire" d="M168 176 C168 100 344 100 344 176" stroke-width="16" />
						<rect class="base" x="104" y="332" width="128" height="44" rx="22" />
						<rect class="base" x="280" y="332" width="128" height="44" rx="22" />
						<path class="p1" d="M168 334 V250" stroke-width="22" />
						<path class="p2" d="M344 334 V250" stroke-width="22" />
						<circle class="p1" cx="168" cy="214" r="44" stroke-width="0" />
						<circle class="p2" cx="344" cy="214" r="44" stroke-width="0" />
					</g>
				</svg>
				<span>Arcade Games</span>
			</h1>
			<p class="tagline">
				Every game is multiplayer. Play the bots on this device, or send an invite and play the people. No accounts, no servers,
				nothing to sign up for.
			</p>
			{/* Filled in only when this browser can actually install the app. */}
			<div class="install-slot" data-install-slot />

			<div
				class="party-banner"
				onClick={(e) => {
					// START A PARTY is a link of its own (the router follows it), and
					// a navigation here first would open the saved party, not a fresh one.
					if ((e.target as Element).closest("a, button")) return;
					navigate("./?party");
				}}
			>
				<div>
					<h3>Start a Party</h3>
					<p>
						Everyone connects once, then the host switches between games without anybody reconnecting. Pick teams, add bots, watch
						as a spectator, hand the party over before you leave.
					</p>
				</div>
				<a href="./?fresh=1" class="play-btn">
					START A PARTY
				</a>
				<button type="button" class="play-btn join-code-btn" onClick={joinWithCode}>
					JOIN WITH A CODE
				</button>
			</div>

			{/* My Games: Recently played (with PLAY SOMETHING), then ★ Favourites
			    (a section below); with neither, how to star a game. */}
			<div class="recent" data-recent hidden>
				<div class="section-head">
					<h2>Recently played</h2>
					<a class="quick-play-btn" data-quick href="./?page=games&tab=all">
						PLAY SOMETHING
					</a>
				</div>
				<div class="recent-list" />
			</div>
			<div class="my-empty" data-my-empty hidden>
				<p>Nothing here yet. Star a game from inside it, with ★, and it appears here. So do the games you play.</p>
				<div class="my-empty-actions">
					<a class="quick-play-btn" data-quick href="./?page=games&tab=all">
						PLAY SOMETHING
					</a>
					<a class="my-empty-all" href="./?page=games&tab=all">
						ALL GAMES
					</a>
				</div>
			</div>

			{/*
			  All Games: the search. Typed into, it replaces the sections below with
			  one grid of what matches. lib/portal.js parseQuery: words, or author:
			  type: tag: players: from:
			*/}
			<div class="search" hidden>
				<input
					type="search"
					data-search
					placeholder="Search games"
					aria-label="Search games"
					autocomplete="off"
					spellcheck={false}
				/>
			</div>
			<p class="filter-empty" hidden>
				Nothing matches that yet.
			</p>

			{/* Drawn by lib/portal.js from every game's manifest (lib/catalog.js,
			    community/catalog.js): a registered game needs no edit here.
			    The sections (favourites, popular, the categories), and the
			    search's results in their place while a search is typed. */}
			{/* A genre's page (./?page=games&tab=all&genre=party, lib/portal.js):
			    the way back to All Games, over the genre's grid. */}
			<a class="genre-back" data-genre-back href="./?page=games&tab=all" hidden>
				<span aria-hidden="true">←</span> All Games
			</a>
			<div class="portal-sections" data-sections />
			<div class="games-grid" hidden />
		</main>
	);
}
