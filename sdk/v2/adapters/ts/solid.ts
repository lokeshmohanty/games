// sdk/v2/adapters/ts/solid.ts — Solid helpers for a managed SDK v2 game.
//
// The platform sends each phone its view only when it changed; `createView`
// turns that into a signal, so a component reads `view()` and Solid updates
// just the text and attributes that depend on what changed.

import { type Accessor, createSignal, getOwner, onCleanup } from "solid-js";
import { arcade } from "./arcade";

/** This phone's view, as a signal: null until the first one arrives. */
export function createView<V>(): Accessor<V | null> {
	const [view, setView] = createSignal<V | null>((arcade.view as V | null) ?? null);
	const off = arcade.on("view", (m) => setView(() => m.state as V));
	if (getOwner()) onCleanup(off);
	return view;
}
