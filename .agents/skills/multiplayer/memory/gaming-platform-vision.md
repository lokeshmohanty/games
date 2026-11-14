---
name: gaming-platform-vision
description: Lokesh's 2026-11-14 directive to make the arcade fast and slick and its game contract language-neutral — the decisions he took (two-layer SDK v2, managed state, WASM, Solid SPA shell) and the phase order.
metadata:
  type: project
---

Asked 2026-11-14: refactor the whole platform to be "very fast and slick" and
make contributing games modular, "invariant of the language used", through an
API "not the traditional sense, rather the way that would suite it" so any game
joins with "minor modifications". He offered "solidJS or wasm with rust" as
candidates and asked for detailed information and a proper plan before any
code. Plan of record: `~/.claude/plans/ethereal-honking-beaver.md`. Work runs
in the worktree `../games-platform-v2` (branch `platform-v2`) because the
shared checkout carried another session's live work.

Decisions he took (AskUserQuestion, 2026-11-14), so don't re-ask them:

- **Contract: two layers.** Layer 1 is a published, versioned message protocol
  (JSON over the MessagePort, JSON Schema, generated bindings). Layer 2 is
  opt-in **managed state**: the game exports init/apply/tick/view/turn/bot/
  result/snapshot/restore, and the platform owns sync, bots, rejoin and host
  handover. Nothing a game needs may exist only as in-frame JS. See
  [[handover]] and [[bots-as-members]].
- **Hidden info:** the host is trusted, and full state replicates to the heir.
  Games that need a dealer nobody can peek at use seal/commit/reveal as shell
  services. See [[unrefereed-honesty]].
- **WASM is allowed** (`wasm-unsafe-eval` in the frame CSP) with a 10 MB cap.
  Godot and Unity stay out. Pyodide is a platform runtime and does not count
  toward the cap.
- **Adapters and examples** for JS, HTML/CSS, TS (+Solid), Rust, C/C++
  (Emscripten), Go (TinyGo) and Python.
- **v1 is migrated, then dropped.** All 10 games port to v2. Web apps
  ([[web-apps]]) keep working through an `sdk: 1` → 2 auto-upgrade for
  `kind: shared`.
- **Shell:** measured speed fixes first, then a Solid + Vite single-page
  shell. `file://` is dropped for the shell too. Rust/WASM *for the shell*
  was not chosen: the shell is bound by I/O and the DOM.
- **Order:** perf → protocol → managed → SPA, with each phase merged only
  after he confirms.

**Why:** the measured slowness was network and handshake cost (a server probe
before bots mode, serial frame fetches, a network-first service worker,
6.7 MB of gifs), not the DOM. And the old contract was a JS object API, so
non-JS games could not exist at all (the CSP blocked WebAssembly).
