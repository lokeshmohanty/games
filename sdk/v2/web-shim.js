// sdk/v2/web-shim.js — runs an ordinary web app as an arcade game (SDK v2).
//
// The v1 shim (sdk/v1/web-shim.js) spoke the v1 bridge; this one speaks the
// v2 protocol through sdk/v2/runtime.js: `asset` and `http` are requests,
// `address` a message (protocol.json). Every web app mounts on v2, whatever
// its manifest's "sdk" says (docs/sdk-v2.md, "Web apps").
//
// An author with a working web app (a Vite/React page that talks to its own
// server, say) should not have to rewrite it to join the arcade. The shell
// inlines this file after sdk/v2/runtime.js, ahead of the app's own
// scripts, when the manifest has an `app` (docs/sdk.md, "Web apps"). It makes
// the frame look like the place the app was written for:
//
//   fetch / XMLHttpRequest   a file of the app's comes from its folder; any
//                            other request goes to the app's server, which
//                            runs on the host's phone (lib/py-server.js)
//   __neon.location/history  the app's address. The arcade rewrites the
//                            app's `location` and `history` to these when it
//                            builds it, since a sandboxed srcdoc frame can
//                            change neither. The address is the party's: a
//                            pushState here moves every phone to it.
//   <img src="/x.svg">       files named by path are fetched from the folder
//   window.open("/x.html")   a page of the app's opens over it, in the frame
//
// No colours, seats, bots or results: a web app is a shared screen (`kind:
// "shared"`), every phone runs it and any phone may act.

(() => {
	const ORIGIN = "https://app.invalid";
	const boot = window.arcadeWebApp ?? { address: "/", id: "app" };
	const toServer = (u) => u.origin !== ORIGIN;
	let address = new URL(boot.address || "/", ORIGIN);

	// ---- requests ------------------------------------------------------------
	const ask = ({ t, ...fields }) => arcade.request(t, fields);
	const assetCache = new Map(); // path -> Promise<{buf, type}|null>
	const asset = (path) => {
		if (!assetCache.has(path)) {
			assetCache.set(
				path,
				ask({ t: "asset", path: path.replace(/^\//, "") }).then((m) => ({ buf: m.bytes, type: m.type }), () => null),
			);
		}
		return assetCache.get(path);
	};
	const blobUrls = new Map(); // path -> Promise<blob: URL|null>
	const blobUrl = (path) => {
		if (!blobUrls.has(path)) {
			blobUrls.set(
				path,
				asset(path).then((a) => (a ? URL.createObjectURL(new Blob([a.buf], { type: a.type })) : null)),
			);
		}
		return blobUrls.get(path);
	};
	const toBase64 = (buf) => {
		let s = "";
		const b = new Uint8Array(buf);
		for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
		return btoa(s);
	};
	const fromBase64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

	/** One request to the app's server, through the shell. */
	async function serve(url, method, headers, body) {
		const m = await ask({
			t: "http",
			method,
			path: url.pathname,
			query: url.search.slice(1),
			headers: [...headers],
			body: body ? toBase64(body) : "",
		});
		return new Response(m.status === 204 || m.status === 304 ? null : fromBase64(m.body ?? ""), {
			status: m.status,
			headers: m.headers ?? [],
		});
	}

	window.fetch = async (input, init = {}) => {
		const req = new Request(input instanceof Request ? input : new URL(String(input), address).href, init);
		const url = new URL(req.url);
		const body = req.method === "GET" || req.method === "HEAD" ? null : await req.arrayBuffer();
		if (!toServer(url) && (req.method === "GET" || req.method === "HEAD")) {
			const a = await asset(url.pathname);
			if (a) return new Response(req.method === "HEAD" ? null : a.buf.slice(0), { status: 200, headers: { "content-type": a.type } });
		}
		return serve(url, req.method, req.headers, body);
	};

	// For apps (and their libraries) that still use XMLHttpRequest: the same
	// route as fetch, behind the parts of the interface they read.
	class ArcadeXHR extends EventTarget {
		readyState = 0;
		status = 0;
		statusText = "";
		responseType = "";
		response = null;
		responseText = "";
		timeout = 0;
		withCredentials = false;
		upload = new EventTarget();
		#method = "GET";
		#url = "";
		#headers = new Headers();
		#got = new Headers();
		open(method, url) {
			this.#method = String(method).toUpperCase();
			this.#url = String(url);
			this.#set(1);
		}
		setRequestHeader(k, v) {
			this.#headers.append(k, v);
		}
		getResponseHeader(k) {
			return this.#got.get(k);
		}
		getAllResponseHeaders() {
			return [...this.#got].map(([k, v]) => `${k}: ${v}\r\n`).join("");
		}
		overrideMimeType() {}
		abort() {}
		send(body = null) {
			fetch(this.#url, { method: this.#method, headers: this.#headers, body })
				.then(async (res) => {
					this.status = res.status;
					this.statusText = res.statusText;
					this.#got = res.headers;
					const buf = await res.arrayBuffer();
					this.responseText = new TextDecoder().decode(buf);
					this.response =
						this.responseType === "arraybuffer"
							? buf
							: this.responseType === "json"
								? JSON.parse(this.responseText || "null")
								: this.responseType === "blob"
									? new Blob([buf])
									: this.responseText;
					this.#set(4);
					this.#fire("load");
				})
				.catch(() => {
					this.#set(4);
					this.#fire("error");
				})
				.finally(() => this.#fire("loadend"));
		}
		#set(state) {
			this.readyState = state;
			this.#fire("readystatechange");
		}
		#fire(type) {
			const ev = new Event(type);
			this[`on${type}`]?.(ev);
			this.dispatchEvent(ev);
		}
	}
	for (const [k, v] of Object.entries({ UNSENT: 0, OPENED: 1, HEADERS_RECEIVED: 2, LOADING: 3, DONE: 4 })) ArcadeXHR[k] = v;
	window.XMLHttpRequest = ArcadeXHR;

	// ---- the address ---------------------------------------------------------
	const stack = [{ url: address.href, state: null }];
	let at = 0;
	const moveTo = (url, { push, share = true }) => {
		const next = new URL(String(url), address);
		if (next.origin !== ORIGIN) throw new DOMException(`cannot move the app to ${next.origin}`, "SecurityError");
		address = next;
		if (share) arcade.send("address", { url: address.pathname + address.search + address.hash });
		return push;
	};
	const location = {
		get href() {
			return address.href;
		},
		set href(url) {
			this.assign(url);
		},
		get origin() {
			return ORIGIN;
		},
		get protocol() {
			return address.protocol;
		},
		get host() {
			return address.host;
		},
		get hostname() {
			return address.hostname;
		},
		get port() {
			return address.port;
		},
		get pathname() {
			return address.pathname;
		},
		set pathname(v) {
			const u = new URL(address);
			u.pathname = v;
			this.assign(u);
		},
		get search() {
			return address.search;
		},
		set search(v) {
			const u = new URL(address);
			u.search = v;
			this.assign(u);
		},
		get hash() {
			return address.hash;
		},
		set hash(v) {
			const u = new URL(address);
			u.hash = v;
			history.pushState(history.state, "", u);
			dispatchEvent(new HashChangeEvent("hashchange"));
		},
		get ancestorOrigins() {
			return [];
		},
		// A full navigation inside the app: the shell remounts every phone,
		// this one included, at the new address.
		assign(url) {
			moveTo(url, { push: true, share: false });
			arcade.send("address", { url: address.pathname + address.search + address.hash, reload: true });
		},
		replace(url) {
			this.assign(url);
		},
		reload() {
			this.assign(address.href);
		},
		toString() {
			return address.href;
		},
	};
	const history = {
		get length() {
			return stack.length;
		},
		get state() {
			return stack[at].state;
		},
		scrollRestoration: "auto",
		pushState(state, _title, url) {
			if (url != null) moveTo(url, { push: true });
			stack.splice(at + 1, Infinity, { url: address.href, state: structuredClone(state) });
			at = stack.length - 1;
		},
		replaceState(state, _title, url) {
			if (url != null) moveTo(url, { push: false });
			stack[at] = { url: address.href, state: structuredClone(state) };
		},
		go(delta = 0) {
			const to = at + delta;
			if (delta === 0) return location.reload();
			if (to < 0 || to >= stack.length) return;
			at = to;
			moveTo(stack[at].url, { push: false });
			setTimeout(() => dispatchEvent(new PopStateEvent("popstate", { state: stack[at].state })));
		},
		back() {
			this.go(-1);
		},
		forward() {
			this.go(1);
		},
	};
	window.__neon = { location, history };
	// The arcade's build rewrites the app's own `history`; an inline script it
	// did not see still reaches the real one, whose pushState would throw in
	// a srcdoc frame. Point that at the app's history too.
	for (const k of ["pushState", "replaceState", "back", "forward", "go"]) {
		History.prototype[k] = function (...args) {
			return history[k](...args);
		};
	}

	// ---- files named by path -------------------------------------------------
	// `<img src="/piece/wK.svg">` would load from nowhere (the CSP allows only
	// data: and blob:), so the path is caught as it is set — before the
	// browser starts a load it would block — and swapped for the file's blob:
	// URL. What arrives as markup (innerHTML) is caught by the observer.
	const LINKED = { IMG: "src", SOURCE: "src", VIDEO: "src", AUDIO: "src", IMAGE: "href", USE: "href" };
	const BLANK = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
	const wanted = new WeakMap(); // element -> the path it was last given
	const resolved = new Map(); // path -> blob: URL, once known
	const own = (value) => {
		if (!value || /^(data|blob|javascript|about):/i.test(value) || value.startsWith("#")) return null;
		const u = new URL(value, address);
		return toServer(u) ? null : u.pathname;
	};
	const setAttr = Element.prototype.setAttribute;
	/** The value to really set for `attr` on `el`; starts the fetch if needed. */
	const linkValue = (el, attr, value) => {
		if (LINKED[el.tagName.toUpperCase()] !== attr) return value;
		const path = own(String(value));
		if (!path) {
			wanted.delete(el);
			return value;
		}
		wanted.set(el, path);
		if (resolved.has(path)) return resolved.get(path);
		blobUrl(path).then((url) => {
			if (!url) return;
			resolved.set(path, url);
			if (wanted.get(el) === path) setAttr.call(el, attr, url);
		});
		return el.tagName.toUpperCase() === "IMG" ? BLANK : "";
	};
	Element.prototype.setAttribute = function (name, value) {
		return setAttr.call(this, name, typeof name === "string" ? linkValue(this, name.toLowerCase(), value) : value);
	};
	for (const ctor of [HTMLImageElement, HTMLSourceElement, HTMLMediaElement]) {
		const d = Object.getOwnPropertyDescriptor(ctor.prototype, "src");
		if (!d?.set) continue;
		Object.defineProperty(ctor.prototype, "src", {
			...d,
			set(value) {
				d.set.call(this, linkValue(this, "src", value));
			},
		});
	}
	const relink = (el) => {
		const attr = LINKED[el.tagName.toUpperCase()];
		if (!attr) return;
		const value = el.getAttribute(attr);
		if (own(value)) setAttr.call(el, attr, linkValue(el, attr, value));
	};
	const sweep = (node) => {
		if (node.nodeType !== 1) return;
		relink(node);
		for (const el of node.querySelectorAll("img,source,video,audio,image,use")) relink(el);
	};
	new MutationObserver((records) => {
		for (const r of records) {
			if (r.type === "attributes") relink(r.target);
			else for (const n of r.addedNodes) sweep(n);
		}
	}).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["src", "href"] });

	// ---- pages of the app's own (rules, help) --------------------------------
	window.open = (url) => {
		const path = own(String(url ?? ""));
		if (!path) return null;
		asset(path).then((a) => {
			if (!a) return;
			const veil = document.createElement("div");
			veil.style.cssText = "position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;background:Canvas;color:CanvasText";
			const close = document.createElement("button");
			close.textContent = "✕ Close";
			close.style.cssText = "align-self:flex-end;margin:8px;padding:8px 14px;font:inherit";
			close.onclick = () => veil.remove();
			const page = document.createElement("iframe");
			page.setAttribute("sandbox", "");
			page.style.cssText = "flex:1;border:0;width:100%";
			page.srcdoc = new TextDecoder().decode(a.buf);
			veil.append(close, page);
			document.body.append(veil);
		});
		return null;
	};

	// The arcade's side is the runtime's: a web app answers no takeOver (its
	// server's state lived on the old host's phone), so the runtime refuses.
})();
