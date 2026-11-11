// lib/room-join.js — joining a party by a six-digit code, over the room server.
//
// The handshake the players used to carry themselves — invite across, reply
// back — becomes one short exchange with a rendezvous: the host holds a code,
// the guest types it, and the offer/reply strings that used to travel through
// hands and cameras travel through the room server instead. Everything after
// the first link is the mesh it always was; this file never touches game data.
//
// The room server is optional on purpose. When it is unreachable — offline,
// `file://`, a network that blocks it — everything here stands down and the
// arcade behaves exactly as it did without it: the invite/scan/paste flow,
// which stays fully supported and fully tested. The zero-server property
// degrades; it does not disappear.
//
// One rule from docs/room-server.md binds the design: the room server's
// notices are *advisory*, never authoritative. The party record replicated over
// the mesh decides who is in the party; this file relays socket state to
// `room.serverPeerState`, and net.js ignores it whenever a live link says
// otherwise.
//
// Loaded as a traditional script so it works on file:// like everything else.

(() => {
	// The deployed room server (worker/, deployed 2026-11-11), no trailing
	// slash; an empty string turns the code-join path off. Override it with localStorage
	// "neon.rs" (a self-hosted server, a test), or with `?rs=<url>` naming a
	// server on this machine — see resolveBase for why only that.
	NeonArcade.roomServerUrl = "https://neon-arcade-room.lokeshmohanty.workers.dev";

	// How patient to be deciding whether the room server is there at all.
	// The probe's answer decides which UI is offered, so it is on the user's
	// path; a long timeout here is an invisible wait, which this project does
	// not ship.
	const PROBE_TIMEOUT_MS = 2500;
	// A host/join exchange that has not been answered in this long is a
	// server that is not going to answer: "unreachable", not a spinner.
	const DIAL_TIMEOUT_MS = 8000;
	// How long a joiner waits, after the server said "joined", to be in a
	// party: a data channel open *and* a host known. The offer comes from
	// whoever is attached; when nobody is (a party that ended, or one whose
	// members all left) or no link can be made, this is what turns the wait
	// into an explicit "no-answer". It has to outlast the offerer's worst
	// case on a reload — the stale-link watch below (12s), then gathering on
	// both ends (ICE_TIMEOUT_MS, 4s each in net.js), then the connect — or a
	// rejoin that was about to succeed is told nobody answered.
	const JOIN_ANSWER_MS = 30000;
	// A peer announced as back on the server while we still hold a link to
	// them is usually a reload whose old link has not closed yet (it does
	// within seconds). Look again this often, this many times, before
	// concluding the link is genuinely live and no offer is needed. 12s
	// covers the slowest close net.js measured (a killed tab: 11s, see
	// DISCONNECT_GRACE_MS) and leaves JOIN_ANSWER_MS its margin.
	const STALE_LINK_POLL_MS = 1000;
	const STALE_LINK_POLLS = 12;
	// A deliberate leave is acknowledged by the server closing the socket.
	// Navigation waits for that (roomSettled) for at most this long: a page
	// that unloads straight after send() can lose the frame with it, and
	// then the old party keeps a seat — and a newcomer to a one-member room
	// is told "joined" by a room nobody is in. Short, because it is on the
	// user's path; a server this slow lets the claim lapse with the TTL.
	const LEAVE_ACK_MS = 1500;
	// Reconnecting the signalling socket: quick at first, capped later. The
	// mesh does not notice any of this — only the next newcomer's offer and
	// our own rejoin claim ride this socket, so a slow retry costs nobody a
	// game turn.
	const RETRY_FIRST_MS = 1000;
	// How long an answer we sent keeps us from also offering to the same
	// member (see `answering`): about one join's worth, after which a pair
	// that never opened may be offered to afresh.
	const ANSWERING_MS = 20000;
	// How long an offer we sent keeps us from offering to the same member
	// again (see `inflight`). Every normal outcome clears it sooner; this is
	// the backstop for the ones that say nothing — an answer that never
	// comes back — so the next notice is not ignored for good.
	const OFFERING_MS = 20000;
	const RETRY_CAP_MS = 30000;
	// net.js's onLeave reasons that mean "I am giving the seat back": a
	// deliberate leave, an eviction, the party being deleted. A reload never
	// calls onLeave at all, so its seat stays claimed for the rejoin.
	const RELEASING = new Set(["left", "evicted", "closed"]);

	const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
	/** Random id/secret material: member ids for claims, secrets for the same. */
	const randToken = (n = 12) =>
		[...crypto.getRandomValues(new Uint8Array(n))]
			.map((b) => ALPHABET[b % ALPHABET.length])
			.join("");

	/**
	 * Is `url` a server on this machine? The one kind of room server a link
	 * may choose: nobody else can run one there.
	 */
	function onLoopback(url) {
		try {
			const host = new URL(url).hostname;
			return host === "localhost" || host === "[::1]" || /^127(\.\d{1,3}){3}$/.test(host);
		} catch {
			return false;
		}
	}

	/**
	 * The room-server base URL for this session, as ws(s)://, or "" when
	 * there is none.
	 *
	 * The server is chosen by storage ("neon.rs"), never by a link — the
	 * same rule as the STUN override (net.js iceDefault). The room server
	 * relays the SDP every link is made from, fingerprints included, so a
	 * `?rs=` link could swap them and sit in the middle of every data
	 * channel of every party it carried. A link may only name a loopback
	 * server, which nobody but this machine's owner can run; that keeps
	 * `?rs=http://127.0.0.1:8787` for local work and the tests' dead
	 * `?rs=http://127.0.0.1:1`.
	 */
	function resolveBase() {
		let base = NeonArcade.roomServerUrl || "";
		try {
			const linked = new URLSearchParams(location.search).get("rs");
			base = (linked && onLoopback(linked) ? linked : "") || localStorage.getItem("neon.rs") || base;
		} catch {}
		// WebSocket wants ws(s)://. Newer browsers accept http(s):// too, older
		// ones throw a SyntaxError — so the conversion is done here, once.
		return base.replace(/\/+$/, "").replace(/^http/, "ws");
	}
	// Exposed for tests (test-room's `?rs=` rule).
	Object.defineProperty(NeonArcade, "_roomServerBase", { get: resolveBase });

	/** The mock server tests drive this code against — see makeMockRoomServer. */
	function mock() {
		return window.__neonRoomMock ?? null;
	}

	const ERRORS = {
		aborted: "The join was cancelled.",
		"no-room": "That party is no longer meeting — its code expired or the party ended.",
		"bad-code": "That is not a six-digit party code.",
		"id-taken": "Somebody else answered for that seat. Ask them to reconnect instead.",
		full: "That party is full.",
		blocked: "Too many attempts. Wait a few minutes and try again.",
		unreachable: "Could not reach the room server.",
		taken: "Could not find a free code. Try again in a moment.",
		"no-answer": "Nobody in that party answered. It may have ended, or your networks cannot reach each other.",
		// The party did answer and the link could not be made: no TURN relay,
		// by design, so some network pairs cannot connect. net.js's own
		// message (which paths were tried) replaces this when there is one.
		"no-route": "The party answered, but your network and theirs cannot connect directly.",
		// Another tab of this browser reconnected with the same rejoin token,
		// and the room server handed it the seat (see makeRoom `displaced`).
		displaced: "This party is open in another tab.",
	};
	const failure = (reason) => Object.assign(new Error(ERRORS[reason] ?? reason), { reason });

	/**
	 * Open the signalling socket — to the room server, or to the mock, which
	 * is the same protocol in one page — send `hello`, and wait for the one
	 * reply that settles it. Resolves { ws, reply } on "room", "joined",
	 * "released" or "busy"; rejects with the protocol's reason on an error reply, and
	 * "unreachable" on a socket that could not be made, died first, or
	 * stayed silent past `timeoutMs`. Every failure is a verdict; none is a
	 * wait.
	 */
	function dial(code, hello, timeoutMs = DIAL_TIMEOUT_MS) {
		return new Promise((resolve, reject) => {
			let ws;
			let settled = false;
			const fail = (reason) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				try {
					ws?.close();
				} catch {}
				reject(failure(reason));
			};
			const timer = setTimeout(() => fail("unreachable"), timeoutMs);
			try {
				ws = mock() ? mock().connect(`/room/${code}`) : new WebSocket(`${resolveBase()}/room/${code}`);
			} catch {
				return fail("unreachable");
			}
			ws.onopen = () => ws.send(JSON.stringify({ ...hello, code }));
			ws.onmessage = (e) => {
				let msg;
				try {
					msg = JSON.parse(e.data);
				} catch {
					return;
				}
				if (msg.t === "error") return fail(msg.reason);
				if (settled || !["room", "joined", "released", "busy"].includes(msg.t)) return;
				settled = true;
				clearTimeout(timer);
				resolve({ ws, reply: msg });
			};
			ws.onclose = () => fail("unreachable");
			ws.onerror = () => {}; // onclose follows; one verdict is enough
		});
	}

	// Leaves sent and not yet acknowledged; roomSettled() waits on them.
	const pendingLeaves = new Set();

	/**
	 * Hand a seat back on `ws`, and let the server's close be the receipt:
	 * the hub releases the claim and then hangs up, so the close event
	 * means the frame arrived. Resolves on that close, or after
	 * LEAVE_ACK_MS, or at once on a socket that is not open (nothing can be
	 * sent on it; the claim lapses with the TTL). Never rejects.
	 */
	function sendLeave(ws, id, secret) {
		const acked = new Promise((resolve) => {
			let timer = null;
			const finish = () => {
				clearTimeout(timer);
				ws.onclose = null;
				try {
					ws.close();
				} catch {}
				resolve();
			};
			if (ws.readyState !== 1) return finish();
			ws.onmessage = null; // leaving: nothing it says matters now
			ws.onclose = finish;
			timer = setTimeout(finish, LEAVE_ACK_MS);
			try {
				ws.send(JSON.stringify({ t: "leave", id, secret }));
			} catch {
				finish();
			}
		});
		pendingLeaves.add(acked);
		acked.then(() => pendingLeaves.delete(acked));
		return acked;
	}

	/**
	 * Resolves once every leave this page has sent is acknowledged (or has
	 * timed out). Anything that navigates straight after a leave awaits
	 * this first — see LEAVE_ACK_MS.
	 */
	NeonArcade.roomSettled = () => Promise.all([...pendingLeaves]).then(() => {});

	let probedOk = false;
	/**
	 * Is the room server reachable? Asked before offering the code-join UI,
	 * because a dead server behind a live-looking button is an indefinite
	 * wait — the exact failure this project refuses. The probe is a plain
	 * `GET /ping`, answered by the routing Worker itself (worker/index.js):
	 * it wakes no room object and counts against no rate limit, so a player
	 * browsing page to page cannot block themselves. (It was a WebSocket
	 * `ping` to room 000000 until 2026-11-11 — one object every client in
	 * the world probed.) Silent past PROBE_TIMEOUT_MS is unreachable.
	 *
	 * Success is cached; failure is not, so a network that comes up later in
	 * the session is noticed without a reload.
	 */
	NeonArcade.roomServerReachable = () => {
		if (probedOk || mock()) return Promise.resolve((probedOk = true));
		const base = resolveBase();
		if (!base) return Promise.resolve(false);
		const ctl = new AbortController();
		const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
		return fetch(base.replace(/^ws/, "http") + "/ping", { cache: "no-store", signal: ctl.signal })
			.then(
				(res) => (probedOk = res.ok),
				() => false,
			)
			.finally(() => clearTimeout(timer));
	};

	// ------------------------------------------------------------ the token

	/**
	 * The rejoin token: proof this browser has a seat in a room. Written on
	 * every host/join, cleared when we leave or the room is gone. It is what
	 * turns a reload from a re-invite into a reconnect: the id is the seat, the
	 * secret is the claim on it, and neither crosses the mesh — only the room
	 * server ever sees the secret, hashed at that.
	 */
	function readToken() {
		try {
			const raw = localStorage.getItem("neon.room");
			const t = raw ? JSON.parse(raw) : null;
			if (t && /^\d{6}$/.test(t.code ?? "") && t.id && t.secret) return t;
		} catch {}
		return null;
	}
	function writeToken(token) {
		try {
			localStorage.setItem("neon.room", JSON.stringify(token));
		} catch {}
	}
	function clearToken() {
		try {
			localStorage.removeItem("neon.room");
		} catch {}
	}
	NeonArcade.rejoinToken = readToken;
	/** Drop the rejoin token — "start fresh" on the reconnect screen. */
	NeonArcade.clearRejoinToken = clearToken;

	// ------------------------------------------------------------- the room

	/**
	 * Host or join a room by code, then keep the signalling socket alive
	 * alongside the mesh it handed the newcomer to. One wiring serves host,
	 * join and rejoin; only the dial differs. A join resolves once the first
	 * data channel to the party is open — "joined" from the server only means
	 * the code was right, not that anybody is there to answer.
	 */
	async function makeRoom(code, { role, id, secret, rejoin = false, opts }) {
		if (!mock() && !resolveBase()) throw failure("unreachable");
		const { signal } = opts;
		if (signal?.aborted) throw failure("aborted");
		let ws;
		try {
			({ ws } = await dial(code, { t: role, id, secret }));
		} catch (err) {
			throw signal?.aborted ? failure("aborted") : err;
		}
		if (signal?.aborted) {
			// Cancelled while dialling: the server has just seated us, so
			// hand the seat straight back rather than leave it to the TTL.
			clearToken();
			sendLeave(ws, id, secret);
			throw failure("aborted");
		}

		let dead = false;
		let retry = RETRY_FIRST_MS;
		// The live signalling socket — replaced on each redial, so the one
		// onLeave must close is always the current one.
		let current = ws;
		// Members this wire has an offer out to: the guard that stops one
		// arrival minting two invites. It is cleared the moment the offer is
		// settled either way — the link opened, the peer's socket dropped, the
		// invite could not be made, our own socket was replaced — so a member
		// who reconnects a second and a third time is offered to every time.
		const inflight = new Map(); // peerId -> backstop timer (OFFERING_MS)
		// The backstop forgets an offer set aside for ours (`glared`) along
		// with ours: kept, a later invite that failed would answer an offer
		// that went stale long ago.
		const offering = (peerId) =>
			inflight.set(
				peerId,
				setTimeout(() => {
					inflight.delete(peerId);
					glared.delete(peerId);
				}, opts.offerBackstopMs ?? OFFERING_MS),
			);
		const doneOffering = (peerId) => {
			clearTimeout(inflight.get(peerId));
			inflight.delete(peerId);
		};
		// Offers we set aside under the glare rule while ours was in flight:
		// peerId -> their packed offer. If ours then fails to be made, theirs
		// is the pair's only offer left, and we answer it after all — or the
		// pair would wait, each for the other, until the next notice.
		const glared = new Map();
		// Members announced as back while a link to them still looks alive,
		// watched until it closes (see STALE_LINK_POLL_MS).
		const watching = new Set();
		// Every member this wire linked through the room server, either end of
		// the offer. Their seat holds through a reload (`member.rs`); a
		// scan/paste member keeps the shorter fuse.
		const viaServer = new Set();
		// A rejoin nobody answered keeps its claim: the party may only be
		// slow, and the token is what RETRY and the next reload reconnect
		// with. Only that one exit sets this; every other leave releases.
		let holding = false;
		// Set when a leave meant to hand the seat back found no open socket to
		// say so on — mid-redial. The redial that lands pays it (see redial).
		let owedLeave = false;
		// The pending redial's timer, so a leave can bring it forward.
		let redialTimer = null;
		// Set when a redial was refused for good (no-room, full, id-taken).
		// The server has no seat of ours to hand back, so a later leave owes
		// nothing — dialling `join` to pay it would be charged as a guess,
		// hold up navigation, and could seat us in whatever party re-hosted
		// the code meanwhile.
		let gaveUp = false;
		// A join's verdict, settled once: "ok", or the reason it failed.
		// Null for a host, which has nobody to wait for.
		let settleJoin = null;
		const joined = role === "join" ? new Promise((resolve) => (settleJoin = resolve)) : null;
		const settle = (outcome) => {
			const done = settleJoin;
			settleJoin = null;
			done?.(outcome);
		};
		/**
		 * In a party means a link open *and* a host known. A link alone is
		 * not enough: two members who both arrive with no record — a lone
		 * host back from a reload, and a newcomer who typed the code
		 * meanwhile — link to each other and neither has a host to name.
		 * Nobody crowns here: a crown minted at term 0 could outrank the real
		 * party's record later. The host is learned from a record (`__p`),
		 * or the deadline says nobody answered.
		 */
		const checkJoined = () => {
			if (room && room.directPeers().length && room.hostId() !== null) settle("ok");
		};

		const markRs = (peerId) => {
			const member = room?.party?.members?.find((m) => m.id === peerId);
			if (member && viaServer.has(peerId)) member.rs = true;
		};

		// The token dies with the room, and the socket dies with the room:
		// onLeave is the one hook net.js promises on every deliberate exit
		// (leave(), eviction, party-closed), so this is the one place to
		// detach in — and the one place a seat is handed back to the server,
		// so a long party's departed members do not fill it up.
		const onLeave = (reason) => {
			if (!holding) clearToken();
			dead = true;
			if (!holding && RELEASING.has(reason)) {
				// Mid-redial the socket is not open, so sendLeave can say
				// nothing on it. Without more, the dial in flight would land,
				// be hung up without a word, and the party would hold a seat
				// for 5 minutes for somebody who left. So the leave is owed:
				// the redial — brought forward if it is only scheduled — pays
				// it on the socket it gets.
				if (current.readyState !== 1 && !gaveUp) oweLeave();
				sendLeave(current, id, secret);
			} else {
				try {
					current.close();
				} catch {}
			}
			opts.onLeave?.(reason);
		};
		const onOpen = (peerId) => {
			doneOffering(peerId);
			glared.delete(peerId);
			doneAnswering(peerId);
			markRs(peerId);
			checkJoined();
			opts.onOpen?.(peerId);
		};
		const onPeerJoin = (peerId) => {
			markRs(peerId);
			opts.onPeerJoin?.(peerId);
		};
		const onParty = (...args) => {
			checkJoined();
			opts.onParty?.(...args);
		};
		// A join whose only link failed ICE is over: no other member will
		// offer, so waiting out the deadline would only swap net.js's
		// accurate verdict for "nobody answered".
		let routeError = null;
		const onError = (message, info) => {
			if (settleJoin && info?.reason === "no-route") {
				routeError = message;
				return settle("no-route");
			}
			opts.onError?.(message, info);
		};
		// Sockets given up on by rejoinServer: their late close is not news.
		const retired = new WeakSet();
		/**
		 * Every link is gone while the party still has people in it. The
		 * mesh has no path left to renegotiate over, and nobody offers to a
		 * member the server has not just announced — so re-announce: re-dial
		 * with the same claim, and whoever the server names offers again.
		 *
		 * Unconditionally, not only when the socket looks dead. Measured by
		 * scripts/test-nat.mjs, scenario 5: a network switch leaves the socket
		 * dead but undetected for 40s+, and a blackout a little longer than
		 * the link's patience leaves *both* sockets healthy and both ends
		 * isolated — with nobody re-announcing, that party never healed, and
		 * held two hosts until the reconnect grace ran out.
		 */
		const rejoinServer = () => {
			if (dead || room.closed) return;
			const socket = current;
			// Not open: its close is already scheduling the re-dial.
			if (socket.readyState !== 1 || retired.has(socket)) return;
			retired.add(socket);
			try {
				socket.close();
			} catch {}
			retry = RETRY_FIRST_MS;
			redial();
		};
		// Members we are answering an offer from: offering to them as well
		// would make a second link for the same pair (see the glare rule in
		// wire). Cleared when the link opens, or after ANSWERING_MS.
		const answering = new Map(); // peerId -> timer
		const doneAnswering = (peerId) => {
			clearTimeout(answering.get(peerId));
			answering.delete(peerId);
		};

		const roomOpts = {
			...opts,
			selfId: id,
			onLeave,
			onOpen,
			onPeerJoin,
			onParty,
			onError,
			onIsolated: rejoinServer,
		};
		delete roomOpts.signal;
		const room = role === "host" ? NeonArcade.createHost(roomOpts) : NeonArcade.createGuest(roomOpts);

		/**
		 * Offer to a member the server says we should — exactly the role any
		 * member plays when they stand next to a newcomer and press ADD
		 * PLAYER. A link we still hold to them is either live (a signalling
		 * hiccup: no offer needed, the link outranks the server) or the
		 * leftover of a reload that has not closed yet; we cannot tell which
		 * at once, so we watch it for a while and offer the moment it closes.
		 */
		const offerTo = (peerId, polls = 0) => {
			if (dead || room.closed || inflight.has(peerId) || answering.has(peerId)) return;
			if (room.directPeers().includes(peerId)) {
				if (polls === 0 && watching.has(peerId)) return;
				if (polls >= STALE_LINK_POLLS) return void watching.delete(peerId);
				watching.add(peerId);
				setTimeout(() => offerTo(peerId, polls + 1), STALE_LINK_POLL_MS);
				return;
			}
			watching.delete(peerId);
			offering(peerId);
			viaServer.add(peerId);
			const socket = current;
			room
				// Naming the peer lets a member who already holds a seat back
				// into a party that is full with them in it.
				.createInvite({ forPeer: peerId })
				.then(({ code: sdp }) => socket.send(JSON.stringify({ t: "offer", to: peerId, sdp })))
				.catch((err) => {
					// No offer went out, so nothing is in flight and the next
					// notice may retry. A full party says so, or the newcomer
					// would wait out the deadline and hear "nobody answered".
					doneOffering(peerId);
					const theirs = glared.get(peerId);
					glared.delete(peerId);
					if (err?.reason === "full") {
						try {
							socket.send(JSON.stringify({ t: "full", to: peerId }));
						} catch {}
					} else if (theirs) {
						// We set their offer aside for ours, and ours never
						// went: theirs is the pair's only one now.
						answerOffer(peerId, theirs);
					}
				});
		};

		/** Answer a member's offer exactly as the `#i=` flow does. */
		const answerOffer = (from, sdp) => {
			if (dead || room.closed) return;
			clearTimeout(answering.get(from));
			answering.set(
				from,
				setTimeout(() => answering.delete(from), ANSWERING_MS),
			);
			viaServer.add(from);
			room
				.answerInvite(sdp)
				.then((reply) => current.send(JSON.stringify({ t: "answer", to: from, sdp: reply })))
				.catch(() => {}); // a malformed offer: the offerer can re-offer
		};

		/**
		 * The signalling socket dropped without the room leaving — a server
		 * restart, a flaky network, an eviction. The mesh does not care; only
		 * our future rejoin claim and the next newcomer's offer ride this
		 * socket, so quietly re-dial with the same claim and carry on. A room
		 * that ended answers "no-room", and that is the one answer that stops
		 * the loop rather than scheduling the next one.
		 */
		const redial = () => {
			if (dead || room.closed) return;
			const delay = retry;
			retry = Math.min(retry * 2, RETRY_CAP_MS);
			clearTimeout(redialTimer);
			redialTimer = setTimeout(attempt, delay);
		};
		let dialling = false;
		const attempt = async () => {
			redialTimer = null;
			if ((dead || room.closed) && !owedLeave) return;
			dialling = true;
			let again;
			try {
				again = await dial(code, { t: "join", id, secret });
			} catch (err) {
				dialling = false;
				if (dead || room.closed) {
					owedLeave = false;
					return void settleOwed(); // unreachable: the claim lapses instead
				}
				// An unreachable server is worth another try. So is
				// "blocked": a valid claim is never charged (worker/hub.js),
				// so it only means the server could not check ours just then
				// — a gate outage, a claim pruned under us — and giving up
				// would end signalling for good over a passing refusal. The
				// backoff caps it at one try per RETRY_CAP_MS. A room that
				// refused us outright ("no-room", "full", "id-taken") will
				// refuse the next try too: that is the answer, not a loop.
				if (err.reason === "unreachable" || err.reason === "blocked") return redial();
				dead = true;
				gaveUp = true;
				if (err.reason === "no-room") clearToken();
				room.onError?.(err.message);
				return;
			}
			dialling = false;
			if (dead || room.closed) {
				// Left while this dial was out. A leave that could not be
				// said on the old socket is said on this one; anything else
				// just hangs up and lets the seat wait, as a reload's does.
				if (owedLeave) {
					owedLeave = false;
					settleOwed(sendLeave(again.ws, id, secret));
				} else again.ws.close();
				return;
			}
			retry = RETRY_FIRST_MS;
			current = again.ws;
			wire(again.ws);
		};
		// The owed leave's receipt, in roomSettled's list from the moment it
		// is owed — a page that navigates right after leaving waits for it,
		// for about as long as releaseRejoin would (a probe's patience plus
		// the ack), not a full dial timeout: this is on the user's path.
		let settleOwed = () => {};
		const oweLeave = () => {
			owedLeave = true;
			const paid = new Promise((resolve) => (settleOwed = (p) => Promise.resolve(p).then(() => resolve())));
			const capped = Promise.race([paid, new Promise((r) => setTimeout(r, PROBE_TIMEOUT_MS + LEAVE_ACK_MS))]);
			pendingLeaves.add(capped);
			capped.then(() => pendingLeaves.delete(capped));
			// A dial in flight pays it when it lands. Otherwise dial now —
			// whether a redial was only scheduled (no point waiting out the
			// backoff) or the old socket is still closing and nothing is
			// scheduled at all (sendLeave has just detached its onclose).
			if (dialling) return;
			clearTimeout(redialTimer);
			attempt();
		};

		/**
		 * Another tab of this browser holds the same rejoin token and has
		 * just reconnected with it; the server gave it the seat and hung up
		 * on us (4409, worker/hub.js `bind`). Redialling would take the seat
		 * straight back, and the two tabs would trade it every second for
		 * as long as both stay open. So this tab stands down, and stays
		 * down: its links are closed *without* a goodbye (`detach`, not
		 * `leave`), because the member id they carried lives on in the
		 * other tab — a goodbye would tell the party to drop it. The claim
		 * and the token are the other tab's now, so neither is touched.
		 */
		const displaced = () => {
			if (dead || room.closed) return;
			holding = true;
			dead = true;
			if (settleJoin) return settle("displaced"); // the join's tail detaches
			room.detach();
			if (opts.onDisplaced) opts.onDisplaced();
			else opts.onError?.(ERRORS.displaced);
		};

		/**
		 * The room server's messages, in net.js terms. Every path here ends
		 * in an existing net.js method — the offer is the same packed string
		 * a human used to carry, which is why the scan/paste flow and this
		 * one can never drift apart.
		 */
		const wire = (socket) => {
			// Offers made on the previous socket went to a server that has
			// since forgotten it; whoever is still waiting will be announced
			// again, and must find no stale guard in the way.
			for (const timer of inflight.values()) clearTimeout(timer);
			inflight.clear();
			glared.clear();
			socket.onmessage = (e) => {
				let msg;
				try {
					msg = JSON.parse(e.data);
				} catch {
					return;
				}
				if (msg.t === "peer") {
					room.serverPeerState(msg.id, msg.connected);
					if (!msg.connected) {
						doneOffering(msg.id);
						glared.delete(msg.id);
						doneAnswering(msg.id);
					}
					else if (msg.offering === room.selfId) offerTo(msg.id);
				} else if (msg.t === "full") {
					// Only news while we are still waiting to get in; a member
					// already inside has nothing to learn from it.
					settle("full");
				} else if (msg.t === "offer") {
					// Glare: both ends of a pair were told to offer — two
					// isolated members re-announced together. The lower id's
					// offer stands and the higher id answers it, so exactly one
					// link is made; two would each close the other's.
					// Theirs is kept, not dropped: if ours fails to be made,
					// it is answered after all (see offerTo).
					if (inflight.has(msg.from) && room.selfId < msg.from) {
						glared.set(msg.from, msg.sdp);
						return;
					}
					// Somebody is offering us a link.
					answerOffer(msg.from, msg.sdp);
				} else if (msg.t === "answer") {
					room.acceptAnswer(msg.sdp).catch(() => {}); // stale slot: ignored, as a stale paste is
				}
			};
			socket.onclose = (e) => {
				if (socket !== current || retired.has(socket)) return;
				// 4409: the server replaced this socket with a newer one for
				// the same claim. Our own replacements never get here —
				// rejoinServer retires the socket it closes, and a redial's
				// predecessor had already closed, which is why it redialled —
				// so a 4409 on the current socket means another tab.
				if (e?.code === 4409) return displaced();
				redial();
			};
			socket.onerror = () => {}; // onclose handles it; one verdict is enough
		};

		wire(ws);
		writeToken({ code, id, secret });

		if (joined) {
			const timer = setTimeout(() => settle("no-answer"), opts.answerTimeoutMs ?? JOIN_ANSWER_MS);
			// Synchronous on purpose: by the time abort() returns, the seat has
			// been handed back and the token is gone, so a caller that
			// navigates straight after leaves nothing claimed behind it.
			const onAbort = () => {
				if (!settleJoin) return;
				settle("aborted");
				room.leave();
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			const outcome = await joined;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			if (outcome === "displaced") {
				room.detach();
				throw failure("displaced");
			}
			if (outcome !== "ok") {
				// A rejoin nobody answered keeps its seat and its token (see
				// `holding`). A first join gives the seat back rather than
				// hold it for a party that is not there; a full party has no
				// seat to keep.
				if ((outcome === "no-answer" || outcome === "no-route") && rejoin) holding = true;
				room.leave(); // a no-op after an abort, which already left
				const err = failure(outcome);
				if (outcome === "no-route" && routeError) err.message = routeError;
				throw err;
			}
		}
		return { room, code };
	}

	/**
	 * Host a room and draw its code. The client draws the code, not the
	 * server: a collision answers "taken" and this redraws, which is one
	 * retry on a one-in-a-million event rather than a server-side mint
	 * nobody can check.
	 */
	NeonArcade.hostRoom = async (opts = {}) => {
		const secret = randToken();
		for (let attempt = 0; attempt < 3; attempt++) {
			const code = String(100000 + Math.floor(Math.random() * 900000));
			try {
				return await makeRoom(code, { role: "host", id: randToken(), secret, opts });
			} catch (err) {
				if (err.reason !== "taken") throw err;
			}
		}
		throw failure("taken");
	};

	/**
	 * Join a room by its code. A token for this same code means a rejoin:
	 * the old member id is adopted rather than minted, so the seat, the
	 * team and the name the party record still holds are the ones that come
	 * back. A different token is simply overwritten — a browser that joins a
	 * new party has left the old one.
	 *
	 * Resolves once a data channel to the party is open *and* the party has
	 * a host this browser knows of; rejects with `err.reason` "no-answer" if
	 * that has not happened within `opts.answerTimeoutMs` (default
	 * JOIN_ANSWER_MS) of the server's "joined", "no-route" as soon as the
	 * party answered but the link failed (two NATs with no path between
	 * them — there is no TURN), and "full" if the member asked to offer
	 * says the party has no seat. A rejoin's "no-answer" or "no-route"
	 * keeps the claim and the token, for a retry; every other failure gives
	 * the seat back.
	 *
	 * `opts.signal` (an AbortSignal) cancels a join still in progress: the
	 * seat is released, the token cleared, and the promise rejects
	 * "aborted".
	 */
	NeonArcade.joinRoom = async (code, opts = {}) => {
		if (!/^\d{6}$/.test(code ?? "")) throw failure("bad-code");
		const token = readToken();
		const rejoin = token?.code === code;
		const id = rejoin ? token.id : randToken();
		const secret = rejoin ? token.secret : randToken();
		return makeRoom(code, { role: "join", id, secret, rejoin, opts });
	};

	/**
	 * Give back the seat the rejoin token claims, and drop the token. For a
	 * page that holds a claim but no room — a rejoin nobody answered — and
	 * is about to start over: without this the old party keeps a seat for a
	 * browser that will never come back to it, until the TTL.
	 *
	 * Resolves "busy" when the seat is live in another tab of this browser
	 * (same localStorage, same token): the server touched nothing, and the
	 * token is kept, because it is that tab's. The caller must not start a
	 * party over it either — a new party's token would replace it, and the
	 * other tab's next reload would walk into this tab's party. Anything
	 * else resolves "released", or "none" when there was nothing to give
	 * back or no server to give it to (best-effort and bounded: the claim
	 * then lapses), and the token is gone.
	 *
	 * A `release`, never `join` + `leave`: a join binds the seat, which
	 * hung up the live tab holding it (worker/hub.js `releaseClaim`).
	 */
	NeonArcade.releaseRejoin = async () => {
		const token = readToken();
		let outcome = "none";
		if (token && (mock() || resolveBase())) {
			try {
				const { ws, reply } = await dial(
					token.code,
					{ t: "release", id: token.id, secret: token.secret },
					PROBE_TIMEOUT_MS + LEAVE_ACK_MS,
				);
				outcome = reply.t;
				try {
					ws.close();
				} catch {}
			} catch {}
		}
		if (outcome !== "busy") clearToken();
		return outcome;
	};

	/** A room code handed over as a link fragment, like the invite's `#i=`. */
	NeonArcade.codeFromUrl = () => location.hash.match(/[#&]c=(\d{6})/)?.[1] ?? null;

	// ------------------------------------------------------------- the mock

	/**
	 * An in-page room server for the tests: the real protocol, the real
	 * client, no network. It mirrors the rules of worker/hub.js the client
	 * can observe — codes, claims, release, notices with `offering` (the
	 * oldest attached member other than the subject), offer/answer/full relay,
	 * socket drops as `connected:false` — and deliberately not the ones only
	 * a server under attack or a clock can exhibit (rate limits, TTLs,
	 * pruning), which scripts/test-hub.mjs covers against the real hub.
	 * (It cannot simply *be* hub.js: that is an ES module, and module
	 * scripts do not load on file://.)
	 *
	 * `drop(id)` kills a member's socket from the server side, which is what
	 * a reload or a dead network looks like to everyone else.
	 */
	function makeMockRoomServer() {
		const rooms = new Map(); // code -> Map(id -> { id, secret, socket, joinedAt })

		const send = (socket, msg) => setTimeout(() => socket.onmessage?.({ data: JSON.stringify(msg) }), 0);
		const announce = (room, member) => {
			const others = [...room.values()]
				.filter((m) => m.socket && m.id !== member.id)
				.sort((a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : 1));
			if (!others.length) return;
			const msg = { t: "peer", id: member.id, connected: !!member.socket, offering: others[0].id };
			for (const m of others) send(m.socket, msg);
		};
		const attach = (room, socket, { id, secret }) => {
			let member = room.get(id);
			if (member && member.secret !== secret) return { t: "error", reason: "id-taken" };
			if (!member) {
				if (room.size >= 8) return { t: "error", reason: "full" };
				member = { id, secret, joinedAt: Date.now() };
				room.set(id, member);
			}
			// A second socket for the same claim replaces the first, which
			// is hung up with 4409, as the hub does (bind).
			const stale = member.socket;
			member.socket = socket;
			if (stale && stale !== socket) stale.close(4409);
			announce(room, member);
			return null;
		};

		return {
			rooms,
			drop(id) {
				for (const room of rooms.values()) room.get(id)?.socket?.close();
			},
			connect(path) {
				const code = path.match(/\/room\/(\d{6})$/)?.[1];
				const ws = {
					readyState: 0,
					onopen: null,
					onmessage: null,
					onclose: null,
					onerror: null,
					send(raw) {
						let msg;
						try {
							msg = JSON.parse(raw);
						} catch {
							return;
						}
						const room = rooms.get(code);
						const me = [...(room?.values() ?? [])].find((m) => m.socket === ws);
						if ((msg.t === "host" || msg.t === "join" || msg.t === "release") && msg.code !== code) {
							send(ws, { t: "error", reason: "bad-code" });
						} else if (msg.t === "release") {
							// releaseClaim: verified without binding; a live
							// seat is somebody's, and is left alone.
							const member = room?.get(msg.id);
							if (!member || member.secret !== msg.secret) {
								send(ws, { t: "error", reason: room ? "no-claim" : "no-room" });
							} else if (member.socket) {
								send(ws, { t: "busy" });
							} else {
								room.delete(member.id);
								announce(room, member);
								if (!room.size) rooms.delete(code);
								send(ws, { t: "released" });
							}
						} else if (msg.t === "host") {
							if (room) return send(ws, { t: "error", reason: "taken" });
							const fresh = new Map();
							rooms.set(code, fresh);
							const refused = attach(fresh, ws, msg);
							if (refused) rooms.delete(code);
							send(ws, refused ?? { t: "room", code });
						} else if (msg.t === "join") {
							if (!room) return send(ws, { t: "error", reason: "no-room" });
							send(ws, attach(room, ws, msg) ?? { t: "joined" });
						} else if (msg.t === "offer" || msg.t === "answer") {
							const to = room?.get(msg.to);
							if (me && to?.socket) send(to.socket, { t: msg.t, from: me.id, sdp: msg.sdp });
						} else if (msg.t === "full") {
							const to = room?.get(msg.to);
							if (me && to?.socket) send(to.socket, { t: "full", from: me.id });
						} else if (msg.t === "leave") {
							if (me && me.id === msg.id && me.secret === msg.secret) {
								room.delete(me.id);
								me.socket = null;
								announce(room, me);
								if (!room.size) rooms.delete(code);
							}
							ws.close();
						}
					},
					close(status = 1000) {
						if (ws.readyState === 3) return;
						ws.readyState = 3;
						// Find this socket's member by the socket, not an id the
						// closer no longer has: a release or a dead socket has none.
						for (const m of rooms.get(code)?.values() ?? []) {
							if (m.socket === ws) {
								m.socket = null;
								announce(rooms.get(code), m);
							}
						}
						setTimeout(() => ws.onclose?.({ code: status }), 0);
					},
				};
				setTimeout(() => {
					if (ws.readyState !== 3) {
						ws.readyState = 1;
						ws.onopen?.();
					}
				}, 0);
				return ws;
			},
		};
	}

	// The test hook: with ?mockroom=1 the page carries its own room server,
	// so every client path above runs without a deploy. The fake camera in
	// test-scan.mjs is the precedent: the real code under test, the transport
	// faked, no network involved. A deployed page never carries the param,
	// and a user who types it in gets a server that talks to nobody but
	// their own tab.
	if (new URLSearchParams(location.search).has("mockroom")) {
		window.__neonRoomMock = makeMockRoomServer();
	}
})();
