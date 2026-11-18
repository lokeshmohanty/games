// src/JoinCode.tsx — JOIN WITH A CODE: the party code, typed into the page.
//
// It was the browser's prompt() (Lokesh's phone, 2026-11-15): no number
// keypad, a wrong code popped a second native dialog, and automated phone
// testing stalls on native dialogs. This is an in-page <dialog> in the house
// style (lib/styles.css .neon-sheet): a numeric field the phone fills from
// its keypad, its clipboard or an SMS (one-time-code), and an inline error.
//
// The dialog stays open until the join has an answer. JOIN moves to the
// party (./?party#c=…), which joins behind the dialog and says how it ended
// (lib/party.js `neon:code-join`): joined, the dialog goes; refused — a
// wrong or expired code, a full party, no network — the reason shows under
// the field and the next code is tried in place (the party's joinCode), with
// no page load. Escape, CANCEL, ✕ or a tap outside close it; after a refused
// code that also leaves the party screen for where the dialog was opened.
// It lives on document.body, not in a view: the portal goes as the party
// shows.
import { createSignal, onCleanup, onMount } from "solid-js";
import { render } from "solid-js/web";
import { navigate } from "./router";

/** Open the dialog; focus returns to `opener` when it closes on the same view. */
export function openJoinCode(opener?: HTMLElement | null) {
	if (document.querySelector("dialog.join-code")) return;
	const host = document.createElement("div");
	document.body.append(host);
	const dispose = render(
		() => (
			<JoinCode
				opener={opener ?? null}
				gone={() => {
					dispose();
					host.remove();
				}}
			/>
		),
		host,
	);
}

/** Digits only, at most six: "12-34-56", " 123 456", "Code: 123456" all paste as 123456. */
export const codeDigits = (raw: string) => raw.replace(/\D/g, "").slice(0, 6);

function JoinCode(props: { opener: HTMLElement | null; gone: () => void }) {
	let dialog!: HTMLDialogElement;
	let field!: HTMLInputElement;
	const from = location.pathname + location.search + location.hash;
	const [error, setError] = createSignal("");
	const [busy, setBusy] = createSignal<string | null>(null);
	// The last answer was a refusal: closing goes back where we came from.
	let refused = false;

	const say = (text: string) => {
		setError(text);
		field.focus();
		field.select();
	};

	const onAnswer = (e: Event) => {
		const d = (e as CustomEvent).detail ?? {};
		if (d.code !== busy()) return;
		setBusy(null);
		if (d.ok) {
			refused = false;
			dialog.close();
			return;
		}
		refused = true;
		say(d.message || "That party could not be joined.");
	};

	const join = (e: Event) => {
		e.preventDefault();
		if (busy()) return;
		const code = codeDigits(field.value);
		field.value = code;
		if (code.length !== 6) return say("A party code is six digits.");
		setError("");
		setBusy(code);
		const party = (window as any).__party;
		// A refused code, the party screen behind us: the next one in place.
		if (party?.joinCode?.(code)) return;
		// A live party: leaving it is the router's question (src/App.tsx),
		// then a fresh page; this dialog has done its part.
		if (party?.room && !party.room.closed) {
			dialog.close();
			navigate(`./?party#c=${code}`);
			return;
		}
		navigate(`./?party#c=${code}`);
	};

	onMount(() => {
		document.addEventListener("neon:code-join", onAnswer);
		dialog.showModal();
		field.focus();
	});
	onCleanup(() => document.removeEventListener("neon:code-join", onAnswer));

	const closed = () => {
		const back = refused && location.pathname + location.search + location.hash !== from;
		props.gone();
		if (back) navigate(from);
		else if (props.opener?.isConnected) props.opener.focus();
	};

	return (
		<dialog
			ref={dialog}
			class="neon-sheet join-code"
			aria-labelledby="join-code-title"
			onClose={closed}
			onClick={(e) => e.target === dialog && dialog.close()}
		>
			<div class="neon-sheet-head">
				<h2 id="join-code-title">Join a party</h2>
				<button type="button" class="neon-sheet-x" aria-label="Close" onClick={() => dialog.close()}>
					✕
				</button>
			</div>
			<form class="neon-sheet-body" onSubmit={join} novalidate>
				<label class="neon-sheet-text" for="join-code-field">
					The six-digit code on the host's party screen.
				</label>
				<input
					ref={field}
					id="join-code-field"
					class="join-code-field"
					name="code"
					type="text"
					inputmode="numeric"
					autocomplete="one-time-code"
					enterkeyhint="go"
					pattern="[0-9]*"
					placeholder="000000"
					spellcheck={false}
					aria-invalid={error() ? "true" : "false"}
					aria-describedby="join-code-error"
					disabled={!!busy()}
					onInput={(e) => {
						const t = e.currentTarget;
						const digits = codeDigits(t.value);
						if (t.value !== digits) t.value = digits;
						if (error()) setError("");
					}}
				/>
				<p id="join-code-error" class="join-code-error" role="alert">
					{error()}
				</p>
				<div class="lobby-row join-code-actions">
					<button type="button" class="neon-btn" onClick={() => dialog.close()}>
						CANCEL
					</button>
					<button type="submit" class="neon-btn neon-btn--accent" disabled={!!busy()}>
						{busy() ? "JOINING…" : "JOIN"}
					</button>
				</div>
			</form>
		</dialog>
	);
}
