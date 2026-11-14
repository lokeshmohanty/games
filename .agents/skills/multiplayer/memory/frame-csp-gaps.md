# What the game frame's CSP does not stop (2026-11-14)

The game frame is `sandbox="allow-scripts"` (opaque origin) with
`default-src 'none'` (lib/bridge.js). It is tempting to read that as "a game
cannot talk to the outside". **Two paths are outside CSP entirely:**

- **WebRTC.** In the SDK v2 review, a sandboxed srcdoc frame under the exact
  bridge CSP created an `RTCPeerConnection` and gathered srflx candidates
  from a public STUN server. That is outbound UDP. Deleting the global in the
  frame does not help: a nested about:blank frame brings it back.
- **Self-navigation.** `location = "https://…?data"` is not blocked.

So `scripts/validate-game.mjs` fails `RTCPeerConnection` / `RTCDataChannel`
statically (`UNCONTAINED`), even though fetch/WebSocket/import became
warnings. Those are covered at runtime, and a CSP violation fails the browser
check. Self-navigation remains a known gap, left to review.

**How to apply:** never write "the CSP holds" as the whole safety argument
for loosening a static check. Test the specific API inside a sandboxed srcdoc
frame first. Related: [[addressed-is-not-private]], [[gaming-platform-vision]].
