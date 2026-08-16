# Reply-code scanning: the traps, and the only test that catches them

Written 2026-08-15, after "the reply scanner isn't working" turned out to be a
bug the existing scan test was structurally incapable of catching.

**Why:** SCAN REPLY has now failed twice for two different reasons, and both
times it failed *silently* — camera live, preview moving, no result and no
error. There is nothing to see and nothing in a console. Both causes are
counter-intuitive enough to be reintroduced by anyone optimising this file in
good faith.

## The constraint everything else follows from

A reply code is a **70-90 module QR** photographed off *somebody else's screen*
from across a table. Pixels per module is the scarce resource and the only thing
that decides whether a frame decodes. Measured on synthetic frames: ~3 px/module
is the floor, and a 89-module code at 2.7 px/module does not decode.

**Never lower the working resolution to save time.** If a decode is too slow,
decode *less often* or *more cheaply* — never *less well*.

## Trap 1 — the backoff that fired on empty frames (the 2026-08-15 bug)

`scanQr` used to drop its working width from 1280 to 720 whenever one decode
took over 250 ms. That reads as prudent and is exactly backwards:

| frame | decode cost (desktop) | cost at 4x CPU throttle |
|---|---|---|
| code in view (hit) | 74 ms | 120 ms |
| **empty (miss)** | **280 ms** | **712 ms** |

A miss costs 4x a hit, because nothing is found and every binarisation pass runs
to the end. The camera opens onto an empty room and its owner spends a second or
two aiming — so the backoff fired *before the code had ever been in frame*, and
at 720 px a reply code no longer had the pixels per module to be read. Permanent
failure, on every device, triggered by normal use.

Fixed by removing the backoff entirely. Cost is now managed by decoding the
**centred square at the camera's native resolution** (the region the 1:1
`object-fit: cover` preview shows — cheaper than the old full-frame downscale
*and* higher resolution), running the cheap binarisation pass on most frames and
the full ladder every third, and pacing the loop to the last decode's cost.

## Trap 2 — a platform `BarcodeDetector` that rejects

Chrome exposes `BarcodeDetector` on platforms where the service behind it is
missing (on Android it is a Play Services module that may never have been
downloaded). `detect()` then **rejects on every frame**. The rejection used to
propagate to the tick's outer `catch`, skipping this project's own decoder
entirely — so the fallback that exists precisely for this never ran.

Now: probe `getSupportedFormats()` before constructing, and drop the detector
permanently on the first `detect()` failure. Verified all three shapes —
constructor throws, `detect()` rejects, `detect()` always returns `[]`.

## Trap 3 — `onError` firing before the caller holds the handle

Callers write `scanner = NeonArcade.scanQr({ onError })` and clean up through
`scanner`. The insecure-context path called `onError` **synchronously**, before
that assignment landed, so cleanup tidied up `null` and the button was left
showing CANCEL SCAN over a dead scanner. `scanQr` now defers every error to a
timeout. This is a contract, not an implementation detail — keep it.

## The test shape that matters

**A code sitting in frame from the first instant is the one situation the
scanner never meets.** That is what the old test did, which is why it passed
throughout the outage: the first decode was a fast hit, so the backoff never
fired.

Any test claiming to cover scanning must include **aim-then-show** — seconds of
empty frames, *then* the code — and should run under CPU throttling
(`Emulation.setCPUThrottlingRate` via CDP, 4x-6x approximates a mid-range
phone), which is where the scanner actually runs. `scripts/test-scan.mjs` now
does both, plus the broken-detector and async-error cases. Verified: 3/3 FAIL
before the fix, 3/3 pass after.

## What is still not covered

Everything is a fake capture device (`--use-file-for-fake-video-capture` with an
ffmpeg-built y4m). Nothing here reproduces glare, autofocus hunting or motion
blur, and no real phone camera has ever been tested. Treat a green suite as
"the failure modes we know about are gone", not "scanning works".
