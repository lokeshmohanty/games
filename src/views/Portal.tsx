// src/views/Portal.tsx — the home screen: brand, the party banner, search,
// recently played, then the sections of cards (was index.html; docs/spa.md).
//
// The sections, cards and search stay lib/portal.js's vanilla DOM
// (NeonArcade.portal): it draws them into [data-sections] and .games-grid
// on mount. lib/pwa.js fills the install slot, lib/nav.js the bar and tabs.
// index.html's speculationrules prefetch of party.html is gone: the party is
// this page.
import { onCleanup, onMount } from "solid-js";
import "../../lib/portal.js";
import { navigate } from "../router";
import "./portal.css";

const A = (window as any).NeonArcade;

/**
 * Join a party by its six-digit code. Lives on the portal because the code
 * is the one piece of party plumbing a newcomer meets before they have a
 * party open. The prompt is deliberately plain: it works inside the PWA
 * shell. Six digits to ./?party#c=, which joins it.
 */
function joinWithCode(event: MouseEvent) {
	event.stopPropagation();
	const raw = prompt("Enter the 6-digit party code");
	if (raw == null) return; // cancelled
	const code = raw.replace(/\D/g, "").slice(0, 6);
	if (code.length !== 6) return alert("That is not a six-digit party code.");
	navigate("./?party#c=" + code);
}

export default function Portal() {
	let main!: HTMLElement;
	onMount(() => {
		A.nav.draw();
		A.renderInstallOffer?.(); // the slot is new on every visit
		onCleanup(A.portal.mount(main));
	});
	return (
		<main class="view-portal" ref={main}>
			{/* lib/nav.js: GitHub, Add your game | theme, account; and the tabs. */}
			<nav class="site-nav" data-nav data-page="games" />
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

			{/*
			  The search. Typed into, it replaces the sections below with one grid of
			  what matches. lib/portal.js parseQuery: words, or author: type: tag:
			  players: from:
			*/}
			<div class="search">
				<input
					type="search"
					data-search
					placeholder="Search — or author:name  type:duel  tag:quick  players:4"
					aria-label="Search games by name, author, type, tag or players"
					autocomplete="off"
					spellcheck={false}
				/>
			</div>
			<p class="filter-empty" hidden>
				Nothing matches that yet.
			</p>

			<div class="recent" data-recent hidden>
				<h2>Recently played</h2>
				<div class="recent-list" />
			</div>

			{/* Drawn by lib/portal.js from every game's manifest (lib/catalog.js,
			    community/catalog.js): a registered game needs no edit here.
			    The sections (favourites, popular, the categories), and the
			    search's results in their place while a search is typed. */}
			<div class="portal-sections" data-sections />
			<div class="games-grid" hidden />
		</main>
	);
}
