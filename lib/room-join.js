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
	// rejoin that was about to succeed is told nobody answered. It also has
	// to hold a role-swapped second try after a failed first (net.js
	// SWAP_WAIT_MS): ICE's own verdict (~15-18 s) plus a gather and a connect
	// on the swapped pair (~3-5 s). On top of a stale-link wait that is
	// ~31-36 s, so a swap under way when this falls gets SWAP_WAIT_MS (8 s)
	// more, once: 38 s is the worst case, and it still always ends in a
	// verdict — "no-route", with the first try's reason, when the swap is
	// what was still out. A first try still undecided at 30 s (no failure
	// yet, so no swap) ends "no-answer" as before; RETRY recovers it.
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
	// A leave owed mid-redial is paid with a `release` (see oweLeave). Its
	// `busy` may be our own old socket the server has not seen close yet,
	// so it is asked again this often, at most this many times: tries at
	// 0, 1.5, 3 and 4.5 s. Navigation waits for it at most OWED_LEAVE_MS —
	// the last try's start plus LEAVE_ACK_MS for its answer, 6 s — and only
	// that long when the seat stays busy throughout (another tab holds it
	// live, or a server that never notices our socket died). Otherwise one
	// round trip.
	const RELEASE_RETRY_MS = 1500;
	const RELEASE_TRIES = 4;
	const OWED_LEAVE_MS = RELEASE_RETRY_MS * (RELEASE_TRIES - 1) + LEAVE_ACK_MS;
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
	// How long an offer of ours may go unanswered while we hold the peer's
	// own offer set aside for it (`glared`) before we give ours up and
	// answer theirs. Between two current clients it never fires: the side
	// whose offer stands is answered within the far side's gather
	// (net.js ICE_TIMEOUT_MS, 4 s, at most) plus two hops through the
	// server, and this is counted from our offer leaving, so 6 s clears
	// that with room. It exists for a far side that never answers ours: a
	// tab still on an older build (it cannot read the `h.`/`r.` marks and
	// drops the offer without a word) — or one whose answer was lost. The
	// pair then has the peer's offer, answered, instead of waiting for the
	// OFFERING_MS backstop and a join that ends `no-answer`.
	const GLARE_FALLBACK_MS = 6000;
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
		// A `/room/new` socket that said `host` only after its code's hold
		// (RESERVE_MS, 15 s) lapsed: a stalled connection, worth a retry.
		expired: "The room server took too long to open the party. Try again.",
		unreachable: "Could not reach the room server.",
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
	 * Two members' offers crossed (glare): whose stands? A hard-NAT offer
	 * (net.js classifyNat; `h.` on the code) over a plain one, because a
	 * port-dependent mapping connects only as the ICE offerer — the lower
	 * id's rule made that a coin flip, and half the reloads across such a
	 * pair took the failing direction and waited ~18 s for the role swap
	 * (docs/network-testing.md, 2026-11-12). Both or neither hard: the lower
	 * id's, as before. Both ends compute the same answer from the same two
	 * marks, so exactly one offer stands.
	 */
	const glareWinner = (a, aHard, b, bHard) => (aHard !== bHard ? (aHard ? a : b) : a < b ? a : b);
	// Exposed for tests (test-room's glare preference).
	NeonArcade._glareWinner = glareWinner;

	/**
	 * Open the signalling socket — to the room server, or to the mock, which
	 * is the same protocol in one page — send `hello`, and wait for the one
	 * reply that settles it. Resolves { ws, reply } on "room", "joined",
	 * "released" or "busy"; rejects with the protocol's reason on an error reply, and
	 * "unreachable" on a socket that could not be made, died first, or
	 * stayed silent past `timeoutMs`. Every failure is a verdict; none is a
	 * wait. (An upgrade refused past a rate budget is not "unreachable":
	 * the routing Worker accepts that socket itself to say `blocked`, since
	 * a browser never sees the HTTP status — worker/index.js `refusal`.)
	 *
	 * `code` "new" is hosting: the server draws the code and names it in
	 * the "room" reply. `pass` ({pass, exp}, from an earlier reply) rides
	 * the URL — the routing Worker reads it before anything else, so a
	 * member's re-dial is never charged against its address's dial budget
	 * (worker/index.js). It is not the claim: the secret stays in the
	 * message, and a pass alone seats nobody.
	 */
	function dial(code, hello, timeoutMs = DIAL_TIMEOUT_MS, pass = null) {
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
			const query = pass?.pass ? "?" + new URLSearchParams({ id: hello.id, exp: pass.exp, pass: pass.pass }) : "";
			const path = `/room/${code}${query}`;
			try {
				ws = mock() ? mock().connect(path) : new WebSocket(resolveBase() + path);
			} catch {
				return fail("unreachable");
			}
			ws.onopen = () => ws.send(JSON.stringify(code === "new" ? hello : { ...hello, code }));
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
	 * server ever sees the secret, hashed at that. `pass`/`exp`, when the
	 * server issued them, are the member pass every re-dial presents (see
	 * dial); refreshed by every seat the server grants.
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
	/** The token's pass, as dial takes it, or null. */
	const passOf = (token) => (token?.pass ? { pass: token.pass, exp: token.exp } : null);
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
	async function makeRoom(code, { role, id, secret, rejoin = false, pass = null, opts }) {
		if (!mock() && !resolveBase()) throw failure("unreachable");
		const { signal } = opts;
		if (signal?.aborted) throw failure("aborted");
		// This network's NAT (net.js classifyNat), asked now and in
		// parallel: nothing waits on it. Until it answers, room.natHard is
		// null and the glare rule is the plain lower-id one. A caller (a
		// test) may pin it with `natHard` instead.
		const natPinned = opts.natHard !== undefined;
		const natClass = natPinned ? null : NeonArcade.classifyNat?.(opts.iceServers);
		let ws;
		let reply;
		try {
			({ ws, reply } = await dial(code, { t: role, id, secret }, DIAL_TIMEOUT_MS, pass));
		} catch (err) {
			throw signal?.aborted ? failure("aborted") : err;
		}
		// A host dialled "new"; the server's reply names the code it drew.
		if (role === "host") {
			if (!/^\d{6}$/.test(reply.code ?? "")) {
				try {
					ws.close();
				} catch {}
				throw failure("unreachable");
			}
			code = reply.code;
		}
		// The newest pass the server issued for this seat, for every re-dial.
		const takePass = (r) => {
			if (r?.pass) pass = { pass: r.pass, exp: r.exp };
		};
		takePass(reply);
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
		// that went stale long ago. Ours, if nobody answered it, is closed
		// (net.js dropInvites): an invite never expires on its own.
		// Not kept for later, though: an offer of theirs still set aside
		// when the backstop falls, for an offer of ours they never answered,
		// is the pair's only one, and is answered then (an older build that
		// could not read ours — see GLARE_FALLBACK_MS, which normally gets
		// there first).
		const offering = (peerId) =>
			inflight.set(
				peerId,
				setTimeout(() => {
					const theirs = answered.has(peerId) ? null : glared.get(peerId);
					inflight.delete(peerId);
					answered.delete(peerId);
					glared.delete(peerId);
					unsent(peerId);
					room.dropInvites(peerId);
					if (theirs) answerOffer(peerId, theirs);
				}, opts.offerBackstopMs ?? OFFERING_MS),
			);
		const doneOffering = (peerId) => {
			clearTimeout(inflight.get(peerId));
			inflight.delete(peerId);
			answered.delete(peerId);
			unsent(peerId);
		};
		// Offers of ours that have left (not still gathering), and, for those
		// that left while we hold the peer's own offer set aside, the
		// GLARE_FALLBACK_MS timer that answers theirs if ours is not.
		const sent = new Set();
		const fallbacks = new Map(); // peerId -> timer
		const unsent = (peerId) => {
			sent.delete(peerId);
			clearTimeout(fallbacks.get(peerId));
			fallbacks.delete(peerId);
		};
		// Armed from whichever comes later — ours leaving, theirs set aside —
		// so the far side always has the full GLARE_FALLBACK_MS to answer.
		const armFallback = (peerId) => {
			if (!sent.has(peerId) || !glared.has(peerId) || fallbacks.has(peerId)) return;
			fallbacks.set(
				peerId,
				setTimeout(() => {
					fallbacks.delete(peerId);
					const theirs = glared.get(peerId);
					if (!theirs || !inflight.has(peerId) || answered.has(peerId)) return;
					// Ours is withdrawn first, so the pair is left with one
					// offer: theirs, answered.
					glared.delete(peerId);
					doneOffering(peerId);
					room.dropInvites(peerId);
					answerOffer(peerId, theirs);
				}, opts.glareFallbackMs ?? GLARE_FALLBACK_MS),
			);
		};
		// Offers in flight that the peer has answered: negotiating directly
		// now, whatever becomes of our socket (see wire). Not a glare
		// exemption — only the marked retry is one.
		const answered = new Set();
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
		// say so on while a redial was already on the wire: that join binds
		// whatever we do, so the socket it lands with carries the leave (see
		// attempt). A leave with no dial out pays with a release instead.
		let owedLeave = false;
		// The pending redial's timer, so a leave can cancel it.
		let redialTimer = null;
		// Set when a redial was refused for good (no-room, full, id-taken).
		// The server has no seat of ours to hand back, so a later leave owes
		// nothing — dialling to pay it would be charged as a guess and hold
		// up navigation. (A `join`, as it once was, could even seat us in
		// whatever party re-hosted the code meanwhile.)
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
			unwatchNetwork();
			if (!holding && RELEASING.has(reason)) {
				// Mid-redial the socket is not open, so sendLeave can say
				// nothing on it. Without more, the dial in flight would land,
				// be hung up without a word, and the party would hold a seat
				// for 5 minutes for somebody who left. So the leave is owed
				// (see oweLeave).
				// So is one while rejoinServer's dial is out: `current` is
				// then the retired socket that dial is about to replace.
				if ((current.readyState !== 1 || retired.has(current)) && !gaveUp) oweLeave();
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
		// Set when a join's first try failed and the role-swapped second
		// one is under way (onRouteFailed).
		let swapping = false;
		const onError = (message, info) => {
			if (settleJoin && info?.reason === "no-route") {
				routeError = message;
				return settle("no-route");
			}
			opts.onError?.(message, info);
		};
		/**
		 * A link negotiated over this socket failed ICE on its first try
		 * (net.js `_routeFailed`). Some NATs open only to a peer whose
		 * checks arrive first, so the direction can decide it: the side that
		 * answered offers back, once, over this socket; the side that offered
		 * waits for that offer (net.js holds its verdict SWAP_WAIT_MS). Only
		 * for a member we reached through the server and only while our
		 * socket is up — otherwise there is no path to swap over and the
		 * failure stands.
		 */
		const onRouteFailed = (peerId, { offered, message }) => {
			if (dead || room.closed || !viaServer.has(peerId) || current.readyState !== 1) return false;
			// Kept for the deadline: a join whose second try is still out
			// when it falls says why the first failed, not "nobody answered",
			// and gets SWAP_WAIT_MS more first (see the deadline below).
			if (settleJoin) {
				routeError = message;
				swapping = true;
			}
			// Any offer of ours to them is spent: the failed one, or one
			// their glare rule set aside.
			doneOffering(peerId);
			glared.delete(peerId);
			if (!offered) {
				doneAnswering(peerId);
				offerTo(peerId, 0, true);
			}
			return true;
		};
		// Sockets given up on by rejoinServer: their late close is not news.
		const retired = new WeakSet();
		// Members a retired socket told us to offer to, offered once the dial
		// replacing it lands. That dial can be held up for seconds — a
		// blackout holds its SYN back — while the old socket still delivers.
		// Offered at once, the invite was gathered on a network that did not
		// work (host candidates only: STUN never answered); answered once it
		// came back, it set the peer's `answering` guard, which muted the
		// peer's own offer on our re-announce, and then failed — the pair's
		// only offer, and no route for good (NAT lab scenario 5,
		// 2026-11-12). Deferred, not dropped: the notice is still the
		// server's word that *we* offer (a member returning while our dial is
		// out — test-room 6e9), and a landed dial proves the network works.
		const owed = new Set();
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
		 *
		 * Dial first, hang up after: the new socket's join replaces the old
		 * one on the server (worker/hub.js `bind`, a 4409 we ignore — the old
		 * socket is retired), so our seat is never unattended. It used to be
		 * closed first and re-dialled RETRY_FIRST_MS later, and a member
		 * returning inside that gap found nobody attached; when we came back
		 * the server named *them* to offer (2026-11-12: a guest's reload
		 * made the returning guest the offerer, the direction a port-
		 * dependent carrier NAT on the host's side cannot connect in).
		 */
		const rejoinServer = () => {
			if (dead || room.closed) return;
			const socket = current;
			// Not open: its close is already scheduling the re-dial.
			if (socket.readyState !== 1 || retired.has(socket)) return;
			retired.add(socket);
			// Isolated is also what a network change looks like: ask again.
			reclassify();
			clearTimeout(redialTimer);
			retry = RETRY_FIRST_MS;
			// Replaced, or the dial failed and attempt has scheduled the next
			// one: either way the old socket's part is over.
			attempt({ replacing: true }).finally(() => {
				try {
					socket.close();
				} catch {}
			});
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
			onRouteFailed,
		};
		delete roomOpts.signal;
		const room = role === "host" ? NeonArcade.createHost(roomOpts) : NeonArcade.createGuest(roomOpts);
		// The newest classification asked for wins; an older one that lands
		// late is ignored. Until a re-ask answers, the last verdict stands.
		let natAsks = 0;
		const takeNat = (asked) => {
			const ask = ++natAsks;
			asked?.then((hard) => {
				if (ask === natAsks && !room.closed) room.natHard = hard;
			});
		};
		takeNat(natClass);
		/**
		 * Ask again (net.js classifyNat, `fresh`): the network may have
		 * changed under us — a phone off mobile data onto Wi-Fi is no longer
		 * behind the carrier's hard NAT, and a stale "hard" would keep
		 * offering back in the direction that now fails. Asked when we find
		 * ourselves isolated (rejoinServer) and on the browser's own news of
		 * a network change. Never for a room given `natHard`.
		 */
		const reclassify = () => {
			if (dead || room.closed) return void unwatchNetwork();
			if (natPinned) return;
			takeNat(NeonArcade.classifyNat?.(opts.iceServers, { fresh: true }));
		};
		const connection = navigator.connection;
		const unwatchNetwork = () => {
			removeEventListener("online", reclassify);
			connection?.removeEventListener?.("change", reclassify);
		};
		if (!natPinned) {
			addEventListener("online", reclassify);
			connection?.addEventListener?.("change", reclassify);
		}
		// The network is back: a redial waiting out its backoff (up to
		// RETRY_CAP_MS) goes now, from the first step again. Nothing else
		// changes — a socket that is open, or a dial on the wire, is left be.
		const redialNow = () => {
			if (dead || room.closed) return void removeEventListener("online", redialNow);
			if (!redialTimer) return;
			clearTimeout(redialTimer);
			retry = RETRY_FIRST_MS;
			attempt();
		};
		addEventListener("online", redialNow);

		/**
		 * Offer to a member the server says we should — exactly the role any
		 * member plays when they stand next to a newcomer and press ADD
		 * PLAYER. A link we still hold to them is either live (a signalling
		 * hiccup: no offer needed, the link outranks the server) or the
		 * leftover of a reload that has not closed yet; we cannot tell which
		 * at once, so we watch it for a while and offer the moment it closes.
		 */
		// Whether our offer in flight to a member carried the hard mark —
		// fixed when the offer is begun, so the glare rule weighs what the
		// far side will actually read, even if classification lands while
		// the offer is still gathering.
		const offeredHard = new Map(); // peerId -> bool
		const offerTo = (peerId, polls = 0, retry = false) => {
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
			const hard = room.natHard === true;
			offeredHard.set(peerId, hard);
			room
				// Naming the peer lets a member who already holds a seat back
				// into a party that is full with them in it.
				.createInvite({ forPeer: peerId, retry, hard })
				// On whichever socket is ours once the offer is gathered: a
				// rejoinServer meanwhile replaced the one we had (and closed
				// it), and the server relays from the new one just the same.
				.then(({ code: sdp }) => {
					current.send(JSON.stringify({ t: "offer", to: peerId, sdp }));
					if (!inflight.has(peerId)) return;
					sent.add(peerId);
					armFallback(peerId);
				})
				.catch((err) => {
					// Dropped while gathering (dropInvites): whoever dropped
					// it has settled the guards already, perhaps for a newer
					// offer to the same member.
					if (err?.reason === "withdrawn") return;
					// No offer went out, so nothing is in flight and the next
					// notice may retry. A full party says so, or the newcomer
					// would wait out the deadline and hear "nobody answered".
					doneOffering(peerId);
					const theirs = glared.get(peerId);
					glared.delete(peerId);
					if (err?.reason === "full") {
						try {
							current.send(JSON.stringify({ t: "full", to: peerId }));
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
				.answerInvite(sdp, { watch: true })
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
			redialTimer = setTimeout(() => attempt(), delay);
		};
		let dialling = false;
		// `replacing`: rejoinServer's dial, made while our socket was still
		// open. The join binds in its place without a gap (the server hangs
		// the old one up, 4409, before it answers), so the offers the peer
		// answered still stand (see wire).
		const attempt = async ({ replacing = false } = {}) => {
			redialTimer = null;
			if (dead || room.closed) return;
			dialling = true;
			let again;
			try {
				again = await dial(code, { t: "join", id, secret }, DIAL_TIMEOUT_MS, pass);
			} catch (err) {
				dialling = false;
				if (dead || room.closed) {
					owedLeave = false;
					return void settleOwed(); // the claim lapses instead
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
				// Left while this dial was out. The join has bound the seat
				// already — whatever it displaced, it displaced as any redial
				// would — so the seat is ours, and this socket says the leave
				// the old one could not. Anything else just hangs up and lets
				// the seat wait, as a reload's does.
				if (owedLeave) {
					owedLeave = false;
					settleOwed(sendLeave(again.ws, id, secret));
				} else again.ws.close();
				return;
			}
			retry = RETRY_FIRST_MS;
			current = again.ws;
			takePass(again.reply);
			// Refreshed only while the token is still this seat's: another
			// tab may have started a different party over it meanwhile.
			const stored = readToken();
			if (stored?.code === code && stored.id === id) writeToken({ code, id, secret, ...pass });
			wire(again.ws, { replacing });
			// After wire: its guard sweep must not withdraw these.
			for (const peerId of [...owed]) {
				owed.delete(peerId);
				offerTo(peerId);
			}
		};
		/**
		 * Give the claim back without binding it: `{t:"release"}`, as
		 * releaseRejoin does (worker/hub.js `releaseClaim`). It used to be a
		 * `join` with the claim and then a `leave` — and when another tab of
		 * this browser had taken the seat meanwhile, that join hung the live
		 * tab up (4409) and the leave gave its seat away under it.
		 *
		 * `busy` means a socket is bound to the seat. Usually that is our
		 * own old one, closed here but not yet seen closing there, so ask
		 * again (RELEASE_TRIES, RELEASE_RETRY_MS apart). If it stays busy it
		 * is another tab's live seat, and it is left alone: never bound,
		 * never displaced. An error answer or an unreachable server ends it
		 * at once — nothing to give back, or nobody to give it to; the claim
		 * lapses with the seat grace. Never rejects.
		 */
		const releaseOwed = async () => {
			const deadline = Date.now() + OWED_LEAVE_MS;
			for (let tries = 1; ; tries++) {
				let reply;
				try {
					const done = await dial(code, { t: "release", id, secret }, Math.max(1, deadline - Date.now()), pass);
					reply = done.reply;
					try {
						done.ws.close();
					} catch {}
				} catch {
					return;
				}
				if (reply.t !== "busy" || tries >= RELEASE_TRIES) return;
				await new Promise((r) => setTimeout(r, RELEASE_RETRY_MS));
			}
		};
		// The owed leave's receipt, in roomSettled's list from the moment it
		// is owed — a page that navigates right after leaving waits for it,
		// for at most OWED_LEAVE_MS, not a full dial timeout: this is on the
		// user's path.
		let settleOwed = () => {};
		const oweLeave = () => {
			// A scheduled redial is cancelled: the room is left, and a join
			// would bind the seat (see releaseOwed).
			clearTimeout(redialTimer);
			redialTimer = null;
			let paid;
			if (dialling) {
				// A join already on the wire binds when it lands, and the
				// socket it lands with carries the leave (attempt).
				owedLeave = true;
				paid = new Promise((resolve) => (settleOwed = (p) => Promise.resolve(p).then(() => resolve())));
			} else paid = releaseOwed();
			const capped = Promise.race([paid, new Promise((r) => setTimeout(r, OWED_LEAVE_MS))]);
			pendingLeaves.add(capped);
			capped.then(() => pendingLeaves.delete(capped));
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
			unwatchNetwork();
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
		const wire = (socket, { replacing = false } = {}) => {
			// Offers made on the previous socket went to a server that has
			// since forgotten it; whoever is still waiting will be announced
			// again, and must find no stale guard in the way. Not so when
			// rejoinServer's dial replaced a socket still open: the seat
			// was never unattended, the offers it relayed still stand, and
			// clearing the guards would mint a second invite for a member
			// the re-announce names again — two links for one pair.
			// rejoinServer's dial replacing a socket still open is the one
			// exception, and only for an offer the peer has *answered*: that
			// pair is negotiating directly, and a fresh invite for the member
			// the re-announce names again would be a second link for it. An
			// unanswered one may have gone down a socket that was already
			// dead without our knowing (a network switch): kept, its guard
			// would block the re-offer until the backstop. Its invite is
			// closed instead, so the re-offer is the only one.
			for (const [peerId, timer] of [...inflight]) {
				if (replacing && answered.has(peerId)) continue;
				clearTimeout(timer);
				inflight.delete(peerId);
				glared.delete(peerId);
				unsent(peerId);
				room.dropInvites(peerId);
			}
			socket.onmessage = (e) => {
				let msg;
				try {
					msg = JSON.parse(e.data);
				} catch {
					return;
				}
				if (msg.t === "peer") {
					if (msg.released) room.serverReleased(msg.id);
					room.serverPeerState(msg.id, msg.connected);
					if (!msg.connected) {
						doneOffering(msg.id);
						glared.delete(msg.id);
						doneAnswering(msg.id);
						// An offer of ours they never answered never will be
						// now: they come back with a fresh connection.
						room.dropInvites(msg.id);
						owed.delete(msg.id);
					}
					// Told down a socket rejoinServer is replacing: offered
					// once its dial lands (see `owed`), not now.
					else if (msg.offering === room.selfId) {
						if (retired.has(socket)) owed.add(msg.id);
						else offerTo(msg.id);
					}
				} else if (msg.t === "full") {
					// Only news while we are still waiting to get in; a member
					// already inside has nothing to learn from it.
					settle("full");
				} else if (msg.t === "offer") {
					// Glare: both ends of a pair were told to offer — two
					// isolated members re-announced together, or a reload's
					// returner and the member who stayed. One offer stands
					// and the other side answers it, so exactly one link is
					// made; two would each close the other's. Which one is
					// glareWinner's: a hard-NAT offer over a plain one (it
					// can only connect as the offerer), else the lower id's.
					// Theirs is kept, not dropped: if ours fails to be made,
					// it is answered after all (see offerTo).
					// The one exception is the role-swapped retry (marked in
					// the code itself, net.js isRetrySignal): they have our
					// offer, answered it, and its ICE failed — it often
					// arrives before our own end has noticed. Only the mark
					// says so: any other offer from a member who answered
					// ours is glare as usual, or the pair gets two links.
					const retry = NeonArcade._codec.isRetrySignal(msg.sdp);
					const theirsHard = NeonArcade._codec.isHardSignal(msg.sdp);
					if (inflight.has(msg.from) && !retry) {
						if (glareWinner(room.selfId, offeredHard.get(msg.from) === true, msg.from, theirsHard) === room.selfId) {
							glared.set(msg.from, msg.sdp);
							armFallback(msg.from);
							return;
						}
						// We are the higher id: the far side sets ours aside
						// for this one, so ours will never be answered.
						doneOffering(msg.from);
						room.dropInvites(msg.from);
					} else if (
						!retry &&
						!theirsHard &&
						room.natHard === true &&
						!answering.has(msg.from) &&
						!room.directPeers().includes(msg.from)
					) {
						// A plain offer, nothing of ours in flight, and our
						// network can only connect as the offerer: answering
						// would be the direction that fails (~15 s, then the
						// swap). Offer back instead, marked hard — on their
						// side ours meets theirs in flight and wins the glare
						// rule above, so they answer it and drop their own.
						// Bounded: only a hard side does this, never to a hard
						// offer, never to the retry. Theirs is set aside as
						// in glare, answered if ours cannot be made — or is
						// not answered in GLARE_FALLBACK_MS (an older build
						// on the far side cannot read the mark).
						glared.set(msg.from, msg.sdp);
						offerTo(msg.from);
						if (inflight.has(msg.from)) return;
						glared.delete(msg.from);
					}
					// Somebody is offering us a link.
					answerOffer(msg.from, msg.sdp);
				} else if (msg.t === "answer") {
					if (inflight.has(msg.from)) answered.add(msg.from);
					room.acceptAnswer(msg.sdp).catch(() => {}); // stale slot: ignored, as a stale paste is
				}
			};
			socket.onclose = (e) => {
				if (socket !== current || retired.has(socket)) return;
				// 4409: the server replaced this socket with a newer one for
				// the same claim. Our own replacements never get here —
				// rejoinServer retires the socket its dial replaces, and a redial's
				// predecessor had already closed, which is why it redialled —
				// so a 4409 on the current socket means another tab.
				if (e?.code === 4409) return displaced();
				redial();
			};
			socket.onerror = () => {}; // onclose handles it; one verdict is enough
		};

		wire(ws);
		writeToken({ code, id, secret, ...pass });

		if (joined) {
			// A first try that already failed for want of a route makes the
			// deadline's verdict "no-route" too: the swapped second try (see
			// onRouteFailed) is what was still out, and nobody failed to answer.
			// A swap under way when the deadline falls gets SWAP_WAIT_MS more,
			// once: its first try failed late (a stale-link wait, two gathers
			// and ICE's own ~15 s verdict use most of the 30 s), and the
			// second may be a second from connecting. Bounded, and net.js
			// reports the swap's own failure sooner anyway — always a verdict.
			let extended = false;
			const deadline = () => {
				if (swapping && !extended) {
					extended = true;
					timer = setTimeout(deadline, NeonArcade.SWAP_WAIT_MS);
					return;
				}
				settle(routeError ? "no-route" : "no-answer");
			};
			let timer = setTimeout(deadline, opts.answerTimeoutMs ?? JOIN_ANSWER_MS);
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
	 * Host a room. The server draws the code (`/room/new`) and names it in
	 * its reply. Until 2026-11-12 the client drew it and redrew on
	 * "taken" — which made every host a question about a code it chose,
	 * answered "dead" on success, so hosting had to be charged as a guess
	 * and an address that hosted a lot ran out of budget for its own
	 * members. A host now learns nothing about any other code.
	 */
	NeonArcade.hostRoom = (opts = {}) => makeRoom("new", { role: "host", id: randToken(), secret: randToken(), opts });

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
		return makeRoom(code, { role: "join", id, secret, rejoin, pass: rejoin ? passOf(token) : null, opts });
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
					passOf(token),
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
	 * can observe — server-drawn codes (`/room/new`), claims, release,
	 * member passes (issued with every seat, checked on every dial and
	 * logged in `dials`, never required), notices with `offering` (the
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
		const reserved = new Set(); // codes drawn for a `/room/new` socket, not yet hosted
		// Every connection: { code, pass: "valid" | "invalid" | "none" }, as
		// the routing Worker would judge it — the tests' window on whether
		// the client presents its pass.
		const dials = [];
		const PASS_TTL_MS = 24 * 60 * 60 * 1000;
		const passFor = (code, id) => ({ pass: `mock.${code}.${id}`, exp: Date.now() + PASS_TTL_MS });

		const send = (socket, msg) => setTimeout(() => socket.onmessage?.({ data: JSON.stringify(msg) }), 0);
		const announce = (room, member, extra = null) => {
			const others = [...room.values()]
				.filter((m) => m.socket && m.id !== member.id)
				.sort((a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : 1));
			if (!others.length) return;
			const msg = { t: "peer", id: member.id, connected: !!member.socket, offering: others[0].id, ...extra };
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
			dials,
			// An outage: while set, every dial fails as unreachable.
			down: false,
			drop(id) {
				for (const room of rooms.values()) room.get(id)?.socket?.close();
			},
			connect(path) {
				if (this.down) throw new Error("mock room server is down");
				const url = new URL(path, "https://mock.invalid");
				const fresh = url.pathname === "/room/new";
				let code = url.pathname.match(/^\/room\/(\d{6})$/)?.[1];
				if (fresh) {
					do code = String(100000 + Math.floor(Math.random() * 900000));
					while (rooms.has(code) || reserved.has(code));
					reserved.add(code);
				}
				const q = url.searchParams;
				dials.push({
					code: fresh ? "new" : code,
					pass: !q.has("pass")
						? "none"
						: q.get("pass") === `mock.${code}.${q.get("id")}` && Number(q.get("exp")) > Date.now()
							? "valid"
							: "invalid",
				});
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
						if ((msg.t === "join" || msg.t === "release") && msg.code !== code) {
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
								announce(room, member, { released: true });
								if (!room.size) rooms.delete(code);
								send(ws, { t: "released" });
							}
						} else if (msg.t === "host") {
							// Only a `/room/new` socket hosts, into the code
							// drawn for it; no client names one.
							if (!fresh || !reserved.has(code)) return send(ws, { t: "error", reason: "bad-code" });
							reserved.delete(code);
							const made = new Map();
							rooms.set(code, made);
							const refused = attach(made, ws, msg);
							if (refused) rooms.delete(code);
							send(ws, refused ?? { t: "room", code, ...passFor(code, msg.id) });
						} else if (msg.t === "join") {
							if (!room) return send(ws, { t: "error", reason: "no-room" });
							send(ws, attach(room, ws, msg) ?? { t: "joined", ...passFor(code, msg.id) });
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
								announce(room, me, { released: true });
								if (!room.size) rooms.delete(code);
							}
							ws.close();
						}
					},
					close(status = 1000) {
						if (ws.readyState === 3) return;
						ws.readyState = 3;
						if (fresh) reserved.delete(code); // never hosted: the code goes back
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
