// src/views/Contributors.tsx — everyone whose games the arcade lists
// (was contributors.html; docs/spa.md).
//
// The cards stay lib/contributors.js's vanilla DOM (NeonArcade.contributors):
// it draws them into [data-people] on mount. CHECK FOR UPDATES asks GitHub
// through lib/propose.js.
import { onCleanup, onMount } from "solid-js";
import "../../lib/propose.js";
import "../../lib/contributors.js";
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
					<span data-count /> Make one yourself — <a href="contribute.html">add your game</a>. Your card comes from a{" "}
					<code>contributor.json</code> in your games repo.
				</p>
				<div data-people />
			</main>
		</>
	);
}
