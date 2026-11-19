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
// A classic script on window.NeonArcade, bundled into the shell by src/main.tsx
// (docs/spa.md). No external
// dependencies at all.

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
	// Past the channel's own buffer, this much more waiting in our queue means
	// the link cannot keep up at all — minutes behind a real-time game. It is
	// closed rather than left to grow without bound, and the mesh treats it as
	// any other dropped link (reconnect, or relay through someone else).
	const MAX_QUEUED = 8 << 20;
	// A relayed message is forwarded at most this many times. Two hops covers
	// "A cannot reach C directly, but B can reach both", which is the only
	// shape that occurs in a party small enough to play a game together.
	const MAX_HOPS = 2;
	// Remembered message ids, so a flooded broadcast is delivered once.
	const SEEN_MAX = 512;
	/** What `seen` remembers an envelope by: its sender and its id. */
	const seenKey = (env) => `${env.f}|${typeof env.id === "string" ? env.id : randId(8)}`;
	// Parts one message may be split into (12 MB): past it, a "chunk" is junk.
	const MAX_CHUNKS = 1024;

	/** One envelope as the strings a data channel carries: itself, or its parts. */
	function toWire(envelope) {
		const str = JSON.stringify(envelope);
		if (str.length <= CHUNK_BYTES) return [str];
		const id = randId(6);
		const total = Math.ceil(str.length / CHUNK_BYTES);
		return Array.from({ length: total }, (_, i) => JSON.stringify({ __c: id, i, n: total, p: str.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES) }));
	}

	/**
	 * One string off a data channel: the envelope, or null while its parts are
	 * still arriving (kept in `chunks`, per link). A part is told by its whole
	 * shape, never by `__c` alone: the election's request is `{ __c: key, … }`
	 * too, and taking it for a part dropped every one sent over a real link
	 * (2026-11-18).
	 */
	function fromWire(chunks, raw) {
		let msg;
		try {
			msg = JSON.parse(raw);
		} catch {
			return null;
		}
		if (!msg || typeof msg !== "object") return null;
		// No envelope has both `__c` and `p`: that shape is a part or junk, never
		// passed on (as an election request it could flood `seen` or throw).
		if (typeof msg.__c !== "string" || typeof msg.p !== "string") return msg.__c === undefined || typeof msg.__c === "string" ? msg : null;
		if (!(Number.isInteger(msg.n) && Number.isInteger(msg.i) && msg.n > 0 && msg.n <= MAX_CHUNKS && msg.i >= 0 && msg.i < msg.n)) return null;
		const parts = chunks.get(msg.__c) ?? new Array(msg.n);
		if (parts.length !== msg.n) return null;
		parts[msg.i] = msg.p;
		chunks.set(msg.__c, parts);
		if (parts.filter((p) => p !== undefined).length < msg.n) return null;
		chunks.delete(msg.__c);
		try {
			return JSON.parse(parts.join(""));
		} catch {
			return null;
		}
	}
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
	// After the crown moves to an heir we only computed, how long we wait to
	// hear from it before concluding that our side of the party cannot reach
	// it (see _lose). Its own notice of the departure can lag ours by the
	// disconnect grace plus a probe, and its record then crosses the mesh.
	const HEIR_WAIT_MS = 10000;
	// A lost side (see _lose) asks the room server to put it back in touch
	// at once, and again this long after.
	const LOST_RETRY_MS = [5000, 15000, 30000];
	// A candidate repeats its request or commit this often while it matters,
	// and a release is said three times this far apart: election messages
	// are not acknowledged by the transport, and a half-dead link drops them.
	const REASK_MS = 2000;
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
	// A link whose far end has not said hello (Room._linkUp) by now is closed.
	// A current client says it the moment its channel opens — one signature,
	// milliseconds — and an old one never does (it usually gives itself away
	// sooner, by talking first).
	const HELLO_MS = 6000;
	// How far back a crown proof may reach (Room._proven): each proof carries
	// the record it was won from, and that record its own proof, so a phone
	// asleep through two changes of host can still check the third.
	const PROOF_DEPTH = 3;
	// How long a member seated on somebody else's word (`pend`) has to speak
	// for itself — its own `__i` goes the moment it sees the mark, and its
	// link to the host usually opens sooner — before the host drops the seat.
	const PEND_MS = 30000;
	// What `refusals` keeps.
	const REFUSALS_KEPT = 32;

	const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
	// Fields the party record owns. A game publishing its own metadata may not
	// overwrite them: a peer that could rename itself `host` or hand itself a
	// team through `setMeta` would be editing the record the whole mesh trusts,
	// not decorating its own seat.
	// How long a disagreement over our own record must last before we say
	// our fields again (Room._reassert).
	const REASSERT_MS = 1000;

	const RESERVED_META = new Set([
		"id",
		"name",
		"team",
		"bot",
		"joined",
		"host",
		"rs",
		"reconnecting",
		"pend",
	]);

	const randId = (n = 12) =>
		[...crypto.getRandomValues(new Uint8Array(n))]
			.map((b) => ALPHABET[b % 36])
			.join("");

	/**
	 * An election's key for the vacancy `gone` leaves in a record of `term`:
	 * who left, the term, the tie-break heir (the oldest human by `joined`)
	 * and the humans — not bots, not seats nobody has proved (`pend`). The
	 * one function voters and certificate checkers share (Room._voteKey,
	 * _proven): a certificate's key is never taken on its own word.
	 */
	function voteKeyOf(members, term, gone) {
		const people = (members ?? []).filter((m) => m && !isBotId(m.id) && m.id !== gone && !m.pend);
		const humans = people.map((m) => m.id).sort();
		const first = [...people].sort((a, b) => a.joined - b.joined || (a.id < b.id ? -1 : 1))[0]?.id ?? "";
		return `${gone}|${term}|${first}|${humans.join(",")}`;
	}

	/** A crown proof cut to PROOF_DEPTH links: the chain inside it nests. */
	function trimProof(cp, depth = 0) {
		if (!cp || typeof cp !== "object" || depth >= PROOF_DEPTH) return undefined;
		if (cp.v === "hand" && cp.env) return { v: "hand", env: { ...cp.env, cp: trimProof(cp.env.cp, depth + 1) } };
		if (cp.v === "vote" && cp.rec) return { ...cp, rec: { ...cp.rec, cp: trimProof(cp.rec.cp, depth + 1) } };
		return cp;
	}

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

	// --------------------------------------------------------------- identity
	//
	// Signed party messages (Lokesh, 2026-11-18; docs/index.md "Who said
	// it"). A member's id is the hash of its public key: an ECDSA P-256 pair
	// whose private half is non-extractable and kept in IndexedDB, so whoever
	// claims an id can be asked to prove it, and no invite or QR code has to
	// carry the key (only the id, 16 characters instead of 10–12). The key
	// is per tab session: sessionStorage names the one this tab uses, so a
	// reload keeps the id (reload-mid-game) while a second tab is a second
	// player; the room server's rejoin token holds the id too, so a rejoin
	// loads the same key. A browser with no IndexedDB (some private modes)
	// gets a key for this page only — its id changes per page load.

	// What a link's hello says it speaks (see Room._linkUp). A peer that does
	// not say it, or says another, cannot stay: there is no transition window
	// for unsigned clients (Lokesh, 2026-11-18).
	const PROTO = 1;
	const ID_LEN = 16;
	const ID_RE = /^[0-9a-z]{16}$/;
	/** Is this a member id (a key's hash), as opposed to a bot's or an old client's? */
	const isMemberId = (id) => typeof id === "string" && ID_RE.test(id);
	const ECDSA_KEY = { name: "ECDSA", namedCurve: "P-256" };
	const ECDSA_SIGN = { name: "ECDSA", hash: "SHA-256" };
	const ID_SPACE = 36n ** BigInt(ID_LEN);
	const utf8 = new TextEncoder();

	/** A raw P-256 public key's member id: base36 of its SHA-256, 16 digits. */
	async function idOfKey(raw) {
		const h = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
		let n = 0n;
		for (const b of h) n = (n << 8n) | BigInt(b);
		// The low 16 digits: 82.7 bits, uniform to well under 2^-170.
		return (n % ID_SPACE).toString(36).padStart(ID_LEN, "0");
	}

	/**
	 * The text a signature covers: the envelope with keys sorted at every
	 * depth, without what a relay may change (`h` hops, `m` still-missing)
	 * and without the signature's own fields (`s`, `k`), a crown proof
	 * (`cp`, which proves itself and may be trimmed) or the mark on a record
	 * handed on to a newcomer (`fw`, Room._linkOpened). JSON.stringify's key
	 * order is not stable across a round trip, so the raw string would fail
	 * to verify with no bug behind it (see secrets.js's canonical form).
	 */
	const UNSIGNED = new Set(["h", "m", "s", "k", "cp", "fw"]);
	function canon(v, top = false) {
		if (Array.isArray(v)) return "[" + v.map((x) => (x === undefined || typeof x === "function" ? "null" : canon(x))).join(",") + "]";
		if (v && typeof v === "object") {
			const keys = Object.keys(v)
				.filter((k) => v[k] !== undefined && typeof v[k] !== "function" && !(top && UNSIGNED.has(k)))
				.sort();
			return "{" + keys.map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
		}
		return JSON.stringify(v) ?? "null";
	}
	const signedText = (env) => canon(env, true);

	/** `{ id, pub, sign(text) }` around a key pair. */
	function wrapIdentity(id, pub, privateKey) {
		return {
			id,
			pub,
			async sign(text) {
				return toB64(new Uint8Array(await crypto.subtle.sign(ECDSA_SIGN, privateKey, utf8.encode(text))));
			},
		};
	}

	// Verified public keys by member id. A key is cached only once its hash
	// was checked against the id, and an id has exactly one such key, so a
	// forged `k` can never displace the real one.
	const KEY_CACHE_MAX = 512;
	const verifiedKeys = new Map(); // id -> { k, key: Promise<CryptoKey|null> }
	function keyOf(id, k) {
		if (!isMemberId(id) || typeof k !== "string" || k.length > 120) return Promise.resolve(null);
		const hit = verifiedKeys.get(id);
		if (hit && hit.k === k) return hit.key;
		const key = (async () => {
			try {
				const raw = fromB64(k);
				if (raw.length !== 65 || (await idOfKey(raw)) !== id) return null;
				return await crypto.subtle.importKey("raw", raw, ECDSA_KEY, true, ["verify"]);
			} catch {
				return null;
			}
		})();
		key.then((got) => {
			if (!got) return;
			verifiedKeys.set(id, { k, key });
			if (verifiedKeys.size > KEY_CACHE_MAX) verifiedKeys.delete(verifiedKeys.keys().next().value);
		});
		return key;
	}

	/** Does `sig` (base64url) sign `text` with the key `k` of member `id`? */
	async function verifyBy(id, k, text, sig) {
		const key = await keyOf(id, k);
		if (!key || typeof sig !== "string" || sig.length > 120) return false;
		try {
			return await crypto.subtle.verify(ECDSA_SIGN, key, fromB64(sig), utf8.encode(text));
		} catch {
			return false;
		}
	}

	// The keys live in IndexedDB ("neon.keys"), one record per id, CryptoKey
	// and all (structured clone keeps a non-extractable key usable without
	// ever exposing it). A key unused for KEY_TTL_MS is pruned when a new one
	// is made: every new tab makes one, and nothing else would remove them.
	const KEYS_DB = "neon.keys";
	const KEY_TTL_MS = 30 * 24 * 3600 * 1000;
	const TAB_KEY = "neon.key"; // sessionStorage: the id this tab plays as
	let keysDb = null;
	function openKeys() {
		keysDb ??= new Promise((resolve) => {
			try {
				if (typeof indexedDB === "undefined" || !indexedDB) return resolve(null);
				const req = indexedDB.open(KEYS_DB, 1);
				req.onupgradeneeded = () => req.result.createObjectStore("keys", { keyPath: "id" });
				req.onsuccess = () => resolve(req.result);
				req.onerror = () => resolve(null);
				req.onblocked = () => resolve(null);
			} catch {
				resolve(null);
			}
		});
		return keysDb;
	}
	function keysDo(db, mode, fn) {
		return new Promise((resolve) => {
			try {
				const tx = db.transaction("keys", mode);
				const req = fn(tx.objectStore("keys"));
				tx.oncomplete = () => resolve(req?.result ?? null);
				tx.onerror = tx.onabort = () => resolve(null);
			} catch {
				resolve(null);
			}
		});
	}
	const sessionGet = (k) => {
		try {
			return sessionStorage.getItem(k);
		} catch {
			return null;
		}
	};
	const sessionSet = (k, v) => {
		try {
			sessionStorage.setItem(k, v);
		} catch {}
	};
	const identities = new Map(); // id -> identity, this page's
	let tabIdentity = null; // a promise: this tab's own (identity())

	// A key is one live page's at a time: "duplicate tab" and window.open
	// copy sessionStorage, and two tabs naming one key were one player
	// (review, 2026-11-19). The page holds the Web Lock "neon.key:<id>" for
	// its life; a key whose lock another page holds is not this tab's. A
	// reload's own predecessor lets go as it unloads, so the new page waits
	// for it a moment (KEY_LOCK_WAIT_MS) before deciding it is a duplicate.
	// Without Web Locks every key is free, as before.
	const KEY_LOCK_WAIT_MS = 1500;
	const heldKeys = new Set();
	function holdKey(id) {
		if (heldKeys.has(id)) return Promise.resolve(true);
		const locks = typeof navigator !== "undefined" ? navigator.locks : null;
		if (typeof locks?.request !== "function") return Promise.resolve(true);
		return new Promise((resolve) => {
			let opts;
			try {
				opts = { signal: AbortSignal.timeout(KEY_LOCK_WAIT_MS) };
			} catch {
				opts = { ifAvailable: true };
			}
			locks
				.request(`neon.key:${id}`, opts, (lock) => {
					if (!lock) return resolve(false);
					heldKeys.add(id);
					resolve(true);
					return new Promise(() => {}); // held until the page goes
				})
				.catch(() => resolve(false));
		});
	}

	async function newIdentity(db) {
		const pair = await crypto.subtle.generateKey(ECDSA_KEY, false, ["sign", "verify"]);
		const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
		const id = await idOfKey(raw);
		const ident = wrapIdentity(id, toB64(raw), pair.privateKey);
		identities.set(id, ident);
		if (db) {
			const now = Date.now();
			await keysDo(db, "readwrite", (store) => {
				store.put({ id, pub: ident.pub, priv: pair.privateKey, used: now });
				const all = store.getAll();
				all.onsuccess = () => {
					for (const r of all.result ?? []) if (r.id !== id && !(now - (r.used ?? 0) < KEY_TTL_MS)) store.delete(r.id);
				};
				return null;
			});
		}
		return ident;
	}

	async function loadIdentity(db, id) {
		if (identities.has(id)) return identities.get(id);
		if (!db || !isMemberId(id)) return null;
		const rec = await keysDo(db, "readonly", (store) => store.get(id));
		if (!rec?.priv || rec.id !== id) return null;
		keysDo(db, "readwrite", (store) => store.put({ ...rec, used: Date.now() }));
		const ident = wrapIdentity(id, rec.pub, rec.priv);
		identities.set(id, ident);
		return ident;
	}

	/**
	 * This tab's identity, made on first use: `{ id, pub, sign }`.
	 * `{ id }`: the one this browser holds for that id (a rejoin token's),
	 * which this tab then plays as — or null if it holds none (IndexedDB
	 * cleared, a private window's earlier page). `{ fresh: true }`: a new
	 * one that is not this tab's (a second room in one page: tests).
	 */
	async function identity({ id = null, fresh = false } = {}) {
		const db = await openKeys();
		if (fresh) {
			const made = await newIdentity(db);
			await holdKey(made.id);
			return made;
		}
		if (id) {
			const got = await loadIdentity(db, id);
			// This tab plays as it from now on only if no other live page
			// does; otherwise it is lent for this seat alone (the room server
			// decides which tab keeps the seat: room-join `displaced`), and
			// this tab's own key stays its own.
			if (got && (await holdKey(id))) {
				sessionSet(TAB_KEY, id);
				tabIdentity = Promise.resolve(got);
			}
			return got;
		}
		tabIdentity ??= (async () => {
			const mine = sessionGet(TAB_KEY);
			const got = mine && (await loadIdentity(db, mine));
			if (got && (await holdKey(got.id))) return got;
			const made = await newIdentity(db);
			await holdKey(made.id);
			sessionSet(TAB_KEY, made.id);
			return made;
		})();
		const ours = await tabIdentity;
		// One page, two live rooms (a test playing host and guest in one
		// page against the mock room server): one id cannot be two members.
		return liveIds.has(ours.id) ? newIdentity(db) : ours;
	}
	// The ids of this page's rooms that have not closed (Room, _close).
	const liveIds = new Set();

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

	/**
	 * A code from a client before signed messages: its id is not a key's
	 * hash (10 or 12 characters, not 16), which is how it is told without a
	 * byte more in the code (Lokesh, 2026-11-18: codes do not grow beyond the
	 * longer id). Refused at once, saying why.
	 */
	const outdated = (what) =>
		Object.assign(new Error(`That ${what} came from an older version of the arcade. Ask them to reload the page to update, then try again.`), { reason: "outdated" });

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
			this.peerId = null; // who the code or relayed offer says is there
			this.owner = null; // who proved it, by its hello (Room._linkUp)
			this.dc = null;
			this.queue = [];
			this.queued = 0; // characters waiting in `queue`
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
				this.room._linkUp(this);
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
				const str = this.queue.shift();
				this.queued -= str.length;
				this.dc.send(str);
			}
		}

		post(str) {
			if (this.overflowed) return; // dropped below; nothing more to queue
			this.queue.push(str);
			this.queued += str.length;
			if (this.open) this.flush();
			if (this.open && this.queued > MAX_QUEUED) {
				this.overflowed = true;
				this.queue = [];
				this.queued = 0;
				// Not from inside the send that overflowed it: _linkClosed starts
				// suspicion and maybe a re-dial, which a caller mid-broadcast
				// should not run into.
				setTimeout(() => this.room._linkClosed(this), 0);
			}
		}

		/**
		 * This connection's DTLS fingerprints, ours and the far side's, from
		 * the two descriptions: what a hello signs, so a hello is good for
		 * this one connection only (Room._linkUp).
		 */
		fingerprints() {
			const fp = (d) => (d?.sdp?.match(/^a=fingerprint:sha-256 (.+)$/im)?.[1] ?? "").replace(/:/g, "").trim().toUpperCase();
			return { local: fp(this.pc.localDescription), remote: fp(this.pc.remoteDescription) };
		}

		/** Split oversized payloads; the far side reassembles in `receive`. */
		send(envelope) {
			for (const str of toWire(envelope)) this.post(str);
		}

		receive(raw) {
			const msg = fromWire(this.chunks, raw);
			if (msg) this.room._inbound(this, msg);
		}

		/**
		 * `drainMs` keeps the PeerConnection alive a moment after the channel
		 * starts closing, so what was already sent still leaves — tearing the
		 * transport down at once can drop it.
		 */
		close(drainMs = 0) {
			clearTimeout(this.expiry);
			clearTimeout(this.watchdog);
			clearTimeout(this.helloTimer);
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
			identity,
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
			onLost,
			heirWaitMs,
			lostRetryMs,
			natHard,
		}) {
			// Our id is our key's hash (see "identity" above), so a room is
			// given its identity rather than minting an id: `await
			// NeonArcade.identity()` first. Reconnecting after a reload passes
			// the same one, because the member the party record remembers is
			// the old id, and a fresh one would arrive as a stranger — team
			// lost, seat lost. (A `bot_` id can never be a key's hash.)
			if (!identity || !isMemberId(identity.id) || typeof identity.sign !== "function") {
				throw new Error("net.js: a room needs an identity — pass { identity: await NeonArcade.identity() }.");
			}
			this.identity = identity;
			this.selfId = identity.id;
			liveIds.add(this.selfId);
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
			// `(lost) => void`: our side of the party lost the side holding the
			// crown (true), or found it again (false). See _lose.
			this.onLost = onLost;
			this.heirWaitMs = heirWaitMs ?? HEIR_WAIT_MS;
			this.lostRetryMs = lostRetryMs ?? LOST_RETRY_MS;
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
			// What we said about ourselves (setName, setMeta): re-sent while the
			// host's record says otherwise (_reassert).
			this.ownMeta = {};
			this.reassertTimer = null;
			this.relayTimeoutMs = RELAY_TIMEOUT_MS;
			this.openTimeoutMs = OPEN_TIMEOUT_MS;
			this.actions = new Map(); // name   -> { onMessage }
			this.seen = new Set(); // recently delivered envelope ids
			this.seenQueue = [];
			this.inbox = []; // held until resume()
			this.running = false;
			this.closed = false;
			// Our own sends, in order: a signed one (async) holds back the
			// ones after it, signed or not (_send).
			this.outq = Promise.resolve();
			this.outN = 0;
			// Messages dropped because nothing proved who sent them, or the
			// one who did may not send them (_authentic): a count and the last
			// few reasons, for tests and a curious console.
			this.refused = 0;
			this.refusals = [];
			// The crown holder whose own record we last took — its term and
			// members — which a crown's proof is checked against (_proven);
			// that record's signed envelope (passed to a newcomer as its first
			// record, _linkOpened); and, while we hold the crown, the proof
			// that we may. `anchor` is not `lastRecord`: a newcomer's first
			// record anchors it, but gives it no vote (see _applyParty).
			this.anchor = isHost ? { host: this.selfId, term: 0, rev: 0, revs: new Set([0]) } : null;
			this.pastAnchors = []; // earlier terms' anchors, newest first (_proven)
			this.hostEnv = null;
			this.proof = null;

			// The party is a shared record, not a network shape. `host` names the
			// member holding the crown; everything else about the topology is
			// free to change under it. `term` counts crown changes, so two
			// records that disagree about the host can be ordered: see _outranks.
			this.party = {
				host: isHost ? this.selfId : null,
				// This party, as opposed to any other these members were or will
				// be in: minted by its founder, carried by the record, and in
				// every signed message (`pa`), so nothing signed for one party
				// counts in another (review, 2026-11-19). A newcomer learns it
				// from its first record.
				pid: isHost ? randId(12) : null,
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
			// The roster as the crown holder last published it, which the heir
			// is computed over (_successor) — not ours, which our own probes,
			// relinks and goodbyes may have changed since.
			this.lastRecord = null;
			this.lastTerm = 0;
			// Cut off from the crown's side of a split party (_lose), and the
			// wait for an heir we only computed (_watchHeir).
			this.lost = false;
			this.heirTimer = null;
			this.lostRetries = [];
			this.lostTerm = 0;
			this.lostHeir = null;
			// The crown in our record is an heir we computed (not us) and have
			// not heard from yet. Not the same as !heard: a page fresh from a
			// reload has heard nobody, and computed nobody either.
			this.computed = false;
			// The latest vacancy: who left the crown, its first heir, and the
			// heirs passed over since (_succeed).
			this.vacated = null;
			this.firstHeir = null;
			this.skipped = new Set();
			// The election for the crown (_succeed): the vacancy's key, whom we
			// granted per key (one at a time), releases heard, our candidacy,
			// and the highest round seen.
			this.voteKey = null;
			this.voteRec = null; // the vacated holder's record the key was made from (_succeed)
			this.unseen = null; // a crown won while we still saw its vacated holder (_onRecord)
			this.behindSaid = false; // told the player we cannot follow a newer crown (_behind)
			this.granted = new Map();
			this.releases = new Set();
			this.asks = new Map(); // key -> the latest request we had to refuse
			this.committed = new Map(); // key -> the candidate whose commit we acknowledged, for good
			this.sworn = new Map(); // key -> member -> the candidate it acknowledged (seen flooding by)
			this.committedAt = 0;
			this.reaskMs = Math.min(REASK_MS, Math.max(50, (heirWaitMs ?? HEIR_WAIT_MS) / 3));
			this.candidacy = null;
			this.round = 0;
			// Named ourselves, standing for the crown (_stand).
			this.pendingCrown = false;
		}

		// -- public API ---------------------------------------------------

		peerCount() {
			return this.party.members.length - 1;
		}
		/**
		 * Lost, and sworn (we acknowledged its commit) to a candidate that is
		 * past its deadline without a crown: our vote is given for good, so
		 * this side of the party cannot elect anyone — only that candidate's
		 * return could still help. The shell offers a new party.
		 */
		get stranded() {
			const key = this.voteKey;
			const n = key && this.committed.get(key);
			return !!(this.lost && n && n !== this.selfId && performance.now() - this.committedAt > 2 * this.heirWaitMs + this.reaskMs);
		}

		/** Whether this room can ask the room server to put it back in touch (rejoin). */
		get canRejoin() {
			return !!this.onIsolated;
		}

		/**
		 * Lost (see _lose): ask the room server, which may still reach the
		 * crown's side, to have us offered to again — the re-announce an
		 * isolated member makes. Without a room server there is no way back.
		 */
		rejoin() {
			if (!this.closed) this.onIsolated?.();
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
			// Proven when they arrived (_authentic): taken as they are.
			for (const [link, msg] of held) this._accept(link, msg);
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
			// Signed (control), so the channels wait for it: the links are kept
			// aside here and closed once it has gone down them.
			const links = [...this.links.values()];
			let bye = null;
			if (reason === "left") {
				const j = this.party.members.find((m) => m.id === this.selfId)?.joined ?? null;
				bye = { __gone: this.selfId, j, f: this.selfId, t: null, id: randId(8), h: MAX_HOPS };
				const missing = this._missing(bye);
				bye.m = missing.length ? missing : null;
			}
			this.closed = true;
			liveIds.delete(this.selfId);
			// Whoever wired this room up (the room server, most likely) learns the
			// departure here rather than having to poll — this is where the rejoin
			// token stops being valid for us.
			this.onLeave?.(reason);
			for (const { timer } of this.suspects.values()) clearTimeout(timer);
			this.suspects.clear();
			clearTimeout(this.reassertTimer);
			for (const timer of this.swapWait.values()) clearTimeout(timer);
			this.swapWait.clear();
			clearTimeout(this.heirTimer);
			clearTimeout(this.retakeTimer);
			this._stopRetries();
			if (bye) {
				const shut = () => links.forEach((l) => l.close(LEAVE_DRAIN_MS));
				this._sign(bye)
					.then(() => links.forEach((l) => l.send(bye)))
					.then(shut, shut);
			} else for (const link of links) link.close(0);
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
				// `local` marks a bot seat (setBotMeta); the host drops it from a person's.
				if (RESERVED_META.has(k) || k === "local") continue;
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
			// A fresh id per run of a game, shared by everyone through the record:
			// results reported in it are told apart and matched up by it
			// (lib/stats.js, the match reports of docs/accounts.md).
			this.party.run = gameId ? randId(10) : null;
			this._commitParty();
		}
		/** The id of the game run in progress (setGame), or null. */
		getRun() {
			return this.party.run ?? null;
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
			// `j`: the seat evicted, by when it was taken. A replayed __k names
			// an old seat, and a member who has since come back holds a new one.
			const j = this.party.members.find((m) => m.id === memberId)?.joined ?? null;
			if (!isBotId(memberId)) this._send({ __k: memberId, j, f: this.selfId, t: null }, null);
			// Their link stays until the __k (signed: queued) has gone down it.
			this._dropMember(memberId, "removed", { linger: true });
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

		/**
		 * Host only. Merge fields into one of our bots' records — not the
		 * fields the record owns (RESERVED_META). The quick table marks a bot
		 * seat played by a person on this device `{ local: true }`
		 * (lib/party.js), and it replicates like the rest of the record.
		 */
		setBotMeta(botId, patch) {
			if (!this.isHost() || !isBotId(botId)) return;
			const clean = {};
			for (const [k, v] of Object.entries(patch ?? {})) if (!RESERVED_META.has(k)) clean[k] = v;
			if (Object.keys(clean).length) this._editMember(botId, clean);
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
			// `o`: who vouches for the bot — us, the crown (see _authentic).
			const env = { a: actionName, d: data, f: botId, o: this.selfId, t: opts?.target ?? null };
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
			// `tr`: the crown's term. A replay reaching a party that has moved on
			// to another holder is old news (and another party's is another
			// party's: `pa`).
			this._send({ __x: 1, tr: this.party.term ?? 0, f: this.selfId, t: null }, null);
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
			const base = NeonArcade.shareBase();
			return {
				code,
				link: `${base}#i=${code}`,
				/** Close it, unless an answer has already taken it. */
				withdraw: () => {
					if (this.pending.get(slot) === link && !link.peerId) this._abandon(link);
				},
			};
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
			if (!isMemberId(peerId)) throw outdated("reply");
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
			if (!isMemberId(inviterId)) throw outdated("invite");
			const pc = trackCandidates(new RTCPeerConnection({ iceServers: this.iceServers }));
			const link = new Link(this, pc, slot);
			link.peerId = inviterId;
			// The member the invite (or the room server's offer) named: the
			// one whose own record a newcomer may take as its first (_onRecord).
			link.named = true;
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
				// Echoed in the answer, so an answer to an offer since abandoned
				// cannot land on the one that replaced it (_onRelayedAnswer).
				link.nonce = randId(6);
				this.negotiating.set(peerId, link);
				this.pending.set("r:" + peerId, link);
				this._expire(link);

				await pc.setLocalDescription(await pc.createOffer());
				await gatherIce(pc);
				// Abandoned while we gathered (_redial, a link that opened): not sent.
				if (this.closed || this.negotiating.get(peerId) !== link) return;
				// Kept, id and all, so it can go again unchanged (_resendOffer).
				link.offerEnv = {
					__g: "offer",
					f: this.selfId,
					t: peerId,
					sdp: pc.localDescription.sdp,
					n: link.nonce,
					...(retry ? { r: 1 } : {}),
				};
				this._send(link.offerEnv, null);
			} catch (err) {
				if (link) this._abandon(link);
			}
		}

		async _onRelayedOffer(from, sdp, retry = false, nonce = null) {
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
					{ __g: "answer", f: this.selfId, t: from, sdp: pc.localDescription.sdp, ...(nonce ? { n: nonce } : {}) },
					null,
				);
			} catch {
				this._abandon(link);
			}
		}

		async _onRelayedAnswer(from, sdp, nonce = null) {
			const link = this.pending.get("r:" + from);
			if (!link) return;
			// The answer to another offer of ours, one since abandoned. (An
			// answer with no nonce is from a client before nonces: taken.)
			if (nonce && link.nonce && nonce !== link.nonce) return;
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
		_redial(peerId) {
			// `peerId` has noticed only now that our direct link dropped — a
			// drop is often seen at one end first. An offer of ours made while
			// they still held the link was set aside (_onRelayedOffer) and
			// marked seen, so resending it would be dropped too: abandon it and
			// make a fresh one, which they now take. If we had not made one,
			// this is our cue (the lower id offers; _openRelayed checks).
			if (this.closed || isBotId(peerId) || this.links.has(peerId)) return;
			if (!this.party.members.some((m) => m.id === peerId)) return;
			const link = this.pending.get("r:" + peerId);
			// Only an offer already sent was set aside; one still gathering
			// goes out now and they take it.
			if (link?.offerEnv && !link.answered) this._abandon(link);
			this._openRelayed(peerId);
		}

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
			clearTimeout(link.helloTimer);
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

		// -- who is on a link ---------------------------------------------

		/**
		 * A data channel opened. Before anything else crosses it, each side
		 * proves it holds the key of the id it claims: a hello, `{ __hi:
		 * PROTO, k: <raw public key>, s }`, `s` signing "neon-link|" + the
		 * far side's DTLS fingerprint + "|" + our own. The receiver checks it
		 * against the fingerprints of its own connection and the key against
		 * the id the code or the relayed offer named (link.peerId). So the
		 * hello is good for this connection only, and a member who relays an
		 * offer under somebody else's id — and answers it itself — cannot
		 * finish it: the link closes unregistered (the relayed-offer hijack,
		 * 2026-11-18). Until the hello verifies, nothing else is taken, and
		 * the link is not ours (no _linkOpened).
		 */
		_linkUp(link) {
			if (!link.peerId) return;
			if (this.closed) return link.close();
			clearTimeout(link.helloTimer);
			link.helloTimer = setTimeout(() => {
				if (!link.owner && !link.refused && !this.closed) this._refuse(link, "silent");
			}, HELLO_MS);
			const { local, remote } = link.fingerprints();
			// Kept: nothing else may go down this link before it (_preHello),
			// or the far side would take us for an old client.
			link.hello = this.identity
				.sign(`neon-link|${remote}|${local}`)
				.then((s) => void (!link.refused && link.send({ __hi: PROTO, k: this.identity.pub, s })))
				.catch((err) => console.warn("[neon] could not sign a hello:", err));
		}

		/** A message on a link whose far end has not proved itself yet. */
		_preHello(link, msg) {
			if (link.refused || link.owner) return;
			// Anything before a hello is an old client: a current one always
			// says hello first, and the channel is ordered.
			if (msg.__hi === undefined) return this._refuse(link, "old");
			if (msg.__hi !== PROTO) return this._refuse(link, msg.__hi > PROTO ? "newer" : "old");
			const { local, remote } = link.fingerprints();
			const checked = verifyBy(link.peerId, msg.k, `neon-link|${local}|${remote}`, msg.s);
			return Promise.all([checked, link.hello]).then(([ok]) => {
				if (this.closed || link.refused) return;
				if (!ok || !local || !remote) return this._refuse(link, "forged");
				clearTimeout(link.helloTimer);
				link.owner = link.peerId;
				this._linkOpened(link);
			});
		}

		/**
		 * Close a link whose far end did not prove itself, and say why.
		 * "old": it speaks the unsigned protocol, which no client may since
		 * 2026-11-18 (Lokesh: no transition window, and both sides told —
		 * never a silent hang). Told in the words an old client knows: an
		 * unsigned `__k` naming it, which it takes as an eviction and closes
		 * on ("You were removed from the party."). Only from a member of an
		 * established party: a newcomer that finds the *party* old must not
		 * evict its inviter from it, so it says goodbye (`__gone`) instead,
		 * and its own player is told to have them reload. "newer": the far
		 * side's protocol is past ours; this page must reload. "forged": the
		 * hello did not verify (a hijack, or a corrupt key) — closed, no
		 * message. "silent": no hello at all in HELLO_MS.
		 */
		_refuse(link, why) {
			if (link.refused) return;
			link.refused = true;
			clearTimeout(link.helloTimer);
			this._refused(`link: ${why}`);
			const peerId = link.peerId;
			const name = link.introducedName || this.party.members.find((m) => m.id === peerId)?.name || "A player";
			const established = this.party.host !== null;
			let message = null;
			if (why === "old") {
				const words = established ? { __k: peerId } : { __gone: this.selfId };
				try {
					link.send({ ...words, f: this.selfId, t: null, id: randId(8), h: 0 });
				} catch {}
				message = established
					? `${name} is on an older version of the arcade. They need to reload the page to update.`
					: "This party is on an older version of the arcade. Ask them to reload the page to update.";
			} else if (why === "newer") {
				message = "This page is an older version of the arcade than the party's. Reload it to update.";
			} else if (why === "silent") {
				message = `${name} did not say who they are. They may be on an older version of the arcade: ask them to reload the page.`;
			} else console.warn("[neon] a link's hello did not verify; closed:", peerId);
			this._forget(link);
			link.close(why === "old" ? LEAVE_DRAIN_MS : 0);
			if (message) this.onError?.(message, { reason: why === "newer" ? "outdated-self" : "outdated", peerId });
		}

		/** Count a message dropped as unproven or unauthorised (`refused`). */
		_refused(why) {
			this.refused++;
			this.refusals.push(why);
			if (this.refusals.length > REFUSALS_KEPT) this.refusals.shift();
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
					this._send({ __i: { id: peerId, back: true }, f: this.selfId, t: null }, null);
				}
				this._publish();
			}

			// Whoever already holds the crown owns the party record and answers
			// with it. A newcomer's first inbound message is therefore the roster.
			if (this.isHost()) {
				this._addMember(peerId, link.introducedName);
				// Its hello proved it: no longer seated on somebody's word.
				const m = this.party.members.find((x) => x.id === peerId);
				if (m?.pend) delete m.pend;
				this._commitParty();
			} else if (this.party.host !== null) {
				// A newcomer knows nobody yet, so it cannot address the host and it
				// cannot broadcast either — it does not know who is missing. Hand it
				// the crown holder's record first; that is where it learns who holds
				// the crown. The record as its holder signed it (a copy of ours
				// would be our word, not the host's: _onRecord).
				//
				// Only an established member does this. The newcomer itself has no
				// record worth sending, and its introduction of the inviter would
				// carry the name from the invite — stale if they renamed since.
				// Marked `fw`: a copy handed on, which gives the newcomer no
				// vote (_applyParty).
				if (this.hostEnv) link.send({ ...this.hostEnv, h: 0, m: null, fw: 1 });
				// Then tell the host, on the newcomer's behalf, that they exist.
				// This is what lets any member do the recruiting. A broadcast,
				// so it finds whoever holds the record (see the __i handler).
				if (!this.party.members.some((m) => m.id === peerId)) {
					this._send({ __i: { id: peerId, name: link.introducedName }, f: this.selfId, t: null }, null);
				}
			}
			this.onOpen?.(peerId);
			this._meshUp();
			// Lost, and a link just opened: an heir we passed over that we
			// reach again is a candidate again, and its record (or the crown's
			// side's) may be on its way. Give it the heir's wait, then stand
			// again (_standAgain) — two lost phones that relink must not stay
			// lost for good.
			if (this.lost) {
				this.skipped.delete(peerId);
				clearTimeout(this.retakeTimer);
				this.retakeTimer = setTimeout(() => this._standAgain(), this.heirWaitMs);
			}
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
			// A crown won while we still saw its vacated holder: seen now.
			const unseen = this.unseen;
			if (unseen && unseen.gone === peerId) {
				this.unseen = null;
				this._onRecord(unseen.msg, unseen.link);
			}
			if (this.party.members.some((m) => m.id === peerId)) this._suspect(peerId);
			// A request refused while we still held this member's link, as the
			// one that left: it is gone for us now too.
			for (const key of [...this.asks.keys()]) if (key.split("|")[0] === peerId) this._askAgain(key);
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
		 *
		 * The second vouch after a drop also dials them again (the lower id
		 * offers, over the links we have) — the second, 2.5 s on, so a stale
		 * vouch for a member who is in fact leaving does not cost an offer to
		 * a seat about to be dropped or held. Waiting for the next roster change
		 * left a pair relay-only for as long as nobody joined or left — and
		 * if their relay then left, the host most of all, each lost the other
		 * and crowned itself: the party split in two (2026-11-16, test-party).
		 * A dial that fails is swapped once (_routeFailed) and then waits for
		 * a roster change, as any failed pair does.
		 */
		_vouch(peerId) {
			const entry = this.suspects.get(peerId);
			if (!entry) return;
			clearTimeout(entry.timer);
			this.suspects.delete(peerId);
			if (this.links.has(peerId)) return;
			if (entry.attempt === 1) this._openRelayed(peerId);
			if (entry.attempt >= VOUCH_RETRIES) return;
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
				if (peerId === this.party.host) {
					this._send({ __v: peerId, f: this.selfId, t: null }, null);
					this._vacateCrown(peerId);
				}
				setTimeout(() => {
					if (this.closed) return;
					const m = this.party.members.find((x) => x.id === peerId);
					// Came back — the link opening cleared the mark — or someone
					// else's broadcast already dropped them.
					if (!m?.reconnecting || this.links.has(peerId)) return;
					if (Date.now() - m.reconnecting < this.reconnectGraceMs) return;
					this._send({ __gone: peerId, j: m.joined ?? null, f: this.selfId, t: null }, null);
					this._applyGone(peerId);
				}, this.reconnectGraceMs);
				return;
			}
			this._send({ __gone: peerId, j: member.joined ?? null, f: this.selfId, t: null }, null);
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
		/**
		 * The room server says this member gave their seat back. Only they can
		 * — a release takes their secret — so it is as good as their own
		 * `__gone`, which never comes when the tab that held the seat closed
		 * long ago and the browser has since moved on to another party.
		 */
		serverReleased(peerId) {
			// A live link says they are here whatever the server thinks.
			if (isBotId(peerId) || this.links.has(peerId)) return;
			this._applyGone(peerId, "left");
		}

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
				if (this.lost) return; // nobody here may crown: see _lose
				this._dropMember(peerId, reason);
				return this._vacateCrown(peerId, reason === "left");
			}
			this._dropMember(peerId, reason);
			this._publish();
		}

		/**
		 * The crown is vacant — its holder left, or (a room-server member whose
		 * seat is waiting out the reconnect grace) cannot be vouched for, in
		 * which case the seat stays but the crown moves. The heir takes it, and
		 * the bots with it.
		 */
		_vacateCrown(gone = this.party.host, left = false) {
			if (this.lost) return;
			// The crown sat with an heir we only computed and have not heard
			// from, and our side has now concluded it gone too (not by its own
			// goodbye): it is skipped, and the next in line may take it — but
			// only by winning the election (_succeed). Not a new vacancy.
			if (this.computed && gone === this.party.host && !left) {
				this.skipped.add(gone);
				return this._succeed();
			}
			// Bots stay. They used to leave with the crown, because the host was
			// the only browser simulating them and the next host would have been
			// handed a game it could not finish — but a crown change now ends the
			// running game (party.js checkCrown, lobby.js), and whoever holds the
			// crown plays every bot in the next one. Dropping them meant a host
			// whose connection blinked came back to a party with its bots gone.
			//
			// Succession is automatic: the heir takes the crown the moment it
			// vacates, on every browser at once, because they all compute the
			// same heir from the same roster — the one its holder last
			// published (_successor). No offer, no button.
			//
			// Only the heir bumps the term, because only the heir publishes. The
			// rest have merely *computed* who it should be, so until the heir's
			// record arrives they yield to any crown holder that speaks up at
			// the old term — which is how a false alarm heals (see _outranks).
			//
			// Only the heir's side of a split party carries on (Lokesh,
			// 2026-11-16): a member that cannot reach the heir does not crown
			// itself. An heir that stays silent may be passed over, but only by
			// a side holding a quorum (Lokesh, 2026-11-17, "skip hidden +
			// quorum"); otherwise that side is lost (_lose).
			this.vacated = gone;
			this.skipped.clear();
			this.firstHeir = null;
			this.voteKey = null;
			this.voteRec = null;
			this.candidacy = null;
			this._succeed();
		}

		/**
		 * Name who holds the vacated crown, and let only one member take it.
		 *
		 * The member named stands for it (_stand): it asks for grants, and every
		 * member grants **one** candidate per vacancy — Raft's vote, without
		 * terms. It crowns when the grants it holds are more than half of the
		 * record's humans, or exactly half with the first heir among them.
		 * Grant sets are disjoint, so at most one candidate ever crowns (an
		 * earlier version counted who had said "here", and a member counted
		 * on two sides of a split made two crowns — three, once).
		 *
		 * A silent heir never asks, so nobody is bound to it: when its wait
		 * runs out (_watchHeir), or our side concludes it gone, the next in
		 * line is named. A candidate that cannot gather a quorum in the heir's
		 * wait releases its grants (`__r`) and never crowns for that round;
		 * members are free again only when they hear it. Anyone named without
		 * a way to win, or bound to a candidate it cannot reach, is lost.
		 */
		_succeed() {
			if (this.firstHeir === null) this.firstHeir = this._successor(this.vacated);
			if (this.voteKey === null) {
				this.voteKey = this._voteKey(this.vacated);
				// The vacated holder's own signed record the key was made from:
				// a certificate carries it, so anyone can rebuild the key (_proven).
				const e = this.hostEnv;
				this.voteRec = e && e.f === this.vacated && voteKeyOf(e.__p?.members, e.__p?.term ?? 0, this.vacated) === this.voteKey ? structuredClone(e) : null;
			}
			const next = this._successor(this.vacated);
			if (next === this.selfId) {
				// We stood already and lost the round, and nobody else is left.
				if (this.skipped.has(this.selfId)) return this._lose();
				return this._stand(1);
			}
			this.party.host = next;
			this.heard = false;
			this.computed = true;
			this._publish();
			this.onHostVacant?.(next, false);
			// Our own side already dropped them: not reachable from here.
			if (!this.party.members.some((m) => m.id === next)) {
				this.skipped.add(next);
				return this._succeed();
			}
			this._watchHeir(next);
		}

		/**
		 * The election's key for vacancy `gone`: who left, the record's term,
		 * the tie-break heir and the record's humans. Members vote only on a
		 * key equal to their own, so every vote counts against the same roster
		 * — two records of one term can differ, and two different fractions
		 * could both be met. The tie-break heir is the oldest of those humans
		 * by `joined`, whatever their `away` or held seat: those marks change
		 * within a term, and a record marking the first heir away that reached
		 * only one side of a split made two keys that differed in the tie-break
		 * alone — each side won its exact half (2026-11-18). `away` and held
		 * seats still steer who is *named* (_successor), never who wins a tie.
		 * (Still open: a missed record that changes the humans themselves.)
		 * Null without a record heard from a crown holder
		 * (a page fresh from a reload, a newcomer): such a page has no vote,
		 * which is also what keeps a page reloaded mid-vote from granting a
		 * second candidate (its grant died with the old page).
		 */
		_voteKey(gone) {
			if (!this.lastRecord || gone === null) return null;
			return voteKeyOf(this.lastRecord, this.lastTerm, gone);
		}

		/** The humans and the tie-break heir a key was made from. */
		_keyParts(key) {
			const [, , first, humans] = key.split("|");
			return { first, humans: new Set(humans ? humans.split(",") : []) };
		}

		/**
		 * Stand for the crown in round `round` of our vacancy, in two phases:
		 *
		 * 1. Grants. Grant ourselves and ask everyone (`__c`). A grant counts
		 *    only inside the heir's wait from standing (by both clocks); a
		 *    voter's grant lapses after twice that, unless it acknowledged a
		 *    commit (below). With a quorum of grants we commit.
		 * 2. Commit. Broadcast `__ck`; a voter that still holds its grant to us
		 *    acknowledges (`__ka`) and is bound to us for that key for good — it
		 *    never lapses, grants nobody else, acknowledges no other commit. We
		 *    crown only on a quorum of acknowledgements.
		 *
		 * Why it is safe: any two quorums of one key share a member, and that
		 * member acknowledges at most one commit per key — so at most one
		 * candidate ever crowns, however late its record gets out. (Grants
		 * alone were not enough: a winner whose record never left kept its
		 * voters only until their grants lapsed, and a second one won too —
		 * 2026-11-18.) Everything is re-sent every REASK_MS while it matters,
		 * and flooded through the mesh, so a half-dead link loses nothing.
		 *
		 * No record, no vote: we wait for the crown's record instead. Bound
		 * to another candidate, we wait for that grant to lapse (or the
		 * crown's record), and stand then; committed to one, we cannot stand.
		 */
		_stand(round) {
			clearTimeout(this.heirTimer);
			this.pendingCrown = true;
			this.heard = false;
			const key = this.voteKey;
			const bound = key && this.granted.get(key);
			if (!key || (this.committed.has(key) && this.committed.get(key) !== this.selfId)) {
				// No vote, or ours is given for good: the crown's record may still reach us.
				this.heirTimer = setTimeout(() => {
					if (!this.closed && !this.lost && this.pendingCrown) this._lose();
				}, this.heirWaitMs);
				return;
			}
			if (bound && bound.n !== this.selfId) {
				const wait = Math.max(this.heirWaitMs, bound.at + 2 * this.heirWaitMs - performance.now() + 50);
				this.heirTimer = setTimeout(() => {
					if (this.closed || this.lost || !this.pendingCrown) return;
					if (this.granted.get(key) || this.committed.has(key)) this._lose();
					else this._stand(round);
				}, wait);
				return;
			}
			this.round = Math.max(this.round, round);
			this.granted.set(key, { n: this.selfId, round: this.round, at: performance.now() });
			// When we stood, on both clocks: grants count only inside the heir's
			// wait from here (_granted).
			this.candidacy = {
				key,
				round: this.round,
				grants: new Set([this.selfId]),
				acks: null,
				at: performance.now(),
				wall: Date.now(),
			};
			this._election();
			if (this._quorumOf(this.candidacy.grants, key)) return this._commit();
			// The grant window: no quorum by then, and we give the grants back.
			this.heirTimer = setTimeout(() => {
				if (this.candidacy && !this.candidacy.acks) this._release();
			}, this.heirWaitMs);
		}

		/**
		 * Say where our candidacy stands — the request, or the commit — and
		 * again every REASK_MS while it can still matter: a lost copy (a
		 * half-dead link) is made good by the next, and voters answer a repeat
		 * as they answered the first.
		 */
		_election() {
			const c = this.candidacy;
			if (!c || this.closed) return;
			if (c.acks) this._send({ __ck: c.key, r: c.round, f: this.selfId, t: null }, null);
			else this._send({ __c: c.key, r: c.round, f: this.selfId, t: null }, null);
			clearTimeout(c.again);
			c.again = setTimeout(() => this._election(), this.reaskMs);
		}

		/** Whether `ids` win the election `key` (see _succeed). */
		_quorumOf(ids, key) {
			const { first, humans } = this._keyParts(key);
			const g = [...ids].filter((id) => humans.has(id));
			return 2 * g.length > humans.size || (2 * g.length === humans.size && g.includes(first));
		}

		/** A grant for our candidacy reached us. */
		_granted(key, round, from) {
			const c = this.candidacy;
			if (!c || c.key !== key || c.round !== round || c.acks) return; // another round's, or committing
			// Only inside the heir's wait from standing, by either clock (a
			// device asleep stops the monotonic one, not the wall clock).
			if (performance.now() - c.at > this.heirWaitMs || Date.now() - c.wall > this.heirWaitMs) return;
			c.grants.add(from);
			if (this._quorumOf(c.grants, key)) this._commit();
		}

		/**
		 * A quorum of grants: commit. We are bound to ourselves for good, and
		 * wait for a quorum of acknowledgements — until every grant we hold
		 * could have lapsed (twice the heir's wait from standing). Short of
		 * one by then, we give up: those who acknowledged stay bound to us
		 * (the narrow window that costs), the rest are released.
		 */
		_commit() {
			const c = this.candidacy;
			if (!c || c.acks) return;
			clearTimeout(this.heirTimer);
			this.committed.set(c.key, this.selfId);
			c.acks = new Set([this.selfId]);
			c.proof = new Map(); // member -> its signed acknowledgement
			this._election();
			if (this._quorumOf(c.acks, c.key)) return this._crown();
			const left = c.at + 2 * this.heirWaitMs + this.reaskMs - performance.now();
			this.heirTimer = setTimeout(() => {
				if (this.candidacy === c) this._release();
			}, Math.max(this.reaskMs, left));
		}

		/** An acknowledgement of our commit reached us. */
		_acked(key, round, from, env) {
			const c = this.candidacy;
			if (!c || !c.acks || c.key !== key || c.round !== round) return;
			c.acks.add(from);
			if (env) {
				const { h, m, ...ack } = env;
				c.proof.set(from, ack);
			}
			if (this._quorumOf(c.acks, key)) this._crown();
		}

		/**
		 * No quorum in time: give the grants back (`__r`, said three times),
		 * never to count them again, and step aside — the next in line is
		 * named, or, with nobody left, we are lost.
		 */
		_release() {
			const c = this.candidacy;
			if (!c || this.closed) return;
			clearTimeout(c.again);
			this.candidacy = null;
			this.pendingCrown = false;
			const say = () => !this.closed && this._send({ __r: c.key, r: c.round, f: this.selfId, t: null }, null);
			say();
			setTimeout(say, this.reaskMs);
			setTimeout(say, 2 * this.reaskMs);
			if (this.granted.get(c.key)?.n === this.selfId) this.granted.delete(c.key);
			this.skipped.add(this.selfId);
			if (this.lost) return;
			this._succeed();
		}

		/**
		 * Somebody stands (`__c`). We grant them if our record makes the same
		 * election (an equal key: a page with no record has no vote) and we
		 * have granted nobody else for it — their own new round included: a
		 * candidate starts one only after releasing the last. Asked again, we
		 * answer again. A grant is never given while we still hold a link to
		 * the member that left (it is not gone for us), nor once we have
		 * acknowledged another's commit.
		 */
		_asked(key, round, from, at = performance.now()) {
			if (from === this.selfId || this.closed) return;
			if (this.releases.has(`${key}#${round}#${from}`)) return; // its release overtook its request
			const gone = key.split("|")[0];
			if (key !== (this.voteKey ?? this._voteKey(gone))) return;
			const sworn = this.committed.get(key);
			if (sworn && sworn !== from) return;
			const bound = this.granted.get(key);
			// Already theirs, this round: say so again (a lost grant, a repeat).
			if (bound && bound.n === from && bound.round === round) {
				this._send({ __gr: key, r: round, n: from, f: this.selfId, t: null }, null);
				return;
			}
			// Not now — the member that left is not gone for us yet, or our
			// grant is given — but perhaps soon: kept, and granted then if it is
			// still young enough to count (_askAgain).
			if (this.links.has(gone) || (bound && bound.n !== from)) {
				this.asks.set(key, { n: from, round, at });
				return;
			}
			this.asks.delete(key);
			const now = performance.now();
			this.granted.set(key, { n: from, round, at: now });
			this.round = Math.max(this.round, round);
			this._send({ __gr: key, r: round, n: from, f: this.selfId, t: null }, null);
			// A grant to a candidate that then goes silent (its tab died
			// before it could release) would bind us for good. It lapses after
			// twice the heir's wait — unless we acknowledged its commit.
			setTimeout(() => {
				const g = this.granted.get(key);
				if (this.closed || !g || g.n !== from || g.round !== round || g.at !== now) return;
				if (this.committed.get(key) === from) return;
				this.granted.delete(key);
				this._askAgain(key);
			}, 2 * this.heirWaitMs);
		}

		/**
		 * A candidate commits (`__ck`). We acknowledge if we still hold our
		 * grant to it — this round, not lapsed — or acknowledged it already
		 * (said again); and then we are bound to it for this key for good.
		 */
		_commitAsked(key, round, from) {
			if (from === this.selfId || this.closed) return;
			const sworn = this.committed.get(key);
			if (sworn && sworn !== from) return;
			if (!sworn) {
				const g = this.granted.get(key);
				if (!g || g.n !== from || g.round !== round) return;
				if (performance.now() - g.at > 2 * this.heirWaitMs) return; // lapsed, its timer late
				this.committed.set(key, from);
				this.committedAt = performance.now();
				// Past its deadline with no crown, the shell says so (stranded).
				setTimeout(() => {
					if (!this.closed && this.lost && this.committed.get(key) === from) this._emitParty();
				}, 2 * this.heirWaitMs + this.reaskMs + 50);
			}
			this._send({ __ka: key, r: round, n: from, f: this.selfId, t: null }, null);
		}

		/** A request we had to refuse may be grantable now. */
		_askAgain(key) {
			const a = this.asks.get(key);
			if (!a || this.closed) return;
			// Too old to count where it was made: dropped.
			if (performance.now() - a.at > this.heirWaitMs) return void this.asks.delete(key);
			this._asked(key, a.round, a.n, a.at);
		}

		/** A candidate gave its grants back (`__r`): we are free to grant again. */
		_released(key, round, from) {
			this.releases.add(`${key}#${round}#${from}`);
			const bound = this.granted.get(key);
			if (bound?.n === from && bound.round === round && this.committed.get(key) !== from) {
				this.granted.delete(key);
				this._askAgain(key);
			}
		}

		/** Take the crown: the next term is ours, and so is the record. */
		_crown() {
			const wasLost = this.lost;
			const c = this.candidacy;
			this.lost = false;
			this.pendingCrown = false;
			clearTimeout(c?.again);
			this.candidacy = null;
			this._stopRetries();
			clearTimeout(this.heirTimer);
			this.party.host = this.selfId;
			this.heard = true;
			this.computed = false;
			// The term after the vacancy's, and the acknowledgements that won
			// it: shown with every record we publish (_proven).
			const was = c ? Number(c.key.split("|")[1]) : NaN;
			this.party.term = Number.isInteger(was) ? was + 1 : (this.party.term ?? 0) + 1;
			if (c && !this.voteRec) console.warn("[neon] crowned without the record the election was won from: others cannot check this crown");
			this.proof = c ? { term: this.party.term, cp: trimProof({ v: "vote", key: c.key, rec: this.voteRec, acks: [...c.proof.values()] }) } : null;
			this._publish();
			this.onHostVacant?.(this.selfId, true);
			if (wasLost) this.onLost?.(false);
		}

		/**
		 * Who takes the crown `gone` held: the longest-present member of the
		 * roster its holder last published, as _ranked orders it — not of our
		 * own copy, which our probes may have thinned (a member we dropped is
		 * one *we* cannot reach, not one the party lost). Skipped: heirs passed
		 * over (skipped), held seats, and — while anyone else can take it —
		 * hidden ones (`away`: a phone in the background cannot run a party).
		 * Every one of those marks is read from the record itself, never from
		 * our own copy, which a relink or a probe may have changed: everyone
		 * reads the same record, so everyone names the same member (a review
		 * found two sides naming different heirs, and both crowning, when one
		 * read a held seat its relink had cleared). A goodbye seen since is
		 * not on the record either: a gone heir is passed over after the wait.
		 * A page with no record (a reload) names from its own copy, but has no
		 * vote (_voteKey).
		 */
		_successor(gone) {
			const pool = (this.lastRecord ?? this.party.members).filter(
				(m) => m.id !== gone && !isBotId(m.id) && !this.skipped.has(m.id) && !m.reconnecting && !m.pend,
			);
			const awake = pool.filter((m) => !m.away);
			const ranked = (awake.length ? awake : pool).sort((a, b) => a.joined - b.joined || (a.id < b.id ? -1 : 1));
			return ranked[0]?.id ?? this.selfId;
		}

		/** Wait for the heir we computed to speak; silence passes it over (_succeed). */
		_watchHeir(heir, wait = this.heirWaitMs) {
			clearTimeout(this.heirTimer);
			this.heirTimer = setTimeout(() => {
				if (this.closed || this.lost || this.heard || this.party.host !== heir) return;
				// It asked and we granted it: we wait until our grant lapses, as
				// the next in line can only gather grants from members that are
				// free.
				const g = this.voteKey && this.granted.get(this.voteKey);
				const left = g?.n === heir && g.at ? g.at + 2 * this.heirWaitMs - performance.now() : 0;
				if (left > 0) return this._watchHeir(heir, left + 50);
				this.skipped.add(heir);
				this._succeed();
			}, wait);
		}

		/**
		 * Our side of a split party cannot reach the side holding the crown,
		 * and cannot take it either. We do not crown — that side is the party
		 * — and the shell stops the game and says so (onLost). The room server,
		 * where there is one, may still reach the heir: we re-announce, as an
		 * isolated member does, a few times over the next half minute, and
		 * rejoin() asks again. The heir's record (or the old host's, if it
		 * still seats the heir: _outranks) ends this in _applyParty — we
		 * rejoin that party, seat and all, and never fork it. Lost phones that
		 * link up again may still win an election in a new round
		 * (_linkOpened → _standAgain).
		 */
		_lose() {
			if (this.lost || this.closed) return;
			this.lost = true;
			this.pendingCrown = false;
			this.lostTerm = this.party.term ?? 0;
			this.lostHeir = this.firstHeir ?? this.party.host;
			clearTimeout(this.heirTimer);
			this.onLost?.(true);
			this.onIsolated?.();
			this._stopRetries();
			this.lostRetries = this.lostRetryMs.map((ms) =>
				setTimeout(() => {
					if (this.lost && !this.closed) this.onIsolated?.();
				}, ms),
			);
		}

		_stopRetries() {
			for (const t of this.lostRetries) clearTimeout(t);
			this.lostRetries = [];
		}

		/**
		 * Lost, a while after a link opened: whoever ranks first among us and
		 * the members we now link to directly stands again, in a new round of
		 * the same election — same key, so the same grants bind: a member
		 * still bound to a candidate that never released it does not grant.
		 */
		_standAgain() {
			if (!this.lost || this.closed || this.vacated === null || this.candidacy || !this.voteKey) return;
			const key = this.voteKey;
			// Members acknowledged our commit: they can elect nobody else, so we
			// stand whatever our rank (a review found everyone lost for good:
			// the first-ranked was sworn to us and could not stand, and we
			// never ranked first).
			if (this.committed.get(key) === this.selfId) return this._stand(this.round + 1);
			// Sworn to somebody else, we cannot stand; nor can those we saw
			// acknowledge another's commit — they are left out of the ranking,
			// so the next free member is not stuck waiting on them.
			if (this.committed.has(key)) return;
			const sworn = this.sworn.get(key) ?? new Map();
			const { humans } = this._keyParts(key);
			const near = new Set([this.selfId, ...this.links.keys()]);
			const rank = (this.lastRecord ?? [])
				.filter((m) => humans.has(m.id) && near.has(m.id) && !m.reconnecting && !(sworn.has(m.id) && sworn.get(m.id) !== m.id))
				.sort((a, b) => a.joined - b.joined || (a.id < b.id ? -1 : 1));
			if (rank[0]?.id !== this.selfId) return;
			this._stand(this.round + 1);
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
				.filter((m) => !isBotId(m.id) && !m.reconnecting && !m.pend)
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

		_dropMember(id, reason, { linger = false } = {}) {
			const member = this.party.members.find((m) => m.id === id);
			this.party.members = this.party.members.filter((m) => m.id !== id);
			if (member) this._emitLeave(id, member, reason);
			const link = this.links.get(id);
			if (!link) return;
			const close = () => {
				if (this.links.get(id) === link) this.links.delete(id);
				link.close(linger ? LEAVE_DRAIN_MS : 0);
			};
			if (linger) this.outq.then(close, close);
			else close();
		}

		_editSelf(patch) {
			const me = this.party.members.find((m) => m.id === this.selfId);
			if (!me) return;
			Object.assign(this.ownMeta, patch);
			Object.assign(me, patch);
			if (!this.isHost()) {
				this._send({ __i: { id: this.selfId, ...patch }, f: this.selfId, t: null }, null);
			}
			this._publish();
		}

		/**
		 * Our own fields as the host's record has them, against what we said
		 * (ownMeta), or null when they agree. A missing field and null agree.
		 */
		_ownDrift() {
			const me = this.party.members.find((m) => m.id === this.selfId);
			if (!me) return null;
			const diff = {};
			for (const [k, v] of Object.entries(this.ownMeta)) {
				if (JSON.stringify(me[k] ?? null) !== JSON.stringify(v ?? null)) diff[k] = v;
			}
			// Seated on somebody else's word (`pend`): speaking for ourselves
			// is what proves us to the host, even with nothing to change.
			return Object.keys(diff).length || me.pend ? diff : null;
		}

		/**
		 * The host's record disagrees with what we said about ourselves: say
		 * it again (review, 2026-11-17). An edit can be lost — the host refuses
		 * a relayed self-edit while it holds a direct link to us, and that link
		 * may be dying — or forged by a relay that `f` cannot unmask (the
		 * host's __i). Checked again a moment later, so an edit merely still in
		 * flight is not sent twice; at most one every REASSERT_MS.
		 */
		_reassert() {
			if (this.closed || this.isHost() || !this.party.host || this.reassertTimer || !this._ownDrift()) return;
			this.reassertTimer = setTimeout(() => {
				this.reassertTimer = null;
				if (this.closed || this.isHost() || !this.party.host) return;
				const diff = this._ownDrift();
				if (diff) this._send({ __i: { id: this.selfId, ...diff }, f: this.selfId, t: null }, null);
			}, REASSERT_MS);
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
			// Our own record, unless it is the one handing the crown on
			// (transferHost): until the next holder's arrives, ours at the
			// term before is the one its hand-over proof is checked against.
			// Each record of ours is newer than the last (`rev`): a signed one
			// can be sent again by anybody, and an old one must not roll the
			// party back (_onRecord). The clock keeps it rising across a reload.
			this.party.rev = Math.max((this.party.rev ?? 0) + 1, Date.now());
			if (this.party.host === this.selfId) {
				this.lastRecord = this.party.members.map((m) => ({ ...m }));
				this.lastTerm = this.party.term ?? 0;
				this._anchor({ host: this.selfId, term: this.lastTerm, rev: this.party.rev });
			}
			this.computed = false;
			// With the proof that the crown is ours (_proven), when it came by
			// an election or a hand-over; a founder's needs none.
			const env = { __p: structuredClone(this.party), f: this.selfId, t: null };
			if (this.proof) env.cp = this.proof.cp;
			this._send(env, null);
			this._emitParty();
			this._meshUp();
		}

		/**
		 * A record arrived (`__p`), its sender proven. A record is its crown
		 * holder's word — `f` is its host — except the one a host sends as
		 * it hands the crown over (transferHost), which names the next.
		 * Signatures alone do not stop a member signing a record that crowns
		 * itself, so beyond a newcomer's first record (it has nothing to
		 * check against) a record is taken only if its crown is proven
		 * (_proven): the holder we last heard, at that term, or a proof it
		 * carries (`cp`). Then _outranks orders it as before.
		 */
		async _onRecord(msg, link) {
			const next = msg.__p;
			const from = msg.f;
			if (!next || typeof next !== "object" || typeof next.host !== "string" || !Array.isArray(next.members)) return;
			const term = next.term ?? 0;
			const hand = from !== next.host;
			const first = this.party.host === null;
			// A copy handed on is for a newcomer; to anyone else it is old
			// news (before signing it was the member's own word, and ignored).
			if (msg.fw === 1 && !first) return;
			if (first) {
				// A newcomer has nothing to check a first record against, so it
				// trusts whoever hands it one — but a record the deliverer wrote
				// about itself only from the member the invite or code named
				// (link.named): any other link could crown itself to a fresh
				// page (review, 2026-11-19). Handed on, the host's own record is
				// taken from any member (Honest gaps: the deliverer is trusted).
				if (link && from === link.owner && !link.named) return this._refused("a first record its deliverer wrote");
			} else {
				const ok = hand ? await this._proven(term - 1, from, msg.cp) : await this._proven(term, next.host, msg.cp);
				if (this.closed) return;
				if (ok === "unseen") {
					this.unseen = { msg, gone: msg.cp?.rec?.f, link };
					return this._refused("vacancy unseen");
				}
				if (ok !== true) {
					this._behind(term);
					return this._refused(hand ? "hand-over unproven" : "crown unproven");
				}
			}
			// From the holder we last heard at this term, only a newer record
			// (`rev`): a signed record can be sent again by anybody, and an
			// old one — replayed, or late by a slower path — must not roll
			// the party back.
			const anchor = this.anchor;
			if (!first && !hand && anchor && next.host === anchor.host && term === anchor.term && !((next.rev ?? 0) > (anchor.rev ?? 0))) return;
			if (!this._outranks(next, from)) return;
			if (next.host === this.selfId) this._keepProof(next, from, msg);
			this._applyParty(next, from, first && msg.fw === 1);
			if (!hand) {
				// A copy: `next` is our live record now, and edits to it
				// would break the signature this is kept for.
				const { h, m, fw, ...kept } = msg;
				this.hostEnv = structuredClone(kept);
			}
		}

		/**
		 * A newer record we cannot check: its proof reaches further back than
		 * we hold (PROOF_DEPTH), or it is forged. Either way this phone will
		 * not follow that crown, so say it — once per party — rather than
		 * split off in silence (review, 2026-11-19).
		 */
		_behind(term) {
			if (term <= (this.party.term ?? 0) || this.behindSaid) return;
			this.behindSaid = true;
			this.onError?.("This phone missed changes of host it cannot check. Reload the page to rejoin the party.", { reason: "behind" });
		}

		/** The crown holder whose own record we took last (see `anchor`). */
		_anchor({ host, term, rev }) {
			const was = this.anchor;
			if (was && was.term === term && was.host === host) {
				// The same holder again: its revisions we hold, the last few.
				was.rev = Math.max(was.rev ?? 0, rev ?? 0);
				was.revs.add(rev ?? 0);
				if (was.revs.size > 8) was.revs.delete(was.revs.values().next().value);
				return;
			}
			if (was) {
				this.pastAnchors.unshift(was);
				this.pastAnchors.length = Math.min(this.pastAnchors.length, 3);
			}
			this.anchor = { host, term, rev: rev ?? 0, revs: new Set([rev ?? 0]) };
		}

		/**
		 * A record naming us host: keep what proves it, to show with ours.
		 * A hand-over is proven by the record that made it (signed by the
		 * one handing over, with that one's own proof inside); our own
		 * record back from before a reload, by the proof it carried.
		 */
		_keepProof(next, from, msg) {
			const term = next.term ?? 0;
			// Copies: `next` becomes our live record, which we edit.
			if (from !== this.selfId) {
				const { h, m, fw, ...env } = msg;
				this.proof = { term, cp: trimProof({ v: "hand", env: structuredClone(env) }) };
			} else this.proof = msg.cp ? { term, cp: trimProof(structuredClone(msg.cp)) } : null;
		}

		/**
		 * Is `host` the crown's holder at `term`? Yes if that is the holder
		 * whose record we last took, at that term. Otherwise `cp` must show
		 * it, one of two ways:
		 *   - `{ v: "vote", key, acks }`: it won the election `key` for a vacancy in the
		 *     term before — a quorum (_quorumOf) of that election's signed
		 *     acknowledgements of its commit (`__ka`), the candidate's own
		 *     standing for its record's signature. The election's key must
		 *     be one our own record makes sense of: its term is the one we
		 *     hold, and its humans are members of it — so nobody can count
		 *     ids they made up.
		 *   - `{ v: "hand", env }`: the holder of the term before handed it
		 *     over (transferHost): that one's signed record naming `host`,
		 *     itself proven the same way, PROOF_DEPTH deep at most.
		 * Without this, "a higher term wins" let any member crown itself by
		 * signing a record (2026-11-18).
		 */
		async _proven(term, host, cp, depth = 0) {
			const anchor = this.anchor;
			if (anchor && term === anchor.term && host === anchor.host) return true;
			if (!cp || typeof cp !== "object" || depth > PROOF_DEPTH || !isMemberId(host)) return false;
			// This party's (`pa`), never another's replayed here.
			const pid = this.party.pid;
			const ours = (env) => !pid || env?.pa === pid;
			if (cp.v === "hand") {
				const e = cp.env;
				if (!e?.__p || e.__p.host !== host || (e.__p.term ?? 0) !== term || e.f === host || typeof e.f !== "string" || !ours(e)) return false;
				if (!(await verifyBy(e.f, e.k, signedText(e), e.s))) return false;
				return (await this._proven(term - 1, e.f, e.cp, depth + 1)) === true;
			}
			if (cp.v !== "vote" || !Array.isArray(cp.acks) || typeof cp.key !== "string") return false;
			// The record the election was won from: signed by the holder that
			// left, of the term before. The key is rebuilt from it, never taken
			// from the certificate — a member wrote one naming only itself,
			// and was its own quorum (review, 2026-11-19).
			const rec = cp.rec;
			const gone = rec?.f;
			const was = rec?.__p?.term ?? 0;
			if (!rec?.__p || !Array.isArray(rec.__p.members) || rec.__p.host !== gone || !isMemberId(gone) || was + 1 !== term || !ours(rec)) return false;
			const key = voteKeyOf(rec.__p.members, was, gone);
			if (cp.key !== key) return false;
			// A record of that holder we took, or a newer one; never an older
			// one — an early record, its roster smaller, could make one voter a
			// quorum. One we never held must prove itself, from what we hold.
			const held = [anchor, ...this.pastAnchors].find((x) => x && x.term === was && x.host === gone);
			const recRev = rec.__p.rev ?? 0;
			if (held && !(held.revs.has(recRev) || recRev > held.rev)) return false;
			if (!(await verifyBy(gone, rec.k, signedText(rec), rec.s))) return false;
			if (!held && (await this._proven(was, gone, rec.cp, depth + 1)) !== true) return false;
			const { humans } = this._keyParts(key);
			if (!humans.has(host)) return false;
			const voters = new Set([host]);
			for (const a of cp.acks.slice(0, 64)) {
				if (a?.__ka !== key || a.n !== host || !humans.has(a.f) || voters.has(a.f) || !ours(a)) continue;
				if (await verifyBy(a.f, a.k, signedText(a), a.s)) voters.add(a.f);
			}
			if (!this._quorumOf(voters, key)) return false;
			// Won by the candidate's own vote alone (half the humans, and the
			// tie-break heir): nobody else saw the vacancy. Taken only by one
			// who sees it too — not the holder said to have left, and not
			// while we still hold a live link to it (as a voter would not
			// grant). Asked again when that link closes (_onRecord).
			if (depth === 0 && voters.size === 1 && (gone === this.selfId || this.links.has(gone))) return "unseen";
			return true;
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
			// Lost (see _lose): only the heir's side ends it — a newer term than
			// we lost at, the heir itself speaking, or the old host speaking at
			// the old term while it still seats the heir (its blip healed, the
			// heir with it). The old host alone at the old term would make a
			// second party of us beside the heir's.
			if (this.lost) {
				if (a > this.lostTerm) return true;
				if (a < this.lostTerm || from !== next.host) return false;
				if (next.host === this.lostHeir) return true;
				return next.host === this.vacated && next.members.some((m) => m.id === this.lostHeir);
			}
			if (a !== b) return a > b;
			if (from !== next.host) return false;
			if (next.host === mine.host) return !this.isHost();
			return !this.heard || next.host < mine.host;
		}

		/** Adopt a record that outranks ours (see _outranks). */
		_applyParty(next, from, handed = false) {
			const was = this.party;
			const wasHost = this.isHost();
			const wasLost = this.lost;
			const before = new Set(was.members.map((m) => m.id));
			this.party = next;
			if (from === next.host) this._anchor({ host: next.host, term: next.term ?? 0, rev: next.rev ?? 0 });
			// A newcomer's first record when handed on by whoever linked it
			// (`fw`, its host's signature and all) tells it who holds the
			// crown, and is no vote: a page fresh from a reload must not grant
			// a second time in an election its last page voted in (_voteKey).
			// Before signing, such a copy was the member's own word and was
			// never heard for the same reason. The host's own next record is.
			// (The mark is unsigned: a member who strips it gives a reloaded
			// page back its vote on a stale record — a residual, 2026-11-18.)
			this.heard = from === next.host && !handed;
			if (next.host !== this.selfId) this.proof = null;
			if (this.heard) {
				this.lastRecord = next.members.map((m) => ({ ...m }));
				this.lastTerm = next.term ?? 0;
				this.computed = false;
				this.pendingCrown = false;
				this.candidacy = null;
				clearTimeout(this.heirTimer);
			}
			// A crown changing hands under a split can leave us, or people only
			// we can reach, out of the winning record. Keep our own seat locally
			// and introduce the missing to the new host, which adds them like
			// any newcomer. Not done for a record from the same host: that one
			// leaving us out is an eviction, and the __k said so.
			// So does a record that finds us lost: its host may have dropped us
			// while we could not reach it.
			if ((was.host !== null && next.host !== was.host) || wasLost) {
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
					this._send({ __i: { id: m.id, name: m.name }, f: this.selfId, t: null }, null);
				}
			}
			const after = new Set(next.members.map((m) => m.id));
			for (const id of after) if (!before.has(id)) this._emitJoin(id);
			this._reassert();
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
			if (wasLost && (this.heard || this.isHost())) {
				// Back in touch with the crown's side: its party is ours again.
				this.lost = false;
				this._stopRetries();
				this.onLost?.(false);
			}
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
				this._send({ __i: { id, rs: true }, f: this.selfId, t: null }, null);
			}
		}
		/**
		 * `member` is the record as it was, since it is already out of the
		 * roster by now — a listener asking getMember() for the name would
		 * get nothing. `reason` says how they went: "left" (on purpose),
		 * "dropped" (lost, and not back within the grace), "removed" (by the
		 * host) or "gone" (vanished from the host's record).
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
			this._markSeen(env);
			// Somebody else's, passed on: as it came, signature and all.
			if (from) return this._route(env, from);
			if (!this.outN && !this._mustSign(env)) return this._route(env, null);
			// Signing is asynchronous, so whatever we send after a signed
			// message waits for it — signed or not — and our order holds.
			// Sent as it is now: a caller may change its object after.
			const copy = JSON.parse(JSON.stringify(env));
			this.outN++;
			this.outq = this.outq
				.then(async () => {
					if (this.closed) return;
					if (this._mustSign(copy) && !copy.s) await this._sign(copy);
					if (!this.closed) this._route(copy, null);
				})
				.catch((err) => console.warn("[neon] could not send:", err))
				.finally(() => void this.outN--);
		}

		/**
		 * Does this message of ours need a signature (_authentic)? Every
		 * control message (`__*`), and whatever someone else may carry on:
		 * a targeted send with no link to its target, a broadcast that misses
		 * someone. Game traffic over direct links — the 15–30 Hz real-time
		 * paths — is proven by the link alone and costs nothing.
		 */
		_mustSign(env) {
			if (env.t === this.selfId) return false;
			for (const k in env) if (k.startsWith("__")) return true;
			if (env.t !== null && env.t !== undefined) return !this.links.has(env.t);
			return this._missing(env).length > 0;
		}

		/** Members a broadcast of ours reaches only if somebody carries it on. */
		_missing(env) {
			// The election's messages (_stand) go round the whole mesh: a
			// member we think we reached may sit behind a half-dead link, and
			// a lost grant or commit costs a crown. Small, and rare.
			const election = env.__c || env.__ck || env.__r || env.__gr || env.__ka;
			const covered = new Set(election ? [env.f, this.selfId] : [...this.links.keys(), env.f, this.selfId]);
			return this.party.members.map((m) => m.id).filter((id) => !covered.has(id) && !isBotId(id));
		}

		/** Sign an envelope of ours in place (`k`, `s`); see signedText. */
		async _sign(env) {
			env.pa = this.party.pid ?? null;
			env.k = this.identity.pub;
			env.s = await this.identity.sign(signedText(env));
			return env;
		}

		/** Where an envelope goes: its target, or everyone (see _send). */
		_route(env, from) {
			if (this.closed) return;
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
			const missing = this._missing(env);
			const out = { ...env, m: missing.length ? missing : null };
			for (const [id, link] of this.links) {
				if (id !== env.f && link !== from) link.send(out);
			}
		}

		/**
		 * Remember an envelope; false if it was already taken. Keyed by sender
		 * and id, not id alone: a member must not be able to send something of
		 * its own under the id another's message will carry and have that one
		 * dropped as a copy (review, 2026-11-19).
		 */
		_markSeen(env) {
			const id = seenKey(env);
			if (this.seen.has(id)) return false;
			this.seen.add(id);
			this.seenQueue.push(id);
			if (this.seenQueue.length > SEEN_MAX) this.seen.delete(this.seenQueue.shift());
			return true;
		}

		_deliver(env) {
			const action = this.actions.get(env.a);
			// No channel by that name yet: a framed game still loading has not
			// opened it, and lib/bridge.js holds the message for it.
			if (!action) return void this.onStray?.(env);
			action.onMessage?.(env.d, { peerId: env.f });
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

		/**
		 * One message off a link, in that link's order. Each link's messages
		 * are handled one at a time even when one has to wait (a signature
		 * to verify, a crown proof): the next queues behind it, so a sender's
		 * order survives verification.
		 */
		_inbound(link, msg) {
			if (this.closed || !link) return;
			this._onLink(link, () => {
				if (this.closed) return;
				if (!link.owner) return this._preHello(link, msg);
				return this._authentic(link, msg);
			});
		}

		/** Run `fn` now if nothing on `link` is waiting, else after what is. */
		_onLink(link, fn) {
			const done = () => void link.waiting--;
			if (!link.waiting) {
				const r = fn();
				if (!r || typeof r.then !== "function") return;
				link.waiting = 1;
				link.tail = r.catch((err) => console.warn("[neon]", err)).then(done);
				return;
			}
			link.waiting++;
			link.tail = link.tail
				.then(fn)
				.catch((err) => console.warn("[neon]", err))
				.then(done);
		}

		/**
		 * Who said it (Lokesh, 2026-11-18). A message counts only if its
		 * sender — `f`, or `o` for a bot's move — is proven: it came over the
		 * link whose owner that is (the hello proved it), or it carries that
		 * sender's signature (`k` its public key, whose hash is the id; `s`
		 * over signedText). A bot speaks only through the crown: `f` a bot
		 * of the host's record, `o` the host. Anything else is dropped and
		 * counted (`refused`). An acknowledgement (`__ka`) is verified even
		 * on its sender's own link: it is kept as proof of a crown (_crown).
		 */
		_authentic(link, msg) {
			if (msg.__hi !== undefined) return; // a hello said twice
			const signer = msg.o ?? msg.f;
			if (typeof signer !== "string" || isBotId(signer)) return this._refused("no sender");
			if (msg.o !== undefined && !isBotId(msg.f)) return this._refused("o for a person");
			// A copy of what we already took: no need to check it again.
			if (typeof msg.id === "string" && this.seen.has(seenKey(msg))) return;
			// Signed for another party (`pa`): an old party's, or a stranger's,
			// replayed here. From a link's own owner only a stated other party
			// is refused — a newcomer that has not yet learnt ours says none.
			const pid = this.party.pid;
			if (link.owner === signer && !msg.__ka) {
				if (pid && typeof msg.pa === "string" && msg.pa !== pid) return this._refused("another party");
				return this._fromSigner(link, msg, signer);
			}
			if (typeof msg.s !== "string") return this._refused("unsigned");
			if (pid && msg.pa !== pid) return this._refused("another party");
			return verifyBy(signer, msg.k, signedText(msg), msg.s).then((ok) => {
				if (this.closed) return;
				if (!ok) return this._refused("bad signature");
				return this._fromSigner(link, msg, signer);
			});
		}

		_fromSigner(link, msg, signer) {
			const ours = this.party.members.some((m) => m.id === msg.f);
			if (msg.f !== signer) {
				if (msg.a === undefined || signer !== this.party.host || !ours) return this._refused("not the crown's bot");
			}
			// Game traffic only from the party's members: a key anybody can
			// make, and a stranger's signed message carried in by a member
			// reached the game (review, 2026-11-19). Control traffic is
			// checked by what it is about (a newcomer is not seated yet).
			if (msg.a !== undefined && !ours) return this._refused("not a member");
			return this._accept(link, msg);
		}

		/**
		 * Is `j` the seat member `id` holds in our record (its `joined`)?
		 * What binds a `__k` or `__gone` to one seat: signed messages can be
		 * sent again by anybody, and the 512-id `seen` window rolls over in
		 * seconds at 30 Hz, so it is no defence (review, 2026-11-19). A member
		 * we do not seat: nothing to do anyway.
		 */
		_sameSeat(id, j) {
			const m = this.party.members.find((x) => x.id === id);
			return !!m && m.joined === j;
		}

		/** May `id` send what only the crown sends (`__k`, `__x`)? */
		_fromCrown(id) {
			return id === this.party.host || id === this.anchor?.host;
		}

		_accept(link, msg) {
			if (this.closed) return;

			// Control traffic is handled before the game's queue, so a party edit
			// is never held behind `resume()`. These are all broadcasts: each is
			// delivered once, and carried on to anyone its sender could not reach.
			// The election's messages (_stand) are flooded like the rest: taken
			// from whichever link brings them first. (A rule taking them only
			// over the sender's own link lost them on a half-dead one.) Since
			// 2026-11-18 each is signed by its sender, so a relay can drop one
			// but never write one (_authentic).
			if (msg.__p || msg.__k || msg.__q || msg.__alive || msg.__gone || msg.__v || msg.__h || msg.__c || msg.__r || msg.__gr || msg.__ck || msg.__ka || msg.__x) {
				if (!this._markSeen(msg)) return;
				this._forwardBroadcast(msg, link);
				if (msg.__p) {
					return this._onRecord(msg, link);
				} else if (msg.__k) {
					// Only the crown evicts: the sender is proven now, so a
					// member's own __k naming another is simply refused.
					if (!this._fromCrown(msg.f)) return this._refused("__k from a non-host");
					if (!this._sameSeat(msg.__k, msg.j)) return this._refused("__k for an old seat");
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
					// Asked about ourselves: the asker has just lost its link to us.
					if (msg.__q === this.selfId) this._redial(msg.f);
				} else if (msg.__alive) {
					this._vouch(msg.__alive);
					this._resendOffer(msg.__alive);
				} else if (msg.__h) {
					// "Here", from a client before elections (it was counted then,
					// and double-counted across a split): ignored.
				} else if (msg.__c) {
					this._asked(msg.__c, msg.r | 0, msg.f);
				} else if (msg.__ck) {
					this._commitAsked(msg.__ck, msg.r | 0, msg.f);
				} else if (msg.__gr) {
					// Flooded, so a half-dead link to the candidate loses nothing.
					if (msg.n === this.selfId) this._granted(msg.__gr, msg.r | 0, msg.f);
				} else if (msg.__ka) {
					// Flooded, so everyone learns who is sworn to whom (_standAgain).
					if (!this.sworn.has(msg.__ka)) this.sworn.set(msg.__ka, new Map());
					this.sworn.get(msg.__ka).set(msg.f, msg.n);
					if (msg.n === this.selfId) this._acked(msg.__ka, msg.r | 0, msg.f, msg);
				} else if (msg.__r) {
					this._released(msg.__r, msg.r | 0, msg.f);
				} else if (msg.__v) {
					// The crown's holder has a seat the room server holds, so its
					// loss is no `__gone`: whoever concluded it says the crown is
					// vacant instead. Somebody who reached it only through that
					// member would never learn otherwise, and its heir would sit
					// out the five-minute grace while the rest went lost. Not
					// taken on trust — one member's false alarm must not move
					// the crown for everyone (test-room 6e22): we ask for
					// ourselves, as for any suspect, and conclude in our turn.
					if (msg.__v === this.party.host && msg.__v !== this.selfId && !this.links.has(msg.__v)) {
						this._suspect(msg.__v);
					}
				} else if (msg.__gone) {
					// A member saying goodbye for itself is gone even though its
					// link is still draining. Anyone else's report yields to a link
					// we still hold: the reporter simply lost a pair, and relaying
					// covers it.
					const own = msg.__gone === msg.f;
					// About the seat it names (`j`): a goodbye replayed once that
					// member is back names its old seat.
					if (!this._sameSeat(msg.__gone, msg.j)) return this._refused("__gone for an old seat");
					if (own || !this.links.has(msg.__gone)) this._applyGone(msg.__gone, own ? "left" : "dropped");
				} else {
					if (!this._fromCrown(msg.f)) return this._refused("__x from a non-host");
					if (!(typeof msg.tr === "number" && msg.tr >= (this.party.term ?? 0))) return this._refused("__x from an old term");
					this.onPartyClosed?.();
					this._close("closed");
				}
				return;
			}
			if (msg.__i) {
				// The sender is proven (_authentic), so a member's edit of its
				// own record is its own however it travelled. (Until
				// 2026-11-18 `f` was unsigned, and a relayed copy was refused
				// while the host held a link to its sender.)
				if (!this._markSeen(msg)) return;
				if (!this.isHost()) {
					// Not ours to keep. Passed on unchanged towards whoever
					// keeps the record: a broadcast round the mesh, one
					// addressed elsewhere along its way. (It used to be
					// re-addressed to the host we know of, which would break
					// its signature; every introduction is a broadcast now.)
					if (msg.t === null || msg.t === undefined) this._forwardBroadcast(msg, link);
					else if (msg.t !== this.selfId) this._send(msg, link);
					return;
				}
				const { id, back, rs, ...fields } = msg.__i;
				// A bot has no browser to speak for it: only the host edits one
				// (setBotMeta), never a message. Nor does anyone edit the host's
				// record, which it edits in place — but a vouch about the host
				// (`back`: its link to them opened again; `rs`) still lands: it
				// clears the host's held seat on a reload (test-worker's handover).
				if (isBotId(id) || (id === this.selfId && !rs && !back)) return;
				if (id === this.selfId) for (const k of Object.keys(fields)) delete fields[k];
				// What a member may write on its own record: its name and its
				// own meta (setMeta) — never a field the record owns (team, bot,
				// host…), nor `local`, which marks a bot seat (2026-11-17).
				const patch = {};
				for (const [k, v] of Object.entries(fields)) if (k === "name" || (!RESERVED_META.has(k) && k !== "local")) patch[k] = v;
				let m = this.party.members.find((x) => x.id === id);
				// A vouch (`rs`, `back`) is about a member we already seat. One
				// for an id we do not know is late news of somebody who has
				// since left; seating them would bring them back as "Player".
				if (!m && (rs || back)) return;
				if (!m) {
					// Seated on somebody else's word: not proven to be anybody
					// until it speaks for itself (`pend`, cleared below or when
					// its link to us opens). An id nobody holds the key of —
					// a member inventing seats — never counts in an election
					// (_voteKey, _successor), so it cannot stall or sway one.
					this._addMember(id, patch.name);
					m = this.party.members.find((x) => x.id === id);
					if (m && msg.f !== id) {
						m.pend = 1;
						// A seat nobody proves is dropped: a replayed introduction
						// of somebody long gone would otherwise seat a ghost.
						const joined = m.joined;
						setTimeout(() => {
							const still = this.party.members.find((x) => x.id === id);
							if (this.closed || !this.isHost() || !still?.pend || still.joined !== joined) return;
							this._dropMember(id, "dropped");
							this._commitParty();
						}, PEND_MS);
					}
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
				if (m && msg.f === id) delete m.pend;
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
				if (!this._markSeen(msg)) return;
				if (msg.__g === "offer") this._onRelayedOffer(msg.f, msg.sdp, !!msg.r, msg.n ?? null);
				else this._onRelayedAnswer(msg.f, msg.sdp, msg.n ?? null);
				return;
			}

			if (!this.running) {
				this.inbox.push([link, msg]);
				return;
			}

			// Game traffic.
			if (msg.t !== null && msg.t !== undefined) {
				if (msg.t === this.selfId) {
					if (this._markSeen(msg)) this._deliver(msg);
				} else {
					this._send(msg, link);
				}
				return;
			}
			if (!this._markSeen(msg)) return;
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

	/**
	 * The address an invite or code link is built on. In the one-page shell
	 * (src/router.ts, docs/spa.md): `./?party` with this page's query (a
	 * test's mock, a loopback ?rs=) but not `page=`, so a link made while the
	 * host looks at the leaderboard still opens the party.
	 */
	NeonArcade.shareBase = () => {
		if (!NeonArcade.shell) return location.href.split("#")[0];
		const q = new URLSearchParams();
		for (const [k, v] of new URLSearchParams(location.search)) if (!["page", "party", "fresh", "mode"].includes(k)) q.set(k, v);
		if (!["game", "dev"].some((k) => q.has(k))) q.set("party", "");
		return new URL(`./?${q.toString().replace(/=(&|$)/g, "$1")}`, location.href).href;
	};

	/** Drop a handshake fragment without reloading, so a live room survives. */
	NeonArcade.clearHash = () => {
		// The state is kept: it may be the back-button guard's (lobby.js).
		// One page (src/router.ts): keep a party word once the invite is gone
		// (?rs= or ?mockroom= alone would read as the portal).
		const q = new URLSearchParams(location.search);
		if (NeonArcade.shell && !["game", "mode", "fresh", "dev", "party"].some((k) => q.has(k))) q.set("party", "");
		const search = q.toString().replace(/=(&|$)/g, "$1");
		history.replaceState(history.state, "", location.pathname + (search ? "?" + search : ""));
	};

	/**
	 * Start a fresh party. Clears any stale rejoin token (which would otherwise
	 * make the next load reconnect to an old party instead of hosting), drops
	 * the handshake fragment, and lands on the party with the fresh-start flag.
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
		location.href = "./?fresh=1";
	};

	/** This tab's signing identity, or another (see identity above). */
	NeonArcade.identity = identity;
	/** Is this a member id — a key's hash, not a bot's or an old client's? */
	NeonArcade.isMemberId = isMemberId;

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
	NeonArcade._codec = { packSignal, unpackSignal, isRetrySignal, isHardSignal, compactSdp, rebuildSdp, toWire, fromWire, signedText, idOfKey, voteKeyOf };
	NeonArcade._pinNat = (v) => (natPinned = v === undefined ? null : Promise.resolve(v));
})();
