# Ask Chrome whether it installs; do not ask the manifest

Found 2026-08-15, while making the arcade installable.

**Why:** the manifest satisfied every rule I had written down — name,
`short_name`, `display: standalone`, background and theme colours, `start_url`
inside `scope`, 192 and 512 PNG icons all returning 200, a maskable icon — and
Chrome still refused to install it. Nothing in the page, the console or the
network log said so. An installability bug is invisible by construction: the
symptom is the *absence* of an install offer.

## The trap: an SVG in `manifest.icons`

The icon list began with:

```json
{ "src": "assets/icon.svg", "sizes": "any", "type": "image/svg+xml" }
```

`sizes: "any"` means it matches every size request, so Chrome selects it as
*the* install icon, then rejects it — and does **not** fall back to the PNGs
sitting right beside it. The verdict is `no-acceptable-icon` with
`minimum-icon-size-in-pixels: 144`, which reads as "your icons are too small"
while two icons of 192 and 512 are present and fetchable.

Bisected against a real Chrome, one manifest variant per run:

| manifest | verdict |
|---|---|
| as written (SVG first) | `no-acceptable-icon` |
| **SVG entry removed** | **installable** |
| only the 512 PNG | installable |
| `purpose` field dropped | installable |
| `shortcuts` removed / `id` removed | still `no-acceptable-icon` |

The SVG is the only variable. It now lives on as the favicon via
`<link rel="icon" type="image/svg+xml">` on each page, which is where scaling to
any tab size is actually worth something, and `manifest.webmanifest` carries a
`_icons_note` key saying why it is not in `icons`.

## The check that catches this class of bug

Chrome's own verdict, over CDP:

```js
const cdp = await ctx.newCDPSession(page);
await cdp.send("Page.getAppManifest");          // parse errors
await cdp.send("Page.getInstallabilityErrors"); // the real verdict
```

`scripts/test-pwa.mjs` runs both on every invocation.

**Use a persistent profile** (`chromium.launchPersistentContext`). Every
throwaway Playwright context is incognito, and `in-incognito` is itself a
blocking installability error that masks whatever else is wrong.

Generalise: for anything whose success is a browser's private judgement —
installability, autoplay, permission prompts — assert the browser's verdict, not
your reading of the spec.
