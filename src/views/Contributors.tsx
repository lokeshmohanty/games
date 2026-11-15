// src/views/Contributors.tsx — everyone whose games the arcade lists
// (was contributors.html; docs/spa.md).
//
// The cards stay lib/contributors.js's vanilla DOM (NeonArcade.contributors):
// it draws them into [data-people] on mount, each with the person's
// collections (lib/collections.js) and a ★. CHECK FOR UPDATES asks GitHub
// through lib/propose.js.
import { onCleanup, onMount } from "solid-js";
import "../../lib/propose.js";
import "../../lib/collections.js";
import "../../lib/contributors.js";
import "./collections.css";
import "./contributors.css";

const A = (window as any).NeonArcade;

export default function Contributors() {
	let main!: HTMLElement;
	onMount(() => {
		A.nav.draw();
		onCleanup(A.contributors.mount(main));
	});
	return (
		<>
			<nav class="site-nav" data-nav data-page="contributors" />
			<main class="view-contributors" ref={main}>
				<h1>Contributors</h1>
				<p class="muted">
					<span data-count /> Each shares one or more <a href="./?page=collections">collections</a> — games repositories. Make one
					yourself — <a href="./?page=contribute">add your game</a>. Your card comes from a <code>contributor.json</code> in your games
					repo; ★ keeps someone at the top.
				</p>
				<div data-people />
			</main>
		</>
	);
}
