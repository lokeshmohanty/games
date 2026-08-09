// lib/net.js — P2P networking core for serverless multiplayer games.
//
// There is no signaling server and no third-party relay. Two browsers cannot
// discover each other on their own, so the *players* carry the handshake: the
// host produces an invite (a link containing a compressed WebRTC offer), the
// guest opens it and produces a short answer code, and the host pastes that
// back. After that every byte flows directly peer-to-peer over an encrypted
// RTCDataChannel. The only outside contact is STUN, which learns a public
// IP:port and never sees game data.
//
// Topology is a star, not a mesh: the host holds one connection per guest and
// relays guest->guest traffic. A mesh would need a manual handshake for every
// pair (O(n^2) copy-pastes); the star needs one per guest. The host is
// therefore permanent — whoever created the room — which also removes the
// re-election churn the old relay-based build had.
//
// Loaded as a traditional script (not an ES module) so it works on file://
// without a local server, and has no external dependencies at all.

window.NeonArcade = window.NeonArcade || {};

(() => {
	// STUN only. No TURN: a TURN server would have to be operated by someone,
	// which is exactly the dependency this design removes. The cost is that a
	// minority of network pairs (symmetric NAT, some mobile carriers) cannot
	// establish a direct path; those surface as an explicit connection error
	// rather than an indefinite wait. Pass `iceServers` to override.
	const DEFAULT_ICE = [
		{ urls: "stun:stun.cloudflare.com:3478" },
		{ urls: "stun:stun.l.google.com:19302" },
	];

	// Give up gathering after this long. Some STUN servers simply never answer,
	// and waiting for `complete` forever is the failure mode we are removing.
	const ICE_TIMEOUT_MS = 4000;
	// Data channel payload ceiling. The negotiated max-message-size is 256 KB,
	// but 16 KB is the size every browser agrees on, so chunk above that.
	const CHUNK_BYTES = 12000;
	// Stop writing when this much is already queued in the channel, and resume
	// on `bufferedamountlow`. Neon Survival broadcasts a position every frame;
	// without this the channel grows without bound on a slow link.
	const MAX_BUFFERED = 1 << 20;

	const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
	const randId = (n = 12) =>
		[...crypto.getRandomValues(new Uint8Array(n))]
			.map((b) => ALPHABET[b % 36])
			.join("");

	// ---------------------------------------------------------------- encoding

	const toB64 = (bytes) => {
		let s = "";
		for (const b of bytes) s += String.fromCharCode(b);
		return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	};

	const fromB64 = (str) => {
		const norm = str.replace(/-/g, "+").replace(/_/g, "/");
		const bin = atob(norm + "=".repeat((4 - (norm.length % 4)) % 4));
		const out = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
		return out;
	};

	async function deflate(str) {
		const cs = new CompressionStream("deflate-raw");
		const w = cs.writable.getWriter();
		w.write(new TextEncoder().encode(str));
		w.close();
		return new Uint8Array(await new Response(cs.readable).arrayBuffer());
	}

	async function inflate(bytes) {
		const ds = new DecompressionStream("deflate-raw");
		const w = ds.writable.getWriter();
		w.write(bytes);
		w.close();
		return await new Response(ds.readable).text();
	}

	/**
	 * A data-channel SDP is almost entirely boilerplate; only the ICE
	 * credentials, the DTLS fingerprint, the setup role and the candidates
	 * actually differ. Sending just those cuts the invite from ~760 to ~420
	 * characters, which is the difference between a QR code that scans off a
	 * screen and one that does not. `rebuildSdp` reconstitutes the rest.
	 *
	 * If an SDP ever fails to match this shape we fall back to shipping it
	 * whole (tag "f"), so an unfamiliar browser degrades to a longer code
	 * rather than a broken handshake.
	 */
	function compactSdp(sdp) {
		const one = (re) => (sdp.match(re) ?? [])[1];
		const ufrag = one(/^a=ice-ufrag:(.+)$/m);
		const pwd = one(/^a=ice-pwd:(.+)$/m);
		const fp = one(/^a=fingerprint:sha-256 (.+)$/m);
		const setup = one(/^a=setup:(.+)$/m);
		if (!ufrag || !pwd || !fp || !setup) return null;

		const cands = [...sdp.matchAll(/^a=candidate:(.+)$/gm)].map((m) => {
			const parts = m[1].trim().split(/\s+/);
			const [foundation, component, proto, priority, ip, port] = parts;
			const typeAt = parts.indexOf("typ");
			if (typeAt < 0) return null;
			const type = parts[typeAt + 1];
			// Keep whatever follows `typ <type>` (raddr/rport, tcptype) but drop
			// the parts every browser regenerates or ignores.
			const tail = parts
				.slice(typeAt + 2)
				.join(" ")
				.replace(/\s*generation \d+/, "")
				.replace(/\s*network-cost \d+/, "")
				.replace(/\s*network-id \d+/, "")
				.trim();
			return [foundation, component, proto, priority, ip, port, type, tail].join("\t");
		});
		if (cands.some((c) => c === null)) return null;

		return {
			u: ufrag,
			p: pwd,
			f: fp.replace(/:/g, ""),
			s: setup,
			// The SCTP max message size is negotiated; carry it only when it is
			// not the value we rebuild with.
			m: one(/^a=max-message-size:(\d+)$/m),
			c: cands,
		};
	}

	function rebuildSdp(c) {
		const fp = (c.f.match(/.{2}/g) ?? []).join(":");
		const lines = [
			"v=0",
			"o=- 1 2 IN IP4 127.0.0.1",
			"s=-",
			"t=0 0",
			"a=group:BUNDLE 0",
			"a=extmap-allow-mixed",
			"a=msid-semantic: WMS",
			"m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
			"c=IN IP4 0.0.0.0",
			"a=ice-ufrag:" + c.u,
			"a=ice-pwd:" + c.p,
			"a=ice-options:trickle",
			"a=fingerprint:sha-256 " + fp,
			"a=setup:" + c.s,
			"a=mid:0",
			"a=sctp-port:5000",
			"a=max-message-size:" + (c.m || 262144),
		];
		for (const raw of c.c) {
			const [foundation, component, proto, priority, ip, port, type, tail] =
				raw.split("\t");
			lines.push(
				`a=candidate:${foundation} ${component} ${proto} ${priority} ${ip} ${port} typ ${type}` +
					(tail ? " " + tail : ""),
			);
		}
		return lines.join("\r\n") + "\r\n";
	}

	/** Encode a handshake payload into a URL-safe code. */
	async function packSignal(obj, sdp) {
		const compact = compactSdp(sdp);
		const body = compact
			? { ...obj, k: "c", d: compact }
			: { ...obj, k: "f", d: sdp };
		return toB64(await deflate(JSON.stringify(body)));
	}

	/** Decode a handshake code back into `{ slot, peerId, sdp }`. */
	async function unpackSignal(code) {
		const clean = code.trim().replace(/^.*#i=/, "").replace(/\s+/g, "");
		const obj = JSON.parse(await inflate(fromB64(clean)));
		return {
			slot: obj.s,
			peerId: obj.i,
			sdp: obj.k === "c" ? rebuildSdp(obj.d) : obj.d,
		};
	}

	// ------------------------------------------------------------------- room

	/** Resolve once ICE gathering finishes, or when the budget runs out. */
	function gatherIce(pc) {
		if (pc.iceGatheringState === "complete") return Promise.resolve();
		return new Promise((resolve) => {
			const finish = () => {
				clearTimeout(timer);
				pc.removeEventListener("icegatheringstatechange", check);
				resolve();
			};
			const check = () => pc.iceGatheringState === "complete" && finish();
			const timer = setTimeout(finish, ICE_TIMEOUT_MS);
			pc.addEventListener("icegatheringstatechange", check);
		});
	}

	/**
	 * One peer-to-peer link. Owns the connection, the send queue and the
	 * reassembly buffer for chunked messages.
	 */
	class Link {
		constructor(room, pc, slot) {
			this.room = room;
			this.pc = pc;
			this.slot = slot;
			this.peerId = null;
			this.dc = null;
			this.queue = [];
			this.chunks = new Map();
			this.open = false;
		}

		attach(dc) {
			this.dc = dc;
			dc.bufferedAmountLowThreshold = MAX_BUFFERED / 2;
			dc.onbufferedamountlow = () => this.flush();
			dc.onopen = () => {
				this.open = true;
				this.flush();
				this.room._linkOpened(this);
			};
			dc.onclose = () => this.room._linkClosed(this);
			dc.onmessage = (e) => this.receive(e.data);
		}

		flush() {
			while (this.queue.length && this.dc?.readyState === "open") {
				if (this.dc.bufferedAmount > MAX_BUFFERED) return;
				this.dc.send(this.queue.shift());
			}
		}

		post(str) {
			this.queue.push(str);
			if (this.open) this.flush();
		}

		/** Split oversized payloads; the far side reassembles in `receive`. */
		send(envelope) {
			const str = JSON.stringify(envelope);
			if (str.length <= CHUNK_BYTES) return this.post(str);
			const id = randId(6);
			const total = Math.ceil(str.length / CHUNK_BYTES);
			for (let i = 0; i < total; i++) {
				this.post(
					JSON.stringify({
						__c: id,
						i,
						n: total,
						p: str.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES),
					}),
				);
			}
		}

		receive(raw) {
			let msg;
			try {
				msg = JSON.parse(raw);
			} catch {
				return;
			}
			if (msg.__c) {
				const parts = this.chunks.get(msg.__c) ?? new Array(msg.n);
				parts[msg.i] = msg.p;
				this.chunks.set(msg.__c, parts);
				if (parts.filter((p) => p !== undefined).length < msg.n) return;
				this.chunks.delete(msg.__c);
				try {
					msg = JSON.parse(parts.join(""));
				} catch {
					return;
				}
			}
			this.room._inbound(this, msg);
		}

		close() {
			try {
				this.dc?.close();
			} catch {}
			try {
				this.pc.close();
			} catch {}
		}
	}

	class Room {
		constructor({ isHost, iceServers, onPeerJoin, onPeerLeave, onOpen, onError }) {
			this.selfId = randId(10);
			this._isHost = isHost;
			this._hostId = isHost ? this.selfId : null;
			this.iceServers = iceServers ?? DEFAULT_ICE;
			this.onPeerJoin = onPeerJoin;
			this.onPeerLeave = onPeerLeave;
			this.onOpen = onOpen;
			this.onError = onError;
			this.links = new Map(); // peerId -> Link
			this.pending = new Map(); // slot   -> Link (awaiting an answer)
			this.actions = new Map(); // name   -> { onMessage }
			this.roster = new Set([this.selfId]);
			this.inbox = []; // held until resume()
			this.running = false;
		}

		// -- public API ---------------------------------------------------

		getPeers() {
			return [...this.roster].filter((id) => id !== this.selfId);
		}
		peerCount() {
			return this.roster.size - 1;
		}
		isHost() {
			return this._isHost;
		}
		hostId() {
			return this._hostId;
		}

		/**
		 * Typed message channel. Mirrors the previous API exactly:
		 * `send(data, { target })` and an assignable `onMessage(data, { peerId })`.
		 * Calling it twice with the same name returns the same channel.
		 */
		makeAction(name) {
			let action = this.actions.get(name);
			if (action) return action;
			const room = this;
			action = {
				onMessage: null,
				send(data, opts) {
					room._route(
						{ a: name, d: data, f: room.selfId, t: opts?.target ?? null },
						null,
					);
				},
			};
			this.actions.set(name, action);
			return action;
		}

		/** Begin delivering messages. Called after the game registers actions. */
		resume() {
			this.running = true;
			const held = this.inbox;
			this.inbox = [];
			for (const [link, msg] of held) this._inbound(link, msg);
		}

		leave() {
			for (const link of this.links.values()) link.close();
			for (const link of this.pending.values()) link.close();
			this.links.clear();
			this.pending.clear();
		}

		// -- signaling ----------------------------------------------------

		/**
		 * Host side. Mint an invite for one guest. Each guest needs its own
		 * offer, so this may be called repeatedly; `slot` ties the answer that
		 * comes back to the right pending connection.
		 */
		async createInvite() {
			if (!this._isHost) throw new Error("only the host can create invites");
			const slot = randId(4);
			const pc = new RTCPeerConnection({ iceServers: this.iceServers });
			const link = new Link(this, pc, slot);
			link.attach(pc.createDataChannel("game", { ordered: true }));
			this._watch(link);

			await pc.setLocalDescription(await pc.createOffer());
			await gatherIce(pc);
			this.pending.set(slot, link);

			const code = await packSignal(
				{ s: slot, i: this.selfId },
				pc.localDescription.sdp,
			);
			const base = location.href.split("#")[0];
			return { code, link: `${base}#i=${code}` };
		}

		/** Host side. Consume the answer code the guest sent back. */
		async acceptAnswer(answerCode) {
			const { slot, peerId, sdp } = await unpackSignal(answerCode);
			const link = this.pending.get(slot);
			if (!link) {
				throw new Error(
					"That code does not match an open invite. Create a new invite and try again.",
				);
			}
			if (this.links.has(peerId)) throw new Error("That player is already connected.");
			this.pending.delete(slot);
			link.peerId = peerId;
			await link.pc.setRemoteDescription({ type: "answer", sdp });
		}

		/**
		 * Guest side. Consume the host's invite and produce the answer code the
		 * host must paste back.
		 */
		async answerInvite(inviteCode) {
			const { slot, peerId: hostId, sdp } = await unpackSignal(inviteCode);
			const pc = new RTCPeerConnection({ iceServers: this.iceServers });
			const link = new Link(this, pc, slot);
			link.peerId = hostId;
			this._hostId = hostId;
			pc.ondatachannel = (e) => link.attach(e.channel);
			this._watch(link);

			await pc.setRemoteDescription({ type: "offer", sdp });
			await pc.setLocalDescription(await pc.createAnswer());
			await gatherIce(pc);

			return await packSignal({ s: slot, i: this.selfId }, pc.localDescription.sdp);
		}

		/** Report a dead connection instead of waiting on it forever. */
		_watch(link) {
			link.pc.onconnectionstatechange = () => {
				const s = link.pc.connectionState;
				if (s === "failed") {
					this.onError?.(
						"Could not establish a direct connection. This network blocks peer-to-peer traffic; try a different network or hotspot.",
					);
					this._linkClosed(link);
				} else if (s === "disconnected" || s === "closed") {
					this._linkClosed(link);
				}
			};
		}

		// -- membership ---------------------------------------------------

		_linkOpened(link) {
			if (!link.peerId) return;
			this.links.set(link.peerId, link);
			if (this._isHost) {
				this.roster.add(link.peerId);
				this._broadcastRoster();
				this._emitJoin(link.peerId);
			}
			// A guest waits for the roster before announcing anyone, so that
			// getPeers() is already correct when onPeerJoin fires.
			this.onOpen?.(link.peerId);
		}

		_linkClosed(link) {
			if (!link.peerId || !this.links.has(link.peerId)) return;
			this.links.delete(link.peerId);
			link.close();
			if (this._isHost) {
				this.roster.delete(link.peerId);
				this._broadcastRoster();
				this._emitLeave(link.peerId);
			} else {
				// Losing the host ends the session; there is nothing to relay through.
				const gone = [...this.roster].filter((id) => id !== this.selfId);
				this.roster = new Set([this.selfId]);
				for (const id of gone) this._emitLeave(id);
				this.onError?.("Disconnected from the host.");
			}
		}

		_broadcastRoster() {
			const ids = [...this.roster];
			for (const link of this.links.values()) link.send({ __r: ids });
		}

		_applyRoster(ids) {
			const next = new Set(ids);
			next.add(this.selfId);
			for (const id of next) {
				if (!this.roster.has(id)) {
					this.roster.add(id);
					this._emitJoin(id);
				}
			}
			for (const id of [...this.roster]) {
				if (!next.has(id)) {
					this.roster.delete(id);
					this._emitLeave(id);
				}
			}
		}

		_emitJoin(id) {
			if (id !== this.selfId) this.onPeerJoin?.(id);
		}
		_emitLeave(id) {
			if (id !== this.selfId) this.onPeerLeave?.(id);
		}

		// -- routing ------------------------------------------------------

		/**
		 * Deliver an envelope. The host is the hub: anything it receives that is
		 * not addressed to it gets forwarded, which is how two guests talk.
		 * `from` is the link a message arrived on, or null when we originated it.
		 */
		_route(env, from) {
			if (this._isHost) {
				if (env.t === null) {
					// Broadcast: everyone except the sender and ourselves.
					for (const [id, link] of this.links) {
						if (id !== env.f) link.send(env);
					}
					if (env.f !== this.selfId) this._deliver(env);
				} else if (env.t === this.selfId) {
					this._deliver(env);
				} else {
					this.links.get(env.t)?.send(env);
				}
			} else {
				// Guests own exactly one link — the host — and it does the rest.
				if (from) this._deliver(env);
				else this.links.get(this._hostId)?.send(env);
			}
		}

		_deliver(env) {
			const action = this.actions.get(env.a);
			action?.onMessage?.(env.d, { peerId: env.f });
		}

		_inbound(link, msg) {
			if (msg.__r) return this._applyRoster(msg.__r);
			if (!this.running) {
				this.inbox.push([link, msg]);
				return;
			}
			this._route(msg, link);
		}
	}

	// ------------------------------------------------------------------ entry

	/** True when this page was opened from an invite link. */
	NeonArcade.inviteFromUrl = () => {
		const m = location.hash.match(/[#&]i=([^&]+)/);
		return m ? m[1] : null;
	};

	/**
	 * Restart this page as a host. A guest reached the page through an `#i=`
	 * invite, so the fragment has to go before reloading — otherwise the lobby
	 * would just try to answer the same (now dead) invite again.
	 *
	 * Used to offer guests a way out of "waiting for the host" states: whoever
	 * is still around can start a new game instead of everyone being stuck
	 * behind a host who left.
	 */
	NeonArcade.hostNewGame = () => {
		history.replaceState(null, "", location.pathname + location.search);
		location.reload();
	};

	/** Create a room you host. Returns the room plus `createInvite`/`acceptAnswer`. */
	NeonArcade.createHost = (opts = {}) => new Room({ ...opts, isHost: true });

	/** Create a room you join. Feed it the invite code via `answerInvite`. */
	NeonArcade.createGuest = (opts = {}) => new Room({ ...opts, isHost: false });

	// Exposed for tests.
	NeonArcade._codec = { packSignal, unpackSignal, compactSdp, rebuildSdp };
})();
