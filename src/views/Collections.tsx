// src/views/Collections.tsx — every games repository the arcade lists, most
// played first (docs/index.md, "Contributors and collections").
//
// The cards are lib/collections.js's vanilla DOM (NeonArcade.collections),
// drawn into [data-collections] on mount, as the other views do.
import { onCleanup, onMount } from "solid-js";
import "../../lib/collections.js";
import "./collections.css";

const A = (window as any).NeonArcade;

export default function Collections() {
	let main!: HTMLElement;
	onMount(() => {
		A.nav.draw();
		onCleanup(A.collections.mount(main));
	});
	return (
		<>
			<nav class="site-nav" data-nav data-page="collections" />
			<main class="view-collections" ref={main}>
				<h1>Collections</h1>
				<p class="muted">
					<span data-count /> A collection is one games repository; a <a href="./?page=contributors">contributor</a> can share several.
					★ keeps one at the top.
				</p>
				<div data-collections />
			</main>
		</>
	);
}
