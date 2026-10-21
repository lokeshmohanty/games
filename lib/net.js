// lib/net.js — P2P networking core for serverless multiplayer games.
//
// There is no signaling server and no third-party relay. Two browsers cannot
// discover each other on their own, so the *players* carry the handshake: one
// side produces an invite (a link containing a compressed WebRTC offer), the
// other opens it and produces an answer code that goes back. After that every
// byte flows directly peer-to-peer over an encrypted RTCDataChannel. The only
// outside contact is STUN, which learns a public IP:port and never sees game
// data.
//
// That manual step is only ever paid ONCE per person. Topology is a mesh, and
// the connections that already exist are used to carry the signalling for the
// connections that do not yet: when someone joins, every existing member
// negotiates with them automatically over the live data channels. The costly
// part of a mesh was never the connections, it was the O(n^2) copy-pastes —
// and relayed signalling removes exactly that.
//
// A mesh also makes the party independent of any one member. The host is a
// role recorded in the party state, not the shape of the network, so it can be
// handed over or inherited without anybody re-scanning anything.
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
	// Grace period after the candidate set looks complete enough to hand over.
	// Generous on purpose: cutting gathering short is how you ship an invite
	// that omits the one path a given pair could actually have used, and the
	// symptom of that ("this network blocks peer-to-peer traffic") looks like a
	// network problem rather than a bug.
	const ICE_SETTLE_MS = 800;
	// Data channel payload ceiling. The negotiated max-message-size is 256 KB,
	// but 16 KB is the size every browser agrees on, so chunk above that.
	const CHUNK_BYTES = 12000;
	// Stop writing when this much is already queued in the channel, and resume
	// on `bufferedamountlow`. Neon Survival broadcasts a position every frame;
	// without this the channel grows without bound on a slow link.
	const MAX_BUFFERED = 1 << 20;
	// A relayed message is forwarded at most this many times. Two hops covers
	// "A cannot reach C directly, but B can reach both", which is the only
	// shape that occurs in a party small enough to play a game together.
	const MAX_HOPS = 2;
	// Remembered message ids, so a flooded broadcast is delivered once.
	const SEEN_MAX = 512;
	// How long to wait for somebody to vouch for a peer whose direct link just
	// dropped, before treating them as having left the party.
	const DEPARTURE_GRACE_MS = 2500;
	// A member who joined through the room server keeps their seat for this
	// long after their last link drops, so a reload — the one case WebRTC
	// cannot rescue, since its credentials are per-connection — costs a
	// reconnect and nothing else. Non-room-server members keep today's
	// behaviour: gone is gone.
	const RECONNECT_GRACE_MS = 5 * 60 * 1000;
	// How many times to re-ask before accepting that a peer we cannot reach
	// directly is genuinely still being relayed to by somebody else.
	const VOUCH_RETRIES = 3;

	const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
	const randId = (n = 12) =>
		[...crypto.getRandomValues(new Uint8Array(n))]
			.map((b) => ALPHABET[b % 36])
			.join("");

	// ------------------------------------------------------------------- bots
	//
	// A bot is a party member that no browser is sitting behind. The host
	// simulates it, and every other peer sees it in the roster exactly like a
	// person: same id, same team, same seat. That is what lets a solo player get
	// a game without any of the game modules learning what a bot is — they read
	// `seats("B")[0]` and neither know nor care that nobody is holding a phone.
	//
	// The id carries the fact, rather than only the party record, because the
	// routing code below has to recognise one from an id alone: a bot has no
	// connection and never will, so the mesh must not try to open one, and a
	// broadcast must not count it as a peer somebody has to relay to.
	const RESERVED_META = new Set(["id", "name", "team", "bot", "joined", "host"]);

	const BOT_PREFIX = "bot_";
	const isBotId = (id) => typeof id === "string" && id.startsWith(BOT_PREFIX);
	NeonArcade.isBotId = isBotId;

	// Called out by name rather than "Bot 1" so a roster of three reads as three
	// characters. Cycled, then suffixed, so a party can hold more than the list.
	const BOT_NAMES = ["NOVA", "VECTOR", "GLITCH", "ECHO", "RAZOR", "ORBIT", "PIXEL"];

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
	 * Drop candidates the far side provably cannot pair with, to keep the code
	 * short — but only those.
	 *
	 * The one safe case is an ICE-TCP candidate with `tcptype active`. Active
	 * means "I will dial out"; it can only pair with a *passive* candidate, and
	 * browsers do not offer passive ones. Two browsers therefore never connect
	 * over these, and Chrome emits one per interface at the discard port.
	 *
	 * Explicitly NOT dropped: `.local` mDNS host candidates. They look useless
	 * because the name means nothing off the originating machine, but the peer
	 * resolves them over multicast DNS, and on a LAN with no route to a STUN
	 * server they are the *only* way two browsers find each other. Removing
	 * them breaks exactly the case this project cares most about — two people
	 * in the same room.
	 */
	function usefulCandidate(proto, tail) {
		return !(/^tcp$/i.test(proto) && /\btcptype active\b/.test(tail));
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

		let malformed = false;
		const cands = [];
		for (const m of sdp.matchAll(/^a=candidate:(.+)$/gm)) {
			const parts = m[1].trim().split(/\s+/);
			const [foundation, component, proto, priority, ip, port] = parts;
			const typeAt = parts.indexOf("typ");
			if (typeAt < 0) {
				malformed = true;
				break;
			}
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
			if (!usefulCandidate(proto, tail)) continue;
			cands.push([foundation, component, proto, priority, ip, port, type, tail].join("\t"));
		}
		if (malformed) return null;

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

	/** Decode a handshake code back into `{ slot, peerId, name, sdp }`. */
	async function unpackSignal(code) {
		const clean = code
			.trim()
			.replace(/^.*[#&][ia]=/, "")
			.replace(/\s+/g, "");
		const obj = JSON.parse(await inflate(fromB64(clean)));
		return {
			slot: obj.s,
			peerId: obj.i,
			name: obj.n ?? null,
			sdp: obj.k === "c" ? rebuildSdp(obj.d) : obj.d,
		};
	}

	// ------------------------------------------------------------------- room

	/**
	 * Resolve once ICE gathering finishes, once we hold enough candidates to be
	 * worth handing over, or when the budget runs out — whichever comes first.
	 *
	 * Waiting for `complete` is correct but slow: browsers keep probing long
	 * after they have produced the candidates a peer will actually use, and that
	 * delay is paid while a player stares at a blank space where the QR goes.
	 *
	 * "Enough" deliberately means BOTH a host candidate and a reflexive one, not
	 * whichever showed up first. The two cover different cases and the pair only
	 * needs one of them to match:
	 *   - host (including mDNS `.local`) is the same-LAN path, and on a network
	 *     with no route to STUN it is the only path there is;
	 *   - srflx is the public IP:port for players on different networks.
	 * Stopping as soon as one arrives ships an invite missing the other, which
	 * surfaces to the player as "this network blocks peer-to-peer traffic" —
	 * a bug wearing a network problem's clothes.
	 */
	function gatherIce(pc) {
		if (pc.iceGatheringState === "complete") return Promise.resolve();
		return new Promise((resolve) => {
			let settle = null;
			let host = false;
			let reflexive = false;
			const finish = () => {
				clearTimeout(timer);
				clearTimeout(settle);
				pc.removeEventListener("icegatheringstatechange", check);
				pc.removeEventListener("icecandidate", onCandidate);
				resolve();
			};
			const check = () => pc.iceGatheringState === "complete" && finish();
			const onCandidate = (e) => {
				const c = e.candidate?.candidate ?? "";
				if (/ typ host/.test(c)) host = true;
				// `relay` only appears if the caller supplied a TURN server.
				if (/ typ (srflx|relay)/.test(c)) reflexive = true;
				if (!host || !reflexive || settle) return;
				settle = setTimeout(finish, ICE_SETTLE_MS);
			};
			const timer = setTimeout(finish, ICE_TIMEOUT_MS);
			pc.addEventListener("icegatheringstatechange", check);
			pc.addEventListener("icecandidate", onCandidate);
		});
	}

	/**
	 * Record which candidate types a connection managed to gather.
	 *
	 * When a connection fails there is no way to tell from the outside whether
	 * the network really blocks peer-to-peer traffic or whether we simply handed
	 * over an impoverished candidate set. `pc._types` makes that answerable from
	 * a phone, which is where these failures actually happen and where a
	 * debugger is not.
	 */
	function trackCandidates(pc) {
		pc._types = new Set();
		pc.addEventListener("icecandidate", (e) => {
			const m = (e.candidate?.candidate ?? "").match(/ typ (\w+)/);
			if (m) pc._types.add(m[1]);
		});
		return pc;
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
		constructor({
			isHost,
			iceServers,
			name,
			maxMembers,
			selfId,
			reconnectGraceMs,
			onPeerJoin,
			onPeerLeave,
			onOpen,
			onError,
			onParty,
			onHostVacant,
			onEvicted,
			onPartyClosed,
			onLeave,
		}) {
			// A room may adopt an id instead of minting one: reconnecting after
			// a reload does exactly that, because the member the party record
			// remembers is the old id, and a fresh one would arrive as a
			// stranger — team lost, seat lost. A `bot_` prefix is refused, so
			// nobody can walk in wearing a bot's seat.
			this.selfId =
				typeof selfId === "string" && selfId && !isBotId(selfId) ? selfId : randId(10);
			this.iceServers = iceServers ?? DEFAULT_ICE;
			this.maxMembers = maxMembers ?? 8;
			this.reconnectGraceMs = reconnectGraceMs ?? RECONNECT_GRACE_MS;
			this.onPeerJoin = onPeerJoin;
			this.onPeerLeave = onPeerLeave;
			this.onOpen = onOpen;
			this.onError = onError;
			this.onParty = onParty;
			this.onHostVacant = onHostVacant;
			this.onEvicted = onEvicted;
			this.onPartyClosed = onPartyClosed;
			this.onLeave = onLeave;

			this.links = new Map(); // peerId -> Link (direct connections only)
			this.pending = new Map(); // slot   -> Link (awaiting an answer)
			this.actions = new Map(); // name   -> { onMessage }
			this.seen = new Set(); // recently delivered envelope ids
			this.seenQueue = [];
			this.inbox = []; // held until resume()
			this.running = false;
			this.closed = false;

			// The party is a shared record, not a network shape. `host` names the
			// member holding the crown; everything else about the topology is
			// free to change under it.
			this.party = {
				host: isHost ? this.selfId : null,
				game: null,
				members: [
					{
						id: this.selfId,
						name: name || "Player",
						team: isHost ? "A" : null,
						joined: Date.now(),
					},
				],
			};
		}

		// -- public API ---------------------------------------------------

		getPeers() {
			return this.party.members.map((m) => m.id).filter((id) => id !== this.selfId);
		}
		peerCount() {
			return this.party.members.length - 1;
		}
		isHost() {
			return this.party.host === this.selfId;
		}
		hostId() {
			return this.party.host;
		}
		/** Everyone in the party, host first, in join order. */
		getMembers() {
			return this.party.members.map((m) => ({ ...m }));
		}
		getMember(id) {
			const m = this.party.members.find((x) => x.id === id);
			return m ? { ...m } : null;
		}
		self() {
			return this.getMember(this.selfId);
		}
		/** The currently selected game module id, or null in the lobby. */
		getGame() {
			return this.party.game;
		}
		/** Peers this browser holds an actual connection to (diagnostics/UI). */
		directPeers() {
			return [...this.links.keys()];
		}

		/**
		 * Typed message channel. `send(data, { target })` and an assignable
		 * `onMessage(data, { peerId })`. Calling it twice with the same name
		 * returns the same channel.
		 */
		makeAction(name) {
			let action = this.actions.get(name);
			if (action) return action;
			const room = this;
			action = {
				onMessage: null,
				send(data, opts) {
					room._dispatch({
						a: name,
						d: data,
						f: room.selfId,
						t: opts?.target ?? null,
					});
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
			if (this.closed) return;
			this.closed = true;
			// Whoever wired this room up (the room server, most likely) learns the
			// departure here rather than having to poll — this is where the rejoin
			// token stops being valid for us.
			this.onLeave?.();
			for (const timer of this.suspects?.values() ?? []) clearTimeout(timer);
			this.suspects?.clear();
			for (const link of this.links.values()) link.close();
			for (const link of this.pending.values()) link.close();
			this.links.clear();
			this.pending.clear();
		}

		// -- party administration -----------------------------------------

		setName(name) {
			this._editSelf({ name });
		}

		// Fields the party record owns. A game publishing its own metadata may
		// not overwrite them: a peer that could rename itself `host` or hand
		// itself a team through this door would be editing the record the whole
		// mesh trusts, not decorating its own seat.
		/**
		 * Attach arbitrary fields to *our own* member record.
		 *
		 * The record already replicates to everyone and is adopted wholesale by
		 * late joiners, so this is the cheap way to publish something durable and
		 * small about yourself — `lib/secrets.js` puts its public key here.
		 * Anything large or frequent belongs on an action channel instead; this
		 * rides every party commit.
		 */
		setMeta(patch) {
			const clean = {};
			for (const [k, v] of Object.entries(patch ?? {})) {
				if (RESERVED_META.has(k)) continue;
				clean[k] = v;
			}
			if (Object.keys(clean).length) this._editSelf(clean);
		}

		/** Host only. Move a member between Team A, Team B and spectators. */
		setTeam(memberId, team) {
			if (!this.isHost()) return;
			this._editMember(memberId, { team });
		}

		/** Host only. Choose the game everyone mounts. */
		setGame(gameId) {
			if (!this.isHost()) return;
			this.party.game = gameId;
			this._commitParty();
		}

		/** Host only. Hand the crown to someone else and stay in the party. */
		transferHost(memberId) {
			if (!this.isHost()) return;
			if (!this.party.members.some((m) => m.id === memberId)) return;
			this.party.host = memberId;
			this._commitParty();
		}

		/** Host only. Remove someone from the party. */
		removeMember(memberId) {
			if (!this.isHost() || memberId === this.selfId) return;
			// A bot has no channel to hear an eviction on, and no peer needs to be
			// told separately — dropping it from the record is the whole story.
			if (!isBotId(memberId)) this._send({ __k: memberId, f: this.selfId }, null);
			this._dropMember(memberId);
			this._commitParty();
		}

		// -- bots -----------------------------------------------------------
		//
		// Bots exist so that a game is never gated on finding a second person.
		// They fill seats in the ordinary roster, and only the host runs them:
		// every one of these games is already host-authoritative, so the side
		// that decides what a bot does is the side that decides everything else.

		/**
		 * Host only. Seat a simulated player and return its member id.
		 *
		 * `team` defaults to whichever side is emptier, which is what somebody
		 * pressing ADD BOT almost always means — they want an opponent.
		 */
		addBot(team) {
			if (!this.isHost()) return null;
			if (this.party.members.length >= this.maxMembers) return null;
			const taken = new Set(this.party.members.map((m) => m.name));
			let name = BOT_NAMES.find((n) => !taken.has(n));
			if (!name) name = `${BOT_NAMES[0]} ${this.party.members.length}`;

			const id = BOT_PREFIX + randId(8);
			this._addMember(id, name);
			this._editMember(id, { team: team ?? this._emptierTeam(), bot: true });
			return id;
		}

		/** Every bot currently seated, in join order. Readable by any member. */
		bots() {
			return this.party.members.filter((m) => isBotId(m.id)).map((m) => ({ ...m }));
		}

		/** The side with fewer players, so ADD BOT lands opposite the human. */
		_emptierTeam() {
			const on = (t) => this.party.members.filter((m) => m.team === t).length;
			return on("B") < on("A") ? "B" : "A";
		}

		/**
		 * Host only. Send an action as though it came from one of our bots.
		 *
		 * Real peers receive it with `peerId` set to the bot, so a game's own
		 * `onMessage` handler treats a bot's move exactly like a person's. The
		 * host also delivers it to itself, which an ordinary `send` does not do:
		 * a broadcast from this browser never comes back to this browser, so
		 * without this the one peer running the bot would be the one peer that
		 * never saw it move.
		 */
		emitAs(botId, actionName, data, opts) {
			if (!this.isHost() || !isBotId(botId)) return;
			const env = { a: actionName, d: data, f: botId, t: opts?.target ?? null };
			this._send(env, null);
			if (env.t === null || env.t === this.selfId) this._deliver(env);
		}

		/**
		 * Take the crown when the host has gone. Automatic succession normally
		 * handles this, but the guard remains for any edge case where the crown
		 * is still vacant: a peer that still sees a live host must not claim it.
		 */
		claimHost() {
			if (this.party.host && this._isReachable(this.party.host)) return false;
			this.party.host = this.selfId;
			this._commitParty();
			return true;
		}

		/**
		 * Host only. End the party for everyone. This is the only exit that
		 * closes it — any other departure leaves the remaining members playing.
		 */
		deleteParty() {
			if (!this.isHost()) return;
			this._send({ __x: 1, f: this.selfId }, null);
			// Give the notice a moment to drain before tearing the channels down.
			setTimeout(() => this.leave(), 250);
		}

		// -- signaling ----------------------------------------------------

		/**
		 * Mint an invite for one newcomer. Any member can do this, not just the
		 * host: the answer that comes back is applied locally and the rest of the
		 * party negotiates with the newcomer automatically afterwards. That is
		 * what lets whoever is standing next to the new player do the scanning.
		 */
		async createInvite() {
			if (this.party.members.length >= this.maxMembers) {
				throw new Error(`This party is full (${this.maxMembers} players).`);
			}
			const slot = randId(4);
			const pc = trackCandidates(new RTCPeerConnection({ iceServers: this.iceServers }));
			const link = new Link(this, pc, slot);
			link.attach(pc.createDataChannel("game", { ordered: true }));
			this._watch(link);

			await pc.setLocalDescription(await pc.createOffer());
			await gatherIce(pc);
			this.pending.set(slot, link);

			const code = await packSignal(
				{ s: slot, i: this.selfId, n: this.self()?.name },
				pc.localDescription.sdp,
			);
			const base = location.href.split("#")[0];
			return { code, link: `${base}#i=${code}` };
		}

		/** Consume the answer code a newcomer sent back. */
		async acceptAnswer(answerCode) {
			const { slot, peerId, name, sdp } = await unpackSignal(answerCode);
			const link = this.pending.get(slot);
			if (!link) {
				throw new Error(
					"That code does not match an open invite. Create a new invite and try again.",
				);
			}
			if (this.links.has(peerId)) throw new Error("That player is already connected.");
			this.pending.delete(slot);
			link.peerId = peerId;
			link.introducedName = name;
			await link.pc.setRemoteDescription({ type: "answer", sdp });
		}

		/**
		 * Consume an invite and produce the answer code that must go back. Used
		 * by whoever opened an `#i=` link — the newcomer joining a party.
		 */
		async answerInvite(inviteCode) {
			const { slot, peerId: inviterId, name, sdp } = await unpackSignal(inviteCode);
			const pc = trackCandidates(new RTCPeerConnection({ iceServers: this.iceServers }));
			const link = new Link(this, pc, slot);
			link.peerId = inviterId;
			link.introducedName = name;
			pc.ondatachannel = (e) => link.attach(e.channel);
			this._watch(link);

			await pc.setRemoteDescription({ type: "offer", sdp });
			await pc.setLocalDescription(await pc.createAnswer());
			await gatherIce(pc);

			return await packSignal(
				{ s: slot, i: this.selfId, n: this.self()?.name },
				pc.localDescription.sdp,
			);
		}

		/**
		 * Negotiate with a party member we have no direct link to, carrying the
		 * offer and answer over the links we *do* have. This is the whole trick:
		 * the manual handshake is paid once, by one person, and every subsequent
		 * connection in the mesh is established without anyone doing anything.
		 *
		 * Only the peer with the lower id offers, so a pair never negotiates
		 * against itself when both notice the gap at the same moment.
		 */
		async _openRelayed(peerId) {
			if (this.closed) return;
			if (this.links.has(peerId) || this.negotiating?.has(peerId)) return;
			if (peerId === this.selfId) return;
			if (this.selfId > peerId) return; // the other side offers
			(this.negotiating ??= new Set()).add(peerId);
			try {
				const pc = trackCandidates(new RTCPeerConnection({ iceServers: this.iceServers }));
				const link = new Link(this, pc, null);
				link.peerId = peerId;
				link.attach(pc.createDataChannel("game", { ordered: true }));
				this._watch(link);
				this.pending.set("r:" + peerId, link);

				await pc.setLocalDescription(await pc.createOffer());
				await gatherIce(pc);
				this._send(
					{
						__g: "offer",
						f: this.selfId,
						t: peerId,
						sdp: pc.localDescription.sdp,
					},
					null,
				);
			} catch (err) {
				this.negotiating.delete(peerId);
			}
		}

		async _onRelayedOffer(from, sdp) {
			if (this.closed || this.links.has(from)) return;
			const pc = trackCandidates(new RTCPeerConnection({ iceServers: this.iceServers }));
			const link = new Link(this, pc, null);
			link.peerId = from;
			pc.ondatachannel = (e) => link.attach(e.channel);
			this._watch(link);
			try {
				await pc.setRemoteDescription({ type: "offer", sdp });
				await pc.setLocalDescription(await pc.createAnswer());
				await gatherIce(pc);
				this._send(
					{ __g: "answer", f: this.selfId, t: from, sdp: pc.localDescription.sdp },
					null,
				);
			} catch {
				link.close();
			}
		}

		async _onRelayedAnswer(from, sdp) {
			const link = this.pending.get("r:" + from);
			if (!link) return;
			this.pending.delete("r:" + from);
			try {
				await link.pc.setRemoteDescription({ type: "answer", sdp });
			} catch {
				link.close();
				this.negotiating?.delete(from);
			}
		}

		/** Fill in every direct connection the mesh is still missing. */
		_meshUp() {
			for (const m of this.party.members) {
				if (m.id === this.selfId || this.links.has(m.id)) continue;
				// A bot has no browser to connect to. Left in, every peer would
				// spend a full ICE timeout on it, every time the roster changed.
				if (isBotId(m.id)) continue;
				this._openRelayed(m.id);
			}
		}

		/** Report a dead connection instead of waiting on it forever. */
		_watch(link) {
			link.pc.onconnectionstatechange = () => {
				const s = link.pc.connectionState;
				if (s === "failed") {
					// In a mesh a single failed pair is survivable: messages between
					// those two are relayed through somebody who can reach both. Only
					// a peer we cannot reach at all is worth reporting.
					const types = [...(link.pc._types ?? [])];
					this._linkClosed(link);
					if (link.peerId && !this._isReachable(link.peerId) && this.links.size === 0) {
						// Say which paths we actually had. "No srflx" means STUN never
						// answered (so only same-LAN play can work); having both and
						// still failing is the genuine symmetric-NAT case that no
						// amount of retrying will fix.
						console.warn("[neon] connection failed; local candidates:", types);
						const detail = !types.length
							? "no connection paths were found at all"
							: !types.includes("srflx") && !types.includes("relay")
								? "STUN did not answer, so only same-network play was possible"
								: "both sides had public addresses but no route between them";
						this.onError?.(
							`Could not establish a direct connection — ${detail}. ` +
								"Try both devices on the same wifi, or one phone's hotspot.",
						);
					}
				} else if (s === "disconnected" || s === "closed") {
					this._linkClosed(link);
				}
			};
		}

		// -- membership ---------------------------------------------------

		_linkOpened(link) {
			if (!link.peerId) return;
			this.links.set(link.peerId, link);
			this.negotiating?.delete(link.peerId);
			this._vouch(link.peerId);

			// A held seat's owner came back: the reconnecting mark is the one
			// thing the return has to clear, because the grace clock and the
			// crown's heir both read it.
			const held = this.party.members.find((m) => m.id === link.peerId);
			if (held?.reconnecting) {
				delete held.reconnecting;
				if (this.isHost()) this._commitParty();
				else this._emitParty();
			}

			// Whoever already holds the crown owns the party record and answers
			// with it. A newcomer's first inbound message is therefore the roster.
			if (this.isHost()) {
				this._addMember(link.peerId, link.introducedName);
				this._commitParty();
			} else {
				// A newcomer knows nobody yet, so it cannot address the host and it
				// cannot broadcast either — it does not know who is missing. Hand it
				// our record first; that is where it learns who holds the crown.
				this._sendParty(link);
				// Then tell the host, on the newcomer's behalf, that they exist.
				// This is what lets any member do the recruiting.
				if (!this.party.members.some((m) => m.id === link.peerId)) {
					this._send(
						{
							__i: { id: link.peerId, name: link.introducedName },
							f: this.selfId,
							t: this.party.host,
						},
						null,
					);
				}
			}
			this.onOpen?.(link.peerId);
			this._meshUp();
		}

		_linkClosed(link) {
			if (!link.peerId || this.links.get(link.peerId) !== link) return;
			const peerId = link.peerId;
			this.links.delete(peerId);
			link.close();
			if (this.party.members.some((m) => m.id === peerId)) this._suspect(peerId);
		}

		/**
		 * A direct link dropped. That is not the same as the member leaving: in a
		 * mesh a single pair can fail while everyone else still reaches them, and
		 * relaying exists precisely for that. So ask before concluding anything —
		 * anyone who still holds a live link to them says so, and silence is what
		 * actually means "gone".
		 */
		_suspect(peerId, attempt = 0) {
			this.suspects ??= new Map();
			if (this.suspects.has(peerId)) return;
			this._send({ __q: peerId, f: this.selfId, t: null }, null);
			const timer = setTimeout(() => {
				this.suspects.delete(peerId);
				if (this.links.has(peerId)) return; // came back on its own
				this._confirmGone(peerId);
			}, DEPARTURE_GRACE_MS);
			this.suspects.set(peerId, { timer, attempt });
		}

		/**
		 * Someone vouched for a suspect. That settles it for now — but a peer
		 * whose own link has not dropped *yet* will vouch for someone who is in
		 * fact already gone, so ask again rather than trusting one answer
		 * forever. A few rounds is enough to outlast a staggered disconnect;
		 * after that, being reachable only by relay is a legitimate steady state
		 * and not worth more traffic.
		 */
		_vouch(peerId) {
			const entry = this.suspects?.get(peerId);
			if (!entry) return;
			clearTimeout(entry.timer);
			this.suspects.delete(peerId);
			if (this.links.has(peerId) || entry.attempt >= VOUCH_RETRIES) return;
			setTimeout(() => {
				if (!this.closed && !this.links.has(peerId)) {
					this._suspect(peerId, entry.attempt + 1);
				}
			}, DEPARTURE_GRACE_MS);
		}

		/**
		 * Nobody could vouch for them. Tell the party, so everyone drops them at
		 * once instead of each waiting to notice independently — whoever sees it
		 * first carries the rest.
		 *
		 * One member is excepted: one who joined through the room server has a
		 * seat held for the reconnect grace, because their reload is expected
		 * and their return is automatic. Gone is still gone for everyone else.
		 */
		_confirmGone(peerId) {
			const member = this.party.members.find((m) => m.id === peerId);
			if (!member) return;
			if (member.rs) {
				// First conclusion marks; the others see it marked and leave the
				// drop to their own timers, so a dead first-marker's timer is
				// covered by everyone else's and the seat cannot be held forever
				// by a peer that itself went away.
				if (!member.reconnecting) {
					member.reconnecting = Date.now();
					if (this.isHost()) this._commitParty();
					else this._emitParty();
				}
				// The crown is the one thing the grace never holds: a hostless
				// party cannot switch games or run its bots, and five minutes of
				// that is worse than re-crowning. The seat waits; the crown does not.
				if (peerId === this.party.host) this._vacateCrown();
				setTimeout(() => {
					if (this.closed) return;
					const m = this.party.members.find((x) => x.id === peerId);
					// Came back — the link opening cleared the mark — or someone
					// else's broadcast already dropped them.
					if (!m?.reconnecting || this.links.has(peerId)) return;
					if (Date.now() - m.reconnecting < this.reconnectGraceMs) return;
					this._send({ __gone: peerId, f: this.selfId, t: null }, null);
					this._applyGone(peerId);
				}, this.reconnectGraceMs);
				return;
			}
			this._send({ __gone: peerId, f: this.selfId, t: null }, null);
			this._applyGone(peerId);
		}

		/**
		 * Advisory socket state from the room server — "their signalling socket
		 * dropped" or "they are back on it". Advisory on purpose: a member whose
		 * mesh links are all alive is present no matter what their signalling
		 * socket is doing, and demoting them on a server hiccup would be the
		 * server's outage becoming the party's problem. So the mark only lands
		 * when there is no live link to hide behind, and it only ever *marks* —
		 * the return is the link's job, and that is `_linkOpened`.
		 */
		serverPeerState(peerId, connected) {
			const member = this.party.members.find((m) => m.id === peerId);
			if (!member?.rs || isBotId(peerId) || connected) return;
			if (this.links.has(peerId) || member.reconnecting) return;
			member.reconnecting = Date.now();
			if (this.isHost()) this._commitParty();
			else this._emitParty();
			// The grace clock still runs through _confirmGone; this mark only
			// makes the roster say RECONNECTING sooner than a probe would.
		}

		_applyGone(peerId) {
			if (!this.party.members.some((m) => m.id === peerId)) return;
			if (peerId === this.party.host) return this._hostLost();
			this._dropMember(peerId);
			if (this.isHost()) this._commitParty();
			else this._emitParty();
		}

		/** Reachable means a message can actually be written towards them. */
		_isReachable(peerId) {
			return this.links.has(peerId);
		}

		/**
		 * The host is gone. The party outlives it: the longest-present remaining
		 * member inherits the crown automatically. Every browser computes the
		 * same heir from the same roster, so the hand-over needs no UI offer.
		 */
		_hostLost() {
			this._dropMember(this.party.host);
			this._vacateCrown();
		}

		/**
		 * The crown is vacant. The nominated heir takes it, and the host's bots
		 * go with it — the only browser simulating them was the one that left.
		 * Split from _hostLost because a *held* host (a room-server member
		 * whose seat is waiting out the reconnect grace) vacates the crown the
		 * moment they cannot be vouched for, without dropping the seat itself.
		 */
		_vacateCrown() {
			this.party.host = null;
			// The host was the only browser simulating them. Left in the roster
			// they would be seats that never move again, and the next host would
			// be handed a game it cannot finish.
			for (const m of this.getMembers()) if (isBotId(m.id)) this._dropMember(m.id);
			const heir = this._heir();
			// Succession is automatic: the heir takes the crown the moment it
			// vacates, on every browser at once, because they all compute the
			// same heir from the same roster. No offer, no button.
			this.party.host = heir;
			if (heir === this.selfId) this._commitParty();
			else this._emitParty();
			this.onHostVacant?.(heir, heir === this.selfId);
		}

		/**
		 * Longest-present remaining member, ties broken by id so all agree.
		 * A reconnecting member is skipped: there is no browser behind the
		 * seat to accept the crown yet, and a five-minute vacancy is better
		 * than offering it to somebody's empty chair.
		 */
		_heir() {
			const ranked = [...this.party.members]
				// A bot cannot hold the crown: there is no browser behind it to run
				// the party, and nothing would ever accept the offer.
				.filter((m) => !isBotId(m.id) && !m.reconnecting)
				.sort((a, b) => a.joined - b.joined || (a.id < b.id ? -1 : 1));
			return ranked[0]?.id ?? this.selfId;
		}

		_addMember(id, name) {
			if (this.party.members.some((m) => m.id === id)) return;
			this.party.members.push({
				id,
				name: name || "Player",
				team: null,
				joined: Date.now(),
			});
			this._emitJoin(id);
		}

		_dropMember(id) {
			const before = this.party.members.length;
			this.party.members = this.party.members.filter((m) => m.id !== id);
			if (this.party.members.length !== before) this._emitLeave(id);
			const link = this.links.get(id);
			if (link) {
				this.links.delete(id);
				link.close();
			}
		}

		_editSelf(patch) {
			const me = this.party.members.find((m) => m.id === this.selfId);
			if (!me) return;
			Object.assign(me, patch);
			if (this.isHost()) this._commitParty();
			else {
				this._send({ __i: { id: this.selfId, ...patch }, f: this.selfId, t: null }, null);
				this._emitParty();
			}
		}

		_editMember(id, patch) {
			const m = this.party.members.find((x) => x.id === id);
			if (!m) return;
			Object.assign(m, patch);
			this._commitParty();
		}

		/** Host side: publish the authoritative party record to everyone. */
		_commitParty() {
			this.party.members.sort((a, b) => a.joined - b.joined);
			this._send({ __p: this.party, f: this.selfId, t: null }, null);
			this._emitParty();
			this._meshUp();
		}

		_sendParty(link) {
			link.send({ __p: this.party, f: this.selfId, t: null });
		}

		/** Non-host side: adopt the host's record wholesale. */
		_applyParty(next) {
			const before = new Set(this.party.members.map((m) => m.id));
			const after = new Set(next.members.map((m) => m.id));
			this.party = next;
			for (const id of after) if (!before.has(id)) this._emitJoin(id);
			for (const id of before) if (!after.has(id)) this._emitLeave(id);
			this._emitParty();
			this._meshUp();
		}

		_emitJoin(id) {
			if (id !== this.selfId) this.onPeerJoin?.(id);
		}
		_emitLeave(id) {
			if (id !== this.selfId) this.onPeerLeave?.(id);
		}
		_emitParty() {
			this.onParty?.(this.getMembers(), {
				host: this.party.host,
				game: this.party.game,
			});
		}

		// -- routing ------------------------------------------------------

		/** Originate an envelope from this peer. */
		_dispatch(env) {
			this._send(env, null);
		}

		/**
		 * Send an envelope towards its target, or to everyone when `t` is null.
		 *
		 * With a complete mesh this is one direct write per recipient and nothing
		 * is ever forwarded. When a pair cannot connect, the envelope is passed
		 * to the peers that might reach it instead, deduplicated by id and capped
		 * at MAX_HOPS so nothing can circulate.
		 */
		_send(env, from) {
			if (this.closed) return;
			env.id ??= randId(8);
			env.h ??= MAX_HOPS;
			this._markSeen(env.id);

			if (env.t !== null && env.t !== undefined) {
				if (env.t === this.selfId) return this._deliver(env);
				const direct = this.links.get(env.t);
				if (direct) return direct.send(env);
				if (env.h <= 0) return;
				const relayed = { ...env, h: env.h - 1 };
				for (const [id, link] of this.links) {
					if (id !== env.f && link !== from) link.send(relayed);
				}
				return;
			}

			// Broadcast. Tell recipients who we already reached, so a peer only
			// forwards to members the sender could not write to itself. In a full
			// mesh that set is empty and no forwarding happens at all.
			const reached = [...this.links.keys()];
			const covered = new Set([...reached, env.f, this.selfId]);
			const missing = this.party.members
				.map((m) => m.id)
				.filter((id) => !covered.has(id) && !isBotId(id));
			const out = { ...env, m: missing.length ? missing : null };
			for (const [id, link] of this.links) {
				if (id !== env.f && link !== from) link.send(out);
			}
		}

		_markSeen(id) {
			if (this.seen.has(id)) return false;
			this.seen.add(id);
			this.seenQueue.push(id);
			if (this.seenQueue.length > SEEN_MAX) this.seen.delete(this.seenQueue.shift());
			return true;
		}

		_deliver(env) {
			const action = this.actions.get(env.a);
			action?.onMessage?.(env.d, { peerId: env.f });
		}

		/** Forward a broadcast on behalf of a sender that could not reach everyone. */
		_forwardBroadcast(env, from) {
			if (!env.m || env.h <= 0) return;
			const stillMissing = env.m.filter((id) => !this.links.has(id));
			const relayed = { ...env, h: env.h - 1, m: stillMissing.length ? stillMissing : null };
			for (const id of env.m) {
				const link = this.links.get(id);
				if (link && link !== from) link.send(relayed);
			}
		}

		_inbound(link, msg) {
			if (this.closed) return;

			// Control traffic is handled before the game's queue, so a party edit
			// is never held behind `resume()`.
			if (msg.__p) {
				if (!this._markSeen(msg.id ?? randId(8))) return;
				this._forwardBroadcast(msg, link);
				// Only the crown holder's record is authoritative. A peer that has
				// no host yet (a newcomer, or someone who just lost theirs) accepts
				// an introduction from anyone, which is how it learns who to trust.
				if (this.isHost()) return;
				const sentByHost = msg.f === msg.__p.host || msg.f === this.party.host;
				if (sentByHost || this.party.host === null) this._applyParty(msg.__p);
				return;
			}
			if (msg.__i) {
				if (!this._markSeen(msg.id ?? randId(8))) return;
				if (!this.isHost()) {
					// Pass introductions along to whoever keeps the record.
					if (this.party.host && msg.t !== this.selfId) {
						this._send({ ...msg, t: this.party.host }, link);
					}
					return;
				}
				const { id, ...patch } = msg.__i;
				if (this.party.members.some((m) => m.id === id)) this._editMember(id, patch);
				else {
					this._addMember(id, patch.name);
					this._commitParty();
				}
				return;
			}
			if (msg.__g) {
				if (msg.t !== this.selfId) return this._send(msg, link);
				if (!this._markSeen(msg.id)) return;
				if (msg.__g === "offer") this._onRelayedOffer(msg.f, msg.sdp);
				else this._onRelayedAnswer(msg.f, msg.sdp);
				return;
			}
			if (msg.__k) {
				if (!this._markSeen(msg.id ?? randId(8))) return;
				this._forwardBroadcast(msg, link);
				if (msg.__k === this.selfId) {
					this.onEvicted?.();
					this.leave();
				} else {
					this._dropMember(msg.__k);
					this._emitParty();
				}
				return;
			}
			if (msg.__q) {
				if (!this._markSeen(msg.id ?? randId(8))) return;
				this._forwardBroadcast(msg, link);
				// Only speak up if we can actually still reach them.
				if (this.links.has(msg.__q)) {
					this._send({ __alive: msg.__q, f: this.selfId, t: null }, null);
				}
				return;
			}
			if (msg.__alive) {
				if (!this._markSeen(msg.id ?? randId(8))) return;
				this._forwardBroadcast(msg, link);
				this._vouch(msg.__alive);
				return;
			}
			if (msg.__gone) {
				if (!this._markSeen(msg.id ?? randId(8))) return;
				this._forwardBroadcast(msg, link);
				// Unless we can still reach them ourselves, in which case the
				// reporter simply lost a pair and relaying covers it.
				if (!this.links.has(msg.__gone)) this._applyGone(msg.__gone);
				return;
			}
			if (msg.__x) {
				if (!this._markSeen(msg.id ?? randId(8))) return;
				this._forwardBroadcast(msg, link);
				this.onPartyClosed?.();
				this.leave();
				return;
			}

			if (!this.running) {
				this.inbox.push([link, msg]);
				return;
			}

			// Game traffic.
			if (msg.t !== null && msg.t !== undefined) {
				if (msg.t === this.selfId) {
					if (this._markSeen(msg.id)) this._deliver(msg);
				} else {
					this._send(msg, link);
				}
				return;
			}
			if (!this._markSeen(msg.id)) return;
			this._forwardBroadcast(msg, link);
			this._deliver(msg);
		}
	}

	// ------------------------------------------------------------------ entry

	/** True when this page was opened from an invite link. */
	NeonArcade.inviteFromUrl = () => {
		const m = location.hash.match(/[#&]i=([^&]+)/);
		return m ? m[1] : null;
	};

	/** An answer handed back as a link, for the paste-free remote path. */
	NeonArcade.answerFromUrl = () => {
		const m = location.hash.match(/[#&]a=([^&]+)/);
		return m ? m[1] : null;
	};

	/** Drop a handshake fragment without reloading, so a live room survives. */
	NeonArcade.clearHash = () => {
		history.replaceState(null, "", location.pathname + location.search);
	};

	/**
	 * Restart this page as a host. A guest reached the page through an `#i=`
	 * invite, so the fragment has to go before reloading — otherwise the lobby
	 * would just try to answer the same (now dead) invite again.
	 */
	NeonArcade.hostNewGame = () => {
		NeonArcade.clearHash();
		location.reload();
	};

	/** Create a room you host. Returns the room plus `createInvite`/`acceptAnswer`. */
	NeonArcade.createHost = (opts = {}) => new Room({ ...opts, isHost: true });

	/** Create a room you join. Feed it the invite code via `answerInvite`. */
	NeonArcade.createGuest = (opts = {}) => new Room({ ...opts, isHost: false });

	// Exposed for tests.
	NeonArcade._codec = { packSignal, unpackSignal, compactSdp, rebuildSdp };
})();
