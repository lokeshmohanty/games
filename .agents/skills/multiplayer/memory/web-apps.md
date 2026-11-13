---
name: web-apps
description: Traps found building the web-app path (manifest `app`, sdk/v1/web-shim.js, lib/py-server.js) — what a sandboxed srcdoc frame refuses, and the two test traps that made a passing feature look broken.
metadata:
  type: project
---

Built 2026-11-14 on branch `plug-n-play` (docs/sdk.md "Web apps"). Lokesh:
"My platform is supposed to be plug-n-play" — an outside React + FastAPI app
must run unchanged. See [[handover]] (a web app's takeOver is false) and
[[addressed-is-not-private]] (p$http bodies relay in plaintext).

**Why:** each of these looked like a design failure the first time and was
not; re-deriving them costs an afternoon.

- **`pushState` in an `about:srcdoc` frame throws** for any URL change but
  the fragment (spec: "can have its URL rewritten"), and `window.location`
  is unforgeable. So the app's `location`/`history` are rewritten at build
  time (esbuild `--define`, only unbound globals; `contentWindow.location`
  is untouched) to `__neon.*`.
- **An `<img src="/x.svg">` logs a CSP violation the moment the attribute is
  set**, before any MutationObserver runs — and validate-game fails console
  errors. The shim catches it in `Element.prototype.setAttribute` and the
  `src` setters and puts a blank in until the blob: URL is ready.
- **Pyodide loads in an opaque frame** only with `createPyodideModule`
  passed to `loadPyodide` (both ES modules inlined, exports made globals)
  and `packageBaseUrl` set; without the latter `loadPackage` fails with
  "relative path … but no packageBaseUrl".
- **Starlette runs plain `def` endpoints via `anyio.to_thread.run_sync`**;
  Pyodide has no threads. Patching that one function is enough.
- **Test trap: Playwright's `waitForFunction` polls on rAF by default**, and
  a background page draws no frames — it waits forever. Pass
  `{ polling: 250 }` in multi-page tests.
- **Test trap: a click into a background page's frame lands on the
  `<iframe>`** (docs/sdk.md, Testing) — `bringToFront()` before clicking.
  Both traps hit the rules-overlay check; calling `window.open` directly
  proved the feature worked.

**How to apply:** before changing web-shim.js or the app path in bridge.js,
run `just test-webapp`; before blaming a feature for a multi-peer test
failure, rule out the two test traps.
