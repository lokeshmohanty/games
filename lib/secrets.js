// lib/secrets.js — private state and commit-reveal, for games with hidden
// information.
//
// Every game in this arcade is host-authoritative: one browser owns the board
// and everybody else renders what it says. That works perfectly while all the
// information is public, and breaks in two different ways the moment it is not.
//
//   1. **Other players can read a "private" message.** `makeAction().send(data,
//      { target })` is addressed, but it is not sealed. When the sender has no
//      direct link to the target — which is exactly what this project's no-TURN
//      trade-off makes routine — `net.js` relays the envelope through whoever
//      *can* reach them, and a relay is another player's browser. Your hand goes
//      through the hands of the people you are hiding it from.
//
//   2. **The host can read everything.** It is a player too. If the host deals
//      the cards, the host knows the cards; if the host stores your fleet's
//      positions so it can adjudicate shots, the host knows where your fleet is.
//      No amount of addressing fixes this, because the host is a legitimate
//      recipient of state it is refereeing.
//
// The two problems want different answers, so this file has two halves.
//
//   `channel(name)`  end-to-end encryption over the existing addressed send.
//                    Fixes (1): a relay forwards ciphertext it cannot open.
//   `commit(value)`  a hash you publish now and open later. Fixes (2): nobody,
//                    the host included, learns your secret until you reveal it,
//                    and everyone can then check you did not change it.
//
// Both rest on WebCrypto, which needs a secure context. `file://` **is** one in
// Chrome and Firefox, so the project's file:// habit is safe here — but the
// check is made at runtime rather than assumed, and a browser without it gets
// an explicit refusal instead of silent plaintext. See `privacy()`.
//
// Loaded as a traditional script so it works on file:// like everything else.

window.NeonArcade = window.NeonArcade || {};

(() => {
	const subtle = globalThis.crypto?.subtle ?? null;

	// How long a send will wait for a recipient's public key before giving up.
	// A key rides the party record, so it arrives on the same replication as a
	// name change: fast, but not instant for someone who joined a moment ago.
	const KEY_WAIT_MS = 3000;

	// ------------------------------------------------------------ encoding

	const utf8 = new TextEncoder();
	const fromUtf8 = new TextDecoder();

	const b64 = (buf) => {
		const bytes = new Uint8Array(buf);
		let s = "";
		for (const byte of bytes) s += String.fromCharCode(byte);
		return btoa(s);
	};

	const unb64 = (str) => {
		const bin = atob(str);
		const out = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
		return out;
	};

	/**
	 * JSON with object keys in sorted order, at every depth.
	 *
	 * A commitment is a hash of *bytes*, and `JSON.stringify` does not promise
	 * the same bytes twice: it preserves insertion order, so a value that has
	 * been through a network round-trip can serialise differently from the one
	 * that was hashed. That is a verification failure with no bug behind it and
	 * nothing to see in the diff, so the hash is taken over a canonical form.
	 */
	const canon = (value) => {
		if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
		if (Array.isArray(value)) return "[" + value.map(canon).join(",") + "]";
		const keys = Object.keys(value).sort();
		return "{" + keys.map((k) => JSON.stringify(k) + ":" + canon(value[k])).join(",") + "}";
	};

	NeonArcade._canon = canon;

	// ------------------------------------------------------------ the thing

	/**
	 * Build the secrets helper for a room. One per mounted game; call
	 * `dispose()` in the game's `unmount`.
	 *
	 * @param {object} room  the Room from net.js
	 * @param {object} [opts]
	 * @param {(err: {peerId: string, reason: string}) => void} [opts.onError]
	 *        called when a sealed send cannot be completed — a recipient whose
	 *        key never arrived, or a message that would not open. Games should
	 *        show this rather than wait: a hand that never appears looks exactly
	 *        like a slow network, and this project's rule is that a failure
	 *        surfaces as an error instead of an indefinite wait.
	 */
	NeonArcade.makeSecrets = (room, opts = {}) => {
		const channels = new Map();
		const derived = new Map(); // peerId -> { pk, key }
		let ownKeys = null;
		let readyPromise = null;
		let disposed = false;

		const fail = (peerId, reason) => {
			opts.onError?.({ peerId, reason });
			return false;
		};

		// -- identity ------------------------------------------------------

		/**
		 * Generate this browser's key pair and publish the public half on the
		 * party record.
		 *
		 * The record is the right carrier rather than a broadcast of our own:
		 * it already replicates to late joiners wholesale, so somebody who
		 * arrives in the middle of a hand learns every key that was published
		 * before they existed, with no re-announcement protocol to get wrong.
		 */
		const init = async () => {
			if (!subtle) return null;
			const pair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
				"deriveKey",
			]);
			const raw = await subtle.exportKey("raw", pair.publicKey);
			ownKeys = pair;
			room.setMeta?.({ pk: b64(raw) });
			return pair;
		};

		const ready = () => {
			readyPromise ??= init();
			return readyPromise;
		};

		/** Wait for a member's published key, up to KEY_WAIT_MS. */
		const keyOf = (peerId) =>
			new Promise((resolve) => {
				const now = room.getMember(peerId)?.pk;
				if (now) return resolve(now);
				const started = Date.now();
				const tick = setInterval(() => {
					if (disposed) {
						clearInterval(tick);
						return resolve(null);
					}
					const pk = room.getMember(peerId)?.pk;
					if (pk) {
						clearInterval(tick);
						resolve(pk);
					} else if (Date.now() - started > KEY_WAIT_MS) {
						clearInterval(tick);
						resolve(null);
					}
				}, 120);
			});

		/** The AES key shared with one peer, derived once and cached. */
		const sharedKey = async (peerId) => {
			const pk = await keyOf(peerId);
			if (!pk) return null;
			const cached = derived.get(peerId);
			// Keyed by the public key, not just the id: a peer that reloads and
			// rejoins under the same id brings a new key with it, and a stale
			// cache entry would encrypt to a browser that no longer exists.
			if (cached && cached.pk === pk) return cached.key;
			const theirs = await subtle.importKey(
				"raw",
				unb64(pk),
				{ name: "ECDH", namedCurve: "P-256" },
				false,
				[],
			);
			const key = await subtle.deriveKey(
				{ name: "ECDH", public: theirs },
				(await ready()).privateKey,
				{ name: "AES-GCM", length: 256 },
				false,
				["encrypt", "decrypt"],
			);
			derived.set(peerId, { pk, key });
			return key;
		};

		// -- sealed channels -----------------------------------------------

		/**
		 * A private channel. `send(to, data)` reaches exactly one member;
		 * `onMessage(data, { from, to })` fires on arrival.
		 *
		 * `to` is on the receive side for one reason: bots. A bot has no browser
		 * and no key, so a private message addressed to one is delivered to the
		 * host — the browser that plays it — with `to` naming the bot. A game's
		 * bot brain therefore reads its private state through the same handler a
		 * person's does, which is the same trick `emitAs` plays for public moves.
		 */
		const channel = (name) => {
			const existing = channels.get(name);
			if (existing) return existing;

			const action = room.makeAction("s$" + name);
			const chan = {
				onMessage: null,
				async send(to, data) {
					if (disposed) return false;
					// A bot is played by the host, so its secrets never leave this
					// browser. Nothing to encrypt and nothing to route.
					if (NeonArcade.isBotId(to)) {
						if (!room.isHost()) return fail(to, "only the host plays bots");
						chan.onMessage?.(data, { from: room.selfId, to });
						return true;
					}
					if (!subtle) {
						// Refuse rather than quietly downgrade. A game that shows a
						// hand it believes is private, over a link that is not, is
						// worse than a game that says it cannot deal.
						return fail(to, "this browser has no WebCrypto; private play is unavailable");
					}
					const key = await sharedKey(to);
					if (!key) return fail(to, "no key published for that player yet");
					const iv = crypto.getRandomValues(new Uint8Array(12));
					// The recipient and the channel are authenticated, not just the
					// payload: without them a relay could replay somebody's sealed
					// hand back into a different channel, and the tag would still
					// check out.
					const aad = utf8.encode(`${name}|${room.selfId}|${to}`);
					const ct = await subtle.encrypt(
						{ name: "AES-GCM", iv, additionalData: aad },
						key,
						utf8.encode(canon(data)),
					);
					action.send({ n: b64(iv), c: b64(ct) }, { target: to });
					return true;
				},
			};

			action.onMessage = async (env, { peerId }) => {
				if (disposed || !env?.c) return;
				if (!subtle) return fail(peerId, "this browser has no WebCrypto");
				const key = await sharedKey(peerId);
				if (!key) return fail(peerId, "no key published by the sender");
				try {
					const aad = utf8.encode(`${name}|${peerId}|${room.selfId}`);
					const plain = await subtle.decrypt(
						{ name: "AES-GCM", iv: unb64(env.n), additionalData: aad },
						key,
						unb64(env.c),
					);
					chan.onMessage?.(JSON.parse(fromUtf8.decode(plain)), {
						from: peerId,
						to: room.selfId,
					});
				} catch {
					// Authentication failed: the message was altered, replayed from
					// another channel, or meant for somebody else. Never a reason to
					// fall back to reading it anyway.
					fail(peerId, "a private message did not open — it was altered or misaddressed");
				}
			};

			channels.set(name, chan);
			return chan;
		};

		// -- commit and reveal ---------------------------------------------

		/**
		 * Commit to a value without disclosing it.
		 *
		 * Publish `digest` now; publish `{ value, nonce }` later and let everyone
		 * run `verify`. The nonce is what makes it a commitment rather than a
		 * lookup table — without it, "which of the ten ships did you place" is
		 * ten hashes away from being read straight off the wire.
		 */
		const commit = async (value) => {
			if (!subtle) throw new Error("commit needs WebCrypto, which this browser has not got");
			const nonce = b64(crypto.getRandomValues(new Uint8Array(16)));
			return { digest: await digestOf(nonce, value), nonce, value };
		};

		const digestOf = async (nonce, value) =>
			b64(await subtle.digest("SHA-256", utf8.encode(`${nonce}|${canon(value)}`)));

		/** Does this opened commitment match the digest that was published? */
		const verify = async ({ digest, value, nonce }) => {
			if (!subtle || !digest || !nonce) return false;
			return (await digestOf(nonce, value)) === digest;
		};

		return {
			ready,
			channel,
			commit,
			verify,
			/**
			 * "sealed" when private sends are encrypted end to end, "plain" when
			 * this browser cannot do that at all. A game with hidden information
			 * should check this before it starts and say so, rather than dealing
			 * a hand it cannot keep.
			 */
			privacy: () => (subtle ? "sealed" : "plain"),
			/** Have we got what we need to send this player something private? */
			canReach: async (peerId) =>
				NeonArcade.isBotId(peerId) ? room.isHost() : !!(await keyOf(peerId)),
			dispose() {
				disposed = true;
				for (const [name] of channels) room.makeAction("s$" + name).onMessage = null;
				channels.clear();
				derived.clear();
			},
		};
	};
})();
