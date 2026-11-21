// scripts/vapid-keys.mjs — make the arcade's VAPID key pair (RFC 8292), once,
// for invites by notification (worker/api/webpush.js; docs/accounts.md
// "Party invites by notification"). Node's own WebCrypto, nothing installed.
//
//   node scripts/vapid-keys.mjs
//
// Writes the public key (base64url, the raw P-256 point: the Worker's
// VAPID_PUBLIC_KEY) to stdout and the private key (base64url, the scalar d:
// VAPID_PRIVATE_KEY) to stderr, neither with a newline, so each can be
// redirected into its own git-ignored file and from there into
// `wrangler secret put` (docs/accounts.md "Deploying invites by
// notification"). Never commit the private key.
//
// Changing the pair later turns every device's invites off until its page
// subscribes again (lib/push.js does so on its next visit, when the key differs).

import { webcrypto as crypto } from "node:crypto";

const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const pub = Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString("base64url");
const { d } = await crypto.subtle.exportKey("jwk", pair.privateKey);
process.stdout.write(pub);
process.stderr.write(d);
