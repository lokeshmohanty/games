// src/views/Profile.tsx — your account, or a player's public profile
// (was profile.html; docs/spa.md).
//
// The page stays lib/profile.js's vanilla DOM (NeonArcade.profilePage): it
// draws into [data-profile] from the address — ?u=<id> for someone else,
// ?join=<code> to join a group. A link from one profile to another changes
// only the address, so it is drawn again whenever the address does.
import { createEffect, on, onCleanup, onMount } from "solid-js";
import { currentUrl, currentView } from "../router";
import "../../lib/profile.js";
import "./profile.css";

const A = (window as any).NeonArcade;

export default function Profile() {
	let main!: HTMLElement;
	let stop: (() => void) | undefined;
	createEffect(
		on(
			() => currentUrl().search,
			() => {
				if (currentView() !== "profile") return;
				stop?.();
				stop = A.profilePage.mount(main);
			},
		),
	);
	onMount(() => A.nav.draw());
	onCleanup(() => stop?.());
	return (
		<>
			<nav class="site-nav" data-nav data-page="profile" />
			<main class="view-profile" ref={main}>
				<h1 data-title>Profile</h1>
				<div data-profile />
			</main>
		</>
	);
}
