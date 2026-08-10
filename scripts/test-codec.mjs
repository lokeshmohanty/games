// Exercise the signalling codec outside a browser: net.js only needs `window`,
// `location` and web-standard globals to define it.
import { readFileSync } from "node:fs";

// In a browser `window.NeonArcade = …` also creates the bare global the file
// refers to later, so `window` has to be the global object here too.
globalThis.window = globalThis;
const win = globalThis;
globalThis.location = { href: "https://example.test/party.html", hash: "", pathname: "/party.html", search: "" };
globalThis.history = { replaceState() {} };

const src = readFileSync(new URL("../lib/net.js", import.meta.url), "utf8");
new Function(src)();

const { packSignal, unpackSignal, compactSdp } = win.NeonArcade._codec;

const SDP = [
	"v=0",
	"o=- 1 2 IN IP4 127.0.0.1",
	"s=-",
	"t=0 0",
	"a=group:BUNDLE 0",
	"a=extmap-allow-mixed",
	"a=msid-semantic: WMS",
	"m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
	"c=IN IP4 0.0.0.0",
	"a=ice-ufrag:Ab3X",
	"a=ice-pwd:s0meL0ngIcePasswordValue99",
	"a=ice-options:trickle",
	"a=fingerprint:sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99",
	"a=setup:actpass",
	"a=mid:0",
	"a=sctp-port:5000",
	"a=max-message-size:262144",
	// A typical gathering result: an mDNS host candidate, a real srflx one, and
	// a TCP host candidate. Only the middle one is usable by a remote peer.
	"a=candidate:1 1 udp 2113937151 9b36eaac-1f2e-4d55-9f0e-1234567890ab.local 54321 typ host generation 0 network-cost 999",
	"a=candidate:2 1 udp 1677729535 203.0.113.7 54321 typ srflx raddr 0.0.0.0 rport 0 generation 0 network-id 1",
	"a=candidate:3 1 tcp 1518222591 9b36eaac-1f2e-4d55-9f0e-1234567890ab.local 9 typ host tcptype active generation 0",
].join("\r\n") + "\r\n";

let failures = 0;
const check = (label, cond, detail = "") => {
	if (cond) console.log(`  ok   ${label}`);
	else {
		console.log(`  FAIL ${label} ${detail}`);
		failures++;
	}
};

const compact = compactSdp(SDP);
check("compaction succeeded", !!compact);
// mDNS candidates must survive: on a LAN with no route to STUN they are the
// only way two browsers connect at all.
check("mDNS host candidate kept", JSON.stringify(compact.c).includes(".local"));
check("active ICE-TCP placeholder dropped", !compact.c.some((c) => c.split("\t")[2] === "tcp"));
check("srflx candidate kept", compact.c.some((c) => c.includes("203.0.113.7")), JSON.stringify(compact.c));
check("two usable candidates survive", compact.c.length === 2, `got ${compact.c.length}`);

const code = await packSignal({ s: "ab12", i: "peer000001", n: "Lokesh" }, SDP);
const out = await unpackSignal(code);

check("slot round-trips", out.slot === "ab12");
check("peer id round-trips", out.peerId === "peer000001");
check("name round-trips", out.name === "Lokesh", out.name);
check("ice-ufrag preserved", out.sdp.includes("a=ice-ufrag:Ab3X"));
check("ice-pwd preserved", out.sdp.includes("a=ice-pwd:s0meL0ngIcePasswordValue99"));
check(
	"fingerprint preserved",
	out.sdp.includes("a=fingerprint:sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99"),
);
check("setup role preserved", out.sdp.includes("a=setup:actpass"));
check("usable candidate preserved", out.sdp.includes("203.0.113.7 54321 typ srflx"));

// The point of the exercise: the code has to fit on a phone screen as a QR.
const wholeSdpCode = await packSignal({ s: "ab12", i: "peer000001" }, "v=0\r\nBROKEN");
console.log(`\n  invite code length: ${code.length} chars`);
check("code is QR-sized (< 420 chars)", code.length < 420, `got ${code.length}`);

// An SDP that does not match the expected shape must still work, just longer.
const odd = SDP.replace(/^a=setup:.*$/m, "");
const fallback = await unpackSignal(await packSignal({ s: "z", i: "y" }, odd));
check("unfamiliar SDP falls back to verbatim", fallback.sdp === odd);

// Links, not just bare codes, are accepted on the way back in.
const fromLink = await unpackSignal(`https://example.test/party.html#a=${code}`);
check("answer link parses", fromLink.peerId === "peer000001");
const fromInvite = await unpackSignal(`https://example.test/party.html#i=${code}`);
check("invite link parses", fromInvite.peerId === "peer000001");

console.log(failures ? `\n${failures} failure(s)` : "\nall codec checks passed");
process.exit(failures ? 1 : 0);
