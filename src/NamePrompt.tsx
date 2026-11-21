// src/NamePrompt.tsx — a first visit asks for a name (Lokesh, 2026-11-21:
// "first time a user enters, pop up asking for his name (default: random two
// word title case name), with a button to generate a new random name").
//
// Once per device, over the portal (src/views/Portal.tsx). An in-page
// <dialog> in the house style (lib/styles.css .neon-sheet), never prompt():
// the field holds this device's random default (NeonArcade.defaultName,
// lib/names.js), NEW NAME rolls another, THAT'S ME keeps what the field says.
// Escape, ✕ or a tap outside keep the suggested name — the last one rolled,
// not a half-typed edit. Whichever way it closes, the name is saved where the
// party reads it (localStorage "neon.name", NeonArcade.rememberName), so it
// never asks again; so does a name typed on the party screen.
//
// Not asked: a device with a name already; a signed-in account with a
// display name (that name is saved instead); under automation
// (navigator.webdriver), like the rules sheet (lib/rules.js), so the suites
// are not stopped by it — localStorage "neon.namePrompt" = "on" brings it
// back (scripts/test-portal.mjs), "off" turns it off anywhere.
import { onMount } from "solid-js";
import { render } from "solid-js/web";

const A = (window as any).NeonArcade;
const MAX = 16; // the party's name field (lib/party.js)

const flag = () => {
	try {
		return localStorage.getItem("neon.namePrompt");
	} catch {
		return null;
	}
};

/** Should this device be asked: no name yet, and not switched off (or automated). */
const wanted = () => !A.savedName?.() && (flag() ? flag() === "on" : !navigator.webdriver);

/**
 * Ask, once per device (the portal calls it on every mount). A signed-in
 * account's display name is used rather than asked for; offline, or an
 * account without one, the question is asked.
 */
export function askNameOnce() {
	if (!wanted() || document.querySelector("dialog.name-prompt")) return;
	const show = () => {
		// The account answered after the portal was left, or a name came meanwhile.
		if (!wanted() || document.body.dataset.view !== "portal" || document.querySelector("dialog.name-prompt")) return;
		open();
	};
	if (!A.account?.signedIn?.()) return show();
	Promise.resolve(A.account.me ?? A.account.load?.())
		.catch(() => null)
		.then((me: any) => {
			const name = typeof me?.name === "string" ? me.name.trim().slice(0, MAX) : "";
			if (name && !A.savedName?.()) A.rememberName(name);
			else show();
		});
}

function open() {
	const host = document.createElement("div");
	document.body.append(host);
	const back = document.activeElement as HTMLElement | null;
	const dispose = render(
		() => (
			<NamePrompt
				gone={() => {
					dispose();
					host.remove();
					if (back?.isConnected) back.focus();
				}}
			/>
		),
		host,
	);
}

function NamePrompt(props: { gone: () => void }) {
	let dialog!: HTMLDialogElement;
	let field!: HTMLInputElement;
	let suggested: string = A.defaultName?.() ?? "Player";
	const seen = new Set([suggested]);
	let pressedOutside = false;
	let chosen: string | null = null;

	const roll = () => {
		suggested = A.names?.random?.(seen) ?? suggested;
		seen.add(suggested);
		field.value = suggested;
		field.focus();
		field.select();
	};

	const confirm = (e: Event) => {
		e.preventDefault();
		chosen = field.value.trim().slice(0, MAX) || suggested;
		dialog.close();
	};

	onMount(() => {
		field.value = suggested;
		dialog.showModal();
		field.focus();
		field.select();
	});

	// Closed any way: THAT'S ME keeps the field; Escape, ✕, a tap outside the suggestion.
	const closed = () => {
		A.rememberName?.(chosen ?? suggested);
		props.gone();
	};

	return (
		<dialog
			ref={dialog}
			class="neon-sheet name-prompt"
			aria-labelledby="name-prompt-title"
			aria-describedby="name-prompt-text"
			onClose={closed}
			onPointerDown={(e) => (pressedOutside = e.target === dialog)}
			onClick={(e) => e.target === dialog && pressedOutside && dialog.close()}
		>
			<div class="neon-sheet-head">
				<h2 id="name-prompt-title">What should we call you?</h2>
				<button type="button" class="neon-sheet-x" aria-label="Close, keeping the suggested name" onClick={() => dialog.close()}>
					✕
				</button>
			</div>
			<form class="neon-sheet-body" onSubmit={confirm} novalidate>
				<label class="neon-sheet-text" id="name-prompt-text" for="name-prompt-field">
					The name other players see. Change it any time on the party screen.
				</label>
				<input
					ref={field}
					id="name-prompt-field"
					class="name-prompt-field"
					name="name"
					type="text"
					maxLength={MAX}
					autocomplete="nickname"
					enterkeyhint="done"
					spellcheck={false}
				/>
				<div class="lobby-row name-prompt-actions">
					<button type="button" class="neon-btn name-prompt-roll" onClick={roll}>
						NEW NAME
					</button>
					<button type="submit" class="neon-btn neon-btn--accent name-prompt-ok">
						THAT'S ME
					</button>
				</div>
			</form>
		</dialog>
	);
}
