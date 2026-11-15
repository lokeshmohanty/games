// src/views/Leaderboard.tsx — one game's board: everyone, friends or a group
// (was leaderboard.html; docs/spa.md, docs/accounts.md).
//
// The board stays lib/leaderboard.js's vanilla DOM (NeonArcade.leaderboard):
// on mount it reads ?game=, ?scope= and ?vs= beside page=leaderboard, draws
// the game, against-bots and scope strips, the podium, the rows and your bar, and keeps the
// choice in the address with history.replaceState.
import { onCleanup, onMount } from "solid-js";
import "../../lib/leaderboard.js";
import "./leaderboard.css";

const A = (window as any).NeonArcade;

export default function Leaderboard() {
	let main!: HTMLElement;
	onMount(() => {
		A.nav.draw();
		onCleanup(A.leaderboard.mount(main));
	});
	return (
		<>
			<nav class="site-nav" data-nav data-page="leaderboard" />
			<main class="view-leaderboard" ref={main}>
				<h1>Leaderboards</h1>
				<div class="strip" data-games role="group" aria-label="Game" />
				<div class="strip" data-vs role="group" aria-label="Ranked or against bots" hidden />
				<div class="strip" data-scopes role="group" aria-label="Whose board" />
				<p class="muted note" data-note />
				<div data-board aria-live="polite" />
				<div class="you" data-you data-away="false" />
			</main>
		</>
	);
}
