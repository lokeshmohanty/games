// src/views/Contribute.tsx — "Add your game": the guide, and proposing games.
//
// The guide is CONTRIBUTING.md itself (one source), fetched at run time (it
// is copied into dist and precached) and drawn by lib/markdown.js. Propose
// (lib/propose.js) opens GitHub's own page, filled in: the pull request is
// the contributor's to open, and once it is merged the site deploys itself.
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import "../../lib/markdown.js";
import "../../lib/propose.js";
import "./contribute.css";

const A = (window as any).NeonArcade;
const REPO_FILES = "https://github.com/lokeshmohanty/games/blob/main/";

type Plan =
	| { kind: "current"; repo: string; at: string }
	| { kind: "update"; repo: string; url: string; from: string; to: string }
	| { kind: "new"; repo: string; url: string; text: string; games: string[]; to: string };
/** What the propose box shows: a line of text, or a plan. */
type Out = { text: string } | { plan: Plan };

export default function Contribute() {
	const [guide, setGuide] = createSignal('<p class="muted">Loading the guide…</p>');
	const [out, setOut] = createSignal<Out | null>(null);
	let repo!: HTMLInputElement;
	let alive = true;
	let asked = 0; // the latest PROPOSE: an older answer arriving late is dropped
	onCleanup(() => (alive = false));

	onMount(() => {
		A.nav.draw();
		fetch("CONTRIBUTING.md")
			.then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
			.then((md) => alive && setGuide(A.markdown.render(md, { base: REPO_FILES })))
			.catch(() => {
				if (alive) setGuide(`<p>The guide could not be loaded. It is <a href="${REPO_FILES}CONTRIBUTING.md">CONTRIBUTING.md on GitHub</a>.</p>`);
			});
	});

	// Propose: new repo → the filled "new file" page; pinned and moved → the
	// pin's edit page and the commit to paste.
	async function propose(e: SubmitEvent) {
		e.preventDefault();
		const mine = ++asked;
		setOut({ text: "Asking GitHub…" });
		try {
			const plan: Plan = await A.propose.plan(repo.value, A.propose.pinnedOf(A.propose.parse(repo.value).repo));
			if (alive && mine === asked) setOut({ plan });
		} catch (err) {
			if (alive && mine === asked) setOut({ text: (err as Error).message });
		}
	}

	// GitHub can fill a new file but not an edit: copy the commit on the same
	// tap that opens the pin, and say where to paste it.
	const copy = (sha: string) =>
		navigator.clipboard?.writeText(sha).then(
			() => A.toast?.("New commit copied.", "good"),
			() => {},
		);

	const result = (o: Out) => {
		if ("text" in o) return o.text;
		const p = o.plan;
		if (p.kind === "current") return <p class="muted">{`${p.repo} is already listed at its latest commit (${p.at.slice(0, 7)}).`}</p>;
		if (p.kind === "update")
			return (
				<>
					<p class="muted">{`${p.repo} is listed at ${p.from.slice(0, 7)}; its newest commit is ${p.to.slice(0, 7)}.`}</p>
					<a class="neon-btn neon-btn--accent" href={p.url} target="_blank" rel="noopener" onClick={() => copy(p.to)}>
						COPY THE COMMIT &amp; OPEN THE PIN ↗
					</a>
					<ol class="propose-steps">
						<For
							each={[
								`In the "commit" line, select the old commit ${p.from.slice(0, 7)}… (the 40 characters between the quotes).`,
								"Paste — the new commit is on your clipboard.",
								'Commit changes → "Create a new branch… and start a pull request" → Propose changes.',
							]}
						>
							{(t) => <li>{t}</li>}
						</For>
					</ol>
					<p class="muted">The new commit, if the copy did not work:</p>
					<pre>{p.to}</pre>
				</>
			);
		return (
			<>
				<p class="muted">{`registry/${p.repo}.json — ${p.games.length} game${p.games.length === 1 ? "" : "s"} at ${p.to.slice(0, 7)}:`}</p>
				<pre>{p.text}</pre>
				<a class="neon-btn neon-btn--accent" href={p.url} target="_blank" rel="noopener">
					OPEN ON GITHUB ↗
				</a>
			</>
		);
	};

	// The nav sits outside <main>, as on the old page, so the guide's column
	// (max-width, padding) does not narrow the bar.
	return (
		<div class="view-contribute">
			<nav class="site-nav" data-nav data-page="contribute" />
			<main>
				<div data-guide innerHTML={guide()} />
				<section class="propose">
					<h2>Propose your games</h2>
					<p class="muted">
						Your public repo, <code>owner/name</code> — or <code>owner/name@branch</code> for games that live on a branch. This opens GitHub's
						page for the registry file, filled in — commit it there and GitHub offers the pull request.
					</p>
					<form class="propose-row" data-propose onSubmit={propose}>
						<input
							ref={repo}
							type="text"
							data-repo
							placeholder="your-github/your-games"
							aria-label="Your games repository, owner/name"
							autocomplete="off"
							spellcheck={false}
						/>
						<button class="neon-btn neon-btn--accent" type="submit">
							PROPOSE
						</button>
					</form>
					<div data-propose-out>
						<Show when={out()} keyed>
							{(o) => result(o)}
						</Show>
					</div>
				</section>
			</main>
		</div>
	);
}
