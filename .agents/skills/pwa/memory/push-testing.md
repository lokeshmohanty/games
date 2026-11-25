# Testing Web Push in a headless browser (2026-11-18)

`scripts/test-push.mjs` drives party invites by notification end to end.
Three things a real browser does cannot be done here, and each has a stand-in:

- **Subscribing.** Playwright's Chromium has no Google API keys, so
  `pushManager.subscribe()` cannot register with FCM. The test stubs
  `PushManager.prototype.subscribe/getSubscription` (addInitScript, wrapped
  in try: it also runs in sandboxed game frames) to hand out a subscription
  on the loopback fake push service (`scripts/push-fake.mjs`), whose private
  key only the test holds. What the page sends (`userVisibleOnly`, the
  server's key) is still checked.
- **Delivery.** The Worker really encrypts and signs; the fake really
  verifies the VAPID JWT and decrypts as the browser would — and the fake's
  decryption is itself checked against RFC 8291 Appendix A's message, so a
  shared misunderstanding cannot pass both sides. The decrypted payload is
  then handed to the real service worker with CDP
  `ServiceWorker.deliverPushMessage` (registration id from
  `ServiceWorker.workerRegistrationUpdated` after `ServiceWorker.enable`),
  and `registration.getNotifications()` (via `context.serviceWorkers()`'s
  `evaluate`) shows what it drew.
- **The tap.** CDP has no way to click a notification. A synthetic
  `new NotificationEvent("notificationclick", { notification })` dispatched in
  the worker runs the handler; its `event.waitUntil` throws (untrusted event)
  after the argument — the real work — has started, so the work still runs.
  `clients.openWindow` and `client.focus()` need a real click, so the test
  replaces `self.clients.openWindow` (Object.defineProperty on the instance)
  to record the URL, then opens that URL itself; `focus()` failing is caught
  in sw.js on purpose.

**Trap (2026-11-25): never poll `getNotifications()` while a push may still
be showing one.** Chrome loses a notification stored while a
`getNotifications()` is in flight: overlapping the two calls in one worker
lost 100 of 100 (one after the other, none). The test polled straight after
`deliverPushMessage`, so a slow push (CI, a loaded machine) drew its
notification during a poll and it was gone: `push → a notification … — []`
and then `{"opened":null,"left":0}` on the tap. test-push now counts the
worker's settled `showNotification` calls (a wrapper on the prototype) and
reads `getNotifications()` once after. sw.js never calls `getNotifications()`,
so the arcade itself is not exposed.

Unproven by any test, so check on a real phone after a deploy: a real FCM /
autopush / Apple subscription and delivery, the OS notification itself, and
a real tap focusing or opening the app (iOS only from the Home Screen).

Also: a page's `?invite=` URL opened by the worker has no `?rs=`, so in a
test add `&rs=` or the page asks the deployed room server.
