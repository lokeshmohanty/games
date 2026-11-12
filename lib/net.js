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

/**
 * A readable default name for this browser/device. Used when the player has
 * not typed their own; kept short so it fits the 16-character name field.
 */
NeonArcade.defaultName = () => {
	const ua = navigator.userAgent;
	if (/android/i.test(ua)) return "Android";
	if (/iphone/i.test(ua)) return "iPhone";
	if (/ipad/i.test(ua)) return "iPad";
	if (/macintosh|mac os x/i.test(ua)) return "Mac";
	if (/windows/i.test(ua)) return "Windows";
	if (/linux/i.test(ua)) return "Linux";
	return "Player";
};

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
	// localStorage "neon.stun" = "host:port", or two of them comma-separated,
	// swaps in the lab's STUN servers. It exists for scripts/test-nat.mjs,
	// whose simulated networks cannot reach the public STUN servers; two
	// ports, like DEFAULT_ICE's two, let classifyNat see a port-dependent
	// mapping there too. Deliberately *not* a `?stun=` query param: a
	// link anybody can send would then pick a stranger's STUN server, which
	// can answer with a forged public address and quietly break every
	// connection (or, given `turn:…`, throw in RTCPeerConnection). Storage
	// is only reachable from this origin's own pages and a test harness.
	// Anything that is not a plain host:port list is ignored, so it stays STUN.
	const STUN_OVERRIDE = /^[a-z0-9.-]+:\d{1,5}$/i;
	const iceDefault = () => {
		let stun = null;
		try {
			stun = localStorage.getItem("neon.stun");
		} catch {}
		const list = (stun ?? "").split(",").map((s) => s.trim());
		return stun && list.length <= 2 && list.every((s) => STUN_OVERRIDE.test(s))
			? list.map((s) => ({ urls: "stun:" + s }))
			: DEFAULT_ICE;
	};

	// How long classifyNat may take. STUN normally answers in well under a
	// second; past this the verdict is whatever is certain by then.
	const NAT_CLASSIFY_MS = 5000;
	// How long after an address family's first mapping a second, different
	// one may still arrive. Chrome reports an identical mapping only once,
	// so "both servers saw the same port" is never an event — it is the
	// absence of a second port this long after the first. Both servers'
	// answers come within tens of milliseconds of each other on the
	// networks measured (2026-11-12); a hard NAT whose second answer is
	// later than this reads as not hard, which is the old rule (only
	// `true` changes anything), never a wrong "hard".
	const NAT_SOFT_SETTLE_MS = 2000;
	// Classifications, keyed by the STUN servers asked (a promise each): a
	// verdict holds for the servers it came from, and a caller with other
	// servers asks its own. `fresh` replaces one (room-join re-asks after
	// isolation and on a network change, so a phone that moves from mobile
	// to Wi-Fi does not stay "hard" for the life of the page).
	const natClasses = new Map();
	let natPinned = null; // a test's fixed classification (`_pinNat`), or null
	/**
	 * Does this network's NAT map one local port to a different public port
	 * per destination ("hard": endpoint- or port-dependent mapping)? Resolves
	 * true, false, or null when it cannot tell — fewer than two STUN servers,
	 * one of them silent or erroring, no RTCPeerConnection.
	 *
	 * One RTCPeerConnection, so one local socket per network, asks every STUN
	 * server in `iceServers` (DEFAULT_ICE: two hosts on two ports) where it
	 * appears from. A NAT that maps by endpoint shows the same public port to
	 * both, and Chrome reports that address once; a hard one shows two
	 * ports for the same base (same candidate foundation: base address and
	 * protocol) and public address. Such a network — the owner's carrier
	 * CGNAT (docs/network-testing.md) — can only connect as the ICE
	 * *offerer*, which room-join's glare rule uses (`room.natHard`). No
	 * traffic but STUN to servers already in the ICE config. Asked once per
	 * set of servers and remembered, unless `fresh`. A set that cannot tell
	 * (fewer than two STUN servers) resolves null without being remembered,
	 * so it never stands in for anybody else's.
	 */
	function classifyNat(iceServers = iceDefault(), { fresh = false } = {}) {
		if (natPinned) return natPinned;
		const urls = (iceServers ?? [])
			.flatMap((s) => [].concat(s?.urls ?? []))
			.filter((u) => /^stuns?:/i.test(u));
		if (urls.length < 2 || typeof RTCPeerConnection !== "function") return Promise.resolve(null);
		const key = [...new Set(urls)].sort().join(" ");
		if (!fresh && natClasses.has(key)) return natClasses.get(key);
		const asked = new Promise((resolve) => {
			let pc;
			try {
				pc = new RTCPeerConnection({ iceServers: urls.map((u) => ({ urls: u })) });
			} catch {
				return resolve(null);
			}
			const mapped = new Map(); // "foundation address" -> Set of public ports
			// Decided per address family ("4"/"6"): a family with a mapping
			// and no STUN error of its own is soft once it has settled. An
			// error vetoes only its own family — on a host with an IPv6
			// address and no IPv6 route (a Tailscale fd7a:… one, measured
			// 2026-11-12) every IPv6 request times out (701, ~40 s) while
			// IPv4 answered in 45 ms. An error whose family cannot be read
			// vetoes every family ("*"), as any error once did.
			const seen = new Set(); // families with a mapping
			const vetoed = new Set();
			const settles = [];
			let done = false;
			const familyOf = (a) => (!a ? null : a.includes(":") ? "6" : a.includes(".") ? "4" : null);
			const hard = () => [...mapped.values()].some((ports) => ports.size > 1);
			const soft = () => !vetoed.has("*") && [...seen].some((f) => !vetoed.has(f));
			const verdict = () => (hard() ? true : soft() ? false : null);
			const finish = (verdict) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				settles.forEach(clearTimeout);
				try {
					pc.close();
				} catch {}
				resolve(verdict);
			};
			pc.onicecandidate = (e) => {
				// Gathering complete: every server answered or gave up.
				if (!e.candidate) return finish(verdict());
				const [foundation, , proto, , address, port, , type] = e.candidate.candidate
					.replace(/^candidate:/, "")
					.split(" ");
				if (type !== "srflx" || proto?.toLowerCase() !== "udp") return;
				const key = `${foundation} ${address}`;
				if (!mapped.has(key)) mapped.set(key, new Set());
				mapped.get(key).add(port);
				if (hard()) return finish(true);
				const family = familyOf(address);
				if (!family || seen.has(family)) return;
				seen.add(family);
				// Settled with no second port and no error of its own: soft.
				// No need to wait out the other family's timeouts.
				settles.push(
					setTimeout(() => {
						if (hard()) finish(true);
						else if (!vetoed.has("*") && !vetoed.has(family)) finish(false);
					}, NAT_SOFT_SETTLE_MS),
				);
			};
			// The error's `address` is the local one that asked; a masked or
			// missing one that shows no family vetoes all (VERIFY what each
			// browser puts there — the real IPv6 timeouts above were read
			// from Chrome's errors, the family test is a stub's).
			pc.onicecandidateerror = (e) => vetoed.add(familyOf(e?.address) ?? "*");
			const timer = setTimeout(() => finish(verdict()), NAT_CLASSIFY_MS);
			try {
				pc.createDataChannel("nat");
				pc.createOffer()
					.then((o) => pc.setLocalDescription(o))
					.catch(() => finish(null));
			} catch {
				finish(null);
			}
		});
		natClasses.set(key, asked);
		return asked;
	}

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
	// A relayed negotiation that has not opened by now never will: the far
	// side was away, or the pair has no route. Abandoning it is what lets the
	// next roster change try again — a negotiation left pending would block
	// every later attempt for that pair, and hold a PeerConnection open forever.
	const RELAY_TIMEOUT_MS = 15000;
	// A pair whose ICE failed is tried once more with the roles swapped:
	// the side that answered offers. Some NATs open to a stranger only when
	// the stranger's checks arrive first — measured 2026-11-12 on a mobile
	// carrier CGNAT whose mapping follows the destination port: the pair
	// connected only when that side *offered*, because the answerer starts
	// its checks about a second earlier. The side that offered waits this
	// long for the swapped offer before it reports no route: the far side's
	// own failure lags ours by up to a second or two, then it gathers
	// (≤ ICE_TIMEOUT_MS) and its offer crosses the signalling path.
	const SWAP_WAIT_MS = 8000;
	// A link both ends have described that has still not opened by now is
	// treated as an ICE `failed` (see _armOpen). Chrome normally says
	// `failed` itself ~15 s into the checks (NAT lab, 2026-11-11: 15.4–17.4 s
	// from the start of a join, gathering included), and the watchdog must
	// not beat it: a slow first try may be the only direction a NAT allows.
	// But an *answering* link was seen sitting in `connecting` for 25 s+
	// without ever failing (2026-11-12, an offer whose candidates were
	// gathered in a blackout), and while it sits there the pair is "still
	// trying": no swap, no verdict. The clock starts once both descriptions
	// are in — the offerer on taking the answer, the answerer once its
	// answer is gathered — so this is Chrome's ~15 s plus 5 s of slack; a
	// link that works opens in a few seconds even on the lab's 10% loss /
	// 200 ms path. The answerer's clock runs only where a machine carries
	// its answer (room-join, `answerInvite(code, { watch: true })`): in the
	// scan/paste flow a person carries the reply back, routinely for longer
	// than this, and the offerer has not even seen it yet. "Opened" means
	// the data channel; a link whose ICE is up when the clock runs out may
	// be DTLS/SCTP retrying under loss, so it gets one more period. Relayed
	// links have RELAY_TIMEOUT_MS instead, which is shorter and does the same.
	const OPEN_TIMEOUT_MS = 20000;
	// `disconnected` is often transient — a phone on a weak or briefly lost
	// signal recovers the same connection within a few seconds. Treating it as
	// closed straight away throws away a link ICE was about to restore. The
	// price: a closed tab also arrives as `disconnected`, not as a closed
	// channel, so noticing one takes this much longer (measured in headless
	// Chrome: tab close to re-crown 8 s without the grace, 11 s with it).
	const DISCONNECT_GRACE_MS = 3000;
	// How long a voluntary leaver keeps its connections after saying goodbye,
	// so the `__gone` already handed to the channel is not cut off by tearing
	// the transport down underneath it.
	const LEAVE_DRAIN_MS = 250;

	const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
	// Fields the party record owns. A game publishing its own metadata may not
	// overwrite them: a peer that could rename itself `host` or hand itself a
	// team through `setMeta` would be editing the record the whole mesh trusts,
	// not decorating its own seat.
	const RESERVED_META = new Set([
		"id",
		"name",
		"team",
		"bot",
		"joined",
		"host",
		"rs",
		"reconnecting",
	]);

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

	// A role-swapped second attempt (`r`, see SWAP_WAIT_MS) is marked
	// *outside* the compressed body, so isRetrySignal can read it without
	// inflating: the room glue decides glare inside one message handler,
	// and an await there would let the next message overtake it. `.` is
	// not in the base64url alphabet, so no plain code can start this way.
	const RETRY_MARK = "r.";
	// An offer from a network classifyNat found hard (`h`), which can only
	// connect as the offerer: room-join's glare rule lets it stand. Marked
	// the same way, after any retry mark, for the same synchronous read.
	const HARD_MARK = "h.";
	const bareCode = (code) =>
		code
			.trim()
			.replace(/^.*[#&][ia]=/, "")
			.replace(/\s+/g, "");
	/** A code's marks, and the compressed body after them. */
	const readMarks = (code) => {
		let body = bareCode(code);
		const retry = body.startsWith(RETRY_MARK);
		if (retry) body = body.slice(RETRY_MARK.length);
		const hard = body.startsWith(HARD_MARK);
		if (hard) body = body.slice(HARD_MARK.length);
		return { retry, hard, body };
	};

	/** Encode a handshake payload into a URL-safe code. */
	async function packSignal({ r, h, ...obj }, sdp) {
		const compact = compactSdp(sdp);
		const body = compact
			? { ...obj, k: "c", d: compact }
			: { ...obj, k: "f", d: sdp };
		return (r ? RETRY_MARK : "") + (h ? HARD_MARK : "") + toB64(await deflate(JSON.stringify(body)));
	}

	/** Is this code the role-swapped retry? Synchronous, unlike unpackSignal. */
	function isRetrySignal(code) {
		return typeof code === "string" && readMarks(code).retry;
	}

	/** Is this an offer from a hard-NAT network? Synchronous, like isRetrySignal. */
	function isHardSignal(code) {
		return typeof code === "string" && readMarks(code).hard;
	}

	/** Decode a handshake code back into `{ slot, peerId, name, retry, hard, sdp }`. */
	async function unpackSignal(code) {
		const { retry, hard, body } = readMarks(code);
		const obj = JSON.parse(await inflate(fromB64(body)));
		return {
			slot: obj.s,
			peerId: obj.i,
			name: obj.n ?? null,
			// Answered, the retry is the pair's last try: its failure is
			// reported, not swapped again.
			retry,
			hard,
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
	 * Has ICE found a path that the data channel is still coming up over?
	 * Used by the open watchdog (_armOpen) to give such a link one more
	 * period. A connection already `failed` or `closed` has its verdict.
	 */
	function iceUp(pc) {
		const s = pc.connectionState;
		if (s === "failed" || s === "closed") return false;
		if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") return true;
		if (s !== "connected" && s !== "connecting") return false;
		try {
			return !!pc.sctp?.transport?.iceTransport?.getSelectedCandidatePair?.();
		} catch {
			return false;
		}
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
			const onOpen = () => {
				if (this.open) return;
				this.open = true;
				this.flush();
				this.room._linkOpened(this);
			};
			dc.onopen = onOpen;
			dc.onclose = () => this.room._linkClosed(this);
			dc.onmessage = (e) => this.receive(e.data);
			// A channel delivered by `datachannel` may already be open, its open
			// event dispatched before we could listen or still queued. Handle it
			// now; the guard above makes the later call a no-op, which matters
			// because _linkOpened is not idempotent.
			if (dc.readyState === "open") onOpen();
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

		/**
		 * `drainMs` keeps the PeerConnection alive a moment after the channel
		 * starts closing, so what was already sent still leaves — tearing the
		 * transport down at once can drop it.
		 */
		close(drainMs = 0) {
			clearTimeout(this.expiry);
			clearTimeout(this.watchdog);
			clearTimeout(this.dropTimer);
			try {
				this.dc?.close();
			} catch {}
			const pc = this.pc;
			const end = () => {
				try {
					pc.close();
				} catch {}
			};
			if (drainMs > 0) setTimeout(end, drainMs);
			else end();
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
			onIsolated,
			onRouteFailed,
			natHard,
		}) {
			// A room may adopt an id instead of minting one: reconnecting after
			// a reload does exactly that, because the member the party record
			// remembers is the old id, and a fresh one would arrive as a
			// stranger — team lost, seat lost. A `bot_` prefix is refused, so
			// nobody can walk in wearing a bot's seat.
			this.selfId =
				typeof selfId === "string" && selfId && !isBotId(selfId) ? selfId : randId(10);
			this.iceServers = iceServers ?? iceDefault();
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
			this.onIsolated = onIsolated;
			// `(peerId, { offered, message }) => bool`: a link this room's
			// owner negotiated (createInvite/answerInvite) failed ICE on its
			// first attempt. True means the owner has a signalling path to
			// the peer and swaps the roles over it — offers back when we
			// answered, or expects their offer when we offered (see
			// SWAP_WAIT_MS). Without it, or false, the failure is final.
			this.onRouteFailed = onRouteFailed;
			// Is this network's NAT hard (classifyNat)? true / false / null
			// (not known, or not asked). Set by whoever classifies — room-join,
			// at room start — or pinned by the caller; nothing here waits on it.
			this.natHard = natHard ?? null;

			this.links = new Map(); // peerId -> Link (direct connections only)
			// Every link still being negotiated, so leave() can close it and a
			// late open cannot resurrect a room that has gone. Keyed by invite
			// slot, "r:<peer>" (our relayed offer), "a:<peer>" (our relayed
			// answer) or "j:<slot>" (an invite we answered).
			this.pending = new Map();
			this.negotiating = new Map(); // peerId -> Link (our relayed offer in flight)
			// Peers whose role-swapped offer we are waiting for: peerId -> timer.
			this.swapWait = new Map();
			this.suspects = new Map(); // peerId -> { timer, attempt }
			// Reconnecting marks the room server's notice set, as opposed to ones
			// the mesh concluded — only these may a "back on the socket" clear.
			this.serverMarks = new Set();
			this.relayTimeoutMs = RELAY_TIMEOUT_MS;
			this.openTimeoutMs = OPEN_TIMEOUT_MS;
			this.actions = new Map(); // name   -> { onMessage }
			this.seen = new Set(); // recently delivered envelope ids
			this.seenQueue = [];
			this.inbox = []; // held until resume()
			this.running = false;
			this.closed = false;

			// The party is a shared record, not a network shape. `host` names the
			// member holding the crown; everything else about the topology is
			// free to change under it. `term` counts crown changes, so two
			// records that disagree about the host can be ordered: see _outranks.
			this.party = {
				host: isHost ? this.selfId : null,
				term: 0,
				game: null,
				members: [
					{
						id: this.selfId,
						name: name || NeonArcade.defaultName(),
						team: isHost ? "A" : null,
						joined: Date.now(),
					},
				],
			};
			// Whether the crown holder in our record has spoken for itself since
			// the crown last moved, rather than us having merely computed the
			// heir. A computed heir yields to any live host at the same term.
			this.heard = !!isHost;
		}

		// -- public API ---------------------------------------------------

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
					room._send({ a: name, d: data, f: room.selfId, t: opts?.target ?? null }, null);
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

		/**
		 * Leave the party on purpose. Peers are told, so they drop the seat at
		 * once — and pass the crown on, if it was ours — instead of holding it
		 * as RECONNECTING for the reconnect grace. Nothing calls this on a page
		 * reload or unload: that is the one exit whose seat should be held.
		 */
		leave() {
			this._close("left");
		}

		/**
		 * Stop being this member *here* without telling anyone: every link
		 * closes as a reload's would, no `__gone`, so the party holds the seat
		 * as RECONNECTING. For when the same member id is coming back from
		 * somewhere else — another tab of this browser took the seat over
		 * (room-join.js `displaced`) — and a goodbye would drop the very
		 * member who is reconnecting. onLeave hears "detached".
		 */
		detach() {
			this._close("detached");
		}

		/**
		 * `reason` is what onLeave hears: "left" (leave()), "evicted" (the host
		 * removed us), "closed" (the party was deleted) or "detached"
		 * (detach()).
		 */
		_close(reason) {
			if (this.closed) return;
			// Best-effort: handed to the channels before they close, and drained
			// below. A peer that misses it still finds out through the probe.
			if (reason === "left") this._send({ __gone: this.selfId, f: this.selfId, t: null }, null);
			this.closed = true;
			// Whoever wired this room up (the room server, most likely) learns the
			// departure here rather than having to poll — this is where the rejoin
			// token stops being valid for us.
			this.onLeave?.(reason);
			for (const { timer } of this.suspects.values()) clearTimeout(timer);
			this.suspects.clear();
			for (const timer of this.swapWait.values()) clearTimeout(timer);
			this.swapWait.clear();
			const drain = reason === "left" ? LEAVE_DRAIN_MS : 0;
			for (const link of this.links.values()) link.close(drain);
			for (const link of this.pending.values()) link.close();
			for (const link of this.negotiating.values()) link.close();
			this.links.clear();
			this.pending.clear();
			this.negotiating.clear();
		}

		// -- party administration -----------------------------------------

		setName(name) {
			this._editSelf({ name });
		}

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
			if (!this.isHost() || memberId === this.selfId) return;
			// A bot has no browser to run the party from (see _ranked).
			if (isBotId(memberId)) return;
			if (!this.party.members.some((m) => m.id === memberId)) return;
			this.party.host = memberId;
			this.party.term++;
			this._commitParty();
		}

		/**
		 * The member the crown would pass to if we left now: the longest-present
		 * member other than us who could actually take it, or null if nobody can.
		 * Same ranking the automatic succession uses, so a host's leave prompt
		 * names the person who will in fact be crowned.
		 */
		heir() {
			return this._ranked().find((m) => m.id !== this.selfId)?.id ?? null;
		}

		/** Host only. Remove someone from the party. */
		removeMember(memberId) {
			if (!this.isHost() || memberId === this.selfId) return;
			// A bot has no channel to hear an eviction on, and no peer needs to be
			// told separately — dropping it from the record is the whole story.
			if (!isBotId(memberId)) this._send({ __k: memberId, f: this.selfId }, null);
			this._dropMember(memberId, "removed");
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
			// _send already delivers an envelope addressed to us; only a
			// broadcast needs the local copy added.
			this._send(env, null);
			if (env.t === null) this._deliver(env);
		}

		/**
		 * Host only. End the party for everyone. This is the only exit that
		 * closes it — any other departure leaves the remaining members playing.
		 */
		deleteParty() {
			if (!this.isHost()) return;
			this._send({ __x: 1, f: this.selfId }, null);
			// Give the notice a moment to drain before tearing the channels down.
			setTimeout(() => this._close("closed"), LEAVE_DRAIN_MS);
		}

		// -- signaling ----------------------------------------------------

		/**
		 * Mint an invite for one newcomer. Any member can do this, not just the
		 * host: the answer that comes back is applied locally and the rest of the
		 * party negotiates with the newcomer automatically afterwards. That is
		 * what lets whoever is standing next to the new player do the scanning.
		 *
		 * `forPeer` names who the invite is for, when the caller knows (the
		 * room-server glue does). A member who already holds a seat — back
		 * from a reload — is not a new arrival, so the full check skips them:
		 * counting their own held seat against them would lock every member of
		 * a full party (bots fill one quickly) out of it for good. A refusal
		 * carries `reason: "full"`, so the glue can tell the joiner why.
		 *
		 * `retry` marks the role-swapped second attempt for a pair whose
		 * first failed (onRouteFailed): it rides the code, so the side that
		 * answers it knows not to swap a second time. `hard` marks an offer
		 * from a hard-NAT network (classifyNat), for the far side's glare rule.
		 */
		async createInvite({ forPeer, retry = false, hard = false } = {}) {
			if (this.closed) throw new Error("This party has closed.");
			const seated = !!forPeer && this.party.members.some((m) => m.id === forPeer);
			if (!seated && this.party.members.length >= this.maxMembers) {
				throw Object.assign(new Error(`This party is full (${this.maxMembers} players).`), {
					reason: "full",
				});
			}
			const slot = randId(4);
			const pc = trackCandidates(new RTCPeerConnection({ iceServers: this.iceServers }));
			const link = new Link(this, pc, slot);
			// Remembered so an invite made redundant — the same member got in
			// over another link first — can be closed rather than held open.
			link.forPeer = forPeer ?? null;
			link.offered = true;
			link.retry = !!retry;
			link.attach(pc.createDataChannel("game", { ordered: true }));
			this._watch(link);
			// Tracked before the first await, so a leave() during gathering
			// closes it rather than leaving it to open into a dead room.
			this.pending.set(slot, link);

			await pc.setLocalDescription(await pc.createOffer());
			await gatherIce(pc);
			if (this.closed) throw new Error("This party has closed.");
			// Dropped while gathering (dropInvites, or made redundant by
			// another link): a code for it would answer nothing.
			if (this.pending.get(slot) !== link) {
				throw Object.assign(new Error("That invite was withdrawn."), { reason: "withdrawn" });
			}

			const code = await packSignal(
				{ s: slot, i: this.selfId, n: this.self()?.name, ...(retry ? { r: 1 } : {}), ...(hard ? { h: 1 } : {}) },
				pc.localDescription.sdp,
			);
			const base = location.href.split("#")[0];
			return { code, link: `${base}#i=${code}` };
		}

		/**
		 * Close every invite minted `forPeer` that no answer has taken. An
		 * invite never expires on its own: whoever minted one that will not
		 * be answered — the far side chose its own offer under a glare rule,
		 * or the peer went away — drops it here, rather than hold a
		 * PeerConnection open for the life of the room. One that took an
		 * answer is a negotiation under way and is left to finish. Returns
		 * how many were closed.
		 */
		dropInvites(forPeer) {
			let dropped = 0;
			for (const l of [...this.pending.values()]) {
				if (l.offered && !l.relayed && l.forPeer === forPeer && !l.peerId) {
					this._abandon(l);
					dropped++;
				}
			}
			return dropped;
		}

		/** Consume the answer code a newcomer sent back. */
		async acceptAnswer(answerCode) {
			if (this.closed) throw new Error("This party has closed.");
			const { slot, peerId, name, sdp } = await unpackSignal(answerCode);
			const link = this.pending.get(slot);
			// An invite that already took an answer stays tracked until it
			// opens, but it cannot take a second one.
			if (!link || link.peerId) {
				throw new Error(
					"That code does not match an open invite. Create a new invite and try again.",
				);
			}
			if (this.links.has(peerId)) throw new Error("That player is already connected.");
			link.peerId = peerId;
			link.introducedName = name;
			try {
				await link.pc.setRemoteDescription({ type: "answer", sdp });
			} catch (err) {
				this._abandon(link);
				throw err;
			}
			this._armOpen(link);
		}

		/**
		 * Consume an invite and produce the answer code that must go back. Used
		 * by whoever opened an `#i=` link — the newcomer joining a party.
		 * `watch`: start the open watchdog (OPEN_TIMEOUT_MS) once the answer is
		 * gathered. Only for an answer a machine delivers (room-join); a reply
		 * a person carries back by QR, paste or link can take any time, and
		 * the offerer's own watchdog starts when it takes it.
		 */
		async answerInvite(inviteCode, { watch = false } = {}) {
			if (this.closed) throw new Error("This party has closed.");
			const { slot, peerId: inviterId, name, sdp, retry } = await unpackSignal(inviteCode);
			const pc = trackCandidates(new RTCPeerConnection({ iceServers: this.iceServers }));
			const link = new Link(this, pc, slot);
			link.peerId = inviterId;
			link.introducedName = name;
			link.retry = retry;
			// The swapped offer we were waiting for (see _routeFailed).
			this._swapArrived(inviterId);
			pc.ondatachannel = (e) => link.attach(e.channel);
			this._watch(link);
			this.pending.set("j:" + slot, link);

			await pc.setRemoteDescription({ type: "offer", sdp });
			await pc.setLocalDescription(await pc.createAnswer());
			await gatherIce(pc);
			if (this.closed) throw new Error("This party has closed.");
			if (watch) this._armOpen(link);

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
		 * against itself when both notice the gap at the same moment — except
		 * for `retry`, the one role-swapped second attempt after the lower
		 * id's offer failed (_routeFailed).
		 */
		async _openRelayed(peerId, { retry = false, resend = false } = {}) {
			if (this.closed) return;
			if (this.links.has(peerId) || this.negotiating.has(peerId)) return;
			if (peerId === this.selfId) return;
			if (!retry && this.selfId > peerId) return; // the other side offers
			// Answering their swapped offer: offering as well would be glare.
			if (this.pending.has("a:" + peerId)) return;
			let link = null;
			try {
				const pc = trackCandidates(new RTCPeerConnection({ iceServers: this.iceServers }));
				link = new Link(this, pc, null);
				link.peerId = peerId;
				link.offered = true;
				link.relayed = true;
				link.retry = retry;
				link.resent = resend;
				link.attach(pc.createDataChannel("game", { ordered: true }));
				this._watch(link);
				this.negotiating.set(peerId, link);
				this.pending.set("r:" + peerId, link);
				this._expire(link);

				await pc.setLocalDescription(await pc.createOffer());
				await gatherIce(pc);
				if (this.closed) return;
				// Kept, id and all, so it can go again unchanged (_resendOffer).
				link.offerEnv = {
					__g: "offer",
					f: this.selfId,
					t: peerId,
					sdp: pc.localDescription.sdp,
					...(retry ? { r: 1 } : {}),
				};
				this._send(link.offerEnv, null);
			} catch (err) {
				if (link) this._abandon(link);
			}
		}

		async _onRelayedOffer(from, sdp, retry = false) {
			if (this.closed || this.links.has(from)) return;
			// A fresh offer supersedes an answer of ours that never opened —
			// the offerer gave up on it and is trying again.
			const stale = this.pending.get("a:" + from);
			if (stale) this._abandon(stale);
			const pc = trackCandidates(new RTCPeerConnection({ iceServers: this.iceServers }));
			const link = new Link(this, pc, null);
			link.peerId = from;
			link.relayed = true;
			link.retry = retry;
			pc.ondatachannel = (e) => link.attach(e.channel);
			this._watch(link);
			this.pending.set("a:" + from, link);
			this._expire(link);
			try {
				await pc.setRemoteDescription({ type: "offer", sdp });
				await pc.setLocalDescription(await pc.createAnswer());
				await gatherIce(pc);
				if (this.closed) return;
				this._send(
					{ __g: "answer", f: this.selfId, t: from, sdp: pc.localDescription.sdp },
					null,
				);
			} catch {
				this._abandon(link);
			}
		}

		async _onRelayedAnswer(from, sdp) {
			const link = this.pending.get("r:" + from);
			if (!link) return;
			// Still in `negotiating` until it opens or expires.
			this.pending.delete("r:" + from);
			link.answered = true;
			try {
				await link.pc.setRemoteDescription({ type: "answer", sdp });
			} catch {
				this._abandon(link);
			}
		}

		/**
		 * Somebody just linked `peerId` (`__alive`). An offer of ours to them
		 * still unanswered may have been sent through a member who had no
		 * route to them yet — a member back from a reload is announced by
		 * the room server before anyone has relinked it — and then went
		 * nowhere. Send the same envelope again: its id is unchanged, so if
		 * the first did arrive the far side drops this one as already seen.
		 */
		_resendOffer(peerId) {
			const link = this.pending.get("r:" + peerId);
			if (link?.offerEnv && !link.answered) this._send({ ...link.offerEnv }, null);
		}

		/** Give up on a relayed negotiation that has not opened in time. */
		_expire(link) {
			link.expiry = setTimeout(() => {
				if (link.open) return;
				this._abandon(link);
				// Usually ICE's own `failed` is a moment behind this, and an
				// abandoned connection reports nothing: swap from here too.
				this._routeFailed(link, null);
			}, this.relayTimeoutMs);
		}

		/** Stop tracking a link that is still being negotiated. */
		_forget(link) {
			clearTimeout(link.expiry);
			clearTimeout(link.watchdog);
			for (const [key, l] of this.pending) if (l === link) this.pending.delete(key);
			if (this.negotiating.get(link.peerId) === link) this.negotiating.delete(link.peerId);
		}

		/** Close a link that never opened (or never will) and forget it. */
		_abandon(link) {
			this._forget(link);
			link.close();
		}

		/** Fill in every direct connection the mesh is still missing. */
		_meshUp() {
			for (const m of this.party.members) {
				if (m.id === this.selfId || this.links.has(m.id)) continue;
				// A bot has no browser to connect to. Left in, every peer would
				// spend a full ICE timeout on it, every time the roster changed.
				if (isBotId(m.id)) continue;
				// Nor does a held seat, until its owner is back: an offer sent
				// now goes nowhere. Their return clears the mark and republishes,
				// and that is what brings the rest of the mesh back to them.
				if (m.reconnecting) continue;
				this._openRelayed(m.id);
			}
		}

		/** Report a dead connection instead of waiting on it forever. */
		_watch(link) {
			link.pc.onconnectionstatechange = () => {
				const s = link.pc.connectionState;
				if (s === "failed") {
					this._linkFailed(link);
				} else if (s === "disconnected") {
					// Often transient (see DISCONNECT_GRACE_MS). Messages written
					// meanwhile queue in the channel and go out if ICE recovers.
					clearTimeout(link.dropTimer);
					link.dropTimer = setTimeout(() => {
						if (link.pc.connectionState === "disconnected") this._linkClosed(link);
					}, DISCONNECT_GRACE_MS);
				} else if (s === "connected") {
					clearTimeout(link.dropTimer);
				} else if (s === "closed") {
					this._linkClosed(link);
				}
			};
		}

		/**
		 * ICE said `failed`, or the watchdog (_armOpen) says it might as well
		 * have. Once per link: whichever comes second finds it already done.
		 */
		_linkFailed(link) {
			if (link.failed) return;
			link.failed = true;
			const types = [...(link.pc._types ?? [])];
			this._linkClosed(link);
			this._routeFailed(link, types);
		}

		/**
		 * Start the clock on a direct link both ends have described (see
		 * OPEN_TIMEOUT_MS). Cleared by its opening or closing (_forget,
		 * Link.close — leave() and detach() close every pending link).
		 */
		_armOpen(link, rearmed = false) {
			clearTimeout(link.watchdog);
			// Opened, failed or given up on while we gathered: nothing to watch.
			if (link.open || link.failed || ![...this.pending.values()].includes(link)) return;
			link.watchdog = setTimeout(() => {
				if (this.closed || link.open || link.failed) return;
				// ICE found a path and the channel is still coming up (DTLS or
				// SCTP retrying under loss): one more period, then the verdict.
				if (!rearmed && iceUp(link.pc)) return void this._armOpen(link, true);
				this._linkFailed(link);
			}, this.openTimeoutMs);
		}

		/**
		 * A link that never opened has failed (`types`: the candidate types we
		 * gathered) or been given up on (`types` null: a relayed negotiation's
		 * expiry). A first attempt is tried once more with the roles swapped
		 * (SWAP_WAIT_MS says why): over the mesh relay we do it ourselves;
		 * for a link the room's owner negotiated, onRouteFailed decides,
		 * since only the owner knows whether it can still reach the peer.
		 * The side that answered offers; the side that offered waits.
		 */
		_routeFailed(link, types) {
			const peerId = link.peerId;
			if (this.closed || !peerId || this.links.has(peerId)) return;
			// Another attempt for this pair is under way — the swapped one,
			// usually, overtaking our own slower verdict on the first. Its
			// outcome is the one that counts.
			if (this._trying(peerId)) return;
			const message = types && this._routeMessage(types);
			// A link that had opened and then failed is a network that moved,
			// not a direction that never worked: the re-announce (onIsolated)
			// and the mesh's own renegotiation are what bring it back.
			if (!link.retry && !link.open) {
				if (link.relayed) {
					const member = this.party.members.some((m) => m.id === peerId);
					if (!link.offered && member) {
						this._openRelayed(peerId, { retry: true });
					} else if (types === null && link.offered && !link.answered && !link.resent && member) {
						// Expired never answered: the offer was lost, not refused — a
						// relayed message has no delivery guarantee, and one
						// sent through a member not yet linked to them goes
						// nowhere. They never saw it, so no swap will come;
						// send it again, once (test-room 6e23, NAT lab 11).
						this._openRelayed(peerId, { resend: true });
					}
				} else if (this.onRouteFailed?.(peerId, { offered: !!link.offered, message })) {
					// Ours was the offer: the verdict waits for theirs.
					if (link.offered) this._awaitSwap(peerId, message);
					return;
				}
			}
			// In a mesh a single failed pair is survivable: messages between
			// those two are relayed through somebody who can reach both. Only
			// a peer we cannot reach at all is worth reporting.
			if (types && this.links.size === 0) this._noRoute(message, types);
		}

		/**
		 * Is any negotiation with `peerId` still in progress? Only one both
		 * ends are in: a link that knows its peer (an answer taken, or an
		 * offer of theirs we are answering). An invite merely minted *for*
		 * them (`forPeer`) does not count — nothing says it will ever be
		 * answered, and it never expires on its own, so counting it muted
		 * both the swap and the no-route verdict for good (2026-11-12).
		 */
		_trying(peerId) {
			if (this.negotiating.has(peerId)) return true;
			for (const l of this.pending.values()) if (l.peerId === peerId) return true;
			return false;
		}

		/** Wait SWAP_WAIT_MS for `peerId`'s swapped offer, then report. */
		_awaitSwap(peerId, message) {
			clearTimeout(this.swapWait.get(peerId));
			this.swapWait.set(
				peerId,
				setTimeout(() => {
					this.swapWait.delete(peerId);
					if (this.closed || this.links.has(peerId) || this._trying(peerId)) return;
					if (this.links.size === 0) this._noRoute(message);
				}, SWAP_WAIT_MS),
			);
		}

		_swapArrived(peerId) {
			clearTimeout(this.swapWait.get(peerId));
			this.swapWait.delete(peerId);
		}

		/**
		 * Say which paths we actually had. "No srflx" means STUN never
		 * answered (so only same-LAN play can work); having both and still
		 * failing is the genuine symmetric-NAT case that no amount of
		 * retrying will fix.
		 */
		_routeMessage(types) {
			const detail = !types.length
				? "no connection paths were found at all"
				: !types.includes("srflx") && !types.includes("relay")
					? "STUN did not answer, so only same-network play was possible"
					: "both sides had public addresses but no route between them";
			return (
				`Could not establish a direct connection — ${detail}. ` +
				"Try both devices on the same wifi, or one phone's hotspot."
			);
		}

		_noRoute(message, types = null) {
			if (types) console.warn("[neon] connection failed; local candidates:", types);
			// The reason lets a caller still waiting on this link (a code join)
			// end its wait now, with this message, rather than time out later
			// and blame the party for not answering.
			this.onError?.(message, { reason: "no-route" });
		}

		// -- membership ---------------------------------------------------

		_linkOpened(link) {
			if (!link.peerId) return;
			// A negotiation that finishes after leave() must not bring the room
			// back: nothing would ever close it again.
			if (this.closed) return link.close();
			const peerId = link.peerId;
			this._forget(link);
			// An offer of ours still in flight to the same peer is now redundant,
			// relayed or minted for them through the room server (which the
			// glare rule there leaves unanswered on purpose).
			const offer = this.negotiating.get(peerId);
			if (offer) this._abandon(offer);
			for (const l of [...this.pending.values()]) {
				if (l !== link && l.forPeer === peerId && !l.peerId) this._abandon(l);
			}
			const prev = this.links.get(peerId);
			this.links.set(peerId, link);
			// Replaced, not left open: once it is no longer the registered link
			// its close is ignored (see _linkClosed), so nothing else would.
			if (prev && prev !== link) prev.close();
			this._vouch(peerId);
			// Say so: a member who asked "who still reaches them?" (`__q`)
			// while every link to them was down — a reload — heard silence,
			// and would hold their seat RECONNECTING when its grace ran out.
			// This settles that suspicion (test-room 6e23).
			this._send({ __alive: peerId, f: this.selfId, t: null }, null);

			// A held seat's owner came back: the reconnecting mark is the one
			// thing the return has to clear, because the grace clock and the
			// crown's heir both read it.
			const held = this.party.members.find((m) => m.id === peerId);
			if (held?.reconnecting) {
				delete held.reconnecting;
				this.serverMarks.delete(peerId);
				// The host holds the mark everyone else reads, and only the host
				// republishes — which is also what makes the rest of the mesh,
				// whose _meshUp skipped the held seat, connect to them again.
				if (!this.isHost() && this.party.host) {
					this._send({ __i: { id: peerId, back: true }, f: this.selfId, t: this.party.host }, null);
				}
				this._publish();
			}

			// Whoever already holds the crown owns the party record and answers
			// with it. A newcomer's first inbound message is therefore the roster.
			if (this.isHost()) {
				this._addMember(peerId, link.introducedName);
				this._commitParty();
			} else if (this.party.host !== null) {
				// A newcomer knows nobody yet, so it cannot address the host and it
				// cannot broadcast either — it does not know who is missing. Hand it
				// our record first; that is where it learns who holds the crown.
				//
				// Only an established member does this. The newcomer itself has no
				// record worth sending, and its introduction of the inviter would
				// carry the name from the invite — stale if they renamed since.
				link.send({ __p: this.party, f: this.selfId, t: null });
				// Then tell the host, on the newcomer's behalf, that they exist.
				// This is what lets any member do the recruiting.
				if (!this.party.members.some((m) => m.id === peerId)) {
					this._send(
						{
							__i: { id: peerId, name: link.introducedName },
							f: this.selfId,
							t: this.party.host,
						},
						null,
					);
				}
			}
			this.onOpen?.(peerId);
			this._meshUp();
		}

		/**
		 * A link closed, failed or was given up on. One that never opened — or
		 * was already replaced — only needs forgetting; losing the registered
		 * link to a member is what starts the probe.
		 */
		_linkClosed(link) {
			// leave() already closed everything it tracked, draining on purpose.
			if (this.closed) return;
			this._forget(link);
			if (!link.peerId || this.links.get(link.peerId) !== link) return link.close();
			const peerId = link.peerId;
			this.links.delete(peerId);
			link.close();
			if (this.party.members.some((m) => m.id === peerId)) this._suspect(peerId);
			// The last link went while there are still people to link to. Either
			// they all left at once, or it is *our* network that moved — and
			// then the mesh has no path left to renegotiate over. Whoever wired
			// up an out-of-band channel (the room server) gets to try that.
			if (
				!this.links.size &&
				this.party.members.some((m) => m.id !== this.selfId && !isBotId(m.id))
			) {
				this.onIsolated?.();
			}
		}

		/**
		 * A direct link dropped. That is not the same as the member leaving: in a
		 * mesh a single pair can fail while everyone else still reaches them, and
		 * relaying exists precisely for that. So ask before concluding anything —
		 * anyone who still holds a live link to them says so, and silence is what
		 * actually means "gone".
		 */
		_suspect(peerId, attempt = 0) {
			if (this.closed || this.suspects.has(peerId)) return;
			this._send({ __q: peerId, f: this.selfId, t: null }, null);
			const timer = setTimeout(() => {
				if (this.closed) return;
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
			const entry = this.suspects.get(peerId);
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
				// The mesh has now concluded this itself, so a "back on the
				// socket" notice no longer clears the mark: only a link does.
				this.serverMarks.delete(peerId);
				// First conclusion marks; the others see it marked and leave the
				// drop to their own timers, so a dead first-marker's timer is
				// covered by everyone else's and the seat cannot be held forever
				// by a peer that itself went away.
				if (!member.reconnecting) {
					member.reconnecting = Date.now();
					this._publish();
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
		 * when there is no live link to hide behind.
		 *
		 * "Back" clears only a mark this notice set itself. A member reached
		 * only by relay never gets a link of ours to open, so without this a
		 * socket blip would leave them RECONNECTING for good; a mark the mesh
		 * concluded (_confirmGone) is still the link's to clear.
		 */
		serverPeerState(peerId, connected) {
			const member = this.party.members.find((m) => m.id === peerId);
			if (!member?.rs || isBotId(peerId)) return;
			if (connected) {
				if (!this.serverMarks.delete(peerId) || !member.reconnecting) return;
				delete member.reconnecting;
				this._publish();
				return;
			}
			if (this.links.has(peerId) || member.reconnecting) return;
			member.reconnecting = Date.now();
			this.serverMarks.add(peerId);
			this._publish();
			// The grace clock still runs through _confirmGone; this mark only
			// makes the roster say RECONNECTING sooner than a probe would.
		}

		_applyGone(peerId, reason = "dropped") {
			if (!this.party.members.some((m) => m.id === peerId)) return;
			if (peerId === this.party.host) {
				// The host is gone. The party outlives it: see _vacateCrown.
				this._dropMember(peerId, reason);
				return this._vacateCrown();
			}
			this._dropMember(peerId, reason);
			this._publish();
		}

		/**
		 * The crown is vacant — its holder left, or (a room-server member whose
		 * seat is waiting out the reconnect grace) cannot be vouched for, in
		 * which case the seat stays but the crown moves. The heir takes it, and
		 * the host's bots go with it — the only browser simulating them was the
		 * one that left.
		 */
		_vacateCrown() {
			// The host was the only browser simulating them. Left in the roster
			// they would be seats that never move again, and the next host would
			// be handed a game it cannot finish.
			for (const m of this.getMembers()) if (isBotId(m.id)) this._dropMember(m.id, "crown");
			const heir = this._heir();
			// Succession is automatic: the heir takes the crown the moment it
			// vacates, on every browser at once, because they all compute the
			// same heir from the same roster. No offer, no button. The crown is
			// never left null — a party always has a host.
			//
			// Only the heir bumps the term, because only the heir publishes. The
			// rest have merely *computed* who it should be, so until the heir's
			// record arrives they yield to any crown holder that speaks up at
			// the old term — which is how a false alarm heals (see _outranks).
			this.party.host = heir;
			this.heard = heir === this.selfId;
			if (this.heard) this.party.term++;
			this._publish();
			this.onHostVacant?.(heir, heir === this.selfId);
		}

		/**
		 * Members who could hold the crown, best first: longest-present, ties
		 * broken by id so every browser agrees. A bot cannot — there is no
		 * browser behind it to run the party. Nor can a reconnecting member:
		 * there is nobody in the seat yet, and the crown does not wait for them
		 * (see _confirmGone).
		 */
		_ranked() {
			return this.party.members
				.filter((m) => !isBotId(m.id) && !m.reconnecting)
				.sort((a, b) => a.joined - b.joined || (a.id < b.id ? -1 : 1));
		}

		/** Who takes a vacant crown. Ourselves if nobody else can. */
		_heir() {
			return this._ranked()[0]?.id ?? this.selfId;
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

		_dropMember(id, reason) {
			const member = this.party.members.find((m) => m.id === id);
			this.party.members = this.party.members.filter((m) => m.id !== id);
			if (member) this._emitLeave(id, member, reason);
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
			if (!this.isHost()) {
				this._send({ __i: { id: this.selfId, ...patch }, f: this.selfId, t: null }, null);
			}
			this._publish();
		}

		_editMember(id, patch) {
			const m = this.party.members.find((x) => x.id === id);
			if (!m) return;
			Object.assign(m, patch);
			this._commitParty();
		}

		/**
		 * Host side: publish the authoritative party record to everyone.
		 * Elsewhere: show our local copy, which the host's next commit replaces.
		 */
		_publish() {
			if (this.isHost()) this._commitParty();
			else this._emitParty();
		}

		/** Host side: publish the authoritative party record to everyone. */
		_commitParty() {
			this.party.members.sort((a, b) => a.joined - b.joined);
			this._send({ __p: this.party, f: this.selfId, t: null }, null);
			this._emitParty();
			this._meshUp();
		}

		/**
		 * Whether a party record that arrived should replace ours. Records are
		 * ordered by crown term — every hand-over and succession bumps it — so a
		 * stale host returning from a partition, or two hosts crowned on either
		 * side of one, converge on a single crown:
		 *
		 *   - a newcomer (no host yet) takes the first record that names one;
		 *   - a higher term wins outright, which is how a host steps down;
		 *   - at the same term only the crown holder speaks for its record —
		 *     a member's copy of it is never authoritative;
		 *   - two crown holders at the same term: a computed heir that has not
		 *     heard from its host yields to one that is actually speaking, and
		 *     otherwise the lower id wins, which every browser agrees on.
		 */
		_outranks(next, from) {
			if (!next?.host) return false; // a newcomer's record is nobody's truth
			const mine = this.party;
			if (mine.host === null) return true;
			const a = next.term ?? 0;
			const b = mine.term ?? 0;
			if (a !== b) return a > b;
			if (from !== next.host) return false;
			if (next.host === mine.host) return !this.isHost();
			return !this.heard || next.host < mine.host;
		}

		/** Adopt a record that outranks ours (see _outranks). */
		_applyParty(next, from) {
			const was = this.party;
			const wasHost = this.isHost();
			const before = new Set(was.members.map((m) => m.id));
			this.party = next;
			this.heard = from === next.host;
			// A crown changing hands under a split can leave us, or people only
			// we can reach, out of the winning record. Keep our own seat locally
			// and introduce the missing to the new host, which adds them like
			// any newcomer. Not done for a record from the same host: that one
			// leaving us out is an eviction, and the __k said so.
			if (was.host !== null && next.host !== was.host) {
				const after = new Set(next.members.map((m) => m.id));
				const self = was.members.find((m) => m.id === this.selfId);
				if (!after.has(this.selfId) && self) next.members.push({ ...self, team: null });
				const carried = was.members.filter(
					(m) =>
						!after.has(m.id) &&
						!isBotId(m.id) &&
						(m.id === this.selfId || (wasHost && this.links.has(m.id))),
				);
				for (const m of carried) {
					this._send({ __i: { id: m.id, name: m.name }, f: this.selfId, t: next.host }, null);
				}
			}
			const after = new Set(next.members.map((m) => m.id));
			for (const id of after) if (!before.has(id)) this._emitJoin(id);
			// Gone from the host's record without a goodbye of their own
			// reaching us first: the record does not say which way they went.
			for (const id of before) {
				if (!after.has(id)) this._emitLeave(id, was.members.find((m) => m.id === id), "gone");
			}
			// A record naming us host that we did not hold a moment ago: a host
			// back from a reload, handed its own record by the stayer who
			// relinked first. Publish it. Only the host's record clears a held
			// seat for those who gave up on it (their _meshUp skips it, and a
			// higher-id host never offers to them), so without this a member
			// who concluded us gone before that stayer relinked stays unlinked,
			// with its own crown, for good (test-room 6e22; NAT lab 11).
			if (!wasHost && this.isHost()) {
				this.heard = true;
				return this._commitParty();
			}
			this._emitParty();
			this._meshUp();
		}

		_emitJoin(id) {
			if (id === this.selfId) return;
			const m = this.party.members.find((x) => x.id === id);
			const had = !!m?.rs;
			this.onPeerJoin?.(id);
			// The room-server glue flags a member it brought in on *its* copy
			// of the record (it is the offerer, and only it knows). A host's
			// copy publishes with the next commit; anyone else's would be
			// overwritten by it, so report the flag to the host, who runs the
			// reconnect grace that reads it.
			if (!had && m?.rs && !this.isHost() && this.party.host) {
				this._send({ __i: { id, rs: true }, f: this.selfId, t: this.party.host }, null);
			}
		}
		/**
		 * `member` is the record as it was, since it is already out of the
		 * roster by now — a listener asking getMember() for the name would
		 * get nothing. `reason` says how they went: "left" (on purpose),
		 * "dropped" (lost, and not back within the grace), "removed" (by the
		 * host), "crown" (a bot that went with its host's crown).
		 */
		_emitLeave(id, member, reason = "left") {
			if (id === this.selfId) return;
			this.onPeerLeave?.(id, { name: member?.name ?? "Player", reason });
		}
		_emitParty() {
			this.onParty?.(this.getMembers(), {
				host: this.party.host,
				game: this.party.game,
			});
		}

		// -- routing ------------------------------------------------------

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
			// is never held behind `resume()`. These are all broadcasts: each is
			// delivered once, and carried on to anyone its sender could not reach.
			if (msg.__p || msg.__k || msg.__q || msg.__alive || msg.__gone || msg.__x) {
				if (!this._markSeen(msg.id ?? randId(8))) return;
				this._forwardBroadcast(msg, link);
				if (msg.__p) {
					if (this._outranks(msg.__p, msg.f)) this._applyParty(msg.__p, msg.f);
				} else if (msg.__k) {
					if (msg.__k === this.selfId) {
						this.onEvicted?.();
						this._close("evicted");
					} else {
						this._dropMember(msg.__k, "removed");
						this._emitParty();
					}
				} else if (msg.__q) {
					// Only speak up if we can actually still reach them.
					if (this.links.has(msg.__q)) {
						this._send({ __alive: msg.__q, f: this.selfId, t: null }, null);
					}
				} else if (msg.__alive) {
					this._vouch(msg.__alive);
					this._resendOffer(msg.__alive);
				} else if (msg.__gone) {
					// A member saying goodbye for itself is gone even though its
					// link is still draining. Anyone else's report yields to a link
					// we still hold: the reporter simply lost a pair, and relaying
					// covers it.
					const own = msg.__gone === msg.f;
					if (own || !this.links.has(msg.__gone)) this._applyGone(msg.__gone, own ? "left" : "dropped");
				} else {
					this.onPartyClosed?.();
					this._close("closed");
				}
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
				const { id, back, rs, ...patch } = msg.__i;
				let m = this.party.members.find((x) => x.id === id);
				// A vouch (`rs`, `back`) is about a member we already seat. One
				// for an id we do not know is late news of somebody who has
				// since left; seating them would bring them back as "Player".
				if (!m && (rs || back)) return;
				if (!m) {
					this._addMember(id, patch.name);
					m = this.party.members.find((x) => x.id === id);
				} else if (msg.f === id) {
					// Only a member edits its own fields. Somebody else
					// introducing an existing member — the newcomer naming its
					// inviter, a second recruiter — carries a name that may be
					// stale, so it never renames anyone.
					Object.assign(m, patch);
				}
				// What a third party may vouch for: the member came in through
				// the room server (see _emitJoin), or their link to them opened
				// again (see _linkOpened).
				if (m && rs) m.rs = true;
				if (m && back) {
					delete m.reconnecting;
					this.serverMarks.delete(id);
				}
				this._commitParty();
				return;
			}
			if (msg.__g) {
				if (msg.t !== this.selfId) return this._send(msg, link);
				if (!this._markSeen(msg.id)) return;
				if (msg.__g === "offer") this._onRelayedOffer(msg.f, msg.sdp, !!msg.r);
				else this._onRelayedAnswer(msg.f, msg.sdp);
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
		// The state is kept: it may be the back-button guard's (lobby.js).
		history.replaceState(history.state, "", location.pathname + location.search);
	};

	/**
	 * Start a fresh party. Clears any stale rejoin token (which would otherwise
	 * make the next load reconnect to an old party instead of hosting), drops
	 * the handshake fragment, and lands on party.html with the fresh-start flag.
	 */
	NeonArcade.hostNewGame = () => {
		NeonArcade.clearHash();
		// The token's owner is lib/room-join.js; a page that did not load it
		// still clears the key, since a token outlives the page that wrote it.
		if (NeonArcade.clearRejoinToken) NeonArcade.clearRejoinToken();
		else {
			try {
				localStorage.removeItem("neon.room");
			} catch {}
		}
		// Nothing from this page's query rides along. A self-hosted room
		// server is chosen in storage ("neon.rs", room-join.js resolveBase),
		// so the new party keeps it without the URL carrying it — a server
		// a link could choose could read and rewrite every party's SDP.
		location.href = "party.html?fresh=1";
	};

	/** Create a room you host. Returns the room plus `createInvite`/`acceptAnswer`. */
	NeonArcade.createHost = (opts = {}) => new Room({ ...opts, isHost: true });

	/** Create a room you join. Feed it the invite code via `answerInvite`. */
	NeonArcade.createGuest = (opts = {}) => new Room({ ...opts, isHost: false });

	// How long the side that offered waits for a role-swapped offer; the
	// room glue's join deadline makes room for it (room-join.js).
	NeonArcade.SWAP_WAIT_MS = SWAP_WAIT_MS;

	/** This network's NAT, remembered per set of STUN servers: see classifyNat. */
	NeonArcade.classifyNat = classifyNat;

	// Exposed for tests. `_pinNat(v)` fixes every classification (fresh or
	// not), so a suite's glare checks do not depend on the network it runs
	// on; `_pinNat(undefined)` lets the real one answer again.
	NeonArcade._codec = { packSignal, unpackSignal, isRetrySignal, isHardSignal, compactSdp, rebuildSdp };
	NeonArcade._pinNat = (v) => (natPinned = v === undefined ? null : Promise.resolve(v));
})();
