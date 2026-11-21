// lib/push.js — party invites as notifications when the arcade is closed
// (Web Push; Lokesh, 2026-11-15 and 2026-11-18). Opt-in, per device, party
// invites only. The server side is worker/api/push.js; the notification and
// its tap are sw.js; docs/accounts.md "Party invites by notification".
//
//   offer    a small card, once per device, the first time the signed-in
//            player has a friend: "Get party invites when the arcade is
//            closed?" TURN ON / NOT NOW. Either answer is final on this
//            device (localStorage "neon.push.offer"); the profile's toggle
//            is always there.
//   on       the browser's permission is asked only on TURN ON (or the
//            toggle), then the page subscribes with the server's VAPID key
//            and hands the subscription to the server. localStorage
//            "neon.push" = "on" remembers this device's choice.
//   off      the server forgets this device and the browser unsubscribes.
//            Signing out or deleting the account does the same first.
//   refresh  while on, a page tells the server again once a day (or when the
//            browser rotated the subscription), so the device keeps its place
//            under the server's cap and a lost subscription is remade.
//
// Inert without a secure context, a service worker or the Push API (iOS
// Safari outside the Home Screen has none): no card, and the toggle says why.

window.NeonArcade = window.NeonArcade || {};

(() => {
	const A = () => NeonArcade.account;
	const PREF = "neon.push";
	const OFFER = "neon.push.offer";
	// Set when a session that ended elsewhere turned this device off: the offer
	// comes back once, after signing in again (review, 2026-11-21).
	const REOFFER = "neon.push.reoffer";
	const SENT = "neon.push.sent"; // `${time} ${account} ${endpoint}`: last told to the server
	const REFRESH_MS = 86_400_000;

	const read = (k) => {
		try {
			return localStorage.getItem(k);
		} catch {
			return null;
		}
	};
	const write = (k, v) => {
		try {
			if (v == null) localStorage.removeItem(k);
			else localStorage.setItem(k, v);
		} catch {}
	};

	const supported = () => !!(window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window);
	const iOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

	let key = null; // the server's VAPID public key
	let keyNone = false; // the server answered: it has none (not set up)
	let keyLoad = null;
	/** The key; null when the server has none or could not be asked (keyNone tells which). */
	function serverKey() {
		if (key) return Promise.resolve(key);
		keyLoad ??= A()
			.api("/api/push", { auth: false })
			.then((r) => {
				key = r.key ?? null;
				keyNone = !key;
				return key;
			})
			// A server from before /api/push answers 404: none there either.
			.catch((err) => ((keyNone = err.status === 404), null))
			.finally(() => (keyLoad = null));
		return keyLoad;
	}
	const bytes = (b64) => Uint8Array.from(atob(b64.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64.length + 3) % 4)), (c) => c.charCodeAt(0));
	const sameKey = (sub, k) => {
		const have = sub.options?.applicationServerKey;
		if (!have) return true; // not exposed: assume it is ours
		const a = new Uint8Array(have);
		const b = bytes(k);
		return a.length === b.length && a.every((x, i) => x === b[i]);
	};

	/** The worker's registration, or null if none comes (lib/pwa.js registers it after load). */
	const registration = () => Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(() => r(null), 10_000))]);

	const listeners = new Set();
	const changed = () => listeners.forEach((fn) => fn());

	/**
	 * This device's state: "on", "off", "denied" (blocked in the browser),
	 * "unsupported" (no Push API here) or "unavailable" (the server has no
	 * key). A server that cannot be reached now changes nothing: the device's
	 * own choice is shown (switching then says what went wrong).
	 */
	async function state() {
		if (!supported()) return "unsupported";
		if (Notification.permission === "denied") return "denied";
		if (!(await serverKey()) && keyNone) return "unavailable";
		return read(PREF) === "on" && Notification.permission === "granted" ? "on" : "off";
	}

	async function tell(sub) {
		const json = sub.toJSON();
		await A().api("/api/push", { method: "POST", body: { endpoint: json.endpoint, keys: json.keys } });
		write(SENT, `${Date.now()} ${A()?.me?.id ?? "-"} ${json.endpoint}`);
	}
	/** Forget `sub` on the server (no sign-in needed: its endpoint is the proof), then unsubscribe it. */
	async function drop(sub, server = true) {
		if (server) await A().api("/api/push", { method: "DELETE", body: { endpoint: sub.endpoint }, auth: !!A()?.signedIn() }).catch(() => {});
		await sub.unsubscribe().catch(() => {});
	}

	/** TURN ON: the permission (asked only here), a subscription, the server told. */
	async function enable() {
		if (!supported()) throw new Error(iOS() ? "On iPhone and iPad: add the arcade to the Home Screen first, then turn this on there." : "This browser cannot show notifications from a web page.");
		// First, while the tap still counts as one: browsers refuse the prompt later.
		const permission = await Notification.requestPermission();
		if (permission !== "granted") {
			throw new Error(permission === "denied" ? "Notifications are blocked for this site. Allow them in the browser's site settings, then try again." : "Not turned on: the browser was not given permission.");
		}
		const k = await serverKey();
		if (!k) throw new Error("Invites by notification are not set up on the server yet.");
		const reg = await registration();
		if (!reg) throw new Error("The arcade's service worker is not running here, so it cannot show notifications.");
		let sub = await reg.pushManager.getSubscription();
		if (sub && !sameKey(sub, k)) {
			await drop(sub); // made with an older key: its row goes too
			sub = null;
		}
		sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(k) });
		await tell(sub);
		write(PREF, "on");
		changed();
	}

	/** Off on this device: the server forgets it (unless `server` is false), then the browser unsubscribes. */
	async function disable(server = true) {
		write(PREF, null);
		write(SENT, null);
		if (supported()) {
			const reg = await registration();
			const sub = await reg?.pushManager.getSubscription().catch(() => null);
			// Offline, the row stays until the push service answers 410 to it.
			if (sub) await drop(sub, server);
		}
		changed();
	}

	/**
	 * While on: tell the server again once a day, when the subscription
	 * changed or was lost, or when another account is signed in here now.
	 */
	async function refresh() {
		if (read(PREF) !== "on" || !supported() || !A()?.me) return;
		if (Notification.permission !== "granted") return void disable();
		const k = await serverKey();
		const reg = k && (await registration());
		if (!reg) return;
		try {
			let sub = await reg.pushManager.getSubscription();
			if (sub && !sameKey(sub, k)) {
				await drop(sub); // the VAPID key changed: the old row goes, a new subscription is told
				sub = null;
			}
			sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(k) });
			const [at, account, endpoint] = (read(SENT) ?? "").split(" ");
			if (endpoint !== sub.endpoint || account !== A().me.id || Date.now() - Number(at) > REFRESH_MS) await tell(sub);
		} catch (err) {
			console.warn("push:", err.message);
		}
	}

	// ------------------------------------------------------------ the offer

	function el(tag, cls, text) {
		const n = document.createElement(tag);
		if (cls) n.className = cls;
		if (text != null) n.textContent = text;
		return n;
	}

	/** The card, once per device, the first time there is a friend. */
	async function maybeOffer() {
		const due = () => !read(OFFER) || read(REOFFER);
		if (!due() || read(PREF) === "on" || !A()?.me || !supported() || Notification.permission === "denied") return;
		const friends = await NeonArcade.accountUi?.loadFriends?.();
		if (!friends?.friends?.length || !due() || document.querySelector(".neon-push-offer")) return;
		if (!(await serverKey())) return;
		write(OFFER, "shown");
		write(REOFFER, null);
		const box = el("div", "neon-invite neon-push-offer");
		box.setAttribute("role", "dialog");
		box.setAttribute("aria-label", "Party invites");
		box.append(el("p", null, "Get party invites when the arcade is closed?"));
		const row = el("div", "neon-invite-row");
		const on = el("button", "neon-btn neon-btn--accent", "TURN ON");
		on.type = "button";
		on.onclick = async () => {
			write(OFFER, "on");
			box.remove();
			try {
				await enable();
				NeonArcade.toast?.("Party invites will show as notifications on this device.", "good");
			} catch (err) {
				NeonArcade.toast?.(err.message, "warn");
			}
		};
		const no = el("button", "neon-btn", "NOT NOW");
		no.type = "button";
		no.onclick = () => {
			// Never asked again on this device; the profile has the toggle.
			write(OFFER, "no");
			box.remove();
		};
		row.append(on, no);
		box.append(row);
		(A()?.notices?.() ?? document.body).append(box);
	}
	document.addEventListener("neon:friends", () => void maybeOffer());

	// ------------------------------------------------- the profile's toggle

	/**
	 * A per-device toggle for the profile (lib/profile.js): a switch the
	 * width of the row, so the whole row is the tap target on a phone.
	 */
	function toggle() {
		const wrap = el("div", "push-toggle");
		const box = el("button", "push-switch");
		box.type = "button";
		box.setAttribute("role", "switch");
		box.setAttribute("aria-checked", "false");
		box.dataset.setting = "push";
		box.disabled = true;
		box.append(el("span", "push-switch-track"), el("span", "push-switch-label", "Party invites on this device when the arcade is closed"));
		const note = el("p", "muted", "Friends' party invites only, as a notification — nothing else. Your browser's push service delivers it but cannot read it.");
		wrap.append(box, note);
		const paint = async () => {
			const s = await state();
			box.setAttribute("aria-checked", String(s === "on"));
			box.disabled = s === "unsupported" || s === "denied" || s === "unavailable";
			wrap.dataset.state = s;
			if (s === "unsupported") note.textContent = iOS() ? "On iPhone and iPad, add the arcade to the Home Screen and turn this on there." : "This browser cannot show notifications from a web page.";
			else if (s === "denied") note.textContent = "Notifications are blocked for this site in the browser's settings.";
			else if (s === "unavailable") note.textContent = "Not available yet.";
		};
		box.onclick = async () => {
			const want = box.getAttribute("aria-checked") !== "true";
			box.disabled = true;
			try {
				if (want) await enable();
				else await disable();
			} catch (err) {
				NeonArcade.toast?.(err.message, "warn");
			}
			await paint();
		};
		paint();
		const off = () => (wrap.isConnected ? paint() : listeners.delete(off));
		listeners.add(off);
		return wrap;
	}

	NeonArcade.push = {
		supported,
		state,
		enable,
		disable,
		toggle,
		/** Before signing out or deleting the account: this device stops getting that account's invites. */
		async forget({ server = true, expired = false } = {}) {
			const wasOn = read(PREF) === "on";
			if (wasOn || read(SENT)) await disable(server);
			// The session ended elsewhere: say so, and offer it again once signed in.
			if (expired && wasOn) {
				write(REOFFER, "1");
				NeonArcade.toast?.("Signed out, so party invites by notification are off on this device. Sign in to turn them on again.", "warn");
			}
		},
	};

	A()?.onChange((me) => {
		if (me) refresh();
	});
})();
